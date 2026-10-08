/**
 * 成员关系持久化的**真实生命周期**测试。跑:node --test src/
 *
 * ── 为什么不能只测纯归约器 ──
 *   归约器对了不代表接线对了:index.ts 完全可能把记录写到错误的时机
 *   (连不上也写)、在还原时又追加一条 join、或者在会话替换时把上一个
 *   会话的连接泄漏进新会话。这些只有在真正的 factory + session_start /
 *   session_shutdown / session_tree 生命周期里才暴露。
 *
 * ── 怎么在没有 Pi 的情况下跑真实接线 ──
 *   1. index.ts 的 Pi 导入只有 `import type`,类型剥离后不产生运行时依赖;
 *      `@earendil-works/pi-tui` 与 `typebox` 已随仓库安装,所以 index.ts 能
 *      直接 import。
 *   2. transport 工厂(src/mode.js 的 createTransport)用 node:module 的
 *      registerHooks 换成可编程替身 —— 这样监听选项(mesh/swim 的
 *      listenHost/listenPort)也能被断言,不必起真 socket。
 *   3. ExtensionAPI / ExtensionContext 用手写替身;appendEntry 同时把
 *      custom 条目追加进"当前分支",getBranch 返回它 —— 和 Pi 一样。
 *
 *   每个用例一个临时 HOME(os.homedir() 在 Linux 上每次读 $HOME),
 *   TEAM* 环境变量在用例边界清干净,避免相互污染。
 */
import * as nodeModule from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MEMBERSHIP_TYPE, makeJoinRecord, makeLeaveRecord } from "./membership.js";
import { M } from "./messages.js";
import { setLocale, t } from "./i18n.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SECRET = "s3cr3t-token-0123456789-abcdefghij";
const URL_A = "http://127.0.0.1:9";
const URL_B = "http://127.0.0.1:10";

setLocale("en-US");

// ---------------------------------------------------------------- transport 替身

/** 当前用例的 createTransport 实现;由 makeRuntime 设置。 */
let currentCreate = null;
globalThis.__teamTestCreateTransport = (opts) => currentCreate(opts);

/**
 * 能力探测:整套 harness 依赖 node:module.registerHooks(Node ≥ 22.15)与
 * .ts 导入时的类型剥离。缺任一能力就整体 skip,而不是把环境问题报成
 * index.ts 的故障 —— 和 index-loadable.test.js 的探测同一原则。
 */
const registerHooks = nodeModule.registerHooks;
const hooksAvailable = typeof registerHooks === "function";
let supported = hooksAvailable;
let unsupportedReason = hooksAvailable ? "" : "node:module.registerHooks 不可用(Node < 22.15?)";

// ── 顺序很重要 ──
//
// team-config.js 传递依赖 mode.js。如果在 registerHooks 之前就把它(或
// index.ts)导入进来,mode.js 会以**真实**实现被缓存,hook 再也拦不到
// 它 —— index.ts 就会去开真 WebSocket、挂重连定时器,测试进程不肯退出。
// 所以凡是会牵出 mode.js 的模块,一律在 hook 注册之后再 import。
if (hooksAvailable) {
  registerHooks({
    load(url, context, nextLoad) {
      // 只替换 mode.js:index.ts 的其它导入(session/config/i18n)照常走真实模块。
      if (url.endsWith("/src/mode.js")) {
        const real = `${url}?real`;
        return {
          format: "module",
          shortCircuit: true,
          source: `
import * as real from ${JSON.stringify(real)};
export const MODES = real.MODES;
export const resolveMode = real.resolveMode;
export const modeReadiness = real.modeReadiness;
export const normalizeSeeds = real.normalizeSeeds;
export const createTransport = (opts) => globalThis.__teamTestCreateTransport(opts);
`,
        };
      }
      return nextLoad(url, context);
    },
  });
}

