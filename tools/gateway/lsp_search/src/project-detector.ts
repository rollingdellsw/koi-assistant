import * as path from "path";
import * as fs from "fs/promises";
import { printDebug } from "./utils/log.js";

export type LanguageID =
  | "typescript"
  | "rust"
  | "python"
  | "go"
  | "java"
  | "cpp"; // Covers both C and C++ - no distinction for LSP purposes

export interface ProjectRoot {
  path: string; // Absolute path to project root
  language: LanguageID;
  configFile: string; // e.g., "tsconfig.json"
  isWorkspaceRoot?: boolean; // True if this is a Cargo/npm workspace root
}

interface ConfigMarker {
  file: string;
  language: LanguageID;
}

const CONFIG_MARKERS: ConfigMarker[] = [
  { file: "tsconfig.json", language: "typescript" },
  { file: "Cargo.toml", language: "rust" },
  { file: "go.mod", language: "go" },
  { file: "pyproject.toml", language: "python" },
  { file: "setup.py", language: "python" },
  { file: "pom.xml", language: "java" },
  { file: "build.gradle", language: "java" },
  // C/C++: Only compile_commands.json is a valid marker (CMakeLists.txt/Makefile don't help clangd)
  { file: "compile_commands.json", language: "cpp" },
];

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  "__pycache__",
  "venv",
  ".venv",
  "builddir",
  ".meson",
]);

export class ProjectDetector {
  private cache: ProjectRoot[] | null = null;
  private cacheTime: number = 0;
  private readonly CACHE_TTL = 60_000; // 1 minute

  constructor(private workspaceRoot: string) {}

  /**
   * Find all project roots in the workspace
   * Results are cached for 1 minute
   */
  async detectProjects(): Promise<ProjectRoot[]> {
    const now = Date.now();
    if (this.cache && now - this.cacheTime < this.CACHE_TTL) {
      return this.cache;
    }

    printDebug(
      `[ProjectDetector] Scanning ${this.workspaceRoot} for projects...`,
    );
    const projects: ProjectRoot[] = [];
    await this.scanDirectory(this.workspaceRoot, projects, 0);

    // Filter out workspace members (keep only workspace roots for Rust/TS)
    const filtered = await this.filterWorkspaceMembers(projects);

    // Also check for compile_commands.json in common build directories
    await this.detectCppProjectsInBuildDirs(filtered);

    // Sort: prefer shallower paths (root projects first)
    filtered.sort((a, b) => {
      const depthA = a.path.split(path.sep).length;
      const depthB = b.path.split(path.sep).length;
      return depthA - depthB;
    });

    printDebug(
      `[ProjectDetector] Found ${filtered.length} projects (after workspace filtering)`,
    );
    this.cache = filtered;
    this.cacheTime = now;

    return filtered;
  }

  /**
   * Detect C/C++ projects by looking for compile_commands.json in build directories.
   * This handles cases where compile_commands.json is in builddir/, build/, etc.
   */
  private async detectCppProjectsInBuildDirs(
    projects: ProjectRoot[],
  ): Promise<void> {
    // Check if workspace root has compile_commands.json in a build directory
    const buildDirs = [
      "build",
      "builddir",
      "out",
      "cmake-build-debug",
      "cmake-build-release",
    ];

    for (const buildDir of buildDirs) {
      const ccPath = path.join(
        this.workspaceRoot,
        buildDir,
        "compile_commands.json",
      );
      if (await this.fileExists(ccPath)) {
        // Check if we already have a cpp project for this root
        const existing = projects.find(
          (p) => p.path === this.workspaceRoot && p.language === "cpp",
        );
        if (!existing) {
          projects.push({
            path: this.workspaceRoot,
            language: "cpp",
            configFile: `${buildDir}/compile_commands.json`,
          });
          printDebug(
            `[ProjectDetector] Found C/C++ project via ${buildDir}/compile_commands.json: ${this.workspaceRoot}`,
          );
        }
        break; // Found one, no need to check others
      }
    }
  }

