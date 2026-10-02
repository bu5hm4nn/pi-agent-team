# 02 — punch URI — one string a fresh worker can present

- **Area:** transport
- **Status:** queued
- **Depends on:** 01
- **Owner decision:** none — settled as `punch-uri-two-secrets-no-host-key`
  (see `index.yaml`)

## Settled design (council review, 2026-10-02)

- URI format is `punch://<name>/<topic>/<token>`: `<name>` is a non-secret label,
  `<topic>` is the 32-byte capability (base64url) and `<token>` is the team token.
  The former "host hint" is dropped.
- `/team create <name>` defaults to the hyperswarm mode, generates the token and
  topic, persists them (`0600`) and prints the URI once (re-printing it when the
  team already exists). `/team join <uri>` takes only the URI.
- A malformed or foreign-scheme string is refused with a reason, never treated as
  a team name or seed.

## What

`/team create <name>` produces one pasteable URI carrying everything needed to
join the room: the room's topic, the room token, and a host hint (semantics
pending `host-key-semantics`). `/team join <uri>` consumes it. The same value is
accepted via `TEAM_PUNCH` and `team_join`, mirroring how `url` and `seeds` already
work three ways.

## Evidence

The target is a rented, ephemeral GPU worker (vast.ai): a per-worker VPN client,
key rotation, or a known seed address is the cost being removed. The punch URI is
the entire per-worker setup. Both `seeds` and `url` assume a reachable address
that an ephemeral, NAT'd worker does not have; the DHT topic removes that
assumption.

## Smallest correct fix

`parsePunchUri()` in `src/options.js` and a mode-agnostic acceptance path in
`src/mode.js`; the transport receives a resolved topic and the handshake receives
the token. Encoding is fixed by `host-key-semantics` and
`topic-derivation-and-encoding`.

## Verification

- Two nodes join with only the punch URI (no seeds, no url) and exchange a
  message.
- A malformed URI is refused with a reason, not silently treated as a seed.
