import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import opencascade from "replicad-opencascadejs";
import { cast, importSTEP, iterTopo, makeSphere, measureVolume, setOC } from "replicad";
import {
  canonicalCadDesignHash,
  canonicalCadDesignJson,
  normalizeCadDesignSpec,
} from "../../lib/cad-spec.ts";
import { cadRuntimeHealth, renderCadSpec } from "../../lib/cad.ts";
import { parseTopViewDxf } from "../helpers/dxf.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const cadRoot = path.join(root, ".data", "cad-tmp");
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

test("受控 CAD 工人生成有效 STEP/STL/二维 DXF/预览网格，且清单闭环", async () => {
  await mkdir(cadRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(cadRoot, "tmp-test-"));
  try {
    const spec = normalizeCadDesignSpec({
      schemaVersion: 1,
      unit: "mm",
      template: "flange",
      name: "测试连接法兰",
      parameters: {
        outer_diameter: 110,
        bore_diameter: 32,
        bolt_circle_diameter: 78,
      },
    });
    const canonical = canonicalCadDesignJson(spec);
    const hash = canonicalCadDesignHash(spec);
    const input = path.join(tmpDir, "input.json");
    await writeFile(input, canonical, { flag: "wx", mode: 0o600 });
    await execFileAsync(
      process.execPath,
      [path.join(root, "scripts", "cad-worker.mjs"), input, tmpDir, hash],
      { cwd: root, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }
    );
    const manifest = JSON.parse(await readFile(path.join(tmpDir, "manifest.json"), "utf8"));
    const mesh = JSON.parse(await readFile(path.join(tmpDir, "mesh.json"), "utf8"));
    const dxf = parseTopViewDxf(await readFile(path.join(tmpDir, "top-view.dxf")));
    assert.equal(manifest.hash, hash);
    assert.equal(manifest.manifestVersion, 2);
    assert.equal(manifest.libraryVersion, 2);
    assert.equal(manifest.template, "flange");
    assert.equal(manifest.artifactMode, "single_part");
    assert.equal(manifest.partCount, 1);
    assert.equal(manifest.validation.brepValid, true);
    assert.ok(manifest.volumeMm3 > 0);
    assert.ok(manifest.triangleCount > 0);
    assert.match(manifest.files.step.sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.files.stl.sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.files.dxf.sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.dxfProjection.lineCount, dxf.lines.length);
    assert.deepEqual(manifest.dxfProjection.bounds, dxf.bounds);
    const [minimum, maximum] = dxf.bounds;
    assert.ok(maximum[0] - minimum[0] >= 109.8 && maximum[0] - minimum[0] <= 110.1);
    assert.ok(maximum[1] - minimum[1] >= 109.8 && maximum[1] - minimum[1] <= 110.1);
    assert.equal(mesh.triangles.length / 3, manifest.triangleCount);
    assert.equal(mesh.vertices.length, mesh.normals.length);
    assert.ok((await stat(path.join(tmpDir, "model.step"))).size > 128);
    assert.ok((await stat(path.join(tmpDir, "model.stl"))).size > 84);
    assert.ok((await stat(path.join(tmpDir, "top-view.dxf"))).size > 128);
    assert.deepEqual(JSON.parse(await readFile(path.join(tmpDir, "design-spec.json"), "utf8")), JSON.parse(canonical));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("七种固定模板都生成可独立回读的毫米 DXF 顶视图", async () => {
  for (const template of [
    "plate",
    "mounting_bracket",
    "enclosure",
    "flange",
    "shaft_adapter",
    "humanoid_robot",
    "concept_car",
  ]) {
    const rendered = await renderCadSpec(normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template }));
    try {
      const dxf = parseTopViewDxf(await readFile(path.join(rendered.tmpDir, "top-view.dxf")));
      assert.equal(rendered.manifest.dxfProjection.unit, "mm", template);
      assert.equal(rendered.manifest.dxfProjection.view, "top", template);
      assert.equal(rendered.manifest.dxfProjection.lineCount, dxf.lines.length, template);
      assert.deepEqual(rendered.manifest.dxfProjection.bounds, dxf.bounds, template);
      assert.deepEqual(dxf.layers, ["MODEL"], template);
      assert.ok(dxf.bounds[1][0] > dxf.bounds[0][0], `${template} 的 DXF X 边界必须有宽度`);
      assert.ok(dxf.bounds[1][1] > dxf.bounds[0][1], `${template} 的 DXF Y 边界必须有高度`);
    } finally {
      await rm(rendered.tmpDir, { recursive: true, force: true });
    }
  }
});

test("机器人与概念汽车生成固定实体数、严格整机边界和 assembly 清单", async () => {
  const cases = [
    { template: "humanoid_robot", solidCount: 16, size: [650, 380, 1_700] },
    { template: "concept_car", solidCount: 5, size: [4_500, 1_800, 1_450] },
  ];
  await ensureOc();
  for (const entry of cases) {
    const { tmpDir, manifest } = await renderCadSpec(normalizeCadDesignSpec({
      schemaVersion: 1,
      unit: "mm",
      template: entry.template,
    }));
    try {
      assert.equal(manifest.manifestVersion, 2);
      assert.equal(manifest.libraryVersion, 2);
      assert.equal(manifest.artifactMode, "assembly");
      assert.equal(manifest.partCount, entry.solidCount);
      assert.equal(manifest.validation.solidCount, entry.solidCount);
      assert.deepEqual(manifest.bounds, [[0, 0, 0], entry.size]);

      const step = await readFile(path.join(tmpDir, "model.step"));
      const shape = await importSTEP(new Blob([step]));
      const solids = [...iterTopo(shape.wrapped, "solid")].map((solid) => cast(solid));
      assert.equal(solids.length, entry.solidCount);
      for (let left = 0; left < solids.length; left++) {
        const leftBounds = solids[left].boundingBox.bounds;
        for (let right = left + 1; right < solids.length; right++) {
          const rightBounds = solids[right].boundingBox.bounds;
          const separated = [0, 1, 2].some((axis) => (
            leftBounds[1][axis] < rightBounds[0][axis] - 0.25
            || rightBounds[1][axis] < leftBounds[0][axis] - 0.25
          ));
          assert.equal(separated, true, `${entry.template} 的实体 ${left}/${right} 不得相交`);
        }
      }
      for (const solid of solids) solid.delete();
      const measured = shape.boundingBox.bounds;
      const measuredSize = measured[1].map((value, axis) => value - measured[0][axis]);
      assert.ok(measured[0].every((value) => Math.abs(value) <= 0.25), `${entry.template} 最小边界必须位于原点`);
      assert.ok(
        measuredSize.every((value, axis) => Math.abs(value - entry.size[axis]) <= 0.25),
        `${entry.template} STEP 边界必须等于规格尺寸`
      );
      shape.delete();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
});

test("CAD 工人对绕过规格层的总成坏参数仍以真实边界 fail closed", async () => {
  await mkdir(cadRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(cadRoot, "tmp-bad-assembly-"));
  try {
    const draft = JSON.parse(canonicalCadDesignJson(normalizeCadDesignSpec({
      schemaVersion: 1,
      unit: "mm",
      template: "concept_car",
    })));
    draft.parameters.overall_length.value = 1_000;
    const raw = JSON.stringify(draft);
    const hash = createHash("sha256").update(raw).digest("hex");
    const input = path.join(tmpDir, "input.json");
    await writeFile(input, raw, { flag: "wx", mode: 0o600 });
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join(root, "scripts", "cad-worker.mjs"), input, tmpDir, hash],
        { cwd: root, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }
      ),
      /实际包围盒超出规格|总成包围盒/
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("全局扩到 12000mm 不会放宽旧五种模板的工人上限", async () => {
  await mkdir(cadRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(cadRoot, "tmp-old-template-limit-"));
  try {
    const draft = JSON.parse(canonicalCadDesignJson(normalizeCadDesignSpec({
      schemaVersion: 1,
      unit: "mm",
      template: "plate",
    })));
    draft.parameters.length.value = 2_001;
    const raw = JSON.stringify(draft);
    const hash = createHash("sha256").update(raw).digest("hex");
    const input = path.join(tmpDir, "input.json");
    await writeFile(input, raw, { flag: "wx", mode: 0o600 });
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join(root, "scripts", "cad-worker.mjs"), input, tmpDir, hash],
        { cwd: root, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }
      ),
      /模板工人上限/
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CAD 工人拒绝受控目录外的输入和输出", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [path.join(root, "scripts", "cad-worker.mjs"), "/tmp/spec.json", "/tmp/output", "0".repeat(64)],
      { cwd: root, timeout: 10_000 }
    ),
    /受控临时目录以外/
  );
});

test("几何工人按真实拓扑拒绝被密集法兰孔切开的多实体", async () => {
  await mkdir(cadRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(cadRoot, "tmp-multisolid-"));
  try {
    const draft = JSON.parse(canonicalCadDesignJson(normalizeCadDesignSpec({
      schemaVersion: 1,
      unit: "mm",
      template: "flange",
    })));
    Object.assign(draft.parameters, {
      outer_diameter: { ...draft.parameters.outer_diameter, value: 100 },
      bore_diameter: { ...draft.parameters.bore_diameter, value: 10 },
      bolt_circle_diameter: { ...draft.parameters.bolt_circle_diameter, value: 70 },
      bolt_hole_diameter: { ...draft.parameters.bolt_hole_diameter, value: 20 },
      bolt_hole_count: { ...draft.parameters.bolt_hole_count, value: 64 },
    });
    const raw = JSON.stringify(draft);
    const hash = createHash("sha256").update(raw).digest("hex");
    const input = path.join(tmpDir, "input.json");
    await writeFile(input, raw, { flag: "wx", mode: 0o600 });
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join(root, "scripts", "cad-worker.mjs"), input, tmpDir, hash],
        // OCCT 在全量门禁与另一个几何文件并发时会比单跑慢约 20%；30s 会在
        // 正确拒绝前几百毫秒把子进程杀掉，丢失真正的拓扑错误。运行时仍有独立硬限。
        { cwd: root, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
      ),
      /单一连通实体/
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("CAD 运行时健康检查真实加载依赖并生成最小多实体", async () => {
  const concurrentHealth = Array.from({ length: 12 }, () => cadRuntimeHealth());
  assert.equal(new Set(concurrentHealth).size, 1, "固定模板冷启动并发体检也必须合并为同一次 OCCT/WASM 探测");
  assert.deepEqual(await concurrentHealth[0], { ok: true });
});

test("外层 AbortSignal 会终止几何子进程并清理临时目录", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    renderCadSpec(
      normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "plate" }),
      controller.signal
    ),
    /CAD 几何计算超时/
  );
});

test("轴套默认紧定螺钉孔真实贯通到过渡内孔，不留下实体隔膜", async () => {
  await mkdir(cadRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(cadRoot, "tmp-shaft-"));
  try {
    const spec = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "shaft_adapter" });
    const canonical = canonicalCadDesignJson(spec);
    const hash = canonicalCadDesignHash(spec);
    const input = path.join(tmpDir, "input.json");
    await writeFile(input, canonical, { flag: "wx", mode: 0o600 });
    await execFileAsync(
      process.execPath,
      [path.join(root, "scripts", "cad-worker.mjs"), input, tmpDir, hash],
      { cwd: root, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }
    );
    const manifest = JSON.parse(await readFile(path.join(tmpDir, "manifest.json"), "utf8"));
    assert.equal(manifest.validation.solidCount, 1);

    await ensureOc();
    const step = await readFile(path.join(tmpDir, "model.step"));
    const shape = await importSTEP(new Blob([step]));
    const probe = makeSphere(0.1).translate(5.3, 0, 25);
    const remaining = shape.intersect(probe);
    assert.ok(measureVolume(remaining) < 1e-8, "紧定孔到内孔之间不应残留实体材料");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
