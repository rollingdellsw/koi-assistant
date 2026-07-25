---
name: dom-interactor
description: Read DOM properties and call methods on elements or global objects. Works across shadow DOM and iframe contexts.
mcp-servers:
  - name: dom-interactor
    script: mcp/dom_interactor.js
---

# DOM Interactor

Read properties and call methods on DOM elements or JavaScript globals.

## Tools

| Tool             | Purpose                                           |
| ---------------- | ------------------------------------------------- |
| `domGetProperty` | Read a property from an element or global object. |
| `domCallMethod`  | Call a method on an element or global object.     |

## Usage

Target by CSS selector or dotted global path:

```
domGetProperty({ selector: "[data-testid='email']", property: "value" })
domGetProperty({ global: "document", property: "title" })
domCallMethod({ selector: "#my-form", method: "scrollIntoView" })
```
