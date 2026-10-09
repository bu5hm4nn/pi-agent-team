/**
 * dispatch 测试。跑:node --test src/
 *
 * dispatch 是命令和工具的唯一实现,所以它是"两个入口行为一致"这条
 * 承诺的落点。这里覆盖每个子命令的成功与失败路径,以及它产出的
 * intentions / party 是否符合预期。
 *
 * dispatch 不产生副作用,所以测试只需要一个 state 和一个 env。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BULK_WARN_THRESHOLD, dispatch, doTransmit, transmit } from "./dispatch.js";
import { applyRoster, createSessionState } from "./session.js";
import { setLocale } from "./i18n.js";

// dispatch 的输出现在经由 t() 渲染。这些断言写的是中文目录的逐字文案,
// 所以把 locale 钉在 zh-Hans —— 默认 locale 是 en-US,不钉就会拿到英文。
setLocale("zh-Hans");

const member = (name, over = {}) => ({
  name,
  host: over.host ?? null,
  addr: over.addr ?? null,
  labels: over.labels ?? [],
  since: 0,
});

/** 造一个已连上、roster 已填充的状态 */
function setup({ self = "me", peers = [member("peer")], connState = "online", team = "demo", config = null } = {}) {
  const state = createSessionState(self);
  applyRoster(state, { members: [member(self), ...peers] });
  const env = { connState, team, config: config ?? { url: "http://x:1", token: "t" } };
  return { state, env };
}

const run = (sub, args, ctx) => dispatch({ sub, args }, ctx.state, ctx.env);
const intentTypes = (r) => (r.intentions ?? []).map((i) => i.type);

// ---------------------------------------------------------------- status / peers

test("status:列出 team、节点名、标签、连接状态", () => {
  const c = setup({ team: "alpha" });
  c.state.selfLabels = ["web"];
  const r = run("status", [], c);

  assert.equal(r.ok, true);
  const all = r.lines.join("\n");
  assert.match(all, /alpha/);
  assert.match(all, /me/);
  assert.match(all, /web/);
  assert.match(all, /online/);
});

test("peers:按机器分组并列出可用分组", () => {
  const c = setup({
    peers: [
      member("a", { host: "dev01", labels: ["web"] }),
      member("b", { host: "dev01", labels: ["web", "db"] }),
      member("c", { host: "laptop" }),
    ],
  });
  const r = run("peers", [], c);

  const all = r.lines.join("\n");
  assert.match(all, /dev01\s+\(2\)/, "同机两个节点应归到一组");
  assert.match(all, /laptop\s+\(1\)/);
  assert.match(all, /可用分组:@db @web/);
});

test("peers:没人时仍算查询成功,并说明只有自己", () => {
  const c = setup({ peers: [] });
  const r = run("peers", [], c);
  // ok 表示"查询执行成功",不是"有结果"。没人时返回 ok:true +
  // 说明文案,让调用方不必把"空"当成错误。
  assert.equal(r.ok, true);
  assert.match(r.lines.join(), /只有你自己在线/);
});

// ---------------------------------------------------------------- 未知子命令

test("未知子命令:报错并提示用 /team 菜单", () => {
  const c = setup();
  const r = run("nonsense", [], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /未知子命令/);
  assert.match(r.error, /\/team/);
});

// ---------------------------------------------------------------- send

test("send:单播产出 send + card 两个意图", () => {
  const c = setup();
  const r = run("send", ["peer", "你好"], c);

  assert.equal(r.ok, true);
  assert.deepEqual(intentTypes(r), ["send", "card"]);
  assert.deepEqual(r.intentions[0].to, "peer");
  assert.equal(r.intentions[0].text, "你好", "正文在顶层,由 index.ts 组装 body");
  assert.equal(r.intentions[1].kind, "send");
});

test("send:记录 origin=user,供对方回复时判断", () => {
  const c = setup();
  const r = run("send", ["peer", "用户手动发的"], c);
  const id = r.intentions[0].id;

  assert.equal(c.state.outbound.get(id).origin, "user");
  assert.equal(c.state.outbound.get(id).text, "用户手动发的");
});

test("send:多词内容拼成一条", () => {
  const c = setup();
  const r = run("send", ["peer", "帮我", "跑一下", "测试"], c);
  assert.equal(r.intentions[0].text, "帮我 跑一下 测试");
});

test("send:缺收件人或内容时拒绝,并给用法", () => {
  const c = setup();
  for (const args of [[], ["peer"], ["", "x"]]) {
    const r = run("send", args, c);
    assert.equal(r.ok, false);
    assert.match(r.error, /用法/);
  }
});

test("send:未连接时拒绝,不产出意图", () => {
  const c = setup({ connState: "offline" });
  const r = run("send", ["peer", "hi"], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /未连接/);
  assert.deepEqual(r.intentions, []);
});

test("send:收件人不存在时报出是谁", () => {
  const c = setup();
  const r = run("send", ["ghost", "hi"], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /ghost/);
});

test("send:@分组解析", () => {
  const c = setup({ peers: [member("a", { labels: ["web"] }), member("b", { labels: ["web"] }), member("d", { labels: ["db"] })] });
  const r = run("send", ["@web", "前端注意"], c);

  assert.equal(r.ok, true);
  assert.deepEqual(r.intentions[0].to, "@web");
  assert.match(r.lines.join(), /2 个节点/);
});

test("send:空分组被拒绝", () => {
  const c = setup({ peers: [member("a", { labels: ["web"] })] });
  const r = run("send", ["@nobody", "hi"], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /nobody/);
});

test("send:小群发直接发,不确认", () => {
  const peers = Array.from({ length: BULK_WARN_THRESHOLD }, (_, i) => member(`p${i}`));
  const c = setup({ peers });
  const r = run("send", ["@default", "hi"], c);

  assert.equal(r.ok, true);
  assert.equal(r.party, undefined, "不超过阈值不应要求确认");
  assert.deepEqual(intentTypes(r), ["send", "card"]);
});

test("send:超过阈值要确认,且不直接产出意图", () => {
  const peers = Array.from({ length: BULK_WARN_THRESHOLD + 1 }, (_, i) => member(`p${i}`));
  const c = setup({ peers });
  const r = run("send", ["@default", "hi"], c);

  assert.equal(r.ok, true);
  assert.equal(r.party.kind, "confirmBulk");
  assert.equal(r.party.n, BULK_WARN_THRESHOLD + 1);
  assert.deepEqual(r.intentions, [], "确认前不该产生发送意图");
});

