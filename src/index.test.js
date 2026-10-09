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
globalThis.__piTeamHarness = { sent: [], attempts: [], messages: [], sendResult: true, sendThrows: false };
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
    send(env) {
      const h = globalThis.__piTeamHarness;
      h.attempts.push(env);
      if (h.sendThrows) throw new Error("socket write failed");
      if (h.sendResult === false) return false;
      h.sent.push(env);
      return true;
    },
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
    sendMessage(msg) {
      globalThis.__piTeamHarness.messages.push(msg);
    },
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

  assert.equal(r.details.delivered, true, "回执表示本地传输已接受");
  assert.match(text, /asked the recipient to reply/, "回执要说明已要求对方回信");
  assert.match(text, /receipt only means the local transport accepted it/, "回执要明确不等于对方已处理");
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

test("tool:team_reply 注册,公开 schema 要求 requestId + text(没有 to)", { skip: SKIP }, async () => {
  const { tools } = await build();
  assert.ok(tools.has("team_reply"), "team_reply 应注册");
  const keys = Object.keys(tools.get("team_reply").parameters.properties);
  assert.deepEqual(keys.sort(), ["requestId", "text"], "team_reply 只要 requestId / text");
  assert.equal("to" in tools.get("team_reply").parameters.properties, false, "不能靠 to 猜回复对象");
});

test("tool:team_reply 缺 requestId / 未知 id 时失败,不发信封", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  harness.sent.length = 0;

  const missing = await tools.get("team_reply").execute("r0", { requestId: "", text: "x" }, undefined, undefined, ctx);
  assert.equal(missing.details.delivered, false);

  const unknown = await tools.get("team_reply").execute("r1", { requestId: "nope", text: "x" }, undefined, undefined, ctx);
  assert.equal(unknown.details.delivered, false);
  assert.match(unknown.content.map((c) => c.text).join(""), /nope/);
  assert.equal(harness.sent.length, 0, "失败不能发出任何信封");
});

