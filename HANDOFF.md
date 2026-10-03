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
- `main` (local) at `76c6c14`; `wave-i18n` at `1f7ce9e` (origin tip).
  `wave1-hyperswarm` is **fully rebased onto `wave-i18n`** and carries the Phase 1
  commits plus story `19`; tip `bf40f9a`. **Nothing is merged or pushed to `main`.**
- `git tag backup-hyperswarm-097fd2c` and `git tag backup-wave1-46ada22` preserve
  the pre-rebase tips (the old hyperswarm branch base and tip).
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
  - `16` — `session.js`, `team-config.js`, `mode.js`, `options.js` and the
    pre-existing transports routed through `t()`; the Chinese-asserting tests
    pinned to `zh-Hans`.
  - `17` — the en-US catalog completed and the sink guard + dual-locale coverage
    added; the roster/UI sink entries regraded.
  - `18` — help/flag/command descriptions localized; `/team lang` and
    `--team-lang` added; council wording applied.
  - The English added by `14`, `15`, `17` and `18` went through the three-seat
    council wording review; the accepted corrections were applied.
- **Story `19`** (final step of the wave, on `wave1-hyperswarm` **after** the
  rebase): the Phase 1 punch-URI and hyperswarm strings are localized. The rebase
  replayed the seven Phase 1 commits onto `wave-i18n` (9 conflicts across
  `mode.js`, `index.ts`, `dispatch.js`, `options.js`, `team-config.js`,
  `team-config.test.js`), keeping the localized `t()`/`optionHelp()` structure and
  integrating the punch-URI logic; `OPTION_HELP` was dropped in favour of
  `optionHelp()` and the new option lines were folded into the `options.help`
  catalog value. Story `19` then added **36 keys** to `messages.js` and both
  catalogs and retired the six migrated team_join sink-guard entries.
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
- `npm test` on the rebased `wave1-hyperswarm` tip with story `19`: 378 tests,
  372 pass, 0 fail, 6 skipped (the 6 skips are the SWIM sidecar cases; every
  hyperswarm conformance and two-node test ran).
- `node --test src/i18n-sink-guard.test.js`: 4 pass, 0 fail (no un-allowlisted
  CJK, no stale entries). `node --test src/i18n.test.js`: 25 pass.
- Both locales verified by hand on the punch-URI create/join and `/team mode`
  paths: en-US renders English with no CJK, zh-Hans renders the Chinese catalog.
- Every story was reviewed read-only with no blocking findings after its fixes; the
  English was reviewed by the council.
- `e2e/conformance.js` is unchanged throughout.
- One `npm test` run in this session crashed `broker.mjs` (a core dump) and hung; it
  did not reproduce on a clean re-run and is treated as environmental.

## Next task

Council-review the story-`19` English wording and run the read-only reviewer over
`wave1-hyperswarm` (`1f7ce9e..bf40f9a`, including the replayed rebase); then the
remaining i18n story is `20` (locale-aware model-facing payload, decision D1).
Story `19`'s status is still `queued` in `backlog/19-i18n-hyperswarm-strings.md`
and `backlog/index.yaml` — matching stories `17`/`18`; set all three to landed in
the PR that merges the wave. Do not push, open the PR, merge, or delete branches
without explicit authorization.
