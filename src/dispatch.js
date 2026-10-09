/**
 * Team 动作分发 —— 纯函数,不依赖 Pi、不依赖网络。
 *
 * 命令(/team ...)和工具(team_*)都调这里的 dispatch(),所以两个
 * 入口的行为不可能分叉。它们只负责:
 *   - 把参数整理成 { sub, args }
 *   - 把返回的 intentions 执行掉并选择输出方式
 *
 * dispatch 不产生副作用。它返回一份"打算做什么"的描述,由调用方
 * 执行。这是它能被单测的原因:
 *
 *   const r = dispatch({ sub: "send", args: ["peer", "hi"] }, state, env)
 *   assert.equal(r.intentions[0].type, "send")
 */

import {
  bindRequest,
  blockedTargets,
  knownLabels,
  others as othersOf,
  parseRecipients,
  resolveLocal,
  teamSize,
} from "./session.js";
import { createTeam, joinTeam, leaveTeam, listTeams, readTeam } from "./team-config.js";
import { optionHelp, checkModeRequirements, parseOptionArgs, validateOptions } from "./options.js";
import { MODES } from "./mode.js";
import { t } from "./i18n.js";
import { M } from "./messages.js";

/** 群发前确认阈值。每个收件人都会跑一轮完整思考,不该手滑就发生。 */
export const BULK_WARN_THRESHOLD = 5;

/**
 * @typedef {{
 *   ok: boolean,
 *   lines: string[],
 *   error?: string,
 *   intentions?: Array<Record<string, unknown>>,
 *   party?: { kind: string } & Record<string, unknown>,
 * }} Result
 *
 * Intentions 是调用方要执行的动作:
 *   { type: "send", to, id, re, body }       通过 transport 发出
 *   { type: "card", kind, peer, text, reason? }  在聊天流插卡片
 *   { type: "notify", level, message }       通知用户
 *   { type: "status" }                       刷新状态栏
 *
 * party 是生命周期动作(连接/断开/重连),由调用方处理:
 *   { kind: "connect", team, config }
 *   { kind: "disconnect" }
 *   { kind: "reconnect", labels }   标签变了要重连 broker 才会知道
 *   { kind: "confirmBulk", n }      需要用户确认的群发
 */

const ok = (lines, extra = {}) => ({ ok: true, lines, intentions: [], ...extra });
// bad() 也带 intentions:[] —— 让调用方不必区别 undefined 和空数组。
// 之前 send 离线时返回 undefined,调用方要么写 defensive 判断,
// 要么就漏掉,两种都容易出错。
const bad = (error) => ({ ok: false, lines: [], intentions: [], error });

/**
 * 消息 id 生成。
 *
 * 必须全 cluster 唯一。早期版本是 `m-<时间>-<进程内计数器>`,
 * 缺了进程标识 —— 两个节点在同一毫秒各发一条时,时间相同、计数
 * 器都从 0 开始,id 必然碰撞。接收方靠 id 去重,于是第二条被当成
 * 重复投递静默丢弃。
 *
 * 症状极难定位:发送方看到"投递 1/1",接收方毫无反应。
 *
 * 组成:时间(可排序)+ 进程级随机数(跨进程不重复)+ 进程内计数器
 * (同毫秒内不重复)。
 */
const PROC_TAG = Math.random().toString(36).slice(2, 8);
let idSeq = 0;
const newId = () => `m-${Date.now().toString(36)}-${PROC_TAG}-${(idSeq++).toString(36)}`;

/**
 * 主分发。
 *
 * @param {{ sub: string, args: string[], origin?: "user"|"model" }} input
 *   子命令 send / ask 共用同一条发送路径;origin 区分人发的(/team)与
 *   模型发的(team_send / team_ask)。
 * @param {import("./session.js").SessionState} state  读写:只改 reply / selfLabels / outbound
 * @param {{ connState: string, team: string|null, config: {url,token,labels?}|null, host?: string }} env
 * @returns {Result}
 */
