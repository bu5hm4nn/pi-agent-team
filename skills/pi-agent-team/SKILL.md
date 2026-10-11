---
name: pi-agent-team
description: Communicate with other Pi nodes, on the same or different machines. Use when delegating work, messaging a group, or receiving a Team message/request/reply header (including localized equivalents).
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

Use `team_join` to join or change configuration. Prefer the punch URI printed
when a hyperswarm team is created; it replaces team/token/url/seeds:

```js
team_join({ punch: "punch://dev/<topic>/<token>" })
team_join({ team: "dev", token: "...", url: "http://100.64.0.1:8787" })
team_join({ team: "dev", token: "...", mode: "mesh", seeds: ["100.64.0.1:19801"] })
team_join({ team: "dev", token: "...", mode: "swim", seeds: ["100.64.0.1:7946"] })
```

- `mode`, `seeds`, and `topic` persist in local team config.
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
its own tokens. Success means the local transport accepted the message,
not that the peer received or processed it.

## Send, ask, and reply

- `team_send` wakes the peer but does not require a reply or create a reminder.
- `team_ask({ to, text })` requests an answer and reminds the peer once if it
  remains unanswered. It returns a delivery receipt immediately, not the answer.
- `team_reply({ requestId, text })` answers exactly one request. Copy the exact
  requestId from the injected message; the reply goes to the original sender.
  Unknown, already-answered, or stale ids fail without sending anything.

Both send and ask create **new messages**, never replies. If a peer has an
unanswered request, send/ask to that peer is rejected with its request id;
reply first. Unrelated peers are unaffected. A broadcast with any blocked
recipient is rejected as a whole, not partially sent. Group recipients are
frozen at dispatch time.

## Receive and reply

A `[Team message from <name>]` or `[Team request from <name>]` header (including
localized equivalents) marks another agent's message, not a human typing. Act
on its content; do not greet, repeat an acknowledgement, or ask "What should I
do?" Busy peers see messages at a turn boundary without interrupting tool calls.

Your turn output is **not** sent back automatically. Only asks require replies;
notifications do not need acknowledgements. To reply explicitly:

```js
team_reply({ requestId: "m-abc123", text: "Finished: three tests failed: ..." })
```

This answers only that request, leaving any others from the same peer pending.
An informational message can also be answered optionally using its requestId.
Pending obligations retain their requestId even when old message bodies are
compacted. Use the id, never guess a recipient or replace the reply with send/ask.

A `[Team reply from <name>]` header (or a localized equivalent) marks a reply.
**Replies need no further reply.** Use send/ask again only for a genuine follow-up
or new task; otherwise the conversation stops instead of looping.

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
