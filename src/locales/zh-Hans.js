/**
 * zh-Hans 目录 —— 抽取源语言(source language)。
 *
 * ── 它是"源",但不是默认 ──
 *   文案最初用中文写,所以中文是抽取源;但默认语言是 en-US(见
 *   backlog/index.yaml 的 i18n-default-english 决策)。只有当 shell/显式
 *   覆盖给出肯定的 zh* 信号时才选中文目录。
 *
 * ── 目录的形态 ──
 *   和 en-US.js 一样是纯数据,键集必须和它逐字一致(含 _one / _other
 *   两种复数形式)。中文没有复数范畴,所以 _one 和 _other 写同一个值;
 *   这样做是为了让完整性测试只需要比较键集,而不必按语言解释复数规则。
 *
 *   键的字面量只允许出现在 src/messages.js。
 */
export const zhHans = Object.freeze({
  "notify.greeting": "你好,{name}",
  "notify.files_one": "{count} 个文件",
  "notify.files_other": "{count} 个文件",
  "reason.offline": "离线",
});

export default zhHans;
