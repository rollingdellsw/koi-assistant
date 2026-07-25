import * as fs from "fs/promises";
import * as path from "path";
import { ToolHandler, MCPToolResult, ServerContext } from "../server.js";
import { LSPManager } from "../lsp-manager.js";
import { DocumentSymbol, SymbolInformation } from "../lsp-client.js";
import { printDebug } from "../utils/log.js";

// Singleton LSP manager
let lspManager: LSPManager | undefined;

export interface FileStructureParams {
  file_path: string;
  include_private?: boolean;
  max_depth?: number;
}

export interface FunctionInfo {
  name: string;
  signature: string;
  line_start: number;
  line_end: number;
  is_async: boolean;
  decorators?: string[];
}

export interface MethodInfo {
  name: string;
  signature: string;
  line: number;
  is_async: boolean;
}

export interface ClassInfo {
  name: string;
  line_start: number;
  line_end: number;
  methods: MethodInfo[];
  parent_class?: string;
}

export interface ImportInfo {
  module: string;
  names: string[];
  line: number;
  is_relative: boolean;
}

export interface GlobalVariableInfo {
  name: string;
  line: number;
  type_hint?: string;
}

export interface FileStructure {
  language: string;
  file_size: number;
  line_count: number;
  classes: ClassInfo[];
  functions: FunctionInfo[];
  imports: ImportInfo[];
  exports: string[];
  global_variables: GlobalVariableInfo[];
  parse_backend: "lsp" | "regex";
}

/**
 * Detect language from file extension
 */
function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const languageMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
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
  return languageMap[ext] ?? "unknown";
}

/**
 * Map language string to LSP language ID
 */
function getLanguageId(language: string): string {
  const map: Record<string, string> = {
    typescript: "typescript",
    javascript: "javascript",
    rust: "rust",
    python: "python",
    go: "go",
    java: "java",
    cpp: "cpp",
    c: "c",
  };
  return map[language] ?? language;
}

/**
 * Parse LSP document symbols into our FileStructure format
 */
function parseLspSymbols(
  symbols: DocumentSymbol[] | SymbolInformation[],
  includePrivate: boolean,
): Omit<
  FileStructure,
  "language" | "file_size" | "line_count" | "parse_backend"
> {
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const globalVariables: GlobalVariableInfo[] = [];

  function processSymbol(
    sym: DocumentSymbol | SymbolInformation,
    _containerName?: string,
  ) {
    const name = sym.name;
    const kind = sym.kind;

    // Skip private symbols if not including private
    if (!includePrivate && (name.startsWith("_") || name.startsWith("#"))) {
      return;
    }

    // Get line number (handle both formats)
    const range = "range" in sym ? sym.range : sym.location.range;
    const lineStart = range.start.line + 1;
    const lineEnd = range.end.line + 1;

    // Class/Struct/Enum/Interface/Trait (kinds 5, 10, 11, 23)
    if (kind === 5 || kind === 10 || kind === 11 || kind === 23) {
      const methods: MethodInfo[] = [];
      // Process children if DocumentSymbol
      if ("children" in sym && sym.children) {
        for (const child of sym.children) {
          if (child.kind === 6 || child.kind === 12) {
            // Method or Function
            methods.push({
              name: child.name,
              signature: child.detail ?? child.name,
              line: child.range.start.line + 1,
              is_async: child.detail?.includes("async") ?? false,
            });
          }
        }
      }
      classes.push({ name, line_start: lineStart, line_end: lineEnd, methods });
    }
    // Function (kind 12)
    else if (kind === 12 || kind === 6) {
      const detail = "detail" in sym ? sym.detail : undefined;
      functions.push({
        name,
        signature: detail ?? name,
        line_start: lineStart,
        line_end: lineEnd,
        is_async: detail?.includes("async") ?? false,
      });
    }
    // Variable/Constant (kinds 13, 14)
    else if (kind === 13 || kind === 14) {
      const detail = "detail" in sym ? sym.detail : undefined;
      globalVariables.push({ name, line: lineStart, type_hint: detail });
    }

    // Recurse into children for DocumentSymbol
    if ("children" in sym && sym.children) {
      for (const child of sym.children) {
        processSymbol(child, name);
      }
    }
  }

  for (const sym of symbols) {
    processSymbol(sym);
  }

  return {
    classes,
    functions,
    imports: [],
    exports: [],
    global_variables: globalVariables,
  };
}

