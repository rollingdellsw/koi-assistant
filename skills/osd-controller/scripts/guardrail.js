module.exports = {
  input: async (ctx) => {
    // Rule 1: Disallow take_screenshot in favor of create_workspace
    if (ctx.tool.name === "take_screenshot" || ctx.tool.name === "take_snapshot") {
      return {
        allowed: false,
        message: 'Do NOT use take_screenshot. Use create_workspace instead to initialize the visual analysis environment for OSD.'
      };
    }

    // Rule 2: Limit concurrent workspaces
    if (ctx.tool.name === 'create_workspace') {
      const wsCount = Object.keys(ctx.memory?.snapshot || {}).length;
      if (wsCount >= 3) {
        return { allowed: false, message: 'Max 3 workspaces. Delete old ones before creating more.' };
      }
    }
    return { allowed: true };
  }
};
