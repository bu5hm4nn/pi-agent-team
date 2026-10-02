# 05 — delivery — max age for queued messages

- **Area:** delivery
- **Status:** queued
- **Depends on:** 04
- **Owner decision:** none

## What

A `maxAgeMs` that drops queued messages older than the threshold before delivery,
and reports the drop in one line rather than silently. It complements the repo's
existing "no offline queue" stance: refuse and say so, never silently deliver
something stale.

## Evidence

A digest that is merely *labelled* stale still spends the agent's turn on noise it
should never have seen. The relay-based extension has neither a TTL nor a drop
report, which is why 20-minute-old messages were delivered at all.

## Smallest correct fix

Filter by `Date.now() - timestamp` where the digest is composed (story 04), and
append "dropped N stale messages (oldest Xm)" to the digest.

## Verification

- A message past the threshold is dropped and named; nothing is silently lost.
