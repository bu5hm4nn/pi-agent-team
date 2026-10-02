/**
 * Hyperswarm transport:serverless node-to-node delivery over Holepunch.
 *
 * ── 拓扑 ──
 *   没有 broker,也没有种子地址。每个节点加入同一个 32 字节 topic,
 *   hyperswarm 负责 DHT 发现、UDP 打洞和每条连接上的 Noise 加密。
 *   topic 本身就是能力凭证:知道 topic 就能找到彼此(见 backlog/01)。
 *
 *   token 鉴权是 story 06,不在这一层。但每条连接的帧序列设计成
 *   "先身份、后信封":hello(以及 06 会插入的 auth 帧)必须在任何
 *   信封被接受之前到达。见 handleFrame。
 *
 * ── 与 mesh 的关系 ──
 *   send() 的收件人解析、成员视图字段、投递语义都尽量与 mesh 一致,
 *   这样 e2e/conformance.js 看到的是同一套语义。
 *   帧编解码复用 src/ws.js —— 同样的 64 KiB 上限和分片处理。
 *
 * ── 原生依赖懒加载 ──
 *   hyperswarm 带原生 addon(udx-native、sodium-native)。如果在模块
 *   顶层 import,mode.js 一被 import 就会加载它,broker/mesh/swim
 *   也被拖累。所以只用 createRequire 保存一个解析器;真正 require
 *   发生在选择 hyperswarm 模式时(createTransport 的可用性检查 /
 *   start())。import 本模块不会加载原生 addon。
 */

import { createRequire } from "node:module";
import { FrameReader, encodeFrame, closeFrame, pingFrame, pongFrame } from "./ws.js";
import { createEmitter } from "./transport.js";
import { resolveTargets } from "./transport-mesh.js";

const HEARTBEAT_MS = 15_000;
/** join 之后最多等这么久 announce 完成;超时也上线,至少本地可用。 */
const FLUSH_TIMEOUT_MS = 10_000;
/** 帧超限时写进 close 原因的前缀,便于对端识别。 */
const MAX_PAYLOAD_HINT = "message too large";

/** 只在真正需要时解析模块路径,不在这里 require —— 保持 broker/mesh/swim 不受影响。 */
const nodeRequire = createRequire(import.meta.url);

/**
 * 加载可选的原生依赖 hyperswarm。
 * 这里是唯一一处会真正执行 require 的地方;mode.js 在 import 阶段
 * 只引用本函数,不会触发加载。
 */
export function loadHyperswarm() {
  return nodeRequire("hyperswarm");
}

/**
 * 该模式所需的 hyperswarm 是否可用。
 *
 * 用法与 swim 的 sidecarAvailable 相同:createTransport 在构造时就判,
 * 缺依赖就明确失败并给出可操作的理由,而不是让 start() 阶段抛异常。
 * 缺一个**可选**依赖绝不能影响 broker/mesh/swim。
 *
 * @param {() => unknown} [loader] 注入点,测试用(默认真实 require)
 * @returns {{ ok: true, Hyperswarm: unknown } | { ok: false, reason: string }}
 */
export function hyperswarmAvailable(loader = loadHyperswarm) {
  try {
    const impl = loader();
    if (!impl) throw new Error("模块为空");
    return { ok: true, Hyperswarm: impl };
  } catch (err) {
    return {
      ok: false,
      reason:
        `hyperswarm 模式需要可选的 hyperswarm 依赖,但它无法加载:${err?.message ?? err}。` +
        "安装:npm i hyperswarm。broker/mesh/swim 不受影响。",
    };
  }
}

/**
 * 把 topic 规范成 32 字节 Buffer。
 * 接受 Buffer/Uint8Array、base64url 字符串、64 位 hex 字符串。
 * 非法时返回 null —— 由调用方报告,不猜。
 */
export function normalizeTopic(topic) {
  if (Buffer.isBuffer(topic)) return topic.length === 32 ? Buffer.from(topic) : null;
  if (topic instanceof Uint8Array) return topic.length === 32 ? Buffer.from(topic) : null;
  if (typeof topic === "string") {
    const s = topic.trim();
    if (!s) return null;
    if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
    try {
      const b = Buffer.from(s, "base64url");
      if (b.length === 32) return b;
    } catch {
      // 不是 base64url,继续
    }
  }
  return null;
}

/** bootstrap 可以是 [{host,port}]、["host:port"] 或逗号分隔字符串。 */
export function normalizeBootstrap(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const out = raw
      .map((n) => {
        if (typeof n === "string") return n;
        if (n && n.host && n.port) return { host: n.host, port: Number(n.port) };
        return null;
      })
      .filter(Boolean);
    return out.length ? out : null;
  }
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

