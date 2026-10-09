// ask-jev: ask the local LM Studio *decision* model ("jev") for a fast, cheap
// judgement, optionally fanned out over files. It classifies; it does not write.
//
// WHY IT READS FILES ITSELF: the point is to keep bulk out of the expensive
// session model's context. The session model names paths or a glob; we read them
// here and fire one small request per file. The session model gets back the N
// answers, never the N files.
//
// USE /v1/decisions, NEVER /v1/chat/completions. Measured on LM Studio 0.3.x:
//   - chat/completions IGNORES `model` and answers from the loaded chat default
//     (ask for d1-omni-600m, get qwen back — `system_fingerprint` gives it away),
//     so a "decision model" call there silently costs you the big model
//   - /v1/decisions honours `model` and rejects anything that is not a decision
//     model (400 model_not_found), so a 200 here is proof of who answered
//   - ~15-90 ms per call, 3 question types: predicate (probability), choice
//     (argmax over options), score (ordered levels). output_tokens is always 0 —
//     it scores the prompt, it never generates
//   - input is a plain string; images go in a top-level `images` array as data
//     URLs (multimodal content parts are rejected)
//   - input bigger than the instance's `eval_batch_size` (512 by default, NOT the
//     128k context) fails with a 500 that names the cap, which is what we parse to
//     size our own truncation — see fittedAsk
//
// Reads are fenced to ctx.cwd with ringfence's own checkPath, so this tool is not a
// door around the fence for a fenced session. Not a security boundary either way.

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkPath } from "./ringfence.ts";

const MODEL = process.env.JEV_MODEL || "d1-omni-600m";
const BASE = (process.env.JEV_BASE_URL || "http://localhost:1234/v1").replace(/\/$/, "");
const CONCURRENCY = Math.max(1, Number(process.env.JEV_CONCURRENCY) || 4);
const MAX_CHARS = Math.max(512, Number(process.env.JEV_MAX_CHARS) || 24_000);
const TIMEOUT_MS = Math.max(1000, Number(process.env.JEV_TIMEOUT_MS) || 30_000);
const MAX_FILES = 200; // shortcut: fixed cap, raise it if a real glob needs more
const MAX_IMAGE_BYTES = 8_000_000;

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

/**
 * Input size known to fit the instance's batch size, learned only from a refusal
 * (0 = never refused yet, so send the whole thing). A success proves nothing about
 * sizes we have not tried.
 */
let fitChars = 0;

export type Question = {
	name: string;
	instructions: string;
	type: "predicate" | "choice" | "score";
	/** choice: the option values to score. */
	options?: string[];
	/** score: the ordered level labels, worst first. */
	levels?: string[];
};

/** Validate session-supplied questions and map them to the wire shape. */
export function buildQuestions(input: unknown): { questions?: Question[]; error?: string } {
	if (!Array.isArray(input) || !input.length) return { error: '"questions" must be a non-empty array' };
	if (input.length > 12) return { error: `too many questions (${input.length}), 12 max` };
	const questions: Question[] = [];
	for (const raw of input) {
		const q = (raw || {}) as any;
		const name = String(q.name || "").trim();
		const instructions = String(q.instructions || "").trim();
		if (!/^[A-Za-z][\w.-]{0,63}$/.test(name)) return { error: `question name ${JSON.stringify(q.name)} must be a short identifier` };
		if (!instructions) return { error: `question "${name}" needs instructions` };
		const options = Array.isArray(q.options) ? q.options.map(String) : undefined;
		const levels = Array.isArray(q.levels) ? q.levels.map(String) : undefined;
		const type = q.type || (options ? "choice" : levels ? "score" : "predicate");
		if (!["predicate", "choice", "score"].includes(type)) return { error: `question "${name}": unknown type "${type}"` };
		if (type === "choice" && (!options || options.length < 2)) return { error: `question "${name}": choice needs at least 2 options` };
		if (type === "score" && (!levels || levels.length < 2)) return { error: `question "${name}": score needs at least 2 levels` };
		questions.push({ name, instructions, type, ...(options ? { options } : {}), ...(levels ? { levels } : {}) });
	}
	return { questions };
}

/** Wire form: choice options are `{value}`, score levels `{label}` (value defaults to index). */
export function toWire(questions: Question[]) {
	return questions.map((q) =>
		q.type === "choice"
			? { type: q.type, name: q.name, instructions: q.instructions, choices: q.options!.map((value) => ({ value })) }
			: q.type === "score"
				? { type: q.type, name: q.name, instructions: q.instructions, levels: q.levels!.map((label) => ({ label })) }
				: { type: q.type, name: q.name, instructions: q.instructions },
	);
}

