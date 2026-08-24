---
name: topic-runner
description: Run a long-lived, multi-session, read-only autonomous task from a single natural-language goal.
runnable: true
allowed-tools:
  - startRunTopic
parameters:
  - name: goal
    description: The task to run, in plain language. Be as specific as you like about what "done" looks like and what to collect — the judge uses it to decide when to stop.
    prompt: true
    required: true
  - name: budget_cap
    description: Maximum total tokens to spend across all worker/judge/curator sessions before pausing to ask whether to continue. Plain integer (e.g. 10000000 for 10M). Defaults to 10000000. On reaching the cap the runner asks the user whether to extend.
    required: false
    default: "10000000"
---

# Run Topic

A generic long-running task runner. You give it a **goal** in plain language and
it runs autonomously across as many sessions as needed, accumulating findings in
a durable topic memory that is returned as the result.

## When to use it

Reach for `topic-runner` when the work is **open-ended and bigger than one pass**:

- Research/synthesis: _"Do competitive market research on product A — competitors, pricing, key feature gaps, with sources."_
- Collection/aggregation: _"Collect every open bug, code review, email thread, and doc relevant to the Q3 launch for a weekly status report."_
- Summarization at scale: _"Summarize all my emails from the last week, grouped by sender and topic."_

Do **not** use it for single-step lookups (just answer directly) or for anything
that changes state — it is read-only on purpose.

## How it works

1. A worker session pursues the goal using read/navigate tools and by composing
   your existing skills ("skill of skills"), then reports its findings.
2. A curator appends those findings to the running topic memory **verbatim**.
3. An **LLM judge** scores the accumulated findings against the goal and returns
   one of: **complete** (done), **continue** (more to gather), or **need_user**
   (it pauses and asks you a question — answer it, or tell it to stop).
4. Steps 1–3 repeat until the judge says complete, you stop it, or the token
   budget runs out (you'll be asked whether to extend).

## Running it

```javascript
// args[0] is the goal text.
const goal = (args[0] || "").trim();
if (goal === "") {
  return { success: false, reason: "Provide a goal as the first argument." };
}

// args[1] (optional) is the token budget cap. Defaults to 10M if absent/invalid.
const parsedCap = parseInt(String(args[1] ?? "").replace(/[_,\s]/g, ""), 10);
const budgetCap =
  Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : undefined;

// Kicks off the topic and blocks until it finishes. The returned `findings`
// string is the accumulated answer (topic memory) — summarize it for the user.
const result = await tools.startRunTopic(
  budgetCap !== undefined ? { goal, budget_cap: budgetCap } : { goal },
);

return { success: true, status: result.status, findings: result.findings };
```

The call returns when the topic finishes, with `{ status, findings }` where
`status` is `"done" | "stopped" | "exhausted"`. Present the `findings` to the
user as the deliverable.
