---
name: dynamic-skill
description: Create and refine skills on the fly, and write or test browser-automation scripts against the live page using the sandbox API.
prerequisites:
  - "Please switch to the best coding model you have for this task!"
allowed-tools:
  - runWorkflowScript
  - saveScript
  - saveSkillMd
  - listSkillScripts
  - skillShow
---

# Dynamic Skill Authoring & Execution

This skill provides a complete toolkit to author, test, and persist browser automation skills directly within a live session.

It gives you `runWorkflowScript` to execute JavaScript against the **live, current page** using the `tools.*` sandbox API. Use it when a task needs several DOM interactions or reads chained together. It also gives you `saveScript`, `listSkillScripts`, and `skillShow` for persisting and managing those scripts across turns, as well as `saveSkillMd` for authoring a skill's instructions and metadata.

`runWorkflowScript`, `saveScript`, and `saveSkillMd` all ask the user for confirmation the first time you call them in a session.

## Iterative Script Development

Once this skill is loaded, call `runWorkflowScript({ code, args?, timeout_ms? })` directly. There is no separate "test" vs "final" mode and no acceptance test — every call actually runs against the live page and returns what happened.

Treat it as iterative: write a draft, call the tool, read `logs` / `result` / `error` in the response, fix anything that went wrong, and call again. The result of whichever call you consider final is itself the deliverable — summarize it for the user, or capture it as a reusable skill (see "Saving a script for reuse" and "Authoring Skills" below) if it should run again later.

## The Sandbox Interface

Your script runs inside an isolated sandbox. Three globals are injected:
`tools`, `args`, and `console`.

- `args` — the string array you passed as `runWorkflowScript({ args: [...] })`. Access as `args[0]`, `args[1]`, etc.
- `console` — `log` / `warn` / `error` / `info`, forwarded to the side panel and returned to you in `logs`.
- `tools` — the browser automation API, documented below.

Your script is a **bare statement body**, not a function declaration you
have to call yourself — `tools`, `args`, and `console` are already in scope.
End with `return { success: boolean, ... };`. Do not wrap your logic in
`async function main(...) { ... }` and leave it uncalled — an uninvoked
function runs clean and silently returns nothing. Do not use `export` or
`module.exports` — there is no module system here.

```javascript
// Example runWorkflowScript call
runWorkflowScript({
  code: `
    await tools.navigatePage("https://example.com/search?q=test");
    await tools.waitFor({ event: "load" });
    const results = await tools.searchDom('[data-testid="result-item"]');
    return { success: true, count: results.matches.length };
  `,
});
```

## `tools` (The Browser API)

> **Calling convention:** built-in tools take **positional arguments** with
> camelCase names (`tools.click(selector)`, `tools.fill(selector, value)`).
> MCP tools loaded via `readSkill` take a **single object argument**
> (`tools.domGetProperty({ selector, property })`).

### Utilities (always available)

- `await tools.readSkill({ name: string })` — load another skill's MCP tools into this script's `tools` object. Tools it registers also remain available to you directly in later turns, without re-loading.
- `await tools.runSubtask({ goal, verification_command, timeoutMs?, context_files?, image_data? })` — spawn an independent sub-agent with its own context window for a self-contained piece of reasoning work. Returns `{ content: [{ type: "text", text }], isError }`; parse `text` as JSON for `.content` (final response) or `.history`.
- `await tools.sleep(ms)`

### Inspection (always available, never mutates the page)

- `await tools.takeScreenshot({ selector?, region?, resolution?, fullPage?, format? })`
- `await tools.takeSnapshot({ selector?, mode?: "readable" | "dom" | "full", maxDepth?, offset?, verbose? })`
- `await tools.searchDom(query)` — text or CSS selector, e.g. `tools.searchDom("Submit")`, `tools.searchDom('[data-testid="email"]')`. Returns `{ matches: [...], count, hasMore }`.
- `await tools.inspectElement(selector)` — computed styles, attributes, event listeners
- `await tools.getContext()`
- `await tools.listPages()`
- `await tools.getPageContext({ selector?, maxReadable?, offset?, maxLinks?, linkOffset? })` — the primary tool for READING page content (text, links, media). Returns `{ readable, links, resources, meta: { hasMore, offset, ... } }`; loop on `meta.hasMore` for long pages. Use this instead of scraping text out of `takeSnapshot`/`searchDom`.
- `await tools.listConsoleMessages({ types?, limit? })`

### Navigation

- `await tools.navigatePage(url, options?)`
- `await tools.waitFor({ event?: "load" | "networkidle", selector?, text?, timeout? })`
- `await tools.scrollViewport({ x?, y?, zoom? })`
- `await tools.enterShadow(selector)` / `await tools.enterIframe(selector)` / `await tools.exitContext()` / `await tools.resetContext()`
- `await tools.newPage(url)` / `await tools.selectPage(pageId)` / `await tools.closePage(pageId)`

### Interaction (mutating)

