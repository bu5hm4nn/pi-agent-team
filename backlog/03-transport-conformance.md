# 03 — conformance coverage for the hyperswarm transport

- **Area:** tests
- **Status:** queued
- **Depends on:** 01
- **Owner decision:** none

## What

`e2e/transport-hyperswarm.test.js`, driving the shared `e2e/conformance.js` suite
against the new transport, plus any suite gaps the new transport exposes.

## Evidence

The repository's stated completion rule is that a new transport "must pass the
whole suite before it counts as done". The suite is the mechanism that keeps the
transports from drifting; a transport that passes only its own tests defeats it.
`e2e/transport-mesh.test.js` and `e2e/transport-swim.test.js` are the templates.

## Smallest correct fix

A test file shaped like the mesh transport's: stand up two in-process nodes on the
new transport and run `conformance.js`.

## Verification

- The suite is green on the new transport, and unchanged on broker/mesh/swim.
