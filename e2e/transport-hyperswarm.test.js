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
import { once } from "node:events";
import createTestnet from "hyperdht/testnet.js";
import Hyperswarm from "hyperswarm";
import DHT from "hyperdht";
import {
  createHyperswarmTransport,
  normalizeBootstrap,
  normalizeTopic,
} from "../src/transport-hyperswarm.js";
import { encodeFrame } from "../src/ws.js";
import { conformanceSuite, waitFor } from "./conformance.js";

const TOKEN = "hyperswarm-transport-token";

async function hyperswarmHarness(t) {
  // 本地 DHT 网络。teardown: false —— 由 harness 自己销毁,
  // 避免测试退出时还有残留句柄。
  const testnet = await createTestnet(3, { teardown: false });
  const topic = randomBytes(32);
  const nodes = [];

  const create = async (self) => {
    const transport = createHyperswarmTransport({
      topic,
      token: TOKEN,
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
  const a = createHyperswarmTransport({ topic: randomBytes(32), token: TOKEN, bootstrap: testnet.bootstrap });
  const b = createHyperswarmTransport({ topic: randomBytes(32), token: TOKEN, bootstrap: testnet.bootstrap });
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

// ---------------------------------------------------------------- story 06:团队 token 持有证明

/** 包一层 Hyperswarm 构造器:记录实例,并把每个连接写出的原始帧抓下来。 */
function tappedHyperswarm(capture) {
  return class extends Hyperswarm {
    constructor(opts) {
      super(opts);
      capture.swarm = this;
      this.on("connection", (socket) => {
        const orig = socket.write.bind(socket);
        socket.write = (chunk, ...rest) => {
          try {
            capture.outbound.push(Buffer.from(chunk));
          } catch {}
          return orig(chunk, ...rest);
        };
      });
    }
  };
}

/** 起一个本地 testnet,并把节点/资源的收尾登记到 t.after。 */
async function makeLocalNet(t) {
  const testnet = await createTestnet(3, { teardown: false });
  const stops = [];
  t.after(async () => {
    for (const stop of stops) {
      try {
        await Promise.resolve(stop());
      } catch {}
    }
    try {
      await testnet.destroy();
    } catch {}
  });
  return { testnet, stops };
}

/** 建一个 hyperswarm 节点,记录 inbox / states / details,start() 等上线。 */
function spawnNode(testnet, topic, token, name, HyperswarmImpl = null) {
  const transport = createHyperswarmTransport({
    topic,
    token,
    bootstrap: testnet.bootstrap,
    heartbeatMs: 3000,
    ...(HyperswarmImpl ? { HyperswarmImpl } : {}),
  });

  const inbox = [];
  const states = [];
  const details = [];
  transport.on("state", (s, d) => {
    states.push(s);
    if (d) details.push({ s, d });
  });
  transport.on("envelope", (env) => inbox.push(env));

  return {
    transport,
    inbox,
    states,
    details,
    name,
    async start() {
      transport.start({ name, labels: [], host: null });
      await waitFor(() => transport.state() === "online", 15000, `${name} 上线`);
    },
    stop: () => transport.stop(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("[hyperswarm] 错误 token 被拒绝,不能投递,诚实节点保持在线", async (t) => {
  const { testnet, stops } = await makeLocalNet(t);
  const topic = randomBytes(32);

  const honest = spawnNode(testnet, topic, TOKEN, "honest-node");
  const intruder = spawnNode(testnet, topic, "wrong-token-value", "intruder");
  stops.push(() => honest.stop(), () => intruder.stop());

  await honest.start();
  await intruder.start();

  // 给 DHT 发现 + 双方互拒留时间。
  await sleep(2500);

  assert.equal(
    honest.transport.members().some((m) => m.name === "intruder"),
    false,
    "未通过 token 证明的对端绝不能进入成员表",
  );

  // 陌生人试图投递:它看不到任何成员,解析不到收件人,投递失败。
  const accepted = intruder.transport.send({
    to: "honest-node",
    id: "attack-1",
    re: null,
    body: { text: "gotcha", hops: 0 },
  });
  assert.equal(accepted, false, "未鉴权对端应无法进入投递路径");
  await sleep(500);
  assert.equal(
    honest.inbox.some((m) => m.id === "attack-1"),
    false,
    "诚实节点不能接受陌生人的信封",
  );

  // per-peer:拒绝一个陌生人不得把诚实节点拉下线,也不得广播房间级失败。
  assert.equal(honest.transport.state(), "online", "拒绝单个对端不得让诚实节点离线");
  assert.equal(
    honest.states.includes("offline") || honest.states.includes("auth_failed"),
    false,
    "拒绝是 per-peer 的,不得 latch 成房间级状态",
  );
});

test("[hyperswarm] 拒绝时线上绝不出现原始 team token", async (t) => {
  const { testnet, stops } = await makeLocalNet(t);
  const topic = randomBytes(32);
  const capture = { outbound: [], swarm: null };

  const honest = spawnNode(testnet, topic, TOKEN, "honest-capture", tappedHyperswarm(capture));
  const intruder = spawnNode(testnet, topic, "wrong-token-value", "intruder-capture");
  stops.push(() => honest.stop(), () => intruder.stop());

  await honest.start();
  await intruder.start();
  await sleep(2500);

  const frames = capture.outbound.map((b) => b.toString("utf8"));
  assert.ok(
    frames.some((f) => f.includes('"t":"auth"')),
    "诚实节点必须先发出 auth(持有证明)帧",
  );
  assert.ok(
    frames.some((f) => f.includes("auth_failed")),
    "对错误 token 的对端必须明确拒绝,而不是裸 close",
  );

  const wire = Buffer.concat(capture.outbound);
  assert.equal(
    wire.includes(Buffer.from(TOKEN, "utf8")),
    false,
    "任何发到线上的字节都不得包含原始 team token",
  );
});

test("[hyperswarm] 正确 token 可以往返", async (t) => {
  const { testnet, stops } = await makeLocalNet(t);
  const topic = randomBytes(32);

  const a = spawnNode(testnet, topic, TOKEN, "rt-a");
  const b = spawnNode(testnet, topic, TOKEN, "rt-b");
  stops.push(() => a.stop(), () => b.stop());

  await a.start();
  await b.start();
  await waitFor(() => a.transport.members().some((m) => m.name === "rt-b"), 10000, "a 看到 b");

  a.transport.send({ to: "rt-b", id: "rt-1", re: null, body: { text: "hello", hops: 0 } });
  const got = await waitFor(() => b.inbox.find((m) => m.id === "rt-1"), 5000, "b 收到");
  assert.equal(got.from, "rt-a");
});

test("[hyperswarm] 陌生人伪造 auth/hello/envelope 一律不被接受", async (t) => {
  const { testnet, stops } = await makeLocalNet(t);
  const topic = randomBytes(32);
  const capture = { outbound: [], swarm: null };

  const honest = spawnNode(testnet, topic, TOKEN, "honest-gate", tappedHyperswarm(capture));
  stops.push(() => honest.stop());
  await honest.start();

  const honestKey = capture.swarm.keyPair.publicKey;

  // 攻击者:知道 topic、能直连诚实节点的 DHT 公钥,但没有 token。
  // 直接写原始帧,跳过我们的 transport,模拟手工攻击。
  const atkDht = new DHT({ bootstrap: testnet.bootstrap });
  atkDht.on("error", () => {});
  stops.push(() => atkDht.destroy());
  const raw = atkDht.connect(honestKey);
  // 被诚实节点拒绝/重置后会产生 stream 错误 —— 这里显式吃掉,不让它逃逸成 uncaughtException。
  raw.on("error", () => {});
  stops.push(() => raw.destroy());

  await Promise.race([
    once(raw, "open"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("raw connect timeout")), 10000)),
  ]);

  raw.write(encodeFrame(JSON.stringify({ t: "auth", v: 1, proof: "A".repeat(43) })));
  raw.write(encodeFrame(JSON.stringify({ kind: "hyperswarm-hello", name: "honest-gate" })));
  raw.write(
    encodeFrame(JSON.stringify({ from: "honest-gate", id: "forged-1", re: null, body: { text: "forged", hops: 0 } })),
  );

  await sleep(1500);

  assert.equal(
    honest.inbox.some((m) => m.id === "forged-1"),
    false,
    "错误证明之后,伪造信封不得被接受",
  );
  assert.equal(
    honest.transport.members().some((m) => m.name === "honest-gate"),
    false,
    "伪造的 hello 不得产生成员或身份元数据",
  );
  assert.equal(honest.transport.state(), "online");
  assert.equal(
    Buffer.concat(capture.outbound).includes(Buffer.from(TOKEN, "utf8")),
    false,
    "拒绝过程中也不得泄露原始 token",
  );
});

test("[hyperswarm] 缺 token 时 start() fail closed 并给出可操作原因", async (t) => {
  const transport = createHyperswarmTransport({ topic: randomBytes(32) });
  const details = [];
  transport.on("state", (s, d) => {
    if (d) details.push({ s, d });
  });
  t.after(() => transport.stop());

  transport.start({ name: "no-token", labels: [], host: null });
  await sleep(100);

  assert.equal(transport.state(), "offline", "没有 token 不该上线");
  const missing = details.find((x) => x.d?.reason === "token_missing");
  assert.ok(missing, `应给出 token_missing 原因,实际 ${JSON.stringify(details)}`);
  assert.match(missing.d.message, /token/, "原因要指明缺的是 token");
});