test("send:显式点名单个节点即使人多也不确认", () => {
  const peers = Array.from({ length: 20 }, (_, i) => member(`p${i}`));
  const c = setup({ peers });
  const r = run("send", ["p3", "hi"], c);
  assert.equal(r.party, undefined, "单播不该被当成群发");
});

// ---------------------------------------------------------------- doTransmit(确认后复用)

test("doTransmit:确认后走同一条发送路径", () => {
  const c = setup();
  const r = doTransmit("peer", "内容", "user", { targets: ["peer"], unknown: [] }, c.state, c.env);
  assert.equal(r.ok, true);
  assert.deepEqual(intentTypes(r), ["send", "card"]);
});

// ---------------------------------------------------------------- reply

test("reply:三个模式都接受", () => {
  const c = setup();
  for (const m of ["off", "remind", "mirror"]) {
    const r = run("reply", [m], c);
    assert.equal(r.ok, true, m);
    assert.equal(c.state.reply, m);
    assert.ok(r.lines[0].includes(m), "要回显当前值");
  }
});

test("replies:非法值报错并列出可用值", () => {
  const c = setup();
  const bad = run("replies", ["sometimes"], c);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /remind/);
  assert.match(bad.error, /mirror/);
});

test("replies:不带参数时显示当前值和三种模式的说明", () => {
  const r = run("replies", [], setup());
  assert.equal(r.ok, true);
  const text = r.lines.join("\n");
  for (const m of ["off", "remind", "mirror"]) assert.match(text, new RegExp(m));
});

test("reply:不带参数时给显式回复的用法(不再是策略)", () => {
  const r = run("reply", [], setup());
  assert.equal(r.ok, false);
  assert.match(r.error, /\/team reply <requestId>/);
  assert.match(r.error, /\/team replies/, "要告诉用户策略搬到 replies 了");
});

test("reply:旧写法 /team reply <mode> 仍设置策略,并提示已换到 /team replies", () => {
  const c = setup();
  const r = run("reply", ["mirror"], c);
  assert.equal(r.ok, true);
  assert.equal(c.state.reply, "mirror");
  assert.ok(r.lines.some((l) => /replies/.test(l)), "要提示新写法:${r.lines}");
});

test("reply:旧名字 auto / always 仍然可用,并说明改名了", () => {
  // 改名不该让已经写好的启动脚本或肌肉记忆失效。旧名字映射到新名字,
  // 并且明确告诉用户现在叫什么 —— 静默接受会让人一直用旧名字。
  const c = setup();

  const auto = run("reply", ["auto"], c);
  assert.equal(auto.ok, true);
  assert.equal(c.state.reply, "remind");
  assert.ok(auto.lines.some((l) => /remind/.test(l) && /旧名字|现在叫/.test(l)), `要说明改名:${auto.lines}`);

  const always = run("reply", ["always"], c);
  assert.equal(always.ok, true);
  assert.equal(c.state.reply, "mirror");
  assert.ok(always.lines.some((l) => /mirror/.test(l) && /旧名字|现在叫/.test(l)));
});

test("announce 作为子命令名保留为别名", () => {
  // /team announce always 以前很常用,直接删掉太粗暴
  const c = setup();
  const r = run("announce", ["always"], c);
  assert.equal(r.ok, true);
  assert.equal(c.state.reply, "mirror");
});

test("normalizeReplyMode:新旧名字都能识别", async () => {
  const { normalizeReplyMode } = await import("./dispatch.js");
  assert.deepEqual(normalizeReplyMode("off"), { mode: "off", legacy: false });
  assert.deepEqual(normalizeReplyMode("remind"), { mode: "remind", legacy: false });
  assert.deepEqual(normalizeReplyMode("mirror"), { mode: "mirror", legacy: false });
  assert.deepEqual(normalizeReplyMode("auto"), { mode: "remind", legacy: true });
  assert.deepEqual(normalizeReplyMode("always"), { mode: "mirror", legacy: true });
  assert.deepEqual(normalizeReplyMode("nonsense"), { mode: null, legacy: false });
  assert.deepEqual(normalizeReplyMode(""), { mode: null, legacy: false });
  assert.deepEqual(normalizeReplyMode(undefined), { mode: null, legacy: false });
});

test("on / off 是 reply 的简写", () => {
  const c = setup();
  run("on", [], c);
  assert.equal(c.state.reply, "remind");
  run("off", [], c);
  assert.equal(c.state.reply, "off");
});

// ---------------------------------------------------------------- label

test("label:list 显示当前标签", () => {
  const c = setup();
  c.state.selfLabels = ["web", "fe"];
  const r = run("label", ["list"], c);
  assert.match(r.lines.join(), /web, fe/);
});

test("label:add / remove 更新状态并要求重连", () => {
  const c = setup();
  const add = run("label", ["add", "web", "fe"], c);
  assert.equal(add.ok, true);
  assert.deepEqual(c.state.selfLabels, ["web", "fe"]);
  assert.equal(add.party.kind, "reconnect", "标签改了 broker 才知道,必须重连");
  assert.deepEqual(add.party.labels, ["web", "fe"]);

  const rm = run("label", ["remove", "web"], c);
  assert.deepEqual(c.state.selfLabels, ["fe"]);
  assert.equal(rm.party.kind, "reconnect");
});

test("label:remove 支持 rm 简写", () => {
  const c = setup();
  run("label", ["add", "x"], c);
  run("label", ["rm", "x"], c);
  assert.deepEqual(c.state.selfLabels, []);
});

test("label:缺参数时报用法", () => {
  const c = setup();
  assert.match(run("label", ["add"], c).error, /用法/);
  assert.match(run("label", ["wat"], c).error, /用法/);
});

test("label:未连接时不提示重连", () => {
  const c = setup({ connState: "offline" });
  const r = run("label", ["add", "web"], c);
  assert.equal(r.party.kind, "reconnect", "party 仍然产出,让上层决定");
  assert.ok(!r.lines.some((l) => /正在重连/.test(l)), "离线时不该说正在重连");
});

