# Koi™ Assistant: Enterprise Deployment & Operations Manual

This document is the complete operations manual for IT administrators deploying and maintaining Koi™ Assistant in a managed enterprise environment.

Enterprise mode activates when a Chrome Managed Policy is detected. Once active, the extension operates exclusively under IT-defined rules: LLM routing is locked to configured endpoints, skills must be cryptographically signed, and end users cannot modify configurations.

**Minimum extension version:** 1.0.9 or later.

---

## Prerequisites

Before starting, ensure you have:

- Google Chrome (or Chromium-based browser with managed policy support)
- OpenSSL installed (for skill signing)
- Node.js v22+ installed (for the `koi-sign.js` tool)
- `jq` installed (for generating config JSON)
- Access to modify Chrome managed policies on your OS (Registry on Windows, JSON files on Linux, plist on macOS)

---

## Phase 1: Licensing

Licenses are purchased and managed through [Polar.sh](https://polar.sh), which handles global tax compliance, invoicing, and seat management.

### 1.1 Purchase Seats

1. Navigate to the Koi™ storefront on Polar.sh and purchase the required number of seats.
2. After checkout, your License Key is displayed on the confirmation page and emailed to the purchasing address.
3. Copy the **full license key string** (e.g., `ENTERPRISE EXTENSION LICENSE-1CDB88D8-1742-419D-B383-F7565C01045B`). The prefix is part of the key — do not use only the UUID portion.

### 1.2 Verify the License (Optional)

Confirm the license is valid before deploying to endpoints:

Set organization_id to `fe1d02a0-6354-4cb9-bd05-52abfbafc707`, which is Rollingdell Software Service LLC's organization_id on Polar.sh.

```bash
curl -X POST https://api.polar.sh/v1/customer-portal/license-keys/validate \
  -H "Content-Type: application/json" \
  -d '{
    "key": "ENTERPRISE EXTENSION LICENSE-1CDB88D8-...",
    "organization_id": "fe1d02a0-6354-4cb9-bd05-52abfbafc707"
  }'
```

A successful response includes `"status":"granted"`. If testing with the Polar sandbox, replace `api.polar.sh` with `sandbox-api.polar.sh`.

---

## Phase 2: LLM Configuration

You control where the extension routes LLM traffic. Two options are available.

### Option A: API Key

For deployments where you distribute a provider API key directly:

```bash
jq -c --arg key "YOUR_REAL_API_KEY" \
  '{"corp-gemini": (.llm.apiKey = $key)}' configs/config.gemini.json
```

Copy the output — this is the value for the `configs` registry entry.

> **Note:** Environment variables (e.g., `${GEMINI_API_KEY}`) are not evaluated within Chrome managed policies. You must use the raw key.

### Option B: GCP Application Default Credentials (Vertex AI)

For deployments where LLM traffic routes through a centralized Google Cloud project with IAM-governed access. No API key is distributed to endpoints.

#### 2B.1 GCP Project Setup

1. Open the [Google Cloud Console](https://console.cloud.google.com) for your corporate GCP project.
2. Enable the **Vertex AI API**: navigate to APIs & Services → Library → search "Vertex AI API" → Enable.

#### 2B.2 IAM Permissions

Each employee using the extension must have these IAM roles on the GCP project:

| Role                     | Purpose                                     |
| ------------------------ | ------------------------------------------- |
| `Vertex AI User`         | Allows `aiplatform.endpoints.predict` calls |
| `Service Usage Consumer` | Allows API quota consumption                |

To grant access:

1. Navigate to IAM & Admin → IAM in the Cloud Console.
2. Click **Grant Access**.
3. Enter the employee's Google Workspace email.
4. Assign both roles listed above.

> **Important:** The extension uses `chrome.identity.getAuthToken()` to obtain an OAuth token. This token proves the user's identity. Google Cloud IAM then checks whether that identity has the required roles on the project. A missing role results in a `403 Forbidden` error.

#### 2B.3 Generate ADC Config

```bash
jq -c --arg pid "your-gcp-project-id" \
  '{"corp-gemini": (.llm.projectId = $pid | del(.llm.apiKey))}' configs/config.gemini.json
```

Copy the output — this is the value for the `configs` registry entry.

#### 2B.4 Verify ADC Auth (Test)

1. Open the extension's background service worker DevTools.
2. Run the OAuth test in the console:

```javascript
chrome.identity.getAuthToken({ interactive: true }, (token) => {
  if (chrome.runtime.lastError) {
    console.error("OAuth Error:", chrome.runtime.lastError.message);
    return;
  }
  console.log("Token:", token ? "PRESENT" : "MISSING");
  fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`)
    .then((r) => r.json())
    .then((info) => {
      console.log("Scopes:", info.scope);
      console.log(
        "Cloud Platform scope:",
        info.scope?.includes("cloud-platform") ? "YES" : "MISSING",
      );
    });
});
```

Expected: Token is present and `cloud-platform` scope is granted.

3. Send a test message in the sidepanel. The console should show:

```
[Gemini:executeStreamChat] Auth State: accessToken=PRESENT, projectId=PRESENT, apiKey=MISSING
[Gemini] Using Vertex AI streaming endpoint with OAuth
```

If you see `accessToken=MISSING, projectId=MISSING`, ensure you are running extension version 1.0.9+.

---

## Phase 3: Chrome Managed Policy Deployment

Chrome reads managed extension policies from the host OS. The extension ID for the production build is `aedfofodkbfgnjknkjpockkgajemkbng`. For sideloaded builds, find the ID at `chrome://extensions`.

