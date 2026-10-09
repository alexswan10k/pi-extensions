// node extensions/workspace-swarm.failover.test.mjs
// Two processes, one bus: the client attaches, then survives a SIGKILL of the hub.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "swarm-fo-"));
const state = path.join(dir, "swarm");
// Must be set BEFORE the import: DIR/PORT are read once at module load. Without
// this the test joins the workspace's real bus instead of its own temp one.
process.env.PI_SWARM_DIR = state;
process.env.PI_SWARM_PORT = "0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.setTimeout(300);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.once("timeout", () => (s.destroy(), resolve(false)));
  });
const readHub = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(state, "hub.json"), "utf-8"));
  } catch {
    return null;
  }
};
const feed = async (port, since = 0, me = "") =>
  (await fetch(`http://127.0.0.1:${port}/api/feed?since=${since}${me ? "&me=" + me : ""}`)).json();

// Child: an ordinary session that happens to arrive first, so it hosts.
fs.writeFileSync(
  path.join(dir, "child.mjs"),
  `process.env.PI_AGENT_NAME="child";process.env.PI_SWARM_PORT="0";process.env.PI_SWARM_DIR=${JSON.stringify(state)};
const { default: ext } = await import(${JSON.stringify(fileURLToPath(new URL("./workspace-swarm.ts", import.meta.url)))});
const h={};ext({on:(e,f)=>(h[e]=f),registerTool:()=>{},registerCommand:()=>{},sendUserMessage:()=>{}});
await h.session_start({},{hasUI:false,sessionManager:{sessionId:"childsession1"},ui:{notify:()=>{}}});
setInterval(()=>{},1000);`,
);
const child = spawn(process.execPath, [path.join(dir, "child.mjs")], { stdio: "ignore", env: process.env });

const hub1 = await (async () => {
  for (let i = 0; i < 50; i++) {
    const h = readHub();
    if (h && (await listening(h.port))) return h;
    await sleep(100);
  }
  throw new Error("child never hosted");
})();
assert.equal(hub1.pid, child.pid, "the first process to arrive hosts the bus");

const { default: ext } = await import("./workspace-swarm.ts");
const notices = [];
const handlers = {};
const tools = {};
ext({
  on: (e, f) => (handlers[e] = f),
  registerTool: (t) => (tools[t.name] = t),
  registerCommand: (n, c) => (tools[n] = c),
  sendUserMessage: () => {},
});
await handlers.session_start({}, { hasUI: false, sessionManager: { sessionId: "parentsession1" }, ui: { notify: (m) => notices.push(m) } });

const send = async (text) => (await tools.send_swarm_message.execute("id", { message: text })).content[0].text;

assert.match(await send("written through the client"), /Sent to #general/);
const seen = await feed(hub1.port);
assert.deepEqual(seen.messages.map((m) => m.text), ["written through the client"], "the client wrote into the host's log");
assert.ok(!notices.some((m) => m.includes("offline")), "the client attached instead of hosting");
assert.ok((await feed(hub1.port, 0, "parent")).agents.some((a) => a.id === "child"), "the host is in the roster");

// Kill -9: no goodbye, no lease release. A send must not be lost, and the bus must come back.
child.kill(9);
await sleep(300);
assert.ok(!(await listening(hub1.port)), "the hub is really gone");
const during = await send("posted during the outage");
assert.ok(
  /queued \(\d+\) hub unreachable|sent after retaking the bus/.test(during),
  "the outage is reported honestly, not silently dropped: " + during,
);

for (let i = 0; i < 30; i++) {
  await send("retry " + i);
  const h = readHub();
  if (h && h.pid === process.pid && (await listening(h.port))) break;
  await sleep(150);
}
const hub2 = readHub();
assert.ok(hub2 && hub2.pid === process.pid, "the surviving client promoted itself to hub");

const after = await feed(hub2.port);
assert.equal(after.messages[0].text, "written through the client", "history survived the failover (it is on disk, not in the host)");
assert.ok(after.messages.some((m) => m.text === "posted during the outage"), "the queued message was delivered after promotion");
assert.ok(after.messages.some((m) => m.text.startsWith("retry")), "writes land again");
assert.equal(new Set(after.messages.map((m) => m.seq)).size, after.messages.length, "seq stays unique across promotion");

fs.rmSync(dir, { recursive: true, force: true });
console.log(`workspace-swarm failover: all asserts pass (${after.messages.length} messages)`);
