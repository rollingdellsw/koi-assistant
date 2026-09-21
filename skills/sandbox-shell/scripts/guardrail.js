// ---------------------------------------------------------------------------
// Command segmentation
// ---------------------------------------------------------------------------

/**
 * Drop the BODY of every heredoc before the command is segmented.
 *
 * A heredoc body is data, not commands: `cat > notes.md <<'EOF' ... EOF` and the
 * skill's own `python3 - <<'PY' ... PY` edit pattern routinely contain lines
 * that read exactly like blocked commands, and scanning them blocks the WRITE
 * of a file for its content. That is the worst kind of false positive here,
 * because the agent is told its edit was blocked for a policy reason and has no
 * way to see which line of the payload did it.
 *
 * A heredoc fed to a SHELL (`bash <<EOF`) is kept, because there the body
 * really is the command list. An unterminated heredoc is also kept: if the
 * delimiter never appears, we cannot tell body from command, so we scan it all.
 */
function stripHeredocBodies(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!m) continue;
    const delim = m[2];
    const feedsShell = /(?:^|[;&|]\s*)(?:sudo\s+)?(?:ba|z|da|k)?sh\b/.test(line);
    let j = i + 1;
    const body = [];
    while (j < lines.length && lines[j].trim() !== delim) { body.push(lines[j]); j++; }
    if (j >= lines.length) continue; // unterminated: keep scanning everything
    if (feedsShell) out.push(...body);
    out.push(lines[j]);
    i = j;
  }
  return out.join('\n');
}

/**
 * Split a command line into the individual commands it runs, respecting quotes.
 *
 * Every rule below is written to match a single command, and most anchor on
 * `^` or a `[;&|]` separator to approximate that. Doing the split properly once
 * is both stricter (a rule anchored on `^` now sees the second command of
 * `cat a; less b`, which it previously missed) and less noisy: a separator
 * INSIDE a quoted string — `rg 'foo|rm -rf /'` — is no longer treated as the
 * start of a new command, which is what makes those anchors misfire today.
 */