test("tool:收到 team_ask → 注入文本带 request id 与 team_reply 指令", { skip: SKIP }, async () => {
  const { ctx } = await build();
  const tr = harness.transport;
  harness.messages.length = 0;

  tr.emit("envelope", { from: "peer", id: "req-in-1", re: null, body: { text: "请回复", hops: 0, requireResponse: true } });
  const payload = String(harness.messages.at(-1)?.content ?? "");
  assert.match(payload, /req-in-1/, "注入文本必须给出 request id");
  assert.match(payload, /team_reply\(\{ requestId: "req-in-1"/, "并给出精确的回复指令");
  assert.doesNotMatch(payload, /team_send\(\{ to:/, "不再保留旧的 team_send 回复脚手架");

  // 清理:直接把它回掉,不影响后续测试
  const { tools } = await build();
  await tools.get("team_reply").execute("cleanup", { requestId: "req-in-1", text: "done" }, undefined, undefined, ctx);
});

test("menu:有待回复的请求时菜单出现 team_reply 入口", { skip: SKIP }, async () => {
  const { commands, ctx } = await build();
  const tr = harness.transport;
  harness.sent.length = 0;

  tr.emit("envelope", { from: "peer", id: "req-menu", re: null, body: { text: "请回复", hops: 0, requireResponse: true } });

  let sawMenu = false;
  const menuCtx = fakeCtx({
    select: async (title, options) => {
      if (title === "Pi Agent Team") {
        sawMenu = true;
        const reply = options.find((o) => /pending request/i.test(o));
        assert.ok(reply, `菜单应包含待回复入口:${options.join(" | ")}`);
        return reply;
      }
      if (title === t(M.ui.selectReplyPending)) return options.find((o) => o.startsWith("req-menu"));
      return undefined;
    },
    input: async () => "菜单回的",
  });
  await commands.get("team").handler("", menuCtx);
  assert.ok(sawMenu, "应打开菜单");
  assert.equal(harness.sent.length, 1, "菜单回复应投递一次");
  assert.equal(harness.sent[0].re, "req-menu", "回复要带原 request id");
});

test("command:/team reply 补全待回复的 request id;/team replies 补全策略", { skip: SKIP }, async () => {
  const { commands, ctx } = await build();
  const tr = harness.transport;
  tr.emit("envelope", { from: "peer", id: "req-ac", re: null, body: { text: "请回复", hops: 0, requireResponse: true } });

  const cmd = commands.get("team");
  const ids = cmd.getArgumentCompletions("reply req");
  assert.ok(ids.some((i) => i.value === "req-ac"), `reply 要补全 request id:${ids.map((i) => i.value)}`);

  const modes = cmd.getArgumentCompletions("replies m");
  assert.ok(modes.some((i) => i.value === "mirror"), `replies 要补全模式:${modes.map((i) => i.value)}`);

  // 清理
  await build().then(({ tools }) => tools.get("team_reply").execute("c", { requestId: "req-ac", text: "x" }, undefined, undefined, ctx));
});

test("tool:对待回复的队友 send/ask 被阻断,无关节点可用,team_reply 可以回答", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  const tr = harness.transport;
  assert.ok(tr && typeof tr.emit === "function", "前置:假 transport 已挂上");

  // 加一个无关节点 other
  tr.emit("membership", [
    { name: "me", host: null, addr: null, labels: [], since: 0 },
    { name: "peer", host: "dev01", addr: null, labels: ["web"], since: 0 },
    { name: "other", host: "dev02", addr: null, labels: [], since: 0 },
  ]);

  harness.sent.length = 0;
  // 对端发来一条要求回信的消息 → 本机建立对 peer 的待回复。
  tr.emit("envelope", { from: "peer", id: "peer-req-ask", re: null, body: { text: "请回复", hops: 0, requireResponse: true } });

  const sendRes = await tools.get("team_send").execute("k1", { to: "peer", text: "新消息" }, undefined, undefined, ctx);
  assert.equal(sendRes.details.delivered, false, "有待回复时 send 被阻断");
  assert.match(sendRes.content.map((c) => c.text).join(""), /peer-req-ask/);

  const askRes = await tools.get("team_ask").execute("k2", { to: "peer", text: "新问题" }, undefined, undefined, ctx);
  assert.equal(askRes.details.delivered, false, "有待回复时 ask 也被阻断");

  const otherRes = await tools.get("team_send").execute("k3", { to: "other", text: "给别人的" }, undefined, undefined, ctx);
  assert.equal(otherRes.details.delivered, true, "无关节点不受影响");
  assert.equal(harness.sent.length, 1, "只有发给 other 的那条发出去了");
  assert.equal(harness.sent[0].to, "other");

  // 显式回复唯一能解除阻断。
  const replyRes = await tools.get("team_reply").execute("k4", { requestId: "peer-req-ask", text: "回复原请求" }, undefined, undefined, ctx);
  assert.equal(replyRes.details.delivered, true);
  assert.equal(harness.sent[1].to, "peer");
  assert.equal(harness.sent[1].re, "peer-req-ask");
  assert.equal("requireResponse" in harness.sent[1].body, false, "回复不再要求对方回信");

  // 回复后 peer 解除了阻断,能再发新消息。
  const afterRes = await tools.get("team_send").execute("k5", { to: "peer", text: "现在可以了" }, undefined, undefined, ctx);
  assert.equal(afterRes.details.delivered, true);
  assert.equal(harness.sent[2].re, null);
});

// ---------------------------------------------------------------- 真实写入失败:义务保留

/**
 * 评审修复点:待回复只能在 transport.send **确认成功** 后消费。
 * transport.send 返回 false 或抛异常时,delivered 必须是 false,义务原样
 * 保留(仍阻断对同一队友的 send/ask),重试成功才清且只清匹配的那一条。
 */
test("tool:team_reply 写失败(返回 false)→ delivered false、义务保留、仍阻断、重试成功才清", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  const tr = harness.transport;
  harness.sendResult = true;
  harness.sendThrows = false;
  harness.sent.length = 0;
  harness.attempts.length = 0;

  tr.emit("envelope", { from: "peer", id: "req-write-false", re: null, body: { text: "请回复", hops: 0, requireResponse: true } });

  harness.sendResult = false;
  const fail = await tools.get("team_reply").execute("w1", { requestId: "req-write-false", text: "回你" }, undefined, undefined, ctx);
  assert.equal(fail.details.delivered, false, "写失败不能报 delivered:true");
  assert.match(fail.content.map((c) => c.text).join(""), /not sent|没发出去/, "要给出本地化的失败信息");
  assert.equal(harness.sent.length, 0, "没有成功写入");
  assert.equal(harness.attempts.length, 1, "尝试写了一次");
  assert.equal(harness.attempts[0].re, "req-write-false");

  // 义务保留 → 对 peer 的 send 仍被阻断
  const blocked = await tools.get("team_send").execute("w2", { to: "peer", text: "新消息" }, undefined, undefined, ctx);
  assert.equal(blocked.details.delivered, false, "写失败后义务保留,仍阻断");
  assert.match(blocked.content.map((c) => c.text).join(""), /req-write-false/);

  // 重试成功 → delivered true,且精确清掉该义务
  harness.sendResult = true;
  const retry = await tools.get("team_reply").execute("w3", { requestId: "req-write-false", text: "再回你" }, undefined, undefined, ctx);
  assert.equal(retry.details.delivered, true, retry.content.map((c) => c.text).join(""));
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].re, "req-write-false");

  const after = await tools.get("team_send").execute("w4", { to: "peer", text: "现在可以" }, undefined, undefined, ctx);
  assert.equal(after.details.delivered, true, "清掉后不再阻断");
});

