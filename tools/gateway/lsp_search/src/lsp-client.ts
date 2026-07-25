import { spawn, ChildProcess } from "child_process";
import { toolEnv } from "./tool-path.js";
import { printDebug, printInfo } from "./utils/log.js";

// Basic LSP types
export interface LSPPosition {
  line: number;
  character: number;
}

export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: LSPLocation;
  containerName?: string;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: DocumentSymbol[];
}

// Response can be either flat SymbolInformation[] or hierarchical DocumentSymbol[]
export type DocumentSymbolResponse = SymbolInformation[] | DocumentSymbol[];

export interface LSPDiagnostic {
  range: LSPRange;
  severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  code?: string | number;
  source?: string;
  message: string;
}

export interface HoverResult {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: LSPRange;
}

/**
 * Inlay hint from LSP (textDocument/inlayHint)
 * Provides inferred types and parameter names
 */
export interface InlayHint {
  position: LSPPosition;
  label: string | Array<{ value: string; tooltip?: string }>;
  kind?: number; // 1 = Type, 2 = Parameter
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

export const InlayHintKind = {
  Type: 1,
  Parameter: 2,
} as const;

export interface ReferenceContext {
  includeDeclaration: boolean;
}

export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: LSPDiagnostic[];
}

// JSON-RPC message structures
interface RPCRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any;
}

interface RPCResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: any;
}

interface RPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

type RPCMessage = RPCResponse | RPCNotification;

export class LSPClient {
  private process!: ChildProcess;
  private requestCounter = 0;
  private pendingRequests: Map<number, (response: RPCResponse) => void> =
    new Map();
  // Waiters for diagnostics per URI
  private diagnosticWaiters: Map<string, (d: LSPDiagnostic[]) => void> =
    new Map();
  public isInitialized = false;
  public capabilities: any = {};

  // Store diagnostics received via notifications
  private diagnosticsMap: Map<string, LSPDiagnostic[]> = new Map();
  // Tracks documents opened on this client and their current LSP version, so
  // openDocument is idempotent and changeDocument can bump versions correctly.
  private openDocuments: Map<string, { version: number; text: string }> =
    new Map();

  // Track if we've opened a file to initialize the project
  private projectInitialized = false;

  // Track if we've received initial diagnostics (signals project is ready)
  private receivedInitialDiagnostics = false;

  // Track rust-analyzer indexing progress
  private indexingComplete = false;
  private indexingProgress: Map<string, number> = new Map();
  private indexingWaiters: Array<() => void> = [];
  private lastProgressMessage = "";
  private progressDebounceTimer: NodeJS.Timeout | null = null;

  // Language ID for this LSP client
  private languageId: string = "typescript";

  // Configurable timeouts based on language
  private readonly requestTimeoutMs: number;
  private readonly indexWaitMs: number;

  // Environment variable overrides for timeouts
  private static readonly ENV_REQUEST_TIMEOUT = "LSP_REQUEST_TIMEOUT_MS";
  private static readonly ENV_INDEX_TIMEOUT = "LSP_INDEX_TIMEOUT_MS";

  constructor(
    private serverCommand: string[],
    private workspaceRoot: string,
    languageId?: string,
    overrideTimeoutMs?: number,
  ) {
    if (languageId) this.languageId = languageId;

    // rust-analyzer needs much longer timeouts for large workspaces
    // clangd also needs longer timeouts for large C/C++ projects
    if (this.languageId === "cpp") {
      this.requestTimeoutMs =
        overrideTimeoutMs ??
        parseInt(process.env[LSPClient.ENV_REQUEST_TIMEOUT] ?? "60000", 10);
      this.indexWaitMs =
        overrideTimeoutMs ??
        parseInt(process.env[LSPClient.ENV_INDEX_TIMEOUT] ?? "10000", 10);
    } else if (this.languageId === "rust") {
      // Use override if provided, then env var, then default to 120s request / 15s index (soft)
      // Note: index timeout must be < MCP tool call timeout (typically 30s) to allow query time
      this.requestTimeoutMs =
        overrideTimeoutMs ??
        parseInt(process.env[LSPClient.ENV_REQUEST_TIMEOUT] ?? "120000", 10);
      this.indexWaitMs =
        overrideTimeoutMs ??
        parseInt(process.env[LSPClient.ENV_INDEX_TIMEOUT] ?? "15000", 10);
    } else {
      // Use override if provided, then env var, then default to 20s request / 5s index
      this.requestTimeoutMs =
        overrideTimeoutMs ??
        parseInt(process.env[LSPClient.ENV_REQUEST_TIMEOUT] ?? "20000", 10);
      this.indexWaitMs =
        overrideTimeoutMs ??
        parseInt(process.env[LSPClient.ENV_INDEX_TIMEOUT] ?? "10000", 10);
    }
    printDebug(
      `[LSPClient] Timeout config: request=${this.requestTimeoutMs}ms, index=${this.indexWaitMs}ms`,
    );
  }

