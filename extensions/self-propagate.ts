import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Constants & Guardrails ---
const EXTENSION_TOOLS = ["self_compact", "memory_store"] as const;
const MAX_KV_ENTRIES = 25;
const MAX_KEY_LEN = 48;
const MAX_TITLE_LEN = 100;
const MAX_BODY_LEN = 1200;
const MAX_TOTAL_KV_CHARS = 16000;
const MAX_PINNED_TURNS = 4;
const MAX_ORIGIN_TURN_CHARS = 2000;
const GRACE_TURNS_AT_100 = 5;
const RETAIN_NONE_SENTINEL = "__self_propagate_retain_none__";

interface MemoryEntry {
  key: string;
  title: string;
  body: string;
  updatedAt: string;
}

interface PersistedSessionState {
  enabled: boolean;
  budgetRatio: number; // Fraction of physical model contextWindow treated as 100% budget (default 0.85)
  keepAwakeMinutes: number; // 0 = disabled
  idleCompactMinutes: number; // Default 15m when keepAwakeMinutes === 0
  kv: Record<string, MemoryEntry>;
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
  lastActiveAt: number;
  idleCompactWarned: boolean;
  overBudgetTurns: number;
  pendingCompaction: PendingCompaction | null;
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
      kv: {},
    },
    isBusy: false,
    isCompacting: false,
    lastActiveAt: Date.now(),
    idleCompactWarned: false,
    overBudgetTurns: 0,
    pendingCompaction: null,
    latestCtx: null,
  };

  // --- Persistence Helpers (.pi/memory/<sessionId>.json) ---
  function getMemoryFilePath(ctx: ExtensionContext): string {
    const sid =
      (ctx as any).sessionId ||
      ctx.sessionManager?.getSessionId?.() ||
      "default";
    state.sessionId = sid;
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
        state.persisted = {
          enabled: Boolean(raw.enabled ?? false),
          budgetRatio: Number(raw.budgetRatio ?? 0.85),
          keepAwakeMinutes: Number(raw.keepAwakeMinutes ?? 0),
          idleCompactMinutes: Number(raw.idleCompactMinutes ?? 15),
          kv: raw.kv && typeof raw.kv === "object" ? raw.kv : {},
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
      kv: {},
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
    const entries = Object.values(state.persisted.kv);
    if (entries.length === 0) {
      return "<working_memory status=\"empty\" />";
    }
    const items = entries
      .map(
        (e) =>
          `  <note key="${e.key}" title="${e.title.replace(/"/g, "'")}">\n    ${e.body}\n  </note>`
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
      state.overBudgetTurns > 0
        ? ` [GRACE ${state.overBudgetTurns}/${GRACE_TURNS_AT_100}]`
        : "";
    ctx.ui?.setStatus?.(
      "self-propagate",
      `CTX: ${budgetPercent}% (${Math.round(tokens / 1000)}k/${Math.round(budgetCeiling / 1000)}k)${graceTag} | KV: ${kvCount}/${MAX_KV_ENTRIES}${wakeTag}`
    );
  }

  // --- Extract First N Turns from Branch History ---
  function extractFirstTurnsBlock(
    ctx: ExtensionContext,
    keepFirstTurns: number
  ): string {
    const clamped = Math.max(0, Math.min(MAX_PINNED_TURNS, keepFirstTurns));
    if (clamped === 0) return "";

    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    const captured: string[] = [];
    let userTurnsSeen = 0;

    for (const entry of branch) {
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
        captured.push(`[Turn ${userTurnsSeen} - ${role.toUpperCase()}]:\n${snippet}`);
      }
    }

    if (captured.length === 0) return "";
    return `<pinned_origin_turns count="${clamped}">\n${captured.join("\n\n")}\n</pinned_origin_turns>\n\n`;
  }

  // --- Trigger Compaction Execution ---
  function executeScheduledCompaction(ctx: ExtensionContext): void {
    if (!state.pendingCompaction || state.isCompacting) return;
    const job = state.pendingCompaction;
    state.isCompacting = true;

    ctx.compact({
      customInstructions: "Self-propagation agent-authored checkpoint.",
      onComplete: () => {
        state.isCompacting = false;
        state.pendingCompaction = null;
        state.overBudgetTurns = 0;
        state.idleCompactWarned = false;
        state.lastActiveAt = Date.now();
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
        state.pendingCompaction = null;
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
          state.pendingCompaction
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
          !state.idleCompactWarned
        ) {
          const idleTargetMs = state.persisted.idleCompactMinutes * 60_000;
          const { budgetPercent } = getBudgetMetrics(ctx);
          if (idleMs >= idleTargetMs && budgetPercent >= 25) {
            state.idleCompactWarned = true;
            state.lastActiveAt = Date.now();
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
  pi.registerTool({
    name: "memory_store",
    label: "Working Memory Store",
    description:
      "Manage persistent key-value notes (key, title, body) that survive across all compactions. Keep entries concise.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("upsert"),
        Type.Literal("delete"),
        Type.Literal("search"),
        Type.Literal("list"),
      ]),
      key: Type.Optional(
        Type.String({ description: `Unique slug key (max ${MAX_KEY_LEN} chars)` })
      ),
      title: Type.Optional(
        Type.String({
          description: `Short searchable header (max ${MAX_TITLE_LEN} chars)`,
        })
      ),
      body: Type.Optional(
        Type.String({
          description: `Compact note content (max ${MAX_BODY_LEN} chars)`,
        })
      ),
      query: Type.Optional(
        Type.String({ description: "Search substring for 'search' action" })
      ),
    }),
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
      "Wipe raw conversation history and replace it with your own structured summary, pinned origin turns, and persistent KV working memory.",
    parameters: Type.Object({
      summary: Type.String({
        description:
          "Comprehensive checkpoint summary of completed work, active file paths, architecture decisions, and remaining tasks. All recent turns will be wiped, so include everything needed to continue.",
      }),
      keepFirstTurns: Type.Optional(
        Type.Number({
          description: `Number of initial user/assistant turns from the start of the session to preserve verbatim (0-${MAX_PINNED_TURNS}, default 1).`,
        })
      ),
      continueAfter: Type.Boolean({
        description:
          "True to automatically resume execution immediately after compaction; False to pause and wait for the user or next wake timer.",
      }),
      nextObjective: Type.Optional(
        Type.String({
          description:
            "When continueAfter is true, the exact immediate action you want to execute first in the fresh context.",
        })
      ),
      memoryUpserts: Type.Optional(
        Type.Array(
          Type.Object({
            key: Type.String(),
            title: Type.String(),
            body: Type.String(),
          }),
          { description: "Optional batch of KV memory notes to save before compacting." }
        )
      ),
      memoryDeletes: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional list of KV memory keys to delete before compacting.",
        })
      ),
    }),
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

      state.pendingCompaction = {
        summary: params.summary,
        keepFirstTurns: params.keepFirstTurns ?? 1,
        continueAfter: params.continueAfter,
        nextObjective: params.nextObjective,
      };

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

  // --- Commands: /propagate and /keep-awake ---
  pi.registerCommand("propagate", {
    description:
      "Opt-in or configure self-propagation for this session: /propagate [on|off|status|budget <0.5-0.95>|idle <minutes>]",
    handler: async (args, ctx) => {
      state.latestCtx = ctx;
      const parts = (args || "").trim().split(/\s+/);
      const sub = (parts[0] || "status").toLowerCase();

      if (sub === "on") {
        state.persisted.enabled = true;
        saveState(ctx);
        syncToolVisibility();
        updateFooterStatus(ctx);
        ctx.ui.notify(
          `Self-propagation ENABLED for session (Budget ceiling: ${Math.round(state.persisted.budgetRatio * 100)}% of model window).`,
          "info"
        );
        return;
      }

      if (sub === "off") {
        state.persisted.enabled = false;
        state.persisted.keepAwakeMinutes = 0;
        state.overBudgetTurns = 0;
        state.pendingCompaction = null;
        saveState(ctx);
        syncToolVisibility();
        updateFooterStatus(ctx);
        ctx.ui.notify("Self-propagation DISABLED for this session.", "info");
        return;
      }

      if (sub === "budget" && parts[1]) {
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

      if (sub === "idle" && parts[1]) {
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

      const { tokens, physicalWindow, budgetCeiling, budgetPercent } =
        getBudgetMetrics(ctx);
      ctx.ui.notify(
        `Self-Propagate: ${state.persisted.enabled ? "ENABLED" : "DISABLED"} | Usage: ${budgetPercent}% (${tokens}/${budgetCeiling}, model max ${physicalWindow}) | KV: ${Object.keys(state.persisted.kv).length}/${MAX_KV_ENTRIES} | KeepAwake: ${state.persisted.keepAwakeMinutes}m | IdleCompact: ${state.persisted.idleCompactMinutes}m`,
        "info"
      );
    },
  });

  pi.registerCommand("keep-awake", {
    description:
      "Toggle keep-awake cron loop for this session: /keep-awake <minutes|off>",
    handler: async (args, ctx) => {
      state.latestCtx = ctx;
      const arg = (args || "").trim().toLowerCase();

      if (!arg) {
        ctx.ui.notify(
          `Keep-awake is currently ${state.persisted.keepAwakeMinutes > 0 ? `ON (${state.persisted.keepAwakeMinutes}m)` : "OFF"}.`,
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
        ctx.ui.notify("Usage: /keep-awake <minutes|off>", "warning");
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
    },
  });

  // --- Lifecycle Hooks ---
  pi.on("session_start", async (_event, ctx) => {
    state.latestCtx = ctx;
    state.isBusy = false;
    state.isCompacting = false;
    state.pendingCompaction = null;
    state.overBudgetTurns = 0;
    state.lastActiveAt = Date.now();
    loadState(ctx);
    syncToolVisibility();
    updateFooterStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    state.latestCtx = ctx;
    state.isBusy = true;
    state.idleCompactWarned = false;
    state.lastActiveAt = Date.now();

    if (!state.persisted.enabled) return;

    const { tokens, budgetCeiling, budgetPercent } = getBudgetMetrics(ctx);

    let budgetDirective = "";
    if (budgetPercent >= 100) {
      state.overBudgetTurns += 1;
      const remainingGrace = Math.max(
        0,
        GRACE_TURNS_AT_100 - state.overBudgetTurns + 1
      );
      if (state.overBudgetTurns <= GRACE_TURNS_AT_100) {
        budgetDirective =
          `\n\n[CRITICAL CONTEXT ALERT — 100% BUDGET REACHED (${tokens}/${budgetCeiling} tokens) — GRACE TURN ${state.overBudgetTurns}/${GRACE_TURNS_AT_100}]\n` +
          `You MUST wrap up your current thought and call \`self_compact\` within ${remainingGrace} turn(s). ` +
          `After turn ${GRACE_TURNS_AT_100}, all tools except \`self_compact\` and \`memory_store\` will be HARD-LOCKED.`;
      } else {
        budgetDirective =
          `\n\n[HARD CONTEXT LOCK ENGAGED — GRACE PERIOD EXPIRED (${state.overBudgetTurns}/${GRACE_TURNS_AT_100} turns over 100%)]\n` +
          `All standard tools are now blocked. You MUST call \`self_compact\` immediately.`;
      }
    } else {
      state.overBudgetTurns = 0;
      if (budgetPercent >= 75) {
        budgetDirective =
          `\n\n[CONTEXT WARNING: ${budgetPercent}% of budget (${tokens}/${budgetCeiling} tokens). ` +
          `Reach a clean checkpoint soon and call \`self_compact\` to free context.]`;
      } else if (budgetPercent >= 50) {
        budgetDirective =
          `\n\n[CONTEXT NOTICE: ${budgetPercent}% of budget (${tokens}/${budgetCeiling} tokens) used.]`;
      }
    }

    updateFooterStatus(ctx);

    const protocolAppend =
      `\n\n## Self-Propagation & Context Protocol\n` +
      `- Persistent Working Memory (${Object.keys(state.persisted.kv).length}/${MAX_KV_ENTRIES} keys): Use \`memory_store\` or \`self_compact.memoryUpserts\` for durable facts.\n` +
      `- When calling \`self_compact\`, all prior turns (except \`keepFirstTurns\`) are wiped. Your \`summary\` must contain all active state, modified files, and next steps.` +
      budgetDirective;

    return {
      systemPrompt: (event.systemPrompt || "") + protocolAppend,
    };
  });

  // Gate tool execution when pending compaction OR when grace turns > 5
  pi.on("tool_call", async (event, ctx) => {
    if (!state.persisted.enabled) return;

    if (state.pendingCompaction && event.toolName !== "memory_store") {
      return {
        block: true,
        reason:
          "self_compact has already been scheduled for the end of this turn. Finish your response immediately so compaction can run.",
      };
    }

    const { budgetPercent } = getBudgetMetrics(ctx);
    if (
      budgetPercent >= 100 &&
      state.overBudgetTurns > GRACE_TURNS_AT_100 &&
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
      tag = `[CRITICAL 100% CONTEXT (${budgetPercent}%) — Grace Turn ${state.overBudgetTurns}/${GRACE_TURNS_AT_100}: CALL self_compact NOW]`;
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
    if (!state.pendingCompaction && event.reason === "threshold") {
      return { cancel: true };
    }

    if (!state.pendingCompaction) return;

    const job = state.pendingCompaction;
    const originBlock = extractFirstTurnsBlock(ctx, job.keepFirstTurns);
    const memoryBlock = renderWorkingMemoryBlock();

    const compositeSummary =
      `${originBlock}` +
      `${memoryBlock}\n\n` +
      `<compaction_summary>\n${job.summary}\n</compaction_summary>`;

    return {
      compaction: {
        summary: compositeSummary,
        // Sentinel ID not matching any prior entry -> buildContextEntries retains 0 tail entries
        firstKeptEntryId: RETAIN_NONE_SENTINEL,
        tokensBefore: event.preparation.tokensBefore,
        details: {
          selfPropagated: true,
          keepFirstTurns: job.keepFirstTurns,
          kvKeys: Object.keys(state.persisted.kv),
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

    if (state.persisted.enabled && state.pendingCompaction) {
      executeScheduledCompaction(ctx);
    }
  });
}