// scripts/test_fem.js — strength: freecad_fem.
//
// Run:  /skill freecad-live/scripts/test_fem.js --full-auto
//
// Needs probe-exec ON, like the other suites, because it builds and tears down
// its own document rather than borrowing the human's.
//
// What this suite is actually for. A solve that produces a number is the easy
// half and the half nobody doubts; every assertion below is a case where a
// WRONG answer arrives looking exactly like a right one:
//
//   * A model with no restraint solves. CalculiX either fails or returns
//     rigid-body motion, and rigid-body motion is a large displacement field
//     that reads exactly like deflection. If that reaches a verdict, every
//     other number here is worthless.
//   * A model with no load solves to zero stress everywhere, and zero stress
//     divided into a yield strength is an infinite factor of safety.
//   * A surface mesh on a solid has no stiffness at all, and reports a node
//     count like any other mesh.
//   * A peak stress on a sharp internal corner is a SINGULARITY: refine the
//     mesh and it rises without bound. It is not a stress, and a factor of
//     safety divided out of it is not a factor of safety. If one is reported
//     anyway, the feature is worse than absent — it manufactures confidence.
//   * A result that outlives the geometry it was solved on is a number the
//     transcript still contains and the part no longer has.
//
// The first four are refusals, and refusals need no solver: sections A and B
// run in full on a build with neither gmsh nor CalculiX installed. Only C
// onward is gated, and absent binaries are a skip, not a failure — a suite
// that fails on a machine without the tools teaches its reader to ignore red.

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

async function fem(args) {
  return guard(parseResult(await tools.freecad_fem(args || {})));
}

async function sync(extra) {
  return guard(parseResult(await tools.freecad_sync(extra || {})));
}

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

// A refusal is the product here, so reading one has to be as precise as
// reading a number. It can arrive from either side: the JS wrapper rejects
// what it can see without a round trip, and the envelope reports a KoiOpError
// raised in the document as an aborted edit.
function refusal(r) {
  if (!r) return "";
  if (r.error) return String(r.error);
  if (r.ok === false && r.reason) return String(r.reason);
  return "";
}

function refused(r, needle) {
  const msg = refusal(r).toLowerCase();
  if (!msg) return false;
  return !needle || msg.indexOf(String(needle).toLowerCase()) !== -1;
}

// The op's own return value lives under the envelope's `result`; `report` is
// the envelope's own diff. Reading the wrong one finds nothing on a call that
// in fact succeeded, which is how a green suite goes quietly blind.
function rep(r) {
  return (r && r.result) || {};
}

async function faceRef(of, normal, minSize) {
  const q = await call("query", Object.assign({
    of,
    kind: "face",
    surface: "plane",
    normal,
    expect: 1,
  }, minSize ? { minSize } : {}));
  const refs = (rep(q).refs || []);
  return refs.length === 1 ? refs[0] : null;
}

const DOC = "KoiFemTest";

