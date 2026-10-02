# 07a — docs — the punch URI and the fourth transport

- **Area:** docs
- **Status:** queued
- **Depends on:** 01, 02
- **Owner decision:** none

## What

Document the fourth transport in `README.md` and `docs/how-it-works.md`: add it to
the mode table (members found by / messages travel / needs), record the punch URI
as the entire per-worker setup, and describe the create/join flow —
`/team create <name>` prints the URI; `/team join <punch://...>` joins from
anywhere.

## Evidence

The mode table and "How it works" are the reference a node operator reads; an
undocumented fourth mode is invisible in practice. Split out of the former story
07 so Phase 1 does not depend on a Phase 2 delivery feature.

## Smallest correct fix

Extend the existing tables and sections; no new document. State plainly that the
punch URI is the team secret (it carries the token) and must not be pasted into
logs or shell history carelessly.

## Verification

- A reader with only the docs can join a node by punch URI and can explain when to
  choose the new mode over broker/mesh/swim.
