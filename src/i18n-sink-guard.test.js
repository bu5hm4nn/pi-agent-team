/**
 * 用户可见文案的源头守卫。跑:node --test src/
 *
 * ── 守的是什么 ──
 *   src/*.js 和 index.ts 里**不允许**再出现新的硬编码中文文案:文案只
 *   允许待在 src/locales/*.js。用户可见的走 t(),会随 locale 变化;模型
 *   可见的(工具描述、注入的提示语)按当前决策保留中文,但必须在这个
 *   文件的白名单里显式登记并写明理由。
 *
 *   为什么不能用一条 grep 了事:中文注释和 JSDoc 遍地都是(grep 会把
 *   它们全抓出来)。所以先做词法扫描,把注释排除掉,只看字符串/模板
 *   字面量。注释里的中文永远不算。
 *
 * ── 白名单的规矩 ──
 *   每个条目都是**当前**保留中文的字面量,并按"为什么保留"分组,每组
 *   一条理由。新增中文文案若不在白名单里,测试就红 —— 要么把它抽到
 *   目录里,要么在这里登记理由。反过来,已经迁移掉的字面量必须从白
 *   名单删掉(下面的"过期条目"测试会逼你删)。
 *
 *   分组:
 *     - D1/backlog-20:模型可见的提示语/工具描述,按决策保留中文,
 *       本地化属于 story 20(改的是模型看到的行为,不是普通抽取)。
 *     - backlog-18:人类可见但尚未迁移的帮助/UI 文案(registerFlag
 *       描述、工具执行结果、ui.select/input 菜单),属于 story 18。
 *     - i18n 运行时诊断:控制台警告,不是渲染给用户的目录文案。
 *
 * ── 扫描器的边界 ──
 *   它只认字符串和模板字面量,不认正则字面量里的中文(仓库里没有这种
 *   写法,正则也遵循常见词法;真出现时不会误报,但也不会拦下来)。
 *   扫描匹配的是**源码原文**:`"\u4e2d\u6587"` 这类 unicode 转义写
 *   法的字面量,原文里根本没有 CJK 码点,会按检测方式本身直接绕过 ——
 *   这是已知边界,不是 bug;要拦得先解码转义,代价大于收益。
 *   另外正则字面量的起点靠前一个有效字符判断:紧跟 `)` 之后写的正则
 *   可能被判成除号,使词法器状态错位(仓库里没有这种写法)。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** CJK 范围:汉字、CJK 标点、全角形式。emoji 不在内,所以纯 emoji 标签不算文案。 */
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * 判断当前位置的 `/` 是正则字面量的开头还是除号。
 * 依据前一个有效字符:运算符/开括号后可以起正则;标识符/闭括号后是除号。
 *
 * @param {string} src
 * @param {number} i  `/` 的下标
 */
function regexCanStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  if ("([{,;:=!&|?+-*%^~<>".includes(src[j])) return true;
  const kw = /([A-Za-z_$][\w$]*)\s*$/.exec(src.slice(0, i));
  if (kw && ["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await"].includes(kw[1])) {
    return true;
  }
  return false;
}

/** 从 `/` 起跳过一个正则字面量,返回结束后的下标;正则内容不参与文案扫描。 */
function skipRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") break; // 不是合法正则,交给常规扫描
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    i++;
  }
  return i;
}

/**
 * 扫描一段源码,返回其中含 CJK 的字符串/模板字面量。
 * 注释(行注释、块注释、JSDoc)和正则字面量里的中文不会被返回。
 *
 * @param {string} source
 * @returns {{ line: number, kind: "string"|"template", text: string }[]}
 */
