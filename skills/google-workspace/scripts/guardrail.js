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
    const { name, result } = ctx.tool;

    // After a create tool, extract the created file ID and track it
    if (CREATE_TOOLS.has(name) && result?.content) {
      for (const block of result.content) {
        // Primary: structured _createdFileId field from MCP response
        if (block._createdFileId) {
          createdFileIds.add(block._createdFileId);
        }
        // Fallback: parse from text "Created spreadsheet: <ID>" / "Created document: <ID>" / "Created presentation: <ID>"
        if (typeof block.text === 'string') {
          const match = block.text.match(/(?:Created|Copied) (?:spreadsheet|document|presentation): (\S+)/);
          if (match && match[1]) {
            createdFileIds.add(match[1]);
          }
        }
      }
    }

    return { override: false };
  },
};