let factory = null;
let readTeam = () => null;
let removeTeam = () => false;
let writeTeam = () => {};
if (hooksAvailable) {
  try {
    factory = (await import("../index.ts")).default;
    const teamConfig = await import("./team-config.js");
    readTeam = teamConfig.readTeam;
    removeTeam = teamConfig.removeTeam;
    writeTeam = teamConfig.writeTeam;
  } catch (err) {
    supported = false;
    unsupportedReason = `无法加载 index.ts:${err.message}`;
  }
}

/** 本文件的用例统一走这个:能力缺失时整条 skip。 */
const lifecycle = (name, fn) =>
  test(name, { skip: supported ? false : unsupportedReason }, fn);

/** 记录 start()/stop() 与事件的假 transport */
function makeFakeTransport() {
  const handlers = new Map();
  return {
    mode: "fake",
    started: null,
    stopped: false,
    port: () => 19999,
    gossipPort: () => null,
    state: () => "online",
    start(self) {
      this.started = self;
    },
    stop() {
      this.stopped = true;
    },
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev).add(fn);
      return () => handlers.get(ev)?.delete(fn);
    },
    send() {
      return true;
    },
    emit(ev, ...args) {
      for (const fn of handlers.get(ev) ?? []) fn(...args);
    },
  };
}

/**
 * 造一个"Pi 运行时 + 会话"替身。
 * branch 由调用方传入,以便跨 reload 共享同一份分支记录。
 */
