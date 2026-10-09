// node extensions/ask-jev.test.mjs
// The decisions request layer, fan-out, capping and the fence, against a stub LM
// Studio. No model, no network: the stub answers from the questions it was sent,
// which is what these cases assert.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "jev-"));
process.env.JEV_MAX_CHARS = "4000"; // read cap, so the batch case below has room
process.env.JEV_CONCURRENCY = "2";

const seen = [];
let batchRefusals = 0;
let maxInflight = 0;
let inflight = 0;

/** Answers the questions the way LM Studio does, plus the failures we must survive. */
function answerFor(p) {
	const input = p.input || "";
	const answers = p.questions.map((q) => {
		if (q.type === "choice") {
			const pick = input.includes("alpha") ? q.choices[1] : q.choices[0];
			return { type: "choice", name: q.name, choice: pick.value, probabilities: q.choices.map((c, i) => ({ value: c.value, probability: i ? 0.2 : 0.8 })), confidence: 0.6 };
		}
		if (q.type === "score") {
			return { type: "score", name: q.name, score: q.levels.length - 1, probabilities: q.levels.map((l, i) => ({ value: i, label: l.label, probability: 1 })), confidence: 0.5 };
		}
		return { type: "predicate", name: q.name, probability: input.includes("beta") ? 0.91 : 0.12 };
	});
	return { model: p.model, answers, usage: { input_tokens: Math.round(input.length / 4), output_tokens: 0 } };
}

const srv = http.createServer((req, res) => {
	inflight++;
	maxInflight = Math.max(maxInflight, inflight);
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		inflight--;
		const p = JSON.parse(body);
		seen.push({ path: req.url, model: p.model, input: p.input, images: p.images, questions: p.questions });
		const fail = (code, msg) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: msg } }));
		};
		// LM Studio rejects anything that is not a decision model — and silently
		// substitutes the chat default on /chat/completions, which is why we do not
		// use that endpoint at all.
		if (p.model !== "d1-omni-600m") return fail(400, `Invalid model identifier "${p.model}".`);
		if (p.input.includes("TRIGGER-IDENTITY")) {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ model: "qwen3.8-flash-next", answers: [] }));
		}
		// The batch refusal we get for real from a 512-token instance.
		if (p.input.includes("TRIGGER-BATCH") && p.input.length > 1500) {
			batchRefusals++;
			return fail(500, `d1-omni-600m: input (${Math.round(p.input.length / 4)} tokens) is too large to process. increase the physical batch size (current batch size: 512)`);
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(answerFor(p)));
	});
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
process.env.JEV_BASE_URL = `http://127.0.0.1:${srv.address().port}/v1`;

const mod = await import("./ask-jev.ts");
const tools = {};
mod.default({ on: () => {}, registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, sendUserMessage: () => {} });
const tool = tools.ask_jev;
const raw = async (params) => (await tool.execute("c1", params, undefined, undefined, { cwd: dir })).content[0].text;
const run = async (params) => JSON.parse(await raw(params));

const PRED = [{ name: "logged", instructions: "Does this file log its errors?" }];

// Bad questions are refused before anything is sent.
for (const [bad, why] of [
	[undefined, '"questions" must be a non-empty array'],
	[[{ instructions: "no name" }], "must be a short identifier"],
	[[{ name: "x" }], "needs instructions"],
	[[{ name: "x", instructions: "i", type: "guess" }], "unknown type"],
	[[{ name: "x", instructions: "i", options: ["one"] }], "choice needs at least 2"],
	[[{ name: "x", instructions: "i", levels: ["low"] }], "score needs at least 2"],
]) {
	const out = await raw({ questions: bad, input: "text" });
	assert.match(out, new RegExp(why), `refused: ${why}`);
}
assert.equal(seen.length, 0, "a refused question never reaches the model");

// All three question types, in the shape LM Studio accepts.
const one = await run({
	questions: [
		{ name: "logged", instructions: "Does this file log its errors?" },
		{ name: "kind", instructions: "What kind of file is it?", options: ["source", "test", "docs"] },
		{ name: "quality", instructions: "How complete is it?", levels: ["stub", "partial", "done"] },
	],
	input: "function f() { return 1 }",
});
assert.equal(one.model, "d1-omni-600m", "names the decision model it used");
const wire = seen.at(-1).questions;
assert.deepEqual(wire[0], { type: "predicate", name: "logged", instructions: "Does this file log its errors?" }, "predicate carries nothing else");
assert.deepEqual(wire[1].choices, [{ value: "source" }, { value: "test" }, { value: "docs" }], "choice options go as {value}, not {label}");
assert.deepEqual(wire[2].levels, [{ label: "stub" }, { label: "partial" }, { label: "done" }], "score levels go as {label}");
assert.equal(seen.at(-1).path, "/v1/decisions", "the decisions endpoint, not chat/completions");
assert.equal(one.answers.logged.probability, 0.12);
assert.equal(one.answers.kind.choice, "source");
assert.equal(one.answers.quality.score, 2);
assert.equal(one.truncated, false, "short input is whole");

