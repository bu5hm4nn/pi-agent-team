# 19 — i18n — localize the Phase 1 additions (above hyperswarm)

- **Area:** i18n
- **Status:** queued
- **Depends on:** 13, 01, 02, 03, 06, 07a, 08
- **Owner decision:** none

## What

The Phase 1 work is stacked **above** the i18n base, so its strings did not exist
when the base migration (stories 14-16) ran. This story localizes them with the same
`t()` mechanism once the base has landed: route the user-visible strings of
`src/transport-hyperswarm.js` and the punch-URI additions in `src/options.js`,
`src/team-config.js`, `src/dispatch.js` and `index.ts` through `t()`, adding the key
to `M` and to **both** catalogs in the same commit so the per-commit completeness
guard holds.

This is the story that lives on the hyperswarm branch (above `wave-i18n`); the base
branch cannot see these files.

## Evidence

Under the chosen topology (i18n below, hyperswarm above) the base is the unmodified
original repo and cannot localize code it does not contain. Leaving the newest
feature as the only unlocalized surface would invert the wave's intent. Council
review 2026-10-03 established the zero-dependency mechanism this story reuses.

## Smallest correct fix

`t()` at the sinks added by the Phase 1 stories; keys in `src/messages.js`; entries
in `src/locales/{zh-Hans,en-US}.js`. No new mechanism.

## Verification

- The punch-URI and transport paths render correctly under both `en-US` (default)
  and `zh-Hans`.
- The catalog completeness and orphan guards stay green on the hyperswarm branch.
- `npm test` green end to end.
