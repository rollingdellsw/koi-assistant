// code-topic:scripts/run.js
//
// The deterministic entry point for the `code-topic` skill.
//
// This file exists so the runnable path never degrades into prompt injection:
// with `runnable: true` and no scripts/run.js, the sidepanel falls back to
// injecting SKILL.md as a plain message and hoping the model calls
// startCodeTopic — which it may not (it may load sandbox-shell and hand-code
// the whole task in the foreground session instead).
//
// args[0] = goal text (required)
// args[1] = budget cap, plain integer (optional; 10M default lives in the tool)
// args[2] = show tools, "true"/"false" (optional; defaults to true)
// args[3] = per-session context window in tokens (optional; the 160k default
//           and the clamp both live in RunTopicRunner, not here)
// args[4] = host project directory (required; `~` is fine — the harness
//           expands it, and nothing upstream of the harness can)

const goal = String(args[0] ?? "").trim();
if (goal === "") {
  return { success: false, reason: "Provide a goal as the first argument." };
}

// The one fact no model upstream can observe. Asked to infer it, a planner
// eventually writes /home/user/... on a machine whose home is /home/yongbing;
// the path is then correctly found absent, the run is declared greenfield, and
// a worker rebuilds the project from scratch in an empty overlay while the real
// tree is never opened. So it is required, and it is passed through untouched —
// no expansion here, where $HOME is just as unknown as it is to the planner.
const projectPath = String(args[4] ?? "").trim();
if (projectPath === "") {
  return {
    success: false,
    reason:
      "Provide project_path: the host directory the project lives in (e.g. " +
      "~/workspace/my-app). There is no default — a code topic with no " +
      "directory has nothing to work on.",
  };
}

// parseInt is too permissive here: "10M" -> 10 and "1e7" -> 1 both pass a
// `> 0` test and would start a run with a budget of ten tokens. Unlike
// session_context there is no clamp downstream, so reject anything that is
// not a plain integer and fall back to the tool's 10M default.
const rawCap = String(args[1] ?? "").replace(/[_,\s]/g, "");
const budgetCap = /^\d+$/.test(rawCap) && Number(rawCap) > 0
  ? Number(rawCap)
  : undefined;

// Live tool trace, on unless explicitly disabled. This is the difference
// between a visible run and a frozen-looking panel; the topic itself behaves
// identically either way.
const streamTools =
  String(args[2] ?? "true").trim().toLowerCase() !== "false";

// Per-session context window, parsed exactly like budget_cap: anything that is
// not a positive integer is dropped rather than forwarded as 0/NaN, so a typo
// falls back to the 160k default instead of starting a run with a nonsense
// window.
const parsedContext = parseInt(
  String(args[3] ?? "").replace(/[_,\s]/g, ""),
  10,
);
const sessionContext =
  Number.isFinite(parsedContext) && parsedContext > 0
    ? parsedContext
    : undefined;

// Blocks until the topic is judged complete, stopped, or the budget runs out.
// `findings` is the accumulated topic memory: the continuity ledger (project,
// sandbox session, outbox path), the ordered patch list, the final build/test
// status, and the work summary.
const result = await tools.startCodeTopic({
  goal,
  project_path: projectPath,
  stream_tools: streamTools,
  ...(budgetCap !== undefined ? { budget_cap: budgetCap } : {}),
  ...(sessionContext !== undefined ? { session_context: sessionContext } : {}),
});

return { success: true, status: result.status, findings: result.findings };
