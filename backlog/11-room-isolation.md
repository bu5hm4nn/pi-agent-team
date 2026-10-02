# 11 — room isolation — a session never sees another room's nodes

- **Area:** tests
- **Status:** queued
- **Depends on:** 06, 09
- **Owner decision:** none

## What

Prove isolation both ways: a session joined to room A never appears in room B's
roster and never receives B's messages, and a peer holding A's topic but not A's
token is refused. Isolation is a claim to be demonstrated, not assumed from
"different topics".

## Evidence

Distinct topics make cross-discovery structurally impossible, but the token gate
(story 06) is what stops a peer that *has* a topic from joining it. Both halves
need a test, or "isolated" is only half true.

## Smallest correct fix

An e2e test standing up two rooms with different topics and tokens, joining A and
B, and asserting: roster(A) excludes B's nodes, a B-targeted send never surfaces
in A, and a wrong-token peer cannot complete the handshake on A's topic.

## Verification

- The isolation assertions hold in both directions, and the wrong-token case is
  refused with a reason.