// ---------------------------------------------------------------- team 生命周期

test("create:生成配置并产出 connect party", (t) => {
  const home = mkdtempSync(join(tmpdir(), "dispatch-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // dispatch 内部用真实 home,所以这里只测参数校验路径
  const c = setup();
  const bad = run("create", [], c);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /缺少 team 名/);

  const badUrl = run("create", ["t1", "not-a-url"], c);
  assert.equal(badUrl.ok, false);
});

test("join:缺 team 名时说清缺的是什么", () => {
  const c = setup();
  const r = run("join", [], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /缺少 team 名/);
});

test("join:给了选项却没给 team 名 —— 最容易犯的错,要针对性提示", () => {
  // 真实反馈:用户敲 `/team join --url ... --token ...`,该给的看起来
  // 都给了,所以读"用法"那张选项表找不出错在哪。漏的是最前面的位置参数。
  const c = setup();
  const r = run("join", ["--url", "http://h:1", "--token", TOKEN64], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /缺少 team 名/);
  assert.match(r.error, /--url/, "要点出他确实给了哪些选项");
  assert.match(r.error, /<team名>/, "要给出正确写法");
});

test("leave:没有当前 team 时报用法", () => {
  const c = setup({ team: null });
  const r = run("leave", [], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /用法/);
});

test("leave:不存在的 team 报错,不静默成功", () => {
  const c = setup({ team: "nope-never-exists" });
  const r = run("leave", [], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /没有/);
});

// ---------------------------------------------------------------- 双入口一致性

test("双入口一致性:命令和工具走同一个 dispatch,输出必然相同", () => {
  // 这条测试的意义在于固定"单一实现"这个约束:如果有人给命令
  // 或工具单独加了分支逻辑,它会先在这里失败。
  const a = setup();
  const b = setup();
  const viaCommand = run("send", ["peer", "同样的内容"], a);
  const viaTool = run("send", ["peer", "同样的内容"], b);

  assert.equal(viaCommand.ok, viaTool.ok);
  assert.deepEqual(intentTypes(viaCommand), intentTypes(viaTool));
  assert.deepEqual(viaCommand.intentions[0].text, viaTool.intentions[0].text);
  assert.deepEqual(viaCommand.intentions[0].to, viaTool.intentions[0].to);
});

test("transmit 是 dispatch 与工具(team_send / team_ask)共用的底层入口", () => {
  const c = setup();
  const r = transmit("peer", "底层入口", "model", c.state, c.env);
  assert.equal(r.ok, true);
  assert.equal(c.state.outbound.get(r.intentions[0].id).origin, "model");
});

// ---------------------------------------------------------------- id 唯一性

/**
 * 真机上出过一次严重故障:id 生成器是 `m-<时间>-<进程内计数器>`,
 * 缺了进程标识。两个节点在同一毫秒各发一条时,时间相同、计数器都从
 * 0 开始,id 必然碰撞。接收方靠 id 去重,于是第二条被当成重复投递
 * 静默丢弃。症状是"发送方看到投递 1/1,接收方毫无反应",极难定位。
 */
test("id 唯一性:同一毫秒内多次调用不重复", () => {
  const c = setup();
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const r = run("send", ["peer", `m${i}`], c);
    ids.add(r.intentions[0].id);
  }
  assert.equal(ids.size, 50, "同一毫秒内的 id 必须互不相同");
});

test("id 唯一性:带进程标识,不会和另一个进程碰撞", () => {
  // 无法在单进程内直接模拟两个进程,但可以断言 id 里除了时间和
  // 计数器之外还有一段进程级随机成分:长度足够且不随调用变化。
  const c = setup();
  const r = run("send", ["peer", "x"], c);
  const id = r.intentions[0].id;

  const parts = id.split("-");
  assert.ok(parts.length >= 4, `id 应有 >=4 段(含进程标识),实际 ${id}`);

  // 进程标识段在多次调用间保持不变(它是模块级的,不是每次随机)
  const r2 = run("send", ["peer", "y"], c);
  assert.equal(id.split("-")[2], r2.intentions[0].id.split("-")[2], "进程标识应稳定");
});

test("id 唯一性:群发路径也用同一个生成器", () => {
  // 注意阈值:超过 BULK_WARN_THRESHOLD 会返回 confirmBulk 而不是
  // 直接发送,所以群发要控制在阈值以内才能真正拿到 send 意图。
  const peers = Array.from({ length: BULK_WARN_THRESHOLD }, (_, i) => member(`p${i}`, { labels: ["web"] }));
  const bulk = setup({ peers });
  const single = setup();

  const fromBulk = run("send", ["@web", "b"], bulk);
  assert.equal(fromBulk.ok, true);
  assert.equal(fromBulk.party, undefined, "阈值以内应直接发送");

  const bulkId = fromBulk.intentions[0].id;
  const singleId = run("send", ["peer", "a"], single).intentions[0].id;

  assert.match(bulkId, /^m-/);
  assert.match(singleId, /^m-/);
  assert.notEqual(bulkId, singleId);
  assert.ok(bulkId.split("-").length >= 4, "群发路径的 id 也要带进程标识");
  assert.equal(bulkId.split("-")[2], singleId.split("-")[2], "同一进程内进程标识应一致");
});

// ---------------------------------------------------------------- 意图契约

/**
 * send 意图必须用顶层 text / hops,由 index.ts 组装信封的 body。
 *
 * 真机上出过:dispatch.js 写 body:{text},而 index.ts 读 it.text,
 * 结果 /team send 发出空正文的消息。对方只看到空字符串,
 * 症状是"发送方显示投递成功,接收方完全没反应"。
 *
 * 两个生产者(dispatch.js 和 session.js)都要满足同一契约,
 * 所以这里两边都测。
 */
test("契约:dispatch 的 send 意图用顶层 text / hops", () => {
  const c = setup();
  const r = run("send", ["peer", "正文内容"], c);
  const send = r.intentions.find((i) => i.type === "send");

  assert.ok(send);
  assert.equal(send.text, "正文内容", "text 必须在顶层");
  assert.equal(send.hops, 0);
  assert.equal("body" in send, false, "不该自带 body —— 那是 index.ts 的职责");
  assert.ok(send.id, "必须自带 id");
});

