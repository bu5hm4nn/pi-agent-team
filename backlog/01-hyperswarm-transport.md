# 01 — hyperswarm transport — serverless node-to-node delivery

- **Area:** transport
- **Status:** queued
- **Depends on:** none
- **Owner decision:** none — settled as `generated-topic-capability` and
  `token-possession-proof-over-swarm` (see `index.yaml`)

## Settled design (council review, 2026-10-02)

- The transport takes a resolved 32-byte topic; topic generation and persistence
  belong to story 02. Bootstrap defaults to the public hyperswarm set and is
  injectable (constructor `bootstrap` / `dht` option).
- Peer authorization (the team token) is **story 06**, not this story: this
  transport gates on the topic capability alone. Design the per-connection
  framing so 06 can insert its handshake before any envelope is accepted.
- The native addon is loaded lazily so broker/mesh/swim are unaffected.
- The conformance driver (story 03) must stay hermetic via a local `hyperdht`
  bootstrapper (`DHT.bootstrapper()` / `createTestnet()` injected through
  `bootstrap` or `dht`); `e2e/conformance.js` stays unchanged.

## What

A fourth transport, `src/transport-hyperswarm.js`, implementing the same interface
as broker/mesh/swim (`start/stop/send/state/members` plus the `envelope`/`state`/
`membership` events) over Holepunch's hyperswarm. Nodes join a DHT topic derived
from the punch URI; hyperswarm does DHT peer discovery, UDP hole punching and a
Noise-encrypted duplex stream per peer. Delivery is direct node-to-node: no
broker, no reachable address, no inbound port.

## Evidence

- `src/transport.js` already defines the contract and names the conformance suite
  as the completion gate; `transport-mesh.js` is the closest template (direct
  delivery, member table) and `src/ws.js` is the framing to reuse.
- hyperswarm was verified on the target host (Node 24, Debian glibc 2.36):
  `npm i hyperswarm` succeeds, `require` loads, and two peers joined a topic and
  exchanged a message (`A received: hello-over-hyperswarm`). Its native addons
  (`udx-native`, `sodium-native`) are Node-API with linux-x64 prebuilds.
- Gotcha measured: `/tmp` is mounted `noexec` on the server, so a native addon
  installed there fails to `mmap` ("failed to map segment from shared object").
  Install under `$HOME` or the project tree, never `/tmp`.
- No first-party TypeScript types exist for hyperswarm (no `types` field, and no
  `@types/hyperswarm`); a small `.d.ts` for the surface actually used is needed.

## Smallest correct fix

`src/transport-hyperswarm.js` plus `src/hyperswarm.d.ts`. `start(self)` creates a
`Hyperswarm`, joins the topic, and treats each `connection` as a peer session
carrying the existing envelope framing; `members()` comes from live connections;
`send(envelope)` writes to one peer or fans out for a broadcast. Reuse `src/ws.js`
framing so the conformance suite sees identical semantics.

## Verification

- `e2e/conformance.js` passes for the new transport exactly as for the others.
- Live two-node check: two machines on different networks join by punch URI and a
  request/reply round-trips.
