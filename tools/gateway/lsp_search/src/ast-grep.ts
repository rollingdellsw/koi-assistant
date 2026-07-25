/**
 * Tree-sitter engine (ast-grep CLI wrapper)
 *
 * The middle tier of code navigation:
 *
 *   LSP         semantic — knows `User` in a.ts is the same type as in b.ts.
 *               Needs a language server, a resolvable project, and a warm
 *               index. Times out on cold Rust/C++, gives up on broken code.
 *   tree-sitter syntactic — knows exactly where `class User` starts and ends.
 *               No index, no dependencies, works on a file with a syntax error
 *               three lines above. Answers in milliseconds.
 *   ripgrep     text — no structure at all.
 *
 * These are complementary, not competing: LSP is the brain, tree-sitter is the
 * eyes. LSP tells you a symbol is on line 450; tree-sitter tells you the node
 * spans lines 450-612, which is what you actually need to read or patch it
 * without dumping a 3,000-line file into the context window.
 *
 * We shell out to `ast-grep` rather than linking a parser in-process:
 * node-tree-sitter needs node-gyp plus a grammar module per language, and
 * @ast-grep/napi pins us to a prebuilt-platform matrix. The gateway is
 * installed by users on machines we do not control, so a native build step is
 * a support burden. The text tier already shells out to `rg`; this is the same
 * detect-or-degrade shape.
 *
 * ast-grep is therefore OPTIONAL. Every entry point here degrades to an
 * install hint, and no existing tool changes behaviour when it is absent.
 *
 * READ-ONLY. `ast-grep --update-all` rewrites the host tree and would bypass
 * the sandbox overlay, so no rewrite path is exposed here (and the skill
 * guardrail blocks it in the shell too). Structural *edits* are made by
 * feeding an exact node range to sandbox_apply_patch.
 */

import { spawn } from "child_process";
import * as path from "path";
import { printDebug } from "./utils/log.js";
import { resolveTool, toolEnv } from "./tool-path.js";

// ============================================================================
// Binary discovery
// ============================================================================

/**
 * `ast-grep`, not the shorter `sg` alias: on Linux `sg` is also the setgid
 * shell from shadow-utils and resolving it is a coin flip.
 *
 * Resolved through tool-path so an `npm install -g` under nvm/fnm — which puts
 * the binary next to the node executable rather than in /usr/bin — is found
 * even when the gateway runs as a service with a stripped PATH.
 */
function astGrepBinary(): string {
  const override = process.env["KOI_AST_GREP_BIN"];
  if (override !== undefined && override.length > 0) return override;
  return resolveTool("ast-grep") ?? "ast-grep";
}

export const AST_GREP_INSTALL_HINT = `Structural search needs the 'ast-grep' CLI (tree-sitter based). Install one of:
  npm install -g @ast-grep/cli        # provides 'ast-grep' (and an 'sg' alias)
  brew install ast-grep
  cargo install ast-grep --locked
Then restart the Koi Gateway. Set KOI_AST_GREP_BIN to an absolute path if it is not on PATH.`;

export interface AstGrepProbe {
  available: boolean;
  version?: string;
  error?: string;
}

let probeCache: { probe: AstGrepProbe; at: number } | undefined;
const PROBE_TTL_MS = 60_000;

export async function detectAstGrep(force = false): Promise<AstGrepProbe> {
  const now = Date.now();
  if (
    !force &&
    probeCache !== undefined &&
    now - probeCache.at < PROBE_TTL_MS
  ) {
    return probeCache.probe;
  }

  let probe: AstGrepProbe;
  try {
    const res = await runProcess(astGrepBinary(), ["--version"], {
      timeoutMs: 5_000,
    });
    probe =
      res.code === 0
        ? { available: true, version: res.stdout.trim() }
        : { available: false, error: res.stderr.trim() || `exit ${res.code}` };
  } catch (error) {
    probe = { available: false, error: (error as Error).message };
  }

  probeCache = { probe, at: now };
  return probe;
}

// ============================================================================
// Language mapping
// ============================================================================

const EXT_TO_AST_LANG: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
};

