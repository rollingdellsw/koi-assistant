# CLIProxyAPI How-To for Koi Assistant

This guide explains how to run Koi Assistant against local subscription-backed models through
[CLIProxyAPI](https://github.com/router-for-me/cliproxyapi-installer).

CLIProxyAPI exposes Anthropic-, OpenAI-, and Gemini-compatible HTTP endpoints on a single local
port, and translates them onto the credentials of a CLI subscription you already own. Koi Assistant
can point its `llm.baseUrl` at this local proxy instead of calling provider APIs directly, so no
provider API key is needed.

> This is a local development setup only. Do not commit local proxy settings back to the shipped
> configs, and read [Security notes](#security-notes) before exposing port `8317` beyond
> `localhost`.

## Disclaimer

Read this before following the steps below.

- **CLIProxyAPI is third-party software.** It is not written, maintained, audited, endorsed, or
  distributed by this project, and we have no affiliation with its authors. Installing it means
  piping a remote script into `bash` and granting it your provider credentials. Review the upstream
  source and decide for yourself; direct bugs, security reports, and support requests to the
  [upstream project](https://github.com/router-for-me/cliproxyapi-installer), not to this
  repository's issue tracker.
- **This is an unsupported, optional developer convenience.** It is not part of Koi Assistant, not
  covered by CI, and not a supported deployment mode. The steps and version numbers here were
  verified once, on one machine, at the date of writing; upstream may change at any time and break
  them without notice.
- **You are responsible for provider terms of service.** Accessing a subscription through a
  third-party proxy may violate your agreement with Anthropic, OpenAI, Google, or xAI. Consequences
  can include rate limiting, billing disputes, or permanent account suspension. Confirm your own
  compliance before authenticating; nothing in this guide is permission or a legal opinion.
- **You are responsible for your own configuration.** That includes securing port `8317`, the OAuth
  tokens under `~/.cli-proxy-api/`, and any usage, quota, or charges incurred through them — see
  [Security notes](#security-notes).
- **No warranty.** This document is provided as-is, without warranty of any kind. To the maximum
  extent permitted by applicable law, the authors and contributors accept no liability for any
  claim, damage, data loss, account action, or other liability arising from this guide, from
  CLIProxyAPI, or from any misconfiguration. Use is entirely at your own risk, and is subject to the
  terms of this repository's [LICENSE](../LICENSE.md).

## What this setup does

- Runs CLIProxyAPI locally on `localhost:8317`
- Authenticates CLIProxyAPI with supported model subscriptions
- Configures Koi Assistant to use `http://localhost:8317`
- Run local verification with `curl` before launching Koi Assistant

## Prerequisites

- A Linux environment. Verified on WSL2 Ubuntu 24.04 for Windows 11.
- `systemd` enabled, check`/etc/wsl.conf` from the WSL2 Ubuntu instance:

  ```ini
  [boot]
  systemd=true
  ```

- An active subscription for the provider you intend to authenticate.

## Install CLIProxyAPI

```bash
curl -fsSL https://raw.githubusercontent.com/router-for-me/cliproxyapi-installer/refs/heads/master/cliproxyapi-installer | bash
```

Verify the binary:

```bash
cd ~/cliproxyapi
./cli-proxy-api --version
```

Expected output (version verified at the time of writing):

```text
CLIProxyAPI Version: 7.2.77, Commit: c8803713, BuiltAt: 2026-07-14T20:50:47Z
```

## Authenticate Claude

```bash
cd ~/cliproxyapi
./cli-proxy-api -claude-login --no-browser
```

`--no-browser` prints an authorization URL instead of opening one. Open it in the browser where you
are signed in to Claude, complete the login.

On success, credentials are written to `~/.cli-proxy-api/claude-<account>.json`. Treat that
directory as a secret: it holds live OAuth tokens.

Repeat this step for each provider you want to use — see
[Other provider examples](#other-provider-examples).

## Configure CLIProxyAPI for local Koi Assistant usage

CLIProxyAPI listens on port `8317` by default.

The installer generates random `api-keys` in `~/cliproxyapi/config.yaml`.

Remove the generated entries, or leave the list empty:

```yaml
# API keys for authentication
api-keys:
```

Koi Assistant still requires a non-empty `llm.apiKey`, so the configs below use `sk-dummy-key`,
which the proxy ignores.

### Security notes

- The proxy answers any request that reaches port `8317` and bills it to your
  subscription. Keep the listener on the loopback interface and do not port-forward `8317`.
- `sk-dummy-key` is a placeholder, not a credential. Never replace it with a real provider key.
- The files edited below are the shipped defaults under `packages/chrome-extension/configs/`. Keep
  local edits out of commits — for example `git update-index --skip-worktree <file>`, or load an
  uncommitted copy through the Configs UI.

## Start CLIProxyAPI

Using systemd user service:

```bash
cd ~/cliproxyapi
systemctl --user enable cliproxyapi.service
systemctl --user start cliproxyapi.service
systemctl --user status cliproxyapi.service
```

Keep the service alive when no interactive session is open:

```bash
loginctl enable-linger "$USER"
```

Follow the logs while debugging:

```bash
journalctl --user -u cliproxyapi.service -f
```

## Verify Claude works locally

Before loading the Koi Assistant config, verify that the local proxy can serve a Claude model:

First get exact model name from the proxy endpoint:

```bash
curl -s http://localhost:8317/v1/models | jq -r '.data[].id'
```

Both `llm.model` and `executor.model` from the config you plan to load must appear in this list.
Model names are reported by the proxy, not by the provider, so they can differ from the public API
names and can change between CLIProxyAPI releases.

Post a 'Hello' message to the proxy endpoint:

```bash
curl -N http://localhost:8317/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

You should see a streamed response from the Claude model.

## Koi Assistant Claude config

Load [Koi Assistant Claude local config](../configs/config.claude.json) from Koi Assistant Configs UI, the changes to the standard endpoint are as below:

```diff
--- a/packages/chrome-extension/configs/config.claude.json
+++ b/packages/chrome-extension/configs/config.claude.json
@@ -1,11 +1,11 @@
 {
   "llm": {
     "provider": "anthropic",
-    "apiKey": "${ANTHROPIC_API_KEY}",
+    "apiKey": "sk-dummy-key",
     "model": "claude-opus-4-8",
     "contextWindow": 1000000,
     "comment": "Reminder LLM when remaining contextWindow is less than 10000",
-    "baseUrl": "https://api.anthropic.com",
+    "baseUrl": "http://localhost:8317",
     "maxTokens": 64000,
     "thinking": {
       "enabled": true,

```

## Other provider examples

### OpenAI

```sh
~/cliproxyapi$ ./cli-proxy-api -codex-login --no-browser
```

[Koi Assistant OpenAI local config](../configs/config.openai.json), and its changes:

```diff
--- a/packages/chrome-extension/configs/config.openai.json
+++ b/packages/chrome-extension/configs/config.openai.json
@@ -1,10 +1,10 @@
 {
   "llm": {
     "provider": "openai",
-    "apiKey": "${OPENAI_API_KEY}",
-    "model": "gpt-5.4",
+    "apiKey": "sk-dummy-key",
+    "model": "gpt-5.5",
     "contextWindow": 400000,
-    "baseUrl": "https://api.openai.com/v1",
+    "baseUrl": "http://localhost:8317/v1",
     "temperature": 1.0,
     "maxTokens": 128000,
     "thinking": {
@@ -15,7 +15,7 @@
   },
   "executor": {
     "enabled": true,
-    "model": "gpt-5.4",
+    "model": "gpt-5.5",
     "timeoutMs": 180000,
     "maxIterations": 20
   },

```

Verify locally:

```bash
curl -N http://localhost:8317/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "Hello",
    "stream": true
  }'
```

### Gemini

```sh
~/cliproxyapi$ ./cli-proxy-api -antigravity-login --no-browser
```

[Koi Assistant Gemini local config](../configs/config.gemini.json), and its changes:

```diff
--- a/packages/chrome-extension/configs/config.gemini.json
+++ b/packages/chrome-extension/configs/config.gemini.json
@@ -1,9 +1,9 @@
 {
   "llm": {
     "provider": "gemini",
-    "apiKey": "${GEMINI_API_KEY}",
-    "model": "gemini-3-flash-preview",
-    "baseUrl": "https://generativelanguage.googleapis.com",
+    "apiKey": "sk-dummy-key",
+    "model": "gemini-3-flash",
+    "baseUrl": "http://localhost:8317",
     "temperature": 0.7,
     "contextWindow": 1000000,
     "maxTokens": 65536,
@@ -14,7 +14,7 @@
     }
   },
   "executor": {
-    "model": "gemini-3-flash-preview",
+    "model": "gemini-3-flash",
     "enabled": true,
     "timeoutMs": 180000,
     "maxIterations": 20

```

Verify locally:

```bash
curl -N http://localhost:8317/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash",
    "input": "Hello from local CLIProxyAPI.",
    "stream": true
  }'
```

### xAI

```sh
~/cliproxyapi$ ./cli-proxy-api -xai-login --no-browser
```

[Koi Assistant xAI local config](../configs/config.xai.json), and its changes:

```diff
--- a/packages/chrome-extension/configs/config.xai.json
+++ b/packages/chrome-extension/configs/config.xai.json
@@ -1,10 +1,10 @@
 {
   "llm": {
     "provider": "xai",
-    "apiKey": "${XAI_API_KEY}",
+    "apiKey": "sk-dummy-key",
     "model": "grok-4.5",
     "contextWindow": 500000,
-    "baseUrl": "https://api.x.ai/v1",
+    "baseUrl": "http://localhost:8317/v1",
     "temperature": 1.0,
     "maxTokens": 128000,
     "thinking": {

```

Verify locally:

```bash
curl -N http://localhost:8317/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.5",
    "input": "Hello",
    "stream": true
  }'
```
