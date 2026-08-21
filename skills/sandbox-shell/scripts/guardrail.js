// ---------------------------------------------------------------------------
// Blocked shell commands
// ---------------------------------------------------------------------------

const BLOCKED_EXEC_COMMANDS = [
  // In-place edits: the overlay changes but the LSP index does not (SKILL.md
  // Golden Rule 3). This is the real port of Deft's "use patch instead of sed".
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
  // ast-grep rewrites land on disk directly: they mutate the overlay without
  // going through sandbox_apply_patch, so the LSP index silently desyncs —
  // exactly the failure mode the sed -i rule above exists to prevent.
  // Interactive mode additionally needs a TTY the sandbox does not have.
  {
    pattern:
      /(?:^|[;&|]\s*)(?:ast-grep|sg)\b[^;&|]*(?:\s-U\b|\s--update-all\b|\s-i\b|\s--interactive\b)/,
    message:
      "ast-grep -U/--update-all writes files without syncing the LSP, and --interactive has no TTY here. " +
      "Preview the change with `ast-grep run -p '<pattern>' --rewrite '<replacement>'`, then apply it with an atomic Python script via sandbox_exec",
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
  // Piping the network straight into a shell defeats the point of the sandbox.
  {
    pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/,
    message: 'Piping downloaded scripts into a shell is not allowed',
  },
  // Recursive delete outside the project, or of the outbox (the outbox is the
  // one path whose writes reach the host).
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/|~|\$HOME|\$KOI_OUTBOX)/,
    message:
      'Recursive delete of the outbox or paths outside the project is not allowed. To discard your work use sandbox_reset',
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
    const name = ctx.tool.name;
    const args = ctx.tool.args || {};

    // -----------------------------------------------------------------------
    // RULE: Trigger overlay FS sync before evaluating mutations
    // -----------------------------------------------------------------------
    const MUTATING_TOOLS = [
      'sandbox_exec',
      'run_command',
    ];
    if (MUTATING_TOOLS.includes(name)) {
      console.log(`[Guardrail] Triggering overlay FS sync before ${name}...`);
      try {
        if (typeof ctx.callTool === 'function') {
          await ctx.callTool('overlay_fs_sync', {});
        } else if (typeof tools !== 'undefined' && typeof tools.overlay_fs_sync === 'function') {
          await tools.overlay_fs_sync({});
        } else if (typeof tools !== 'undefined' && typeof tools.overlayFsSync === 'function') {
          await tools.overlayFsSync({});
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error('[Guardrail] Overlay FS sync failed:', errMsg);
        return { allowed: false, message: `Guardrail blocked action: Overlay sync failed - ${errMsg}` };
      }
    }

    // -----------------------------------------------------------------------
    // RULE 0a: Blocked shell commands
    // -----------------------------------------------------------------------
    if (name === 'sandbox_exec') {
      const cmd = String(args.command || '');
      const trimmed = cmd.trim();

      for (const rule of BLOCKED_EXEC_COMMANDS) {
        if (rule.pattern.test(trimmed) && !(rule.exempt && rule.exempt.test(trimmed))) {
          return { allowed: false, message: `BLOCKED: ${rule.message}.` };
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

    if (ctx.tool.name === 'requestAction') {
        return {
            allowed: false,
            message: "SECURITY BLOCK: You are not supposed to ask for user action via requestAction. Please use chrome-developer-tools or other automated methods."
        };
    }


    return { allowed: true };
  },

  output: async (ctx) => {
    // Sync LSP after successful shell execution so subsequent reads see the mutations
    if (ctx.tool.name === "sandbox_exec" && !ctx.result.isError) {
      try {
        if (typeof ctx.callTool === 'function') {
          await ctx.callTool('overlay_fs_sync', {});
        } else if (typeof tools !== 'undefined' && typeof tools.overlay_fs_sync === 'function') {
          await tools.overlay_fs_sync({});
        } else if (typeof tools !== 'undefined' && typeof tools.overlayFsSync === 'function') {
          await tools.overlayFsSync({});
        }
      } catch (error) {
        console.error('[Guardrail] Post-exec overlay FS sync failed:', error);
      }
    }

    // Anti-pattern 4: Misreporting masked paths
    if (ctx.tool.name === "sandbox_exec" && !ctx.result.isError) {
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