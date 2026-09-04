import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CAD_TEMPLATES,
  CAD_TEMPLATE_ARTIFACT_MODE,
  CAD_TEMPLATE_EXPECTED_SOLID_COUNT,
} from "../../lib/cad-spec.ts";

const execFileAsync = promisify(execFile);

test("v3 固定模板无来源确定性生成，STEP 在隔离进程回读后才可发布", async () => {
  const code = String.raw`
    const pick = (module) => module.default ?? module;
    const requestPlan = pick(await import("./lib/cad-request-plan.ts"));
    const generator = pick(await import("./lib/cad-generator.ts"));
    const cad = pick(await import("./lib/cad.ts"));
    const { plan } = requestPlan.buildCadRequestPlan({
      mode: "fixed_template",
      templateId: "plate",
      parameters: { length: 120, width: 80, thickness: 5, hole_count: 4 },
      sources: [],
    });
    const output = await generator.generateCadModel("no-db", [], {
      mode: plan.mode,
      parameters: plan.parameters,
      requestPlan: plan,
    });
    try {
      console.log(JSON.stringify({
        title: output.title,
        template: output.manifest.template,
        validation: output.manifest.validation,
        stepValidation: output.manifest.stepValidation,
        step: output.manifest.files.step,
      }));
    } finally {
      await cad.discardCadTemp(output.tmpDir);
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--conditions=react-server",
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    code,
  ], { cwd: process.cwd(), timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.title, "安装板");
  assert.equal(result.template, "plate");
  assert.equal(result.validation.brepValid, true);
  assert.equal(result.validation.solidCount, 1);
  assert.equal(result.stepValidation.roundTripValid, true);
  assert.equal(result.stepValidation.validator, "replicad-isolated");
  assert.equal(result.stepValidation.unit, "mm");
  assert.deepEqual(result.stepValidation.bounds, [[0, 0, 0], [120, 80, 5]]);
  assert.equal(result.step.name, "model.step");
  assert.match(result.step.sha256, /^[a-f0-9]{64}$/);
});

test("七个固定模板与大直径轴套都以精确边界通过 STEP 往返", async () => {
  const code = String.raw`
    const pick = (module) => module.default ?? module;
    const cad = pick(await import("./lib/cad.ts"));
    const specModule = pick(await import("./lib/cad-spec.ts"));
    const cases = [
      { id: "plate", template: "plate" },
      { id: "mounting_bracket", template: "mounting_bracket" },
      { id: "enclosure", template: "enclosure" },
      { id: "flange", template: "flange" },
      { id: "shaft_adapter", template: "shaft_adapter" },
      { id: "shaft_adapter_100", template: "shaft_adapter", parameters: { outer_diameter: 100 } },
      { id: "humanoid_robot", template: "humanoid_robot" },
      { id: "concept_car", template: "concept_car" },
    ];
    const results = [];
    for (const entry of cases) {
      const output = await cad.renderCadSpec(specModule.normalizeCadDesignSpec({
        schemaVersion: 1,
        unit: "mm",
        template: entry.template,
        ...(entry.parameters ? { parameters: entry.parameters } : {}),
      }));
      try {
        results.push({
          id: entry.id,
          bounds: output.manifest.bounds,
          stepBounds: output.manifest.stepValidation.bounds,
          roundTripValid: output.manifest.stepValidation.roundTripValid,
          stepValidator: output.manifest.stepValidation.validator,
          stepUnit: output.manifest.stepValidation.unit,
          stepBrepValid: output.manifest.stepValidation.brepValid,
          artifactMode: output.manifest.artifactMode,
          partCount: output.manifest.partCount,
          solidCount: output.manifest.validation.solidCount,
          stepSolidCount: output.manifest.stepValidation.solidCount,
          faceCount: output.manifest.faceCount,
          stepFaceCount: output.manifest.stepValidation.faceCount,
          edgeCount: output.manifest.edgeCount,
          stepEdgeCount: output.manifest.stepValidation.edgeCount,
          volumeMm3: output.manifest.volumeMm3,
          stepVolumeMm3: output.manifest.stepValidation.volumeMm3,
        });
      } finally {
        await cad.discardCadTemp(output.tmpDir);
      }
    }
    console.log(JSON.stringify(results));
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--conditions=react-server",
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    code,
  ], { cwd: process.cwd(), timeout: 240_000, maxBuffer: 2 * 1024 * 1024 });
  const results = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  const expected = new Map([
    ["plate", [[0, 0, 0], [100, 60, 5]]],
    ["mounting_bracket", [[0, 0, 0], [80, 40, 50]]],
    ["enclosure", [[0, 0, 0], [120, 80, 40]]],
    ["flange", [[-50, -50, 0], [50, 50, 10]]],
    ["shaft_adapter", [[-15, -15, 0], [15, 15, 50]]],
    ["shaft_adapter_100", [[-50, -50, 0], [50, 50, 50]]],
    ["humanoid_robot", [[0, 0, 0], [650, 380, 1_700]]],
    ["concept_car", [[0, 0, 0], [4_500, 1_800, 1_450]]],
  ]);
  assert.equal(results.length, expected.size);
  assert.deepEqual(
    results.filter((result) => result.id !== "shaft_adapter_100").map((result) => result.id).sort(),
    [...CAD_TEMPLATES].sort(),
    "固定模板往返矩阵必须与现役模板全集严格一致"
  );
  for (const result of results) {
    const template = result.id === "shaft_adapter_100" ? "shaft_adapter" : result.id;
    const expectedSolidCount = CAD_TEMPLATE_EXPECTED_SOLID_COUNT[template];
    assert.equal(result.roundTripValid, true, `${result.id} 必须通过隔离 STEP 回读`);
    assert.equal(result.stepValidator, "replicad-isolated");
    assert.equal(result.stepUnit, "mm");
    assert.equal(result.stepBrepValid, true);
    assert.deepEqual(result.bounds, expected.get(result.id), `${result.id} 清单必须使用精确 B-Rep 边界`);
    assert.deepEqual(result.stepBounds, expected.get(result.id), `${result.id} STEP 回读边界必须与清单一致`);
    assert.equal(result.artifactMode, CAD_TEMPLATE_ARTIFACT_MODE[template]);
    assert.equal(result.partCount, expectedSolidCount);
    assert.equal(result.solidCount, expectedSolidCount);
    assert.equal(result.stepSolidCount, expectedSolidCount);
    assert.equal(result.stepFaceCount, result.faceCount);
    assert.equal(result.stepEdgeCount, result.edgeCount);
    assert.ok(Math.abs(result.stepVolumeMm3 - result.volumeMm3) <= Math.max(0.1, result.volumeMm3 * 0.001));
  }
});

