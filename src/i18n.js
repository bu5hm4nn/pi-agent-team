/**
 * 零依赖的 i18n 机制:目录查找、复数、插值、locale 判定。
 *
 * ── 分层 ──
 *   src/locales/{zh-Hans,en-US}.js  纯数据,唯一放文案的地方
 *   src/messages.js                 消息键的符号注册表(唯一放键字面量的地方)
 *   src/i18n.js                     本模块:resolveLocale / setLocale / getLocale / t
 *
 * ── 默认是英文,不是中文 ──
 *   Pi 本身只有英文,所以任何不能**肯定**判定为中文的场合都渲染英文。
 *   只有 shell/显式覆盖给出 zh* 信号才选 zh-Hans(zh-Hant 也降级到它,
 *   因为我们只有这一份中文目录)。决策见 backlog/index.yaml 的
 *   i18n-default-english。
 *
 * ── 为什么不用 i18n 库 ──
 *   仓库有硬性的零运行时依赖约束(src/packaging.test.js 会断言
 *   dependencies 为空,README 也承诺了)。Intl.MessageFormat 在 Node 24
 *   上还不存在;中文没有复数范畴、英文只有 one/other,完整的 ICU
 *   格式化换不来任何东西。所以用普通对象 + Intl.PluralRules 就够了。
 *
 * ── 单例与测试 ──
 *   t / setLocale / getLocale 是一个启动期解析、之后不再变化的模块单例。
 *   setLocale 留给测试和 story 18 的 /team lang;需要在隔离环境里验证
 *   缺键回退时用 createTranslator() 造一个独立的翻译器。
 */

import { enUS } from "./locales/en-US.js";
import { zhHans } from "./locales/zh-Hans.js";

/** 默认/兜底语言。en-US 是 base,也是 day one 的默认。 */
const DEFAULT_LOCALE = "en-US";

/** 目前支持的目录。加语言时同时加目录文件和这里。 */
const SUPPORTED_LOCALES = Object.freeze(["zh-Hans", "en-US"]);

const CATALOGS = Object.freeze({
  "zh-Hans": zhHans,
  "en-US": enUS,
});

/** 生产环境不打印缺键警告;dev/test 才打,且每个键只打一次。 */
const isDevEnv = () => process.env.NODE_ENV !== "production";

const defaultWarn = (...args) => console.warn(...args);

/**
 * 规范化 POSIX locale 值。
 *
 * POSIX 的写法是 `语言_地区.编码@修饰`,例如 `zh_CN.UTF-8@euro`。
 * 我们要的是语言/地区部分,所以:
 *   - 去掉 `@modifier`
 *   - 去掉 `.encoding`
 *   - `C` 和 `POSIX` 是"无 locale"的别名,按 en 处理
 *
 * 不去掉 `_`(如 `zh_CN`):判定用的是前缀匹配,`zh_cn` 一样能命中 zh*。
 *
 * @param {unknown} raw
 * @returns {string} 规范化后的值;空输入返回空串
 */
function normalizePosix(raw) {
  let v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return "";

  const at = v.indexOf("@");
  if (at >= 0) v = v.slice(0, at);

  const dot = v.indexOf(".");
  if (dot >= 0) v = v.slice(0, dot);

  v = v.trim();
  if (!v) return "";

  const lower = v.toLowerCase();
  if (lower === "c" || lower === "posix") return "en";
  return v;
}

/**
 * 把一个 locale 值归类到某个受支持的目录。
 *
 * zh* → zh-Hans(zh-Hant 也降级到这里,我们只有这一份中文目录)
 * en* / C / POSIX → en-US
 * 其它 → null(调用方决定是警告回退还是静默回退)
 *
 * @param {unknown} raw
 * @param {readonly string[]} supported
 * @returns {string|null}
 */
function classify(raw, supported) {
  const norm = normalizePosix(raw);
  if (!norm) return null;
  const lower = norm.toLowerCase();

  if (lower === "zh" || lower.startsWith("zh-") || lower.startsWith("zh_")) {
    return supported.includes("zh-Hans") ? "zh-Hans" : null;
  }
  if (lower === "en" || lower.startsWith("en-") || lower.startsWith("en_")) {
    return supported.includes("en-US") ? "en-US" : null;
  }
  return supported.includes(norm) ? norm : null;
}

