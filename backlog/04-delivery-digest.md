# 04 — delivery — batch queued messages into one timestamped digest

- **Area:** delivery
- **Status:** queued
- **Depends on:** none
- **Owner decision:** idle-gate-vs-turn-boundary

## What

An opt-in delivery mode (`queuedDelivery: perMessage | digest`) that collapses
messages arriving while the agent is busy into a single custom message, in
chronological order, each with a relative and an absolute age, an ask flag, and a
"treat as background; discard anything superseded" framing. Replies stay bound:
each request's `re` remains individually addressable underneath the digest.

## Evidence

Measured failure mode on the relay-based extension: inbound delivery is
idle-gated, so during a long autonomous build messages accumulate and arrive
10–20 minutes late, in a burst, one turn each, with no age shown — the agent
cannot tell they are stale. The data needed already exists on the envelope
(`timestamp`); it is simply absent from the model-visible text. See this repo's
own `docs/how-it-works.md`, "Delivery, and why not followUp", for the measured
timing that motivates delivering at a turn boundary rather than at idle.

## Smallest correct fix

Compose the digest at the existing settle/delivery boundary in `src/session.js`
and emit one custom message via `pi.sendMessage`; keep the per-request reply
binding intact. The default stays `perMessage`.

## Verification

- Unit: N messages arriving within one turn produce one digest; each still
  resolves to its own request for a reply.
- No behaviour change with the default mode.
