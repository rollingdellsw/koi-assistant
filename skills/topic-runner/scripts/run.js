// topic-runner:scripts/run.js
//
// Thin entry point for the topic-runner skill. Kicks off a long-lived RunTopicRunner
// via the `startRunTopic` bridge tool (registered by LocalBackend when this skill
// is loaded) and returns the accumulated findings.
//
// args[0] — the goal, in plain language.
// args[1] — optional token budget cap (plain integer; defaults to 10M).

const goal = (args[0] || "").trim();
if (goal === "") {
  return {
    success: false,
    reason:
      "Provide a goal as the first argument, e.g. \"do market research on product A\".",
  };
}

// Optional budget cap. Accepts "10000000", "10_000_000", or "10,000,000".
const parsedCap = parseInt(String(args[1] ?? "").replace(/[_,\s]/g, ""), 10);
const budgetCap =
  Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : undefined;

console.info(`Starting topic-runner for goal: ${goal.slice(0, 200)}`);
if (budgetCap !== undefined) {
  console.info(`Token budget cap: ${budgetCap.toLocaleString()} tokens`);
}

// Blocks until the topic completes (judge says done), the user stops it, or the
// budget is exhausted. `findings` is the running topic memory — the deliverable.
const result = await tools.startRunTopic(
  budgetCap !== undefined ? { goal, budget_cap: budgetCap } : { goal },
);

const status = result && typeof result.status === "string" ? result.status : "unknown";
const findings =
  result && typeof result.findings === "string" ? result.findings : "";

console.info(`topic-runner finished with status: ${status}`);

return { success: status === "done", status, findings };
