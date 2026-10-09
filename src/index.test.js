/**
 * index.ts 接线测试 —— 真的调用注册好的工具 execute 与命令补全。
 *
 * ── 为什么要用 registerHooks ──
 *   决策逻辑都在 dispatch / session(已有纯逻辑单测)。这里守的是
 *   **接线**:team_send / team_ask 是否真的把子命令选对、公开 schema
 *   是否还有 requireResponse、命令补全是否暴露 ask 且不再有旧开关、
 *   菜单路径是否也能发 ask。
 *
 *   为了不碰真实网络,在 dynamic import index.ts **之前**把
 *   ./src/transport.js 换成假的:createBrokerTransport 返回一个同步报
 *   online 的 stub。必须早于 import —— 模块一旦被缓存,再改就晚了。
 *   typebox 也换成会记录字段的 stub,这样才能断言公开 schema 的形状
 *   (仓库里的 typebox 是空 stub,Type.Object 返回 {})。
 *
 *   node:test 默认每个测试文件一个进程,所以这里的 hook 不会污染别的
 *   测试文件。registerHooks 与默认 TS 剥离只在新 Node 上可用,旧的
 *   运行时整组跳过(报 skipped,不是静默通过)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";

import { t } from "./i18n.js";
import { M } from "./messages.js";

const registerHooks = nodeModule.registerHooks;
// process.features.typescript 是 "strip" 说明 index.ts 能直接被 import。
const RUNNABLE = typeof registerHooks === "function" && process.features?.typescript === "strip";
const SKIP = RUNNABLE ? false : "需要 node:module.registerHooks 与默认 TS 类型剥离(较新的 Node)";

const TRANSPORT_SUFFIX = "/src/transport.js";
const TYPEBOX_SUFFIX = "/typebox/index.js";

/** fake transport 把每次投递记在这里,测试直接读。 */
globalThis.__piTeamHarness = { sent: [] };
const harness = globalThis.__piTeamHarness;

const FAKE_TYPEBOX = `
export const Type = {
  Object: (properties) => ({ kind: "object", properties }),
  String: (o) => ({ kind: "string", ...(o ?? {}) }),
  Number: (o) => ({ kind: "number", ...(o ?? {}) }),
  Boolean: (o) => ({ kind: "boolean", ...(o ?? {}) }),
  Optional: (inner) => ({ ...inner, optional: true }),
  Union: (anyOf, o) => ({ kind: "union", anyOf, ...(o ?? {}) }),
  Literal: (value) => ({ kind: "literal", value }),
  Array: (items, o) => ({ kind: "array", items, ...(o ?? {}) }),
};
`;

function fakeTransport(realUrl) {
  return `
export * from ${JSON.stringify(realUrl)};
export function createBrokerTransport() {
  const handlers = new Map();
  const tr = {
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev).add(fn);
      return () => handlers.get(ev).delete(fn);
    },
    emit(ev, ...a) { for (const h of handlers.get(ev) ?? []) h(...a); },
    start(self) {
      globalThis.__piTeamHarness.transport = tr;
      tr.emit("state", "online");
      tr.emit("membership", [
        { name: self.name, host: null, addr: null, labels: [], since: 0 },
        { name: "peer", host: "dev01", addr: null, labels: ["web"], since: 0 },
      ]);
    },
    stop() {},
    send(env) { globalThis.__piTeamHarness.sent.push(env); return true; },
    state() { return "online"; },
    members() { return []; },
    port() { return 19801; },
    gossipPort() { return null; },
  };
  return tr;
}
`;
}

if (RUNNABLE) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const r = nextResolve(specifier, context);
      if (!r?.url) return r;
      if (r.url.endsWith(TYPEBOX_SUFFIX) && !r.url.includes("fake-typebox")) {
        return { url: `${r.url}?fake-typebox`, shortCircuit: true };
      }
      if (r.url.endsWith(TRANSPORT_SUFFIX) && !(context.parentURL ?? "").includes("fake-transport")) {
        return { url: `${r.url}?fake-transport`, shortCircuit: true };
      }
      return r;
    },
    load(url, context, nextLoad) {
      if (url.includes("fake-typebox")) {
        return { format: "module", shortCircuit: true, source: FAKE_TYPEBOX };
      }
      if (url.includes("fake-transport")) {
        return { format: "module", shortCircuit: true, source: fakeTransport(url.split("?")[0]) };
      }
      return nextLoad(url, context);
    },
  });
}

