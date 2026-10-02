# AGENTS.md

## Mission

Let several machines running the Pi coding agent work as one team with the fewest
moving parts — and, for rented and ephemeral workers, with no per-machine network
setup at all. Today that means a fourth transport built on hyperswarm
(Holepunch): DHT discovery, UDP hole punching, Noise per-connection encryption, so
a fresh worker joins by presenting a single punch URI.

## HANDOFF.md — keep it current

The root `HANDOFF.md` is the next session's entry point and you own keeping it
accurate. Update it before a session ends: branch and commit state, what landed,
verification evidence, what remains, and the next task (or an explicit "none
pending"). A stale handoff is a defect.

**Write it ahead, not behind.** A handoff that ships inside a PR must describe the
state that exists *once that PR merges* — "landed as PR #N", never "awaited".

## Backlog discipline

`backlog/index.yaml` is the decision of record; `backlog/NN-*.md` are the stories.
A story's `Area:`, `Depends on:` and `Owner decision:` must agree with its
`index.yaml` entry, and the PR that lands a story also sets its `Status` in the
file **and** in `index.yaml` in that same PR.

## Validate before claiming done

- `npm test` (runs `node --test src/ e2e/`; Node >= 22)
- `git diff --check`
- LSP diagnostics on changed JavaScript.

## A new transport must pass the whole conformance suite

`e2e/conformance.js` is the contract that keeps broker, mesh and swim from
drifting. A new transport is not done until it passes the same suite, driven by
its own `e2e/transport-<mode>.test.js`. Do not relax the suite for a new transport.

## Hyperswarm notes

- Install under `$HOME` or the project tree, **never `/tmp`** — the servers mount
  `/tmp` `noexec`, so a native addon there fails to `mmap`
  ("failed to map segment from shared object").
- hyperswarm has no first-party TypeScript types; add a local `.d.ts` for the
  surface actually used rather than pulling a random `@types` package.
- Verified working on the target hosts: Node 24, Debian glibc 2.36; two peers join
  a topic and exchange a message.

## Working rules

- Minimal changes; no over-engineering; check the live stable version before
  adding any new dependency.
- Implement with a worker subagent, then an independent read-only reviewer.
- Never push, open a PR, merge, or delete branches without explicit authorization.
- Upstream is `github.com/Yiki21/pi-agent-team`; this working fork is
  `github.com:bu5hm4nn/pi-agent-team`. Prefer upstreamable changes over private
  divergence, and keep any transport fork separable from generic delivery fixes.

Planner model for backlog work: **openai-codex/gpt-6-astra**.
