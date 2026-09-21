// packages/chrome-extension/skills/sandbox-shell/scripts/guardrail-test.js
//
// Run the guardrail case table from the Koi input box:
//
//     /skill sandbox-shell/scripts/guardrail-test.js
//     /skill sandbox-shell/scripts/guardrail-test.js --path /abs/path/to/scripts
//
// The cases and the runner live in `guardrail-test-cases.cjs`; this file only
// finds them on disk and runs them through `sandbox_exec`. One case table, two
// entry points — a copy here would drift from the one the CI/shell run uses,
// and a guardrail test that disagrees with itself is worse than none.
//
// Why it shells out instead of testing in-process: this script runs in the
// sandboxed iframe, which has no filesystem, and `guardrail.js` is a CommonJS
// file inside a `"type": "module"` package — Node cannot `require()` it either.
// The runner reads the source and evaluates it in a CommonJS wrapper, which is
// also how the extension itself loads it.
//
// What it does NOT do: execute any of the commands under test. Every case is
// answered by calling the guardrail's own `input()` hook, so `rm -rf /` is a
// string being classified, never a thing that runs. A black-box variant that
// really executed the allow-cases would delete the user's outbox the moment the
// rules regressed — the test would destroy exactly what it exists to protect.
//
// Scope caveat: this checks the guardrail file ON DISK in the repo, which is
// what you are editing. The extension runs the copy loaded into the profile. If
// you have not reloaded the skill since your last edit, the two differ.

const ARGV = typeof args !== "undefined" ? args : [];

function argValue(flag) {
  const i = ARGV.indexOf(flag);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : null;
}

/** MCP results arrive as {content:[{text}]} here and as a bare string elsewhere. */
function textOf(res) {
  if (res === null || res === undefined) return "";
  if (typeof res === "string") return res;
  if (typeof res.content === "string") return res.content;
  if (Array.isArray(res.content)) return res.content.map((c) => c.text ?? "").join("");
  return JSON.stringify(res);
}

function jsonOf(res) {
  try {
    return JSON.parse(textOf(res));
  } catch {
    return null;
  }
}

/** stdout + stderr of a sandbox_exec, whichever shape the result arrives in. */
function outputOf(res) {
  const body = jsonOf(res);
  if (body && (body.stdout !== undefined || body.stderr !== undefined)) {
    return { stdout: body.stdout ?? "", stderr: body.stderr ?? "", exitCode: body.exitCode };
  }
  return { stdout: textOf(res), stderr: "", exitCode: undefined };
}

// Walk up from the sandbox cwd looking for the scripts directory, then fall
// back to a bounded search of $HOME. The sandbox may be opened on any project,
// including one that is not this repo, so "not found" is a normal answer and
// gets an instruction rather than a stack trace.
const LOCATE = [
  'set -e',
  'P=""',
  'd="$PWD"',
  'while [ "$d" != "/" ]; do',
  '  for c in "$d/packages/chrome-extension/skills/sandbox-shell/scripts" "$d/skills/sandbox-shell/scripts" "$d"; do',
  '    if [ -f "$c/guardrail.js" ] && [ -f "$c/guardrail-test-cases.cjs" ]; then P="$c"; break 2; fi',
  '  done',
  '  d="$(dirname "$d")"',
  'done',
  'if [ -z "$P" ]; then',
  '  f="$(find "$HOME" -maxdepth 8 -type f -name guardrail-test-cases.cjs -not -path "*/node_modules/*" 2>/dev/null | head -n 1)"',
  '  [ -n "$f" ] && P="$(dirname "$f")"',
  'fi',
  'printf "%s" "$P"',
].join('\n');

async function run() {
  console.log("Sandbox guardrail — rule table\n");

  let dir = argValue("--path");
  if (!dir) {
    const located = outputOf(await tools.sandbox_exec({ command: LOCATE, timeout_ms: 60000 }));
    dir = located.stdout.trim();
  }

  if (!dir) {
    console.log(
      "Could not find scripts/guardrail-test-cases.cjs from this sandbox.\n" +
        "Open the repo as the project, or pass the directory:\n" +
        "  /skill sandbox-shell/scripts/guardrail-test.js --path /abs/path/to/scripts",
    );
    return { passed: 0, total: 0, failures: [{ name: "locate", detail: "scripts directory not found" }] };
  }

  console.log(`scripts: ${dir}`);

  const res = outputOf(
    await tools.sandbox_exec({
      command: `node "${dir}/guardrail-test-cases.cjs" --json "${dir}/guardrail.js"`,
      timeout_ms: 120000,
    }),
  );

  const summary = (() => {
    // The runner prints one JSON object on the last non-empty line.
    const lines = `${res.stdout}`.trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* keep looking */
      }
    }
    return null;
  })();

  if (!summary) {
    console.log("The runner produced no JSON summary. Raw output:");
    console.log(res.stdout || "(empty)");
    if (res.stderr) console.log(res.stderr);
    return { passed: 0, total: 0, failures: [{ name: "runner", detail: "no JSON summary" }] };
  }

  for (const f of summary.failures) {
    console.log(`FAIL  ${f.name}`);
    console.log(`      ${f.detail}`);
  }

  console.log(`\n${summary.passed}/${summary.total} checks passed.`);
  if (summary.failures.length === 0) {
    console.log(
      "Note: this tested the guardrail file on disk. If you edited it since the\n" +
        "last skill reload, the extension is still running the older copy.",
    );
  }
  return summary;
}

return run();