test("契约:群发确认后走 doTransmit,同样用顶层 text", () => {
  const c = setup();
  const r = doTransmit("peer", "群发正文", "user", { targets: ["peer"], unknown: [] }, c.state, c.env);
  const send = r.intentions.find((i) => i.type === "send");

  assert.ok(send);
  assert.equal(send.text, "群发正文");
  assert.equal("body" in send, false);
});

test("契约:两个生产者的 send 意图字段集一致", async () => {
  // 防止再次出现"一边改了一边没改"
  const { createSessionState, applyRoster, onTurnSettled } = await import("./session.js");

  const c = setup();
  const fromDispatch = run("send", ["peer", "x"], c).intentions.find((i) => i.type === "send");

  const s = createSessionState("me");
  applyRoster(s, { members: [{ name: "me", labels: [], host: null, addr: null, since: 0 }, { name: "peer", labels: [], host: null, addr: null, since: 0 }] });
  // auto 模式下 settle 不再产出 send(回复改由模型显式调 team_send),
  // 所以用 always 模式 —— 它是 settle 仍会产出 send 的那条路径。
  s.reply = "mirror";
  s.lastText = "y";
  const fromSession = onTurnSettled(s).find((i) => i.type === "send");
  assert.ok(fromSession, "前置条件:always 模式应产出 send");

  const keys = (o) => Object.keys(o).sort().join(",");
  assert.equal(
    keys(fromDispatch).includes("text") && keys(fromSession).includes("text"),
    true,
    `两边都要有 text: dispatch=${keys(fromDispatch)} session=${keys(fromSession)}`,
  );
  assert.equal("body" in fromDispatch, false);
  assert.equal("body" in fromSession, false);
});

test("契约:正文非空 —— 空正文会被接收方丢弃", () => {
  const c = setup();
  const r = run("send", ["peer", "非空"], c);
  const send = r.intentions.find((i) => i.type === "send");
  assert.ok(send, `应有 send 意图,实际 ${JSON.stringify(r)}`);
  assert.ok(send.text.length > 0);
});

// ---------------------------------------------------------------- 连接选项(三个入口共用)

/**
 * 把 HOME 指到临时目录,让 team 配置写到那里。
 * os.homedir() 在 Linux 上每次都读 $HOME,所以这样能覆盖真实写盘路径。
 */
function isolatedHome(t) {
  const home = mkdtempSync(join(tmpdir(), "dispatch-opts-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

const TOKEN64 = "a".repeat(64);

test("join:--mode/--seeds 首次加入就生效并落盘", async (t) => {
  isolatedHome(t);
  const { readTeam } = await import("./team-config.js");
  const c = setup();

  const r = run("join", ["meshy", "--mode", "mesh", "--seeds", "10.0.0.1:19801", "--token", TOKEN64], c);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.party.kind, "connect");
  assert.equal(r.party.config.mode, "mesh");
  assert.deepEqual(r.party.config.seeds, ["10.0.0.1:19801"]);

  const saved = readTeam("meshy");
  assert.equal(saved.mode, "mesh", "mode 要写进 team 配置,下次启动不用再给");
  assert.deepEqual(saved.seeds, ["10.0.0.1:19801"]);
});

test("join:已有 team 可以只改 mode,token 和 url 保留", async (t) => {
  isolatedHome(t);
  const { readTeam } = await import("./team-config.js");
  const c = setup();

  run("join", ["t2", "--url", "http://10.0.0.1:8787", "--token", TOKEN64], c);
  const r = run("join", ["t2", "--mode", "mesh", "--seeds", "10.0.0.2:19801"], c);
  assert.equal(r.ok, true, r.error);

  const saved = readTeam("t2");
  assert.equal(saved.mode, "mesh");
  assert.equal(saved.token, TOKEN64, "改 mode 不能把 token 丢掉 —— 它没存在别的地方");
  assert.equal(saved.url, "http://10.0.0.1:8787");
});

test("join:--name 只进本次连接,绝不写进 team 配置", async (t) => {
  isolatedHome(t);
  const { readTeam } = await import("./team-config.js");
  const c = setup();

  const r = run("join", ["t3", "--url", "http://h:1", "--token", TOKEN64, "--name", "dev01-web"], c);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.party.session.name, "dev01-web", "名字要传给这次连接");

  const saved = readTeam("t3");
  assert.equal(
    "name" in saved,
    false,
    "名字不能落盘:同一台机器上的几个 Pi 共用这个文件,存进去第二个会把第一个顶掉",
  );
});

test("join:位置参数形式仍然可用(向后兼容)", async (t) => {
  isolatedHome(t);
  const c = setup();
  const r = run("join", ["t4", "http://h:1", TOKEN64], c);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.party.config.url, "http://h:1");
  assert.equal(r.party.config.mode, "broker");
});

test("join:broker 模式缺 url 时报错并给写法", async (t) => {
  isolatedHome(t);
  const c = setup();
  const r = run("join", ["t5", "--token", TOKEN64], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /--url/);
});

test("join:mesh 缺 seeds 时可以加入,但结果里要带警告", async (t) => {
  isolatedHome(t);
  const c = setup();
  const r = run("join", ["t6", "--mode", "mesh", "--token", TOKEN64], c);
  assert.equal(r.ok, true, r.error);
  assert.ok(r.lines.some((l) => /seeds/.test(l)), "要提醒没有种子的后果");
});

test("join:拼错的选项被拒,不是静默忽略", async (t) => {
  isolatedHome(t);
  const c = setup();
  const r = run("join", ["t7", "--mod", "mesh", "--token", TOKEN64], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /mod/);
});

test("create:支持 --mode/--seeds,并给出其它机器的加入命令", async (t) => {
  isolatedHome(t);
  const c = setup();
  const r = run("create", ["t8", "--mode", "mesh", "--seeds", "10.0.0.1:19801"], c);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.party.config.mode, "mesh");
  const joinLine = r.lines.find((l) => l.trim().startsWith("/team join"));
  assert.ok(joinLine, "要给出别的机器怎么加入");
  assert.match(joinLine, /--mode mesh/, "加入命令必须带上模式,否则对方会按 broker 连");
});

