/**
 * Hyperswarm transport:serverless node-to-node delivery over Holepunch.
 *
 * ── 拓扑 ──
 *   没有 broker,也没有种子地址。每个节点加入同一个 32 字节 topic,
 *   hyperswarm 负责 DHT 发现、UDP 打洞和每条连接上的 Noise 加密。
 *   topic 本身就是能力凭证:知道 topic 就能找到彼此(见 backlog/01)。
 *
 *   ── 威胁模型(story 06)──
 *   topic 是能力凭证,不是秘密:知道 topic 就能被 DHT 发现并建立连接。
 *   Noise 提供的是每条连接的机密性与完整性 —— 它保证"这条链路的对端就是
 *   它自称的那个 Noise 身份",但不证明"它属于这个团队"。
 *   团队身份靠应用层的 HMAC-SHA256 持有证明:key = team token,
 *   message = 版本串 || topic || Noise handshakeHash || 发起/响应角色。
 *   原始 token **永不上线**,只发 MAC;两侧对称发送、常数时间校验,
 *   校验通过之前不接受任何身份帧或信封。
 *   结论:只有 topic 没有 token 的陌生人既无法冒充成员,也拿不到任何
 *   可用信息 —— 只会被明确拒绝。team token 必须是高熵随机值
 *   (MAC 的 key 强度就是 token 的强度)。
 *
 *   每条连接的帧序列是"auth → hello → 信封":parseFrame 在任何
 *   信封被接受之前要求 auth 已通过、hello 已到达。见 handleFrame。
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
import { createHmac } from "node:crypto";
import { FrameReader, encodeFrame, closeFrame, pingFrame, pongFrame, tokenEquals } from "./ws.js";
import { createEmitter } from "./transport.js";
import { resolveTargets } from "./transport-mesh.js";
import { t } from "./i18n.js";
import { M } from "./messages.js";

const HEARTBEAT_MS = 15_000;
/** join 之后最多等这么久 announce 完成;超时也上线,至少本地可用。 */
const FLUSH_TIMEOUT_MS = 10_000;
/** 帧超限时写进 close 原因的前缀,便于对端识别。 */
const MAX_PAYLOAD_HINT = "message too large";

/** 证明绑定用的协议版本串,参与 HMAC,防止跨版本重放。 */
const PROTOCOL_VERSION = "pi-agent-team/v1";
/** 鉴权之前允许的单帧上限。auth 帧只有几百字节,超出即视为滥用。 */
const PREAUTH_MAX_BYTES = 4 * 1024;
/** 从建立起连接起,多久没完成 token 证明就断开,避免挂住未鉴权连接。 */
const HANDSHAKE_TIMEOUT_MS = 8_000;

/**
 * 团队成员的持有证明(key = team token,message = 版本串 || topic ||
 * Noise handshakeHash || 角色)。handshakeHash 两侧相同、随 Noise 会话变化,
 * 所以证明绑定到具体连接;角色两侧互补,防止在反方向重放。
 */
function computeProof(teamToken, topicBytes, channelBinding, role) {
  return createHmac("sha256", teamToken)
    .update(PROTOCOL_VERSION, "utf8")
    .update(topicBytes)
    .update(channelBinding)
    .update(role, "utf8")
    .digest();
}

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
    if (!impl) throw new Error(t(M.transport.hyperswarmEmptyModule));
    return { ok: true, Hyperswarm: impl };
  } catch (err) {
    return {
      ok: false,
      reason: t(M.transport.hyperswarmMissingDep, { error: err?.message ?? err }),
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
 *   token: string,                     // 团队 token(story 06:持有证明的 key)
 *   bootstrap?: Array|string|null,     // 默认走公共 hyperswarm bootstrap
 *   dht?: object|null,                 // 注入的 hyperdht 实例(测试用)
 *   HyperswarmImpl?: unknown,          // 注入的 Hyperswarm 构造器(测试用)
 *   heartbeatMs?: number,
 *   flushTimeoutMs?: number,
 *   handshakeTimeoutMs?: number,       // 未完成 token 证明的连接多久被断开
 * }} opts
 */
