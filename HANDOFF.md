# HANDOFF

## State

- Fork of `@yiki21/pi-agent-team`; working copy on zedra at
  `~/work/pi-agent-team` (upstream `github.com/Yiki21/pi-agent-team`).
- **Two stacked draft PRs, i18n underneath hyperswarm**, so a clean rebase is
  guaranteed when i18n lands first:
  - **PR #2** `wave-i18n` -> `main` (base): the decision of record, the i18n
    mechanism, and the migrations.
  - **PR #1** `wave1-hyperswarm` -> `wave-i18n`: the Phase 1 holepunch mesh; a
    code-only diff, rebased onto each `wave-i18n` advance.
- `main` (local) at `76c6c14`; `wave-i18n` at `8592b35`; `wave1-hyperswarm`
  rebased onto it. **Nothing is merged or pushed to `main`.**
- `git tag backup-hyperswarm-097fd2c` preserves the pre-reorder hyperswarm tip.
- One upstream contribution attempt is planned; if rejected, the fork is renamed.

## What landed

- Phase 1, implemented and reviewed on `wave1-hyperswarm` (PR #1): the hyperswarm
  transport (`01`), its conformance driver (`03`), the token possession proof
  (`06`), the punch URI (`02`), one-line join (`08`), docs (`07a`). The live
  two-node check passed (`macmesh`).
- The i18n wave on `wave-i18n` (PR #2):
  - `13` core — `src/i18n.js`, `src/messages.js`, `src/locales/{zh-Hans,en-US}.js`,
    shell-locale detection, and the completeness / orphan / count guards. The
    packaging guard now scans `src/` recursively.
  - `14` — the `index.ts` UI sinks routed through `t()`; a blocking plural-key leak
    and two further raw-key leaks were found in review and fixed.
  - `15` — `dispatch.js` output and `OPTION_HELP` migrated; 97 keys.
  - The English added by `14` and `15` went through the three-seat council wording
    review; the accepted corrections were applied.
- The backlog gained story `12` (Phase 1 follow-ups) and the i18n wave (Phase 4,
  stories `13`-`19`).

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

- `npm test` on `wave-i18n` (base): 312 tests, 306 pass, 0 fail, 6 skipped.
- `npm test` on the combined `wave1-hyperswarm` tip: 362 tests, 356 pass, 0 fail,
  6 skipped.
- Every story was reviewed read-only with no blocking findings after its fixes; the
  English was reviewed by the council.
- `e2e/conformance.js` is unchanged throughout.
- One `npm test` run in this session crashed `broker.mjs` (a core dump) and hung; it
  did not reproduce on a clean re-run and is treated as environmental.

## Next task

Implement story `16` on `wave-i18n`: migrate `src/session.js`, `src/team-config.js`,
`src/mode.js`, `src/options.js` and the pre-existing transports through `t()`, pin
the Chinese-asserting tests to `zh-Hans`, then council-review the English and run the
read-only reviewer. Then rebase `wave1-hyperswarm`. Stories `17`-`19` remain.
