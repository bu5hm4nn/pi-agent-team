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
  "notify.sendFailed": "team: not connected, the message was not sent",
  "notify.injectFailed": "team: failed to add the message to the model context: {reason}",
  "notify.remindFailed": "team: reminder failed: {reason}",
  "notify.cancelled": "Canceled",
  "notify.modeUnavailable": "team: {mode} mode is unavailable — {reason}",
  "notify.replaced": "team: node name \"{name}\" was taken over by another instance; this instance stopped reconnecting. Use a different name, or shut that instance down.",
  "notify.payloadTooLarge": "team: the message was too large, so the peer rejected it and closed the connection.",
  "notify.payloadTooLargeDetail": "  Peer explanation: {detail}",
  "notify.payloadTooLargeHint": "The connection reconnects automatically, but this message will not be resent — shorten it, or have the peer read the file itself.",
  "notify.tokenRejected": "team: the broker rejected this token ({url}). Reconnecting has stopped — retrying will not fix an incorrect token.",
  "notify.tokenMissing": "team: the broker refused the connection — no token was provided. Add it with /team join <team> --token <token>.",
  "notify.tokenLocalFingerprint": "  Local token fingerprint:  {fingerprint}",
  "notify.tokenBrokerFingerprint": "  Broker token fingerprint: {fingerprint}",
  "notify.tokenFingerprintExplanation": "The two fingerprints differ, which means this machine and the broker are not using the same token.",
  "notify.tokenFingerprintFixIntro": "The broker printed its fingerprint at startup; change one side so they match:",
  "notify.tokenFingerprintFixCommand": "  /team join <team> --token <the broker's token>",
  "notify.tokenNone": "(none)",
  "notify.tokenUnknown": "(unknown)",
  "notify.connectionReplaced": "team: the connection was replaced by an instance with the same name",
  "notify.replyLegacyName": "team: the old reply-strategy name \"{old}\" still works, but it is now called \"{mode}\". New form: TEAM_REPLY={mode} or --team-reply {mode}",
  "notify.replyUnknown": "team: unrecognized reply strategy \"{value}\"; valid values: off / remind / mirror",
  "notify.noTeamKnown": "team: no team was specified. Teams on this machine: {known}. Use --team <name> or /team join",
  "notify.noTeam": "team: not in any team. Use /team create or /team join",
  "notify.noPeersOnline": "No other nodes online",
  "notify.noTeamsConfigured": "No teams configured on this machine",
  "notify.currentTeamMarker": "  ← current",
  "notify.teamCreated": "team \"{team}\" was created and connected.\n\ntoken (shown only this once, also in the config file):\n{token}\n\n{join}",
  "reason.offline": "offline",
  "status.replaced": "⚠️ team:{name} (replaced)",
  "status.line_one": "{icon} team:{name} ({count}) {mode}",
  "status.line_other": "{icon} team:{name} ({count}) {mode}",
  "tool.moreLines_one": "…{count} more line",
  "tool.moreLines_other": "…{count} more lines",
  "tool.cardMoreLines_one": "…{count} more line (expand to view)",
  "tool.cardMoreLines_other": "…{count} more lines (expand to view)",
  "tool.notConnected": "not connected, the message was not sent",
  "tool.delivered": "✓ delivered to {to}",
  "tool.noPeers": "(no other nodes)",
  "tool.currentTeam": "(current)",
});

export default enUS;
