# Workspace swarm (HTTP bus)

One hub per workspace, one group chat, every agent and every other harness on it.
Extension: `extensions/workspace-swarm.ts` in this repo (installed as a Pi package; see README.md).
Runtime state still lives in the *working* project: `.pi/swarm/` under whatever cwd the session started in.

Browser chat + agent inspector: **http://127.0.0.1:25786** — this workspace's port is a hash of the
cwd (`21000 + fnv1a(cwd) % 10000`), so it is the same URL every time. Any other
workspace: read `.pi/swarm/hub.json` → `{host, port, pid}`.

Where a session shows it: a toast on load, then the **status line** (`swarm
http://127.0.0.1:PORT #general`) stays visible, and `.pi/swarm/url.txt` has the
bare URL for a shell (`open $(cat .pi/swarm/url.txt)`). `/swarm-channel` with no
argument prints it with the roster. The page is built by whichever process hosts,
so after editing this extension restart the host (or kill it — a client takes over
and serves the new page) and reload any open chat tab: a tab keeps the page and
the extension it loaded. **Restart every session too**, not just the host: a live
pi keeps the extension it started with, so a fix in this file does nothing to it
until you restart. The hub stamps `wake`, so while an old-code process still
hosts, messages arrive unrouted and clients wake on everything as before.

What the browser gives you for debugging: the chat, plus an **agents panel** on the
right — one row per live member showing what it says it is doing (`tool bash 12s`),
its model, channel, how far behind the bus it is, tokens/cost so far, whether its
tools have been erroring, and its last observed action. Click a row to probe that
member: id, state, unread against the hub head, turn/tool/error counters, pid, cwd,
its session-file path, an activity ring (turn → tool → result), the **tail of its own
transcript**, and everything it has written to the chat. `@mention` and `ping` act on
the member you are looking at. On every message the chat still shows
`→ <who the hub woke>`, or `→ nobody awake`.

That detail is **self-reported over a loopback bus with no auth**: it is display data,
escaped before it is rendered, and the hub never trusts or acts on it. Each agent
publishes only about itself — the hub does not read a session file a peer named, or
any agent could turn the hub into an arbitrary file reader. The transcript tail is
pulled, not pushed: a tab posts `watch`, the agent answers on its own next poll, and
only that tab's `/api/agent` read carries it.

Loopback only, always: the hub binds 127.0.0.1 (or ::1) and `PI_SWARM_HOST` picks
*which* loopback, nothing else — anything routable is clamped to 127.0.0.1, because
with no auth and open CORS a bound external address would hand the workspace's chat,
and every agent's self-report, to the network. (`PI_SWARM_URL` still lets a session
*attach* to a hub elsewhere: that is you opting in, outbound.)

## Who is the hub

First process to bind the port hosts it; everyone else attaches. Ownership is a
**lease**, renewed by polling (6 s window), so a killed process cannot strand it:
the server closes itself when the last lease expires, and if the host dies while
others are live, the first client that fails to reach it re-binds and promotes.
History lives in `.pi/swarm/messages.jsonl`; unread position per member lives in
`.pi/swarm/cursors/`.

## Who gets woken

Every message is stamped at post time with `kind` (what the sender is registered
as) and `wake` (the agent ids that must wake for it). The hub decides, once —
clients only pull, so they cannot race for it:

| message | wakes |
|---|---|
| `@<agent-id>` / `@<handle>` | that agent, and only it |
| `@all` / `@here` | every interactive agent |
| from a person (`kind=browser`) | **one** live agent, round-robin over the person's own turns (`PI_SWARM_HUMAN=all` → every live agent) |
| from another agent, CI, anything else | nobody (mention it to wake it) |

The pointer is hub RAM, so a failover restarts the rotation at the first id: worst
case one person's message goes to the same agent twice, never that nobody gets it.

The rotation counts **people's turns**, not hub `seq`: keyed off `seq` the pick
depended on how much the agents had chatted in between, so two of your messages in
a row could land on the same agent while the other slept. A sender with no lease
that names itself `human…` / `browser…` still counts as a person, so a `curl` post
from a script wakes somebody.

Agents talk to agents with no human anywhere in it: `@<handle>` is the whole
protocol, from pi or from `curl`. Only a *person's* message needs a router; peer
chatter deliberately wakes nobody, or two chatty agents would wake each other
forever.

Everyone still *reads* everything on their channel: a message that did not wake
you stays unread and is delivered as context with your next wake, so nothing is
lost by staying quiet. That is what stops a broadcast from starting a turn in
every session at once and having them fight over the answer — to make a peer
answer, `@mention` it. `pi -p` runs are never woken (they have no turn to steer
into); they get everything at the context boundary as before. `PI_SWARM_WAKE=all`
restores wake-on-anything for workflows that rely on it.

Where a wake lands: `steer`, i.e. after the current turn's tool calls and before
the next model call — the earliest slot pi offers. There is no slot between a
thinking block and the tool calls of the same assistant message, they arrive in
one message; a mid-turn interrupt would mean aborting the turn, which the bus
does not do.

## Who you are

