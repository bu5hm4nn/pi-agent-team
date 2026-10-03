# 15 — i18n — migrate dispatch output and option help

- **Area:** i18n
- **Status:** queued
- **Depends on:** 14
- **Owner decision:** none

## What

Route `src/dispatch.js` command and tool output, and its errors, through `t()`,
keyed by the existing stable result and reason codes where one exists. Convert
`OPTION_HELP` and any other translated module constant into a function evaluated at
call time — they are frozen at import today, so a locale chosen at startup would
not reach them.

## Evidence

`dispatch.js` is the largest single user-visible surface after `index.ts`; its
coded reasons make message keys stable and reviewable.

## Smallest correct fix

`t()` at the output sites; `OPTION_HELP` becomes `optionHelp()`. Add the keys to the
`zh-Hans` catalog.

## Verification

- Default-locale output is byte-identical; `src/dispatch.test.js` keeps passing
  under the pinned `zh-Hans` locale.
- Option help reflects a locale change made before the call (it is no longer frozen
  at import).