test("tool:team_reply 写抛异常 → 安全失败、本地化错误、义务保留", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  const tr = harness.transport;
  harness.sendResult = true;
  harness.sendThrows = false;
  harness.sent.length = 0;
  harness.attempts.length = 0;

  tr.emit("envelope", { from: "peer", id: "req-write-throw", re: null, body: { text: "请回复", hops: 0, requireResponse: true } });

  harness.sendThrows = true;
  const fail = await tools.get("team_reply").execute("t1", { requestId: "req-write-throw", text: "回你" }, undefined, undefined, ctx);
  assert.equal(fail.details.delivered, false, "抛异常也要当成失败");
  assert.match(fail.content.map((c) => c.text).join(""), /sending failed|发送失败/, "异常也要本地化成可读错误");
  harness.sendThrows = false;

  const blocked = await tools.get("team_send").execute("t2", { to: "peer", text: "新消息" }, undefined, undefined, ctx);
  assert.equal(blocked.details.delivered, false);
  assert.match(blocked.content.map((c) => c.text).join(""), /req-write-throw/, "义务必须保留");

  const retry = await tools.get("team_reply").execute("t3", { requestId: "req-write-throw", text: "再回你" }, undefined, undefined, ctx);
  assert.equal(retry.details.delivered, true, "重试应能清掉义务");
});

test("tool:可选回复(未要求回信)写失败也保留关联,成功才消费", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  const tr = harness.transport;
  harness.sendResult = true;
  harness.sendThrows = false;
  harness.sent.length = 0;

  tr.emit("envelope", { from: "peer", id: "note-write-opt", re: null, body: { text: "通知", hops: 0 } });

  harness.sendResult = false;
  const fail = await tools.get("team_reply").execute("o1", { requestId: "note-write-opt", text: "收到" }, undefined, undefined, ctx);
  assert.equal(fail.details.delivered, false, "写的失败也要报失败");

  harness.sendResult = true;
  const retry = await tools.get("team_reply").execute("o2", { requestId: "note-write-opt", text: "收到" }, undefined, undefined, ctx);
  assert.equal(retry.details.delivered, true, "失败后关联保留,重试应能成功");

  const again = await tools.get("team_reply").execute("o3", { requestId: "note-write-opt", text: "再回" }, undefined, undefined, ctx);
  assert.equal(again.details.delivered, false, "成功后关联一次性消费,再回是未知 id");
});