export function dispatch(input, state, env) {
  const { sub, args } = input;

  switch (sub) {
    case "":
    case "status":
      return ok(statusLines(state, env));

    case "peers":
      return peersResult(state);

    case "create":
      return createResult(args, state);

    case "join":
      return joinResult(args, state);

    case "leave":
      return leaveResult(args, state, env);

    case "mode":
      return modeResult(args, state, env);

    case "label":
      return labelResult(args, state, env);

    case "send":
    case "say":
      return transmitResult(args, state, env, "send", input.origin);

    // ask 是同一条发送路径,只是信封上带 requireResponse: 对方会被要求
    // 回信,未回复时提醒一次。send 不带标志 —— 送达并唤醒,但不要求回复。
    case "ask":
      return transmitResult(args, state, env, "ask", input.origin);

    // reply 现在是**显式回复**(按 request id)。它不再兼做提醒策略 ——
    // 策略搬到 /team replies,旧写法 /team reply <mode> 仍兼容。
    case "reply":
      return replySubcommand(args, state, env, input.origin);

    // replies(以及旧名字 announce)才是回信策略。
    case "replies":
    case "announce":
      return replyPolicyResult(args, state, sub);

    case "on":
      state.reply = "remind";
      return ok([t(M.dispatch.replyOn)]);

    case "off":
      state.reply = "off";
      return ok([t(M.dispatch.replyOff)]);

    default:
      return bad(t(M.dispatch.unknownSubcommand, { sub }));
  }
}

// ---------------------------------------------------------------- status / peers

function statusLines(state, env) {
  const cfg = env.config ?? (env.team ? readTeam(env.team) : null);
  const mode = env.mode ?? cfg?.mode ?? "broker";

  const lines = [
    // 这里说的是"本次连接属于哪个 team",和末尾"已存 team 列表"不是一回事。
    // 措辞要区分开,否则用环境变量连接时会同时看到"未加入"和"已存 dev",
    // 看起来自相矛盾(实测中确实被误读成一个 bug)。
    t(M.dispatch.statusTeam, {
      team: env.team ?? t(M.dispatch.statusTeamUnbound),
    }),
    t(M.dispatch.statusName, { name: state.self || t(M.dispatch.statusNameUnset) }),
    t(M.dispatch.statusLabels, {
      labels: state.selfLabels?.length ? state.selfLabels.join(", ") : t(M.dispatch.none),
    }),
    t(M.dispatch.statusMode, { mode }),
    t(M.dispatch.statusConnState, { state: env.connState }),
  ];

  if (mode === "broker") {
    lines.push(t(M.dispatch.statusBroker, { url: cfg?.url ?? t(M.dispatch.statusBrokerUnset) }));
  } else {
    lines.push(
      t(M.dispatch.statusSeeds, {
        seeds: (cfg?.seeds ?? []).join(", ") || t(M.dispatch.statusSeedsNone),
      }),
    );
    lines.push(
      t(M.dispatch.statusListenPort, { port: env.listenPort ?? t(M.dispatch.statusNotReady) }),
    );

    // 种子地址说的是哪个端口,取决于模式:
    //   mesh  直接连对端的投递端口
    //   swim  连对端的 gossip 端口,投递端口由成员信息带出来
    if (mode === "swim") {
      lines.push(
        t(M.dispatch.statusGossipPort, { port: env.gossipPort ?? t(M.dispatch.statusNotReady) }),
      );
      if (env.gossipPort) lines.push(t(M.dispatch.statusSeedFormGossip, { port: env.gossipPort }));
    } else if (env.listenPort) {
      lines.push(t(M.dispatch.statusSeedFormListen, { port: env.listenPort }));
    }
  }

  lines.push(
    t(M.dispatch.statusOnline, { count: teamSize(state), others: othersOf(state).length }),
    t(M.dispatch.statusReply, { reply: state.reply }),
    t(M.dispatch.statusTeams, { teams: listTeams().join(", ") || t(M.dispatch.none) }),
  );
  return lines;
}

