/**
 * Search Tools for code navigation and exploration
 *
 * Tools:
 * 1. search - Unified search: LSP -> tree-sitter -> text, in that order
 * 2. get_references - Find all usages of a symbol at a position
 * 3. get_hover - Get documentation/type info at a position
 *
 * `search` walks three tiers, in order, and hides which one answered:
 *   1. lsp         semantic. Best answer, but needs a language server, a
 *                  resolvable project and a warm index.
 *   2. tree-sitter syntactic. Finds the DECLARATION of a symbol by parsing the
 *                  file. Survives everything that breaks tier 1: cold index,
 *                  missing node_modules, syntax error three lines up.
 *   3. text        ripgrep. Every occurrence, no structure.
 * Tier 2 sits above text on purpose — a declaration is a better answer than a
 * list of occurrences, and it costs milliseconds.
 *
 * A query carrying ast-grep metavariables ($NAME / $$$ARGS) skips straight to
 * the structural tier, since only that tier can express a code shape.
 */

import * as path from "path";
import { validatePath } from "../server.js";
import * as fs from "fs/promises";
import { spawn } from "child_process";
import { ToolHandler, MCPToolResult, ServerContext } from "../server.js";
import { ProjectDetector, ProjectRoot } from "../project-detector.js";
import { getLSPCache } from "../lsp-cache.js";
import { printDebug } from "../utils/log.js";
import { readOverlayOrDisk } from "../document-overlay.js";
import { searchAstToolHandler } from "./search-ast.js";
import { resolveTool, toolEnv } from "../tool-path.js";
import {
  detectAstGrep,
  findDefinitions,
  isSafeSymbolName,
  astLangForExtension,
  astLangForProjectLanguage,
  supportsDefinitionLookup,
  AST_GREP_INSTALL_HINT,
  type AstDefinition,
} from "../ast-grep.js";

// ProjectDetector is expensive (a depth-limited tree scan, cached 60s), so it
// is memoised — but it must be keyed to the workspace. The gateway is a
// long-lived service and `set_workspace` moves the working directory under it,
// so a plain `if (!projectDetector)` pins the detector to whichever project was
// opened FIRST after boot. Every later session then resolves projects against a
// tree it is not working in: the LSP tier gets clients for the wrong project
// and silently returns nothing, and everything falls through to text search.
let projectDetector: ProjectDetector | undefined;
let projectDetectorRoot: string | undefined;

function getProjectDetector(workingDirectory: string): ProjectDetector {
  if (
    projectDetector === undefined ||
    projectDetectorRoot !== workingDirectory
  ) {
    printDebug(`[search] ProjectDetector root -> ${workingDirectory}`);
    projectDetector = new ProjectDetector(workingDirectory);
    projectDetectorRoot = workingDirectory;
  }
  return projectDetector;
}

// ============================================================================
// Shared Types
// ============================================================================

export interface SearchResult {
  file_path: string;
  line: number;
  column: number;
  match_text: string;
  context?: string;
}

interface DefinitionResult {
  file_path: string;
  line: number;
  column: number;
  symbol_name: string;
  kind?: string;
}

// ============================================================================
// Shared Utilities
// ============================================================================

/**
 * Same story as the language servers: `rg` installed by cargo or Homebrew is
 * invisible to a systemd user service's PATH. Resolve it through tool-path
 * instead of shelling out and trusting the inherited environment.
 */
async function hasRipgrep(): Promise<boolean> {
  await Promise.resolve();
  return resolveTool("rg") !== null;
}

function executeCommand(
  command: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command;
    if (cmd === undefined) {
      reject(new Error("Empty command"));
      return;
    }

    const proc = spawn(resolveTool(cmd) ?? cmd, args, {
      env: toolEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0 || code === 1) resolve({ stdout, stderr });
      else reject(new Error(`Command failed with code ${code}: ${stderr}`));
    });
    proc.on("error", reject);
  });
}

