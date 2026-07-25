import * as path from "path";
import {
  ToolHandler,
  MCPToolResult,
  ServerContext,
  validatePath,
} from "../server.js";
import { LSPManager } from "../lsp-manager.js";
import { readOverlayOrDisk } from "../document-overlay.js";
import { LSPDiagnostic } from "../lsp-client.js";
import { printDebug } from "../utils/log.js";

// Singleton LSP manager (shared with search-code.ts)
let lspManager: LSPManager | undefined;

/**
 * Reset the singleton. Called by set_workspace when the workspace root
 * changes: the manager is bound to the old root's working directory, so
 * keeping it would serve stale project detection and clients.
 */
export function resetLspManager(): void {
  if (lspManager) {
    lspManager.stopAll();
    lspManager = undefined;
  }
}

export interface GetLspDiagnosticsParams {
  file_path: string;
  severity_filter?: "error" | "warning" | "info" | "hint" | "all";
  offset?: number;
  limit?: number;
}

export interface DiagnosticInfo {
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  severity: string;
  message: string;
  code?: string | number;
  source?: string;
}

export interface DiagnosticsResponse {
  file_path: string;
  language: string;
  total_count: number;
  returned_count: number;
  diagnostics: DiagnosticInfo[];
  /**
   * Always "lsp": a successful response means a language server actually
   * analyzed the file. Unavailability is thrown, never returned, so an empty
   * `diagnostics` array unambiguously means "clean".
   */
  backend: "lsp";
}

/**
 * Map LSP severity number to string
 */
function severityToString(severity?: number): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "unknown";
  }
}

/**
 * Map severity string to LSP number for filtering
 */
function severityToNumber(severity: string): number | undefined {
  switch (severity) {
    case "error":
      return 1;
    case "warning":
      return 2;
    case "info":
      return 3;
    case "hint":
      return 4;
    default:
      return undefined;
  }
}

/**
 * Detect language ID from file extension
 */
function detectLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const languageMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact", // Must be typescriptreact for JSX support
    ".js": "javascript",
    ".jsx": "javascriptreact", // Must be javascriptreact for JSX support
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
  };
  return languageMap[ext] ?? "plaintext";
}

/**
 * Get LSP diagnostics for a file
 */
async function getLspDiagnostics(
  params: GetLspDiagnosticsParams,
  workingDir: string,
): Promise<DiagnosticsResponse> {
  const filePath = params.file_path;
  const severityFilter = params.severity_filter ?? "all";
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;

  // Validate path
  const validation = validatePath(filePath, workingDir);
  if (!validation.valid) {
    throw new Error(`Invalid file path: ${validation.error}`);
  }
  const fullPath = validation.fullPath!;

  // Check file exists
  let content: string;
  try {
    content = await readOverlayOrDisk(fullPath);
  } catch (error) {
    throw new Error(`Failed to read file: ${(error as Error).message}`);
  }

  const languageId = detectLanguageId(filePath);
  const fileUri = `file://${fullPath}`;

  printDebug(
    `[LspDiagnostics] Getting diagnostics for ${filePath} (${languageId})`,
  );

  // Initialize LSP manager if needed
  if (!lspManager) {
    lspManager = new LSPManager(workingDir);

    // Optimize: Infer language first, then only initialize that one
    // This prevents checking for Python/Go/etc when we only need TypeScript
    const inferred = await lspManager.inferLanguage();
    if (inferred) {
      await lspManager.initialize(inferred);
    }
  }

  // Try to get LSP client for this language
  const language = await lspManager.inferLanguage();
  if (!language) {
    // Do NOT return an empty-but-successful result here. "no diagnostics"
    // and "nothing analyzed the file" are indistinguishable to a caller that
    // does not inspect `backend`, so a silent degradation reads as a clean
    // bill of health and real errors get shipped. Fail loudly instead.
    throw new Error(
      `No language server available for ${filePath} (detected language: ` +
        `${languageId}). Diagnostics were NOT checked — this is not the same ` +
        `as the file being clean. Run the project's own compiler/linter ` +
        `(e.g. tsc --noEmit, cargo check) to verify it.`,
    );
  }

  const client = await lspManager.getClientForLanguage(language);
  if (!client) {
    throw new Error(
      `Language server for '${language}' could not be started, so ${filePath} ` +
        `was NOT analyzed. This is not the same as the file being clean. ` +
        `Check that the server is installed and on PATH, or run the project's ` +
        `own compiler/linter to verify.`,
    );
  }

  // Set up the waiter BEFORE opening the document to avoid race conditions
  // Wait up to 3 seconds for the server to analyze the file
  const diagnosticsPromise = client.waitForDiagnostics(fileUri, 3000);

  // Open document to trigger diagnostics
  await client.openDocument(fileUri, languageId, content);

  // Wait for the server to publish results
  let diagnostics = await diagnosticsPromise;

  // Filter by severity if specified
  if (severityFilter !== "all") {
    const targetSeverity = severityToNumber(severityFilter);
    if (targetSeverity !== undefined) {
      diagnostics = diagnostics.filter((d) => d.severity === targetSeverity);
    }
  }

  const totalCount = diagnostics.length;

  // Apply pagination
  const paginatedDiagnostics = diagnostics.slice(offset, offset + limit);

  // Transform to response format
  const result: DiagnosticInfo[] = paginatedDiagnostics.map(
    (d: LSPDiagnostic) => ({
      line: d.range.start.line + 1, // Convert to 1-based
      column: d.range.start.character + 1,
      end_line: d.range.end.line + 1,
      end_column: d.range.end.character + 1,
      severity: severityToString(d.severity),
      message: d.message,
      code: d.code,
      source: d.source,
    }),
  );

  // Close document (optional - keeps memory clean)
  client.closeDocument(fileUri);

  printDebug(
    `[LspDiagnostics] Found ${totalCount} diagnostics, returning ${result.length}`,
  );

  return {
    file_path: filePath,
    language: languageId,
    total_count: totalCount,
    returned_count: result.length,
    diagnostics: result,
    backend: "lsp",
  };
}

export const getLspDiagnosticsToolHandler: ToolHandler = {
  name: "get_lsp_diagnostics",
  description:
    "Get LSP diagnostics (errors, warnings) for a source file. Use after build failures to see exact error locations.",

  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the source file to analyze",
      },
      severity_filter: {
        type: "string",
        enum: ["error", "warning", "info", "hint", "all"],
        description: "Filter by severity level (default: all)",
      },
      offset: {
        type: "integer",
        description: "Pagination offset (default: 0)",
      },
      limit: {
        type: "integer",
        description: "Maximum diagnostics to return (default: 100)",
      },
    },
    required: ["file_path"],
  },

  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      if (typeof params["file_path"] !== "string") {
        throw new Error("file_path must be a string");
      }

      const diagnosticsParams: GetLspDiagnosticsParams = {
        file_path: params["file_path"],
        severity_filter:
          typeof params["severity_filter"] === "string"
            ? (params["severity_filter"] as
                | "error"
                | "warning"
                | "info"
                | "hint"
                | "all")
            : undefined,
        offset:
          typeof params["offset"] === "number" ? params["offset"] : undefined,
        limit:
          typeof params["limit"] === "number" ? params["limit"] : undefined,
      };

      const result = await getLspDiagnostics(
        diagnosticsParams,
        context.workingDirectory,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  },
};
