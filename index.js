// index.js — dsh-prompt-plus 宿主入口（Cordis 插件）
//
// 这个插件的**行为契约**是从 WorkBuddy 5.9.3 的 app.asar 里逆向确认的：
//
//   · 一次改写 = 一次独立的模型调用，只带一段 system + 一段 user，不带会话历史
//   · 空输入直接拒绝，不浪费一次请求
//   · 结果只取正文，去掉模型爱套的外层引号；正文为空按失败处理
//   · 失败要给出**结构化 code**，让界面能按 code 分派而不是解析消息文本
//   · 语言必须与输入一致；不代答、不索要代码片段、不点名未提及的技术
//
// 这些需求是功能性的，实现方式多种多样。本插件用自己的实现满足它们：
// 提示词是自己写的（见 lib/prompts.js），消息用标记包裹而不是字符串模板替换，
// 引号剥离按对称语义实现。
//
// 在 DSH 里的落地方式：
//   浏览器草稿 → POST /api/prompt-plus/enhance → ctx.llm.stream
//              → unwrapQuotes → 回传 → inputActions.setDraft 写回输入框
//
// 依赖策略：只 import node: 内置模块。llm / agentDefaultModel / webServer / tools
// 全部走 ctx.inject 动态注入 —— 缺任何一个都只关掉对应能力，不让插件整层不激活。

import { Buffer } from 'node:buffer'
import { REWRITE_SYSTEM_PROMPT, buildUserMessage, unwrapQuotes } from './lib/prompts.js'

export { REWRITE_SYSTEM_PROMPT, buildUserMessage, unwrapQuotes, SOFT_LIMIT_CHARS } from './lib/prompts.js'

/** Cordis 插件名。 */
export const name = 'dsh-prompt-plus'

/** 浏览器半侧固定请求这一条路由。 */
export const ROUTE = '/api/prompt-plus/enhance'

/**
 * 宿主半侧没有硬依赖：llm / agentDefaultModel / webServer / tools 全部走
 * `ctx.inject` 动态注入。少一个服务只关掉对应能力，不会让整层不激活
 * （这是 dsh-retro 踩过的坑：把可选服务写进静态 inject，缺了就整块消失）。
 */
export const inject = []

const MAX_BODY_BYTES = 128 * 1024

// ============================================================================
// HTTP 工具
// ============================================================================

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        done({ ok: false, status: 413, error: '请求体过大' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return done({ ok: true, body: {} })
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return done({ ok: false, status: 400, error: '请求体必须是 JSON 对象' })
        }
        done({ ok: true, body: parsed })
      } catch (error) {
        done({ ok: false, status: 400, error: `JSON 解析失败：${String(error?.message ?? error)}` })
      }
    })
    req.on('error', (error) => done({ ok: false, status: 400, error: String(error?.message ?? error) }))
  })
}

// ============================================================================
// 插件主体
// ============================================================================

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 部署层配置（profile 的 cordis.patch.yml 里同 id 条目的 config）
 */
