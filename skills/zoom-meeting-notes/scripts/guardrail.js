// scripts/guardrail.js — Prevent manual LLM DOM inspection during Zoom capture
// The LLM must delegate all capture to capture.js, not poke at the DOM directly.
// Tool names here are the LLM-facing snake_case names (not the script camelCase).
module.exports = {
  input: async (ctx) => {
    // Block the LLM from manually inspecting the obfuscated Zoom DOM.
    // Note: capture.js calls these internally via tools.* — guardrails only
    // intercept direct LLM tool calls, not calls from within a running script.
    const forbiddenTools = ["take_screenshot", "search_dom", "take_snapshot"];
    if (forbiddenTools.includes(ctx.tool.name)) {
      return {
        allowed: false,
        message: "Manual DOM inspection is prohibited during Zoom capture. Use the capture.js script."
      };
    }
    return { allowed: true };
  }
};
