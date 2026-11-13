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
	const confirmQueue = [];
	const confirmCalls = [];
	const selectQueue = [];
	const inputQueue = [];
	const pi = {
		on: (name, fn) => { events[name] = fn; },
		registerTool: (t) => { tools[t.name] = t; },
		registerCommand: (n, o) => { commands[n] = o; },
		setActiveTools: (arr) => { activeTools.splice(0, activeTools.length, ...arr); },
		getActiveTools: () => [...activeTools],
		sendUserMessage: (msg, opts) => { sent.push({ msg, opts }); },
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
			confirm: async (title, message) => {
				confirmCalls.push({ title, message });
				return confirmQueue.shift() ?? false; // default to rejection: forgetting to approve must not silently apply
			},
			select: async () => selectQueue.shift() ?? "keep",
			input: async () => inputQueue.shift(),
		},
	};
	mod.default(pi);
	const memoryFile = path.join(dir, ".pi", "memory", `${sessionId}.json`);
	const readMemory = () => JSON.parse(fs.readFileSync(memoryFile, "utf8"));
	return { ctx, tools, commands, events, notifyLog, sent, compactCalls, activeTools, memoryFile, readMemory, confirmQueue, confirmCalls, selectQueue, inputQueue };
}
const toolCall = (s, name) => s.events.tool_call({ toolName: name }, s.ctx);
const notified = (s) => s.notifyLog.join("\n---\n");

// ---- Phase 1: a session does work and is then "killed" mid-crisis -------------
const s1 = boot("sess-a");
await s1.events.session_start({}, s1.ctx);
assert.equal(s1.activeTools.includes("self_compact"), false, "tools hidden before opt-in");

await s1.commands["self-propagate"].handler("on here", s1.ctx);
await s1.commands["self-propagate"].handler("budget 0.7", s1.ctx);
await s1.commands["self-propagate"].handler("wake once 10", s1.ctx);
await s1.commands["self-propagate"].handler("wake every 5", s1.ctx);
assert.equal(s1.activeTools.includes("goal_set"), true, "goal_set declared after opt-in");
const memGoal = s1.readMemory();
assert.equal(memGoal.pinnedContext?.source, "seed", "goal seeded at enable time");
assert.match(memGoal.pinnedContext?.text ?? "", /also add a watchdog/, "seed goal comes from the anchor");

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
assert.equal(s2.activeTools.includes("goal_set"), true, "goal_set re-declared after restart");
assert.match(notified(s2), /restored/i, "restart notice about the queued checkpoint");

// KV survived
const list = await s2.tools.memory_store.execute("l1", { action: "list" }, undefined, undefined, s2.ctx);
assert.match(list.content[0].text, /goal/, "KV entry 'goal' survived restart");
assert.match(list.content[0].text, /arch/, "KV entry 'arch' survived restart");

// Budget directive is delivered as a custom message, never as volatile head bytes
const beforeOut = await s2.events.before_agent_start({ systemPrompt: "base" }, s2.ctx);
assert.match(beforeOut.systemPrompt, /Self-Propagation & Context Protocol/, "static protocol present in head");
assert.doesNotMatch(beforeOut.systemPrompt, /CRITICAL CONTEXT ALERT/, "volatile budget text kept out of the cached head");
assert.doesNotMatch(beforeOut.systemPrompt, /No session goal set/, "goal nudge not emitted once a goal exists");
assert.match(beforeOut.message?.content ?? "", /CRITICAL CONTEXT ALERT/, "over-budget directive delivered as a message after restart");
assert.equal(s2.readMemory().overBudgetTurns, 1, "grace counter persisted");

// Status reflects restored state
await s2.commands["self-propagate"].handler("status", s2.ctx);
const statusOut = notified(s2);
assert.match(statusOut, /ENABLED/, "status: enabled restored");
assert.match(statusOut, /ceiling 70%/, "status bar uses restored ceiling");
assert.match(statusOut, /wake every 5m/, "wake-every restored");
assert.match(statusOut, /wake once 10m/, "wake-once restored");
assert.match(statusOut, /seeded/, "goal restored");
assert.match(statusOut, /anchor: e3/, "anchor restored");

// The restored checkpoint blocks tool calls again
const blocked = await toolCall(s2, "bash");
assert.equal(blocked?.block, true, "restored pendingCompaction blocks tools after restart");
assert.match(blocked.reason, /self_compact has already been scheduled/);
assert.equal((await toolCall(s2, "goal_set"))?.block, true, "goal_set also blocked while compaction is queued");

// `compact` no-ops while a compaction is pending (its force path is asserted after agent_end)
await s2.commands["self-propagate"].handler("compact", s2.ctx);
assert.match(notified(s2), /already queued/i, "compact reports the queued checkpoint instead of steering");

