/**
 * Inlay Hints Service
 *
 * Provides LSP inlay hints (inferred types, parameter names) for files.
 * Used by read_file in the fs MCP to enrich code with type information.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { getLSPCache } from "./lsp-cache.js";
import { ProjectDetector } from "./project-detector.js";
import { InlayHint, InlayHintKind, LSPRange } from "./lsp-client.js";
import { printDebug } from "./utils/log.js";

/** Languages that benefit from inlay hints (heavy type inference) */
const INLAY_HINT_LANGUAGES = new Set(["rust", "typescript", "cpp"]);

/** File extensions mapped to language IDs */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ".rs": "rust",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".h": "cpp",
  ".c": "cpp",
};

/** Default line window for inlay hints */
const DEFAULT_LINE_WINDOW = 100;

/** Timeout for inlay hint requests (ms) - keep short, hints are nice-to-have */
const INLAY_HINT_TIMEOUT_MS = 300000;

/** Noise patterns to filter out from inlay hints */
const NOISE_PATTERNS = [
  /^default:?$/, // Default parameter names
  /^value:?$/, // Generic "value" parameter
  /^data:?$/, // Generic "data" parameter
  /^-> \(\)$/, // Unit return type
  /^: \(\)$/, // Unit type annotation
  /^'[0-9]+,?$/, // Anonymous lifetime like '0, '1, (with optional comma)
  /'[0-9]+,\s*$/, // Trailing lifetime with comma like "'0, '1,"
  /^'[0-9]+,\s*'[0-9]+,?$/, // Multiple lifetimes like "'0, '1" or "'0, '1,"
  /^<'[0-9].*>$/, // Generic lifetime params like <'0, '1>
  /^self:?$/, // Standalone self parameter hint
  /^&mut\s*self:?$/, // &mut self parameter hint
  /^&self:?$/, // &self parameter hint
  /^[a-z_][a-z0-9_]*:$/i, // Standalone parameter name hints like "node_ref:"
  /^fn\s+[a-z_][a-z0-9_]*$/i, // Function name hints like "fn insert_recursive"
];

/** Parameter names that are noise on their own but useful with types */
const NOISE_PARAM_NAMES = new Set(["self", "&self", "&mut self"]);

/** Types that are too simple to be useful as hints */
const SIMPLE_TYPES = new Set([
  "bool",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
  "f32",
  "f64",
  "char",
  "str",
  "String",
  "number",
  "string",
  "boolean",
  "void",
  "null",
  "undefined",
  "int",
  "float",
  "double",
  "char",
  "void",
]);

export interface FormattedInlayHint {
  line: number; // 1-based line number
  column: number; // 0-based column for ordering
  kind: "type" | "parameter";
  hint: string;
  label?: string; // Optional label/identifier the hint applies to
}

export interface InlayHintsResult {
  hints: FormattedInlayHint[];
  language: string;
  error?: string;
}

/**
 * Check if a file should have inlay hints fetched
 */
export function shouldFetchInlayHints(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const lang = EXT_TO_LANGUAGE[ext];
  return lang !== undefined && INLAY_HINT_LANGUAGES.has(lang);
}

/**
 * Get the language ID for a file path
 */
export function getLanguageForFile(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANGUAGE[ext];
}

/**
 * Check if a hint should be filtered out as noise
 */
function isNoiseHint(hint: string, kind: "type" | "parameter"): boolean {
  const trimmed = hint.trim();

  // Check against noise patterns
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // Filter standalone self parameter names (but keep "self:" with type info)
  if (kind === "parameter" && NOISE_PARAM_NAMES.has(trimmed)) {
    return true;
  }

  // Filter simple types (only for type hints, not parameters)
  if (kind === "type") {
    // Extract the core type (handle ": Type" format)
    const typeMatch = trimmed.match(/^:?\s*(.+)$/);
    const coreType = typeMatch ? typeMatch[1].trim() : trimmed;
    if (SIMPLE_TYPES.has(coreType)) {
      return true;
    }
  }

  return false;
}

/**
 * Fetch inlay hints for a file range.
 *
 * @param filePath - Absolute path to the file
 * @param startLine - 1-based start line (default: 1)
 * @param endLine - 1-based end line (default: startLine + DEFAULT_LINE_WINDOW)
 * @param workspaceRoot - Workspace root for project detection
 * @returns Formatted inlay hints or empty result
 */