export function scanCjkLiterals(source) {
  const findings = [];
  const lineOf = (idx) => source.slice(0, idx).split("\n").length;
  // 词法状态栈:script 顶层;expr 模板里的 ${...};dq/sq 字符串;tpl 模板
  const stack = [{ t: "script" }];
  const record = (start, end, kind) => {
    const raw = source.slice(start, end);
    if (!CJK_RE.test(raw)) return;
    // 去掉定界符,并把空白归一化,白名单按这个文本比对
    const text = raw.slice(1, -1).replace(/\s+/g, " ").trim();
    findings.push({ line: lineOf(start), kind, text });
  };

  let i = 0;
  const n = source.length;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = source[i];
    const d = source[i + 1];

    if (top.t === "script" || top.t === "expr") {
      if (c === "/" && d === "/") {
        i += 2;
        while (i < n && source[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && d === "*") {
        i += 2;
        while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (c === "/" && regexCanStart(source, i)) {
        i = skipRegex(source, i);
        continue;
      }
      if (c === '"' || c === "'") {
        stack.push({ t: c === '"' ? "dq" : "sq", start: i });
        i++;
        continue;
      }
      if (c === "`") {
        stack.push({ t: "tpl", start: i });
        i++;
        continue;
      }
      if (top.t === "expr") {
        if (c === "{") {
          top.depth++;
          i++;
          continue;
        }
        if (c === "}") {
          if (top.depth === 0) {
            stack.pop();
            i++;
            continue;
          }
          top.depth--;
          i++;
          continue;
        }
      }
      i++;
      continue;
    }

    if (top.t === "dq" || top.t === "sq") {
      const q = top.t === "dq" ? '"' : "'";
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === q) {
        record(top.start, i + 1, "string");
        stack.pop();
        i++;
        continue;
      }
      i++;
      continue;
    }

    // tpl
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      record(top.start, i + 1, "template");
      stack.pop();
      i++;
      continue;
    }
    if (c === "$" && d === "{") {
      stack.push({ t: "expr", depth: 0 });
      i += 2;
      continue;
    }
    i++;
  }
  return findings;
}

// ---------------------------------------------------------------- 白名单

/** 文本 -> 保留理由;重复登记会在构造时报错,免得静默覆盖。 */
const ALLOWED = new Map();
function allow(reason, literals) {
  for (const l of literals) {
    if (ALLOWED.has(l)) throw new Error(`白名单重复登记:${JSON.stringify(l)}`);
    ALLOWED.set(l, reason);
  }
}

allow("i18n 运行时诊断(控制台警告),不是目录文案", [
  "i18n: 不支持的语言 \"${override}\",回退到 ${DEFAULT_LOCALE}",
  "i18n: 缺少消息键 \"${key}\"(locale ${current})",
  "i18n: 不支持的语言 \"${next}\",回退到 ${fallback}",
]);

allow("D1/backlog-20:模型可见的 buildPayload 脚手架按决策保留中文", [
  "你之前发给它的消息「${excerpt(cls.original, 120)}」",
  "你之前发出的消息",
  "[来自 ${from} 的 team 回复]\\n${text}\\n\\n---\\n",
  "上面是 teammate ${from} 对${quote}的回复(不是真人用户在打字)。",
  "你这一轮的输出【不会】自动回传给 ${from}。",
  "如果需要继续和它对话,显式调用 team_send;否则直接处理这条回复即可。",
  "[来自 ${from} 的 team 消息]\\n${text}\\n\\n---\\n",
  "上面是 teammate ${from} 发来的消息原文(不是真人用户在打字)。",
  "按内容本身的意思回应:是任务就执行,是讨论/诗句/提问就接着往下走。",
  "不要反问\"需要我做什么\",也不要复述确认。\\n",
  "你这一轮的输出【不会】自动回传给 ${from}。要回复它,显式调用",
  "team_send({ to: \"${from}\", text: \"...\" });它会和这条请求关联起来。",
  "不回复也可以 —— 需要收尾的话做一次就好。",
]);

allow("D1/backlog-20:注入给模型的提示语按决策保留中文", [
  "[系统] 你的消息没有送达 ${state.self}:注入失败(${reason})。请重发。",
  "[team 待回复]${who.join(\", \")} 之前发来的请求还没有回复。",
  "现在就回复它:team_send({ to: \"${who[0]}\", text: \"...\" })。",
  "如果本来就不需要回复,忽略这条即可。\\n\\n${payload}",
]);