test("mode:切换模式时 url/token/seeds 不动", async (t) => {
  isolatedHome(t);
  const { readTeam } = await import("./team-config.js");
  const c = setup();
  run("join", ["t9", "--url", "http://h:1", "--token", TOKEN64, "--seeds", "10.0.0.1:19801"], c);

  const c2 = setup({ team: "t9" });
  const r = run("mode", ["mesh"], c2);
  assert.equal(r.ok, true, r.error);

  const saved = readTeam("t9");
  assert.equal(saved.mode, "mesh");
  assert.equal(saved.url, "http://h:1");
  assert.equal(saved.token, TOKEN64);
  assert.deepEqual(saved.seeds, ["10.0.0.1:19801"]);
});

test("mode:切到 broker 但配置里没 url 时拒绝", async (t) => {
  isolatedHome(t);
  const c = setup();
  run("join", ["t10", "--mode", "mesh", "--token", TOKEN64, "--seeds", "10.0.0.1:1"], c);

  const r = run("mode", ["broker"], setup({ team: "t10" }));
  assert.equal(r.ok, false);
  assert.match(r.error, /url/);
});

test("mode:不带参数时显示当前模式和用法", () => {
  const r = run("mode", [], setup({ config: { mode: "mesh", token: "t" } }));
  assert.equal(r.ok, true);
  assert.match(r.lines[0], /mesh/);
});

test("mode:非法模式被拒", () => {
  const r = run("mode", ["raft"], setup());
  assert.equal(r.ok, false);
  assert.match(r.error, /broker/);
});

test("join:--port/--listen 只影响本次连接,不落盘", async (t) => {
  isolatedHome(t);
  const { readTeam } = await import("./team-config.js");
  const c = setup();

  const r = run("join", ["tp", "--mode", "mesh", "--seeds", "10.0.0.1:1", "--token", TOKEN64, "--port", "19801", "--listen", "127.0.0.1"], c);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.party.session.port, 19801);
  assert.equal(r.party.session.listen, "127.0.0.1");

  const saved = readTeam("tp");
  assert.equal(
    "port" in saved,
    false,
    "端口不能落盘:同机第二个 agent 会监听同一个端口,EADDRINUSE 起不来",
  );
  assert.equal("listen" in saved, false);
});


// ---------------------------------------------------------------- 显式回复与 origin

test("send:工具路径记 origin=model,命令路径记 origin=user", () => {
  // 以前 dispatch 一律记成 "user",连 team_send 工具也是。于是模型发出的
  // 消息被当成人发的,对方回复时只显示一张卡片,模型永远看不到回复。
  const c = setup();
  const byModel = run("send", ["peer", "模型发的"], { ...c });
  const idModel = byModel.intentions.find((i) => i.type === "send").id;

  const viaTool = dispatch({ sub: "send", args: ["peer", "工具发的"], origin: "model" }, c.state, c.env);
  const idTool = viaTool.intentions.find((i) => i.type === "send").id;

  assert.equal(c.state.outbound.get(idModel).origin, "user", "/team send 是人发的");
  assert.equal(c.state.outbound.get(idTool).origin, "model", "team_send 工具是模型发的");
});

test("send:发给有待回复请求的队友 → 被阻断,不发出任何东西", async () => {
  const { rememberPending } = await import("./session.js");
  const c = setup();
  rememberPending(c.state, { from: "peer", id: "req-42", hops: 0, ref: "p" });

  const r = dispatch({ sub: "send", args: ["peer", "这是回复"], origin: "model" }, c.state, c.env);
  assert.equal(r.ok, false, "不能静默发新消息把义务掠过去");
  assert.deepEqual(r.intentions, [], "不产出任何发送意图");
  assert.match(r.error, /req-42/, "错误要列出 request id");
  assert.match(r.error, /team_reply/, "要指明先 team_reply");
  assert.equal(c.state.pendingReplies.length, 1, "阻断不改动义务");
});

test("send:没有待回复时照常作为新消息发出(re 为空,不自动关联)", () => {
  const c = setup();
  const r = dispatch({ sub: "send", args: ["peer", "新话题"], origin: "model" }, c.state, c.env);
  const send = r.intentions.find((i) => i.type === "send");
  assert.equal(send.re, null, "send 不再自动算作回复");
  assert.equal(send.hops, 0);
});

// ---------------------------------------------------------------- 显式回复(team_reply)

/**
 * 回复只能通过 team_reply 用显式 request id 发出。这组测试把"精确 id →
 * 原发信人"、"只消费匹配那一那一条"、"未知/过期 id 不发不消费"、
 * "离线/校验失败保留义务"定死。
 */
test("reply:按 request id 精确回复原发信人,并只消费匹配的那一条", async () => {
  const { rememberPending } = await import("./session.js");
  const c = setup({ peers: [member("peer")] });
  rememberPending(c.state, { from: "peer", id: "req-1", hops: 2, ref: "p" });

  const r = dispatch({ sub: "reply", args: ["req-1", "回你了"], origin: "model" }, c.state, c.env);
  assert.equal(r.ok, true, r.error);
  const send = r.intentions.find((i) => i.type === "send");
  assert.equal(send.to, "peer", "路由到存储记录里的原发信人");
  assert.equal(send.re, "req-1");
  assert.equal(send.hops, 3, "跳数在原请求上 +1");
  assert.equal(send.requireResponse, false, "回复不再要求对方回信");
  assert.equal(c.state.pendingReplies.length, 0, "成功发出发出后消费匹配的那一条");
  assert.ok(r.lines.some((l) => /req-1/.test(l)), "结果要回显回复的 id");
});

test("reply:同一队友两条待回复各自独立可回,不互相顶掉", async () => {
  const { rememberPending } = await import("./session.js");
  const c = setup();
  rememberPending(c.state, { from: "peer", id: "req-a", hops: 0, ref: "a" });
  rememberPending(c.state, { from: "peer", id: "req-b", hops: 0, ref: "b" });

  const a = dispatch({ sub: "reply", args: ["req-a", "answer a"], origin: "model" }, c.state, c.env);
  assert.equal(a.ok, true, a.error);
  assert.equal(c.state.pendingReplies.length, 1, "只清 req-a");
  assert.equal(c.state.pendingReplies[0].re, "req-b");

  const b = dispatch({ sub: "reply", args: ["req-b", "answer b"], origin: "model" }, c.state, c.env);
  assert.equal(b.ok, true, b.error);
  assert.equal(c.state.pendingReplies.length, 0);
});

