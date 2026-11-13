// node extensions/self-propagate.test.mjs
// Durability of self-propagate state across process restarts. Phase 1 runs a
// "session" that enables the extension, stores KV notes, queues a self_compact
// checkpoint and mutates budget/idle/grace state; phase 2 boots a fresh
// extension instance against the same workspace and asserts everything —
// including the queued checkpoint — is restored and enforced. No pi, no model.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sp-"));
const mod = await import("./self-propagate.ts");

const BRANCH = [
	{ id: "e1", type: "message", message: { role: "user", content: "build the daemon" } },
	{ id: "e2", type: "message", message: { role: "assistant", content: "on it" } },
	{ id: "e3", type: "message", message: { role: "user", content: "also add a watchdog" } },
];

function boot(sessionId, { tokens = 1000, branch = BRANCH } = {}) {
	const tools = {};
	const commands = {};
	const events = {};
	const notifyLog = [];
	const sent = [];
	const compactCalls = [];
	const activeTools = ["bash", "read"];
	const pi = {
		on: (name, fn) => { events[name] = fn; },
		registerTool: (t) => { tools[t.name] = t; },
		registerCommand: (n, o) => { commands[n] = o; },
		setActiveTools: (arr) => { activeTools.splice(0, activeTools.length, ...arr); },
		getActiveTools: () => [...activeTools],
		sendUserMessage: (msg) => { sent.push(msg); },
	};
	const ctx = {
		cwd: dir,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => path.join(dir, `${sessionId}.jsonl`),
			getBranch: () => branch,
		},
		getContextUsage: () => ({ contextWindow: 100000, tokens }),
		compact: (opts) => { compactCalls.push(opts); opts.onComplete?.(); },
		ui: {
			notify: (m) => notifyLog.push(String(m)),
			setStatus: () => {},
		},
	};
	mod.default(pi);
	const memoryFile = path.join(dir, ".pi", "memory", `${sessionId}.json`);
	const readMemory = () => JSON.parse(fs.readFileSync(memoryFile, "utf8"));
	return { ctx, tools, commands, events, notifyLog, sent, compactCalls, activeTools, memoryFile, readMemory };
}
const toolCall = (s, name) => s.events.tool_call({ toolName: name }, s.ctx);
const notified = (s) => s.notifyLog.join("\n---\n");

// ---- Phase 1: a session does work and is then "killed" mid-crisis -------------
const s1 = boot("sess-a");
await s1.events.session_start({}, s1.ctx);
assert.equal(s1.activeTools.includes("self_compact"), false, "tools hidden before opt-in");

await s1.commands.propagate.handler("on here", s1.ctx);
await s1.commands.propagate.handler("budget 0.7", s1.ctx);
await s1.commands.propagate.handler("idle 10", s1.ctx);
await s1.commands["keep-awake"].handler("5", s1.ctx);

const upsert = { action: "upsert", key: "goal", title: "Goal", body: "build the daemon" };
await s1.tools.memory_store.execute("t1", upsert, undefined, undefined, s1.ctx);
await s1.tools.memory_store.execute("t2", { action: "upsert", key: "arch", title: "Arch", body: "single process, unix socket" }, undefined, undefined, s1.ctx);

await s1.tools.self_compact.execute("t3", {
	summary: "daemon scaffold done; watchdog next",
	keepFirstTurns: 0, // below the floor: must be clamped at extraction time
	continueAfter: false,
}, undefined, undefined, s1.ctx);

let mem = s1.readMemory();
assert.equal(mem.enabled, true, "enabled persisted");
assert.equal(mem.budgetRatio, 0.7, "budget persisted");
assert.equal(mem.idleCompactMinutes, 10, "idle persisted");
assert.equal(mem.keepAwakeMinutes, 5, "keep-awake persisted");
assert.equal(mem.anchorEntryId, "e3", "anchor persisted");
assert.equal(mem.minPinnedTurns, 1, "floor persisted");
assert.equal(Object.keys(mem.kv).length, 2, "kv persisted");
assert.equal(mem.pendingCompaction?.summary, "daemon scaffold done; watchdog next", "queued checkpoint persisted");
assert.equal(mem.pendingCompaction?.keepFirstTurns, 0, "raw keepFirstTurns stored; floor applies at extraction");

// ---- Phase 2: fresh process resumes the same session --------------------------
const s2 = boot("sess-a", { tokens: 95000 }); // 95000/70000 = 136% of ceiling
await s2.events.session_start({}, s2.ctx);
assert.equal(s2.activeTools.includes("self_compact"), true, "self_compact re-declared after restart");
assert.equal(s2.activeTools.includes("memory_store"), true, "memory_store re-declared after restart");
assert.match(notified(s2), /restored/i, "restart notice about the queued checkpoint");

// KV survived
const list = await s2.tools.memory_store.execute("l1", { action: "list" }, undefined, undefined, s2.ctx);
assert.match(list.content[0].text, /goal/, "KV entry 'goal' survived restart");
assert.match(list.content[0].text, /arch/, "KV entry 'arch' survived restart");

