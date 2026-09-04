#!/usr/bin/env node

/**
 * Isolated STEP round-trip gate.
 *
 * This process does not receive database, model-provider, payment, or storage
 * credentials. It re-opens the serialized STEP file after the geometry worker
 * has exited and compares topology/bounds against the frozen manifest. A
 * separately packaged FreeCAD/OCP validator can be added as a second gate in
 * deployment; this gate deliberately reports its actual validator identity.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import opencascade from "replicad-opencascadejs";
import { cast, importSTEP, iterTopo, measureVolume, setOC } from "replicad";

const [stepArg, expectedArg] = process.argv.slice(2);
if (!stepArg || !expectedArg) {
  throw new Error("usage: cad-step-validator <model.step> <expectedJson>");
}

const stepPath = path.resolve(stepArg);
const tempRoot = path.resolve(process.cwd(), ".data", "cad-tmp");
if (!stepPath.startsWith(`${tempRoot}${path.sep}`) || path.basename(stepPath) !== "model.step") {
  throw new Error("STEP validator path escaped CAD temp root");
}
const expected = JSON.parse(expectedArg);
const expectedCount = Number(expected.solidCount);
const expectedBounds = expected.bounds;
if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 24) {
  throw new Error("STEP expected solid count is invalid");
}
if (
  !Array.isArray(expectedBounds)
  || expectedBounds.length !== 2
  || expectedBounds.some((point) => !Array.isArray(point) || point.length !== 3 || point.some((value) => !Number.isFinite(value)))
) {
  throw new Error("STEP expected bounds are invalid");
}
const info = await stat(stepPath);
if (!info.isFile() || info.size < 128 || info.size > 256 * 1024 * 1024) {
  throw new Error("STEP file size is invalid");
}
const step = await readFile(stepPath);
const header = step.subarray(0, Math.min(step.length, 8_192)).toString("utf8");
const wholeText = step.toString("utf8");
if (!/ISO-10303-21\s*;/.test(header)) throw new Error("STEP header is invalid");
if (!/LENGTH_UNIT\(\).*SI_UNIT\(\.MILLI\.,\.METRE\.\)/s.test(wholeText)) {
  throw new Error("STEP does not declare millimeter units");
}

const oc = await opencascade({ print: () => {}, printErr: () => {} });
setOC(oc);
const shape = await importSTEP(new Blob([step]));
const solidHandles = [...iterTopo(shape.wrapped, "solid")];
const solids = solidHandles.map((solid) => cast(solid));
try {
  if (solids.length !== expectedCount) {
    throw new Error(`STEP solid count mismatch:${solids.length}/${expectedCount}`);
  }
  const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
  const brepValid = analyzer.IsValid();
  analyzer.delete();
  if (!brepValid) throw new Error("STEP round-trip B-Rep is invalid");
  const volumeMm3 = measureVolume(shape);
  if (!Number.isFinite(volumeMm3) || volumeMm3 <= 0) throw new Error("STEP round-trip volume is invalid");
  const volumeTolerance = Math.max(0.1, Math.abs(Number(expected.volumeMm3)) * 0.001);
  if (!Number.isFinite(Number(expected.volumeMm3)) || Math.abs(volumeMm3 - Number(expected.volumeMm3)) > volumeTolerance) {
    throw new Error(`STEP volume mismatch:${volumeMm3}/${expected.volumeMm3}`);
  }
  const faceCount = shape.faces.length;
  const edgeCount = shape.edges.length;
  if (!Number.isInteger(expected.faceCount) || faceCount !== expected.faceCount) {
    throw new Error(`STEP face count mismatch:${faceCount}/${expected.faceCount}`);
  }
  if (!Number.isInteger(expected.edgeCount) || edgeCount !== expected.edgeCount) {
    throw new Error(`STEP edge count mismatch:${edgeCount}/${expected.edgeCount}`);
  }
  const bounds = shape.boundingBox.bounds.map((point) => point.map((value) => Math.round(value * 1_000) / 1_000));
  const toleranceFor = (expected) => Math.max(0.05, Math.abs(expected) * 0.0005);
  for (let side = 0; side < 2; side++) {
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(bounds[side][axis] - expectedBounds[side][axis]) > toleranceFor(expectedBounds[side][axis])) {
        throw new Error(`STEP bounds mismatch at ${side}/${axis}:${bounds[side][axis]}/${expectedBounds[side][axis]}`);
      }
    }
  }
  const expectedParts = Array.isArray(expected.parts) ? expected.parts : [];
  if (expectedParts.length) {
    if (expectedParts.length !== solids.length) throw new Error("STEP part summary count mismatch");
    const actualParts = solids.map((solid) => ({ bounds: solid.boundingBox.bounds, volumeMm3: measureVolume(solid) }));
    const unused = new Set(actualParts.map((_, index) => index));
    for (const part of expectedParts) {
      if (!part || !Array.isArray(part.bounds) || !Number.isFinite(part.volumeMm3)) throw new Error("STEP expected part summary is invalid");
      const match = [...unused].find((index) => {
        const actual = actualParts[index];
        const boundsMatch = part.bounds.every((point, side) => point.every((value, axis) => (
          Math.abs(actual.bounds[side][axis] - value) <= toleranceFor(value)
        )));
        const partVolumeTolerance = Math.max(0.1, Math.abs(part.volumeMm3) * 0.001);
        return boundsMatch && Math.abs(actual.volumeMm3 - part.volumeMm3) <= partVolumeTolerance;
      });
      if (match === undefined) throw new Error(`STEP part geometry mismatch:${String(part.name || "unnamed").slice(0, 80)}`);
      unused.delete(match);
      // ASCII 部件名在 STEP 中应可直接检索；中文可被 STEP \X2\ 编码，不做错误字节假阳性。
      if (typeof part.name === "string" && /^[\x20-\x7e]+$/.test(part.name) && !wholeText.includes(part.name)) {
        throw new Error(`STEP part name missing:${part.name.slice(0, 80)}`);
      }
    }
  }
  console.log(JSON.stringify({
    ok: true,
    validator: "replicad-isolated",
    schema: /FILE_SCHEMA\s*\(\s*\(\s*'AP242/i.test(wholeText) ? "AP242" : "STEP",
    unit: "mm",
    brepValid,
    solidCount: solids.length,
    faceCount,
    edgeCount,
    bounds,
    volumeMm3: Math.round(volumeMm3 * 1_000) / 1_000,
    partGeometryValid: expectedParts.length ? true : undefined,
  }));
} finally {
  for (const solid of solids) solid.delete();
  shape.delete();
}
