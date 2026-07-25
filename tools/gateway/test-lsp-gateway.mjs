#!/usr/bin/env node
/**
 * test-lsp-gateway.mjs — Gateway-driven test for the lsp_search MCP server.
 *
 * WS-transport conversion of lsp_search/test/test_lsp_stress_go.ts: instead of
 * spawning the server directly (lsp-test-kit), it connects through the Koi
 * Gateway exactly like the Chrome extension does (WS /mcp/sandbox, auth
 * handshake, then JSON-RPC), reusing GatewayClient from test-sandbox-gateway.
 *
 * The server boots workspace-less by design (no WORKING_DIR); the suite's
 * first real step is set_workspace — the same call an LLM session must make.
 *
 * Usage:
 *   node test-lsp-gateway.mjs <workspace> [preset]   # full suite (preset: go|rust|ts|c)
 *   node test-lsp-gateway.mjs <workspace> --symbols Ctx,Engine   # custom symbols
 *   node test-lsp-gateway.mjs <workspace> search <query>         # ad-hoc search
 *   node test-lsp-gateway.mjs <workspace> ast <pattern>          # ad-hoc search_ast
 *
 * Env: GATEWAY_URL (default ws://localhost:8080), SERVER_NAME (default sandbox),
 *      WARMUP_MS (extra wait for slow indexers, default 2000; rust: try 60000+)
 *
 * Example (mirrors the original stress tests):
 *   node test-lsp-gateway.mjs ~/tmp/gin go
 *   WARMUP_MS=90000 node test-lsp-gateway.mjs ~/workspace/redfish-codegen rust
 *
 * Host prerequisites (install yourself; the gateway installer adds nothing):
 *   ripgrep      sudo apt install ripgrep
 *   ast-grep     npm install -g @ast-grep/cli
 *   Python       pip install python-lsp-server[all]
 *   JS/TS        npm install -g typescript-language-server typescript
 *   Rust         rustup component add rust-analyzer
 *   Go           go install golang.org/x/tools/gopls@latest
 *   C/C++        sudo apt install clangd            # or brew install llvm
 *
 * Missing backends are reported as SKIPs, not failures: the semantic,
 * structural and text tiers each degrade independently by design.
 *
 * Corpora these presets were tuned against:
 *   ts    tools/gateway/lsp_search/          (this repo)
 *   rust  https://github.com/AmateurECE/redfish-codegen.git
 *   go    https://github.com/gin-gonic/gin.git
 *   c     https://github.com/systemd/systemd.git
 */

import fs from 'fs';
import path from 'path';
import { GatewayClient, section, show } from './test-sandbox-gateway.mjs';

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:8080';
const SERVER_NAME = process.env.SERVER_NAME || 'sandbox';
const WARMUP_MS = parseInt(process.env.WARMUP_MS || '2000', 10);

// Symbol presets per language, taken from the original stress tests.
// `ast` is the structural (tree-sitter) probe for each language:
//   lang    ast-grep grammar id
//   pattern a shape that is idiomatic enough to appear in any real codebase
//   probe   an overlay-only file used to prove the tools read through the
//           overlay rather than the host tree (it is never written to disk)
const PRESETS = {
  go: {
    marker: 'go.mod', symbols: ['Context', 'Engine', 'HandlerFunc'], workflow: 'RouterGroup',
    ast: {
      lang: 'go', pattern: 'if err != nil { $$$BODY }',
      probe: { file: 'koi_ast_probe.go', name: 'KoiAstProbe',
        code: 'package koiprobe\n\nfunc KoiAstProbe(a int) int {\n\treturn a + 1\n}\n' },
    },
  },
  rust: {
    marker: 'Cargo.toml', symbols: ['main', 'Error', 'Config'], workflow: 'new',
    ast: {
      lang: 'rust', pattern: 'match $EXPR { $$$ARMS }',
      probe: { file: 'koi_ast_probe.rs', name: 'koi_ast_probe',
        code: 'pub fn koi_ast_probe(a: u32) -> u32 {\n    a + 1\n}\n' },
    },
  },
  ts: {
    marker: 'tsconfig.json', symbols: ['ToolHandler', 'createServer'], workflow: 'ServerContext',
    ast: {
      lang: 'ts', pattern: 'await $CALL',
      probe: { file: 'koi_ast_probe.ts', name: 'koiAstProbe',
        code: 'export function koiAstProbe(a: number): number {\n  return a + 1;\n}\n' },
    },
  },
  c: {
    marker: null, symbols: ['main', 'init'], workflow: 'free',
    ast: {
      lang: 'c', pattern: 'if ($COND) { $$$BODY }',
      probe: { file: 'koi_ast_probe.c', name: 'koi_ast_probe',
        code: 'int koi_ast_probe(int a) {\n        return a + 1;\n}\n' },
    },
  },
};