/**
 * Parse TypeScript/JavaScript file structure
 */
function parseTypeScriptStructure(
  content: string,
  includePrivate: boolean,
): Omit<
  FileStructure,
  "language" | "file_size" | "line_count" | "parse_backend"
> {
  const lines = content.split("\n");
  const classes: ClassInfo[] = [];
  const functions: FunctionInfo[] = [];
  const imports: ImportInfo[] = [];
  const exports: string[] = [];
  const globalVariables: GlobalVariableInfo[] = [];

  // Regex patterns
  const classPattern =
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/;
  const functionPattern =
    /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\((.*?)\)/;
  const arrowFunctionPattern =
    /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\((.*?)\)\s*=>/;
  const methodPattern = /^\s*(?:async\s+)?(\w+)\s*\((.*?)\)/;
  const importPattern =
    /^import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/;
  const exportPattern = /^export\s+(?:{([^}]+)}|(?:default\s+)?(\w+))/;
  const constPattern = /^\s*(?:export\s+)?const\s+(\w+)(?::\s*([^=]+))?\s*=/;
  const letPattern = /^\s*(?:export\s+)?let\s+(\w+)(?::\s*([^=]+))?\s*=/;

  let currentClass: ClassInfo | null = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const lineNum = i + 1;

    // Track brace depth for class boundaries
    braceDepth += (line.match(/{/g) ?? []).length;
    braceDepth -= (line.match(/}/g) ?? []).length;

    // Class detection
    const classMatch = line.match(classPattern);
    if (classMatch !== null) {
      if (currentClass !== null) {
        currentClass.line_end = lineNum - 1;
        classes.push(currentClass);
      }

      currentClass = {
        name: classMatch[1] ?? "",
        line_start: lineNum,
        line_end: lineNum,
        methods: [],
        parent_class: classMatch[2],
      };
      continue;
    }

    // End of class
    if (currentClass !== null && braceDepth === 0) {
      currentClass.line_end = lineNum;
      classes.push(currentClass);
      currentClass = null;
    }

    // Method detection (inside class)
    if (currentClass !== null) {
      const methodMatch = line.match(methodPattern);
      if (methodMatch !== null && !line.includes("function")) {
        const methodName = methodMatch[1] ?? "";

        // Skip private methods if not including private
        if (!includePrivate && methodName.startsWith("_")) {
          continue;
        }

        currentClass.methods.push({
          name: methodName,
          signature: `${methodName}(${methodMatch[2] ?? ""})`,
          line: lineNum,
          is_async: line.includes("async"),
        });
      }
      continue;
    }

    // Function detection (outside class)
    const functionMatch = line.match(functionPattern);
    if (functionMatch !== null) {
      const funcName = functionMatch[1] ?? "";

      if (!includePrivate && funcName.startsWith("_")) {
        continue;
      }

      functions.push({
        name: funcName,
        signature: `function ${funcName}(${functionMatch[2] ?? ""})`,
        line_start: lineNum,
        line_end: lineNum,
        is_async: line.includes("async"),
      });
    }

    // Arrow function detection
    const arrowMatch = line.match(arrowFunctionPattern);
    if (arrowMatch !== null) {
      const funcName = arrowMatch[1] ?? "";

      if (!includePrivate && funcName.startsWith("_")) {
        continue;
      }

      functions.push({
        name: funcName,
        signature: `const ${funcName} = (${arrowMatch[2] ?? ""}) =>`,
        line_start: lineNum,
        line_end: lineNum,
        is_async: line.includes("async"),
      });
    }

    // Import detection
    const importMatch = line.match(importPattern);
    if (importMatch !== null) {
      const namedImports = importMatch[1];
      const defaultImport = importMatch[2];
      const module = importMatch[3] ?? "";

      const names: string[] = [];
      if (namedImports !== undefined) {
        names.push(...namedImports.split(",").map((n) => n.trim()));
      }
      if (defaultImport !== undefined) {
        names.push(defaultImport);
      }

      imports.push({
        module,
        names,
        line: lineNum,
        is_relative: module.startsWith("."),
      });
    }

    // Export detection
    const exportMatch = line.match(exportPattern);
    if (exportMatch !== null) {
      const namedExports = exportMatch[1];
      const defaultExport = exportMatch[2];

      if (namedExports !== undefined) {
        exports.push(...namedExports.split(",").map((n) => n.trim()));
      }
      if (defaultExport !== undefined) {
        exports.push(defaultExport);
      }
    }

    // Global variables (const/let at top level)
    if (currentClass === null && braceDepth === 0) {
      const constMatch = line.match(constPattern);
      if (constMatch !== null) {
        globalVariables.push({
          name: constMatch[1] ?? "",
          line: lineNum,
          type_hint: constMatch[2]?.trim(),
        });
      }

      const letMatch = line.match(letPattern);
      if (letMatch !== null) {
        globalVariables.push({
          name: letMatch[1] ?? "",
          line: lineNum,
          type_hint: letMatch[2]?.trim(),
        });
      }
    }
  }

  // Close any remaining class
  if (currentClass !== null) {
    currentClass.line_end = lines.length;
    classes.push(currentClass);
  }

  return {
    classes,
    functions,
    imports,
    exports,
    global_variables: globalVariables,
  };
}

