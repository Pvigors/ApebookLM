import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import opencascade from "replicad-opencascadejs";
import { importSTEP, iterTopo, setOC } from "replicad";
import {
  canonicalText2CadDesignHash,
  canonicalText2CadDesignJson,
  normalizeText2CadDesignSpec,
} from "../../lib/text2cad-spec.ts";
import {
  renderText2CadSpec,
  Text2CadRenderError,
  text2cadRuntimeHealth,
} from "../../lib/text2cad.ts";
import { parseTopViewDxf } from "../helpers/dxf.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cadTmpRoot = path.join(root, ".data", "cad-tmp");
const workerPath = path.join(root, "scripts", "text2cad-worker.mjs");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let ocReady;

const ensureOc = async () => {
  if (!ocReady) {
    ocReady = opencascade({ print: () => {}, printErr: () => {} }).then((oc) => {
      setOC(oc);
      return oc;
    });
  }
  return ocReady;
};

const rectangle = (width, height, center = [0, 0], cornerRadius = 0) => ({
  kind: "rectangle",
  center,
  width,
  height,
  cornerRadius,
});

const baseSpec = (parts) => normalizeText2CadDesignSpec({
  schemaVersion: 2,
  engine: "text2cad",
  unit: "mm",
  name: "Text2CAD 几何测试",
  process: "CNC machining",
  requirements: [{
    id: "req_shape",
    text: "生成可编辑、尺寸受控的机械零件",
    sourceRefs: ["prompt:1"],
    acceptance: "导出有效 STEP 并通过几何校验",
  }],
  parts,
});

