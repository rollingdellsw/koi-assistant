/**
 * Koi Browser Loop Detection
 */
const history = [];
const LIMIT = 3;
let needsAuth = false;

module.exports = {
  input: async (ctx) => {
    // If a previous tool flagged an auth failure, block the next call with a UI popup.
    // We reset the flag here so the user can "Retry" after logging in.
    if (needsAuth) {
      needsAuth = false;
      return {
        allowed: false,
        message: "⚠️ AUTHENTICATION REQUIRED: Your session has expired or is invalid. Please click the 'Sign in' or 'Consent' button in the side panel to re-connect your account before continuing."
      };
    }

    const browserTools = ['click', 'navigate_page', 'search_dom', 'fill', 'execute_isolated_script'];
    if (!browserTools.includes(ctx.tool.name)) return { allowed: true };

    const target = ctx.tool.args.selector || ctx.tool.args.url || ctx.tool.args.script_path || "action";
    const signature = `${ctx.tool.name}:${target}`;

    history.push({ signature, timestamp: Date.now() });
    if (history.length > 15) history.shift();

    const repeats = history.filter(h => h.signature === signature).length;
    if (repeats >= LIMIT) {
      return {
        allowed: false,
        message: `LOOP DETECTED: You have attempted '${signature}' ${repeats} times. Please STOP and ask the user for help or a different strategy.`
      };
    }

    // Prevent the LLM from directly fetching raw base64 data to save context
    if (ctx.tool.name === "gmail_get_attachment" && ctx.tool.args.returnRawBase64 === true) {
      return {
        allowed: false,
        message: "Context overflow risk. LLMs cannot process raw base64 data directly.",
        suggestion: "Use run_browser_script to execute a JS script that fetches the base64 data and pipes it directly into pdf_load or other processing tools."
      };
    }
    return { allowed: true };
  },

  output: async (ctx) => {
    // Intercept tool results to check for global authentication failure patterns.
    const resultString = JSON.stringify(ctx.result);
    if (ctx.result.isError && (resultString.includes("401") || resultString.includes("UNAUTHENTICATED"))) {
      needsAuth = true;
    }
    return { override: false };
  }
};

// @koi-signature: MEYCIQC6X8bKFVgehey5Yl6BBGVzWbprPqsq0O0W5u8lxAEWUQIhALkdfmtYSNW6vxxKapVJjJOD7dPKXjM7z/553RQtMZ5o
