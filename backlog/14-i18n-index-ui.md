# 14 — i18n — migrate the index.ts UI sinks

- **Area:** i18n
- **Status:** queued
- **Depends on:** 13
- **Owner decision:** none

## What

Route the user-visible output produced in `index.ts` through `t()`: the
`ctx.ui.notify` sites, the tool `renderCall`/`renderResult` output, the
`new Text(...)` renders and the status lines. Keys are namespaced by area
(`notify.*`, `tool.*`, `status.*`).

## Evidence

The council's string-scope review puts all extension-authored runtime output in
scope; only model-facing text (tool descriptions, the injected system-prompt
fragment) and documentation are out.

## Smallest correct fix

Replace the literals at those sinks with `t()` calls and add the keys to the
`zh-Hans` catalog. No behaviour change: the default locale is the source language.

## Verification

- With the default locale the rendered strings are byte-identical to today.
- Every sink's key exists in both catalogs; `TEAM_LANG=en-US` renders English for
  the same paths once the en catalog lands (story 17).
