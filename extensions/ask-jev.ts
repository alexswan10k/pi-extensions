// ask-jev: ping the local LM Studio decision model ("jev") for a fast, cheap,
// schema-shaped second opinion, optionally fanned out over files.
//
// WHY IT READS FILES ITSELF: the point is to keep bulk out of the expensive
// session model's context. The session model names paths or a glob; we read them
// here, cap them, and fire one small request per file at the decision model. The
// session model gets back the N answers, never the N files.
//
// MEASURED against LM Studio + d1-omni-600m (arch lfm2, type "decision", resident):
//   - 0.3-0.7 s per request solo, ~1.8 req/s at 8-way concurrency
//   - it thinks first: `reasoning_content` is separate, and reasoning tokens eat
//     max_tokens, so a small budget returns content:"" (we report that as such)
//   - response_format json_schema (strict) works; json_object is REJECTED (400)
//   - image_url data URLs work (png tested) — "omni" is not a lie
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
const TIMEOUT_MS = Math.max(1000, Number(process.env.JEV_TIMEOUT_MS) || 120_000);
const MAX_TOKENS = Math.max(64, Number(process.env.JEV_MAX_TOKENS) || 800);
const MAX_FILES = 200; // shortcut: fixed cap, raise it if a real glob needs more

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

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

/** One schema-constrained question. Throws with a message the session model can act on. */
export async function askJev(question: string, schema: object, content: unknown, maxTokens = MAX_TOKENS, signal?: AbortSignal) {
	const res = await fetch(`${BASE}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{
					role: "system",
					content:
						"You are a fast decision model. Answer only from the material in this request; you cannot see any codebase or conversation. Reply with JSON matching the required schema and nothing else.",
				},
				{ role: "user", content },
			],
			temperature: 0,
			max_tokens: maxTokens,
			response_format: { type: "json_schema", json_schema: { name: "jev_answer", schema, strict: true } },
		}),
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
	const text = String(payload.choices?.[0]?.message?.content ?? "").trim();
	if (!text) {
		// Usually the thinking budget, not a refusal: it reasoned, then ran out.
		// usage sits next to choices, not inside it.
		throw new Error(`empty answer: all ${payload.usage?.completion_tokens ?? "?"} tokens went to reasoning, retry with a larger max_tokens or less material`);
	}
	try {
		return JSON.parse(text);
	} catch {
		return { answer: text.slice(0, 2000) }; // model ignored the schema; keep its words
	}
}

/** User content block: the question, plus the material it is about. */
export function userContent(question: string, file: string | null, body?: unknown) {
	if (file === null) return [{ type: "text", text: question }];
	return [
		{ type: "text", text: `${question}\n\n--- ${file} ---` },
		typeof body === "string" ? { type: "text", text: body } : (body as any),
	];
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_jev",
		description:
			"Ask the local LM Studio decision model (small, resident, ~0.5 s, answer constrained by a JSON schema) a question. It cannot see this conversation, so pass it everything it needs. " +
			"Without `files`: one question, one answer. With `files` (workspace paths or globs): the same question asked once per file with that file attached — the files are read here, so their contents never enter your context. " +
			"Use it for bulk judgement a strong model would waste tokens on: per-file classification, 'does every handler log errors', secret/PII scanning, summarising a log, sorting files by topic. It also sees images (png/jpg/webp/gif). " +
			"Needs LM Studio serving JEV_MODEL (default d1-omni-600m).",
		parameters: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description: "Self-contained instruction. With `files`, describe the judgement to make; do not quote file contents, the tool attaches them.",
				},
				schema: {
					type: "object",
					description:
						'JSON Schema for the answer, e.g. {"type":"object","properties":{"ok":{"type":"boolean"},"why":{"type":"string"}},"required":["ok","why"],"additionalProperties":false}',
				},
				files: {
					type: "array",
					items: { type: "string" },
					description: "Workspace-relative paths and/or globs (e.g. 'src/**/*.ts'). One request per matched file.",
				},
				max_tokens: {
					type: "integer",
					minimum: 64,
					maximum: 4000,
					description: `Answer budget (default ${MAX_TOKENS}). It thinks before answering, so a small budget can return nothing at all.`,
				},
			},
			required: ["question", "schema"],
		} as any,
		execute: async (_id: string, { question, schema, files, max_tokens }: any, signal?: AbortSignal, _u?: any, ctx?: any) => {
			const root = path.resolve(ctx?.cwd || process.cwd());
			const text = (t: string) => ({ content: [{ type: "text", text: t }] });
			if (!schema || typeof schema !== "object") return text('ask_jev: "schema" must be a JSON Schema object');
			const q = String(question);
			const budget = Math.min(4000, Math.max(64, Number(max_tokens) || MAX_TOKENS));

			if (!files?.length) {
				try {
					return text(JSON.stringify({ model: MODEL, answer: await askJev(q, schema, userContent(q, null), budget, signal) }));
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
					let body: unknown;
					const mime = MIME[path.extname(file).toLowerCase()];
					if (mime) {
						const size = fs.statSync(file).size;
						if (size > 8_000_000) throw new Error(`image is ${(size / 1e6).toFixed(1)} MB, over the 8 MB cap`);
						body = { type: "image_url", image_url: { url: `data:${mime};base64,${fs.readFileSync(file).toString("base64")}` } };
					} else {
						const r = readCapped(file, MAX_CHARS);
						body = r.text + (r.truncated ? `\n[... truncated at ${MAX_CHARS} chars ...]` : "");
					}
					return { file: rel, answer: await askJev(q, schema, userContent(q, rel, body), budget, signal) };
				} catch (err: any) {
					return { file: rel, error: String(err?.message || err) };
				}
			});
			const failed = results.filter((r: any) => r.error).length;
			return text(JSON.stringify({ model: MODEL, asked: results.length - failed, failed, rejected, ms: Date.now() - t0, results }, null, 2));
		},
	});
}
