// node extensions/workspace-swarm.wake.test.mjs
// Identity across a resume, and who gets woken. Interactive sessions only:
// a print run has no turn to steer into, so it is never woken at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "swarm-wake-"));
// Must be set BEFORE the import: DIR/PORT are read once at module load.
process.env.PI_SWARM_DIR = path.join(dir, "swarm");
process.env.PI_SWARM_PORT = "0";
delete process.env.PI_AGENT_NAME; // identity must come from the session

const { default: ext } = await import("./workspace-swarm.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, p, body) =>
  (
    await fetch(base + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)
  ).json();

// One live session: fake pi, with sendUserMessage recorded instead of injected.
let idle = true;
const makeSession = (sessionId) => {
  const handlers = {};
  const sent = [];
  const pi = {
    on: (e, h) => (handlers[e] = h),
    registerTool: () => {},
    registerCommand: () => {},
    sendUserMessage: (text, opts) => sent.push({ text, opts }),
  };
  const ctx = {
    hasUI: true,
    isIdle: () => idle,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: () => {}, setStatus: () => {} },
  };
  ext(pi);
  return { handlers, sent, ctx };
};

const SESSION = "01a116eb-9a9f-76b6-912b-253442b5b3df";
const A = makeSession(SESSION);
await A.handlers.session_start({}, A.ctx);
const hub = JSON.parse(fs.readFileSync(path.join(process.env.PI_SWARM_DIR, "hub.json"), "utf-8"));
const base = `http://127.0.0.1:${hub.port}`;
// Something that is not an agent, so the bus outlives each session in this test.
await api(base, "/api/register", { id: "watcher", name: "Watcher", kind: "harness" });

// Keep the bus up between the sessions below: a hub with no live lease closes.
const keepalive = setInterval(() => void api(base, "/api/feed?since=0&me=watcher&kind=harness"), 2000);
keepalive.unref?.();
const human = async (text) => {
  await api(base, "/api/feed?since=0&me=human-abc&kind=browser"); // the person's tab
  return api(base, "/api/messages", { sender: "human-abc", channel: "general", text });
};

// --- identity: the session IS the agent id -----------------------------------
// The id is what every lease the session renews is keyed by, so the roster shows it.
const roster = async () => (await api(base, "/api/feed?since=0")).agents.map((a) => a.id);
assert.ok((await roster()).includes("01a116eb-9a9f-b3df"), "id = session head + random tail: " + (await roster()));

// A second session started in the same millisecond must not collide: the old
// slice(0,13) was pure timestamp, so it gave both of them one identity.
const SAME_MS = "01a116eb-9a9f-76b6-912b-253442b5b3aa";
const C = makeSession(SAME_MS);
await C.handlers.session_start({}, C.ctx);
assert.notEqual((await roster()).length, 1, "two live sessions");
assert.ok((await roster()).includes("01a116eb-9a9f-b3aa"), "the tail separates sessions started in the same millisecond");
await C.handlers.session_shutdown({ reason: "quit" }, C.ctx);

// A resumed session (same session id) is the same agent, with its unread cursor.
await human("before the restart");
await sleep(1300); // one poll: A takes it
assert.equal(A.sent.length, 1, "the live session is woken for the person's message");
await A.handlers.session_shutdown({ reason: "quit" }, A.ctx);

// Simulate `pi --resume`: same session id, a brand-new extension instance.
process.env.PI_AGENT_NAME = ""; // still session-derived
const B = makeSession(SESSION);
await B.handlers.session_start({}, B.ctx);
await sleep(1300);
assert.equal(B.sent.length, 0, "a resume does not replay what the session already read");
await human("after the restart");
await sleep(1300);
assert.equal(B.sent.length, 1, "and it still gets what arrives after the resume");
assert.match(B.sent[0].text, /after the restart/);
await B.handlers.session_shutdown({ reason: "quit" }, B.ctx);

// --- wake routing ------------------------------------------------------------
process.env.PI_AGENT_NAME = "me"; // deterministic id for the rotation asserts
const M = makeSession(SESSION);
await M.handlers.session_start({}, M.ctx);
await api(base, "/api/register", { id: "otherbot", name: "otherbot", kind: "agent" });