// Pi fires session_before_compact during ctx.compact; check the checkpoint that gets composed
const sc = await s2.events.session_before_compact({ reason: "manual", preparation: { tokensBefore: 90000 } }, s2.ctx);
assert.match(sc.compaction.summary, /<pinned_context source="seed"/, "floor clamps keepFirstTurns=0 to a seed pinned from turn 1/anchor");
assert.match(sc.compaction.summary, /also add a watchdog/, "anchor start: goal seed begins at latest user message");
assert.doesNotMatch(sc.compaction.summary.split("</pinned_context>")[0], /build the daemon/, "pre-anchor turn not in the seed");
assert.match(sc.compaction.summary, /<working_memory/, "working memory baked into checkpoint");
assert.match(sc.compaction.summary, /<compaction_summary>\ndaemon scaffold done/, "agent summary baked in");
assert.equal(sc.compaction.firstKeptEntryId, "__self_propagate_retain_none__", "zero tail entries retained");
assert.equal(sc.compaction.details.selfPropagated, true);
assert.equal(s2.readMemory().pinnedContext?.source, "seed", "seeded goal persisted at enable time (restored)");
assert.match(s2.readMemory().pinnedContext?.text ?? "", /also add a watchdog/, "seeded goal holds the anchored turn");

// ---- Goal lifecycle: user override → agent rewrite (reject/approve) → clear → reset ----
// NB: this whole block relies on pendingCompaction still being queued — session_before_compact
// returns undefined (and the sc2-sc4 asserts blow up with a TypeError) only after agent_end.
// Keep it above the "Agent ends" section below.
await s2.commands["self-propagate"].handler("goal set ALWAYS RUN THE FOO TESTS BEFORE DONE", s2.ctx);
await s2.commands["self-propagate"].handler("goal show", s2.ctx);
assert.match(notified(s2), /ALWAYS RUN THE FOO TESTS/, "goal show reflects the user override");
await s2.commands["self-propagate"].handler("status", s2.ctx);
assert.match(notified(s2), /custom \(user/, "status reports a custom user pin");
const sc2 = await s2.events.session_before_compact({ reason: "manual", preparation: { tokensBefore: 90000 } }, s2.ctx);
assert.match(sc2.compaction.summary, /ALWAYS RUN THE FOO TESTS/, "user goal replaces the seed verbatim");
assert.doesNotMatch(sc2.compaction.summary, /also add a watchdog/, "seed discarded after user override");
assert.equal(sc2.compaction.details.pinSource, "user", "checkpoint records which goal was baked in");

s2.confirmQueue.push(false); // user rejects the agent's proposal
const rejected = await s2.tools.goal_set.execute("t8", { text: "AGENT MANDATE V2", reason: "goal changed" }, undefined, undefined, s2.ctx);
assert.match(rejected.content[0].text, /rejected/i, "rejected rewrite is not applied");
assert.equal(s2.readMemory().pinnedContext?.text, "ALWAYS RUN THE FOO TESTS BEFORE DONE", "goal unchanged after rejection");

s2.confirmQueue.push(true); // user approves
const approved = await s2.tools.goal_set.execute("t9", { text: "AGENT MANDATE V2", reason: "goal changed" }, undefined, undefined, s2.ctx);
assert.equal(approved.details?.applied, true, "approved rewrite reports applied");
assert.equal(s2.readMemory().pinnedContext?.source, "agent", "agent rewrite persisted with source=agent");
assert.equal(s2.readMemory().pinnedContext?.text, "AGENT MANDATE V2");

await s2.commands["self-propagate"].handler("goal clear", s2.ctx);
const sc3 = await s2.events.session_before_compact({ reason: "manual", preparation: { tokensBefore: 90000 } }, s2.ctx);
assert.match(sc3.compaction.summary, /<pinned_context status="empty"/, "cleared goal renders the empty marker");

await s2.commands["self-propagate"].handler("goal reset", s2.ctx);
assert.equal(s2.readMemory().pinnedContext, null, "goal reset returns to unseeded state");
const sc4 = await s2.events.session_before_compact({ reason: "manual", preparation: { tokensBefore: 90000 } }, s2.ctx);
assert.match(sc4.compaction.summary, /also add a watchdog/, "reset re-seeds from the branch");

// pin here pins the latest user message verbatim
await s2.commands["self-propagate"].handler("goal here", s2.ctx);
assert.equal(s2.readMemory().pinnedContext?.source, "user", "goal here stores a user goal");
assert.match(s2.readMemory().pinnedContext?.text ?? "", /watchdog/, "goal here captured the latest user message");
assert.match(s2.readMemory().pinnedContext?.text ?? "", /\[Goal pinned from the current user message\]/, "goal here tags its provenance");

// Agent ends: the restored checkpoint actually executes
await s2.events.agent_end({}, s2.ctx);
assert.equal(s2.compactCalls.length, 1, "restored checkpoint executed at next turn end");

// onComplete cleared the pending checkpoint
assert.equal(s2.readMemory().pendingCompaction, null, "checkpoint cleared after execution");
assert.equal(s2.readMemory().overBudgetTurns, 0, "grace counter reset after checkpoint");
const unblocked = await toolCall(s2, "bash");
assert.equal(unblocked?.block, undefined, "tools unblocked after checkpoint executed");

// Compact-command: user forces a checkpoint request (steer); not blocked by empty queue
await s2.commands["self-propagate"].handler("compact", s2.ctx);
assert.match(s2.sent.at(-1).msg, /force_compact/, "compact sends a force_compact steer");

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
await s4.commands["self-propagate"].handler("compact", s4.ctx);
assert.match(notified(s4), /disabled/i, "compact refuses while disabled");
await s4.commands["self-propagate"].handler("goal", s4.ctx);
assert.match(notified(s4), /disabled/i, "goal refuses while disabled");
await s4.commands["self-propagate"].handler("on", s4.ctx);
const list4 = await s4.tools.memory_store.execute("l4", { action: "list" }, undefined, undefined, s4.ctx);
assert.match(list4.content[0].text, /empty/i, "fresh session starts with an empty KV store");

// ---- Phase 5: minPinnedTurns below the floor in storage is clamped on load ------
fs.writeFileSync(s2.memoryFile, JSON.stringify({ enabled: true, minPinnedTurns: 0, budgetRatio: 0.85, pinnedContext: { text: 42, source: 9, updatedAt: 5 } }));
const s5 = boot("sess-a");
await s5.events.session_start({}, s5.ctx); // must not crash; malformed pinnedContext loads as unseeded
await s5.commands["self-propagate"].handler("status", s5.ctx);
assert.match(notified(s5), /floor 1 turn/, "minPinnedTurns=0 loads as floor 1; malformed goal drops to unseeded");

// ---- Phase 6: dead anchor still yields a seed (root fallback, with a warning) ---
fs.writeFileSync(
	path.join(dir, ".pi", "memory", "sess-dead.json"),
	JSON.stringify({
		enabled: true,
		anchorEntryId: "no-such-entry",
		pendingCompaction: { summary: "checkpoint despite dead anchor", keepFirstTurns: 0, continueAfter: false },
	})
);
const s6 = boot("sess-dead");
await s6.events.session_start({}, s6.ctx);
const deadSc = await s6.events.session_before_compact(
	{ reason: "manual", preparation: { tokensBefore: 1000 } },
	s6.ctx
);
assert.match(deadSc.compaction.summary, /build the daemon/, "dead anchor falls back to session-root seed");
assert.match(notified(s6), /anchor no longer resolves/i, "dead anchor fallback notifies the user");
assert.equal(s6.readMemory().pinnedContext?.source, "seed", "root fallback persists a real seed, not an empty pin");

// ---- Phase 7: hard grace lock blocks goal_set too ----------------------------
fs.writeFileSync(
	path.join(dir, ".pi", "memory", "sess-lock.json"),
	JSON.stringify({ enabled: true, overBudgetTurns: 6 })
);
const s7 = boot("sess-lock", { tokens: 95000 }); // 95000/85000 = 112% of ceiling
await s7.events.session_start({}, s7.ctx);
const beforeLock = await s7.events.before_agent_start({ systemPrompt: "base" }, s7.ctx);
assert.match(beforeLock.message?.content ?? "", /HARD CONTEXT LOCK/, "grace period expired: hard lock directive fires as a message");
assert.doesNotMatch(beforeLock.systemPrompt, /HARD CONTEXT LOCK/, "head stays static under the hard lock");
assert.equal((await toolCall(s7, "goal_set"))?.block, true, "goal_set is hard-blocked past the grace lock");
assert.equal((await toolCall(s7, "memory_store"))?.block, undefined, "memory_store stays available in the lock");

// ---- Phase 8: enable-time goal flow (edit / skip) ---------------------------
const s8 = boot("sess-goal");
s8.selectQueue.push("edit");
s8.inputQueue.push("EDITED GOAL TEXT");
await s8.events.session_start({}, s8.ctx);
await s8.commands["self-propagate"].handler("on here", s8.ctx);
assert.equal(s8.readMemory().pinnedContext?.text, "EDITED GOAL TEXT", "edit flow stores the edited goal");
assert.equal(s8.readMemory().pinnedContext?.source, "user", "edited goal is a user goal");

const s9 = boot("sess-skip");
s9.selectQueue.push("skip");
await s9.events.session_start({}, s9.ctx);
await s9.commands["self-propagate"].handler("on here", s9.ctx);
assert.equal(s9.readMemory().pinnedContext?.text, "", "skip stores a deliberate empty goal");
assert.equal(s9.readMemory().pinnedContext?.source, "user", "skip is a user decision, not a seed");
const skipOut = await s9.events.before_agent_start({ systemPrompt: "base" }, s9.ctx);
assert.doesNotMatch(skipOut.systemPrompt, /No session goal set/, "skip disables the no-goal nudge");

// ---- Housekeeping: atomic writes leave no tmp litter ---------------------------
const leftovers = fs.readdirSync(path.join(dir, ".pi", "memory")).filter((f) => f.includes(".tmp."));
assert.deepEqual(leftovers, [], "no .tmp files left behind");

clearInterval(globalThis.__pi_self_propagate_timer_v1__);
console.log("self-propagate: all durability asserts pass");
process.exit(0);
