# pi-agent-team

Turn several machines running the [Pi coding agent](https://github.com/earendil-works/pi)
into one team. Each node keeps its own filesystem, session and context; they
discover each other and exchange messages over your tailnet.

No public relay, no phone app, no account.

```
  laptop                                    dev01
 ┌──────────────┐                        ┌──────────────┐
 │ pi  dev01-web│◄──── messages ────────►│ pi  srv-api  │
 └──────────────┘                        └──────────────┘
```

## What it does

- **Nodes find each other.** Every node appears in a roster with its machine and
  labels.
- **Send to one, several, a label group, or everyone.** `other`, `a,b`, `@web`,
  `*`.
- **A teammate's message reaches the model without interrupting it.** It is
  delivered as a custom message: while the agent is mid-tool-call it queues, and
  the model sees it at the next turn instead of having its work cut short.
- **The model answers with `team_send`.** No output is mirrored automatically,
  so a run that was doing something else cannot have its tail sent to the wrong
  peer as a "reply".
- **The conversation ends.** A request is answered; a reply is not. Two agents
  cannot talk in circles. Messages do not ask for a reply unless they were sent
  with `team_ask`.
- **Choosing whether a reply is wanted.** `team_send` delivers and wakes the
  peer but does not ask it to answer. Use `team_ask` only when you actually need
  an answer; the peer is then reminded once if it stays silent. Both return a
  delivery receipt immediately — neither waits for the answer.
- **You can see it.** `📥 RECV` / `📤 SEND` / `🔁 REPLY` / `⚠️ FAIL` cards in the
  transcript. Display only — they never enter the model's context.
- **Two entry points.** `/team` commands for you, `team_*` tools for the model.
  Both share one implementation, so they cannot behave differently.
- **An agent skill ships with it**, so the model knows the commands without
  being told.

## Install

```bash
pi install npm:@yiki21/pi-agent-team
```

Or from GitHub:

```bash
pi install git:github.com/Yiki21/pi-agent-team
```

Requires Node 22+ and Pi. No runtime dependencies. Everything below assumes this
is installed — there is no path to type.

## The three modes

All three share one API and pass one conformance suite, so they behave the same.
Pick one at a time.

| mode | how nodes find each other | how messages travel | needs |
|---|---|---|---|
| `broker` **(default)** | a broker you run pushes the roster | through the broker | a reachable broker URL |
| `mesh` | nodes exchange member tables directly | direct node-to-node | one seed address |
| `swim` | SWIM gossip (Go sidecar) | direct node-to-node | a seed, plus the sidecar built |

**Start with `broker`.** It is one process, it survives nodes coming and going,
and nothing needs to know anyone else's address in advance.

Use `mesh` when you want no centre and every node can reach every other. Use
`swim` when nodes actually die without saying goodbye and you need the roster to
notice.

## Use it

You need a token first. Anyone can generate one; everyone shares it.

```bash
openssl rand -hex 32
```

### Option A — broker

Run the broker on one always-on machine. It does not need Pi, only Node:

```bash
TEAM_TOKEN=<token> npx -y -p @yiki21/pi-agent-team pi-agent-team-broker --bind "$(tailscale ip -4)"
```

`pi install` puts the package somewhere that is not on your `PATH`, so the
broker command is run through `npx` rather than by name.

**For a permanent broker, use systemd** — a broker started from a terminal dies
when you close it, and one in systemd comes back after a reboot. A unit file
plus the reasoning is in [docs/systemd.md](docs/systemd.md).

Then each node:

```
/team join dev --url http://<tailnet-ip>:8787 --token <token>
```

### Option B — mesh or swim

No broker. The first node starts, everyone else points at it:

```
# first node
/team join dev --mode mesh --token <token>

# the address to hand out is printed by:
/team status

# every other node
/team join dev --mode mesh --seeds 100.64.0.1:19801 --token <token> --name dev01-web
```

For `swim`, add `--mode swim`. It also needs a sidecar, which you build once:

```bash
cd ~/.pi/agent/npm/node_modules/@yiki21/pi-agent-team/swim
go build -o ../swim-sidecar .
```

`swim` seeds use the **gossip** port, not the delivery port. `/team status`
prints the right one.

### Then talk

```
/team                     # interactive menu
/team peers               # who is online
/team send other hello
/team ask srv-api run the migration and report back
/team send "@web" deploy is starting
/team send '*' maintenance in 5 minutes
```

## Configure

Every option works three ways. They share one implementation, so what you can
set one way you can set every way.

**Startup — environment variables.** For scripts, containers, systemd:

```bash
TEAM_NAME=dev01-web \
TEAM_MODE=broker \
TEAM_URL=http://100.64.0.1:8787 \
TEAM_TOKEN=<token> \
TEAM_LABELS=web \
  pi
```

**Commands — for you.** Options are the same names:

```
/team join dev --url http://100.64.0.1:8787 --token <token> --name dev01-web
/team mode mesh
/team join dev --mode mesh --seeds 100.64.0.1:19801
```

**Tools — for the model and automation.** `team_join`, `team_info`,
`team_roster`, `team_send`, `team_ask`, `team_label`, `team_leave`. `team_join`
takes the same options as `/team join`. `team_send` and `team_ask` take the
same `to` forms; they differ only in whether a reply is requested.

| Option | Meaning | Saved? |
|---|---|---|
| `url` | broker address (broker mode) | yes |
| `token` | team token | yes |
| `mode` | `broker` / `mesh` / `swim` | yes |
| `seeds` | mesh/swim seed addresses | yes |
| `name` | this node's name | no |
| `labels` | this node's labels, for `@label` sends | no |
| `port` | mesh/swim listening port (0 = pick one) | no |
| `listen` | mesh/swim listening address | no |

Reply behaviour is a separate setting, not a connection option:

| `reply` | What it does |
|---|---|
| `off` | Never reminds. Messages still arrive; answering is the model's call |
| `remind` *(default)* | Reminds once when a request goes unanswered |
| `mirror` | Mirrors every turn's output to all nodes as `fyi` (both sides on means both keep posting) |

Set it with `reply=` / `TEAM_REPLY` / `--team-reply`, or `/team reply <mode>` at
runtime. The older names still work: `TEAM_ANNOUNCE`, `--team-announce`,
`/team announce`, and the values `auto` (now `remind`) and `always` (now
`mirror`). Using one prints a note saying what it is called now — `auto` and
`always` no longer describe what the mode does, which is why they were renamed.

### Asking for a reply (per message)

`reply` decides what this node does about *incoming* requests. Whether a
*specific* message asks for a reply is a property of that message — and it is
chosen by which tool (or command) sends it, not by a flag:

| How | Effect |
|---|---|
| `team_send({ to, text })` — or `/team send other hi` | Delivered and the peer is woken, but no reply is requested; no reminder is created. **This is the default.** |
| `team_ask({ to, text })` — or `/team ask other run the migration and report back` | The peer is asked to answer and is reminded once if it does not. |

Both return a delivery receipt immediately; `team_ask` does **not** wait for the
answer — the reply arrives later as a team message. A reply never asks for a
reply, even when it was sent to a peer you had asked: it is bound to the message
it answers, so conversations still end. On the receiving side, `reply=off` still
suppresses the reminder entirely.

The receiving agent is always woken either way — `team_ask` controls whether an
answer is *expected*, not whether the message is delivered.

The last four are not saved because one machine can run several Pi agents and
they share one config file. Saving the name would have the second agent
overwrite the first; saving the port would have it try to listen on a port
already in use. Pass them on each run.

```
/team join dev --mode mesh --seeds 100.64.0.1:19801 --name dev01-web --port 19801
```

`/team mode` switches mode without retyping `url` or `token`.

## Language

The extension's own output — menus, status lines, errors, help text — is shown
in English or Chinese. English is the base and the default; Chinese is selected
only when the locale is a positive `zh*` match.

Detection order, first hit wins:

```
--team-lang  >  TEAM_LANG  >  team config `lang`  >  LC_ALL  >  LC_MESSAGES  >  LANG  >  Pi's host locale
```

`/team lang` reports the effective locale and where it came from; `/team lang
zh-Hans` (or `en-US`) sets it. A value set this way is saved in the current
team's config and its runtime messages apply immediately — the flag and command
help is registered when the extension loads, so it applies the next time Pi
starts. With no team bound it is session-only; use `--team-lang` or `TEAM_LANG`
to keep it across sessions.

The text sent to the model — tool descriptions, the system-prompt team section,
and the injected teammate-message templates — is intentionally **not** localized
yet; it stays Chinese while an upstream contribution is attempted.

## How it works

[`docs/how-it-works.md`](docs/how-it-works.md) covers:

- the three transports in detail, and which to pick
- what a message flows through, and the rules that end a conversation
- SWIM mode: why the sidecar is Go, and its two ports
- the security model, and what a stolen token gets an attacker
- design notes that were measured rather than assumed
- how to run the tests
- known limitations

## Requirements

- Node 22+
- Pi
- [Tailscale](https://tailscale.com/) or any private network — the broker binds
  a single non-public address
- Go, only for `swim` mode

## License

MIT