function buildRipgrepCommand(
  query: string,
  searchPath: string,
  fileTypes: string[],
  excludePaths: string[],
  contextLines: number,
  wordBoundary: boolean = true,
): string[] {
  const args: string[] = ["rg", "--json", "--line-number", "--column"];
  args.push(`--context=${contextLines}`);

  // Always use fixed strings (literal search, no regex)
  // Use word boundary matching for better precision on symbol names
  if (wordBoundary) {
    args.push("--word-regexp", query);
  } else {
    args.push("--fixed-strings", query);
  }

  if (fileTypes.length > 0) {
    fileTypes.forEach((ext) => {
      args.push("--type-add", `custom:*.${ext}`);
      args.push("--type", "custom");
    });
  }

  const defaultExcludes = [
    "node_modules",
    ".git",
    "dist",
    "build",
    "*.min.js",
    "*.map",
  ];
  [...defaultExcludes, ...excludePaths].forEach((pattern) => {
    args.push("--glob", `!${pattern}`);
  });

  args.push(searchPath);
  return args;
}

function parseRipgrepOutput(output: string): SearchResult[] {
  const results: SearchResult[] = [];
  const lines = output.trim().split("\n");

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["type"] !== "match") continue;

      const data = parsed["data"] as Record<string, unknown>;
      const pathData = data["path"] as Record<string, unknown>;
      const lineData = data["line_number"] as number;
      const linesData = data["lines"] as Record<string, unknown>;
      const submatches = data["submatches"] as Array<Record<string, unknown>>;

      if (!submatches || submatches.length === 0) continue;

      const firstMatch = submatches[0];
      if (!firstMatch) continue;

      const matchObj = firstMatch["match"] as Record<string, unknown>;

      results.push({
        file_path: pathData["text"] as string,
        line: lineData,
        column: (firstMatch["start"] as number) + 1,
        match_text: matchObj["text"] as string,
        context: (linesData["text"] as string).trim(),
      });
    } catch {
      continue;
    }
  }

  return results;
}

async function findSymbolColumnInFile(
  filePath: string,
  lineNumber: number,
  symbolName: string,
  fallbackColumn: number,
): Promise<number> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const line = lines[lineNumber - 1];

    if (!line) return fallbackColumn;

    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`);
    const match = line.match(regex);

    if (match && match.index !== undefined) {
      return match.index + 1;
    }

    const index = line.indexOf(symbolName);
    if (index !== -1) return index + 1;

    return fallbackColumn;
  } catch {
    return fallbackColumn;
  }
}

function prioritizeProjects(
  projects: ProjectRoot[],
  currentProject: ProjectRoot | null,
): ProjectRoot[] {
  return [...projects].sort((a, b) => {
    if (currentProject) {
      if (a.path === currentProject.path) return -1;
      if (b.path === currentProject.path) return 1;
    }
    const depthA = a.path.split(path.sep).length;
    const depthB = b.path.split(path.sep).length;
    return depthA - depthB;
  });
}

/**
 * Nothing found by symbol or by text: the query may have been the wrong SHAPE
 * rather than the wrong string. Point at the structural tier — but only if it
 * is actually installed, so we never advertise a tool that will error.
 */
async function structuralHint(): Promise<string> {
  const probe = await detectAstGrep();
  return probe.available
    ? "No text match either. If you are looking for a code shape rather than a name " +
        "(e.g. all calls with a certain argument), try search_ast with a pattern like 'foo($$$ARGS)'."
    : "No text match either. Structural (tree-sitter) search could help here; " +
        "it needs the optional 'ast-grep' CLI on the gateway host.";
}

function formatResponse(data: unknown): MCPToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function formatError(
  message: string,
  context?: { language?: string; isTimeout?: boolean },
): MCPToolResult {
  let fullMessage = message;

  // Add actionable guidance for LSP timeouts
  if (context?.isTimeout) {
    const lang = context.language ?? "unknown";
    const warmupStatus = getLSPCache().getWarmupStatus();

    // Include warmup progress if relevant
    if (warmupStatus.inProgress && warmupStatus.language === lang) {
      const elapsedSec = Math.round(warmupStatus.elapsedMs / 1000);
      fullMessage =
        `${message}\n\n[LSP Warmup In Progress]\n` +
        `The ${lang} language server has been indexing for ${elapsedSec}s.\n` +
        `This is normal for large projects. Please retry in 30-60 seconds.\n\n` +
        getLspTimeoutGuidance(lang);
    } else {
      fullMessage = `${message}\n\n` + getLspTimeoutGuidance(lang);
    }
  }

  return {
    content: [{ type: "text", text: `Error: ${fullMessage}` }],
    isError: true,
  };
}

/**
 * Provide honest, actionable guidance when LSP times out.
 * Different languages have different caching behaviors.
 */
function getLspTimeoutGuidance(language: string): string {
  switch (language) {
    case "rust":
      return `[Rust LSP Timeout]
