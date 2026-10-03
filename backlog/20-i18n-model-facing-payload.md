# 20 — i18n — locale-aware model-facing payload and prompts

- **Area:** i18n
- **Status:** queued
- **Depends on:** 13, 16
- **Owner decision:** none

## What

Make the model-facing text locale-aware instead of hardcoded Chinese: the
`buildPayload` prompt scaffolding in `src/session.js` (`[来自 … 的 team 消息]` /
`[来自 … 的 team 回复]`) and any remaining `index.ts` prompt fragments. This is a
**mechanism** change — the payload must be produced through `t()` for the active
locale rather than carrying a Chinese literal — not a plain catalog extraction,
because it changes the prompt the receiving model sees.

## Evidence

The story-14 and story-16 council reviews flagged this as the largest remaining gap
for an `en-US`-default install: a Chinese scaffold can bias a model toward answering
in Chinese and leaks Chinese into the transcript when peer text is quoted. It was
deliberately excluded from the extraction stories because translating a prompt is a
behaviour change, not an i18n extraction.

## Smallest correct fix

Route the payload and prompt construction through `t()` with keys in both catalogs;
keep the payload structure and its failure-tuning identical. Add the keys to `M` and
to both `src/locales/*.js`.

## Verification

- The injected payload renders in the active locale; `zh-Hans` output is
  byte-identical to today.
- The catalog completeness, orphan and count guards pass.
- The owner decides whether this is offered upstream, since it changes model-facing
  behaviour.
