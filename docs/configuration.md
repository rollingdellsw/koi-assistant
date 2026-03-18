# Configuration Guide

Koi™ uses a JSON-based configuration system. In the browser extension, configurations are managed through the Settings UI and stored in `chrome.storage.local`. In CLI mode, config is loaded from the filesystem (e.g. `~/.config/deft/config.json` or `.deft/config.json`).

---

## Quick Setup

1. Click the Koi™ icon → Open the side panel
2. Go to **Settings**
3. Select a provider, enter your API key, and save

The default configuration works out of the box for page inspection and Q&A.

Refer to [enterpise-deployment.md](./enterprise-deployment.md) for enterpise specific configuration.

---

## Configuration Profiles

Koi ships with pre-built config profiles for popular providers. You can also create custom profiles via the Settings UI. Each profile is a JSON object with the following structure.

### Full Config Reference

All values shown are examples. Defaults are noted in the [Configuration Sections](#configuration-sections) tables below. Fields marked optional can be omitted entirely.

```jsonc
{
  "llm": {
    "provider": "anthropic",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "model": "claude-sonnet-4-6",
    "baseUrl": "https://api.anthropic.com",
    "contextWindow": 200000,
    "temperature": 1,
    "maxTokens": 64000,
    "topP": 0.9,
    "topK": 40,
    "thinking": {
      "enabled": true,
      "budgetLevel": "high",
      "fallbackToPrompt": false
    }
  },
  "executor": {
    "enabled": true,
    "model": "claude-haiku-4-5",
    "timeoutMs": 180000,
    "maxIterations": 20
  },
  "tools": {
    "whitelist": ["run_subtask"],
    "visibilityMode": "smart"
  },
  "agent": {
    "systemPrompt": "You are a web assistant with browser use tools.\n\n"
  },
  "storage": {
    "maxSessionStorageMb": 1000,
    "autoCleanupDays": 90
  },
  "skills": {
    "preload": []
  },
  "reminders": [],
  "guardrails": "",
  "gateways": {
    "default": {
      "authMethod": "none",
      "url": "ws://localhost:8080"
    }
  },
  "defaultGateway": "default"
}
```

> **Note:** The `executor`, `storage`, `skills`, `reminders`, `guardrails`, and `gateways` sections are optional. Sensible defaults are applied when omitted.

---

## Environment Variable Substitution

`apiKey` and `baseUrl` fields support `${VAR}` syntax resolved at load time:

- `${VAR}` — replaced with env var value; empty string if unset
- `${VAR:-default}` — uses `default` if the variable is unset or empty

```json
"apiKey": "${ANTHROPIC_API_KEY}"
"baseUrl": "${API_BASE_URL:-https://api.anthropic.com}"
```

All real-world config examples in this repo use env var substitution for API keys rather than hardcoded strings.

---

## LLM Providers

Koi supports direct connections to multiple LLM providers. Each provider uses the OpenAI-compatible chat completions API format unless noted otherwise.

### Anthropic (Claude)

```jsonc
{
  "llm": {
    "provider": "anthropic",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "model": "claude-sonnet-4-6",
    "baseUrl": "https://api.anthropic.com",
    "contextWindow": 200000,
    "temperature": 1,
    "maxTokens": 64000,
    "thinking": {
      "enabled": true,
      "budgetLevel": "high",
      "fallbackToPrompt": false
    }
  },
  "executor": {
    "enabled": true,
    "model": "claude-haiku-4-5",
    "timeoutMs": 180000,
    "maxIterations": 20
  }
}
```

Supported models: `claude-sonnet-4-6`, `claude-opus-4-5`, `claude-haiku-4-5`, `claude-sonnet-4`, `claude-opus-4`, `claude-haiku-4`

### Google Gemini

```jsonc
{
  "llm": {
    "provider": "gemini",
    "apiKey": "${GEMINI_API_KEY}",
    "model": "gemini-3-flash-preview",
    "baseUrl": "https://generativelanguage.googleapis.com",
    "contextWindow": 1000000,
    "temperature": 0.7,
    "maxTokens": 32768,
    "thinking": {
      "enabled": true,
      "budgetLevel": "high",
      "fallbackToPrompt": false
    }
  },
  "executor": {
    "model": "gemini-3-flash-preview",
    "enabled": true,
    "timeoutMs": 180000,
    "maxIterations": 20
  }
}
```

### OpenAI

```json
{
  "llm": {
    "provider": "openai",
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-5.2",
    "baseUrl": "https://api.openai.com/v1",
    "contextWindow": 400000,
    "temperature": 1.0,
    "maxTokens": 128000,
    "thinking": {
      "enabled": true,
      "budgetLevel": "high",
      "fallbackToPrompt": false
    }
  },
  "executor": {
    "enabled": true,
    "model": "gpt-5.2",
    "timeoutMs": 180000,
    "maxIterations": 20
  }
}
```

### OpenRouter (Multi-Provider Gateway)

Access multiple models through one API key. Use `topP` (camelCase) — the `top-p` hyphenated form is silently ignored by the schema.

```json
{
  "llm": {
    "provider": "openrouter",
    "apiKey": "${OPENROUTER_API_KEY}",
    "model": "qwen/qwen3.5-397b-a17b",
    "baseUrl": "https://openrouter.ai/api/v1",
    "contextWindow": 262144,
    "temperature": 0.7,
    "topP": 1.0,
    "maxTokens": 16384,
    "thinking": {
      "enabled": true,
      "budgetLevel": "high",
      "fallbackToPrompt": false
    },
    "providerRouting": {
      "order": ["alibaba"],
      "allowFallbacks": false
    }
  },
  "executor": {
    "enabled": true,
    "model": "qwen/qwen3.5-122b-a10b",
    "timeoutMs": 180000,
    "maxIterations": 20,
    "providerRouting": {
      "order": ["alibaba"],
      "allowFallbacks": false
    }
  }
}
```

**OpenRouter free tier:** Use `"model": "openrouter/free"` for zero-cost experimentation.

### Alibaba DashScope (Qwen)

DashScope hosts Qwen models via an OpenAI-compatible endpoint. Use `provider: "llamacpp"` with the DashScope base URL:

```json
{
  "llm": {
    "provider": "llamacpp",
    "apiKey": "${DASHSCOPE_API_KEY}",
    "model": "qwen3.5-plus",
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "contextWindow": 262144,
    "temperature": 0.7,
    "topP": 1.0,
    "maxTokens": 16384,
    "thinking": {
      "enabled": true,
      "budgetLevel": "high",
      "fallbackToPrompt": false
    }
  },
  "executor": {
    "enabled": true,
    "model": "qwen3.5-plus",
    "timeoutMs": 180000,
    "maxIterations": 20
  }
}
```

### Llama.cpp (Local)

Connect to a local Llama.cpp server on your network:

```json
{
  "llm": {
    "provider": "llamacpp",
    "apiKey": "None",
    "model": "qwen/qwen3.5-27b",
    "baseUrl": "http://192.168.68.116:8080/v1",
    "topP": 0.95,
    "contextWindow": 262144,
    "temperature": 1.0,
    "maxTokens": 16384,
    "thinking": {
      "enabled": true,
      "budgetLevel": "high",
      "fallbackToPrompt": false
    }
  }
}
```

### vLLM (Local)

```json
{
  "llm": {
    "provider": "vllm",
    "apiKey": "None",
    "model": "/models/gpt-oss-20b",
    "baseUrl": "http://192.168.68.116:8000/v1",
    "contextWindow": 262144,
    "temperature": 1.0,
    "maxTokens": 16384,
    "thinking": {
      "enabled": true,
      "budgetLevel": "high",
      "fallbackToPrompt": false
    }
  }
}
```

### MLX (Local, Apple Silicon)

```json
{
  "llm": {
    "provider": "mlx",
    "apiKey": "None",
    "model": "qwen/qwen3.5-35b-a3b",
    "baseUrl": "http://192.168.68.116:8080/v1",
    "contextWindow": 262144,
    "temperature": 1.0,
    "maxTokens": 16384,
    "thinking": {
      "enabled": true,
      "budgetLevel": "high",
      "fallbackToPrompt": false
    }
  }
}
```

> **Note:** For local providers (Llama.cpp, vLLM, MLX), set `apiKey` to `"None"` and point `baseUrl` to your server's OpenAI-compatible endpoint. No data leaves your network.

---

## Configuration Sections

### LLM Configuration

| Option            | Required | Default | Description                                                                                      |
| ----------------- | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `provider`        | Yes      | —       | `anthropic`, `gemini`, `openai`, `openrouter`, `llamacpp`, `vllm`, `mlx`                         |
| `apiKey`          | No\*     | —       | API key. Optional for GCP ADC providers. Use `"None"` for local. Supports `${VAR}` substitution. |
| `model`           | Yes      | —       | Model identifier string                                                                          |
| `baseUrl`         | No       | —       | API endpoint URL. Required for local providers.                                                  |
| `contextWindow`   | No       | —       | Model context size in tokens. **Required** for `low_context_window` reminders to fire.           |
| `temperature`     | No       | `0.7`   | Sampling temperature (0–2)                                                                       |
| `maxTokens`       | No       | `4096`  | Maximum output tokens                                                                            |
| `topP`            | No       | —       | Top-p sampling. **Must use camelCase** — `top-p` is silently ignored.                            |
| `topK`            | No       | —       | Top-k sampling                                                                                   |
| `thinking`        | No       | —       | Reasoning configuration (see below)                                                              |
| `providerRouting` | No       | —       | OpenRouter only — provider selection control                                                     |
| `projectId`       | No       | —       | GCP project ID for Vertex AI / Gemini with ADC billing                                           |

### Thinking Configuration

| Option             | Default  | Values                                              | Description                                                  |
| ------------------ | -------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `enabled`          | `false`  | `true` / `false`                                    | Enable thinking mode                                         |
| `budgetLevel`      | `"high"` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | Token budget for reasoning                                   |
| `fallbackToPrompt` | `true`   | `true` / `false`                                    | Use `<think>` prompt blocks when native thinking unavailable |

### Executor Configuration

| Option            | Default | Description                                                                                                            |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | `true`  | Enable/disable executor for sub-tasks                                                                                  |
| `model`           | —       | Model for executor. Inherits `llm.model` when omitted.                                                                 |
| `timeoutMs`       | `60000` | Timeout per call in ms. **Recommended: `180000`** — the default is too short for complex tasks like PDF summarization. |
| `maxIterations`   | `10`    | Max tool iterations per sub-task. Real-world tasks often need `20`.                                                    |
| `maxTokens`       | `4096`  | Max output tokens for executor responses                                                                               |
| `provider`        | —       | Inherits `llm.provider` when omitted                                                                                   |
| `apiKey`          | —       | Inherits `llm.apiKey` when omitted                                                                                     |
| `baseUrl`         | —       | Inherits `llm.baseUrl` when omitted                                                                                    |
| `providerRouting` | —       | OpenRouter routing (can differ from main LLM)                                                                          |

### Provider Routing (OpenRouter)

When using OpenRouter, control which underlying providers handle your requests:

| Option           | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `order`          | Prioritize specific providers (e.g., `["alibaba"]`)     |
| `allowFallbacks` | Allow fallback to other providers on failure            |
| `sort`           | Sort by `price`, `throughput`, or `latency`             |
| `dataCollection` | `allow` or `deny` (skip providers that train on inputs) |
| `ignore`         | Explicitly skip these providers                         |
| `quantizations`  | Only use providers with specific quantizations          |

### Storage Configuration

| Option                | Default | Description                                                                                           |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `maxSessionStorageMb` | `100`   | Max session storage in MB. When exceeded, oldest unnamed sessions with < 3 messages are auto-rotated. |
| `autoCleanupDays`     | —       | Delete sessions older than N days (disabled if omitted)                                               |

Sessions are stored in IndexedDB (browser) or the filesystem (CLI).

### Tool Whitelist

Tools in the whitelist execute without user confirmation. All other tools pause for user approval.

```json
{
  "tools": {
    "whitelist": ["run_subtask"]
  }
}
```

### Tool Visibility Mode

Controls which tools are shown to the main LLM (does not affect availability — executor and subtask agents are governed separately):

| Value               | Behaviour                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `"smart"` (default) | Hides low-level search tools (`search_files`, `git_log`, etc.) to encourage `agentic_search`. Executor still receives full search tool set. |
| `"manual"`          | All tools visible to all agents. Use when you want full control.                                                                            |
| `"hybrid"`          | Main LLM sees both high- and low-level search tools.                                                                                        |

```json
{ "tools": { "visibilityMode": "smart" } }
```

### Skills Configuration

| Option    | Description                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `preload` | Skill names to load at startup. Tools from preloaded skills are available immediately without the LLM calling `read_skill` first. |

```json
{
  "skills": {
    "preload": ["google-workspace", "pdf"]
  }
}
```

### System Prompt

Override the default assistant prompt:

```json
{
  "agent": {
    "systemPrompt": "You are a browser assistant.\nAdd [Source](url) for all facts you reference.\n"
  }
}
```

### Reminders

Inject dynamic context hints into the LLM based on triggers. Defined as a JSON array in the same format as the [Reminder System Guide](./system_reminder.md):

```json
{
  "reminders": [
    {
      "id": "low-context-warning",
      "trigger": {
        "type": "context",
        "condition": { "type": "low_context_window", "threshold": 10000 }
      },
      "content": "CONTEXT WINDOW LOW: Summarize findings and finish up.",
      "strategy": "sticky",
      "priority": "high"
    }
  ]
}
```

### Guardrails

A JavaScript string evaluated in the sandbox. Uses the same `module.exports = { input, output }` format as the [Guardrails API](./guardrails_api.md):

```json
{
  "guardrails": "const history = [];\nmodule.exports = {\n  input: async (ctx) => {\n    // your logic\n    return { allowed: true };\n  }\n};"
}
```

### Gateways (Remote MCP)

Configure WebSocket gateways for remote MCP servers (databases, native protocols). `defaultGateway` sets the fallback used when a skill's `gateway:` field is omitted.

```json
{
  "gateways": {
    "default": {
      "authMethod": "none",
      "url": "ws://localhost:8080"
    }
  },
  "defaultGateway": "default"
}
```

Skills reference gateways by name (`gateway: default` in SKILL.md). `defaultGateway` is a top-level field alongside `gateways`, not nested inside it.

---

## Skills

Skills are installed via the Settings UI (folder picker) or imported as JSON bundles. They are stored in `chrome.storage.local` and managed through the Skills panel.

Skills are not loaded automatically unless listed in `skills.preload` — otherwise the LLM calls `read_skill` on demand. You can list installed skills in Settings.

→ [Skills System Guide](./skill_api.md)
