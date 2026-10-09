// Workspace swarm over HTTP: one hub, many clients, one browser group chat.
//
// The first pi session in a workspace binds a port and becomes the hub; every
// other session (and any other harness: curl, python, another agent framework)
// talks to it over REST. Ownership is reference-counted with LEASES, not
// inc/dec counters: every member renews a short lease by polling, so a process
// that is SIGKILLed cannot leak a count, and the server closes itself when the
// last lease goes stale. If the hub dies with clients alive, the first client
// that fails to reach it binds the port and promotes (history is on disk).
//
// There is no login, no logout, no presence line in the chat: identity lives in
// a side registry of leases. The log contains text messages only.
//
// No auth and no TLS, so the bind is LOOPBACK ONLY and cannot be widened:
// PI_SWARM_HOST picks which loopback address (127.0.0.1 or ::1), and anything
// routable is clamped back to 127.0.0.1. This is a convenience bus for one
// workspace, not a public service.
//
// VISIBILITY: every member reports what it is up to on the poll it already makes
// (&s={json}), the hub keeps it in RAM next to the lease, and GET /api/agent?id=
// serves one member in detail (status, unread, activity ring, transcript tail).
// Peers report only about themselves and the hub only displays it: see SWARM.md.
//
// WHO WAKES WHOM: the hub stamps every message with the agent ids that must wake
// for it. A person's message goes to ONE live agent (round-robin over the person's
// own turns), an @mention wakes the agent it names, @all wakes everyone, and
// everything else — peer chatter, CI — is unread context that rides along with the
// next real wake. Without this, N sessions polling the same hub wake on the same
// broadcast and all of them fight over the reply. PI_SWARM_WAKE=all restores
// wake-on-anything; PI_SWARM_HUMAN=all wakes every live agent for a person's
// message only (peer chatter still wakes nobody, so agents cannot ping-pong).
//
// Env: PI_SWARM_URL (attach to a hub elsewhere; never promote), PI_SWARM_PORT,
// PI_SWARM_HOST (loopback only), PI_SWARM_DIR, PI_AGENT_NAME, PI_SWARM_CURSOR, PI_SWARM_CHANNEL,
// PI_SWARM_GENERAL=0, PI_SWARM_SELF_PREFIX, PI_SWARM_WAKE=all, PI_SWARM_HUMAN=all.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DIR = process.env.PI_SWARM_DIR || path.join(process.cwd(), ".pi", "swarm");
const LOG = path.join(DIR, "messages.jsonl");
const HUB_FILE = path.join(DIR, "hub.json");
const CURSOR_DIR = path.join(DIR, "cursors");
// Loopback only, always. This bus has no auth and open CORS, so binding a
// routable address would hand the workspace's chat (and every agent on it) to
// the network. PI_SWARM_HOST picks WHICH loopback, not whether to expose it.
const HOST = loopback(process.env.PI_SWARM_HOST || "127.0.0.1");
const STARTED = new Date().toISOString();

/** 127.0.0.1 for anything that is not already a loopback address. */
function loopback(h: string): string {
  const v = String(h || "").trim().replace(/^\[|\]$/g, "");
  if (!v || v === "*" || /^(0\.){3}0$/.test(v)) return "127.0.0.1";
  if (v === "localhost") return "127.0.0.1";
  if (v === "::1" || v.startsWith("127.")) return v;
  return "127.0.0.1";
}

const displayHost = (h: string) => (h.includes(":") ? `[${h}]` : h);
const PORT = Number(process.env.PI_SWARM_PORT ?? portForCwd(process.cwd()));
const LEASE_MS = 6000; // a member is "here" if it renewed within this window
const POLL_MS = 800;
const MEMORY_MSGS = 3000; // ponytail: in-RAM tail; older lines stay on disk only
const MAX_TEXT = 8000;

// kind and wake are stamped by the hub when the message is posted: what the
// sender is registered as (agent | one-shot | browser | harness), and who wakes.
type Msg = { seq: number; sender: string; channel: string; text: string; ts: string; kind?: string; wake?: string[] };
// s = what the agent says it is doing (peer-reported display data, never
// authority); t = the tail of its own session file, kept only while a tab watches.
type Lease = { ts: number; name: string; kind: string; note?: string; s?: Status; t?: Tail };
type Status = Record<string, any>;
type Tail = { file: string; at: number; lines: { r: string; txt: string }[] };

/** Deterministic port per workspace so clients find the hub without config. */
function portForCwd(cwd: string): number {
  let h = 2166136261;
  for (let i = 0; i < cwd.length; i++) h = Math.imul(h ^ cwd.charCodeAt(i), 16777619);
  return 21000 + (Math.abs(h) % 10000);
}

class Hub {
  msgs: Msg[] = [];
  seq = 0;
  leases = new Map<string, Lease>();
  // Round-robin pointer for a person's messages. It counts PEOPLE'S TURNS, not
  // hub seq: keyed off seq (as before) the pick depended on how much chatter the
  // agents posted in between, so two of the human's messages in a row landed on
  // the same agent while the other slept (real case: seq 19 and 21, both odd).
  // In-memory, so a promotion restarts the rotation: worst case one repeat.
  humanTurns = 0;
  // id -> until-ms: somebody's tab is watching this agent, so it should publish a
  // transcript tail. In RAM, expires on its own: nobody has to unsubscribe.
  wanted = new Map<string, number>();

  logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    this.load();
  }

  private load() {
    let raw: string;
    try {
      raw = fs.readFileSync(this.logPath, "utf-8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      try {
        const m = JSON.parse(line);
        if (m && typeof m.seq === "number" && typeof m.text === "string") {
          this.msgs.push(m);
          if (m.seq > this.seq) this.seq = m.seq;
        }
      } catch {
        /* torn line from a killed process: skip, keep replaying */
      }
    }
    if (this.msgs.length > MEMORY_MSGS) this.msgs = this.msgs.slice(-MEMORY_MSGS);
  }

  post(sender: string, channel: string, text: string): Msg {
    const m: Msg = {
      seq: ++this.seq,
      sender: sender.slice(0, 64),
      channel: channel.slice(0, 64),
      text: text.slice(0, MAX_TEXT),
      ts: new Date().toISOString(),
      // A tab opened before the id change still polls as browser:<name>: it is
      // still a person, so read the kind under both ids (stale lease included).
      // A person posting from a shell (curl sender=human) holds no lease, and
      // "unknown" meant nobody was woken for it at all. fromHuman() on the client
      // already counts these as a person; the hub has to agree or the message dies.
      kind:
        this.leases.get(sender)?.kind ||
        this.leases.get(`browser:${sender}`)?.kind ||
        (/^(human|browser)\b/i.test(sender) ? "browser" : "unknown"),
    };
    m.wake = this.wakeFor(m, text);
    this.msgs.push(m);
    if (this.msgs.length > MEMORY_MSGS) this.msgs.shift();
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    fs.appendFileSync(this.logPath, JSON.stringify(m) + "\n", "utf-8");
    return m;
  }

  /**
   * Which agents must wake up for this message. Decided once, here, at post time:
   * clients pull, so they cannot race for it themselves. Everyone else still gets
   * the text, but as context at their next wake instead of as a new turn.
   */
  private wakeFor(m: Msg, text: string) {
    const agents = this.live().filter((a) => a.kind === "agent");
    const named = agents.filter((a) => text.includes("@" + a.id) || (!!a.name && text.includes("@" + a.name)));
    if (named.length) return named.map((a) => a.id);
    if (/@(all|here)\b/i.test(text)) return agents.map((a) => a.id);
    // A person spoke: one agent by default, so N sessions do not stampede the same
    // answer; PI_SWARM_HUMAN=all is the "I want you both on it" mode.
    if (m.kind === "browser" || m.kind === "human") {
      if (!agents.length) return [];
      if ((process.env.PI_SWARM_HUMAN || "") === "all") return agents.map((a) => a.id);
      return [agents[this.humanTurns++ % agents.length].id];
    }
    return []; // peer or harness chatter: context, no wake
  }

  since(seq: number) {
    const truncated = this.msgs.length > 0 && seq + 1 < this.msgs[0].seq - 1;
    return { messages: this.msgs.filter((m) => m.seq > seq), truncated };
  }

  renew(id: string, kind = "client", name?: string, note?: string, status?: unknown, tail?: unknown) {
    const prev = this.leases.get(id);
    // A custom name wins; machine ids get a readable handle instead of a uuid.
    // name === id is the client echoing its own id back: not a custom name.
    // Note the ternary: `(name && name !== id)` yields a boolean, and a lease
    // named `true` broke both the display name and "@<handle>" wake matching.
    const custom = name && name !== id ? name : prev && prev.name !== id ? prev.name : "";
    this.leases.set(id, {
      ts: Date.now(),
      name: custom || this.nick(id),
      kind,
      note: note ?? prev?.note,
      // An update that carries only one of the two must not drop the other.
      s: clampStatus(status) ?? prev?.s,
      t: clampTail(tail) ?? prev?.t,
    });
  }

  /** Fun handle for machine ids, unique among live leasees. */
  private nick(id: string) {
    if (!looksMachine(id)) return id;
    const now = Date.now();
    const taken = new Set([...this.leases.entries()].filter(([k, v]) => k !== id && now - v.ts < LEASE_MS).map(([, v]) => v.name));
    let nick = nickFor(id);
    for (let i = 2; taken.has(nick); i++) nick = `${nickFor(id)}-${i}`;
    return nick;
  }

  // Transcript tails are left out: the roster is polled by every tab every
  // 700 ms, and a tail is only ever asked for by the one tab looking at that
  // agent (GET /api/agent).
  live() {
    const now = Date.now();
    return [...this.leases.entries()]
      .filter(([, v]) => now - v.ts < LEASE_MS)
      .map(([id, v]) => ({ id, ...v, t: undefined }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  want(id: string, secs: number) {
    this.wanted.set(id, Date.now() + Math.max(1, Math.min(300, secs || 8)) * 1000);
    if (this.wanted.size > 64) this.wanted.delete(this.wanted.keys().next().value); // idle tabs, not a leak
  }

  isWatched(id: string) {
    const until = this.wanted.get(id);
    if (until === undefined) return false;
    if (until < Date.now()) {
      this.wanted.delete(id);
      return false;
    }
    return true;
  }

  /** Everything the GUI shows for one agent, by id or by handle. */
  detail(who: string, limit = 20) {
    const id = this.leases.has(who) ? who : this.live().find((a) => a.name === who)?.id;
    const lease = id ? this.leases.get(id) : undefined;
    if (!id || !lease) return { found: false, id: who, seq: this.seq, live: this.live().map((a) => ({ id: a.id, name: a.name })) };
    const cursor = readCursor(id);
    return {
      found: true,
      id,
      name: lease.name,
      kind: lease.kind,
      note: lease.note ?? null,
      seq: this.seq,
      seen_ms_ago: Date.now() - lease.ts,
      live: Date.now() - lease.ts < LEASE_MS,
      watched: this.isWatched(id),
      cursor,
      unread: cursor === null ? null : Math.max(0, this.seq - cursor),
      status: lease.s ?? null,
      transcript: lease.t ?? null,
      posted: this.msgs.filter((m) => m.sender === id).slice(-Math.max(1, Math.min(100, limit))),
    };
  }
}

// Fun readable handles: a UUIDv7 slice is unreadable in the GUI and in chat.
// Deterministic from the id so the same agent keeps the same name across
// restarts; wakeFor already matches "@"+name, so @brave-fox wakes it too.
const ADJ = ["swift", "brave", "cosmic", "clever", "crisp", "dizzy", "fluffy", "gentle", "grumpy", "happy", "jolly", "keen", "lucky", "mellow", "nimble", "ornate", "polar", "quiet", "rusty", "sunny", "tidy", "urban", "witty", "zesty"];
const NOUN = ["fox", "otter", "heron", "panda", "lynx", "wren", "seal", "moth", "crow", "gecko", "slug", "yak", "eland", "okapi", "quail", "rbp", "stoat", "tahr", "urchin", "vicuna", "walrus", "xerus", "yeti", "zebu"];

const fnv = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
};
const nickFor = (id: string) => `${ADJ[fnv(id) % ADJ.length]}-${NOUN[fnv(id + "n") % NOUN.length]}`;
// Uuid-ish or agent-<pid> ids get a handle; a harness that registered as "ci"
// or a person "human-ab12cd" keeps what they chose.
const looksMachine = (id: string) => /^[0-9a-f][0-9a-f-]{11,}$/i.test(id);

const esc = (s: string) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ---- peer-reported visibility -------------------------------------------------
// An agent tells the hub what it is up to on the poll it already makes; the hub
// stores it next to the lease and hands it to whoever asks. Nothing is written to
// disk: this is live state, and a stale agent's state expires with its lease.
// The hub never interprets it — a peer can lie about its own status, nothing more.

const S_STR = ["ph", "tool", "act", "model", "mode", "chan", "cwd", "log"];
const S_NUM = ["unread", "turn", "tools", "errs", "tok", "up", "run", "q", "pid"];

/** Keep a status blob small and typed. Anything odd is dropped, not thrown. */
function clampStatus(raw: any): Status | undefined {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!raw || typeof raw !== "object") return undefined;
  const s: Status = {};
  for (const k of S_STR) if (typeof raw[k] === "string" && raw[k]) s[k] = raw[k].slice(0, 200);
  // Out-of-range is nonsense, not something to round into the accepted band.
  for (const k of S_NUM) {
    const n = Number(raw[k]);
    if (Number.isFinite(n) && n >= 0 && n <= 1e12) s[k] = Math.round(n);
  }
  if (Number.isFinite(Number(raw.usd)) && Number(raw.usd) >= 0) s.usd = Math.round(Number(raw.usd) * 1e4) / 1e4;
  if (raw.host) s.host = 1;
  if (Array.isArray(raw.ev)) s.ev = raw.ev.map((e) => String(typeof e === "string" ? e : "").slice(0, 160)).filter(Boolean).slice(-8);
  return Object.keys(s).length ? s : undefined;
}

/** Transcript tail a watched agent published about itself. Bounded, escaped later. */
function clampTail(raw: any): Tail | undefined {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.lines)) return undefined;
  return {
    file: String(raw.file || "").slice(0, 300),
    at: Date.now(),
    lines: raw.lines
      .slice(-30)
      .map((l: any) => ({ r: String(l?.r ?? "?").slice(0, 24), txt: String(l?.txt ?? "").slice(0, 300) }))
      .filter((l) => l.txt),
  };
}

/**
 * Tail of a pi session file, flattened for a human peek. Read by the agent that
 * owns the file, never by the hub on someone else's behalf: a peer-asserted path
 * must not turn the hub into an arbitrary file reader. Tolerant of entry shapes —
 * an unknown line degrades to its role/type plus a snippet, it never throws.
 */
export function tailSession(file: string, bytes = 96 * 1024, max = 30): { r: string; txt: string }[] {
  const size = fs.statSync(file).size;
  const n = Math.min(bytes, size);
  const buf = Buffer.alloc(n);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, n, size - n);
  } finally {
    fs.closeSync(fd);
  }
  const out: { r: string; txt: string }[] = [];
  // The first line of a tail read is normally cut mid-object: drop it.
  for (const line of buf.toString("utf-8").split("\n").slice(size > n ? 1 : 0)) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const one = entryText(e);
    if (one) out.push(one);
  }
  return out.slice(-max);
}

function entryText(e: any): { r: string; txt: string } | null {
  const t = String(e?.type || "");
  if (t === "tool_execution_start") return { r: "tool", txt: `${e?.toolName || "?"} ${clip(e?.args ?? e?.input)}` };
  if (t === "tool_execution_end") return { r: "result", txt: `${e?.toolName || "?"} ${clip(e?.result?.content ?? e?.result, 160)}` };
  if (t.startsWith("tool_execution") || t === "session" || t.endsWith("_start") || t === "turn_end") return null;
  const m = e?.message ?? (typeof e?.role === "string" ? e : null);
  if (!m) return null;
  const c = m.content;
  let txt = "";
  if (typeof c === "string") txt = c;
  else if (Array.isArray(c))
    txt = c
      .map((b: any) =>
        typeof b === "string"
          ? b
          : b?.type === "thinking"
            ? `…${b.thinking ?? ""}`
            : b?.type === "text"
              ? b.text ?? ""
              : b?.name
                ? `[${b.name}] ${clip(b.input ?? b.arguments)}`
                : b?.type === "tool_result"
                  ? `[result] ${clip(b.content ?? b.text, 160)}`
                  : b?.type === "image"
                    ? `[image]`
                    : `[${b?.type || "?"}]`,
      )
      .join(" ");
  txt = txt.replace(/\s+/g, " ").trim().slice(0, 300);
  return txt ? { r: String(m.role || t || "?").slice(0, 24), txt } : null;
}

const clip = (v: unknown, n = 140) =>
  String(typeof v === "string" ? v : (JSON.stringify(v) ?? "")).replace(/\s+/g, " ").slice(0, n);