/** ProjectDetector's LanguageID -> ast-grep language id. */
const PROJECT_LANG_TO_AST_LANG: Record<string, string> = {
  typescript: "ts",
  python: "python",
  rust: "rust",
  go: "go",
  java: "java",
  cpp: "cpp",
};

export function astLangForExtension(ext: string): string | undefined {
  return EXT_TO_AST_LANG[ext.replace(/^\./, "").toLowerCase()];
}

export function astLangForFile(filePath: string): string | undefined {
  return astLangForExtension(path.extname(filePath));
}

export function astLangForProjectLanguage(
  language: string,
): string | undefined {
  return PROJECT_LANG_TO_AST_LANG[language];
}

// ============================================================================
// Declaration node kinds
// ============================================================================
//
// Every kind below was verified against the grammar ast-grep ships (an unknown
// kind is a hard rule-parse error, not a silent no-match — so this table must
// stay accurate; `js` genuinely has no interface_declaration, for example).
//
// Name matching is `has: { field: "name" }`, which holds for every grammar
// except C/C++, where a function's identifier hangs off the declarator instead.

export type DefGroup =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "module";

interface KindSpec {
  kind: string;
  group: DefGroup;
  /** How the declaration's name is reached. Default: a `name` field. */
  nameVia?: "field" | "declarator";
}

const TS_KINDS: KindSpec[] = [
  { kind: "function_declaration", group: "function" },
  { kind: "generator_function_declaration", group: "function" },
  { kind: "method_definition", group: "function" },
  { kind: "function_signature", group: "function" },
  { kind: "class_declaration", group: "class" },
  { kind: "abstract_class_declaration", group: "class" },
  { kind: "interface_declaration", group: "interface" },
  { kind: "type_alias_declaration", group: "type" },
  { kind: "enum_declaration", group: "enum" },
  { kind: "variable_declarator", group: "variable" },
  { kind: "public_field_definition", group: "variable" },
];

const JS_KINDS: KindSpec[] = [
  { kind: "function_declaration", group: "function" },
  { kind: "generator_function_declaration", group: "function" },
  { kind: "method_definition", group: "function" },
  { kind: "class_declaration", group: "class" },
  { kind: "variable_declarator", group: "variable" },
  { kind: "field_definition", group: "variable" },
];

const C_KINDS: KindSpec[] = [
  { kind: "function_definition", group: "function", nameVia: "declarator" },
  { kind: "struct_specifier", group: "class" },
  { kind: "union_specifier", group: "class" },
  { kind: "enum_specifier", group: "enum" },
  { kind: "type_definition", group: "type" },
];

const DEF_KINDS: Record<string, KindSpec[]> = {
  ts: TS_KINDS,
  tsx: TS_KINDS,
  js: JS_KINDS,
  jsx: JS_KINDS,
  python: [
    { kind: "function_definition", group: "function" },
    { kind: "class_definition", group: "class" },
  ],
  rust: [
    { kind: "function_item", group: "function" },
    { kind: "function_signature_item", group: "function" },
    { kind: "struct_item", group: "class" },
    { kind: "union_item", group: "class" },
    { kind: "trait_item", group: "interface" },
    { kind: "enum_item", group: "enum" },
    { kind: "type_item", group: "type" },
    { kind: "const_item", group: "variable" },
    { kind: "static_item", group: "variable" },
    { kind: "macro_definition", group: "function" },
    { kind: "mod_item", group: "module" },
  ],
  go: [
    { kind: "function_declaration", group: "function" },
    { kind: "method_declaration", group: "function" },
    { kind: "type_spec", group: "class" },
    { kind: "const_spec", group: "variable" },
    { kind: "var_spec", group: "variable" },
  ],
  java: [
    { kind: "method_declaration", group: "function" },
    { kind: "constructor_declaration", group: "function" },
    { kind: "class_declaration", group: "class" },
    { kind: "record_declaration", group: "class" },
    { kind: "interface_declaration", group: "interface" },
    { kind: "annotation_type_declaration", group: "interface" },
    { kind: "enum_declaration", group: "enum" },
    { kind: "variable_declarator", group: "variable" },
  ],
  cpp: [
    ...C_KINDS,
    { kind: "class_specifier", group: "class" },
    { kind: "namespace_definition", group: "module" },
    { kind: "alias_declaration", group: "type" },
    { kind: "concept_definition", group: "type" },
  ],
  c: C_KINDS,
};

