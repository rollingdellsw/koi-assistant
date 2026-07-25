import { LSPClient } from "./lsp-client.js";
import { ProjectRoot, LanguageID } from "./project-detector.js";
import { printDebug, printInfo } from "./utils/log.js";
import { ProjectDetector } from "./project-detector.js";
import * as path from "path";
import * as fs from "fs/promises";

interface ServerConfig {
  command: string[];
}

const SERVER_CONFIGS: Record<LanguageID, ServerConfig> = {
  typescript: { command: ["typescript-language-server", "--stdio"] },
  rust: { command: ["rust-analyzer"] },
  python: { command: ["pylsp"] },
  go: { command: ["gopls"] },
  java: { command: ["jdtls"] },
  // clangd needs --background-index for workspace/symbol to work
  cpp: { command: ["clangd", "--background-index"] },
};

/**
 * Single-server LSP cache with automatic idle shutdown.
 *
 * Memory-bounded: Only ONE LSP server runs at a time.
 * When switching projects, the old server is stopped before starting a new one.
 */
export class LSPServerCache {
  private currentClient: LSPClient | null = null;
  private currentProject: ProjectRoot | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private warmupPromise: Promise<void> | null = null;
  private warmupStartTime: number | null = null;
  private warmupComplete: boolean = false;
  private warmupLanguage: LanguageID | null = null;

  /** Idle timeout before auto-shutdown (5 minutes) */
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  /** Warmup timeout (10 minutes - generous for huge projects) */
  private readonly WARMUP_TIMEOUT_MS = 10 * 60 * 1000;

