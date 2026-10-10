// node extensions/workspace-swarm.test.mjs
// Drives the extension through a fake ExtensionAPI: real HTTP hub, real leases.
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "swarm-"));
process.env.PI_SWARM_DIR = path.join(dir, "swarm");
process.env.PI_SWARM_PORT = "0"; // ephemeral: parallel-safe
process.env.PI_AGENT_NAME = "testbot";
// The bus has no auth, so it must refuse to bind anything but loopback even when
// the environment asks for a routable address.
process.env.PI_SWARM_HOST = "0.0.0.0";

const { default: extension, tailSession } = await import("./workspace-swarm.ts");

const handlers = {};
const tools = {};
const fakePi = {
  on: (e, h) => (handlers[e] = h),
  registerTool: (t) => (tools[t.name] = t),
  registerCommand: (n, c) => ((tools[n] = c), n),
  sendUserMessage: () => {
    throw new Error("one-shot run must not steer");
  },
};
const notices = [];
const ctx = { hasUI: false, sessionManager: { sessionId: "testbot-session" }, ui: { notify: (m) => notices.push(m) } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, p, body) => {
  const r = await fetch(base + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  return r.json();
};
// Ask the kernel, not fetch: a keep-alive socket can outlive server.close().
const up = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.setTimeout(400);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.once("timeout", () => (s.destroy(), resolve(false)));
  });
const waitFor = async (fn, ms = 5000) => {
  for (let t = 0; t < ms; t += 200) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
};
const tool = async (name, args) => (await tools[name].execute("id", args)).content[0].text;

// Run the page's inline script against a stub DOM. Compiling it is not enough:
// a helper missing at runtime throws inside tick()'s try and used to be
// mislabelled "hub unreachable" while the chat stayed blank.
const boot = (html, fetchImpl, cookie = "") => {
  const els = {};
  const qsel = (sel) =>
    (els[sel] ||= { innerHTML: "", textContent: "", value: "", scrollHeight: 100, scrollTop: 0, clientHeight: 50 });
  let tick = null;
  const urls = [];
  const spy = async (u, o) => (urls.push(String(u)), fetchImpl(u, o));
  const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
  new Function("document", "fetch", "localStorage", "setInterval", "location", "URLSearchParams", "console", src)(
    { querySelector: qsel, cookie },
    spy,
    {},
    (fn) => (tick = fn),
    { search: "" },
    URLSearchParams,
    { error() {}, log() {} }, // the deliberate broken render must not spam the test
  );
  return { els, tick, urls };
};
const okFeed = async (u) => ({
  json: async () => {
    // The sidepanel asks for one member in detail; answer it like the hub would.
    if (String(u).startsWith("/api/agent"))
      return {
        found: true, id: "ci", name: "CI", kind: "harness", seq: 12, live: true, seen_ms_ago: 900, watched: true,
        cursor: 10, unread: 2,
        status: { ph: "tool", tool: "bash", act: "npm <test>", model: "acme/x", mode: "live", chan: "general", turn: 2, tools: 5, errs: 0, tok: 80, usd: 0.2, up: 90, run: 4, pid: 7, host: 1, cwd: "/w", log: "/w/s.jsonl", ev: ["00:00:01 turn #2", "00:00:02 bash npm test"] },
        transcript: { at: Date.now(), lines: [{ r: "assistant", txt: "probing <b>" }, { r: "tool", txt: "bash make" }] },
        posted: [{ seq: 11, channel: "general", text: "build green" }],
      };
    return {
      seq: 10,
      messages: [
        { seq: 9, sender: "ci", channel: "general", text: "build green", ts: "2026-01-01T00:00:09.000Z" },
        { seq: 10, sender: "x", channel: "general", text: "<img onerror=alert(1)>", ts: "2026-01-01T00:00:10.000Z" },
      ],
      agents: [
        { id: "ci", name: "CI", kind: "harness", note: "jenkins", ts: Date.now(), s: { ph: "tool", tool: "bash", act: "npm <test>", model: "acme/x", chan: "general", unread: 2, tok: 99, usd: 0.5, errs: 1, run: 4, host: 1, ev: ["00:00:02 bash npm test"] } },
      ],
    };
  },
});