export function createHyperswarmTransport({
  topic,
  token,
  bootstrap = null,
  dht = null,
  HyperswarmImpl = null,
  heartbeatMs = HEARTBEAT_MS,
  flushTimeoutMs = FLUSH_TIMEOUT_MS,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
} = {}) {
  const bus = createEmitter();
  const resolvedTopic = normalizeTopic(topic);
  // token 缺失就 fail closed:没有 key 就算不出证明,任何对端都不该被信任。
  const teamToken = token == null || token === "" ? null : String(token);

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
   * 角色由噪声/连接方向决定:主动 dial 的一方是 initiator,另一方是
   * responder。两侧取值互补,所以证明不能反方向重放。
   */
  function connectionRole(socket, peerInfo) {
    const initiator =
      typeof socket?.isInitiator === "boolean" ? socket.isInitiator : peerInfo?.client === true;
    return initiator ? "initiator" : "responder";
  }

  function clearAuthTimer(session) {
    if (session.authTimer) {
      clearTimeout(session.authTimer);
      session.authTimer = null;
    }
  }

  /** 本端 auth 帧:只带 MAC,永远不带原始 token。 */
  function authFrame(session) {
    const proof = computeProof(teamToken, resolvedTopic, session.binding, session.role);
    return JSON.stringify({ t: "auth", v: 1, proof: proof.toString("base64url") });
  }

  /**
   * 明确拒绝一个对端。原因镜像 probeAuth(token_mismatch / token_missing),
   * 先发帧再断开 —— 裸 close 在对端看来就是 1006,和网络断开无法区分。
   */
  function refuse(session, reason) {
    if (session.refused) return;
    session.refused = true;
    clearAuthTimer(session);
    try {
      session.socket.write(encodeFrame(JSON.stringify({ t: "auth_failed", reason })));
    } catch {}
    bus.emit("diagnostic", { source: "hyperswarm", kind: "auth_failed", reason, peer: session.key });
    const timer = setTimeout(() => {
      try {
        session.socket.destroy();
      } catch {}
    }, 200);
    timer.unref?.();
  }

  /**
   * 校验对端证明。用对端角色重算期望值,常数时间比较。
   * 任何失败都只针对这条连接/这个对端,绝不 setState —— 陌生人不该
   * 把诚实节点的房间级状态拉下线。
   */
  function handleAuthFrame(session, env) {
    if (session.authenticated || session.refused) return;
    if (!teamToken) {
      refuse(session, "token_missing");
      return;
    }
    if (env.v !== 1 || typeof env.proof !== "string" || !env.proof) {
      refuse(session, "token_missing");
      return;
    }
    // 没有 handshakeHash 就无法绑定会话 —— 不能算出期望值,只能 fail closed。
    if (!session.binding) {
      refuse(session, "token_missing");
      return;
    }
    const peerRole = session.role === "initiator" ? "responder" : "initiator";
    const expected = computeProof(teamToken, resolvedTopic, session.binding, peerRole).toString("base64url");
    if (!tokenEquals(env.proof, expected)) {
      refuse(session, "token_mismatch");
      return;
    }
    session.authenticated = true;
    clearAuthTimer(session);
  }

  /** 对端明确拒绝了我们(它那边的 token 和我们的不匹配)。只处理这条连接。 */
  function handlePeerRefusal(session, env) {
    if (session.refused) return;
    session.refused = true;
    clearAuthTimer(session);
    bus.emit("diagnostic", {
      source: "hyperswarm",
      kind: "peer_refused",
      reason: env.reason ?? null,
      peer: session.key,
    });
    try {
      session.socket.destroy();
    } catch {}
  }

  /**
   * 发起鉴权:绑定 Noise handshakeHash,先发 auth(第一条帧)、再发 hello。
   * 两侧都主动发,不存在"等对方先说"的死锁。
   */
  function beginHandshake(session) {
    if (stopped || session.refused || session.authenticated) return;
    if (session.socket.destroyed) return;
    if (!teamToken || !resolvedTopic) {
      refuse(session, "token_missing");
      return;
    }
    const binding = session.socket.handshakeHash;
    if (!binding) {
      // Noise 握手尚未完成(极少见):稍后重试;deadline 会兜底。
      const t = setTimeout(() => beginHandshake(session), 20);
      t.unref?.();
      return;
    }
    session.binding = Buffer.from(binding);
    writeText(session, authFrame(session));
    writeText(session, helloFrame());
  }

  /**
   * 收到一条完整文本帧。
   *
   * 顺序门禁:必须先通过 token 持有证明(auth),对端身份(hello)才被
   * 接受;身份建立(ready)之前,任何信封都不被接受。
   */
  function handleFrame(session, text) {
    if (session.refused) return;

    // pre-auth 帧必须有界:topic 持有者不能靠超大帧撑爆内存。
    if (!session.authenticated && Buffer.byteLength(text, "utf8") > PREAUTH_MAX_BYTES) {
      try {
        session.socket.write(closeFrame(1009, `${MAX_PAYLOAD_HINT}: pre-auth frame`));
      } catch {}
      try {
        session.socket.destroy();
      } catch {}
      return;
    }

    let env;
    try {
      env = JSON.parse(text);
    } catch {
      return;
    }
    if (!env || typeof env !== "object") return;

    if (env.t === "auth") {
      handleAuthFrame(session, env);
      return;
    }
    if (env.t === "auth_failed") {
      handlePeerRefusal(session, env);
      return;
    }

    if (env.kind === "hyperswarm-hello") {
      // 没证明持有 token 之前,不接受任何身份元数据。
      if (!session.authenticated) return;
      // 一旦身份建立,忽略后续的 hello —— 防止中途改名字冒充别人。
      if (session.ready) return;
      if (!env.name) return;
      session.name = String(env.name);
      session.host = env.host ?? null;
      session.labels = Array.isArray(env.labels) ? env.labels : [];
      session.ready = true;
      emitMembership();
      return;
    }

    // 身份未建立(未鉴权或未 hello)之前的任何信封都不接受。
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
      role: connectionRole(socket, peerInfo),
      binding: null,
      authenticated: false,
      refused: false,
      ready: false,
      authTimer: null,
    };
    sessions.set(key, session);

    // 未完成 token 证明的连接不能永久挂住:超时就拒绝并断开。
    session.authTimer = setTimeout(() => {
      if (!session.authenticated) refuse(session, "token_missing");
    }, handshakeTimeoutMs);
    session.authTimer.unref?.();

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

    // 连上立刻发起鉴权:先 auth 帧(带 MAC),再 hello。
    // 对端只有验过我们的证明、并且它的证明也通过后,才会把我们当成员。
    beginHandshake(session);

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

      // token 缺失:fail closed。不发一个证明都算不出的连接出去。
      if (!teamToken) {
        setState("connecting");
        state = "offline";
        bus.emit("state", "offline", {
          reason: "token_missing",
          message: t(M.transport.hyperswarmMissingToken),
        });
        return;
      }
      setState("connecting");

      if (!resolvedTopic) {
        setState("offline", { reason: "invalid_topic", message: t(M.transport.hyperswarmBadTopic) });
        return;
      }

      let Hyperswarm = HyperswarmImpl;
      if (!Hyperswarm) {
        try {
          Hyperswarm = loadHyperswarm();
        } catch (err) {
          setState("offline", {
            reason: "dependency_missing",
            message: t(M.transport.hyperswarmLoadFailed, { error: err?.message ?? err }),
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
      swarm.on("error", (err) => {
        // 不再静默:swarm 级错误(DHT/网络)通过诊断事件暴露,便于排查。
        bus.emit("diagnostic", { source: "swarm", kind: "error", message: String(err?.message ?? err) });
      });

      try {
        discovery = swarm.join(resolvedTopic, { server: true, client: true });
        await swarm.listen();
        // announce 完成后才算 online。这样后加入的节点做 lookup 时
        // 一定能发现我们,顺序创建的节点不会互相错过。
        // DHT 不可达时不能永远卡在 connecting,超时也上线(孤立节点可用)。
        await Promise.race([
          discovery.flushed().catch(() => {}),
          new Promise((r) => {
            // 兜底定时器要 unref:flushed() 先完成时它会被遗弃,
            // 若还挂在事件循环上,每个节点都会把进程多吊住 flushTimeoutMs。
            const t = setTimeout(r, flushTimeoutMs);
            t.unref?.();
          }),
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
