/**
 * Team 成员关系的持久化 —— 版本化 schema + 按分支顺序归约的纯逻辑。
 *
 * ── 为什么需要它 ──
 *   Pi 的 session 是树;`/reload`、`/resume`、`/fork` 之后内存里的连接
 *   状态全没了。用户不得不在每次重载后重新 `/team join`。这里把"加入
 *   了哪个 team、以什么身份(名字/标签/监听选项)"记成 custom 条目
 *   (`pi.appendEntry`,不进 LLM 上下文),在 session_start / session_tree
 *   时从当前分支重建。
 *
 * ── 为什么不直接持久化整个运行时状态 ──
 *   凭据(token/topic)永远来自本机已有的 team 配置(~/.pi/agent/
 *   pi-agent-team/<team>.json,0600),**绝不**进这里。条目里只有
 *   非秘密信息:team 名、节点名、标签、监听 host/port。这样 session
 *   文件可以随便备份/分享,不会泄漏任何能力凭证。
 *
 * ── 为什么 leave 要带 joinId ──
 *   只用 join/leave 两种事件、并且"最后一条 join 生效"还不够。考虑
 *   一条在 join B 之后才到达(或从别处重放)的陈旧 leave A:如果 leave
 *   只带 team 名或不带引用,它会把 B 也关掉。所以:
 *     - join 有自己的唯一 id(UUID),就是这次成员关系的身份;
 *     - leave 有自己的唯一事件 id,并用 joinId 指明它关闭的是哪一次 join;
 *     - 归约器只在该 joinId 正好等于当前 active join 的 id 时才关闭它。
 *
 *   还原时**不**追加 join:身份沿用被还原的那条记录,reload 不会造出
 *   新的 join 身份,也不会让分支无限增长。
 *
 * ── 有意的非目标 ──
 *   不做通用事件框架。这里只有两种事件、一条顺序归约,坏记录一律跳过。
 */

import { randomUUID } from "node:crypto";

/** custom 条目的 customType;index.ts 与 reducer 必须是同一个值 */
export const MEMBERSHIP_TYPE = "team-membership";

/** 当前 schema 版本。不认识的值一律忽略(向前兼容)。 */
export const MEMBERSHIP_VERSION = 1;

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
const isNullableString = (v) => v === null || typeof v === "string";

/** join 记录是否合法(结构完整、版本已知) */
function isJoin(d) {
  return (
    !!d &&
    typeof d === "object" &&
    d.v === MEMBERSHIP_VERSION &&
    d.kind === "join" &&
    isNonEmptyString(d.id) &&
    isNullableString(d.team) &&
    typeof d.name === "string" &&
    Array.isArray(d.labels) &&
    d.labels.every((l) => typeof l === "string") &&
    !!d.listen &&
    typeof d.listen === "object" &&
    isNullableString(d.listen.host) &&
    (d.listen.port === null || (typeof d.listen.port === "number" && Number.isFinite(d.listen.port))) &&
    typeof d.at === "string"
  );
}

/** leave 记录是否合法 */
function isLeave(d) {
  return (
    !!d &&
    typeof d === "object" &&
    d.v === MEMBERSHIP_VERSION &&
    d.kind === "leave" &&
    isNonEmptyString(d.id) &&
    isNonEmptyString(d.joinId) &&
    isNullableString(d.team) &&
    typeof d.at === "string"
  );
}

/** 记录是否是本模块认识的 join/leave */
export function isValidRecord(data) {
  return isJoin(data) || isLeave(data);
}

/**
 * 构造一条 join 记录。
 *
 * team 可以是 null:用显式 url+token / 环境变量直连(没有 team 名)时
 * 也会记录,但那种连接没有本地配置可读,还原时只能安全失败并提示。
 */
export function makeJoinRecord({ team = null, name = "", labels = [], listen = {}, at = null } = {}) {
  return {
    v: MEMBERSHIP_VERSION,
    kind: "join",
    id: randomUUID(),
    team: team ?? null,
    name: typeof name === "string" ? name : "",
    labels: Array.isArray(labels) ? labels.filter((l) => typeof l === "string") : [],
    listen: {
      host: typeof listen?.host === "string" ? listen.host : null,
      port: typeof listen?.port === "number" && Number.isFinite(listen.port) ? listen.port : null,
    },
    at: at ?? new Date().toISOString(),
  };
}

/** 构造一条 leave 记录:自己的事件 id + 它关闭的 joinId */
export function makeLeaveRecord({ joinId = "", team = null, at = null } = {}) {
  return {
    v: MEMBERSHIP_VERSION,
    kind: "leave",
    id: randomUUID(),
    // 不用 String(joinId):那会把 undefined/null 变成 "undefined"/"null",
    // 看起来像合法引用。非字符串就落成空,让 isLeave 判为不合法,归约器直接跳过。
    joinId: typeof joinId === "string" ? joinId : "",
    team: team ?? null,
    at: at ?? new Date().toISOString(),
  };
}

/**
 * 按分支顺序归约出仍然生效的 join,没有则返回 null。
 *
 * 规则(每条都有测试钉住):
 *   - join 生效并覆盖更早的 join(标签/模式变更后的新 join 就是最新身份)
 *   - leave 只关闭 joinId 与当前 active.id 相同的那个 join
 *   - 关不掉的 leave(陈旧、未匹配、先于任何 join)是空操作
 *   - 不是本扩展的 custom 条目、版本不认识、结构损坏 → 跳过
 *
 * @param {Array<{type?: string, customType?: string, data?: unknown}>} entries 当前分支(root → leaf)
 * @returns {object|null} 生效的 join 记录
 */
export function reduceMembership(entries) {
  if (!Array.isArray(entries)) return null;

  let active = null;
  for (const entry of entries) {
    if (!entry || entry.type !== "custom" || entry.customType !== MEMBERSHIP_TYPE) continue;
    const d = entry.data;
    if (isJoin(d)) {
      active = d;
      continue;
    }
    if (isLeave(d) && active && d.joinId === active.id) active = null;
  }
  return active;
}
