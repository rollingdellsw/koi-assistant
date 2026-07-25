/**
 * Document sync tools (Design 2: editor-style LSP sync).
 *
 * These are the counterpart of the sandbox-shell overlay. The sandbox server
 * calls sync_document after every write/patch with the current overlay content,
 * so the language servers reflect in-session edits without depending on overlay
 * mount visibility. They also keep the text-search overlay (readOverlayOrDisk)
 * current so navigation resolves against edited files.
 *
 * sync_document  — upsert a file's buffer and push didOpen/didChange
 * close_document — drop a file's buffer and send didClose
 * sync_reset     — clear all buffers (called on workspace switch / reset)
 *
 * These tools never write to the host tree; they only update in-memory state
 * and notify language servers. They are safe in SEARCH_MCP_READONLY mode.
 */
import * as path from "path";
import {
  ToolHandler,
  MCPToolResult,
  ServerContext,
  validatePath,
} from "../server.js";
import { ProjectDetector } from "../project-detector.js";
import { getLSPCache } from "../lsp-cache.js";
import { printDebug } from "../utils/log.js";
import {
  setOverlay,
  markOpen,
  deleteOverlay,
  clearOverlay,
  listOverlayPaths,
} from "../document-overlay.js";

let detector: ProjectDetector | undefined;

function ok(payload: Record<string, unknown>): MCPToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}
function err(message: string): MCPToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/** Push the given content to the language server for a file, if one exists. */
async function notifyLsp(
  workingDirectory: string,
  fullPath: string,
  text: string,
): Promise<{ synced: boolean; language?: string; note?: string }> {
  const absoluteWorkingDir = path.resolve(workingDirectory);
  if (!detector) detector = new ProjectDetector(absoluteWorkingDir);
  const project = await detector.findProjectForFile(fullPath).catch(() => null);
  if (!project)
    return { synced: false, note: "no project/language server for this file" };

  const client = await getLSPCache()
    .getClient(project)
    .catch(() => null);
  if (!client)
    return {
      synced: false,
      language: project.language,
      note: "language server unavailable",
    };

  const uri = `file://${fullPath}`;
  // openDocument is idempotent: sends didOpen the first time, didChange after.
  await client.openDocument(uri, project.language, text);
  markOpen(fullPath);
  return { synced: true, language: project.language };
}

export const syncDocumentToolHandler: ToolHandler = {
  name: "sync_document",
  description:
    "Register or update the in-session content of a file so code intelligence " +
    "reflects edits that live in the sandbox overlay (not yet on disk). The " +
    "sandbox-shell server calls this automatically after each write/patch; you " +
    "normally do not call it directly. Forwards didOpen/didChange to the language server.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute, or relative to the workspace root)",
      },
      text: { type: "string", description: "Full current content of the file" },
    },
    required: ["path", "text"],
  },
  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      const p = params["path"];
      const text = params["text"];
      if (typeof p !== "string" || p.length === 0)
        throw new Error("path must be a non-empty string");
      if (typeof text !== "string") throw new Error("text must be a string");

      const validation = validatePath(p, context.workingDirectory);
      if (!validation.valid)
        throw new Error(validation.error ?? "invalid path");
      const fullPath = validation.fullPath!;

      const doc = setOverlay(fullPath, text);
      const lsp = await notifyLsp(context.workingDirectory, fullPath, text);
      return ok({
        path: fullPath,
        version: doc.version,
        bytes: Buffer.byteLength(text),
        ...lsp,
      });
    } catch (e) {
      printDebug(`[sync_document] ${(e as Error).message}`);
      return err((e as Error).message);
    }
  },
};

export const closeDocumentToolHandler: ToolHandler = {
  name: "close_document",
  description:
    "Drop a file's in-session buffer (e.g. after it is deleted or shipped) and " +
    "send didClose to the language server. Called automatically by sandbox-shell.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (absolute, or relative to the workspace root)",
      },
    },
    required: ["path"],
  },
  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      const p = params["path"];
      if (typeof p !== "string" || p.length === 0)
        throw new Error("path must be a non-empty string");
      const validation = validatePath(p, context.workingDirectory);
      if (!validation.valid)
        throw new Error(validation.error ?? "invalid path");
      const fullPath = validation.fullPath!;

      deleteOverlay(fullPath);
      const uri = `file://${fullPath}`;
      try {
        if (!detector)
          detector = new ProjectDetector(
            path.resolve(context.workingDirectory),
          );
        const project = await detector
          .findProjectForFile(fullPath)
          .catch(() => null);
        if (project) {
          const client = await getLSPCache()
            .getClient(project)
            .catch(() => null);
          client?.closeDocument(uri);
        }
      } catch {
        /* best effort */
      }
      return ok({ path: fullPath, closed: true });
    } catch (e) {
      return err((e as Error).message);
    }
  },
};

export const syncResetToolHandler: ToolHandler = {
  name: "sync_reset",
  description:
    "Clear all in-session document buffers (called when the workspace switches " +
    "or the sandbox overlay is reset, so code intelligence returns to the host tree).",
  inputSchema: { type: "object", properties: {} },
  handler: async (
    _params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    const paths = listOverlayPaths();
    clearOverlay();
    // Best-effort didClose for everything we had open.
    try {
      if (!detector)
        detector = new ProjectDetector(path.resolve(context.workingDirectory));
      for (const fullPath of paths) {
        const project = await detector
          .findProjectForFile(fullPath)
          .catch(() => null);
        if (!project) continue;
        const client = await getLSPCache()
          .getClient(project)
          .catch(() => null);
        client?.closeDocument(`file://${fullPath}`);
      }
    } catch {
      /* best effort */
    }
    return ok({ cleared: paths.length });
  },
};

/** Reset the module-local detector when the workspace root changes. */
export function resetDocumentSync(): void {
  detector = undefined;
}