/**
 * Parse Rust file structure using regex
 */
function parseRustStructure(
  content: string,
  includePrivate: boolean,
): Omit<
  FileStructure,
  "language" | "file_size" | "line_count" | "parse_backend"
> {
  const lines = content.split("\n");
  const classes: ClassInfo[] = []; // structs/enums in Rust
  const functions: FunctionInfo[] = [];
  const imports: ImportInfo[] = [];
  const globalVariables: GlobalVariableInfo[] = [];

  // Rust patterns
  const structPattern = /^\s*(?:pub\s+)?struct\s+(\w+)/;
  const enumPattern = /^\s*(?:pub\s+)?enum\s+(\w+)/;
  const traitPattern = /^\s*(?:pub\s+)?trait\s+(\w+)/;
  const implPattern = /^\s*impl(?:<[^>]+>)?\s+(?:(\w+)\s+for\s+)?(\w+)/;
  const fnPattern =
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
  const usePattern = /^\s*use\s+([^;]+);/;
  const constPattern = /^\s*(?:pub\s+)?(?:const|static)\s+(\w+)\s*:\s*([^=]+)/;

  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const lineNum = i + 1;

    // Track brace depth
    braceDepth += (line.match(/{/g) ?? []).length;
    braceDepth -= (line.match(/}/g) ?? []).length;

    // Struct detection
    const structMatch = line.match(structPattern);
    if (structMatch !== null) {
      const name = structMatch[1] ?? "";
      if (!includePrivate && !line.includes("pub ")) continue;
      classes.push({
        name,
        line_start: lineNum,
        line_end: lineNum,
        methods: [],
      });
      continue;
    }

    // Enum detection
    const enumMatch = line.match(enumPattern);
    if (enumMatch !== null) {
      const name = enumMatch[1] ?? "";
      if (!includePrivate && !line.includes("pub ")) continue;
      classes.push({
        name: `enum ${name}`,
        line_start: lineNum,
        line_end: lineNum,
        methods: [],
      });
      continue;
    }

    // Trait detection
    const traitMatch = line.match(traitPattern);
    if (traitMatch !== null) {
      const name = traitMatch[1] ?? "";
      if (!includePrivate && !line.includes("pub ")) continue;
      classes.push({
        name: `trait ${name}`,
        line_start: lineNum,
        line_end: lineNum,
        methods: [],
      });
      continue;
    }

    // Function detection (top-level)
    if (braceDepth === 0 || (braceDepth === 1 && line.match(implPattern))) {
      const fnMatch = line.match(fnPattern);
      if (fnMatch !== null) {
        const name = fnMatch[1] ?? "";
        if (!includePrivate && !line.includes("pub ")) continue;
        functions.push({
          name,
          signature: `fn ${name}(${fnMatch[2] ?? ""})`,
          line_start: lineNum,
          line_end: lineNum,
          is_async: line.includes("async "),
        });
      }
    }

    // Use/import detection
    const useMatch = line.match(usePattern);
    if (useMatch !== null) {
      const module = useMatch[1]?.trim() ?? "";
      imports.push({
        module,
        names: [module.split("::").pop() ?? module],
        line: lineNum,
        is_relative:
          module.startsWith("crate::") || module.startsWith("super::"),
      });
    }

    // Const/static detection
    const constMatch = line.match(constPattern);
    if (constMatch !== null && braceDepth === 0) {
      if (!includePrivate && !line.includes("pub ")) continue;
      globalVariables.push({
        name: constMatch[1] ?? "",
        line: lineNum,
        type_hint: constMatch[2]?.trim(),
      });
    }
  }

  return {
    classes,
    functions,
    imports,
    exports: [], // Rust uses pub visibility, not explicit exports
    global_variables: globalVariables,
  };
}