rust-analyzer does NOT persist its index to disk.
- First call in a session is always slow (indexing from scratch)
- Subsequent calls in the SAME session will be fast
- Retry this call in 30-60 seconds, or use text search as fallback
- If you keep timing out, the project may be too large for CLI usage`;

    case "cpp":
      return `[C/C++ LSP Timeout]
clangd DOES persist its index to disk (.cache/clangd/index/).
- First run on a project: slow (building index)
- Subsequent runs: should be fast (loading from disk)
- If this is a repeated timeout, the project may be too large
- Fallback: use text search with 'search' tool`;

    case "typescript":
    case "go":
    case "python":
      return `[${language} LSP Timeout]
This language usually has fast LSP startup.
- Check if the project is unusually large
- Verify the language server is installed correctly
- Fallback: use text search with 'search' tool`;

    default:
      return `[LSP Timeout]
The language server did not respond in time.
- The project may be too large for LSP
- Fallback: use text search with 'search' tool`;
  }
}

// ============================================================================
// Tool 1: search (unified LSP + text search)
// ============================================================================

/**
 * LSP search timeout per language.
 * Some languages (go, rust, cpp) need more time to index.
 * We don't pass timeout to getClient() - let LSPClient use its own
 * language-specific defaults which are more appropriate.
 * This timeout is only for the retry loop in tryLspSearch.
 */
const LSP_SEARCH_TIMEOUT_MS = 15_000;

/**
 * Total budget for the tree-sitter tier. It sits between a tier that already
 * spent up to 15s and the text tier, so it has to be cheap or it is not worth
 * having: parsing is fast, and if it is not, ripgrep is the better answer.
 */
const AST_DEF_SEARCH_BUDGET_MS = 8_000;

export const searchToolHandler: ToolHandler = {
  name: "search",
  description: `Search for code symbols, structure, or text in the codebase.

Automatically uses LSP for semantic search when available (finds definitions,
classes, functions, etc.), and falls back to text search otherwise.

If the query contains ast-grep metavariables ($NAME, $$$ARGS) it is treated as
a structural tree-sitter pattern instead — same engine as the 'search_ast'
tool, which has the full pattern documentation.

Returns file path, line, and column for each match. Use the results with
get_references or get_hover for further exploration.