extension(fakePi);
assert.deepEqual(Object.keys(tools).sort(), ["get_swarm_history", "send_swarm_message", "swarm-channel", "swarm_status"], "same tool surface as the file bus");
await handlers.session_start({}, ctx);
const hub = JSON.parse(fs.readFileSync(path.join(process.env.PI_SWARM_DIR, "hub.json"), "utf-8"));
const base = `http://127.0.0.1:${hub.port}`;
assert.equal(hub.pid, process.pid, "hub.json records the host pid");
assert.equal(hub.host, "127.0.0.1", "PI_SWARM_HOST=0.0.0.0 still binds loopback only");
assert.equal((await api(base, "/api/state")).host, "127.0.0.1", "and says so over REST");
assert.ok(await up(hub.port), "fresh hub is listening");
assert.equal((await api(base, "/api/state")).seq, 0, "fresh hub at seq 0");

// REST in, tool out (and back): the group-chat round trip.
await api(base, "/api/messages", { sender: "ci", channel: "general", text: "build green" });
assert.match(await tool("get_swarm_history", {}), /build green/);
assert.match(await tool("send_swarm_message", { message: "hi from pi", channel: "review" }), /Sent to #review/);
const fed = await api(base, "/api/feed?since=0");
assert.deepEqual(fed.messages.map((m) => [m.seq, m.sender, m.channel]), [[1, "ci", "general"], [2, "testbot", "review"]], "seq is monotonic across senders");

// The hub is the single source of truth for who is here.
await api(base, "/api/register", { id: "loop", name: "Nightly loop", kind: "harness", note: "pi -p" });
const st = JSON.parse(await tool("swarm_status", {}));
assert.equal(st.hosted_by_me, true);
assert.deepEqual(st.peers.map((a) => a.id).sort(), ["loop", "testbot"], "registry lists agents and foreign harnesses");

// Delivery filter: own messages never come back, #general always, other channels only on @mention.
let injected = [];
const contextHook = (msgs) => injected.push(...msgs);
for (const [text, chan, want] of [
  ["noise elsewhere", "backend", false],
  ["ping @testbot in the backend", "backend", true],
  ["everyone sees general", "general", true],
]) {
  await api(base, "/api/messages", { sender: "peer", channel: chan, text });
  const event = { messages: [] };
  await handlers.context(event, ctx);
  injected.push(...event.messages.map((m) => m.content));
  assert.equal(injected.join("\n").includes(text), want, `delivery of "${text}" in #${chan}`);
}
assert.ok(injected.every((t) => !t.includes("noise elsewhere")), "channel filter holds");

// Wake routing: the hub decides WHO wakes, so a broadcast cannot stampede every
// session into the same reply. Only kind=agent is wake-able (a print run has no
// turn to steer into), a person's message goes to one agent, and a mention
// overrides the rotation.
await api(base, "/api/register", { id: "otherbot", name: "otherbot", kind: "agent" });
await api(base, "/api/register", { id: "thirdbot", name: "thirdbot", kind: "agent" });
await api(base, "/api/feed?since=0&me=human-abc&kind=browser"); // a live person's tab
const live = ["otherbot", "thirdbot"];
const posted = await api(base, "/api/messages", { sender: "human-abc", channel: "general", text: "which of you answers?" });
assert.equal(posted.kind, "browser", "the hub stamps what the sender is registered as");
assert.equal(posted.wake.length, 1, "one agent is woken for a person's message, not all of them");
assert.ok(live.includes(posted.wake[0]), "a print run (one-shot) is never woken: " + posted.wake);
const second = await api(base, "/api/messages", { sender: "human-abc", channel: "general", text: "still there?" });
assert.ok(live.includes(second.wake[0]) && second.wake[0] !== posted.wake[0], "the next message rotates to the other live agent");
const chatter = await api(base, "/api/messages", { sender: "otherbot", channel: "general", text: "untracked noise" });
assert.deepEqual(chatter.wake, [], "peer chatter wakes nobody: it is unread context");
const pinged = await api(base, "/api/messages", { sender: "otherbot", channel: "general", text: "ping @otherbot" });
assert.deepEqual(pinged.wake, ["otherbot"], "an @mention beats the rotation");
const asleep = await api(base, "/api/messages", { sender: "otherbot", channel: "general", text: "ping @testbot" });
assert.deepEqual(asleep.wake, [], "a print run has no turn to steer into, so nothing wakes it");
const every = await api(base, "/api/messages", { sender: "human-abc", channel: "general", text: "@all hands" });
assert.deepEqual(every.wake, live, "@all wakes every interactive agent");
await api(base, "/api/feed?since=0&me=browser:legacy&kind=browser"); // a tab opened before the id change
const legacy = await api(base, "/api/messages", { sender: "legacy", channel: "general", text: "still me?" });
assert.equal(legacy.kind, "browser", "an old tab polling as browser:<name> is still read as a person");
assert.equal(legacy.wake.length, 1, "and still gets an answer");
const ci = await api(base, "/api/messages", { sender: "ci", channel: "general", text: "build green again" });
assert.equal(ci.kind, "unknown", "an unregistered REST harness is not a person");
assert.deepEqual(ci.wake, [], "CI does not wake agents by shouting into the workspace");
await api(base, "/api/bye", { id: "otherbot" });
await api(base, "/api/bye", { id: "thirdbot" });

// ---- per-agent visibility -----------------------------------------------------
// An agent reports what it is doing on the poll it already makes; the hub stores
// it and serves it per member. Nothing here is trusted: it is display data.
const visStatus = { ph: "tool", tool: "bash", act: "npm test", model: "acme/x", mode: "live", chan: "general", unread: 0, turn: 3, tools: 9, errs: 1, tok: 1234, usd: 0.4242, up: 60, run: 7, pid: 4242, cwd: "/tmp/x", host: 1, ev: ["00:00:01 turn #3", "00:00:02 bash npm test"] };
await api(base, `/api/feed?since=0&me=vis&kind=agent&note=busy&s=${encodeURIComponent(JSON.stringify(visStatus))}`);
const visRow = (await api(base, "/api/state")).agents.find((a) => a.id === "vis");
assert.equal(visRow.s.ph, "tool", "the roster carries what the agent says it is doing");
assert.equal(visRow.s.tool, "bash");
assert.equal(visRow.s.usd, 0.4242, "cost keeps its cents");
assert.deepEqual(visRow.s.ev, ["00:00:01 turn #3", "00:00:02 bash npm test"], "the activity ring rides along");
assert.equal(visRow.t, undefined, "a transcript tail is never broadcast to every tab");

// A peer may report anything: keep it typed, keep it short, never throw.
await api(base, "/api/feed?since=0&me=vis2&kind=agent&s=" + encodeURIComponent(JSON.stringify({ ph: { nope: 1 }, turn: "abc", ev: "nope", model: 42 })));
const vis2 = (await api(base, "/api/state")).agents.find((a) => a.id === "vis2");
assert.equal(vis2.s, undefined, "a status blob of nothing usable stores nothing");
await api(base, "/api/feed?since=0&me=vis3&kind=agent&s=not-json");
assert.equal((await api(base, "/api/state")).agents.find((a) => a.id === "vis3").s, undefined, "a malformed blob is dropped, not a 500");
await api(base, `/api/feed?since=0&me=vis4&kind=agent&s=${encodeURIComponent(JSON.stringify({ act: "y".repeat(900), turn: -5, tok: 1e30 }))}`);
const vis4 = (await api(base, "/api/state")).agents.find((a) => a.id === "vis4");
assert.equal(vis4.s.act.length, 200, "peer text is clamped");
assert.equal(vis4.s.turn, undefined, "nonsense numbers are dropped, not rewritten");
assert.equal(vis4.s.tok, undefined, "absurd counters are dropped");

// One member in detail: by id, and by the handle the hub gave it.
assert.equal((await api(base, "/api/register", { id: "disp", name: "Display Name", kind: "agent" })).name, "Display Name", "a chosen name is stored as a name, not a boolean");
assert.deepEqual((await api(base, "/api/messages", { sender: "ci", channel: "general", text: "hey @Display Name" })).wake, ["disp"], "and @<chosen name> wakes it");
await api(base, "/api/bye", { id: "disp" });
await api(base, "/api/register", { id: "nightly", name: "Night shift", kind: "harness", status: { ph: "idle", model: "acme/y" } });
assert.equal((await api(base, "/api/agent?id=nightly")).name, "Night shift", "detail by id");
assert.equal((await api(base, "/api/agent?id=Night%20shift")).id, "nightly", "detail by handle");
assert.equal((await api(base, "/api/agent?id=Night%20shift")).status.ph, "idle", "registered status shows up");
assert.equal((await api(base, "/api/agent?id=nope")).found, false, "an unknown member says so and lists who is live");
assert.ok(Array.isArray((await api(base, "/api/agent?id=nope")).live), "including the roster to pick from");
assert.equal((await api(base, "/api/agent")).error, "id required");
// Unread lag comes from the cursor file that agent writes, no protocol needed.
fs.writeFileSync(path.join(process.env.PI_SWARM_DIR, "cursors", "vis.json"), JSON.stringify({ seq: (await api(base, "/api/state")).seq - 3 }));
const det = await api(base, "/api/agent?id=vis");
assert.equal(det.posted.length, 0, "it has not posted anything");
assert.equal(det.unread, 3, "unread = hub head - its own cursor");
assert.equal(det.live, true);
await api(base, "/api/messages", { sender: "vis", channel: "general", text: "I am here" });
assert.equal((await api(base, "/api/agent?id=vis&limit=5")).posted.at(-1).text, "I am here", "what it wrote to the bus");

// A transcript tail is pulled, not pushed: a tab asks, the agent answers on its
// own POST, and only that agent's detail carries it.
assert.equal(det.watched, false, "nobody is watching yet");
await api(base, "/api/watch", { id: "vis", for: 60 });
assert.equal((await api(base, "/api/feed?since=99999&me=vis")).watch, true, "its poll is told a tab is looking");
assert.equal((await api(base, "/api/feed?since=99999&me=other")).watch, false, "and only its own");
await api(base, "/api/status", { id: "vis", t: { file: "/tmp/vis.jsonl", lines: [{ r: "assistant", txt: "probing" }, { r: "tool", txt: "bash ls" }, {}] } });
const detWatched = await api(base, "/api/agent?id=vis");
assert.equal(detWatched.transcript.lines.length, 2, "empty lines are dropped");
assert.equal(detWatched.transcript.lines[1].txt, "bash ls");
assert.equal(detWatched.status.ph, "tool", "a status POST must not wipe the summary it sent before");
assert.equal((await api(base, "/api/state")).agents.find((a) => a.id === "vis").t, undefined, "the tail stays out of the broadcast roster");
await api(base, "/api/status", { id: "vis", s: { ph: "idle", act: "" } });
assert.equal((await api(base, "/api/agent?id=vis")).transcript.lines.length, 2, "and a status-only POST must not wipe the tail");
await api(base, "/api/bye", { id: "vis" });
assert.equal((await api(base, "/api/agent?id=vis")).found, false, "gone with the lease: no ghost state");

// The session tail is read by the agent that owns the file, and must survive
// pi's real entry shapes plus a torn line from a killed process.
const sess = path.join(dir, "sess.jsonl");
fs.writeFileSync(
  sess,
  [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/w" }),
    JSON.stringify({ type: "agent_start" }),
    JSON.stringify({ type: "message_end", message: { role: "user", content: "do the thing" } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "on it" }] } }),
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "make test" } }),
    JSON.stringify({ type: "tool_execution_update", toolCallId: "x", args: {} }),
    JSON.stringify({ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] } }),
    '{"type":"message_end","mess',
  ].join("\n"),
);
assert.deepEqual(tailSession(sess), [
  { r: "user", txt: "do the thing" },
  { r: "assistant", txt: "…hmm on it" },
  { r: "tool", txt: "bash {\"command\":\"make test\"}" },
  { r: "result", txt: "bash [{\"type\":\"text\",\"text\":\"ok\"}]" },
], "real pi entries flatten to role + snippet, torn lines and lifecycle noise drop out");
assert.equal(tailSession(sess, 4096, 2).length, 2, "the tail is capped to the last N entries");
assert.equal(tailSession(sess).at(-1).r, "result", "and ends where the session ended");

