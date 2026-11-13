### Architecture & Mechanics

1. **Opt-In Session Gate (**`/propagate on`**)**
   - **Zero overhead when off:** On `session_start`, the extension checks `.pi/memory/<sessionId>.json`. If the session has not opted in, `pi.setActiveTools()` strips `self_compact` and `memory_store` from the active tool declarations (saving schema tokens) and all lifecycle hooks no-op.
   - Running `/propagate on` enables the extension for the current session, persists the flag to `.pi/memory/<sessionId>.json` (surviving `/reload` and `--resume`), and activates the tools and background watchdog.
2. **Model-Relative Context Budget & 5-Turn Grace Lock**
   - Uses `ctx.getContextUsage()` to read the active model's native `contextWindow` and authoritative token count (including system prompt and tool schemas).
    - **Headroom Buffer:** Because hitting 100% of the *physical* model window would cause the LLM provider to reject the 5 grace turns with `context_length_exceeded`, the extension defines your **Effective Budget Ceiling** as `85%` of `ctx.model.contextWindow` by default (configurable via `/propagate budget <0.30-0.95>`).
   - **Tiered escalation against Effective Budget:**
     - **50%:** Appends a one-line telemetry notice to tool results.
     - **75%:** Injects a wrap-up warning advising the agent to checkpoint at the next logical boundary.
      - **100% (Turns 1–5):** Increments `overBudgetTurns` on each `before_agent_start` and injects an urgent `[CRITICAL CONTEXT ALERT — 100% BUDGET REACHED ... GRACE TURN X/5]` directive into the turn context and every tool result.
     - **100% (Turn 6+):** Hard-blocks all tool calls in `tool_call` except `self_compact` and `memory_store`.
3. **Full-Wipe Compaction + Pinned First $N$ Turns + Continuation**
    - When the agent calls `self_compact({ summary, keepFirstTurns, continueAfter, nextObjective, memoryUpserts })`:
      - Any further tool calls in the same turn are blocked so the turn settles cleanly.
      - On `agent_end`, `ctx.compact()` fires and `session_before_compact` returns a custom compaction entry with `firstKeptEntryId: "__self_propagate_retain_none__"` (a sentinel matching no prior entry, so zero tail entries are retained).
      - The pinned origin turns are extracted from the session branch and baked into `<pinned_origin_turns>` at the top of the compaction checkpoint, followed by `<working_memory>` and `<compaction_summary>`. Each pinned turn is capped at **12,000 chars** (~3k tokens) so a full initial spec survives intact.
      - **Turn 1 can never be dropped:** `keepFirstTurns` is clamped to a hard floor of `minPinnedTurns` (default **1**) in `extractFirstTurnsBlock()`. The agent may pin *more* turns (up to 4) but passing `0` is clamped, not honoured.
      - **Pinning starts at the session root by default**, or at an anchor set with `/propagate on here` — which snapshots the latest user message's entry id into `.pi/memory/<sessionId>.json` (`anchorEntryId`) and pins from there, so enabling mid-session anchors the *current* goal instead of Turn 1 of the session file.
     - In `onComplete`, if `continueAfter: true`, the extension dispatches `pi.sendUserMessage(..., { deliverAs: "steer" })` to immediately resume work on `nextObjective`.
4. **Capped Title + Body KV Store (**`.pi/memory/<sessionId>.json`**)**
   - Each entry stores `{ key, title, body, updatedAt }` with strict caps: max **25 entries**, `key <= 48` chars, `title <= 100` chars, `body <= 1,200` chars, and **16,000 chars total store size**.
   - Exposed via a single `memory_store` tool (`upsert`, `delete`, `search`, `list`) and inline `memoryUpserts` inside `self_compact`.
5. **Keep-Awake Cron & Idle-Compaction Watchdog**
   - Managed by a `globalThis` singleton timer (preventing duplicate loops on `/reload`) that only fires when `enabled && !isBusy && !isCompacting`.
   - When `/keep-awake <minutes>` is active, idle sessions receive a `<keep_awake_tick>` steer message every $X$ minutes.
   - When `/keep-awake` is `off`, if the session sits idle for `15` minutes with context usage $\\ge 25\\%$ of budget, it wakes the agent once (`idleCompactWarned = true`) to run `self_compact({ continueAfter: false })`.