function peersResult(state) {
  const list = othersOf(state);
  if (!list.length) {
    return { ok: true, lines: [t(M.dispatch.peersOnlySelf, { self: state.self })], intentions: [] };
  }

  const lines = [];
  const byHost = new Map();
  for (const m of list) {
    const k = m.host ?? t(M.dispatch.peersHostUnknown);
    if (!byHost.has(k)) byHost.set(k, []);
    byHost.get(k).push(m);
  }
  for (const [host, arr] of [...byHost].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(t(M.dispatch.peersHostGroup, { host, count: arr.length }));
    for (const m of [...arr].sort((x, y) => x.name.localeCompare(y.name))) {
      const labels = m.labels?.length
        ? t(M.dispatch.peersMemberLabels, { labels: m.labels.join(" ") })
        : "";
      lines.push(t(M.dispatch.peersMember, { name: m.name, labels }));
    }
  }
  const labels = knownLabels(state);
  if (labels.length) {
    lines.push("", t(M.dispatch.peersGroups, { groups: labels.map((l) => `@${l}`).join(" ") }));
  }
  return ok(lines);
}

// ---------------------------------------------------------------- team 生命周期

/**
 * 缺 team 名时的提示。
 *
 * 以前只报一句"用法:…"加一张选项表。用户给齐了 --url 和 --token,
 * 看起来该给的都给了,所以读那张表找不出错在哪 —— 实际上漏的是
 * 最前面那个位置参数。这里把"缺的是什么"说在第一行。
 */
function missingTeamName(sub, parsed) {
  const given = Object.keys(parsed.values);
  const lines = [];

  if (given.length) {
    // 给了选项但没给名字:这是最容易犯的错,要直接点出来
    lines.push(
      t(M.dispatch.missingTeamGivenIntro, { options: given.map((k) => `--${k}`).join(" ") }),
      "",
      t(M.dispatch.missingTeamGivenUsage, {
        sub,
        options: given.map((k) => `--${k} …`).join(" "),
      }),
    );
  } else {
    lines.push(t(M.dispatch.missingTeamNone), "", t(M.dispatch.missingTeamUsage, { sub }));
  }

  const known = listTeams();
  if (sub === "join" && known.length) {
    lines.push(
      "",
      t(M.dispatch.missingTeamKnown, { known: known.join(", ") }),
      t(M.dispatch.missingTeamKnownHint, { team: known[0] }),
    );
  }
  if (sub === "create") {
    lines.push("", t(M.dispatch.missingTeamCreateNameRule));
  }

  lines.push("", t(M.dispatch.missingTeamOptionsHeading), optionHelp());
  return lines.join("\n");
}

