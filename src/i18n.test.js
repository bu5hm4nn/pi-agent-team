/**
 * i18n 机制测试。跑:node --test src/
 *
 * 守三件事:
 *   1. locale 判定链的顺序、POSIX 规范化、别名与回退 —— 默认必须是英文,
 *      只有肯定的 zh* 才选中文目录。
 *   2. t() 的插值、复数、缺键回退与"每个键只警告一次"。
 *   3. 目录完整性:两个目录键集一致、占位符一致;M 与目录双向可达
 *      (没有孤儿键,也没有 M 到不了的目录键)。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { t, setLocale, getLocale, resolveLocale, createTranslator } from "./i18n.js";
import { M } from "./messages.js";
import { enUS } from "./locales/en-US.js";
import { zhHans } from "./locales/zh-Hans.js";

/** 临时替换 console.warn,收集输出后还原。 */
function captureWarn(fn) {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warns;
}

// ---------------------------------------------------------------- resolveLocale

test("resolveLocale:默认是 en-US(没有任何信号时)", () => {
  assert.equal(resolveLocale({}, {}), "en-US");
});

test("resolveLocale:链的顺序 --team-lang > TEAM_LANG > config.lang", () => {
  // 全给上,最前面的赢
  assert.equal(
    resolveLocale({ teamLang: "zh-Hans", TEAM_LANG: "en-US" }, { lang: "en-US" }),
    "zh-Hans",
    "--team-lang 应压过 TEAM_LANG",
  );
  assert.equal(
    resolveLocale({ TEAM_LANG: "zh-Hans" }, { lang: "en-US" }),
    "zh-Hans",
    "TEAM_LANG 应压过 config.lang",
  );
  assert.equal(
    resolveLocale({}, { lang: "zh-Hans" }),
    "zh-Hans",
    "config.lang 应压过 shell 探测",
  );
});

test("resolveLocale:链的顺序 config.lang > LC_ALL > LC_MESSAGES > LANG", () => {
  assert.equal(
    resolveLocale({ LC_ALL: "zh_CN", LC_MESSAGES: "en_US", LANG: "en_US" }, { lang: "zh-Hans" }),
    "zh-Hans",
  );
  assert.equal(
    resolveLocale({ LC_ALL: "zh_CN", LC_MESSAGES: "en_US", LANG: "en_US" }, {}),
    "zh-Hans",
    "LC_ALL 应压过 LC_MESSAGES 和 LANG",
  );
  assert.equal(
    resolveLocale({ LC_MESSAGES: "zh_CN", LANG: "en_US" }, {}),
    "zh-Hans",
    "LC_MESSAGES 应压过 LANG",
  );
  assert.equal(resolveLocale({ LANG: "zh_CN" }, {}), "zh-Hans", "LANG 在没有更高优先级时生效");
});

test("resolveLocale:都没有时看 Intl", () => {
  const intl = Intl.DateTimeFormat().resolvedOptions().locale;
  const expected = intl.toLowerCase().startsWith("zh") ? "zh-Hans" : "en-US";
  assert.equal(resolveLocale({}, {}), expected);
});

test("resolveLocale:POSIX 规范化(编码与 @modifier, C/POSIX 视为 en)", () => {
  assert.equal(resolveLocale({ LANG: "zh_CN.UTF-8" }, {}), "zh-Hans");
  assert.equal(resolveLocale({ LANG: "zh_CN.UTF-8@euro" }, {}), "zh-Hans");
  assert.equal(resolveLocale({ LANG: "en_US.UTF-8" }, {}), "en-US");
  assert.equal(resolveLocale({ LANG: "C" }, {}), "en-US");
  assert.equal(resolveLocale({ LANG: "POSIX" }, {}), "en-US");
  assert.equal(resolveLocale({ LANG: "C.UTF-8" }, {}), "en-US");
});

test("resolveLocale:zh* 都选 zh-Hans(含 zh-Hant 降级)", () => {
  for (const raw of ["zh", "zh-CN", "zh-Hans", "zh-Hant", "zh-TW", "zh_CN.UTF-8"]) {
    assert.equal(resolveLocale({ LANG: raw }, {}), "zh-Hans", `${raw} 应选 zh-Hans`);
  }
});

