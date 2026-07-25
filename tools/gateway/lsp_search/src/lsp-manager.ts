import * as path from "path";
import * as fs from "fs/promises";
import { LSPClient } from "./lsp-client.js";
import { resolveTool } from "./tool-path.js";
import { printDebug, printInfo } from "./utils/log.js";

type LanguageID = "typescript" | "python" | "rust" | "go" | "java" | "cpp"; // Covers both C and C++ - no distinction for LSP purposes

/**
 * Find an executable.
 *
 * `command -v` only sees the inherited PATH, which under a systemd user
 * service excludes every per-user toolchain directory (~/.cargo/bin,
 * ~/go/bin, ~/.local/bin, the node bin dir used by nvm/fnm). That made
 * language servers that work fine in a terminal undetectable to the
 * service. resolveTool searches those too — see tool-path.ts.
 */
function findExecutable(name: string): string | null {
  return resolveTool(name);
}

export class LSPManager {
  private clients: Map<LanguageID, LSPClient> = new Map();
  private serverConfigs: Map<LanguageID, string[]> = new Map([
    ["typescript", ["typescript-language-server", "--stdio"]],
    ["python", ["pylsp"]],
    ["rust", ["rust-analyzer"]],
    ["go", ["gopls"]],
    ["java", ["jdtls"]],
    ["cpp", ["clangd"]],
  ]);
  private detectedServers: Map<LanguageID, string[]> = new Map();

  constructor(private workspaceRoot: string) {}

  /**
   * Initialize and detect available LSP servers
   * Returns a summary of what was found
   */
  public async initialize(limitTo?: LanguageID): Promise<void> {
    await this.detectLspServers(limitTo);
  }

  private async detectLspServers(limitTo?: LanguageID): Promise<void> {
    // Only check specific language if requested, otherwise check all
    const serversToCheck = limitTo
      ? this.serverConfigs.has(limitTo)
        ? [limitTo]
        : []
      : Array.from(this.serverConfigs.keys());

    printDebug(
      `[LSPManager] Detecting LSP servers: ${serversToCheck.join(", ")}`,
    );

    for (const lang of serversToCheck) {
      const command = this.serverConfigs.get(lang as LanguageID);
      if (!command) continue;

      const exePath = findExecutable(command[0]!);
      if (exePath) {
        this.detectedServers.set(lang, [exePath, ...command.slice(1)]);
        printDebug(`[LSPManager] Found ${lang} LSP server at: ${exePath}`);
      } else if (limitTo === lang) {
        // Only warn if we specifically need this language
        printDebug(`[LSPManager] ${lang} LSP server not found: ${command[0]}`);
      }
    }
  }

  /**
   * Get a summary of detected LSP servers for display
   */
  public getDetectedServersSummary(): {
    available: Array<{ language: LanguageID; command: string }>;
    missing: LanguageID[];
  } {
    const available: Array<{ language: LanguageID; command: string }> = [];
    const missing: LanguageID[] = [];

    for (const [lang] of this.serverConfigs.entries()) {
      if (this.detectedServers.has(lang)) {
        const cmd = this.detectedServers.get(lang)!;
        available.push({ language: lang, command: cmd[0] ?? "" });
      } else {
        missing.push(lang);
      }
    }

    return { available, missing };
  }

  /**
   * Check if any LSP servers are available
   */
  public hasAnyServer(): boolean {
    return this.detectedServers.size > 0;
  }

  /**
   * Get list of all detected server language IDs
   */
  public getDetectedLanguages(): LanguageID[] {
    return Array.from(this.detectedServers.keys());
  }

  public async getClientForLanguage(
    language: LanguageID,
  ): Promise<LSPClient | undefined> {
    // Return existing client if available
    if (this.clients.has(language)) {
      const client = this.clients.get(language)!;
      if (client.isInitialized) {
        return client;
      }
    }

    // Create a new client if a server is detected
    if (this.detectedServers.has(language)) {
      const command = this.detectedServers.get(language)!;
      const client = new LSPClient(command, this.workspaceRoot, language);
      if (await client.start()) {
        this.clients.set(language, client);
        return client;
      }
    }

    printInfo(
      `[LSPManager] Could not start or find LSP client for ${language}.`,
    );
    return undefined;
  }

  public async inferLanguage(): Promise<LanguageID | undefined> {
    // 1. Check for config files (most reliable)
    if (await this.fileExists("tsconfig.json")) return "typescript";
    if (await this.fileExists("Cargo.toml")) return "rust";
    if (await this.fileExists("go.mod")) return "go";
    if (
      (await this.fileExists("pom.xml")) ||
      (await this.fileExists("build.gradle"))
    )
      return "java";
    if (
      (await this.fileExists("requirements.txt")) ||
      (await this.fileExists("pyproject.toml"))
    )
      return "python";
    // C/C++ detection - only compile_commands.json is reliable for LSP
    if (await this.fileExists("compile_commands.json")) return "cpp";
    // Also check common build directories
    if (await this.fileExists("build/compile_commands.json")) return "cpp";
    if (await this.fileExists("builddir/compile_commands.json")) return "cpp";
    if (await this.fileExists("out/compile_commands.json")) return "cpp";
    if (await this.fileExists("cmake-build-debug/compile_commands.json"))
      return "cpp";

    // 2. Fallback: Depth-limited recursive scan for source extensions
    // We limit depth to 3 and ignore common heavy folders to prevent timeouts
    try {
      return await this.scanForLanguage(this.workspaceRoot, 0);
    } catch (error) {
      // Ignore readdir errors
    }

    return undefined;
  }

  private async scanForLanguage(
    dir: string,
    depth: number,
  ): Promise<LanguageID | undefined> {
    if (depth > 2) return undefined; // Limit recursion depth

    const entries = await fs.readdir(dir, { withFileTypes: true });

    // Common directories to ignore to save time
    const ignoreDirs = new Set([
      "node_modules",
      ".git",
      "dist",
      "build",
      "target",
      "out",
      "bin",
    ]);

    // 1. Check files in current directory first
    for (const entry of entries) {
      if (entry.isFile()) {
        const name = entry.name;
        if (name.endsWith(".ts") || name.endsWith(".tsx")) return "typescript";
        if (name.endsWith(".py")) return "python";
        if (name.endsWith(".rs")) return "rust";
        if (name.endsWith(".go")) return "go";
        if (name.endsWith(".java")) return "java";
        if (
          name.endsWith(".cpp") ||
          name.endsWith(".hpp") ||
          name.endsWith(".c") ||
          name.endsWith(".h") ||
          name.endsWith(".cc") ||
          name.endsWith(".cxx")
        )
          return "cpp";
      }
    }

    // 2. Recurse into subdirectories
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !ignoreDirs.has(entry.name) &&
        !entry.name.startsWith(".")
      ) {
        const found = await this.scanForLanguage(
          path.join(dir, entry.name),
          depth + 1,
        );
        if (found) return found;
      }
    }

    return undefined;
  }

  private async fileExists(fileName: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.workspaceRoot, fileName));
      return true;
    } catch {
      return false;
    }
  }

  public stopAll(): void {
    for (const client of this.clients.values()) {
      client.stop();
    }
  }
}
