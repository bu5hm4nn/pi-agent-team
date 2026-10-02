/**
 * Pi Agent Team —— 让多台机器上的 Pi 互相通信,像一个集群。
 *
 * ── 分层 ──
 *   src/session.js       会话状态机(纯逻辑,单测)
 *   src/transport.js     transport 接口 + BrokerTransport(网络与重连)
 *   src/team-config.js   team 配置读写(create/join/leave 落地)
 *   src/dispatch.js      命令与工具共用的动作分发(纯逻辑,单测)
 *   index.ts             只做 Pi API 接线,不放决策逻辑
 *
 * ── 双入口 ──
 *   /team ...        给人用,输出走 ui.notify / 交互菜单
 *   team_* 工具      给模型和自动化用,输出走结构化返回值
 *   两者都调 dispatch.js 的同一个函数,行为不会分叉。
 *
 * ── 两个 API 分属不同对象(踩过的坑)──
 *   pi.sendUserMessage() / pi.appendEntry()  在 ExtensionAPI 上
 *   ctx.isIdle() / ctx.ui.select()           在 ExtensionContext 上
 * 写成 ctx.sendUserMessage() 会抛 "is not a function"。
 *
 * ── 生命周期契约 ──
 *   不在 factory 里开 socket。socket 从 session_start 起,
 *   由幂等的 session_shutdown 关。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { Type } from "typebox";

import { createBrokerTransport, CLOSE_REPLACED } from "./src/transport.js";
import { setLocale, getLocale, resolveLocale, resolveLocaleInfo, startupLocaleEnv, classifyLocale, SUPPORTED_LOCALES, t } from "./src/i18n.js";
import { M } from "./src/messages.js";
import { MODES, createTransport, modeReadiness, normalizeSeeds, resolveMode } from "./src/mode.js";
import { parsePunchUri, punchFromEnv } from "./src/options.js";
import { createSessionState, handleIncoming, knownLabels, newId, onTurnSettled, observeMessage, others, teamSize, applyRoster, TEAM_MESSAGE_TYPE } from "./src/session.js";
import { normalizeReplyMode } from "./src/dispatch.js";
import { createTeam, joinTeam, leaveTeam, listTeams, readTeam, toSocketUrl, writeTeam } from "./src/team-config.js";
import { BULK_WARN_THRESHOLD, dispatch, doSend, sendMessage } from "./src/dispatch.js";

// ---------------------------------------------------------------- 类型

type CardKind = "receive" | "send" | "reply" | "failed";

type CardDetails = { kind: CardKind; peer: string; text: string; at: number; reason?: string };

const CARD_TYPE = "team-message";

type ConnState = "offline" | "connecting" | "online" | "replaced" | "auth_failed";

// ---------------------------------------------------------------- 运行时

let state = createSessionState();
/**
 * 当前 transport。三种模式共用同一套接口,所以类型是结构化的。
 * 具体实现见 src/mode.js 的工厂。
 */
let transport: ReturnType<typeof createBrokerTransport> | null = null;

/** 当前模式,用于状态显示和诊断 */
let currentMode: string = "broker";
let connState: ConnState = "offline";
let currentTeam: string | null = null;
let currentConfig: { url?: string; token: string; labels?: string[]; mode?: string; seeds?: string[]; topic?: string } | null = null;

let ctxRef: ExtensionContext | null = null;
let apiRef: ExtensionAPI | null = null;

/** 启动时解析出的语言来源,供 /team lang 汇报(见 i18n.js 的 resolveLocaleInfo)。 */
let localeSource: string | null = null;
let localeSourceValue = "";
/** /team lang 是否在本会话里改过语言。改过就以它为准。 */
let localeOverridden = false;

/** 把 i18n 的机器码来源映射到目录键,供 /team lang 渲染。 */
const LANG_SOURCE_KEYS: Record<string, string> = {
  flag: M.lang.source.flag,
  env: M.lang.source.env,
  config: M.lang.source.config,
  lc_all: M.lang.source.lcAll,
  lc_messages: M.lang.source.lcMessages,
  lang: M.lang.source.lang,
  intl: M.lang.source.intl,
  session: M.lang.source.session,
};

/**
 * 队友消息以"自定义消息"送达(pi.sendMessage),不是用户消息。
 *
 * ── 为什么不能用 sendUserMessage ──
 * 它只支持 steer / followUp 两种投递。followUp 实测会结束当前 run:
 *
 *   227163ms  assistant ""            ← 原任务没做完
 *   227165ms  agent_end               ← 当前 run 被收尾
 *   227168ms  agent_start             ← 新 run
 *   227169ms  user "队友消息"          ← 被当成你下的新指令
 *   ...      原任务被挤乱,最后连收尾回复都没发出
 *
 * ── sendMessage 的实测行为 ──
 *   空闲 + triggerTurn    → 起一个新 turn
 *   流式中 + triggerTurn  → steer:当前 assistant turn 和它的工具调用
 *                            结束后插入,不打断正在跑的工具
 *   流式中 + 不触发       → 等当前 turn 结束再追加
 *
 * 忙时实测:原任务完整跑完并回复 FULLDONE,同时模型看到了队友消息
 * 并在下一个 turn 开头就作了回应 —— 这是我们要的"立刻知道、不打断"。
 *
 * 另外 sendMessage 不会像 sendUserMessage 那样在同一 tick 里互相覆盖
 * (实测同 tick 两条都进了模型),所以原来的注入队列不再需要。
 */

/** dispatch 需要的环境快照 */
const envOf = () => ({
  connState,
  team: currentTeam,
  config: currentConfig,
  mode: currentMode,
  // mesh/swim 需要报出监听端口,否则用户不知道拿什么当种子
  listenPort: (transport as { port?: () => number | null } | null)?.port?.() ?? null,
  // swim 模式的种子用的是边车 gossip 端口,和投递端口不是一个。
  // 不报出来用户就无从写种子地址。
  gossipPort: (transport as { gossipPort?: () => number | null } | null)?.gossipPort?.() ?? null,
});

// ---------------------------------------------------------------- 意图执行

/**
 * 注入失败时告诉发信人。
 *
 * 不这么做的话,发信人只会看到自己的请求发出去了,然后一直等回信 ——
 * 而回信永远不会来,因为它根本没进模型。这可能发生在 Pi 正忙、注入被拒
 * 的时候。
 *
 * 用一条 noReply 的说明发回去,而不是让它当成一次正常回复(那会再触发
 * 一轮无意义的思考)。
 */
async function notifyInjectFailure(from: string, reason: string, ctx: ExtensionContext) {
  if (!from) return;
  const text = `[系统] 你的消息没有送达 ${state.self}:注入失败(${reason})。请重发。`;

  // 直接在传输层构造信封。inbound 的 id 已经记在 seen 里，不走
  // sendMessage —— 那样会把它当成一次普通发送而记入 outbound，
  // 让对端的 re 能对着一个我们没真正发过的请求。
  try {
    transport?.send({ to: from, id: newId(), re: null, body: { text, hops: 1, fyi: true } });
  } catch {
    // 连失败通知都发不出去就只留着本机 notify，不再递归上报
    void ctx;
  }
}

/**
 * 执行 dispatch 产出的意图。这是唯一的"意图 → 副作用"映射点,
 * 两个入口共用,所以行为不可能分叉。
 */