test("tool:群发确认后写失败 → delivered false(错误传播一致)", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  const tr = harness.transport;
  harness.sendResult = true;
  harness.sendThrows = false;

  // 动态 import:静态 import 会在 registerHooks 之前加载 transport.js,
  // 让 hook 失效(实测会把假 transport 换成真的)。阈值是 5。
  const { BULK_WARN_THRESHOLD } = await import("./dispatch.js");
  const bulk = Array.from({ length: BULK_WARN_THRESHOLD + 1 }, (_, i) => ({ name: `bp${i}`, host: null, addr: null, labels: [], since: 0 }));
  tr.emit("membership", [{ name: "me", host: null, addr: null, labels: [], since: 0 }, ...bulk]);
  harness.sent.length = 0;
  harness.attempts.length = 0;

  harness.sendResult = false;
  const res = await tools.get("team_send").execute("b1", { to: "@default", text: "群发" }, undefined, undefined, ctx);
  assert.equal(res.details.delivered, false, "确认群发写失败也要报失败,不能静默成功");
  assert.equal(harness.attempts.length, 1, "只尝试了一次(整组一条意图)");
  assert.equal(harness.sent.length, 0);
  harness.sendResult = true;

  // 恢复 roster,避免影响后续测试
  tr.emit("membership", [
    { name: "me", host: null, addr: null, labels: [], since: 0 },
    { name: "peer", host: "dev01", addr: null, labels: ["web"], since: 0 },
    { name: "other", host: "dev02", addr: null, labels: [], since: 0 },
  ]);
});

test("menu:request id 前缀不互相误配(精确匹配)", { skip: SKIP }, async () => {
  const { commands, ctx } = await build();
  const tr = harness.transport;
  harness.sendResult = true;
  harness.sendThrows = false;
  harness.sent.length = 0;

  // 两条 id 互为前缀:短的必须不能抢长的
  tr.emit("envelope", { from: "peer", id: "m-prefix-1", re: null, body: { text: "a", hops: 0, requireResponse: true } });
  tr.emit("envelope", { from: "peer", id: "m-prefix-10", re: null, body: { text: "b", hops: 0, requireResponse: true } });

  const menuCtx = fakeCtx({
    select: async (title, options) => {
      if (title === "Pi Agent Team") return options.find((o) => /pending request/i.test(o));
      if (title === t(M.ui.selectReplyPending)) return "m-prefix-10  —  peer";
      return undefined;
    },
    input: async () => "回第二条",
  });
  await commands.get("team").handler("", menuCtx);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].re, "m-prefix-10", "更长的 id 不能被更短的前缀误配");

  // 清理剩下那条
  const { tools } = await build();
  await tools.get("team_reply").execute("mp-clean", { requestId: "m-prefix-1", text: "x" }, undefined, undefined, ctx);
});

function repairRoster(names) {
  harness.transport.emit("membership", names.map(name => ({ name, host: null, addr: null, labels: [], since: 0 })));
}
function repairAsk(from, id) {
  harness.transport.emit("envelope", { from, id, re: null, body: { text: "answer", hops: 0, requireResponse: true } });
}

