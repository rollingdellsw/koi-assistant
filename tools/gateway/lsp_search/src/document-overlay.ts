/**
 * Document overlay store (Design 2: editor-style sync).
 *
 * The sandbox-shell server edits files in an overlay filesystem that the
 * language servers (which index the read-only host tree) cannot see. Instead
 * of relying on mount visibility, the sandbox pushes the current buffer for
 * each edited file here via the sync_document tool. This module is the single
 * source of truth for in-session edits: the sync tools forward the text to the
 * relevant language server as didOpen/didChange, and every disk read performed
 * by the navigation/diagnostics tools is routed through readOverlayOrDisk so
 * queries reflect unshipped edits instead of stale on-disk content.
 *
 * Lifetime mirrors a session: cleared on set_workspace / sandbox_open_project /
 * sandbox_reset (via sync_reset), so a new session starts from the host tree.
 */
import * as fs from "fs/promises";

export interface OverlayDoc {
  text: string;
  version: number; // LSP document version, bumped on every change
  open: boolean; // whether didOpen has been sent to a language server
}

const overlay = new Map<string, OverlayDoc>();

function normalize(fullPath: string): string {
  return fullPath;
}

export function getOverlay(fullPath: string): OverlayDoc | undefined {
  return overlay.get(normalize(fullPath));
}

export function hasOverlay(fullPath: string): boolean {
  return overlay.has(normalize(fullPath));
}

/** Upsert overlay content, bumping the version. Returns the new record. */
export function setOverlay(fullPath: string, text: string): OverlayDoc {
  const key = normalize(fullPath);
  const prev = overlay.get(key);
  const doc: OverlayDoc = {
    text,
    version: (prev?.version ?? 0) + 1,
    open: prev?.open ?? false,
  };
  overlay.set(key, doc);
  return doc;
}

export function markOpen(fullPath: string): void {
  const doc = overlay.get(normalize(fullPath));
  if (doc) doc.open = true;
}

export function deleteOverlay(fullPath: string): OverlayDoc | undefined {
  const key = normalize(fullPath);
  const doc = overlay.get(key);
  overlay.delete(key);
  return doc;
}

export function listOverlayPaths(): string[] {
  return [...overlay.keys()];
}

export function clearOverlay(): string[] {
  const keys = [...overlay.keys()];
  overlay.clear();
  return keys;
}

/**
 * Read a file's content, preferring the in-session overlay buffer over disk.
 * All LSP tools that open a document should read through this so a synced edit
 * is not clobbered by the (stale) on-disk version.
 */
export async function readOverlayOrDisk(fullPath: string): Promise<string> {
  const doc = overlay.get(normalize(fullPath));
  if (doc) return doc.text;
  return fs.readFile(fullPath, "utf-8");
}