  /**
   * Get LSP client for a project.
   * - Cache hit: returns existing client
   * - Cache miss: stops old client, starts new one
   */
  async getClient(
    project: ProjectRoot,
    timeoutMs?: number,
  ): Promise<LSPClient | null> {
    this.resetIdleTimer();

    // Cache hit - same project, client still alive
    if (
      this.currentProject?.path === project.path &&
      this.currentClient?.isInitialized
    ) {
      printDebug(`[LSP Cache] Hit: reusing client for ${project.path}`);
      return this.currentClient;
    }

    // Cache miss - need to switch
    printDebug(
      `[LSP Cache] Miss: switching from ${this.currentProject?.path ?? "none"} to ${project.path}`,
    );

    // Stop old client
    await this.stopCurrent();

    // Start new client
    const config = SERVER_CONFIGS[project.language];
    if (!config) {
      printInfo(
        `[LSP Cache] No server config for language: ${project.language}`,
      );
      return null;
    }

    // For C/C++, find compile_commands.json and add --compile-commands-dir if needed
    let command = [...config.command];
    if (project.language === "cpp") {
      const ccDir = await this.findCompileCommandsDir(project.path);
      if (ccDir) {
        // Always pass --compile-commands-dir to handle both symlinked and build-dir cases
        command.push(`--compile-commands-dir=${ccDir}`);
        printDebug(`[LSP Cache] Using compile_commands.json from: ${ccDir}`);
      } else if (!ccDir) {
        printInfo(
          `[LSP Cache] Warning: No compile_commands.json found for C/C++ project`,
        );
      }
    }

    try {
      const client = new LSPClient(
        command,
        project.path,
        project.language,
        timeoutMs,
      );
      const started = await client.start();

      if (!started) {
        printInfo(`[LSP Cache] Failed to start LSP for ${project.path}`);
        return null;
      }

      this.currentClient = client;
      this.currentProject = project;

      printDebug(
        `[LSP Cache] Started ${project.language} LSP at ${project.path}`,
      );
      return client;
    } catch (error) {
      printInfo(`[LSP Cache] Error starting LSP: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Proactively start LSP warmup for slow-indexing languages.
   * Call this when MCP server starts, before any tool calls.
   * Does not block - runs in background.
   */
  startWarmup(workspaceRoot: string): void {
    if (this.warmupPromise) {
      printDebug("[LSP Cache] Warmup already in progress");
      return;
    }

    this.warmupStartTime = Date.now();
    this.warmupPromise = this.doWarmup(workspaceRoot);

    // Don't await - let it run in background
    this.warmupPromise
      .then(() => {
        this.warmupComplete = true;
        const elapsed = Date.now() - (this.warmupStartTime ?? 0);
        printInfo(
          `[LSP Cache] Warmup complete for ${this.warmupLanguage} in ${(elapsed / 1000).toFixed(1)}s`,
        );
      })
      .catch((err) => {
        printDebug(`[LSP Cache] Warmup failed: ${(err as Error).message}`);
        this.warmupComplete = true; // Mark complete so we don't block
      });
  }

  /**
   * Re-arm warmup for a new workspace root (used by set_workspace).
   * No-op while a warmup is still in flight; otherwise clears completion
   * state and starts warmup again against the new root.
   */
  restartWarmup(workspaceRoot: string): void {
    if (this.warmupPromise && !this.warmupComplete) {
      printDebug("[LSP Cache] Warmup still in progress; not restarting");
      return;
    }
    this.warmupPromise = null;
    this.warmupComplete = false;
    this.warmupStartTime = null;
    this.warmupLanguage = null;
    this.startWarmup(workspaceRoot);
  }

  private async doWarmup(workspaceRoot: string): Promise<void> {
    const detector = new ProjectDetector(workspaceRoot);
    const projects = await detector.detectProjects();

    // Find first project that needs slow warmup (prefer rust, then cpp).
    // NOTE: In monorepos with multiple Rust/C++ projects, only the first one
    // gets warmed up. This is intentional to limit resource usage - the LSP
    // cache only holds one server at a time anyway. Subsequent projects will
    // warm up on first access.
    const slowProject =
      projects.find((p) => p.language === "rust") ??
      projects.find((p) => p.language === "cpp");

    if (!slowProject) {
      printDebug(
        "[LSP Cache] No slow-init projects (rust/cpp) found, skipping warmup",
      );
      return;
    }

    this.warmupLanguage = slowProject.language;
    printInfo(
      `[LSP Cache] Starting proactive warmup for ${slowProject.language} at ${slowProject.path}`,
    );

    // This will trigger full indexing - use generous 10 min timeout
    await this.getClient(slowProject, this.WARMUP_TIMEOUT_MS);
  }

  /**
   * Get warmup status for error messages and retry guidance.
   */
  getWarmupStatus(): {
    inProgress: boolean;
    elapsedMs: number;
    language: LanguageID | null;
  } {
    if (this.warmupComplete || !this.warmupStartTime) {
      return { inProgress: false, elapsedMs: 0, language: null };
    }
    return {
      inProgress: true,
      elapsedMs: Date.now() - this.warmupStartTime,
      language: this.warmupLanguage,
    };
  }

  /**
   * Find compile_commands.json for C/C++ projects.
   */
  private async findCompileCommandsDir(
    projectPath: string,
  ): Promise<string | null> {
    const searchPaths = [
      projectPath,
      path.join(projectPath, "build"),
      path.join(projectPath, "builddir"),
      path.join(projectPath, "out"),
      path.join(projectPath, "cmake-build-debug"),
      path.join(projectPath, "cmake-build-release"),
      path.join(projectPath, ".build"),
    ];

    for (const searchPath of searchPaths) {
      const ccPath = path.join(searchPath, "compile_commands.json");
      try {
        await fs.access(ccPath);
        return searchPath;
      } catch {
        // Not found, continue
      }
    }
    return null;
  }

  /**
   * Check if we have an active client for the given project
   */
  hasClientFor(project: ProjectRoot): boolean {
    return (
      this.currentProject?.path === project.path &&
      this.currentClient?.isInitialized === true
    );
  }

  /**
   * Get current project (if any)
   */
  getCurrentProject(): ProjectRoot | null {
    return this.currentProject;
  }

  /**
   * Stop the current LSP server.
   */
  async stopCurrent(): Promise<void> {
    if (this.currentClient) {
      printDebug(`[LSP Cache] Stopping LSP at ${this.currentProject?.path}`);

      // Normal shutdown - stop the process
      try {
        await this.currentClient.stop();
      } catch (error) {
        printDebug(
          `[LSP Cache] Error stopping client: ${(error as Error).message}`,
        );
      }
      this.currentClient = null;
      this.currentProject = null;
    }
  }

  /**
   * Stop all and cleanup (call on shutdown)
   */
  async shutdown(): Promise<void> {
    this.clearIdleTimer();
    await this.stopCurrent();
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();

    this.idleTimer = setTimeout(() => {
      printDebug("[LSP Cache] Idle timeout reached - stopping LSP server");
      void this.stopCurrent();
    }, this.IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

// Global singleton instance
let globalCache: LSPServerCache | null = null;

export function getLSPCache(): LSPServerCache {
  if (!globalCache) {
    globalCache = new LSPServerCache();
  }
  return globalCache;
}

export function shutdownLSPCache(): Promise<void> {
  if (globalCache) {
    return globalCache.shutdown();
  }
  return Promise.resolve();
}