/** 记录型 fake Pi API —— 只实现 index.ts 真正调用到的部分。 */
function fakePi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    getFlag: (name) => (name === "team-url" ? process.env.TEAM_URL : undefined),
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    },
    registerEntryRenderer() {},
    registerFlag() {},
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    sendMessage() {},
    appendEntry() {},
  };
  return { pi, tools, commands, handlers };
}

function fakeCtx(over = {}) {
  const notes = [];
  const ctx = {
    notes,
    ui: {
      notify: (message) => notes.push(message),
      setStatus() {},
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => true,
      ...over,
    },
    isIdle: () => true,
  };
  return ctx;
}

let built = null;

/** 加载 index.ts(只一次),注册工具并跑一次 session_start 连上假 transport。 */
function build() {
  if (!built) {
    built = (async () => {
      const saved = {
        TEAM: process.env.TEAM,
        TEAM_NAME: process.env.TEAM_NAME,
        TEAM_LABELS: process.env.TEAM_LABELS,
        TEAM_MODE: process.env.TEAM_MODE,
        TEAM_SEEDS: process.env.TEAM_SEEDS,
        TEAM_LANG: process.env.TEAM_LANG,
        TEAM_URL: process.env.TEAM_URL,
        TEAM_TOKEN: process.env.TEAM_TOKEN,
      };

      // import 时就会读这些:team 走环境变量直连路径,语言钉在 en-US
      // 让断言不随宿主 locale 变。
      delete process.env.TEAM;
      delete process.env.TEAM_NAME;
      delete process.env.TEAM_LABELS;
      delete process.env.TEAM_MODE;
      delete process.env.TEAM_SEEDS;
      process.env.TEAM_LANG = "en-US";
      process.env.TEAM_URL = "http://stub:8787";
      process.env.TEAM_TOKEN = "a".repeat(64);

      try {
        const mod = await import("../index.ts");
        const { pi, tools, commands, handlers } = fakePi();
        mod.default(pi);

        const ctx = fakeCtx();
        for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
        return { tools, commands, handlers, ctx };
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    })();
  }
  return built;
}

if (RUNNABLE) {
  test.after(() => {
    delete globalThis.__piTeamHarness;
  });
}

test("tool:team_send 与 team_ask 都注册,公开 schema 只有 to / text(没有 requireResponse)", { skip: SKIP }, async () => {
  const { tools } = await build();
  assert.ok(tools.has("team_send"), "team_send 应注册");
  assert.ok(tools.has("team_ask"), "team_ask 应注册");

  for (const name of ["team_send", "team_ask"]) {
    const keys = Object.keys(tools.get(name).parameters.properties);
    assert.deepEqual(keys.sort(), ["text", "to"], `${name} 的公开参数只能是 to / text`);
    assert.equal(
      "requireResponse" in tools.get(name).parameters.properties,
      false,
      `${name} 不该再把 requireResponse 暴露成公开参数`,
    );
  }
});

test("tool:team_send 走后 send,wire 不含 requireResponse;team_ask 走后 ask,wire 为 true", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  harness.sent.length = 0;

  const sendRes = await tools.get("team_send").execute("c1", { to: "peer", text: "通知" }, undefined, undefined, ctx);
  const askRes = await tools.get("team_ask").execute("c2", { to: "peer", text: "请回复" }, undefined, undefined, ctx);

  assert.equal(sendRes.details.delivered, true, "team_send 立即返回投递成功");
  assert.equal(askRes.details.delivered, true, "team_ask 也立即返回投递成功");
  assert.equal(harness.sent.length, 2, "两次执行各投递一次");

  assert.equal("requireResponse" in harness.sent[0].body, false, "send 的信封不写 requireResponse(接收方按缺省 false 处理)");
  assert.equal(harness.sent[1].body.requireResponse, true, "ask 的信封必须带 requireResponse: true");
  assert.equal(harness.sent[1].body.text, "请回复");
});

