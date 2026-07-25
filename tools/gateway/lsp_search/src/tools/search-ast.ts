/**
 * Tree-sitter tools
 *
 *   search_ast    structural pattern search — find a code SHAPE
 *   read_ast_node surgical extraction — read exactly one declaration
 *
 * read_ast_node is the context-window tool: `cat` on a 3,000-line file floods
 * the window and LSP tells you where a symbol starts but not where it ends.
 * Tree-sitter knows the node boundaries, so the agent can pull back one
 * function and nothing else — and gets an exact line range to hand to
 * sandbox_apply_patch when it wants to replace it.
 *
 * Both degrade to an install hint when the optional ast-grep CLI is absent.
 * Both are read-only; edits go through the sandbox overlay as always.
 */

import * as path from "path";
import * as fs from "fs/promises";
import {
  validatePath,
  type ToolHandler,
  type MCPToolResult,
  type ServerContext,
} from "../server.js";
import { readOverlayOrDisk } from "../document-overlay.js";
import {
  runAstGrep,
  findDefinitions,
  detectAstGrep,
  astLangForFile,
  astLangForExtension,
  supportsDefinitionLookup,
  AST_GREP_INSTALL_HINT,
  type DefGroup,
} from "../ast-grep.js";

const DEF_GROUPS: DefGroup[] = [
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
  "module",
];

// ============================================================================
// Tool: search_ast
// ============================================================================

export const searchAstToolHandler: ToolHandler = {
  name: "search_ast",
  description: `Structural (tree-sitter) code search. Matches SYNTAX, not text.

Use it when you are looking for a SHAPE rather than a name: call sites with a
particular argument, functions returning Result, empty catch blocks, awaits
inside loops. It parses with tree-sitter, so it needs no index and no language
server, is instant, and still works on a file with a syntax error in it.

For "who calls this exact symbol", get_references (LSP) is more accurate —
this tier is syntactic and does not resolve imports or aliases.

PATTERN SYNTAX:
  $VAR     one node, captured
  $$$ARGS  zero or more nodes (arguments, statements, params), captured
  $_       one node, not captured
A pattern must be valid standalone code: 'foo($$$)' parses, 'foo(' does not.

Examples:
  { "pattern": "console.log($$$ARGS)", "lang": "ts" }
  { "pattern": "await $CALL", "lang": "ts", "path": "src/tools" }
  { "pattern": "fn $NAME($$$) -> Result<$OK, $ERR> { $$$ }", "lang": "rust" }
  { "pattern": "except: $$$BODY", "lang": "python" }

Relational queries use 'rule' (inline ast-grep YAML) instead of 'pattern':
  { "rule": "id: log-in-catch\\nlanguage: ts\\nrule:\\n  pattern: console.log($$$)\\n  inside:\\n    kind: catch_clause\\n    stopBy: end" }

Set file_path to search one file INCLUDING your unshipped overlay edits;
a directory search reads the host tree.

Needs the optional 'ast-grep' CLI on the gateway host.`,

  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          "ast-grep pattern, e.g. 'console.log($$$ARGS)'. Required unless 'rule' is given.",
      },
      rule: {
        type: "string",
        description:
          "Inline ast-grep rule YAML for relational queries (inside/has/follows/not). Overrides 'pattern'.",
      },
      lang: {
        type: "string",
        description:
          "Language of the pattern: ts, tsx, js, jsx, python, rust, go, java, c, cpp. Inferred from file_types / file_path when omitted.",
      },
      path: {
        type: "string",
        description: "Directory or file to search (default: whole workspace)",
      },
      file_path: {
        type: "string",
        description:
          "Search this single file through the in-session overlay (reflects unshipped edits).",
      },
      file_types: {
        type: "array",
        items: { type: "string" },
        description: 'Extensions to include, e.g. ["ts", "tsx"]',
      },
      exclude_paths: {
        type: "array",
        items: { type: "string" },
        description: 'Globs to exclude, e.g. ["test/", "vendor/"]',
      },
      strictness: {
        type: "string",
        description:
          "Match strictness: smart (default), ast, relaxed, signature, cst",
      },
      max_results: {
        type: "integer",
        description: "Maximum matches (default: 30, max: 200)",
      },
      timeout_ms: {
        type: "integer",
        description: "Search timeout in milliseconds (default: 30000)",
      },
    },
    required: [],
  },

  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      const pattern = params["pattern"] as string | undefined;
      const rule = params["rule"] as string | undefined;
      const hasPattern = pattern !== undefined && pattern.trim().length > 0;
      const hasRule = rule !== undefined && rule.trim().length > 0;

      if (!hasPattern && !hasRule) {
        return astError("Either 'pattern' or 'rule' is required");
      }

      const maxResults = Math.min((params["max_results"] as number) ?? 30, 200);
      const timeoutMs = Math.min(
        (params["timeout_ms"] as number) ?? 30_000,
        180_000,
      );
      const fileTypes = (params["file_types"] as string[]) ?? [];
      const excludePaths = (params["exclude_paths"] as string[]) ?? [];
      const strictness = params["strictness"] as string | undefined;
      const singleFile = params["file_path"] as string | undefined;
      const searchPath = (params["path"] as string) ?? ".";

      const workingDir = path.resolve(context.workingDirectory);

      // A rule carries its own `language:` key; a pattern needs one from us.
      const lang = hasRule
        ? undefined
        : ((params["lang"] as string | undefined) ??
          langFromTypes(fileTypes) ??
          astLangForFile(singleFile ?? searchPath));

      let absolute: string;
      let stdinText: string | undefined;

      if (singleFile !== undefined) {
        // Single file: go through the overlay so unshipped edits count, and so
        // files that exist only in the overlay are searchable at all.
        if (lang === undefined && !hasRule) {
          return astError(
            `Could not infer a language for ${singleFile}. Pass 'lang' explicitly.`,
          );
        }
        const file = await readTargetFile(singleFile, workingDir);
        if ("error" in file) return astError(file.error);
        absolute = file.absolute;
        stdinText = file.content;
      } else {
        const resolved = await resolveDiskTarget(searchPath, workingDir);
        if ("error" in resolved) return astError(resolved.error);
        absolute = resolved.absolute;
      }

      const outcome = await runAstGrep({
        ...(hasPattern && !hasRule ? { pattern } : {}),
        ...(hasRule ? { rule } : {}),
        ...(lang !== undefined ? { lang } : {}),
        ...(strictness !== undefined ? { strictness } : {}),
        target: absolute,
        ...(stdinText !== undefined ? { stdinText } : {}),
        fileTypes,
        excludePaths,
        maxResults,
        timeoutMs,
      });

      if (!outcome.ok) {
        return astError(outcome.error ?? "structural search failed");
      }

      const response: Record<string, unknown> = {
        results: outcome.matches.map((m) => ({
          ...m,
          file_path: toRelative(m.file_path, workingDir),
        })),
        source: "tree-sitter (ast-grep)",
        total_count: outcome.matches.length,
        ...(lang !== undefined ? { language: lang } : {}),
      };

      if (outcome.truncated) {
        response["truncated"] = true;
        response["hint"] =
          "More matches exist. Narrow 'path' or raise 'max_results'.";
      }
      if (outcome.warning !== undefined) {
        response["warning"] = outcome.warning;
      }
      if (outcome.matches.length === 0 && outcome.warning === undefined) {
        response["message"] =
          "No structural matches. Loosen the pattern with metavariables, or use 'search' if you only need the name.";
      }
      if (stdinText === undefined) {
        response["overlay_note"] =
          "Directory search reads the host tree; pass file_path to include unshipped overlay edits.";
      }

      return jsonResult(response);
    } catch (error) {
      return astError((error as Error).message);
    }
  },
};

