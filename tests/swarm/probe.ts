import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test probe, loaded AFTER the extension under test. Deterministic ground truth
// with no model call: what tools got registered (with descriptions), and the
// exact message array about to go to the model.
export default function (pi: ExtensionAPI) {
  const fs = require("node:fs");

  pi.on("session_start", async () => {
    // Send path, deterministic and with no model call: pi gives every extension
    // its own API closure and exposes no tool-invocation API (getAllTools returns
    // definitions, no execute), so the harness registers the real extension into a
    // fake API and calls the real execute. That is the code that writes the bus.
    if (process.env.SWARM_TOOL_CALL) {
      const bus = require("node:path").join(process.cwd(), ".pi", "swarm.jsonl");
      const read = () => (fs.existsSync(bus) ? fs.readFileSync(bus, "utf-8") : "");
      const before = read();
      const out: any = { tool: "send_swarm_message", args: { message: process.env.SWARM_TOOL_CALL } };
      try {
        const tools: any = {};
        const fake: any = {
          on: () => {},
          registerCommand: () => {},
          registerTool: (t: any) => (tools[t.name] = t),
          sendUserMessage: () => {},
        };
        const mod = await import(process.env.EXT_UNDER_TEST!);
        mod.default(fake);
        out.result = await tools.send_swarm_message.execute("probe", { message: process.env.SWARM_TOOL_CALL });
        out.appended = read().slice(before.length);
      } catch (e: any) {
        out.error = String(e?.message ?? e);
      }
      fs.writeFileSync(process.env.SWARM_TOOL_OUT || "swarm-send.json", JSON.stringify(out));
      process.exit(0);
    }
    if (!process.env.SWARM_TOOLS) return;
    const tools = ((pi as any).getAllTools?.() || []).map((t: any) => ({ name: t?.name, description: t?.description }));
    fs.writeFileSync(process.env.SWARM_TOOLS, JSON.stringify(tools));
  });

  pi.on("context", async (event: any) => {
    if (!process.env.SWARM_DUMP) return;
    fs.writeFileSync(process.env.SWARM_DUMP, JSON.stringify(event?.messages ?? []));
    process.exit(0); // nothing left to prove; never reach the model
  });
}