// Fan-out: one request per file, contents kept out of the session model.
fs.writeFileSync(path.join(dir, "a.ts"), "alpha");
fs.writeFileSync(path.join(dir, "b.ts"), "beta");
fs.mkdirSync(path.join(dir, "sub"));
fs.writeFileSync(path.join(dir, "sub", "c.ts"), "gamma");
fs.writeFileSync(path.join(dir, "big.ts"), "x".repeat(9000));

seen.length = 0;
const many = await run({ questions: PRED, files: ["*.ts", "sub/*.ts"] });
assert.equal(many.asked, 4, `one request per matched file (glob expanded), got ${many.asked}`);
assert.deepEqual(many.results.map((r) => r.file).sort(), ["a.ts", "b.ts", "big.ts", "sub/c.ts"], "paths relative to cwd");
assert.deepEqual(seen.map((s) => s.input.slice(0, 5).trim()).sort(), ["alpha", "beta", "gamma", "xxxxx"], "each request carries its own material");
assert.ok(many.results.find((r) => r.file === "b.ts").answers.logged.probability > 0.9, "answers come back per file");
assert.ok(maxInflight <= 2, `respects JEV_CONCURRENCY=2, saw ${maxInflight}`);
assert.equal(many.failed, 0);
assert.equal(many.results.find((r) => r.file === "big.ts").read_capped, 4000, "a file over the read cap says so");
assert.equal(many.results.find((r) => r.file === "a.ts").read_capped, undefined, "a small file does not");

// The fence: escaping the workspace is refused here, not sent to the model.
const esc = await run({ questions: PRED, files: ["../outside.ts", "~/secrets.env"] });
assert.equal(esc.asked, 0, "nothing escaped was read");
assert.equal(esc.rejected.length, 2, `both escapes reported: ${JSON.stringify(esc.rejected)}`);
assert.equal((await run({ questions: PRED, files: ["nope-*.ts"] })).error, "no files matched", "an empty glob says so");

// An image goes as an image, not as bytes of text, and never as `input`.
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
fs.writeFileSync(path.join(dir, "dot.png"), png);
const img = await run({ questions: PRED, files: ["dot.png"] });
assert.equal(seen.at(-1).images[0].slice(0, 22), "data:image/png;base64,", "image sent as a data URL");
assert.equal(seen.at(-1).input, "", "and the input stays empty");
assert.equal(img.asked, 1);

// If something other than the decision model answers, that is an error, not an answer.
fs.writeFileSync(path.join(dir, "wrong-model.ts"), "TRIGGER-IDENTITY\nexport const x = 1;");
const wrong = await run({ questions: PRED, files: ["wrong-model.ts"] });
assert.equal(wrong.failed, 1, "a substituted model is a failure, not an answer");
assert.match(wrong.results[0].error, /answered by "qwen3\.8-flash-next", not "d1-omni-600m"/, "a substituted model fails loudly");

// A too-large input teaches us the instance's batch size, then fits itself to it.
fs.writeFileSync(path.join(dir, "huge.ts"), `TRIGGER-BATCH\n${"y".repeat(5000)}`);
const before = batchRefusals;
const fitted = await run({ questions: PRED, files: ["huge.ts"] });
assert.equal(fitted.failed, 0, `refusal was retried, not surfaced: ${JSON.stringify(fitted.results[0])}`);
const got = fitted.results[0].judged_chars;
assert.ok(got <= 1700 && got > 100, `cut to fit the reported batch size, got ${got}`);
assert.equal(fitted.results[0].truncated, true, "and says it judged only part");
assert.ok(batchRefusals > before, "learned the cap from the refusal");

// The cap is remembered, so the next big file is cut before it is ever sent.
const cached = batchRefusals;
const again = await run({ questions: PRED, files: ["big.ts"] });
assert.equal(batchRefusals, cached, "no new refusal: the cap is cached");
assert.ok(again.results[0].judged_chars <= 1700, `pre-cut to ${again.results[0].judged_chars}`);

assert.match(await raw({ questions: PRED }), /pass "input" \(text\) or "files"/, "neither input nor files says so");
srv.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("ask-jev: all asserts pass");