// ============================================================================
// Tool: read_ast_node
// ============================================================================

export const readAstNodeToolHandler: ToolHandler = {
  name: "read_ast_node",
  description: `Read ONE declaration out of a file by name, with exact boundaries.

Tree-sitter knows where a node starts AND ends, so this returns the whole
function/class/type and nothing else — the way to inspect a symbol in a large
file without reading the file into your context.

  read_ast_node({ file_path: "src/app.ts", name: "handleSubmit" })
  read_ast_node({ file_path: "src/user.rs", name: "User", node_type: "class" })

Reads through your in-session overlay, so it reflects unshipped edits.

TO REPLACE a declaration: call this first, then feed the returned code as the
patch context to sandbox_apply_patch (start_line/end_line give you the exact
span). Never hand-count context lines — Golden Rule 4.

Needs the optional 'ast-grep' CLI on the gateway host.`,

  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "File to read the declaration from",
      },
      name: {
        type: "string",
        description:
          "Exact identifier of the declaration (function, class, struct, type, const...)",
      },
      node_type: {
        type: "string",
        enum: DEF_GROUPS,
        description:
          "Restrict to one kind of declaration. Omit to match any (a method and a same-named free function both come back).",
      },
      lang: {
        type: "string",
        description: "Override the language inferred from the file extension",
      },
      max_bytes: {
        type: "integer",
        description:
          "Cap on returned source per node (default: 20000). Huge nodes are truncated, never silently dropped.",
      },
      timeout_ms: {
        type: "integer",
        description: "Timeout in milliseconds (default: 30000)",
      },
    },
    required: ["file_path", "name"],
  },

  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      const filePath = params["file_path"] as string;
      const name = params["name"] as string;

      if (
        typeof filePath !== "string" ||
        filePath.length === 0 ||
        typeof name !== "string" ||
        name.length === 0
      ) {
        return astError("file_path and name are required");
      }

      const nodeType = params["node_type"] as DefGroup | undefined;
      const maxBytes = Math.min(
        (params["max_bytes"] as number) ?? 20_000,
        200_000,
      );
      const timeoutMs = Math.min(
        (params["timeout_ms"] as number) ?? 30_000,
        180_000,
      );

      const workingDir = path.resolve(context.workingDirectory);
      const file = await readTargetFile(filePath, workingDir);
      if ("error" in file) return astError(file.error);

      const lang =
        (params["lang"] as string | undefined) ?? astLangForFile(filePath);
      if (lang === undefined) {
        return astError(
          `Could not infer a language for ${filePath}. Pass 'lang' explicitly.`,
        );
      }
      if (!supportsDefinitionLookup(lang)) {
        return astError(
          `Declaration lookup is not mapped for '${lang}'. Use search_ast with an explicit pattern instead.`,
        );
      }

      const result = await findDefinitions({
        name,
        lang,
        target: file.absolute,
        stdinText: file.content,
        ...(nodeType !== undefined ? { groups: [nodeType] } : {}),
        maxResults: 10,
        timeoutMs,
        includeCode: true,
        codeLimit: maxBytes,
      });

      if (!result.ok) {
        return astError(result.error ?? "declaration lookup failed");
      }

      if (result.definitions.length === 0) {
        return jsonResult({
          nodes: [],
          total_count: 0,
          file_path: toRelative(file.absolute, workingDir),
          message:
            `No ${nodeType ?? "declaration"} named '${name}' in this file. ` +
            `Check the spelling, drop node_type, or use search to locate the file that declares it.`,
        });
      }

      return jsonResult({
        nodes: result.definitions.map((d) => ({
          name: d.symbol_name,
          node_type: d.kind,
          file_path: toRelative(file.absolute, workingDir),
          start_line: d.line,
          end_line: d.end_line,
          signature: d.signature,
          code: d.code,
        })),
        total_count: result.definitions.length,
        source: "tree-sitter (ast-grep)",
        language: lang,
        note: "Line numbers are 1-based and include the whole declaration. Use them as patch context for sandbox_apply_patch.",
      });
    } catch (error) {
      return astError((error as Error).message);
    }
  },
};

