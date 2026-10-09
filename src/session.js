/**
 * Team 会话状态机 —— 纯逻辑,不依赖 Pi、不依赖网络。
 *
 * 为什么单独一层:index.ts 里有 1000 行,状态、决策和 Pi API 调用混在
 * 一起,导致"broker 重启后怎么办""对端在请求和回复之间离线怎么办"
 * 这类场景只能靠真机手测。
 *
 * 这个模块只做决策,不做 I/O。调用方(扩展)负责把它的输出变成
 * 实际动作:
 *
 *   const s = createSessionState()
 *   for (const action of handleIncoming(s, env, outbound)) {
 *     switch (action.type) {
 *       case "inject":  pi.sendUserMessage(action.payload); break
 *       case "send":    socket.send(...); break
 *       case "card":    pi.appendEntry(...); break
 *       case "notify":  ctx.ui.notify(...); break
 *     }
 *   }
 *
 * 这样每个场景都能用几行测试覆盖,不需要起 Pi、不需要起 broker。
 */

import { t } from "./i18n.js";
import { M } from "./messages.js";

/** 跳数上限:最后一道防线,正常对话形状不应碰到它 */
const MAX_HOPS = 4;

/** 成员标签上限,和 broker 保持一致 */
const MAX_LABELS = 8;

/** 已发出消息的记录上限,防止长会话内存增长 */
const OUTBOUND_CAP = 1000;

/**
 * 待回复队列上限。
 *
 * 正常一次 settle 周期不会超过个位数。上限的作用是:万一 settle 永远不触发
 * (Pi 卡死、异常退出),队列不能无限增长。超限时挤掉最早的那条并出失败卡片 ——
 * 静默丢弃会让发信人一直等下去。
 */
const MAX_PENDING_REPLIES = 32;

// ---------------------------------------------------------------- 类型

/**
 * @typedef {{ name: string, host: string|null, addr: string|null, labels: string[], since: number }} Member
 * @typedef {{ text: string, origin: "user"|"model", to: string|string[] }} Outbound
 * @typedef {{ seen: Set<string>, injected: Set<string>, outbound: Map<string, Outbound>,
 *             members: Member[], self: string, selfLabels: string[],
 *             reply: "off"|"remind"|"mirror",
 *             pendingReplies: PendingReply[], incomingIds: Map<string, IncomingId>,
 *             lastText: string }} SessionState
 *
 * @typedef {{ id: string, hops: number }} IncomingId
 *
 * @typedef {{ to: string, re: string, hops: number, at: number,
 *             ref: string, seen: boolean, reminded: boolean }} PendingReply
 *
 * @typedef {{ type: "inject", payload: string, from: string }
 *   | { type: "card", kind: "receive"|"send"|"reply"|"failed"|"fyi", peer: string, text: string, reason?: string }
 *   | { type: "send", to: string|string[], text: string, hops: number, re: string|null, origin: "user"|"model" }
 *   | { type: "notify", level: "info"|"warning"|"error", message: string }
 *   | { type: "status" }} Action
 */

// ---------------------------------------------------------------- 构造

/**
 * 消息 id 生成。导出是因为 index.ts 也要造 id(注入失败通知),
 * 两处各写一份迟早会分叉成不同格式。
 */
export const newId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createSessionState(self = "") {
  return {
    seen: new Set(),
    injected: new Set(),
    outbound: new Map(),
    members: [],
    self,
    /** 本节点自己的标签。broker 需要它来解析 @label 群发。 */
    selfLabels: [],
    reply: "remind",
    /**
     * 已收到、但还没有得到回复的队友请求。
     *
     * ── 为什么不再自动回信,而是让模型显式回复 ──
     *
     * 队友消息现在以 sendMessage 自定义消息送达(role="custom"),理由是
     * sendUserMessage 只有 steer/followUp 两种投递方式,而 followUp 实测会
     * 结束当前 run、原任务被挤乱 —— 实测中原任务连收尾回复都没发出来。
     *
     * 但换了投递方式之后,"哪段输出是给谁的回复"就没法从 turn 边界推断了:
     * 实测模型会在同一个 run 里先回应队友、再继续做完原任务:
     *
     *   111711ms  message_end role=custom text="TICKPROBE-BUSY"
     *   134544ms  assistant "Got TICKPROBE-BUSY. The first slowwork c..."
     *   150032ms  assistant "FULLDONE"        ← 原任务的收尾
     *
     * 按"最后一段"回信会把 FULLDONE 发给队友,答非所问。所以改为:模型用
     * team_send 显式回复,这里只负责跟踪"谁还没被回复",必要时提醒一次。
     */
    pendingReplies: [],
    /**
     * 最近一条来自某队友的入站消息 id,只用于把**可选回复**关联回它。
     *
     * ── 为什么不和 pendingReplies 合并 ──
     *   pendingReplies 表达的是"对方要求了回信、我们还没回"——它驱动提醒。
     *   而现在消息默认不要求回信,却仍然值得把回复闭合到原消息(re 指向它),
     *   否则对端会把我们的回复当成一条全新请求。两者语义不同,所以分开存:
     *   关联不产生任何提醒,只让 bindReply 拿得到入站 id。
     *
     * 只记"请求"(re 为空、非 fyi 的注入消息),回复不记 —— 回复本身已经
     * 带着 re,不需要再被当成另一条消息去关联。
     */
    incomingIds: new Map(),
    /** 上一轮的输出文本,供 reply=mirror 镜像用 */
    lastText: "",
    lastText: "",
  };
}