test("用户显式选择的教学板在生成结果中保留教学身份", async () => {
  const code = String.raw`
    const pick = (module) => module.default ?? module;
    const requestPlan = pick(await import("./lib/cad-request-plan.ts"));
    const generator = pick(await import("./lib/cad-generator.ts"));
    const cad = pick(await import("./lib/cad.ts"));
    const { plan } = requestPlan.buildCadRequestPlan({
      mode: "fixed_template", templateId: "plate", tutorialExample: true,
      parameters: { length: 100, width: 60, thickness: 5, hole_count: 4, hole_diameter: 6 },
      allowAssumptions: true, sources: [],
    });
    const output = await generator.generateCadModel("no-db", [], { requestPlan: plan });
    try { console.log(JSON.stringify(output.modelSelection)); }
    finally { await cad.discardCadTemp(output.tmpDir); }
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", code,
  ], { cwd: process.cwd(), timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
  const selection = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(selection.tutorialExample, true);
  assert.equal(selection.tutorialContext, "explicit");
  assert.equal(selection.reason, "explicit_tutorial");
  assert.equal(selection.requestMode, "fixed_template");
});

test("v3 来源驱动禁止回退到 live chunks，缺少同次复核正文时在 provider 前失败", async () => {
  const code = String.raw`
    const pick = (module) => module.default ?? module;
    const requestPlan = pick(await import("./lib/cad-request-plan.ts"));
    const generator = pick(await import("./lib/cad-generator.ts"));
    const { plan } = requestPlan.buildCadRequestPlan({
      mode: "source_driven",
      allowAssumptions: false,
      sources: [{
        id: "source-a",
        title: "安装板规格书",
        content: "建模目标为安装板，长度 120mm，宽度 80mm，厚度 5mm。",
      }],
    });
    try {
      await generator.generateCadModel("no-db", ["source-a"], { requestPlan: plan });
      console.log("unexpected-success");
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", code,
  ], { cwd: process.cwd(), timeout: 15_000, maxBuffer: 1024 * 1024 });
  assert.match(stdout, /冻结正文/);
  assert.doesNotMatch(stdout, /unexpected-success/);
});