/**
 * @param {{
 *   topic: Buffer|Uint8Array|string,   // 32 字节 topic(Buffer / base64url / hex)
 *   bootstrap?: Array|string|null,     // 默认走公共 hyperswarm bootstrap
 *   dht?: object|null,                 // 注入的 hyperdht 实例(测试用)
 *   HyperswarmImpl?: unknown,          // 注入的 Hyperswarm 构造器(测试用)
 *   heartbeatMs?: number,
 *   flushTimeoutMs?: number,
 * }} opts
 */
export function createHyperswarmTransport({
  topic,
  bootstrap = null,
  dht = null,
  HyperswarmImpl = null,
  heartbeatMs = HEARTBEAT_MS,
  flushTimeoutMs = FLUSH_TIMEOUT_MS,
} = {}) {
  const bus = createEmitter();
  const resolvedTopic = normalizeTopic(topic);

  let self = null;
  let swarm = null;
  let discovery = null;
  let state = "offline";
  let stopped = false;
  let ephemeralCounter = 0;

  /**
   * 活跃的对等会话。key 优先用对端 Noise 公钥(hex),拿不到时用序号。
   * 只有收到身份帧(hello)之后 session.ready 才为 true,信封才被接受。
   */
  const sessions = new Map();

  const setState = (next, detail) => {
    if (state === next) return;
    state = next;
    bus.emit("state", next, detail);
  };

  /** 成员视图 = 已识别身份的对等会话。永不含自己,也不含未握手的连接。 */
  function members() {
    const byName = new Map();
    for (const s of sessions.values()) {
      if (!s.ready || !s.name || s.name === self?.name) continue;
      byName.set(s.name, {
        name: s.name,
        host: s.host ?? null,
        addr: null,
        labels: Array.isArray(s.labels) ? s.labels : [],
        since: s.since ?? 0,
        // hyperswarm 不需要地址来主动建边,DHT 会处理。端点留空。
        endpoints: [],
      });
    }
    return [...byName.values()];
  }

  const emitMembership = () => bus.emit("membership", members());

  function findSession(name) {
    for (const s of sessions.values()) {
      if (s.ready && s.name === name) return s;
    }
    return null;
  }

  function writeText(session, text) {
    try {
      session.socket.write(encodeFrame(text));
      return true;
    } catch {
      return false;
    }
  }

  function helloFrame() {
    return JSON.stringify({
      kind: "hyperswarm-hello",
      name: self?.name ?? null,
      host: self?.host ?? null,
      labels: self?.labels ?? [],
    });
  }

  /**
   * 收到一条完整文本帧。
   *
   * 顺序门禁:身份帧(hello)必须先到,信封才被接受。story 06 的 token
   * 握手就插在这个位置 —— 在 hello 与 "ready" 之间要求一个 auth 帧,
   * 通过后才置 ready。本 story 只用 topic 能力,故 hello 即 ready。
   */
  function handleFrame(session, text) {
    let env;
    try {
      env = JSON.parse(text);
    } catch {
      return;
    }
    if (!env || typeof env !== "object") return;

    if (env.kind === "hyperswarm-hello") {
      if (!env.name) return;
      session.name = String(env.name);
      session.host = env.host ?? null;
      session.labels = Array.isArray(env.labels) ? env.labels : [];
      session.ready = true;
      emitMembership();
      return;
    }

    // 身份未建立之前的任何信封都不接受。story 06 会在这里要求 auth。
    if (!session.ready) return;

    // env.from 一律忽略:身份来自连接,不来自发送方的自述。
    bus.emit("envelope", { ...env, from: session.name });
  }

  function handleConnection(socket, peerInfo) {
    // 对端可能在任何时刻消失;不处理 error 会变成未捕获异常。
    socket.on("error", () => {});

    if (stopped || !swarm) {
      try {
        socket.destroy();
      } catch {}
      return;
    }

    const publicKey = peerInfo?.publicKey ? Buffer.from(peerInfo.publicKey) : null;
    // 自己连自己(理论上 DHT 不会,但防御一下)
    if (publicKey && swarm.keyPair?.publicKey && publicKey.equals(Buffer.from(swarm.keyPair.publicKey))) {
      try {
        socket.destroy();
      } catch {}
      return;
    }

    const key = publicKey ? publicKey.toString("hex") : `conn:${++ephemeralCounter}`;

    // 同一对端出现重复连接时,只保留最新的那条。
    const existing = sessions.get(key);
    if (existing) {
      try {
        existing.socket.destroy();
      } catch {}
      sessions.delete(key);
    }

    const session = {
      key,
      name: null,
      host: null,
      labels: [],
      since: Date.now(),
      socket,
      ready: false,
    };
    sessions.set(key, session);

    const reader = new FrameReader({
      onText: (t) => handleFrame(session, t),
      onPing: () => {
        try {
          socket.write(pongFrame());
        } catch {}
      },
      onClose: () => {
        try {
          socket.end(closeFrame(1000));
        } catch {}
      },
    });

    socket.on("data", (chunk) => {
      try {
        reader.feed(chunk);
      } catch (err) {
        if (err?.code === "PAYLOAD_TOO_LARGE") {
          // 和 mesh 一样用 1009 + 原因,让对端知道是"太大"而非断网。
          try {
            socket.write(closeFrame(1009, `${MAX_PAYLOAD_HINT}: ${err.size} bytes`));
          } catch {}
        }
        socket.destroy();
      }
    });

    socket.on("close", () => {
      if (sessions.get(key) === session) sessions.delete(key);
      emitMembership();
    });

    // 连上就自我介绍。对端收到后才把我们加进它的成员表。
    writeText(session, helloFrame());

    const hb = setInterval(() => {
      try {
        socket.write(pingFrame());
      } catch {}
    }, heartbeatMs);
    hb.unref?.();
    socket.on("close", () => clearInterval(hb));
  }

  return {
    mode: "hyperswarm",

    async start(nextSelf) {
      self = nextSelf;
      stopped = false;
      setState("connecting");

      if (!resolvedTopic) {
        setState("offline", { reason: "invalid_topic", message: "需要一个 32 字节 topic(Buffer / base64url / hex)" });
        return;
      }

      let Hyperswarm = HyperswarmImpl;
      if (!Hyperswarm) {
        try {
          Hyperswarm = loadHyperswarm();
        } catch (err) {
          setState("offline", {
            reason: "dependency_missing",
            message: `无法加载 hyperswarm:${err?.message ?? err}`,
          });
          return;
        }
      }

      try {
        const opts = {};
        if (dht) opts.dht = dht;
        else {
          const nodes = normalizeBootstrap(bootstrap);
          if (nodes) opts.bootstrap = nodes;
        }
        swarm = new Hyperswarm(opts);
      } catch (err) {
        setState("offline", { reason: "construct_failed", message: String(err?.message ?? err) });
        return;
      }

      swarm.on("connection", handleConnection);
      swarm.on("error", () => {});

      try {
        discovery = swarm.join(resolvedTopic, { server: true, client: true });
        await swarm.listen();
        // announce 完成后才算 online。这样后加入的节点做 lookup 时
        // 一定能发现我们,顺序创建的节点不会互相错过。
        // DHT 不可达时不能永远卡在 connecting,超时也上线(孤立节点可用)。
        await Promise.race([
          discovery.flushed().catch(() => {}),
          new Promise((r) => setTimeout(r, flushTimeoutMs)),
        ]);
      } catch (err) {
        setState("offline", { reason: "join_failed", message: String(err?.message ?? err) });
        return;
      }

      if (stopped) return;
      setState("online");
    },

    stop() {
      stopped = true;
      for (const s of sessions.values()) {
        try {
          s.socket.destroy();
        } catch {}
      }
      sessions.clear();
      // 返回销毁 promise:teardown 可以 await 它,确保 DHT 套接字与定时器
      // 真正释放,不让句柄把测试进程吊住。
      //
      // 不用 {force:true}:force 跳过 clear(),会剩下两个重试定时器把
      // 事件循环一直挂住(实测)。不 force 会先 unannounce,本地/公共
      // DHT 都能很快完成。调用方不 await 也没关系。
      const closing = swarm ? Promise.resolve(swarm.destroy()).catch(() => {}) : Promise.resolve();
      swarm = null;
      discovery = null;
      setState("offline", { reason: "stopped" });
      bus.emit("membership", []);
      return closing;
    },

    send({ to, id, re = null, body }) {
      if (!self || state !== "online") return false;

      const targets = resolveTargets(to, self.name, members());
      if (!targets.length) return false;

      const envelope = JSON.stringify({ from: self.name, id, re, body });
      let anyOk = false;
      for (const target of targets) {
        const session = findSession(target);
        if (!session) continue;
        if (writeText(session, envelope)) anyOk = true;
      }
      return anyOk;
    },

    state: () => state,
    members,
    on: bus.on,

    /** 诊断用:当前 topic(方便上层显示/复制) */
    topic: () => (resolvedTopic ? Buffer.from(resolvedTopic) : null),
  };
}
