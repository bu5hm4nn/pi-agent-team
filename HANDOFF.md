# HANDOFF

## State

- Fork of `@yiki21/pi-agent-team`; working copy on zedra at
  `~/work/pi-agent-team` (upstream `github.com/Yiki21/pi-agent-team`).
- **Two stacked draft PRs, i18n underneath hyperswarm**, so a clean rebase is
  guaranteed when i18n lands first:
  - **PR #2** `wave-i18n` -> `main` (base): the decision of record plus the i18n
    wave.
  - **PR #1** `wave1-hyperswarm` -> `wave-i18n`: the Phase 1 holepunch mesh (a
    code-only diff against `wave-i18n`).
- `main` (local) at `76c6c14`; `wave-i18n` at `16d2203`; `wave1-hyperswarm` at
  `487adc6`. **Nothing is merged or pushed to `main`.**
- `git tag backup-hyperswarm-097fd2c` preserves the pre-reorder hyperswarm tip.
- One upstream contribution attempt is planned; if rejected, the fork is renamed.

## What landed

- Phase 1 is implemented, reviewed and green on `wave1-hyperswarm` (PR #1):
  the hyperswarm transport (`01`), its conformance driver (`03`), the token
  possession proof (`06`), the punch URI (`02`), one-line join (`08`) and docs
  (`07a`).
- The backlog gained story `12` (Phase 1 follow-ups) and the i18n wave (Phase 4,
  stories `13`-`18`).
- Live two-node check passed (`macmesh`): a message round-tripped over the public
  DHT between zedra and a MacBook peer.

## Settled decisions

- **Phase 1** (council 2026-10-02): a generated 32-byte topic capability persisted
  beside the token, base64url in the URI; an HMAC-SHA256 possession proof — never
  the raw token; the punch URI is `punch://<name>/<topic>/<token>`; hyperswarm is an
  optional, lazily-loaded dependency.
- **i18n** (owner 2026-10-03): English is the base and the default; only a positive
  `zh*` locale selects `zh-Hans`. Detection is the shell locale
  (`LC_ALL > LC_MESSAGES > LANG`) with explicit overrides; zero-dependency in-repo
  catalogs; "codes in, text at the edge". Translations are reviewed by the
  three-seat council because the owner cannot validate the Chinese source.
  Model-facing text stays Chinese while an upstream contribution is attempted; new
  code is documented in Chinese.

## Verification evidence

- `npm test` on `wave1-hyperswarm` -> 348 tests, 342 pass, 0 fail, 6 skipped
  (SWIM sidecar absent).
- Independent read-only review per wave, no blocking findings; the two-node e2e
  test is hermetic and CI-ready.
- `e2e/conformance.js` is unchanged throughout.

## Next task

Implement story `13` on `wave-i18n` (`src/i18n.js`, `src/messages.js`,
`src/locales/{zh-Hans,en-US}.js`, the detection chain, and the completeness/guard
tests), then rebase `wave1-hyperswarm` onto it. Use the worker + read-only reviewer
workflow.
