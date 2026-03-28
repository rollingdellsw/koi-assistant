/**
 * Google Workspace MCP Guardrail
 *
 * Enforces "own-file-only" write policy:
 * - Create tools (sheets_create, docs_create, slides_create) are always allowed
 * - Read-only tools are always allowed
 * - Write/mutate tools are ONLY allowed on files created by this agent session
 *
 * State: The `createdFileIds` set persists across calls within a session
 * because the guardrail module is cached by the sandbox (see compileGuardrailModule).
 */

// Persistent across calls within the same session (module-level closure)
const createdFileIds = new Set();
// Auth-failure detection state (persists across calls within a session)
let needsAuth = false;

// Tools that create new files — always allowed, and we track the IDs
const CREATE_TOOLS = new Set([
  'sheets_create',
  'docs_create',
  'slides_create',
]);

// Tools that mutate existing files — only allowed on own files
const MUTATE_TOOLS = new Set([
  'sheets_write_range',
  'sheets_batch_update',
  'sheets_clear_range',
  'docs_batch_update',
  'slides_batch_update',
]);

// Map from mutate tool name to the arg key that holds the file ID
const MUTATE_ID_ARG = {
  sheets_write_range: 'spreadsheetId',
  sheets_batch_update: 'spreadsheetId',
  sheets_clear_range: 'spreadsheetId',
  docs_batch_update: 'documentId',
  slides_batch_update: 'presentationId',
};

const AUTH_ERROR_RE = /\b(401|UNAUTHENTICATED)\b/;

module.exports = {
  /**
   * Input guardrail: called BEFORE each MCP tool invocation.
   *
   * @param {object} ctx
   * @param {object} ctx.tool - { name: string, args: object }
   * @param {object} ctx.history - { messages: array, lastUserMessage: string }
   * @param {object} ctx.memory - { snapshot: object }
   * @returns {{ allowed: boolean, message?: string }}
   */
  input: async (ctx) => {
    const { name, args } = ctx.tool;
    // If a previous tool flagged an auth failure, block with a re-auth prompt.
    // Reset the flag so the user can retry after logging in.
    if (needsAuth) {
      needsAuth = false;
      return {
        allowed: false,
        message: "⚠️ AUTHENTICATION REQUIRED: Your Google session has expired. Please click 'Sign in' in the side panel to re-connect your account before continuing."
      };
    }

    // Create tools: always allowed
    if (CREATE_TOOLS.has(name)) {
      return { allowed: true };
    }

    // Mutate tools: check ownership
    if (MUTATE_TOOLS.has(name)) {
      const idKey = MUTATE_ID_ARG[name];
      const fileId = args?.[idKey];

      if (!fileId) {
        return {
          allowed: false,
          message: `GUARDRAIL BLOCK: ${name} requires a file ID (${idKey}) but none was provided.`,
        };
      }

      if (!createdFileIds.has(fileId)) {
        return {
          allowed: false,
          message: `GUARDRAIL BLOCK: ${name} on ${idKey}="${fileId}" denied. ` +
            `Write operations are only allowed on files created by this agent. ` +
            `Created files: [${[...createdFileIds].join(', ') || 'none'}]. ` +
            `Use the corresponding create tool first, or use read-only tools for existing files.`,
        };
      }

      return { allowed: true };
    }

    // All other tools (reads, Drive list, Gmail, Calendar, etc): always allowed
    return { allowed: true };
  },

  /**
   * Output guardrail: called AFTER each MCP tool invocation.
   * Used to track created file IDs from create tool responses.
   *
   * @param {object} ctx
   * @param {object} ctx.tool - { name: string, args: object, result: object }
   * @returns {{ override: boolean, result?: object }}
   */
  output: async (ctx) => {
    const { name } = ctx.tool;
    const result = ctx.result;

    // Detect auth failures in tool results and flag for next input check.
    if (ctx.result && ctx.result.isError) {
      const resultString = typeof ctx.result === 'string' ? ctx.result : JSON.stringify(ctx.result);
      if (AUTH_ERROR_RE.test(resultString)) {
        needsAuth = true;
      }
    }

    // After a create tool, extract the created file ID and track it
    if (CREATE_TOOLS.has(name) && result && !result.isError) {
      const content = result.content || '';
      // ctx.result.content is a string (JSON-serialized), not an array
      // Check for _createdFileId in the serialized string
      const idMatch = content.match(/"_createdFileId"\s*:\s*"([^"]+)"/);
      if (idMatch && idMatch[1]) {
        createdFileIds.add(idMatch[1]);
      }
      // Fallback: parse from "Created spreadsheet: <ID>" / "Created document: <ID>" pattern
      const textMatch = content.match(/(?:Created|Copied) (?:spreadsheet|document|presentation): (\S+)/);
      if (textMatch && textMatch[1]) {
        createdFileIds.add(textMatch[1]);
      }
    }

    return { override: false };
  },
};
