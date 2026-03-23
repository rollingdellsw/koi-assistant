# Koi™ — The Enterprise AI Productivity Operating System

## 1. Vision: The Browser is the Enterprise OS

Koi™ is a **Productivity Operating System** designed for the modern, AI-integrated enterprise.
In an era where 90% of enterprise work happens in a browser, the browser _is_ the OS. Koi™ builds on the browser's native infrastructure — **Identity, Resource Management, and a Shared GUI Interface** — to orchestrate AI intelligence across disparate enterprise silos.

---

## 2. The Core Thesis: "The UI is the Shared Intelligence Canvas"

Current AI automation trends focus on "Headless" or "API-first" interaction. Koi™ takes a different stance: **The Web UI is the essential, permanent interface for both Human and AI intelligence.**

- **The UI as the AI's "Eyes":** Complex data (Medical Imaging, Financial Dashboards, CAD) requires a visual context. Koi™ leverages the browser's rendering engine as a pre-processor, allowing the AI to "see" and "act" on the same pixels as a human expert.
- **The 7.5 Billion-Pixel Stress Test:** Traditional LLM agents fail on massive datasets. Koi™ uses the UI (e.g., OpenSeadragon) to tile, zoom, and pan across a **7.5B-pixel pathology slide**, providing the AI with high-fidelity visual context without crashing the context window.
- **Ending the "Black Box":** Enterprise workflows carry liability — a human must remain accountable for every outcome. By automating within the UI, Koi™ ensures every AI action is observable, verifiable, and grounded in the visual reality of the workspace.

---

## 3. Platform Pillars

### **A. Identity-Native (SSO-First)**

Koi™ operates within the user’s existing authenticated browser state.

- **Inherited Permissions:** No need for "Service Accounts" or new credentials. Koi™ natively inherits the user's SSO/MFA permissions (Okta, Azure AD, etc.).
- **Accountability:** Every action is tied to a human identity, maintaining a perfect, auditable trail of liability for enterprise governance.

### **B. Local-First Security (Air-Gapped Ready)**

- **Edge Execution:** All session data and orchestration logic live locally in `IndexedDB` and `chrome.storage.local`.
- **Provider Agnostic:** Connect to any LLM—from cloud-based Gemini/Claude to on-premise Llama.cpp servers—keeping 100% of sensitive data behind the firewall.

### **C. Sub-Task Delegation (Orchestration at Scale)**

Koi™ solves the context-window limit by spawning independent sub-agents for heavy lifting (e.g., analyzing 50 separate regions of a massive image or summarizing 1,000+ page PDFs) and returning only the relevant insights to the main conversation.

---

## 4. Strategic Positioning & Market Context

| Feature             | **Koi™ OS**           | **Cloud-Based Agents** | **Microsoft/Google Copilot** |
| :------------------ | :--------------------- | :--------------------- | :--------------------------- |
| **Execution Model** | **Local-First (Edge)** | Cloud-First / Proxy    | Cloud-Siloed                 |
| **Identity**        | **Inherits User SSO**  | Needs New Credentials  | Single-Cloud Only            |
| **Visual Context**  | **7.5B Pixel Support** | Standard Web Only      | Text/Small Image Only        |
| **Interface**       | **Shared UI Canvas**   | "Black Box" Automation | Sidebar Chat                 |
| **Data Privacy**    | **Zero Exfiltration**  | Data Leaves Perimeter  | Data Stays in Silo           |

---

## 5. Sample Use Cases & ROI

### **High-Stakes Technical Work (e.g., Engineering/Pathology)**

An electrical engineer spends 8+ hours browsing a 1,299-page component specification to locate one reference relevant to a design question. A pathologist manually pans across a 7.5-billion-pixel whole-slide image to find regions of interest. Koi™ reads, indexes, and answers against the full document or image in minutes — within the engineer's existing browser workspace, with zero data leaving the device. The specialist stays in control of every decision; Koi™ provides a visual, interactive, and **transparent** conversation with the AI — not a black-box answer.

### **Cross-Silo Orchestration (e.g., Finance/Operations)**

A finance analyst copies numbers from an internal database into a spreadsheet, reformats them, and pastes the result into a slide deck — a process repeated weekly that takes half a day. Koi™ queries the internal PostgreSQL database via a secure gateway, generates the formatted report in Google Sheets or Excel Online, and delivers it ready for review. The analyst's SSO credentials govern access; no service account or new permission is required.

### **Secure Office Productivity**

A procurement team needs to review a 1,000-page vendor contract against internal policy before a deadline. Today that means days of manual reading or uploading sensitive documents to a third-party AI service. Koi™ processes the full document locally, surfaces the relevant clauses, and keeps the raw content entirely within the corporate perimeter.

---

## 6. Enterprise Security Architecture

Koi™ is secured by a four-layer trust model designed for regulated enterprise environments:

**Device Trust.** The extension runs on managed devices enrolled in corporate MDM (Intune, JAMF). Disk encryption is enforced, extensions are whitelisted via Chrome policy, and device identity is certificate-bound.

**User Identity.** Authentication is hardware-bound (YubiKey, Touch ID) through the organization's existing IdP (Okta, Google Workspace, Azure AD). The extension inherits the user's SSO session — no separate credentials exist.

**Extension Trust.** Every skill deployed to the extension must be cryptographically signed (ECDSA P-256) with a corporate-managed key. Signatures are verified at both install time and execution time. MCP scripts are bundled with the skill — no remote code is loaded.

**Gateway Trust.** When Koi™ connects to internal data sources, the gateway validates the user's SSO token against the IdP. Database credentials are stored exclusively in the gateway environment and are never sent to the browser. Network segmentation ensures the browser has no direct database access.

The result: credentials never reach the browser, every action traces to a human identity, and skill code is tamper-proof from IT's signing pipeline to the employee's machine.

---

## 7. Roadmap: The Path to Autonomous Workspaces

1.  **Phase 1 (Current):** Browser-based "Co-Pilot" with Skill extensibility and local-first security.
2.  **Phase 2:** Deep integration with Enterprise MCP Gateways for internal data orchestration.
3.  **Phase 3:** Full "Autonomous Workspace" where Koi™ manages complex, multi-tab workflows across disparate enterprise silos, all visible and auditable through the Shared UI Canvas.

---

## 8. Business Model

Koi™ uses a **land-and-expand** licensing model. Enterprises purchase per-seat activation licenses (one-time, reusable within the organization) to unlock the platform. From there, Koi™ offers professional services — billed hourly — to build and deploy custom workflow automations tailored to the customer's internal systems. As the customer matures, the open skill platform enables self-service: internal teams author, sign, and distribute their own skills using the same OS-level infrastructure.
As an organization builds, signs, and deploys custom skills, switching costs compound and the platform becomes infrastructure.

---

## 9. Why This Exists and Why It Can't Be Easily Replicated

Koi™ is not a concept deck. It is shipping software with a production Chrome Web Store listing, enterprise licensing via managed Chrome policy, cryptographic skill signing (ECDSA P-256), and deployment through standard MDM tooling (Intune, JAMF, GPO). No comparable product exists that combines local-first execution, inherited SSO identity, visual context at billion-pixel scale, and a signed skill platform — all within the browser.

Cloud-based AI agents require data to leave the perimeter. Copilot products are locked to a single vendor's cloud. RPA tools automate _around_ applications rather than _within_ them. Koi™ occupies a unique position: it delivers AI productivity with zero data exfiltration, zero new credentials, and full auditability — the three requirements that enterprise security teams actually block deployments over.

_Koi™: Bringing peace of mind to the Enterprise AI journey._