### 3.1 Policy Values

Create the following string values under the extension's policy path:

| Name                       | Value                                                             | Notes                                  |
| -------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `license_key`              | `ENTERPRISE EXTENSION LICENSE-...`                                | Full string from Polar.sh              |
| `organization_id`          | `fe1d02a0-6354-4cb9-bd05-52abfbafc707`                            | UUID from Polar.sh Settings            |
| `skill_signing_public_key` | `-----BEGIN PUBLIC KEY-----\nMFkw...\n-----END PUBLIC KEY-----\n` | PEM with literal `\n`                  |
| `allowed_skill_names`      | `["google-workspace", "pdf", ...]`                                | JSON array of approved skill names     |
| `default_config`           | `corp-gemini`                                                     | Name of the config profile to activate |
| `configs`                  | `{"corp-gemini":{...}}`                                           | Minified JSON from Phase 3             |

### 3.2 Windows (Registry / GPO / Intune)

Path: `HKEY_CURRENT_USER\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\aedfofodkbfgnjknkjpockkgajemkbng\policy`

Create each value above as a **String Value (REG_SZ)**. For GPO/Intune mass deployment, export as a `.reg` file or use ADMX templates.

After setting values, open `chrome://policy` and click **Reload policies** to force a refresh.

### 3.3 Linux

Create a JSON file at `/etc/opt/chrome/policies/managed/koi-enterprise.json`:

```json
{
  "3rdparty": {
    "extensions": {
      "<EXTENSION_ID>": {
        "license_key": "ENTERPRISE EXTENSION LICENSE-...",
        "organization_id": "fe1d02a0-6354-4cb9-bd05-52abfbafc707",
        "skill_signing_public_key": "-----BEGIN PUBLIC KEY-----\nMFkw...",
        "allowed_skill_names": ["google-workspace", "pdf"],
        "default_config": "corp-gemini",
        "configs": {
          "corp-gemini": {
            "llm": {
              "provider": "gemini",
              "projectId": "gen-lang-client-...",
              "model": "gemini-3-flash-preview",
              "baseUrl": "https://generativelanguage.googleapis.com",
              "temperature": 0.7,
              "contextWindow": 1000000,
              "maxTokens": 32768
            }
          }
        }
      }
    }
  }
}
```

Set file permissions to `644` owned by `root`. Restart Chrome.

### 3.4 macOS

Use a `.mobileconfig` profile or MDM to push a `com.google.Chrome` managed preference containing the same structure as the Linux JSON. Deploy via Jamf, Mosyle, or similar MDM solutions.

---

## Phase 4: Validation Checklist

After deployment, verify each layer in order:

### 4.1 Policy Loaded

Navigate to `chrome://policy/`. Under "Koi™ Assistant", confirm all six values appear with Status **OK**.

![Policy screenshot](./koi-chrome-policy-for-enterprise.png)

### 4.2 License Activation

Open the background service worker DevTools (`chrome://extensions` → service worker link). Look for:

```
[EnterpriseLicense] Activation successful, instance: <uuid>
```

