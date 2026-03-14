module.exports = {
  input: async (ctx) => {
    // Rule 1: Disallow take_screenshot in favor of create_workspace
    if (ctx.tool.name === "take_screenshot" || ctx.tool.name === "take_snapshot") {
      return {
        allowed: false,
        message: 'Do NOT use take_screenshot. Use create_workspace instead to initialize the visual analysis environment for OSD.'
      };
    }

    return { allowed: true };
  }
};
