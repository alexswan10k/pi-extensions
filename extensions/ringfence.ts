import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function slap(why: string, root: string) {
	const dir = scratchDir(root);
	return {
		block: true,
		reason:
			`RINGFENCE (not executed): ${why}.\n` +
			`This session is ring-fenced to ${root}. At all costs stay out of the home directory (~/*, $HOME/*, dotfiles, keychains), other repositories, /tmp, and any absolute path outside ${root}, and do not route around this block with another tool, an env var, a heredoc script, or a helper file.\n` +
			`Stay on the assigned task inside the workspace and do not try to route around this block with another tool, an env var, a heredoc, a script file, or a decoded string.\n` +
			`If the task genuinely needs something from outside the fence (a global package, a credential, a file from elsewhere, a system or destructive change), append one line saying what and why to ${path.join(root, REQUESTS)}, then continue with the best in-fence alternative and note the limitation in your final answer. Do not wait for approval.\n` +
			`Temp or scratch files go in ${dir}/ (workspace-local, git-ignored, created for you); delete that directory when you are done. Note: ${REQUESTS} is kept on purpose.`,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (process.env.RINGFENCE === "off") return undefined; // emergency escape hatch
		const root = path.resolve(ctx.cwd || process.cwd());
		const input = event.input as Record<string, unknown> | undefined;

		if (FILE_TOOLS.has(event.toolName)) {
			const why = checkPath(input?.path, root);
			if (why) return slap(why, root);
		} else if (SHELL_TOOLS.has(event.toolName)) {
			const why = checkCommand(input?.command, root);
			if (why) return slap(why, root);
		}
		return undefined;
	});

	// Clean the scratch pad up after ourselves.
	// ponytail: deletes shared .ringfence on exit; per-session subdir if concurrent runs collide.
	pi.on("session_shutdown", (_event, ctx) => {
		const root = realish(path.resolve(ctx.cwd || process.cwd()));
		const dir = path.join(root, SCRATCH);
		if (path.basename(dir) === SCRATCH && within(root, dir)) fs.rmSync(dir, { recursive: true, force: true });
	});
}