test("resolveLocale:en* / 未设 / 未知语言都选 en-US", () => {
  for (const raw of ["en", "en-US", "en_GB.UTF-8"]) {
    assert.equal(resolveLocale({ LANG: raw }, {}), "en-US", `${raw} 应选 en-US`);
  }
  assert.equal(resolveLocale({}, {}), "en-US", "未设应选 en-US");
  assert.equal(resolveLocale({ LANG: "" }, {}), "en-US", "空串应选 en-US");
  assert.equal(resolveLocale({ LANG: "fr_FR.UTF-8" }, {}), "en-US", "未知语言应选 en-US");
  assert.equal(resolveLocale({ LANG: "de-DE" }, {}), "en-US", "未知语言应选 en-US");
});

test("resolveLocale:显式覆盖不支持的语言会警告并回退 en-US", () => {
  const warns = captureWarn(() => {
    assert.equal(resolveLocale({ TEAM_LANG: "fr-FR" }, {}), "en-US");
  });
  assert.ok(warns.some((w) => w.includes("fr-FR")), `应警告不支持的语言,实际:${warns.join(" | ")}`);

  const warns2 = captureWarn(() => {
    assert.equal(resolveLocale({}, { lang: "de-DE" }), "en-US");
  });
  assert.ok(warns2.some((w) => w.includes("de-DE")), "config.lang 的显式覆盖也应警告");

  // 显式覆盖命中后不再往下看:即使 shell 是 zh,也要回退 en-US
  const warns3 = captureWarn(() => {
    assert.equal(resolveLocale({ TEAM_LANG: "fr-FR", LC_ALL: "zh_CN" }, {}), "en-US");
  });
  assert.ok(warns3.length > 0, "显式覆盖未命中时不应继续探测 shell");
});

// ---------------------------------------------------------------- t()

test("t():插值 {name}", () => {
  setLocale("en-US");
  assert.equal(t(M.notify.greeting, { name: "Ada" }), "Hello, Ada");
  setLocale("zh-Hans");
  assert.equal(t(M.notify.greeting, { name: "Ada" }), "你好,Ada");
});

test("t():缺参数时占位符原样留着", () => {
  setLocale("en-US");
  assert.equal(t(M.notify.greeting, {}), "Hello, {name}");
  assert.equal(t(M.notify.greeting), "Hello, {name}");
});

test("t():按 Intl.PluralRules 选 _one / _other", () => {
  setLocale("en-US");
  assert.equal(t(M.notify.files, { count: 1 }), "1 file");
  assert.equal(t(M.notify.files, { count: 2 }), "2 files");
  assert.equal(t(M.notify.files, { count: 0 }), "0 files");

  // 中文只有 other 范畴,_one 和 _other 是同一个值
  setLocale("zh-Hans");
  assert.equal(t(M.notify.files, { count: 1 }), "1 个文件");
  assert.equal(t(M.notify.files, { count: 2 }), "2 个文件");
});

test("复数守卫:M 里带 {count} 的键在 count=1/5 下都解析成文案(不吐裸键)", () => {
  const leaves = [];
  const walk = (obj) => {
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v);
      else leaves.push(v);
    }
  };
  walk(M);

  const hasCount = (v) => typeof v === "string" && v.includes("{count}");
  const countKeys = leaves.filter(
    (base) => hasCount(enUS[base]) || hasCount(enUS[`${base}_one`]) || hasCount(enUS[`${base}_other`]),
  );

  // 前置条件:已知的三个复数键必须在列,否则守卫本身没覆盖到目标。
  assert.ok(countKeys.includes(M.tool.moreLines), "tool.moreLines 应带 {count}");
  assert.ok(countKeys.includes(M.tool.cardMoreLines), "tool.cardMoreLines 应带 {count}");
  assert.ok(countKeys.includes(M.notify.files), "notify.files 应带 {count}");

  for (const locale of ["en-US", "zh-Hans"]) {
    setLocale(locale);
    for (const base of countKeys) {
      for (const count of [1, 5]) {
        const out = t(base, { count });
        assert.ok(
          !out.startsWith(base) && !out.startsWith("tool.") && !out.startsWith("notify."),
          `${locale}: t(${base}, { count: ${count} }) 返回了裸键:${out}`,
        );
        assert.ok(out.includes(String(count)), `${locale}: t(${base}, { count: ${count} }) 应插值 count`);
      }
    }
  }
  setLocale("en-US");
});

