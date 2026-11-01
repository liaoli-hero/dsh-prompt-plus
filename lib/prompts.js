// lib/prompts.js — 提示词重写：本插件的独立实现
//
// 与 WorkBuddy 的关系，只说事实：
//
//   逆向阶段读了它的 app.asar，确认了「提示词优化」这件事的**行为契约**：
//   输入一段草稿 → 输出改写后的草稿本身（不执行原请求）→ 语言随输入 →
//   不代答、不索要代码片段、不点名未提及的技术、不做 how-to、篇幅克制。
//
//   这些是**功能需求**，实现它们的方式有无穷多种。本文件里的提示词据此
//   重新写成，不是任何既有产品的原文，也没有逐句对应关系：
//   结构自定（分节标签而非流水句）、示例自选、措辞自成一套。
//
// 因此本文件可独立分发。原先「从 asar 逐字抽取」的生成逻辑与比对工具已移除。

/**
 * 系统提示词：定义「你是一个改写器，不是执行者」以及输出契约。
 *
 * 分节用标签而不是长段落，是为了让每条约束都能被模型单独定位：
 * 输出格式、语言、保留什么、补什么、多长。
 */
export const REWRITE_SYSTEM_PROMPT = `<role>
You rewrite one draft prompt that a person is about to send to a coding agent.
You are the editor, not the coding agent: you never carry out the request itself.
</role>

<output>
Return exactly the rewritten prompt, as plain text, and nothing else.
- No preamble, no sign-off, no "here is the rewritten version".
- No markdown fence, heading, or bullet list describing your changes.
- No question back to the person.
- If the draft is already clear, return it lightly polished rather than unchanged or empty.
</output>

<language>
Match the language of the draft exactly.
Chinese draft -> Chinese output. English draft -> English output.
Any other language -> that same language.
A draft that mixes languages keeps the same natural mix; do not flatten it into one.
Never state which language you detected, and never add language notes to the output.
</language>

<preserve>
Keep what the draft already decided: its goal, its subject, its constraints, and
the kind of result the person asked for. You are making an existing request
precise, not substituting your own idea of a better request.
</preserve>

<add>
Make explicit what the draft left implicit, but only what follows from the draft:
- the task, phrased as an action
- the scope: what is included and what is not
- the constraints already implied by the request
- the shape of the result the person should get back
Never invent requirements, facts, names, numbers, or technologies the draft did
not mention. Never turn the request into a tutorial, an implementation plan, or
an answer. Describe what is wanted, not how to build it.
</add>

<size>
Aim for roughly 800 characters; shorter is fine. Do not pad to reach it.
Finish on a complete sentence — no dangling conjunction, colon, or open list.
</size>

<example>
draft: 写个爬虫
rewritten: 写一个抓取网页内容的爬虫：由我指定目标站点与需要提取的字段，
处理分页与请求频率限制，把结果保存为结构化数据文件，并对请求失败和重复数据
做处理。请说明如何运行，以及如何确认抓取结果正确。
</example>

<example>
draft: make the error messages nicer
rewritten: Rewrite the error messages in this codebase so each one states what
failed, the likely cause, and the next action available to the reader, while
keeping the existing tone and language.
</example>`

/**
 * 用户消息：把草稿包进明确的边界里。
 *
 * 不复用「模板字符串 + replace」那套：草稿里出现 `$&`、`` $` ``、`$1` 时，
 * 字符串替换会把它们当成替换模式吞掉。这里直接拼接，从根上避免这类问题。
 *
 * @param {string} draft 用户草稿原文
 * @returns {string} 可直接作为 user message 的文本
 */
export function buildUserMessage(draft) {
  const text = String(draft ?? '').replace(/\r\n?/g, '\n').trim()
  return [
    'Rewrite the draft between the markers. Output only the rewritten draft.',
    '',
    '<draft>',
    text,
    '</draft>',
  ].join('\n')
}

/** 改写结果的软上限（字符）。提示词里让模型自己收敛，这里只做兜底提示。 */
export const SOFT_LIMIT_CHARS = 800

/**
 * 去掉模型给结果套的外层引号。
 *
 * 只削最外层一对，中间引号一律保留；首尾字符集**对称**（含中文引号与直角引号）。
 *
 * 这里的取舍与逆向对象不同：那边结尾漏了右单引号 ’，`内容’` 会留下 ’。
 * 独立实现按正确语义做，而不是复刻那处缺口 —— 复刻它没有任何收益。
 *
 * @param {string} text 模型输出
 * @returns {string} 去掉外层引号后的文本
 */
const WRAPPING = `["'\u201C\u201D\u2018\u2019\u300C\u300D]`
const LEADING = new RegExp(`^${WRAPPING}`, 'u')
const TRAILING = new RegExp(`${WRAPPING}$`, 'u')

export function unwrapQuotes(text) {
  return String(text)
    .trim()
    .replace(LEADING, '')
    .replace(TRAILING, '')
}
