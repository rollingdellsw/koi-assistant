module.exports = {
  input: async (ctx) => {
    // Rule 1: Disallow takeScreenshot in favor of createWorkspace
    if (ctx.tool.name === "takeScreenshot" || ctx.tool.name === "takeSnapshot") {
      return {
        allowed: false,
        message: 'Do NOT use takeScreenshot. Use createWorkspace instead to initialize the visual analysis environment for OSD.'
      };
    }

    return { allowed: true };
  }
};
