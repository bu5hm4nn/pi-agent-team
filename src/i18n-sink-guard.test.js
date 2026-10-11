/**
 * 文案源头守卫:用户与模型可见的 authored 字面量都必须走目录。
 * 注释/JSDoc、测试、目录和 opaque payload 不作为待翻译文本。
 * 词法扫描器忽略注释与正则;unicode 转义与复杂正则仍是已知边界。
 * 唯一白名单为不注入模型的 i18n 控制台诊断。
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
      `模型可见文案也必须使用目录:\n${detail}`,
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