  /**
   * Filter out workspace member projects.
   * For Cargo workspaces: keep only the root, not individual crates.
   * For TypeScript: keep only composite project roots.
   */
  private async filterWorkspaceMembers(
    projects: ProjectRoot[],
  ): Promise<ProjectRoot[]> {
    const workspaceRoots = new Set<string>();
    const memberPaths = new Set<string>();

    // First pass: identify workspace roots and their members
    for (const project of projects) {
      if (project.language === "rust") {
        const members = await this.getCargoWorkspaceMembers(project.path);
        if (members.length > 0) {
          // This is a workspace root
          workspaceRoots.add(project.path);
          project.isWorkspaceRoot = true;
          for (const member of members) {
            memberPaths.add(member);
          }
          printDebug(
            `[ProjectDetector] Cargo workspace root: ${project.path} (${members.length} members)`,
          );
        }
      } else if (project.language === "typescript") {
        const isComposite = await this.isTypeScriptComposite(project.path);
        if (isComposite) {
          workspaceRoots.add(project.path);
          project.isWorkspaceRoot = true;
          // Get referenced projects
          const refs = await this.getTypeScriptReferences(project.path);
          for (const ref of refs) {
            memberPaths.add(ref);
          }
          printDebug(
            `[ProjectDetector] TypeScript composite root: ${project.path}`,
          );
        }
      }
    }

    // Second pass: filter out members that have a workspace root ancestor
    return projects.filter((project) => {
      // Always keep workspace roots
      if (workspaceRoots.has(project.path)) {
        return true;
      }

      // Check if this project is a member of a workspace
      if (memberPaths.has(project.path)) {
        printDebug(
          `[ProjectDetector] Filtering out workspace member: ${project.path}`,
        );
        return false;
      }

      // Check if any workspace root is an ancestor of this project
      for (const root of workspaceRoots) {
        if (
          project.path.startsWith(root + path.sep) &&
          project.language === projects.find((p) => p.path === root)?.language
        ) {
          printDebug(
            `[ProjectDetector] Filtering out nested project: ${project.path} (under ${root})`,
          );
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Parse Cargo.toml to get workspace members
   * Returns empty array if not a workspace
   */
  private async getCargoWorkspaceMembers(
    projectPath: string,
  ): Promise<string[]> {
    try {
      const cargoPath = path.join(projectPath, "Cargo.toml");
      const content = await fs.readFile(cargoPath, "utf-8");

      // Simple TOML parsing for [workspace] members
      // Look for [workspace] section
      if (!content.includes("[workspace]")) {
        return [];
      }

      // Extract members array
      // Handles: members = ["crate1", "crate2"] or multi-line
      const membersMatch = content.match(
        /\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/,
      );
      if (!membersMatch) {
        return [];
      }

      const membersStr = membersMatch[1];
      const members: string[] = [];

      // Parse quoted strings, handling globs
      const stringMatches = membersStr.matchAll(/"([^"]+)"|'([^']+)'/g);
      for (const match of stringMatches) {
        const memberPattern = match[1] ?? match[2];
        if (memberPattern) {
          // Handle glob patterns like "packages/*"
          if (memberPattern.includes("*")) {
            const expanded = await this.expandGlob(projectPath, memberPattern);
            members.push(...expanded);
          } else {
            const memberPath = path.resolve(projectPath, memberPattern);
            members.push(memberPath);
          }
        }
      }

      return members;
    } catch {
      return [];
    }
  }

  /**
   * Expand a glob pattern to actual directories
   */
  private async expandGlob(
    basePath: string,
    pattern: string,
  ): Promise<string[]> {
    const results: string[] = [];

    // Simple glob handling for "dir/*" patterns
    if (pattern.endsWith("/*")) {
      const parentDir = pattern.slice(0, -2);
      const fullParent = path.resolve(basePath, parentDir);
      try {
        const entries = await fs.readdir(fullParent, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            results.push(path.join(fullParent, entry.name));
          }
        }
      } catch {
        // Directory doesn't exist
      }
    } else {
      // Non-glob pattern
      results.push(path.resolve(basePath, pattern));
    }

    return results;
  }

  /**
   * Check if tsconfig.json is a composite project (has references)
   */
  private async isTypeScriptComposite(projectPath: string): Promise<boolean> {
    try {
      const tsconfigPath = path.join(projectPath, "tsconfig.json");
      const content = await fs.readFile(tsconfigPath, "utf-8");
      const config = JSON.parse(content);
      return (
        config.compilerOptions?.composite === true ||
        (Array.isArray(config.references) && config.references.length > 0)
      );
    } catch {
      return false;
    }
  }

  /**
   * Get referenced project paths from tsconfig.json
   */
  private async getTypeScriptReferences(
    projectPath: string,
  ): Promise<string[]> {
    try {
      const tsconfigPath = path.join(projectPath, "tsconfig.json");
      const content = await fs.readFile(tsconfigPath, "utf-8");
      const config = JSON.parse(content);

      if (!Array.isArray(config.references)) {
        return [];
      }

      return config.references
        .filter((ref: { path?: string }) => ref.path)
        .map((ref: { path: string }) => path.resolve(projectPath, ref.path));
    } catch {
      return [];
    }
  }

  /**
   * Find the project root for a specific file path.
   *
   * Walks up looking for a config file, then keeps walking to see whether that
   * project is a MEMBER of a workspace — and if so returns the workspace root.
   *
   * The second step exists so the positional tools agree with `search` about
   * which language server to use. `detectProjects()` deliberately collapses
   * Cargo/TS workspaces to their root (see filterWorkspaceMembers), so a symbol
   * search on a workspace repo is answered by a server rooted at the workspace.
   * Returning the nearest crate here instead asks the LSP cache for a *second*
   * server rooted at the member, which for Cargo workspaces typically fails to
   * start — producing the confusing pair where `search` finds a symbol and
   * `get_references` on that very result reports "Could not start LSP".
   */
  async findProjectForFile(filePath: string): Promise<ProjectRoot | null> {
    const nearest = await this.findNearestProject(filePath);
    if (!nearest) return null;
    return (await this.findWorkspaceRootFor(nearest)) ?? nearest;
  }

  private async findNearestProject(
    filePath: string,
  ): Promise<ProjectRoot | null> {
    let dir = path.dirname(path.resolve(filePath));
    const root = path.parse(dir).root;
    const MAX_DEPTH = 10; // Prevent scanning too far up
    let depth = 0;

    while (dir !== root && depth < MAX_DEPTH) {
      for (const marker of CONFIG_MARKERS) {
        const configPath = path.join(dir, marker.file);
        if (await this.fileExists(configPath)) {
          return {
            path: dir,
            language: marker.language,
            configFile: marker.file,
          };
        }
      }
      dir = path.dirname(dir);
      depth++;
    }

    return null;
  }

  /**
   * Walk up from a project looking for an ancestor that declares it as a
   * workspace member. Only Rust and TypeScript have the concept; every other
   * language keeps the nearest project.
   */
  private async findWorkspaceRootFor(
    project: ProjectRoot,
  ): Promise<ProjectRoot | null> {
    const marker =
      project.language === "rust"
        ? "Cargo.toml"
        : project.language === "typescript"
          ? "tsconfig.json"
          : null;
    if (marker === null) return null;

    let dir = path.dirname(project.path);
    const fsRoot = path.parse(dir).root;
    const MAX_DEPTH = 10;
    let depth = 0;

    while (dir !== fsRoot && depth < MAX_DEPTH) {
      if (await this.fileExists(path.join(dir, marker))) {
        const isRoot =
          project.language === "rust"
            ? await this.isCargoWorkspaceRootFor(dir, project.path)
            : await this.isTypeScriptComposite(dir);
        if (isRoot) {
          printDebug(
            `[ProjectDetector] ${project.path} is a member of workspace ${dir} — using the workspace root`,
          );
          return {
            path: dir,
            language: project.language,
            configFile: marker,
            isWorkspaceRoot: true,
          };
        }
      }
      dir = path.dirname(dir);
      depth++;
    }

    return null;
  }

  /**
   * True when `dir` is a Cargo workspace that owns `memberPath`.
   * A virtual manifest can declare `[workspace]` without an explicit members
   * list (crates picked up via path dependencies, or globs beyond what
   * expandGlob handles), so an empty members list still counts as owning a
   * descendant.
   */
  private async isCargoWorkspaceRootFor(
    dir: string,
    memberPath: string,
  ): Promise<boolean> {
    try {
      const content = await fs.readFile(path.join(dir, "Cargo.toml"), "utf-8");
      if (!content.includes("[workspace]")) return false;

      const members = await this.getCargoWorkspaceMembers(dir);
      if (members.length === 0) return true;

      const target = path.resolve(memberPath);
      return members.some((m) => path.resolve(m) === target);
    } catch {
      return false;
    }
  }

  /**
   * Invalidate the cache (call after file system changes)
   */
  invalidateCache(): void {
    this.cache = null;
  }

  private async scanDirectory(
    dir: string,
    projects: ProjectRoot[],
    depth: number,
  ): Promise<void> {
    // Limit recursion depth to prevent slow scans
    if (depth > 5) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      // Check for config files in this directory
      for (const marker of CONFIG_MARKERS) {
        const configPath = path.join(dir, marker.file);
        if (await this.fileExists(configPath)) {
          // Avoid duplicate languages in same directory
          const existing = projects.find(
            (p) => p.path === dir && p.language === marker.language,
          );
          if (!existing) {
            projects.push({
              path: dir,
              language: marker.language,
              configFile: marker.file,
            });
            printDebug(`[ProjectDetector]   Found ${marker.language}: ${dir}`);
          }
        }
      }

      // Recurse into subdirectories
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;

        await this.scanDirectory(
          path.join(dir, entry.name),
          projects,
          depth + 1,
        );
      }
    } catch (error) {
      // Ignore permission errors, etc.
      printDebug(
        `[ProjectDetector] Error scanning ${dir}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Find compile_commands.json for C/C++ projects.
   * Searches common build directories and symlinks.
   * Returns the directory containing compile_commands.json, or null.
   */
  async findCompileCommandsDir(projectPath: string): Promise<string | null> {
    // Common locations for compile_commands.json
    const searchPaths = [
      projectPath, // Root (symlinked)
      path.join(projectPath, "build"),
      path.join(projectPath, "builddir"),
      path.join(projectPath, "out"),
      path.join(projectPath, "cmake-build-debug"),
      path.join(projectPath, "cmake-build-release"),
      path.join(projectPath, ".build"),
    ];

    for (const searchPath of searchPaths) {
      const ccPath = path.join(searchPath, "compile_commands.json");
      if (await this.fileExists(ccPath)) {
        printDebug(
          `[ProjectDetector] Found compile_commands.json at: ${ccPath}`,
        );
        return searchPath;
      }
    }

    return null;
  }

  /**
   * Get the effective project root for LSP.
   * For C/C++ projects, this may be different from the config file location
   * if compile_commands.json is in a build directory.
   */
  async getEffectiveLspRoot(project: ProjectRoot): Promise<string> {
    if (project.language === "cpp") {
      // For C/C++, we need to find where compile_commands.json actually is
      const ccDir = await this.findCompileCommandsDir(project.path);
      if (ccDir && ccDir !== project.path) {
        printDebug(
          `[ProjectDetector] Using compile_commands.json directory for LSP: ${ccDir}`,
        );
        // Still return project.path as LSP root, but the compile_commands.json
        // location will be handled by clangd's --compile-commands-dir flag
        return project.path;
      }
    }
    return project.path;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
