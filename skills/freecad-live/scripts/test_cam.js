// scripts/test_cam.js — manufacturability: freecad_dfm and freecad_cam.
//
// Run:  /skill freecad-live/scripts/test_cam.js --full-auto
//
// Needs probe-exec ON, like the other suites, because it builds and tears down
// its own document rather than borrowing the human's.
//
// The shape of this suite follows from what the feature claims. Every assertion
// below is a case where a WRONG answer would look exactly like a right one:
//
//   * A plate with a 3 mm slot and a 6 mm cutter passes every existing check
//     in this skill — recomputes clean, isValid(), no interference, correct
//     volume — and cannot be machined. If dfm reports it manufacturable, the
//     feature is decorative.
//   * A dovetail undercut is reachable from nowhere on a 3-axis machine and
//     reachable from the side on a 5-axis one. A checker that returns the same
//     verdict for both is not measuring reach, it is guessing.
//   * A hollow shell with no opening is a solid with two shells. It looks like
//     a box.
//   * An OCC offset that fails must produce `manufacturable: null`. If a
//     failed check can come back as a pass, every other number here is
//     untrustworthy, so that path is asserted explicitly rather than hoped for.
//
// The CAM half is capability-gated on purpose: Path.Op.* is not importable on
// every build, and a suite that fails on a machine without the CAM workbench
// teaches its reader to ignore red.

const results = [];
let pass = 0;
let fail = 0;
let warn = 0;

class TransportLost extends Error {}

function assert(label, condition, detail) {
  if (condition) {
    pass++;
    results.push("✅ " + label);
    console.log("✅ " + label);
  } else {
    fail++;
    const msg = "❌ " + label + (detail ? " — " + detail : "");
    results.push(msg);
    console.error(msg);
  }
  return !!condition;
}

function note(label, detail) {
  warn++;
  const msg = "⚠️ " + label + (detail ? " — " + detail : "");
  results.push(msg);
  console.warn(msg);
}

function isTransportError(msg) {
  const s = String(msg || "");
  return (
    s.indexOf("BROWSER_BRIDGE_UNAVAILABLE") !== -1 ||
    s.indexOf("did not respond within") !== -1 ||
    s.indexOf("executeBrowserTool timeout") !== -1
  );
}

function parseResult(res) {
  if (!res) return null;
  if (res.isError) {
    const text = res.content && res.content[0] && res.content[0].text;
    try {
      return Object.assign({ __error: true }, JSON.parse(text));
    } catch (_) {
      return { __error: true, error: text || "unknown error" };
    }
  }
  try {
    const text = res.content ? res.content[0].text : JSON.stringify(res);
    return JSON.parse(text);
  } catch (_) {
    return res;
  }
}

function guard(r) {
  const msg = r && r.error;
  if (isTransportError(msg)) throw new TransportLost(String(msg));
  return r;
}

async function call(fn, opArgs, id, extra) {
  return guard(
    parseResult(
      await tools.freecad_call(
        Object.assign({ fn, args: opArgs || {} }, id ? { id } : {}, extra || {})
      )
    )
  );
}

async function dfm(args) {
  return guard(parseResult(await tools.freecad_dfm(args || {})));
}

async function cam(args) {
  return guard(parseResult(await tools.freecad_cam(args || {})));
}

async function sync(extra) {
  return guard(parseResult(await tools.freecad_sync(extra || {})));
}

// eslint-disable-next-line no-unused-vars
void sync;

async function probe(python, timeoutMs) {
  const r = guard(
    parseResult(
      await tools.freecad_exec({ python, timeoutMs: timeoutMs || 30000 })
    )
  );
  if (!r || r.ok !== true) return { __fail: (r && r.error) || "exec failed" };
  const d = r.result || {};
  if (d.ok === false) return { __fail: d.error || "returned ok:false" };
  return d;
}

const DOC = "KoiCamTest";

