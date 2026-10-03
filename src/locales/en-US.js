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

  "dispatch.unknownSubcommand": "Unknown subcommand \"{sub}\". Run /team to open the menu.",
  "dispatch.replyOn": "reply=remind (reminds once when a request goes unanswered)",
  "dispatch.replyOff": "reply=off (no reminder; whether to send is the model's decision)",
  "dispatch.none": "(none)",

  "dispatch.status.team": "current team  {team}",
  "dispatch.status.teamUnbound": "(unbound, connected directly via environment variables)",
  "dispatch.status.name": "node name    {name}",
  "dispatch.status.nameUnset": "(unset)",
  "dispatch.status.labels": "local labels {labels}",
  "dispatch.status.mode": "mode         {mode}",
  "dispatch.status.connState": "connection   {state}",
  "dispatch.status.broker": "broker       {url}",
  "dispatch.status.brokerUnset": "(not configured)",
  "dispatch.status.seeds": "seeds        {seeds}",
  "dispatch.status.seedsNone": "(none, can only wait for others to connect to you)",
  "dispatch.status.listenPort": "delivery port {port}",
  "dispatch.status.gossipPort": "gossip port  {port}",
  "dispatch.status.notReady": "(not ready)",
  "dispatch.status.seedFormGossip": "seed form    <address reachable from this machine>:{port}",
  "dispatch.status.seedFormListen": "seed form    <address reachable from this machine>:{port}",
  "dispatch.status.online_one": "online       {count} node ({others} others)",
  "dispatch.status.online_other": "online       {count} nodes ({others} others)",
  "dispatch.status.reply": "reply-strategy {reply}",
  "dispatch.status.teams": "saved teams  {teams}",

  "dispatch.peers.onlySelf": "only you are online ({self})",
  "dispatch.peers.hostGroup_one": "{host}  ({count})",
  "dispatch.peers.hostGroup_other": "{host}  ({count})",
  "dispatch.peers.hostUnknown": "(unknown host)",
  "dispatch.peers.member": "  {name}{labels}",
  "dispatch.peers.memberLabels": "  [{labels}]",
  "dispatch.peers.groups": "available groups: {groups}",

  "dispatch.missingTeam.givenIntro": "Missing team name. You provided {options}, but the team name must come first:",
  "dispatch.missingTeam.givenUsage": "  /team {sub} <team-name> {options}",
  "dispatch.missingTeam.none": "Missing team name.",
  "dispatch.missingTeam.usage": "  /team {sub} <team-name> [options]",
  "dispatch.missingTeam.known": "Already on this machine: {known}",
  "dispatch.missingTeam.knownHint": "A team that is already configured can be joined with just /team join {team}; no url or token needed.",
  "dispatch.missingTeam.createNameRule": "A team name may only contain lowercase letters and digits, for example dev or prod2.",
  "dispatch.missingTeam.optionsHeading": "Options:",

  "dispatch.unknownOptions": "Unrecognized options: {options}",
  "dispatch.modeLine": "mode: {mode}",
  "dispatch.brokerLine": "broker: {url}",
  "dispatch.seedsLine": "seeds: {seeds}",
  "dispatch.warning": "Note: {warning}",

  "dispatch.create.created": "Created team \"{team}\"  →  {path}",
  "dispatch.create.tokenGenerated": "Generated token (shown only this once; also stored in the config file):",
  "dispatch.create.brokerNextStep": "Next: you must start the broker yourself on {host} — /team create will not start it for you.",
  "dispatch.create.brokerHostUnknown": "<the machine running the broker>",
  "dispatch.create.brokerRunIntro": "Run this on that machine (only Node is needed, not Pi):",
  "dispatch.create.brokerCommand": "  TEAM_TOKEN='{token}' npx -y -p @yiki21/pi-agent-team pi-agent-team-broker --bind {host} --port {port}",
  "dispatch.create.brokerTokenNote": "The token must match this one, or the broker will refuse the connection.",
  "dispatch.create.brokerSystemd": "To run it as a persistent service, see docs/systemd.md.",
  "dispatch.create.joinIntro": "Other machines join with:",
  "dispatch.create.joinCommand": "  /team join {team} --url {url} --token {token}",
  "dispatch.create.joinCommandMode": "  /team join {team} --url {url} --token {token} --mode {mode}",

  "dispatch.join.joined": "Joining team \"{team}\"",
  "dispatch.join.adopted": "(first join; saved to the local config)",
  "dispatch.join.updated": "(config updated)",

  "dispatch.mode.current": "current mode: {mode}",
  "dispatch.mode.switchHeading": "Switch:",
  "dispatch.mode.helpBroker": "  /team mode broker   relayed through a broker, needs url",
  "dispatch.mode.helpMesh": "  /team mode mesh     nodes connect directly, needs seeds",
  "dispatch.mode.helpSwim": "  /team mode swim     SWIM membership + direct delivery, needs seeds and the sidecar",
  "dispatch.mode.note1": "Switching the mode alone does not touch url / token / seeds — those live in the team config.",
  "dispatch.mode.note2": "To change those, use /team join <team> --url ... --token ....",
  "dispatch.mode.invalid": "The mode must be {modes}, not \"{value}\"",
  "dispatch.mode.noTeam": "No team is bound yet, so the mode cannot be saved. Use /team join <team> --mode {mode} ...",
  "dispatch.mode.noConfig": "No local config for team \"{team}\"",
  "dispatch.mode.switched": "Mode switched: {from} → {to}",
  "dispatch.mode.swimSidecar": "swim needs the sidecar: cd swim && go build -o ../.tmp/swim-sidecar .",

  "dispatch.leave.usage": "Usage: /team leave <team>",
  "dispatch.leave.left": "Left team \"{team}\" (local config deleted)",

  "dispatch.label.current": "Local labels: {labels}",
  "dispatch.label.usageOp": "Usage: /team label {op} <name...>",
  "dispatch.label.updated": "Labels updated: {labels}",
  "dispatch.label.reconnect": "(labels changed; reconnecting to the broker)",
  "dispatch.label.usage": "Usage: /team label [list|add <name...>|remove <name...>]",

  "dispatch.send.usage": "Usage: /team send <name|@group|*|@default|a,b> <message>",
  "dispatch.send.noMatch": "No matching recipients ({targets})",
  "dispatch.send.noPeers": "No other nodes online",
  "dispatch.send.bulk_one": "About to send to {count} node: {targets}",
  "dispatch.send.bulk_other": "About to send to {count} nodes: {targets}",
  "dispatch.send.oversize": "The message is too long to send: {bytes} bytes (single-message limit about {limit} bytes). Split it into several messages, or have the peer read the file itself.",
  "dispatch.send.notConnected": "not connected, the message was not sent",
  "dispatch.send.sent_one": "Sent to {to} ({count} node)",
  "dispatch.send.sent_other": "Sent to {to} ({count} nodes)",
  "dispatch.send.asReply": "(as a reply to the request {id})",

  "dispatch.target.all": "everyone",
  "dispatch.target.default": "default group",

  "dispatch.reply.current": "current reply={reply}",
  "dispatch.reply.helpOff": "  off     no reminder — messages are delivered as usual; the model decides whether to reply",
  "dispatch.reply.helpRemind": "  remind  reminds once when a request goes unanswered (the reply is still sent explicitly by the model with team_send)",
  "dispatch.reply.helpMirror": "  mirror  mirrors every turn's output to all nodes (fyi, does not wake the peer)",
  "dispatch.reply.usage": "Usage: /team {sub} <off|remind|mirror>",
  "dispatch.reply.invalid": "The mode must be {modes}, not \"{value}\". current reply={current}",
  "dispatch.reply.noteOff": "No reminder — messages are delivered as usual; whether a reply is needed is entirely the model's decision",
  "dispatch.reply.noteRemind": "Reminds once when a request goes unanswered",
  "dispatch.reply.noteMirror": "Mirrors every turn's output to all nodes (fyi, does not wake the peer)",
  "dispatch.reply.set": "reply={mode}",
  "dispatch.reply.legacy": "(the old name \"{old}\" still works, but it is now called \"{mode}\")",

  "options.help": "  --url <http://host:port>    broker address (required for broker mode)\n  --token <hex>               team token (required)\n  --mode <broker|mesh|swim>   delivery mode (default broker)\n  --seeds <host:port,...>     seed addresses for mesh/swim\n  --name <name>               this node's name (this run only)\n  --labels <a,b>              this node's labels (this run only)\n  --port <n>                  mesh/swim listen port (this run only, 0 = auto)\n  --listen <address>          mesh/swim listen address (this run only)",
});

export default enUS;
