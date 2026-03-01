module.exports = {
  input: async (ctx) => {
    if (ctx.tool.name === 'navigate_page' &&
        ctx.tool.args.url?.includes('forbidden.com')) {
      return {
        allowed: false,
        message: 'SECURITY BLOCK: Access to forbidden.com is restricted.'
      };
    }
    return { allowed: true };
  }
};
