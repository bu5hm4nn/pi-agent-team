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
  bindReply,
  knownLabels,
  others as othersOf,
  parseRecipients,
  resolveLocal,
  teamSize,
} from "./session.js";
import { createTeam, joinTeam, leaveTeam, listTeams, readTeam } from "./team-config.js";
import { optionHelp, buildPunchUri, checkModeRequirements, parseOptionArgs, validateOptions } from "./options.js";
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
 * @param {{ sub: string, args: string[] }} input
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
      return sendResult(args, state, env, input);

    // reply 是现在的名字;announce 保留为别名,免得已有的肌肉记忆失效
    case "reply":
    case "announce":
      return replyResult(args, state, sub);

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

  // create 的默认模式:显式给 mode 就用它;只给 url 说明是老习惯(broker);
  // 什么都不给时按 owner 指定的 UX 默认 hyperswarm —— 生成 token + topic,
  // 打印一条 punch URI,新机器只凭它就能加入。
  let mode = v.team.mode;
  if (!mode) mode = v.team.url ? "broker" : "hyperswarm";

  const req = checkModeRequirements({
    mode,
    url: v.team.url,
    seeds: v.team.seeds,
    token: v.team.token ?? "(to-be-generated)",
    topic: v.team.topic ?? "(to-be-generated)",
  });
  if (!req.ok) return bad(req.reason);

  // 已存在的 team:不重新创建。hyperswarm 把存好的 URI 再打印一次
  // (它只在配置里,重复创建不能让用户拿到);别的模式保持原有拒绝行为。
  const existing = readTeam(team);
  if (existing) {
    const cleanHyperswarm = existing.mode === "hyperswarm" && existing.topic;
    if (cleanHyperswarm && !v.team.mode && !v.team.url && !v.team.topic) {
      const uri = buildPunchUri({ name: team, topic: existing.topic, token: existing.token });
      return ok(
        [
          t(M.dispatch.createExistsHyperswarm, { team }),
          "",
          uri,
          "",
          t(M.dispatch.createPunchJoinIntroShort),
          `  TEAM_PUNCH='${uri}' pi`,
          t(M.dispatch.createPunchJoinLocal, { uri }),
        ],
        { party: { kind: "connect", team, config: existing, session: v.session } },
      );
    }
    return bad(
      t(M.dispatch.createExistsOther, { team, mode: existing.mode ?? "broker" }),
    );
  }

  const r = createTeam({
    team,
    url: v.team.url,
    token: v.team.token,
    mode,
    seeds: v.team.seeds ?? [],
    topic: v.team.topic,
  });
  if (!r.ok) return bad(r.reason);

  const lines = [
    t(M.dispatch.createCreated, { team, path: r.path }),
    t(M.dispatch.modeLine, { mode: r.config.mode }),
  ];
  if (r.config.url) lines.push(t(M.dispatch.brokerLine, { url: r.config.url }));
  if (r.config.seeds?.length) lines.push(t(M.dispatch.seedsLine, { seeds: r.config.seeds.join(", ") }));
  if (req.warning) lines.push("", t(M.dispatch.warning, { warning: req.warning }));

  if (r.config.mode === "hyperswarm") {
    // punch URI 就是唯一要复制的东西:token 和 topic 都在里面。
    const uri = buildPunchUri({ name: team, topic: r.config.topic, token: r.token });
    lines.push(
      "",
      t(M.dispatch.createPunchHeading),
      "",
      uri,
      "",
      t(M.dispatch.createPunchJoinIntro),
      `  TEAM_PUNCH='${uri}' pi`,
      t(M.dispatch.createPunchJoinLocal, { uri }),
    );
    // 创建后直接连上,省得用户再敲一次 join
    return ok(lines, {
      party: { kind: "connect", team, config: r.config, session: v.session },
    });
  }

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

  // 位置参数可能是 punch URI。任何带 scheme 的字符串先当 URI 解析,
  // 解析失败就直接拒绝 —— 绝不降级成 team 名或种子。
  const rest = [...parsed.rest];
  let positionalPunch = null;
  if (rest[0] && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rest[0])) {
    positionalPunch = rest.shift();
  }
  const [team, posUrl, posToken] = rest;

  const values = { ...parsed.values };
  // 显式 --punch 优先于位置 URI。validateOptions 会把 punch 展开成
  // mode/topic/token,后面的显式选项再覆盖它。
  if (positionalPunch && !values.punch) values.punch = positionalPunch;
  if (posUrl && !values.url) values.url = posUrl;
  if (posToken && !values.token) values.token = posToken;

  const v = validateOptions(values);
  if (!v.ok) return bad(v.reason);

  // punch URI 自带 team 名;否则用位置参数。
  const targetTeam = v.punch?.name ?? team;
  if (!targetTeam) return bad(missingTeamName("join", parsed));

  // 已有配置时,mode/seeds 必须能改 —— 否则想从 broker 换成 mesh
  // 就只能 leave 再 join,而那会把 token 也一起忘掉。
  const existing = readTeam(targetTeam);
  const mode = v.team.mode ?? existing?.mode ?? "broker";

  const req = checkModeRequirements({
    mode,
    url: v.team.url ?? existing?.url,
    seeds: v.team.seeds ?? existing?.seeds,
    token: v.team.token ?? existing?.token,
    topic: v.team.topic ?? existing?.topic,
  });
  if (!req.ok) return bad(req.reason);

  const r = joinTeam({
    team: targetTeam,
    url: v.team.url,
    token: v.team.token,
    mode: v.team.mode,
    seeds: v.team.seeds,
    topic: v.team.topic,
  });
  if (!r.ok) return bad(r.reason);

  const lines = [
    t(M.dispatch.joinJoined, { team: targetTeam }),
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
      team: targetTeam,
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
      t(M.dispatch.modeHelpHyperswarm),
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
    topic: existing.topic,
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

// ---------------------------------------------------------------- send

function sendResult(args, state, env, input = {}) {
  const rawTo = args[0];
  const text = args.slice(1).join(" ");
  if (!rawTo || !text) return bad(t(M.dispatch.sendUsage));

  // origin 以前写死成 "user",连 team_send 工具也是 —— 于是模型发出的消息
  // 被记成人发的,对方回复时只显示卡片,模型永远看不到那条回复。
  // 工具路径在 index.ts 里传 origin:"model"。
  const origin = input.origin === "model" ? "model" : "user";
  return sendMessage(rawTo, text, origin, state, env);
}

/**
 * 发送的实际执行 —— command 和 tool 共用这一条路径。
 *
 * 群发超过阈值时不直接发,返回 confirmBulk 让上层决定怎么问:
 * 命令走 confirm 对话框,工具走结构化返回让模型自己判断。
 */
export function sendMessage(rawTo, text, origin, state, env) {
  const to = parseRecipients(rawTo);
  const local = resolveLocal(state, to);

  if (local.targets.length === 0) {
    return bad(
      local.unknown.length
        ? t(M.dispatch.sendNoMatch, { targets: local.unknown.join(",") })
        : t(M.dispatch.sendNoPeers),
    );
  }

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
        party: { kind: "confirmBulk", n: local.targets.length, to, text, origin },
      },
    );
  }

  return doSend(to, text, origin, local, state, env);
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

export function doSend(to, text, origin, local, state, env) {
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

  // 发给一个正有待回复请求的队友 → 认成对那条请求的回复。
  // 带上 re,对端才知道这是回复、不该再自动回信;不带的话两个 agent
  // 会互相触发下去,只能靠跳数上限兜住。
  const { replyTo, re, hops } = bindReply(state, local.targets);

  const lines = [
    t(M.dispatch.sendSent, { to: formatTarget(to), count: local.targets.length }),
  ];
  if (replyTo) lines.push(t(M.dispatch.sendAsReply, { id: replyTo }));

  return ok(lines, {
    intentions: [
      // 契约(与 session.js 一致):send 意图用**顶层** text / hops,
      // 由 index.ts 组装成信封的 body。
      // 曾经一边写 body:{text} 一边读 it.text,导致 /team send 发出
      // 空正文的消息 —— 对方只看到空字符串,症状是"投递成功但对方没反应"。
      { type: "send", to, id, re, text, hops },
      { type: "card", kind: replyTo ? "reply" : "send", peer: formatTarget(to), text },
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

function replyResult(args, state, sub = "reply") {
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
