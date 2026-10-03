/**
 * 端到端:两个本地节点经 hyperswarm 相连。
 *
 * 与 conformance 套件(transport-hyperswarm.test.js)不同,这个测试走的是
 * **用户实际看到的加入流程**:
 *
 *   A:/team create  → 本地生成 token + topic → buildPunchUri
 *   B:只拿到那一条 punch URI → parsePunchUri → joinTeam → 配置文件落盘
 *   A、B 各自 createHyperswarmTransport(topic, token)→ 上线 → 互相发现
 *   → alpha 发消息,beta 收到并回信,载荷逐字节一致
 *
 * ── 完全自足 ──
 *   只依赖 Node + package.json 里已声明的包(hyperdht 是 devDependency)。
 *   不用 Go/SWIM 边车、不用外部服务、不碰公共 DHT、不需要公网。
 *   所有网络都发生在 127.0.0.1 上,端口由内核分配(见下)。
 *
 * ── 本地 DHT:为什么是两个节点,以及为什么端口写成 [0, 0] ──
 *   hyperswarm 的 topic announce 需要路由节点达到法定人数(quorum);
 *   只有单个节点时 lookup 永远返回空,两个节点才稳定发现(实测)。
 *   所以这里起一个 bootstrap 节点 + 一个持久路由节点,都绑 127.0.0.1。
 *
 *   hyperdht 的 `new DHT({ port: 0 })` 会被 `opts.port || 49737` 悄悄换成
 *   固定端口 49737 —— 那在 CI 上和硬编码端口一样会撞。`port: [0, 0]` 是
 *   真值,会原样传给 dht-rpc,bind 时落到内核分配的空闲端口。这里读
 *   `address().port` 再拼 bootstrap 列表,绝不写死端口。
 *
 *   两个 transport 还各自注入一个绑到 127.0.0.1 的 DHT(transport 的
 *   `dht` 选项),这样 hyperswarm 自己的底层 socket 也只听回环,
 *   不会默认绑 0.0.0.0。整条测试不产生任何离开 127.0.0.1 的流量。
 *
 * 跑:node --test e2e/hyperswarm-two-node.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DHT from "hyperdht";
import { createHyperswarmTransport } from "../src/transport-hyperswarm.js";
import { createTeam, joinTeam, readTeam } from "../src/team-config.js";
import { buildPunchUri, parsePunchUri } from "../src/options.js";
import { MAX_PAYLOAD } from "../src/ws.js";
import { waitFor } from "./conformance.js";

const TEAM = "e2e-two-node";

/**
 * 多字节、跨多个 TCP 段的载荷:远超单个段(~37 KB),但仍在 64 KiB 上限内。
 * 每轮 "多字节🚀λ" = 9 + 4 + 2 = 15 字节,2500 轮 ≈ 37.5 KB。
 */
const PAYLOAD_ALPHA_TO_BETA = `alpha→beta|${"多字节🚀λ".repeat(2500)}|end`;
const PAYLOAD_BETA_TO_ALPHA = `beta→alpha|${"🚀λ多字节".repeat(2500)}|end`;

/**
 * 起一个完全在 127.0.0.1 上、端口由内核分配的本地 DHT 网络。
 *
 * 返回的 bootstrap 列表给两个 transport 注入(transport 有 bootstrap 就
 * 不会用 hyperdht 的公共默认节点);createNode() 给每个 transport 一个
 * 绑回环的底层 DHT;destroy() 关掉全部本机节点。
 */
async function startLocalDht() {
  const nodes = [];

  // bootstrap 节点:空 bootstrap,持久,不 firewall。
  const bootstrapNode = new DHT({
    host: "127.0.0.1",
    port: [0, 0],
    ephemeral: false,
    firewalled: false,
    bootstrap: [],
  });
  await bootstrapNode.fullyBootstrapped();
  nodes.push(bootstrapNode);

  const port = bootstrapNode.address().port;
  assert.ok(Number.isInteger(port) && port > 0, `本地 bootstrap 应绑定到具体端口,实际 ${port}`);
  const bootstrap = [{ host: "127.0.0.1", port }];

  // 第二个持久节点:announce quorum 需要它。
  const routingNode = new DHT({
    host: "127.0.0.1",
    port: [0, 0],
    ephemeral: false,
    firewalled: false,
    bootstrap: [...bootstrap],
  });
  await routingNode.fullyBootstrapped();
  nodes.push(routingNode);

  return {
    bootstrap,
    /** 每个 transport 一个绑回环的底层 DHT —— 连 hyperswarm 自己也不听 0.0.0.0。 */
    createNode() {
      const dht = new DHT({ host: "127.0.0.1", port: [0, 0], bootstrap: [...bootstrap] });
      nodes.push(dht);
      return dht;
    },
    async destroy() {
      // 后起的先关。
      for (let i = nodes.length - 1; i >= 0; i--) {
        await nodes[i].destroy().catch(() => {});
      }
    },
  };
}

/** 给 transport 挂上状态与收件箱记录,start 后返回句柄。 */
function startNode(transport, name) {
  const inbox = [];
  const states = [];
  transport.on("state", (s) => states.push(s));
  transport.on("envelope", (env) => inbox.push(env));
  transport.start({ name, labels: [], host: null });
  return { transport, inbox, states, name };
}