/** 取第一个非空字符串并 trim,没有则 null。 */
function firstNonEmpty(values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * 解析生效语言。先命中先赢:
 *
 *   1. `--team-lang`(调用方以 `env.teamLang` 传入,因为它是 Pi 的 flag,
 *      不在 process.env 里)
 *   2. `TEAM_LANG`
 *   3. team 配置的 `lang` 字段(config.lang)
 *   4. `LC_ALL`
 *   5. `LC_MESSAGES`
 *   6. `LANG`
 *   7. `Intl.DateTimeFormat().resolvedOptions().locale`
 *
 * 1-3 是**显式覆盖**:值不受支持(既不是 zh* 也不是 en*)时警告并回退
 * en-US,不再往下看。4-7 是探测:不受支持就静默回退 en-US。
 *
 * @param {Record<string, unknown>} [env]  通常传 process.env;可含 teamLang
 * @param {{ lang?: string }|null} [config] team 配置
 * @returns {string} 一定是受支持的 locale(zh-Hans 或 en-US)
 */
export function resolveLocale(env = {}, config = {}) {
  const override = firstNonEmpty([env.teamLang, env["team-lang"], env.TEAM_LANG, config?.lang]);
  if (override) {
    const picked = classify(override, SUPPORTED_LOCALES);
    if (picked) return picked;
    defaultWarn(`i18n: 不支持的语言 "${override}",回退到 ${DEFAULT_LOCALE}`);
    return DEFAULT_LOCALE;
  }

  const detected = firstNonEmpty([env.LC_ALL, env.LC_MESSAGES, env.LANG]);
  if (detected) return classify(detected, SUPPORTED_LOCALES) ?? DEFAULT_LOCALE;

  const fromIntl = classify(Intl.DateTimeFormat().resolvedOptions().locale, SUPPORTED_LOCALES);
  return fromIntl ?? DEFAULT_LOCALE;
}

/**
 * 用 `{name}` 占位符插值。不引入任何新的转义语义 —— 找不到的参数原样
 * 留着(比静默变空更容易在界面上发现)。
 *
 * @param {string} template
 * @param {Record<string, unknown>|undefined} params
 */
function interpolate(template, params) {
  if (!params) return template;
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/**
 * 造一个独立的翻译器。生产代码用下面的单例;测试需要注入自己的目录、
 * 警告函数或独立 locale 时用这个,互不影响。
 *
 * @param {{ locale?: string, catalogs?: Record<string, Record<string,string>>, warn?: (...a: unknown[]) => void }} [opts]
 */
export function createTranslator({ locale, catalogs = CATALOGS, warn = defaultWarn } = {}) {
  const supported = Object.keys(catalogs);
  const fallback = supported.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : supported[0];
  const warned = new Set();
  let current = fallback;

  const lookup = (loc, key) => {
    const cat = catalogs[loc];
    return cat && Object.prototype.hasOwnProperty.call(cat, key) ? cat[key] : undefined;
  };

  const warnMissing = (key) => {
    if (warned.has(key) || !isDevEnv()) return;
    warned.add(key);
    warn(`i18n: 缺少消息键 "${key}"(locale ${current})`);
  };

  /**
   * 取文案并插值。
   *
   * params.count 存在时,用 Intl.PluralRules 按**当前 locale** 选复数范畴,
   * 查找 `<key>_<category>`(en 是 _one/_other,zh 只有 _other)。
   * 缺键回退顺序:当前目录 → en-US(base) → 键本身;每次缺键只警告一次。
   *
   * @param {string} key
   * @param {Record<string, unknown>} [params]
   * @returns {string}
   */
  function t(key, params) {
    if (typeof key !== "string" || key === "") return "";

    let lookupKey = key;
    if (params && params.count !== undefined && params.count !== null) {
      const category = new Intl.PluralRules(current).select(params.count);
      lookupKey = `${key}_${category}`;
    }

    const own = lookup(current, lookupKey);
    if (own !== undefined) return interpolate(own, params);

    warnMissing(lookupKey);
    const base = lookup(fallback, lookupKey);
    return interpolate(base !== undefined ? base : lookupKey, params);
  }

  /** 切换语言。不受支持时警告并回退;空值静默回到默认。 */
  function setLocale(next) {
    const picked = classify(next, supported);
    if (picked) {
      current = picked;
      return current;
    }
    if (next === undefined || next === null || String(next).trim() === "") {
      current = fallback;
      return current;
    }
    warn(`i18n: 不支持的语言 "${next}",回退到 ${fallback}`);
    current = fallback;
    return current;
  }

  function getLocale() {
    return current;
  }

  const translator = { t, setLocale, getLocale };
  if (locale !== undefined && locale !== null) setLocale(locale);
  return translator;
}

/** 模块单例:启动期解析一次,之后由 setLocale 显式改变。 */
const singleton = createTranslator();

/** @type {(key: string, params?: Record<string, unknown>) => string} */
export const t = singleton.t;
/** @type {(locale: string) => string} */
export const setLocale = singleton.setLocale;
/** @type {() => string} */
export const getLocale = singleton.getLocale;