let passed = 0, failed = 0, skipped = 0;
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** An optional host backend is missing — not a product defect. */
function skip(label, why) { skipped++; console.log(`  ⊘ ${label} — ${why}`); }
/** Informational: true is good, false is a note, neither moves the score. */
function soft(label, cond, detail = '') {
  console.log(`  ${cond ? '✅' : '○'} ${label}${!cond && detail ? ` — ${detail}` : ''}`);
}

function detectPreset(workspace) {
  if (fs.existsSync(path.join(workspace, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(workspace, 'Cargo.toml'))) return 'rust';
  if (fs.existsSync(path.join(workspace, 'tsconfig.json'))) return 'ts';
  return 'c';
}

/** search with retry — slow indexers (rust-analyzer/clangd) come up gradually. */
async function searchWithRetry(client, query, { tries = 5, delayMs = 3000 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await client.callTool('search', { query });
    if (last?.results?.length) return last;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

/** Poll get_lsp_diagnostics until `ok(result)` or attempts run out (LSP is async). */
async function diagnosticsUntil(client, filePath, ok, { tries = 6, delayMs = 1500 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await client.callTool('get_lsp_diagnostics', { file_path: filePath });
    if (ok(last)) return last;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

/**
 * Design 2 (editor-style sync): edits made through the sandbox live only in the
 * overlay and are pushed to the language server as didOpen/didChange, and the
 * LSP query tools read overlay content. So an overlay-only file — one that never
 * exists on the host disk — must still be analysable, and editing it must change
 * what the LSP reports. This suite proves that observable contract, plus the raw
 * sync_document/close_document/sync_reset plumbing.
 * */
async function documentSyncSuite(client, workspace, preset) {
  section('editor-style LSP sync (Design 2: overlay edits visible to LSP)');
  // Plumbing round-trip (language-agnostic): the sync tools must be present and
  // respond. sandbox drives these automatically; here we exercise them directly.
  const reset0 = await client.callTool('sync_reset', {});
  check('sync_reset responds', reset0.isError !== true, JSON.stringify(reset0)?.slice(0, 150));
  if (preset !== 'ts') {
    console.log(`  \u25cb deep assertions are TypeScript-specific; preset=${preset} — running plumbing check only.`);
    const probe = 'koi_sync_probe.txt';
    const sd = await client.callTool('sync_document', { path: probe, text: 'hello from overlay\n' });
    check('sync_document round-trips', sd.isError !== true, JSON.stringify(sd)?.slice(0, 150));
    const cd = await client.callTool('close_document', { path: probe });
    check('close_document round-trips', cd.isError !== true, JSON.stringify(cd)?.slice(0, 150));
    return;
  }
  // TypeScript: prove diagnostics track overlay edits, with the file never on disk.
  const rel = 'koi_sync_probe.ts';
  const abs = path.join(workspace, rel);
  // (a) Write a file with a deliberate type error — lands in the overlay only,
  //     and is auto-synced to the language server.
  const bad = 'export const koiSyncProbe: number = "definitely not a number";\n';
  const w1 = await client.callTool('sandbox_write_file', { path: rel, content: bad });
  check('overlay write ok (auto-syncs to LSP)', w1.success === true, JSON.stringify(w1)?.slice(0, 150));
  check('probe file is overlay-only (absent on host disk)', !fs.existsSync(abs), `${abs} leaked to the host tree!`);
  const d1 = await diagnosticsUntil(client, rel, (d) => (d.total_count ?? 0) > 0);
  check('diagnostics SEE the overlay edit (type error reported)',
    (d1.total_count ?? 0) > 0, `count=${d1.total_count} ${JSON.stringify(d1.diagnostics || []).slice(0, 200)}`);
  // (b) Fix the error — the edit must be reflected (not stale, not the first buffer).
  const good = 'export const koiSyncProbe: number = 42;\n';
  const w2 = await client.callTool('sandbox_write_file', { path: rel, content: good });
  check('overlay edit ok', w2.success === true, JSON.stringify(w2)?.slice(0, 150));
  const d2 = await diagnosticsUntil(client, rel, (d) => (d.total_count ?? 0) === 0);
  check('diagnostics REFLECT the fix (error cleared)', (d2.total_count ?? 0) === 0, `count=${d2.total_count}`);
  // (c) hover resolves the overlay symbol (soft — server-dependent formatting).
  const hv = await client.callTool('get_hover', { file_path: rel, line: 1, column: 14 });
  check('hover resolves the overlay symbol', hv.isError !== true, JSON.stringify(hv)?.slice(0, 150));
  // cleanup: drop the buffer and remove the file from the overlay.
  await client.callTool('close_document', { path: rel }).catch(() => {});
  await client.callTool('sandbox_exec', { command: `rm -f -- '${rel}'` }).catch(() => {});
}

/** Install line per language, used when a semantic check has to be skipped. */
const LSP_INSTALL = {
  go: 'go install golang.org/x/tools/gopls@latest',
  rust: 'rustup component add rust-analyzer',
  ts: 'npm install -g typescript-language-server typescript',
  c: 'sudo apt install clangd  (C/C++ also needs compile_commands.json in the project)',
};

/**
 * "No language server" is an environment fact, not a product defect.
 *
 * The gateway usually runs as a systemd *user service*, which does not read
 * your shell profile — so servers installed under ~/.cargo/bin, ~/go/bin or
 * ~/.local/bin are frequently invisible to it even though they work in your
 * terminal. Reporting that as a red ❌ sends you hunting through the code for
 * a bug that is not there, so it is a SKIP with the remedy attached.
 */
function lspUnavailable(res) {
  return res?.isError === true &&
    /Could not start LSP|No project found for file|LSP .*(timeout|not available)/i.test(rawText(res));
}

function lspRemedy(preset) {
  return `no language server answered — install: ${LSP_INSTALL[preset] ?? 'the language server for this project'}` +
    `. If it IS installed, check the gateway log's "Host tools:" lines for where it looked` +
    ` (KOI_TOOL_PATH=/extra/bin adds directories)`;
}

/** MCP results reach us either parsed or raw; get at the text either way. */
function rawText(res) {
  if (typeof res === 'string') return res;
  if (res?.content?.[0]?.text) return res.content[0].text;
  return JSON.stringify(res ?? {});
}

/** The structural tier is optional: tell "not installed" apart from "no match". */
function astUnavailable(res) {
  return res?.isError === true && /ast-grep/i.test(rawText(res));
}

/**
 * Structural (tree-sitter) tier.
 *
 * The tier exists to answer what the language server cannot: exact node
 * boundaries, and a code SHAPE rather than a name. Two properties matter
 * enough to assert:
 *
 *   1. read_ast_node returns a bounded, non-empty declaration — that is what
 *      lets a session read one function out of a 3,000-line file.
 *   2. It reads through the OVERLAY, so a file written this session and never
 *      present on the host tree is still analysable (same contract Design 2
 *      proves for diagnostics, one layer down).
 *
 * Pattern-match counts are informational: the corpora are third-party repos
 * and "how many `if err != nil` blocks does gin have" is not a product
 * invariant. Absence of ast-grep is a SKIP, not a failure.
 */
async function treeSitterSuite(client, workspace, preset, firstDef, firstDefSymbol, firstDefSource) {
  section('structural tier (tree-sitter / ast-grep)');
  const A = PRESETS[preset].ast;

  const probeCall = await client.callTool('search_ast', {
    pattern: A.pattern, lang: A.lang, max_results: 5,
  });
  if (astUnavailable(probeCall)) {
    skip('structural tier', "ast-grep not on the gateway host — install: npm install -g @ast-grep/cli");
    console.log('    (search still works; it just loses its tree-sitter fallback tier)');
    return;
  }

  check('search_ast responds', probeCall.isError !== true, rawText(probeCall).slice(0, 200));
  soft(`pattern "${A.pattern}" matched (${probeCall.total_count ?? 0})`,
    (probeCall.total_count ?? 0) > 0, 'no match in this corpus — informational only');

  // --- an unparseable pattern must be diagnosed, not silently empty --------
  const badPat = await client.callTool('search_ast', { pattern: 'foo(', lang: A.lang });
  check('unparseable pattern is diagnosed, not silently empty',
    badPat.isError !== true && typeof badPat.warning === 'string',
    rawText(badPat).slice(0, 200));

  // --- read_ast_node on a real declaration found by an upstream tier ------
  // Only `lsp` and `tree-sitter` return DECLARATIONS. A `text` hit is any
  // occurrence — "Engine" matched in debug.go because gin's debug.go mentions
  // it — and asking read_ast_node to extract a declaration from a file that
  // merely mentions the name is a bad question, not a bug.
  const declarationTier = firstDefSource === 'lsp' || firstDefSource === 'tree-sitter';
  if (firstDef && firstDefSymbol && declarationTier) {
    const node = await client.callTool('read_ast_node', {
      file_path: firstDef.file_path, name: firstDefSymbol,
    });
    const first = node?.nodes?.[0];
    check(`read_ast_node extracts "${firstDefSymbol}"`, !!first, rawText(node).slice(0, 200));
    if (first) {
      console.log(`  node: ${first.node_type} ${first.start_line}-${first.end_line} :: ${first.signature}`);
      check('node has sane boundaries', first.end_line >= first.start_line,
        `${first.start_line}-${first.end_line}`);
      check('node carries its source', typeof first.code === 'string' && first.code.length > 0);
      // Cross-tier agreement: the LSP's position should fall inside the span
      // tree-sitter reports. Soft — the two tiers legitimately point at
      // different anchors for decorated or attribute-wrapped declarations.
      soft('LSP position falls inside the tree-sitter span',
        firstDef.line >= first.start_line && firstDef.line <= first.end_line,
        `lsp line ${firstDef.line} vs span ${first.start_line}-${first.end_line}`);
    }

    const missing = await client.callTool('read_ast_node', {
      file_path: firstDef.file_path, name: 'KoiNoSuchSymbol12345XYZ',
    });
    check('unknown declaration returns empty, not an error',
      missing.isError !== true && (missing.total_count ?? 0) === 0, rawText(missing).slice(0, 200));
  } else if (firstDef && !declarationTier) {
    skip('read_ast_node on a real declaration',
      `the "${firstDefSource}" tier returns occurrences, not declarations — nothing upstream to extract`);
  } else {
    skip('read_ast_node on a real declaration', 'no in-workspace definition was found earlier');
  }

  // --- metavariable queries route through `search` automatically -----------
  const routed = await client.callTool('search', { query: A.pattern, lang: A.lang, max_results: 5 });
  check('search auto-routes a metavariable query to the structural tier',
    typeof routed.source === 'string' && routed.source.includes('tree-sitter'),
    `source=${routed.source}`);

  const explicit = await client.callTool('search', {
    query: A.pattern, lang: A.lang, mode: 'structural', max_results: 5,
  });
  check("search mode:'structural' reaches the same tier",
    typeof explicit.source === 'string' && explicit.source.includes('tree-sitter'),
    `source=${explicit.source}`);

  // --- overlay-only file: never on the host tree, still analysable ---------
  const rel = A.probe.file;
  const abs = path.join(workspace, rel);
  const w = await client.callTool('sandbox_write_file', { path: rel, content: A.probe.code });
  check('overlay write ok', w.success === true, JSON.stringify(w)?.slice(0, 150));
  check('probe file is overlay-only (absent on host disk)', !fs.existsSync(abs),
    `${abs} leaked to the host tree!`);

  const overlayNode = await client.callTool('read_ast_node', { file_path: rel, name: A.probe.name });
  const on = overlayNode?.nodes?.[0];
  check('read_ast_node reads the OVERLAY, not the host tree', !!on,
    rawText(overlayNode).slice(0, 200));
  if (on) {
    check('overlay node source contains the declaration',
      typeof on.code === 'string' && on.code.includes(A.probe.name),
      String(on.code).slice(0, 120));
  }

  const overlayPattern = await client.callTool('search_ast', {
    pattern: A.probe.name + '($$$)', lang: A.lang, file_path: rel,
  });
  soft('search_ast file_path search also reads the overlay',
    overlayPattern.isError !== true, rawText(overlayPattern).slice(0, 150));

  await client.callTool('sandbox_exec', { command: `rm -f -- '${rel}'` }).catch(() => {});
}

async function fullSuite(client, workspace, preset) {
  const P = PRESETS[preset];

  // --- handshake ------------------------------------------------------------
  section('MCP handshake (code intelligence via merged sandbox server)');
  const init = await client.rpc('initialize', {
    protocolVersion: '2024-11-05',
    clientInfo: { name: 'test-lsp-gateway', version: '1.0.0' },
    capabilities: {},
  });
  // Code intelligence is served through the merged sandbox server now.
  check('initialize', init?.serverInfo?.name === 'koi-sandbox-shell', JSON.stringify(init?.serverInfo));

  const toolList = await client.rpc('tools/list', {});
  const toolNames = (toolList?.tools || []).map((t) => t.name);
  console.log(`  tools: ${toolNames.join(', ')}`);
  for (const t of ['search', 'get_references', 'get_hover', 'get_implementation', 'get_file_structure', 'get_lsp_diagnostics']) {
    check(`tools/list includes ${t} (forwarded from lsp_search)`, toolNames.includes(t));
  }
  for (const t of ['search_ast', 'read_ast_node']) {
    check(`tools/list includes ${t} (structural tier)`, toolNames.includes(t));
  }
  check('sandbox_open_project present (drives the LSP workspace)', toolNames.includes('sandbox_open_project'));
  check('set_workspace hidden (open_project drives it)', !toolNames.includes('set_workspace'));
  check('search_and_replace absent (SEARCH_MCP_READONLY)', !toolNames.includes('search_and_replace'));

  // --- open the project (drives the LSP workspace automatically) ------------
  // The merged server points code intelligence at the project when it is
  // opened; there is no separate set_workspace call for the LLM to make.
  section('sandbox_open_project (sets the LSP workspace)');
  const sw = await client.callTool('sandbox_open_project', { path: workspace });
  check('project opened', sw.success === true && sw.project === workspace, JSON.stringify(sw));
  check('code intelligence reported', sw.codeIntelligence !== undefined, JSON.stringify(sw.codeIntelligence));
  const swAgain = await client.callTool('sandbox_open_project', { path: workspace });
  check('re-open same project succeeds (overlay reused)', swAgain.success === true, JSON.stringify(swAgain));
  const swBad = await client.callTool('sandbox_open_project', { path: path.join(workspace, 'no-such-dir-xyz') });
  check('bad path rejected', swBad.success === false, JSON.stringify(swBad));

  if (WARMUP_MS > 0) {
    console.log(`  waiting ${WARMUP_MS}ms for LSP warmup...`);
    await new Promise((r) => setTimeout(r, WARMUP_MS));
  }

  // --- symbol search (LSP workspace/symbol) ---------------------------------
  section(`symbol search (${preset} preset)`);
  // LSP servers legitimately return definitions OUTSIDE the workspace (e.g.
  // "Context" in a Go project resolves to context.Context in GOROOT; C hits
  // land in /usr/include). get_references/get_hover accept those, but
  // get_file_structure/get_lsp_diagnostics validate paths against the
  // workspace and reject them — so prefer an in-workspace definition for the
  // dependent tests.
  const inWs = (fp) => {
    if (typeof fp !== 'string' || !fp) return false;
    const abs = path.isAbsolute(fp) ? path.normalize(fp) : path.join(workspace, fp);
    return abs === workspace || abs.startsWith(workspace + path.sep);
  };
  let firstDef = null;      // first hit inside the workspace (preferred)
  let firstAnyDef = null;   // first hit anywhere (fallback for refs/hover)
  let firstDefSymbol = null; // the query that produced firstDef (read_ast_node needs a name)
  let firstDefSource = null; // which tier answered: lsp | tree-sitter | text
  for (const sym of P.symbols) {
    const res = await searchWithRetry(client, sym);
    const hit = !!res?.results?.length;
    check(`search "${sym}" finds results`, hit, JSON.stringify(res)?.slice(0, 200));
    if (hit) {
      if (!firstAnyDef) firstAnyDef = res.results[0];
      if (!firstDef) {
        firstDef = res.results.find((r) => inWs(r.file_path)) ?? null;
        if (firstDef) {
          firstDefSymbol = firstDef.symbol_name || sym;
          firstDefSource = res.source ?? 'unknown';
        }
      }
    }
  }
  const defOutsideWs = !firstDef && !!firstAnyDef;
  if (defOutsideWs) {
    console.log('  ○ all definitions resolve outside the workspace (stdlib/deps) — using one for refs/hover; structure/diagnostics will be skipped');
    firstDef = firstAnyDef;
  }

  if (firstDef) {
    // Which tier answered decides what the result MEANS: `lsp` and
    // `tree-sitter` give declarations, `text` gives occurrences. Several
    // checks below are only meaningful for the former.
    console.log(`  first def: ${firstDef.file_path}:${firstDef.line}:${firstDef.column}  (via ${firstDefSource})`);
    if (firstDefSource === 'text') {
      console.log('  ○ answered by the TEXT tier — no language server produced a symbol for this workspace');
    }

    // --- get_references -----------------------------------------------------
    section('get_references');
    const refs = await client.callTool('get_references', {
      file_path: firstDef.file_path, line: firstDef.line, column: firstDef.column,
    });
    if (lspUnavailable(refs)) skip('references found', lspRemedy(preset));
    else check('references found', !!refs?.references?.length, JSON.stringify(refs)?.slice(0, 200));

    // --- get_hover ----------------------------------------------------------
    section('get_hover');
    const hover = await client.callTool('get_hover', {
      file_path: firstDef.file_path, line: firstDef.line, column: firstDef.column,
    });
    if (lspUnavailable(hover)) skip('hover documentation present', lspRemedy(preset));
    else check('hover documentation present', !!hover?.documentation, JSON.stringify(hover)?.slice(0, 200));

    // --- get_implementation (soft: concrete types have none) ----------------
    section('get_implementation');
    const impls = await client.callTool('get_implementation', {
      file_path: firstDef.file_path, line: firstDef.line, column: firstDef.column,
    });
    if (impls?.implementations?.length) {
      check(`implementations found (${impls.total_count})`, true);
    } else {
      console.log('  ○ no implementations (may be a concrete type) — not counted as failure');
    }

    // --- get_file_structure / get_lsp_diagnostics ---------------------------
    // These validate the path against the workspace, so only meaningful for
    // in-workspace files.
    if (!defOutsideWs) {
      section('get_file_structure');
      const struct = await client.callTool('get_file_structure', { file_path: firstDef.file_path });
      check('file structure returned', struct.isError !== true, JSON.stringify(struct)?.slice(0, 200));

      section('get_lsp_diagnostics');
      const diag = await client.callTool('get_lsp_diagnostics', { file_path: firstDef.file_path });
      check('diagnostics responds', diag.isError !== true && typeof diag.backend === 'string',
        JSON.stringify(diag)?.slice(0, 200));
      console.log(`  backend=${diag.backend} count=${diag.total_count}`);
    } else {
      section('get_file_structure / get_lsp_diagnostics');
      console.log('  ○ skipped: definition is outside the workspace (server validates paths to the workspace root)');
    }
  } else {
    failed++;
    console.log('  ❌ no definition found — skipping dependent tests');
  }

  // --- text search fallback -------------------------------------------------
  section('text search (ripgrep fallback)');
  const todo = await client.callTool('search', { query: 'TODO' });
  check('text search responds', todo.isError !== true);

  // --- two-phase workflow ---------------------------------------------------
  section('two-phase workflow (search → hover)');
  const wf = await searchWithRetry(client, P.workflow, { tries: 2 });
  if (wf?.results?.length) {
    const d = wf.results[0];
    const h = await client.callTool('get_hover', { file_path: d.file_path, line: d.line, column: d.column });
    if (lspUnavailable(h)) skip(`search "${P.workflow}" → hover succeeded`, lspRemedy(preset));
    else check(`search "${P.workflow}" → hover succeeded`, !!h?.documentation);
  } else {
    console.log(`  ○ "${P.workflow}" not found in this workspace — workflow test skipped`);
  }

  // --- negative test --------------------------------------------------------
  section('negative test');
  const bogus = 'NonExistentSymbol12345XYZ';
  const none = await client.callTool('search', { query: bogus });
  const hits = none?.results ?? [];
  // LSP workspace/symbol is a FUZZY search in rust-analyzer, pylsp and others:
  // a long CamelCase query can subsequence-match real symbols, so a non-empty
  // result set is not by itself wrong. What must never happen is a result that
  // claims to BE the bogus symbol.
  const exact = hits.filter((r) => r.symbol_name === bogus);
  check('bogus symbol produces no exact match', exact.length === 0, JSON.stringify(exact).slice(0, 200));
  if (hits.length) {
    console.log(`  ○ ${hits.length} fuzzy hit(s) from the ${none.source} tier — expected for LSP workspace/symbol`);
  }
  // --- structural / tree-sitter tier ----------------------------------------
  await treeSitterSuite(client, workspace, preset, firstDef, firstDefSymbol, firstDefSource);

  // --- editor-style LSP sync (Design 2) -------------------------------------
  await documentSyncSuite(client, workspace, preset);

  // --- summary --------------------------------------------------------------
  section('RESULT');
  console.log(`  ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  console.log(failed === 0
    ? '  🎉 lsp_search is fully operational through the gateway.'
    : '  ⚠️ Some checks failed — see above.');
  if (skipped) {
    console.log('  ⊘ Skips are optional host backends, not defects — see the header for install commands.');
  }
  return failed === 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const workspace = argv[0] ? path.resolve(argv[0]) : null;
  if (!workspace || !fs.existsSync(workspace)) {
    console.error('Usage: node test-lsp-gateway.mjs <workspace> [go|rust|ts|c | search <query> | ast <pattern> | --symbols a,b]');
    process.exit(1);
  }

  let preset = detectPreset(workspace);
  let adhocSearch = null;
  let adhocAst = null;
  for (let i = 1; i < argv.length; i++) {
    if (PRESETS[argv[i]]) preset = argv[i];
    else if (argv[i] === 'search' && argv[i + 1]) adhocSearch = argv[++i];
    else if (argv[i] === 'ast' && argv[i + 1]) adhocAst = argv[++i];
    else if (argv[i] === '--symbols' && argv[i + 1]) {
      PRESETS[preset] = { ...PRESETS[preset], symbols: argv[++i].split(',') };
    }
  }

  console.log(`Connecting to ${GATEWAY_URL}/mcp/${SERVER_NAME} ...`);
  const client = new GatewayClient(GATEWAY_URL, SERVER_NAME);
  try {
    await client.connect();
  } catch (e) {
    console.error(`\n❌ Cannot connect: ${e.message}`);
    console.error('   Is the gateway running?  node koi-gateway.js --config gateway-config.json');
    process.exit(1);
  }
  console.log(`Connected & authenticated. workspace=${workspace} preset=${preset}\n`);

  let ok = true;
  try {
    if (adhocSearch || adhocAst) {
      await client.rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 't', version: '1' }, capabilities: {} });
      show(await client.callTool('sandbox_open_project', { path: workspace }));
      if (adhocSearch) show(await client.callTool('search', { query: adhocSearch }), 20_000);
      if (adhocAst) {
        show(await client.callTool('search_ast', { pattern: adhocAst, lang: PRESETS[preset].ast.lang }), 20_000);
      }
    } else {
      ok = await fullSuite(client, workspace, preset);
    }
  } catch (e) {
    console.error(`\n❌ Test run failed: ${e.message}`);
    ok = false;
  } finally {
    client.close();
  }
  process.exit(ok ? 0 : 1);
}

main();
