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
  "notify.sendFailed": "team:未连接,消息没发出去",
  "notify.injectFailed": "team:注入失败 {reason}",
  "notify.remindFailed": "team:提醒失败 {reason}",
  "notify.cancelled": "已取消",
  "notify.modeUnavailable": "team:{mode} 模式不可用 —— {reason}",
  "notify.replaced": "team:节点名 \"{name}\" 已被另一个实例接管,本实例停止重连。换一个名字,或关掉那个实例。",
  "notify.payloadTooLarge": "team:消息太大,对端拒绝了它并关闭了连接。",
  "notify.payloadTooLargeDetail": "  对端说明:{detail}",
  "notify.payloadTooLargeHint": "连接会自动重连,但这条消息不会补发 —— 请把内容拆短,或让对端自己读文件。",
  "notify.tokenRejected": "team:broker 拒绝了这个 token({url})。已停止重连 —— 重试多少次也不会变对。",
  "notify.tokenMissing": "team:broker 拒绝连接 —— 没有提供 token。用 /team join <team> --token <token> 补上。",
  "notify.tokenLocalFingerprint": "  本机 token 指纹:  {fingerprint}",
  "notify.tokenBrokerFingerprint": "  broker token 指纹:{fingerprint}",
  "notify.tokenFingerprintExplanation": "两个指纹不同,说明本机和 broker 用的不是同一个 token。",
  "notify.tokenFingerprintFixIntro": "broker 启动时打印过它的指纹;改其中一边让它们一致:",
  "notify.tokenFingerprintFixCommand": "  /team join <team> --token <broker 的 token>",
  "notify.tokenNone": "(无)",
  "notify.tokenUnknown": "(未知)",
  "notify.connectionReplaced": "team:连接被同名实例顶替",
  "notify.replyLegacyName": "team:回信策略的旧名字 \"{old}\" 仍可用,但现在叫 \"{mode}\"。新写法:TEAM_REPLY={mode} 或 --team-reply {mode}",
  "notify.replyUnknown": "team:认不出的回信策略 \"{value}\",可以用:off / remind / mirror",
  "notify.noTeamKnown": "team:未指定 team。本机已有:{known}。用 --team <名字> 或 /team join",
  "notify.noTeam": "team:未加入任何 team。用 /team create 或 /team join",
  "notify.noPeersOnline": "没有其他节点在线",
  "notify.noTeamsConfigured": "本机没有 team 配置",
  "notify.currentTeamMarker": "  ← 当前",
  "notify.teamCreated": "team \"{team}\" 已创建并连接。\n\ntoken(只显示这一次,也在配置文件里):\n{token}\n\n{join}",
  "reason.offline": "离线",
  "status.replaced": "⚠️ team:{name} (被顶替)",
  "status.line": "{icon} team:{name} ({count}) {mode}",
  "tool.moreLines": "…还有 {count} 行",
  "tool.cardMoreLines": "…还有 {count} 行(展开查看)",
  "tool.notConnected": "未连接,消息没发出去",
  "tool.delivered": "✓ 已投递给 {to}",
  "tool.noPeers": "(无其他节点)",
  "tool.currentTeam": "(当前)",
});

export default zhHans;
