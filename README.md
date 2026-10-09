# pi-extensions

Lambdasafe's Pi extensions, version-controlled here and installed as an ordinary
[Pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
(local path, git, or npm — no build step, Pi loads the `.ts` directly).

| Extension | What it does |
|---|---|
| `extensions/workspace-swarm.ts` | One loopback HTTP hub per workspace: group chat + agent inspector at `http://127.0.0.1:<port>`, tools `send_swarm_message` / `swarm_status` / `get_swarm_history`. Details in [SWARM.md](SWARM.md). |
| `extensions/ringfence.ts` | Default-deny guardrail around `ctx.cwd`: blocks file/shell calls that escape the workspace, touch `$HOME`, or do machine-wide/destructive things, and tells the model to log the need to `user_request.txt`. Not a security boundary. Escape hatch: `RINGFENCE=off`. |
| `extensions/ask-jev.ts` | Tool `ask_jev`: cheap yes/no, pick-one and rate judgements from the local LM Studio **decision model**, one pass over many files/images. |

Zero runtime dependencies — both use only `node:*` plus the host-provided
`@earendil-works/pi-coding-agent` types (declared in `peerDependencies`).

## Install

This repo is the source of truth; every project installs it from GitHub.

Global (every Pi session, all machines):

```bash
pi install git:github.com/alexswan10k/pi-extensions
```

That loads all three extensions everywhere. The fence is usually only wanted in chosen
repos, so turn the plain entry in `~/.pi/agent/settings.json` into a filtered one:

```json
{ "source": "git:github.com/alexswan10k/pi-extensions", "extensions": ["-extensions/ringfence.ts"] }
```

Per-project (a repo where the fence *is* wanted) — run from that project:

```bash
pi install -l git:github.com/alexswan10k/pi-extensions
```

A project entry **replaces** the personal entry, so the project loads whatever the
package declares (all three) unless it filters. Switch what loads per scope with
`pi config` (Tab = global/project) and `pi list -a` to see resolved sources. Git sources
are identified by repo URL (ignoring the ref), so a global and a project entry never
load twice.

Don't keep a hand-copied `.pi/extensions/` in a project: it shadows this package, drifts,
and loads a second copy of the swarm. Delete it and install the source instead.

Editing the extensions themselves? Clone and install the checkout —
`pi install ./pi-extensions` loads the path without copying, so edits apply after
`/reload` and restart of live sessions. A relative source resolves from the directory
holding the settings file (`<project>/.pi` or `~/.pi/agent`), not the project root.

Updating an installed git source: `pi update --extensions` (a pinned `@ref` stays pinned).

## ask_jev

The local decision model **classifies; it never writes**. It answers three kinds of
question about material you hand it, and returns numbers, not prose (measured: 15–90 ms a
request, `output_tokens` always 0):

| type | ask | you get |
|---|---|---|
| `predicate` | one yes/no question | `probability` |
| `choice` | pick one of `options` | `choice` + `confidence` |
| `score` | rate against ordered `levels` | `score` + `confidence` |

```jsonc
{ "questions": [
    { "name": "leaks",  "instructions": "Does this file contain a hardcoded secret or token?" },
    { "name": "kind",   "instructions": "What is this file?", "options": ["source", "test", "config", "docs"] } ],
  "files": ["src/**/*.ts", "logs/deploy.log", "shots/*.png"] }
```

With `files` (paths or globs) the same questions are asked once per file **read here,
in-process** — classifying 60 files costs the session model 60 small answers, never 60
files of context. Images go as images (top-level `images` data URLs; it is an omni model).
Ask 2–3 questions per call instead of making 3 calls. Reads are checked with ringfence's
own `checkPath`, so `ask_jev` is not a door around the fence.

**Two LM Studio traps, both measured** (details in the header of `ask-jev.ts`):

1. **Never use `/v1/chat/completions` for a decision model.** It ignores `model` and
   answers from the loaded chat default — ask for `d1-omni-600m`, get qwen back, and ask
   for `bogus-xyz`, also get qwen. `/v1/decisions` honours `model` and rejects anything
   that is not a decision model, so a 200 there is proof of who answered. `ask_jev` also
   throws if the reply names any other model. Any "decision model" screen built on
   chat/completions is paying for the big model while believing it is not.
2. **The input window is `eval_batch_size`, not the context length.** A default load has
   `eval_batch_size: 512`, so only ~1.2 k characters fit — 128 k of context does not
   help. Too big is an HTTP 500 naming the cap; the tool reads the cap off that refusal,
   cuts, retries, and reports `judged_chars` / `truncated`. Raise it for real coverage
   (reload with `eval_batch_size` 8192 ≈ 16 k chars) and `ask_jev` uses the room with no
   config change:

   ```bash
   curl -s localhost:1234/api/v0/unload -d '{"model":"d1-omni-600m"}' -H 'content-type: application/json'
   curl -s localhost:1234/api/v0/load -d '{"model":"d1-omni-600m","context_length":128000,"eval_batch_size":8192}' -H 'content-type: application/json'
   ```

Because only the head is judged by default, ask questions that hold for the *first* screen
of a file. Predicates separated cleanly in testing (a network-binding file scored 0.34
against 0.007 for one that does not); a `choice` over four labels came back nearly uniform
at confidence ~0.1, i.e. no signal — prefer two or three sharply different options, and
sanity-check a new question against a file you know the answer for.

Env: `JEV_MODEL` (`d1-omni-600m`), `JEV_BASE_URL` (`http://localhost:1234/v1`),
`JEV_CONCURRENCY` (4), `JEV_MAX_CHARS` (24 000 read per file), `JEV_TIMEOUT_MS` (30 000).
Needs LM Studio running with a decision model served — `lms load d1-omni-600m` or the app;
a decision model normally stays resident.

## Test

```bash
npm test                    # 5 fast unit suites, no pi, no model
bash tests/swarm/test.sh    # end-to-end through `pi -ne -e`, ~15 pi print-mode runs (local model)
```

`tests/swarm/test.sh` uses `-ne` (not `-na`) so an installed copy of this package cannot
double-load the extension under test. Same reason: anything that names the extension with
`-e` must not also have it installed — pick one. Note `-ne` also drops package-provided
*providers*, so the suite names its model's provider too (`-e npm:pi-lmstudio`, override
with `PI_TEST_PACKAGES`); `-na` does not suppress user packages, only project files. Runtime state (`.pi/swarm/`, `.ringfence/`,
`user_request.txt`) is written to the session's cwd, never here.
