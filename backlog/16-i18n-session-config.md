# 16 — i18n — migrate session, config and transport messages

- **Area:** i18n
- **Status:** queued
- **Depends on:** 15
- **Owner decision:** none

## What

Route the user-visible error and diagnostic strings in the **pre-existing** modules
— `src/session.js`, `src/team-config.js`, `src/mode.js`, `src/options.js`,
`src/transport.js`, `src/transport-mesh.js`, `src/transport-swim.js` and
`src/ws.js` — through `t()`. Third-party diagnostic text is wrapped, not translated.
Command identifiers, wire codes and user content are left untouched.

The hyperswarm additions (the transport, the punch URI, the token gate) do not exist
on this branch; their strings are localized by story 19, above the Phase 1 work.

## Evidence

The council's scope review includes nested validator and transport errors as
user-visible output. Chinese comments and JSDoc stay Chinese throughout.

## Smallest correct fix

`t()` at the message sites; keys namespaced by module (`session.*`, `config.*`,
`mode.*`, `options.*`, `transport.*`). Add the keys to the `zh-Hans` catalog.

## Verification

- Default-locale output is byte-identical; the full suite passes pinned to
  `zh-Hans`.
- No user-facing literal outside `src/locales/` remains untranslated in these
  modules (guarded in story 17).
