/**
 * Toolchain discovery
 *
 * The gateway normally runs as a **systemd user service**, and a user service
 * does not read your shell profile. Its PATH is whatever the user manager was
 * started with — typically:
 *
 *   /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
 *
 * Every per-user toolchain is missing from that list. `rustup` installs
 * rust-analyzer to ~/.cargo/bin, `go install` writes ~/go/bin, `pip --user`
 * writes ~/.local/bin, and nvm/fnm/volta put npm's global binaries next to the
 * node binary in a versioned directory. All of them work in your terminal and
 * none of them exist as far as the service is concerned, which produces the
 * worst kind of bug report: "it works when I run it by hand".
 *
 * So we do not rely on the inherited PATH. We look in the standard per-user
 * toolchain directories as well, and — just as importantly — we hand the
 * widened PATH to the processes we spawn. Resolving rust-analyzer's absolute
 * path is not enough on its own: rust-analyzer shells out to `cargo` for
 * metadata, build scripts and proc macros, and `cargo` lives in the same
 * invisible directory.
 *
 * This widens where *we* look. It does not modify the user's environment,
 * install anything, or change any other service. Two escape hatches:
 *
 *   KOI_TOOL_PATH=/opt/x/bin:/opt/y/bin   prepended, wins over everything
 *   KOI_TOOL_PATH_AUGMENT=0               disable augmentation, inherited PATH only
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { printDebug } from "./utils/log.js";

/**
 * Standard per-user toolchain bin directories, most specific first.
 * Only directories that actually exist are kept.
 */
function candidateDirs(): string[] {
  const home = os.homedir();
  const env = process.env;
  const dirs: string[] = [];

  // npm/pnpm/yarn global binaries land next to the node that owns them, which
  // is how nvm, fnm and volta installs get found without knowing the manager.
  dirs.push(path.dirname(process.execPath));

  const goPath = env["GOPATH"];
  const goBin = env["GOBIN"];
  if (goBin !== undefined && goBin.length > 0) dirs.push(goBin);
  dirs.push(
    path.join(
      goPath !== undefined && goPath.length > 0
        ? goPath
        : path.join(home, "go"),
      "bin",
    ),
  );

  dirs.push(
    path.join(home, ".cargo", "bin"), // rustup: rust-analyzer, cargo
    path.join(home, ".local", "bin"), // pip --user: pylsp
    path.join(home, ".npm-global", "bin"), // npm prefix convention
    path.join(home, ".bun", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".pyenv", "shims"),
    path.join(home, ".rbenv", "shims"),
    "/usr/local/bin",
    "/opt/homebrew/bin", // Apple silicon Homebrew
    "/home/linuxbrew/.linuxbrew/bin",
  );

  return dirs;
}

function splitPath(value: string | undefined): string[] {
  return value === undefined || value.length === 0
    ? []
    : value.split(path.delimiter).filter((p) => p.length > 0);
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

let cachedSearchPath: string[] | undefined;

/**
 * The directories we search, in priority order:
 * KOI_TOOL_PATH, then the inherited PATH, then the standard toolchain dirs.
 *
 * The inherited PATH comes before the augmentation so a deliberately pinned
 * system tool still wins; augmentation only ever *adds* places to look.
 */
export function toolSearchPath(): string[] {
  if (cachedSearchPath !== undefined) return cachedSearchPath;

  const augment = process.env["KOI_TOOL_PATH_AUGMENT"] !== "0";
  const seen = new Set<string>();
  const result: string[] = [];

  const add = (dir: string): void => {
    const normalized = path.normalize(dir);
    if (seen.has(normalized) || !isDirectory(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  };

  for (const dir of splitPath(process.env["KOI_TOOL_PATH"])) add(dir);
  for (const dir of splitPath(process.env["PATH"])) add(dir);
  if (augment) for (const dir of candidateDirs()) add(dir);

  cachedSearchPath = result;
  printDebug(
    `[tool-path] search path (${result.length} dirs): ${result.join(path.delimiter)}`,
  );
  return result;
}

const resolveCache = new Map<string, string | null>();

/**
 * Absolute path to an executable, or null. Replaces `command -v <name>`:
 * no shell, no argument interpolation, and it sees the widened search path.
 */
export function resolveTool(name: string): string | null {
  const cached = resolveCache.get(name);
  if (cached !== undefined) return cached;

  // An explicit path in the name means the caller already decided.
  if (name.includes(path.sep)) {
    const direct = isExecutable(name) ? path.resolve(name) : null;
    resolveCache.set(name, direct);
    return direct;
  }

  let found: string | null = null;
  for (const dir of toolSearchPath()) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) {
      found = candidate;
      break;
    }
  }

  if (found !== null) printDebug(`[tool-path] ${name} -> ${found}`);
  resolveCache.set(name, found);
  return found;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Environment for spawned tools, carrying the widened PATH.
 *
 * Required, not cosmetic: language servers shell out to their own toolchain
 * (rust-analyzer -> cargo, gopls -> go), and those live in exactly the
 * directories the service PATH is missing.
 */
export function toolEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: toolSearchPath().join(path.delimiter),
    ...extra,
  };
}

/** Startup diagnostics: what did we find, and where. */
export function describeToolchain(
  names: string[],
): Array<{ name: string; path: string | null }> {
  return names.map((name) => ({ name, path: resolveTool(name) }));
}