Examples:
  { "query": "UserService" }           - Find UserService definition
  { "query": "handleClick" }           - Find handleClick function
  { "query": "TODO" }                  - Find all TODO comments (text search)
  { "query": "API_KEY", "path": "config" } - Search in specific directory
  { "query": "await $CALL", "lang": "ts" } - Structural: every await expression`,

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Symbol name or text to search for",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: current directory)",
      },
      file_types: {
        type: "array",
        items: { type: "string" },
        description: 'File extensions to include, e.g. ["ts", "js"]',
      },
      exclude_paths: {
        type: "array",
        items: { type: "string" },
        description: 'Paths to exclude, e.g. ["test/", "vendor/"]',
      },
      max_results: {
        type: "integer",
        description: "Maximum results (default: 20)",
      },
      mode: {
        type: "string",
        enum: ["auto", "semantic", "structural", "text"],
        description:
          "auto (default): LSP, then text; structural if the query has metavariables. semantic: LSP only. structural: tree-sitter pattern. text: ripgrep only.",
      },
      lang: {
        type: "string",
        description:
          "Language for structural mode (ts, tsx, python, rust, go, cpp, ...). Inferred from file_types when omitted.",
      },
    },
    required: ["query"],
  },

  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      const query = params["query"] as string;
      if (!query || typeof query !== "string") {
        return formatError("query is required");
      }

      const searchPath = (params["path"] as string) ?? ".";
      const fileTypes = (params["file_types"] as string[]) ?? [];
      const excludePaths = (params["exclude_paths"] as string[]) ?? [];
      const maxResults = Math.min((params["max_results"] as number) ?? 20, 100);
      const mode = ((params["mode"] as string) ?? "auto").toLowerCase();

      const absoluteWorkingDir = path.resolve(context.workingDirectory);
      const validation = validatePath(searchPath, absoluteWorkingDir);
      if (!validation.valid) {
        return formatError(`Invalid path: ${validation.error}`);
      }

      // Try to access the path
      try {
        await fs.access(validation.fullPath!);
      } catch {
        return formatError(`Path does not exist: ${searchPath}`);
      }

      // ========================================
      // Phase 0: structural (tree-sitter) search
      // ========================================
      // Only fires on an explicit mode or on a query carrying ast-grep
      // metavariables. A plain symbol name never matches this, so auto-routing
      // cannot hijack an ordinary search.
      const looksStructural = /\$(?:\$\$)?[A-Z_]/.test(query);

      if (mode === "structural" || (mode === "auto" && looksStructural)) {
        const astProbe = await detectAstGrep();
        if (astProbe.available) {
          const lang = params["lang"] as string | undefined;
          return searchAstToolHandler.handler(
            {
              pattern: query,
              path: searchPath,
              file_types: fileTypes,
              exclude_paths: excludePaths,
              max_results: maxResults,
              ...(lang !== undefined ? { lang } : {}),
            },
            context,
          );
        }
        if (mode === "structural") {
          return formatError(AST_GREP_INSTALL_HINT);
        }
        printDebug(
          "[search] metavariable query but ast-grep is unavailable; using text search",
        );
      }

      // ========================================
      // Phase 1: Try LSP semantic search
      // ========================================
      getProjectDetector(absoluteWorkingDir);

      const lspResult: LspSearchOutcome =
        mode === "text"
          ? { success: false, results: [], lspAvailable: false }
          : await tryLspSearch(
              query,
              searchPath,
              fileTypes,
              maxResults,
              absoluteWorkingDir,
              context,
            );

      if (lspResult.success && lspResult.results.length > 0) {
        return formatResponse({
          results: lspResult.results,
          source: "lsp",
          total_count: lspResult.results.length,
        });
      }

      // ========================================
      // Phase 1.5: tree-sitter declaration lookup
      // ========================================
      // Reaching here means the LSP had no symbol — usually "still indexing",
      // "no language server installed", or "the project does not build".
      // tree-sitter is unmoved by all three.
      if (mode === "auto") {
        const astDefs = await tryAstDefinitionSearch(
          query,
          validation.fullPath!,
          fileTypes,
          excludePaths,
          maxResults,
        );

        if (astDefs.length > 0) {
          return formatResponse({
            results: astDefs.map((d) => ({
              file_path: d.file_path,
              line: d.line,
              column: d.column,
              end_line: d.end_line,
              symbol_name: d.symbol_name,
              kind: d.kind,
              signature: d.signature,
            })),
            source: "tree-sitter",
            total_count: astDefs.length,
            ...(lspResult.warmupInfo !== undefined
              ? { lsp_hint: lspResult.warmupInfo }
              : {}),
            hint:
              "Declarations found by parsing, not by the language server: syntactic, " +
              "so same-named symbols in unrelated modules all appear. Use read_ast_node " +
              "to read one in full, or get_references for true call sites.",
          });
        }
      }

      if (mode === "semantic") {
        return formatResponse({
          results: [],
          source: "lsp",
          total_count: 0,
          message: `No LSP symbols for "${query}". ${lspResult.warmupInfo ?? "Retry without mode:semantic to fall back to text search."}`,
        });
      }

      // ========================================
      // Phase 2: Fall back to text search
      // ========================================
      const useRipgrep = await hasRipgrep();
      if (!useRipgrep) {
        // No ripgrep, return LSP result (even if empty) with guidance
        if (lspResult.warmupInfo) {
          return formatResponse({
            results: [],
            source: "lsp",
            message: `No results found. ${lspResult.warmupInfo}`,
            lsp_status: "warmup_indexing",
          });
        }
        return formatResponse({
          results: [],
          source: "lsp",
          message: `No definition found for "${query}". LSP may still be indexing.`,
        });
      }

      // Run ripgrep with word boundary matching
      const command = buildRipgrepCommand(
        query,
        validation.fullPath!,
        fileTypes,
        excludePaths,
        2, // context lines
        true, // word boundary
      );

      try {
        const { stdout } = await executeCommand(command);
        const textResults = parseRipgrepOutput(stdout);
        const limitedResults = textResults.slice(0, maxResults);

        // Build response with appropriate messaging
        const response: Record<string, unknown> = {
          results: limitedResults.map((r) => ({
            file_path: r.file_path,
            line: r.line,
            column: r.column,
            context: r.context,
          })),
          source: "text",
          total_count: textResults.length,
        };

        // Add LSP status hint if it was warming up
        if (lspResult.warmupInfo) {
          response.lsp_hint = lspResult.warmupInfo;
        } else if (lspResult.lspAvailable) {
          response.lsp_hint =
            "LSP returned no symbols. Results are from text search.";
        }

        if (textResults.length > maxResults) {
          response.truncated = true;
        }

        if (limitedResults.length === 0) {
          response.structural_hint = await structuralHint();
        }

        return formatResponse(response);
      } catch (error) {
        if ((error as Error).message.includes("code 1")) {
          // No matches found
          const response: Record<string, unknown> = {
            results: [],
            source: "text",
            total_count: 0,
            message: `No matches found for "${query}"`,
          };
          if (lspResult.warmupInfo) {
            response.lsp_hint = lspResult.warmupInfo;
          }
          response.structural_hint = await structuralHint();
          return formatResponse(response);
        }
        return formatError((error as Error).message);
      }
    } catch (error) {
      return formatError((error as Error).message);
    }
  },
};

interface LspSearchOutcome {
  success: boolean;
  results: DefinitionResult[];
  lspAvailable: boolean;
  // Explicit `| undefined` so this compiles with or without
  // exactOptionalPropertyTypes: tryLspSearch always sets the key.
  warmupInfo?: string | undefined;
}

/**
 * Try LSP workspace/symbol search with timeout.
 * Returns results if successful, or empty with status info.
 */
async function tryLspSearch(
  query: string,
  searchPath: string,
  fileTypes: string[],
  maxResults: number,
  _absoluteWorkingDir: string,
  context: ServerContext,
): Promise<LspSearchOutcome> {
  const results: DefinitionResult[] = [];

  try {
    let projects = await projectDetector!.detectProjects();
    if (projects.length === 0) {
      return { success: false, results: [], lspAvailable: false };
    }

    // Handle Rust workspaces - prefer workspace root
    const workspaceRoots = projects.filter((p) => p.isWorkspaceRoot);
    const rustWorkspaceRoot = workspaceRoots.find((p) => p.language === "rust");
    if (rustWorkspaceRoot) {
      const nonRustProjects = projects.filter((p) => p.language !== "rust");
      projects = [rustWorkspaceRoot, ...nonRustProjects];
    }

    const cache = getLSPCache();
    const sortedProjects = prioritizeProjects(
      projects,
      cache.getCurrentProject(),
    );
    const startTime = Date.now();

    for (const project of sortedProjects) {
      if (results.length >= maxResults) break;

      // Don't pass timeout - let LSPClient use language-specific defaults
      // This is important for Go/Rust/C++ which need longer init times
      const client = await cache.getClient(project);
      if (!client) continue;

      try {
        // Polling loop: retry until symbols found or timeout
        while (true) {
          const symbols = await client.getWorkspaceSymbols(query);

          if (symbols.length > 0) {
            for (const symbol of symbols) {
              if (results.length >= maxResults) break;

              const filePath = symbol.location.uri.replace("file://", "");
              const lineNumber = symbol.location.range.start.line + 1;

              // Filter by path if specified
              if (searchPath !== ".") {
                const fullSearchPath = path.resolve(
                  context.workingDirectory,
                  searchPath,
                );
                if (!filePath.startsWith(fullSearchPath)) continue;
              }

              // Filter by file type if specified
              if (fileTypes.length > 0) {
                const ext = path.extname(filePath).slice(1);
                if (!fileTypes.includes(ext)) continue;
              }

              const accurateColumn = await findSymbolColumnInFile(
                filePath,
                lineNumber,
                symbol.name,
                symbol.location.range.start.character + 1,
              );

              results.push({
                file_path: filePath,
                line: lineNumber,
                column: accurateColumn,
                symbol_name: symbol.name,
                kind: getSymbolKindName(symbol.kind),
              });
            }
            break; // Found symbols, exit retry loop
          }

          // Check timeout
          if (Date.now() - startTime >= LSP_SEARCH_TIMEOUT_MS) {
            printDebug(`[search] LSP timeout after ${LSP_SEARCH_TIMEOUT_MS}ms`);
            break;
          }

          // Optimization: If LSP is not warming up, and we got empty results,
          // assume the symbol really doesn't exist and break early.
          // Allow a grace period (5s) for slow servers to finish initialization.
          const warmup = cache.getWarmupStatus();
          if (!warmup.inProgress && Date.now() - startTime > 5000) {
            printDebug(`[search] LSP ready, no symbols found for query`);
            break;
          }

          // Wait before retry
          printDebug(
            `[search] LSP returned no symbols, retrying... (${Math.round((Date.now() - startTime) / 1000)}s)`,
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        if (project.isWorkspaceRoot && results.length > 0) break;
      } catch (error) {
        printDebug(
          `[search] LSP error for ${project.path}: ${(error as Error).message}`,
        );
      }
    }

    // Check warmup status for messaging
    const warmupStatus = cache.getWarmupStatus();
    let warmupInfo: string | undefined;
    if (warmupStatus.inProgress) {
      const elapsedSec = Math.round(warmupStatus.elapsedMs / 1000);
      warmupInfo = `LSP is indexing ${warmupStatus.language} (${elapsedSec}s elapsed). Results may be incomplete.`;
    }

    return {
      success: results.length > 0,
      results,
      lspAvailable: true,
      warmupInfo,
    };
  } catch (error) {
    printDebug(`[search] LSP search failed: ${(error as Error).message}`);
    return { success: false, results: [], lspAvailable: false };
  }
}

/**
 * Tier 2: parse the tree and look for a DECLARATION of `query`.
 *
 * Scoped to the languages the workspace actually contains — an unknown kind is
 * a hard rule error in ast-grep, and scanning nine grammars over a large tree
 * would cost more than the ripgrep tier we are trying to beat. If we cannot
 * name a language, we skip the tier entirely rather than guess.
 */
async function tryAstDefinitionSearch(
  query: string,
  target: string,
  fileTypes: string[],
  excludePaths: string[],
  maxResults: number,
): Promise<AstDefinition[]> {
  if (!isSafeSymbolName(query)) return [];

  const probe = await detectAstGrep();
  if (!probe.available) return [];

  const langs = await candidateAstLangs(fileTypes);
  if (langs.length === 0) return [];

  const definitions: AstDefinition[] = [];
  const deadline = Date.now() + AST_DEF_SEARCH_BUDGET_MS;

  for (const lang of langs) {
    if (definitions.length >= maxResults) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const result = await findDefinitions({
      name: query,
      lang,
      target,
      fileTypes,
      excludePaths,
      maxResults: maxResults - definitions.length,
      timeoutMs: Math.min(remaining, AST_DEF_SEARCH_BUDGET_MS),
    });

    if (result.ok) {
      definitions.push(...result.definitions);
    } else if (result.unavailable !== true) {
      printDebug(`[search] tree-sitter tier (${lang}): ${result.error ?? ""}`);
    }
  }

  return definitions.slice(0, maxResults);
}

/**
 * Explicit file_types win; otherwise take the languages ProjectDetector found
 * (cached, so this is nearly free). `.tsx`/`.jsx` are separate grammars from
 * `.ts`/`.js`, so a TS project implies both.
 */
async function candidateAstLangs(fileTypes: string[]): Promise<string[]> {
  const langs = new Set<string>();

  for (const ext of fileTypes) {
    const lang = astLangForExtension(ext);
    if (lang !== undefined) langs.add(lang);
  }

  if (langs.size === 0 && projectDetector !== undefined) {
    try {
      for (const project of await projectDetector.detectProjects()) {
        const lang = astLangForProjectLanguage(project.language);
        if (lang !== undefined) langs.add(lang);
      }
    } catch {
      /* detection is best-effort; an empty set just skips the tier */
    }
  }

  if (langs.has("ts")) langs.add("tsx");
  if (langs.has("js")) langs.add("jsx");

  return [...langs].filter((lang) => supportsDefinitionLookup(lang));
}

function getSymbolKindName(kind: number): string {
  const kinds: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    20: "Key",
    21: "Null",
    22: "EnumMember",
    23: "Struct",
    24: "Event",
    25: "Operator",
    26: "TypeParameter",
  };
  return kinds[kind] ?? "Unknown";
}

// ============================================================================
// Tool 2: get_references
// ============================================================================

export const findReferencesToolHandler: ToolHandler = {
  name: "get_references",
  description: `Find all usages of a symbol at a specific position using LSP.