// ============================================================================
// Helpers
// ============================================================================

function jsonResult(data: unknown): MCPToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function astError(message: string): MCPToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

function resolvePath(
  target: string,
  workingDir: string,
): { absolute: string } | { error: string } {
  const validation = validatePath(target, workingDir);
  if (!validation.valid || validation.fullPath === undefined) {
    return { error: `Invalid path: ${validation.error ?? target}` };
  }
  return { absolute: validation.fullPath };
}

/**
 * Resolve a path that ast-grep will walk on disk (a directory, or a file we
 * hand it by name rather than by content).
 */
async function resolveDiskTarget(
  target: string,
  workingDir: string,
): Promise<{ absolute: string; isFile: boolean } | { error: string }> {
  const resolved = resolvePath(target, workingDir);
  if ("error" in resolved) return resolved;
  try {
    const stat = await fs.stat(resolved.absolute);
    return { absolute: resolved.absolute, isFile: stat.isFile() };
  } catch {
    return { error: `Path does not exist: ${target}` };
  }
}

/**
 * Read a single file the way the rest of this server does: through the overlay.
 *
 * Deliberately NOT gated on a disk stat. A file created this session by
 * sandbox_write_file lives only in the overlay and never appears on the host
 * tree — statting first would make exactly the files the agent just wrote
 * unreadable. A directory is still rejected, and a genuinely missing path
 * fails on the read.
 */
async function readTargetFile(
  target: string,
  workingDir: string,
): Promise<{ absolute: string; content: string } | { error: string }> {
  const resolved = resolvePath(target, workingDir);
  if ("error" in resolved) return resolved;

  try {
    const stat = await fs.stat(resolved.absolute);
    if (stat.isDirectory()) {
      return { error: `${target} is a directory; pass a single file.` };
    }
  } catch {
    // Not on disk: expected for overlay-only files. Fall through to the read.
  }

  try {
    return {
      absolute: resolved.absolute,
      content: await readOverlayOrDisk(resolved.absolute),
    };
  } catch {
    return {
      error: `Cannot read ${target}: not on the host tree and not in this session's overlay.`,
    };
  }
}

function langFromTypes(fileTypes: string[]): string | undefined {
  const first = fileTypes[0];
  return first === undefined ? undefined : astLangForExtension(first);
}

function toRelative(filePath: string, workingDir: string): string {
  if (filePath.length === 0) return filePath;
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workingDir, filePath);
  const rel = path.relative(workingDir, abs);
  return rel.startsWith("..") ? abs : rel;
}

export { detectAstGrep, AST_GREP_INSTALL_HINT };