// Budget directive at 136% persists the grace counter
const beforeOut = await s2.events.before_agent_start({ systemPrompt: "base" }, s2.ctx);
assert.match(beforeOut.systemPrompt, /CRITICAL CONTEXT ALERT/, "over-budget directive still fires after restart");
assert.equal(s2.readMemory().overBudgetTurns, 1, "grace counter persisted");

// Status reflects restored state
await s2.commands.propagate.handler("status", s2.ctx);
const statusOut = notified(s2);
assert.match(statusOut, /ENABLED/, "status: enabled restored");
assert.match(statusOut, /ceiling 70%/, "status bar uses restored ceiling");
assert.match(statusOut, /keep-awake 5m/, "keep-awake restored");
assert.match(statusOut, /idle-compact warn 10m/, "idle restored");
assert.match(statusOut, /floor 1 turn/, "pinned floor restored");
assert.match(statusOut, /anchor: e3/, "anchor restored");

// The restored checkpoint blocks tool calls again
const blocked = await toolCall(s2, "bash");
assert.equal(blocked?.block, true, "restored pendingCompaction blocks tools after restart");
assert.match(blocked.reason, /self_compact has already been scheduled/);

// Pi fires session_before_compact during ctx.compact; check the checkpoint that gets composed
const sc = await s2.events.session_before_compact({ reason: "manual", preparation: { tokensBefore: 90000 } }, s2.ctx);
assert.match(sc.compaction.summary, /<pinned_origin_turns count="1">/, "floor clamps keepFirstTurns=0 to 1 pinned turn");
assert.match(sc.compaction.summary, /also add a watchdog/, "anchor start: pinning begins at latest user message");
assert.doesNotMatch(sc.compaction.summary.split("</pinned_origin_turns>")[0], /build the daemon/, "pre-anchor turn not pinned");
assert.match(sc.compaction.summary, /<working_memory/, "working memory baked into checkpoint");
assert.match(sc.compaction.summary, /<compaction_summary>\ndaemon scaffold done/, "agent summary baked in");
assert.equal(sc.compaction.firstKeptEntryId, "__self_propagate_retain_none__", "zero tail entries retained");
assert.equal(sc.compaction.details.selfPropagated, true);

// Agent ends: the restored checkpoint actually executes
await s2.events.agent_end({}, s2.ctx);
assert.equal(s2.compactCalls.length, 1, "restored checkpoint executed at next turn end");

// onComplete cleared the pending checkpoint
assert.equal(s2.readMemory().pendingCompaction, null, "checkpoint cleared after execution");
assert.equal(s2.readMemory().overBudgetTurns, 0, "grace counter reset after checkpoint");
const unblocked = await toolCall(s2, "bash");
assert.equal(unblocked?.block, undefined, "tools unblocked after checkpoint executed");

// ---- Phase 3: corrupt memory file degrades to safe defaults --------------------
fs.writeFileSync(s2.memoryFile, "{ not json");
const s3 = boot("sess-a");
await s3.events.session_start({}, s3.ctx);
const s3out = notified(s3);
assert.doesNotMatch(s3out, /restored/, "corrupt file: nothing restored");
assert.equal(s3.activeTools.includes("self_compact"), false, "corrupt file: tools stay hidden");

// ---- Phase 4: a different session does not see this session's state ------------
const s4 = boot("sess-b");
await s4.events.session_start({}, s4.ctx);
assert.equal(fs.existsSync(path.join(dir, ".pi", "memory", "sess-b.json")), false, "other sessions get no reuse of this session's memory file");
await s4.commands.propagate.handler("on", s4.ctx);
const list4 = await s4.tools.memory_store.execute("l4", { action: "list" }, undefined, undefined, s4.ctx);
assert.match(list4.content[0].text, /empty/i, "fresh session starts with an empty KV store");

// ---- Phase 5: minPinnedTurns below the floor in storage is clamped on load ------
fs.writeFileSync(s2.memoryFile, JSON.stringify({ enabled: true, minPinnedTurns: 0, budgetRatio: 0.85 }));
const s5 = boot("sess-a");
await s5.events.session_start({}, s5.ctx);
assert.match(notified(s5), /.*/); // no crash
await s5.commands.propagate.handler("status", s5.ctx);
assert.match(notified(s5), /floor 1 turn/, "minPinnedTurns=0 in storage loads as floor 1");

// ---- Housekeeping: atomic writes leave no tmp litter ---------------------------
const leftovers = fs.readdirSync(path.join(dir, ".pi", "memory")).filter((f) => f.includes(".tmp."));
assert.deepEqual(leftovers, [], "no .tmp files left behind");

clearInterval(globalThis.__pi_self_propagate_timer_v1__);
console.log("self-propagate: all durability asserts pass");
process.exit(0);
