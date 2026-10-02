# 09 — multi-room session core — one session, many rooms

- **Area:** rooms
- **Status:** queued
- **Depends on:** 01, 02
- **Owner decision:** multi-room-membership

## What

Replace the session's singular team state with a room registry, so one pi session
can hold many isolated rooms at once. `index.ts` currently keeps `let state`,
`let transport`, `let currentTeam`, `let currentConfig`, `let connState` as
module-level singletons; they become a `rooms` map keyed by room, each entry
holding its own transport and `createSessionState()` instance.

## Evidence

- `index.ts` singletons: `state = createSessionState()`, `transport`,
  `currentMode`, `connState`, `currentTeam`, `currentConfig` — one of each per
  process.
- `src/team-config.js` already persists one config file per named team
  (`~/.pi/agent/pi-agent-team/<team>.json`, `listTeams`), so per-room persistence
  exists; only the active-connection layer is singular.
- `createSessionState(self)` is already per-instance, so per-room roster, hops and
  reply tracking come for free.
- Rooms stay isolated by construction: a room is a hyperswarm topic, and distinct
  topics never discover each other.

## Smallest correct fix

A `RoomHandle` (`name`, `topic`, `token`, `transport`, `state`, `connState`) and a
`Map<string, RoomHandle>`, plus create/join/leave lifecycle. No transport changes —
one transport instance per room, exactly as today's single one.

## Verification

- Two rooms active in one session; each keeps its own roster, reply tracking and
  hop counts; no state crosses between them.
- Leaving one room does not disturb the other.