// The web chat: one file, inline JS, and that JS has to at least compile.
const page2 = await (await fetch(base + "/")).text();
const page = page2;

// The web chat: one durable id per human, so closing the tab does not make you
// somebody else. The hub mints it as a cookie; the page signs its posts with it.
const firstLoad = await fetch(base + "/");
const minted = (firstLoad.headers.getSetCookie?.() || []).join(";");
assert.match(minted, /swarm_id=human-[0-9a-f]{6}/, "a first visit is given a durable human id");
assert.match(minted, /Max-Age=\d{9,}/, "and it outlives the browser session");
assert.equal((await fetch(base + "/", { headers: { cookie: "swarm_id=human-abcdef" } })).headers.getSetCookie?.().length, 0, "a returning visitor keeps their id");
const identified = boot(page, okFeed, "swarm_id=human-abcdef");
await identified.tick();
assert.equal(identified.els["#name"].value, "human-abcdef", "the page signs as its durable id, not as a shared 'human'");
assert.match(identified.urls[0], /[?&]me=human-abcdef\b/, "the lease id is the sender id: that is how the hub knows it is a person");
assert.doesNotMatch(identified.urls[0], /browser:/, "no second id for the same person");
assert.match(page, /id="log"[\s\S]*id="text"/, "group-chat page has a transcript and an input");
assert.doesNotMatch(page, /login|logout|sign in/i, "no login/logout UI");
const { els, tick, urls } = boot(page, okFeed);
await tick();
assert.match(els["#log"].innerHTML, /build green/, "the chat pane renders what the hub sends");
assert.match(els["#log"].innerHTML, /&lt;img onerror/, "peer text is escaped, never injected as markup");
assert.doesNotMatch(els["#log"].innerHTML, /<img /, "no live markup from peer text");
assert.match(els["#who"].innerHTML, /CI/, "the roster shows live members, including non-pi harnesses");
assert.doesNotMatch(els["#who"].textContent, /unreachable|UI error/, "a good poll is not reported as a failure");

