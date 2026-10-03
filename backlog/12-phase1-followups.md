# 12 — Phase 1 follow-ups — hardening, coverage and UX polish

- **Area:** transport
- **Status:** queued
- **Depends on:** 01, 02, 03, 06
- **Owner decision:** none

## What

The residual items captured by the independent reviews of the Phase 1 waves and
by the live two-node (`macmesh`) check. Each is a correctness/robustness fix or a
coverage/UX gap; none block the Phase 1 landing. Fixing an item here means a test
or a recorded reason, not a silent change.

## Items

### Reliability

- **R1 — `send()` before `online` is dropped.** A peer `membership` event can fire
  before the transport's `online` transition; `send()` guards on
  `state() === "online"` and returns `false`. Found by the live two-node check
  (`SEND attempt ok=false` while still `connecting`). Fix: allow a send when a
  ready session exists, or transition to `online` before inbound connections can
  register. (`src/transport-hyperswarm.js`)
- **R2 — swarm errors are silent.** `swarm.on("error", …)` is swallowed, so a DHT
  failure after `online` never surfaces. Emit a diagnostic (or a
  `rejected`-style) event.
- **R3 — `stop()` and auth timers.** `stop()` clears the sessions map but does not
  clear each session's `authTimer` explicitly (they are `unref()`d). Cosmetic.

### Security / protocol

- **S1 — malformed auth reason.** A frame with `v !== 1`, an empty/non-string
  `proof`, or a missing binding is refused as `token_missing`; use a distinct
  `invalid_auth` and reserve `token_missing` for genuine local absence
  (`probeAuth` parity).
- **S2 — MAC length separation.** `computeProof` concatenates
  `version ‖ topic ‖ handshakeHash ‖ role` without length prefixes. Unambiguous
  today; add length-prefix or domain separation so future fields cannot collide.
- **S3 — pre-auth buffering.** The 4 KiB pre-auth bound is checked after
  `FrameReader` has assembled a frame (worst case ~64 KiB from the transport cap).
  Drop mid-frame, or cap before assembly.
- **S4 — role determination.** Roles come from `socket.isInitiator` /
  `peerInfo.client`; if both are undefined every peer derives `responder` and
  refuses (safe, but an availability quirk). Add an explicit check/diagnostic.
- **S5 — topic canonicalization.** A non-canonical 43-char base64url topic decodes
  to the same 32 bytes and works; normalize or reject non-canonical input.

### Coverage

- **C1 — two-node punch-URI e2e.** `e2e/hyperswarm-two-node.test.js`: two local
  nodes, `create → URI → parse → join` on a hermetic local DHT, then exchange a
  message. Added with this story.
- **C2 — auth edge tests.** The handshake deadline, an oversized pre-auth frame,
  cross-connection proof replay, and "auth frame must be first" are implemented
  but untested.
- **C3 — live-check reproducibility.** The public-DHT two-machine check is manual
  by design; document the exact steps (or ship a scratch peer script) so it can be
  rerun. Reference: PR #1 discussion.
- **C4 — CI flakiness guard.** The two-node test's discovery waits (15 s) sit far
  above the ~45 ms measured, but a heavily loaded runner could still stall. Consider
  one bounded retry, or a CI matrix that repeats the file, to rule out rare
  announce-quorum flakiness.

### Config / UX

- **U1 — `saved:false` is inert.** `joinTeam` accepts `save: false` but never honors
  it (pre-existing). Implement or remove the parameter.
- **U2 — `statusLines` for hyperswarm.** `/team status` prints a seeds/port line
  that is meaningless for hyperswarm; tailor it to topic/URI.
- **U3 — `/team mode hyperswarm` guidance.** Switching to hyperswarm without a
  topic errors generically; point at `/team join <punch URI>`.
- **U4 — injectable bootstrap via config/env.** The transport accepts
  `bootstrap`/`dht`, but `createTransport`/options do not expose it; add a
  `TEAM_BOOTSTRAP` / config field for a self-hosted DHT.
- **U5 — typo.** `HYPERWARM_TOPIC_REQUIRED` → `HYPERSWARM_TOPIC_REQUIRED`.
- **U6 — secret hygiene.** The punch URI is a bearer secret; keep it out of logs
  and transcripts beyond the owner-requested create output, and consider a
  `/team uri` reprint command so the create output need not be re-read.
- **U7 — `bootstrap` ignored when `dht` is injected.** `src/transport-hyperswarm.js`
  skips `normalizeBootstrap` when `opts.dht` is set, so a caller passing both is
  silently surprised (the two-node test works only because its injected DHT already
  carries the same bootstrap). Document this on the `dht` JSDoc param, or assert the
  injected DHT's bootstrap matches.

## Already tracked elsewhere

Phase 2 (`04` digest, `05` max age, `07b` docs) and Phase 3 (`09`–`11` rooms)
remain in their own stories and are not duplicated here.

## Verification

- Each item is fixed with a test where it is testable, or explicitly deferred with
  a recorded reason in this file or the landing PR.