/**
 * Get file structure using regex-based parsing
 */
async function getFileStructure(
  params: FileStructureParams,
  workingDir: string,
): Promise<FileStructure> {
  const filePath = params.file_path;
  const includePrivate = params.include_private ?? false;

  // Validate path
  const fullPath = path.resolve(workingDir, filePath);
  const normalizedWorking = path.normalize(workingDir);

  if (!fullPath.startsWith(normalizedWorking)) {
    throw new Error("File path outside working directory");
  }

  // Read file
  let content: string;
  let stats: { size: number };

  try {
    content = await fs.readFile(fullPath, "utf-8");
    const fileStats = await fs.stat(fullPath);
    stats = { size: fileStats.size };
  } catch (error) {
    throw new Error(`Failed to read file: ${(error as Error).message}`);
  }

  const language = detectLanguage(filePath);
  const lineCount = content.split("\n").length;

  printDebug(
    `[FileStructure] Parsing ${filePath} (${language}, ${lineCount} lines)`,
  );

  // Try LSP first for supported languages
  const lspLanguages = ["typescript", "rust", "python", "go"];
  if (lspLanguages.includes(language)) {
    try {
      if (!lspManager) {
        const absoluteWorkingDir = path.resolve(workingDir);
        lspManager = new LSPManager(absoluteWorkingDir);
        const inferred = await lspManager.inferLanguage();
        if (inferred) {
          await lspManager.initialize(inferred);
        }
      }

      const lspLang = await lspManager.inferLanguage();
      if (lspLang) {
        const client = await lspManager.getClientForLanguage(lspLang);
        if (client) {
          const uri = `file://${fullPath}`;
          const languageId = getLanguageId(language);
          const symbols = await client.getDocumentSymbols(
            uri,
            content,
            languageId,
          );

          if (symbols.length > 0) {
            printDebug(
              `[FileStructure] Using LSP backend, got ${symbols.length} symbols`,
            );
            const structure = parseLspSymbols(symbols, includePrivate);
            return {
              language,
              file_size: stats.size,
              line_count: lineCount,
              ...structure,
              parse_backend: "lsp",
            };
          }
        }
      }
    } catch (error) {
      printDebug(
        `[FileStructure] LSP failed, falling back to regex: ${(error as Error).message}`,
      );
    }
  }

  // Parse based on language
  let structure: Omit<
    FileStructure,
    "language" | "file_size" | "line_count" | "parse_backend"
  >;

  if (language === "typescript" || language === "javascript") {
    structure = parseTypeScriptStructure(content, includePrivate);
  } else if (language === "rust") {
    structure = parseRustStructure(content, includePrivate);
  } else {
    // For unsupported languages, return empty structure
    structure = {
      classes: [],
      functions: [],
      imports: [],
      exports: [],
      global_variables: [],
    };
  }

  printDebug(
    `[FileStructure] Found: ${structure.classes.length} classes, ${structure.functions.length} functions`,
  );

  return {
    language,
    file_size: stats.size,
    line_count: lineCount,
    ...structure,
    parse_backend: "regex",
  };
}

export const getFileStructureToolHandler: ToolHandler = {
  name: "get_file_structure",
  description:
    "Parse file structure: classes/structs, functions, imports, exports. Supports TypeScript, JavaScript, and Rust.",

  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to analyze",
      },
      include_private: {
        type: "boolean",
        description: "Include private/internal members (default: false)",
      },
      max_depth: {
        type: "integer",
        description: "Maximum nesting depth (not yet implemented)",
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

      const structureParams: FileStructureParams = {
        file_path: params["file_path"],
        include_private:
          typeof params["include_private"] === "boolean"
            ? params["include_private"]
            : undefined,
        max_depth:
          typeof params["max_depth"] === "number"
            ? params["max_depth"]
            : undefined,
      };

      const result = await getFileStructure(
        structureParams,
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
