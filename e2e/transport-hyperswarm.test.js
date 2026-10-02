/**
 * Hyperswarm transport 一致性测试。
 *
 * ── 为什么要本地 DHT ──
 *   hyperswarm 默认连公共 bootstrap 节点。测试必须完全自足,不碰
 *   公网,所以每个 harness 起一个本地 hyperdht testnet,把它的
 *   bootstrap 列表注入每个节点(transport 的 bootstrap 选项)。
 *   topic 每个 harness 随机生成,互不串台。
 *
 * ── 顺序很重要 ──
 *   hyperswarm 的 announce 是一次 DHT 查询:先加入的节点 announce
 *   完成后,后加入的节点做 lookup 才能发现它。harness 的 create()
 *   等到 state() === "online"(= announce 完成)才返回,而
 *   conformance 套件总是顺序创建节点,所以发现是确定的。
 *
 * 跑:node --test e2e/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import createTestnet from "hyperdht/testnet.js";
import {
  createHyperswarmTransport,
  normalizeBootstrap,
  normalizeTopic,
} from "../src/transport-hyperswarm.js";
import { conformanceSuite, waitFor } from "./conformance.js";

async function hyperswarmHarness(t) {
  // 本地 DHT 网络。teardown: false —— 由 harness 自己销毁,
  // 避免测试退出时还有残留句柄。
  const testnet = await createTestnet(3, { teardown: false });
  const topic = randomBytes(32);
  const nodes = [];

  const create = async (self) => {
    const transport = createHyperswarmTransport({
      topic,
      bootstrap: testnet.bootstrap,
      heartbeatMs: 3000,
    });

    const inbox = [];
    const states = [];
    const sent = [];

    transport.on("state", (s) => states.push(s));
    transport.on("envelope", (env) => {
      inbox.push(env);
      if (env.from !== "broker" && env.re) {
        const rec = sent.find((x) => x.id === env.re);
        if (rec && rec.outcome === "pending") rec.outcome = "delivered";
      }
    });

    // 和 mesh harness 一样:记录发出的信封,失败时标 failed,
    // conformance 第 4/8 条据此判断"未知收件人有明确报告"。
    const rawSend = transport.send.bind(transport);
    transport.send = (envelope) => {
      sent.push({ ...envelope, outcome: "pending" });
      const ok = rawSend(envelope);
      if (!ok) sent[sent.length - 1].outcome = "failed";
      return ok;
    };

    transport.start(self);

    // 上线 = 已加入 topic 且 announce 完成。对端 lookup 一定能找到我们。
    await waitFor(() => transport.state() === "online", 12000, `${self.name} 上线`);

    const node = {
      transport,
      inbox,
      states,
      sent,
      self,
      stop: () => transport.stop(),
    };
    nodes.push(node);
    return node;
  };

  const teardown = async () => {
    // stop() 返回 swarm.destroy 的 promise —— await 它,确保原生套接字释放。
    await Promise.all(
      nodes.map((n) =>
        Promise.resolve(n.stop()).catch(() => {}),
      ),
    );
    try {
      await testnet.destroy();
    } catch {}
  };

  t.after(teardown);

  return { create, teardown };
}

conformanceSuite({
  name: "hyperswarm",
  makeHarness: (t) => hyperswarmHarness(t),
});

// ---------------------------------------------------------------- hyperswarm 特有

test("[hyperswarm] normalizeTopic 接受 Buffer / base64url / hex", () => {
  const raw = randomBytes(32);
  assert.ok(normalizeTopic(raw).equals(raw), "Buffer 原样接受");
  assert.ok(normalizeTopic(raw.toString("base64url")).equals(raw), "base64url 接受");
  assert.ok(normalizeTopic(raw.toString("hex")).equals(raw), "hex 接受");
  assert.equal(normalizeTopic(""), null);
  assert.equal(normalizeTopic("not-a-topic"), null);
  assert.equal(normalizeTopic(randomBytes(31)), null, "长度不对要拒绝");
  assert.equal(normalizeTopic(null), null);
});

test("[hyperswarm] normalizeBootstrap 接受对象数组和字符串列表", () => {
  assert.deepEqual(normalizeBootstrap([{ host: "127.0.0.1", port: 49737 }]), [
    { host: "127.0.0.1", port: 49737 },
  ]);
  assert.deepEqual(normalizeBootstrap(["127.0.0.1:49737"]), ["127.0.0.1:49737"]);
  assert.deepEqual(normalizeBootstrap("a:1,b:2"), ["a:1", "b:2"]);
  assert.equal(normalizeBootstrap(null), null);
  assert.equal(normalizeBootstrap([]), null);
});

test("[hyperswarm] 孤立节点没有对端也能上线", async (t) => {
  const h = await hyperswarmHarness(t);
  const a = await h.create({ name: "solo-hs" });
  assert.equal(a.transport.state(), "online");
  assert.deepEqual(a.transport.members(), [], "没有对端时成员表为空");
});

test("[hyperswarm] 未知 topic 的节点互相发现不了", async (t) => {
  const testnet = await createTestnet(3, { teardown: false });
  t.after(async () => {
    try {
      await testnet.destroy();
    } catch {}
  });

  // 同一个 DHT 网络,但两个不同的 topic —— 不该看到对方
  const a = createHyperswarmTransport({ topic: randomBytes(32), bootstrap: testnet.bootstrap });
  const b = createHyperswarmTransport({ topic: randomBytes(32), bootstrap: testnet.bootstrap });
  t.after(async () => {
    await Promise.all([
      Promise.resolve(a.stop()).catch(() => {}),
      Promise.resolve(b.stop()).catch(() => {}),
    ]);
  });

  a.start({ name: "topic-a", labels: [], host: null });
  await waitFor(() => a.state() === "online", 12000, "topic-a 上线");
  b.start({ name: "topic-b", labels: [], host: null });
  await waitFor(() => b.state() === "online", 12000, "topic-b 上线");

  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(
    a.members().some((m) => m.name === "topic-b"),
    false,
    "不同 topic 的节点不该出现在成员表里",
  );
  assert.equal(
    b.members().some((m) => m.name === "topic-a"),
    false,
    "不同 topic 的节点不该出现在成员表里",
  );
});
