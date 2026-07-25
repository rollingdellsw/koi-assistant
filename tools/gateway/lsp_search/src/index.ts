#!/usr/bin/env node

import { createServer } from "./server.js";
import { LSPManager } from "./lsp-manager.js";
import { printDebug } from "./utils/log.js";
import {
  searchToolHandler,
  findReferencesToolHandler,
  getHoverToolHandler,
  getFileStructureToolHandler,
  searchAndReplaceToolHandler,
  getLspDiagnosticsToolHandler,
  getImplementationToolHandler,
  setWorkspaceToolHandler,
  syncDocumentToolHandler,
  closeDocumentToolHandler,
  syncResetToolHandler,
} from "./tools/index.js";
// Imported directly rather than through the tools barrel so this file compiles
// standalone; add `export * from "./search-ast.js"` to tools/index.ts if you
// prefer the barrel.
import {
  searchAstToolHandler,
  readAstNodeToolHandler,
} from "./tools/search-ast.js";
import { detectAstGrep, AST_GREP_INSTALL_HINT } from "./ast-grep.js";
import { describeToolchain, toolSearchPath } from "./tool-path.js";
import { getLSPCache } from "./lsp-cache.js";

// Re-export inlay hints API for use by fs MCP
export {
  getInlayHintsForFile,
  formatInlayHintsSection,
  shouldFetchInlayHints,
} from "./inlay-hints.js";

// Get working directory from env or use cwd
const workingDir = process.env["WORKING_DIR"] ?? process.cwd();

// Read-only mode for Koi Gateway embedding: search_and_replace writes to the
// REAL host tree, which would bypass the sandbox-shell overlay guarantee
// (all mutations must go through the sandbox and leave only as patches).
// Set SEARCH_MCP_READONLY=1 to expose navigation/diagnostics tools only.
const readOnly = process.env["SEARCH_MCP_READONLY"] === "1";

/**
 * Report which host tools we can actually see.
 *
 * This is the single most useful line in the log when someone says "it works
 * in my terminal": a systemd user service inherits a PATH without any per-user
 * toolchain directory, so tools that obviously exist are invisible to it.
 * Printing the resolved absolute path (or a clear "not found") turns a
 * mystifying "Could not start LSP" into a one-line diagnosis.
 */
function reportToolchain(): void {
  const tools = describeToolchain([
    "rg",
    "ast-grep",
    "typescript-language-server",
    "rust-analyzer",
    "gopls",
    "clangd",
    "pylsp",
    "cargo",
    "go",
  ]);

  printDebug("[Search MCP] Host tools:");
  for (const tool of tools) {
    printDebug(
      `[Search MCP]   ${tool.path === null ? "✗" : "✓"} ${tool.name}${tool.path === null ? "" : `: ${tool.path}`}`,
    );
  }
  if (tools.some((t) => t.path === null)) {
    printDebug(
      `[Search MCP]   searched ${toolSearchPath().length} directories; set KOI_TOOL_PATH=/extra/bin to add more`,
    );
  }
}

/**
 * Test and display LSP server availability at startup
 */
async function checkLspAvailability(workingDirectory: string): Promise<void> {
  printDebug("[Search MCP] Checking LSP server availability...");

  const lspManager = new LSPManager(workingDirectory);

  // Infer language first to optimize detection
  const inferredLanguage = await lspManager.inferLanguage();

  // Only check for the relevant LSP server to save time
  await lspManager.initialize(inferredLanguage);

  const summary = lspManager.getDetectedServersSummary();

  // Display available servers
  if (summary.available.length > 0) {
    printDebug("[Search MCP] ✓ Available LSP servers:");
    for (const server of summary.available) {
      printDebug(`[Search MCP]   • ${server.language}: ${server.command}`);
    }
  }

  // Check if the inferred project language has LSP support
  if (inferredLanguage !== undefined) {
    printDebug(`[Search MCP] Detected project language: ${inferredLanguage}`);

    const hasLspForProject = summary.available.some(
      (s) => s.language === inferredLanguage,
    );

    if (hasLspForProject) {
      printDebug(
        `[Search MCP] ✓ LSP support available for ${inferredLanguage}`,
      );
    } else {
      printDebug(`[Search MCP] ⚠ No LSP server found for ${inferredLanguage}`);
      printDebug(
        `[Search MCP]   Install the language server for better code intelligence:`,
      );
      printLspInstallHint(inferredLanguage);
    }
  }

  // Warn if no LSP servers are available at all
  if (summary.available.length === 0) {
    printDebug(
      "[Search MCP] ════════════════════════════════════════════════════════════",
    );
    printDebug("[Search MCP] ⚠ WARNING: No LSP servers detected!");
    printDebug("[Search MCP]");
    printDebug(
      "[Search MCP] Setting up LSP for your project is HIGHLY RECOMMENDED for",
    );
    printDebug("[Search MCP] LLM coding tasks. LSP provides:");
    printDebug(
      "[Search MCP]   • Precise error locations (get_lsp_diagnostics tool)",
    );
    printDebug(
      "[Search MCP]   • Symbol definitions and references (search_code tool)",
    );
    printDebug(
      "[Search MCP]   • Better code intelligence for the AI assistant",
    );
    printDebug("[Search MCP]");
    printDebug(
      "[Search MCP] Install a language server based on your project type:",
    );
    printDebug(
      "[Search MCP]   TypeScript: npm install -g typescript-language-server typescript",
    );
    printDebug("[Search MCP]   Python:     pip install python-lsp-server");
    printDebug("[Search MCP]   Rust:       rustup component add rust-analyzer");
    printDebug(
      "[Search MCP]   Go:         go install golang.org/x/tools/gopls@latest",
    );
    printDebug(
      "[Search MCP]   C/C++:      Install clangd (apt install clangd / brew install llvm)",
    );
    printDebug(
      "[Search MCP] ════════════════════════════════════════════════════════════",
    );
  }

  // Stop the manager (we'll create new instances as needed for actual operations)
  lspManager.stopAll();
}

