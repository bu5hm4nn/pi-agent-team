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

import { t, setLocale, getLocale, resolveLocale, resolveLocaleInfo, startupLocaleEnv, createTranslator } from "./i18n.js";
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

test("resolveLocale:没有 zh 信号时回退 en-US(不依赖宿主 Intl)", () => {
  // 显式给一个既非 zh、也没有目录的语言,证明未知 locale 静默回退英文。
  // 不用空 env:空 env 会落到 Intl.DateTimeFormat().resolvedOptions().locale,
  // 结果随宿主 locale 而变(zh 宿主上会解析成 zh-Hans),那是宿主耦合的偶合,
  // 不是本测试要证明的确定行为。Intl 回退分支由下面"都没有时看 Intl"自适应覆盖。
  assert.equal(resolveLocale({ LANG: "fr_FR.UTF-8" }, {}), "en-US", "未知语言应回退 en-US");
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
  // 唯一允许宿主耦合的地方:期望值直接从宿主 Intl 派生,任何宿主下都自洽。
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

test("resolveLocale:en* 与未知语言都选 en-US", () => {
  for (const raw of ["en", "en-US", "en_GB.UTF-8"]) {
    assert.equal(resolveLocale({ LANG: raw }, {}), "en-US", `${raw} 应选 en-US`);
  }
  // "未设"与"空串"都会落到宿主 Intl.DateTimeFormat,结果随宿主 locale 变;
  // 该分支由上面"都没有时看 Intl"自适应验证,这里只断言显式非 zh 信号。
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

test("resolveLocaleInfo:报告生效语言与来源", () => {
  // --team-lang flag 值与 TEAM_LANG 同时给,flag 必须赢 —— 这就是 index.ts
  // 启动时把 pi.getFlag("team-lang") 送进 env.teamLang 的那条链。
  assert.deepEqual(resolveLocaleInfo({ teamLang: "zh-Hans", TEAM_LANG: "en-US" }, {}), {
    locale: "zh-Hans",
    source: "flag",
    value: "zh-Hans",
    unsupported: false,
  });
  assert.deepEqual(resolveLocaleInfo({ TEAM_LANG: "zh-Hans" }, {}), {
    locale: "zh-Hans",
    source: "env",
    value: "zh-Hans",
    unsupported: false,
  });
  assert.deepEqual(resolveLocaleInfo({}, { lang: "zh-Hans" }), {
    locale: "zh-Hans",
    source: "config",
    value: "zh-Hans",
    unsupported: false,
  });
  assert.deepEqual(resolveLocaleInfo({ LC_ALL: "zh_CN" }, {}), {
    locale: "zh-Hans",
    source: "lc_all",
    value: "zh_CN",
    unsupported: false,
  });
  assert.deepEqual(resolveLocaleInfo({ LC_MESSAGES: "zh_CN" }, {}), {
    locale: "zh-Hans",
    source: "lc_messages",
    value: "zh_CN",
    unsupported: false,
  });
  assert.deepEqual(resolveLocaleInfo({ LANG: "zh_CN.UTF-8" }, {}), {
    locale: "zh-Hans",
    source: "lang",
    value: "zh_CN.UTF-8",
    unsupported: false,
  });

  // 不支持的显式覆盖:回退 en-US,但汇报里仍指出来源与原始值
  const warns = captureWarn(() => {
    assert.deepEqual(resolveLocaleInfo({ TEAM_LANG: "fr-FR" }, {}), {
      locale: "en-US",
      source: "env",
      value: "fr-FR",
      unsupported: true,
    });
  });
  assert.ok(warns.some((w) => w.includes("fr-FR")), "resolveLocaleInfo 也应警告");
});

test("--team-lang flag 经 startupLocaleEnv 进入检测链顶端(env.teamLang 不是死代码)", () => {
  // 模拟 index.ts 的启动接入:把 Pi 的 --team-lang flag 值并入 env。
  // flag 必须压过 shell 信号,证明检测链顶端真的接上了。
  assert.equal(resolveLocale(startupLocaleEnv("zh-Hans", { LANG: "en_US.UTF-8" }), {}), "zh-Hans");
  assert.equal(resolveLocale(startupLocaleEnv("en-US", { LANG: "zh_CN" }), {}), "en-US");
  // 没有 flag / 空 flag 时不得伪造一个空覆盖把 shell 信号压掉
  assert.equal(resolveLocale(startupLocaleEnv(undefined, { LANG: "zh_CN" }), {}), "zh-Hans");
  assert.equal(resolveLocale(startupLocaleEnv("", { LANG: "zh_CN" }), {}), "zh-Hans");
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
  // 分发输出的带 {count} 基础键也要在列 —— 它们同样是复数键,守卫必须覆盖。
  assert.ok(countKeys.includes(M.dispatch.statusOnline), "dispatch.status.online 应带 {count}");
  assert.ok(countKeys.includes(M.dispatch.peersHostGroup), "dispatch.peers.hostGroup 应带 {count}");
  assert.ok(countKeys.includes(M.dispatch.sendBulk), "dispatch.send.bulk 应带 {count}");
  assert.ok(countKeys.includes(M.dispatch.sendSent), "dispatch.send.sent 应带 {count}");

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

// ---------------------------------------------------------------- 双语言覆盖

/**
 * 代表性的用户可见路径:每个命名空间挑一两条,断言 en-US 真的渲染
 * 英文。zh-Hans 的逐字断言由各测试文件自己 setLocale("zh-Hans") 钉住
 * (见 dispatch.test.js / mode.test.js / options.test.js),那是对"中文
 * 目录未被改动"的字节级回归证明;这里补的是 en 侧。
 */
const EN_CASES = [
  [M.notify.greeting, { name: "Ada" }, "Hello, Ada"],
  [M.notify.files, { count: 2 }, "2 files"],
  [M.notify.sendFailed, undefined, "team: not connected, the message was not sent"],
  [M.tool.delivered, { to: "bob" }, "✓ delivered to bob"],
  [M.tool.currentTeam, undefined, "(current)"],
  [M.tool.moreLines, { count: 3 }, "…3 more lines"],
  [M.status.replaced, { name: "n" }, "⚠️ team:n (replaced)"],
  [M.dispatch.none, undefined, "(none)"],
  [M.dispatch.statusMode, { mode: "broker" }, "mode         broker"],
  [M.dispatch.sendNotConnected, undefined, "not connected, the message was not sent"],
  [M.dispatch.sendBulk, { count: 3, targets: "a,b,c" }, "About to send to 3 nodes: a,b,c"],
  [M.dispatch.modeCurrent, { mode: "mesh" }, "current mode: mesh"],
  [M.dispatch.peersHostGroup, { host: "h", count: 2 }, "h  (2)"],
  [M.session.peerJoined, { peer: "bob" }, "team: bob is online"],
  [M.session.deliveredPartial, { delivered: 1, total: 2 }, "delivered 1/2"],
  [M.session.remindedStillPending, { to: "bob" }, "reminded once, but the request from bob is still unanswered"],
  [M.config.modeInvalid, { modes: "broker|mesh|swim", value: "x" }, 'mode must be broker|mesh|swim, got "x"'],
  [M.mode.unknownNoQuote, { mode: "x" }, "unknown mode x"],
  [M.options.tokenTooShort, undefined, "token is too short (at least 16 characters)"],
  [M.reason.offline, undefined, "offline"],
];

const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

test("双语言覆盖:en-US 下代表性路径渲染英文,不吐裸键", () => {
  setLocale("en-US");
  assert.equal(getLocale(), "en-US");
  for (const [key, params, want] of EN_CASES) {
    const out = t(key, params);
    assert.equal(out, want, `${key} 的 en-US 渲染`);
    assert.notEqual(out, key, `${key} 不应吐裸键`);
    assert.ok(!CJK_RE.test(out), `en-US 的输出不应含中文:${key} => ${out}`);
  }
});

test("双语言覆盖:同一批键在 zh-Hans 下含中文(两份目录确实不同)", () => {
  setLocale("zh-Hans");
  for (const key of [M.notify.greeting, M.notify.sendFailed, M.tool.delivered, M.config.modeInvalid, M.options.tokenTooShort]) {
    const entry = EN_CASES.find(([k]) => k === key);
    const out = t(key, entry[1]);
    assert.ok(CJK_RE.test(out), `zh-Hans 的输出应含中文:${key} => ${out}`);
  }
  setLocale("en-US");
});

test("双语言覆盖:默认 locale(无覆盖、非 zh*)解析为 en-US", () => {
  // 不用空 env:空 env 会落到宿主 Intl,结果随宿主 locale 变(见文件顶部说明)。
  assert.equal(resolveLocale({ LANG: "en_US.UTF-8" }, {}), "en-US");
  assert.equal(resolveLocale({ LANG: "fr_FR.UTF-8" }, {}), "en-US", "没有目录的语言也回退英文");
  assert.equal(createTranslator().getLocale(), "en-US", "无 locale 的翻译器默认 en-US");
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
