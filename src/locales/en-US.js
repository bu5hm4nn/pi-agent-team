/**
 * en-US 目录 —— 基准语言(base),也是默认语言。
 *
 * ── 为什么它是基准 ──
 *   Pi 本身就是英文的,所以任何无法肯定地判定为中文的场合都渲染英文
 *   (见 i18n.js 的 resolveLocale)。en-US 既是默认,也是缺键时的兜底:
 *   任何 locale 找不到的键都先回到这里,再回退成键本身。
 *
 * ── 目录的形态 ──
 *   纯数据,扁平对象,键是点分命名空间(notify.* / reason.* …),值是文案。
 *   复数消息用 `<base>_one` / `<base>_other` 两个键表示,由 t() 在
 *   params.count 存在时用 Intl.PluralRules 选一个。两个 catalog 的键集
 *   必须完全一致(含两种复数形式),否则完整性测试不过 —— 见
 *   src/i18n.test.js。中文没有复数范畴,zh-Hans 的 _one 与 _other 写成
 *   同一个值。
 *
 *   这个文件只放文案,不放逻辑。键的字面量只允许出现在 src/messages.js。
 */
export const enUS = Object.freeze({
  "notify.greeting": "Hello, {name}",
  "notify.files_one": "{count} file",
  "notify.files_other": "{count} files",
  "reason.offline": "offline",
});

export default enUS;