/**
 * Print language-specific LSP installation hint
 */
function printLspInstallHint(language: string): void {
  const hints: Record<string, string> = {
    typescript: "  npm install -g typescript-language-server typescript",
    python: "  pip install python-lsp-server",
    rust: "  rustup component add rust-analyzer",
    go: "  go install golang.org/x/tools/gopls@latest",
    java: "  Install Eclipse JDT Language Server (jdtls)",
    cpp: "  Install clangd: apt install clangd / brew install llvm",
    c: "  Install clangd: apt install clangd / brew install llvm",
  };

  const hint = hints[language];
  if (hint !== undefined) {
    printDebug(`[Search MCP] ${hint}`);
  }
}

/**
 * Report the optional structural-search backend at startup.
 * ast-grep is not required: search_ast degrades to an install hint and every
 * other tool is unaffected, so this is informational only.
 */
async function checkAstGrepAvailability(): Promise<void> {
  const probe = await detectAstGrep();
  if (probe.available) {
    printDebug(
      `[Search MCP] ✓ Structural search available: ${probe.version ?? "ast-grep"}`,
    );
  } else {
    printDebug(
      "[Search MCP] ⚠ ast-grep not found — search_ast / read_ast_node disabled,",
    );
    printDebug(
      "[Search MCP]   and 'search' loses its tree-sitter fallback tier.",
    );
    for (const line of AST_GREP_INSTALL_HINT.split("\n")) {
      printDebug(`[Search MCP]   ${line}`);
    }
  }
}

const server = createServer({
  name: "search-server",
  version: "1.0.0",
  workingDirectory: workingDir,
  tools: [
    setWorkspaceToolHandler,
    searchToolHandler,
    findReferencesToolHandler,
    getHoverToolHandler,
    getFileStructureToolHandler,
    ...(readOnly ? [] : [searchAndReplaceToolHandler]),
    getLspDiagnosticsToolHandler,
    getImplementationToolHandler,
    // Tree-sitter tier. Both are read-only (no host writes), so they stay
    // registered in read-only mode alongside the navigation tools.
    searchAstToolHandler,
    readAstNodeToolHandler,
    // Design 2: editor-style document sync (safe in read-only mode; no host writes)
    syncDocumentToolHandler,
    closeDocumentToolHandler,
    syncResetToolHandler,
  ],
});

// Start server immediately to handle 'initialize' request and avoid timeout
server.start();

// Proactive LSP Warmup: Start indexing immediately in background for Rust/C++
getLSPCache().startWarmup(workingDir);

reportToolchain();

// Probe the optional structural-search backend (never fatal)
checkAstGrepAvailability().catch(() => {
  /* detection failures are already reported as "not found" */
});

// Run LSP check in background
checkLspAvailability(workingDir).catch((error) => {
  // Log warning only, do not crash the server
  printDebug(
    `[Search MCP] LSP availability check skipped: ${(error as Error).message}`,
  );
  printDebug(`[Search MCP] LSP check debug: ${(error as Error).stack}`);
});

printDebug(
  `[Search MCP Server] Initialized with working directory: ${workingDir}`,
);
