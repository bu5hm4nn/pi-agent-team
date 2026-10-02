# 10 — room-scoped tool and command API

- **Area:** rooms
- **Status:** queued
- **Depends on:** 09
- **Owner decision:** none

## What

Make every team tool and command take a room: `team_send({ room, to, text })`,
`team_roster({ room })`, `team_info({ room })`, `team_label({ room, ... })`, and a
new `team_rooms()`; `/team create|join|leave <room>`. The default when `room` is
omitted must be unambiguous — a single active room, or an explicit error when
several are joined.

## Evidence

Today the tools are implicitly "the one team" (`team_send(to, text)`). With many
rooms, a message with no room is a correctness hazard: sending a `photogram`
update into `colmap`'s room is exactly the cross-project leak the phase exists to
prevent.

## Smallest correct fix

Thread a `room` parameter through the existing handlers against the registry from
story 09, and add `team_rooms`. Keep the tool names, and the frozen
description-string tests, intact where possible.

## Verification

- Each tool acts only on the named room.
- With multiple rooms joined, an omitted `room` is a clear error rather than a
  silent guess.
