/**
 * 连接选项:解析、合并、校验。
 *
 * ── 为什么要单独一个模块 ──
 *   同一组选项有三个入口(环境变量 / /team 命令 / team_join 工具),
 *   如果各写一份解析,它们迟早会分叉 —— 命令能设的选项工具设不了,
 *   或者两处对同一个值的校验不一致。所以解析和校验只在这里做一次。
 *
 * ── 两类选项,生命周期不同 ──
 *
 *   team 级(写进 ~/.pi/agent/pi-agent-team/<team>.json):
 *     url      broker 地址
 *     token    认证
 *     mode     broker | mesh | swim | hyperswarm
 *     seeds    mesh/swim 的种子地址
 *     topic    hyperswarm 的 32 字节 DHT 能力凭证(base64url)
 *
 *   另外 `punch` 是一个输入别名(不落盘):它展开成 mode/topic/token。
 *
 *   session 级(只在本次运行有效,不落盘):
 *     name     节点名
 *     labels   本节点标签
 *     port     mesh/swim 的监听端口
 *     listen   mesh/swim 的监听地址
 *
 *   为什么这些不落盘:一台机器上可以同时跑几个 Pi,每个是一个独立
 *   节点,它们共用同一个 team 配置文件。
 *     name  存进去 → 第二个 agent 启动时覆盖第一个的名字,而名字就是身份
 *     port  存进去 → 第二个 agent 监听同一个端口,EADDRINUSE 起不来
 */

import { MODES } from "./mode.js";
import { t } from "./i18n.js";
import { M } from "./messages.js";
import { validateTeamName, validateTopic } from "./team-config.js";

/** team 级选项 → 落盘字段名 */
const TEAM_KEYS = new Set(["url", "token", "mode", "seeds", "topic"]);
/** session 级选项 → 只影响本次运行 */
const SESSION_KEYS = new Set(["name", "labels", "port", "listen"]);
/**
 * 输入别名:既不是 team 配置也不是 session 配置,由一个值展开成多个字段。
 * `punch` 展开成 mode/topic/token,所以它不落盘 —— 落盘的是展开后的字段。
 */
const INPUT_KEYS = new Set(["punch"]);

export const ALL_KEYS = [...TEAM_KEYS, ...SESSION_KEYS, ...INPUT_KEYS];

/**
 * 解析 punch URI:`punch://<name>/<topic>/<token>`。
 *
 * 格式由 backlog/02 与决策 punch-uri-two-secrets-no-host-key 固定:
 *   <name>   非秘密的房间标签,复用 team 名校验
 *   <topic>  32 字节能力凭证(base64url)
 *   <token>  team token
 *
 * 唯一入口:任何看起来像 URI 的字符串都先过这里。方案不对或字段不合法
 * 一律返回 { ok:false, reason },调用方据此拒绝 —— **绝不**把它降级成
 * team 名或种子,否则一个手误的 URI 会变成“加入了一个叫 punch://… 的
 * team”或者一个畸形的种子地址。
 *
 * @returns {{ ok:true, name:string, topic:string, token:string } | { ok:false, reason:string }}
 */
export function parsePunchUri(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, reason: "punch URI 为空" };
  // 方案必须**正好**是小写 punch:。写成 PUNCH:// 或 http:// 都不认 ——
  // 宽松匹配会让一个外来的 URI 静默通过。
  if (!raw.startsWith("punch:")) {
    return { ok: false, reason: `不是 punch URI(应以 punch:// 开头),实际 "${raw}"` };
  }
  const m = /^punch:\/\/([^/]+)\/([^/]+)\/([^/?#\s]+)$/.exec(raw);
  if (!m) {
    return { ok: false, reason: "punch URI 应写成 punch://<team>/<topic>/<token>" };
  }
  const [, name, topic, token] = m;

  const nt = validateTeamName(name);
  if (!nt.ok) return { ok: false, reason: `team 名不合法:${nt.reason}` };

  const tt = validateTopic(topic);
  if (!tt.ok) return { ok: false, reason: `topic 不合法:${tt.reason}` };

  // token 规则与 --token 一致(至少 16 位);额外要求不含路径分隔符,
  // 否则 URI 会被切错段。
  if (token.length < 16) return { ok: false, reason: "token 太短(至少 16 位)" };

  return { ok: true, name, topic, token };
}

/** 生成规范的 punch URI 字符串。topic 接受 base64url 字符串或 32 字节 Buffer。 */
export function buildPunchUri({ name, topic, token } = {}) {
  const t =
    topic instanceof Uint8Array || Buffer.isBuffer(topic)
      ? Buffer.from(topic).toString("base64url")
      : String(topic);
  return `punch://${name}/${t}/${token}`;
}

/**
 * 从环境变量解析 TEAM_PUNCH。脚本/容器的一条命令加入就靠它。
 * 返回 null 表示没设;否则是 parsePunchUri 的结果。
 */
export function punchFromEnv(env = process.env) {
  const raw = env?.TEAM_PUNCH;
  if (raw == null || raw === "") return null;
  return parsePunchUri(raw);
}

/**
 * 解析 `--key value` / `--key=value` / `key=value` 混排的参数。
 *
 * 位置参数(不以 -- 开头且不带 =)原样留在 rest 里,让调用方按位置
 * 语义处理 —— /team join 的第一个位置参数是 team 名。
 *
 * @returns {{ values: Record<string,string>, rest: string[], unknown: string[] }}
 */
export function parseOptionArgs(args = []) {
  const values = {};
  const rest = [];
  const unknown = [];

  for (let i = 0; i < args.length; i++) {
    const raw = String(args[i] ?? "");
    if (!raw) continue;

    let key = null;
    let val = null;

    if (raw.startsWith("--")) {
      const body = raw.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        key = body.slice(0, eq);
        val = body.slice(eq + 1);
      } else {
        key = body;
        // 下一个参数是值,除非它本身是另一个选项
        const next = args[i + 1];
        if (next !== undefined && !String(next).startsWith("--")) {
          val = String(next);
          i++;
        } else {
          val = "";
        }
      }
    } else if (raw.includes("=") && !raw.startsWith("@")) {
      const eq = raw.indexOf("=");
      key = raw.slice(0, eq);
      val = raw.slice(eq + 1);
    } else {
      rest.push(raw);
      continue;
    }

    key = key.trim().toLowerCase();
    if (!ALL_KEYS.includes(key)) {
      unknown.push(key);
      continue;
    }
    values[key] = String(val).trim();
  }

  return { values, rest, unknown };
}