  // Track spawn errors for start() to check
  private spawnError: Error | null = null;

  public async start(): Promise<boolean> {
    printDebug(
      `[LSPClient] Starting LSP server: ${this.serverCommand.join(" ")}`,
    );
    this.spawnError = null;
    const [command, ...args] = this.serverCommand;

    this.process = spawn(command!, args, {
      cwd: this.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      // Language servers drive their own toolchain as subprocesses —
      // rust-analyzer runs `cargo metadata`, build scripts and proc macros;
      // gopls runs `go list`. Those binaries sit in the same per-user
      // directories the service PATH omits, so resolving the server's own
      // path is not enough: the child needs the widened PATH too, or it
      // starts and then fails to load the project.
      env: toolEnv(),
      // Create a new process group so we can kill all children together
      detached: true,
    });

    // Prevent the parent from waiting for this process group
    this.process.unref();
    // But re-ref so our process doesn't exit
    this.process.ref();

    this.process.stderr?.on("data", (data) => {
      printDebug(`[LSPClient Server STDERR] ${data.toString()}`);
    });

    this.process.stdout?.on("data", (data) => this.handleData(data));

    this.process.on("exit", (code) => {
      printInfo(`[LSPClient] Server process exited with code ${code}`);
      this.isInitialized = false;
    });

    // Handle spawn errors (e.g., command not found)
    this.process.on("error", (error) => {
      printInfo(`[LSPClient] Failed to spawn LSP server: ${error.message}`);
      this.spawnError = error;
      this.isInitialized = false;
    });

    // Small delay to allow spawn error to be caught before initialize
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.spawnError) {
      printInfo(`[LSPClient] Spawn failed: ${this.spawnError}`);
      return false;
    }