If activation fails, check the console for the specific error (network, invalid key, org mismatch).

### 4.3 Config Lockdown

Open the sidepanel Settings. The config dropdown should show your profile as `corp-gemini (managed)`. Users must not be able to edit, add, or delete configurations.

### 4.4 Skill Signature Verification

Install an approved signed skill. Background console should log:

```
[SkillStorage] Signature verified for skill: <name>
```

When the agent uses the skill, look for:

```
[BrowserSkillResolver:resolve] Skill "<name>" signature verified OK
```

### 4.5 LLM Routing

Send a test message. In the sidepanel console, verify the auth state line matches your deployment:

**API Key deployment:**

```
Auth State: accessToken=MISSING, projectId=MISSING, apiKey=PRESENT
```

**ADC deployment:**

```
Auth State: accessToken=PRESENT, projectId=PRESENT, apiKey=MISSING
[Gemini] Using Vertex AI streaming endpoint with OAuth
```

Check the Network tab to confirm requests go to `us-central1-aiplatform.googleapis.com` (ADC) or `generativelanguage.googleapis.com` (API key).

---

## Phase 5: Skill Signing

Enterprise mode requires all installed skills to be cryptographically signed (ECDSA P-256) by IT. Unsigned or tampered skills are blocked at both install time and resolve time.

### 5.1 Generate the Signing Key Pair

Keep the private key secure within your CI/CD pipeline or secrets manager.

```bash
# Generate private key
openssl ecparam -name prime256v1 -genkey -noout -out skill-signing-key.pem

# Extract the public key (this goes into Chrome policy)
openssl ec -in skill-signing-key.pem -pubout -out skill-signing-pubkey.pem
```

### 5.2 Format the Public Key for Policy

The public key must be a single-line string with literal `\n` characters for the Chrome policy value:

```bash
cat skill-signing-pubkey.pem | perl -pe 's/\n/\\n/g'
```

Output example:

```
-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0C...\n-----END PUBLIC KEY-----\n
```

### 5.3 Sign a Skill

Use the provided `koi-sign.js` script (located at `tools/koi-sign.js`). This script uses the same V8 text encoding as the browser's Web Crypto API, ensuring byte-for-byte hash parity.

```bash
node tools/koi-sign.js \
  --pub-key skill-signing-pubkey.pem \
  --priv-key skill-signing-key.pem \
  skills/<target-skill-folder>
```

The script outputs a `skill.sig` file into the skill folder and verifies the signature immediately. Distribute the skill folder with this file included.

### 5.4 Verify Signing (After Full Configuration)

**Positive path:** Install the signed skill via the Skills UI. Background console should log:

```
[SkillStorage] Signature verified for skill: <skill-name>
```

**Negative path:** Modify any character in the skill's script files and attempt installation. The UI should block with a signature verification failure.

### 5.5 Sign a Global Guardrail File

Enterprise environments must also secure global configuration scripts. `koi-sign.js` can sign standalone `.js` files (like `guardrails.js`).

Instead of writing a separate `.sig` file, the script will append the signature directly to the end of the Javascript file as a comment: `// @koi-signature: <base64>`.

```bash
node tools/koi-sign.js \
  --pub-key skill-signing-pubkey.pem \
  --priv-key skill-signing-key.pem \
  configs/guardrails.js
```

---

## Phase 6: Skill Distribution

Signed skills must be delivered to employee browsers. Supported distribution methods:

1. **Bundled with extension:** Place signed skill folders in the extension's `skills/` directory before packaging. Skills are available immediately after install.
2. **Skills UI upload:** Employees open the Skills Manager in the sidepanel and import a skill folder (containing `skill.sig`). The signature is verified at install time.
3. **Preload via config:** Add skill names to the `skills.preload` array in the config to auto-load them on session start (skills must already be installed).

---

## Phase 7: Skill Development Environment

Enterprise mode enforces signed skills, locked configs, and IT-controlled policies — but Koi is designed as a skill operating system. Employees should be able to develop their own skills. This phase describes how IT can provision a secure development environment that preserves the full enterprise security stack while giving developers a fast iteration loop.

### 7.1 Architecture Overview

The developer runs a **second copy of the extension** (the "dev extension") alongside the production extension on the same managed device. The dev extension is built from the same source as the production extension but uses a different `key` in `manifest.json`, giving it a distinct Chrome extension ID. IT controls this dev extension via a separate managed policy scoped to the developer's device.