- `await tools.requestAction({ action: "click" | "fill", selector, value?, description? })` — always available; highlights the element and asks the user to act, no separate skill needed.
- `await tools.click(selector, delayMs?)`, `await tools.fill(selector, value, delayMs?)`, `await tools.hover(selector, delayMs?)` — require `await tools.readSkill({ name: "chrome-developer-tools" })` first. Calling them without loading that skill fails.
- `await tools.pressKey(key)` — works with or without `chrome-developer-tools` loaded.

> **Important Limitation (Synthetic Events):** These tools dispatch synthetic DOM events because the live browser extension does **not** have CDP/debugger permissions. Complex JavaScript frameworks (like React) or SPAs that rely on trusted events may ignore synthetic events. If live interaction fails, **do not keep trying to force it or inject raw JS dispatch events**. Instead, switch to `sandbox-shell` and run native headless tests (Playwright, Cypress, Puppeteer) directly on the host.

> Pass `delayMs` (e.g. `tools.fill('#origin', 'JFK', 800)`) when a site needs a beat to attach event listeners after a UI transition, like a modal opening.

### Reading DOM properties / calling element methods

Use the shared `dom-interactor` skill rather than hand-rolling this:

```javascript
await tools.readSkill({ name: "dom-interactor" });
const value = await tools.domGetProperty({
  selector: "#email",
  property: "value",
});
await tools.domCallMethod({ selector: "#my-form", method: "scrollIntoView" });
```

## Selector Guidance

- Use CSS selectors / `searchDom` for elements you need to **act on** (click, fill). Prefer stable text content, `aria-*` attributes, or `data-testid` over ad-tracking or auto-generated IDs.
- Use `getPageContext` for **reading** content (prices, titles, article text, counts). Don't regex/parse `takeSnapshot` output to extract data values — `getPageContext` already returns structured text for you to reason over.
- Read state before acting on toggles/dropdowns/tabs that have a current value — if the desired state is already selected, skip the interaction.

## Error Handling

If `runWorkflowScript` returns `isError: true`, the response includes an
`error` field — either a synchronous lint failure (e.g. markdown fences left
in, a Puppeteer-style API used by mistake, a bare global function call not
prefixed with `tools.`) or a runtime exception. Fix the script and call
again; nothing about the page state is lost between calls.

If the script ran but the work wasn't fully accomplished, have it return
`{ success: false, reason: "..." }` rather than throwing — that gives you a
clear signal to act on without losing the rest of the response (`logs`,
partial `result`).

## Saving a script for reuse

`runWorkflowScript` is for one-off, in-session automation. If the same
script will be needed again later (by you or another user), don't rely on
re-deriving it from conversation history — call `saveScript({ skill_name,
script_name, script_content })` to persist it. This requires the user's
confirmation, the same as `runWorkflowScript` does.

- `skill_name` — lowercase letters, numbers, and hyphens only. If a skill
  with this name doesn't exist yet, `saveScript` creates it (with a minimal
  SKILL.md) and saves your script as its first file. If it already exists,
  the script is added or overwritten as a new, rollback-able version —
  nothing else about the skill is touched.
- `script_name` — a file name like `extract-table.js` (no `scripts/` prefix,
  no path separators).
- `script_content` — the exact code, in the same `tools`/`args`/`console`
  style as `runWorkflowScript`.

Ask the user before calling `saveScript` if it isn't already clear they want
a reusable skill out of the session — it's a real commit to skill storage,
not a draft.

Once saved, the script can be invoked deterministically later via
`runBrowserScript({ script_path: "<skill_name>:scripts/<script_name>.js" })`,
without going through `readSkill("dynamic-skill")` again.

### Discovering and reading existing scripts

Before writing a new script, check whether one already exists:

- `listSkillScripts({ skill_name })` — lists the script and MCP-server files
  currently on a skill, even if it has never been committed. Use this before
  `saveScript` to see whether you'd be creating a new file or overwriting one.
- `skillShow({ skill_name, file? })` — reads file content. Omit `version` to
  read the skill's CURRENT content (works even with no commits yet); pass a
  specific `version` to read an older snapshot (get version numbers from
  `listSkillHistory`).

## Authoring Skills (SKILL.md)

If you need to define or update the metadata, instructions, parameters, or allowed-tools of a skill, call `saveSkillMd({ skill_name, skill_md_content })`.
This writes the skill's primary `SKILL.md` file and parses the YAML frontmatter to register the skill's capabilities in the system.

- `skill_md_content` — Must contain a valid YAML frontmatter block (enclosed in `---`) followed by markdown instructions.

Example `skill_md_content`:

```yaml
---
name: my-skill
description: Does something awesome
runnable: true
allowed-tools:
  - navigatePage
  - getPageContext
parameters:
  - name: query
    description: Search term
    required: true
---
# Instructions
When the user asks to do something awesome, navigate to the search page...
```

Call this alongside `saveScript` to give a skill its complete identity and capabilities.