function createResult(args, state) {
  // 位置形式(/team create t <url> [token])和选项形式都接受。
  // 位置形式保留是因为它用了很久,选项形式是为了设置 mode/seeds。
  const parsed = parseOptionArgs(args);
  if (parsed.unknown.length) {
    return bad(`${t(M.dispatch.unknownOptions, { options: parsed.unknown.join(", ") })}\n${optionHelp()}`);
  }

  const [team, posUrl, posToken] = parsed.rest;
  if (!team) return bad(missingTeamName("create", parsed));

  const values = { ...parsed.values };
  if (posUrl && !values.url) values.url = posUrl;
  if (posToken && !values.token) values.token = posToken;

  const v = validateOptions(values);
  if (!v.ok) return bad(v.reason);

  const mode = v.team.mode ?? "broker";
  const req = checkModeRequirements({
    mode,
    url: v.team.url,
    seeds: v.team.seeds,
    token: v.team.token ?? "(to-be-generated)",
  });
  if (!req.ok) return bad(req.reason);

  const r = createTeam({
    team,
    url: v.team.url,
    token: v.team.token,
    mode,
    seeds: v.team.seeds ?? [],
  });
  if (!r.ok) return bad(r.reason);

  const lines = [
    t(M.dispatch.createCreated, { team, path: r.path }),
    t(M.dispatch.modeLine, { mode: r.config.mode }),
  ];
  if (r.config.url) lines.push(t(M.dispatch.brokerLine, { url: r.config.url }));
  if (r.config.seeds?.length) lines.push(t(M.dispatch.seedsLine, { seeds: r.config.seeds.join(", ") }));
  if (req.warning) lines.push("", t(M.dispatch.warning, { warning: req.warning }));

  if (r.created) {
    lines.push("", t(M.dispatch.createTokenGenerated), r.token);
  }

  // create 只写本地配置、让本机去连。它不启动任何东西。
  //
  // 这一点以前没说,于是用户会以为 team 已经建好可以用了 —— 而此时
  // 对面可能根本没有 broker 在监听,或者在监听但用的是另一个 token。
  // 两种都表现为"连不上",看起来像网络问题。
  if (r.config.mode === "broker") {
    const host = (() => {
      try {
        return new URL(r.config.url).hostname;
      } catch {
        return t(M.dispatch.createBrokerHostUnknown);
      }
    })();
    const port = (() => {
      try {
        return new URL(r.config.url).port || "8787";
      } catch {
        return "8787";
      }
    })();
    lines.push(
      "",
      t(M.dispatch.createBrokerNextStep, { host }),
      t(M.dispatch.createBrokerRunIntro),
      "",
      t(M.dispatch.createBrokerCommand, { token: r.token, host, port }),
      "",
      t(M.dispatch.createBrokerTokenNote),
      t(M.dispatch.createBrokerSystemd),
    );
  }

  lines.push(
    "",
    t(M.dispatch.createJoinIntro),
    r.config.mode !== "broker"
      ? t(M.dispatch.createJoinCommandMode, {
          team,
          url: r.config.url ?? "<url>",
          token: r.token,
          mode: r.config.mode,
        })
      : t(M.dispatch.createJoinCommand, {
          team,
          url: r.config.url ?? "<url>",
          token: r.token,
        }),
  );
  // 创建后直接连上,省得用户再敲一次 join
  return ok(lines, {
    party: {
      kind: "connect",
      team,
      config: r.config,
      session: v.session,
    },
  });
}

function joinResult(args, state) {
  const parsed = parseOptionArgs(args);
  if (parsed.unknown.length) {
    return bad(`${t(M.dispatch.unknownOptions, { options: parsed.unknown.join(", ") })}\n${optionHelp()}`);
  }

  const [team, posUrl, posToken] = parsed.rest;
  if (!team) return bad(missingTeamName("join", parsed));

  const values = { ...parsed.values };
  if (posUrl && !values.url) values.url = posUrl;
  if (posToken && !values.token) values.token = posToken;

  const v = validateOptions(values);
  if (!v.ok) return bad(v.reason);

  // 已有配置时,mode/seeds 必须能改 —— 否则想从 broker 换成 mesh
  // 就只能 leave 再 join,而那会把 token 也一起忘掉。
  const existing = readTeam(team);
  const mode = v.team.mode ?? existing?.mode ?? "broker";

  const req = checkModeRequirements({
    mode,
    url: v.team.url ?? existing?.url,
    seeds: v.team.seeds ?? existing?.seeds,
    token: v.team.token ?? existing?.token,
  });
  if (!req.ok) return bad(req.reason);

  const r = joinTeam({
    team,
    url: v.team.url,
    token: v.team.token,
    mode: v.team.mode,
    seeds: v.team.seeds,
  });
  if (!r.ok) return bad(r.reason);

  const lines = [
    t(M.dispatch.joinJoined, { team }),
    t(M.dispatch.modeLine, { mode: r.config.mode }),
  ];
  if (r.config.url) lines.push(t(M.dispatch.brokerLine, { url: r.config.url }));
  if (r.config.seeds?.length) lines.push(t(M.dispatch.seedsLine, { seeds: r.config.seeds.join(", ") }));
  if (r.adopted) lines.push(t(M.dispatch.joinAdopted));
  if (r.updated) lines.push(t(M.dispatch.joinUpdated));
  if (req.warning) lines.push("", t(M.dispatch.warning, { warning: req.warning }));

  return ok(lines, {
    party: {
      kind: "connect",
      team,
      config: r.config,
      session: v.session,
    },
  });
}

