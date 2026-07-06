# Privacy & Data Ownership

**We do not collect your prompts, page content, or usage analytics.**

- Zero product telemetry — no usage statistics, no crash reports, no page or DOM content ever sent to us.
- Sessions live in IndexedDB, config and skills in `chrome.storage.local`.
- Your prompts go directly to your configured LLM provider with no proxy or middleman.
- You can connect to a local server (Llama.cpp, vLLM, MLX) for complete end-to-end data control.
- API keys are stored locally in extension storage;
- OAuth tokens are managed by Chrome's identity API.

**License verification is the one exception.** To confirm your subscription, the extension contacts Polar (our license provider) and our own license endpoint (`api.rollingdell.com`). These requests send only your license key, a randomly-generated install identifier (`machine_id`), your organization ID, and the extension version — used solely to validate entitlement, never to track what you do or see.
