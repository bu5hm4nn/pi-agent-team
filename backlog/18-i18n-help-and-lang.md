# 18 — i18n — help/description localization, /team lang and overrides

- **Area:** i18n
- **Status:** queued
- **Depends on:** 17
- **Owner decision:** none

## What

Localize the human-visible help surfaces: `registerFlag` and `registerCommand`
descriptions. Add the `/team lang` command to report and set the effective locale
and its source. The override surface (`TEAM_LANG`, `--team-lang`, the team-config
`lang` field, `/team lang`) is **internal** — an escape hatch noted in the
changelog, not published as public API.

Also localize the tool execute-result text that `index.ts` still emits as hardcoded
Chinese (e.g. `失败:${error}`, `发送失败:…`, and the `ui.input`/`ui.select` prompts).
Those results are user-visible, and they are the largest remaining `en-US` gap
outside the model-facing payload (story 20). Setting `/team lang` persists and takes effect on the next reload, because
registration descriptions are frozen at extension load.

Out of scope this wave: tool `description` and parameter descriptions for the
model, and the injected team-context system-prompt fragment. Those are model-facing
and must be translated as a deliberate protocol decision (they pair with the
inbound-message instruction templates), not by accident.

## Evidence

A heterogeneous team (one node Chinese, one English) would otherwise have nodes
running different model-facing prompt text; the council deferred this together
with the inbound templates.

## Smallest correct fix

`t()` for the flag/command descriptions; a `/team lang` command reading and writing
the config `lang` field; README and configuration docs.

## Verification

- `/team lang` reports the effective locale and where it came from; setting it
  persists and applies on the next reload.
- The `--team-lang` flag value is threaded into `resolveLocale`'s `env.teamLang`,
  asserted by a test, so the top of the detection chain is not dead code.
- Docs state plainly that model-facing text is intentionally not localized yet.
