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
  requireResponse: "tool.requireResponse",
  notConnected: "tool.notConnected",
  delivered: "tool.delivered",
  replied: "tool.replied",
  noPeers: "tool.noPeers",
  currentTeam: "tool.currentTeam",
  // 工具 execute() 的返回文字。它同时进 UI 和模型上下文,但按 story 18
  // 的定位属于"人类可见的失败/回执行",不随 D1 的模型载荷一起冻结。
  sendFailed: "tool.sendFailed",
  receipt: "tool.receipt",
  failed: "tool.failed",
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
  sendAwaitReply: "dispatch.send.awaitReply",
  sendBlocked: "dispatch.send.blocked",

  explicitReplyUsage: "dispatch.explicitReply.usage",
  explicitReplyUnknown: "dispatch.explicitReply.unknown",
  explicitReplySent: "dispatch.explicitReply.sent",

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
  replyMovedHint: "dispatch.reply.movedHint",
});

const session = Object.freeze({
  noMatch: "session.noMatch",
  noPeers: "session.noPeers",
  peerJoined: "session.peerJoined",
  peerJoinedWithHost: "session.peerJoinedWithHost",
  undeliverable: "session.undeliverable",
  undeliverableGroup: "session.undeliverableGroup",
  undeliverableUnknown: "session.undeliverableUnknown",
  undeliverableRecipient: "session.undeliverableRecipient",
  undeliverableNoRecipients: "session.undeliverableNoRecipients",
  unknownReason: "session.unknownReason",
  deliveredPartial: "session.deliveredPartial",
  deliveredFailed: "session.deliveredFailed",
  deliveredUnknown: "session.deliveredUnknown",
  deliveredSummary: "session.deliveredSummary",
  pendingOverflow: "session.pendingOverflow",
  peerOfflinePending: "session.peerOfflinePending",
  remindedStillPending: "session.remindedStillPending",
  replyReason: "session.replyReason",
  targetAll: "session.targetAll",
  targetDefault: "session.targetDefault",
});

const config = Object.freeze({
  teamNameInvalid: "config.teamNameInvalid",
  agentNameInvalid: "config.agentNameInvalid",
  modeInvalid: "config.modeInvalid",
  urlInvalid: "config.urlInvalid",
  brokerNeedsUrl: "config.brokerNeedsUrl",
  teamExists: "config.teamExists",
  tokenNotHex: "config.tokenNotHex",
  teamUnknownKnown: "config.teamUnknownKnown",
  teamUnknownNeedsToken: "config.teamUnknownNeedsToken",
  teamUnknown: "config.teamUnknown",
});

const mode = Object.freeze({
  invalid: "mode.invalid",
  missingToken: "mode.missingToken",
  brokerNeedsUrl: "mode.brokerNeedsUrl",
  brokerNeedsUrlShort: "mode.brokerNeedsUrlShort",
  meshNoSeeds: "mode.meshNoSeeds",
  meshNoSeedsShort: "mode.meshNoSeedsShort",
  swimSidecarMissing: "mode.swimSidecarMissing",
  swimSidecarNotFound: "mode.swimSidecarNotFound",
  unknown: "mode.unknown",
  unknownNoQuote: "mode.unknownNoQuote",
});

const transport = Object.freeze({
  swimSidecarMissing: "transport.swimSidecarMissing",
});

/** registerFlag 的帮助文案(人类可见,冻结在扩展加载时)。 */
const flag = Object.freeze({
  team: "flag.team",
  teamName: "flag.teamName",
  teamLabels: "flag.teamLabels",
  teamMode: "flag.teamMode",
  teamSeeds: "flag.teamSeeds",
  teamUrl: "flag.teamUrl",
  teamReply: "flag.teamReply",
  teamLang: "flag.teamLang",
});

/** registerCommand 的帮助文案。 */
const command = Object.freeze({
  team: "command.team",
});