// The sidepanel: one clickable row per member showing what it reports, with the
// peer-reported strings escaped like any other input.
assert.match(els["#who"].innerHTML, /class="ag k-harness[^"]*" data-id="ci"/, "a row per live member, clickable by id");
assert.match(els["#who"].innerHTML, /class="ph tool">bash 4s</, "the state badge says which tool, for how long");
assert.match(els["#who"].innerHTML, /npm &lt;test&gt;/, "a peer's status text is escaped, not injected");
assert.doesNotMatch(els["#who"].innerHTML, /<img |onerror=/, "no live markup from a peer's self-report");
assert.match(els["#who"].innerHTML, /class="badge"[^>]*>2</, "how far behind the bus it is");
assert.match(els["#who"].innerHTML, /acme\/x/, "which model it is on");
assert.match(els["#who"].innerHTML, /1 err/, "and whether its tools have been failing");
assert.match(els["#who"].innerHTML, /bash npm test</, "its last observed action");
// Clicking a row opens the per-agent detail, which polls /api/agent.
els["#who"].onclick({ target: { closest: () => ({ getAttribute: () => "ci" }) } });
await sleep(10);
assert.match(urls.join("\n"), /^\/api\/watch/m, "opening a panel asks that agent for its transcript tail");
assert.match(urls.join("\n"), /^\/api\/agent\?id=ci/m, "then reads its detail");
assert.match(els["#det"].innerHTML, /<b>assistant<\/b> probing &lt;b&gt;/, "the transcript tail renders, escaped");
assert.match(els["#det"].innerHTML, /unread<\/span> 2 of seq 12/, "unread against the hub head");
assert.match(els["#det"].innerHTML, /npm &lt;test&gt;/, "detail shows what it is doing");
assert.match(els["#det"].innerHTML, /data-ping="CI"/, "and how to wake it from here");
assert.match(page, /\/api\/agent/, "the REST help documents the probe endpoint");
assert.match(page, /\/api\/watch/, "and the watch endpoint");