    return this.initialize();
  }

  /**
   * Check if this language should have inlay hints enabled
   */
  private shouldEnableInlayHints(): boolean {
    // Only enable inlay hints for languages with heavy type inference
    // that benefit from showing inferred types/parameters
    const inlayHintLanguages = new Set(["rust", "typescript", "cpp"]);
    return inlayHintLanguages.has(this.languageId);
  }

  /**
   * Build textDocument capabilities based on language
   */
  private getTextDocumentCapabilities(): Record<string, unknown> {
    const capabilities: Record<string, unknown> = {
      publishDiagnostics: {
        relatedInformation: true,
        versionSupport: false,
        tagSupport: { valueSet: [1, 2] },
        codeDescriptionSupport: true,
        dataSupport: true,
      },
    };

    // Only add inlay hint capability for languages that use it
    if (this.shouldEnableInlayHints()) {
      capabilities.inlayHint = {
        dynamicRegistration: false,
      };
    }

    return capabilities;
  }

  private async initialize(): Promise<boolean> {
    const params = {
      processId: process.pid,
      rootUri: `file://${this.workspaceRoot}`,
      // Workspace folders for multi-root support
      workspaceFolders: [
        {
          uri: `file://${this.workspaceRoot}`,
          name: this.workspaceRoot.split("/").pop() ?? "workspace",
        },
      ],
      capabilities: {
        workspace: {
          symbol: {
            dynamicRegistration: true,
            symbolKind: {
              valueSet: [
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
                19, 20, 21, 22, 23, 24, 25, 26,
              ],
            },
          },
        },
        window: {
          workDoneProgress: true,
        },
        textDocument: this.getTextDocumentCapabilities(),
      },
      trace: "off",
      // LSP initialization options - server-specific settings
      initializationOptions: this.getInitializationOptions(),
    };

    try {
      const response = await this.sendRequest("initialize", params);
      this.capabilities = response.result.capabilities;
      this.sendNotification("initialized", {});
      this.isInitialized = true;
      printDebug("[LSPClient] LSP server initialized successfully.");
      return true;
    } catch (error) {
      printInfo("[LSPClient] LSP initialization failed:", error);
      return false;
    }
  }

  /**
   * Get language-specific initialization options
   */
  private getInitializationOptions(): Record<string, unknown> {
    if (this.languageId === "rust") {
      return {
        // rust-analyzer specific settings
        // See: https://rust-analyzer.github.io/manual.html#configuration
        files: {
          // Exclude build artifacts and common non-source directories
          excludeDirs: [
            "target",
            ".git",
            "node_modules",
            ".cargo",
            "dist",
            "build",
          ],
          // Watch fewer files to reduce memory usage
          watcher: "server",
        },
        cargo: {
          // Run build scripts to ensure dependencies are found
          buildScripts: {
            enable: true,
          },
          // Enable all features to ensure code paths are active
          allFeatures: true,
        },
        checkOnSave: {
          // Disable check-on-save for MCP usage (we're read-only)
          enable: false,
        },
        procMacro: {
          // Enable proc macro expansion (critical for type inference)
          enable: true,
        },
        // Explicitly enable inlay hints
        inlayHints: {
          enable: true,
          bindingModeHints: { enable: true },
          chainingHints: { enable: true },
          closingBraceHints: { enable: true },
          closureReturnTypeHints: { enable: "always" },
          lifetimeElisionHints: { enable: "always" },
          parameterHints: { enable: true },
          typeHints: { enable: true },
        },
      };
    } else if (this.languageId === "cpp") {
      return {
        // clangd specific settings
        // See: https://clangd.llvm.org/config
        clangd: {
          // Enable background indexing
          arguments: [
            "--background-index",
            "--clang-tidy",
            "--completion-style=detailed",
            "--header-insertion=iwyu",
          ],
        },
        // Fallback compile flags if no compile_commands.json
        fallbackFlags: ["-std=c++17", "-Wall"],
      };
    }

    // TypeScript, Python, etc. - no special options needed
    return {};
  }

  private sendRequest(method: string, params: any): Promise<RPCResponse> {
    return new Promise((resolve, reject) => {
      const id = this.requestCounter++;
      const request: RPCRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };
      this.pendingRequests.set(id, resolve);
      this.sendMessage(request);

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(
            new Error(
              `Request ${id} (${method}) timed out after ${this.requestTimeoutMs}ms.`,
            ),
          );
        }
      }, this.requestTimeoutMs);
    });
  }

  private sendNotification(method: string, params: any): void {
    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.sendMessage(notification);
  }

  private sendMessage(message: object): void {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    this.process.stdin?.write(header);
    this.process.stdin?.write(body);
  }

  private buffer: Buffer = Buffer.alloc(0);
  private handleData(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);

    let messagesProcessed = 0;
    while (true) {
      const separatorIndex = this.buffer.indexOf("\r\n\r\n");
      if (separatorIndex === -1) {
        break;
      }

      const headerString = this.buffer
        .subarray(0, separatorIndex)
        .toString("ascii");
      const match = headerString.match(/Content-Length: (\d+)/i);

      if (!match) {
        printDebug(
          `[LSPClient] Header found but no Content-Length: ${headerString}`,
        );
        // Skip past this invalid header to attempt recovery
        this.buffer = this.buffer.subarray(separatorIndex + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const messageStart = separatorIndex + 4;
      const totalNeeded = messageStart + contentLength;

      if (this.buffer.length < totalNeeded) {
        break;
      }

      const messageBody = this.buffer
        .subarray(messageStart, totalNeeded)
        .toString("utf-8");

      this.buffer = this.buffer.subarray(totalNeeded);
      messagesProcessed++;

      try {
        const message = JSON.parse(messageBody) as RPCMessage;

        if ("id" in message && "method" in message) {
          // This is a REQUEST from the server (e.g., window/workDoneProgress/create)
          // We need to send a response back
          const requestId = message.id;
          const method = (message as any).method as string;
          this.handleServerRequest(
            requestId as number,
            method,
            (message as any).params,
          );
        } else if ("id" in message) {
          // This is a response to a request we made
          const responseId = message.id;

          const callback = this.pendingRequests.get(responseId as number);
          if (callback) {
            callback(message);
            this.pendingRequests.delete(responseId as number);
          } else {
            printDebug(
              `[LSPClient] WARNING: No pending request for id=${responseId}`,
            );
          }
        } else {
          // Handle notifications from server (e.g., diagnostics)
          this.handleNotification(message);
        }
      } catch (error) {
        printDebug(`[LSPClient] JSON parse error: ${(error as Error).message}`);
        printDebug(
          `[LSPClient] Message body (first 200 chars): ${messageBody.substring(0, 200)}`,
        );
      }
    }
  }

  private handleNotification(notification: RPCNotification): void {
    // Handle rust-analyzer progress notifications
    if (notification.method === "$/progress") {
      const params = notification.params as {
        token: string;
        value: {
          kind: "begin" | "report" | "end";
          title?: string;
          message?: string;
          percentage?: number;
        };
      };

      if (params?.token && params?.value) {
        const { token, value } = params;

        if (value.kind === "begin") {
          // Cancel any pending completion timer if a new task starts
          if (this.progressDebounceTimer) {
            clearTimeout(this.progressDebounceTimer);
            this.progressDebounceTimer = null;
          }

          this.indexingProgress.set(token, 0);
          const msg = value.title ?? value.message ?? "Working...";
          this.lastProgressMessage = msg;
          printDebug(`[LSPClient] Progress started: ${msg}`);
        } else if (value.kind === "report") {
          if (value.percentage !== undefined) {
            this.indexingProgress.set(token, value.percentage);
          }
          if (value.message) {
            this.lastProgressMessage = value.message;
            // Only log occasionally to avoid spam
            if (value.percentage !== undefined && value.percentage % 20 === 0) {
              printDebug(
                `[LSPClient] Progress: ${value.message} (${value.percentage}%)`,
              );
            }
          }
        } else if (value.kind === "end") {
          this.indexingProgress.delete(token);
          printDebug(
            `[LSPClient] Progress completed: ${token} (remaining: ${this.indexingProgress.size})`,
          );

          // Check if all indexing is complete
          if (this.indexingProgress.size === 0) {
            // Debounce completion to catch gaps between phases (e.g. Fetching -> CrateGraph)
            if (this.progressDebounceTimer)
              clearTimeout(this.progressDebounceTimer);

            this.progressDebounceTimer = setTimeout(() => {
              if (this.indexingProgress.size === 0 && !this.indexingComplete) {
                this.indexingComplete = true;
                printDebug(
                  "[LSPClient] All indexing tasks complete (debounce settled)!",
                );

                // Notify all waiters
                for (const waiter of this.indexingWaiters) {
                  waiter();
                }
                this.indexingWaiters = [];
              }
              this.progressDebounceTimer = null;
            }, 1500); // 1.5s wait to ensure no new tasks start
          }
        }
      }
      return;
    }

    if (notification.method === "textDocument/publishDiagnostics") {
      const params = notification.params as PublishDiagnosticsParams;
      if (params?.uri && params?.diagnostics) {
        this.diagnosticsMap.set(params.uri, params.diagnostics);
        printDebug(
          `[LSPClient] Received ${params.diagnostics.length} diagnostics for ${params.uri}`,
        );

        // Mark that we've received diagnostics (project is initialized)
        this.receivedInitialDiagnostics = true;

        // Resolve any pending waiters for this URI
        const waiter = this.diagnosticWaiters.get(params.uri);
        if (waiter) {
          waiter(params.diagnostics);
          this.diagnosticWaiters.delete(params.uri);
        }
      }
    }
  }

  /**
   * Handle requests from the server that require a response.
   * LSP servers can send requests to clients (e.g., window/workDoneProgress/create)
   */
  private handleServerRequest(
    id: number,
    method: string,
    _params: unknown,
  ): void {
    // Send appropriate response based on method
    let result: unknown = null;

    switch (method) {
      case "window/workDoneProgress/create":
        // Acknowledge progress token creation - result is null/void
        result = null;
        break;
      case "client/registerCapability":
        // Acknowledge capability registration
        result = null;
        break;
      default:
        printDebug(`[LSPClient] Unknown server request: ${method}`);
        result = null;
    }

    // Send response back to server
    const response = {
      jsonrpc: "2.0",
      id,
      result,
    };
    this.sendMessage(response);
  }

  /**
   * Wait for rust-analyzer to complete indexing.
   * Returns true if indexing completed, false if timeout.
   */
  private async waitForIndexingComplete(timeoutMs: number): Promise<boolean> {
    if (this.indexingComplete) {
      return true;
    }

    return new Promise<boolean>((resolve) => {
      const startTime = Date.now();
      let lastLogTime = 0;

      // Check periodically and log progress
      const checkInterval = setInterval(() => {
        // Check faster
        const elapsed = Date.now() - startTime;

        if (this.indexingComplete) {
          clearInterval(checkInterval);
          resolve(true);
          return;
        }

        if (elapsed >= timeoutMs) {
          clearInterval(checkInterval);
          printDebug(
            `[LSPClient] Indexing soft timeout after ${elapsed}ms. Last progress: ${this.lastProgressMessage}`,
          );
          // CHANGE: Return true (success) to allow query to proceed despite timeout
          resolve(true);
          return;
        }

        // Log progress every 3 seconds
        if (Date.now() - lastLogTime > 3000) {
          lastLogTime = Date.now();
          printDebug(
            `[LSPClient] Still indexing... (${Math.round(elapsed / 1000)}s) - ${this.lastProgressMessage}`,
          );
        }
      }, 500);

      // Also register as a waiter for immediate notification
      this.indexingWaiters.push(() => {
        clearInterval(checkInterval);
        resolve(true);
      });
    });
  }

  /**
   * Ensure the LSP project is initialized by opening a TypeScript file.
   * typescript-language-server requires at least one open file for workspace/symbol to work.
   */
  public async ensureProjectInitialized(): Promise<void> {
    if (this.projectInitialized) return;

    const fs = await import("fs/promises");

    // rust-analyzer indexes from Cargo.toml automatically, no need to open a file
    if (this.languageId === "rust") {
      printDebug(
        `[LSPClient] Waiting for rust-analyzer to index (soft limit ${Math.round(this.indexWaitMs / 1000)}s)...`,
      );

      // Wait for indexing to complete via progress notifications
      // CHANGE: We accept the result regardless of timeout
      await this.waitForIndexingComplete(this.indexWaitMs);

      printDebug(
        "[LSPClient] Proceeding with queries (indexing may still be backgrounded)",
      );

      this.projectInitialized = true;
      return;
    }

    // For other languages, find and open a source file to trigger project creation
    const sourceFile = await this.findFirstSourceFile(this.workspaceRoot);
    if (sourceFile) {
      try {
        const content = await fs.readFile(sourceFile, "utf-8");
        const uri = `file://${sourceFile}`;
        printDebug(`[LSPClient] Opening ${uri} to initialize project`);
        await this.openDocument(uri, this.languageId, content);

        // Wait for tsserver to index - either until we receive diagnostics or timeout
        const maxWait = this.indexWaitMs;
        const checkInterval = 100;
        let waited = 0;

        while (!this.receivedInitialDiagnostics && waited < maxWait) {
          await new Promise((r) => setTimeout(r, checkInterval));
          waited += checkInterval;
        }

        if (this.receivedInitialDiagnostics) {
          printDebug(
            `[LSPClient] Project ready after ${waited}ms (received diagnostics)`,
          );
        } else {
          printDebug(`[LSPClient] Project init timeout after ${maxWait}ms`);
        }

        this.projectInitialized = true;
      } catch (e) {
        printDebug(
          `[LSPClient] Failed to open ${sourceFile}: ${(e as Error).message}`,
        );
      }
    } else {
      printDebug(`[LSPClient] No source file found to initialize project`);
    }
  }

  private async findFirstSourceFile(dir: string): Promise<string | null> {
    const fs = await import("fs/promises");
    const path = await import("path");

    // Define extensions based on language
    const extMap: Record<string, string[]> = {
      typescript: [".ts", ".tsx"],
      rust: [".rs"],
      python: [".py"],
      go: [".go"],
      java: [".java"],
      // cpp covers both C and C++
      cpp: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"],
    };
    const extensions = extMap[this.languageId] ?? [".ts"];
    const isSourceFile = (name: string) =>
      extensions.some((ext) => name.endsWith(ext)) && !name.endsWith(".d.ts");

    try {
      // Prefer src/ directory files first (main source code, not test files)
      const srcDir = path.join(dir, "src");
      try {
        const srcEntries = await fs.readdir(srcDir, { withFileTypes: true });
        for (const entry of srcEntries) {
          if (entry.isFile() && isSourceFile(entry.name)) {
            return path.join(srcDir, entry.name);
          }
          // For C/C++ projects like systemd, source files are in subdirectories
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            try {
              const subDir = path.join(srcDir, entry.name);
              const subEntries = await fs.readdir(subDir, {
                withFileTypes: true,
              });
              for (const subEntry of subEntries) {
                if (subEntry.isFile() && isSourceFile(subEntry.name)) {
                  return path.join(subDir, subEntry.name);
                }
              }
            } catch {}
          }
        }
      } catch {}

      // Fallback to root directory
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && isSourceFile(entry.name)) {
          return path.join(dir, entry.name);
        }
      }
    } catch {}
    return null;
  }

  public async getWorkspaceSymbols(
    query: string,
  ): Promise<SymbolInformation[]> {
    if (!this.isInitialized) {
      throw new Error("LSP client is not initialized.");
    }

    // Ensure project is initialized before querying symbols
    await this.ensureProjectInitialized();

    const params = { query };
    const response = await this.sendRequest("workspace/symbol", params);
    return (response.result as SymbolInformation[]) ?? [];
  }

  /**
   * Get document symbols for a specific file (textDocument/documentSymbol)
   * Returns hierarchical symbols for the given document
   */
  public async getDocumentSymbols(
    uri: string,
    content: string,
    languageId: string,
  ): Promise<DocumentSymbolResponse> {
    if (!this.isInitialized) {
      throw new Error("LSP client is not initialized.");
    }

    // Ensure document is open
    await this.openDocument(uri, languageId, content);

    const params = { textDocument: { uri } };
    const response = await this.sendRequest(
      "textDocument/documentSymbol",
      params,
    );
    return (response.result as DocumentSymbolResponse) ?? [];
  }

  /**
   * Go to definition at a specific position (textDocument/definition)
   * Returns locations where the symbol at the given position is defined.
   *
   * @param uri - Document URI (e.g., "file:///path/to/file.ts")
   * @param position - Position in the document (0-based line and character)
   * @returns Array of locations where the symbol is defined
   */
  public async getDefinition(
    uri: string,
    position: LSPPosition,
  ): Promise<LSPLocation[]> {
    if (!this.isInitialized) {
      throw new Error("LSP client is not initialized.");
    }

    const params = {
      textDocument: { uri },
      position,
    };

    const response = await this.sendRequest("textDocument/definition", params);

    // Response can be Location | Location[] | LocationLink[] | null
    const result = response.result;
    if (!result) return [];

    // Normalize to array of LSPLocation
    if (Array.isArray(result)) {
      return result.map((item: any) => ({
        uri: item.uri ?? item.targetUri,
        range: item.range ?? item.targetSelectionRange,
      }));
    }

    // Single location
    return [{ uri: result.uri, range: result.range }];
  }

  /**
   * Go to implementation at a specific position (textDocument/implementation)
   * Returns locations where the symbol at the given position is implemented.
   * Useful for finding concrete implementations of interfaces/traits/abstract methods.
   *
   * @param uri - Document URI (e.g., "file:///path/to/file.ts")
   * @param position - Position in the document (0-based line and character)
   * @returns Array of locations where the symbol is implemented
   */
  public async getImplementation(
    uri: string,
    position: LSPPosition,
  ): Promise<LSPLocation[]> {
    if (!this.isInitialized) {
      throw new Error("LSP client is not initialized.");
    }

    const params = {
      textDocument: { uri },
      position,
    };

    const response = await this.sendRequest(
      "textDocument/implementation",
      params,
    );

    // Response can be Location | Location[] | LocationLink[] | null
    const result = response.result;
    if (!result) return [];

    // Normalize to array of LSPLocation
    if (Array.isArray(result)) {
      return result.map((item: any) => ({
        uri: item.uri ?? item.targetUri,
        range: item.range ?? item.targetSelectionRange,
      }));
    }

    // Single location
    return [{ uri: result.uri, range: result.range }];
  }

  /**
   * Find all references to the symbol at a specific position (textDocument/references)
   * Returns all locations where the symbol is used.
   *
   * @param uri - Document URI (e.g., "file:///path/to/file.ts")
   * @param position - Position in the document (0-based line and character)
   * @param includeDeclaration - Whether to include the declaration in results (default: true)
   * @returns Array of locations where the symbol is referenced
   */
  public async getReferences(
    uri: string,
    position: LSPPosition,
    includeDeclaration: boolean = true,
  ): Promise<LSPLocation[]> {
    if (!this.isInitialized) {
      throw new Error("LSP client is not initialized.");
    }

    const params = {
      textDocument: { uri },
      position,
      context: { includeDeclaration },
    };

    const response = await this.sendRequest("textDocument/references", params);
    return (response.result as LSPLocation[]) ?? [];
  }

  /**
   * Get hover information at a specific position (textDocument/hover)
   * Returns documentation, type info, etc. for the symbol at the position.
   *
   * @param uri - Document URI (e.g., "file:///path/to/file.ts")
   * @param position - Position in the document (0-based line and character)
   * @returns Hover result with contents, or null if no hover info available
   */
  public async getHover(
    uri: string,
    position: LSPPosition,
  ): Promise<HoverResult | null> {
    if (!this.isInitialized) {
      throw new Error("LSP client is not initialized.");
    }

    const params = {
      textDocument: { uri },
      position,
    };

    const response = await this.sendRequest("textDocument/hover", params);
    return (response.result as HoverResult) ?? null;
  }

  /**
   * Get inlay hints for a range in a document (textDocument/inlayHint)
   * Returns type hints and parameter hints for the given range.
   *
   * @param uri - Document URI (e.g., "file:///path/to/file.rs")
   * @param range - Range in the document (0-based lines and characters)
   * @returns Array of inlay hints, or empty array if not supported/available
   */
  public async getInlayHints(
    uri: string,
    range: LSPRange,
  ): Promise<InlayHint[]> {
    if (!this.isInitialized) {
      throw new Error("LSP client is not initialized.");
    }

    // Check if server supports inlay hints
    const hasInlayHints =
      this.capabilities?.inlayHintProvider !== undefined &&
      this.capabilities?.inlayHintProvider !== false;

    if (!hasInlayHints) {
      printDebug("[LSPClient] Server does not support inlayHints");
      return [];
    }

    const params = {
      textDocument: { uri },
      range,
    };

    try {
      const response = await this.sendRequest("textDocument/inlayHint", params);
      return (response.result as InlayHint[]) ?? [];
    } catch (error) {
      // Some servers may not implement inlayHint even if they advertise it
      printDebug(
        `[LSPClient] inlayHint request failed: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Open a document to trigger diagnostics.
   *
   * Idempotent: if the document is already open (e.g. it was synced from the
   * sandbox overlay), we send didChange instead of a second didOpen so the
   * language server updates its in-memory buffer rather than resetting it. This
   * is what lets edited-but-unshipped files resolve correctly for references /
   * hover / diagnostics.
   */
  public async openDocument(
    uri: string,
    languageId: string,
    content: string,
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new Error("LSP client is not initialized.");
    }

    const known = this.openDocuments.get(uri);
    if (known) {
      // Already open — treat as an edit (full-document sync).
      if (known.text === content) return; // nothing changed, avoid churn
      this.changeDocument(uri, content);
      return;
    }

    this.openDocuments.set(uri, { version: 1, text: content });
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });

    // Note: We don't sleep here anymore. The caller should use waitForDiagnostics
  }

  /**
   * Push a full-document change to the language server (Design 2 sync).
   * Uses whole-text content changes, which every server accepts regardless of
   * its advertised sync kind. No-op if the document was never opened.
   */
  public changeDocument(uri: string, content: string): void {
    if (!this.isInitialized) return;
    const known = this.openDocuments.get(uri);
    if (!known) return;
    known.version += 1;
    known.text = content;
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: known.version },
      contentChanges: [{ text: content }],
    });
  }

  /**
   * Wait for diagnostics.
   * IMPROVED: Waits for a "settle" period after the first diagnostic
   * to allow for multi-pass servers (Syntax first, then Semantic).
   */
  public async waitForDiagnostics(
    uri: string,
    timeoutMs: number = 5000,
  ): Promise<LSPDiagnostic[]> {
    return new Promise<LSPDiagnostic[]>((resolve) => {
      let settled = false;
      const settleTime = 1000; // Wait 1s after last message to ensure stream is done

      // Hard timeout (failsafe)
      const maxTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.diagnosticWaiters.delete(uri);
          printDebug(`[LSPClient] Max timeout reached for ${uri}`);
          resolve(this.getDiagnostics(uri));
        }
      }, timeoutMs);

      let settleTimer: NodeJS.Timeout | undefined;

      this.diagnosticWaiters.set(uri, () => {
        if (settled) return;

        printDebug(
          `[LSPClient] Received diagnostics update... waiting for settle`,
        );

        // Reset the settle timer on every update
        if (settleTimer) clearTimeout(settleTimer);

        settleTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            clearTimeout(maxTimer);
            this.diagnosticWaiters.delete(uri);
            printDebug(`[LSPClient] Diagnostics settled for ${uri}`);
            resolve(this.getDiagnostics(uri));
          }
        }, settleTime);
      });
    });
  }

  /**
   * Close a document
   */
  public closeDocument(uri: string): void {
    if (!this.isInitialized) return;

    this.openDocuments.delete(uri);
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });

    // Clear cached diagnostics
    this.diagnosticsMap.delete(uri);
  }

  /**
   * Get cached diagnostics for a URI
   */
  public getDiagnostics(uri: string): LSPDiagnostic[] {
    return this.diagnosticsMap.get(uri) ?? [];
  }

  /**
   * Clear all cached diagnostics
   */
  public clearDiagnostics(): void {
    this.diagnosticsMap.clear();
  }

  /**
   * Stop the LSP server and clean up all child processes.
   * Returns a promise that resolves when the server has been terminated.
   */
  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      printDebug(`[LSPClient] Stopping LSP server (pid: ${this.process.pid})`);

      try {
        // Send LSP shutdown sequence
        this.sendNotification("shutdown", {});

        // Give it a moment to clean up
        setTimeout(() => {
          try {
            this.sendNotification("exit", {});
          } catch {
            // Ignore - process may already be dead
          }
        }, 100);

        // Kill the entire process group to ensure child processes (like proc-macro-srv) are killed
        // Using negative PID kills the process group
        if (this.process.pid) {
          try {
            // Check if process is still alive before attempting to kill
            try {
              process.kill(this.process.pid, 0);
            } catch {
              // Process already dead, nothing to do
              this.isInitialized = false;
              resolve();
              return;
            }
            process.kill(-this.process.pid, "SIGTERM");
          } catch {
            // Process group kill failed, try direct kill
            this.process.kill("SIGTERM");
          }

          // Force kill after 2 seconds if still alive
          setTimeout(() => {
            try {
              if (this.process?.pid) {
                process.kill(-this.process.pid, "SIGKILL");
              }
              resolve();
            } catch {
              // Already dead, ignore
            }
          }, 2000);
        }
      } catch (error) {
        printDebug(
          `[LSPClient] Error during stop: ${(error as Error).message}`,
        );
        // Force kill as fallback
        try {
          this.process.kill("SIGKILL");
        } catch {
          // Ignore
        }
      }

      this.isInitialized = false;
      // If we reach here without early return, resolve after a short delay
      setTimeout(resolve, 100);
    });
  }
}
