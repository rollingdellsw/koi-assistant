# NOTICE

This product includes third-party software components licensed under various open-source licenses.

---

## Runtime Dependencies

### Frontend Framework & UI

| Package        | License | Source                                     |
| -------------- | ------- | ------------------------------------------ |
| react          | MIT     | https://github.com/facebook/react          |
| react-dom      | MIT     | https://github.com/facebook/react          |
| react-markdown | MIT     | https://github.com/remarkjs/react-markdown |
| zustand        | MIT     | https://github.com/pmndrs/zustand          |

### Core Utilities & Logic

| Package | License | Source                            |
| ------- | ------- | --------------------------------- |
| zod     | MIT     | https://github.com/colinhacks/zod |
| chalk   | MIT     | https://github.com/chalk/chalk    |
| js-yaml | MIT     | https://github.com/nodeca/js-yaml |
| uuid    | MIT     | https://github.com/uuidjs/uuid    |

### Schema & Validation

| Package                          | License | Source                                             |
| -------------------------------- | ------- | -------------------------------------------------- |
| @alcyone-labs/zod-to-json-schema | ISC     | https://github.com/alcyone-labs/zod-to-json-schema |
| jsonrepair                       | ISC     | https://github.com/josdejong/jsonrepair            |

### OpenTelemetry (Observability)

| Package                             | License    | Source                                             |
| ----------------------------------- | ---------- | -------------------------------------------------- |
| @opentelemetry/resources            | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-js |
| @opentelemetry/sdk-metrics          | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-js |
| @opentelemetry/semantic-conventions | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-js |
| opentelemetry                       | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-js |

### Bundled Libraries (`public/lib/`)

These libraries are bundled directly into the extension for offline/sandboxed use.

| Package        | Version  | License      | Source                                    |
| -------------- | -------- | ------------ | ----------------------------------------- |
| pdf.js (pdfjs) | v5.4.624 | Apache-2.0   | https://github.com/mozilla/pdf.js         |
| mammoth.js     | v1.11.0  | BSD-2-Clause | https://github.com/mwilliamson/mammoth.js |

---

## License Texts

### MIT License

The MIT License permits reuse within proprietary software on the condition that the license is distributed with that software.

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License 2.0

Dependencies including `pdf.js` are licensed under the Apache License 2.0. The full text is available at:
https://www.apache.org/licenses/LICENSE-2.0

### BSD 2-Clause License

The `mammoth.js` package is licensed under the BSD 2-Clause License:

```text
Copyright (c) 2013, Michael Williamson
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

```

---

## Skills and MCP Servers

Files located in the `skills/` directories are licensed under the MIT License and may include inspiration or patterns from the broader Model Context Protocol (MCP) ecosystem.
