import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Constants & Guardrails ---
const EXTENSION_TOOLS = ["self_compact", "memory_store", "pin_rewrite"] as const;
const MAX_KV_ENTRIES = 25;
const MAX_KEY_LEN = 48;
const MAX_TITLE_LEN = 100;
const MAX_BODY_LEN = 1200;
const MAX_TOTAL_KV_CHARS = 16000;
const MAX_PINNED_TURNS = 4;
const MAX_ORIGIN_TURN_CHARS = 12000;
const MAX_PIN_CHARS = 12000;
const GRACE_TURNS_AT_100 = 5;
const RETAIN_NONE_SENTINEL = "__self_propagate_retain_none__";

// Static protocol text appended to every system prompt. MUST stay byte-identical
// across turns and compactions: pi sends a forced prompt as the leading system
// message on every request (a cache miss whenever it changes), so anything
// volatile here re-reads the whole prompt every turn. Volatile budget alerts
// are delivered as a `<self_propagate_budget>` custom message instead.
const PROTOCOL_STATIC =
  `\n\n## Self-Propagation & Context Protocol\n` +
  `- Persistent Working Memory: use \`memory_store\` or \`self_compact.memoryUpserts\` for durable facts that survive compaction (current count: see /self-propagate status).\n` +
  `- The pinned context (the original mandate) is re-baked into every self-propagate checkpoint. If the session's goal has genuinely changed, propose a replacement via \`pin_rewrite\` — the user must approve it.\n` +
  `- When calling \`self_compact\`, all prior turns are wiped. Your \`summary\` must contain all active state, modified files, and next steps.`;

interface MemoryEntry {
  key: string;
  title: string;
  body: string;
  updatedAt: string;
}

interface PinnedContext {
  text: string; // may be "" — an explicit user/agent-approved clear
  source: "seed" | "user" | "agent";
  updatedAt: string;
}

interface PersistedSessionState {
  enabled: boolean;
  budgetRatio: number; // Fraction of physical model contextWindow treated as 100% budget (default 0.85)
  keepAwakeMinutes: number; // 0 = disabled
  idleCompactMinutes: number; // Default 15m when keepAwakeMinutes === 0
  minPinnedTurns: number; // Seed floor for the initial pin (default 1) — applies until pinnedContext is set
  anchorEntryId: string | null; // null = session root; set via `/self-propagate on here`
  pinnedContext: PinnedContext | null; // null = not yet seeded; seeded from the branch at first need
  kv: Record<string, MemoryEntry>;
  // Durable across restarts so a restart cannot escape the grace lock or lose a
  // queued checkpoint. Ephemeral execution flags (isBusy/isCompacting) are NOT here.
  pendingCompaction: PendingCompaction | null;
  overBudgetTurns: number;
  idleCompactWarned: boolean;
}

interface PendingCompaction {
  summary: string;
  keepFirstTurns: number;
  continueAfter: boolean;
  nextObjective?: string;
}

interface RuntimeState {
  sessionId: string;
  persisted: PersistedSessionState;
  isBusy: boolean;
  isCompacting: boolean;
  lastActiveAt: number; // idle clock: reset at every session start, never persisted
  latestCtx: ExtensionContext | null;
}

const GLOBAL_TIMER_KEY = "__pi_self_propagate_timer_v1__";

