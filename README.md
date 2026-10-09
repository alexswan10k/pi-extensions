# pi-extensions

Lambdasafe's Pi extensions, version-controlled here and installed as an ordinary
[Pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
(local path, git, or npm — no build step, Pi loads the `.ts` directly).

| Extension | What it does |
|---|---|
| `extensions/workspace-swarm.ts` | One loopback HTTP hub per workspace: group chat + agent inspector at `http://127.0.0.1:<port>`, tools `send_swarm_message` / `swarm_status` / `get_swarm_history`. Details in [SWARM.md](SWARM.md). |
| `extensions/ringfence.ts` | Default-deny guardrail around `ctx.cwd`: blocks file/shell calls that escape the workspace, touch `$HOME`, or do machine-wide/destructive things, and tells the model to log the need to `user_request.txt`. Not a security boundary. Escape hatch: `RINGFENCE=off`. |

Zero runtime dependencies — both use only `node:*` plus the host-provided
`@earendil-works/pi-coding-agent` types (declared in `peerDependencies`).

## Install

Global (every project) — load the swarm only, keep the fence off by default:

```bash
pi install /Users/alexanderswan/Source/Lambdasafe/pi-extensions
```

then in `~/.pi/agent/settings.json` turn the plain entry into a filtered one:

```json
{ "source": "../../../Source/Lambdasafe/pi-extensions", "extensions": ["-extensions/ringfence.ts"] }
```

Repo-level (e.g. `../voxtrk`, where the fence *is* wanted) — run from that project:

```bash
printf '{\n  "packages": ["../../pi-extensions"]\n}\n' > .pi/settings.json   # or: pi install -l <path>
```

A project entry **replaces** the personal entry, so the project loads whatever the
package declares (both extensions) unless it filters. Switch what loads per scope with
`pi config` (Tab = global/project) and `pi list -a` to see resolved sources.

**Path gotcha:** a relative source resolves from the **directory holding the settings
file** — `<project>/.pi` or `~/.pi/agent` — not from the project root. So from
`<project>/.pi/settings.json` a sibling of the project is `../../pi-extensions`, and
that is why `pi install` writes `../../../Source/...` into `~/.pi/agent/settings.json`.
An absolute path also works (identity is the resolved path, so it never loads twice).

After changing an extension: `/reload`, and restart every live session — a running pi
keeps the extension it started with.

## Test

```bash
npm test                    # 4 fast unit suites, no pi, no model
bash tests/swarm/test.sh    # end-to-end through `pi -ne -e`, ~15 pi print-mode runs (local model)
```

`tests/swarm/test.sh` uses `-ne` (not `-na`) so an installed copy of this package cannot
double-load the extension under test. Same reason: anything that names the extension with
`-e` must not also have it installed — pick one. Runtime state (`.pi/swarm/`, `.ringfence/`,
`user_request.txt`) is written to the session's cwd, never here.