/** name -> answer, with the question type kept (it says which field holds the result). */
export function toAnswers(answers: any[]) {
	const out: Record<string, any> = {};
	for (const a of answers || []) {
		if (!a?.name) continue;
		out[a.name] = a.type === "choice" ? { type: a.type, choice: a.choice, confidence: a.confidence } : a.type === "score" ? { type: a.type, score: a.score, confidence: a.confidence } : { type: a.type, probability: a.probability };
	}
	return out;
}

/** One decisions request. Throws with a message the session model can act on. */
export async function decide(input: string, images: string[] | undefined, questions: Question[], signal?: AbortSignal) {
	const res = await fetch(`${BASE}/decisions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: MODEL, input, ...(images?.length ? { images } : {}), questions: toWire(questions) }),
		signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]),
	});
	const raw = await res.text();
	if (!res.ok) {
		let why = raw.slice(0, 300);
		try {
			why = JSON.parse(raw)?.error?.message || why;
		} catch {}
		throw new Error(`HTTP ${res.status}: ${why}`);
	}
	const payload = JSON.parse(raw);
	// LM Studio routes decisions by `model`, so a mismatch means we are not talking
	// to the decision model at all. Fail loudly; a silent swap costs the big model.
	if (payload.model && payload.model !== MODEL) throw new Error(`answered by "${payload.model}", not "${MODEL}"`);
	return payload;
}

/**
 * Ask, keeping the prompt inside the instance's batch size. A too-large input is a
 * 500 that names the cap, so the first refusal teaches us the limit; we then cut and
 * retry, halving if the questions' own tokens still push us over.
 */
export async function fittedAsk(material: string, images: string[] | undefined, questions: Question[], signal?: AbortSignal) {
	for (let attempt = 0; ; attempt++) {
		// First try the whole thing (or last known fit); after a refusal, back off by halves.
		const budget = fitChars ? Math.max(120, Math.floor(fitChars / 2 ** Math.max(0, attempt - 1))) : material.length;
		const input = images?.length ? "" : material.slice(0, budget);
		try {
			const payload = await decide(input, images, questions, signal);
			return images?.length
				? { answers: toAnswers(payload.answers), truncated: false }
				: { answers: toAnswers(payload.answers), judged_chars: input.length, truncated: input.length < material.length };
		} catch (err: any) {
			// The refusal names both numbers we need: our input's token count and the cap.
			const m = /input \((\d+) tokens\).*current batch size: (\d+)/.exec(String(err?.message || err));
			if (!m || attempt >= 3) throw err;
			const perToken = input.length ? input.length / Number(m[1]) : 3;
			// 0.8 leaves room for the questions' own tokens, which count against the same batch.
			fitChars = Math.min(fitChars || Infinity, Math.max(120, Math.floor(Number(m[2]) * 0.8 * perToken)));
		}
	}
}

/** Read at most maxChars bytes: a 2 GB file must not be slurped just to be sampled. */
export function readCapped(file: string, maxChars: number) {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(maxChars + 1);
		const n = fs.readSync(fd, buf, 0, maxChars + 1, 0);
		return { text: buf.subarray(0, Math.min(n, maxChars)).toString("utf8"), truncated: n > maxChars };
	} finally {
		fs.closeSync(fd);
	}
}

/** Paths and/or globs, resolved against root, refused when they escape it. */
export function expandFiles(patterns: string[], root: string) {
	const files: string[] = [];
	const rejected: string[] = [];
	for (const p of patterns) {
		const why = checkPath(p, root);
		if (why) {
			rejected.push(`${p}: ${why}`);
			continue;
		}
		const abs = path.resolve(root, p);
		// shortcut: node's own globSync, so no dependency; swap for a real glob lib
		// only if we need semantics it gets wrong.
		let hits: string[] = [abs];
		if (/[*?[\]]/.test(p)) {
			try {
				hits = (fs as any).globSync(abs) as string[];
			} catch {
				hits = [];
			}
		}
		for (const h of hits) {
			try {
				if (fs.statSync(h).isFile()) files.push(h);
			} catch {
				/* vanished between listing and stat */
			}
		}
	}
	return { files: [...new Set(files)], rejected };
}

/** Fixed-size pool: LM Studio is one local server, not a queue to flood. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			for (;;) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i]);
			}
		}),
	);
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_jev",
		description:
			"Ask the local LM Studio DECISION model (small, resident, ~20-90 ms) to judge material. It classifies only — it returns probabilities, never prose. " +
			"Question types: predicate (probability yes/no), choice (argmax over `options`), score (ordered `levels`, worst first). " +
			"It cannot see this conversation or a codebase, so pass everything it needs: `input` for text, or `files` (paths/globs) to ask the same questions once per file — the tool reads them, so file contents never enter your context. Images are scored too. " +
			"Use for bulk judgement a strong model would waste tokens on: per-file classification, triage, secret/PII screening, sorting files by topic. Ask 2-3 questions per call instead of making 3 calls. " +
			"Only the first ~1.5k characters of each text file are scored unless LM Studio's eval_batch_size is raised; the result says how much it judged and whether it truncated. " +
			"Needs LM Studio serving a decision model (JEV_MODEL, default d1-omni-600m).",
		parameters: {
			type: "object",
			properties: {
				questions: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string", description: "Short identifier, becomes the answer key." },
							instructions: { type: "string", description: "The one yes/no-or-pick question, self-contained." },
							type: { type: "string", enum: ["predicate", "choice", "score"], description: "Defaults from options/levels; predicate otherwise." },
							options: { type: "array", items: { type: "string" }, description: "choice: 2+ mutually exclusive values." },
							levels: { type: "array", items: { type: "string" }, description: "score: 2+ ordered labels, worst first." },
						},
						required: ["name", "instructions"],
					},
					description: "1-12 questions asked of the same material in one pass.",
				},
				input: { type: "string", description: "The material, when not reading files (a log excerpt, a commit message, a docstring)." },
				files: {
					type: "array",
					items: { type: "string" },
					description: "Workspace-relative paths and/or globs (e.g. 'src/**/*.ts'). One request per matched file.",
				},
			},
			required: ["questions"],
		} as any,
		execute: async (_id: string, { questions: rawQuestions, input, files }: any, signal?: AbortSignal, _u?: any, ctx?: any) => {
			const root = path.resolve(ctx?.cwd || process.cwd());
			const text = (t: string) => ({ content: [{ type: "text", text: t }] });
			const { questions, error } = buildQuestions(rawQuestions);
			if (error) return text(`ask_jev: ${error}`);
			const qs = questions!;

			const askOne = async (material: string, images?: string[]) => {
				const r = await fittedAsk(material, images, qs, signal);
				return r;
			};

			if (!files?.length) {
				if (typeof input !== "string" || !input.trim()) return text('ask_jev: pass "input" (text) or "files" (paths/globs)');
				try {
					return text(JSON.stringify({ model: MODEL, ...await askOne(input) }, null, 2));
				} catch (err: any) {
					return text(`ask_jev failed: ${err?.message || err} (LM Studio ${BASE}, model ${MODEL})`);
				}
			}

			const { files: list, rejected } = expandFiles(files.map(String), root);
			if (!list.length) return text(JSON.stringify({ asked: 0, rejected, error: "no files matched" }));
			if (list.length > MAX_FILES)
				return text(JSON.stringify({ asked: 0, rejected, error: `${list.length} files matched, narrow the glob (${MAX_FILES} max)` }));

			const t0 = Date.now();
			const results = await mapPool(list, CONCURRENCY, async (file) => {
				const rel = path.relative(root, file) || file;
				try {
					const mime = MIME[path.extname(file).toLowerCase()];
					if (mime) {
						const size = fs.statSync(file).size;
						if (size > MAX_IMAGE_BYTES) throw new Error(`image is ${(size / 1e6).toFixed(1)} MB, over the ${(MAX_IMAGE_BYTES / 1e6).toFixed(0)} MB cap`);
						const r = await askOne("", [`data:${mime};base64,${fs.readFileSync(file).toString("base64")}`]);
						return { file: rel, ...r };
					}
					const r = readCapped(file, MAX_CHARS);
					return { file: rel, ...(await askOne(r.text)), ...(r.truncated ? { read_capped: MAX_CHARS } : {}) };
				} catch (err: any) {
					return { file: rel, error: String(err?.message || err) };
				}
			});
			const failed = results.filter((r: any) => r.error).length;
			return text(JSON.stringify({ model: MODEL, asked: results.length - failed, failed, rejected, ms: Date.now() - t0, results }, null, 2));
		},
	});
}