test("tool:team_ask 返回的是投递回执,不会同步等答案", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  harness.sent.length = 0;

  const r = await tools.get("team_ask").execute("c3", { to: "peer", text: "需要答案" }, undefined, undefined, ctx);
  const text = r.content.map((c) => c.text).join("");

  assert.equal(r.details.delivered, true, "回执表示已写入对方 socket");
  assert.match(text, /asked the recipient to reply/, "回执要说明已要求对方回信");
  assert.match(text, /receipt only means the peer's socket received it/, "回执要明确不等于对方已处理");
});

test("command:补全暴露 ask,send 不再补全 --require-response", { skip: SKIP }, async () => {
  const { commands } = await build();
  const cmd = commands.get("team");
  assert.ok(cmd, "/team 命令应注册");

  const subs = cmd.getArgumentCompletions("");
  assert.ok(subs.some((s) => s.value === "ask"), `子命令补全要含 ask:${subs.map((s) => s.value)}`);

  assert.deepEqual(cmd.getArgumentCompletions("send --req"), [], "send 不该再补全 --require-response");
  assert.deepEqual(cmd.getArgumentCompletions("send --require-response"), [], "旧开关彻底移除");

  const askTargets = cmd.getArgumentCompletions("ask @");
  assert.ok(askTargets.some((s) => s.value === "@default"), `ask 的收件人补全与 send 一致:${askTargets.map((s) => s.value)}`);
});

test("menu:发消息的向导也能选 ask,并真的走 ask", { skip: SKIP }, async () => {
  const { commands } = await build();
  harness.sent.length = 0;

  // 脚本化菜单:选「发给单个节点」→ 选 peer → 输入正文 → 选「要求回信」。
  const ctx = fakeCtx({
    select: async (title, options) => {
      if (title === "Pi Agent Team") return t(M.ui.menuSendToNode);
      if (title === t(M.ui.selectSendWho)) return "peer";
      if (title === t(M.ui.selectMessageKind)) return options[1]; // 第二项是 ask
      return undefined;
    },
    input: async () => "菜单发的询问",
  });

  await commands.get("team").handler("", ctx);

  assert.equal(harness.sent.length, 1, "菜单应投递一次");
  assert.equal(harness.sent[0].body.requireResponse, true, "菜单里选了 ask,信封就要带 requireResponse");
  assert.equal(harness.sent[0].body.text, "菜单发的询问");
});

test("tool:对端有待回复时 team_ask 仍发新请求,不消费它 —— 之后 team_send 仍能回复原请求", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  const tr = harness.transport;
  assert.ok(tr && typeof tr.emit === "function", "前置:假 transport 已挂上,能注入入站消息");

  harness.sent.length = 0;
  // 对端发来一条要求回信的消息 → 本机建立对 peer 的待回复。
  tr.emit("envelope", { from: "peer", id: "peer-req-ask", re: null, body: { text: "请回复", hops: 0, requireResponse: true } });

  const askRes = await tools.get("team_ask").execute("k1", { to: "peer", text: "我的新请求" }, undefined, undefined, ctx);
  assert.equal(askRes.details.delivered, true);
  assert.equal(harness.sent[0].body.requireResponse, true, "team_ask 要求回信");
  assert.equal(harness.sent[0].re, null, "team_ask 是新请求,不能带上对方请求的 id");
  assert.equal(harness.sent[0].body.hops, 0, "team_ask 跳数从 0 开始");

  // 待回复没有被 ask 消费,所以随后的 team_send 仍能关联到它。
  const sendRes = await tools.get("team_send").execute("k2", { to: "peer", text: "回复原请求" }, undefined, undefined, ctx);
  assert.equal(sendRes.details.delivered, true);
  assert.equal("requireResponse" in harness.sent[1].body, false, "回复(send)不要求回信");
  assert.equal(harness.sent[1].re, "peer-req-ask", "原待回复未被 ask 消费,team_send 仍能关联");
});
