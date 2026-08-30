// packages/chrome-extension/skills/sandbox-shell/scripts/network-policy-test.js
//
// Interactive end-to-end check of sandbox egress filtering, run from the Koi
// input box:
//
//     /skill sandbox-shell/scripts/network-policy-test.js
//     /skill sandbox-shell/scripts/network-policy-test.js --quick
//
// The host-side `test-network-approval.mjs` proves the machinery works with a
// scripted answer. This proves the part that one cannot: that a real approval
// dialog appears in YOUR side panel, that clicking it actually releases a
// parked connection, and that the enforcement layer is really on — a curl to a
// non-allowlisted host has to FAIL when you deny it, which no amount of
// unit-testing the policy engine can tell you.
//
// Do NOT run it with --full-auto: step 4 exists precisely to make a dialog
// appear, and full-auto is the mode where nothing prompts.

const QUICK = (typeof args !== "undefined" ? args : []).includes("--quick");

// Hosts. The unknown one is under a domain reserved by RFC 2606 for exactly
// this, so it can never collide with something the user has allowed, and it
// does not resolve — which is fine, because a policy denial happens at the
// proxy BEFORE any name lookup. A refused request therefore proves the policy
// fired; a DNS error proves it did not.
const ALLOWED_HOST = "registry.npmjs.org";
const UNKNOWN_HOST = "koi-network-test.invalid";
const DENIED_HOST = "169.254.169.254"; // cloud metadata; denied in the shipped list

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** MCP results arrive as {content:[{text}]} here and as a bare string elsewhere. */
function textOf(res) {
  if (res === null || res === undefined) return "";
  if (typeof res === "string") return res;
  if (typeof res.content === "string") return res.content;
  if (Array.isArray(res.content)) {
    return res.content.map((c) => c.text ?? "").join("");
  }
  return JSON.stringify(res);
}

function jsonOf(res) {
  try {
    return JSON.parse(textOf(res));
  } catch {
    return null;
  }
}

/**
 * curl with a short timeout, printing a stable marker. --proxy is NOT passed:
 * the point is to check what the sandbox's own environment does, which is what
 * a real build would hit.
 */
async function probe(host, timeoutMs = 65000) {
  const res = await tools.sandbox_exec({
    command:
      `curl -sS -o /dev/null -m 60 -w 'HTTP:%{http_code}' https://${host}/ ` +
      `2>&1; echo " EXIT:$?"`,
    timeout_ms: timeoutMs,
  });
  const out = textOf(res);
  const body = jsonOf(res);
  const combined = body ? `${body.stdout ?? ""}${body.stderr ?? ""}` : out;
  const exit = /EXIT:(\d+)/.exec(combined);
  return {
    raw: combined.trim(),
    exitCode: exit ? Number(exit[1]) : null,
    reachable: /HTTP:[23]\d\d/.test(combined),
    blocked: /403|[Ff]orbidden|network policy|denied by user|approval/.test(combined),
    // curl 5/7 against the proxy address itself: the request never reached the
    // policy at all. Distinguishing this matters more than anything else in
    // this file — an unreachable proxy makes EVERY probe fail, which looks
    // exactly like a working default-deny and turns the whole suite green
    // while nothing is being enforced.
    proxyDown: /Failed to connect to .* port|Could not resolve proxy|proxy CONNECT aborted/i.test(combined),
    // `curl: (56) Received HTTP code N from proxy after CONNECT` is how a
    // refusal of a TLS tunnel looks from inside: curl cannot show a body, only
    // the status. The status is the whole diagnosis, so keep it.
    proxyStatus: (() => {
      const m = /HTTP code (\d{3}) from proxy/i.exec(combined) ?? /HTTP:(\d{3})/.exec(combined);
      return m ? Number(m[1]) : null;
    })(),
  };
}

/**
 * Did the PROXY refuse this, and does the code mean a policy decision?
 *
 * 403 is the policy speaking. 5xx is the proxy failing to get an answer — the
 * request never got a verdict, so counting it as "blocked" would report a
 * broken approval path as a working one. That distinction is the difference
 * between this suite being a security check and being decoration.
 */