// A dead hub and a broken render must not print the same message.
const dead = boot(page, async () => {
  throw new Error("ECONNREFUSED");
});
await dead.tick();
assert.match(dead.els["#who"].textContent, /hub unreachable/, "a dead hub says so");
const broken = boot(page, async () => ({ json: async () => ({ seq: 1, messages: [{ seq: 1, sender: "a", channel: "general", kind: "browser", wake: ["a"], text: "t", ts: "x" }] }) }));
// (no agents in the payload: the roster render must throw into "UI error")
await broken.tick();
assert.match(broken.els["#who"].textContent, /UI error/, "a render bug says UI error, not hub unreachable");

// No login/logout chatter: the log is text messages only, however many joined.
const log = fs.readFileSync(path.join(process.env.PI_SWARM_DIR, "messages.jsonl"), "utf-8").trim().split("\n").map(JSON.parse);
assert.ok(log.every((m) => typeof m.text === "string" && m.text && m.type === undefined), "presence lines must not exist");

// Refcount: the hub outlives its own session while a lease is live, then closes.
await api(base, "/api/feed?since=0&me=browser:alex&kind=browser");
await handlers.session_shutdown({ reason: "quit" }, ctx);
await sleep(2200);
assert.ok(await up(hub.port), "server stays up while another owner holds a lease");
await api(base, "/api/bye", { id: "browser:alex" });
// 'loop' never renews and never says bye (a killed harness): its lease must
// expire on its own, and only then may the hub close.
assert.ok(await waitFor(async () => !(await up(hub.port)), 12000), "last owner out switches the light off");
assert.equal(fs.existsSync(path.join(process.env.PI_SWARM_DIR, "hub.json")), false, "stale hub file is removed");
assert.deepEqual(notices.filter((m) => m.includes("offline")), [], "session_start must connect cleanly");

