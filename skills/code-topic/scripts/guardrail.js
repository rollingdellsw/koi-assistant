// code-topic:scripts/guardrail.js
//
// Structural backstop for the failure mode this skill is most prone to: the
// main session reads SKILL.md, loads sandbox-shell, and hand-codes the goal
// itself — no planner, no judge, no curator, no cross-session memory, no
// budget, and every mutating tool call stopping for a confirmation prompt.
//
// Until startCodeTopic has actually run, this session may not touch the
// sandbox. Worker sessions spawned by the topic are separate sessions with
// their own guardrail (CODING_GUARDRAIL_SCRIPT), so they are unaffected.

let topicStarted = false;

const SANDBOX_TOOL = /^sandbox_/;
const CODE_NAV_TOOL =
  /^(search|search_ast|read_ast_node|get_references|get_hover|get_implementation|get_file_structure|get_lsp_diagnostics|sync_document|close_document|sync_reset)$/;

const HANDOFF =
  "code-topic does not do the work in this session. Call " +
  "startCodeTopic({ goal }) with the user's goal — it runs the planner, " +
  "worker, judge and curator loop in the sandbox and returns the result.";

function requestedSkill(args) {
  if (args === undefined || args === null) return "";
  return String(args.name ?? args.skill ?? args.skill_name ?? "");
}

module.exports = {
  input: async (ctx) => {
    const name = ctx.tool.name;

    // The handoff itself, and anything after it, is always allowed.
    if (name === "startCodeTopic" || topicStarted) return { allowed: true };

    if (name === "readSkill" && requestedSkill(ctx.tool.args) === "sandbox-shell") {
      return {
        allowed: false,
        message:
          "Loading sandbox-shell here is blocked: the topic's own workers load " +
          "it. " +
          HANDOFF,
      };
    }

    if (SANDBOX_TOOL.test(name) || CODE_NAV_TOOL.test(name)) {
      return {
        allowed: false,
        message: `${name} is blocked before the topic starts. ${HANDOFF}`,
      };
    }

    return { allowed: true };
  },

  output: async (ctx) => {
    // Latch open once the topic has run, so follow-up work in this session
    // (inspecting the outbox, a quick fix on top) is not blocked.
    if (ctx.tool.name === "startCodeTopic") topicStarted = true;
    return { override: false };
  },
};