export default function selfPropagateExtension(pi: ExtensionAPI) {
  const state: RuntimeState = {
    sessionId: "default",
    persisted: {
      enabled: false,
      budgetRatio: 0.85,
      keepAwakeMinutes: 0,
      idleCompactMinutes: 15,
      minPinnedTurns: 1,
      anchorEntryId: null,
      pinnedContext: null,
      kv: {},
      pendingCompaction: null,
      overBudgetTurns: 0,
      idleCompactWarned: false,
    },
    isBusy: false,
    isCompacting: false,
    lastActiveAt: Date.now(),
    latestCtx: null,
  };

  // --- Persistence Helpers (.pi/memory/<sessionId>.json) ---
  function currentSessionId(ctx: ExtensionContext): string {
    const sid =
      (ctx as any).sessionId ||
      ctx.sessionManager?.getSessionId?.() ||
      "default";
    state.sessionId = sid;
    return sid;
  }

  function getMemoryFilePath(ctx: ExtensionContext): string {
    const sid = currentSessionId(ctx);
    const dir = path.join(ctx.cwd || process.cwd(), ".pi", "memory");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, `${sid.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  function loadState(ctx: ExtensionContext): void {
    const file = getMemoryFilePath(ctx);
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        const rawPc = raw.pendingCompaction;
        const pendingCompaction =
          rawPc && typeof rawPc.summary === "string" && rawPc.summary.trim()
            ? {
                summary: rawPc.summary,
                keepFirstTurns: Number(rawPc.keepFirstTurns ?? 1) || 1,
                continueAfter: Boolean(rawPc.continueAfter),
                nextObjective:
                  typeof rawPc.nextObjective === "string" ? rawPc.nextObjective : undefined,
              }
            : null;
        const rawPin = raw.pinnedContext;
        const pinSource: PinnedContext["source"] =
          rawPin?.source === "user" || rawPin?.source === "agent" || rawPin?.source === "seed"
            ? rawPin.source
            : "seed";
        const pinnedContext =
          rawPin && typeof rawPin.text === "string"
            ? {
                text: scrubContextTags(rawPin.text.slice(0, MAX_PIN_CHARS)),
                source: pinSource,
                updatedAt:
                  typeof rawPin.updatedAt === "string" ? rawPin.updatedAt : new Date().toISOString(),
              }
            : null;
        state.persisted = {
          enabled: Boolean(raw.enabled ?? false),
          budgetRatio: Number(raw.budgetRatio ?? 0.85),
          keepAwakeMinutes: Number(raw.keepAwakeMinutes ?? 0),
          idleCompactMinutes: Number(raw.idleCompactMinutes ?? 15),
          minPinnedTurns: Math.max(1, Number(raw.minPinnedTurns ?? 1) || 1),
          anchorEntryId:
            typeof raw.anchorEntryId === "string" && raw.anchorEntryId ? raw.anchorEntryId : null,
          pinnedContext,
          kv: raw.kv && typeof raw.kv === "object" ? raw.kv : {},
          pendingCompaction,
          overBudgetTurns: Math.max(0, Math.floor(Number(raw.overBudgetTurns) || 0)),
          idleCompactWarned: Boolean(raw.idleCompactWarned ?? false),
        };
        return;
      } catch {
        // Fallback to default on corrupt file
      }
    }
    state.persisted = {
      enabled: false,
      budgetRatio: 0.85,
      keepAwakeMinutes: 0,
      idleCompactMinutes: 15,
      minPinnedTurns: 1,
      anchorEntryId: null,
      pinnedContext: null,
      kv: {},
      pendingCompaction: null,
      overBudgetTurns: 0,
      idleCompactWarned: false,
    };
  }

  function saveState(ctx: ExtensionContext): void {
    const file = getMemoryFilePath(ctx);
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state.persisted, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  // --- Tool Activation Gate ---
  function syncToolVisibility(): void {
    const currentActive = new Set(pi.getActiveTools());
    if (state.persisted.enabled) {
      for (const t of EXTENSION_TOOLS) currentActive.add(t);
    } else {
      for (const t of EXTENSION_TOOLS) currentActive.delete(t);
    }
    pi.setActiveTools(Array.from(currentActive));
  }

  // --- KV Memory Operations with Hard Caps ---
  function upsertMemoryEntry(key: string, title: string, body: string): string {
    const cleanKey = key.trim().slice(0, MAX_KEY_LEN);
    const cleanTitle = title.trim().slice(0, MAX_TITLE_LEN);
    const cleanBody = body.trim().slice(0, MAX_BODY_LEN);

    if (!cleanKey) throw new Error("Memory key cannot be empty.");

    const existingCount = Object.keys(state.persisted.kv).length;
    if (!state.persisted.kv[cleanKey] && existingCount >= MAX_KV_ENTRIES) {
      throw new Error(
        `Memory store full (${MAX_KV_ENTRIES} entries max). Delete stale keys first.`
      );
    }

    const candidate: Record<string, MemoryEntry> = {
      ...state.persisted.kv,
      [cleanKey]: {
        key: cleanKey,
        title: cleanTitle,
        body: cleanBody,
        updatedAt: new Date().toISOString(),
      },
    };

    const totalChars = JSON.stringify(candidate).length;
    if (totalChars > MAX_TOTAL_KV_CHARS) {
      throw new Error(
        `Memory cap exceeded (${totalChars}/${MAX_TOTAL_KV_CHARS} chars). Shorten body or delete keys.`
      );
    }

    state.persisted.kv = candidate;
    return cleanKey;
  }

  function renderWorkingMemoryBlock(): string {
    const entries = Object.values(state.persisted.kv).filter(
      (e): e is MemoryEntry =>
        !!e && typeof e.key === "string" && typeof e.title === "string" && typeof e.body === "string"
    );
    if (entries.length === 0) {
      return "<working_memory status=\"empty\" />";
    }
    const items = entries
      .map(
        (e) =>
          `  <note key="${e.key.replace(/"/g, "'")}" title="${e.title.replace(/"/g, "'")}">\n    ${scrubContextTags(e.body)}\n  </note>`
      )
      .join("\n");
    return `<working_memory count="${entries.length}">\n${items}\n</working_memory>`;
  }

  // --- Context Budget Accounting ---
  function getBudgetMetrics(ctx: ExtensionContext) {
    const usage = ctx.getContextUsage?.();
    const physicalWindow =
      usage?.contextWindow || (ctx as any).model?.contextWindow || 128000;
    const budgetCeiling = Math.floor(
      physicalWindow * state.persisted.budgetRatio
    );
    const tokens = usage?.tokens ?? 0;
    const budgetPercent =
      budgetCeiling > 0 ? Math.round((tokens / budgetCeiling) * 100) : 0;

    return {
      tokens,
      physicalWindow,
      budgetCeiling,
      budgetPercent,
    };
  }

  function updateFooterStatus(ctx: ExtensionContext): void {
    if (!state.persisted.enabled) {
      ctx.ui?.setStatus?.("self-propagate", undefined);
      return;
    }
    const { tokens, budgetCeiling, budgetPercent } = getBudgetMetrics(ctx);
    const wakeTag =
      state.persisted.keepAwakeMinutes > 0
        ? ` ⏰${state.persisted.keepAwakeMinutes}m`
        : "";
    const kvCount = Object.keys(state.persisted.kv).length;
    const graceTag =
      state.persisted.overBudgetTurns > 0
        ? ` [GRACE ${state.persisted.overBudgetTurns}/${GRACE_TURNS_AT_100}]`
        : "";
    ctx.ui?.setStatus?.(
      "self-propagate",
      `CTX: ${budgetPercent}% (${Math.round(tokens / 1000)}k/${Math.round(budgetCeiling / 1000)}k)${graceTag} | KV: ${kvCount}/${MAX_KV_ENTRIES}${wakeTag}`
    );
  }

  // --- Pinned Context (the original mandate, re-baked into every compaction) ---
  // The pin is a persisted document in .pi/memory/<session>.json, not a re-extraction
  // from the branch. It is seeded once, lazily, at the first compaction (or first pin
  // need) — from the session root by default, from the anchor set via
  // `/self-propagate on here`, falling back to the root when the anchor no longer lies
  // on the branch. It is re-injected verbatim into every self-propagate checkpoint.
  // Rewriting it requires an explicit user action (`/self-propagate pin set|clear|reset|here`)
  // or a `pin_rewrite` tool call approved by the user — the floor cannot be edited away
  // silently. `minPinnedTurns` is the seed floor only; it does not override a
  // deliberately cleared or rewritten pin.

  // Agent/user content containing tag-looking sequences must not forge the
  // checkpoint structure (<pinned_context>…</pinned_context> etc.). Strip the
  // leading angle bracket from any closing/opening tag the checkpoint uses.
  function scrubContextTags(text: string): string {
    return text.replace(
      /<(\/?)(pinned_context|working_memory|compaction_summary|note|idle_compaction_notice|keep_awake_tick|force_compact|pin_rewrite_request|self_propagation_resume)\b/gi,
      "[$1$2"
    );
  }

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  function extractPinSeed(
    ctx: ExtensionContext,
    keepFirstTurns: number
  ): { text: string; fellBack: boolean } {
    const minFloor = state.persisted.minPinnedTurns ?? 1;
    const raw = Number(keepFirstTurns);
    const requested = Number.isFinite(raw) ? raw : 1;
    const clamped = Math.max(
      minFloor,
      Math.min(MAX_PINNED_TURNS, requested)
    );

    const branch = ctx.sessionManager?.getBranch?.() ?? [];

    const capture = (anchor: string | null): string => {
      const captured: string[] = [];
      let userTurnsSeen = 0;
      let passedAnchor = !anchor;

      for (const entry of branch) {
        if (!passedAnchor) {
          if ((entry as any).id === anchor) passedAnchor = true;
          else continue;
        }

        if (entry.type !== "message" || !entry.message) continue;
        const role = entry.message.role;
        if (role !== "user" && role !== "assistant") continue;

        if (role === "user") {
          userTurnsSeen++;
          if (userTurnsSeen > clamped) break;
        }

        const rawContent =
          typeof entry.message.content === "string"
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content
                  .filter((b: any) => b.type === "text")
                  .map((b: any) => b.text)
                  .join("\n")
              : "";

        if (rawContent.trim()) {
          const snippet =
            rawContent.length > MAX_ORIGIN_TURN_CHARS
              ? `${rawContent.slice(0, MAX_ORIGIN_TURN_CHARS)}...[truncated]`
              : rawContent;
          captured.push(`[Pinned Turn ${userTurnsSeen} - ${role.toUpperCase()}]:\n${snippet}`);
        }
      }

      return captured.join("\n\n");
    };

    const anchored = capture(state.persisted.anchorEntryId);
    // A dead/absent anchor must never persist a silently empty pin.
    if (anchored.trim() || !state.persisted.anchorEntryId) {
      return { text: anchored.slice(0, MAX_PIN_CHARS), fellBack: false };
    }
    const text = capture(null);
    return { text: text.slice(0, MAX_PIN_CHARS), fellBack: true };
  }

  function ensurePinnedContext(ctx: ExtensionContext, keepFirstTurns = 1): PinnedContext {
    if (state.persisted.pinnedContext) return state.persisted.pinnedContext;
    const seed = extractPinSeed(ctx, keepFirstTurns);
    if (seed.fellBack) {
      ctx.ui?.notify?.(
        "Pin seed: the anchor no longer resolves on this branch — seeded from the session root instead.",
        "warning"
      );
    }
    const pinnedContext: PinnedContext = {
      text: scrubContextTags(seed.text),
      source: "seed",
      updatedAt: new Date().toISOString(),
    };
    state.persisted.pinnedContext = pinnedContext;
    saveState(ctx);
    return pinnedContext;
  }

  function renderPinnedContextBlock(ctx: ExtensionContext, keepFirstTurns: number): string {
    const pin = ensurePinnedContext(ctx, keepFirstTurns);
    if (!pin.text.trim()) {
      return `<pinned_context status="empty" source="${pin.source}" />\n\n`;
    }
    return `<pinned_context source="${pin.source}" updated="${pin.updatedAt}">\n${pin.text}\n</pinned_context>\n\n`;
  }

  function setPinnedContext(text: string, source: "user" | "agent"): void {
    state.persisted.pinnedContext = {
      text: scrubContextTags(text).slice(0, MAX_PIN_CHARS),
      source,
      updatedAt: new Date().toISOString(),
    };
  }

  function latestUserMessageText(ctx: ExtensionContext): string | null {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    const lastUserEntry = [...branch]
      .reverse()
      .find((e: any) => e.type === "message" && e.message?.role === "user");
    const content = (lastUserEntry as any)?.message?.content;
    if (!content) return null;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n")
          : "";
    return text.trim() ? text : null;
  }

  // --- Trigger Compaction Execution ---
  function executeScheduledCompaction(ctx: ExtensionContext): void {
    if (!state.persisted.pendingCompaction || state.isCompacting) return;
    const job = state.persisted.pendingCompaction;
    state.isCompacting = true;

    ctx.compact({
      customInstructions: "Self-propagation agent-authored checkpoint.",
      onComplete: () => {
        state.isCompacting = false;
        state.persisted.pendingCompaction = null;
        state.persisted.overBudgetTurns = 0;
        state.persisted.idleCompactWarned = false;
        state.lastActiveAt = Date.now();
        saveState(ctx);
        updateFooterStatus(ctx);

        if (job.continueAfter) {
          const resumeText =
            `<self_propagation_resume>\n` +
            `Context compaction complete. Working memory and summary are loaded in your checkpoint.\n` +
            `Next objective: ${job.nextObjective || "Continue executing your plan from the checkpoint summary."}\n` +
            `</self_propagation_resume>`;
          pi.sendUserMessage(resumeText, { deliverAs: "steer" });
        } else {
          ctx.ui?.notify?.(
            "Self-compaction complete (agent paused).",
            "info"
          );
        }
      },
      onError: (err: unknown) => {
        state.isCompacting = false;
        state.persisted.pendingCompaction = null;
        saveState(ctx);
        ctx.ui?.notify?.(
          `Self-compaction failed: ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      },
    });
  }

  // --- Background Watchdog (Keep-Awake & Idle Compaction) ---
  function ensureGlobalWatchdog(): void {
    const g = globalThis as any;
    if (g[GLOBAL_TIMER_KEY]) clearInterval(g[GLOBAL_TIMER_KEY]);

    g[GLOBAL_TIMER_KEY] = setInterval(() => {
      try {
        const ctx = state.latestCtx;
        if (
          !ctx ||
          !state.persisted.enabled ||
          state.isBusy ||
          state.isCompacting ||
          state.persisted.pendingCompaction
        ) {
          return;
        }

        const idleMs = Date.now() - state.lastActiveAt;

        // Mode 1: Keep-Awake Cron
        if (state.persisted.keepAwakeMinutes > 0) {
          const wakeMs = state.persisted.keepAwakeMinutes * 60_000;
          if (idleMs >= wakeMs) {
            state.lastActiveAt = Date.now();
            const { budgetPercent } = getBudgetMetrics(ctx);
            pi.sendUserMessage(
              `<keep_awake_tick idle_minutes="${state.persisted.keepAwakeMinutes}" context_budget="${budgetPercent}%">\n` +
                `Session wake tick triggered because no activity occurred for ${state.persisted.keepAwakeMinutes}m.\n` +
                `Review your <working_memory> and current objectives. If context budget (${budgetPercent}%) is high, call self_compact.\n` +
                `</keep_awake_tick>`,
              { deliverAs: "steer" }
            );
          }
          return;
        }

        // Mode 2: Idle Compaction Warning (when keep-awake is OFF)
        if (
          state.persisted.idleCompactMinutes > 0 &&
          !state.persisted.idleCompactWarned
        ) {
          const idleTargetMs = state.persisted.idleCompactMinutes * 60_000;
          const { budgetPercent } = getBudgetMetrics(ctx);
          if (idleMs >= idleTargetMs && budgetPercent >= 25) {
            state.persisted.idleCompactWarned = true;
            state.lastActiveAt = Date.now();
            saveState(ctx);
            pi.sendUserMessage(
              `<idle_compaction_notice idle_minutes="${state.persisted.idleCompactMinutes}" context_budget="${budgetPercent}%">\n` +
                `The session has been inactive for ${state.persisted.idleCompactMinutes} minutes at ${budgetPercent}% context budget.\n` +
                `Persist any important notes via memoryUpserts and call self_compact({ continueAfter: false, ... }) now so the session is cleanly compacted while idle.\n` +
                `</idle_compaction_notice>`,
              { deliverAs: "steer" }
            );
          }
        }
      } catch {
        // Ignore stale context errors across reloads
      }
    }, 15_000);
  }

  ensureGlobalWatchdog();

  // --- Register Tools ---
  // Tool parameters are plain JSON Schema (what TypeBox emits) so this file also
  // loads under bare node — see extensions/self-propagate.test.mjs.
  pi.registerTool({
    name: "memory_store",
    label: "Working Memory Store",
    description:
      "Manage persistent key-value notes (key, title, body) that survive across all compactions. Keep entries concise.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["upsert", "delete", "search", "list"],
        },
        key: { type: "string", description: `Unique slug key (max ${MAX_KEY_LEN} chars)` },
        title: { type: "string", description: `Short searchable header (max ${MAX_TITLE_LEN} chars)` },
        body: { type: "string", description: `Compact note content (max ${MAX_BODY_LEN} chars)` },
        query: { type: "string", description: "Search substring for 'search' action" },
      },
      required: ["action"],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!state.persisted.enabled) {
        return {
          content: [{ type: "text", text: "Self-propagation is disabled for this session." }],
          details: {},
        };
      }

      const entries = Object.values(state.persisted.kv);

      if (params.action === "list") {
        const listText =
          entries.length === 0
            ? "Working memory is empty."
            : entries
                .map((e) => `- [${e.key}] ${e.title} (${e.body.length} chars)`)
                .join("\n");
        return { content: [{ type: "text", text: listText }], details: {} };
      }

      if (params.action === "search") {
        const q = (params.query || "").toLowerCase();
        const matches = entries.filter(
          (e) =>
            e.key.toLowerCase().includes(q) ||
            e.title.toLowerCase().includes(q) ||
            e.body.toLowerCase().includes(q)
        );
        const text =
          matches.length === 0
            ? `No memory notes matched "${params.query}".`
            : matches
                .map((e) => `[${e.key}] ${e.title}:\n${e.body}`)
                .join("\n\n");
        return { content: [{ type: "text", text }], details: {} };
      }

      if (params.action === "delete") {
        if (!params.key || !state.persisted.kv[params.key]) {
          return {
            content: [{ type: "text", text: `Key "${params.key ?? ""}" not found.` }],
            details: {},
          };
        }
        delete state.persisted.kv[params.key];
        saveState(ctx);
        updateFooterStatus(ctx);
        return {
          content: [{ type: "text", text: `Deleted memory key "${params.key}".` }],
          details: {},
        };
      }

      // action === "upsert"
      if (!params.key || !params.title || params.body === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Error: 'upsert' requires key, title, and body.",
            },
          ],
          details: {},
        };
      }

      try {
        const savedKey = upsertMemoryEntry(params.key, params.title, params.body);
        saveState(ctx);
        updateFooterStatus(ctx);
        return {
          content: [
            {
              type: "text",
              text: `Saved [${savedKey}] (${Object.keys(state.persisted.kv).length}/${MAX_KV_ENTRIES} slots used).`,
            },
          ],
          details: {},
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Memory error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  pi.registerTool({
    name: "self_compact",
    label: "Self Compact Context",
    description:
      "Wipe raw conversation history and replace it with your own structured summary, the pinned context (the original mandate, re-baked verbatim), and persistent KV working memory.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Comprehensive checkpoint summary of completed work, active file paths, architecture decisions, and remaining tasks. All recent turns will be wiped, so include everything needed to continue.",
        },
        keepFirstTurns: {
          type: "number",
          description: `Number of turns to seed the pinned context with when none exists yet (1-${MAX_PINNED_TURNS}, default 1). Only used at seed time; once a pin exists it is re-used verbatim. Changing the pin itself requires the user (\`/self-propagate pin\`) or a user-approved \`pin_rewrite\`.`,
        },
        continueAfter: {
          type: "boolean",
          description:
            "True to automatically resume execution immediately after compaction; False to pause and wait for the user or next wake timer.",
        },
        nextObjective: {
          type: "string",
          description:
            "When continueAfter is true, the exact immediate action you want to execute first in the fresh context.",
        },
        memoryUpserts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              title: { type: "string" },
              body: { type: "string" },
            },
            required: ["key", "title", "body"],
          },
          description: "Optional batch of KV memory notes to save before compacting.",
        },
        memoryDeletes: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of KV memory keys to delete before compacting.",
        },
      },
      required: ["summary", "continueAfter"],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!state.persisted.enabled) {
        return {
          content: [{ type: "text", text: "Self-propagation is disabled." }],
          details: {},
        };
      }

      const memErrors: string[] = [];
      if (params.memoryDeletes) {
        for (const k of params.memoryDeletes) {
          delete state.persisted.kv[k];
        }
      }
      if (params.memoryUpserts) {
        for (const item of params.memoryUpserts) {
          try {
            upsertMemoryEntry(item.key, item.title, item.body);
          } catch (e) {
            memErrors.push(e instanceof Error ? e.message : String(e));
          }
        }
      }
      saveState(ctx);

      state.persisted.pendingCompaction = {
        summary: params.summary,
        keepFirstTurns: Number.isFinite(Number(params.keepFirstTurns))
          ? Number(params.keepFirstTurns)
          : 1, // NaN/undefined → safe default (seed floor applies at render time)
        continueAfter: params.continueAfter,
        nextObjective: params.nextObjective,
      };
      saveState(ctx); // the queued checkpoint must survive a process restart

      const errNote =
        memErrors.length > 0 ? ` (Memory warnings: ${memErrors.join("; ")})` : "";

      return {
        content: [
          {
            type: "text",
            text: `Compaction queued${errNote}. Do NOT call any more tools in this turn; conclude your response in 1 sentence so compaction can execute immediately.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "pin_rewrite",
    label: "Rewrite Pinned Context",
    description:
      "Propose a replacement for the pinned context — the original mandate re-injected verbatim into every self-propagate checkpoint. The user is asked to approve the new text; if they reject it, nothing changes. Use this only when the session's goal has genuinely changed, not to shed inconvenient constraints. Takes effect at the next compaction (call self_compact to apply it now).",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: `The full replacement pinned context (max ${MAX_PIN_CHARS} chars). Pass an empty string to clear the pin entirely — the user still has to approve that. Write it as instructions you would want a fresh instance of you to obey.`,
        },
        reason: {
          type: "string",
          description: "Why the pin should change. Shown to the user in the approval dialog.",
        },
      },
      required: ["text", "reason"],
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!state.persisted.enabled) {
        return {
          content: [{ type: "text", text: "Self-propagation is disabled." }],
          details: {},
        };
      }

      const text = String(params.text ?? "").trim();
      const reason = String(params.reason ?? "").trim();
      if (text.length > MAX_PIN_CHARS) {
        return {
          content: [
            {
              type: "text",
              text: `Pinned context too large (${text.length}/${MAX_PIN_CHARS} chars). Trim it.`,
            },
          ],
          details: {},
        };
      }

      const preview = text
        ? text.length > 2000
          ? `${text.slice(0, 2000)}...[${text.length - 2000} more chars]`
          : text
        : "(empty — the pin will be CLEARED; no mandate is re-injected after compactions)";
      const message = `Reason: ${reason || "(none given)"}\n\nNew pinned context (${text.length} chars):\n\n${preview}`;

      let approved = false;
      try {
        approved = (await ctx.ui?.confirm?.("Rewrite pinned context?", message)) === true;
      } catch {
        approved = false;
      }
      if (!approved) {
        return {
          content: [
            {
              type: "text",
              text: "Pin rewrite rejected or unavailable — the pinned context is unchanged. Do not retry without new user input.",
            },
          ],
          details: { applied: false },
        };
      }

      setPinnedContext(text, "agent");
      saveState(ctx);
      return {
        content: [
          {
            type: "text",
            text: "Pinned context rewritten (user-approved). It takes effect at the next compaction — call self_compact, or the user can run /self-propagate compact, to apply it now.",
          },
        ],
        details: { applied: true },
      };
    },
  });

  // --- Commands: /self-propagate ---
  const PROPAGATE_SUBS = [
    { value: "on", description: "Enable self-propagation for this session" },
    { value: "on here", description: "Enable, anchoring the pinned-context seed to your latest user message" },
    { value: "off", description: "Disable; clears keep-awake and any queued compaction" },
    { value: "status", description: "Full state: budget bar, pin, anchor, KV store, timers" },
    { value: "budget", description: "Set/show budget ceiling as fraction of model window (0.3–0.95, default 0.85)" },
    { value: "idle", description: "Set/show idle-compaction warning minutes (0 = off, default 15)" },
    { value: "keep-awake", description: "Wake tick every N minutes of inactivity, or `off` to disable" },
    { value: "pin", description: "Manage the pinned context: show | set <text> | clear | reset | here | draft" },
    { value: "compact", description: "Ask the agent to compact right now" },
    { value: "help", description: "Show this help" },
  ] as const;

  function clampPct(n: number): number {
    return Math.max(0, Math.min(100, n));
  }

  function renderBudgetBar(pct: number, width = 20): string {
    const filled = Math.round((clampPct(pct) / 100) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
  }

  function propagateStatusSummary(ctx: ExtensionContext): string {
    const { budgetPercent } = getBudgetMetrics(ctx);
    const kv = Object.keys(state.persisted.kv).length;
    return `${state.persisted.enabled ? "ENABLED" : "DISABLED"} | ${budgetPercent}% of ceiling | KV ${kv}/${MAX_KV_ENTRIES} | keep-awake ${state.persisted.keepAwakeMinutes > 0 ? `${state.persisted.keepAwakeMinutes}m` : "off"} | anchor ${state.persisted.anchorEntryId ? "current turn" : "session start"}`;
  }

  function propagateStatusDetail(ctx: ExtensionContext): string {
    const { tokens, physicalWindow, budgetCeiling, budgetPercent } =
      getBudgetMetrics(ctx);
    const kv = Object.keys(state.persisted.kv).length;
    const pin = state.persisted.pinnedContext;
    const pinDesc = pin
      ? pin.text.trim()
        ? `${pin.source === "seed" ? "seeded" : `custom (${pin.source})`}, ${pin.text.length} chars, updated ${pin.updatedAt.slice(0, 10)}`
        : `CLEARED (${pin.source}, ${pin.updatedAt.slice(0, 10)})`
      : `floor ${state.persisted.minPinnedTurns} turn(s), seed pending`;
    const anchor = state.persisted.anchorEntryId
      ? `${state.persisted.anchorEntryId.slice(0, 12)}… (set via /self-propagate on here)`
      : "session start (default)";
    const tier =
      budgetPercent >= 100
        ? "OVER BUDGET — grace turns running"
        : budgetPercent >= 75
          ? "warning ≥75% — checkpoint soon"
          : budgetPercent >= 50
            ? "notice ≥50%"
            : "healthy";
    return [
      "Self-Propagate",
      `  State    ${state.persisted.enabled ? "ENABLED" : "DISABLED"}`,
      `  Budget   ${renderBudgetBar(budgetPercent)} ${budgetPercent}%  (${tokens}/${Math.round(budgetCeiling)} tokens; window ${physicalWindow}, ceiling ${Math.round(state.persisted.budgetRatio * 100)}%) — ${tier}`,
      `  Pinned   ${pinDesc} | anchor: ${anchor}`,
      `  KV       ${kv}/${MAX_KV_ENTRIES} notes | file: .pi/memory/${currentSessionId(ctx).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
      `  Timers   keep-awake ${state.persisted.keepAwakeMinutes > 0 ? `${state.persisted.keepAwakeMinutes}m` : "off"} | idle-compact warn ${state.persisted.idleCompactMinutes > 0 ? `${state.persisted.idleCompactMinutes}m` : "off"}`,
    ].join("\n");
  }

  function propagateHelp(): string {
    return [
      "Self-Propagate — contextual self-compaction for long sessions",
      "",
      "When the budget fills, the agent writes its own checkpoint (summary + pinned",
      "context + KV working memory), wipes raw history, and resumes. Opt-in per",
      "session; nothing is sent anywhere and nothing changes when disabled.",
      "",
      "Usage: /self-propagate [subcommand]",
      "",
      "  on [here]          Enable. `here` seeds the initial pin from your latest",
      "                     user message (for mid-conversation); default seeds from",
      "                     the session root. The seed floor is 1 turn.",
      "  off                Disable; clears keep-awake, pending compaction, grace count.",
      "  status             Full state: budget bar, pin, anchor, KV, timers.",
      "  budget <0.3-0.95>  Effective ceiling as fraction of model window (default 0.85).",
      "                     No argument prints the current value.",
      "  idle <minutes>     Warn + poke the agent when idle this long at ≥25% budget",
      "                     (0 = off, default 15). No argument prints the current value.",
      "  keep-awake <minutes|off>",
      "                     Wake tick every N minutes of inactivity (auto-enables).",
      "  pin [show]         Show the pinned context (the mandate re-baked into every",
      "                     checkpoint). If unset, it is seeded at the next compaction.",
      "  pin set <text>     Replace the pinned context with <text>.",
      "  pin clear          Clear the pin — no mandate re-injected after compaction.",
      "  pin reset          Discard the custom pin; re-seed from the branch next compaction.",
      "  pin here           Pin the latest user message as the pinned context.",
      "  pin draft          Ask the agent to propose a new pin; you approve before it lands.",
      "  compact            Ask the agent to compact right now.",
      "  help               This help (also the default for bare /self-propagate).",
      "",
      "Notes",
      "  Pin edits take effect at the NEXT compaction; `compact` applies them now.",
      "  Writing the pin file itself never enters context and never busts the cache.",
      "  The agent can propose pin changes via the pin_rewrite tool, but they",
      "  apply only with your approval.",
      "",
      "Related tooling",
      "  self_compact, memory_store, pin_rewrite   Tools, only declared while enabled.",
      "  .pi/memory/<session>.json                 KV notes + pin + flags; survives /reload and resume.",
    ].join("\n");
  }

  pi.registerCommand("self-propagate", {
    description:
      "Self-propagation for long sessions: /self-propagate help | on [here] | off | status | budget <0.3-0.95> | idle <minutes> | keep-awake <minutes|off> | pin <show|set|clear|reset|here|draft> | compact",
    getArgumentCompletions: (prefix: string) => {
      const lower = prefix.toLowerCase();
      const firstSpace = lower.indexOf(" ");
      if (firstSpace === -1) {
        const items = PROPAGATE_SUBS.filter((s) =>
          s.value.startsWith(lower)
        ).map((s) => ({ value: s.value, label: s.value, description: s.description }));
        return items.length > 0 ? items : null;
      }
      const first = lower.slice(0, firstSpace).trim();
      const rest = lower.slice(firstSpace + 1);
      // pi's autocomplete replaces the WHOLE argument with `value`, so nested
      // values must carry the `<subcommand> ` prefix ("idle 5", not "5").
      const suggest = (values: string[], describe: (v: string) => string) =>
        values
          .filter((v) => v.startsWith(rest))
          .map((v) => ({ value: `${first} ${v}`, label: v, description: describe(v) }));
      if (first === "on")
        return suggest(["here"], () => "Seed the pin from your latest user message");
      if (first === "budget")
        return suggest(["0.5", "0.7", "0.85", "0.9"], (v) => `Ceiling ${Math.round(parseFloat(v) * 100)}% of model window`);
      if (first === "idle")
        return suggest(["0", "5", "10", "15", "30"], (v) => (v === "0" ? "Disable idle warning" : `Warn after ${v}m idle`));
      if (first === "keep-awake")
        return suggest(["off", "5", "10", "15", "30"], (v) => (v === "off" ? "Disable keep-awake" : `Wake after ${v}m idle`));
      if (first === "pin") {
        const PIN_HELP: Record<string, string> = {
          show: "Show the pinned context",
          set: "Replace the pinned context with <text>",
          clear: "Clear the pin (no mandate re-injected)",
          reset: "Discard custom pin; re-seed from the branch",
          here: "Pin the latest user message",
          draft: "Agent proposes a new pin; you approve",
        };
        return suggest(["show", "set", "clear", "reset", "here", "draft"], (v) => PIN_HELP[v] ?? v);
      }
      return null;
    },
    handler: async (args, ctx) => {
      state.latestCtx = ctx;
      const rawArgs = args || "";
      const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "help").toLowerCase();

      if (sub === "help" || sub === "h" || sub === "?") {
        ctx.ui.notify(`${propagateHelp()}\n\nCurrent: ${propagateStatusSummary(ctx)}`, "info");
        return;
      }

      if (sub === "on") {
        const option = parts[1]?.toLowerCase();
        if (option && option !== "here") {
          ctx.ui.notify(
            `Unknown option '${parts[1]}'. Did you mean \`/self-propagate on here\`?`,
            "warning"
          );
          return;
        }
        state.persisted.enabled = true;
        state.persisted.minPinnedTurns = Math.max(1, state.persisted.minPinnedTurns ?? 1);

        // `/self-propagate on here` pins from the latest user message in the branch
        let seedNote = "";
        if (option === "here") {
          const branch = ctx.sessionManager?.getBranch?.() ?? [];
          const lastUserEntry = [...branch]
            .reverse()
            .find(
              (e: any) => e.type === "message" && e.message?.role === "user"
            );
          state.persisted.anchorEntryId = (lastUserEntry as any)?.id ?? null;
          // Anchoring only affects the SEED. If an untouched seed pin exists,
          // drop it so it re-seeds from the new anchor at the next compaction.
          // A user/agent-rewritten pin is never touched silently.
          const pin = state.persisted.pinnedContext;
          if (!pin) {
            seedNote = "";
          } else if (pin.source === "seed") {
            state.persisted.pinnedContext = null;
            seedNote = " The existing seed pin will be re-created from this turn at the next compaction.";
          } else {
            seedNote = " Existing custom pin kept — run /self-propagate pin reset to re-seed from this turn instead.";
          }
        }

        saveState(ctx);
        syncToolVisibility();
        updateFooterStatus(ctx);
        ctx.ui.notify(
          `Self-propagation ENABLED (${state.persisted.anchorEntryId ? "anchor: current turn" : "anchor: session start"}, ceiling ${Math.round(state.persisted.budgetRatio * 100)}% of model window). /self-propagate status for details, /self-propagate help for usage.${seedNote}`,
          "info"
        );
        return;
      }

      if (sub === "off") {
        state.persisted.enabled = false;
        state.persisted.keepAwakeMinutes = 0;
        state.persisted.overBudgetTurns = 0;
        state.persisted.pendingCompaction = null;
        saveState(ctx);
        syncToolVisibility();
        updateFooterStatus(ctx);
        ctx.ui.notify("Self-propagation DISABLED for this session. /self-propagate on to re-enable.", "info");
        return;
      }

      if (sub === "budget") {
        if (!parts[1]) {
          ctx.ui.notify(
            `Budget ceiling is ${Math.round(state.persisted.budgetRatio * 100)}% of model window. Set it with /self-propagate budget <0.3-0.95> (e.g. 0.85).`,
            "info"
          );
          return;
        }
        const val = parseFloat(parts[1]);
        if (isNaN(val) || val < 0.3 || val > 0.95) {
          ctx.ui.notify("Budget ratio must be between 0.30 and 0.95 (e.g. 0.85).", "warning");
          return;
        }
        state.persisted.budgetRatio = val;
        saveState(ctx);
        updateFooterStatus(ctx);
        ctx.ui.notify(`Budget ceiling set to ${Math.round(val * 100)}% of model window.`, "info");
        return;
      }

      if (sub === "idle") {
        if (!parts[1]) {
          ctx.ui.notify(
            `Idle compaction warning is ${state.persisted.idleCompactMinutes > 0 ? `${state.persisted.idleCompactMinutes}m` : "off"}. Set it with /self-propagate idle <minutes> (0 = off).`,
            "info"
          );
          return;
        }
        const mins = parseInt(parts[1], 10);
        if (isNaN(mins) || mins < 0) {
          ctx.ui.notify("Idle compact minutes must be >= 0.", "warning");
          return;
        }
        state.persisted.idleCompactMinutes = mins;
        saveState(ctx);
        ctx.ui.notify(`Idle compaction warning timeout set to ${mins}m.`, "info");
        return;
      }

      if (sub === "keep-awake") {
        const arg = (parts[1] || "").trim().toLowerCase();
        if (!arg) {
          ctx.ui.notify(
            `Keep-awake is currently ${state.persisted.keepAwakeMinutes > 0 ? `ON (${state.persisted.keepAwakeMinutes}m)` : "OFF"}. Set it with /self-propagate keep-awake <minutes|off>.`,
            "info"
          );
          return;
        }
        if (arg === "off" || arg === "0") {
          state.persisted.keepAwakeMinutes = 0;
          saveState(ctx);
          updateFooterStatus(ctx);
          ctx.ui.notify("Keep-awake timer disabled.", "info");
          return;
        }
        const mins = parseFloat(arg);
        if (isNaN(mins) || mins <= 0) {
          ctx.ui.notify("Usage: /self-propagate keep-awake <minutes|off>", "warning");
          return;
        }
        state.persisted.enabled = true; // Auto-enable propagation if keep-awake is turned on
        state.persisted.keepAwakeMinutes = mins;
        state.lastActiveAt = Date.now();
        saveState(ctx);
        syncToolVisibility();
        updateFooterStatus(ctx);
        ctx.ui.notify(
          `Keep-awake enabled: session will wake after ${mins}m of inactivity (Self-propagation enabled).`,
          "info"
        );
        return;
      }

      if (sub === "pin") {
        if (!state.persisted.enabled) {
          ctx.ui.notify("Self-propagation is disabled for this session.", "warning");
          return;
        }
        const action = (parts[1] || "show").toLowerCase();
        // Preserve the mandate's internal formatting: take everything after `pin set` verbatim
        const rest =
          action === "set"
            ? rawArgs.replace(/^\s*pin\s+set\s*/i, "").trim()
            : parts.slice(2).join(" ").trim();
        const pin = state.persisted.pinnedContext;
        const seedDesc = state.persisted.anchorEntryId ? "the anchor (current turn)" : "Turn 1";

        if (action === "show" || action === "s") {
          if (!pin) {
            ctx.ui.notify(
              `Pin not yet seeded — the first checkpoint will seed it from ${seedDesc} (floor ${state.persisted.minPinnedTurns} turn). /self-propagate pin here to pin the current user message instead.`,
              "info"
            );
            return;
          }
          if (!pin.text.trim()) {
            ctx.ui.notify(
              `Pinned context is CLEARED (${pin.source}, ${pin.updatedAt}). No mandate will be re-injected after compaction. /self-propagate pin reset to re-seed from ${seedDesc}.`,
              "warning"
            );
            return;
          }
          const body =
            pin.text.length > 3000
              ? `${pin.text.slice(0, 3000)}\n...[truncated — ${pin.text.length} chars total]`
              : pin.text;
          ctx.ui.notify(
            `Pinned context (${pin.source}, ${pin.updatedAt}, ${pin.text.length} chars):\n\n${body}`,
            "info"
          );
          return;
        }

        if (action === "set") {
          if (!rest) {
            ctx.ui.notify(
              "Usage: /self-propagate pin set <text>. Applies at the next compaction; run /self-propagate compact to apply now.",
              "warning"
            );
            return;
          }
          if (rest.length > MAX_PIN_CHARS) {
            ctx.ui.notify(`Pinned context too large (${rest.length}/${MAX_PIN_CHARS} chars).`, "warning");
            return;
          }
          setPinnedContext(rest, "user");
          saveState(ctx);
          ctx.ui.notify(
            `Pinned context set (user, ${rest.length} chars). Applies at the next compaction — /self-propagate compact to apply now.`,
            "info"
          );
          return;
        }

        if (action === "clear") {
          setPinnedContext("", "user");
          saveState(ctx);
          ctx.ui.notify(
            "Pinned context CLEARED — no mandate will be re-injected after compaction. /self-propagate pin reset to re-seed.",
            "warning"
          );
          return;
        }

        if (action === "reset") {
          state.persisted.pinnedContext = null;
          saveState(ctx);
          ctx.ui.notify(
            `Pinned context reset — re-seeded from ${seedDesc} at the next compaction (floor ${state.persisted.minPinnedTurns} turn).`,
            "info"
          );
          return;
        }

        if (action === "here") {
          const msg = latestUserMessageText(ctx);
          if (!msg) {
            ctx.ui.notify("No user message found in this branch to pin.", "warning");
            return;
          }
          const text = `[Pinned from the current user message]:\n${msg.slice(0, MAX_ORIGIN_TURN_CHARS)}`;
          setPinnedContext(text, "user");
          saveState(ctx);
          ctx.ui.notify(
            `Pinned context set from the latest user message (${text.length} chars). Applies at the next compaction — /self-propagate compact to apply now.`,
            "info"
          );
          return;
        }

        if (action === "draft") {
          if (state.persisted.pendingCompaction || state.isCompacting) {
            ctx.ui.notify(
              "A compaction is already queued or running — pin_rewrite is blocked until it completes. Try again afterwards.",
              "warning"
            );
            return;
          }
          pi.sendUserMessage(
            `<pin_rewrite_request>The user asked you to draft a replacement for the pinned context (the mandate baked into every compaction). Review the current pinned context and the session's trajectory, then call pin_rewrite with the new text and a reason — the user will approve or reject it.</pin_rewrite_request>`,
            { deliverAs: "steer" }
          );
          ctx.ui.notify(
            "Asked the agent to draft a new pinned context (you will be asked to approve it).",
            "info"
          );
          return;
        }

        ctx.ui.notify(
          `Unknown pin action '${parts[1] ?? ""}'. Use: show | set <text> | clear | reset | here | draft`,
          "warning"
        );
        return;
      }

      if (sub === "compact") {
        if (!state.persisted.enabled) {
          ctx.ui.notify("Self-propagation is disabled for this session.", "warning");
          return;
        }
        if (state.persisted.pendingCompaction || state.isCompacting) {
          ctx.ui.notify(
            "A compaction is already queued — it will run at the end of the current turn.",
            "info"
          );
          return;
        }
        pi.sendUserMessage(
          `<force_compact reason="user">The user ran /self-propagate compact. Persist anything critical via memory_store, then call self_compact now (continueAfter: true unless you are meant to pause) so context is cleanly checkpointed — the current pinned context will be re-baked verbatim.</force_compact>`,
          { deliverAs: "steer" }
        );
        ctx.ui.notify(
          "Asked the agent to compact now. (Compaction replaces the whole prefix — full cache miss, unavoidable and deliberate.)",
          "info"
        );
        return;
      }

      if (sub === "status" || sub === "s") {
        ctx.ui.notify(propagateStatusDetail(ctx), "info");
        return;
      }

      ctx.ui.notify(
        `Unknown subcommand '${parts[0]}'. Run /self-propagate help to see usage.`,
        "warning"
      );
    },
  });

  // --- Lifecycle Hooks ---
  pi.on("session_start", async (_event, ctx) => {
    state.latestCtx = ctx;
    state.isBusy = false;
    state.isCompacting = false; // never persisted — always false on boot
    loadState(ctx); // restores durable state, including any queued checkpoint
    state.lastActiveAt = Date.now(); // idle clock restarts with the session
    syncToolVisibility();
    updateFooterStatus(ctx);
    if (state.persisted.pendingCompaction) {
      ctx.ui?.notify?.(
        "Self-propagation: a self_compact checkpoint queued before the restart was restored and will run at the next turn end.",
        "info"
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    state.latestCtx = ctx;
    state.isBusy = true;
    state.persisted.idleCompactWarned = false;
    state.lastActiveAt = Date.now();

    if (!state.persisted.enabled) return;

    const { tokens, budgetCeiling, budgetPercent } = getBudgetMetrics(ctx);

    let budgetAlert: string | null = null;
    if (budgetPercent >= 100) {
      state.persisted.overBudgetTurns += 1;
      const remainingGrace = Math.max(
        0,
        GRACE_TURNS_AT_100 - state.persisted.overBudgetTurns + 1
      );
      if (state.persisted.overBudgetTurns <= GRACE_TURNS_AT_100) {
        budgetAlert =
          `[CRITICAL CONTEXT ALERT — 100% BUDGET REACHED (${tokens}/${budgetCeiling} tokens) — GRACE TURN ${state.persisted.overBudgetTurns}/${GRACE_TURNS_AT_100}]\n` +
          `You MUST wrap up your current thought and call \`self_compact\` within ${remainingGrace} turn(s). ` +
          `After turn ${GRACE_TURNS_AT_100}, all tools except \`self_compact\` and \`memory_store\` will be HARD-LOCKED.`;
      } else {
        budgetAlert =
          `[HARD CONTEXT LOCK ENGAGED — GRACE PERIOD EXPIRED (${state.persisted.overBudgetTurns}/${GRACE_TURNS_AT_100} turns over 100%)]\n` +
          `All standard tools are now blocked. You MUST call \`self_compact\` immediately.`;
      }
    } else {
      state.persisted.overBudgetTurns = 0;
      if (budgetPercent >= 75) {
        budgetAlert =
          `[CONTEXT WARNING: ${budgetPercent}% of budget (${tokens}/${budgetCeiling} tokens). ` +
          `Reach a clean checkpoint soon and call \`self_compact\` to free context.]`;
      } else if (budgetPercent >= 50) {
        budgetAlert =
          `[CONTEXT NOTICE: ${budgetPercent}% of budget (${tokens}/${budgetCeiling} tokens) used.]`;
      }
    }

    updateFooterStatus(ctx);
    saveState(ctx); // persist overBudgetTurns / idleCompactWarned changes

    return {
      systemPrompt: (event.systemPrompt || "") + PROTOCOL_STATIC,
      ...(budgetAlert
        ? {
            message: {
              customType: "self_propagate_budget",
              content: `<self_propagate_budget level="${budgetPercent >= 100 ? "critical" : budgetPercent >= 75 ? "warning" : "notice"}">\n${budgetAlert}\n</self_propagate_budget>`,
              display: false,
              details: { tokens, budgetCeiling, budgetPercent },
            },
          }
        : {}),
    };
  });

  // Gate tool execution when pending compaction OR when grace turns > 5
  pi.on("tool_call", async (event, ctx) => {
    if (!state.persisted.enabled) return;

    if (state.persisted.pendingCompaction && event.toolName !== "memory_store") {
      return {
        block: true,
        reason:
          "self_compact has already been scheduled for the end of this turn. Finish your response immediately so compaction can run.",
      };
    }

    const { budgetPercent } = getBudgetMetrics(ctx);
    if (
      budgetPercent >= 100 &&
      state.persisted.overBudgetTurns > GRACE_TURNS_AT_100 &&
      event.toolName !== "self_compact" &&
      event.toolName !== "memory_store"
    ) {
      return {
        block: true,
        reason: `HARD CONTEXT LOCK: Context is at ${budgetPercent}% of budget and you exceeded the ${GRACE_TURNS_AT_100}-turn grace period. Call self_compact immediately.`,
      };
    }
  });

  // Append lightweight telemetry to tool results when >= 50%
  pi.on("tool_result", async (event, ctx) => {
    if (!state.persisted.enabled || event.toolName === "self_compact") return;

    const { budgetPercent, tokens, budgetCeiling } = getBudgetMetrics(ctx);
    if (budgetPercent < 50) return;

    let tag = `[Context: ${budgetPercent}% (${Math.round(tokens / 1000)}k/${Math.round(budgetCeiling / 1000)}k)]`;
    if (budgetPercent >= 100) {
      tag = `[CRITICAL 100% CONTEXT (${budgetPercent}%) — Grace Turn ${state.persisted.overBudgetTurns}/${GRACE_TURNS_AT_100}: CALL self_compact NOW]`;
    } else if (budgetPercent >= 75) {
      tag = `[WARNING 75%+ CONTEXT (${budgetPercent}%) — Prepare to call self_compact at next checkpoint]`;
    }

    const existing = Array.isArray(event.content) ? event.content : [];
    return {
      content: [...existing, { type: "text", text: `\n${tag}` }],
    };
  });

  // Intercept compaction: suppress built-in auto-compact and inject agent's self_compact payload
  pi.on("session_before_compact", async (event, ctx) => {
    if (!state.persisted.enabled) return;

    // If Pi's internal threshold compaction fired without the agent calling self_compact, cancel it
    // so the agent stays in direct control via the 50/75/100% warnings (unless it's a hard API overflow)
    if (!state.persisted.pendingCompaction && event.reason === "threshold") {
      return { cancel: true };
    }

    if (!state.persisted.pendingCompaction) return;

    // Total handler: a failure here must never let pi fall back to its default
    // compaction (which would silently drop the pinned context, the KV memory
    // and the agent's checkpoint). Degrade per-block and tag the result instead.
    const job = state.persisted.pendingCompaction;
    const problems: string[] = [];

    let originBlock = "";
    try {
      originBlock = renderPinnedContextBlock(ctx, job.keepFirstTurns);
    } catch (e) {
      problems.push(`pinned context failed to render: ${errMsg(e)}`);
    }

    let memoryBlock = "";
    try {
      memoryBlock = renderWorkingMemoryBlock();
    } catch (e) {
      problems.push(`working memory failed to render: ${errMsg(e)}`);
    }

    let kvKeys: string[] = [];
    try {
      kvKeys = Object.keys(state.persisted.kv);
    } catch {
      kvKeys = [];
    }

    const problemNote = problems.length
      ? `\n[self-propagate: checkpoint DEGRADED — ${problems.join("; ")}]\n`
      : "";

    if (problems.length > 0) {
      ctx.ui?.notify?.(
        `Self-propagate checkpoint rendered in degraded mode: ${problems.join("; ")}`,
        "warning"
      );
    }

    const compositeSummary =
      `${originBlock}` +
      `${memoryBlock}\n\n` +
      problemNote +
      `<compaction_summary>\n${scrubContextTags(job.summary)}\n</compaction_summary>`;

    return {
      compaction: {
        summary: compositeSummary,
        // Sentinel ID not matching any prior entry -> buildContextEntries retains 0 tail entries
        firstKeptEntryId: RETAIN_NONE_SENTINEL,
        tokensBefore: event.preparation.tokensBefore,
        details: {
          selfPropagated: true,
          keepFirstTurns: job.keepFirstTurns,
          pinSource: state.persisted.pinnedContext?.source ?? null,
          kvKeys,
          degraded: problems.length > 0,
        },
      },
    };
  });

  // Execute queued self_compact as soon as the agent turn settles
  pi.on("agent_end", async (_event, ctx) => {
    state.latestCtx = ctx;
    state.isBusy = false;
    state.lastActiveAt = Date.now();
    updateFooterStatus(ctx);

    if (state.persisted.enabled && state.persisted.pendingCompaction) {
      executeScheduledCompaction(ctx);
    }
  });
}