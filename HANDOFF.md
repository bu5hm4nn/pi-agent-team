# HANDOFF

## State

- Fork of `@yiki21/pi-agent-team`; working copy on zedra at
  `~/work/pi-agent-team` (upstream `github.com/Yiki21/pi-agent-team`).
- Branch `main` at `996c324`, tracking `origin/main`.
- Backlog restructured into three phases, and the three Phase 1 owner decisions
  settled by a council review (2026-10-02). Phase 1 = holepunch mesh, Phase 2 =
  delivery hygiene, Phase 3 = multi-room.

## What landed

- Nothing in the extension yet. The council review (workflows `baa4d930` pass 1,
  `9809da53` pass 2) settled the three Phase 1 owner decisions; they are recorded
  as `decisions` in `backlog/index.yaml` and in the story headers.
- Story `07` was split into `07a` (transport + punch URI docs, Phase 1) and `07b`
  (delivery docs, Phase 2), fixing the former `07 -> 04` Phase 1/Phase 2 conflict.

## Settled decisions (council 2026-10-02)

- **Topic:** generated 32-byte capability persisted beside the token, base64url in
  the URI; public bootstrap by default, injectable.
- **Token gate:** HMAC-SHA256 possession proof over the team token, bound to the
  Noise session (`socket.handshakeHash`), the topic, a version string and the
  initiator/responder role — the raw token is never transmitted. Verified before
  any envelope/membership event; refusal mirrors `probeAuth`; `auth_failed` is
  per-peer.
- **Punch URI:** `punch://<name>/<topic>/<token>`; the separate host hint is
  dropped. `/team create <name>` defaults to the hyperswarm mode and prints the
  URI; `/team join <uri>` takes only the URI.
- **Dependency:** accept the hyperswarm native dependency (pinned 4.17.2 +
  hyperdht, committed lockfile, `files[]` entries) and the public bootstrap; the
  native addon is loaded lazily so broker/mesh/swim are unaffected.

## Verification evidence

- hyperswarm installs and loads on zedra (Node 24, glibc 2.36); two peers joined a
  DHT topic and exchanged a message.
- `/tmp` is `noexec` there — native addons installed under it fail to `mmap`.
- Hermetic conformance: `hyperdht` ships `DHT.bootstrapper()` and
  `createTestnet()`; hyperswarm forwards `bootstrap` and accepts a `dht` option
  (verified from published package source, not yet executed).
- Why the relay extension delivered messages 10–20 minutes late is recorded in
  `backlog/04-delivery-digest.md`.

## What remains

- Phase 1: `01` transport + `03` conformance (Wave 1), `02` punch URI + `08`
  provisioning, `06` token hardening, `07a` docs.
- Phase 2: `04` digest, `05` max age, `07b` docs.
- Phase 3: `09` multi-room core, `10` room-scoped API, `11` isolation.

## Next task

Wave 1: story `01` (`src/transport-hyperswarm.js`, `src/hyperswarm.d.ts`,
lazy-loaded, HMAC auth handshake) together with story `03`
(`e2e/transport-hyperswarm.test.js` driving `e2e/conformance.js` unchanged via a
hermetic local-hyperdht harness). Mesh is the closest template.
