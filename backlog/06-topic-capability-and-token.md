# 06 — security — topic capability and the team token

- **Area:** security
- **Status:** queued
- **Depends on:** 01
- **Owner decision:** none — settled as `token-possession-proof-over-swarm`
  (see `index.yaml`)

## Settled design (council review, 2026-10-02)

- Authorization is an application-level HMAC-SHA256 possession proof over the
  team token — the raw token is never transmitted. The proof is bound to the
  Noise session (`socket.handshakeHash`), the topic, a version string and the
  initiator/responder role, compared constant-time, and verified before any
  envelope or membership event.
- Refusal mirrors `probeAuth` (`{reason, fingerprint}`), never a bare close;
  `auth_failed` is per-peer and never latches the whole room. Bound pre-auth
  frames and add a handshake deadline.

## What

Settle and implement the authorization story for the serverless path. The DHT
topic is a capability — anyone who knows it can join — and Noise provides
confidentiality and integrity but not membership. Decide whether the existing
team token is presented over the swarm (refusing peers without it) or topic
secrecy is the only gate, and document the threat model plainly.

## Evidence

broker, mesh and swim already authorize with a team token (`TEAM_TOKEN`,
`probeAuth`). Hyperswarm's per-connection Noise handshake authenticates the peer
identity a node generated, not team membership. Leaving this implicit would make
the new mode the weakest of the four.

## Smallest correct fix

An application-level token frame in the handshake, verified before any envelope is
accepted, mirroring `probeAuth`'s refusal shape.

## Verification

- A peer with a valid topic but no (or a wrong) token is refused with a reason.
- A peer with both token and topic round-trips.