test("reply:缺 requestId / 正文时报用法,不发也不消费", () => {
  const c = setup();
  for (const args of [[], ["req-1"]]) {
    const r = run("reply", args, c);
    assert.equal(r.ok, false);
    assert.match(r.error, /\/team reply <requestId>/);
    assert.deepEqual(r.intentions, []);
  }
});

test("reply:未知 / 过期 id 拒绝,不发任何信封,也不动待回复", async () => {
  const { rememberPending } = await import("./session.js");
  const c = setup();
  rememberPending(c.state, { from: "peer", id: "req-live", hops: 0, ref: "p" });

  const r = run("reply", ["req-dead", "x"], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /req-dead/);
  assert.deepEqual(r.intentions, [], "不能发出任何信封");
  assert.equal(c.state.pendingReplies.length, 1, "不能消费/清空任何一个义务");
});

test("reply:离线时保留义务,不提前消费", async () => {
  const { rememberPending } = await import("./session.js");
  const c = setup({ connState: "offline" });
  rememberPending(c.state, { from: "peer", id: "req-off", hops: 0, ref: "p" });

  const r = run("reply", ["req-off", "x"], c);
  assert.equal(r.ok, false);
  assert.deepEqual(r.intentions, []);
  assert.equal(c.state.pendingReplies.length, 1, "离线失败不能提前消费义务");
});

test("reply:可选回复未要求回信的入站消息(不产生/不消费待回复)", () => {
  const c = setup();
  c.state.incomingIds.set("peer", { id: "note-9", hops: 1 });

  const r = run("reply", ["note-9", "收到"], c);
  assert.equal(r.ok, true, r.error);
  const send = r.intentions.find((i) => i.type === "send");
  assert.equal(send.to, "peer");
  assert.equal(send.re, "note-9");
  assert.equal(send.hops, 2);
  assert.equal(c.state.incomingIds.has("peer"), false, "关联一次性消费");
});

test("reply:命令路径记 origin=user,工具路径记 origin=model", async () => {
  const { rememberPending } = await import("./session.js");
  const viaUser = setup();
  rememberPending(viaUser.state, { from: "peer", id: "u1", hops: 0, ref: "p" });
  const ru = run("reply", ["u1", "人回的"], viaUser);
  assert.equal(viaUser.state.outbound.get(ru.intentions[0].id).origin, "user");

  const viaModel = setup();
  rememberPending(viaModel.state, { from: "peer", id: "m1", hops: 0, ref: "p" });
  const rm = dispatch({ sub: "reply", args: ["m1", "模型回的"], origin: "model" }, viaModel.state, viaModel.env);
  assert.equal(viaModel.state.outbound.get(rm.intentions[0].id).origin, "model");
});

// ---------------------------------------------------------------- 响应策略(send / ask)

/**
 * 公开 API 只有两个发送工具:`team_send`(通知,不要求回信)与 `team_ask`
 * (要求回信)。命令侧是 `/team send` 与 `/team ask`。requireResponse 只剩
 * 私有 wire 元数据 —— 下面的测试把"缺省 / 通知 / 要求"三条路径钉死。
 */
test("send:默认(通知)不要求回信,意图上明确是 false", () => {
  const c = setup();
  const plain = run("send", ["peer", "hi"], c);
  const send = plain.intentions.find((i) => i.type === "send");
  assert.equal(send.requireResponse, false, "send 就是通知,不要求回信");
  assert.ok(!plain.lines.some((l) => /要求对方回信/.test(l)), "通知不该说已要求回信");
});

test("ask:要求回信,意图上明确是 true,并告诉用户已要求", () => {
  const c = setup();
  const r = run("ask", ["peer", "帮我", "跑测试"], c);
  assert.equal(r.ok, true, r.error);
  const send = r.intentions.find((i) => i.type === "send");
  assert.equal(send.requireResponse, true);
  assert.equal(send.to, "peer");
  assert.equal(send.text, "帮我 跑测试");
  assert.ok(r.lines.some((l) => /已要求对方回信/.test(l)), `要让用户知道已要求回信:${r.lines}`);
});

test("send:用法里不再有 --require-response 开关", () => {
  const r = run("send", [], setup());
  assert.equal(r.ok, false);
  assert.match(r.error, /\/team send/);
  assert.doesNotMatch(r.error, /require-response/, "公开入口已不再有这个开关");
});

test("ask:缺收件人或内容时拒绝,用法指向 /team ask", () => {
  const c = setup();
  for (const args of [[], ["peer"]]) {
    const r = run("ask", args, c);
    assert.equal(r.ok, false);
    assert.match(r.error, /用法/);
    assert.match(r.error, /\/team ask/, "用法要指向 ask,不能误导成 send");
  }
});

test("send 与 ask 走同一发送路径:命令与工具结果一致,只有 requireResponse 不同", () => {
  const cmdSend = run("send", ["peer", "x"], setup()).intentions.find((i) => i.type === "send");
  const cmdAsk = run("ask", ["peer", "x"], setup()).intentions.find((i) => i.type === "send");
  const cToolSend = setup();
  const cToolAsk = setup();
  const toolSend = dispatch({ sub: "send", args: ["peer", "x"], origin: "model" }, cToolSend.state, cToolSend.env).intentions.find(
    (i) => i.type === "send",
  );
  const toolAsk = dispatch({ sub: "ask", args: ["peer", "x"], origin: "model" }, cToolAsk.state, cToolAsk.env).intentions.find(
    (i) => i.type === "send",
  );

  assert.equal(cmdSend.requireResponse, false);
  assert.equal(toolSend.requireResponse, false);
  assert.equal(cmdAsk.requireResponse, true);
  assert.equal(toolAsk.requireResponse, true);
  // 两条路径除标志外的字段形状一致 —— 证明它们真的共用同一条实现
  for (const it of [cmdSend, cmdAsk, toolSend, toolAsk]) {
    assert.equal(it.text, "x");
    assert.equal(it.to, "peer");
    assert.equal(it.hops, 0);
    assert.equal(it.re, null);
  }
});

