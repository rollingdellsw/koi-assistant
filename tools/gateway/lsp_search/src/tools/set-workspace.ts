import * as fs from "fs/promises";
import * as path from "path";
import { ToolHandler, MCPToolResult, ServerContext } from "../server.js";
import { getLSPCache } from "../lsp-cache.js";
import { resetLspManager } from "./lsp-diagnostics.js";
import { printDebug, printInfo } from "../utils/log.js";
import { clearOverlay } from "../document-overlay.js";
import { resetDocumentSync } from "./document-sync.js";

/**
 * set_workspace — switch the workspace root at runtime.
 *
 * The lsp_search server is not tied to a single project (mirrors
 * sandbox_open_project on the sandbox server): the session picks the project
 * when it starts working and can switch freely. Switching:
 *   - repoints context.workingDirectory (path validation root for all tools)
 *   - resets the diagnostics LSPManager singleton (was bound to the old root)
 *   - stops the cached LSP client so the next query re-detects the project
 *   - re-triggers background warmup (rust-analyzer / clangd indexing)
 */
export const setWorkspaceToolHandler: ToolHandler = {
  name: "set_workspace",
  description:
    "Switch the workspace root for all search/LSP tools. Call this FIRST with the absolute " +
    "project path before using search, get_references, get_lsp_diagnostics, etc., and again " +
    "whenever you switch projects (keep it in sync with sandbox_open_project). " +
    "Slow-indexing languages (Rust, C/C++) start warming up in the background immediately.",

  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path to the project / workspace root on the host",
      },
    },
    required: ["path"],
  },

  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      if (typeof params["path"] !== "string" || params["path"].length === 0) {
        throw new Error("path must be a non-empty string");
      }
      const requested = path.resolve(params["path"]);

      const stat = await fs.stat(requested).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        throw new Error(`not a directory: ${requested}`);
      }

      const previous = context.workingDirectory;
      if (path.resolve(previous) === requested) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  workspace: requested,
                  changed: false,
                  note: "workspace already active",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      printInfo(
        `[SetWorkspace] Switching workspace: ${previous} -> ${requested}`,
      );
      context.workingDirectory = requested;

      // Drop state bound to the old root; next query re-detects the project.
      // Also drop in-session document buffers — they belonged to the old workspace.
      clearOverlay();
      resetDocumentSync();
      resetLspManager();
      await getLSPCache().stopCurrent();

      // Kick background indexing for slow languages in the new workspace.
      getLSPCache().restartWarmup(requested);

      const result = {
        workspace: requested,
        previous,
        changed: true,
        note:
          "LSP re-initializes on the next query. Rust/C++ projects index in the background — " +
          "if an early query times out or returns few results, retry after a moment.",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      printDebug(`[SetWorkspace] Error: ${(error as Error).message}`);
      return {
        content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
};