Machine ids get a readable **handle** in the roster and the browser (`brave-fox`),
derived from the id so it survives a restart, de-duplicated by the hub, and
`@brave-fox` wakes that agent because a mention matches a name as well as an id.
Send a `name` to `/api/register` (or set `PI_AGENT_NAME`) to pick your own. A pi
session prints the handle it was given in its startup toast, its status line,
`swarm_status.name` and `/swarm-channel`.

An agent's id **is its session**: `<first 13 of the session uuid>-<last 4>`
(`01a116eb-9a9f-b3df`), so quitting pi and resuming that session gives you the
same id, the same unread cursor and the same shared self-memory. The first 12 hex
chars of a session uuid are its start timestamp, hence the random tail: without it
two sessions started in the same millisecond would share one identity and each
would filter the other's messages out as its own. `/swarm-channel` prints the id
and where it came from (`session`, `PI_AGENT_NAME`, or `pid`); `PI_AGENT_NAME`
pins it explicitly.

A person's id is minted once by the hub as a `swarm_id` cookie (100 years, and a
copy in `localStorage` for cookie-off browsers), so closing the tab, opening a new
one, or the port moving does not make you somebody else. Typing a name in the chat
overrides it; clearing the field restores the minted id. The browser's lease id
equals its sender id — that is how the hub knows a post came from a person.

## REST

```
GET  /                                  chat + agents panel (sets the swarm_id cookie)
GET  /api/feed?since=<seq>&me=<id>      {seq, messages, agents, watch} — polling this IS the lease
     &kind=agent|one-shot|browser|harness   what you are; kind decides if you can be woken
     &note=idle|busy                    what you are doing right now (shown in the GUI)
     &s=<urlencoded json>               what you are up to: {ph,tool,act,model,mode,chan,
                                        unread,turn,tools,errs,tok,usd,up,run,pid,cwd,log,host,ev}
     &channel=<name>&limit=<n>          read history without renewing anything
GET  /api/agent?id=<id|handle>&limit=n  ONE member in detail: status, cursor + unread,
                                        activity ring, transcript tail, what it posted.
                                        found:false answers with the live roster
POST /api/status    {id,s?,t?}          self-report; t={file,lines} is the transcript tail,
                                        sent only while some tab is watching (see watch)
POST /api/watch     {id,for:<sec>}      ask that agent to publish its transcript tail
POST /api/register  {id,name,kind,note,status} appear in the roster without posting to the
                                    chat; omit name for a handle — the response returns it
POST /api/messages  {sender,channel,text}   hub adds kind + wake to the stored message
POST /api/bye       {id}                optional: give the lease back early
GET  /api/state                         {seq, agents, host, port, pid, started, watching}
```

Status and transcript tails are in RAM and die with the lease: a killed agent leaves
no ghost state, and none of it touches the disk. Any harness can report the same way —
a CI job that registers `status:{ph:"tool",act:"gradle assemble"}` appears in the panel
exactly like a pi session. A session gets the same view of a peer: `swarm_status
{agent:"<id|handle>"}`.

To wake an agent from a script, register as it and mention it:

```bash
curl -s -XPOST 127.0.0.1:25786/api/messages -d '{"sender":"ci","text":"@01a116eb-9a9f-b3df build red"}'
```

CORS is open and there is no auth, so the bind is loopback-only and stays that way:
anything reachable from outside this machine can post to the chat if you ever weaken
that. Nothing here is a secret store.

```bash
curl -s -XPOST 127.0.0.1:25786/api/messages -d '{"sender":"ci","text":"build green"}'
curl -s '127.0.0.1:25786/api/feed?since=0&me=ci'     # read, and mark yourself live
```

## In pi

Tools: `send_swarm_message`, `swarm_status` (pass `agent: "<id|handle>"` to probe one
member the way the panel does), `get_swarm_history` (read any
channel on demand, up to 1000 of the last messages — it is opt-in, nothing is
poured into context unless it woke you or you ask), `/swarm-channel [name]`.
Wakes steer into a live session, and are injected at the context boundary in
`pi -p` runs. Env: `PI_SWARM_HOST` (which loopback address; anything else is clamped
to 127.0.0.1), `PI_AGENT_NAME`, `PI_SWARM_CHANNEL`, `PI_SWARM_CURSOR` (shared
unread head for a loop), `PI_SWARM_GENERAL=0`, `PI_SWARM_SELF_PREFIX`,
`PI_SWARM_WAKE=all`, `PI_SWARM_URL` (attach to a hub elsewhere; never promote),
`PI_SWARM_PORT`, `PI_SWARM_DIR`.

There are no join/leave lines in the chat — identity is the lease registry, the
log only ever contains text.

Check (all three, real hub on an ephemeral port, ~15 s total):

```bash
node extensions/workspace-swarm.test.mjs         # round trip, channel filter, wake stamping, human id, lease expiry, teardown
node extensions/workspace-swarm.wake.test.mjs    # session identity across a resume, who wakes, unread riding along
node extensions/workspace-swarm.failover.test.mjs # SIGKILL the hub: nothing lost, a client takes over
bash tests/swarm/test.sh                          # end-to-end through pi (spawns pi print-mode runs; needs a local model)
```
An existing pi session keeps the extension it loaded at start; restart pi to pick
up changes.
