/**
  * Slack MCP Guardrail
  *
  * User confirmation on posts is handled by Koi's built-in tool-call
  * Accept/Reject UI (§8.1 of skill_api.md). This guardrail's only job
  * is defensive shape validation plus blast-radius limits on
  * slack_chat_post_message. Rejections are handled by a one-shot
  * system reminder in SKILL.md.
  *
  * Read tools are always allowed — they only access data the signed-in
  * user can already see in their browser.
  */

 const POST_TOOL = "slack_chat_post_message";
 const MAX_TEXT_LENGTH = 4000; // Slack's recommended message size cap

 module.exports = {
   input: async (ctx) => {
     if (ctx.tool.name !== POST_TOOL) {
       return { allowed: true };
     }

     const args = ctx.tool.args || {};

     if (typeof args.channel !== "string" || args.channel === "") {
       return {
         allowed: false,
         message: "GUARDRAIL BLOCK: slack_chat_post_message requires a non-empty channel ID.",
       };
     }
     if (typeof args.text !== "string" || args.text.trim() === "") {
       return {
         allowed: false,
         message: "GUARDRAIL BLOCK: slack_chat_post_message requires non-empty text.",
       };
     }

     if (args.text.length > MAX_TEXT_LENGTH) {
       return {
         allowed: false,
         message: `GUARDRAIL BLOCK: message text is ${args.text.length} chars (max ${MAX_TEXT_LENGTH}). Split into multiple posts or trim.`,
       };
     }

    // Block high-blast-radius mentions. These notify everyone in the
    // channel/workspace and are almost never what the user wants from
    // an AI-drafted reply. The user can re-issue with an explicit
    // override if they really mean it.
    //
    // We have to check TWO forms:
    //   1. <!channel> / <!here> / <!everyone>  — Slack's wire format,
    //      only present if the LLM is quoting a prior message.
    //   2. plain-text @channel / @here / @everyone  — what an LLM will
    //      naturally write when authoring fresh text. Slack's server
    //      converts these on post, so they DO trigger broadcasts.
    const broadcast =
      /<!(channel|here|everyone)>/.exec(args.text) ||
      /(?:^|[^a-zA-Z0-9_])@(channel|here|everyone)\b/.exec(args.text);
    if (broadcast) {
      const which = broadcast[1];
      return {
        allowed: false,
        message: `GUARDRAIL BLOCK: draft contains @${which} which notifies many people. Remove the broadcast mention or ask the user to confirm explicitly before retrying.`,
        suggestion: "Rewrite the draft without @channel/@here/@everyone, or quote what specifically the user asked for if they did request a broadcast.",
      };
    }

     return { allowed: true };
   },
 };