export async function getInlayHintsForFile(
  filePath: string,
  startLine: number = 1,
  endLine?: number,
  workspaceRoot?: string,
): Promise<InlayHintsResult> {
  const language = getLanguageForFile(filePath);
  if (!language) {
    return { hints: [], language: "unknown" };
  }

  const effectiveEndLine = endLine ?? startLine + DEFAULT_LINE_WINDOW - 1;

  try {
    // Find project for this file
    const detector = new ProjectDetector(
      workspaceRoot ?? path.dirname(filePath),
    );
    printDebug(
      `[InlayHints] Using workspaceRoot: ${workspaceRoot ?? path.dirname(filePath)} for file: ${filePath}`,
    );
    const project = await detector.findProjectForFile(filePath);

    if (!project) {
      printDebug(`[InlayHints] No project found for ${filePath}`);
      return { hints: [], language };
    }
    printDebug(`[InlayHints] Found project: ${JSON.stringify(project)}`);

    // Get LSP client
    const cache = getLSPCache();
    const client = await cache.getClient(project, INLAY_HINT_TIMEOUT_MS);

    if (!client) {
      printDebug(
        `[InlayHints] Could not get LSP client for ${project.language}`,
      );
      return { hints: [], language };
    }

    // Read file content and open document
    const content = await fs.readFile(filePath, "utf-8");
    const uri = `file://${filePath}`;
    await client.openDocument(uri, project.language, content);

    // CRITICAL: Wait for LSP to finish indexing (especially for Rust)
    await client.ensureProjectInitialized();

    // Convert 1-based line numbers to 0-based LSP range
    const range: LSPRange = {
      start: { line: startLine - 1, character: 0 },
      end: { line: effectiveEndLine - 1, character: 1000000000 }, // Safe limit < 2^31
    };

    // Fetch inlay hints
    const hints = await client.getInlayHints(uri, range);

    printDebug(
      `[InlayHints] Received ${hints.length} hints for ${path.basename(filePath)}`,
    );

    if (hints.length === 0) {
      return { hints: [], language };
    }

    // Format hints for output
    const formattedHints = formatInlayHints(hints, content);

    printDebug(
      `[InlayHints] Got ${formattedHints.length} hints for ${filePath}`,
    );
    return { hints: formattedHints, language };
  } catch (error) {
    printDebug(`[InlayHints] Error: ${(error as Error).message}`);
    return { hints: [], language, error: (error as Error).message };
  }
}

/**
 * Format raw LSP inlay hints into our output format
 */
function formatInlayHints(
  hints: InlayHint[],
  content: string,
): FormattedInlayHint[] {
  const lines = content.split("\n");
  const result: FormattedInlayHint[] = [];

  for (const hint of hints) {
    // Convert 0-based LSP line to 1-based display line
    const line = hint.position.line + 1;
    const column = hint.position.character;

    // Determine hint kind
    const kind: "type" | "parameter" =
      hint.kind === InlayHintKind.Parameter ? "parameter" : "type";

    // Extract hint text from label
    let hintText: string;
    if (typeof hint.label === "string") {
      hintText = hint.label;
    } else if (Array.isArray(hint.label)) {
      hintText = hint.label.map((part) => part.value).join("");
    } else {
      hintText = String(hint.label);
    }

    // Clean up hint text (remove leading ": " for types if present)
    hintText = hintText.trim();

    // Filter out noise
    if (isNoiseHint(hintText, kind)) {
      continue;
    }

    // Try to extract the identifier this hint applies to
    let label: string | undefined;
    const sourceLine = lines[hint.position.line];
    if (sourceLine && column > 0) {
      // Look backwards from hint position to find identifier
      const beforeHint = sourceLine.slice(0, column);
      const identMatch = beforeHint.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
      if (identMatch) {
        label = identMatch[1];
      }
    }

    // Filter orphan type hints (types without associated identifier)
    // These are intermediate chain types that aren't bound to variables
    if (kind === "type" && !label && !hintText.startsWith("->")) {
      // Check if it looks like an intermediate type (Option<...>, Result<...>, etc.)
      if (
        /^(Option|Result|Vec|Box|Rc|Arc|RefCell|Cell|Ref|RefMut)</.test(
          hintText,
        )
      ) {
        continue;
      }
    }

    result.push({
      line,
      column,
      kind,
      hint: hintText,
      label,
    });
  }

  // Sort by line, then column for consistent output
  result.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });

  // Deduplicate hints on same line with same content
  const seen = new Set<string>();
  return result.filter((h) => {
    const key = `${h.line}:${h.hint}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Format inlay hints as a text section for appending to file content
 */
export function formatInlayHintsSection(result: InlayHintsResult): string {
  if (result.hints.length === 0) {
    return "";
  }

  // Group hints by line for more readable output
  const byLine = new Map<number, FormattedInlayHint[]>();
  for (const hint of result.hints) {
    const existing = byLine.get(hint.line) ?? [];
    existing.push(hint);
    byLine.set(hint.line, existing);
  }

  const lines: string[] = [];
  const sortedLineNums = Array.from(byLine.keys()).sort((a, b) => a - b);

  for (const lineNum of sortedLineNums) {
    const hintsOnLine = byLine.get(lineNum) ?? [];
    // Format each hint with optional label context
    const formatted = hintsOnLine.map((h) => {
      if (h.label && h.kind === "type") {
        // Show as "identifier => Type" for type hints
        const typeText = h.hint.startsWith(":")
          ? h.hint.slice(1).trim()
          : h.hint;
        return `(${h.label}) => ${typeText}`;
      } else if (h.label && h.kind === "parameter") {
        // Show as "param_name:" for parameter hints
        return `${h.hint}`;
      } else {
        return h.hint;
      }
    });
    lines.push(`L${lineNum}: ${formatted.join(", ")}`);
  }

  return `\n[INLAY HINTS (${result.language})]\n${lines.join("\n")}`;
}