test("repair: bulk confirmation freezes approved recipients and rechecks their obligations", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  const names = Array.from({ length: 6 }, (_, i) => `freeze${i}`);
  repairRoster(names);
  harness.sent.length = 0;
  const confirmCtx = fakeCtx({ confirm: async () => {
    repairRoster([...names, "new-peer"]);
    repairAsk("new-peer", "freeze-new");
    return true;
  } });
  const result = await tools.get("team_send").execute("freeze", { to: "*", text: "hello" }, undefined, undefined, confirmCtx);
  assert.equal(result.details.delivered, true);
  assert.deepEqual(harness.sent[0].to, names);
  await tools.get("team_reply").execute("clean", { requestId: "freeze-new", text: "done" }, undefined, undefined, ctx);
  harness.sent.length = 0;
  const blockedCtx = fakeCtx({ confirm: async () => { repairAsk(names[0], "freeze-old"); return true; } });
  const blocked = await tools.get("team_ask").execute("blocked", { to: "*", text: "hello" }, undefined, undefined, blockedCtx);
  assert.equal(blocked.details.delivered, false);
  assert.equal(harness.sent.length, 0);
  await tools.get("team_reply").execute("clean", { requestId: "freeze-old", text: "done" }, undefined, undefined, ctx);
});

test("repair: parallel registered replies consume an ID exactly once", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  repairRoster(["race-peer"]);
  repairAsk("race-peer", "race-id");
  harness.attempts.length = 0;
  const results = await Promise.all([1, 2].map(n => tools.get("team_reply").execute(`race${n}`, { requestId: "race-id", text: "done" }, undefined, undefined, ctx)));
  assert.deepEqual(results.map(r => r.details.delivered), [true, false]);
  assert.equal(harness.attempts.length, 1);
});

test("repair: overflow keeps every obligation blocked and individually replyable", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  repairRoster(["overflowA", "overflowB"]);
  repairAsk("overflowA", "overflowA-id");
  for (let i = 0; i < 33; i++) repairAsk("overflowB", `overflowB-${i}`);
  for (const tool of ["team_send", "team_ask"]) {
    const result = await tools.get(tool).execute("blocked", { to: "overflowA", text: "new" }, undefined, undefined, ctx);
    assert.equal(result.details.delivered, false);
  }
  for (const id of ["overflowA-id", ...Array.from({ length: 33 }, (_, i) => `overflowB-${i}`)]) {
    const result = await tools.get("team_reply").execute("reply", { requestId: id, text: "done" }, undefined, undefined, ctx);
    assert.equal(result.details.delivered, true, id);
  }
});

test("repair: exact IDs do not alias and injected instructions safely encode IDs", { skip: SKIP }, async () => {
  const { tools, ctx } = await build();
  repairRoster(["exactA", "exactB"]);
  repairAsk("exactA", "exact-r");
  repairAsk("exactB", " exact-r");
  harness.sent.length = 0;
  const result = await tools.get("team_reply").execute("exact", { requestId: " exact-r", text: "B" }, undefined, undefined, ctx);
  assert.equal(result.details.delivered, true);
  assert.equal(harness.sent[0].to, "exactB");
  assert.equal(harness.sent[0].re, " exact-r");
  const stale = await tools.get("team_reply").execute("stale", { requestId: " exact-r", text: "again" }, undefined, undefined, ctx);
  assert.equal(stale.details.delivered, false);
  const blocked = await tools.get("team_send").execute("blocked", { to: "exactA", text: "new" }, undefined, undefined, ctx);
  assert.equal(blocked.details.delivered, false);
  await tools.get("team_reply").execute("clean", { requestId: "exact-r", text: "A" }, undefined, undefined, ctx);
  const unusual = 'quote"\\\n-id';
  repairAsk("exactB", unusual);
  assert.ok(harness.messages.at(-1).content.includes(`requestId: ${JSON.stringify(unusual)}`));
  repairAsk("exactB", "123");
  for (const requestId of [null, undefined, 123, {}, ""]) {
    const invalid = await tools.get("team_reply").execute("invalid", { requestId, text: "no" }, undefined, undefined, ctx);
    assert.equal(invalid.details.delivered, false);
  }
  const numericId = await tools.get("team_reply").execute("clean", { requestId: "123", text: "done" }, undefined, undefined, ctx);
  assert.equal(numericId.details.delivered, true);
  await tools.get("team_reply").execute("clean", { requestId: unusual, text: "done" }, undefined, undefined, ctx);
});