function makeRuntime({ branch = [], flags = {} } = {}) {
  const appended = [];
  const notifications = [];
  const created = [];
  const transports = [];

  currentCreate = (opts) => {
    created.push(opts);
    const tr = makeFakeTransport();
    transports.push(tr);
    return { ok: true, transport: tr };
  };

  const pi = {
    handlers: new Map(),
    commands: new Map(),
    tools: new Map(),
    appendEntry(customType, data) {
      appended.push({ customType, data });
      // 和 Pi 一样:条目进入当前分支,getBranch 才能读到
      branch.push({
        type: "custom",
        id: `e${branch.length}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      });
    },
    getFlag(name) {
      return flags[name];
    },
    registerEntryRenderer() {},
    registerFlag() {},
    registerTool(def) {
      pi.tools.set(def.name, def);
    },
    registerCommand(name, def) {
      pi.commands.set(name, def);
    },
    on(ev, fn) {
      if (!pi.handlers.has(ev)) pi.handlers.set(ev, []);
      pi.handlers.get(ev).push(fn);
    },
    sendMessage() {},
    sendUserMessage() {},
    setSessionName() {},
  };

  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify(msg, level) {
        notifications.push({ msg, level });
      },
      setStatus() {},
      select: async () => null,
      confirm: async () => true,
      input: async () => null,
    },
    sessionManager: { getBranch: () => branch },
    shutdown() {},
  };

  factory(pi);

  const emit = async (event, arg = {}) => {
    for (const fn of pi.handlers.get(event) ?? []) await fn({ type: event, ...arg }, ctx);
  };

  return {
    pi,
    ctx,
    branch,
    appended,
    notifications,
    created,
    transports,
    emit,
    setCreateFailure(reason) {
      currentCreate = (opts) => {
        created.push(opts);
        return { ok: false, reason };
      };
    },
    command: (args) => pi.commands.get("team").handler(args, ctx),
    tool: (name, params) => pi.tools.get(name).execute("call", params, null, null, ctx),
    joins: () => appended.filter((a) => a.data?.kind === "join").map((a) => a.data),
    leaves: () => appended.filter((a) => a.data?.kind === "leave").map((a) => a.data),
  };
}

// ---------------------------------------------------------------- 环境隔离

const TEAM_ENV_KEYS = [
  "TEAM", "TEAM_NAME", "TEAM_LABELS", "TEAM_MODE", "TEAM_SEEDS", "TEAM_URL", "TEAM_TOKEN",
  "TEAM_PUNCH", "TEAM_REPLY", "TEAM_ANNOUNCE", "TEAM_QUIET", "TEAM_LANG",
  "TEAM_LISTEN_HOST", "TEAM_LISTEN_PORT", "TEAM_ADVERTISE_HOST", "PI_TEAM_SWIM_SIDECAR",
];

/** 默认清空所有 TEAM* 变量,并把 shell locale 钉成英文 */
function env(over = {}) {
  const base = { LANG: "en_US.UTF-8" };
  for (const k of TEAM_ENV_KEYS) base[k] = undefined;
  return { ...base, ...over };
}

async function withEnv(vars, fn) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function withHome(t) {
  const home = mkdtempSync(join(tmpdir(), "pi-team-membership-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// ---------------------------------------------------------------- 用例

lifecycle("生命周期:join → reload 还原同一 team/名字/标签/监听选项与 join 身份", async (t) => {
  const home = withHome(t);
  const branch = [];
  const NAME = "dev01-web";
  const LABELS = ["web", "db"];

  await withEnv(env({ HOME: home, TEAM_TOKEN: TOKEN, TEAM_LISTEN_HOST: "0.0.0.0", TEAM_LISTEN_PORT: "19801" }), async () => {
    // ── 第一次运行:显式参数加入 ──
    const rt1 = makeRuntime({ branch, flags: { team: "alpha", "team-url": URL_A, "team-name": NAME, "team-labels": LABELS.join(",") } });
    await rt1.emit("session_start", { reason: "startup" });

    assert.equal(rt1.joins().length, 1, "成功加入后应恰好追加一条 join");
    const joinRec = rt1.joins()[0];
    assert.equal(joinRec.team, "alpha");
    assert.equal(joinRec.name, NAME);
    assert.deepEqual(joinRec.labels, LABELS);
    assert.deepEqual(joinRec.listen, { host: "0.0.0.0", port: 19801 }, "应记下本次生效的监听选项");
    assert.equal(rt1.created.length, 1);
    assert.equal(rt1.created[0].listenPort, 19801);
    assert.equal(rt1.transports[0].started.name, NAME);

    await rt1.emit("session_shutdown", { reason: "reload" });

    // ── 模拟 reload:分支记录保留,显式参数与监听环境变量都不再存在 ──
    delete process.env.TEAM_LISTEN_HOST;
    delete process.env.TEAM_LISTEN_PORT;
    delete process.env.TEAM_TOKEN;

    const rt2 = makeRuntime({ branch });
    await rt2.emit("session_start", { reason: "reload" });

    assert.equal(rt2.joins().length, 0, "还原不能再追加 join");
    assert.equal(rt2.created.length, 1, "应据记录重新连接");
    assert.equal(rt2.created[0].listenPort, 19801, "监听端口应沿用记录,即使环境变量已消失");
    assert.equal(rt2.created[0].listenHost, "0.0.0.0");
    assert.equal(rt2.created[0].config.url, URL_A);
    assert.equal(rt2.transports[0].started.name, NAME, "节点名应沿用记录");
    assert.deepEqual(rt2.transports[0].started.labels, LABELS, "标签应沿用记录");

    // 身份保留的端到端证明:此刻 leave,引用的是被还原的那个 join id
    await rt2.command("leave");
    const leaveRec = rt2.leaves()[0];
    assert.ok(leaveRec, "leave 应追加一条 leave 记录");
    assert.equal(leaveRec.joinId, joinRec.id, "leave 必须引用被还原的 join,而不是新造的");

    // 再 reload 一次:依然不追加
    await rt2.emit("session_shutdown", { reason: "reload" });
    const rt3 = makeRuntime({ branch });
    await rt3.emit("session_start", { reason: "reload" });
    assert.equal(rt3.joins().length, 0, "还原是幂等的,不会累积 join");
  });
});

lifecycle("生命周期:显式 leave 之后 reload 保持断开(即使本地配置仍在)", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home, TEAM_TOKEN: TOKEN }), async () => {
    const rt1 = makeRuntime({ branch, flags: { team: "alpha", "team-url": URL_A } });
    await rt1.emit("session_start", { reason: "startup" });
    assert.equal(rt1.joins().length, 1);

    await rt1.command("leave");
    assert.equal(readTeam("alpha", home), null, "leave 会删掉本地配置");
    assert.equal(rt1.leaves().length, 1);
    assert.equal(rt1.leaves()[0].joinId, rt1.joins()[0].id);

    // 把配置重新放回去:leave 的语义必须来自持久化记录,而不是"配置恰好没了"
    writeTeam("alpha", { mode: "broker", token: TOKEN, url: URL_A }, home);

    await rt1.emit("session_shutdown", { reason: "reload" });
    const rt2 = makeRuntime({ branch });
    await rt2.emit("session_start", { reason: "reload" });

    assert.equal(rt2.created.length, 0, "显式 leave 之后不得自动重连");
    assert.equal(rt2.transports.length, 0);
    assert.equal(rt2.joins().length, 0);
  });
});

lifecycle("生命周期:join A → leave A → join B → reload 还原 B", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home }), async () => {
    const rt1 = makeRuntime({ branch });
    await rt1.command(`join alpha --url ${URL_A} --token ${TOKEN}`);
    await rt1.command("leave");
    await rt1.command(`join beta --url ${URL_B} --token ${TOKEN}`);
    assert.equal(rt1.joins().length, 2);
    assert.equal(rt1.leaves().length, 1);

    await rt1.emit("session_shutdown", { reason: "reload" });
    const rt2 = makeRuntime({ branch });
    await rt2.emit("session_start", { reason: "reload" });

    assert.equal(rt2.created.length, 1);
    assert.equal(rt2.created[0].config.url, URL_B, "应还原最后一个 join 的 team");
    assert.equal(rt2.joins().length, 0);
  });
});

lifecycle("生命周期:陈旧的 leave A 关不掉更新的 join B", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home }), async () => {
    const rt1 = makeRuntime({ branch });
    await rt1.command(`join alpha --url ${URL_A} --token ${TOKEN}`);
    const alphaId = rt1.joins()[0].id;
    await rt1.command("leave");
    await rt1.command(`join beta --url ${URL_B} --token ${TOKEN}`);

    // 乱序/重放:一条 join B 之后才到达的 leave A
    branch.push({ type: "custom", id: "stale", parentId: null, timestamp: new Date().toISOString(), customType: MEMBERSHIP_TYPE, data: makeLeaveRecord({ joinId: alphaId, team: "alpha" }) });

    await rt1.emit("session_shutdown", { reason: "reload" });
    const rt2 = makeRuntime({ branch });
    await rt2.emit("session_start", { reason: "reload" });

    assert.equal(rt2.created.length, 1, "陈旧 leave 不应把当前成员关系关掉");
    assert.equal(rt2.created[0].config.url, URL_B);
  });
});

lifecycle("生命周期:树导航只看当前分支,来回切换会重连但不追加 join", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home, TEAM_TOKEN: TOKEN }), async () => {
    const rt = makeRuntime({ branch, flags: { team: "alpha", "team-url": URL_A } });
    await rt.emit("session_start", { reason: "startup" });
    assert.equal(rt.created.length, 1);

    // 导航到 join 之前:当前分支变空
    const saved = branch.splice(0, branch.length);
    await rt.emit("session_tree", { newLeafId: null, oldLeafId: "e0" });
    assert.equal(rt.transports[0].stopped, true, "离开 join 所在分支应断开");

    // 回到 join 所在分支
    branch.push(...saved);
    await rt.emit("session_tree", { newLeafId: "e0", oldLeafId: null });
    assert.equal(rt.created.length, 2, "回到 join 所在分支应重连");
    assert.equal(rt.joins().length, 1, "树导航的重连不能再追加 join");
    assert.equal(rt.transports[1].started.name, rt.transports[0].started.name);
  });
});

lifecycle("生命周期:会话替换不留残余连接(新会话空分支)", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home, TEAM_TOKEN: TOKEN }), async () => {
    const rt1 = makeRuntime({ branch, flags: { team: "alpha", "team-url": URL_A } });
    await rt1.emit("session_start", { reason: "startup" });
    assert.equal(rt1.transports[0].stopped, false);

    // 不显式 shutdown:直接换一个新会话,重置逻辑必须清掉旧连接
    const rt2 = makeRuntime({ branch: [] });
    await rt2.emit("session_start", { reason: "new" });

    assert.equal(rt1.transports[0].stopped, true, "上一个会话的连接必须被停掉");
    assert.equal(rt2.created.length, 0, "空分支的新会话不应连接任何 team");
    assert.equal(rt2.transports.length, 0);
  });
});

lifecycle("生命周期:损坏的持久化记录被安全忽略,不影响其后的合法记录", async (t) => {
  const home = withHome(t);
  const branch = [
    { type: "custom", id: "a", parentId: null, timestamp: "", customType: MEMBERSHIP_TYPE, data: { v: 2, kind: "join", id: "x", team: "alpha", name: "n", labels: [], listen: { host: null, port: null } } },
    { type: "custom", id: "b", parentId: null, timestamp: "", customType: MEMBERSHIP_TYPE, data: { kind: "join" } },
    { type: "custom", id: "c", parentId: null, timestamp: "", customType: MEMBERSHIP_TYPE, data: null },
  ];

  await withEnv(env({ HOME: home }), async () => {
    const rt = makeRuntime({ branch });
    await rt.emit("session_start", { reason: "resume" });
    assert.equal(rt.created.length, 0, "坏记录不应触发连接");

    // 追加一条合法 join 后,能据它还原
    writeTeam("alpha", { mode: "broker", token: TOKEN, url: URL_A }, home);
    branch.push({ type: "custom", id: "d", parentId: null, timestamp: "", customType: MEMBERSHIP_TYPE, data: makeJoinRecord({ team: "alpha", name: "n1", labels: [], listen: { host: null, port: null } }) });
    await rt.emit("session_tree", {});
    assert.equal(rt.created.length, 1);
    assert.equal(rt.created[0].config.url, URL_A);
  });
});

lifecycle("生命周期:持久化记录里绝不出现 token / topic / punch URI", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home, TEAM_TOKEN: SECRET }), async () => {
    const rt = makeRuntime({ branch, flags: { team: "alpha", "team-url": URL_A } });
    await rt.emit("session_start", { reason: "startup" });
    assert.equal(rt.joins().length, 1);

    const flat = JSON.stringify(rt.appended.map((a) => a.data));
    assert.equal(flat.includes(SECRET), false, "token 绝不能进持久化条目");
    assert.equal(flat.includes("punch://"), false, "punch URI 绝不能进持久化条目");
    assert.equal(flat.includes("topic"), false, "topic 不能进持久化条目");
    // 但恢复所需的信息必须在
    assert.equal(flat.includes("alpha"), true);
  });
});

lifecycle("生命周期:本地配置缺失时安全失败,给出既有本地化提示,且不连别的 team", async (tc) => {
  const home = withHome(tc);
  const branch = [];

  await withEnv(env({ HOME: home, TEAM_TOKEN: TOKEN }), async () => {
    const rt1 = makeRuntime({ branch, flags: { team: "alpha", "team-url": URL_A } });
    await rt1.emit("session_start", { reason: "startup" });
    await rt1.emit("session_shutdown", { reason: "reload" });

    // 配置在会话之间被人删掉了(或损坏)
    assert.equal(removeTeam("alpha", home), true);

    const rt2 = makeRuntime({ branch });
    await rt2.emit("session_start", { reason: "reload" });

    assert.equal(rt2.created.length, 0, "拿不到凭据就不连,绝不退回别的 team");
    const expect = t(M.config.teamUnknown, { team: "alpha" });
    assert.ok(
      rt2.notifications.some((n) => n.msg === expect && n.level === "warning"),
      `应给出本地化提示:${expect}\n实际:${JSON.stringify(rt2.notifications)}`,
    );
  });
});

lifecycle("生命周期:连接创建失败时不写成功记录,reload 也不会误还原", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home, TEAM_TOKEN: TOKEN }), async () => {
    const rt1 = makeRuntime({ branch, flags: { team: "alpha", "team-url": URL_A } });
    rt1.setCreateFailure("boom");
    await rt1.emit("session_start", { reason: "startup" });

    assert.equal(rt1.joins().length, 0, "失败的 join 不能写成功记录");
    assert.equal(rt1.transports.length, 0);

    await rt1.emit("session_shutdown", { reason: "reload" });
    const rt2 = makeRuntime({ branch });
    await rt2.emit("session_start", { reason: "reload" });
    assert.equal(rt2.created.length, 0);
  });
});

lifecycle("生命周期:team_join 工具也写持久化记录", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home }), async () => {
    const rt = makeRuntime({ branch });
    await rt.tool("team_join", { team: "alpha", url: URL_A, token: TOKEN });
    assert.equal(rt.joins().length, 1);
    assert.equal(rt.joins()[0].team, "alpha");
  });
});

lifecycle("生命周期:标签变更重连会更新持久化的标签", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home, TEAM_TOKEN: TOKEN }), async () => {
    const rt = makeRuntime({ branch, flags: { team: "alpha", "team-url": URL_A, "team-labels": "web" } });
    await rt.emit("session_start", { reason: "startup" });
    assert.equal(rt.joins().length, 1);

    await rt.command("label add db");
    assert.equal(rt.joins().length, 2, "标签变更也是一次新的 join 记录");
    assert.equal(rt.joins()[1].labels.includes("db"), true, "新记录要带上更新后的标签");
    assert.notEqual(rt.joins()[1].id, rt.joins()[0].id, "变更后是新的 join 身份");
  });
});

lifecycle("优先级:显式启动的是同一个 team 时沿用身份,不重复追加 join", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home, TEAM_TOKEN: TOKEN, TEAM: "alpha", TEAM_URL: URL_A }), async () => {
    const rt1 = makeRuntime({ branch });
    await rt1.emit("session_start", { reason: "startup" });
    assert.equal(rt1.joins().length, 1);
    const firstId = rt1.joins()[0].id;

    // 带着同样的 TEAM 环境变量再启动一次:显式优先,但同一 team 不该
    // 造出第二个身份(否则每次重启都会堆一条 join)。
    const rt2 = makeRuntime({ branch });
    await rt2.emit("session_start", { reason: "resume" });
    assert.equal(rt2.joins().length, 0, "同一 team 的显式重启不追加 join");
    assert.equal(rt2.created.length, 1);

    await rt2.command("leave");
    assert.equal(rt2.leaves()[0].joinId, firstId, "沿用的必须是第一次的 join 身份");
  });
});

lifecycle("优先级:显式启动的是另一个 team 时,显式优先并记下新的 join", async (t) => {
  const home = withHome(t);
  const branch = [];

  await withEnv(env({ HOME: home, TEAM_TOKEN: TOKEN, TEAM: "alpha", TEAM_URL: URL_A }), async () => {
    const rt1 = makeRuntime({ branch });
    await rt1.emit("session_start", { reason: "startup" });
    const alphaId = rt1.joins()[0].id;

    // 显式换成 beta:显式参数优先,并且这是一次新的成员关系
    process.env.TEAM = "beta";
    process.env.TEAM_URL = URL_B;
    const rt2 = makeRuntime({ branch });
    await rt2.emit("session_start", { reason: "resume" });

    assert.equal(rt2.created.length, 1);
    assert.equal(rt2.created[0].config.url, URL_B, "显式指定的 team 必须赢过持久化记录");
    assert.equal(rt2.joins().length, 1);
    assert.notEqual(rt2.joins()[0].id, alphaId, "换 team 是一次新的 join");
  });
});
