// node extensions/ask-jev.test.mjs
// Fan-out, capping and the fence, against a stub LM Studio. No model, no network:
// the stub echoes what it was asked, which is exactly what these cases assert.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "jev-"));
process.env.JEV_MAX_CHARS = "512"; // the tool clamps below this, so test at the floor
process.env.JEV_CONCURRENCY = "2";

const seen = [];
let maxInflight = 0;
let inflight = 0;
const srv = http.createServer((req, res) => {
	inflight++;
	maxInflight = Math.max(maxInflight, inflight);
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", async () => {
		inflight--;
		const p = JSON.parse(body);
		const blocks = p.messages[1].content;
		const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
		const image = blocks.find((b) => b.type === "image_url");
		seen.push({ text, image: image ? image.image_url.url.slice(0, 22) : null, fmt: p.response_format?.type, budget: p.max_tokens });
		// BASE is fixed at module load, so the stub varies behaviour on the request,
		// not the URL: this is how the "it spent the whole budget thinking" case is hit.
		const content = text.includes("TRIGGER-EMPTY")
			? ""
			: JSON.stringify({ saw: text, image: seen.at(-1).image });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 96 } }));
	});
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
process.env.JEV_BASE_URL = `http://127.0.0.1:${srv.address().port}/v1`;

const mod = await import("./ask-jev.ts");
const tools = {};
mod.default({ on: () => {}, registerTool: (t) => (tools[t.name] = t), registerCommand: () => {}, sendUserMessage: () => {} });
const tool = tools.ask_jev;
const SCHEMA = { type: "object", properties: { saw: {} }, required: ["saw"], additionalProperties: false };
const run = async (params) => JSON.parse((await tool.execute("c1", params, undefined, undefined, { cwd: dir })).content[0].text);
const answerOf = (r) => r.answer ?? r.results[0].answer;

// The model is told nothing but what we send it, and gets a strict schema.
const one = await run({ question: "Is this a TODO list?", schema: SCHEMA });
assert.equal(one.model, "d1-omni-600m", "names the decision model it used");
assert.equal(seen.at(-1).fmt, "json_schema", "strict json_schema, since LM Studio rejects json_object");
assert.equal(answerOf(one).saw, "Is this a TODO list?", "no file block when files is absent");
assert.equal(seen.at(-1).budget, 800, "a thinking model needs a real answer budget by default");

// A caller that hits the thinking budget can raise it, and cannot ask for the moon.
await run({ question: "q", schema: SCHEMA, max_tokens: 2000 });
assert.equal(seen.at(-1).budget, 2000, "max_tokens passes through");
await run({ question: "q", schema: SCHEMA, max_tokens: 90000 });
assert.equal(seen.at(-1).budget, 4000, "clamped to a sane ceiling");

fs.writeFileSync(path.join(dir, "a.ts"), "alpha");
fs.writeFileSync(path.join(dir, "b.ts"), "beta");
fs.mkdirSync(path.join(dir, "sub"));
fs.writeFileSync(path.join(dir, "sub", "c.ts"), "gamma");
fs.writeFileSync(path.join(dir, "big.ts"), "x".repeat(5000));

seen.length = 0;
const many = await run({ question: "Count the TODOs", schema: SCHEMA, files: ["*.ts", "sub/*.ts"] });
assert.equal(many.asked, 4, `one request per matched file (glob expanded), got ${many.asked}`);
assert.deepEqual(many.results.map((r) => r.file).sort(), ["a.ts", "b.ts", "big.ts", "sub/c.ts"], "paths relative to cwd");
assert.deepEqual(seen.map((s) => s.text.match(/--- (\S+) ---/)[1]).sort(), ["a.ts", "b.ts", "big.ts", "sub/c.ts"], "each request carries its own file");
assert.ok(many.results.every((r) => r.answer.saw.includes("Count the TODOs")), "the question rides along");
assert.ok(maxInflight <= 2, `respects JEV_CONCURRENCY=2, saw ${maxInflight}`);
assert.equal(many.failed, 0);

const big = many.results.find((r) => r.file === "big.ts");
assert.match(big.answer.saw, /\[\.\.\. truncated at 512 chars \.\.\.\]/, "over-cap file is capped and says so");
assert.match(big.answer.saw, /x{512}\n/, "exactly the cap is sent");
assert.ok(!/x{513}/.test(big.answer.saw), "and not one byte more");
assert.ok(!many.results.find((r) => r.file === "a.ts").answer.saw.includes("truncated"), "small file is not marked truncated");

// The fence: escaping the workspace is refused here, not sent to the model.
const esc = await run({ question: "q", schema: SCHEMA, files: ["../outside.ts", "~/secrets.env"] });
assert.equal(esc.asked, 0, "nothing escaped was read");
assert.equal(esc.rejected.length, 2, `both escapes reported: ${JSON.stringify(esc.rejected)}`);
assert.deepEqual(esc.results ?? [], [], "no results for rejected paths");

// An image goes as an image, not as bytes of text.
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
fs.writeFileSync(path.join(dir, "dot.png"), png);
const img = await run({ question: "What colour", schema: SCHEMA, files: ["dot.png"] });
assert.equal(seen.at(-1).image, "data:image/png;base64,", "image sent as a data URL");
assert.equal(img.asked, 1);

// Failure modes come back as data, not as a thrown tool error.
const bad = await run({ question: "TRIGGER-EMPTY", schema: SCHEMA, files: ["a.ts"] });
assert.equal(bad.failed, 1, "empty-content answer is a per-file failure");
assert.match(bad.results[0].error, /all 96 tokens went to reasoning/, `named as a reasoning-budget problem: ${bad.results[0].error}`);

const none = await run({ question: "q", schema: SCHEMA, files: ["nope-*.ts"] });
assert.equal(none.error, "no files matched", "an empty glob says so");
srv.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("ask-jev: all asserts pass");