async function runIntentions(
  intentions: Array<Record<string, unknown>>,
  ctx: ExtensionContext,
): Promise<string[]> {
  const notes: string[] = [];

  for (const it of intentions) {
    switch (it.type) {
      case "notify":
        notes.push(String(it.message));
        ctx.ui.notify(String(it.message), (it.level as "info" | "warning" | "error") ?? "info");
        break;

      case "status":
        renderStatus();
        break;

      case "card":
        showCard({
          kind: it.kind as CardKind,
          peer: String(it.peer),
          text: String(it.text),
          reason: it.reason as string | undefined,
        });
        break;

      case "send": {
        // 契约:send 意图用顶层 text / hops / to / id / re。
        // 之前的 bug 是 index.ts 读 it.body 而 session.js 给 it.text,
        // 于是自动回信发出一个没有 body 的信封,被 broker 判为畸形。
        const okSent = transport?.send({
          to: it.to as string | string[],
          id: String(it.id),
          re: (it.re as string | null) ?? null,
          body: {
            text: String(it.text ?? ""),
            hops: typeof it.hops === "number" ? it.hops : 1,
            ...(it.fyi ? { fyi: true } : {}),
          },
        });
        if (!okSent) {
          const msg = t(M.notify.sendFailed);
          notes.push(msg);
          ctx.ui.notify(msg, "error");
        }
        break;
      }

      case "inject": {
        const payload = String(it.payload);
        try {
          // display:false —— 卡片已经由 card 意图画出来了,再画一次会重复。
          // 实测 display:false 的自定义消息仍然进入模型上下文。
          apiRef?.sendMessage(
            { customType: TEAM_MESSAGE_TYPE, content: payload, display: false },
            { triggerTurn: true },
          );
        } catch (err) {
          const reason = (err as Error).message;
          const msg = t(M.notify.injectFailed, { reason });
          notes.push(msg);
          ctx.ui.notify(msg, "error");
          // 发信人必须知道请求没进去,否则它会一直等回信
          void notifyInjectFailure(String(it.from ?? ""), reason, ctx);
        }
        break;
      }

      case "remind": {
        // 请求已送达并且模型看到过,但这一轮结束时还没有回复。提醒一次,
        // 并把这一轮叫起来 —— 否则忙时看到的请求会一直悬着没人处理。
        const who = (it.pending as string[]) ?? [];
        if (!who.length) break;
        const payload = String(it.ref ?? "");
        try {
          apiRef?.sendMessage(
            {
              customType: TEAM_MESSAGE_TYPE,
              content:
                `[team 待回复]${who.join(", ")} 之前发来的请求还没有回复。` +
                `现在就回复它:team_send({ to: "${who[0]}", text: "..." })。` +
                `如果本来就不需要回复,忽略这条即可。\n\n${payload}`,
              display: false,
            },
            { triggerTurn: true },
          );
        } catch (err) {
          ctx.ui.notify(t(M.notify.remindFailed, { reason: (err as Error).message }), "error");
        }
        break;
      }
    }
  }

  return notes;
}

/**
 * 处理 dispatch 返回的 party(生命周期动作)。
 * 这些动作需要连接管理,不属于意图执行。
 */
async function runParty(party: Record<string, unknown> | undefined, ctx: ExtensionContext): Promise<boolean> {
  if (!party) return true;

  switch (party.kind) {
    case "connect":
      connectWith(
        party.team as string | null,
        party.config as { url: string; token: string; labels?: string[] },
        (party.session as { name?: string; labels?: string[]; port?: number; listen?: string }) ?? {},
      );
      return true;

    case "disconnect":
      transport?.stop();
      transport = null;
      connState = "offline";
      currentTeam = null;
      currentConfig = null;
      renderStatus();
      return true;

    case "reconnect": {
      const labels = party.labels as string[];
      if (transport && currentConfig) connectWith(currentTeam, { ...currentConfig, labels });
      return true;
    }

    case "confirmBulk": {
      const n = party.n as number;
      const proceed = await ctx.ui.confirm(
        t(M.ui.confirmBulkTitle, { count: n }),
        t(M.ui.confirmBulkBody),
      );
      if (!proceed) {
        ctx.ui.notify(t(M.notify.cancelled), "info");
        return false;
      }
      // 确认后走同一条发送路径,不复制逻辑
      const to = party.to as string | string[];
      const local = { targets: new Array(n).fill("") as string[], unknown: [] };
      const r = doSend(to, String(party.text), (party.origin as "user" | "model") ?? "user", local, state, envOf());
      if (!r.ok) {
        ctx.ui.notify(r.error!, "error");
        return false;
      }
      await runIntentions(r.intentions ?? [], ctx);
      return true;
    }
  }
  return true;
}

/** dispatch + 执行。命令和工具的统一入口。 */
async function invoke(
  input: { sub: string; args: string[]; origin?: "user" | "model" },
  ctx: ExtensionContext,
) {
  ctxRef = ctx;
  const r = dispatch(input, state, envOf());

  if (!r.ok) return { ok: false, lines: [] as string[], error: r.error!, notes: [] as string[] };

  const proceeded = await runParty(r.party, ctx);

  // confirmBulk 被取消时,party 已经处理过 intentions,不要再执行一次
  const notes = r.party?.kind === "confirmBulk"
    ? []
    : await runIntentions(r.intentions ?? [], ctx);

  renderStatus();
  return { ok: proceeded, lines: r.lines, error: undefined, notes };
}

// ---------------------------------------------------------------- 卡片 / 状态栏

function showCard(details: Omit<CardDetails, "at">) {
  apiRef?.appendEntry<CardDetails>(CARD_TYPE, { ...details, at: Date.now() });
}

function renderStatus() {
  const ui = ctxRef?.ui;
  if (!ui) return;
  if (connState === "replaced") {
    ui.setStatus("team", t(M.status.replaced, { name: state.self || "?" }));
    return;
  }
  const icon =
    connState === "online"
      ? "🟢"
      : connState === "connecting"
        ? "🟡"
        : connState === "auth_failed"
          ? "🔑" // 和"网络断开"区分开:这是凭据问题,不是网络问题
          : "🔴";
  ui.setStatus("team", t(M.status.line, { icon, name: state.self || "?", count: teamSize(state), mode: currentMode }));
}

/**
 * token 不对时的提示。
 *
 * 要把两边的指纹都给出来:用户看到的现象是"连不上",最先怀疑的是
 * 网络和地址。指纹一比对,马上就能确认是 token 不一致,而且知道
 * 该改哪一边 —— 指纹不是 token 本身,贴出来也不泄露什么。
 */
function tokenFailureMessage(detail: { reason?: string; fingerprint?: string | null; url?: string }): string {
  const mine = currentConfig?.token ? fingerprintOf(currentConfig.token) : t(M.notify.tokenNone);
  if (detail.reason === "missing") {
    return t(M.notify.tokenMissing);
  }
  const lines = [
    t(M.notify.tokenRejected, { url: detail.url ?? "broker" }),
    "",
    t(M.notify.tokenLocalFingerprint, { fingerprint: mine }),
    t(M.notify.tokenBrokerFingerprint, { fingerprint: detail.fingerprint ?? t(M.notify.tokenUnknown) }),
    "",
    t(M.notify.tokenFingerprintExplanation),
    t(M.notify.tokenFingerprintFixIntro),
    t(M.notify.tokenFingerprintFixCommand),
  ];
  return lines.join("\n");
}