// A run that starts the bus alone must tear it down on exit even if the process
// dies right after session_shutdown (that is what pi -p does).
await handlers.session_start({}, ctx);
assert.ok(notices.at(-1).includes("this session hosts it"), "second run re-hosts after the bus died");
const hub2 = JSON.parse(fs.readFileSync(path.join(process.env.PI_SWARM_DIR, "hub.json"), "utf-8"));
assert.ok(await up(hub2.port), "re-hosted bus is listening");
await handlers.session_shutdown({ reason: "quit" }, ctx);
assert.equal(fs.existsSync(path.join(process.env.PI_SWARM_DIR, "hub.json")), false, "solo run leaves no hub file behind");
assert.ok(!(await up(hub2.port)), "solo run closes the port on exit");

// --- a resume must not take pi down ------------------------------------------
// pi invalidates the ctx of the session it replaces (resume / new / fork / reload),
// and a stale ctx throws on ANY property read. The instance that just left kept its
// heartbeat running, and the next tick read ctx.cwd: an uncaught throw inside a timer
// makes pi exit with "This extension ctx is stale after session replacement...".
// Teardown lives on "session_shutdown" (pi has no "session_end"), which is what the
// old handler never heard, so nothing ever stopped those timers.
const STALE = "This extension ctx is stale after session replacement or reload.";
const mkCtx = (sessionId) => {
  const gone = { on: false };
  const boom = () => {
    if (gone.on) throw new Error(STALE);
  };
  return {
    hasUI: false,
    kill: () => (gone.on = true), // pi invalidated this ctx: every read now throws
    get cwd() {
      boom();
      return process.cwd();
    },
    get sessionManager() {
      boom();
      return { sessionId };
    },
    isIdle: () => {
      boom();
      return true;
    },
    ui: { notify: (m) => notices.push(m), setStatus: () => {} },
  };
};

const crashes = [];
const capture = (e) => crashes.push(String(e?.message || e));
process.on("uncaughtException", capture);
process.on("unhandledRejection", capture);

extension(fakePi); // pi loads a fresh instance of the extension for the new session
const ctx3 = mkCtx("resumehost1");
await handlers.session_start({}, ctx3);
assert.ok(notices.at(-1).includes("this session hosts it"), "third run hosts the bus");
const hub3 = JSON.parse(fs.readFileSync(path.join(process.env.PI_SWARM_DIR, "hub.json"), "utf-8"));
assert.ok(handlers.session_shutdown, "pi tears a session down with session_shutdown");
ctx3.kill(); // pi replaced the session: this ctx is now a bomb
await handlers.session_shutdown({ reason: "resume", targetSessionFile: "x" }, ctx3);

const ctx4 = mkCtx("resumesuccessor1"); // the instance for the session pi resumed
extension(fakePi);
await handlers.session_start({}, ctx4);
assert.ok(await up(hub3.port), "the hub outlives the swap: the successor joins the same bus");
await sleep(2400); // longer than the 2s heartbeat: a leaked timer would have fired
assert.deepEqual(crashes, [], "a replaced session must not throw at pi from a timer");

process.off("uncaughtException", capture);
process.off("unhandledRejection", capture);
await handlers.session_shutdown({ reason: "quit" }, ctx4); // last lease out closes it
assert.ok(await waitFor(async () => !(await up(hub3.port)), 12000), "hub closes once nothing renews");
assert.equal(fs.existsSync(path.join(process.env.PI_SWARM_DIR, "hub.json")), false, "and leaves no hub file");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`workspace-swarm: all asserts pass (${log.length} messages logged)`);
