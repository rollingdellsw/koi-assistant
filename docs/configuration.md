# Configuration Guide

Koi™ uses a JSON-based configuration system managed through the Settings UI in the side panel. Configurations are stored in `chrome.storage.local`.

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

```json
{
  "llm": {
    "provider": "anthropic",
    "apiKey": "your-api-key",
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
    "whitelist": ["run_subtask", "run_cmd"]
  },
  "agent": {
    "systemPrompt": "You are a web assistant with browser use tools.\n\n"
  },
  "storage": {
    "maxSessionStorageMb": 1000,
    "autoCleanupDays": 90
  },
  "reminders": [],
  "guardrails": "",
  "gateways": {
    "default": {
      "authMethod": "none",
      "url": "ws://localhost:8080"
    }
  }
}
```

> **Note:** The `executor`, `storage`, `reminders`, `guardrails`, and `gateways` sections are optional. Sensible defaults are applied when omitted.

---

## LLM Providers

Koi supports direct connections to multiple LLM providers. Each provider uses the OpenAI-compatible chat completions API format unless noted otherwise.

### Anthropic (Claude)

```json
{
  "llm": {
    "provider": "anthropic",
    "apiKey": "your-anthropic-api-key",
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

```json
{
  "llm": {
    "provider": "gemini",
    "apiKey": "your-gemini-api-key",
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
    "apiKey": "your-openai-api-key",
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

Access multiple models through one API key:

```json
{
  "llm": {
    "provider": "openrouter",
    "apiKey": "your-openrouter-api-key",
    "model": "qwen/qwen3.5-122b-a10b",
    "baseUrl": "https://openrouter.ai/api/v1",
    "contextWindow": 262144,
    "temperature": 0.7,
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

### Llama.cpp (Local)

Connect to a local Llama.cpp server on your network:

```json
{
  "llm": {
    "provider": "llamacpp",
    "apiKey": "None",
    "model": "qwen/qwen3.5-27b",
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

| Option          | Required | Description                                                              |
| --------------- | -------- | ------------------------------------------------------------------------ |
| `provider`      | Yes      | `anthropic`, `gemini`, `openai`, `openrouter`, `llamacpp`, `vllm`, `mlx` |
| `apiKey`        | Yes\*    | API key (use `"None"` for local providers)                               |
| `model`         | Yes      | Model identifier                                                         |
| `baseUrl`       | No       | API endpoint URL                                                         |
| `contextWindow` | No       | Context window size in tokens (used for low-context reminders)           |
| `temperature`   | No       | Sampling temperature (0–2, default: 0.7)                                 |
| `maxTokens`     | No       | Maximum output tokens (default: 4096)                                    |
| `topP`          | No       | Top-p sampling parameter                                                 |
| `topK`          | No       | Top-k sampling parameter                                                 |
| `thinking`      | No       | Reasoning/thinking configuration (see below)                             |

### Thinking Configuration

Controls LLM reasoning capabilities. Supported natively by Anthropic, Gemini, OpenAI, and via prompt fallback for others.

| Option             | Values                                              | Description                                                     |
| ------------------ | --------------------------------------------------- | --------------------------------------------------------------- |
| `enabled`          | `true` / `false`                                    | Enable thinking mode                                            |
| `budgetLevel`      | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | Token budget for reasoning                                      |
| `fallbackToPrompt` | `true` / `false`                                    | Use `<think>` prompt blocks when native thinking is unavailable |

### Executor Configuration

The executor handles sub-task delegation using a secondary (often faster/cheaper) LLM:

| Option          | Default | Description                                            |
| --------------- | ------- | ------------------------------------------------------ |
| `enabled`       | `true`  | Enable/disable executor for sub-tasks                  |
| `model`         | —       | Model for executor (often a faster/cheaper model)      |
| `timeoutMs`     | `60000` | Timeout for executor calls in ms (recommended: 180000) |
| `maxIterations` | `10`    | Maximum tool iterations per sub-task                   |

The executor inherits `provider`, `apiKey`, and `baseUrl` from the main `llm` section when not explicitly set.

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

| Option                | Default | Description                                     |
| --------------------- | ------- | ----------------------------------------------- |
| `maxSessionStorageMb` | `100`   | Maximum storage for sessions in MB              |
| `autoCleanupDays`     | —       | Automatically delete sessions older than N days |

Sessions are stored in IndexedDB. When storage exceeds the limit, the oldest unnamed sessions with fewer than 3 messages are automatically rotated.

### Tool Whitelist

Tools in the whitelist execute without user confirmation:

```json
{
  "tools": {
    "whitelist": ["run_subtask", "run_cmd"]
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

Configure WebSocket gateways for remote MCP servers (databases, native protocols):

```json
{
  "gateways": {
    "default": {
      "authMethod": "none",
      "url": "ws://localhost:8080"
    }
  }
}
```

Skills reference gateways by name (e.g., `gateway: default` in SKILL.md).

---

## Skills

Skills are installed via the Settings UI (folder picker) or imported as JSON bundles. They are stored in `chrome.storage.local` and managed through the Skills panel.

Skills are not loaded automatically — the LLM calls `read_skill` when it needs a skill's capabilities. You can list installed skills in Settings.

→ [Skills System Guide](./skill_api.md)
