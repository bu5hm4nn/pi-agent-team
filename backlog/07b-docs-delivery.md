# 07b — docs — delivery modes and the max age

- **Area:** docs
- **Status:** queued
- **Depends on:** 04, 05
- **Owner decision:** none

## What

Document the opt-in timestamped delivery digest (04) and the queued-message max
age (05) in `README.md` and `docs/how-it-works.md`, keeping the existing "why not
followUp" caveat consistent.

## Evidence

Split out of the former story 07: the delivery caveat already lives in the docs
and must stay consistent as the digest and TTL land in Phase 2.

## Smallest correct fix

Extend the existing delivery section; no new document.

## Verification

- A reader can explain when a digest is used instead of per-message delivery, and
  how stale queued messages are dropped.
