# pi-extensions

Lambdasafe's Pi extensions, version-controlled here and installed as an ordinary
[Pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
(local path, git, or npm — no build step, Pi loads the `.ts` directly).

| Extension | What it does |
|---|---|
| `extensions/workspace-swarm.ts` | One loopback HTTP hub per workspace: group chat + agent inspector at `http://127.0.0.1:<port>`, tools `send_swarm_message` / `swarm_status` / `get_swarm_history`. Details in [SWARM.md](SWARM.md). |
| `extensions/ringfence.ts` | Default-deny guardrail around `ctx.cwd`: blocks file/shell calls that escape the workspace, touch `$HOME`, or do machine-wide/destructive things, and tells the model to log the need to `user_request.txt`. Not a security boundary. Escape hatch: `RINGFENCE=off`. |
| `extensions/ask-jev.ts` | Tool `ask_jev`: one cheap schema-shaped question to the local LM Studio **decision model**, or the same question fanned out over many files/images. |

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

The session model asks a question + a JSON schema; the small resident decision model
answers in ~0.5 s. With `files` (paths or globs) the same question is asked once per
file **with the file attached, read here in-process** — so classifying 60 files costs the
session model 60 short answers, not 60 files of context. Images go as images; it sees them.

```jsonc
{ "question": "Does this file leak secrets? name them",
  "schema": { "type": "object", "properties": { "leak": { "type": "boolean" }, "which": { "type": "array", "items": { "type": "string" } } },
              "required": ["leak", "which"], "additionalProperties": false },
  "files": ["src/**/*.ts", "logs/deploy.log"] }
```

Reads are checked with ringfence's own `checkPath`, so `ask_jev` is not a door around the
fence. LM Studio quirks worth knowing (all measured, see the header of `ask-jev.ts`): it
thinks before answering and thinking eats `max_tokens`, so a small budget comes back empty
(the tool says so and you can retry with a larger `max_tokens`); `response_format` only
accepts `json_schema`, never `json_object`.

Env: `JEV_MODEL` (`d1-omni-600m`), `JEV_BASE_URL` (`http://localhost:1234/v1`),
`JEV_CONCURRENCY` (4), `JEV_MAX_CHARS` (24 000 per file), `JEV_MAX_TOKENS` (800),
`JEV_TIMEOUT_MS` (120 000). Needs LM Studio running with that model served —
`lms load d1-omni-600m` or the app; a decision model normally stays resident.

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
