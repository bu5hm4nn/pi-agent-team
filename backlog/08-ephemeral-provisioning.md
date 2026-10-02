# 08 — ops — one-line join for a fresh, ephemeral worker

- **Area:** ops
- **Status:** queued
- **Depends on:** 02
- **Owner decision:** none

## What

A provisioning path for rented, ephemeral workers: `TEAM_PUNCH=<uri>
TEAM_TOKEN=<token> pi`, plus a `pi-agent-team-join <uri>` convenience, so a fresh
box joins with one command, outbound-only, and no inbound ports, VPN, or key
rotation.

## Evidence

The whole point of the serverless transport is the vast.ai case: a box rented for
hours, behind NAT, with nothing configured. Anything requiring a client install or
a host key is the cost being removed.

## Smallest correct fix

Document the env-var path (reusing the existing precedence, so it is one more
value rather than a new mechanism) and add a tiny join wrapper only if it earns
its place.

## Verification

- On a fresh machine with only Node and Pi, one command carrying the punch URI
  joins the team and a request/reply round-trips.
