// lib/client.js — dsh-prompt-plus 浏览器半侧
//
// 一个按钮，挂在输入框工具栏（conversation.input.left），四种状态：
//
//   空草稿             → 整个不渲染（没字就没有按钮，不占位、不留灰点）
//   有字               → 四角星，点击改写
//   改写中             → 转圈，点击取消（abort 请求）
//   已改写（草稿未动） → 变「恢复原文」，点击写回改写前的文本
//   上一次失败         → 红点四角星 + 气泡说明，之后仍可重试
//
// 可见性判定是「没内容就不存在」：空草稿 + 无结果 + 无错误 ⇒ 不渲染。
// 这一条是这个按钮体验的核心 —— 灰着的按钮会让人以为功能坏了。
//
// 文本来源是宿主 useInput 快照里的 draft 字符串，写回走 inputActions.setDraft，
// 所以草稿持久化、撤销历史、引用胶囊全部仍由宿主维护 —— 本插件不碰编辑器内部。
//
// 纯 JS + react/jsx-runtime 手写（不依赖 JSX 构建），与 dsh-retro / dsh-soul 同写法：
// children 必须放 props.children，不能当第三参数传（第三参数是 key）。

window.__ModuleLoader__.load({
  id: 'dsh-prompt-plus',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { jsx: h, jsxs: hs } = require('react/jsx-runtime')
    const React = require('react')

    // 与 dsh-soul / dsh-retro 相同的包装：把多余参数收集成 children
    const e = (type, props, ...children) => {
      const p = props || {}
      if (children.length === 0) return h(type, p)
      if (children.length === 1) return h(type, { ...p, children: children[0] })
      return hs(type, { ...p, children })
    }

    const NS = 'prompt-plus'
    const ENDPOINT = '/api/prompt-plus/enhance'
    /** 少于这个字符数不显示按钮：一个标点不值得改写。 */
    const MIN_CHARS = 1

    // -------------------------------------------------------------------------
    // 文案（键集中英对齐；locale 服务缺失时回落中文）
    // -------------------------------------------------------------------------

    const zh = {
      'action.enhance': '优化提示词',
      'action.enhancing': '优化中…',
      'action.revert': '恢复原文',
      'action.cancel': '取消优化',
      'error.failed': '优化失败',
      'error.empty': '先写点内容再优化',
      'error.noModel': '没有可用模型，请先在输入框上方选一个',
      'error.quota': '这个模型的额度用完了，换个模型或等额度恢复',
      'error.rateLimit': '请求太频繁，稍等一下再试',
      'error.auth': '模型凭据无效，检查一下设置里的 API Key',
    }

    const en = {
      'action.enhance': 'Enhance prompt',
      'action.enhancing': 'Enhancing…',
      'action.revert': 'Revert',
      'action.cancel': 'Cancel enhancement',
      'error.failed': 'Enhance failed',
      'error.empty': 'Write something first',
      'error.noModel': 'No model selected',
      'error.quota': 'This model is out of quota — switch models or wait for it to reset',
      'error.rateLimit': 'Too many requests, try again shortly',
      'error.auth': 'Invalid model credentials — check the API key in settings',
    }

    /**
     * 把宿主的失败翻译成一句人话。
     *
     * 宿主把失败的稳定 code 拼在 `llm_error:<CODE>` 里（`QUOTA` / `ACCOUNT_QUOTA` /
     * `RATE_LIMIT` / `AUTH` …）。按 code 分派，**不解析消息文本** —— 那是
     * dsh-llm 明确禁止的做法。认不出来的 code 才回落到原文，并且截断，
     * 免得把一整段 JSON（例如 429 的配额说明）糊到输入框上方。
     */
    function describeFailure(code, message, t) {
      const raw = typeof code === 'string' ? code : ''
      const bare = raw.startsWith('llm_error:') ? raw.slice('llm_error:'.length) : raw
      if (bare === 'QUOTA' || bare === 'ACCOUNT_QUOTA') return t('error.quota')
      if (bare === 'RATE_LIMIT') return t('error.rateLimit')
      if (bare === 'AUTH' || bare === 'INVALID_CREDENTIAL') return t('error.auth')
      if (raw === 'no_model') return t('error.noModel')

      const text = String(message ?? '').trim()
      if (text === '') return t('error.failed')
      return `${t('error.failed')}：${text.length > 120 ? `${text.slice(0, 120)}…` : text}`
    }

    /** 宿主注入的 t 可能缺键（宿主词典未加载时），一律回落到内置中文。 */
    function translator(t) {
      return (key, params) => {
        let template = typeof t === 'function' ? t(key) : key
        if (typeof template !== 'string' || template === '' || template === key) {
          template = zh[key] ?? key
        }
        if (!params) return template
        return template.replace(/\{(\w+)\}/g, (match, name) =>
          params[name] === undefined ? match : String(params[name]),
        )
      }
    }

    // -------------------------------------------------------------------------
    // 样式（data-plugin-css 注入，避免与宿主样式冲突）
    // -------------------------------------------------------------------------

    const css = [
      '.ppp-wrap{position:relative;display:inline-flex;align-items:center}',
      '.ppp-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;min-width:28px;padding:0 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .15s ease,color .15s ease;font:inherit;font-size:12px;line-height:1}',
      '.ppp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ppp-btn:disabled{cursor:default;opacity:.4}',
      '.ppp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.ppp-btn[data-state="enhancing"],.ppp-btn[data-state="done"]{color:var(--dsw-alias-brand-primary)}',
      '.ppp-btn[data-state="error"]{color:var(--dsw-alias-label-error)}',
      '.ppp-spin{animation:ppp-spin 1s linear infinite;transform-origin:center}',
      '@keyframes ppp-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '.ppp-toast{position:absolute;left:0;bottom:calc(100% + 6px);z-index:30;max-width:320px;padding:6px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-tooltip-bg));color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.16);white-space:normal}',
      '@media (prefers-reduced-motion:reduce){.ppp-spin{animation:none}.ppp-btn{transition:none}}',
    ].join('')

    const tagId = 'dsh-prompt-plus/styles.css'
    let styleTagMissing = false
    if (typeof document !== 'undefined') {
      try {
        styleTagMissing = document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
      } catch {
        styleTagMissing = true
      }
    }
    if (styleTagMissing) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-prompt-plus'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------------------
    // 图标
    //
    // 「DeepSeek 化」的做法不是把鲸鱼塞进来 —— 实测过：官方那份 3.4KB 的鲸鱼
    // 路径在 16px 就是一团墨，任何缩放都救不回来。
    //
    // 真正决定观感的是**重量**。把官方鲸鱼渲染成位图量了一遍：
    //   fillRatio      0.501   ← 实心，占包围盒一半
    //   stroke/width   0.167   ← 笔画是整体宽度的 1/6
    //   circularity    0.176   ← 轮廓"碎"（有尾鳍与眼睛缺口）
    //
    // 而常规图标描边 1.4/16 = 0.087，只有官方的一半 —— 这才是"看着不像
    // DeepSeek"的根子，不是形状不够像。
    //
    // 所以定稿：保留四角星的语义，把描边提到 2/16 = 0.125（16px 下正好 2px，
    // 落在官方 0.167 的同一量级），并让星星本身用 DeepSeek 那种饱满曲率。
    // -------------------------------------------------------------------------

    /**
     * 腰部饱满度。0.5 是细长比例，DeepSeek 的曲率语言更饱满。
     * 0.55 是扫参后的平衡点（见 tools/icon-scan.mjs）：
     *   ≥0.75 臂间凹口消失、退化成菱形；≤0.45 又回到细长尖角。
     */
    const STAR_WAIST = 0.55
    /** 臂长（中心到臂尖），四周留白与宿主其他工具栏图标对齐。 */
    const STAR_REACH = 5.6
    /** 与官方 logo 同一量级的笔画：2/16 = 0.125（官方实测 0.167）。 */
    const STAR_STROKE = 2

    /** 保留两位小数：SVG 路径不需要浮点长尾，也便于人读与 diff。 */
    const n2 = (value) => Math.round(value * 100) / 100

    /**
     * 四角星路径：单条闭合曲线，四段三次贝塞尔。
     *
     * 腰部控制点越靠近臂尖（waist 越大），臂间凹口越浅、整体越"胖"；
     * 这正是 DeepSeek logo 的曲率语言 —— 饱满粗圆弧，而不是细长尖角。
     *
     * @param {number} waist 腰部控制点比例
     * @param {number} reach 臂长
     */
    function starPath(waist, reach) {
      const c = 8
      const k = waist * reach
      const r = reach
      // 腰部控制点：沿两臂之间的对角线向内收
      const p = n2(k * 0.55)
      const q = n2(r * 0.45)
      const top = n2(c - r)
      const bottom = n2(c + r)
      const left = n2(c - r)
      const right = n2(c + r)
      return (
        `M${c} ${top}` +
        `C${n2(c + p)} ${n2(c - q)} ${n2(c + q)} ${n2(c - p)} ${right} ${c}` +
        `C${n2(c + q)} ${n2(c + p)} ${n2(c + p)} ${n2(c + q)} ${c} ${bottom}` +
        `C${n2(c - p)} ${n2(c + q)} ${n2(c - q)} ${n2(c + p)} ${left} ${c}` +
        `C${n2(c - q)} ${n2(c - p)} ${n2(c - p)} ${n2(c - q)} ${c} ${top}Z`
      )
    }

    function SparkleIcon({ size = 16, className }) {
      const edge = Number(size) > 0 ? Number(size) : 16
      return e(
        'svg',
        {
          className,
          width: edge,
          height: edge,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          // 按 viewBox 单位给笔画，缩放时自动保持比例
          strokeWidth: STAR_STROKE,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        e('path', { d: starPath(STAR_WAIST, STAR_REACH) }),
      )
    }

    function RevertIcon({ size = 16, className }) {
      const edge = Number(size) > 0 ? Number(size) : 16
      return e(
        'svg',
        {
          className,
          width: edge,
          height: edge,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        e('path', { d: 'M3.4 8.6a4.9 4.9 0 1 0 1.5-3.5' }),
        e('path', { d: 'M2.6 2.6v3.1h3.1' }),
      )
    }

    function SpinnerIcon({ size = 16, className }) {
      const edge = Number(size) > 0 ? Number(size) : 16
      return e(
        'svg',
        {
          className,
          width: edge,
          height: edge,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        e('path', { d: 'M8 2.2a5.8 5.8 0 1 1-5.8 5.8', opacity: 0.95 }),
      )
    }

    // -------------------------------------------------------------------------
    // 请求
    // -------------------------------------------------------------------------

    /**
     * 请求改写。
     *
     * `sessionId` 必须带上：服务商按会话计免费额度，用假 id 会让插件自己开一个
     * 独立额度池（用光就一直 429），带上真实会话才与对话共用同一份预算。
     * 同时它也决定了「当前对话用的是哪个模型」——宿主按会话解析模型选择。
     *
     * @param text 草稿原文
     * @param sessionId 当前会话 id（拿不到就不传，宿主回落到默认选择）
     * @param signal 取消信号
     */
    async function requestEnhance(text, sessionId, signal) {
      const body = { text }
      if (typeof sessionId === 'string' && sessionId !== '') body.sessionId = sessionId
      let response
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw new Error(String(error?.message ?? error))
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || payload?.ok !== true) {
        const error = new Error(String(payload?.error ?? `HTTP ${response.status}`))
        error.code = typeof payload?.code === 'string' ? payload.code : 'unknown'
        throw error
      }
      const enhanced = typeof payload.text === 'string' ? payload.text : ''
      if (enhanced.trim() === '') throw new Error('模型没有返回可用文本')
      return enhanced
    }

    // -------------------------------------------------------------------------
    // 按钮
    // -------------------------------------------------------------------------

    /**
     * 标准 props：useInput（草稿快照 Hook）、inputActions（setDraft/persistDraft…）、
     * sessionId、t（locale 命名空间）。都是宿主 slot 渲染器并进来的，插件不自己造。
     */
    function EnhanceButton(props) {
      const t = translator(props.t)
      const useInput = props.useInput
      const actions = props.inputActions

      // 草稿快照：只取需要的字段，避免每次按键都重渲整块。
      const draft = useInput((s) => s?.draft ?? '')
      const phase = useInput((s) => s?.phase ?? 'idle')
      const text = typeof draft === 'string' ? draft : ''
      const hasText = text.trim().length >= MIN_CHARS
      const busyMachine = phase === 'adjudicating' || phase === 'submitting'
      const canWrite = actions !== undefined && actions !== null && typeof actions.setDraft === 'function'

      // 四态 + 回退基线（原文 / 改写结果）与提示气泡。
      const [state, setState] = React.useState({ kind: 'idle' })
      const [toast, setToast] = React.useState(null)
      const abortRef = React.useRef(null)
      const toastTimer = React.useRef(null)

      // 草稿被用户改过 ⇒ 回退基线失效。这里**纯派生**、不用 effect：
      // setDraft 之后宿主快照要晚一帧才更新，用 effect 去比对文本会在
      // 「已写回」与「快照还是旧值」之间打架，把刚出现的「恢复原文」又抹掉。
      // 因此两种值都算「仍是改写结果」：刚写回时快照可能还是原文，随后才是改写文本。
      const doneVisible =
        state.kind === 'done' && (text === state.enhanced || text === state.original)

      // 卸载 / 换会话：收掉进行中的请求与计时器。
      React.useEffect(() => {
        return () => {
          abortRef.current?.abort()
          abortRef.current = null
          if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        }
      }, [props.sessionId])

      const showToast = React.useCallback((message) => {
        if (typeof message !== 'string' || message === '') return
        setToast(message)
        if (toastTimer.current !== null) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 4000)
      }, [])

      const enhancing = state.kind === 'loading'
      const done = doneVisible
      const failed = state.kind === 'error'

      // 可见性判定：空草稿 + 无结果 + 无错误 ⇒ 按钮根本不存在。
      if (!canWrite) return null
      if (!enhancing && !done && !failed && !hasText) return null

      const runEnhance = async () => {
        if (!hasText) {
          showToast(t('error.empty'))
          return
        }
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        const original = text
        setState({ kind: 'loading' })
        try {
          const enhanced = await requestEnhance(original, props.sessionId, controller.signal)
          if (controller.signal.aborted) return
          actions.setDraft(enhanced)
          actions.persistDraft?.()
          setState({ kind: 'done', original, enhanced })
        } catch (error) {
          if (error?.name === 'AbortError') {
            setState({ kind: 'idle' })
            return
          }
          const message = String(error?.message ?? error)
          setState({ kind: 'error' })
          showToast(describeFailure(error?.code, message, t))
        } finally {
          if (abortRef.current === controller) abortRef.current = null
        }
      }

      const cancel = () => {
        abortRef.current?.abort()
        abortRef.current = null
        setState({ kind: 'idle' })
      }

      const revert = () => {
        // 原文仍可用且草稿仍是「改写结果 / 尚未刷新成结果的原文」才回退；
        // 用户已改写草稿时只收按钮，绝不动新内容。
        const untouched =
          state.kind === 'done' &&
          typeof state.original === 'string' &&
          (text === state.enhanced || text === state.original)
        if (untouched) {
          actions.setDraft(state.original)
          actions.persistDraft?.()
        }
        setState({ kind: 'idle' })
      }

      let label
      let icon
      let dataState = 'idle'
      let onClick = runEnhance
      let disabled = false

      if (enhancing) {
        dataState = 'enhancing'
        label = t('action.enhancing')
        icon = e(SpinnerIcon, { className: 'ppp-spin' })
        onClick = cancel
      } else if (done) {
        dataState = 'done'
        label = t('action.revert')
        icon = e(RevertIcon, {})
        onClick = revert
      } else {
        dataState = failed ? 'error' : 'idle'
        label = failed ? t('error.failed') : t('action.enhance')
        icon = e(SparkleIcon, {})
        disabled = busyMachine || !hasText
      }

      return e(
        'span',
        { className: 'ppp-wrap' },
        e(
          'button',
          {
            type: 'button',
            className: 'ppp-btn',
            'data-state': dataState,
            'data-prompt-plus': 'enhance',
            'aria-label': label,
            title: label,
            'aria-busy': enhancing ? 'true' : undefined,
            disabled,
            onClick,
          },
          icon,
        ),
        toast === null ? null : e('div', { className: 'ppp-toast', role: 'status' }, toast),
      )
    }

    const EnhanceButtonMemo = React.memo(EnhanceButton)
    EnhanceButtonMemo.displayName = 'PromptPlusEnhanceButton'

    // -------------------------------------------------------------------------
    // 装配
    // -------------------------------------------------------------------------

    const inject = ['slots']

    function apply(ctx) {
      // 词典：locale 服务可选，缺了就用内置中文。
      ctx.inject(['locale'], (localeCtx) => {
        localeCtx.effect(() => localeCtx.locale.register(NS, { zh, en }), 'dsh-prompt-plus: dictionaries')
      })

      // 输入框工具栏左侧列表槽位（kind:list / scope:session）。宿主把它渲染在
      // 权限控件之后、模型选择之前 —— 输入内容左侧的第一个动作位。
      // order 40：排在 soul-quick-toggle（order 50）之前，改写紧贴输入内容。
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'prompt-plus-enhance',
            order: 40,
            locale: NS,
          },
          EnhanceButtonMemo,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.ENDPOINT = ENDPOINT
    exports.EnhanceButton = EnhanceButtonMemo
    return module.exports
  },
})