The security model does not change. Enterprise mode is still active: skills must be signed, configs are locked, and the license is validated. The key difference is:

- The dev extension's managed policy restricts its [runtime_allowed_hosts](https://support.google.com/chrome/a/answer/9867568) to a narrow set of URLs (e.g., a single internal test page), the dev policy is applied to the developer's managed device only by IT upon request, limiting the blast radius of any skill under development.
- Skill signing is handled by a **self-service signing RPC** operated by IT. Developers call the RPC to sign their skills on demand. The RPC logs every signing event (who, what skill, content hash, timestamp) for audit.
- The developer authenticates with the same corporate SSO. Gateway access, LLM routing, and guardrails all work identically to production.

```
┌────────────────────────────────────────────────────────────────────────┐
│                     Developer's Managed Device                         │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ┌─────────────────────────────┐  ┌──────────────────────────────────┐ │
│  │ Production Extension        │  │ Dev Extension                    │ │
│  │ ID: aedfofod...             │  │ ID: <dev-extension-id>           │ │
│  │                             │  │                                  │ │
│  │ • IT-signed skills only     │  │ • Self-service signed skills     │ │
│  │ • Full host access          │  │ • Scoped to test URLs only       │ │
│  │ • allowed_skill_names: [..] │  │ • allowed_skill_names: ["*"]     │ │
│  │ • Production policy         │  │ • Dev policy (per-device)        │ │
│  └─────────────────────────────┘  └──────────────────────────────────┘ │
│                │                              │                        │
│                └──────────┬───────────────────┘                        │
│                           ▼                                            │
│              Same SSO · Same Gateway · Same LLM                        │
│              Same Global Guardrails · Same License                     │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### 7.2 IT Setup (One-Time)

#### 7.2.1 Generate the Dev Extension Key

Generate a keypair whose public key will be embedded in the dev extension's `manifest.json`. This key determines the dev extension ID. All developers share the same key so all dev extensions have the same ID, allowing IT to write one policy template.

```bash
# Generate a fresh RSA keypair for the dev extension identity
# (This is a Chrome extension packaging key, NOT the skill signing key)
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out dev-extension.pem

# Extract the public key in the DER format Chrome expects
openssl rsa -in dev-extension.pem -pubout -outform DER -out dev-extension-pub.der

# Convert to base64 for manifest.json
base64 -w0 dev-extension-pub.der > dev-extension-pub.b64
```

Publish `dev-extension-pub.b64` to an internal wiki, shared drive, or developer portal. The `.pem` private key is not needed by developers — it is only required if IT wants to produce a `.crx` package. For the unpacked-extension workflow described below, only the public key is used.

#### 7.2.2 Determine the Dev Extension ID

Chrome derives the extension ID from the public key. To find the ID before any developer loads the extension:

```bash
# Compute the extension ID from the DER public key
cat dev-extension-pub.der | openssl dgst -sha256 -binary | head -c 16 | xxd -p | tr '0-9a-f' 'a-p'
```

Record this ID — it is the target for the dev managed policy (e.g., `bfcmjegopkhnface...`).

#### 7.2.3 Deploy the Self-Service Skill Signing RPC

Set up an internal service (HTTP endpoint, CLI tool, or CI job) that:

1. Accepts a skill folder upload (or Git ref) and the developer's SSO token.
2. Validates the SSO token against the corporate IdP.
3. Runs `node tools/koi-sign.js --pub-key <key> --priv-key <key> <skill-folder>` using the **same** skill signing keypair used for production (Phase 5).
4. Returns the signed skill folder (with `skill.sig` included).
5. Logs an audit record: developer identity, skill name, content hash (SHA-256), timestamp.

Using the same skill signing key for dev and production is intentional. The security gate for production deployment is not the signing key — it is the `allowed_skill_names` whitelist in the production extension's managed policy. A dev-signed skill cannot load in the production extension unless IT explicitly adds its name to the production whitelist.

#### 7.2.4 Prepare the Dev Managed Policy Template

Create a policy template identical to the production policy (§3.1) but with these differences:

| Field                   | Production Policy                  | Dev Policy                                          |
| ----------------------- | ---------------------------------- | --------------------------------------------------- |
| Extension ID in path    | `aedfofodkbfgnjknkjpockkgajemkbng` | `<dev-extension-id>` from §7.2.2                    |
| `allowed_skill_names`   | Curated list                       | `["*"]` (unrestricted — URL scoping is the control) |
| `runtime_allowed_hosts` | (not set — full access)            | Scoped to developer's approved test URLs            |

All other fields (`license_key`, `organization_id`, `skill_signing_public_key`, `configs`, `default_config`) are the same as production.

### 7.3 Provisioning a Developer (Per-Developer, IT Action)

When a developer requests a skill development environment:

1. Developer submits a request specifying the target URL(s) they need to develop against (e.g., `https://staging.internal.corp/*`).
2. IT approves the request and logs it (ticket system, access review tool, etc.).
3. IT enables Chrome developer mode on the developer's managed device (via MDM policy for the developer's OU or device).
4. IT pushes the dev managed policy to the developer's device, with `runtime_allowed_hosts` set to the approved URL(s).