function splitSegments(cmd) {
  const out = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      buf += c;
      if (c === '\\' && quote === '"') { buf += cmd[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '\\') { buf += c + (cmd[++i] ?? ''); continue; }
    if (c === ';' || c === '&' || c === '|' || c === '\n') {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Every way the outbox is named in practice: the env var (bare, braced, or
 * quoted), the bwrap bind path, and the host path handed out by sandbox_info
 * (`~/.koi/<...>/outbox`). All three appear in real transcripts, and the host
 * form is the one that survives KOI_OUTBOX being pointed at the host path.
 */
const OUTBOX_REF =
  String.raw`(?:\$\{?KOI_OUTBOX\}?|/tmp/koi/outbox|[^\s"';]*\.koi/[^\s"';]*outbox)`;

// ---------------------------------------------------------------------------
// Blocked shell commands
// ---------------------------------------------------------------------------

const BLOCKED_EXEC_COMMANDS = [
  // In-place stream edits are unverifiable: they either match or silently do
  // nothing, and the model cannot tell which without a second read. This is the
  // real port of Deft's "use patch instead of sed".
  {
    pattern:
      /(?:^|[;&|]\s*)(?:sed[^|;&]*\s-i\b|perl[^|;&]*\s-[a-z]*i[a-z]*\b|ex\s+-s\b)/,
    message:
      "In-place stream edits (sed -i / perl -i) are error-prone. Use an atomic Python replacement via sandbox_exec",
  },
  // Interactive programs have no tty here; they hang until timeout_ms.
  {
    pattern: /^(vi|vim|nvim|nano|emacs|less|more|top|htop|watch|man)\b/,
    message:
      "Interactive/pager programs have no TTY in the sandbox and will hang until timeout. Use cat/sed -n, or pipe through 'cat'",
  },
  // ast-grep's interactive mode needs a TTY the sandbox does not have, so it
  // hangs until timeout_ms. -U/--update-all is NOT blocked: it is an ordinary
  // overlay write now that nothing indexes the tree behind the shell's back.
  {
    pattern:
      /(?:^|[;&|]\s*)(?:ast-grep|sg)\b[^;&|]*(?:\s-i\b|\s--interactive\b)/,
    message:
      "ast-grep --interactive has no TTY here and will hang until timeout. " +
      "Preview the change with `ast-grep run -p '<pattern>' --rewrite '<replacement>'`, then apply it with `-U` or an atomic Python script via sandbox_exec",
  },
  // Existing rules, kept.
  {
    pattern: /(?:^|[;&|]\s*)(?:npm install [a-zA-Z]|cargo add|pip install)/,
    message:
      'Global package caches are read-only. To add dependencies, edit package.json or Cargo.toml via sandbox_exec, then run the standard build command',
  },
  {
    pattern: /(?:^|[;&|]\s*)git\s+push\b/,
    message:
      'git push is blocked by policy and credentials are masked. Ship changes using: git format-patch -o "$KOI_OUTBOX" <base>..HEAD',
  },
  {
    // Anchored per-command so `npm run build && npm run dev` still blocks, and
    // the sub-pattern itself excludes the build invocations.
    pattern:
      /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?dev\b|cargo\s+watch\b|next\s+dev\b|(?:npx\s+)?(?:vite|webpack)(?!\s+build)\b)/,
    message:
      'Do not run long-lived dev servers or watchers using sandbox_exec (the process will die). Use sandbox_start_service instead',
  },
  // Unresolved placeholder strings like <base> or <sha> in git format-patch / git diff.
  {
    pattern: /(?:^|[;&|]\s*)git\s+(?:format-patch|diff)\b.*<[a-zA-Z_-]+>/,
    message:
      'Do not use literal placeholder strings like <base> or <sha> in git format-patch / diff. ' +
      'Resolve the exact base commit SHA (e.g. via git rev-parse HEAD at session start) first',
  },
  // Piping the network straight into a shell defeats the point of the sandbox.
  // `whole: true` because the pipe IS the pattern: this is the one rule whose
  // match spans two commands, so it must see the line, not a single stage.
  {
    whole: true,
    pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/,
    message: 'Piping downloaded scripts into a shell is not allowed',
  },
  // Recursive delete outside the project, or of the outbox (the outbox is the
  // one path whose writes reach the host).
  {
    // Two changes over the `\brm` spelling this replaces: the quote is part of
    // the idiom (`rm -rf "$HOME"`) so it must be optional, and the rule now
    // anchors at the start of a command, so searching FOR the string —
    // `rg 'foo|rm -rf /'` — is no longer blocked as if it were running it.
    pattern: /^(?:sudo\s+)?rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+["']?(\/|~|\$\{?HOME\}?|\$\{?KOI_OUTBOX\}?)/,
    message:
      'Recursive delete of the outbox or paths outside the project is not allowed. To discard your work use sandbox_reset',
  },
  // -------------------------------------------------------------------------
  // The outbox is the ONLY path whose writes reach the host, so a sweep there
  // destroys the delivery itself rather than a scratch file — and the agent
  // cannot tell afterwards, because a missing patch and a patch never written
  // look identical. SKILL.md tells the agent exactly one deletion is sanctioned
  // (the sha-stamped bundle rotation) and that everything else is blocked; this
  // rule is what makes that sentence true.
  // -------------------------------------------------------------------------
  {
    pattern: new RegExp(String.raw`^(?:rm|shred|truncate)\b[^\n]*` + OUTBOX_REF),
    // The rotation from SKILL.md, and only that: one -f, one glob, nothing
    // chained. `exempt` is matched against the SAME single segment, so an
    // extra command cannot ride along behind a sanctioned one.
    exempt: new RegExp(
      String.raw`^rm\s+-f\s+["']?(?:\$\{?KOI_OUTBOX\}?|/tmp/koi/outbox|[^\s"';]*\.koi/[^\s"';]*outbox)["']?/project-\*\.bundle$`,
    ),
    message:
      'Deleting files in the outbox is not allowed: it is the only path whose writes reach the user, ' +
      'and a removed artifact is indistinguishable from one that was never exported. ' +
      'The single sanctioned deletion is the bundle rotation, exactly as written in the skill: ' +
      'rm -f "$KOI_OUTBOX"/project-*.bundle. ' +
      'If something already in the outbox looks wrong, say so in your report instead of removing it',
  },
  {
    // `mv <outbox>/... <elsewhere>` is a delete with extra steps. Only the
    // FIRST operand is checked, so moving a file INTO the outbox (the normal
    // way to deliver something git did not write) stays allowed.
    pattern: new RegExp(String.raw`^mv\b(?:\s+-[^\s]+)*\s+["']?` + OUTBOX_REF),
    message:
      'Moving files OUT of the outbox removes them from the user\'s only delivery path. ' +
      'Copy them instead (cp) if you need a working copy elsewhere',
  },
  {
    pattern: new RegExp(String.raw`^find\b[^\n]*` + OUTBOX_REF + String.raw`[^\n]*\s-(?:delete|exec\s+rm)\b`),
    message:
      'Bulk deletion under the outbox is not allowed — see the rm rule. ' +
      'Report what looks stale instead of removing it',
  },
];

/** Credential-shaped files: masked ones are handled by the server, these are not. */
const PROTECTED_PATTERNS = [
  // .env.example / .env.sample / .env.template are checked-in templates with no
  // secrets — reading them is how the agent learns which vars a build needs.
  /(?:^|[/\s"'])\.env(?!\.(?:example|sample|template|dist|schema))(?:\.[\w-]+)?(?:$|[\s"'])/,
  /id_rsa|id_ed25519/,
  /\.pem(?:$|[\s"'])/,
  /(?:^|[/\\])secrets?\.(?:json|ya?ml)(?:$|[\s"'])/i,
  // `credentials` only as a path segment — a bare word match blocks
  // `grep -rn credentials src/`.
  /\.npmrc|\.pypirc|[\w~.-]*\/credentials(?:$|[\s"'])/,
];

// ---------------------------------------------------------------------------

module.exports = {
  input: async (ctx) => {
    // Optional all the way down. The loader DRY-RUNS both hooks with a dummy
    // context before activating a guardrail, and a throw there means the
    // guardrail is never installed at all — skill-scoped hooks also always
    // fail OPEN, so every rule in this file would silently stop applying while
    // the skill kept promising them. Cheap defensiveness buys the difference
    // between "this rule blocked nothing" and "nothing blocked anything".
    const name = ctx?.tool?.name;
    const args = ctx?.tool?.args || {};

    // -----------------------------------------------------------------------
    // RULE 0a: Blocked shell commands
    // -----------------------------------------------------------------------
    if (name === 'sandbox_exec') {
      const cmd = String(args.command || '');
      const trimmed = cmd.trim();

      // Rules are evaluated per command, not per line: `a && rm -rf "$KOI_OUTBOX"`
      // must block on its second command, and an exemption granted to one
      // command must not cover the one chained behind it. A rule marked
      // `whole` opts out because its match legitimately spans a pipe.
      const segments = splitSegments(stripHeredocBodies(trimmed));
      for (const rule of BLOCKED_EXEC_COMMANDS) {
        for (const target of rule.whole ? [trimmed] : segments) {
          if (rule.pattern.test(target) && !(rule.exempt && rule.exempt.test(target))) {
            return { allowed: false, message: `BLOCKED: ${rule.message}.` };
          }
        }
      }

      // Reading a credential file into the transcript exfiltrates it into the
      // LLM context even though the host tree itself is read-only.
      if (PROTECTED_PATTERNS.some((p) => p.test(cmd))) {
        return {
          allowed: false,
          message:
            'SECURITY BLOCK: This command touches a credential-shaped file (.env, SSH key, .pem, secrets.*). ' +
            'Do not read or write these. If a build genuinely needs host credentials, ask the user to restart ' +
            'the MCP server with --allow-creds.',
        };
      }
    }

    if (name === 'requestAction') {
        return {
            allowed: false,
            message: "SECURITY BLOCK: You are not supposed to ask for user action via requestAction. Please use chrome-developer-tools or other automated methods."
        };
    }


    return { allowed: true };
  },

  output: async (ctx) => {
    // Anti-pattern 4: Misreporting masked paths
    if (ctx?.tool?.name === "sandbox_exec" && !ctx?.result?.isError) {
      // Defensive reads: the output hook runs for EVERY tool, and args/content
      // are not guaranteed to be present. An unguarded read here throws inside
      // the guardrail, which surfaces as an opaque agent-loop termination.
      const cmd = String(ctx.tool.args?.command ?? "");
      const content = String(ctx.result?.content ?? "");

      // Only claim "masked" when the command actually touched a masked path.
      //
      // Two things make the naive check wrong:
      //  1. $KOI_OUTBOX resolves to /tmp/koi/outbox and the sandbox's own
      //     scratch space is /tmp/koi — both are fully readable/writable. A
      //     bare /tmp match therefore flags paths the skill itself hands out.
      //  2. "No such file or directory" is matched anywhere in the output, so
      //     a compound command whose LATER stage prints it (a build, a test
      //     runner) gets its SUCCESSFUL earlier stage overridden with a
      //     security error.
      //
      // Net effect of the old rule: a working command was reported as blocked,
      // and the agent was instructed to tell the user a path that exists is
      // masked. Require a real masked path AND a co-located failure.
      const MASKED = [
        // /tmp, but NOT the sandbox's own /tmp/koi tree.
        /(?:^|[\s"'=:])\/tmp\/(?!koi(?:\/|\b))/,
        /(?:^|[\s"'=:~])[^\s"']*\/\.ssh(?:\/|\b)/,
        /(?:^|[\s"'=:~])[^\s"']*\/\.aws(?:\/|\b)/,
        /(?:^|[\s"'=:~])[^\s"']*\/\.npmrc\b/,
        /(?:^|[\s"'=:~])[^\s"']*\/\.bash_history\b/,
        /(?:^|[\s"'=:~])[^\s"']*\/\.docker(?:\/|\b)/,
      ];
      const touchesMasked = MASKED.some((p) => p.test(cmd));
      // The error must name a masked path too, so an unrelated downstream
      // "No such file or directory" cannot hijack the result.
      const failedOnMasked =
        /No such file or directory|Permission denied/.test(content) &&
        MASKED.some((p) => p.test(content));

      if (touchesMasked && failedOnMasked) {
        return {
          override: true,
          isError: true,
          result: "BLOCKED BY GUARDRAIL: This path is masked from the sandbox for security. Do NOT report it as missing to the user; state explicitly that it is masked."
        };
      }
    }

    return { override: false };
  }
};