async function runWorker(spec) {
  await mkdir(cadTmpRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(cadTmpRoot, "tmp-text2cad-test-"));
  const canonical = canonicalText2CadDesignJson(spec);
  const hash = canonicalText2CadDesignHash(spec);
  const input = path.join(tmpDir, "input.json");
  await writeFile(input, canonical, { flag: "wx", mode: 0o600 });
  await execFileAsync(process.execPath, [workerPath, input, tmpDir, hash], {
    cwd: root,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { tmpDir, canonical, hash };
}

test("Text2CAD 工人解释四类轮廓与四种布尔操作，并产出闭环单零件包", async () => {
  const spec = baseSpec([
    {
      id: "part_body",
      name: "Control Body",
      material: "6061-T6",
      color: "#6D5CE7",
      features: [
        {
          id: "feat_base",
          kind: "extrude",
          operation: "new",
          plane: "XY",
          profile: {
            outer: rectangle(100, 60, [0, 0], 6),
            holes: [
              { kind: "circle", center: [-35, -15], radius: 4 },
              { kind: "circle", center: [-35, 15], radius: 4 },
            ],
          },
          distance: 10,
          requirementRefs: ["req_shape"],
        },
        {
          id: "feat_add",
          kind: "extrude",
          operation: "add",
          plane: "XY",
          profile: {
            outer: { kind: "polygon", points: [[40, -12], [65, 0], [40, 12]] },
            holes: [],
          },
          distance: 10,
          requirementRefs: ["req_shape"],
        },
        {
          id: "feat_cut",
          kind: "extrude",
          operation: "cut",
          plane: "XY",
          profile: {
            outer: { kind: "circle", center: [0, 0], radius: 8 },
            holes: [],
          },
          distance: 10,
          requirementRefs: ["req_shape"],
        },
        {
          id: "feat_intersect",
          kind: "extrude",
          operation: "intersect",
          plane: "XY",
          profile: {
            outer: {
              kind: "path",
              segments: [
                { kind: "line", start: [-70, -50], end: [70, -50] },
                { kind: "line", start: [70, -50], end: [70, 25] },
                { kind: "arc", start: [70, 25], mid: [0, 20], end: [-70, 25] },
                { kind: "line", start: [-70, 25], end: [-70, -50] },
              ],
            },
            holes: [],
          },
          distance: 10,
          requirementRefs: ["req_shape"],
        },
      ],
    },
  ]);

  const { tmpDir, canonical, hash } = await runWorker(spec);
  try {
    const manifest = JSON.parse(await readFile(path.join(tmpDir, "manifest.json"), "utf8"));
    const mesh = JSON.parse(await readFile(path.join(tmpDir, "mesh.json"), "utf8"));
    const dxf = parseTopViewDxf(await readFile(path.join(tmpDir, "top-view.dxf")));
    assert.equal(manifest.manifestVersion, 2);
    assert.equal(manifest.libraryVersion, 2);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.template, "text2cad");
    assert.equal(manifest.process, "CNC machining");
    assert.equal(manifest.hash, hash);
    assert.equal(manifest.artifactMode, "single_part");
    assert.equal(manifest.partCount, 1);
    assert.equal(manifest.parts.length, 1);
    assert.equal(manifest.parts[0].featureCount, 4);
    assert.equal(manifest.featureHistory.length, 4);
    assert.deepEqual(manifest.featureHistory.map((entry) => entry.operation), ["new", "add", "cut", "intersect"]);
    assert.equal(manifest.validation.brepValid, true);
    assert.equal(manifest.validation.partsSingleSolid, true);
    assert.equal(manifest.validation.interferenceFree, true);
    assert.equal(manifest.partsHash, sha256(JSON.stringify(manifest.parts)));
    assert.equal(mesh.parts.length, 1);
    assert.equal(mesh.parts[0].id, "part_body");
    assert.equal(mesh.parts[0].material, "6061-T6");
    assert.equal(mesh.parts[0].features.length, 4);
    assert.equal(mesh.parts[0].vertices.length, mesh.vertices.length);
    assert.ok(mesh.parts[0].triangles.every((index) => index >= 0 && index < mesh.parts[0].vertices.length / 3));
    assert.equal(mesh.manifest.partsHash, manifest.partsHash);
    assert.equal(manifest.dxfProjection.lineCount, dxf.lines.length);
    assert.deepEqual(manifest.dxfProjection.bounds, dxf.bounds);
    assert.equal(mesh.triangles.length / 3, manifest.triangleCount);
    assert.equal(mesh.vertices.length, mesh.normals.length);
    assert.ok(mesh.triangles.every((index) => Number.isInteger(index) && index >= 0 && index < mesh.vertices.length / 3));
    assert.deepEqual(JSON.parse(await readFile(path.join(tmpDir, "design-spec.json"), "utf8")), JSON.parse(canonical));
    for (const key of ["step", "stl", "dxf", "mesh", "spec"]) {
      const entry = manifest.files[key];
      const data = await readFile(path.join(tmpDir, entry.name));
      assert.equal(data.length, entry.bytes);
      assert.equal(sha256(data), entry.sha256);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Text2CAD 多部件 STEP 保留部件名，语义网格范围与实体数一致", async () => {
  const spec = baseSpec([
    {
      id: "part_base",
      name: "Base Plate",
      material: "steel",
      color: "#3366CC",
      features: [{
        id: "feat_base",
        kind: "extrude",
        operation: "new",
        plane: "XY",
        profile: { outer: rectangle(30, 20), holes: [] },
        distance: 6,
        requirementRefs: ["req_shape"],
      }],
    },
    {
      id: "part_hub",
      name: "Rotated Hub",
      material: "aluminum",
      color: "#CC6633",
      placement: { translate: [60, 0, 0], rotateDeg: [90, 0, 0] },
      features: [{
        id: "feat_hub",
        kind: "extrude",
        operation: "new",
        plane: "XY",
        profile: { outer: { kind: "circle", center: [0, 0], radius: 8 }, holes: [] },
        distance: 12,
        requirementRefs: ["req_shape"],
      }],
    },
  ]);

  const { tmpDir } = await runWorker(spec);
  try {
    const manifest = JSON.parse(await readFile(path.join(tmpDir, "manifest.json"), "utf8"));
    const mesh = JSON.parse(await readFile(path.join(tmpDir, "mesh.json"), "utf8"));
    const dxf = parseTopViewDxf(await readFile(path.join(tmpDir, "top-view.dxf")));
    assert.equal(manifest.artifactMode, "assembly");
    assert.equal(manifest.partCount, 2);
    assert.equal(manifest.validation.solidCount, 2);
    assert.deepEqual(manifest.parts.map((part) => part.id), ["part_base", "part_hub"]);
    assert.deepEqual(
      manifest.parts[0].bounds,
      [[-15, -10, 0], [15, 10, 6]],
      "发布尺寸不得夹带 OCCT 包围盒公差"
    );
    assert.deepEqual(mesh.parts.map((part) => part.id), ["part_base", "part_hub"]);
    assert.deepEqual(dxf.layers, ["PART_001", "PART_002"]);
    assert.equal(manifest.dxfProjection.lineCount, dxf.lines.length);
    assert.deepEqual(manifest.dxfProjection.bounds, dxf.bounds);
    assert.equal(mesh.parts.reduce((sum, part) => sum + part.vertices.length, 0), mesh.vertices.length);
    assert.equal(mesh.parts.reduce((sum, part) => sum + part.triangles.length, 0), mesh.triangles.length);
    assert.equal(mesh.parts.reduce((sum, part) => sum + part.lines.length, 0), mesh.lines.length);
    for (const part of mesh.parts) {
      assert.equal(part.vertices.length, part.normals.length);
      assert.ok(part.triangles.every((index) => Number.isInteger(index) && index >= 0 && index < part.vertices.length / 3));
      assert.equal(part.features.length, 1);
      assert.ok(part.volumeMm3 > 0);
    }

    const step = await readFile(path.join(tmpDir, "model.step"));
    const stepText = step.toString("utf8");
    assert.match(stepText, /Base Plate/);
    assert.match(stepText, /Rotated Hub/);
    assert.match(stepText, /LENGTH_UNIT\(\).*SI_UNIT\(\.MILLI\.,\.METRE\.\)/, "STEP 必须显式声明毫米单位");
    await ensureOc();
    const shape = await importSTEP(new Blob([step]));
    const solids = [...iterTopo(shape.wrapped, "solid")];
    assert.equal(solids.length, 2);
    for (const solid of solids) solid.delete();
    shape.delete();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Text2CAD 工人拒绝部件实体干涉", async () => {
  const commonFeature = (id) => ({
    id,
    kind: "extrude",
    operation: "new",
    plane: "XY",
    profile: { outer: rectangle(20, 20), holes: [] },
    distance: 10,
    requirementRefs: ["req_shape"],
  });
  const spec = baseSpec([
    { id: "part_left", name: "Left", features: [commonFeature("feat_left")] },
    {
      id: "part_right",
      name: "Right",
      placement: { translate: [5, 0, 0], rotateDeg: [0, 0, 0] },
      features: [commonFeature("feat_right")],
    },
  ]);
  await assert.rejects(
    renderText2CadSpec(spec),
    (error) => (
      error instanceof Text2CadRenderError
      && error.message === "Text2CAD 几何计算失败，请检查轮廓、布尔关系、放置位置和部件干涉后重试"
      && /存在实体干涉/.test(error.repairHint)
      && !/part_left|part_right/.test(error.message)
      && !Object.keys(error).includes("repairHint")
    )
  );
});

test("Text2CAD 每步门禁拒绝 add 产生的非连通多实体", async () => {
  const spec = baseSpec([{
    id: "part_split",
    name: "Split",
    features: [
      {
        id: "feat_first",
        kind: "extrude",
        operation: "new",
        plane: "XY",
        profile: { outer: rectangle(10, 10, [0, 0]), holes: [] },
        distance: 5,
        requirementRefs: ["req_shape"],
      },
      {
        id: "feat_second",
        kind: "extrude",
        operation: "add",
        plane: "XY",
        profile: { outer: rectangle(10, 10, [100, 0]), holes: [] },
        distance: 5,
        requirementRefs: ["req_shape"],
      },
    ],
  }]);
  await mkdir(cadTmpRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(cadTmpRoot, "tmp-text2cad-multisolid-"));
  try {
    const raw = canonicalText2CadDesignJson(spec);
    const input = path.join(tmpDir, "input.json");
    await writeFile(input, raw, { flag: "wx", mode: 0o600 });
    await assert.rejects(
      execFileAsync(process.execPath, [workerPath, input, tmpDir, sha256(raw)], {
        cwd: root,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      }),
      /必须保持单一连通实体/
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Text2CAD 体积门禁拒绝空切、空孔和无变化 intersect", async () => {
  const cases = [
    {
      label: "空切",
      expected: /cut 未实质降低部件体积/,
      features: [
        {
          id: "feat_base",
          kind: "extrude",
          operation: "new",
          plane: "XY",
          profile: { outer: rectangle(20, 20), holes: [] },
          distance: 5,
          requirementRefs: ["req_shape"],
        },
        {
          id: "feat_empty_cut",
          kind: "extrude",
          operation: "cut",
          plane: "XY",
          profile: { outer: { kind: "circle", center: [100, 100], radius: 2 }, holes: [] },
          distance: 5,
          requirementRefs: ["req_shape"],
        },
      ],
    },
    {
      label: "空孔",
      expected: /孔 0 未实质降低特征体积/,
      features: [{
        id: "feat_empty_hole",
        kind: "extrude",
        operation: "new",
        plane: "XY",
        profile: {
          outer: rectangle(20, 20),
          holes: [{ kind: "circle", center: [100, 100], radius: 2 }],
        },
        distance: 5,
        requirementRefs: ["req_shape"],
      }],
    },
    {
      label: "越界孔",
      expected: /未完整位于外轮廓内/,
      features: [{
        id: "feat_partial_hole",
        kind: "extrude",
        operation: "new",
        plane: "XY",
        profile: {
          outer: rectangle(20, 20),
          holes: [{ kind: "circle", center: [9, 0], radius: 3 }],
        },
        distance: 5,
        requirementRefs: ["req_shape"],
      }],
    },
    {
      label: "无变化相交",
      expected: /intersect 未实质改变部件体积/,
      features: [
        {
          id: "feat_base",
          kind: "extrude",
          operation: "new",
          plane: "XY",
          profile: { outer: rectangle(20, 20), holes: [] },
          distance: 5,
          requirementRefs: ["req_shape"],
        },
        {
          id: "feat_noop_intersect",
          kind: "extrude",
          operation: "intersect",
          plane: "XY",
          profile: { outer: rectangle(40, 40), holes: [] },
          distance: 5,
          requirementRefs: ["req_shape"],
        },
      ],
    },
  ];

  for (const entry of cases) {
    const spec = baseSpec([{ id: `part_${entry.label === "空切" ? "cut" : entry.label === "空孔" ? "hole" : "intersect"}`, name: entry.label, features: entry.features }]);
    await mkdir(cadTmpRoot, { recursive: true });
    const tmpDir = await mkdtemp(path.join(cadTmpRoot, "tmp-text2cad-noop-"));
    try {
      const raw = canonicalText2CadDesignJson(spec);
      const input = path.join(tmpDir, "input.json");
      await writeFile(input, raw, { flag: "wx", mode: 0o600 });
      await assert.rejects(
        execFileAsync(process.execPath, [workerPath, input, tmpDir, sha256(raw)], {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
        }),
        entry.expected
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
});

test("Text2CAD 工人独立拒绝代码字段和受控目录外路径", async () => {
  const spec = baseSpec([{
    id: "part_safe",
    name: "Safe",
    features: [{
      id: "feat_safe",
      kind: "extrude",
      operation: "new",
      plane: "XY",
      profile: { outer: rectangle(10, 10), holes: [] },
      distance: 5,
      requirementRefs: ["req_shape"],
    }],
  }]);
  await mkdir(cadTmpRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(cadTmpRoot, "tmp-text2cad-injection-"));
  try {
    const unsafe = JSON.parse(canonicalText2CadDesignJson(spec));
    unsafe.parts[0].features[0].code = "process.exit(0)";
    const raw = JSON.stringify(unsafe);
    const input = path.join(tmpDir, "input.json");
    await writeFile(input, raw, { flag: "wx", mode: 0o600 });
    await assert.rejects(
      execFileAsync(process.execPath, [workerPath, input, tmpDir, sha256(raw)], {
        cwd: root,
        timeout: 10_000,
        maxBuffer: 512 * 1024,
      }),
      /未知字段/
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  await assert.rejects(
    execFileAsync(process.execPath, [workerPath, "/tmp/spec.json", "/tmp/output", "0".repeat(64)], {
      cwd: root,
      timeout: 10_000,
    }),
    /受控临时目录以外/
  );
});

test("Text2CAD 主进程隔离提交返回清单，Abort 时清理临时目录", async () => {
  const concurrentHealth = Array.from({ length: 12 }, () => text2cadRuntimeHealth());
  assert.equal(new Set(concurrentHealth).size, 1, "冷启动并发健康检查必须合并为同一次 OCCT/WASM 探测");
  assert.deepEqual(await concurrentHealth[0], { ok: true });
  const spec = baseSpec([{
    id: "part_render",
    name: "Render",
    features: [{
      id: "feat_render",
      kind: "extrude",
      operation: "new",
      plane: "XZ",
      origin: [0, 0, 0],
      profile: { outer: rectangle(12, 8), holes: [] },
      distance: 4,
      requirementRefs: ["req_shape"],
    }],
  }]);
  const rendered = await renderText2CadSpec(spec);
  try {
    assert.equal(rendered.manifest.hash, canonicalText2CadDesignHash(spec));
    assert.ok((await stat(path.join(rendered.tmpDir, "model.step"))).size > 128);
  } finally {
    await rm(rendered.tmpDir, { recursive: true, force: true });
  }

  const before = new Set((await readdir(cadTmpRoot).catch(() => [])).filter((name) => name.startsWith("tmp-text2cad-")));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    renderText2CadSpec(spec, controller.signal),
    (error) => error instanceof Text2CadRenderError && /几何计算超时/.test(error.message) && error.repairHint.length > 0
  );
  const after = new Set((await readdir(cadTmpRoot).catch(() => [])).filter((name) => name.startsWith("tmp-text2cad-")));
  assert.deepEqual(after, before);
});
