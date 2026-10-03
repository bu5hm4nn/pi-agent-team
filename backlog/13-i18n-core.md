# 13 — i18n core — catalogs, t(), shell-locale detection

- **Area:** i18n
- **Status:** queued
- **Depends on:** 01, 02, 03, 06, 07a, 08
- **Owner decision:** none

## What

A zero-dependency i18n foundation. `src/i18n.js` exports `t(key, params)`,
`setLocale(locale)`, `getLocale()` and `resolveLocale(env)`; catalogs live in
`src/locales/zh-Hans.js` (the source language) and `src/locales/en-US.js` (the base
and default). The locale is a startup-frozen module singleton; tests use
`setLocale()` or an isolated translator factory.

This story establishes the mechanism and the guards only. Catalog content is added
incrementally by stories 14-16 as each call site is migrated, in both locales at
once, because the completeness test enforces key parity per commit: a `zh-Hans`
entry without its reviewed `en-US` counterpart fails the build, so there is no
window in which the English default can leak a raw key.

## Architecture — codes in, text at the edge

No user-facing prose may appear in `src/*.js` or `index.ts`; prose lives only in
`src/locales/*.js`. Code carries a symbolic message id or a structured code, and a
single `t()` at the presentation boundary turns it into text:

- `src/locales/{zh-Hans,en-US}.js` — pure data; the only place prose lives.
- `src/i18n.js` — `resolveLocale`, `setLocale`/`getLocale`, `t(key, params)`,
  `{placeholder}` interpolation, `Intl.PluralRules` selection (`key_one`/
  `key_other`), fallback `en-US` -> key, and a dev/test warning for a missing key.
- `src/messages.js` — the only module allowed to contain message-key literals,
  exported as a frozen symbolic registry (`M.notify.joined`, `M.reason.*`). Call
  sites use `M.*`, so keys are never scattered as raw strings.
- Logic layers (`dispatch.js`, `session.js`, `team-config.js`, the transports)
  return structured results, codes and params — they stay locale-free, and the
  presentation layer (`index.ts` UI sinks) is the only place that renders text.

Detection chain, first hit wins: `--team-lang` > `TEAM_LANG` > the team-config
`lang` field > `LC_ALL` > `LC_MESSAGES` > `LANG` > `Intl.DateTimeFormat()
.resolvedOptions().locale`. POSIX values are normalized (strip the encoding and
`@modifier`; `C`/`POSIX` mean `en`).

Selection: a positive Chinese match (`zh*`) selects `zh-Hans` (our only Chinese
catalog; `zh-Hant` degrades to `zh-Hans`). Every other locale — unset, `en*`, or any
language without a catalog yet — selects `en-US`. English is the base and the
default, because Pi itself is English-only. An explicit override naming an
unsupported locale warns and falls back to `en-US`. Pi exposes no locale API, so
detecting from the Pi install is an explicit non-goal; the shell locale is the
signal.

`t()` interpolates `{name}` placeholders with no new escaping. A missing key falls
back to the `en-US` value (the base), then to the key itself, and warns once in
dev/test.

`en-US` is the default from day one: the framework never stages the default behind a
later flip. Instead the catalog-completeness test enforces key parity **per commit**,
so a call site can only be migrated (stories 14-16) once its English string exists and
has been reviewed. There is therefore no window in which the English default leaks a
raw key. The legacy tests keep their Chinese assertions by pinning the locale
(`setLocale("zh-Hans")`, or `TEAM_LANG=zh-Hans` in the npm script), which doubles as
the proof that the Chinese catalog is intact.

## Evidence

The repo has a hard zero-required-runtime-dependency guard: `src/packaging.test.js`
asserts `Object.keys(pkg.dependencies)` is empty, and the README promises "no
required runtime dependencies". A runtime i18n library would break both.
`Intl.MessageFormat` is undefined on Node 24; Chinese has no plural category and
English only `one`/`other`, so a full ICU formatter buys nothing. Council review
2026-10-03: all three advisors independently picked a zero-dependency plain-object
catalog and a shell-locale detection chain (`LC_ALL` > `LC_MESSAGES` > `LANG`).

## Smallest correct fix

`src/i18n.js`, `src/locales/zh-Hans.js`, `src/locales/en-US.js` and
`src/messages.js`, all added to `package.json` `files[]`. No call-site changes in
this story.

## Verification

- `resolveLocale` returns `en-US` for unset / `en*` / unknown locales, and
  `zh-Hans` for `zh*`.
- The default (no override, no `zh*`) resolves to `en-US`; the full suite stays
  green because it pins `zh-Hans`, and story 17 adds the en-default assertions.
- A catalog-completeness test: identical key sets and matching `{placeholders}`
  across locales.
- A `resolveLocale` unit test covering the full chain, POSIX normalization, the
  aliases and the unknown-language fallback.
- The packaging test covers the three new files.