/** /team mode —— 查看或切换模式,不必重敲 url/token */
function modeResult(args, state, env) {
  const want = (args[0] ?? "").toLowerCase();

  if (!want) {
    const current = env.mode ?? env.config?.mode ?? "broker";
    return ok([
      t(M.dispatch.modeCurrent, { mode: current }),
      "",
      t(M.dispatch.modeSwitchHeading),
      t(M.dispatch.modeHelpBroker),
      t(M.dispatch.modeHelpMesh),
      t(M.dispatch.modeHelpSwim),
      "",
      t(M.dispatch.modeNote1),
      t(M.dispatch.modeNote2),
    ]);
  }

  if (!MODES.includes(want)) {
    return bad(t(M.dispatch.modeInvalid, { modes: MODES.join(" / "), value: want }));
  }

  const team = env.team;
  if (!team) {
    return bad(t(M.dispatch.modeNoTeam, { mode: want }));
  }

  const existing = readTeam(team);
  if (!existing) return bad(t(M.dispatch.modeNoConfig, { team }));

  const req = checkModeRequirements({
    mode: want,
    url: existing.url,
    seeds: existing.seeds,
    token: existing.token,
  });
  if (!req.ok) return bad(req.reason);

  const r = joinTeam({ team, mode: want });
  if (!r.ok) return bad(r.reason);

  const lines = [t(M.dispatch.modeSwitched, { from: existing.mode ?? "broker", to: want })];
  if (req.warning) lines.push("", t(M.dispatch.warning, { warning: req.warning }));
  if (want === "swim") lines.push("", t(M.dispatch.modeSwimSidecar));

  return ok(lines, { party: { kind: "connect", team, config: r.config, session: sessionFrom(state) } });
}

/** 把当前会话级的选项打包给 connect */
function sessionFrom(state) {
  const out = {};
  if (state.self) out.name = state.self;
  if (state.selfLabels?.length) out.labels = state.selfLabels;
  return out;
}

function leaveResult(args, state, env) {
  const target = args[0] ?? env.team;
  if (!target) return bad(t(M.dispatch.leaveUsage));

  const r = leaveTeam({ team: target });
  if (!r.ok) return bad(r.reason);
  return ok([t(M.dispatch.leaveLeft, { team: target })], { party: { kind: "disconnect" } });
}

// ---------------------------------------------------------------- label

function labelResult(args, state, env) {
  const [op, ...rest] = args;
  const labels = new Set(state.selfLabels ?? []);

  if (!op || op === "list") {
    return ok([
      t(M.dispatch.labelCurrent, {
        labels: labels.size ? [...labels].join(", ") : t(M.dispatch.none),
      }),
    ]);
  }

  if (op === "add" || op === "remove" || op === "rm") {
    const names = rest.filter(Boolean);
    if (!names.length) return bad(t(M.dispatch.labelUsageOp, { op }));
    for (const l of names) (op === "add" ? labels.add(l) : labels.delete(l));
    state.selfLabels = [...labels];

    const lines = [
      t(M.dispatch.labelUpdated, {
        labels: state.selfLabels.join(", ") || t(M.dispatch.none),
      }),
    ];
    // 标签是 broker 侧的分组依据,改了必须重连它才知道
    if (env.connState === "online") lines.push(t(M.dispatch.labelReconnect));
    return ok(lines, { party: { kind: "reconnect", labels: state.selfLabels } });
  }

  return bad(t(M.dispatch.labelUsage));
}

// ---------------------------------------------------------------- send / ask

