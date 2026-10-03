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
  sendFailed: "notify.sendFailed",
  injectFailed: "notify.injectFailed",
  remindFailed: "notify.remindFailed",
  cancelled: "notify.cancelled",
  modeUnavailable: "notify.modeUnavailable",
  replaced: "notify.replaced",
  payloadTooLarge: "notify.payloadTooLarge",
  payloadTooLargeDetail: "notify.payloadTooLargeDetail",
  payloadTooLargeHint: "notify.payloadTooLargeHint",
  tokenRejected: "notify.tokenRejected",
  tokenMissing: "notify.tokenMissing",
  tokenLocalFingerprint: "notify.tokenLocalFingerprint",
  tokenBrokerFingerprint: "notify.tokenBrokerFingerprint",
  tokenFingerprintExplanation: "notify.tokenFingerprintExplanation",
  tokenFingerprintFixIntro: "notify.tokenFingerprintFixIntro",
  tokenFingerprintFixCommand: "notify.tokenFingerprintFixCommand",
  tokenNone: "notify.tokenNone",
  tokenUnknown: "notify.tokenUnknown",
  connectionReplaced: "notify.connectionReplaced",
  replyLegacyName: "notify.replyLegacyName",
  replyUnknown: "notify.replyUnknown",
  noTeamKnown: "notify.noTeamKnown",
  noTeam: "notify.noTeam",
  noPeersOnline: "notify.noPeersOnline",
  noTeamsConfigured: "notify.noTeamsConfigured",
  currentTeamMarker: "notify.currentTeamMarker",
  teamCreated: "notify.teamCreated",
});

const reason = Object.freeze({
  offline: "reason.offline",
});

const status = Object.freeze({
  replaced: "status.replaced",
  line: "status.line",
});

const tool = Object.freeze({
  moreLines: "tool.moreLines",
  cardMoreLines: "tool.cardMoreLines",
  notConnected: "tool.notConnected",
  delivered: "tool.delivered",
  noPeers: "tool.noPeers",
  currentTeam: "tool.currentTeam",
});

