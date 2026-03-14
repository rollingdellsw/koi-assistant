// Track state across tool calls within the session
let lastUrl = null;
let navCount = 0;

module.exports = {
  input: async (ctx) => {
    if (ctx.tool.name === 'navigate_page') {
      const currentUrl = ctx.tool.args.url;

      // 1. The existing security block
      if (currentUrl?.includes('forbidden.com')) {
        return {
          allowed: false,
          message: 'SECURITY BLOCK: Access to forbidden.com is restricted.'
        };
      }

      // 2. The new loop detection mechanism
      if (currentUrl === lastUrl) {
        navCount++;
        // Block on the 3rd attempt
        if (navCount >= 3) {
          return {
            allowed: false,
            message: `LOOP DETECTED: You have attempted to navigate to ${currentUrl} ${navCount} times in a row. Please evaluate the page content or try a different approach.`
          };
        }
      } else {
        // Reset the counter if they navigate somewhere new
        lastUrl = currentUrl;
        navCount = 1;
      }
    }

    return { allowed: true };
  }
};