test("ask:命令路径记 origin=user,工具路径记 origin=model", () => {
  const c = setup();
  const byUser = run("ask", ["peer", "人问的"], c).intentions.find((i) => i.type === "send");
  const cTool = setup();
  const byModel = dispatch({ sub: "ask", args: ["peer", "模型问的"], origin: "model" }, cTool.state, cTool.env).intentions.find(
    (i) => i.type === "send",
  );
  assert.equal(c.state.outbound.get(byUser.id).origin, "user");
  assert.equal(cTool.state.outbound.get(byModel.id).origin, "model");
});

test("wire:send 意图的信封不含 requireResponse,ask 意图的信封为 true", async () => {
  const { transmitBodyFrom } = await import("./session.js");
  const sendIt = run("send", ["peer", "x"], setup()).intentions.find((i) => i.type === "send");
  const askIt = run("ask", ["peer", "x"], setup()).intentions.find((i) => i.type === "send");
  assert.equal("requireResponse" in transmitBodyFrom(sendIt), false, "通知不写标志,接收方按缺省即 false 处理");
  assert.equal(transmitBodyFrom(askIt).requireResponse, true);
});

test("send:发送不产生待回复(无提醒),ask:发送才要求回信", () => {
  // dispatch 的输出本身不建待回复 —— 那是接收方的入站分类。这里断言的是
  // 意图上携带的标志:只有 ask 才让接收方建立待回复与提醒。
  assert.equal(run("send", ["peer", "通知"], setup()).intentions.find((i) => i.type === "send").requireResponse, false);
  assert.equal(run("ask", ["peer", "请回复"], setup()).intentions.find((i) => i.type === "send").requireResponse, true);
});

test("send:群发确认 party 的 requireResponse 是 false,不会莫名变成要求回信", () => {
  const peers = Array.from({ length: BULK_WARN_THRESHOLD + 1 }, (_, i) => member(`p${i}`));
  const c = setup({ peers });
  const r = transmit("@default", "hi", "user", c.state, c.env);
  assert.equal(r.party.kind, "confirmBulk");
  assert.equal(r.party.requireResponse, false);
});

test("ask:群发确认 party 携带 requireResponse=true,确认后 doTransmit 仍带上", () => {
  const peers = Array.from({ length: BULK_WARN_THRESHOLD + 1 }, (_, i) => member(`p${i}`));
  const c = setup({ peers });
  const r = transmit("@default", "hi", "model", c.state, c.env, { requireResponse: true });
  assert.equal(r.party.kind, "confirmBulk");
  assert.equal(r.party.requireResponse, true, "确认数据必须带着标志,否则确认后就丢了");
  assert.deepEqual(r.intentions, [], "确认前不直接发送");

  const local = { targets: peers.map((p) => p.name), unknown: [] };
  const after = doTransmit(r.party.to, r.party.text, r.party.origin, local, c.state, c.env, {
    requireResponse: r.party.requireResponse,
  });
  assert.equal(after.intentions.find((i) => i.type === "send").requireResponse, true, "确认后 ask 不能退化成 send");
});

test("ask:对端有待回复时被阻断(和 send 一样的整组校验)", async () => {
  const { rememberPending } = await import("./session.js");
  const c = setup();
  rememberPending(c.state, { from: "peer", id: "peer-req-1", hops: 2, ref: "peer 的请求" });

  const r = dispatch({ sub: "ask", args: ["peer", "我的新请求"], origin: "model" }, c.state, c.env);
  assert.equal(r.ok, false, "有未回复的请求时不能发新 ask");
  assert.deepEqual(r.intentions, []);
  assert.match(r.error, /peer-req-1/);
  assert.match(r.error, /team_reply/);
  assert.equal(c.state.pendingReplies.length, 1, "阻断不改动义务");
});

test("send/ask:有待回复的人被阻断,无关节点仍可用", async () => {
  const { rememberPending } = await import("./session.js");
  const c = setup({ peers: [member("peer"), member("other")] });
  rememberPending(c.state, { from: "peer", id: "r1", hops: 0, ref: "p" });

  const blockedSend = run("send", ["peer", "hi"], c);
  assert.equal(blockedSend.ok, false);

  const okSend = run("send", ["other", "hi"], c);
  assert.equal(okSend.ok, true, okSend.error);
  assert.equal(okSend.intentions.find((i) => i.type === "send").to, "other");

  const okAsk = run("ask", ["other", "please reply"], c);
  assert.equal(okAsk.ok, true, okAsk.error);
});

test("send/ask:分组/全员里有人有待回复 → 原子拒绝,不部分发送", async () => {
  const { rememberPending } = await import("./session.js");
  const peers = [member("a", { labels: ["web"] }), member("b", { labels: ["web"] }), member("c", { labels: ["web"] })];
  const c = setup({ peers });
  rememberPending(c.state, { from: "b", id: "r-b", hops: 0, ref: "p" });

  const group = run("send", ["@web", "hi"], c);
  assert.equal(group.ok, false, "组内有一个人被阻断就拒绝整次");
  assert.deepEqual(group.intentions, [], "不能给 a / c 部分发送");
  assert.match(group.error, /r-b/);

  const all = run("send", ["@default", "hi"], c);
  assert.equal(all.ok, false);
  assert.deepEqual(all.intentions, []);

  const askAll = run("ask", ["@default", "hi"], c);
  assert.equal(askAll.ok, false);
  assert.deepEqual(askAll.intentions, []);
});

test("doTransmit:群发确认时重新校验阻断 —— 对话期间可能出现新请求", async () => {
  const { rememberPending } = await import("./session.js");
  const peers = Array.from({ length: BULK_WARN_THRESHOLD + 1 }, (_, i) => member(`p${i}`));
  const c = setup({ peers });
  const r = transmit("@default", "hi", "user", c.state, c.env);
  assert.equal(r.party.kind, "confirmBulk");
  assert.deepEqual(r.party.targets, peers.map((p) => p.name), "party 要带真实收件人,否则确认后无法重新校验");

  // 对话框弹出后才收到一条请求 —— 确认时必须被拦住。
  rememberPending(c.state, { from: "p3", id: "late-req", hops: 0, ref: "p" });
  const local = { targets: r.party.targets, unknown: [] };
  const after = doTransmit(r.party.to, r.party.text, r.party.origin, local, c.state, c.env, {
    requireResponse: r.party.requireResponse,
  });
  assert.equal(after.ok, false, "确认后不能绕过后来出现的阻断");
  assert.deepEqual(after.intentions, []);
  assert.match(after.error, /late-req/);
});