export function supportsDefinitionLookup(lang: string): boolean {
  return DEF_KINDS[lang] !== undefined;
}

/** Identifiers only: the name is interpolated into a rule regex. */
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isSafeSymbolName(name: string): boolean {
  return SAFE_IDENTIFIER.test(name);
}

type RuleObject = Record<string, unknown>;

function nameRules(spec: KindSpec, nameRegex: string): RuleObject[] {
  if (spec.nameVia === "declarator") {
    // C/C++: function_definition -> function_declarator -> identifier, or
    // field_identifier for a method defined inside a class body.
    return ["identifier", "field_identifier"].map((idKind) => ({
      kind: spec.kind,
      has: {
        kind: "function_declarator",
        has: { kind: idKind, regex: nameRegex },
      },
    }));
  }
  return [{ kind: spec.kind, has: { field: "name", regex: nameRegex } }];
}

/**
 * Build one inline-rule document per DefGroup. ast-grep echoes `ruleId` on
 * every match, which is the only channel that survives the JSON boundary — so
 * the group is encoded in the id rather than inferred afterwards.
 */
function buildDefinitionRules(
  lang: string,
  name: string,
  groups?: DefGroup[],
): string | undefined {
  const specs = DEF_KINDS[lang];
  if (specs === undefined) return undefined;

  const wanted =
    groups === undefined || groups.length === 0
      ? specs
      : specs.filter((s) => groups.includes(s.group));
  if (wanted.length === 0) return undefined;

  const nameRegex = `^${name}$`;
  const byGroup = new Map<DefGroup, RuleObject[]>();
  for (const spec of wanted) {
    const list = byGroup.get(spec.group) ?? [];
    list.push(...nameRules(spec, nameRegex));
    byGroup.set(spec.group, list);
  }

  const docs: string[] = [];
  for (const [group, rules] of byGroup) {
    const firstRule = rules[0];
    if (firstRule === undefined) continue;
    docs.push(
      JSON.stringify({
        id: `def-${group}`,
        language: lang,
        rule: rules.length === 1 ? firstRule : { any: rules },
      }),
    );
  }

  return docs.length > 0 ? docs.join("\n---\n") : undefined;
}

// ============================================================================
// Process helper
// ============================================================================

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: toolEnv(),
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            proc.kill("SIGKILL");
          }, opts.timeoutMs);

    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("error", (err) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });

    if (opts.input !== undefined && proc.stdin !== null) {
      proc.stdin.end(opts.input);
    }
  });
}

// ============================================================================
// Matches
// ============================================================================

export interface AstMatch {
  file_path: string;
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  /** Source text of the matched node. */
  text: string;
  /** The full lines the node spans (includes leading `export`, indentation). */
  lines?: string;
  rule_id?: string;
  meta_variables?: Record<string, string>;
}

