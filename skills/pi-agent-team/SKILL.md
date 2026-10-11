---
name: pi-agent-team
description: Communicate with other Pi nodes, on the same or different machines. Use when delegating work, messaging a group, or receiving a Team message/reply header (including localized equivalents).
---

# Pi Agent Team

Each node is another running Pi with its own session and context. Identify nodes
by name, not IP. Follow the human conversation language; team semantics do not
change with language.

## Check membership

The system prompt's `## Team` section lists your node name and labels, online
nodes grouped by host, and available `@label` groups. Without that section, do
not call `team_send`. Get recipient names from the roster; never guess them.

## Join and configure

Use `team_join` to join or change configuration:

```js
team_join({ team: "dev", token: "...", url: "http://100.64.0.1:8787" })
team_join({ team: "dev", token: "...", mode: "mesh", seeds: ["100.64.0.1:19801"] })
team_join({ team: "dev", token: "...", mode: "swim", seeds: ["100.64.0.1:7946"] })
```

- `mode` and `seeds` persist in local team config.
- `name`, `labels`, `port`, and `listen` affect only this run. Multiple Pi nodes
  may share one machine's config; persisting identities or ports would collide.
- Changing `mode` preserves existing `url` and `token`.
- Use `team_info` for configuration/status and `team_roster` for online nodes.
- Never guess tokens or addresses. Ask the user for missing credentials.

## Send

Use `team_send({ to, text })`. Recipients can be a node name (`"laptop-web"`),
comma-separated names (`"web1,db1"`), a label (`"@web"`), or everyone else (`"*"`).
`"@default"` selects the default group.

```js
team_send({ to: "dev01-api", text: "Run integration tests on dev and report failures." })
team_send({ to: "@web", text: "Frontend dependencies changed; rebuild your projects." })
```

Be sparing with broadcasts: each recipient spends a full reasoning turn and
its own tokens. Success means the message was written to the peer's socket,
not that the peer has processed it.

## Receive and reply

A `[Team message from <name>]` header (or a localized equivalent) marks a
teammate's request, not a human typing. Act on the content; do not greet,
repeat an acknowledgement, or ask "What should I do?" Messages arriving while
you are busy wait for a turn boundary and do not interrupt tool calls.

Your turn output is **not** sent back automatically. Reply explicitly:

```js
team_send({ to: "laptop-web", text: "Finished: three tests failed: ..." })
```

Sending to the requester automatically associates the reply with its request;
no extra parameter is needed. Notifications and greetings may need no reply.
The system reminds you at most once.

A `[Team reply from <name>]` header (or a localized equivalent) marks a reply
to your earlier message. Its scaffold quotes that message for context.
**Replies need no further reply.** Only call `team_send` again for a genuine
follow-up or new task. Otherwise the conversation stops rather than looping.

## Delegate effectively

Cross-node communication takes seconds and starts a full reasoning turn.
Include background, desired output, and acceptance criteria in one message.
Delegate complete work units rather than high-frequency back-and-forth. The
recipient may be busy; continue your own work after sending.

## Offline peers and boundaries

If delivery fails or a node is not found, check the roster or do the work
locally. The broker has no offline queue; undelivered messages are lost.

Broker messages are plaintext at the broker (the underlying tailnet link is
WireGuard-encrypted). Do not send secrets or credentials. Peers cannot see
your conversation history; include the context they need.
