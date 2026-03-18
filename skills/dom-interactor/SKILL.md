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

| Tool               | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `dom_get_property` | Read a property from an element or global object. |
| `dom_call_method`  | Call a method on an element or global object.     |

## Usage

Target by CSS selector or dotted global path:

```
dom_get_property({ selector: "[data-testid='email']", property: "value" })
dom_get_property({ global: "document", property: "title" })
dom_call_method({ selector: "#my-form", method: "scrollIntoView" })
```