const DEFAULT_TEXT_LIMIT = 400;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… [truncated]` : text;
}

/**
 * ast-grep reports 0-based line/column; every other tool in this server speaks
 * 1-based, so the conversion happens here, once.
 */
function parseMatches(
  stdout: string,
  opts: { textLimit: number; fallbackFile?: string },
): AstMatch[] {
  const matches: AstMatch[] = [];

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.startsWith("{")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const m = parsed as Record<string, unknown>;
    const range = m["range"] as Record<string, unknown> | undefined;
    if (range === undefined) continue;

    const start = range["start"] as
      | { line?: number; column?: number }
      | undefined;
    const end = range["end"] as { line?: number; column?: number } | undefined;
    if (start === undefined) continue;

    const metaVariables: Record<string, string> = {};
    const meta = m["metaVariables"] as Record<string, unknown> | undefined;
    const single = meta?.["single"] as Record<string, unknown> | undefined;
    if (single !== undefined) {
      for (const [name, value] of Object.entries(single)) {
        const text = (value as Record<string, unknown>)["text"];
        if (typeof text === "string")
          metaVariables[`$${name}`] = clip(text, 200);
      }
    }
    const multi = meta?.["multi"] as Record<string, unknown> | undefined;
    if (multi !== undefined) {
      for (const [name, value] of Object.entries(multi)) {
        if (!Array.isArray(value)) continue;
        const joined = value
          .map((n) => String((n as Record<string, unknown>)["text"] ?? ""))
          .join(", ");
        metaVariables[`$$$${name}`] = clip(joined, 200);
      }
    }

    const file = m["file"] as string | undefined;
    const lines = m["lines"];
    const ruleId = m["ruleId"];

    matches.push({
      // stdin scans report the literal file name "STDIN".
      file_path:
        file === undefined || file === "STDIN"
          ? (opts.fallbackFile ?? file ?? "")
          : file,
      line: (start.line ?? 0) + 1,
      column: (start.column ?? 0) + 1,
      end_line: (end?.line ?? start.line ?? 0) + 1,
      end_column: (end?.column ?? start.column ?? 0) + 1,
      text: clip(String(m["text"] ?? ""), opts.textLimit),
      ...(typeof lines === "string"
        ? { lines: clip(lines, opts.textLimit) }
        : {}),
      ...(typeof ruleId === "string" ? { rule_id: ruleId } : {}),
      ...(Object.keys(metaVariables).length > 0
        ? { meta_variables: metaVariables }
        : {}),
    });
  }

  return matches;
}

// ============================================================================
// Runner
// ============================================================================

export interface AstGrepOutcome {
  ok: boolean;
  matches: AstMatch[];
  truncated: boolean;
  /** ast-grep warned but still ran — usually an unparseable pattern. */
  warning?: string;
  error?: string;
  unavailable?: boolean;
}

const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "*.min.js",
  "*.map",
];

export interface AstGrepRunOptions {
  /** Surface-syntax pattern (`run` mode). Mutually exclusive with `rule`. */
  pattern?: string;
  /** Inline rule YAML/JSON, possibly multi-document (`scan` mode). */
  rule?: string;
  lang?: string;
  strictness?: string;
  /** Absolute file or directory to search. */
  target: string;
  /** When set, `target` is searched via stdin using this text (overlay-aware). */
  stdinText?: string;
  fileTypes?: string[];
  excludePaths?: string[];
  maxResults: number;
  timeoutMs: number;
  /** Per-match text cap. Raise it when the caller wants a whole node back. */
  textLimit?: number;
}

export async function runAstGrep(
  opts: AstGrepRunOptions,
): Promise<AstGrepOutcome> {
  const probe = await detectAstGrep();
  if (!probe.available) {
    return {
      ok: false,
      matches: [],
      truncated: false,
      unavailable: true,
      error: AST_GREP_INSTALL_HINT,
    };
  }

  const args: string[] = [];

  if (opts.rule !== undefined && opts.rule.trim().length > 0) {
    // `scan` is the rule engine: relational constraints (inside / has /
    // follows) and multi-document rule sets only exist here.
    args.push("scan", "--inline-rules", opts.rule);
  } else {
    args.push("run", "--pattern", opts.pattern ?? "");
    if (opts.lang !== undefined && opts.lang.length > 0) {
      args.push("--lang", opts.lang);
    }
    if (opts.strictness !== undefined && opts.strictness.length > 0) {
      args.push("--strictness", opts.strictness);
    }
  }

  args.push("--json=stream");

  if (opts.stdinText !== undefined) {
    args.push("--stdin");
  } else {
    for (const ext of opts.fileTypes ?? []) {
      args.push("--globs", `*.${ext.replace(/^\./, "")}`);
    }
    for (const pattern of [...DEFAULT_EXCLUDES, ...(opts.excludePaths ?? [])]) {
      args.push("--globs", `!${pattern}`);
    }
    args.push(opts.target);
  }

  printDebug(`[ast-grep] ${args.length} args on ${opts.target}`);

  let res: RunResult;
  try {
    res = await runProcess(astGrepBinary(), args, {
      timeoutMs: opts.timeoutMs,
      ...(opts.stdinText !== undefined ? { input: opts.stdinText } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      matches: [],
      truncated: false,
      error: (error as Error).message,
    };
  }

  if (res.timedOut) {
    return {
      ok: false,
      matches: [],
      truncated: false,
      error: `ast-grep timed out after ${opts.timeoutMs}ms. Narrow the path or raise timeout_ms.`,
    };
  }

  // Exit 1 means "no matches" for `run` and "matched at error severity" for
  // `scan`. Neither is a failure. Anything else is (bad rule, bad kind, ...).
  if (res.code !== 0 && res.code !== 1) {
    return {
      ok: false,
      matches: [],
      truncated: false,
      error: (res.stderr.trim() || `ast-grep exited ${res.code}`).slice(0, 800),
    };
  }

  const all = parseMatches(res.stdout, {
    textLimit: opts.textLimit ?? DEFAULT_TEXT_LIMIT,
    ...(opts.stdinText !== undefined ? { fallbackFile: opts.target } : {}),
  });

  // A pattern that does not parse still exits 0 and matches nothing; without
  // this the agent gets a confusing empty result and retries the same query.
  const warning =
    all.length === 0 && res.stderr.includes("ERROR node")
      ? "The pattern did not parse cleanly. A pattern must be valid standalone code — 'foo($$$)' parses, 'foo(' does not."
      : undefined;

  return {
    ok: true,
    matches: all.slice(0, opts.maxResults),
    truncated: all.length > opts.maxResults,
    ...(warning !== undefined ? { warning } : {}),
  };
}

// ============================================================================
// Definition lookup (the `search` fallback tier and read_ast_node's engine)
// ============================================================================

export interface AstDefinition {
  file_path: string;
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  symbol_name: string;
  kind: DefGroup | "Unknown";
  /** First line of the declaration — a signature, not the whole body. */
  signature: string;
  /** Whole-line source of the node. Only populated when full text was asked for. */
  code?: string;
}

export interface FindDefinitionsOptions {
  name: string;
  lang: string;
  target: string;
  groups?: DefGroup[];
  stdinText?: string;
  fileTypes?: string[];
  excludePaths?: string[];
  maxResults: number;
  timeoutMs: number;
  /** Return the node's full source in `code` (for extraction, not search). */
  includeCode?: boolean;
  codeLimit?: number;
}

export async function findDefinitions(opts: FindDefinitionsOptions): Promise<{
  ok: boolean;
  definitions: AstDefinition[];
  truncated: boolean;
  error?: string;
  unavailable?: boolean;
}> {
  if (!isSafeSymbolName(opts.name)) {
    return {
      ok: false,
      definitions: [],
      truncated: false,
      error: `'${opts.name}' is not a plain identifier; structural definition lookup needs one.`,
    };
  }

  const rule = buildDefinitionRules(opts.lang, opts.name, opts.groups);
  if (rule === undefined) {
    return {
      ok: false,
      definitions: [],
      truncated: false,
      error: `No declaration grammar mapped for language '${opts.lang}'.`,
    };
  }

  const outcome = await runAstGrep({
    rule,
    target: opts.target,
    ...(opts.stdinText !== undefined ? { stdinText: opts.stdinText } : {}),
    ...(opts.fileTypes !== undefined ? { fileTypes: opts.fileTypes } : {}),
    ...(opts.excludePaths !== undefined
      ? { excludePaths: opts.excludePaths }
      : {}),
    maxResults: opts.maxResults,
    timeoutMs: opts.timeoutMs,
    ...(opts.includeCode === true
      ? { textLimit: opts.codeLimit ?? 40_000 }
      : {}),
  });

  if (!outcome.ok) {
    return {
      ok: false,
      definitions: [],
      truncated: false,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      ...(outcome.unavailable === true ? { unavailable: true } : {}),
    };
  }

  const definitions = outcome.matches.map((m): AstDefinition => {
    const body = m.lines ?? m.text;
    const firstLine = body.split("\n")[0] ?? "";
    return {
      file_path: m.file_path,
      line: m.line,
      column: m.column,
      end_line: m.end_line,
      end_column: m.end_column,
      symbol_name: opts.name,
      kind: groupFromRuleId(m.rule_id),
      signature: firstLine.trim().slice(0, 200),
      ...(opts.includeCode === true ? { code: body } : {}),
    };
  });

  return { ok: true, definitions, truncated: outcome.truncated };
}

function groupFromRuleId(ruleId: string | undefined): DefGroup | "Unknown" {
  if (ruleId === undefined || !ruleId.startsWith("def-")) return "Unknown";
  return ruleId.slice(4) as DefGroup;
}