Use the file_path, line, and column from a find_definition result.

Example: { "file_path": "src/user.ts", "line": 10, "column": 14 }`,

  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "File path from find_definition result",
      },
      line: {
        type: "integer",
        description: "1-based line number from find_definition result",
      },
      column: {
        type: "integer",
        description: "1-based column number from find_definition result",
      },
      max_results: {
        type: "integer",
        description: "Maximum results (default: 50)",
      },
      timeout_ms: {
        type: "integer",
        description: "LSP timeout in milliseconds (default: 30000)",
      },
    },
    required: ["file_path", "line", "column"],
  },

  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      const filePath = params["file_path"] as string;
      const line = params["line"] as number;
      const column = params["column"] as number;

      if (!filePath || typeof line !== "number" || typeof column !== "number") {
        return formatError("file_path, line, and column are required");
      }

      const maxResults = Math.min((params["max_results"] as number) ?? 50, 100);
      const timeoutMs = params["timeout_ms"] as number | undefined;

      const absoluteWorkingDir = path.resolve(context.workingDirectory);
      const absoluteFilePath = path.resolve(absoluteWorkingDir, filePath);

      const project =
        await getProjectDetector(absoluteWorkingDir).findProjectForFile(
          absoluteFilePath,
        );
      if (!project) {
        return formatError(`No project found for file: ${filePath}`);
      }

      const cache = getLSPCache();
      const client = await cache.getClient(project, timeoutMs);
      if (!client) {
        return formatError(`Could not start LSP for ${project.language}`);
      }

      try {
        const content = await readOverlayOrDisk(absoluteFilePath);
        const uri = `file://${absoluteFilePath}`;

        await client.openDocument(uri, project.language, content);
        await client.ensureProjectInitialized();

        const position = { line: line - 1, character: column - 1 };
        const references = await client.getReferences(uri, position, true);

        const results = references.slice(0, maxResults).map((ref) => ({
          file_path: ref.uri.replace("file://", ""),
          line: ref.range.start.line + 1,
          column: ref.range.start.character + 1,
        }));

        return formatResponse({
          references: results,
          total_count: references.length,
        });
      } catch (error) {
        const errMsg = (error as Error).message;
        const isTimeout =
          errMsg.includes("timeout") || errMsg.includes("Timeout");
        return formatError(`LSP references failed: ${errMsg}`, {
          language: project.language,
          isTimeout,
        });
      }
    } catch (error) {
      return formatError((error as Error).message);
    }
  },
};

