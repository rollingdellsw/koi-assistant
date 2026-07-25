import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs/promises";
import {
  ToolHandler,
  MCPToolResult,
  ServerContext,
  validatePath,
} from "../server.js";
import { printDebug } from "../utils/log.js";

export interface SearchReplaceParams {
  search: string;
  replace: string;
  file_pattern?: string;
  path?: string;
  regex?: boolean;
  case_sensitive?: boolean;
  free_run?: boolean;
  max_files?: number;
}

export interface FileReplacement {
  file_path: string;
  replacements: number;
  preview: string[]; // First few replacements
}

export interface DryRunResult {
  files_affected: number;
  total_replacements: number;
  file_details: FileReplacement[];
  would_exceed_limit: boolean;
}

/**
 * Find files containing the search pattern
 */
async function findMatchingFiles(
  search: string,
  filePattern: string,
  fullSearchPath: string,
  workingDir: string,
  regex: boolean,
  caseSensitive: boolean,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const args = ["rg", "--files-with-matches", "--null"];

    // Case sensitivity
    if (!caseSensitive) {
      args.push("--ignore-case");
    }

    // Search type
    if (regex) {
      args.push("--regexp", search);
    } else {
      args.push("--fixed-strings", search);
    }

    // File pattern (glob)
    if (filePattern) {
      args.push("--glob", filePattern);
    }

    // Default excludes
    args.push("--glob", "!.git/**");
    args.push("--glob", "!node_modules/**");
    args.push("--glob", "!dist/**");
    args.push("--glob", "!build/**");

    // Search path
    args.push(fullSearchPath);

    const [cmd, ...cmdArgs] = args;
    if (cmd === undefined) {
      reject(new Error("Empty command"));
      return;
    }

    const proc = spawn(cmd, cmdArgs, {
      cwd: workingDir,
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
      if (code === 0 || code === 1) {
        // Parse null-separated file list
        const files = stdout.split("\0").filter((f) => f.trim().length > 0);
        resolve(files);
      } else {
        reject(new Error(`ripgrep failed with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", reject);
  });
}

/**
 * Perform dry-run: calculate what would be replaced
 */
async function performDryRun(
  files: string[],
  search: string,
  replace: string,
  workingDir: string,
  regex: boolean,
  caseSensitive: boolean,
  maxFiles: number,
): Promise<DryRunResult> {
  const fileDetails: FileReplacement[] = [];
  let totalReplacements = 0;
  const wouldExceedLimit = files.length > maxFiles;

  // Limit processing to maxFiles
  const filesToProcess = files.slice(0, maxFiles);

  // Build regex for replacement
  let searchRegex: RegExp;
  if (regex) {
    const flags = caseSensitive ? "g" : "gi";
    try {
      searchRegex = new RegExp(search, flags);
    } catch (e) {
      throw new Error(`Invalid regex pattern: ${(e as Error).message}`);
    }
  } else {
    // Escape special regex characters for literal search
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = caseSensitive ? "g" : "gi";
    searchRegex = new RegExp(escaped, flags);
  }

  for (const file of filesToProcess) {
    const fullPath = path.resolve(workingDir, file);

    try {
      // Check if binary
      const buffer = await fs.readFile(fullPath);
      if (buffer.includes(0)) {
        // Skip binary files
        continue;
      }

      const content = buffer.toString("utf-8");
      const lines = content.split("\n");

      let fileReplacements = 0;
      const previews: string[] = [];

      lines.forEach((line, idx) => {
        const matches = line.match(searchRegex);
        if (matches !== null) {
          fileReplacements += matches.length;

          // Store preview (first 3 matches in this file)
          if (previews.length < 3) {
            const newLine = line.replace(searchRegex, replace);
            previews.push(
              `  Line ${idx + 1}:\n` +
                `    - ${line.trim()}\n` +
                `    + ${newLine.trim()}`,
            );
          }
        }
      });

      if (fileReplacements > 0) {
        fileDetails.push({
          file_path: file,
          replacements: fileReplacements,
          preview: previews,
        });
        totalReplacements += fileReplacements;
      }
    } catch (error) {
      printDebug(
        `[SearchReplace] Error processing ${file}: ${(error as Error).message}`,
      );
      // Continue with other files
    }
  }

  return {
    files_affected: fileDetails.length,
    total_replacements: totalReplacements,
    file_details: fileDetails,
    would_exceed_limit: wouldExceedLimit,
  };
}

/**
 * Apply replacements to files
 */
async function applyReplacements(
  files: FileReplacement[],
  search: string,
  replace: string,
  workingDir: string,
  regex: boolean,
  caseSensitive: boolean,
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Build regex
  let searchRegex: RegExp;
  if (regex) {
    const flags = caseSensitive ? "g" : "gi";
    searchRegex = new RegExp(search, flags);
  } else {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = caseSensitive ? "g" : "gi";
    searchRegex = new RegExp(escaped, flags);
  }

  for (const file of files) {
    const fullPath = path.resolve(workingDir, file.file_path);

    try {
      const content = await fs.readFile(fullPath, "utf-8");
      const newContent = content.replace(searchRegex, replace);

      // Atomic write: write to temp file, then rename
      const tempPath = `${fullPath}.tmp`;
      await fs.writeFile(tempPath, newContent, "utf-8");
      await fs.rename(tempPath, fullPath);
    } catch (error) {
      errors.push(`${file.file_path}: ${(error as Error).message}`);
    }
  }

  return {
    success: errors.length === 0,
    errors,
  };
}

/**
 * Main search and replace function
 */
async function searchAndReplace(
  params: SearchReplaceParams,
  workingDir: string,
): Promise<{ success: boolean; message: string; data?: unknown }> {
  const search = params.search;
  const replace = params.replace;
  const filePattern = params.file_pattern;
  const searchPath = params.path ?? ".";
  const regex = params.regex ?? false;
  const caseSensitive = params.case_sensitive ?? true;
  const freeRun = params.free_run ?? false;
  const maxFiles = params.max_files ?? 100;

  const validation = validatePath(searchPath, workingDir);
  if (!validation.valid) {
    return {
      success: false,
      message: `Invalid search path: ${validation.error}`,
    };
  }
  const fullSearchPath = validation.fullPath!;

  printDebug(
    `[SearchReplace] search="${search}", replace="${replace}", path="${searchPath}"`,
  );
  printDebug(
    `[SearchReplace] regex=${regex}, case_sensitive=${caseSensitive}, free_run=${freeRun}`,
  );

  try {
    // Step 1: Find matching files
    const matchingFiles = await findMatchingFiles(
      search,
      filePattern ?? "**/*",
      fullSearchPath,
      workingDir,
      regex,
      caseSensitive,
    );

    if (matchingFiles.length === 0) {
      return {
        success: true,
        message: "No matches found",
      };
    }

    printDebug(
      `[SearchReplace] Found ${matchingFiles.length} files with matches`,
    );

    // Step 2: Perform dry-run
    const dryRun = await performDryRun(
      matchingFiles,
      search,
      replace,
      workingDir,
      regex,
      caseSensitive,
      maxFiles,
    );

    if (dryRun.files_affected === 0) {
      return {
        success: true,
        message: "No replacements needed (pattern found but no changes)",
      };
    }

    printDebug(
      `[SearchReplace] Dry-run: ${dryRun.total_replacements} replacements in ${dryRun.files_affected} files`,
    );

    // Step 3: If not free-run, return preview for confirmation
    if (!freeRun) {
      // Format preview
      let preview = `## Search and Replace Preview\n\n`;
      preview += `**Files affected:** ${dryRun.files_affected}\n`;
      preview += `**Total replacements:** ${dryRun.total_replacements}\n\n`;

      if (dryRun.would_exceed_limit) {
        preview += `⚠️  **Warning:** More than ${maxFiles} files match. Showing first ${maxFiles} only.\n\n`;
      }

      preview += `### Preview (first 5 files):\n\n`;

      dryRun.file_details.slice(0, 5).forEach((file) => {
        preview += `**${file.file_path}** (${file.replacements} replacements)\n`;
        file.preview.forEach((p) => {
          preview += `${p}\n`;
        });
        preview += "\n";
      });

      if (dryRun.files_affected > 5) {
        preview += `... and ${dryRun.files_affected - 5} more files\n\n`;
      }

      preview += `\nTo proceed, call this tool again with **free_run=true**.\n`;
      preview += `To verify changes afterward, use: **git diff**\n`;

      return {
        success: false,
        message: preview,
        data: {
          requires_confirmation: true,
          files_affected: dryRun.files_affected,
          total_replacements: dryRun.total_replacements,
        },
      };
    }

    // Step 4: Apply replacements
    const result = await applyReplacements(
      dryRun.file_details,
      search,
      replace,
      workingDir,
      regex,
      caseSensitive,
    );

    if (!result.success) {
      return {
        success: false,
        message: `Completed with errors:\n${result.errors.join("\n")}`,
        data: {
          files_modified: dryRun.file_details.length - result.errors.length,
          errors: result.errors,
        },
      };
    }

    return {
      success: true,
      message: `Successfully replaced ${dryRun.total_replacements} occurrences in ${dryRun.files_affected} files.\nUse 'git diff' to review changes.`,
      data: {
        files_modified: dryRun.files_affected,
        total_replacements: dryRun.total_replacements,
      },
    };
  } catch (error) {
    printDebug(`[SearchReplace] Error: ${(error as Error).message}`);
    return {
      success: false,
      message: `Error: ${(error as Error).message}`,
    };
  }
}

export const searchAndReplaceToolHandler: ToolHandler = {
  name: "search_and_replace",
  description:
    "Search and replace across files. First call shows preview, second call with free_run=true applies.",

  inputSchema: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description: "Text or regex pattern to search for",
      },
      replace: {
        type: "string",
        description: "Replacement text (supports $1, $2 for regex groups)",
      },
      file_pattern: {
        type: "string",
        description: 'Glob pattern for files to include (e.g., "**/*.ts")',
      },
      path: {
        type: "string",
        description: 'Root directory to search (default: ".")',
      },
      regex: {
        type: "boolean",
        description: "Treat search as regex pattern (default: false)",
      },
      case_sensitive: {
        type: "boolean",
        description: "Case-sensitive search (default: true)",
      },
      free_run: {
        type: "boolean",
        description:
          "Skip confirmation and apply changes immediately (default: false)",
      },
      max_files: {
        type: "integer",
        description: "Maximum files to process (default: 100)",
      },
    },
    required: ["search", "replace"],
  },

  handler: async (
    params: Record<string, unknown>,
    context: ServerContext,
  ): Promise<MCPToolResult> => {
    try {
      if (typeof params["search"] !== "string") {
        throw new Error("search must be a string");
      }
      if (typeof params["replace"] !== "string") {
        throw new Error("replace must be a string");
      }

      const searchReplaceParams: SearchReplaceParams = {
        search: params["search"],
        replace: params["replace"],
        file_pattern:
          typeof params["file_pattern"] === "string"
            ? params["file_pattern"]
            : undefined,
        path: typeof params["path"] === "string" ? params["path"] : undefined,
        regex:
          typeof params["regex"] === "boolean" ? params["regex"] : undefined,
        case_sensitive:
          typeof params["case_sensitive"] === "boolean"
            ? params["case_sensitive"]
            : undefined,
        free_run:
          typeof params["free_run"] === "boolean"
            ? params["free_run"]
            : undefined,
        max_files:
          typeof params["max_files"] === "number"
            ? params["max_files"]
            : undefined,
      };

      const result = await searchAndReplace(
        searchReplaceParams,
        context.workingDirectory,
      );

      return {
        content: [
          {
            type: "text",
            text: result.message,
          },
        ],
        isError: !result.success,
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