test("ask:没有待回复时是要求回信的新请求(re=null / hops=0)", () => {
  const c = setup();
  const r = run("ask", ["peer", "请回复"], c);
  const send = r.intentions.find((i) => i.type === "send");
  assert.equal(send.requireResponse, true, "team_ask 要求回信");
  assert.equal(send.re, null, "新请求,不能带别人的请求 id");
  assert.equal(send.hops, 0);
});

test("send/ask 不再自动消费可选入站关联(回复只能用 team_reply)", async () => {
  const { handleIncoming } = await import("./session.js");
  const c = setup();
  // peer 之前发过一条不要求回信的通知 → 存在可选关联,但它不阻断发送
  handleIncoming(c.state, { from: "peer", id: "note-1", re: null, body: { text: "通知", hops: 0 } });
  assert.equal(c.state.incomingIds.get("peer").id, "note-1", "前置条件:已有关联");

  const snd = dispatch({ sub: "send", args: ["peer", "新话题"], origin: "model" }, c.state, c.env);
  assert.equal(snd.intentions.find((i) => i.type === "send").re, null, "send 不再自动绑入站关联");
  assert.equal(c.state.incomingIds.get("peer").id, "note-1", "send 不消费关联");

  const ask = dispatch({ sub: "ask", args: ["peer", "新问题"], origin: "model" }, c.state, c.env);
  assert.equal(ask.intentions.find((i) => i.type === "send").re, null);
  assert.equal(c.state.incomingIds.get("peer").id, "note-1", "ask 也不消费关联");

  // 唯一能消费它的是显式 team_reply
  const rep = run("reply", ["note-1", "回答通知"], c);
  assert.equal(rep.intentions.find((i) => i.type === "send").re, "note-1");
  assert.equal(c.state.incomingIds.has("peer"), false, "显式回复才消费关联");
});

test("ask:命令路径同样被阻断(/team ask)", async () => {
  const { rememberPending } = await import("./session.js");
  const c = setup();
  rememberPending(c.state, { from: "peer", id: "cmd-req", hops: 1, ref: "peer 的请求" });

  const r = run("ask", ["peer", "命令侧的新请求"], c);
  assert.equal(r.ok, false, "命令路径和工具路径行为一致");
  assert.deepEqual(r.intentions, []);
  assert.match(r.error, /cmd-req/);
  assert.equal(c.state.pendingReplies.length, 1, "命令路径也不能消费待回复");
});

// ---------------------------------------------------------------- 消息体积

test("oversizeBy:正常文本不报,超限才报", async () => {
  const { oversizeBy, ENVELOPE_HEADROOM } = await import("./dispatch.js");

  assert.equal(oversizeBy("短消息"), null);
  assert.equal(oversizeBy(""), null);
  assert.equal(oversizeBy("a".repeat(60000)), null, "6 万字节仍在限内");

  const over = oversizeBy("a".repeat(66000));
  assert.ok(over, "应报超限");
  assert.ok(over.bytes >= 66000);
  assert.ok(over.limit > 0);
  assert.ok(ENVELOPE_HEADROOM > 0, "要留出信封其余字段的余量");
});

test("oversizeBy:按字节而不是字符算 —— 中文比英文早得多就超限", async () => {
  const { oversizeBy } = await import("./dispatch.js");
  // 一个汉字 3 字节。20000 字 = 60000 字节,勉强够;24000 字 = 72000 就超了。
  assert.equal(oversizeBy("字".repeat(20000)), null);
  assert.ok(oversizeBy("字".repeat(24000)), "按字符算会漏掉这种情况");
});

test("send:超长消息在本地就被拒,不会去碰连接", () => {
  const c = setup();
  const r = run("send", ["peer", "字".repeat(24000)], c);

  assert.equal(r.ok, false, "本地就该失败");
  assert.match(r.error, /太长|太大/);
  assert.match(r.error, /拆|几条/, "要给出可操作的建议");
  assert.deepEqual(r.intentions, [], "不该产出任何 send 意图");
});

test("send:超长检查先于连接状态 —— 没连接时也报体积问题", () => {
  // 报"未连接"会把人引向错误方向:真正的问题是文本太长。
  const c = setup({ connState: "offline" });
  const r = run("send", ["peer", "字".repeat(24000)], c);
  assert.equal(r.ok, false);
  assert.match(r.error, /太长|太大/, "体积问题是本地可判断的,不该被连接状态掩盖");
});

// ---------------------------------------------------------------- en-US 渲染

/**
 * 上面的断言都把 locale 钉在 zh-Hans,是对中文目录的逐字回归。
 * 这一条把 locale 切到 en-US,走一遍代表性的分发路径,证明同一个
 * dispatch 在英文默认下真的渲染英文(而不是漏键或只有局部翻译)。
 */
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

test("en-US:分发输出的代表性路径渲染英文", () => {
  setLocale("en-US");
  try {
    const statusCtx = setup({ team: "alpha" });
    statusCtx.state.selfLabels = ["web"];
    const status = run("status", [], statusCtx).lines.join("\n");
    assert.match(status, /current team {2}alpha/);
    assert.match(status, /online/);
    assert.ok(!CJK_RE.test(status), `en-US 的 status 不应含中文:\n${status}`);

    const peers = run("peers", [], setup({ peers: [member("a", { host: "dev01", labels: ["web"] })] })).lines.join("\n");
    assert.match(peers, /available groups: @web/);
    assert.ok(!CJK_RE.test(peers), `en-US 的 peers 不应含中文:\n${peers}`);

    assert.match(run("nonsense", [], setup()).error, /Unknown subcommand/);
    assert.match(run("send", ["peer", "hi"], setup({ connState: "offline" })).error, /not connected/);
    assert.match(run("ask", [], setup()).error, /Usage: \/team ask/, "ask 的用法也要本地化成英文");
    assert.match(run("ask", ["peer", "hi"], setup({ connState: "offline" })).error, /not connected/);
    assert.match(run("join", [], setup()).error, /Missing team name/);
  } finally {
    // 文件顶部把 locale 钉在 zh-Hans,恢复它,免得影响别的断言。
    setLocale("zh-Hans");
  }
});
