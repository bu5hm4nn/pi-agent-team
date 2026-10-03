/**
 * 模式选择与配置测试。跑:node --test src/
 *
 * 重点:三种模式对配置的要求不同,而且**缺配置时的行为必须明确**。
 * 尤其是 swim 缺边车 —— 那必须是硬失败,不能静默降级成别的模式。
 * 降级会让"SWIM 检测到故障"变成谎言:成员表说什么都不影响消息怎么走。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MODES, createTransport, modeReadiness, normalizeSeeds, resolveMode, toSocketUrl } from "./mode.js";
import { setLocale } from "./i18n.js";

// 迁移后这里断言的 reason / warning 文案来自 zh-Hans 目录;默认 locale 是 en-US,
// 把 locale 钉在 zh-Hans 而不是改写断言。
setLocale("zh-Hans");

// ---------------------------------------------------------------- 模式解析

test("resolveMode:默认 broker", () => {
  const r = resolveMode({ config: {}, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "broker", "不指定时默认 broker —— 和之前行为一致");
});

test("resolveMode:环境变量优先于配置", () => {
  const r = resolveMode({ config: { mode: "mesh" }, env: { TEAM_MODE: "swim" } });
  assert.equal(r.mode, "swim");
});

test("resolveMode:配置在没有环境变量时生效", () => {
  assert.equal(resolveMode({ config: { mode: "mesh" }, env: {} }).mode, "mesh");
});

test("resolveMode:非法模式明确报错并列出合法值", () => {
  const r = resolveMode({ config: {}, env: { TEAM_MODE: "raft" } });
  assert.equal(r.ok, false);
  for (const m of MODES) assert.match(r.reason, new RegExp(m));
});

test("MODES 正好是四种", () => {
  assert.deepEqual([...MODES].sort(), ["broker", "hyperswarm", "mesh", "swim"]);
});

// ---------------------------------------------------------------- seeds 规范化

test("normalizeSeeds:字符串、数组、空白都处理", () => {
  assert.deepEqual(normalizeSeeds("a:1,b:2"), ["a:1", "b:2"]);
  assert.deepEqual(normalizeSeeds(["a:1", " b:2 "]), ["a:1", "b:2"]);
  assert.deepEqual(normalizeSeeds(""), []);
  assert.deepEqual(normalizeSeeds(null), []);
  assert.deepEqual(normalizeSeeds(" , , "), [], "全空白应被过滤");
  assert.deepEqual(normalizeSeeds("a:1,,b:2"), ["a:1", "b:2"], "中间空项要跳过");
});

test("toSocketUrl:http(s) 转 ws(s)", () => {
  assert.equal(toSocketUrl("http://h:1"), "ws://h:1");
  assert.equal(toSocketUrl("https://h"), "wss://h");
});

// ---------------------------------------------------------------- 就绪检查

test("modeReadiness:broker 需要 url", () => {
  assert.equal(modeReadiness("broker", { token: "t" }).ready, false);
  assert.match(modeReadiness("broker", { token: "t" }).reason, /url/);
  assert.equal(modeReadiness("broker", { token: "t", url: "http://x" }).ready, true);
});

test("modeReadiness:任何模式都缺不了 token", () => {
  for (const m of MODES) {
    assert.equal(modeReadiness(m, {}).ready, false, `${m} 缺 token 应未就绪`);
  }
});

test("modeReadiness:mesh 没有 seeds 可用但会警告", () => {
  const r = modeReadiness("mesh", { token: "t" });
  assert.equal(r.ready, true, "没有种子不是致命错误 —— 节点可以等别人连它");
  assert.match(r.warning, /seeds/, "但要说清楚后果");
  assert.equal(modeReadiness("mesh", { token: "t", seeds: ["h:1"] }).warning, undefined);
});

test("modeReadiness:swim 缺边车不可用", () => {
  const r = modeReadiness("swim", { token: "t" }, "/nonexistent/sidecar");
  assert.equal(r.ready, false);
  assert.match(r.reason, /边车/);
});

test("modeReadiness:hyperswarm 需要 topic", () => {
  assert.equal(modeReadiness("hyperswarm", { token: "t" }).ready, false);
  assert.match(modeReadiness("hyperswarm", { token: "t" }).reason, /topic/);
  assert.equal(modeReadiness("hyperswarm", { token: "t", topic: Buffer.alloc(32) }).ready, true);
  // 拼错的 topic 也不能蒙混过关
  assert.equal(modeReadiness("hyperswarm", { token: "t", topic: "not-a-topic" }).ready, false);
});

// ---------------------------------------------------------------- 工厂

test("createTransport:broker 缺 url 时拒绝并给用法", () => {
  const r = createTransport({ mode: "broker", config: { token: "t" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /url/);
  assert.match(r.reason, /\/team/, "要告诉用户怎么配");
});

test("createTransport:任何模式缺 token 都拒绝", () => {
  for (const m of MODES) {
    const r = createTransport({ mode: m, config: {} });
    assert.equal(r.ok, false, `${m} 缺 token 应拒绝`);
  }
});

test("createTransport:broker 成功时给出 transport 且 mode 正确", () => {
  const r = createTransport({ mode: "broker", config: { token: "t", url: "http://127.0.0.1:1" } });
  assert.equal(r.ok, true);
  assert.equal(r.transport.mode, "broker");
  r.transport.stop();
});

test("createTransport:mesh 没 seeds 时带警告但可用", () => {
  const r = createTransport({ mode: "mesh", config: { token: "t" }, listenHost: "127.0.0.1", listenPort: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.transport.mode, "mesh");
  assert.ok(r.warning, "应提示没有种子");
  r.transport.stop();
});

test("createTransport:mesh 有 seeds 时无警告", () => {
  const r = createTransport({ mode: "mesh", config: { token: "t", seeds: ["h:1"] }, listenHost: "127.0.0.1", listenPort: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.warning, undefined);
  r.transport.stop();
});

test("createTransport:swim 缺边车是硬失败,不降级成别的模式", () => {
  const r = createTransport({
    mode: "swim",
    config: { token: "t" },
    sidecarPath: "/definitely/not/here",
  });
  assert.equal(r.ok, false, "缺边车必须失败,不能悄悄用 broker 或 mesh 顶上");
  assert.equal(r.transport, undefined);
  assert.match(r.reason, /go build/, "要告诉用户怎么构建");
});

test("createTransport:hyperswarm 缺 topic 时拒绝并说明用法", () => {
  const r = createTransport({ mode: "hyperswarm", config: { token: "t" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /topic/);
});

test("createTransport:hyperswarm 的 topic 拼错时也拒绝", () => {
  const r = createTransport({ mode: "hyperswarm", config: { token: "t", topic: "not-base64url" } });
  assert.equal(r.ok, false, "只判 truthy 会让拼错的 topic 到 start() 才失败");
  assert.match(r.reason, /topic/);
});

test("createTransport:hyperswarm 有 topic 时给出 transport 且 mode 正确", () => {
  const r = createTransport({ mode: "hyperswarm", config: { token: "t", topic: Buffer.alloc(32, 7) } });
  assert.equal(r.ok, true);
  assert.equal(r.transport.mode, "hyperswarm");
  r.transport.stop();
});

test("createTransport:hyperswarm 缺可选原生依赖时硬失败,不拖累其它模式", () => {
  // 模拟 hyperswarm 没装 / 原生 addon 构建失败。swim 缺边车是硬失败,
  // hyperswarm 缺依赖同样:不能降级成别的模式,也不能影响 broker/mesh/swim。
  const r = createTransport({
    mode: "hyperswarm",
    config: { token: "t", topic: Buffer.alloc(32, 3) },
    hyperswarmLoader: () => {
      throw new Error("native addon missing");
    },
  });
  assert.equal(r.ok, false, "缺可选依赖必须失败");
  assert.equal(r.transport, undefined);
  assert.match(r.reason, /hyperswarm/, "要提到缺的是哪个依赖");
  assert.match(r.reason, /broker\/mesh\/swim/, "要说明其它模式不受影响");
});

test("createTransport:未知模式被拒", () => {
  const r = createTransport({ mode: "raft", config: { token: "t" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /未知模式/);
});