allow("backlog-18:人类可见的帮助/UI 文案(执行结果、菜单),尚未迁移", [
  "群发给 ${n} 个节点?",
  "每个收件人都会跑一轮完整思考,消耗各自的 token。",
  "发送失败:${r.error}",
  "${r.lines.join(\" \")}。回执只表示对方 socket 收到了,不表示对方已处理完。",
  "失败:${r.error}",
  "Pi Agent Team:状态 / 成员 / 发送 / team 生命周期 / 标签",
  "默认组(全员)",
  "全员",
  "分组",
  "本机已有配置",
  "broker 地址",
  "本节点名(仅本次运行)",
  "标签,逗号分隔",
  "新 team 名",
  "小写字母数字",
  "(输入新的 team)",
  "加入哪个 team?",
  "team 名",
  "连接模式",
  "broker — 经一个中转进程(推荐,最省事)",
  "mesh — 节点直连,无中心",
  "swim — SWIM 管成员,节点直连投递",
  "种子地址(已在线节点的地址,可留空)",
  "host:gossip端口,留空 = 你是第一个节点",
  "host:端口,留空 = 你是第一个节点",
  "留空自动生成",
  "openssl rand -hex 32 生成的那个",
  "📋 查看成员",
  "✉️ 发消息给某个节点",
  "发给谁?",
  "发给 ${target.name}",
  "消息内容",
  "📢 群发",
  "@default — 默认组(${list.length} 个节点)",
  "* — 全员(${list.length} 个节点)",
  "@${l} — ${list.filter((m) => m.labels?.includes(l)).length} 个节点",
  "群发给哪一组?",
  "群发给 ${to}",
  "🏷️ 管理标签",
  "标签操作",
  "list — 查看当前标签",
  "add — 添加",
  "remove — 移除",
  "添加",
  "移除",
  "${action === \"add\" ? \"添加\" : \"移除\"}哪些标签?",
  "逗号分隔",
  "🔗 team 管理",
  "team 操作",
  "list — 列出本机已有 team",
  "join — 加入一个 team",
  "create — 创建一个 team",
  "leave — 离开当前 team",
  "🧭 连接模式 (当前:${currentMode})",
  "broker — 经一个中转进程,需要 URL",
  "mesh — 节点直连,需要种子地址",
  "swim — SWIM 管成员 + 直连投递,需要种子和边车",
  "🔔 回信策略 (当前:${state.reply})",
  "回信策略",
  "off — 不提醒,回不回由模型自己决定",
  "remind — 请求没被回复时提醒一次",
  "mirror — 每轮输出都镜像给所有节点(两边都开会互相刷屏)",
  "📊 状态",
]);

allow("backlog-18:registerFlag 帮助文案,尚未迁移", [
  "启动时加入的 team 名",
  "本节点的名字",
  "本节点的标签,逗号分隔",
  "投递模式:broker | mesh | swim",
  "mesh/swim 的种子地址,逗号分隔",
  "broker 模式的 URL(不读 team 配置)",
  "回信策略:off | remind | mirror",
]);

allow("D1/backlog-20:模型可见的 team_roster 执行结果按决策保留中文", [
  "\\n可用分组:${labels.map((l) => `@${l}`).join(\" \")}",
  "没有其他节点在线",
]);

allow("D1/backlog-20:模型可见的系统提示片段按决策保留中文", [
  "(无其他节点在线)",
  "(直接连接)",
  "你是多机 Pi 集群的一员。节点名 \\`${state.self}\\`,team \\`${currentTeam ?? \"(直接连接)\"}\\`,模式 \\`${mode}\\`。",
  "你的标签:${state.selfLabels.join(\", \")}",
  "在线节点:",
  "可用分组:${labels.map((l) => `@${l}`).join(\" \")}",
  "**发送**:调用 `team_send({ to, text })`。`to` 可以是节点名、`@label`(分组)、`\\\"*\\\"`(全员)、`\\\"@default\\\"`(默认组),或数组。",
  "**查成员**:调用 `team_roster()`,或 `team_info({ what: \\\"peers\\\" })`。",
  "**接收**:输入里出现 `[来自 <名字> 的 team 消息]` 前缀时,那是另一个 agent 发来的请求,不是真人打字。",
  "按内容本身的意思回应:是任务就执行,是讨论就接着走。不要反问「需要我做什么」。",
  "**回复要用 team_send** —— 你这一轮的输出不会自动回传。发给谁就是回复谁,不需要额外参数。",
  "不需要回复的(纯通知、寒暄)可以不管;系统最多提醒一次,不会反复打扰。",
  "**克制**:每次发送都占用对方一轮完整思考,群发更贵。除非任务需要,不要主动发消息。",
]);

