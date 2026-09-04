#!/usr/bin/env node

/** CI/release smoke: Replicad/WASM exports STEP, native FreeCAD imports it. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import opencascade from "replicad-opencascadejs";
import { exportSTEP, makeBox, makeCompound, makeLine, measureVolume, setOC } from "replicad";

const execFileAsync = promisify(execFile);
const binary = process.env.CAD_EXTERNAL_STEP_VALIDATOR_BIN || "/usr/bin/python3";
const root = path.resolve(process.cwd(), ".data", "cad-tmp");
await mkdir(root, { recursive: true });
const tmpDir = await mkdtemp(path.join(root, "tmp-cross-validator-"));
const validator = path.join(process.cwd(), "scripts", "freecad-step-validator.py");

const round = (value) => Math.round(value * 1_000) / 1_000;
const bounds = (shape) => shape.boundingBox.bounds.map((point) => point.map(round));
const close = (left, right, tolerance = 0.1) => Math.abs(left - right) <= tolerance;
const boundsEqual = (left, right) => left.every((point, side) => (
  point.every((value, axis) => close(value, right[side][axis], Math.max(0.05, Math.abs(value) * 0.0005)))
));

async function validate(stepPath) {
  const { stdout } = await execFileAsync(binary, [validator, stepPath], {
    cwd: process.cwd(),
    timeout: 90_000,
    killSignal: "SIGKILL",
    maxBuffer: 512 * 1024,
    env: {
      PATH: process.env.PATH || "",
      HOME: "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      QT_QPA_PLATFORM: "offscreen",
      PYTHONPATH: process.env.PYTHONPATH || "",
    },
  });
  const line = stdout.trim().split(/\r?\n/).reverse().find((entry) => /^\s*\{.*\}\s*$/.test(entry));
  return JSON.parse(line || "{}");
}

async function expectReject(stepPath, label, expectedMessage) {
  try {
    await validate(stepPath);
  } catch (error) {
    const detail = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join("\n");
    if (!detail.includes(expectedMessage)) {
      throw new Error(`FreeCAD negative sample rejected for the wrong reason:${label}:${detail}`);
    }
    return;
  }
  throw new Error(`FreeCAD negative sample unexpectedly passed:${label}`);
}

const oc = await opencascade({ print: () => {}, printErr: () => {} });
setOC(oc);
const samples = [
  {
    name: "single",
    shapes: [{ shape: makeBox([0, 0, 0], [120, 80, 5]), name: "plate", color: "#6D5CE7" }],
  },
  {
    name: "multi",
    shapes: [
      { shape: makeBox([0, 0, 0], [20, 10, 5]), name: "part_a", color: "#6D5CE7" },
      { shape: makeBox([30, 0, 0], [40, 10, 5]), name: "part_b", color: "#28A57A" },
    ],
  },
];
const results = [];
const negativeResults = [];
try {
  for (const sample of samples) {
    const combined = makeCompound(sample.shapes.map((entry) => entry.shape.clone()));
    const step = Buffer.from(await (await exportSTEP(sample.shapes, { unit: "MM", modelUnit: "MM" })).arrayBuffer());
    const stepPath = path.join(tmpDir, sample.name === "single" ? "model.step" : `${sample.name}.step`);
    // validator 对生产入口固定 model.step；多实体也在同一安全路径下覆盖后复读。
    const productionPath = path.join(tmpDir, "model.step");
    await writeFile(productionPath, step);
    const result = await validate(productionPath);
    const expectedVolume = measureVolume(combined);
    if (
      result.ok !== true
      || result.validator !== "freecad-native"
      || result.unit !== "mm"
      || result.brepValid !== true
      || result.solidCount !== sample.shapes.length
      || result.faceCount !== combined.faces.length
      || result.edgeCount !== combined.edges.length
      || !close(Number(result.volumeMm3), expectedVolume, Math.max(0.1, expectedVolume * 0.001))
      || !boundsEqual(result.bounds, bounds(combined))
    ) {
      throw new Error(`Replicad -> FreeCAD summary mismatch:${sample.name}:${JSON.stringify(result)}`);
    }
    results.push({ sample: sample.name, solidCount: result.solidCount, volumeMm3: result.volumeMm3 });
    combined.delete();
  }

  const valid = await readFile(path.join(tmpDir, "model.step"), "utf8");
  // 保留完整头与 mm 单位声明，破坏 DATA 实体编号，确保真正进入 FreeCAD 解析分支，
  // 而不是被文件大小/头/单位预检提前拒绝。
  const corrupt = valid.replace(/^#/gm, "!");
  if (corrupt === valid || Buffer.byteLength(corrupt) < 128) {
    throw new Error("STEP corrupt sample was not constructed from the full valid export");
  }
  await writeFile(path.join(tmpDir, "model.step"), corrupt);
  await expectReject(path.join(tmpDir, "model.step"), "corrupt", "FreeCAD returned an empty STEP shape");
  negativeResults.push({ sample: "corrupt", rejectedBy: "FreeCAD returned an empty STEP shape" });
  const wrongUnit = valid.replace(/SI_UNIT\(\.MILLI\.,\.METRE\.\)/g, "SI_UNIT($,.METRE.)");
  if (wrongUnit === valid) throw new Error("STEP sample did not contain millimeter unit declaration");
  await writeFile(path.join(tmpDir, "model.step"), wrongUnit);
  await expectReject(path.join(tmpDir, "model.step"), "wrong-unit", "STEP does not declare millimeter units");
  negativeResults.push({ sample: "wrong-unit", rejectedBy: "STEP does not declare millimeter units" });

  // 用 Replicad 实际导出仅含一条边的合法 STEP，它足够大且含 mm 单位，
  // FreeCAD 能读取但必须因没有 solid 而拒绝。
  const line = makeLine([0, 0, 0], [10, 0, 0]);
  try {
    const noSolid = Buffer.from(await (await exportSTEP([
      { shape: line, name: "edge_only", color: "#6D5CE7" },
    ], { unit: "MM", modelUnit: "MM" })).arrayBuffer());
    if (noSolid.length < 128) throw new Error("STEP no-solid sample is unexpectedly small");
    await writeFile(path.join(tmpDir, "model.step"), noSolid);
    await expectReject(path.join(tmpDir, "model.step"), "no-solid", "FreeCAD STEP contains no solids");
    negativeResults.push({ sample: "no-solid", rejectedBy: "FreeCAD STEP contains no solids" });
  } finally {
    line.delete();
  }

  console.log(JSON.stringify({ ok: true, validator: "replicad-to-freecad", results, negativeResults }));
} finally {
  for (const sample of samples) for (const entry of sample.shapes) entry.shape.delete();
  await rm(tmpDir, { recursive: true, force: true });
}
