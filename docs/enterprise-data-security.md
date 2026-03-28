# Enterprise Data Security Audit

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Enterprise Security Model                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Layer 1: Device Trust (MDM)                                         │    │
│  │                                                                     │    │
│  │  • Managed device with corporate MDM (Intune, JAMF, etc.)           │    │
│  │  • Disk encryption enforced                                         │    │
│  │  • Extension whitelist via Chrome policy                            │    │
│  │  • Certificate-based device identity                                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Layer 2: User Identity (SSO + MFA)                                  │    │
│  │                                                                     │    │
│  │  • Hardware-bound authentication (YubiKey, Touch ID)                │    │
│  │  • SSO via corporate IdP (Okta, Google Workspace, Azure AD)         │    │
│  │  • Session managed by Chrome profile                                │    │
│  │  • Identity available to extension via chrome.identity              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Layer 3: Extension Trust                                            │    │
│  │                                                                     │    │
│  │  • Extension installed via managed Chrome policy                    │    │
│  │  • Skills signed with corporate key (IT-managed)                    │    │
│  │  • Signature verified before skill execution                        │    │
│  │  • MCP scripts bundled with skill (no remote code)                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ Layer 4: Gateway Trust                                              │    │
│  │                                                                     │    │
│  │  • Gateway validates SSO token against IdP                          │    │
│  │  • Database credentials stored in Gateway environment               │    │
│  │  • Credentials NEVER sent to browser                                │    │
│  │  • Network segmentation: Gateway has DB access, browser doesn't     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Gateway Deployment (Remote MCP)

The Koi Gateway (`tools/gateway/koi-gateway.js`) bridges the Chrome Extension to backend MCP servers (e.g., PostgreSQL) over WebSocket. It is an optional component — only required when skills need access to server-side resources that the browser cannot reach directly.

### Architecture & Trust Model

The Gateway is a **transparent transport relay**, not an authentication provider. It does not implement SSO or manage user sessions. The trust model is:

1. **Browser Extension** obtains an SSO token from the corporate IdP (via `chrome.identity` or equivalent) and forwards it with each Gateway connection.
2. **Gateway** validates the SSO token against the IdP (e.g., OIDC introspection, JWKS verification) before proxying MCP requests. It holds backend credentials (database passwords, API keys) in its own environment — these are never sent to the browser.
3. **Backend MCP servers** receive only proxied JSON-RPC calls from the Gateway. They do not see or handle user identity directly.

**Implementing IdP token verification in the Gateway is the responsibility of the deploying organization's IT team.** The Gateway ships with a pluggable `validateAuth(token)` method. In `auth.mode: "none"`, all connections are accepted (suitable for development or when the Gateway sits behind a corporate reverse proxy that already enforces authentication). In `auth.mode: "sso"`, IT must implement the verification logic appropriate to their IdP — for example, calling an OIDC token introspection endpoint or validating a JWT signature against the IdP's JWKS. This is by design: Koi does not prescribe a specific IdP or SSO protocol, so the verification implementation must match the organization's identity infrastructure.

### Deployment Options

| Scenario                                                                 | `auth.mode` | Who enforces identity                                       |
| ------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------- |
| Development / local testing                                              | `none`      | No enforcement                                              |
| Behind corporate reverse proxy (e.g., Cloudflare Access, AWS ALB + OIDC) | `none`      | Reverse proxy validates SSO before traffic reaches Gateway  |
| Direct exposure on internal network                                      | `sso`       | Gateway validates token via IT-implemented `validateAuth()` |

### Configuration

```json
{
  "port": 8080,
  "auth": {
    "mode": "sso"
  },
  "servers": {
    "postgres": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-postgres",
        "postgresql://user:pass@db-host:5432/mydb"
      ]
    }
  }
}
```

### Extension-Side Gateway Config

In the extension's config (managed policy or local settings), add a `gateways` block pointing to the Gateway instance:

```json
{
  "gateways": {
    "default": {
      "url": "ws://gateway-host:8080"
    }
  }
}
```

Skills that declare `gateway: default` in their `mcp-servers` section will route through this Gateway.