function classify(probe) {
  if (probe.proxyDown) {
    return { refused: false, why: "the proxy was unreachable — not a policy decision" };
  }
  if (probe.proxyStatus === 403) {
    return { refused: true, why: "403 from the policy" };
  }
  if (probe.proxyStatus !== null && probe.proxyStatus >= 500) {
    return {
      refused: false,
      why:
        `HTTP ${probe.proxyStatus} from the proxy: it gave up waiting for the ` +
        "policy helper instead of getting a decision. Check: " +
        "journalctl --user -u koi-egress -n 30",
    };
  }
  if (probe.reachable) return { refused: false, why: "the request succeeded" };
  return { refused: false, why: probe.raw.slice(0, 120) };
}

/**
 * Is the proxy the sandbox has been told to use actually answering? Runs first,
 * because if it is not, every later "blocked" result is meaningless.
 */
async function proxyReachable() {
  const res = await tools.sandbox_exec({
    command:
      'echo "proxy=${HTTPS_PROXY:-unset}"; ' +
      'curl -sS -o /dev/null -m 10 -w "HTTP:%{http_code}" ' +
      'http://169.254.169.254/ 2>&1; echo " EXIT:$?"',
    timeout_ms: 30000,
  });
  const body = jsonOf(res);
  const raw = (body ? `${body.stdout ?? ""}${body.stderr ?? ""}` : textOf(res)).trim();
  return {
    raw,
    proxySet: /proxy=http/.test(raw),
    // A denied host is the cheapest positive signal: only a live squid running
    // a live policy helper produces 403 here.
    answering: /HTTP:403/.test(raw),
  };
}