export function apply(ctx, config = {}) {
  const settings = {
    /** 单次改写超时：超时即失败，绝不让输入框一直转圈。 */
    timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 60_000,
    /**
     * 温度：**默认不传**，交给服务端自己决定。
     *
     * 改写是「重述」而不是「创作」，插件没有依据替调用方猜一个温度。适配器侧
     * 只在拿到数字时才把字段写进请求，所以「不传」与「传 1」在服务端看到的
     * 是两种不同的请求，不能想当然地等同 —— 这也是默认不填的理由。
     *
     * 需要固定时在 config 里给数字；给 null/省略则保持不传。
     */
    temperature: typeof config.temperature === 'number' ? config.temperature : null,
    /**
     * 输入长度上限。给一个保险值：超长草稿本来就该先拆再改写，
     * 直接塞给模型只会得到同样冗长的结果。
     */
    maxInputChars: Number(config.maxInputChars) > 0 ? Number(config.maxInputChars) : 8_000,
    /** 显式覆盖模型；留空则跟随当前会话实际在用的模型。 */
    provider: typeof config.provider === 'string' ? config.provider : '',
    model: typeof config.model === 'string' ? config.model : '',
    /**
     * 兜底会话 id。浏览器半侧会传当前会话，正常情况下用不到它；
     * 只有模型侧工具 `prompt_enhance` 这类没有会话上下文的调用才回落到这里。
     * 留空时用一个固定的插件 id —— 注意按会话计费的服务商会把它当成独立额度池。
     */
    sessionId: typeof config.sessionId === 'string' ? config.sessionId : '',
    /** 调试：把每次改写的长度/耗时写进日志（不写正文，避免草稿进日志）。 */
    logPrompts: config.logPrompts === true,
  }

  /** 运行期句柄：服务可能晚到，统一存这里；缺了给明确错误而不是静默失败。 */
  const runtime = { llm: null, agentDefaultModel: null, sessions: null, sessionProjections: null }

  const log = (level, message, detail) => {
    const fn = ctx.logger?.[level]
    if (typeof fn !== 'function') return
    detail === undefined ? fn.call(ctx.logger, message) : fn.call(ctx.logger, message, detail)
  }

  ctx.inject(['llm'], (llmCtx) => {
    llmCtx.effect(() => {
      runtime.llm = llmCtx.llm
      return () => {
        if (runtime.llm === llmCtx.llm) runtime.llm = null
      }
    }, 'dsh-prompt-plus: llm ref')
  })

  ctx.inject(['agentDefaultModel'], (modelCtx) => {
    modelCtx.effect(() => {
      runtime.agentDefaultModel = modelCtx.agentDefaultModel
      return () => {
        if (runtime.agentDefaultModel === modelCtx.agentDefaultModel) runtime.agentDefaultModel = null
      }
    }, 'dsh-prompt-plus: agentDefaultModel ref')
  })

  // 会话与投影服务：用来读「这个会话实际在用哪个模型」。
  // 两者都可选 —— 缺了就退回默认模型，功能仍可用（只是可能不是用户在用的那个）。
  ctx.inject(['sessions'], (sessionCtx) => {
    sessionCtx.effect(() => {
      runtime.sessions = sessionCtx.sessions
      return () => {
        if (runtime.sessions === sessionCtx.sessions) runtime.sessions = null
      }
    }, 'dsh-prompt-plus: sessions ref')
  })

  ctx.inject(['sessionProjections'], (projCtx) => {
    projCtx.effect(() => {
      runtime.sessionProjections = projCtx.sessionProjections
      return () => {
        if (runtime.sessionProjections === projCtx.sessionProjections) runtime.sessionProjections = null
      }
    }, 'dsh-prompt-plus: sessionProjections ref')
  })

  function usable(sel) {
    return sel && typeof sel.provider === 'string' && sel.provider !== '' && typeof sel.model === 'string' && sel.model !== ''
  }

  /**
   * 这个会话实际在用的模型 —— 与 dsh-api-session-controller 组装请求时的顺序一致：
   *   ① 会话级 modelSelection 投影的 pending（用户刚在输入框上方切的那个）
   *   ② 会话日志里最后一次 request/header 记录的 provider/model（真正发出去过的那个）
   *   ③ agentDefaultModel（只为「从未选过模型的新会话」兜底）
   *
   * 只用 ③ 是不够的：它是**默认**模型，不是会话模型。会话里选了 DeepSeek-V4.1-Flash
   * 而默认值指向某个免费模型时，改写会打到没额度的那个池子上。
   *
   * @param sessionId 目标会话；空字符串表示没有会话上下文
   * @returns `{ provider, model, source }` 或 null
   */
  function sessionSelection(sessionId) {
    if (settings.provider !== '' && settings.model !== '') {
      return { provider: settings.provider, model: settings.model, source: 'config' }
    }

    if (sessionId !== '') {
      // ① 会话级选择投影
      try {
        const sessions = runtime.sessions
        const projections = runtime.sessionProjections
        const session = sessions?.get?.(sessionId)
        if (session !== undefined && session !== null && projections !== null) {
          const state = projections.stateOf(session, 'modelSelection')
          const pending = state?.pending
          if (usable(pending)) {
            return { provider: pending.provider, model: pending.model, source: 'session-pending' }
          }
        }
      } catch {
        /* 投影读失败不致命：继续往下一层 */
      }

      // ② 会话日志里最后一次请求头
      try {
        const session = runtime.sessions?.get?.(sessionId)
        const header = session?.requestHeader?.()
        const config = header?.config
        if (usable(config)) {
          return { provider: config.provider, model: config.model, source: 'session-header' }
        }
      } catch {
        /* 同上 */
      }
    }

    // ③ 默认模型兜底
    try {
      const sel = runtime.agentDefaultModel?.currentSelection?.()
      if (usable(sel)) return { provider: sel.provider, model: sel.model, source: 'default' }
    } catch {
      /* 服务在但读取失败 */
    }
    return null
  }

  /** 兼容旧调用点：没有会话上下文时的当前选择。 */
  function currentSelection() {
    return sessionSelection('')
  }

  /**
   * 一次改写。
   *
   * 返回 `{ success, text, code?, error? }`：成功只给正文，失败给机器可读的
   * `code` 供界面分派，`error` 只作人读补充。调用方按 code 分支，不解析文案。
   *
   * @param {{ text?: unknown, provider?: unknown, model?: unknown, sessionId?: unknown }} input
   */
  async function enhance(input) {
    const text = typeof input?.text === 'string' ? input.text : ''
    if (text.trim() === '') {
      return { success: false, text: '', code: 'empty_input', error: '输入为空' }
    }
    if (text.length > settings.maxInputChars) {
      return {
        success: false,
        text: '',
        code: 'input_too_long',
        error: `输入过长（${text.length} > ${settings.maxInputChars} 字符），请先精简再改写`,
      }
    }

    const llm = runtime.llm
    if (llm === null || typeof llm.stream !== 'function') {
      return { success: false, text: '', code: 'llm_unavailable', error: 'llm 服务未挂载，无法发起改写请求' }
    }

    // 会话身份。必须用**当前对话**的 sessionId 而不是插件自造的假 id：
    //  · 服务商按会话计免费额度 —— 假 id 等于自开一个独立额度池，用光就长时间 429；
    //  · 会话身份也是「当前对话用哪个模型」的解析依据（见 sessionSelection）。
    // 前端没传（例如模型侧工具调用）时依次回落到 config 固定值、插件固定 id。
    const sessionContextId =
      typeof input?.sessionId === 'string' && input.sessionId.trim() !== ''
        ? input.sessionId.trim()
        : settings.sessionId
    const sessionId = sessionContextId !== '' ? sessionContextId : 'dsh-prompt-plus'

    // 模型优先级：显式入参 > 该会话实际在用的模型 > config > 默认模型。
    const resolved = sessionSelection(sessionContextId)
    const provider =
      typeof input?.provider === 'string' && input.provider.trim() !== '' ? input.provider.trim() : resolved?.provider
    const model =
      typeof input?.model === 'string' && input.model.trim() !== '' ? input.model.trim() : resolved?.model
    if (!provider || !model) {
      return {
        success: false,
        text: '',
        code: 'no_model',
        error: '没有可用模型：在输入框上方选一个模型，或在插件 config 里固定 provider/model',
      }
    }

    const userMessage = buildUserMessage(text)
    const startedAt = Date.now()
    if (settings.logPrompts) {
      log('info', '[prompt-plus] enhance start', {
        provider,
        model,
        source: resolved?.source ?? 'input',
        chars: text.length,
        sessionId,
      })
    }

    const parts = []
    let failure = ''
    let failureCode = ''
    // 只在显式配置时才带 temperature；默认省略 = 让服务端用它自己的默认值
    const callConfig = {
      provider,
      model,
      sessionId,
      system: REWRITE_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: [{ type: 'text', text: userMessage }], source: { kind: 'dsh-prompt-plus' } },
      ],
      ...(settings.temperature === null ? {} : { temperature: settings.temperature }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    }
    try {
      for await (const chunk of llm.stream(callConfig)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text)
        if (chunk?.type === 'finish') {
          const reason = chunk.reason
          if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
            // 结构化 code 优先（RATE_LIMIT / QUOTA / ACCOUNT_QUOTA / AUTH…），
            // 消息只作为可读补充 —— 消费方按 code 路由，不解析文本。
            failureCode = String(reason.failure?.code ?? '')
            failure = String(reason.failure?.message ?? reason.failure?.code ?? reason.kind)
          }
        }
      }
    } catch (error) {
      failureCode = String(error?.code ?? '')
      failure = String(error?.message ?? error)
    }

    const cleaned = unwrapQuotes(parts.join(''))
    if (cleaned.trim() === '') {
      return {
        success: false,
        text: '',
        code: failureCode === '' ? 'llm_error' : `llm_error:${failureCode}`,
        error: failure || 'Enhanced result is empty',
      }
    }
    if (settings.logPrompts) {
      log('info', '[prompt-plus] enhance done', { chars: cleaned.length, ms: Date.now() - startedAt })
    }
    return { success: true, text: cleaned }
  }

  // ---- ① 路由 --------------------------------------------------------------
  // 浏览器半侧只认这一条 POST。GET 是 ping：页面没按钮时先看它判断是缺服务还是缺界面。
  ctx.inject(['webServer'], (wsCtx) => {
    wsCtx.effect(
      () =>
        wsCtx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (req, res) => {
            if (req.method === 'GET') {
              // 排障用：带 ?sessionId= 就能看到该会话**实际**会用哪个模型、来自哪一层。
              const probeSession =
                typeof req.url === 'string' ? (new URL(req.url, 'http://localhost').searchParams.get('sessionId') ?? '') : ''
              const scoped = sessionSelection(probeSession)
              return sendJson(res, 200, {
                ok: true,
                plugin: 'dsh-prompt-plus',
                llm: runtime.llm !== null,
                agentDefaultModel: runtime.agentDefaultModel !== null,
                sessions: runtime.sessions !== null,
                sessionProjections: runtime.sessionProjections !== null,
                defaultSelection: currentSelection(),
                selection: scoped,
              })
            }
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })

            const parsed = await readJsonBody(req)
            if (!parsed.ok) return sendJson(res, parsed.status, { ok: false, error: parsed.error })

            try {
              const result = await enhance(parsed.body)
              if (!result.success) {
                log('warn', '[prompt-plus] enhance failed', { code: result.code })
                return sendJson(res, 400, { ok: false, ...result })
              }
              sendJson(res, 200, { ok: true, text: result.text })
            } catch (error) {
              const message = String(error?.message ?? error)
              log('error', '[prompt-plus] enhance threw', { message })
              sendJson(res, 500, { ok: false, code: 'unknown', error: message })
            }
          },
        }),
      'dsh-prompt-plus: enhance route',
    )
  })

  // ---- ② 工具 --------------------------------------------------------------
  // 同一套提示词也给模型用：先把粗糙需求改写成可执行指令，再动手。
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'prompt_enhance',
          description:
            '把一段粗糙的提示词改写成更清晰、更具体的版本（与输入框那个四角星按钮共用同一套提示词流水线）。只返回改写结果本身，不执行原请求。',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: '待改写的原始提示词' } },
            required: ['text'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
          },
          async execute(args) {
            const result = await enhance({ text: args?.text })
            if (!result.success) throw new Error(result.error)
            return result.text
          },
        }),
      'dsh-prompt-plus: prompt_enhance tool',
    )
  })
}