function transmitResult(args, state, env, sub, origin) {
  const rawTo = args[0];
  const text = args.slice(1).join(" ");
  if (!rawTo || !text) return bad(t(M.dispatch.sendUsage, { sub }));

  // origin 以前写死成 "user",连 team_send 工具也是 —— 于是模型发出的消息
  // 被记成人发的,对方回复时只显示卡片,模型永远看不到那条回复。
  // 工具路径在 index.ts 里传 origin:"model"。
  const sender = origin === "model" ? "model" : "user";
  return transmit(rawTo, text, sender, state, env, { requireResponse: sub === "ask" });
}

/**
 * 发送的实际执行 —— command 和 tool(team_send / team_ask)共用这一条路径。
 *
 * 群发超过阈值时不直接发,返回 confirmBulk 让上层决定怎么问:
 * 命令走 confirm 对话框,工具走结构化返回让模型自己判断。
 *
 * ── 有待回复的人不能被发送绕过 ──
 * send/ask 都要在发出**之前**检查整组收件人:谁还有未回复的请求,
 * 就拒绝整次发送(没有部分发送),让它先用 team_reply。这是为了让
 * 「新消息」不会把对方的请求无声地晾在一边 —— 义务还在,却没人回。
 * 与待回复者无关的节点不受影响。
 *
 * requireResponse 与 targets 必须跟着 party 一起返回,否则用户确认后
 * 那一步会丢标志/丢收件人 —— 确认后的 doTransmit 拿不到它们,
 * ask 会静默退化成 send,阻断也无法在对话期间重新校验。
 */
export function transmit(rawTo, text, origin, state, env, opts = {}) {
  const requireResponse = opts.requireResponse === true;
  const to = parseRecipients(rawTo);
  const local = resolveLocal(state, to);

  if (local.targets.length === 0) {
    return bad(
      local.unknown.length
        ? t(M.dispatch.sendNoMatch, { targets: local.unknown.join(",") })
        : t(M.dispatch.sendNoPeers),
    );
  }

  // 整组校验,原子拒绝:组内任何一人有待回复,就一次都不发。
  const blocked = blockedTargets(state, local.targets);
  if (blocked.length) return bad(blockedMessage(blocked));

  const isBulk =
    to === "*" || to === "@default" || Array.isArray(to) || (typeof to === "string" && to.startsWith("@"));
  if (isBulk && local.targets.length > BULK_WARN_THRESHOLD) {
    return ok(
      [
        t(M.dispatch.sendBulk, {
          count: local.targets.length,
          targets: local.targets.join(", "),
        }),
      ],
      {
        party: {
          kind: "confirmBulk",
          n: local.targets.length,
          to,
          text,
          origin,
          requireResponse,
          targets: local.targets,
        },
      },
    );
  }

  return doTransmit(to, text, origin, local, state, env, { requireResponse });
}

/** 阻断错误:列出 pending 的 request id 和对应队友,并指明先 team_reply。 */
function blockedMessage(blocked) {
  const requests = blocked.map((b) => `${b.ids.join(",")}(${b.peer})`).join("; ");
  return t(M.dispatch.sendBlocked, { requests });
}

/**
 * 真正发出。确认过群发之后也走这里,避免两条路径。
 */
/**
 * 消息是否超过一帧能装下的体积。
 *
 * ── 为什么在发送前就查 ──
 * 实测:超限时发送侧没有任何本地报错 —— socket.send 接受它,broker 读到
 * 长度头就断开连接,发送方只看到 close 1006,和网线被拔一模一样。
 * 用户会去查网络、防火墙、地址,而真正的原因是文本太长。
 *
 * 在本地拦住可以:保住连接、给出可操作的错误(让模型把内容拆短),
 * 而且三种 transport 都受益。
 *
 * 估算用顶层信封的字节数。body 之外还有 from/to/id/re 这些字段,
 * 所以这里留一点余量 —— 宁可稍微早报,也不要漏过去把连接搞断。
 */
export const ENVELOPE_HEADROOM = 512;

export function oversizeBy(text) {
  const frameLimit = 64 * 1024;
  const bytes = Buffer.byteLength(String(text ?? ""), "utf8");
  const total = bytes + ENVELOPE_HEADROOM;
  return total > frameLimit ? { bytes, limit: frameLimit, total } : null;
}