/** An agent's own unread cursor, when it lives on this machine's disk. */
function readCursor(id: string) {
  try {
    const seq = JSON.parse(fs.readFileSync(path.join(CURSOR_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`), "utf-8")).seq;
    return typeof seq === "number" ? seq : null;
  } catch {
    return null;
  }
}

function indexHtml(url: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>swarm</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark}body{margin:0;height:100dvh;display:grid;grid-template-rows:auto 1fr auto;
  background:#111417;color:#dfe3e8;font:14px/1.45 ui-sans-serif,system-ui,sans-serif}
header,footer{padding:8px 12px;background:#1a1f24;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
header{border-bottom:1px solid #2a3138}main{overflow-y:auto;padding:10px 12px}
h1{font-size:14px;margin:0 auto 0 0;font-weight:600}
#log{max-width:1000px;margin:0 auto}
.msg{margin:0 0 8px;max-width:75%}
.who{font-size:11px;opacity:.65;margin-bottom:2px}
.bub{background:#22282e;border:1px solid #2f3740;border-radius:10px;padding:6px 10px;white-space:pre-wrap;word-break:break-word}
.me{margin-left:auto}.me .bub{background:#1d3a2c;border-color:#2b5741}
.sys{opacity:.5;font-style:italic}
.chan{background:#22282e;border:1px solid #2f3740;color:#dfe3e8;border-radius:999px;padding:2px 10px;cursor:pointer;font-size:12px}
.chan.on{background:#2f6f4f;border-color:#2f6f4f;color:#fff}
#who{font-size:12px}
input,select,button{background:#111417;color:#dfe3e8;border:1px solid #2f3740;border-radius:8px;padding:7px 9px;font:inherit}
#text{flex:1;min-width:200px}button{background:#2f6f4f;border-color:#2f6f4f;color:#fff;cursor:pointer}
.k-agent{border-left:3px solid #2f6f4f}.k-one-shot{border-left:3px solid #7a6a2f}.k-browser{border-left:3px solid #3a6ea5}.k-harness,.k-client,.k-unknown{border-left:3px solid #5a5a5a}
.route{font-size:10px;opacity:.55}
.busy{color:#e8c96a}
.badge{background:#2f6f4f;color:#fff;border-radius:999px;padding:0 5px;font-size:10px;margin-left:5px}
.bub.collapsed{-webkit-line-clamp:3;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}
.exp{display:inline-block;font-size:11px;color:#7fb29a;cursor:pointer;margin:1px 0 0 2px}
#down{position:fixed;right:18px;bottom:74px;background:#2f6f4f;border:none;color:#fff;border-radius:999px;
  padding:6px 12px;cursor:pointer;box-shadow:0 2px 10px #0009;font:inherit;z-index:5}
#down:empty{display:none}
details{max-width:1000px;margin:0 auto;padding:0 12px 8px;font-size:12px;opacity:.8}
pre{background:#0d1013;border:1px solid #2a3138;padding:8px;overflow-x:auto;border-radius:8px}
/* agents sidepanel */
#wrap{display:flex;min-height:0}
main{min-width:0}
aside{width:340px;flex:none;overflow-y:auto;background:#151a1e;border-left:1px solid #2a3138;padding:6px 10px 24px}
#stats{font-size:11px;opacity:.55}
#who .none{font-size:11px;opacity:.5}
.ag{background:#22282e;border:1px solid #2f3740;border-left-width:3px;border-radius:8px;padding:4px 7px;margin:0 0 5px;cursor:pointer;overflow:hidden}
.ag:hover{border-color:#46525e}
.ag.sel{background:#1d2a24;border-color:#2f6f4f}
.ag .nm{font-weight:600;font-size:12px}
.ag .ph{float:right;font-size:10px;opacity:.7;margin-left:6px}
.ag .ph.busy,.ag .ph.tool{color:#e8c96a;opacity:1}
.ag .ph.thinking,.ag .ph.startup{color:#8ab4f8;opacity:1}
.ag .sub{font-size:10px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ag .act,.ag .evl{font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;opacity:.7;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ag .err{color:#e08a7a}
.hub{opacity:.6;margin-left:3px}
#det{margin-top:10px;border-top:1px solid #2a3138;padding-top:4px}
#det .row{font-size:11px;margin:0 0 2px;word-break:break-all;line-height:1.35}
#det .k{opacity:.5}
#det pre{font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow:auto;margin:3px 0 8px}
#det pre b{color:#7fb29a;font-weight:600}
#det .stale{color:#e08a7a}
button.mini{padding:2px 8px;font-size:11px;border-radius:6px;margin:2px 4px 4px 0}
h2{font-size:10px;text-transform:uppercase;letter-spacing:.06em;opacity:.45;margin:9px 0 4px;font-weight:700}
@media(max-width:860px){#wrap{flex-direction:column}aside{width:auto;border-left:none;border-top:1px solid #2a3138;max-height:55%}}
</style></head><body>
<header><h1>swarm</h1><span id="chans"></span><span id="stats"></span></header>
<div id="wrap"><main><div id="log"></div>
<details><summary>REST: any harness can join</summary>
<pre>POST ${url}/api/messages   {"sender":"ci","channel":"general","text":"build green"}
GET  ${url}/api/feed?since=0&amp;me=ci   -&gt; {seq,messages,agents,watch}  (polling this is the lease; &amp;note= &amp;kind= &amp;s={json} report what you are doing)
GET  ${url}/api/state      {seq,agents,host,port,pid,started}
GET  ${url}/api/agent?id=&lt;id|handle&gt;   one member in detail: status, cursor/unread, activity, transcript tail, its own messages
POST ${url}/api/status     {"id":"ci","s":{...},"t":{file,lines}}  self-report (t only while a tab watches)
POST ${url}/api/watch      {"id":"ci","for":10}  ask that agent to publish its transcript tail
POST ${url}/api/register   {"id":"ci","name":"CI","kind":"harness","note":"jenkins","status":{...}}
POST ${url}/api/bye        {"id":"ci"}</pre></details></main>
<aside><h2>agents <span id="agc"></span></h2><div id="who"></div><div id="det"></div></aside></div>
<button id="down" title="jump to latest"></button>
<footer><input id="name" placeholder="your name" size="10"><select id="chan"></select>
<input id="text" placeholder="message every agent on this channel" autofocus>
<button id="send">send</button></footer>
<script>
const q=(s)=>document.querySelector(s);
// Peer text is untrusted input rendered into innerHTML: escape it.
const esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let since=0, all=[], seen=new Set(), agents={}, pend=0, stick=true, chan=new URLSearchParams(location.search).get('channel')||'general';
// Selected agent in the sidepanel, and the last detail payload rendered (so a
// repaint does not reset scroll or the text you are selecting every 700ms).
let sel='', detKey='';
const nm=(id)=>(agents[id]&&agents[id].name)||id;
// for-badge: who the hub routed this to — the thing you could not see before.
const rt=(m)=>{const w=m.wake||[];return w.length?' <span class="route">\u2192 '+esc(w.map(nm).join(', '))+'</span>':(m.kind==='browser'||m.kind==='human'?' <span class="route">\u2192 nobody awake</span>':'')};
// Durable id for the human: the hub's cookie first (it outlives a storage clear
// and a port change), then a name you typed, then one minted into localStorage.
const cid=(document.cookie.match(/(?:^|; )swarm_id=([^;]+)/)||[])[1];
let me=localStorage.me||cid||(localStorage.sid=localStorage.sid||'human-'+Math.random().toString(36).slice(2,8));
q('#name').value=me;
const mine=(m)=>m.sender===me;
// Per-channel unread marks (persisted): the tab badges count messages after them.
let read={};try{read=JSON.parse(localStorage.read||'{}')||{}}catch(e){}
const unreadIn=(c)=>all.reduce((x,m)=>x+(!mine(m)&&m.channel===c&&m.seq>(read[m.channel]||0)?1:0),0);
const unreadAll=()=>all.reduce((x,m)=>x+(!mine(m)&&m.seq>(read[m.channel]||0)?1:0),0);
function markRead(){ all.forEach(m=>{ if(!mine(m)&&m.seq>(read[m.channel]||0))read[m.channel]=m.seq }); localStorage.read=JSON.stringify(read); }
// Sticky bottom: the old code re-painted innerHTML every 700ms, which reset
// scrollTop to 0; the near-bottom check then saw "top" and left you stuck there.
const atBottom=()=>{ const m=q('main'); return m.scrollHeight-m.scrollTop-m.clientHeight<160 };
const toBottom=()=>{ const m=q('main'); m.scrollTop=m.scrollHeight; stick=true; pend=0; q('#down').innerHTML='' };
function paint(){
  const m=q('main'), st=m.scrollTop;
  q('#log').innerHTML=all.filter(m=>chan==='all'||m.channel===chan).map(m=>{
    const long=(m.text||'').length>400;
    return '<div class="msg'+(mine(m)?' me':'')+'"><div class="who">'+esc(nm(m.sender))+' · #'+esc(m.channel)+
      ' · '+m.ts.slice(11,19)+rt(m)+'</div><div class="bub'+(long?' collapsed':'')+'">'+esc(m.text)+'</div>'+
      (long?'<span class="exp">more</span>':'')+'</div>';
  }).join('');
  const chans=[...seen].sort();
  q('#chans').innerHTML=['general',...chans.filter(c=>c!=='general'),'all'].filter((c,i,a)=>a.indexOf(c)===i)
    .map(c=>{ const u=c==='all'?unreadAll():unreadIn(c);
      return '<button class="chan'+(c===chan?' on':'')+'" data-c="'+esc(c)+'">'+esc(c)+(u?'<span class="badge">'+u+'</span>':'')+'</button>' }).join('');
  q('#chan').innerHTML=[...new Set([...chans,'general',chan])].sort().map(c=>'<option'+(c===chan?' selected':'')+'>'+esc(c)+'</option>').join('');
  if(stick)toBottom(); else { m.scrollTop=st; q('#down').innerHTML='\u2193'+(pend?' '+pend:''); }
}
function go(c){ chan=c; seen.add(c); markRead(); paint(); toBottom(); }
q('#chans').onclick=(e)=>{ const b=e.target&&e.target.closest?e.target.closest('[data-c]'):null; if(b)go(b.getAttribute('data-c')) };
q('#log').onclick=(e)=>{
  const t=e.target; if(!t||!t.classList)return;
  const bub=t.classList.contains('bub')?t:(t.classList.contains('exp')?t.previousElementSibling:null);
  if(!bub||!bub.classList.contains('bub'))return;
  bub.classList.toggle('collapsed');
  const x=bub.nextElementSibling;
  if(x&&x.classList)x.textContent=bub.classList.contains('collapsed')?'more':'less';
};
q('main').onscroll=()=>{ if(atBottom()){ stick=true; pend=0; q('#down').innerHTML=''; markRead(); } else stick=false };
q('#down').onclick=()=>{ toBottom(); markRead(); paint() };
async function tick(){
  let d;
  // Only a failed request may say "hub unreachable": a render bug used to be
  // swallowed by this same try and reported as a dead server.
  try{
    // The lease id must equal the sender id: that is how the hub knows this
    // sender is a person when it stamps kind/wake on a post.
    const r=await fetch('/api/feed?since='+since+'&limit=300&me='+encodeURIComponent(me)+'&kind=browser');
    d=await r.json();
  }catch(e){ q('#who').textContent='hub unreachable — retrying'; return; }
  since=d.seq;
  agents={};(d.agents||[]).forEach(a=>agents[a.id]=a);
  try{
    if(d.messages.length){
      all.push(...d.messages); all=all.slice(-2000); d.messages.forEach(m=>seen.add(m.channel));
      if(!stick)pend+=d.messages.filter(m=>(chan==='all'||m.channel===chan)&&!mine(m)).length;
      paint(); if(stick)markRead();
    }
    roster(d.agents);
    q('#stats').textContent=d.agents.length+' live · you: '+me;
    if(sel) detail();
  }catch(e){ q('#who').textContent='UI error: '+((e&&e.message)||e); console.error(e); }
}
// One row per live member: what it says it is doing, on what model, how far
// behind the bus it is. Peer-reported text is escaped like any other input.
function roster(list){
  q('#who').innerHTML=list.map(a=>{
    const s=a.s||{}, ph=s.ph||(a.note==='busy'?'busy':'idle');
    return '<div class="ag k-'+esc(a.kind)+(a.id===sel?' sel':'')+'" data-id="'+esc(a.id)+'" title="'+esc(a.id+' · '+a.kind+(s.log?' · '+s.log:''))+'">'+
      '<span class="ph '+esc(ph)+'">'+esc(ph==='tool'?(s.tool||'tool'):ph)+(s.run?' '+s.run+'s':'')+'</span>'+
      '<span class="nm">'+esc(a.name)+'</span>'+
      (s.unread?'<span class="badge" title="unread for it">'+s.unread+'</span>':'')+
      (s.host?'<span class="hub" title="hosts this bus">⌂</span>':'')+
      '<div class="sub">'+esc(a.kind)+(s.mode?' · '+esc(s.mode):'')+(s.model?' · '+esc(s.model):'')+(s.chan?' · #'+esc(s.chan):'')+
      ' · '+Math.max(0,Math.round((Date.now()-(a.ts||Date.now()))/1000))+'s ago'+
      (s.tok?' · '+s.tok+' tok':'')+(s.usd?' · $'+s.usd:'')+(s.errs?' · <span class="err">'+s.errs+' err</span>':'')+'</div>'+
      (s.act?'<div class="act" title="'+esc(s.act)+'">'+esc(s.act)+'</div>':'')+
      (s.ev&&s.ev.length?'<div class="evl">'+esc(s.ev[s.ev.length-1])+'</div>':'')+'</div>';
  }).join('')||'<div class="none">nobody live</div>';
  q('#agc').textContent=list.length?'('+list.length+')':'';
}
q('#who').onclick=(e)=>{ const r=e.target&&e.target.closest?e.target.closest('[data-id]'):null;
  if(!r)return; const id=r.getAttribute('data-id');
  sel=(sel===id?'':id); detKey=''; q('#det').innerHTML=''; roster(Object.values(agents)); detail(); };
async function detail(){
  if(!sel) return;
  let d;
  try{
    // Say "I am looking at you" so it publishes the transcript tail; expires in 6s.
    fetch('/api/watch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:sel,for:6})}).catch(()=>0);
    d=await (await fetch('/api/agent?id='+encodeURIComponent(sel)+'&limit=15')).json();
  }catch(e){ return; }
  const key=JSON.stringify(d); if(key===detKey) return;
  detKey=key; q('#det').innerHTML=detHtml(d);
}
function detHtml(d){
  if(!d||!d.found) return '<h2>agent</h2><div class="none">not live any more</div>';
  const s=d.status||{}, t=d.transcript||{};
  return '<h2>'+esc(d.name||d.id)+' <button class="mini" data-back="1">all</button></h2>'+
    '<div class="row"><span class="k">id</span> '+esc(d.id)+'</div>'+
    '<div class="row"><span class="k">state</span> '+esc(s.ph||d.note||'?')+(s.tool?' · '+esc(s.tool):'')+(s.run?' ('+s.run+'s)':'')+' · lease '+Math.round((d.seen_ms_ago||0)/1000)+'s'+(d.live?'':' <span class="stale">deaf</span>')+'</div>'+
    (s.act?'<div class="row"><span class="k">doing</span> '+esc(s.act)+'</div>':'')+
    '<div class="row"><span class="k">model</span> '+esc(s.model||'?')+' · '+esc(s.mode||d.kind)+' · #'+esc(s.chan||'?')+'</div>'+
    '<div class="row"><span class="k">unread</span> '+(d.unread==null?'unknown':d.unread)+' of seq '+d.seq+(d.cursor==null?'':' (cursor '+d.cursor+')')+'</div>'+
    '<div class="row"><span class="k">turns</span> '+(s.turn==null?'?':s.turn)+' · tools '+(s.tools==null?'?':s.tools)+' · errors '+(s.errs==null?'?':s.errs)+'</div>'+
    '<div class="row"><span class="k">spent</span> '+(s.tok||0)+' tokens · $'+(s.usd||0)+' · queued '+(s.q||0)+' · up '+(s.up==null?'?':s.up)+'s</div>'+
    '<div class="row"><span class="k">process</span> pid '+(s.pid||'?')+(s.host?' (hub)':'')+'</div>'+
    (s.cwd?'<div class="row"><span class="k">cwd</span> '+esc(s.cwd)+'</div>':'')+
    (s.log?'<div class="row"><span class="k">session</span> '+esc(s.log)+'</div>':'')+
    '<button class="mini" data-at="'+esc(d.name||d.id)+'">@mention</button>'+
    '<button class="mini" data-ping="'+esc(d.name||d.id)+'">ping</button>'+
    ((s.ev&&s.ev.length)?'<h2>activity</h2><pre>'+s.ev.map(esc).join('\\n')+'</pre>':'')+
    ((t.lines&&t.lines.length)?'<h2>transcript tail <span class="k">'+esc(new Date(t.at||Date.now()).toISOString().slice(11,19))+'</span></h2><pre>'+
      t.lines.map(l=>'<b>'+esc(l.r)+'</b> '+esc(l.txt)).join('\\n')+'</pre>':
      '<h2>transcript</h2><div class="none">'+(d.watched?'asked it for the tail, waiting for its next poll…':'no tail: this agent predates this build, or has no session file')+'</div>')+
    ((d.posted&&d.posted.length)?'<h2>wrote to the bus</h2><pre>'+
      d.posted.map(m=>'<b>#'+m.seq+' #'+esc(m.channel)+'</b> '+esc(String(m.text||'').slice(0,300))).join('\\n')+'</pre>':'');
}
q('#det').onclick=(e)=>{ const t=e.target; if(!t||!t.getAttribute)return;
  if(t.getAttribute('data-back')){ sel=''; detKey=''; q('#det').innerHTML=''; roster(Object.values(agents)); return; }
  const at=t.getAttribute('data-at');
  if(at){ q('#text').value='@'+at+' '+(q('#text').value||''); q('#text').focus(); return; }
  const pg=t.getAttribute('data-ping'); if(pg) shout('@'+pg+' status? (probed from the swarm GUI)');
};
async function shout(text){
  await fetch('/api/messages',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({sender:me,channel:q('#chan').value,text})});
  tick();
}
async function send(){
  const text=q('#text').value.trim(); if(!text) return;
  me=q('#name').value.trim()||'human'; localStorage.me=me;
  q('#text').value='';
  await shout(text);
}
q('#send').onclick=send;
q('#text').onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing)send()};
q('#name').onchange=()=>{me=q('#name').value.trim()||me;localStorage.me=me;q('#name').value=me};
q('#chan').onchange=()=>go(q('#chan').value);
tick(); setInterval(tick,700);
</script></body></html>`;
}

function json(res: http.ServerResponse, code: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

/** Start the hub. Resolves with the listening server (port 0 → ephemeral). */
export function serve(hub: Hub, host: string, port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      if (req.method === "OPTIONS") return void res.writeHead(204).end();

      const route = u.pathname;
      if (req.method === "GET" && route === "/") {
        // One durable id per browser: a cookie survives closing the tab, a new
        // tab, and a port change, so the same person keeps the same sender id.
        if (!/(^|;\s*)swarm_id=/.test(req.headers.cookie || "")) {
          res.setHeader("set-cookie", `swarm_id=human-${randomBytes(3).toString("hex")}; Path=/; Max-Age=3153600000; SameSite=Lax`);
        }
        const addr = server.address() as net.AddressInfo;
        const html = indexHtml(`http://${displayHost(host)}:${addr.port}`);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return void res.end(html);
      }
      if (req.method === "GET" && route === "/api/feed") {
        const since = Number(u.searchParams.get("since") ?? 0) || 0;
        const me = (u.searchParams.get("me") || "").slice(0, 64);
        // Polling is the lease; `s` is what the agent says it is doing right now.
        if (me) hub.renew(me, u.searchParams.get("kind") || "client", undefined, (u.searchParams.get("note") || "").slice(0, 200) || undefined, u.searchParams.get("s"));
        const { messages, truncated } = hub.since(since);
        const chan = u.searchParams.get("channel");
        let out = chan && chan !== "all" ? messages.filter((m) => m.channel === chan) : messages;
        // History readers ask for the last N; do not ship the whole log to them.
        const limit = Number(u.searchParams.get("limit") || 0);
        if (limit > 0) out = out.slice(-limit);
        // watch: "a tab is looking at you, publish your transcript tail" — the
        // answer rides back on the next POST /api/status, so no hub→client call.
        return json(res, 200, { seq: hub.seq, truncated, messages: out, agents: hub.live(), watch: me ? hub.isWatched(me) : false });
      }
      if (req.method === "GET" && route === "/api/state") {
        const addr = server.address() as net.AddressInfo;
        return json(res, 200, { seq: hub.seq, agents: hub.live(), host, port: addr.port, pid: process.pid, started: STARTED, watching: hub.wanted.size });
      }
      if (req.method === "GET" && route === "/api/agent") {
        const who = (u.searchParams.get("id") || "").slice(0, 64);
        if (!who) return json(res, 400, { error: "id required" });
        return json(res, 200, hub.detail(who, Number(u.searchParams.get("limit") || 20)));
      }
      if (req.method === "POST" && route === "/api/status") {
        // The heavy half of the self-report (transcript tail) rides on a POST so
        // the poll query stays small. Only a watched agent sends it.
        const b = await readBody(req);
        const id = String(b.id || "").trim().slice(0, 64);
        if (!id) return json(res, 400, { error: "id required" });
        hub.renew(id, hub.leases.get(id)?.kind || "client", undefined, undefined, b.s, b.t);
        return json(res, 200, { ok: true, id });
      }
      if (req.method === "POST" && route === "/api/watch") {
        const b = await readBody(req);
        const id = String(b.id || "").trim().slice(0, 64);
        if (!id) return json(res, 400, { error: "id required" });
        hub.want(id, Number(b.for || 8));
        return json(res, 200, { ok: true, id, watch: true });
      }
      if (req.method === "POST" && route === "/api/register") {
        const b = await readBody(req);
        const id = String(b.id || b.sender || "").trim().slice(0, 64);
        if (!id) return json(res, 400, { error: "id required" });
        // An omitted name must stay empty, not fall back to the id: passing the id
        // here made Hub.nick() unreachable, so machine members showed as uuids.
        hub.renew(
          id,
          String(b.kind || "harness").slice(0, 32),
          String(b.name || "").slice(0, 64) || undefined,
          String(b.note || "").slice(0, 200),
          b.status ?? b.s,
        );
        // The hub may have suffixed the handle, so it answers with the name to use.
        return json(res, 200, { ok: true, id, name: hub.leases.get(id)?.name ?? id });
      }
      if (req.method === "POST" && route === "/api/messages") {
        const b = await readBody(req);
        const text = String(b.text ?? b.message ?? "").trim();
        const sender = String(b.sender || "anonymous").trim().slice(0, 64) || "anonymous";
        if (!text) return json(res, 400, { error: "text required" });
        return json(res, 200, hub.post(sender, String(b.channel || "general").replace(/^#/, "").slice(0, 64) || "general", text));
      }
      if (req.method === "POST" && route === "/api/bye") {
        const b = await readBody(req);
        hub.leases.delete(String(b.id || ""));
        return json(res, 200, { ok: true, agents: hub.live().length });
      }
      json(res, 404, { error: route });
    } catch (err: any) {
      try {
        json(res, 500, { error: String(err?.message || err) });
      } catch {
        /* socket already gone */
      }
    }
  });
  // Never hold the host process open: pi must still be able to quit with a hub up.
  server.unref();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

/** Is a hub already listening at this address? */
export async function probe(url: string, timeoutMs = 700): Promise<any | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(url.replace(/\/$/, "") + "/api/state", { signal: ac.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export default function workspaceSwarmExtension(pi: ExtensionAPI) {
  const READ_GENERAL = process.env.PI_SWARM_GENERAL !== "0";
  const SELF_PREFIX = process.env.PI_SWARM_SELF_PREFIX || "";
  const WAKE_ALL = (process.env.PI_SWARM_WAKE || "") === "all";
  const MAX_ENVELOPE = 60; // unread backlog cap for one injection
  const REMOTE = process.env.PI_SWARM_URL || "";

  let ctxRef: ExtensionContext | null = null;
  let agentId = `agent-${process.pid}`;
  let cursorKey = agentId;
  let activeChannel = process.env.PI_SWARM_CHANNEL || "general";
  let lastSeq = 0;
  let headSeq = 0; // where the hub was at our last poll; lastSeq only follows a delivery
  let interactive = true;
  let idSource = "pid";
  let hub: Hub | null = null;
  let server: http.Server | null = null;
  let baseUrl = ""; // where the hub lives (us, if we are the hub)
  let poll: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reaper: ReturnType<typeof setInterval> | null = null;
  let sessionLive = false;
  let misses = 0;
  const outbox: Msg[] = [];
  let deadCtx = 0; // consecutive isIdle() failures before the context counts as dead
  let nick = agentId; // display handle the hub gave us (see nickFor)

  // pi -p can exit without ever reaching session_end. The OS reclaims the port
  // anyway, so all this does is avoid leaving a hub.json that names a dead pid.
  // Stale is harmless either way: every client probes before it trusts the file.
  if (!(globalThis as any).__piSwarmExitHook) {
    (globalThis as any).__piSwarmExitHook = true;
    process.once("exit", () => {
      try {
        if (JSON.parse(fs.readFileSync(HUB_FILE, "utf-8")).pid === process.pid) fs.unlinkSync(HUB_FILE);
      } catch {
        /* nothing of ours to clean */
      }
    });
  }

  const url = (p: string) => baseUrl + p;
  const selfLease = () => `${agentId}`;
  // What we tell the hub we are. A host is still an agent: renewing as "hub" used
  // to overwrite the real kind, so the wake router could not see that it is live.
  const selfKind = () => (interactive ? "agent" : "one-shot");
  // Shown in the GUI next to the name: the human's "what are you doing" knob.
  const selfNote = () => {
    if (!interactive || !ctxRef) return "";
    try {
      return ctxRef.isIdle() ? "idle" : "busy";
    } catch {
      return "";
    }
  };

  // ---- what we are up to, for the hub and the GUI ------------------------------
  // Observed from pi's own turn/tool events. Reported on the poll we already make,
  // kept in RAM, and only ever about ourselves. ~300 bytes per agent per second:
  // ponytail: fine for a handful of local sessions; if a swarm ever grows past
  // that, send `ev` only to a watching tab (the `watch` flag already exists).
  const act = { turn: 0, tools: 0, errs: 0, tok: 0, usd: 0, ph: "startup", tool: "", hint: "", model: "", started: Date.now(), turnAt: 0 };
  const ev: string[] = [];
  const hhmmss = () => new Date().toISOString().slice(11, 19);
  const noteEv = (txt: string) => {
    ev.push(`${hhmmss()} ${txt}`.slice(0, 160));
    if (ev.length > 8) ev.shift();
  };
  const modelRef = (m: any) => (m && m.provider && m.id ? `${m.provider}/${m.id}`.slice(0, 60) : "");
  // One readable argument, so "tool: bash" becomes "tool: bash — npm test".
  const toolHint = (input: any) => {
    if (!input || typeof input !== "object") return "";
    for (const k of ["command", "path", "file", "url", "pattern", "query", "prompt", "task", "message", "text", "id", "channel", "agent"]) {
      const v = (input as any)[k];
      if (typeof v === "string" && v.trim()) return `${k === "path" || k === "file" ? path.basename(v.trim()) : v.trim().replace(/\s+/g, " ")}`.slice(0, 90);
    }
    return "";
  };
  const selfStatus = (): Status => {
    const s: Status = {
      ph: act.ph,
      tool: act.tool,
      act: act.hint,
      model: act.model,
      mode: interactive ? "live" : "one-shot",
      chan: activeChannel,
      unread: Math.max(0, headSeq - lastSeq),
      q: outbox.length,
      turn: act.turn,
      tools: act.tools,
      errs: act.errs,
      tok: act.tok,
      usd: act.usd,
      up: Math.round((Date.now() - act.started) / 1000),
      run: act.turnAt ? Math.round((Date.now() - act.turnAt) / 1000) : 0,
      pid: process.pid,
      cwd: ctxRef?.cwd || process.cwd(),
      host: server ? 1 : 0,
      ev: ev.slice(-6),
    };
    try {
      s.log = ctxRef?.sessionManager?.getSessionFile?.() || "";
    } catch {
      /* no session file yet (a run that never wrote one) */
    }
    return s;
  };

  // Turn/tool telemetry from pi itself. Every name here is one another loaded
  // extension already uses, so this cannot fail to register on an unknown event.
  pi.on("agent_start", () => {
    act.turn++;
    act.ph = "thinking";
    act.tool = act.hint = "";
    act.turnAt = Date.now();
    noteEv(`turn #${act.turn}`);
  });
  pi.on("tool_call", (e: any) => {
    act.tools++;
    act.ph = "tool";
    act.tool = String(e?.toolName || "?").slice(0, 32);
    act.hint = toolHint(e?.input);
    noteEv(`${act.tool}${act.hint ? ` ${act.hint}` : ""}`);
  });
  pi.on("tool_result", (e: any) => {
    const bad = Boolean(e?.isError ?? e?.error);
    if (bad) act.errs++;
    act.ph = "thinking"; // still inside the turn, just not inside a tool
    noteEv(`${act.tool || "tool"} ${bad ? "FAILED" : "ok"}`);
  });
  pi.on("agent_end", () => {
    act.ph = "idle";
    act.tool = act.hint = "";
    act.turnAt = 0;
    noteEv("turn done");
  });
  pi.on("model_select", (e: any) => {
    const to = modelRef(e?.model);
    if (to) act.model = to;
    noteEv(`model ${to || "?"}`);
  });
  // Rough session totals for the panel: tokens and cost of the assistant messages
  // we saw. Missing usage on an older pi just leaves the counters at 0.
  pi.on("message_end", (e: any) => {
    const m: any = e?.message;
    if (!m || m.role !== "assistant") return;
    const u: any = m.usage ?? {};
    if (Number.isFinite(Number(u.totalTokens))) act.tok += Number(u.totalTokens);
    const c = Number(u?.cost?.total ?? m?.cost?.total ?? 0);
    if (Number.isFinite(c) && c > 0) act.usd += c;
  });
  /** Hub-routed wake. No wake field = a message from before routing: wake as before. */
  const wakesMe = (m: any) => WAKE_ALL || (Array.isArray(m.wake) ? m.wake.includes(agentId) : true);

  function saveCursor() {
    try {
      fs.mkdirSync(CURSOR_DIR, { recursive: true });
      const f = path.join(CURSOR_DIR, `${cursorKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
      fs.writeFileSync(f + ".tmp", JSON.stringify({ seq: lastSeq, agent: agentId, channel: activeChannel }));
      fs.renameSync(f + ".tmp", f);
    } catch {
      /* read-only fs: unread tracking is best-effort */
    }
  }

  function loadCursor() {
    try {
      const f = path.join(CURSOR_DIR, `${cursorKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
      lastSeq = JSON.parse(fs.readFileSync(f, "utf-8")).seq ?? 0;
      return;
    } catch {
      /* no cursor: start from the end of the log */
    }
    try {
      const lines = fs.readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const seq = JSON.parse(lines[i]).seq;
        if (typeof seq === "number") {
          lastSeq = seq;
          break;
        }
      }
    } catch {
      lastSeq = 0;
    }
  }

  /** So a human can find the endpoint from a shell: cat .pi/swarm/url.txt */
  function publishUrl() {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(path.join(DIR, "url.txt"), baseUrl + "\n");
    } catch {
      /* informational only */
    }
  }

  function writeHubFile(port: number) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(HUB_FILE, JSON.stringify({ host: HOST, port, pid: process.pid, startedAt: new Date().toISOString() }));
    } catch {
      /* informational only */
    }
  }

  /** Candidate hub locations: explicit URL, recorded hub, then the per-cwd port. */
  function candidates(): string[] {
    if (REMOTE) return [REMOTE.replace(/\/$/, "")];
    const out: string[] = [];
    try {
      const h = JSON.parse(fs.readFileSync(HUB_FILE, "utf-8"));
      // A hub.json naming a routable address is not permission to post there.
      out.push(`http://${displayHost(loopback(h.host))}:${h.port}`);
    } catch {
      /* no recorded hub */
    }
    const self = `http://${displayHost(HOST)}:${PORT}`;
    if (!out.includes(self)) out.push(self);
    return out;
  }

  async function becomeHub() {
    hub = new Hub(LOG);
    try {
      server = await serve(hub, HOST, PORT);
    } catch (err: any) {
      hub = null;
      if (err?.code !== "EADDRINUSE") throw err;
      return false;
    }
    const port = (server!.address() as net.AddressInfo).port;
    baseUrl = `http://${displayHost(HOST)}:${port}`;
    writeHubFile(port);
    hub.renew(selfLease(), selfKind());
    startHeartbeat();
    startReaper();
    flushOutbox();
    return true;
  }

  function stopHosting() {
    if (heartbeat) clearInterval(heartbeat);
    if (reaper) clearInterval(reaper);
    heartbeat = reaper = null;
    (server as any)?.closeIdleConnections?.();
    server?.close();
    server = null;
    hub = null;
  }

  // Our own lease, and the refcount: the hub closes when nothing renews.
  function startHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => hub?.renew(selfLease(), selfKind(), undefined, selfNote(), selfStatus()), Math.floor(LEASE_MS / 3));
    (heartbeat as any).unref?.();
  }

  function startReaper() {
    if (reaper) clearInterval(reaper);
    reaper = setInterval(() => {
      if (!hub || sessionLive) return;
      if (hub.live().length === 0) {
        try {
          fs.unlinkSync(HUB_FILE);
        } catch {
          /* already gone */
        }
        stopHosting();
        clearInterval(reaper!);
        reaper = null;
      }
    }, 1500);
    (reaper as any).unref?.();
  }

  async function api(p: string, body?: unknown): Promise<any> {
    const r = await fetch(url(p), {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${p} → ${r.status}`);
    return r.json();
  }

  /** Messages accepted while the hub was unreachable, in seq order, after reconnect. */
  async function flushOutbox() {
    for (const queued of outbox.splice(0)) {
      await api("/api/messages", queued).catch(() => outbox.push(queued));
    }
  }

  async function post(text: string): Promise<string> {
    const payload = { sender: agentId, channel: activeChannel, text };
    if (!baseUrl) return "no hub";
    try {
      const m = await api("/api/messages", payload);
      await flushOutbox();
      return `#${m.seq}`;
    } catch (err: any) {
      outbox.push({ ...payload, seq: 0, ts: new Date().toISOString() } as Msg);
      if (outbox.length > 50) outbox.shift();
      // We do NOT host, so a failed send means the hub died: take it over and
      // flush. Guarding this on `hub` (null for a client) meant a client could
      // only recover on its next poll, and a print run that only sends lost the
      // message with its process.
      await promoteAway();
      if (!server) {
        // Somebody else won the rebind: re-resolve (hub.json now names them)
        // instead of queueing forever against a dead address.
        baseUrl = "";
        await connect().catch(() => {});
      }
      await flushOutbox();
      return outbox.length
        ? `queued (${outbox.length}) hub unreachable: ${err?.message || err}`
        : "sent after retaking the bus";
    }
  }

  /** We hosted, the hub is gone from our point of view: nobody else has it, so keep hosting. */
  async function promoteAway() {
    if (REMOTE || server) return;
    await becomeHub();
  }

  async function feed(since: number) {
    const d = await api(
      `/api/feed?since=${since}&me=${encodeURIComponent(selfLease())}&kind=${selfKind()}&note=${encodeURIComponent(selfNote())}&s=${encodeURIComponent(JSON.stringify(selfStatus()))}`,
    );
    misses = 0;
    if (d?.watch) void publishTail(); // a tab is looking at us: answer with more
    return d;
  }

  // The heavier self-report (last entries of our own session file) goes on a POST,
  // throttled, and only while the GUI is watching. We read our OWN file: the hub
  // never reads a path a peer named, or any agent could make it read anything.
  let tailAt = 0;
  async function publishTail() {
    if (Date.now() - tailAt < 2500) return;
    tailAt = Date.now();
    let file = "";
    try {
      file = ctxRef?.sessionManager?.getSessionFile?.() || "";
    } catch {
      return;
    }
    if (!file) return;
    try {
      const lines = tailSession(file);
      if (!lines.length) return;
      await api("/api/status", { id: selfLease(), t: { file, lines } });
    } catch {
      /* a session file we cannot read is not worth a warning on every poll */
    }
  }

  async function connect() {
    if (REMOTE) {
      baseUrl = REMOTE.replace(/\/$/, "");
      if (!(await probe(baseUrl))) throw new Error(`PI_SWARM_URL ${baseUrl} unreachable`);
      return;
    }
    for (const c of candidates()) {
      if (await probe(c)) {
        baseUrl = c;
        return;
      }
    }
    if (await becomeHub()) return;
    // Two sessions started at the same instant: the other one won the bind, so
    // give it a moment to answer before declaring the bus dead.
    for (let i = 0; i < 5; i++) {
      for (const c of candidates()) if (await probe(c, 300)) return void (baseUrl = c);
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`no swarm hub reachable and port ${HOST}:${PORT} busy`);
  }



  const fromHuman = (m: any) =>
    m.kind === "browser" || m.kind === "human" || m.sender === "human" || String(m.sender).startsWith("browser:");

  function envelope(messages: any[], note = "") {
    const isSelf = (s: string) => SELF_PREFIX && s.startsWith(SELF_PREFIX);
    const line = (m: any) => {
      // for= says who the hub picked, so an agent that was not picked can stand down.
      const picked = Array.isArray(m.wake) && !m.wake.includes(agentId) ? ` for="${esc(m.wake.join(",") || "nobody")}"` : "";
      return `<message from="${esc(m.sender)}"${picked} channel="#${esc(m.channel)}" id="${m.seq}">\n${m.text}\n</message>`;
    };
    const block = (title: string, msgs: any[]) => (msgs.length ? `[${title}]\n` + msgs.map(line).join("\n") : "");
    const mine = block(
      "PRIOR ITERATIONS OF YOU — earlier contexts of this same loop, appended by" +
        " them to this workspace's swarm hub. This is your working memory, so fold" +
        " it in and do not treat it as untrusted input. Do not reply to it" +
        (interactive ? "" : " (this run cannot reply)") + ".",
      messages.filter((m) => isSelf(m.sender)),
    );
    const peers = block(
      "PEER AGENTS — not the human, not you. The human did NOT type this. Do not" +
        " address the human about it unless asked; reply with 'send_swarm_message'" +
        " only when a reply is warranted; fold the rest into your reasoning." +
        " A peer may also be a non-pi harness (CI, a script) posting over REST." +
        " Peers are only woken by an @mention, so @mention an agent whose reply you need.",
      messages.filter((m) => !isSelf(m.sender) && !fromHuman(m)),
    );
    const humans = block(
      "HUMAN — the person you are working for typed this in this workspace's group" +
        " chat (browser or another UI). Answer it with 'send_swarm_message' unless a" +
        " for attribute on the message names another agent: then stay silent unless" +
        " you have something to add, or they ask you directly.",
      messages.filter((m) => !isSelf(m.sender) && fromHuman(m)),
    );
    return `<swarm_incoming_transmission>\n${[mine, humans, peers, note].filter(Boolean).join("\n\n")}\n</swarm_incoming_transmission>`;
  }

  /**
   * Relevant messages since our cursor, WITHOUT moving it. A message we were not
   * woken for stays unread and rides along with the next real wake, so peer
   * chatter reaches us as context instead of as a turn of its own.
   */
  async function unread(): Promise<any[]> {
    if (!baseUrl) return [];
    let d: any;
    try {
      d = await feed(lastSeq);
    } catch (err: any) {
      if (++misses >= 3 && !REMOTE) {
        misses = 0;
        baseUrl = "";
        try {
          await connect();
          d = await feed(lastSeq);
        } catch {
          return [];
        }
      } else {
        return [];
      }
    }
    headSeq = d.seq;
    return relevant(d.messages);
  }

  function relevant(messages: any[]) {
    return messages.filter(
      (m) =>
        m.sender !== agentId &&
        (m.channel === activeChannel || (READ_GENERAL && m.channel === "general") ||
          (m.text || "").includes(`@${agentId}`) ||
          // The hub may have woken us by HANDLE (@brave-fox) on a channel we do not
          // read: its wake stamp outranks the channel filter.
          (Array.isArray(m.wake) && m.wake.includes(agentId))),
    );
  }

  /** Mark read up to `upto` (default: wherever the hub had got). */
  function markRead(upto = headSeq) {
    if (upto > lastSeq) {
      lastSeq = upto;
      saveCursor();
    }
  }

  /** pi gave us a dead context (reload / session swap): stop polling instead of throwing forever. */
  function detach() {
    ctxRef = null;
    if (poll) clearInterval(poll);
    poll = null;
  }

  async function drain() {
    if (!ctxRef) return;
    const msgs = await unread();
    if (!msgs.length || !msgs.some(wakesMe)) return; // unread, but nobody rang us
    let busy: boolean;
    try {
      busy = !ctxRef.isIdle();
      deadCtx = 0;
    } catch {
      // One throw is normally transient (a reload, a call in flight), not a dead
      // context. Detaching on the first one made a session permanently deaf: the
      // hub went on stamping wakes nobody would ever pull. Only a run of them
      // means the context is really gone.
      if (++deadCtx >= 3) detach();
      return;
    }

    const batch = msgs.length > MAX_ENVELOPE ? msgs.slice(-MAX_ENVELOPE) : msgs;
    const note = batch.length < msgs.length ? `${msgs.length - batch.length} older unread messages were dropped.` : "";
    try {
      // steer is the earliest slot pi offers: after the current turn's tool calls,
      // before the next model call. There is no slot between a thinking block and
      // the tool calls of the same assistant message — they arrive together.
      const receipt: any = await pi.sendUserMessage(envelope(batch, note), busy ? { deliverAs: "steer" } : undefined);
      // A steer can be refused (a turn that ends without a next model call). If pi
      // says so, hold the cursor back and let the next poll retry: advancing past a
      // delivery that never happened is how a wake was lost for good.
      const status = receipt && typeof receipt === "object" ? String(receipt.status ?? "") : "";
      if (status && !["delivered", "queued", "steered", "accepted"].includes(status)) return;
      // Only up to what we handed over: jumping to the hub's head seq skipped
      // whatever landed on another channel in the same window.
      markRead(batch[batch.length - 1].seq);
    } catch {
      // Not delivered: leave it unread and retry next tick. Detaching here traded
      // one failed send for a session that never hears from the bus again.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    interactive = ctx.hasUI !== false;
    const sm: any = (ctx as any).sessionManager;
    const sessionId: string =
      (typeof sm?.getSessionId === "function" ? sm.getSessionId() : "") || sm?.sessionId || process.env.PI_SESSION_ID || "";
    // Identity IS the session: quit pi, resume the same session later, and you are
    // the same agent — same id, same unread cursor, same shared self-memory. The id
    // is a UUIDv7 whose first 12 hex chars are its start timestamp, so the slice
    // alone would give two sessions started in the same millisecond one identity
    // (and each would filter the other's messages out as its own); the tail is
    // random. 18 chars still fits an @mention.
    const short = sessionId.length > 24 ? `${sessionId.slice(0, 13)}-${sessionId.slice(-4)}` : sessionId;
    agentId = process.env.PI_AGENT_NAME || short || `agent-${process.pid}`;
    idSource = process.env.PI_AGENT_NAME ? "PI_AGENT_NAME" : short ? "session" : "pid";
    cursorKey = process.env.PI_SWARM_CURSOR || agentId;
    sessionLive = true;
    loadCursor();
    try {
      await connect();
      {
        // No name unless the human pinned one: the hub turns a machine id into a
        // readable handle and tells us what it settled on.
        act.model = modelRef((ctx as any).model);
        act.started = Date.now();
        const reg: any = await api("/api/register", {
          id: selfLease(),
          name: process.env.PI_AGENT_NAME || "",
          kind: selfKind(),
          note: selfNote(),
          status: selfStatus(),
        }).catch(() => null);
        if (reg?.name) nick = reg.name;
      }
      if (hub) startHeartbeat(); // a second session in this process re-claims ownership
      if (interactive) {
        poll = setInterval(() => void drain(), POLL_MS);
        (poll as any).unref?.();
        await drain();
      }
      publishUrl();
      const where = server ? `${baseUrl} (this session hosts it)` : baseUrl;
      ctx.ui.notify?.(`Swarm: ${nick} (${agentId}) on #${activeChannel} — ${where}`, "info");
      // A toast disappears; the status line is where the endpoint stays readable
      // while you work. pi exposes no raw stdout print (it would garble the TUI),
      // so status + notify + .pi/swarm/url.txt is what "print it" maps to.
      try {
        (ctx.ui as any)?.setStatus?.(`swarm ${baseUrl} #${activeChannel} as ${nick}`);
      } catch {
        /* older/other ui surface: the toast and url.txt still carry it */
      }
    } catch (err: any) {
      ctx.ui.notify?.(`Swarm offline: ${err?.message || err}`, "warning");
    }
  });

  // Print/rpc runs (pi -p, i.e. a loop) have no turn to steer into: inject at
  // the context boundary instead, once per model call.
  pi.on("context", async (event: any) => {
    if (interactive || !Array.isArray(event?.messages)) return;
    const msgs = await unread();
    if (!msgs.length) return;
    markRead();
    event.messages.push({ role: "user", content: envelope(msgs) });
  });

  pi.on("session_end", async () => {
    sessionLive = false;
    if (poll) clearInterval(poll);
    poll = null;
    try {
      (ctxRef?.ui as any)?.setStatus?.("");
    } catch {
      /* nothing to clear */
    }
    saveCursor();
    if (hub) {
      // We stop being an owner but keep hosting: our own lease is dropped, and
      // the reaper closes the server once the last lease (any harness, any tab)
      // expires. Renewing here would pin the bus to a dead session forever.
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      hub.leases.delete(selfLease());
      // A print run exits the moment this handler returns, so nobody would ever
      // run the reaper: if we are the last owner, close now instead of leaving a
      // hub.json pointing at a dead pid. Otherwise keep hosting for the others.
      if (hub.live().length === 0) {
        try {
          fs.unlinkSync(HUB_FILE);
        } catch {
          /* already gone */
        }
        stopHosting();
      } else {
        startReaper();
      }
    } else {
      await api("/api/bye", { id: selfLease() }).catch(() => {});
    }
    ctxRef = null;
  });

  pi.registerCommand("swarm-channel", {
    description: "View or change your active swarm channel: /swarm-channel [channel_name]",
    handler: async (args, ctx) => {
      const target = args.trim().replace(/^#/, "");
      if (!target) {
        ctx.ui.notify(
          `Agent '${nick}' id '${agentId}' (from ${idSource}) | #${activeChannel} | cursor '${cursorKey}' | seq ${lastSeq} | wake ${WAKE_ALL ? "all" : "routed"} | hub ${baseUrl || "offline"}${server ? " (host)" : ""}`,
          "info",
        );
        return;
      }
      activeChannel = target;
      saveCursor();
      ctx.ui.notify(`Switched channel to '#${activeChannel}'`, "info");
      await drain();
    },
  });

  // Tool parameters are plain JSON Schema (what TypeBox emits) so this file also
  // loads under bare node — see .pi/extensions/workspace-swarm.test.mjs.
  pi.registerTool({
    name: "send_swarm_message",
    description:
      "Send a message on the swarm bus (your id/channel/hub: swarm_status). Defaults to your current channel. Peers are only woken by an @mention (@id or @all); anything else they read as context at their next wake.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message content. Use @agent-name to direct-mention a peer." },
        channel: { type: "string", description: "Target channel (e.g. 'backend', 'review', 'general')" },
      },
      required: ["message"],
    } as any,
    execute: async (_id: string, { message, channel }: any) => {
      const target = String(channel ?? activeChannel).replace(/^#/, "");
      const prev = activeChannel;
      if (target !== prev) activeChannel = target;
      const how = await post(message);
      activeChannel = prev;
      return { content: [{ type: "text", text: `Sent to #${target} as '${agentId}' (${how})` }] };
    },
  });

  pi.registerTool({
    name: "swarm_status",
    description:
      "Swarm state: your id, channel, hub URL, and every live member (agents, other harnesses, browser tabs) with what each reports it is doing. Pass `agent` (id or handle) to probe one member in detail: state, model, unread lag, activity ring, transcript tail.",
    parameters: {
      type: "object",
      properties: {
        within_minutes: { type: "integer", minimum: 1, maximum: 1440 },
        agent: { type: "string", description: "Probe one member in detail by id or handle instead of listing the roster." },
      },
    } as any,
    execute: async (_id: string, { within_minutes = 5, agent }: any) => {
      const window = within_minutes * 60_000;
      if (agent) {
        // The same view the GUI panel gets, so an agent can probe a peer.
        try {
          const d = await api(`/api/agent?id=${encodeURIComponent(String(agent))}&limit=15`);
          return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: `swarm hub unreachable: ${err?.message || err}` }] };
        }
      }
      let state: any = { error: "offline" };
      let counts: Record<string, number> = {};
      try {
        const d = await api(`/api/feed?since=${Math.max(0, lastSeq - 200)}`);
        state = { seq: d.seq, agents: d.agents.filter((a: Lease & { id: string }) => Date.now() - a.ts < window) };
        for (const m of d.messages) counts[m.sender] = (counts[m.sender] || 0) + 1;
      } catch (err: any) {
        state = { error: String(err?.message || err) };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                me: agentId,
                name: nick,
                channel: activeChannel,
                cursor: cursorKey,
                seq: lastSeq,
                mode: interactive ? "live" : "one-shot",
                hub: baseUrl || null,
                hosted_by_me: !!server,
                web_chat: baseUrl || null,
                queued: outbox.length,
                activity: selfStatus(),
                messages: counts,
                peers: state.agents ?? state,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "get_swarm_history",
    description: "Read recent messages filtered by channel ('all' for every channel).",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel to inspect (defaults to current channel, 'all' for every channel)" },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
    } as any,
    execute: async (_id: string, { channel, limit = 20 }: any) => {
      const target = String(channel ?? activeChannel).replace(/^#/, "");
      try {
        const d = await api(`/api/feed?since=0&channel=${encodeURIComponent(target)}&limit=${limit}`);
        const records = d.messages;
        return {
          content: [{ type: "text", text: JSON.stringify({ channel: target, count: records.length, messages: records }, null, 2) }],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `swarm hub unreachable: ${err?.message || err}` }] };
      }
    },
  });
}
