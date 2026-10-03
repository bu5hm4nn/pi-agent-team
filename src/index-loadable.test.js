/**
 * index.ts 可加载性守卫。
 *
 * 背景:一次 rebase 在 index.ts 里留下了一行重复的 import,整个文件成了
 * SyntaxError。Pi 加载扩展直接失败,而 npm test 全绿 —— 因为仓库里没有
 * 任何测试 import 或 parse index.ts。这个测试补上这一格。
 *
 * ── 为什么不用 `node --check --experimental-strip-types index.ts` ──
 * 实测(Node 24):`node --check <文件>` 对 ESM 文件是空操作。只要文件里
 * 出现 import/export,Node 判定为 ES 模块后就不再对它做语法检查,直接以
 * 0 退出 —— 哪怕文件是坏的。仓库根有 "type": "module"、index.ts 全是
 * import/export,所以那条命令对着这个问题只会给出假绿。
 *
 * 可靠做法分两步,顺序和 Node 真正加载 .ts 时一致:
 *   1. 用 node:module 的 stripTypeScriptTypes 去掉类型(这一步本身会在
 *      类型语法坏掉时抛错);
 *   2. `node --check --input-type=module` 从 stdin 读去类型后的 ESM 源码,
 *      这一步做真正的解析 —— 语法错误、重复声明都逃不掉。
 *
 * 全程不执行 index.ts,也不解析它 import 的 Pi 运行时:只证明它可解析。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "index.ts");

/** 对一段 ESM 源码做语法检查,返回 spawnSync 的结果。 */
function checkModule(source) {
  return spawnSync(process.execPath, ["--check", "--input-type=module"], {
    input: source,
    encoding: "utf8",
  });
}

/**
 * 探测本机 Node 是否具备做这件事的能力(去类型 + ESM 语法检查)。
 * 缺能力时干净地 skip,而不是把一个环境问题报成 index.ts 的故障。
 */
function probe() {
  if (typeof stripTypeScriptTypes !== "function") {
    return { ok: false, why: "node:module.stripTypeScriptTypes 不可用(Node < 22.13?)" };
  }
  try {
    stripTypeScriptTypes("const n: number = 1;\n", { mode: "strip" });
  } catch (err) {
    return { ok: false, why: `stripTypeScriptTypes 探测失败:${err.message}` };
  }
  const r = checkModule("export const n = 1;\n");
  if (r.error) return { ok: false, why: `无法运行 ${process.execPath}:${r.error.message}` };
  if (r.status !== 0) return { ok: false, why: `--check --input-type=module 探测失败:${r.stderr.trim()}` };
  return { ok: true };
}

const supported = probe();

test("index.ts 能被解析 —— 否则 Pi 加载扩展会直接失败", (t) => {
  if (!supported.ok) {
    t.skip(`本环境无法验证 index.ts 可解析性:${supported.why}`);
    return;
  }

  const source = readFileSync(INDEX, "utf8");

  // 第一步:去类型。mode "strip" 与 Node 加载 .ts 的默认行为一致(不做
  // enum/namespace 变换);需要变换的写法在真实加载时同样会失败,这里
  // 如实报错,不掩盖。
  let stripped;
  try {
    stripped = stripTypeScriptTypes(source, { mode: "strip" });
  } catch (err) {
    assert.fail(`index.ts 去类型阶段就报错,Pi 加载扩展会失败:\n${err.message}`);
  }

  // 第二步:对去类型后的 ESM 源码做真正的语法检查。
  const r = checkModule(stripped);
  assert.equal(
    r.status,
    0,
    "index.ts 无法被解析,Pi 加载这个扩展会直接失败。\n" +
      `解析器输出:\n${(r.stderr || r.error?.message || "(无输出)").trim()}`,
  );
});

test("守卫本身有效:合成的坏模块必须被判失败,否则是假绿", (t) => {
  // 这条守的是上面那条测试的机制,不是 index.ts。因为 Node 的 --check
  // 对 ESM 文件会静默放行,一旦有人把上面的实现"简化"回按文件路径检查,
  // 这条会立刻戳破假绿。
  if (!supported.ok) {
    t.skip(`本环境无法验证:${supported.why}`);
    return;
  }
  const r = checkModule("export const x = 1 +;\n");
  assert.notEqual(r.status, 0, "守卫没有检测出合成语法错误 —— 它会给 index.ts 假绿");
});