// ============================================================================
// Tool 3: get_hover
// ============================================================================

export const getHoverToolHandler: ToolHandler = {
  name: "get_hover",
  description: `Get documentation and type information at a specific position using LSP.

Use the file_path, line, and column from a find_definition result.

Example: { "file_path": "src/user.ts", "line": 10, "column": 14 }`,

  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "File path from find_definition result",
      },
      line: {
        type: "integer",
        description: "1-based line number from find_definition result",
      },
      column: {
        type: "integer",
        description: "1-based column number from find_definition result",
      },
      timeout_ms: {
        type: "integer",
        description: "LSP timeout in milliseconds (default: 30000)",
      },
    },
    required: ["file_path", "line", "column"],
  },

  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      const filePath = params["file_path"] as string;
      const line = params["line"] as number;
      const column = params["column"] as number;

      if (!filePath || typeof line !== "number" || typeof column !== "number") {
        return formatError("file_path, line, and column are required");
      }

      const timeoutMs = params["timeout_ms"] as number | undefined;

      const absoluteWorkingDir = path.resolve(context.workingDirectory);
      const absoluteFilePath = path.resolve(absoluteWorkingDir, filePath);

      const project =
        await getProjectDetector(absoluteWorkingDir).findProjectForFile(
          absoluteFilePath,
        );
      if (!project) {
        return formatError(`No project found for file: ${filePath}`);
      }

      const cache = getLSPCache();
      const client = await cache.getClient(project, timeoutMs);
      if (!client) {
        return formatError(`Could not start LSP for ${project.language}`);
      }

      try {
        const content = await readOverlayOrDisk(absoluteFilePath);
        const uri = `file://${absoluteFilePath}`;

        await client.openDocument(uri, project.language, content);
        await client.ensureProjectInitialized();

        const position = { line: line - 1, character: column - 1 };
        const hover = await client.getHover(uri, position);

        if (!hover) {
          return formatResponse({
            documentation: null,
            message: "No hover information available at this position",
          });
        }

        let hoverText: string;
        if (typeof hover.contents === "string") {
          hoverText = hover.contents;
        } else if (Array.isArray(hover.contents)) {
          hoverText = hover.contents
            .map((c) => (typeof c === "string" ? c : c.value))
            .join("\n\n");
        } else {
          hoverText = hover.contents.value;
        }

        return formatResponse({
          documentation: hoverText,
          file_path: filePath,
          line,
          column,
        });
      } catch (error) {
        const errMsg = (error as Error).message;
        const isTimeout =
          errMsg.includes("timeout") || errMsg.includes("Timeout");
        return formatError(`LSP hover failed: ${errMsg}`, {
          language: project.language,
          isTimeout,
        });
      }
    } catch (error) {
      return formatError((error as Error).message);
    }
  },
};

