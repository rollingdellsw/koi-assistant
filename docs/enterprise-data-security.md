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
