// scripts/guardrail.js — Microsoft 365 own-file-only write policy

const createdFileIds = new Set();

const CREATE_TOOLS = new Set([
  'excel_create',
  'word_create',
  'ppt_create',
]);

const MUTATE_TOOLS = new Set([
  'excel_write_range',
  'excel_batch_update',
  'excel_clear_range',
  'word_batch_update',
  'ppt_batch_update',
]);

const MUTATE_ID_ARG = {
  excel_write_range: 'itemId',
  excel_batch_update: 'itemId',
  excel_clear_range: 'itemId',
  word_batch_update: 'itemId',
  ppt_batch_update: 'itemId',
};

module.exports = {
  input: async (ctx) => {
    const { name, args } = ctx.tool;

    if (CREATE_TOOLS.has(name)) {
      return { allowed: true };
    }

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

    return { allowed: true };
  },

  output: async (ctx) => {
    const { name } = ctx.tool;
    const result = ctx.result;

    if (CREATE_TOOLS.has(name) && result && !result.isError) {
      const content = result.content || '';
      const idMatch = content.match(/"_createdFileId"\s*:\s*"([^"]+)"/);
      if (idMatch && idMatch[1]) {
        createdFileIds.add(idMatch[1]);
      }
      const textMatch = content.match(/(?:Created|Copied) (?:workbook|document|presentation): (\S+)/);
      if (textMatch && textMatch[1]) {
        createdFileIds.add(textMatch[1]);
      }
    }

    return { override: false };
  },
};