/**
 * 真正发出。确认过群发之后也走这里,避免两条路径。
 *
 * opts.kind:
 *   "send"  普通通知(缺省)
 *   "ask"   要求回信
 *   "reply" 显式回复(team_reply)
 *
 * 只有 reply 例外于“有待回复就阻断”:回复正是解除阻断的动作,即便同一
 * 队友还有别的未回复请求,也要允许针对其中一条发出(只消费匹配的那条)。
 *
 * 阻断在这里**再查一次**:群发确认对话框弹出到真正发送之间可能收到新
 * 的请求,如果只在 transmit 里查一次,确认后的那一下就会漏过去。
 */
export function doTransmit(to, text, origin, local, state, env, opts = {}) {
  const kind = opts.kind ?? (opts.requireResponse === true ? "ask" : "send");
  const isReply = kind === "reply";

  if (!isReply) {
    const blocked = blockedTargets(state, local?.targets ?? []);
    if (blocked.length) return bad(blockedMessage(blocked));
  }

  // 先查体积再查连接:超长是本地就能判断的问题,不该依赖连接状态
  const over = oversizeBy(text);
  if (over) {
    return bad(
      t(M.dispatch.sendOversize, {
        bytes: over.bytes,
        limit: over.limit - ENVELOPE_HEADROOM,
      }),
    );
  }

  if (env.connState !== "online") return bad(t(M.dispatch.sendNotConnected));

  const id = newId();
  // 记下 origin:对方回复时靠它判断"模型知道这回事吗"
  state.outbound.set(id, { text, origin, to });

  // send/ask **不** 再自动关联任何入站请求:回复只能由 team_reply 用显式
  // request id 发出,所以 send/ask 的 re 永远是空、跳数从 0 开始。
  // reply 的 re/hops 由调用方从存储的请求里带进来(route 到原发信人)。
  const re = isReply ? opts.re ?? null : null;
  const hops = isReply && typeof opts.hops === "number" ? opts.hops : 0;
  const requireResponse = kind === "ask";

  const lines = [
    t(M.dispatch.sendSent, { to: formatTarget(to), count: local?.targets?.length ?? 1 }),
  ];
  if (isReply) lines.push(t(M.dispatch.explicitReplySent, { id: re }));
  else if (requireResponse) lines.push(t(M.dispatch.sendAwaitReply));

  // 显式回复的 send 意图带一个**私有**字段 replyRequestId。它不进信封
  // (transmitBodyFrom 只取 text/hops/fyi/requireResponse),只用来把"哪条
  // 请求应被消费"交给真正把信封写出去的调用方 —— 只有 transport.send
  // 确认成功后才由 runIntentions 消费,写失败/抛异常时义务原样保留。
  const sendIntent = { type: "send", to, id, re, text, hops, requireResponse };
  if (isReply) sendIntent.replyRequestId = String(opts.replyRequestId ?? re ?? "");

  return ok(lines, {
    intentions: [
      // 契约(与 session.js 一致):send 意图用**顶层** text / hops,
      // 由 index.ts 组装成信封的 body。
      // 曾经一边写 body:{text} 一边读 it.text,导致 /team send 发出
      // 空正文的消息 —— 对方只看到空字符串,症状是"投递成功但对方没反应"。
      sendIntent,
      { type: "card", kind: isReply ? "reply" : "send", peer: formatTarget(to), text },
    ],
  });
}