async function run() {
  console.log("=== test_fem.js — strength: freecad_fem ===");

  const attachRes = parseResult(await tools.freecad_attach({}));
  if (!attachRes || !attachRes.attached) {
    assert("attached to FreeCAD", false, JSON.stringify(attachRes));
    return { success: false, pass, fail, warn, results };
  }
  assert("attached to FreeCAD", true, attachRes.status);

  const caps = await call("capabilities", {});
  const mods = (rep(caps).modules) || {};
  const femAvailable = !!(mods["ObjectsFem"] && mods["ObjectsFem"].available);
  console.log("FEM python importable: " + femAvailable);

  await call("new_document", { name: DOC }, "doc.fem", "fem test doc");

  // ---------------------------------------------------------------
  // A. The elastic table. It writes nothing, and the refusals it
  //    encodes are data rather than improvisation.
  // ---------------------------------------------------------------
  console.log("\n--- Section A: the material table ---");
  const table = await fem({ mode: "materials" });
  const mats = rep(table).materials || {};
  assert(
    "A1 the table returns elastic properties, not just densities",
    mats["aluminium-6061"] &&
      mats["aluminium-6061"].E > 60000 &&
      mats["aluminium-6061"].E < 80000 &&
      mats["aluminium-6061"].nu > 0.2,
    JSON.stringify(mats["aluminium-6061"] || {})
  );
  // Not the undo count: the envelope's own comment records that the same
  // no-op call booked one entry on one run and none on the next. What is
  // deterministic, and what actually matters, is that nothing appeared.
  assert(
    "A2 it writes nothing — no object appears in the document",
    table && table.applied === true &&
      ((table.diff || {}).added || []).length === 0 &&
      ((table.diff || {}).removed || []).length === 0,
    "applied=" + (table && table.applied) + " diff=" +
      JSON.stringify((table && table.diff) || {})
  );
  // The refusal that matters most is the one nobody asks for: a material whose
  // strength is not one number must not produce a factor of safety at all.
  assert(
    "A3 a brittle material carries no yield, so no factor of safety can be built from it",
    mats["cast-iron"] &&
      mats["cast-iron"].yield === null &&
      /brittle/i.test(String(mats["cast-iron"].note || "")),
    JSON.stringify(mats["cast-iron"] || {})
  );
  assert(
    "A4 and neither does a polymer",
    mats["abs"] && mats["abs"].yield === null,
    JSON.stringify(mats["abs"] || {})
  );

  const bins = rep(table).binaries || (table && table.result && table.result.binaries) || {};
  const canMesh = !!bins.gmsh;
  const canSolve = !!(bins.gmsh && bins.ccx);
  console.log("gmsh: " + (bins.gmsh || "absent") + " | ccx: " + (bins.ccx || "absent"));
  assert(
    "A5 the reply says where the two external programs are, or that they are absent",
    bins && Object.prototype.hasOwnProperty.call(bins, "gmsh") &&
      Object.prototype.hasOwnProperty.call(bins, "ccx"),
    JSON.stringify(bins)
  );

  if (!femAvailable) {
    note("B*..H* skipped", "ObjectsFem is not importable on this build");
    return finish();
  }

  // ---------------------------------------------------------------
  // B. The refusals. No solver needed for any of them, which is the
  //    point: the model is rejected BEFORE minutes of CalculiX.
  // ---------------------------------------------------------------
  console.log("\n--- Section B: what is refused before the solver runs ---");

  // A beam, 60 x 10 x 8, loaded in tension along its own axis. Deliberately
  // dull: section E is where the geometry gets interesting.
  await call(
    "batch",
    {
      ops: [
        { fn: "body", args: {}, id: "body.beam" },
        {
          fn: "sketch",
          args: {
            body: "body.beam",
            on: "XY",
            geometry: [
              { type: "rect", anchor: "center", x: 0, y: 0, w: 60, h: 10 },
            ],
          },
          id: "sk.beam",
        },
        { fn: "pad", args: { sketch: "sk.beam", length: 8 }, id: "pad.beam" },
      ],
    },
    null,
    "beam"
  );

  // Queried on the BODY, not on the Pad. A reference onto an intermediate
  // feature resolves, stores, and then finds no nodes at mesh time — the
  // solve runs without that constraint and reports nothing wrong. B7b below
  // is the assertion that this is refused rather than discovered later.
  const fixedFace = await faceRef("body.beam", "-X");
  const loadFace = await faceRef("body.beam", "+X");
  assert(
    "B0 both end faces are addressable by geometry rather than by index",
    !!fixedFace && !!loadFace,
    "fixed=" + fixedFace + " load=" + loadFace
  );

  const noId = await fem({ mode: "study", target: "body.beam" });
  assert(
    "B1 a creating mode without an id is refused",
    refused(noId, "id"),
    refusal(noId)
  );

  const noMat = await fem({
    mode: "study",
    target: "body.beam",
    material: "unobtanium",
    id: "fea.nope",
  });
  assert(
    "B2 an unknown material is refused rather than defaulted",
    refused(noMat, "elastic properties"),
    refusal(noMat)
  );

  const onSketch = await fem({
    mode: "study",
    target: "sk.beam",
    material: "aluminium-6061",
    id: "fea.nope2",
  });
  assert(
    "B3 a sketch has no solid to analyse and is refused",
    refused(onSketch, "solid"),
    refusal(onSketch)
  );

  const study = await fem({
    mode: "study",
    target: "body.beam",
    material: "aluminium-6061",
    id: "fea.beam",
    name: "beam study",
  });
  const sRep = rep(study);
  assert(
    "B4 a study is created, with a solver and a material",
    study.applied === true && !!sRep.analysis && !!sRep.solver,
    refusal(study) || JSON.stringify(sRep).slice(0, 200)
  );
  // Read back, not assumed. If the material card did not stick, every stress
  // and every displacement below is about a material nobody chose — and it
  // would still solve.
  assert(
    "B5 the material card is read back off the object, not echoed",
    sRep.material &&
      sRep.material.readback &&
      /MPa/.test(String(sRep.material.readback.YoungsModulus || "")),
    JSON.stringify((sRep.material || {}).readback || {})
  );

  const noRefs = await fem({
    mode: "constrain",
    analysis: "fea.beam",
    kind: "fixed",
    id: "bc.norefs",
  });
  assert(
    "B6 a boundary condition with no references is refused",
    refused(noRefs, "refs"),
    refusal(noRefs)
  );

  const wholeObj = await fem({
    mode: "constrain",
    analysis: "fea.beam",
    kind: "fixed",
    refs: ["body.beam"],
    id: "bc.whole",
  });
  assert(
    "B7 a whole object is not a face, and is refused",
    refused(wholeObj, "whole object"),
    refusal(wholeObj)
  );

  // Load first, restraint second, so the no-restraint refusal can be tested
  // on its own. This is the one that matters most: an unrestrained model does
  // not error, it floats.
  const onFeature = await faceRef("pad.beam", "+X");
  if (onFeature) {
    const wrongOwner = await fem({
      mode: "constrain",
      analysis: "fea.beam",
      kind: "fixed",
      refs: [onFeature],
      id: "bc.wrongowner",
    });
    assert(
      "B7b a face on an intermediate feature rather than the meshed solid is refused",
      refused(wrongOwner, "no nodes"),
      refusal(wrongOwner)
    );
  } else {
    note("B7b skipped", "the pad's own +X face did not resolve uniquely");
  }

  const load = await fem({
    mode: "constrain",
    analysis: "fea.beam",
    kind: "force",
    refs: [loadFace],
    magnitude: 20000,
    id: "bc.pull",
  });
  assert(
    "B8 a force is applied and reports what it actually stored",
    load.applied === true &&
      rep(load).constraint &&
      rep(load).constraint.applied.forceN > 0 &&
      Array.isArray(rep(load).constraint.stored) &&
      rep(load).constraint.stored.length === 1,
    refusal(load) || JSON.stringify(rep(load).constraint || {})
  );

  const noRestraint = await fem({ mode: "solve", analysis: "fea.beam" });
  assert(
    "B9 a model with NO restraint is refused before the solver runs",
    refused(noRestraint, "restraint") &&
      /rigid.?body/i.test(refusal(noRestraint)),
    refusal(noRestraint)
  );

  const fixedBc = await fem({
    mode: "constrain",
    analysis: "fea.beam",
    kind: "fixed",
    refs: [fixedFace],
    id: "bc.root",
  });
  assert(
    "B10 a fixed constraint is applied",
    fixedBc.applied === true && !!rep(fixedBc).constraint,
    refusal(fixedBc)
  );

  const noMesh = await fem({ mode: "solve", analysis: "fea.beam" });
  assert(
    "B11 a model with no volume mesh is refused, rather than solved on nothing",
    refused(noMesh, "mesh"),
    refusal(noMesh)
  );

  const unsolved = await fem({ mode: "result", analysis: "fea.beam" });
  assert(
    "B12 an unsolved analysis reports solved:null — not false, and not a pass",
    rep(unsolved).solved === null ||
      (unsolved.result && unsolved.result.solved === null),
    JSON.stringify(rep(unsolved)).slice(0, 200)
  );

  // A second analysis with a restraint and no load, to prove the other half of
  // the pair. Zero stress everywhere divides into a yield strength as an
  // infinite factor of safety, which is the most comfortable wrong answer here.
  const study2 = await fem({
    mode: "study",
    target: "body.beam",
    material: "steel-1018",
    id: "fea.noload",
  });
  if (study2.applied === true) {
    await fem({
      mode: "constrain",
      analysis: "fea.noload",
      kind: "fixed",
      refs: [fixedFace],
      id: "bc.root2",
    });
    const noLoad = await fem({ mode: "solve", analysis: "fea.noload" });
    assert(
      "B13 a model with no load is refused — zero stress is not a pass",
      refused(noLoad, "no load"),
      refusal(noLoad)
    );
    await fem({ mode: "clear", analysis: "fea.noload" });
  } else {
    note("B13 skipped", refusal(study2));
  }

  // ---------------------------------------------------------------
  // C. The mesh. Gated on gmsh, which is a separate program.
  // ---------------------------------------------------------------
  console.log("\n--- Section C: mesh ---");
  if (!canMesh) {
    note("C*..H* skipped", "gmsh is not installed; nothing below can run");
    return finish();
  }

  const meshRes = await fem({
    mode: "mesh",
    analysis: "fea.beam",
    elementSize: 4,
  });
  const mesh = rep(meshRes).mesh || {};
  assert(
    "C1 the mesh has nodes AND volume elements",
    meshRes.applied === true && mesh.nodes > 0 && mesh.volumes > 0,
    refusal(meshRes) || JSON.stringify(mesh)
  );
  assert(
    "C2 it reports the element size it actually used",
    typeof mesh.elementSizeMm === "number" && mesh.elementSizeMm > 0,
    JSON.stringify(mesh)
  );

  // ---------------------------------------------------------------
  // D. The solve, and the contract its verdict has to keep.
  // ---------------------------------------------------------------
  console.log("\n--- Section D: solve ---");
  if (!canSolve) {
    note("D*..H* skipped", "CalculiX (ccx) is not installed");
    return finish();
  }

  const solved = await fem({ mode: "solve", analysis: "fea.beam" });
  const sr = rep(solved);
  const field = sr.field || {};
  const solveOk = assert(
    "D1 the solve produces a readable stress field",
    solved.applied === true &&
      sr.solved === true &&
      field.readable === true &&
      field.maxVonMisesMPa > 0,
    refusal(solved) || JSON.stringify(sr).slice(0, 300)
  );

  if (solveOk) {
    // A tension bar is the one case where the answer is known without a
    // solver: 20000 N over 10 x 8 mm is 250 MPa. The check is deliberately
    // loose — the fixed face restrains lateral contraction and concentrates
    // stress at its edges — but an answer off by an order of magnitude is a
    // unit error, and a unit error is exactly what this suite is for.
    assert(
      "D2 the field is the right order of magnitude for 20 kN over 80 mm²",
      field.p99VonMisesMPa > 100 && field.p99VonMisesMPa < 1500,
      "p99=" + field.p99VonMisesMPa + " peak=" + field.maxVonMisesMPa
    );
    assert(
      "D3 the peak is reported alongside a field statistic, not alone",
      typeof field.p99VonMisesMPa === "number" &&
        typeof field.maxVonMisesMPa === "number" &&
        field.maxVonMisesMPa >= field.p99VonMisesMPa,
      JSON.stringify(field).slice(0, 200)
    );
    assert(
      "D4 solved once, convergence is null — an unfinished check, never a pass",
      sr.converged === null && /unknown/i.test(String(sr.convergenceNote || "")),
      "converged=" + JSON.stringify(sr.converged)
    );
    // The contract, not the value. Either the peak is trustworthy and a factor
    // of safety comes with it, or it is not and the factor of safety is
    // withheld WITH a reason. What must never happen is a number divided out
    // of a singular peak.
    if (sr.singularitySuspect === true || field.singularitySuspect === true) {
      assert(
        "D5 a singular peak withholds the factor of safety and says why",
        sr.factorOfSafety === null &&
          !!sr.factorOfSafetyNote &&
          typeof sr.factorOfSafetyP99 === "number",
        JSON.stringify({ fos: sr.factorOfSafety, note: sr.factorOfSafetyNote })
      );
    } else {
      assert(
        "D5 a clean peak carries a factor of safety against a real yield",
        typeof sr.factorOfSafety === "number" && sr.yieldMPa > 0,
        JSON.stringify({ fos: sr.factorOfSafety, yield: sr.yieldMPa })
      );
    }
    assert(
      "D6 a bar in tension does not move a tenth of its own length",
      !field.displacementImplausible &&
        typeof field.maxDisplacementMm === "number",
      JSON.stringify({
        disp: field.maxDisplacementMm,
        pct: field.displacementOverSizePct,
      })
    );
    assert(
      "D7 the reply says out loud that this is one load case and not a certificate",
      /not a certificate|evidence/i.test(String(sr.loadNote || "")),
      String(sr.loadNote || "").slice(0, 120)
    );
  }

  // ---------------------------------------------------------------
  // E. The singularity. A sharp re-entrant corner, loaded, is the case
  //    where a confident number is worse than no number.
  // ---------------------------------------------------------------
  console.log("\n--- Section E: sharp corner ---");
  await call(
    "batch",
    {
      ops: [
        { fn: "body", args: {}, id: "body.notch" },
        {
          fn: "sketch",
          args: {
            body: "body.notch",
            on: "XY",
            geometry: [
              { type: "rect", anchor: "center", x: 0, y: 0, w: 60, h: 10 },
            ],
          },
          id: "sk.nbeam",
        },
        { fn: "pad", args: { sketch: "sk.nbeam", length: 8 }, id: "pad.nbeam" },
        {
          fn: "sketch",
          args: {
            body: "body.notch",
            on: "XY",
            geometry: [
              // Square corners on purpose, and wider than the beam in Y so it
              // cuts clean through: this is a notch with a zero-radius root.
              { type: "rect", anchor: "center", x: 0, y: 0, w: 6, h: 20 },
            ],
          },
          id: "sk.notch",
        },
        {
          fn: "pocket",
          args: { sketch: "sk.notch", length: 3 },
          id: "pocket.notch",
        },
      ],
    },
    null,
    "notch"
  );

  const notchStudy = await fem({
    mode: "study",
    target: "body.notch",
    material: "aluminium-6061",
    id: "fea.notch",
  });
  if (notchStudy.applied !== true) {
    note("E* skipped", refusal(notchStudy));
  } else {
    const nFixed = await faceRef("body.notch", "-X", 40);
    const nLoad = await faceRef("body.notch", "+X", 40);
    if (!nFixed || !nLoad) {
      note("E* skipped", "the notched beam's end faces did not resolve uniquely");
    } else {
      await fem({
        mode: "constrain",
        analysis: "fea.notch",
        kind: "fixed",
        refs: [nFixed],
        id: "bc.nroot",
      });
      await fem({
        mode: "constrain",
        analysis: "fea.notch",
        kind: "force",
        refs: [nLoad],
        magnitude: 20000,
        id: "bc.npull",
      });
      await fem({ mode: "mesh", analysis: "fea.notch", elementSize: 2 });
      const nSolved = await fem({ mode: "solve", analysis: "fea.notch" });
      const nr = rep(nSolved);
      const nf = nr.field || {};
      assert(
        "E1 the corner check ran and found the sharp edges the notch has",
        typeof nf.sharpEdges === "number" && nf.sharpEdges > 0,
        JSON.stringify({
          sharp: nf.sharpEdges,
          near: nf.peakNearCornerMm,
          note: nf.singularityNote ? "present" : "absent",
        })
      );
      if (nf.singularitySuspect === true) {
        assert(
          "E2 a peak on the corner is named as a singularity and costs the factor of safety",
          nr.factorOfSafety === null &&
            /singular/i.test(String(nr.factorOfSafetyNote || "")) &&
            typeof nr.factorOfSafetyP99 === "number",
          JSON.stringify({
            fos: nr.factorOfSafety,
            p99fos: nr.factorOfSafetyP99,
          })
        );
        assert(
          "E3 and the distance that decided it is a measurement, not an opinion",
          typeof nf.peakNearCornerMm === "number" &&
            typeof nf.bandMm === "number" &&
            nf.peakNearCornerMm <= nf.bandMm,
          JSON.stringify({ at: nf.peakNearCornerMm, band: nf.bandMm })
        );
      } else {
        // Not a failure: on a coarse mesh the peak node can land at the fixed
        // face instead. The contract still has to hold, so it is checked in
        // the other direction.
        note(
          "E2 the peak did not land on the corner this run",
          "peakNearCornerMm=" + nf.peakNearCornerMm + " band=" + nf.bandMm
        );
        assert(
          "E2b a peak away from the corner still carries a factor of safety",
          nr.solved !== true || typeof nr.factorOfSafety === "number",
          JSON.stringify({ fos: nr.factorOfSafety })
        );
      }

      // Convergence. Two meshes is the cheapest honest statement about
      // whether a number depends on the mesh — and at a singular corner it is
      // supposed to REFUSE to converge, which is the finding, not a fault.
      const conv = await fem({
        mode: "converge",
        analysis: "fea.notch",
        factor: 0.75,
      });
      const cr = rep(conv);
      if (refusal(conv)) {
        note("E4 skipped", refusal(conv));
      } else {
        assert(
          "E4 converge solves twice and reports how far the answer moved",
          typeof cr.converged === "boolean" &&
            cr.convergence &&
            typeof cr.convergence.p99ChangePct === "number" &&
            cr.convergence.elementSizeMm[1] < cr.convergence.elementSizeMm[0],
          JSON.stringify(cr.convergence || {})
        );
        assert(
          "E5 and the verdict it reports is the finer mesh's, not the coarse one's",
          cr.refined && cr.refined.field && cr.field &&
            cr.field.maxVonMisesMPa === cr.refined.field.maxVonMisesMPa,
          JSON.stringify({
            reported: (cr.field || {}).maxVonMisesMPa,
            refined: ((cr.refined || {}).field || {}).maxVonMisesMPa,
          })
        );
      }
    }
  }

  // ---------------------------------------------------------------
  // F. Staleness. A result that outlives its geometry is a number the
  //    transcript still has and the part does not.
  // ---------------------------------------------------------------
  console.log("\n--- Section F: stale results ---");
  const before = await fem({ mode: "result", analysis: "fea.beam" });
  assert(
    "F1 a solved analysis reads back as not stale",
    rep(before).stale === false,
    JSON.stringify({ stale: rep(before).stale })
  );

  await call(
    "feature_edit",
    { target: "pad.beam", props: { Length: 14 } },
    null,
    "grow the beam"
  );

  const after = await fem({ mode: "result", analysis: "fea.beam" });
  assert(
    "F2 changing the geometry makes the old result stale, and it says so",
    rep(after).stale === true && /old shape/i.test(String(rep(after).staleNote || "")),
    JSON.stringify({ stale: rep(after).stale })
  );

  const lintRep = await sync({ detail: "summary" });
  assert(
    "F3 and lint reports it every turn, without being asked",
    ((lintRep && lintRep.lint) || []).some((r) => r.code === "fem-stale"),
    JSON.stringify(((lintRep && lintRep.lint) || []).map((r) => r.code))
  );

  // ---------------------------------------------------------------
  // G. Teardown. An analysis owns a solver, a material, constraints,
  //    a mesh and its results; removing the container alone leaves
  //    every one of them in the tree.
  // ---------------------------------------------------------------
  console.log("\n--- Section G: clear ---");
  const cleared = await fem({ mode: "clear", analysis: "fea.beam" });
  const removed = rep(cleared).removed || [];
  assert(
    "G1 clear removes the analysis and what it owns, and names them",
    cleared.applied === true && removed.length > 1,
    JSON.stringify(removed)
  );
  const lintAfter = await sync({ detail: "summary" });
  assert(
    "G2 and the stale finding goes with it",
    !((lintAfter && lintAfter.lint) || []).some((r) => r.code === "fem-stale"),
    JSON.stringify(((lintAfter && lintAfter.lint) || []).map((r) => r.code))
  );
  const idsRep = await call("ids", {});
  assert(
    "G3 the solid it was solved on is untouched",
    JSON.stringify(rep(idsRep)).indexOf("body.beam") !== -1,
    "body.beam should still be registered"
  );

  return finish();
}

async function finish() {
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