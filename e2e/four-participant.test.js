/** 四个隔离 Pi 运行时经真实本地 broker 调用注册工具；不调用模型或公网。 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as module from "node:module";

const runnable = typeof module.registerHooks === "function" && process.features?.typescript === "strip";
const root = new URL("../", import.meta.url);
const token = "four-participant-local-test-only";

// 所有等待由事件驱动；超时报告每个节点已收到的请求与发送数量。
function controller() {
  const changes = new EventEmitter();
  const nodes = [];
  let failure;
  const diagnostic = () => JSON.stringify(nodes.map(n => {
    const pending = n.received.filter(e => e.body?.requireResponse && !n.sent.some(reply => reply.re === e.id));
    return { name: n.name, sent: n.sent.length, received: n.received.length, pendingCount: pending.length, pendingIds: pending.map(e => e.id), injected: n.injected.length, stderr: n.stderr };
  }));
  function wait(predicate, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`${label}: ${diagnostic()}`)), 8000);
      function finish(error) {
        clearTimeout(timer);
        changes.off("change", check);
        error ? reject(error) : resolve();
      }
      function check() {
        if (failure) return finish(failure);
        try { if (predicate()) finish(); } catch (error) { finish(error); }
      }
      changes.on("change", check);
      check();
    });
  }
  return { nodes, wait, changed: () => changes.emit("change"), fail(error) { failure = error; changes.emit("change"); } };
}

async function reap(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  try { await exit; } finally { clearTimeout(timer); }
}

async function harness(t) {
  const home = await mkdtemp(join(tmpdir(), "pi-four-"));
  const control = controller();
  const children = [];
  let closing = false;
  // 在任何启动动作前登记清理，失败断言也不能留下子进程或临时凭据。
  t.after(async () => {
    closing = true;
    control.fail(new Error("Harness cleanup"));
    try { await Promise.all(children.map(reap)); }
    finally { await rm(home, { recursive: true, force: true }); }
  });
  const server = createServer();
  let port;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = server.address().port;
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  // 清除宿主 TEAM_*，只给子进程传入测试自己的配置。
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TEAM_" ) && key !== "TEAM"));
  const broker = spawn(process.execPath, [new URL("broker.mjs", root).pathname, "--bind", "127.0.0.1", "--port", String(port)], {
    env: { ...cleanEnv, HOME: home, TEAM_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(broker);
  let output = "";
  broker.stdout.on("data", data => { output += data; control.changed(); });
  broker.stderr.on("data", data => { output += data; control.changed(); });
  function watch(child, name) {
    child.on("error", error => control.fail(error));
    child.on("exit", (code, signal) => {
      if (!closing && !child.expectedExit) control.fail(new Error(`${name} exited ${code}/${signal}; broker=${output}`));
    });
  }
  watch(broker, "broker");
  await control.wait(() => output.includes("broker 监听"), "broker startup");
  for (const name of ["A", "B", "C", "D"]) {
    const nodeHome = join(home, name);
    await mkdir(nodeHome);
    const child = fork(new URL("fixtures/four-participant.js", import.meta.url), [], {
      cwd: nodeHome,
      env: { ...cleanEnv, HOME: nodeHome, XDG_CONFIG_HOME: join(nodeHome, "config"), TEAM_DIR: join(nodeHome, "teams"), TEAM_NAME: name, TEAM_MODE: "broker", TEAM_URL: `ws://127.0.0.1:${port}`, TEAM_TOKEN: token, TEAM_LANG: "en-US", TEAM_REPLY: "remind" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.push(child);
    const n = { name, child, sent: [], received: [], injected: [], stderr: "", responses: new Map(), sequence: 0 };
    control.nodes.push(n);
    child.stdout.on("data", data => { n.stderr += data; });
    child.stderr.on("data", data => { n.stderr += data; });
    watch(child, name);
    child.on("message", message => {
      if (message.id) n.responses.set(message.id, message);
      else if (message.kind === "ready") n.pid = message.value.pid;
      else n[message.kind].push(message.value);
      control.changed();
    });
    n.rpc = async (op, calls) => {
      const id = `${name}-${++n.sequence}`;
      if (op === "shutdown") child.expectedExit = true;
      child.send({ id, op, calls });
      await control.wait(() => n.responses.has(id), `${id} ${op}`);
      const response = n.responses.get(id);
      n.responses.delete(id);
      if (response.error) throw new Error(response.error);
      return response.value;
    };
  }
  await control.wait(() => control.nodes.every(n => n.pid && n.received.some(e => e.body?.members?.length === 4)), "four runtimes online");
  return { ...control, home };
}

const call = (name, args) => ({ name, args });
const application = node => node.received.filter(e => e.from !== "broker");
const reminders = node => node.injected.filter(m => m.content.startsWith("[team 待回复]"));

test("四节点真实工具：并发请求溢出、精确回复、阻断、一次提醒与竞争", {
  skip: runnable ? false : "Requires native registerHooks and default TypeScript stripping",
  timeout: 25000,
}, async t => {
  const h = await harness(t);
  const [A, B, C, D] = h.nodes;
  assert.equal(new Set(h.nodes.map(n => n.pid)).size, 4);
  let expectedWrites = 0;
  async function execute(node, calls, delivered = true) {
    const before = node.sent.length;
    const results = await node.rpc("tools", calls);
    assert.deepEqual(results.map(r => r.details.delivered), calls.map(() => delivered));
    assert.equal(node.sent.length - before, delivered ? calls.length : 0, "rejected tools must not write");
    if (delivered) expectedWrites += calls.length;
    const writes = node.sent.slice(before);
    for (const envelope of writes) assert.equal(envelope.from, node.name, "wire identity matches isolated runtime");
    return writes;
  }
  async function received(envelopes) {
    await h.wait(() => envelopes.every(e => h.nodes.find(n => n.name === e.to).received.some(r => r.id === e.id)), `delivery ${envelopes.map(e => e.id).join(",")}`);
  }
  async function settleAll() { await Promise.all(h.nodes.map(n => n.rpc("settle"))); }

  // 默认通知跨四节点；旧通知关联被同一发送者的新通知替代后不可回复。
  const notes = (await Promise.all(h.nodes.map((n, i) => execute(n, [call("team_send", { to: h.nodes[(i + 1) % 4].name, text: `notice-${n.name}` })])))).flat();
  await received(notes);
  const replacement = await execute(A, [call("team_send", { to: "B", text: "newest-notice" })]);
  await received(replacement);
  await settleAll();
  await settleAll();
  assert.deepEqual(h.nodes.map(n => reminders(n).length), [0, 0, 0, 0]);
  await execute(B, [call("team_reply", { requestId: notes[0].id, text: "stale" })], false);
  await execute(A, [call("team_reply", { text: "missing" }), call("team_reply", { requestId: "unknown-id", text: "unknown" })], false);

  // 同一队友多条未完成请求，三位请求者同时越过 32 条正文保留上限。
  const questions = (await Promise.all([B, C, D].map(n => execute(n, Array.from({ length: 12 }, (_, i) => call("team_ask", { to: "A", text: `question-${n.name}-${i}` })))))).flat();
  assert.equal(new Set(questions.map(q => q.id)).size, 36);
  await received(questions);
  await h.wait(() => A.injected.length === 37, "36 question payloads plus initial notice");
  for (const q of questions) {
    const wire = application(A).find(e => e.id === q.id);
    assert.equal(wire.from, q.from);
    assert.equal(wire.body.text, q.body.text);
    assert.equal(wire.body.requireResponse, true);
    const payloads = A.injected.filter(m => m.content.includes(`requestId: ${JSON.stringify(q.id)}`));
    assert.equal(payloads.length, 1);
    assert.ok(payloads[0].content.includes(q.from) && payloads[0].content.includes(q.body.text));
    assert.equal(payloads[0].options.triggerTurn, true);
  }
  await A.rpc("settle");
  assert.equal(reminders(A).length, 36);
  for (const q of questions) assert.equal(reminders(A).filter(m => m.content.includes(`requestId: ${JSON.stringify(q.id)}`)).length, 1);
  await A.rpc("settle");
  assert.equal(reminders(A).length, 36, "each request reminds once, including compacted payloads");
  await execute(A, [call("team_send", { to: "B", text: "blocked" }), call("team_ask", { to: "B", text: "blocked" })], false);

  // 回复 C/D 的同时 B 继续提问；不能退化成纯串行的请求批次/回复批次。
  const cd = questions.filter(q => q.from !== "B").reverse();
  const [, extra] = await Promise.all([
    execute(A, cd.map(q => call("team_reply", { requestId: q.id, text: `answer:${q.body.text}` }))),
    execute(B, Array.from({ length: 3 }, (_, i) => call("team_ask", { to: "A", text: `interleaved-B-${i}` }))),
  ]);
  assert.deepEqual(A.sent.filter(e => e.re).map(e => e.re), cd.map(q => q.id), "replies follow requested reverse order, not FIFO");
  questions.push(...extra);
  await received(extra);
  // B 的义务仍在，C 已全部回答，应允许 A 与 C 独立交流。
  await execute(A, [call("team_send", { to: "B", text: "still-blocked" }), call("team_ask", { to: "B", text: "still-blocked" })], false);
  const independent = await execute(A, [call("team_send", { to: "C", text: "unrelated-notice" }), call("team_ask", { to: "C", text: "independent-question" })]);
  await received(independent);
  const independentReply = await execute(C, [call("team_reply", { requestId: independent[1].id, text: "independent-answer" })]);
  await received(independentReply);

  const bQuestions = questions.filter(q => q.from === "B").reverse();
  const race = bQuestions.shift();
  const beforeRace = A.sent.length;
  const results = await A.rpc("tools", [1, 2].map(() => call("team_reply", { requestId: race.id, text: `answer:${race.body.text}` })));
  assert.deepEqual(results.map(r => r.details.delivered).sort(), [false, true]);
  assert.equal(A.sent.length - beforeRace, 1, "parallel same-ID reply writes once");
  expectedWrites++;
  await execute(A, bQuestions.map(q => call("team_reply", { requestId: q.id, text: `answer:${q.body.text}` })));
  await execute(A, [call("team_reply", { requestId: race.id, text: "already answered" })], false);
  await execute(A, [call("team_send", { to: "B", text: "unblocked-after-all-replies" })]);

  // 用 broker 回执和实际收件人的事件做屏障，不用固定睡眠证明没有额外消息。
  await h.wait(() => h.nodes.every(n => n.sent.every(e => n.received.some(r => r.from === "broker" && r.re === e.id && r.body?.kind === "delivered"))) && h.nodes.reduce((sum, n) => sum + application(n).length, 0) === expectedWrites, "all broker receipts and receiver deliveries");
  const injectedBefore = h.nodes.map(n => n.injected.length);
  await settleAll();
  await settleAll();
  assert.deepEqual(h.nodes.map(n => n.injected.length), injectedBefore, "no reply ping-pong or informational reminders");
  const sent = h.nodes.flatMap(n => n.sent);
  assert.equal(sent.length, expectedWrites);
  assert.equal(expectedWrites, 87);
  for (const n of h.nodes) {
    assert.deepEqual(application(n).map(e => e.id).sort(), sent.filter(e => e.to === n.name).map(e => e.id).sort(), `${n.name}: exact deliveries, no duplicates`);
    const payloads = n.injected.filter(m => !m.content.startsWith("[team 待回复]"));
    assert.equal(payloads.length, application(n).length, `${n.name}: every received message reaches model context once`);
    for (const envelope of application(n)) {
      const matching = payloads.filter(m => m.content.split("\n").includes(envelope.body.text));
      assert.equal(matching.length, 1, `${n.name}: injected ${envelope.id}`);
      assert.ok(matching[0].content.includes(envelope.from));
      assert.equal(matching[0].customType, "team-msg");
      assert.equal(matching[0].options.triggerTurn, true);
    }
  }
  for (const q of questions) {
    const replies = application(h.nodes.find(n => n.name === q.from)).filter(e => e.re === q.id);
    assert.equal(replies.length, 1, `exactly one reply for ${q.id}`);
    assert.equal(replies[0].from, "A");
    assert.equal(replies[0].body.text, `answer:${q.body.text}`);
  }
  for (const e of sent) {
    if (e.re || !e.body.text.startsWith("question-") && !e.body.text.startsWith("interleaved-") && e.body.text !== "independent-question") assert.equal("requireResponse" in e.body, false);
  }
  assert.equal(sent.filter(e => e.body.requireResponse).length, 40);
  t.diagnostic(`4 isolated processes; 39 concurrent/interleaved questions to A; 40 correlated replies total; ${expectedWrites} exact socket deliveries; 36 once-only reminders.`);
  // 验证扩展生命周期主动关闭 socket；after 仍负责兜底回收进程。
  await Promise.all(h.nodes.map(n => n.rpc("shutdown")));
});
