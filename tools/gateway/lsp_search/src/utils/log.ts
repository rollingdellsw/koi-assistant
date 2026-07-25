/**
 * Shared logging utility for deft and MCP servers
 * Supports verbose mode control via environment variable
 */

/**
 * Print error message to stderr
 */
export function printError(...args: unknown[]): void {
  process.stderr.write("[ERR] " + args.map((a) => String(a)).join(" ") + "\n");
}

/**
 * Print info message to stderr
 */
export function printInfo(...args: unknown[]): void {
  process.stderr.write("[INFO] " + args.map((a) => String(a)).join(" ") + "\n");
}

/**
 * Print debug message (only in verbose mode)
 */
export function printDebug(...args: unknown[]): void {
  if (isVerbose()) {
    // Use process.stderr.write to avoid any console interception
    process.stderr.write(
      "[DEBUG] " + args.map((a) => String(a)).join(" ") + "\n",
    );
  }
}

/**
 * Check if verbose mode is enabled
 * Checks both global flag (for main app) and environment variable (for MCP servers)
 */
export function isVerbose(): boolean {
  // Check global flag first (main app)
  if ((global as { VERBOSE?: boolean }).VERBOSE === true) {
    return true;
  }
  // Check environment variable (MCP servers)
  return process.env["VERBOSE"] === "true";
}