Example dev policy (Linux, `/etc/opt/chrome/policies/managed/koi-dev.json`):

```json
{
  "3rdparty": {
    "extensions": {
      "<dev-extension-id>": {
        "license_key": "ENTERPRISE EXTENSION LICENSE-...",
        "organization_id": "fe1d02a0-6354-4cb9-bd05-52abfbafc707",
        "skill_signing_public_key": "-----BEGIN PUBLIC KEY-----\nMFkw...",
        "allowed_skill_names": ["*"],
        "default_config": "corp-gemini",
        "configs": {
          "corp-gemini": { "...same as production..." }
        }
      }
    }
  },
  "ExtensionSettings": {
    "<dev-extension-id>": {
      "runtime_allowed_hosts": [
        "https://staging.internal.corp/*"
      ]
    }
  }
}
```

Because the policy is pushed per-device, different developers can have different URL scopes while sharing the same dev extension ID.

### 7.4 Developer Setup (One-Time)

#### 7.4.1 Extract the Production Extension

Locate the installed production extension on disk. Chrome stores installed extensions at:

| OS      | Path                                                                                          |
| ------- | --------------------------------------------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\aedfofodkbfgnjknkjpockkgajemkbng\` |
| macOS   | `~/Library/Google/Chrome/Default/Extensions/aedfofodkbfgnjknkjpockkgajemkbng/`                |
| Linux   | `~/.config/google-chrome/Default/Extensions/aedfofodkbfgnjknkjpockkgajemkbng/`                |

Copy the version subfolder (e.g., `1.0.9_0/`) to a working directory:

```bash
cp -r ~/.config/google-chrome/Default/Extensions/aedfofodkbfgnjknkjpockkgajemkbng/1.0.9_0 \
  ~/koi-dev-extension
```

#### 7.4.2 Patch manifest.json

Replace the `key` field in `manifest.json` with the dev public key published by IT:

```bash
cd ~/koi-dev-extension

# Read the base64 public key from IT's published file
DEV_KEY=$(cat /path/to/dev-extension-pub.b64)

# Replace the key field in manifest.json
jq --arg k "$DEV_KEY" '.key = $k' manifest.json > manifest.tmp && mv manifest.tmp manifest.json
```

#### 7.4.3 Load the Dev Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** and select the `~/koi-dev-extension` directory
4. Verify the extension ID matches the dev extension ID from §7.2.2
5. Open `chrome://policy/` and confirm the dev policy values appear under the dev extension ID

The production extension remains installed and active. Both extensions run side by side — the production extension has full host access, the dev extension is scoped to the approved URLs.

### 7.5 Development Loop

```
┌──────────┐     ┌──────────────┐     ┌───────────┐     ┌──────────┐
│  Write   │────▶│ Sign via RPC │────▶│  Install  │────▶│   Test   │
│  skill   │     │ (self-serve) │     │  in dev   │     │ on scope │
└──────────┘     └──────────────┘     │ extension │     │  pages   │
     ▲                                └───────────┘     └────┬─────┘
     │                                                       │
     └───────────────────────────────────────────────────────┘
                        iterate
```