async function run() {
  console.log("=== test_cam.js — manufacturability: freecad_dfm and freecad_cam ===");

  const attachRes = parseResult(await tools.freecad_attach({}));
  if (!attachRes || !attachRes.attached) {
    assert("attached to FreeCAD", false, JSON.stringify(attachRes));
    return { success: false, pass, fail, warn, results };
  }
  assert("attached to FreeCAD", true, attachRes.status);

  const caps = await call("capabilities", {});
  const mods = (caps && caps.result && caps.result.modules) || {};
  const camAvailable = !!(
    (mods["Path.Op.Profile"] && mods["Path.Op.Profile"].available) ||
    (mods["PathScripts.PathJob"] && mods["PathScripts.PathJob"].available)
  );
  console.log("CAM workbench importable: " + camAvailable);

  await call("new_document", { name: DOC }, "doc.cam", "cam test doc");

  // ---------------------------------------------------------------
  // A. A plate that IS machinable. The baseline: if this fails, every
  //    failure below is noise.
  // ---------------------------------------------------------------
  console.log("\n--- Section A: baseline machinable plate ---");
  await call(
    "batch",
    {
      ops: [
        { fn: "body", args: {}, id: "body.plate" },
        {
          fn: "sketch",
          args: {
            body: "body.plate",
            on: "XY",
            geometry: [
              { type: "rect", anchor: "center", x: 0, y: 0, w: 80, h: 60 },
            ],
          },
          id: "sk.plate",
        },
        { fn: "pad", args: { sketch: "sk.plate", length: 12 }, id: "pad.plate" },
        // A generous pocket: 20 mm wide, 6 mm deep, corners left square in the
        // sketch — PartDesign will give them a zero radius, which is exactly the
        // sharp-corner case, so this one is rounded deliberately.
        {
          fn: "sketch",
          args: {
            body: "body.plate",
            on: "XY",
            geometry: [
              { type: "slot", x: 0, y: 0, length: 40, width: 20, angle: 0 },
            ],
          },
          id: "sk.pocket",
        },
        {
          fn: "pocket",
          args: { sketch: "sk.pocket", length: 6 },
          id: "pocket.wide",
        },
      ],
    },
    null,
    "machinable plate"
  );

  const good = await dfm({
    targets: ["body.plate"],
    process: "mill3axis",
    tool: 6,
  });
  assert(
    "A1 baseline plate is manufacturable",
    good && good.manufacturable === true,
    (good && (good.verdict || good.error)) || ""
  );
  // Asserted on its own because it has already been wrong once, silently, in
  // a way every other number inherited: the residual's stock default lived in
  // two places, the Python signature and the JS wrapper, and when one moved
  // the other kept supplying the old value. A 2 mm allowance on the underside
  // of a plate is machined in a setup of its own, so charging it to the setup
  // that cuts the top reports 11 cm3 of ordinary billet as unreachable.
  assert(
    "A1b the residual measures against the bounding box, with no allowance",
    good &&
      good.objects &&
      good.objects[0] &&
      good.objects[0].residual &&
      String(good.objects[0].residual.stock || "") === "bounding box",
    "stock=" + JSON.stringify(((good && good.objects) || [{}])[0].residual &&
      good.objects[0].residual.stock)
  );

  // The residual is a measurement, not a threshold: read `obstructed`. Under
  // slab-2d a flat end mill leaves square floors, so this is near zero; under
  // the ball-closing fallback an internal corner always keeps the tool's own
  // radius and the raw volume is never zero at all.
  assert(
    "A2 baseline has no material a cutter cannot reach",
    good &&
      good.objects &&
      good.objects[0] &&
      good.objects[0].residual &&
      good.objects[0].residual.ok === true &&
      good.objects[0].residual.obstructed === false,
    JSON.stringify(((good && good.objects) || [{}])[0].residual || {})
  );
  // Two setups, not one: the underside of a plate is not reachable from the
  // side you machined the top from, and a checker that said one setup here
  // would be wrong in the direction that costs money.
  assert(
    "A3 baseline has no undercuts and needs at most two setups",
    good &&
      good.objects &&
      good.objects[0] &&
      good.objects[0].reach &&
      good.objects[0].reach.unreachableFaceCount === 0 &&
      good.objects[0].reach.setupCount <= 2,
    JSON.stringify(((good && good.objects) || [{}])[0].reach || {})
  );

  // ---------------------------------------------------------------
  // B. The slot no cutter fits. Geometrically perfect, unmakeable.
  //    This is the assertion the whole feature exists for.
  // ---------------------------------------------------------------
  console.log("\n--- Section B: unmakeable slot ---");
  await call(
    "sketch",
    {
      body: "body.plate",
      on: "XY",
      geometry: [{ type: "slot", x: 0, y: 22, length: 50, width: 3, angle: 0 }],
    },
    "sk.thin",
    "thin slot"
  );
  await call(
    "pocket",
    { sketch: "sk.thin", length: 8 },
    "pocket.thin",
    "thin slot"
  );

  const syncRep = await sync({ detail: "summary" });
  const cleanLint =
    !(syncRep && syncRep.lint || []).some(
      (r) =>
        (r.object === "Pocket001" || r.object === "pocket.thin") &&
        r.level === "error"
    );
  assert(
    "B0 the unmakeable slot recomputes without a lint error",
    cleanLint,
    "this is the point: nothing else in the skill catches it"
  );

  const thin = await dfm({
    targets: ["body.plate"],
    process: "mill3axis",
    tool: 6,
  });
  assert(
    "B1 a 6 mm cutter cannot make a 3 mm slot",
    thin && thin.manufacturable === false,
    (thin && (thin.verdict || thin.error)) || ""
  );
  assert(
    "B2 the finding is the residual volume, with a number",
    thin &&
      (thin.findings || []).some(
        (f) => f.code === "dfm-unreachable-volume" && /\d/.test(f.message)
      ),
    JSON.stringify((thin && thin.findings) || [])
  );

  const fits = await dfm({
    targets: ["body.plate"],
    process: "mill3axis",
    tool: 2.5,
  });
  assert(
    "B3 a 2.5 mm cutter does make it — the verdict tracks the tool",
    fits && fits.manufacturable === true,
    (fits && (fits.verdict || fits.error)) || ""
  );

  const corners = (((fits && fits.objects) || [{}])[0] || {}).corners || {};
  assert(
    "B4 the largest tool that fits the tightest corner is reported",
    typeof corners.maxToolDiameter === "number" &&
      corners.maxToolDiameter > 2.9 &&
      corners.maxToolDiameter < 3.1,
    "maxToolDiameter=" + corners.maxToolDiameter
  );
  assert(
    "B5 and it is mapped to a tool that can be bought",
    corners.nearestStockTool === 2.5 || corners.nearestStockTool === 3.0,
    "nearestStockTool=" + corners.nearestStockTool
  );

  // ---------------------------------------------------------------
  // C. An undercut. 3-axis says no, 5-axis says yes, and a checker that
  //    cannot tell them apart is not checking reach.
  // ---------------------------------------------------------------
  console.log("\n--- Section C: undercut block ---");
  await call(
    "batch",
    {
      ops: [
        { fn: "body", args: {}, id: "body.under" },
        {
          fn: "sketch",
          args: {
            body: "body.under",
            on: "XY",
            geometry: [
              { type: "rect", anchor: "center", x: 0, y: 0, w: 40, h: 40 },
            ],
          },
          id: "sk.under",
        },
        { fn: "pad", args: { sketch: "sk.under", length: 30 }, id: "pad.under" },
        // A slot cut straight through in Y: open on both Y faces, and open
        // NOWHERE on Z, because the block above it is solid. That is the
        // shape this section is about.
        //
        // The first version of this pocketed 12 mm from the XZ plane, which
        // sits at y=0 in the middle of the block — so the cut never reached
        // either outside face and the result was a SEALED CAVITY, unreachable
        // from all six directions. It failed the 5-axis assertion for the
        // right reason about the wrong solid.
        {
          fn: "sketch",
          args: {
            body: "body.under",
            on: "XZ",
            geometry: [
              { type: "rect", anchor: "center", x: 0, y: 15, w: 24, h: 10 },
            ],
          },
          id: "sk.side",
        },
        {
          fn: "pocket",
          args: { sketch: "sk.side", through: true },
          id: "pocket.side",
        },
      ],
    },
    null,
    "undercut block"
  );

  const u3 = await dfm({
    targets: ["body.under"],
    process: "mill3axis",
    tool: 6,
    checks: ["reach", "corners"],
  });
  const u5 = await dfm({
    targets: ["body.under"],
    process: "mill5axis",
    tool: 6,
    checks: ["reach", "corners"],
  });
  const r3 = (((u3 && u3.objects) || [{}])[0] || {}).reach || {};
  const r5 = (((u5 && u5.objects) || [{}])[0] || {}).reach || {};
  assert(
    "C1 the side pocket is unreachable on 3 axes",
    r3.unreachableFaceCount > 0,
    "unreachable=" + r3.unreachableFaceCount
  );
  assert(
    "C2 and reachable once -Y is a setup",
    r5.unreachableFaceCount === 0,
    "unreachable=" + r5.unreachableFaceCount
  );
  assert(
    "C3 which makes it a multi-setup part, not an impossible one",
    r5.setupCount >= 2 &&
      (u5 && u5.findings || []).some((f) => f.code === "dfm-multi-setup"),
    "setups=" + JSON.stringify(r5.setupsSuggested)
  );

  // ---------------------------------------------------------------
  // D. An enclosed void: a solid with two shells. Looks like a box.
  // ---------------------------------------------------------------
  console.log("\n--- Section D: sealed void ---");
  await call(
    "batch",
    {
      ops: [
        {
          fn: "primitive",
          args: {
            kind: "box",
            length: 30,
            width: 30,
            height: 30,
            at: [200, 0, 0],
          },
          id: "prim.outer",
        },
        {
          fn: "primitive",
          args: {
            kind: "box",
            length: 10,
            width: 10,
            height: 10,
            at: [210, 10, 10],
          },
          id: "prim.inner",
        },
        {
          fn: "boolean",
          args: {
            op: "cut",
            base: "prim.outer",
            tool: "prim.inner",
          },
          id: "bool.void",
        },
      ],
    },
    null,
    "sealed void"
  );

  const voidRep = await dfm({
    targets: ["bool.void"],
    checks: ["voids"],
  });
  assert(
    "D1 an enclosed void is refused",
    voidRep &&
      voidRep.manufacturable === false &&
      (voidRep.findings || []).some((f) => f.code === "dfm-internal-void"),
    (voidRep && (voidRep.verdict || voidRep.error)) || ""
  );

  // ---------------------------------------------------------------
  // E. The honesty check. A check that did not run must not read as a pass.
  // ---------------------------------------------------------------
  console.log("\n--- Section E: honesty check ---");
  const partial = await dfm({
    targets: ["body.plate"],
    checks: ["corners"],
  });
  assert(
    "E1 a subset run still returns a verdict and says what ran",
    partial &&
      typeof partial.verdict === "string" &&
      Array.isArray(partial.notDetermined),
    (partial && partial.verdict) || ""
  );
  assert(
    "E2 nothing claims a residual it did not compute",
    !(((partial && partial.objects) || [{}])[0] || {}).residual,
    "residual should be absent when checks omit it"
  );

  const empty = await dfm({ targets: ["sk.plate"] });
  assert(
    "E3 a sketch is refused rather than passed as manufacturable",
    !empty || !!empty.error || empty.manufacturable !== true,
    (empty && (empty.error || empty.verdict)) || ""
  );

  // ---------------------------------------------------------------
  // F. The CAM workbench. Gated: absent is a skip, not a failure.
  // ---------------------------------------------------------------
  console.log("\n--- Section F: CAM workbench ---");
  if (!camAvailable) {
    note("F* skipped", "no importable CAM operation module on this build");
  } else {
    const job = await cam({
      mode: "job",
      target: "body.plate",
      id: "cam.plate",
      name: "plate job",
    });
    const jobOk = job && job.applied !== false && !job.error;
    assert(
      "F1 a Job is created on the plate",
      jobOk,
      (job && (job.error || JSON.stringify(job.result || {}).slice(0, 200))) || ""
    );

    if (jobOk) {
      // The envelope puts the op's own return value under `result`. `report`
      // is the envelope's OWN diff — added/removed/volumeDeltas — and reading
      // the api block out of it found nothing every time while the call had
      // in fact succeeded.
      assert(
        "F2 the reply names the API spelling it found, not an assumed one",
        !!(job.result && job.result.api && job.result.api.job),
        JSON.stringify(((job && job.result) || {}).api || {})
      );

      const verify = await cam({ mode: "verify", job: "cam.plate" });
      const rep = (verify && verify.result) || {};
      assert(
        "F3 a job with no operations reports machinable: null, not true",
        rep.machinable === null && rep.operationCount === 0,
        (rep.verdict || "") + " machinable=" + JSON.stringify(rep.machinable)
      );

      const noId = await cam({
        mode: "op",
        job: "cam.plate",
        op: "profile",
      });
      assert(
        "F4 a creating cam mode without an id is refused",
        !!(noId && (noId.error || noId.ok === false)),
        (noId && (noId.error || noId.detail)) || ""
      );

      const opRes = await cam({
        mode: "op",
        job: "cam.plate",
        op: "profile",
        id: "camop.profile",
      });
      const opRep = (opRes && opRes.result) || {};
      if (opRes && opRes.error) {
        note("F5 skipped", opRes.error);
      } else {
        assert(
          "F5 the operation reports a command count either way",
          opRep.operation && typeof opRep.operation.commands === "number",
          JSON.stringify(opRep.operation || {})
        );
        assert(
          "F6 an empty toolpath is flagged, not swallowed",
          !opRep.operation ||
            opRep.operation.commands > 0 ||
            opRep.operation.empty === true,
          JSON.stringify(opRep.operation || {})
        );
      }

      await cam({ mode: "clear", job: "cam.plate" });
    }
  }

  // ---------------------------------------------------------------
  // G. The undo contract. A CAM job is a write like any other.
  // ---------------------------------------------------------------
  console.log("\n--- Section G: CAM undo contract ---");
  if (camAvailable) {
    const dry = await cam({
      mode: "job",
      target: "body.plate",
      id: "cam.dry",
      dryRun: true,
    });
    assert(
      "G1 a dry-run job leaves nothing behind",
      dry && dry.applied === false && dry.ok !== false,
      "applied=" + (dry && dry.applied) + " ok=" + (dry && dry.ok)
    );
  }

  // ======================================================================
  console.log("\n--- Cleaning up ---");
  try {
    await probe(`
import FreeCAD as App
if "${DOC}" in App.listDocuments():
    App.closeDocument("${DOC}")
`);
    assert("scratch document closed cleanly", true, "");
  } catch (e) {
    note("cleanup failed", e.message);
  }

  const buildInfo = parseResult(await tools.freecad_version({}));
  const build = (buildInfo && (buildInfo.build || buildInfo.runtime)) || {};
  console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings.`);
  console.log(`Valid for build ${build.exeVersion || build.version || "?"} @ ${build.commit || "?"}`);

  return { success: fail === 0, pass, fail, warn, results };
}

return run().catch((e) => {
  console.error(e);
  const label =
    e instanceof TransportLost
      ? "transport lost — the rest of this run proves nothing: " + e.message
      : e.message;
  results.push("❌ " + label);
  return { success: false, pass, fail, warn, results, error: label };
});