/** seeds 接受 "a:1,b:2" 或数组 */
export function parseSeeds(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/** labels 同理 */
export function parseLabels(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * 校验并规范化解析出来的选项。
 *
 * @returns {{ ok: true, team: object, session: object } | { ok: false, reason: string }}
 */
export function validateOptions(values = {}) {
  const team = {};
  const session = {};
  let punchName;

  // punch 先展开,后面的显式选项就能覆盖它 —— TEAM_TOKEN/TEAM_MODE 是
  // 可选覆盖,而不是第二个必填项(URI 已经带着 token 了)。
  if (values.punch != null && values.punch !== "") {
    const p = parsePunchUri(values.punch);
    if (!p.ok) return { ok: false, reason: `punch URI 无效:${p.reason}` };
    team.mode = "hyperswarm";
    team.topic = p.topic;
    team.token = p.token;
    punchName = p.name;
  }

  for (const [k, v] of Object.entries(values)) {
    if (v === "") continue; // 空值 = 没给,不要清掉已有配置
    if (k === "punch") continue; // 已在上面展开

    if (k === "url") {
      if (!/^(https?|wss?):\/\//.test(v)) {
        return { ok: false, reason: t(M.options.urlInvalid, { value: v }) };
      }
      team.url = v;
    } else if (k === "token") {
      if (v.length < 16) return { ok: false, reason: t(M.options.tokenTooShort) };
      team.token = v;
    } else if (k === "topic") {
      const tt = validateTopic(v);
      if (!tt.ok) return { ok: false, reason: tt.reason };
      team.topic = v;
    } else if (k === "mode") {
      if (!MODES.includes(v)) {
        return { ok: false, reason: t(M.options.modeInvalid, { modes: MODES.join(" / "), value: v }) };
      }
      team.mode = v;
    } else if (k === "seeds") {
      const seeds = parseSeeds(v);
      if (!seeds.length) return { ok: false, reason: t(M.options.seedsEmpty) };
      for (const s of seeds) {
        if (!/^[^\s:]+:\d{1,5}$/.test(s)) {
          return { ok: false, reason: t(M.options.seedInvalid, { seed: s }) };
        }
      }
      team.seeds = seeds;
    } else if (k === "name") {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v)) {
        return { ok: false, reason: t(M.options.nameInvalid, { value: v }) };
      }
      session.name = v;
    } else if (k === "port") {
      const port = Number(v);
      // 0 合法:交给内核分配。/team status 会报出实际端口。
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return { ok: false, reason: t(M.options.portInvalid, { value: v }) };
      }
      session.port = port;
    } else if (k === "listen") {
      // 不做严格 IP 校验:主机名和 IPv6 都合法,交给 listen() 去报错更准
      if (/\s/.test(v)) return { ok: false, reason: t(M.options.listenInvalid, { value: v }) };
      session.listen = v;
    } else if (k === "labels") {
      const labels = parseLabels(v);
      // 上限和 broker / 成员表一致,免得本机接受了而别人看不到
      if (labels.length > 8) return { ok: false, reason: t(M.options.labelsTooMany, { count: labels.length }) };
      session.labels = labels;
    }
  }

  const out = { ok: true, team, session };
  // 只在真的给了 punch URI 时带上名字,供调用方知道该加入哪个 team
  if (punchName !== undefined) out.punch = { name: punchName };
  return out;
}

/**
 * 模式相关的必填项检查。
 *
 * 放在这里而不是各个入口里,原因和解析一样:三个入口必须给出
 * 完全相同的判断,否则"命令能连上、工具连不上"这种问题会反复出现。
 */
export function checkModeRequirements({ mode, url, seeds, token, topic }) {
  if (!token) return { ok: false, reason: t(M.options.missingToken) };

  if (mode === "broker") {
    if (!url) {
      return { ok: false, reason: t(M.options.brokerNeedsUrl) };
    }
    return { ok: true };
  }

  if (mode === "hyperswarm") {
    // topic 是 DHT 能力凭证,没有它无法加入房间。它由 /team create 生成
    // 或由 punch URI 携带;这里不做种子提示 —— hyperswarm 没有种子。
    if (!topic) {
      return {
        ok: false,
        reason: "hyperswarm 模式需要 topic(32 字节 base64url)。用 /team create 自动生成,或 /team join <punch URI> 携带它。",
      };
    }
    return { ok: true };
  }

  if (!seeds?.length) {
    // 不是错误,但后果要说清楚:没有种子的节点只能等别人连它
    return {
      ok: true,
      warning: t(M.options.meshNoSeeds, { mode }),
    };
  }
  return { ok: true };
}

/**
 * 给 /team status 和帮助信息用的一行说明。
 *
 * 做成函数而不是模块常量:常量在 import 时就冻住了,而 locale 是
 * 启动期才 setLocale 选定的 —— 冻住的常量拿不到后选的 locale。
 */
export function optionHelp() {
  return t(M.options.help);
}
