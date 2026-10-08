/**
 * 成员关系持久化的纯逻辑测试。跑:node --test src/
 *
 * 这一层只测"记录长什么样"和"按分支顺序怎么归约",不碰 Pi、不碰网络。
 * 真正的接线(index.ts 的 session_start / session_tree)由
 * membership-lifecycle.test.js 用假运行时覆盖。
 *
 * ── 为什么 leave 要带 joinId ──
 *   只用 join/leave 两种事件、"最后一条 join 生效"是不够的:一条在
 *   join B 之后才到达(或重放)的陈旧 leave A 必须关不掉 B。归约器
 *   靠 leave.joinId === active.id 这一条把它挡掉。这个文件把这条语义
 *   逐条钉死,包括"先 leave 后 join""同一个 join 被 leave 两次"。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMBERSHIP_TYPE,
  MEMBERSHIP_VERSION,
  isValidRecord,
  makeJoinRecord,
  makeLeaveRecord,
  reduceMembership,
} from "./membership.js";

// ---------------------------------------------------------------- 测试夹具

/** 把记录包成 Pi 的 custom 条目(只有 customType/data 是我们的关注点) */
const entry = (data) => ({
  type: "custom",
  customType: MEMBERSHIP_TYPE,
  id: `e${Math.random().toString(36).slice(2, 8)}`,
  parentId: null,
  timestamp: new Date().toISOString(),
  data,
});

const join = (over = {}) => ({
  v: MEMBERSHIP_VERSION,
  kind: "join",
  id: "j1",
  team: "alpha",
  name: "n1",
  labels: [],
  listen: { host: "0.0.0.0", port: 0 },
  at: "2026-01-01T00:00:00.000Z",
  ...over,
});

const leave = (over = {}) => ({
  v: MEMBERSHIP_VERSION,
  kind: "leave",
  id: "l1",
  joinId: "j1",
  team: "alpha",
  at: "2026-01-01T00:00:01.000Z",
  ...over,
});

// ---------------------------------------------------------------- 构造

test("makeJoinRecord:字段规范、id 唯一、不含凭据", () => {
  const a = makeJoinRecord({ team: "alpha", name: "n1", labels: ["web"], listen: { host: "0.0.0.0", port: 0 } });
  const b = makeJoinRecord({ team: "alpha", name: "n1", labels: ["web"], listen: { host: "0.0.0.0", port: 0 } });

  assert.equal(a.v, MEMBERSHIP_VERSION);
  assert.equal(a.kind, "join");
  assert.match(a.id, /^[0-9a-f-]{36}$/, "join id 应是 UUID");
  assert.notEqual(a.id, b.id, "两次 join 的 id 必须不同");
  assert.equal(a.team, "alpha");
  assert.deepEqual(a.labels, ["web"]);
  assert.deepEqual(a.listen, { host: "0.0.0.0", port: 0 });
  assert.equal(isValidRecord(a), true);
  // 凭据绝不进持久化记录:任何 token/topic/punch 字段都不该出现
  const flat = JSON.stringify(a);
  assert.equal(flat.includes("token"), false);
  assert.equal(flat.includes("topic"), false);
  assert.equal(flat.includes("punch://"), false);
});

test("makeJoinRecord:直连配置(team=null)与缺失 listen 也能安全构造", () => {
  const r = makeJoinRecord({ team: null, name: "n", labels: [], listen: {} });
  assert.equal(r.team, null);
  assert.deepEqual(r.listen, { host: null, port: null });
  assert.equal(isValidRecord(r), true);
});

test("makeLeaveRecord:带自己的事件 id,并引用它关闭的 join", () => {
  const r = makeLeaveRecord({ joinId: "j1", team: "alpha" });
  assert.equal(r.kind, "leave");
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.joinId, "j1");
  assert.equal(r.team, "alpha");
  assert.equal(isValidRecord(r), true);
});

// ---------------------------------------------------------------- 归约

