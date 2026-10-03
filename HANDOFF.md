# HANDOFF

## State

- Fork of `@yiki21/pi-agent-team`; working copy on zedra at
  `~/work/pi-agent-team` (upstream `github.com/Yiki21/pi-agent-team`).
- **Two stacked draft PRs, i18n underneath hyperswarm** (the clean-rebase topology):
  - **PR #2** `wave-i18n` -> `main` (base): the decision of record plus the i18n
    mechanism and the migration stories `13`-`18`. Tip `1f7ce9e`.
  - **PR #1** `wave1-hyperswarm` -> `wave-i18n`: the Phase 1 holepunch mesh plus
    story `19` (localizing the Phase 1 additions). Code-only diff. Tip `d48e3ec`.
  - `git merge-base --is-ancestor wave-i18n wave1-hyperswarm` holds, so when i18n
    lands first the hyperswarm rebase onto `main` is clean.
- `main` (local) at `76c6c14`. **Nothing is merged or pushed to `main`.**
- Safety tags `backup-wave1-46ada22` and `backup-hyperswarm-097fd2c` preserve the
  pre-rebase tips.
- One upstream contribution attempt is planned; if rejected, the fork is renamed.

## What landed

- **Phase 1** on `wave1-hyperswarm`: the hyperswarm transport (`01`), its
  conformance driver (`03`), the token possession proof (`06`), the punch URI
  (`02`), one-line join (`08`), docs (`07a`). The live two-node check passed
  (`macmesh`).
- **i18n wave** (Phase 4):
  - `13` core - `src/i18n.js`, `src/messages.js`, `src/locales/{zh-Hans,en-US}.js`,
    shell-locale detection, completeness / orphan / count guards; the packaging
    guard now scans `src/` recursively.
  - `14`-`16` - the `index.ts` UI sinks, `dispatch.js` + option help, and
    session/config/mode/transport messages migrated to `t()`.
  - `17` - the sink guard (a real lexer that ignores comments and fails on new CJK
    outside the catalogs, with a self-shrinking allowlist) plus dual-locale coverage.
  - `18` - tool execute-result text, menu/input prompts and flag/command help
    localized; `/team lang` added; `--team-lang` threaded into the detection chain.
  - `19` - the Phase 1 additions localized on top of a full rebase onto `wave-i18n`.
  - English for `14`-`19` went through the three-seat council review; accepted
    wording applied.

## Settled decisions

- **Phase 1** (council 2026-10-02): a generated 32-byte topic capability persisted
  beside the token, base64url in the URI; an HMAC-SHA256 possession proof - never
  the raw token; the punch URI is `punch://<name>/<topic>/<token>`; hyperswarm is an
  optional, lazily-loaded dependency.
- **i18n** (owner 2026-10-03): English is the base and the default; only a positive
  `zh*` locale selects `zh-Hans`. Detection is the shell locale
  (`LC_ALL > LC_MESSAGES > LANG`) with explicit overrides; zero-dependency in-repo
  catalogs; "codes in, text at the edge". Translations are council-reviewed because
  the owner cannot validate the Chinese source. Model-facing text stays Chinese
  while an upstream contribution is attempted; new code is documented in Chinese.

## Verification evidence

- `wave-i18n` (base): npm test 322 tests, 316 pass, 0 fail, 6 skipped.
- `wave1-hyperswarm` (tip): npm test 378 tests, 372 pass, 0 fail, 6 skipped; the
  hyperswarm conformance and two-node e2e suites both run and pass.
- Every story reviewed read-only with no blocking findings after its fixes; the
  English reviewed by the council.
- `e2e/conformance.js` unchanged throughout.

## Next task

Await the owner's landing decision: mark PR #2 ready and merge `wave-i18n` to
`main`, then rebase PR #1 onto the new `main` and merge it. At merge time set the
story `Status` fields in `backlog/index.yaml` and the story files. Open items: the
optional story `20` (locale-aware model-facing payload), and the two owner calls the
story-19 council surfaced - whether to edit the `zh-Hans` source for the
topic-generation wording, and "serverless" vs "no central server" branding.
