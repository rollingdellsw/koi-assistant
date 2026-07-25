import * as readline from "readline";
import * as path from "path";
import { printError, printDebug } from "./utils/log.js";

export interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPServerConfig {
  name: string;
  version: string;
  workingDirectory: string;
  tools: ToolHandler[];
}

export interface ServerContext {
  workingDirectory: string;
}

export interface MCPToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface ToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolHandler {
  name: string;
  description: string;
  inputSchema: object;
  handler: (
    params: Record<string, unknown>,
    context: ServerContext,
  ) => Promise<MCPToolResult>;
}

/**
 * Safely resolve and validate a path is within the working directory
 */
export function validatePath(
  requestedPath: string,
  workingDirectory: string,
): { valid: boolean; fullPath?: string; error?: string } {
  printDebug(
    `[validatePath] Input: requestedPath="${requestedPath}", workingDirectory="${workingDirectory}"`,
  );

  try {
    const absoluteWorkingDir = path.resolve(workingDirectory);
    printDebug(
      `[validatePath] Absolute working directory: "${absoluteWorkingDir}"`,
    );

    const fullPath = path.resolve(absoluteWorkingDir, requestedPath);
    printDebug(`[validatePath] Resolved fullPath: "${fullPath}"`);

    const normalizedFull = path.normalize(fullPath);
    const normalizedWorking = path.normalize(absoluteWorkingDir);
    printDebug(
      `[validatePath] Normalized: full="${normalizedFull}", working="${normalizedWorking}"`,
    );

    const workingWithSep = normalizedWorking.endsWith(path.sep)
      ? normalizedWorking
      : normalizedWorking + path.sep;

    if (normalizedFull === normalizedWorking) {
      printDebug(`[validatePath] Exact match with working directory`);
      return { valid: true, fullPath: normalizedFull };
    }

    if (!normalizedFull.startsWith(workingWithSep)) {
      printError(`[validatePath] Path outside working directory`);
      return { valid: false, error: "Path outside working directory" };
    }

    printDebug(`[validatePath] Path is within working directory`);
    return { valid: true, fullPath: normalizedFull };
  } catch (error) {
    printError(`[validatePath] Exception: ${(error as Error).message}`);
    return { valid: false, error: `Invalid path: ${(error as Error).message}` };
  }
}

export function createServer(config: MCPServerConfig) {
  let initialized = false;
  const context: ServerContext = {
    workingDirectory: config.workingDirectory,
  };
  let workingDirectoryOverride: string | undefined;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  function sendResponse(
    id: string | number,
    result: Record<string, unknown> | MCPToolResult,
  ) {
    const response = {
      jsonrpc: "2.0",
      id,
      result,
    };
    console.log(JSON.stringify(response));
  }

  function sendError(id: string | number, code: number, message: string) {
    const response = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    console.log(JSON.stringify(response));
  }

  function isValidRequest(obj: unknown): obj is MCPRequest {
    return (
      typeof obj === "object" &&
      obj !== null &&
      "jsonrpc" in obj &&
      obj.jsonrpc === "2.0" &&
      "id" in obj &&
      "method" in obj &&
      typeof obj.method === "string"
    );
  }

  async function handleRequest(request: MCPRequest) {
    const { id, method, params } = request;

    printDebug(`[MCP Server] Request ${id}: ${method}`);
    if (params !== undefined && Object.keys(params).length > 0) {
      printDebug(`[MCP Server]   Params: ${JSON.stringify(params, null, 2)}`);
    }

    try {
      switch (method) {
        case "initialize":
          // Update working directory if provided in init params
          if (
            params?.workingDirectory !== undefined &&
            typeof params.workingDirectory === "string"
          ) {
            workingDirectoryOverride = params.workingDirectory;
            context.workingDirectory = workingDirectoryOverride;
          }
          initialized = true;
          sendResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: config.name,
              version: config.version,
            },
          });
          printDebug("[MCP Server] Initialized successfully");
          break;

        case "tools/list":
          if (!initialized) throw new Error("Not initialized");
          sendResponse(id, {
            tools: config.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });
          printDebug(`[MCP Server] Listed ${config.tools.length} tools`);
          break;

        case "tools/call": {
          if (!initialized) throw new Error("Not initialized");
          const toolParams = params as unknown as ToolCallParams;

          printDebug(`[MCP Server] Calling tool: ${toolParams.name}`);
          printDebug(
            `[MCP Server]   Tool arguments: ${JSON.stringify(toolParams.arguments, null, 2)}`,
          );

          const tool = config.tools.find((t) => t.name === toolParams.name);
          if (tool === null || tool === undefined) {
            printError(`[MCP Server] Tool not found: ${toolParams.name}`);
            throw new Error(`Tool not found: ${toolParams.name}`);
          }

          printDebug(`[MCP Server] Executing tool handler...`);
          const result = await tool.handler(toolParams.arguments, context);

          printDebug(`[MCP Server] Tool execution complete`);
          printDebug(
            `[MCP Server]   Result: ${JSON.stringify(result, null, 2)}`,
          );

          sendResponse(id, result);
          break;
        }
        default:
          printError(`[MCP Server] Unknown method: ${method}`);
          throw new Error(`Unknown method: ${method}`);
      }
    } catch (error) {
      printError(
        `[MCP Server] Error handling request ${id}:`,
        (error as Error).message,
      );
      printError(`[MCP Server]    Stack: ${(error as Error).stack}`);
      sendError(id, -32603, (error as Error).message);
    }
  }

  return {
    start() {
      printDebug(`[MCP Server] Starting ${config.name} v${config.version}`);
      printDebug(`[MCP Server] Working directory: ${config.workingDirectory}`);
      printDebug(
        `[MCP Server] Available tools: ${config.tools.map((t) => t.name).join(", ")}`,
      );

      rl.on("line", (line) => {
        if (line.trim().length === 0) return;

        try {
          const parsed: unknown = JSON.parse(line);
          if (!isValidRequest(parsed)) {
            printError("[Server Error] Invalid JSON-RPC request format");
            return;
          }
          void handleRequest(parsed);
        } catch (error) {
          printDebug(
            "[Server Error] Failed to parse request:",
            (error as Error).message,
          );
        }
      });

      process.on("SIGTERM", () => {
        printError("[MCP Server] Received SIGTERM, shutting down...");
        rl.close();
        process.exit(0);
      });

      process.on("SIGINT", () => {
        printError("[MCP Server] Received SIGINT, shutting down...");
        rl.close();
        process.exit(0);
      });

      process.stdin.resume();
    },
  };
}