test("t():getLocale/setLocale 作用于单例", () => {
  setLocale("zh-Hans");
  assert.equal(getLocale(), "zh-Hans");
  setLocale("en-US");
  assert.equal(getLocale(), "en-US");
});

test("t():缺键先回退 en-US,再回退键本身", () => {
  const tr = createTranslator({
    locale: "zh-Hans",
    catalogs: {
      "en-US": { "only.en": "English only" },
      "zh-Hans": {},
    },
    warn: () => {},
  });
  assert.equal(tr.t("only.en"), "English only", "当前目录缺、en 有 → 用 en 的值");
  assert.equal(tr.t("nowhere.key"), "nowhere.key", "两边都缺 → 用键本身");
});

test("t():缺键每个键只警告一次(dev/test)", () => {
  const warns = [];
  const tr = createTranslator({
    locale: "en-US",
    catalogs: { "en-US": {} },
    warn: (msg) => warns.push(msg),
  });
  tr.t("missing.one");
  tr.t("missing.one");
  tr.t("missing.one");
  tr.t("missing.two");
  assert.equal(warns.filter((w) => w.includes("missing.one")).length, 1, "同一个键只警告一次");
  assert.equal(warns.filter((w) => w.includes("missing.two")).length, 1, "另一个键各自警告一次");
});

test("t():生产环境不打印缺键警告", () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const warns = [];
    const tr = createTranslator({ locale: "en-US", catalogs: { "en-US": {} }, warn: (m) => warns.push(m) });
    tr.t("missing.prod");
    assert.equal(warns.length, 0, "NODE_ENV=production 时不应警告");
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});

// ---------------------------------------------------------------- 目录守卫

const catalogKeys = (cat) => Object.keys(cat).sort();

test("目录完整性:两个目录键集完全一致", () => {
  assert.deepEqual(catalogKeys(zhHans), catalogKeys(enUS), "键集必须一致,否则默认语言会漏键");
});

test("目录完整性:每个键的 {placeholders} 一致且值非空", () => {
  const placeholders = (v) => [...String(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of catalogKeys(enUS)) {
    assert.ok(String(enUS[key]).length > 0, `en-US 的 ${key} 不应为空`);
    assert.ok(String(zhHans[key]).length > 0, `zh-Hans 的 ${key} 不应为空`);
    assert.deepEqual(
      placeholders(zhHans[key]),
      placeholders(enUS[key]),
      `${key} 的占位符在两个目录里必须一致`,
    );
  }
});

test("orphan:每个 M 的值都能在两个目录里解析", () => {
  const leaves = [];
  const walk = (obj) => {
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v);
      else leaves.push(v);
    }
  };
  walk(M);
  assert.ok(leaves.length > 0, "前置条件:M 应有叶子键");

  const resolvable = (cat, base) =>
    Object.prototype.hasOwnProperty.call(cat, base) ||
    (Object.prototype.hasOwnProperty.call(cat, `${base}_one`) &&
      Object.prototype.hasOwnProperty.call(cat, `${base}_other`));

  for (const base of leaves) {
    assert.ok(resolvable(enUS, base), `en-US 目录里没有 ${base}(或其 _one/_other)`);
    assert.ok(resolvable(zhHans, base), `zh-Hans 目录里没有 ${base}(或其 _one/_other)`);
  }
});

test("orphan:目录里的每个键都能从 M 到达", () => {
  const leaves = [];
  const walk = (obj) => {
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") walk(v);
      else leaves.push(v);
    }
  };
  walk(M);

  const reachable = new Set();
  for (const base of leaves) {
    reachable.add(base);
    reachable.add(`${base}_one`);
    reachable.add(`${base}_other`);
  }

  for (const key of catalogKeys(enUS)) {
    assert.ok(reachable.has(key), `目录键 ${key} 无法从 M 到达 —— 要么加进 messages.js,要么删掉`);
  }
});