async function run() {
  console.log("Sandbox network policy — interactive test\n");

  // -- 1. Is filtering even on? ---------------------------------------------
  const info = jsonOf(await tools.sandbox_info({}));
  const mode = info?.network ?? "unknown";
  console.log(`Sandbox network mode: ${mode}`);

  if (mode !== "policy") {
    record("egress filtering enabled", false, `--net ${mode}`);
    console.log(
      "\nNothing else in this test is meaningful while egress is unfiltered.\n" +
        "Turn it on with:  ./koi-gateway-installer network on\n" +
        "(that also checks for pasta / nftables / squid and starts the proxy).",
    );
    return summary();
  }
  record("egress filtering enabled", true, "--net policy");

  if (info?.notes?.some((n) => String(n).startsWith("TEST MODE"))) {
    record(
      "enforcement is real",
      false,
      "server is running with KOI_NET_TEST=1 — prompts work but NOTHING is confined",
    );
  } else {
    record("enforcement is real", true, "no test-mode banner");
  }

  // -- 2. Policy is readable and populated ----------------------------------
  let policy = null;
  try {
    policy = jsonOf(await tools.sandbox_network_policy({}));
  } catch (e) {
    // The tool is only present once it is added to allowed-tools in SKILL.md.
    record("sandbox_network_policy available", false, String(e?.message ?? e));
  }
  if (policy !== null) {
    const allowed = policy.allowed ?? [];
    const denied = policy.denied ?? [];
    record(
      "policy has an allowlist",
      allowed.length > 0,
      `${allowed.length} allowed, ${denied.length} denied, unmatched: ${policy.unmatched}`,
    );
    console.log(`  allowed: ${allowed.slice(0, 8).join(", ")}${allowed.length > 8 ? ", ..." : ""}`);
    console.log(`  denied:  ${denied.join(", ") || "none"}`);
  }

  // -- 2b. Is the proxy actually there? -------------------------------------
  const proxy = await proxyReachable();
  record(
    "sandbox has a proxy configured",
    proxy.proxySet,
    proxy.raw.split("\n")[0],
  );
  record("proxy answers and applies policy", proxy.answering, proxy.raw.replace(/\n/g, " ").slice(0, 160));
  if (!proxy.answering) {
    console.log(
      "\nThe sandbox cannot reach its egress proxy, so nothing below would be" +
        "\nmeaningful — every request would fail and look like a policy block." +
        "\n\nCheck:  systemctl --user status koi-egress" +
        "\n        journalctl --user -u koi-egress -n 30" +
        "\nThen:   ./koi-gateway-installer network on   (re-runs the whole setup)",
    );
    return summary();
  }

  // -- 3. Allowlisted host: no prompt, works --------------------------------
  console.log(`\nReaching ${ALLOWED_HOST} (allowlisted — you should NOT be asked)...`);
  const allowedProbe = await probe(ALLOWED_HOST);
  record(
    "allowlisted host passes without a prompt",
    allowedProbe.reachable,
    allowedProbe.raw.slice(0, 120),
  );

  // -- 4. Standing deny: blocked, still no prompt ---------------------------
  console.log(`\nReaching ${DENIED_HOST} (standing deny — you should NOT be asked)...`);
  const deniedProbe = await probe(DENIED_HOST, 20000);
  const deniedVerdict = classify(deniedProbe);
  record("explicitly denied host is blocked", deniedVerdict.refused, deniedVerdict.why);

  if (QUICK) {
    console.log("\n--quick: skipping the interactive approval steps.");
    return summary();
  }

  // -- 5. Unknown host, DENY -------------------------------------------------
  console.log(
    `\n>>> A dialog should now appear for ${UNKNOWN_HOST}.` +
      `\n>>> Click DENY. The request must fail.`,
  );
  const denyProbe = await probe(UNKNOWN_HOST, 320000);
  // One check, not two: "it failed" and "it failed for the right reason" are
  // the same question, and splitting them made a broken proxy score 1/2.
  const denyVerdict = classify(denyProbe);
  record("denying at the dialog blocks the request", denyVerdict.refused, denyVerdict.why);
  if (!denyVerdict.refused && denyProbe.proxyStatus >= 500) {
    console.log(
      "  Hint: the proxy answered before your click reached it. The prompt is\n" +
        "  still honoured — approve it and the next attempt succeeds. If this is\n" +
        "  routine, raise the hold time: koi-net-acl.mjs --timeout-ms.",
    );
  }

  // -- 6. Unknown host, ALLOW ONCE ------------------------------------------
  console.log(
    `\n>>> A dialog should appear again for ${UNKNOWN_HOST}` +
      ` (a denial is not remembered unless you chose "always").` +
      `\n>>> Click ALLOW ONCE. The host does not resolve, so the request will` +
      `\n>>> still fail — but it should fail with a DNS/connection error from` +
      `\n>>> the far side, NOT with a policy refusal.`,
  );
  const allowProbe = await probe(UNKNOWN_HOST, 320000);
  // .invalid never resolves, so success here is a DNS/connect failure REPORTED
  // BY THE FAR SIDE (503 from the proxy, or a resolution error) rather than a
  // 403. A 403 would mean the approval never took effect.
  record(
    "allowing at the dialog releases the request to the proxy",
    !allowProbe.proxyDown && allowProbe.proxyStatus !== 403,
    allowProbe.proxyStatus === 403
      ? "still 403 — the approval did not reach the policy"
      : classify(allowProbe).why,
  );

  // -- 7. "once" really means once ------------------------------------------
  console.log(
    `\n>>> One more dialog for ${UNKNOWN_HOST} should appear, proving "allow` +
      `\n>>> once" granted nothing durable. Answer it either way.`,
  );
  await probe(UNKNOWN_HOST, 320000);
  console.log(
    "(If no dialog appeared that time, a session or always grant is in effect —" +
      " check ~/.koi/network-policy.json.)",
  );

  return summary();
}

function summary() {
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed.`,
  );
  if (failed.length > 0) {
    console.log("Failed: " + failed.map((r) => r.name).join("; "));
  }
  return {
    passed: results.length - failed.length,
    total: results.length,
    failures: failed.map((r) => ({ name: r.name, detail: r.detail })),
  };
}

return run();