test("reduce:无记录 → 未加入", () => {
  assert.equal(reduceMembership([]), null);
  assert.equal(reduceMembership(undefined), null);
});

test("reduce:join 后为 active;leave 关掉它", () => {
  const j = join();
  assert.equal(reduceMembership([entry(j)])?.id, "j1");
  assert.equal(reduceMembership([entry(j), entry(leave())]), null);
});

test("reduce:join A → leave A → join B → B 生效", () => {
  const a = join({ id: "ja" });
  const b = join({ id: "jb", team: "beta" });
  const out = reduceMembership([entry(a), entry(leave({ id: "la", joinId: "ja" })), entry(b)]);
  assert.equal(out?.id, "jb");
  assert.equal(out?.team, "beta");
});

test("reduce:陈旧的 leave 关不掉更新的 join", () => {
  const a = join({ id: "ja" });
  const b = join({ id: "jb", team: "beta" });
  const stale = leave({ id: "l-stale", joinId: "ja" });
  const out = reduceMembership([entry(a), entry(leave({ id: "la", joinId: "ja" })), entry(b), entry(stale)]);
  assert.equal(out?.id, "jb", "joinId 对不上就不能关掉当前的 join");
});

test("reduce:未匹配/先于任何 join 的 leave 被忽略", () => {
  const orphan = leave({ id: "lo", joinId: "nope" });
  assert.equal(reduceMembership([entry(orphan)]), null, "没有 join 可关时不应凭空产生状态");
  const b = join({ id: "jb" });
  assert.equal(reduceMembership([entry(orphan), entry(b)])?.id, "jb", "孤儿 leave 不该影响后面的 join");
});

test("reduce:同一个 join 被 leave 两次,第二次是空操作", () => {
  const a = join({ id: "ja" });
  const out = reduceMembership([entry(a), entry(leave({ id: "l1", joinId: "ja" })), entry(leave({ id: "l2", joinId: "ja" }))]);
  assert.equal(out, null);
});

test("reduce:只认本扩展的 custom 条目", () => {
  const other = { type: "custom", customType: "some-other-ext", data: join() };
  const msg = { type: "message", message: { role: "user", content: "hi" } };
  assert.equal(reduceMembership([other, msg]), null);
});

test("reduce:损坏或未知版本的记录被安全忽略,不影响合法记录", () => {
  const bad = [
    entry(null),
    entry({ kind: "join" }), // 缺 id
    entry({ ...join(), v: 2 }), // 未知版本
    entry({ ...join(), id: 42 }),
    entry({ ...join(), labels: "web" }), // labels 不是数组
    entry({ ...join(), listen: null }),
    entry(leave({ joinId: "" })), // joinId 为空
    { type: "custom", customType: MEMBERSHIP_TYPE }, // 没有 data
  ];
  const good = join({ id: "jg" });
  assert.equal(reduceMembership([...bad, entry(good)])?.id, "jg", "坏记录被跳过,合法记录照常生效");
  assert.equal(reduceMembership(bad), null);
});

test("reduce:join 覆盖同分支上更早的 join(标签/模式变更后只保留最新)", () => {
  const a = join({ id: "ja", labels: ["web"] });
  const a2 = join({ id: "ja2", labels: ["web", "db"] });
  const out = reduceMembership([entry(a), entry(a2)]);
  assert.equal(out?.id, "ja2");
  assert.deepEqual(out?.labels, ["web", "db"]);
});

test("makeLeaveRecord:joinId 不是非空字符串时不产生看似合法的记录", () => {
  for (const bad of [undefined, null, "", 42, {}]) {
    const r = makeLeaveRecord({ joinId: bad });
    assert.equal(isValidRecord(r), false, `joinId=${JSON.stringify(bad)} 的记录必须不合法`);
  }
  const ok = makeLeaveRecord({ joinId: "j1" });
  assert.equal(isValidRecord(ok), true);
});