test("[hyperswarm] 两个本地节点经 punch URI 加入同一房间并互相投递", async (t) => {
  // 载荷本身也得是合规的:多字节且不超过帧上限。
  for (const p of [PAYLOAD_ALPHA_TO_BETA, PAYLOAD_BETA_TO_ALPHA]) {
    const bytes = Buffer.byteLength(p, "utf8");
    assert.ok(bytes > 30_000, `载荷应有几十 KB,实际 ${bytes} 字节`);
    assert.ok(bytes <= MAX_PAYLOAD, `载荷不能超过 ${MAX_PAYLOAD} 字节,实际 ${bytes}`);
  }

  // ── 两个节点的独立配置目录:证明只有 URI 是共享的 ──
  const dirA = await mkdtemp(join(tmpdir(), "pi-hs-node-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "pi-hs-node-b-"));

  // ── 本地 DHT 网络(仅在 127.0.0.1,hermetic) ──
  const localDht = await startLocalDht();

  let alpha = null;
  let beta = null;

  t.after(async () => {
    // stop() 返回 swarm.destroy 的 promise,await 它确保原生套接字释放。
    await Promise.all(
      [alpha, beta]
        .filter(Boolean)
        .map((n) => Promise.resolve(n.transport.stop()).catch(() => {})),
    );
    await localDht.destroy();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  // ── 1. A 创建房间并产出 punch URI ──
  const created = createTeam({ team: TEAM, mode: "hyperswarm", home: dirA });
  assert.equal(created.ok, true, created.reason);
  assert.ok(created.config.topic, "createTeam 应生成并持久化 topic");
  assert.equal(created.config.mode, "hyperswarm");

  const uri = buildPunchUri({
    name: TEAM,
    topic: created.config.topic,
    token: created.config.token,
  });
  assert.match(uri, /^punch:\/\/e2e-two-node\//);

  // A 自己的配置:topic / token 就是 URI 里那两个。
  const configA = readTeam(TEAM, dirA);
  assert.equal(configA.topic, created.config.topic);
  assert.equal(configA.token, created.config.token);

  // ── 2. B 只凭 URI 加入 ──
  const parsed = parsePunchUri(uri);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.name, TEAM);

  const joined = joinTeam({
    team: parsed.name,
    topic: parsed.topic,
    token: parsed.token,
    mode: "hyperswarm",
    home: dirB,
  });
  assert.equal(joined.ok, true, joined.reason);
  assert.equal(joined.config.mode, "hyperswarm");

  // URI 是唯一共享的东西:B 落盘的 topic/token 与 A 完全一致,
  // 但 B 用的是自己的配置目录 —— 没有任何文件被复制过去。
  const configB = readTeam(TEAM, dirB);
  assert.equal(configB.topic, configA.topic, "B 的 topic 必须来自 URI,与 A 相同");
  assert.equal(configB.token, configA.token, "B 的 token 必须来自 URI,与 A 相同");

  // ── 3. 两节点上线 ──
  // 同一个本地 DHT 网络、同一个 topic、同一个 token = 同一个房间。
  // 顺序很重要:先让 alpha announce 完成,beta 再做 lookup 才能发现它。
  const bootstrap = localDht.bootstrap;

  alpha = startNode(
    createHyperswarmTransport({
      topic: configA.topic,
      token: configA.token,
      bootstrap,
      dht: localDht.createNode(),
      heartbeatMs: 3000,
    }),
    "alpha",
  );
  await waitFor(() => alpha.transport.state() === "online", 15000, "alpha 上线");

  beta = startNode(
    createHyperswarmTransport({
      topic: configB.topic,
      token: configB.token,
      bootstrap,
      dht: localDht.createNode(),
      heartbeatMs: 3000,
    }),
    "beta",
  );
  await waitFor(() => beta.transport.state() === "online", 15000, "beta 上线");

  // 这就是"两个本地节点经 hyperswarm 连上了":双方成员表互相看见。
  await waitFor(
    () => alpha.transport.members().some((m) => m.name === "beta"),
    15000,
    "alpha 看到 beta",
  );
  await waitFor(
    () => beta.transport.members().some((m) => m.name === "alpha"),
    15000,
    "beta 看到 alpha",
  );

  // ── 4. alpha → beta,beta 回信 ──
  const sent = alpha.transport.send({
    to: "beta",
    id: "msg-1",
    re: null,
    body: { text: PAYLOAD_ALPHA_TO_BETA, hops: 0 },
  });
  assert.equal(sent, true, "alpha 应能投递到已发现的 beta");

  const received = await waitFor(
    () => beta.inbox.find((m) => m.id === "msg-1"),
    10000,
    "beta 收到 alpha 的消息",
  );
  assert.equal(received.from, "alpha", "from 必须来自连接身份");
  assert.equal(received.re, null);
  assert.equal(
    received.body.text,
    PAYLOAD_ALPHA_TO_BETA,
    "alpha→beta 的载荷必须逐字节一致(含多字节字符)",
  );

  const replied = beta.transport.send({
    to: "alpha",
    id: "msg-2",
    re: received.id,
    body: { text: PAYLOAD_BETA_TO_ALPHA, hops: 0 },
  });
  assert.equal(replied, true, "beta 应能回信");

  const reply = await waitFor(
    () => alpha.inbox.find((m) => m.id === "msg-2"),
    10000,
    "alpha 收到 beta 的回信",
  );
  assert.equal(reply.from, "beta", "from 必须来自连接身份");
  assert.equal(reply.re, "msg-1", "回信必须带上被回复消息的 re");
  assert.equal(
    reply.body.text,
    PAYLOAD_BETA_TO_ALPHA,
    "beta→alpha 的载荷必须逐字节一致(含多字节字符)",
  );
});