const dispatch = Object.freeze({
  unknownSubcommand: "dispatch.unknownSubcommand",
  replyOn: "dispatch.replyOn",
  replyOff: "dispatch.replyOff",
  none: "dispatch.none",

  statusTeam: "dispatch.status.team",
  statusTeamUnbound: "dispatch.status.teamUnbound",
  statusName: "dispatch.status.name",
  statusNameUnset: "dispatch.status.nameUnset",
  statusLabels: "dispatch.status.labels",
  statusMode: "dispatch.status.mode",
  statusConnState: "dispatch.status.connState",
  statusBroker: "dispatch.status.broker",
  statusBrokerUnset: "dispatch.status.brokerUnset",
  statusSeeds: "dispatch.status.seeds",
  statusSeedsNone: "dispatch.status.seedsNone",
  statusListenPort: "dispatch.status.listenPort",
  statusGossipPort: "dispatch.status.gossipPort",
  statusNotReady: "dispatch.status.notReady",
  statusSeedFormGossip: "dispatch.status.seedFormGossip",
  statusSeedFormListen: "dispatch.status.seedFormListen",
  statusOnline: "dispatch.status.online",
  statusReply: "dispatch.status.reply",
  statusTeams: "dispatch.status.teams",

  peersOnlySelf: "dispatch.peers.onlySelf",
  peersHostGroup: "dispatch.peers.hostGroup",
  peersHostUnknown: "dispatch.peers.hostUnknown",
  peersMember: "dispatch.peers.member",
  peersMemberLabels: "dispatch.peers.memberLabels",
  peersGroups: "dispatch.peers.groups",

  missingTeamGivenIntro: "dispatch.missingTeam.givenIntro",
  missingTeamGivenUsage: "dispatch.missingTeam.givenUsage",
  missingTeamNone: "dispatch.missingTeam.none",
  missingTeamUsage: "dispatch.missingTeam.usage",
  missingTeamKnown: "dispatch.missingTeam.known",
  missingTeamKnownHint: "dispatch.missingTeam.knownHint",
  missingTeamCreateNameRule: "dispatch.missingTeam.createNameRule",
  missingTeamOptionsHeading: "dispatch.missingTeam.optionsHeading",

  unknownOptions: "dispatch.unknownOptions",
  modeLine: "dispatch.modeLine",
  brokerLine: "dispatch.brokerLine",
  seedsLine: "dispatch.seedsLine",
  warning: "dispatch.warning",

  createCreated: "dispatch.create.created",
  createTokenGenerated: "dispatch.create.tokenGenerated",
  createBrokerNextStep: "dispatch.create.brokerNextStep",
  createBrokerHostUnknown: "dispatch.create.brokerHostUnknown",
  createBrokerRunIntro: "dispatch.create.brokerRunIntro",
  createBrokerCommand: "dispatch.create.brokerCommand",
  createBrokerTokenNote: "dispatch.create.brokerTokenNote",
  createBrokerSystemd: "dispatch.create.brokerSystemd",
  createJoinIntro: "dispatch.create.joinIntro",
  createJoinCommand: "dispatch.create.joinCommand",
  createJoinCommandMode: "dispatch.create.joinCommandMode",

  joinJoined: "dispatch.join.joined",
  joinAdopted: "dispatch.join.adopted",
  joinUpdated: "dispatch.join.updated",

  modeCurrent: "dispatch.mode.current",
  modeSwitchHeading: "dispatch.mode.switchHeading",
  modeHelpBroker: "dispatch.mode.helpBroker",
  modeHelpMesh: "dispatch.mode.helpMesh",
  modeHelpSwim: "dispatch.mode.helpSwim",
  modeNote1: "dispatch.mode.note1",
  modeNote2: "dispatch.mode.note2",
  modeInvalid: "dispatch.mode.invalid",
  modeNoTeam: "dispatch.mode.noTeam",
  modeNoConfig: "dispatch.mode.noConfig",
  modeSwitched: "dispatch.mode.switched",
  modeSwimSidecar: "dispatch.mode.swimSidecar",

  leaveUsage: "dispatch.leave.usage",
  leaveLeft: "dispatch.leave.left",

  labelCurrent: "dispatch.label.current",
  labelUsageOp: "dispatch.label.usageOp",
  labelUpdated: "dispatch.label.updated",
  labelReconnect: "dispatch.label.reconnect",
  labelUsage: "dispatch.label.usage",

  sendUsage: "dispatch.send.usage",
  sendNoMatch: "dispatch.send.noMatch",
  sendNoPeers: "dispatch.send.noPeers",
  sendBulk: "dispatch.send.bulk",
  sendOversize: "dispatch.send.oversize",
  sendNotConnected: "dispatch.send.notConnected",
  sendSent: "dispatch.send.sent",
  sendAsReply: "dispatch.send.asReply",

  targetAll: "dispatch.target.all",
  targetDefault: "dispatch.target.default",

  replyCurrent: "dispatch.reply.current",
  replyHelpOff: "dispatch.reply.helpOff",
  replyHelpRemind: "dispatch.reply.helpRemind",
  replyHelpMirror: "dispatch.reply.helpMirror",
  replyUsage: "dispatch.reply.usage",
  replyInvalid: "dispatch.reply.invalid",
  replyNoteOff: "dispatch.reply.noteOff",
  replyNoteRemind: "dispatch.reply.noteRemind",
  replyNoteMirror: "dispatch.reply.noteMirror",
  replySet: "dispatch.reply.set",
  replyLegacy: "dispatch.reply.legacy",
});

const options = Object.freeze({
  help: "options.help",
});

export const M = Object.freeze({
  notify,
  reason,
  status,
  tool,
  dispatch,
  options,
});

export default M;