/** index.ts 的交互界面文案(菜单、ui.select / ui.input 标题与选项)。 */
const ui = Object.freeze({
  confirmBulkTitle: "ui.confirmBulkTitle",
  confirmBulkBody: "ui.confirmBulkBody",

  menuViewMembers: "ui.menuViewMembers",
  menuSendToNode: "ui.menuSendToNode",
  menuBroadcast: "ui.menuBroadcast",
  menuManageLabels: "ui.menuManageLabels",
  menuTeamManage: "ui.menuTeamManage",
  menuConnectMode: "ui.menuConnectMode",
  menuReplyStrategy: "ui.menuReplyStrategy",
  menuStatus: "ui.menuStatus",

  inputNewTeam: "ui.inputNewTeam",
  placeholderLowerAlnum: "ui.placeholderLowerAlnum",
  selectJoinTeam: "ui.selectJoinTeam",
  optionNewTeam: "ui.optionNewTeam",
  inputTeamName: "ui.inputTeamName",
  selectConnectMode: "ui.selectConnectMode",
  modeBrokerRecommend: "ui.modeBrokerRecommend",
  modeMeshNoCenter: "ui.modeMeshNoCenter",
  modeSwimMembers: "ui.modeSwimMembers",
  brokerAddress: "ui.brokerAddress",
  inputSeeds: "ui.inputSeeds",
  placeholderSeedsSwim: "ui.placeholderSeedsSwim",
  placeholderSeeds: "ui.placeholderSeeds",
  placeholderTokenCreate: "ui.placeholderTokenCreate",
  placeholderToken: "ui.placeholderToken",

  selectSendWho: "ui.selectSendWho",
  inputSendTo: "ui.inputSendTo",
  placeholderMessage: "ui.placeholderMessage",
  selectMessageKind: "ui.selectMessageKind",
  messageKindSend: "ui.messageKindSend",
  messageKindAsk: "ui.messageKindAsk",

  broadcastDefault: "ui.broadcastDefault",
  broadcastAll: "ui.broadcastAll",
  broadcastLabel: "ui.broadcastLabel",
  selectBroadcastGroup: "ui.selectBroadcastGroup",
  inputBroadcastTo: "ui.inputBroadcastTo",

  selectLabelOp: "ui.selectLabelOp",
  labelOpList: "ui.labelOpList",
  labelOpAdd: "ui.labelOpAdd",
  labelOpRemove: "ui.labelOpRemove",
  inputLabelsAdd: "ui.inputLabelsAdd",
  inputLabelsRemove: "ui.inputLabelsRemove",
  placeholderCommaSeparated: "ui.placeholderCommaSeparated",

  selectTeamOp: "ui.selectTeamOp",
  teamOpList: "ui.teamOpList",
  teamOpJoin: "ui.teamOpJoin",
  teamOpCreate: "ui.teamOpCreate",
  teamOpLeave: "ui.teamOpLeave",

  modeBrokerNeedUrl: "ui.modeBrokerNeedUrl",
  modeMeshNeedSeeds: "ui.modeMeshNeedSeeds",
  modeSwimNeedSeeds: "ui.modeSwimNeedSeeds",

  selectReplyTitle: "ui.selectReplyTitle",
  replyOff: "ui.replyOff",
  replyRemind: "ui.replyRemind",
  replyMirror: "ui.replyMirror",

  menuReplyPending: "ui.menuReplyPending",
  selectReplyPending: "ui.selectReplyPending",
  inputReplyText: "ui.inputReplyText",
  replyPendingNone: "ui.replyPendingNone",
  acPendingFrom: "ui.acPendingFrom",

  acDefaultGroup: "ui.acDefaultGroup",
  acAll: "ui.acAll",
  acGroup: "ui.acGroup",
  acKnownConfig: "ui.acKnownConfig",
  acNodeName: "ui.acNodeName",
  acLabels: "ui.acLabels",
});

/** /team lang 命令的汇报文案与来源标签。 */
const lang = Object.freeze({
  report: "lang.report",
  set: "lang.set",
  setUnpersisted: "lang.setUnpersisted",
  invalid: "lang.invalid",
  unsupported: "lang.unsupported",
  usage: "lang.usage",
  source: Object.freeze({
    flag: "lang.source.flag",
    env: "lang.source.env",
    config: "lang.source.config",
    lcAll: "lang.source.lcAll",
    lcMessages: "lang.source.lcMessages",
    lang: "lang.source.lang",
    intl: "lang.source.intl",
    session: "lang.source.session",
  }),
});

const options = Object.freeze({
  help: "options.help",
  urlInvalid: "options.urlInvalid",
  tokenTooShort: "options.tokenTooShort",
  modeInvalid: "options.modeInvalid",
  seedsEmpty: "options.seedsEmpty",
  seedInvalid: "options.seedInvalid",
  nameInvalid: "options.nameInvalid",
  portInvalid: "options.portInvalid",
  listenInvalid: "options.listenInvalid",
  labelsTooMany: "options.labelsTooMany",
  missingToken: "options.missingToken",
  brokerNeedsUrl: "options.brokerNeedsUrl",
  meshNoSeeds: "options.meshNoSeeds",
});

export const M = Object.freeze({
  notify,
  reason,
  status,
  tool,
  dispatch,
  session,
  config,
  mode,
  transport,
  options,
  flag,
  command,
  ui,
  lang,
});

export default M;