1. **Write or modify** the skill locally (SKILL.md, scripts, MCP servers).
2. **Sign** by calling the IT signing RPC. The RPC returns the skill folder with a valid `skill.sig`.
3. **Install** the signed skill into the dev extension via the Skills Manager UI.
4. **Test** against the scoped URL(s). The full Koi sandbox, guardrails, SSO, and gateway stack are active — the only constraint is the URL scope.
5. **Iterate** — modify the skill, re-sign, re-install. Each signing event is logged.

### 7.6 Promotion to Production

When a skill is ready for org-wide deployment:

1. Developer submits the skill folder for IT review (e.g., opens a pull request to the internal skills repository).
2. IT reviews the skill code — scripts, MCP servers, guardrails, SKILL.md.
3. The skill is already signed with the production signing key (the signing RPC uses the same keypair). No re-signing is needed.
4. IT adds the skill name to the production extension's `allowed_skill_names` policy.
5. IT distributes the skill via Phase 6 channels (bundled, Skills UI upload, or preload config).

### 7.7 Revoking Developer Access

To revoke a developer's skill development environment:

1. Remove the dev managed policy from the developer's device (via MDM).
2. The dev extension loses its enterprise configuration on next Chrome restart and can no longer load skills.
3. Optionally, disable Chrome developer mode on the device to prevent loading unpacked extensions.

The audit log from the signing RPC retains all historical signing events for compliance.

---


## Troubleshooting

| Symptom                                          | Console Evidence                                       | Cause                                                           | Fix                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Extension shows "Configure Local Mode"           | `Enterprise license not activated`                     | License key or org ID invalid/missing in policy                 | Verify `license_key` and `organization_id` at `chrome://policy`                                           |
| Config dropdown shows "default (not configured)" | `loadConfig` log missing enterprise                    | Managed policy not detected                                     | Check policy path matches extension ID; reload policies                                                   |
| LLM calls fail with 401                          | `Gemini API requires either an API key or OAuth token` | Neither API key nor projectId in config                         | Check `configs` JSON has `apiKey` or `projectId`                                                          |
| `accessToken=MISSING` with ADC                   | `Auth State: accessToken=MISSING, projectId=MISSING`   | Extension version < 1.0.9 (authService lost during reconfigure) | Update to 1.0.9+; verify build includes `LLMClient` authService fix                                       |
| `accessToken=MISSING` but `projectId=PRESENT`    | Token retrieval returns null                           | `chrome.identity.getAuthToken` failed silently                  | Run OAuth test script from §3B.5; check `chrome://identity-internals`                                     |
| LLM calls fail with 403                          | `Gemini API error (403)`                               | User lacks IAM roles on GCP project                             | Grant `Vertex AI User` + `Service Usage Consumer` roles                                                   |
| Skill install blocked                            | `Signature verification failed`                        | Skill was modified after signing, or wrong public key in policy | Re-sign the skill; verify `skill_signing_public_key` matches the private key used                         |
| Skill install blocked                            | `Skill not in allowed list`                            | Skill name not in `allowed_skill_names`                         | Add the skill name to the JSON array in policy                                                            |
| Thinking/reasoning not working                   | No `[Gemini 3] Thinking enabled` log                   | `thinking` config field mismatch                                | Ensure config uses `budgetLevel` (not `budgetTokens`): `"thinking":{"enabled":true,"budgetLevel":"high"}` |

---

## License Lifecycle

| Event                    | Behavior                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ |
| License valid            | Silent activation on extension install/startup                                 |
| License expired          | Activation fails on next startup; extension shows enterprise error             |
| License revoked in Polar | Next validation attempt fails; existing active sessions continue until restart |
| Seat limit reached       | Activation fails with limit error; revoke unused instances in Polar dashboard  |

To revoke a specific instance, use the Polar API or dashboard to deactivate the license key. The extension will fail activation on its next startup.

---

## Security Model Summary

| Layer                | Mechanism                                                             |
| -------------------- | --------------------------------------------------------------------- |
| LLM traffic routing  | Config locked via managed policy; user cannot edit                    |
| Skill integrity      | ECDSA P-256 signatures verified at install + resolve time             |
| Authentication (ADC) | `chrome.identity.getAuthToken` → Google IAM enforces roles            |
| License enforcement  | Polar.sh activation on startup; no activation = no agent              |
| Config immutability  | Enterprise mode disables save/edit/add/delete in UI                   |
| Skill development    | Dev extension scoped to approved URLs; signing RPC audits every build |

```

```
