# code-topic (human docs)

Human-facing documentation for the `code-topic` skill. It lives here rather
than in `SKILL.md` because the SKILL.md body is injected into the model's
context: architecture notes and "requirements" read as instructions and pull
the main session into doing the engineering itself.

## What it is

A generic long-running **engineering** task runner. You give it a **goal** in
plain language and it runs autonomously across as many sessions as needed:
navigating, editing, building, testing, and browser-verifying inside the host
**sandbox**, accumulating its work as an ordered **git patch series** in the
sandbox outbox plus curated topic memory.

Your machine is never modified directly: workers edit a sandbox overlay over a
read-only view of the host, and the host tree changes only when **you** review
and `git am` the exported patches.

## When to use it

Reach for `code-topic` when the work is engineering and bigger than one pass:

- _"Duplicate the UI of https://example.com/dashboard as a new React (Vite)
  app in ~/workspace/dash-clone. Mock the data. Done = builds clean, dev
  server renders the page list and detail views visually close to the
  original."_
- _"Port src/legacy/parser.py to Rust in ~/workspace/parser-rs with tests
  matching the Python fixtures."_
- _"Add dark mode across the app in ~/workspace/myapp; all existing tests
  stay green."_

Do **not** use it for single-file edits (use the sandbox-shell skill
interactively) or for research/collection goals (use `topic-runner`, which is
read-only).

## Requirements

- The **Koi Gateway** running with the `sandbox` server (see the Skill API
  docs, §7.4–7.5), on Linux/WSL2 for full isolation.
- The **sandbox-shell** skill installed — workers load it for their tools.
- The target **host directory must exist** (an empty dir is fine for a new
  project); workers cannot create host directories.
- For UI goals: the sandbox in `--net host` mode so the browser can verify
  the dev server at `localhost:<port>`.

## How it works

1. A **planner** (the only role that can ask you questions) fixes the scope
   and a checkable definition of done: the build command that must exit 0,
   the tests that must pass, the pages that must visually match.
2. A **worker session** loads sandbox-shell, reattaches the topic's overlay
   (the continuity ledger in topic memory pins the sandbox session across
   context windows), edits, builds, tests, browser-verifies, commits, and
   **exports patches to the outbox before ending — every session**, finished
   or not.
3. A **curator** carries the continuity ledger, cumulative patch list, status,
   decisions, and dead ends forward verbatim into topic memory.
4. An **LLM judge** reads the report and memory and rules **complete** only on
   evidence — green build/test exit codes and exported patches — else
   **continue** (with concrete gaps) or **need_user** (it pauses and asks you).
5. Steps 2–4 repeat until complete, you stop it, or the budget runs out
   (you'll be asked whether to extend).

One code topic at a time: the sandbox holds a single live session state.

## Invoking it directly

Bypassing the LLM entirely (the human path):

```
/skill code-topic/scripts/run.js --full-auto
```

`args[0]` is the goal text, `args[1]` the optional token budget cap. The Run
button on the skill card uses the same `scripts/run.js` entry point.

## Reviewing the result

```
cd <project> && git am <outbox>/*.patch     # review the patches first!
```

Treat the patches like a pull request from an autonomous contributor: review
before applying. Nothing on the host changes until you do.