/** 与 broker 相同的指纹算法:sha256 前 8 位 */
function fingerprintOf(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------- 连接

function connectWith(
  team: string | null,
  config: { url?: string; token: string; labels?: string[]; mode?: string; seeds?: string[]; topic?: string },
  /**
   * 会话级选项,来自这次调用的参数,覆盖启动时的值。
   *
   * name 和 labels 不落盘:一台机器可以跑几个 Pi,每个是一个独立节点,
   * 它们共用同一个 team 配置文件 —— 节点名存进去的话,第二个启动
   * 就会把第一个覆盖掉,而名字就是身份。
   */
  session: { name?: string; labels?: string[]; port?: number; listen?: string } = {},
) {
  transport?.stop();

  currentTeam = team;
  currentConfig = config;

  // 优先级:本次调用的参数 > 启动时的值。
  // 注意 labels 用 length 判断:空数组是 truthy,直接赋值会把
  // 启动时的 --team-labels 覆盖成空。
  if (session.name) state.self = session.name;
  if (session.labels?.length) {
    state.selfLabels = session.labels;
  } else if (!state.selfLabels?.length && config.labels?.length) {
    // 旧版本会把标签写进 team 配置。现在不写了,但已经存下的要继续
    // 生效,否则升级后已有用户的标签会悄悄消失 —— 而它们只在别人
    // 用 @label 群发时才会被发现。
    state.selfLabels = config.labels;
  }

  state.members = [];
  state.pendingReplies = [];
  state.answering = [];

  // 模式只看配置。启动时的 TEAM_MODE 已经在下面并进去了 ——
  // 这里再读环境变量的话,/team mode 切换就会被它压住,切不动。
  const resolved = resolveMode({ config, env: {} });
  if (!resolved.ok) {
    ctxRef?.ui.notify(`team:${resolved.reason}`, "error");
    return;
  }
  currentMode = resolved.mode;

  const readiness = modeReadiness(resolved.mode, config);
  if (!readiness.ready) {
    ctxRef?.ui.notify(t(M.notify.modeUnavailable, { mode: resolved.mode, reason: readiness.reason }), "error");
    return;
  }

  const made = createTransport({
    mode: resolved.mode,
    config,
    // 优先级:本次调用的选项 > 启动时的环境变量 > 默认。
    // 监听端口不落盘(见 options.js),所以这是它唯一的来源。
    listenHost: session.listen ?? process.env.TEAM_LISTEN_HOST ?? "0.0.0.0",
    listenPort: session.port ?? Number(process.env.TEAM_LISTEN_PORT ?? 0),
    advertiseHost: process.env.TEAM_ADVERTISE_HOST ?? null,
    sidecarPath: process.env.PI_TEAM_SWIM_SIDECAR ?? null,
  });

  if (!made.ok) {
    ctxRef?.ui.notify(`team:${made.reason}`, "error");
    return;
  }

  transport = made.transport;
  if (made.warning) ctxRef?.ui.notify(`team:${made.warning}`, "warning");

  transport.on("state", (next, detail) => {
    connState = next as ConnState;

    if (next === "replaced") {
      ctxRef?.ui.notify(t(M.notify.replaced, { name: state.self }), "error");
    } else if (next === "auth_failed") {
      ctxRef?.ui.notify(tokenFailureMessage(detail as { reason?: string; fingerprint?: string | null; url?: string }), "error");
    } else if (next === "offline" && (detail as { reason?: string })?.reason === "payload_too_large") {
      const d = detail as { detail?: string | null };
      ctxRef?.ui.notify(
        [
          t(M.notify.payloadTooLarge),
          d.detail ? t(M.notify.payloadTooLargeDetail, { detail: d.detail }) : "",
          "",
          t(M.notify.payloadTooLargeHint),
        ]
          .filter(Boolean)
          .join("\n"),
        "error",
      );
    } else if (next === "offline" && (detail as { code?: number })?.code === CLOSE_REPLACED) {
      ctxRef?.ui.notify(t(M.notify.connectionReplaced), "warning");
    }
    renderStatus();
  });

  // mesh 和 swim 通过 membership 事件推送成员表。
  // broker 模式走控制消息,不会发这个事件 —— 所以两种都要接,
  // 少了这一处,mesh/swim 下 roster 永远只有自己。
  transport.on("membership", (list: unknown) => {
    applyRoster(state, { members: list });
    renderStatus();
  });

  transport.on("envelope", (env) => {
    const ctx = ctxRef;
    if (!ctx) return;
    // 决策全在 session.js;这里只执行它产出的动作
    const actions = handleIncoming(state, env as Parameters<typeof handleIncoming>[1]);
    void runIntentions(actions as unknown as Array<Record<string, unknown>>, ctx);
    renderStatus();
  });

  transport.start({ name: state.self, labels: state.selfLabels, host: safeHostname() });
  renderStatus();
}

// ---------------------------------------------------------------- 导出

export default function (pi: ExtensionAPI) {
  // 启动期把 shell/环境与 `--team-lang` flag 解析成单例 locale。注册说明
  // (registerFlag / registerCommand)在扩展加载时就被冻结,所以这一处必须
  // 最早跑。flag 此刻可能还没解析出来(getFlag 对尚未注册的 flag 返回
  // undefined),但仍按最高优先级接入,链顶不是装饰:session_start 会用
  // 真正拿到的 flag 值和 team 配置的 `lang` 字段再解析一次。
  const startupTeamEnv = process.env.TEAM ?? "";
  const startupConfig = startupTeamEnv ? readTeam(startupTeamEnv) : null;
  setLocale(resolveLocale(startupLocaleEnv(pi.getFlag("team-lang"), process.env), startupConfig ?? {}));

  apiRef = pi;

  /**
   * 用 flag + team 配置重解析语言,并记录来源。
   * 注册说明在加载时定下,这里重解析是为了让本次会话的运行时文案跟随
   * `--team-lang` / `TEAM_LANG` / 配置的 `lang` 字段(后两者加载时也已可见)。
   */
  function applyStartupLocale(teamForConfig: string | null) {
    const info = resolveLocaleInfo(
      startupLocaleEnv(pi.getFlag("team-lang"), process.env),
      teamForConfig ? readTeam(teamForConfig) ?? {} : {},
    );
    setLocale(info.locale);
    localeSource = info.source;
    localeSourceValue = info.value ?? "";
    localeOverridden = false;
    return info;
  }

  // ---- 卡片渲染器(entry 版:不进 LLM 上下文)
  pi.registerEntryRenderer<CardDetails>(CARD_TYPE, (entry, { expanded }, theme) => {
    const d = entry.data;
    const kind: CardKind = d?.kind ?? "receive";
    const body = d?.text ?? "";

    const meta: Record<CardKind, { icon: string; label: string; color: string; arrow: string }> = {
      receive: { icon: "📥", label: "RECV", color: "accent", arrow: "←" },
      send: { icon: "📤", label: "SEND", color: "success", arrow: "→" },
      reply: { icon: "🔁", label: "REPLY", color: "success", arrow: "→" },
      failed: { icon: "⚠️", label: "FAIL", color: "error", arrow: "→" },
    };
    const m = meta[kind] ?? meta.receive;

    const head =
      theme.fg(m.color, `${m.icon} ${m.label}`) +
      " " +
      theme.fg("dim", `${m.arrow} ${d?.peer ?? "?"}`) +
      (d?.at ? theme.fg("dim", `  ${new Date(d.at).toLocaleTimeString()}`) : "");

    const lines = body.split("\n");
    const shown = expanded ? lines : lines.slice(0, 6);
    let text = head + "\n" + shown.map((l) => `  ${l}`).join("\n");
    if (!expanded && lines.length > 6) text += "\n" + theme.fg("dim", `  ${t(M.tool.cardMoreLines, { count: lines.length - 6 })}`);
    if (d?.reason) text += "\n" + theme.fg(m.color, `  ${d.reason}`);

    const box = new Box(0, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  // ---- CLI flags。--team 是常规入口,其余用于显式覆盖。
  pi.registerFlag("team", { description: t(M.flag.team), type: "string" });
  pi.registerFlag("team-name", { description: t(M.flag.teamName), type: "string" });
  pi.registerFlag("team-labels", { description: t(M.flag.teamLabels), type: "string" });
  pi.registerFlag("team-mode", { description: t(M.flag.teamMode), type: "string" });
  pi.registerFlag("team-seeds", { description: t(M.flag.teamSeeds), type: "string" });
  pi.registerFlag("team-url", { description: t(M.flag.teamUrl), type: "string" });
  pi.registerFlag("team-punch", { description: "用 punch URI 加入(等同 TEAM_PUNCH)", type: "string" });
  pi.registerFlag("punch", { description: "team-punch 的别名", type: "string" });
  pi.registerFlag("team-reply", { description: t(M.flag.teamReply), type: "string" });
  pi.registerFlag("team-lang", { description: t(M.flag.teamLang), type: "string" });

  // ---- 生命周期
  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;

    // 语言:flag > TEAM_LANG > team 配置 lang > shell。注册说明在扩展加载
    // 时就冻住了,这里重解析,让本次会话的运行时文案跟随 flag 与配置。
    const localeTeam = (pi.getFlag("team") as string) ?? process.env.TEAM ?? "";
    applyStartupLocale(localeTeam || null);

    state.self =
      (pi.getFlag("team-name") as string) ??
      process.env.TEAM_NAME ??
      process.cwd().split("/").filter(Boolean).pop() ??
      "pi";

    const labels = (pi.getFlag("team-labels") as string) ?? process.env.TEAM_LABELS ?? "";
    state.selfLabels = labels.split(",").map((s) => s.trim()).filter(Boolean);

    // 回信策略。旧名字(TEAM_ANNOUNCE / --team-announce / auto / always)
    // 继续可用,读到就说一声 —— 改名不该让已写好的启动脚本静默失效。
    const rawReply =
      (pi.getFlag("team-reply") as string) ??
      (pi.getFlag("team-announce") as string) ??
      process.env.TEAM_REPLY ??
      process.env.TEAM_ANNOUNCE;

    if (rawReply) {
      const { mode, legacy } = normalizeReplyMode(rawReply);
      if (mode) {
        state.reply = mode;
        if (legacy) {
          ctx.ui.notify(t(M.notify.replyLegacyName, { old: rawReply, mode }), "warning");
        }
      } else {
        ctx.ui.notify(t(M.notify.replyUnknown, { value: rawReply }), "warning");
      }
    } else if (process.env.TEAM_QUIET === "1") {
      state.reply = "off";
    }

    const team = (pi.getFlag("team") as string) ?? process.env.TEAM ?? "";
    const url = (pi.getFlag("team-url") as string) ?? process.env.TEAM_URL ?? "";
    const token = process.env.TEAM_TOKEN ?? "";
    const modeFlag = (pi.getFlag("team-mode") as string) ?? process.env.TEAM_MODE ?? "";
    const seedsFlag = (pi.getFlag("team-seeds") as string) ?? process.env.TEAM_SEEDS ?? "";

    // ── TEAM_PUNCH:<uri> ──
    // 一台全新机器的一条命令加入路径:URI 里已经有 topic 和 token,
    // 所以不需要 seeds / url / TEAM_TOKEN。TEAM_TOKEN 仍可作为可选
    // 覆盖(不是第二个必填项)。TEAM_PUNCH 优先于 TEAM。
    const flagPunch =
      (pi.getFlag("punch") as string) ?? (pi.getFlag("team-punch") as string) ?? "";
    const parsedPunch = flagPunch ? parsePunchUri(flagPunch) : punchFromEnv(process.env);
    if (parsedPunch) {
      if (!parsedPunch.ok) {
        ctx.ui.notify(`team:punch URI 无效 —— ${parsedPunch.reason}`, "error");
        return;
      }
      const r = joinTeam({
        team: parsedPunch.name,
        token: token || parsedPunch.token, // TEAM_TOKEN 可选覆盖
        topic: parsedPunch.topic,
        mode: "hyperswarm",
        save: false,
      });
      if (!r.ok) {
        ctx.ui.notify(`team:${r.reason}`, "error");
        return;
      }
      ctx.ui.notify(`team:从 punch URI 加入 "${parsedPunch.name}"(hyperswarm)`, "info");
      connectWith(parsedPunch.name, r.config);
      return;
    }

    if (team) {
      // joinTeam 只读本地配置 / 或记录新配置,不涉及网络
      const r = joinTeam({
        team,
        url: url || undefined,
        token: token || undefined,
        mode: modeFlag || undefined,
        seeds: seedsFlag || undefined,
        save: false,
      });
      if (!r.ok) {
        ctx.ui.notify(`team:${r.reason}`, "error");
        return;
      }
      connectWith(team, r.config);
      return;
    }

    // 不读配置文件,完全由参数/环境变量驱动(适合容器和脚本)
    if (token && (url || seedsFlag || modeFlag)) {
      connectWith(null, {
        url: url || undefined,
        token,
        labels: state.selfLabels,
        mode: modeFlag || undefined,
        seeds: seedsFlag ? normalizeSeeds(seedsFlag) : undefined,
      });
      return;
    }

    const known = listTeams();
    ctx.ui.notify(
      known.length
        ? t(M.notify.noTeamKnown, { known: known.join(", ") })
        : t(M.notify.noTeam),
      "warning",
    );
  });

  pi.on("session_shutdown", async () => {
    transport?.stop();
    transport = null;
    ctxRef = null;
  });

  pi.on("turn_start", async (_event, ctx) => {
    ctxRef = ctx;
  });

  // ---- 累积 assistant 文本
  //
  // agent_settled 的事件对象只有 { type },没有 messages,所以文本
  // 必须在这里攒。
  pi.on("message_end", async (event) => {
    const m = event.message as { role?: string; content?: unknown };
    const role = m?.role;

    // user 消息也要看:注入的 payload 会原样出现在这里,靠它把
    // "哪段回答对应哪个请求"绑起来。以前只处理 assistant,
    // 所以并发请求时只能记住最后一个,回答会寄给错误的人。
    // 队友消息的 role 是 "custom"(实测),靠 customType 认出来。
    // 这一步同时记录"模型确实看到了它" —— 只有看到过、又在这一轮里
    // 没被回复的请求,才需要提醒。
    const customType = (m as { customType?: string })?.customType ?? null;
    if (role === "custom" || role === "user" || role === "assistant") {
      observeMessage(state, role, extractAssistantText(m.content), customType);
    }
  });

  // run 正式开始 —— 这时才把排队的消息投出去。
  //
  // 为什么必须等这一刻:agent_start 之前投 followUp 没有意义,那时代理
  // 还没开始处理,Pi 会把它当普通 prompt,于是又落回"被后一条覆盖"的
  // 那个窗口。探针在 before_agent_start 与 agent_start 之间实测过。
  pi.on("agent_settled", async (_event, ctx) => {
    ctxRef = ctx;
    const actions = onTurnSettled(state);
    void runIntentions(actions as unknown as Array<Record<string, unknown>>, ctx);
  });

  // ---- 系统提示
  pi.on("before_agent_start", async (event) => {
    const list = others(state);
    const labels = knownLabels(state);
    const mode = currentMode;

    const roster = list.length
      ? [...list]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((m) => `  ${m.name}${m.host ? ` (${m.host})` : ""}${m.labels?.length ? ` [${m.labels.join(" ")}]` : ""}`)
          .join("\n")
      : "  (无其他节点在线)";

    const note = [
      "",
      "## Team",
      `你是多机 Pi 集群的一员。节点名 \`${state.self}\`,team \`${currentTeam ?? "(直接连接)"}\`,模式 \`${mode}\`。`,
      state.selfLabels?.length ? `你的标签:${state.selfLabels.join(", ")}` : "",
      "",
      "在线节点:",
      roster,
      labels.length ? `可用分组:${labels.map((l) => `@${l}`).join(" ")}` : "",
      "",
      "**发送**:调用 `team_send({ to, text })`。`to` 可以是节点名、`@label`(分组)、`\"*\"`(全员)、`\"@default\"`(默认组),或数组。",
      "**查成员**:调用 `team_roster()`,或 `team_info({ what: \"peers\" })`。",
      "",
      "**接收**:输入里出现 `[来自 <名字> 的 team 消息]` 前缀时,那是另一个 agent 发来的请求,不是真人打字。",
      "按内容本身的意思回应:是任务就执行,是讨论就接着走。不要反问「需要我做什么」。",
      "**回复要用 team_send** —— 你这一轮的输出不会自动回传。发给谁就是回复谁,不需要额外参数。",
      "不需要回复的(纯通知、寒暄)可以不管;系统最多提醒一次,不会反复打扰。",
      "",
      "**克制**:每次发送都占用对方一轮完整思考,群发更贵。除非任务需要,不要主动发消息。",
      "",
    ]
      .filter((l) => l !== "")
      .join("\n");

    return { systemPrompt: event.systemPrompt + note };
  });

  // ---- 工具入口(给模型和自动化)
  pi.registerTool({
    name: "team_send",
    label: "Team Send",
    description:
      "给同一 team 里的其他 Pi 节点发消息,也用它回复收到的队友消息。to 可以是节点名、'@label' 分组、'*' 全员、'@default' 默认组,或逗号分隔的名字数组。名字从 team_roster 或系统提示的 Team 段落获取。",
    promptSnippet: "team_send(to, text) — 给一个或一组 Pi 节点发消息(也是回复队友的方式)",
    promptGuidelines: [
      "Use team_send only when the task spans another machine; each recipient costs a full model turn.",
      "Replies are NOT automatic: when a teammate's message needs an answer, call team_send to answer it. Sending back to the same peer links it to their request automatically.",
      "You can ignore a teammate's message when no answer is needed; it will be reminded once, not repeatedly.",
      "Broadcasting with '*' or '@label' wakes every matching node; prefer naming recipients.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "节点名、'@label'、'*'、'@default',或逗号分隔多收件人" }),
      text: Type.String({ description: "消息内容:背景、期望产出、验收标准一次说清" }),
    }),

    renderCall(args, theme) {
      const raw = String(args?.to ?? "?");
      const bulk = raw === "*" || raw === "@default" || raw.includes(",") || raw.startsWith("@") || raw.startsWith("#");
      const head =
        theme.fg("toolTitle", theme.bold("team_send ")) +
        theme.fg(bulk ? "warning" : "accent", bulk ? `📢 ${raw}` : `📤 ${raw}`);
      const lines = String(args?.text ?? "").split("\n");
      let text = head + "\n" + lines.slice(0, 4).map((l) => theme.fg("muted", `  ${l}`)).join("\n");
      if (lines.length > 4) text += "\n" + theme.fg("dim", `  ${t(M.tool.moreLines, { count: lines.length - 4 })}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as { delivered?: boolean; to?: string; error?: string } | undefined;
      if (d?.delivered === false) {
        return new Text(theme.fg("error", `⚠️ ${d.error ?? t(M.tool.notConnected)}`), 0, 0);
      }
      return new Text(theme.fg("success", t(M.tool.delivered, { to: d?.to ?? "?" })), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctxRef = ctx;
      // origin:"model" —— 对方回复时靠它判断"模型知道这回事吗"。
      // 以前这里没传,dispatch 一律记成 "user",于是模型发出的消息被
      // 记成人发的,对方回复时只显示一张卡片,模型永远看不到那条回复。
      const r = await invoke({ sub: "send", args: [params.to, params.text], origin: "model" }, ctx);

      if (!r.ok) {
        return {
          content: [{ type: "text", text: t(M.tool.sendFailed, { error: r.error }) }],
          details: { delivered: false, to: params.to, error: r.error },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: t(M.tool.receipt, { summary: r.lines.join(" ") }),
          },
        ],
        details: { delivered: true, to: params.to },
      };
    },
  });

  pi.registerTool({
    name: "team_roster",
    label: "Team Roster",
    description: "列出在线节点及其所在机器和标签。用于按机器或标签挑选收件人,或确认谁在线。",
    promptSnippet: "team_roster() — 列出在线节点与标签",
    parameters: Type.Object({}),

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("team_roster ")), 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as { members?: Array<{ name: string; host: string | null; labels: string[] }> } | undefined;
      const list = d?.members ?? [];
      return new Text(
        theme.fg(
          "muted",
          list.length
            ? list.map((m) => `${m.name}${m.labels.length ? ` [${m.labels.join(" ")}]` : ""} @${m.host ?? "?"}`).join("\n")
            : t(M.tool.noPeers),
        ),
        0,
        0,
      );
    },

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      ctxRef = ctx;
      const members = others(state).map((m) => ({ name: m.name, host: m.host, labels: m.labels ?? [] }));
      const labels = knownLabels(state);
      return {
        content: [
          {
            type: "text",
            text: members.length
              ? [
                  ...members.map((m) => `${m.name}${m.labels.length ? ` [${m.labels.join(" ")}]` : ""} host=${m.host ?? "?"}`),
                  labels.length ? `\n可用分组:${labels.map((l) => `@${l}`).join(" ")}` : "",
                ].join("\n")
              : "没有其他节点在线",
          },
        ],
        details: { members, labels },
      };
    },
  });

  pi.registerTool({
    name: "team_info",
    label: "Team Info",
    description: "查看本节点在 team 里的状态:team 名、连接状态、broker、在线数量、回信提醒模式。",
    promptSnippet: "team_info() — 查看 team 状态",
    parameters: Type.Object({
      what: Type.Optional(Type.String({ description: "'status'(默认)或 'peers'" })),
    }),

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("team_info ")) + theme.fg("muted", String(args?.what ?? "status")),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const d = result.details as { lines?: string[] } | undefined;
      return new Text(theme.fg("muted", (d?.lines ?? []).join("\n")), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ctxRef = ctx;
      const r = await invoke({ sub: params.what === "peers" ? "peers" : "status", args: [] }, ctx);
      return {
        content: [{ type: "text", text: r.ok ? r.lines.join("\n") : t(M.tool.failed, { error: r.error }) }],
        details: { lines: r.ok ? r.lines : [], ok: r.ok },
      };
    },
  });

  /**
   * team_join / team_leave / team_label 也做成工具。
   *
   * 它们会改本机配置或连接状态,属于配置操作。给模型开放是因为
   * 自动化场景确实需要(让 agent 自己加入一个 team 并开始协作),
   * 但说明里写清楚它们有副作用。
   */
  pi.registerTool({
    name: "team_join",
    label: "Team Join",
    description:
      "加入一个 team 并连接。首选方式是把创建时打印的 punch URI 传给 punch 参数 —— 一条 URI 就够,不需要 team/token/url/seeds。" +
      "也可以用 team 名:已在本机配置里时只需 team 名;首次加入需要 token,以及 url(broker)或 seeds(mesh/swim)。" +
      "改 mode 或 seeds 也用它 —— 已有的 url/token 会保留。",
    promptSnippet:
      "team_join(punch?) 或 team_join(team, token?, url?, mode?, seeds?, name?, labels?, port?) — 加入或重新配置 team",
    parameters: Type.Object({
      team: Type.Optional(Type.String({ description: "team 名(小写字母数字)。给了 punch URI 时可省略" })),
      punch: Type.Optional(
        Type.String({ description: "punch://<team>/<topic>/<token> —— 创建时打印的 URI。给了它就不需要 team/token/url/seeds" }),
      ),
      token: Type.Optional(Type.String({ description: "team token,首次加入时必需(用 punch URI 时由 URI 携带)" })),
      url: Type.Optional(Type.String({ description: "broker 地址,broker 模式必需,例如 http://100.64.0.1:8787" })),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("broker"), Type.Literal("mesh"), Type.Literal("swim"), Type.Literal("hyperswarm")],
          { description: "投递模式。broker 经中转;mesh/swim 节点直连,需要 seeds;hyperswarm 无服务器,用 punch URI 加入" },
        ),
      ),
      seeds: Type.Optional(
        Type.Array(Type.String(), { description: "mesh/swim 的种子地址,形如 100.64.0.1:19801" }),
      ),
      name: Type.Optional(Type.String({ description: "本节点名。只影响本次运行,不写入配置" })),
      labels: Type.Optional(Type.Array(Type.String(), { description: "本节点标签,供 @label 群发" })),
      port: Type.Optional(
        Type.Number({ description: "mesh/swim 的监听端口。只影响本次运行。0 = 让内核分配(默认)" }),
      ),
      listen: Type.Optional(
        Type.String({ description: "mesh/swim 的监听地址,默认 0.0.0.0。只影响本次运行" }),
      ),
    }),

    renderCall(args, theme) {
      // 绝不回显完整 token —— 它会出现在可见的工具调用行里,被抄进日志。
      // punch URI 只显示 room 标识和 topic,token 一段用 … 代替。
      let what;
      if (args?.punch) {
        const p = parsePunchUri(args.punch);
        what = p.ok ? `punch://${p.name}/${p.topic}/…` : "punch URI";
      } else {
        what = String(args?.team ?? "?");
      }
      return new Text(theme.fg("toolTitle", theme.bold("team_join ")) + theme.fg("accent", what), 0, 0);
    },

    renderResult(result, _options, theme) {
      const d = result.details as { ok?: boolean; lines?: string[] } | undefined;
      return new Text(theme.fg(d?.ok ? "success" : "error", (d?.lines ?? []).join("\n")), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // 走和 /team join 同一个 dispatch —— 工具的选项必须和命令的选项
      // 完全一致,否则模型能设的东西和人能设的东西会分叉。
      // punch URI 作为位置参数传入,dispatch 会解析出 team/topic/token。
      const args: string[] = params.punch ? [params.punch] : params.team ? [params.team] : [];
      if (params.url) args.push("--url", params.url);
      if (params.token) args.push("--token", params.token);
      if (params.mode) args.push("--mode", params.mode);
      if (params.seeds?.length) args.push("--seeds", params.seeds.join(","));
      if (params.name) args.push("--name", params.name);
      if (params.labels?.length) args.push("--labels", params.labels.join(","));
      if (params.port !== undefined) args.push("--port", String(params.port));
      if (params.listen) args.push("--listen", params.listen);

      const r = await invoke({ sub: "join", args }, ctx);
      return {
        content: [{ type: "text", text: r.ok ? r.lines.join("\n") : t(M.tool.failed, { error: r.error }) }],
        details: { ok: r.ok, lines: r.ok ? r.lines : [r.error] },
      };
    },
  });

  pi.registerTool({
    name: "team_leave",
    label: "Team Leave",
    description: "离开当前 team:断开连接并删除本机配置。不影响 broker 或其它节点。",
    promptSnippet: "team_leave(team?) — 离开 team",
    parameters: Type.Object({
      team: Type.Optional(Type.String({ description: "要离开的 team 名,省略则离开当前" })),
    }),

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("team_leave ")) + theme.fg("muted", String(args?.team ?? t(M.tool.currentTeam))),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const d = result.details as { ok?: boolean; lines?: string[] } | undefined;
      return new Text(theme.fg(d?.ok ? "success" : "error", (d?.lines ?? []).join("\n")), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await invoke({ sub: "leave", args: params.team ? [params.team] : [] }, ctx);
      return {
        content: [{ type: "text", text: r.ok ? r.lines.join("\n") : t(M.tool.failed, { error: r.error }) }],
        details: { ok: r.ok, lines: r.ok ? r.lines : [r.error] },
      };
    },
  });

  pi.registerTool({
    name: "team_label",
    label: "Team Label",
    description:
      "管理本节点的标签,用于被别人按 @label 群发。add/remove 会重连 broker(标签是 broker 侧的分组依据)。",
    promptSnippet: "team_label(action, labels?) — 管理本节点标签",
    parameters: Type.Object({
      action: Type.String({ description: "'list'、'add' 或 'remove'" }),
      labels: Type.Optional(Type.String({ description: "逗号分隔的标签名" })),
    }),

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("team_label ")) +
          theme.fg("accent", String(args?.action ?? "list")) +
          (args?.labels ? theme.fg("muted", ` ${args.labels}`) : ""),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const d = result.details as { ok?: boolean; lines?: string[] } | undefined;
      return new Text(theme.fg(d?.ok ? "success" : "error", (d?.lines ?? []).join("\n")), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const list = String(params.labels ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const r = await invoke({ sub: "label", args: [String(params.action ?? "list"), ...list] }, ctx);
      return {
        content: [{ type: "text", text: r.ok ? r.lines.join("\n") : t(M.tool.failed, { error: r.error }) }],
        details: { ok: r.ok, lines: r.ok ? r.lines : [r.error] },
      };
    },
  });

  // ---- 命令入口(给人用)
  pi.registerCommand("team", {
    description: t(M.command.team),
    getArgumentCompletions(prefix) {
      const subs = [
        "status", "peers", "create", "join", "leave", "mode", "label", "send", "reply", "lang", "on", "off",
      ];
      if (!prefix.includes(" ")) {
        return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s, description: `/team ${s}` }));
      }

      const [sub, ...rest] = prefix.split(" ");
      const partial = rest.join(" ");

      if (sub === "label") {
        return ["list", "add", "remove"].filter((o) => o.startsWith(partial)).map((o) => ({ value: o, label: o }));
      }

      if (sub === "send" && rest.length <= 1) {
        const items = [
          { value: "@default", label: "@default", description: t(M.ui.acDefaultGroup) },
          { value: "*", label: "*", description: t(M.ui.acAll) },
          ...knownLabels(state).map((l) => ({ value: `@${l}`, label: `@${l}`, description: t(M.ui.acGroup) })),
          ...others(state).map((m) => ({
            value: m.name,
            label: m.name,
            description: m.host ? `${m.host}${m.labels?.length ? ` · ${m.labels.join(" ")}` : ""}` : undefined,
          })),
        ];
        return items.filter((i) => i.value.startsWith(partial));
      }

      if (sub === "join" && rest.length === 0) {
        return listTeams().map((name) => ({ value: name, label: name, description: t(M.ui.acKnownConfig) }));
      }

      if (sub === "lang") {
        return SUPPORTED_LOCALES.filter((l) => l.toLowerCase().startsWith(partial.toLowerCase()))
          .map((l) => ({ value: l, label: l }));
      }

      // join / create / mode 的选项补全 —— 否则这些选项只能靠记。
      //
      // autocomplete 的 value 替换的是**整个参数串**,不是最后一个词。
      // 所以这里必须把前缀原样带上,只换掉正在输入的那一段;否则
      // `/team join dev --m` 选中后会把 `dev` 一起吞掉,team 名就没了。
      const completeToken = (options) => {
        const tokens = partial.split(" ");
        const head = tokens.slice(0, -1);
        const last = tokens[tokens.length - 1] ?? "";
        return options
          .filter((o) => o.option.startsWith(last))
          .map((o) => ({ value: [...head, o.option].join(" "), label: o.option, description: o.description }));
      };

      if (sub === "join" || sub === "create") {
        const cur = partial.split(" ").pop() ?? "";
        // 只有正在输入一个 -- 选项时才提示选项,免得打字时一直刷列表
        if (partial === "" || cur.startsWith("--")) {
          return completeToken([
          return completeToken([
            { option: "--punch", description: "punch://... 加入(一条 URI 就够)" },
            { option: "--url", description: t(M.ui.brokerAddress) },
            { option: "--token", description: "team token" },
            { option: "--mode", description: "broker | mesh | swim | hyperswarm" },
            { option: "--topic", description: "hyperswarm 的 32 字节 topic" },
            { option: "--seeds", description: "host:port,..." },
            { option: "--name", description: t(M.ui.acNodeName) },
            { option: "--labels", description: t(M.ui.acLabels) },
          ]);
        }
        return null;
      }

      if (sub === "mode") {
        return completeToken(["broker", "mesh", "swim", "hyperswarm"].map((m) => ({ option: m })));
      }

      if (sub === "reply" || sub === "announce") {
        return ["off", "remind", "mirror"]
          .filter((m) => m.startsWith(partial))
          .map((m) => ({ value: m, label: m }));
      }

      return null;
    },

    handler: async (args, ctx) => {
      ctxRef = ctx;
      const trimmed = args.trim();
      if (!trimmed) {
        await menu(ctx);
        return;
      }

      const parts = trimmed.split(/\s+/);
      if (parts[0] === "lang") {
        await langCommand(parts.slice(1), ctx);
        return;
      }
      const r = await invoke({ sub: parts[0], args: parts.slice(1) }, ctx);

      if (!r.ok) {
        // error 而不是 warning:命令没执行成功。显示成警告会让人以为
        // 部分是成功的(实测中确实造成了这个误解)。
        ctx.ui.notify(r.error!, "error");
        return;
      }
      // 意图执行阶段已经 notify 过 notes,这里只报 lines
      if (r.lines.length) ctx.ui.notify(r.lines.join("\n"), "info");
    },
  });

  // ---------------------------------------------------------------- 菜单

  /**
   * join / create 的交互向导。
   *
   * 先问模式,再按模式问地址 —— 要问什么取决于模式:broker 要 URL,
   * mesh/swim 要种子。以前的向导只问 URL,于是从菜单加入 mesh team
   * 会卡在一个根本用不上的必填项上。
   *
   * 返回 /team join 能直接吃的参数数组,和命令行完全同一套选项。
   * 用户中途取消时返回 null。
   */
  async function askJoinOptions(
    ctx: ExtensionContext,
    { allowNewTeam = false, isCreate = false }: { allowNewTeam?: boolean; isCreate?: boolean } = {},
  ): Promise<string[] | null> {
    let teamName: string;
    let existing: { mode?: string; url?: string; token?: string } | null = null;

    if (isCreate) {
      const name = await ctx.ui.input(t(M.ui.inputNewTeam), t(M.ui.placeholderLowerAlnum));
      if (!name?.trim()) return null;
      teamName = name.trim();
    } else {
      const known = listTeams();
      const NEW = t(M.ui.optionNewTeam);
      const picked = await ctx.ui.select(t(M.ui.selectJoinTeam), allowNewTeam ? [...known, NEW] : known);
      if (!picked) return null;
      if (picked === NEW) {
        const name = await ctx.ui.input(t(M.ui.inputTeamName), t(M.ui.placeholderLowerAlnum));
        if (!name?.trim()) return null;
        teamName = name.trim();
      } else {
        teamName = picked;
        existing = readTeam(picked);
        // 已有配置的 team 直接加入,不重复问 —— 要改配置用 /team mode
        // 或者带选项的 /team join。
        if (existing?.token) return [teamName];
      }
    }

    const modePick = await ctx.ui.select(t(M.ui.selectConnectMode), [
      "hyperswarm  —  无服务器,DHT 打洞(默认;用 punch URI 加入)",
      t(M.ui.modeBrokerRecommend),
      t(M.ui.modeMeshNoCenter),
      t(M.ui.modeSwimMembers),
    ]);
    if (!modePick) return null;
    const mode = modePick.split(" ")[0];

    // hyperswarm 加入靠 punch URI,不需要 url/seeds。create 时不需要
    // 额外输入 —— token 和 topic 会自动生成。
    if (mode === "hyperswarm") {
      if (isCreate) return [teamName, "--mode", mode];
      const uri = await ctx.ui.input("punch URI", "punch://<team>/<topic>/<token>");
      if (!uri?.trim()) return null;
      return [uri.trim()];
    }

    const args = [teamName, "--mode", mode];

    if (mode === "broker") {
      const u = await ctx.ui.input(t(M.ui.brokerAddress), "http://<tailscale-ip>:8787");
      if (!u?.trim()) return null;
      args.push("--url", u.trim());
    } else {
      // 种子可以不填:第一个节点本来就没有别人可以指向
      const seeds = await ctx.ui.input(
        t(M.ui.inputSeeds),
        mode === "swim" ? t(M.ui.placeholderSeedsSwim) : t(M.ui.placeholderSeeds),
      );
      if (seeds?.trim()) args.push("--seeds", seeds.trim());
    }

    // create 时 token 可以省略,会自动生成
    const k = await ctx.ui.input(
      "token",
      isCreate ? t(M.ui.placeholderTokenCreate) : t(M.ui.placeholderToken),
    );
    if (k?.trim()) args.push("--token", k.trim());
    else if (!isCreate) return null;

    return args;
  }

  /**
   * /team lang —— 汇报生效语言与来源,或设置它。
   *
   * 设置会写进当前 team 配置的 `lang` 字段,下次启动(以及下次会话)能
   * 读回来。注册说明(flag / 命令帮助)在扩展加载时就冻结了,所以那次
   * 改动要到下次重载才会体现;运行时文案即时生效。
   */
  async function langCommand(args: string[], ctx: ExtensionContext) {
    const want = (args[0] ?? "").trim();

    if (want === "help" || want === "-h" || want === "--help") {
      ctx.ui.notify(t(M.lang.usage), "info");
      return;
    }

    if (!want) {
      const cfg = currentTeam ? readTeam(currentTeam) : null;
      const startup = resolveLocaleInfo(startupLocaleEnv(pi.getFlag("team-lang"), process.env), cfg ?? {});
      const sourceKey = localeOverridden
        ? M.lang.source.session
        : LANG_SOURCE_KEYS[localeSource ?? startup.source] ?? M.lang.source.intl;
      const value = localeOverridden ? getLocale() : localeSourceValue || startup.value || "";
      const lines = [t(M.lang.report, { locale: getLocale(), source: t(sourceKey, { value }) })];
      if (!localeOverridden && startup.unsupported) {
        lines.push(t(M.lang.unsupported, { value: startup.value ?? "" }));
      }
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    const picked = classifyLocale(want);
    if (!picked) {
      ctx.ui.notify(t(M.lang.invalid, { value: want, locales: SUPPORTED_LOCALES.join(", ") }), "error");
      return;
    }

    setLocale(picked);
    localeOverridden = true;

    // 写回当前 team 的配置。没绑定 team 时没有文件可写,只在本会话生效。
    let persisted = false;
    if (currentTeam) {
      const cfg = readTeam(currentTeam);
      if (cfg) {
        cfg.lang = picked;
        writeTeam(currentTeam, cfg);
        persisted = true;
      }
    }
    ctx.ui.notify(
      persisted
        ? t(M.lang.set, { locale: picked })
        : t(M.lang.setUnpersisted, { locale: picked }),
      "info",
    );
  }

  async function menu(ctx: ExtensionContext) {
    const list = others(state);
    const choices: { label: string; run: () => Promise<void> }[] = [
      {
        label: t(M.ui.menuViewMembers),
        run: async () => {
          const r = await invoke({ sub: "peers", args: [] }, ctx);
          if (r.lines.length) ctx.ui.notify(r.lines.join("\n"), r.ok ? "info" : "error");
        },
      },
      {
        label: t(M.ui.menuSendToNode),
        run: async () => {
          if (!list.length) return void ctx.ui.notify(t(M.notify.noPeersOnline), "warning");
          const pick = await ctx.ui.select(
            t(M.ui.selectSendWho),
            list.map((m) => `${m.name}${m.host ? `  —  ${m.host}` : ""}${m.labels?.length ? `  [${m.labels.join(" ")}]` : ""}`),
          );
          if (!pick) return;
          const target = list.find((m) => pick.startsWith(m.name));
          if (!target) return;
          const text = await ctx.ui.input(t(M.ui.inputSendTo, { name: target.name }), t(M.ui.placeholderMessage));
          if (!text?.trim()) return;
          const r = await invoke({ sub: "send", args: [target.name, text] }, ctx);
          if (!r.ok) ctx.ui.notify(r.error!, "error");
        },
      },
      {
        label: t(M.ui.menuBroadcast),
        run: async () => {
          if (!list.length) return void ctx.ui.notify(t(M.notify.noPeersOnline), "warning");
          const labels = knownLabels(state);
          const options = [
            t(M.ui.broadcastDefault, { count: list.length }),
            t(M.ui.broadcastAll, { count: list.length }),
            ...labels.map((l) =>
              t(M.ui.broadcastLabel, { label: l, count: list.filter((m) => m.labels?.includes(l)).length }),
            ),
          ];
          const pick = await ctx.ui.select(t(M.ui.selectBroadcastGroup), options);
          if (!pick) return;

          const to = pick.split(/\s+/)[0];
          const text = await ctx.ui.input(t(M.ui.inputBroadcastTo, { to }), t(M.ui.placeholderMessage));
          if (!text?.trim()) return;

          const r = await invoke({ sub: "send", args: [to, text] }, ctx);
          if (!r.ok) ctx.ui.notify(r.error!, "error");
        },
      },
      {
        label: t(M.ui.menuManageLabels),
        run: async () => {
          const op = await ctx.ui.select(t(M.ui.selectLabelOp), [
            t(M.ui.labelOpList),
            t(M.ui.labelOpAdd),
            t(M.ui.labelOpRemove),
          ]);
          if (!op) return;
          const action = op.split(" ")[0];

          if (action === "list") {
            const r = await invoke({ sub: "label", args: ["list"] }, ctx);
            return void ctx.ui.notify(r.lines.join("\n"), "info");
          }

          const input = await ctx.ui.input(
            action === "add" ? t(M.ui.inputLabelsAdd) : t(M.ui.inputLabelsRemove),
            t(M.ui.placeholderCommaSeparated),
          );
          if (!input?.trim()) return;
          const names = input.split(",").map((s) => s.trim()).filter(Boolean);
          const r = await invoke({ sub: "label", args: [action, ...names] }, ctx);
          if (!r.ok) ctx.ui.notify(r.error!, "error");
        },
      },
      {
        label: t(M.ui.menuTeamManage),
        run: async () => {
          const op = await ctx.ui.select(t(M.ui.selectTeamOp), [
            t(M.ui.teamOpList),
            t(M.ui.teamOpJoin),
            t(M.ui.teamOpCreate),
            t(M.ui.teamOpLeave),
          ]);
          if (!op) return;
          const action = op.split(" ")[0];

          if (action === "list") {
            const known = listTeams();
            return void ctx.ui.notify(
              known.length
                ? known.map((name) => (name === currentTeam ? `${name}${t(M.notify.currentTeamMarker)}` : name)).join("\n")
                : t(M.notify.noTeamsConfigured),
              "info",
            );
          }

          if (action === "leave") {
            const r = await invoke({ sub: "leave", args: [] }, ctx);
            return void ctx.ui.notify(r.ok ? r.lines.join("\n") : r.error!, r.ok ? "info" : "error");
          }

          if (action === "join") {
            const args = await askJoinOptions(ctx, { allowNewTeam: true });
            if (!args) return;
            const r = await invoke({ sub: "join", args }, ctx);
            return void ctx.ui.notify(r.ok ? r.lines.join("\n") : r.error!, r.ok ? "info" : "error");
          }

          if (action === "create") {
            const args = await askJoinOptions(ctx, { allowNewTeam: true, isCreate: true });
            if (!args) return;
            const r = await invoke({ sub: "create", args }, ctx);
            if (!r.ok) return void ctx.ui.notify(r.error!, "error");
            // hyperswarm:要复制的是 punch URI(它带着 topic 和 token)。
            // broker/mesh:token 只显示这一次,单独提示,免得被后续 notify 冲掉。
            const punchLine = r.lines.find((l) => l.startsWith("punch://"));
            if (punchLine) {
              return void ctx.ui.notify(
                `team "${args[0]}" 已创建并连接。\n\npunch URI(复制这一条到新机器):\n${punchLine}\n\n新机器一条命令:\nTEAM_PUNCH='${punchLine}' pi`,
                "info",
              );
            }
            const tokenLine = r.lines.find((l) => /^[0-9a-f]{64}$/.test(l));
            ctx.ui.notify(
              tokenLine
                ? t(M.notify.teamCreated, {
                    team: args[0],
                    token: tokenLine,
                    join: r.lines.find((l) => l.trim().startsWith("/team join"))?.trim() ?? "",
                  })
                : r.lines.join("\n"),
              "info",
            );
          }
        },
      },
      {
        label: t(M.ui.menuConnectMode, { mode: currentMode }),
        run: async () => {
          const pick = await ctx.ui.select(t(M.ui.selectConnectMode), [
            "hyperswarm  —  无服务器,DHT 打洞,用 punch URI 加入",
            t(M.ui.modeBrokerNeedUrl),
            t(M.ui.modeMeshNeedSeeds),
            t(M.ui.modeSwimNeedSeeds),
          ]);
          if (!pick) return;
          const want = pick.split(" ")[0];
          const r = await invoke({ sub: "mode", args: [want] }, ctx);
          ctx.ui.notify(r.ok ? r.lines.join("\n") : r.error!, r.ok ? "info" : "error");
        },
      },
      {
        label: t(M.ui.menuReplyStrategy, { reply: state.reply }),
        run: async () => {
          const pick = await ctx.ui.select(t(M.ui.selectReplyTitle), [
            t(M.ui.replyOff),
            t(M.ui.replyRemind),
            t(M.ui.replyMirror),
          ]);
          if (!pick) return;
          const r = await invoke({ sub: "reply", args: [pick.split(" ")[0]] }, ctx);
          if (!r.ok) ctx.ui.notify(r.error!, "error");
        },
      },
      {
        label: t(M.ui.menuStatus),
        run: async () => {
          const r = await invoke({ sub: "status", args: [] }, ctx);
          if (r.lines.length) ctx.ui.notify(r.lines.join("\n"), "info");
        },
      },
    ];

    const pick = await ctx.ui.select(
      "Pi Agent Team",
      choices.map((c) => c.label),
    );
    if (!pick) return;
    const idx = choices.findIndex((c) => c.label === pick);
    if (idx >= 0) await choices[idx].run();
  }
}

// ---------------------------------------------------------------- 工具函数

function safeHostname(): string | null {
  try {
    return hostname() || null;
  } catch {
    return null;
  }
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: { type?: string }) => c?.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("");
  }
  return "";
}