/** 有上限的 Map:超过容量丢最早的条目 */
function rememberBounded(map, key, value, cap = OUTBOUND_CAP) {
  map.set(key, value);
  if (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function remember(set, value, cap = OUTBOUND_CAP) {
  set.add(value);
  if (set.size > cap) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

// ---------------------------------------------------------------- 成员视图

/** 其他成员(排除自己) */
export const others = (s) => s.members.filter((m) => m.name !== s.self);

/** 树规模 = 其他成员 + 自己 */
export const teamSize = (s) => others(s).length + 1;

/** 所有已知 label,用于补全和分组显示 */
export function knownLabels(s) {
  const out = new Set();
  for (const m of others(s)) for (const l of m.labels ?? []) out.add(l);
  return [...out].sort();
}

/**
 * 应用 broker 推来的成员快照。
 *
 * 同时接受新格式(members,带元数据)和旧格式(peers,只有名字数组),
 * 因为 broker 可能先于扩展升级。
 */
/**
 * 应用 broker 推来的成员快照。
 *
 * 同时接受新格式(members,带元数据)和旧格式(peers,只有名字数组),
 * 因为 broker 可能先于扩展升级。
 *
 * 字段名映射:broker 的 wire 字段是 `tags`(历史遗留),而扩展内部和
 * 用户面向的词汇是 `labels`。这个接缝在这里收,上层看到的永远是 labels。
 * 曾经因为没收这个接缝,标签在成员列表里静默丢失过。
 */
export function applyRoster(s, body) {
  /** @type {Member[]} */
  let list;
  if (Array.isArray(body?.members)) {
    list = body.members.map((m) => ({
      name: m.name,
      host: m.host ?? null,
      addr: m.addr ?? null,
      labels: m.labels ?? m.tags ?? [], // 兼容两种字段名
      since: m.since ?? 0,
    }));
  } else if (Array.isArray(body?.peers)) {
    list = body.peers.map((name) => ({ name, host: null, addr: null, labels: [], since: 0 }));
  } else {
    return false;
  }
  s.members = list.filter((m) => m && typeof m.name === "string" && m.name !== s.self);
  return true;
}

// ---------------------------------------------------------------- 收件人解析

/**
 * 把用户输入或工具参数解析成收件人表达式。
 *
 *   "laptop"          → "laptop"
 *   "all" / "*"       → "*"
 *   "@web" / "#web"   → "@web"
 *   "a,b,@web"        → ["a","b","@web"]
 *   (空)              → "@default"   默认组
 */
export function parseRecipients(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "@default";
  if (text === "all" || text === "*") return "*";

  const parts = text
    .split(",")
    .map((x) => {
      const v = x.trim();
      if (!v) return null;
      if (v === "all" || v === "*") return "*";
      if (v.startsWith("#")) return `@${v.slice(1)}`; // 兼容旧写法
      return v;
    })
    .filter(Boolean);

  if (parts.length === 0) return "@default";
  if (parts.length === 1) return parts[0];
  return parts;
}

/**
 * 本地计算某个收件人表达式会命中几个成员。
 *
 * 为什么本地算:群发前要确认"这真的会发给 5 个人以上吗",而确认对话框
 * 必须在发送前弹出。broker 的回执是发送后才知道的,来不及。
 *
 * `@default` 视为全员(见 group 模型:不指定收件人 = 默认组 = 全体)。
 */
export function resolveLocal(s, to) {
  const requested = Array.isArray(to) ? to : [to];
  const targets = new Set();
  const unknown = [];
  const mine = others(s);

  for (const raw of requested) {
    if (typeof raw !== "string") continue;
    const expr = raw.trim();
    if (!expr) continue;

    if (expr === "*" || expr === "@default") {
      for (const m of mine) targets.add(m.name);
      continue;
    }
    if (expr.startsWith("@")) {
      const label = expr.slice(1);
      let hit = 0;
      for (const m of mine) {
        if ((m.labels ?? []).includes(label)) {
          targets.add(m.name);
          hit++;
        }
      }
      if (hit === 0) unknown.push(expr);
      continue;
    }
    if (!mine.some((m) => m.name === expr)) {
      unknown.push(expr);
      continue;
    }
    targets.add(expr);
  }

  return { targets: [...targets], unknown };
}

// ---------------------------------------------------------------- 出站

/**
 * 记录一条我们发出的消息,并产出动作。
 *
 * origin 是要紧的:对方回复时,靠它判断"模型知道这回事吗"。
 * 用户用 /team send 发的消息,模型完全不知道,不该被叫醒来疑惑。
 */
export function sendMessage(s, { to, text, hops = 0, re = null, origin = "user", fyi = false, requireResponse = false }) {
  const targets = resolveLocal(s, to);
  if (targets.targets.length === 0) {
    return [
      {
        type: "notify",
        level: "warning",
        message: targets.unknown.length
          ? t(M.session.noMatch, { targets: targets.unknown.join(",") })
          : t(M.session.noPeers),
      },
    ];
  }

  const id = newId();
  rememberBounded(s.outbound, id, { text, origin, to });

  return [
    { type: "send", to, text, hops, re, origin, fyi, requireResponse: requireResponse === true, id, targets: targets.targets },
    { type: "card", kind: "send", peer: formatTarget(to), text },
  ];
}

function formatTarget(to) {
  if (Array.isArray(to)) return to.join(",");
  // 显示用规范写法 @,不转成 # —— 用户输入的是 @,回显成 # 会让人以为要改写法
  return to === "*"
    ? t(M.session.targetAll)
    : to === "@default"
      ? t(M.session.targetDefault)
      : String(to).replace(/^#/, "@");
}

/**
 * 把一条 send 意图组装成信封的 body。
 *
 * 放在 session.js 而不是 index.ts:两个生产者(session 的镜像 / dispatch
 * 的手动发送)共用同一套字段语义,信封形状不可能分叉,而且这段接线
 * 能被纯函数测到(requireResponse 只把 **true** 写进信封,缺省与 false
 * 都不写 —— 接收方按缺省即 false 处理,和 fyi 一致)。
 */
export function sendBodyFrom(intention = {}) {
  return {
    text: String(intention.text ?? ""),
    hops: typeof intention.hops === "number" ? intention.hops : 1,
    ...(intention.fyi ? { fyi: true } : {}),
    ...(intention.requireResponse === true ? { requireResponse: true } : {}),
  };
}

// ---------------------------------------------------------------- 入站

/**
 * 分类一条入站消息。这是对话形状的唯一权威。
 *
 * 规则(每一条都对应一次真实故障):
 *   - 请求 + 要求回信   → 注入,建立待回复,必要时提醒一次
 *   - 请求 + 不要求回信  → 注入(仍然唤醒模型),不建立待回复、不提醒
 *   - 回复我们的消息   → 注入,**不要求回信**(否则请求→回复→回复…打到跳数上限)
 *   - 回复用户的消息   → 只显示卡片(模型没见过那条消息,叫醒它只会说“正文是空的”)
 *   - 回复但原消息未知 → 注入,不要求回信
 *   - fyi 广播        → 只显示卡片(reply=mirror 的镜像推送,不该叫醒模型)
 *
 * 要求回信只看信封 body.requireResponse 是否**严格为 true**;缺省与 false 一律
 * 视为不要求。re 命中(回复)的优先级高于 requireResponse —— 回复永远不会
 * 反过来要求回信,这是对话能停下来的关键。
 */
export function classifyInbound(s, env) {
  const body = env.body ?? {};
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return { action: "drop", reason: "empty" };

  const hops = typeof body.hops === "number" ? body.hops : 0;
  if (hops >= MAX_HOPS) return { action: "drop", reason: "hops" };

  if (body.fyi === true) return { action: "card", kind: "fyi", requireResponse: false };

  if (env.re) {
    const orig = s.outbound.get(env.re) ?? null;
    if (orig?.origin === "user") {
      return { action: "card", kind: "reply", requireResponse: false, original: orig.text };
    }
    return { action: "inject", kind: "reply", requireResponse: false, original: orig?.text ?? null };
  }

  return { action: "inject", kind: "request", requireResponse: body.requireResponse === true };
}

/** 构造注入给模型的文本。要求回信与不要求回信的措辞必须不同,见 classifyInbound 注释。 */
export function buildPayload(from, text, cls) {
  if (cls.kind === "reply") {
    const quote = cls.original ? `你之前发给它的消息「${excerpt(cls.original, 120)}」` : "你之前发出的消息";
    return (
      `[来自 ${from} 的 team 回复]\n${text}\n\n---\n` +
      `上面是 teammate ${from} 对${quote}的回复(不是真人用户在打字)。` +
      `你这一轮的输出【不会】自动回传给 ${from}。` +
      `如果需要继续和它对话,显式调用 team_send;否则直接处理这条回复即可。`
    );
  }

  // 不要求回信时,要把“无需回信”说清楚 —— 否则模型会习惯性地回一句
  // 确认,而对端并不需要,白烧一轮完整思考。
  const replyHint =
    cls.requireResponse === true
      ? `要回复它,显式调用 team_send({ to: "${from}", text: "..." });它会和这条请求关联起来。`
      : `这条消息没有要求回复(发送方未要求回信);不需要回复时直接处理即可,不要为了确认而回信。\n` +
        `如果任务本身需要回报结果,仍可显式调用 team_send({ to: "${from}", text: "..." }) —— 它同样会关联到这条消息。`;

  return (
    `[来自 ${from} 的 team 消息]\n${text}\n\n---\n` +
    `上面是 teammate ${from} 发来的消息原文(不是真人用户在打字)。` +
    `按内容本身的意思回应:是任务就执行,是讨论/诗句/提问就接着往下走。` +
    `不要反问"需要我做什么",也不要复述确认。\n` +
    `你这一轮的输出【不会】自动回传给 ${from}。` +
    replyHint
  );
}

export function excerpt(text, max = 120) {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 处理一条入站信封,产出动作列表。
 *
 * @returns {Action[]}
 */
export function handleIncoming(s, env, now = Date.now()) {
  const body = env.body ?? {};
  const kind = typeof body.kind === "string" ? body.kind : undefined;

  // ---- broker 控制消息
  if (env.from === "broker") {
    switch (kind) {
      case "welcome":
      case "peer_joined":
      case "peer_left": {
        const changed = applyRoster(s, body);
        const actions = changed ? [{ type: "status" }] : [];
        if (kind === "peer_joined" && typeof body.peer === "string" && body.peer !== s.self) {
          const m = others(s).find((x) => x.name === body.peer);
          actions.push({
            type: "notify",
            level: "info",
            message: m?.host
              ? t(M.session.peerJoinedWithHost, { peer: body.peer, host: m.host })
              : t(M.session.peerJoined, { peer: body.peer }),
          });
        }
        return actions;
      }

      case "undeliverable":
        return [
          {
            type: "notify",
            level: "warning",
            message: t(M.session.undeliverable, {
              to: String(body.to ?? "?"),
              reason: describeUndeliverable(body),
            }),
          },
        ];

      case "delivered": {
        // 部分成功也要说,否则用户以为"发出去了"就全到了
        const failed = Array.isArray(body.failed) ? body.failed : [];
        const unknown = Array.isArray(body.unknown) ? body.unknown : [];
        if (!failed.length && !unknown.length) return [];
        const parts = [t(M.session.deliveredPartial, { delivered: body.delivered, total: body.total })];
        if (failed.length) parts.push(t(M.session.deliveredFailed, { failed: failed.join(",") }));
        if (unknown.length) parts.push(t(M.session.deliveredUnknown, { unknown: unknown.join(",") }));
        return [
          {
            type: "notify",
            level: "warning",
            message: t(M.session.deliveredSummary, { parts: parts.join(" · ") }),
          },
        ];
      }

      case "ping":
        return [];
    }
    return [];
  }

  // ---- 团队消息
  if (s.seen.has(env.id)) return [];
  remember(s.seen, env.id);

  if (s.injected.has(env.id)) return [];
  remember(s.injected, env.id);

  const cls = classifyInbound(s, env);
  if (cls.action === "drop") return [];

  const text = typeof body.text === "string" ? body.text : "";

  if (cls.action === "card") {
    return [
      {
        type: "card",
        kind: cls.kind === "fyi" ? "send" : "receive",
        peer: env.from,
        text,
        ...(cls.original ? { reason: t(M.session.replyReason, { excerpt: excerpt(cls.original, 60) }) } : {}),
      },
    ];
  }

  const hops = typeof body.hops === "number" ? body.hops : 0;
  const payload = buildPayload(env.from, text, cls);
  const actions = [{ type: "card", kind: "receive", peer: env.from, text }];

  if (cls.requireResponse) {
    const dropped = rememberPending(s, { from: env.from, id: env.id, hops, ref: payload });
    if (dropped) {
      actions.push({
        type: "card",
        kind: "failed",
        peer: dropped.to,
        text: "",
        reason: t(M.session.pendingOverflow, { count: MAX_PENDING_REPLIES, to: dropped.to }),
      });
    }
  } else if (cls.kind === "request") {
    // 不要求回信,仍记下入站 id:模型若选择回复,bindReply 要能带上 re,
    // 对端才认得出是回复而不是一条新请求。这不会产生任何提醒。
    associateIncoming(s, env.from, env.id, hops);
  }

  actions.push({ type: "inject", payload, from: env.from, re: env.id, hops });
  return actions;
}

function describeUndeliverable(body) {
  const unknown = Array.isArray(body.unknown) ? body.unknown : [];
  if (unknown.length && unknown.every((u) => String(u).startsWith("@"))) {
    return t(M.session.undeliverableGroup, { unknown: unknown.join(",") });
  }
  if (unknown.length) return t(M.session.undeliverableUnknown, { unknown: unknown.join(",") });
  if (body.reason === "unknown_recipient") return t(M.session.undeliverableRecipient);
  if (body.reason === "no_recipients") return t(M.session.undeliverableNoRecipients);
  return body.reason ? String(body.reason) : t(M.session.unknownReason);
}

// ---------------------------------------------------------------- 出站决策

/**
 * 观察一条消息。
 *
 * 队友消息现在以自定义消息送达,role 是 `"custom"` 而不是 `"user"`
 * (实测),所以这里按 customType 识别,并记录"模型确实看到了它"。
 *
 * 为什么要记 seen:忙时送达的消息会被排在下一个 turn 的开头,模型可能
 * 还没机会看它 run 就结束了。只有 seen 为 true 的请求才需要提醒 ——
 * 没被看到的那些,它们会自己触发新的一轮。
 */
export function observeMessage(s, role, text, customType = null) {
  if (role === "custom" && customType === TEAM_MESSAGE_TYPE) {
    const hit = s.pendingReplies.find((p) => p.ref === text && !p.seen);
    if (hit) hit.seen = true;
    return;
  }
  if (role === "assistant") s.lastText = text;
}

/** 队友消息用的 customType —— index.ts 注入时和这里必须是同一个值 */
export const TEAM_MESSAGE_TYPE = "team-msg";

/**
 * 轮次结束后该做什么。产出动作。
 *
 * 用 agent_settled 触发,不用 agent_end:后者之后还可能有重试、
 * compaction、queued continuation,拿它当"结束"会推中间态。
 */
export function onTurnSettled(s) {
  if (s.reply === "off") {
    s.pendingReplies = [];
    s.lastText = "";
    return [];
  }

  if (s.reply === "mirror") {
    const text = s.lastText;
    if (!text.trim()) return [];
    s.lastText = "";
    const list = others(s);
    if (list.length === 0) return [];
    // fyi:true 让收件人只显示卡片,不叫醒它的模型。否则 N 个节点都开
    // always 时,每轮都会触发 N-1 轮新思考。
    return list.map((m) => ({
      type: "send",
      to: m.name,
      text,
      hops: 1,
      re: null,
      origin: "model",
      fyi: true,
      id: newId(),
      targets: [m.name],
      card: { kind: "send", peer: m.name, text },
    }));
  }

  // auto:不再自动把某段文本当成回复发出去 —— 实测模型会在同一个 run 里
  // 先回应队友再做完原任务,按段落猜归属会把原任务的收尾(i.e. "DONE")
  // 发给队友。改为:只在请求还没被回复时提醒模型一次。
  const actions = [];
  const online = new Set(others(s).map((m) => m.name));
  const stillPending = [];

  for (const p of s.pendingReplies) {
    if (!online.has(p.to)) {
      // 对方已经不在线了,再提醒也没有意义
      actions.push({
        type: "card",
        kind: "failed",
        peer: p.to,
        text: "",
        reason: t(M.session.peerOfflinePending, { to: p.to }),
      });
      continue;
    }

    if (!p.seen) {
      // 模型还没看到这条消息。它会被排进下一个 turn,那时再判断是否需要提醒。
      stillPending.push(p);
      continue;
    }

    if (!p.reminded) {
      p.reminded = true;
      stillPending.push(p);
      actions.push({ type: "remind", pending: [p.to], ref: p.ref });
      continue;
    }

    // 已经提醒过一次仍未回复。不再打扰,但在本机说明清楚 —— 静默丢掉会
    // 让用户以为对方收到了回复。
    actions.push({
      type: "card",
      kind: "failed",
      peer: p.to,
      text: "",
      reason: t(M.session.remindedStillPending, { to: p.to }),
    });
  }

  s.pendingReplies = stillPending;
  return actions;
}

/**
 * 记下某队友最近一条入站请求的 id,供可选回复关联(不产生提醒)。
 * 每个队友只保留最新一条 —— 他连发三条,回一次就够。
 */
function associateIncoming(s, from, id, hops) {
  rememberBounded(s.incomingIds, from, { id, hops });
}

/**
 * 记录一条待回复的请求。
 *
 * 同一个发信人只保留最新一条:它连发三条时,三条都进了模型,但回一次
 * 就够了 —— 否则三个队友各发三条会得到九条回信,而它们本来是一段回答。
 */
export function rememberPending(s, { from, id, hops, ref }) {
  const existing = s.pendingReplies.findIndex((p) => p.to === from);
  if (existing >= 0) s.pendingReplies.splice(existing, 1);

  if (s.pendingReplies.length >= MAX_PENDING_REPLIES) {
    const dropped = s.pendingReplies.shift();
    dropped.dropped = true;
    return dropped;
  }

  s.pendingReplies.push({
    to: from,
    re: id,
    hops,
    at: Date.now(),
    ref,
    seen: false,
    reminded: false,
  });
  return null;
}

/**
 * 把一次出站发送绑定到某个入站消息上。
 *
 * 优先绑定"要求回信的待回复":那是真正的请求,回它就把队列清掉。
 * 没有待回复时,退回到"入站关联" —— 对方刚发过一条不要求回信的消息,
 * 我们回它同样应带上 re。两种情况都返回对方的消息 id,跳数 +1。
 *
 * 关联是一次性的:用掉即删,免得后续一条全新的消息被误当成对旧消息的回复。
 * allowAssociation=false 时只走待回复通道 —— 发送方**显式要求回信**的消息
 * 是一条新请求,不能静默绑成对旧通知的回复(否则标志会被归零),所以调用方
 * 在 requireResponse=true 时关掉它。
 *
 * @returns {{ replyTo: string|null, re: string|null, hops: number }}
 */
export function bindReply(s, targets, { allowAssociation = true } = {}) {
  const list = Array.isArray(targets) ? targets : [targets];
  if (list.length !== 1) return { replyTo: null, re: null, hops: 0 };

  const to = list[0];
  const idx = s.pendingReplies.findIndex((p) => p.to === to);
  if (idx >= 0) {
    const p = s.pendingReplies[idx];
    // 回一次就把它所有的请求都算答完 —— 它连发三条,回一次就够
    s.pendingReplies = s.pendingReplies.filter((x) => x.to !== to);
    // 关联也一并消费:这条已经回过,别再让后续消息挂到同一个入站 id 上
    s.incomingIds?.delete(to);
    return { replyTo: to, re: p.re, hops: Math.min(p.hops + 1, MAX_HOPS) };
  }

  const near = allowAssociation ? s.incomingIds?.get(to) : undefined;
  if (near) {
    s.incomingIds.delete(to);
    return { replyTo: to, re: near.id, hops: Math.min(near.hops + 1, MAX_HOPS) };
  }

  return { replyTo: null, re: null, hops: 0 };
}

/** 从 assistant 消息里取文本 */
export function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

export { MAX_HOPS, MAX_LABELS };