// ============================================================================
// Tool 4: get_implementation
// ============================================================================

export const getImplementationToolHandler: ToolHandler = {
  name: "get_implementation",
  description: `Find implementations of an interface, trait, or abstract method using LSP.

Use the file_path, line, and column from a search result to find concrete implementations.
Useful for navigating from abstract types to their concrete implementations.

Example: { "file_path": "src/traits.rs", "line": 5, "column": 10 }`,

  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "File path from search result",
      },
      line: {
        type: "integer",
        description: "1-based line number from search result",
      },
      column: {
        type: "integer",
        description: "1-based column number from search result",
      },
      max_results: {
        type: "integer",
        description: "Maximum results (default: 50)",
      },
      timeout_ms: {
        type: "integer",
        description: "LSP timeout in milliseconds (default: 30000)",
      },
    },
    required: ["file_path", "line", "column"],
  },

  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      const filePath = params["file_path"] as string;
      const line = params["line"] as number;
      const column = params["column"] as number;

      if (!filePath || typeof line !== "number" || typeof column !== "number") {
        return formatError("file_path, line, and column are required");
      }

      const maxResults = Math.min((params["max_results"] as number) ?? 50, 100);
      const timeoutMs = params["timeout_ms"] as number | undefined;

      const absoluteWorkingDir = path.resolve(context.workingDirectory);
      const absoluteFilePath = path.resolve(absoluteWorkingDir, filePath);

      const project =
        await getProjectDetector(absoluteWorkingDir).findProjectForFile(
          absoluteFilePath,
        );
      if (!project) {
        return formatError(`No project found for file: ${filePath}`);
      }

      const cache = getLSPCache();
      const client = await cache.getClient(project, timeoutMs);
      if (!client) {
        return formatError(`Could not start LSP for ${project.language}`);
      }

      try {
        const content = await readOverlayOrDisk(absoluteFilePath);
        const uri = `file://${absoluteFilePath}`;

        await client.openDocument(uri, project.language, content);
        await client.ensureProjectInitialized();

        const position = { line: line - 1, character: column - 1 };
        const implementations = await client.getImplementation(uri, position);

        const results = implementations.slice(0, maxResults).map((impl) => ({
          file_path: impl.uri.replace("file://", ""),
          line: impl.range.start.line + 1,
          column: impl.range.start.character + 1,
        }));

        return formatResponse({
          implementations: results,
          total_count: implementations.length,
        });
      } catch (error) {
        const errMsg = (error as Error).message;
        const isTimeout =
          errMsg.includes("timeout") || errMsg.includes("Timeout");
        return formatError(`LSP implementation failed: ${errMsg}`, {
          language: project.language,
          isTimeout,
        });
      }
    } catch (error) {
      return formatError((error as Error).message);
    }
  },
};

// ============================================================================
// Export all tool handlers
// ============================================================================

export const searchToolHandlers: ToolHandler[] = [
  findReferencesToolHandler,
  getHoverToolHandler,
  searchToolHandler,
  getImplementationToolHandler,
];
