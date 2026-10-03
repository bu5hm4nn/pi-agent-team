/**
 * 消息键的符号注册表。
 *
 * ── 为什么要有这一层 ──
 *   调用点如果直接写 "notify.greeting" 这样的裸字符串,键就会散落在
 *   各个模块里:改一个键要全仓库搜,删一个键不知道还有谁在用,拼错
 *   了也只有运行时才发现。所以键的字面量**只允许出现在本模块**,调用点
 *   一律用 M.notify.greeting 这样的符号引用。i18n.test.js 的 orphan 测试
 *   会验证:每个 M 里的值在两个目录里都能解析,目录里也没有 M 到不了的键。
 *
 * ── 形态 ──
 *   嵌套对象,叶子是点分键字符串;每层都 Object.freeze。复数消息只登记
 *   基础键(如 M.notify.files),t() 在 params.count 存在时自己拼
 *   `_one` / `_other`。
 *
 *   本模块不导入任何东西,也不放逻辑 —— 它只是键的清单。
 */

const notify = Object.freeze({
  greeting: "notify.greeting",
  files: "notify.files",
});

const reason = Object.freeze({
  offline: "reason.offline",
});

export const M = Object.freeze({
  notify,
  reason,
});

export default M;