allow("D1/backlog-20:模型可见的工具描述/参数文案按决策保留中文", [
  "给同一 team 里的其他 Pi 节点发消息,也用它回复收到的队友消息。to 可以是节点名、'@label' 分组、'*' 全员、'@default' 默认组,或逗号分隔的名字数组。名字从 team_roster 或系统提示的 Team 段落获取。",
  "team_send(to, text) — 给一个或一组 Pi 节点发消息(也是回复队友的方式)",
  "节点名、'@label'、'*'、'@default',或逗号分隔多收件人",
  "消息内容:背景、期望产出、验收标准一次说清",
  "列出在线节点及其所在机器和标签。用于按机器或标签挑选收件人,或确认谁在线。",
  "team_roster() — 列出在线节点与标签",
  "查看本节点在 team 里的状态:team 名、连接状态、broker、在线数量、回信提醒模式。",
  "team_info() — 查看 team 状态",
  "'status'(默认)或 'peers'",
  "加入一个 team 并连接。team 已在本机配置里时只需 team 名;首次加入需要 token,以及 url(broker 模式)或 seeds(mesh/swim)。",
  "改 mode 或 seeds 也用它 —— 已有的 url/token 会保留,不会被清掉。",
  "team_join(team, token?, url?, mode?, seeds?, name?, labels?, port?) — 加入或重新配置 team",
  "team 名(小写字母数字)",
  "team token,首次加入时必需",
  "broker 地址,broker 模式必需,例如 http://100.64.0.1:8787",
  "投递模式。broker(默认)经中转;mesh/swim 节点直连,需要 seeds",
  "mesh/swim 的种子地址,形如 100.64.0.1:19801",
  "本节点名。只影响本次运行,不写入配置",
  "本节点标签,供 @label 群发",
  "mesh/swim 的监听端口。只影响本次运行。0 = 让内核分配(默认)",
  "mesh/swim 的监听地址,默认 0.0.0.0。只影响本次运行",
  "离开当前 team:断开连接并删除本机配置。不影响 broker 或其它节点。",
  "team_leave(team?) — 离开 team",
  "要离开的 team 名,省略则离开当前",
  "管理本节点的标签,用于被别人按 @label 群发。add/remove 会重连 broker(标签是 broker 侧的分组依据)。",
  "team_label(action, labels?) — 管理本节点标签",
  "'list'、'add' 或 'remove'",
  "逗号分隔的标签名",
]);

// ---------------------------------------------------------------- 源码清单

/**
 * 递归列出 src/ 下该扫的源文件(相对仓库根),外加 index.ts。
 * 排除:测试文件、src/messages.js(键注册表)、src/locales/(文案的唯一归属)。
 *
 * @param {string} absDir
 * @param {string} prefix
 * @returns {string[]}
 */
function listSources(absDir, prefix = "src") {
  const out = [];
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    const rel = `${prefix}/${name}`;
    if (statSync(abs).isDirectory()) {
      if (name === "locales") continue;
      out.push(...listSources(abs, rel));
    } else if (name.endsWith(".js") && !name.endsWith(".test.js") && name !== "messages.js") {
      out.push(rel);
    }
  }
  return out;
}

const SOURCES = [...listSources(join(ROOT, "src")), "index.ts"];

/** 扫全部源文件,返回 { file, line, kind, text }。 */
function scanAllSources() {
  const findings = [];
  for (const rel of SOURCES) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    for (const f of scanCjkLiterals(src)) findings.push({ file: rel, ...f });
  }
  return findings;
}

// ---------------------------------------------------------------- 测试

test("守卫:src 与 index.ts 里没有白名单之外的 CJK 文案", () => {
  const offenders = scanAllSources().filter((f) => !ALLOWED.has(f.text));
  const detail = offenders
    .map((f) => `  ${f.file}:${f.line}  [${f.kind}]  ${JSON.stringify(f.text)}`)
    .join("\n");
  assert.deepEqual(
    offenders,
    [],
    `发现未登记的 CJK 字面量。用户可见的请改用 t()(文案进 src/locales/);` +
      `模型可见且按决策保留中文的,请在 src/i18n-sink-guard.test.js 的白名单里登记并写明理由:\n${detail}`,
  );
});

test("守卫:白名单没有过期条目(已迁移的字面量必须删掉)", () => {
  const seen = new Set(scanAllSources().map((f) => f.text));
  const stale = [...ALLOWED.keys()].filter((t) => !seen.has(t));
  const detail = stale.map((t) => `  ${JSON.stringify(t)}`).join("\n");
  assert.deepEqual(stale, [], `这些白名单条目在源码里已经找不到了,请删除:\n${detail}`);
});

test("守卫自检:注释被忽略,字符串与模板被识别", () => {
  const src = [
    "// 这行注释里的中文不该算",
    "/* 块注释里的中文",
    "   也不该算 */",
    "const a = \"中文字符串\";",
    "const b = `中文模板 ${x}`;",
    "const c = \"english only\"; // 尾部注释里的中文不该算",
    "const d = /正则里的中文/;",
  ].join("\n");

  const found = scanCjkLiterals(src)
    .map((f) => `${f.kind}:${f.text}`)
    .sort();
  assert.deepEqual(found, ["string:中文字符串", "template:中文模板 ${x}"].sort());
});

test("守卫自检:临时塞进一个中文文案会被抓出来", () => {
  // 固定"守卫真的是守卫":用一个合成源码片段代替改真实文件。
  const synthetic = ["export function f() {", '  return "临时中文提示";', "}"].join("\n");
  const found = scanCjkLiterals(synthetic);
  assert.equal(found.length, 1);
  assert.equal(found[0].text, "临时中文提示");
  assert.equal(ALLOWED.has(found[0].text), false, "这个文案不在白名单里,守卫必须报红");
});