// Peer chatter wakes nobody, and does not move our cursor: it is unread context.
await api(base, "/api/register", { id: "peer-1", name: "peer-1", kind: "agent" });
const seqBefore = (await api(base, "/api/state")).seq;
await api(base, "/api/messages", { sender: "peer-1", channel: "general", text: "untracked chatter" });
await sleep(1300);
assert.equal(M.sent.length, 0, "peer chatter must not start a turn in every session");
await api(base, "/api/messages", { sender: "peer-1", channel: "general", text: "@otherbot take this one" });
await sleep(1300);
assert.equal(M.sent.length, 0, "a message addressed to another agent is not ours to answer");

// A wake brings the held chatter along, so nothing is lost by staying quiet.
await human("ping @me: status?");
await sleep(1300);
assert.equal(M.sent.length, 1, "an @mention of us wakes us once, not once per message");
assert.match(M.sent[0].text, /HUMAN/, "a person's message is labelled as a person, not as a peer");
assert.match(M.sent[0].text, /untracked chatter/, "the unread chatter rides along with the wake");
assert.match(M.sent[0].text, /for="otherbot"/, "and says who the other message was for");

// Busy: the wake steers into the running turn instead of queueing behind it.
idle = false;
await human("ping @me: stop and look at this");
await sleep(1300);
assert.equal(M.sent.length, 2, "a busy session still gets the wake");
assert.equal(M.sent[1].opts?.deliverAs, "steer", "delivered as a steer: pi injects it at the next turn boundary");
assert.ok((await api(base, "/api/state")).seq >= seqBefore + 4, "the hub kept counting while we stayed quiet");

// --- round robin over the PERSON's turns, not over hub seq -------------------
// The bug this pins: rotation keyed off m.seq meant the parity of the global
// message counter picked the agent, so an agent's own replies could hand the
// human's next two messages to the same session while the other one slept.
const alive = (id) => api(base, `/api/feed?since=0&me=${id}&kind=agent`);
// Exactly two live agents for these asserts: a third live session would make the
// 3-way rotation legitimate. peer-1 only sends below, which needs no lease.
await api(base, "/api/bye", { id: "peer-1" });
const asHuman = async (text, sender = "human-abc") => {
  await api(base, "/api/feed?since=0&me=human-abc&kind=browser"); // the tab's lease
  return api(base, "/api/messages", { sender, channel: "general", text });
};
await alive("otherbot");
const turn1 = await asHuman("round one");
for (let i = 0; i < 3; i++) await api(base, "/api/messages", { sender: "peer-1", channel: "general", text: `chatter ${i}` });
await alive("otherbot");
const turn2 = await asHuman("round two");
await alive("otherbot");
const turn3 = await asHuman("round three");
assert.equal(turn1.wake.length, 1, "a person's message still goes to one agent");
assert.notEqual(turn1.wake[0], turn2.wake[0], "the person's next turn goes to the OTHER agent, however much chatter fell between");
assert.equal(turn3.wake[0], turn1.wake[0], "and the two alternate");

// A person posting from a shell holds no lease, so kind used to come out unknown
// and nobody was woken at all.
const cli = await api(base, "/api/messages", { sender: "human-cli", channel: "general", text: "posted from curl" });
assert.equal(cli.kind, "browser", "a human-prefixed sender with no lease is still a person");
assert.equal(cli.wake.length, 1, "and somebody wakes for it");

// PI_SWARM_HUMAN=all: both agents on a person's message, nobody on peer chatter.
process.env.PI_SWARM_HUMAN = "all";
await alive("otherbot");
const fanout = await asHuman("you two, talk to each other");
delete process.env.PI_SWARM_HUMAN;
assert.equal(fanout.wake.length, 2, "PI_SWARM_HUMAN=all wakes every live agent for a person");
const chatter = await api(base, "/api/messages", { sender: "peer-1", channel: "general", text: "peer to peer" });
assert.equal(chatter.wake.length, 0, "peer chatter still wakes nobody: agents cannot ping-pong each other awake");
const asked = await api(base, "/api/messages", { sender: "peer-1", channel: "general", text: "@me your turn" });
assert.deepEqual(asked.wake, ["me"], "agent-to-agent works headlessly on an @mention, no human involved");

await M.handlers.session_shutdown({ reason: "quit" }, M.ctx);
clearInterval(keepalive);
await api(base, "/api/bye", { id: "watcher" });
await api(base, "/api/bye", { id: "otherbot" });
await api(base, "/api/bye", { id: "peer-1" });
fs.rmSync(dir, { recursive: true, force: true });
console.log("workspace-swarm wake/identity: all asserts pass");
