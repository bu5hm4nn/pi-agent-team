# 17 — i18n — en-US catalog, completeness test, dual-locale CI

- **Area:** i18n
- **Status:** queued
- **Depends on:** 13, 14, 15, 16
- **Owner decision:** none

## What

Complete `src/locales/en-US.js` for every extracted key. The default is already
`en-US` (story 13), so this story completes the catalog and its guards rather than
flipping anything: add any remaining keys, add the en-default and `zh-Hans` regression
assertions, and keep the legacy Chinese assertions pinned to `zh-Hans`. Add the
guards: a catalog-completeness test (identical key sets, matching `{placeholders}`,
no empty values), a dual-locale test run over a representative subset, and a
dependency-free grep guard that flags new CJK literals in user-facing sink positions
(`ctx.ui.notify`, dispatch `lines.push`, `description:`) against a reviewed
allowlist — not a blanket CJK scan, which would flag the comments.

## Evidence

English plurals reduce to `one`/`other` behind `t()` (`Intl.PluralRules` if a
message ever needs it); no ICU is required. Council review 2026-10-03.

## Smallest correct fix

Fill the en catalog; add the three tests. No code changes outside the catalog.

## Verification

- `npm test` green under both `zh-Hans` and `en-US`.
- The completeness test fails if a key is removed from either catalog or a
  placeholder drifts.
- The guard test fails on a new untranslated user-facing literal.
- English strings are LLM-drafted and then reviewed by the three-seat council
  (the owner cannot validate the Chinese source); that review gates the default
  flip to `en-US`.
