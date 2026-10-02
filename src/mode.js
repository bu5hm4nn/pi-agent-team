/**
 * Transport 工厂:按 TEAM_MODE 选择投递方式。
 *
 * 三种模式共用同一套 Team API(roadmap 8.2)。调用方只看到 start/
 * stop/send/members/on,看不到底下的 WebSocket、gossip、重连这些。
 *
 * 三种模式都必须通过 e2e/conformance.js 的同一套保证。语义不会在
 * 模式之间分叉,因为只有一套测试。
 *
 * ── 需要什么配置 ──
 *   broker     url(broker 地址)        必填
 *   mesh       seeds(至少一个)         可选但强烈建议;没有种子的节点
 *                                      只能等别人连它
 *   swim       seeds + 边车可执行文件   边车缺失是硬失败,不静默降级
 *   hyperswarm topic(32 字节)         必填;topic 由 story 02 生成,
 *                                      这里只接受已解析好的值
 *
 * 所有模式都要 token。
 */

import { createBrokerTransport } from "./transport.js";
import { createMeshTransport } from "./transport-mesh.js";
import { createSwimTransport, sidecarAvailable } from "./transport-swim.js";
import { t } from "./i18n.js";
import { M } from "./messages.js";
import { createHyperswarmTransport, hyperswarmAvailable, loadHyperswarm } from "./transport-hyperswarm.js";

export const MODES = ["broker", "mesh", "swim", "hyperswarm"];

/** 从配置和环境变量解析出模式 */
export function resolveMode({ config = {}, env = process.env } = {}) {
  const raw = env.TEAM_MODE ?? config.mode ?? "broker";
  if (!MODES.includes(raw)) {
    return { ok: false, reason: t(M.mode.invalid, { modes: MODES.join(" / "), value: raw }) };
  }
  return { ok: true, mode: raw };
}

/**
 * 创建 transport。
 *
 * @param {{
 *   mode: "broker"|"mesh"|"swim",
 *   config: { url?: string, token: string, seeds?: string[], labels?: string[] },
 *   listenHost?: string, listenPort?: number, advertiseHost?: string|null,
 *   sidecarPath?: string|null,
 *   hyperswarmLoader?: () => unknown,   // 仅测试用:模拟缺少可选原生依赖
 * }} opts
 */
export function createTransport({
  mode,
  config,
  listenHost = "0.0.0.0",
  listenPort = 0,
  advertiseHost = null,
  sidecarPath = null,
  hyperswarmLoader = loadHyperswarm,
}) {
  const token = config?.token;
  if (!token) return { ok: false, reason: t(M.mode.missingToken) };

  switch (mode) {
    case "broker": {
      if (!config.url) {
        return { ok: false, reason: t(M.mode.brokerNeedsUrl) };
      }
      return {
        ok: true,
        transport: createBrokerTransport({ url: toSocketUrl(config.url), token }),
      };
    }

    case "mesh": {
      const seeds = normalizeSeeds(config.seeds);
      if (!seeds.length) {
        // 不是致命错误,但要说清楚后果:没有种子的节点只能被动等待,
        // 自己发现不了任何人。
        return {
          ok: true,
          transport: createMeshTransport({ token, seeds, listenHost, listenPort, advertiseHost }),
          warning: t(M.mode.meshNoSeeds),
        };
      }
      return { ok: true, transport: createMeshTransport({ token, seeds, listenHost, listenPort, advertiseHost }) };
    }

    case "swim": {
      if (!sidecarAvailable(sidecarPath)) {
        return {
          ok: false,
          reason: t(M.mode.swimSidecarMissing),
        };
      }
      return {
        ok: true,
        transport: createSwimTransport({
          token,
          seeds: normalizeSeeds(config.seeds),
          sidecarPath,
          listenHost,
          listenPort,
          advertiseHost,
        }),
      };
    }

    case "hyperswarm": {
      if (!config.topic) {
        return {
          ok: false,
          reason: "hyperswarm 模式需要 topic(32 字节)。它由 punch URI 生成,先执行 /team create 或 /team join。",
        };
      }
      // 可选原生依赖缺失时明确失败,不拖垮其它模式。
      const dep = hyperswarmAvailable(hyperswarmLoader);
      if (!dep.ok) return { ok: false, reason: dep.reason };
      return {
        ok: true,
        transport: createHyperswarmTransport({
          topic: config.topic,
          token,
          HyperswarmImpl: dep.Hyperswarm,
        }),
      };
    }

    default:
      return { ok: false, reason: t(M.mode.unknown, { mode }) };
  }
}

/** seeds 可以写成字符串(逗号分隔)或数组 */
export function normalizeSeeds(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/** http(s) → ws(s),broker transport 内部需要 */
export function toSocketUrl(url) {
  return String(url).replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}

/**
 * 该模式的配置是否完整。给 /team 命令做提示用,不抛异常。
 */
export function modeReadiness(mode, config = {}, sidecarPath = null) {
  if (!config?.token) return { ready: false, reason: t(M.mode.missingToken) };
  switch (mode) {
    case "broker":
      return config.url
        ? { ready: true }
        : { ready: false, reason: t(M.mode.brokerNeedsUrlShort) };
    case "mesh":
      return normalizeSeeds(config.seeds).length
        ? { ready: true }
        : { ready: true, warning: t(M.mode.meshNoSeedsShort) };
    case "swim":
      return sidecarAvailable(sidecarPath)
        ? { ready: true }
        : { ready: false, reason: t(M.mode.swimSidecarNotFound) };
    case "hyperswarm":
      return config.topic
        ? { ready: true }
        : { ready: false, reason: "hyperswarm 模式需要 topic" };
    default:
      return { ready: false, reason: t(M.mode.unknownNoQuote, { mode }) };
  }
}