function formatTarget(to) {
  if (Array.isArray(to)) return to.join(",");
  if (to === "*") return t(M.dispatch.targetAll);
  if (to === "@default") return t(M.dispatch.targetDefault);
  return String(to).replace(/^#/, "@");
}

// ---------------------------------------------------------------- reply

/** 旧的模式名映射到新的,别让已有脚本静默失效 */
const REPLY_ALIASES = { auto: "remind", always: "mirror" };
const REPLY_MODES = ["off", "remind", "mirror"];

export function normalizeReplyMode(raw) {
  const v = String(raw ?? "").trim();
  if (REPLY_MODES.includes(v)) return { mode: v, legacy: false };
  if (REPLY_ALIASES[v]) return { mode: REPLY_ALIASES[v], legacy: true };
  return { mode: null, legacy: false };
}

function replyPolicyResult(args, state, sub = "replies") {
  const raw = args[0];
  if (!raw) {
    return ok([
      t(M.dispatch.replyCurrent, { reply: state.reply }),
      "",
      t(M.dispatch.replyHelpOff),
      t(M.dispatch.replyHelpRemind),
      t(M.dispatch.replyHelpMirror),
      "",
      t(M.dispatch.replyUsage, { sub }),
    ]);
  }

  const { mode, legacy } = normalizeReplyMode(raw);
  if (!mode) {
    return bad(
      t(M.dispatch.replyInvalid, {
        modes: REPLY_MODES.join(" / "),
        value: raw,
        current: state.reply,
      }),
    );
  }

  state.reply = mode;
  const note =
    mode === "off"
      ? t(M.dispatch.replyNoteOff)
      : mode === "remind"
        ? t(M.dispatch.replyNoteRemind)
        : t(M.dispatch.replyNoteMirror);

  const lines = [t(M.dispatch.replySet, { mode }), note];
  if (legacy) lines.push(t(M.dispatch.replyLegacy, { old: raw, mode }));
  return ok(lines);
}

/**
 * /team reply 的入口。
 *
 * ── 为什么在这里做一个无歧义的分流 ──
 *   reply 曾经是提醒策略(/team reply off|remind|mirror)。现在它是显式
 *   回复,格式为 /team reply <requestId> <text>。request id 形如 m-…,
 *   永远不会等于一个模式名,所以“只有一个参数且是模式名”就是旧写法,
 *   其余一律当成显式回复。旧写法仍有效,并提示策略已搬到 /team replies。
 */
function replySubcommand(args, state, env, origin) {
  if (args.length === 1) {
    const { mode } = normalizeReplyMode(args[0]);
    if (mode) {
      const r = replyPolicyResult(args, state, "reply");
      r.lines.push(t(M.dispatch.replyMovedHint));
      return r;
    }
  }
  return explicitReplyResult(args, state, env, origin);
}

/**
 * 显式回复:按 request id 找回原发信人,把回复发给它。
 *
 * 没有 request id、或 id 未知/已回复/过期(重启后内存里的记录没了)→ 直接
 * 失败,**不发任何信封,也不动任何待回复**。绝不能靠"发给谁"猜目标:
 * 猜错会把回复寄给错误的人,而正确的那条义务还留着。
 *
 * 只有本地校验 + 连接都通过、真的产出了发送意图之后才消费匹配的那一条
 * (离线/超长时保留义务,不提前消费)。同一队友的其它请求不受影响。
 *
 * 注意:真正的消费不在这里 —— dispatch 不知道 transport.send 的结果。
 * 这里只把 request id 写进 send 意图的私有字段 replyRequestId,由
 * index.ts 的 runIntentions 在确认写入成功后消费。
 */
function explicitReplyResult(args, state, env, origin) {
  const requestId = String(args[0] ?? "").trim();
  const text = args.slice(1).join(" ");
  if (!requestId || !text) return bad(t(M.dispatch.explicitReplyUsage));

  const bound = bindRequest(state, requestId);
  if (!bound) return bad(t(M.dispatch.explicitReplyUnknown, { id: requestId }));

  const local = { targets: [bound.replyTo], unknown: [] };
  const r = doTransmit(bound.replyTo, text, origin === "model" ? "model" : "user", local, state, env, {
    kind: "reply",
    re: bound.re,
    hops: bound.hops,
    // 不在 dispatch 里消费:把 request id 交给调用方,只有 transport.send
    // 确认成功后才消费。dispatch 不知道真实写入结果,提前消费会在写失败
    // 时把义务弄丢(且发送阻断失效)。
    replyRequestId: requestId,
  });
  return r;
}
