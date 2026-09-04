import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CAD_LIBRARY_VERSION,
  CAD_MANIFEST_VERSION,
  CAD_TEMPLATE_ARTIFACT_MODE,
  CAD_TEMPLATE_EXPECTED_SOLID_COUNT,
  CAD_TEMPLATES,
  TEXT2CAD_TEMPLATE,
  classifyCadTemplateInstruction,
  inferCadTemplateFromInstruction,
  resolveCadArtifactContract,
} from "../../lib/cad-library.ts";
import { CAD_MODEL_LIBRARY } from "../../components/studio-shared.ts";

const validation = (solidCount) => ({ brepValid: true, solidCount });
const modern = (template) => ({
  manifestVersion: CAD_MANIFEST_VERSION,
  libraryVersion: CAD_LIBRARY_VERSION,
  artifactMode: CAD_TEMPLATE_ARTIFACT_MODE[template],
  partCount: CAD_TEMPLATE_EXPECTED_SOLID_COUNT[template],
  validation: validation(CAD_TEMPLATE_EXPECTED_SOLID_COUNT[template]),
});

test("文件包、冻结快照和已发布模型库合同三方全等才通过", () => {
  for (const template of CAD_TEMPLATES) {
    const manifest = modern(template);
    const resolved = resolveCadArtifactContract(template, manifest, { ...manifest });
    assert.deepEqual(resolved, {
      template,
      manifestVersion: 2,
      libraryVersion: CAD_LIBRARY_VERSION,
      artifactMode: CAD_TEMPLATE_ARTIFACT_MODE[template],
      partCount: CAD_TEMPLATE_EXPECTED_SOLID_COUNT[template],
      legacy: false,
    });
  }

  const robot = modern("humanoid_robot");
  assert.equal(resolveCadArtifactContract("humanoid_robot", robot, { ...robot, partCount: 15 }), null);
  assert.equal(resolveCadArtifactContract("humanoid_robot", { ...robot, libraryVersion: 9 }, robot), null);
  assert.equal(resolveCadArtifactContract("concept_car", { ...modern("concept_car"), artifactMode: "single_part" }, modern("concept_car")), null);

  const publishedV1 = { ...modern("plate"), libraryVersion: 1 };
  assert.equal(resolveCadArtifactContract("plate", publishedV1, { ...publishedV1 })?.libraryVersion, 1);
});

test("只兼容四个合同字段完整缺失的旧五种单零件", () => {
  const legacy = { validation: validation(1) };
  assert.equal(resolveCadArtifactContract("plate", legacy, { ...legacy })?.legacy, true);
  assert.equal(resolveCadArtifactContract("humanoid_robot", { validation: validation(16) }, {}), null);
  assert.equal(resolveCadArtifactContract("plate", { ...legacy, partCount: 1 }, legacy), null);
  assert.equal(resolveCadArtifactContract("plate", legacy, { ...legacy, manifestVersion: 2 }), null);
});

test("Text2CAD 动态部件数必须与双份清单和 partsHash 一致", () => {
  const manifest = {
    manifestVersion: 2,
    libraryVersion: 2,
    artifactMode: "assembly",
    partCount: 3,
    partsHash: "a".repeat(64),
    validation: { brepValid: true, solidCount: 3 },
  };
  assert.deepEqual(resolveCadArtifactContract(TEXT2CAD_TEMPLATE, manifest, { ...manifest }), {
    template: TEXT2CAD_TEMPLATE,
    manifestVersion: 2,
    libraryVersion: 2,
    artifactMode: "assembly",
    partCount: 3,
    legacy: false,
  });
  assert.equal(resolveCadArtifactContract(TEXT2CAD_TEMPLATE, manifest, { ...manifest, partsHash: "b".repeat(64) }), null);
  assert.equal(resolveCadArtifactContract(TEXT2CAD_TEMPLATE, { ...manifest, partCount: 1 }, manifest), null);
  assert.equal(resolveCadArtifactContract(TEXT2CAD_TEMPLATE, { validation: { brepValid: true, solidCount: 1 } }, {}), null);
});

test("页面模型库与服务端模板的模式和部件数全等", () => {
  const ui = CAD_MODEL_LIBRARY.filter((model) => model.id !== "auto" && model.id !== "text2cad");
  assert.deepEqual(new Set(ui.map((model) => model.id)), new Set(CAD_TEMPLATES));
  for (const model of ui) {
    assert.equal(model.artifactMode, CAD_TEMPLATE_ARTIFACT_MODE[model.id]);
    assert.equal(model.partCount, CAD_TEMPLATE_EXPECTED_SOLID_COUNT[model.id]);
  }
});

test("自动匹配优先锁定明确的汽车和机器人对象词，冲突时不猜测", () => {
  assert.equal(inferCadTemplateFromInstruction("生成一台人形机器人，高 1700mm"), "humanoid_robot");
  assert.equal(inferCadTemplateFromInstruction("设计轴距 2800mm 的概念汽车"), "concept_car");
  assert.equal(inferCadTemplateFromInstruction("做一个机器人汽车联合装置"), undefined);
  assert.deepEqual(classifyCadTemplateInstruction("做一个机器人汽车联合装置"), {
    status: "ambiguous",
    templates: ["humanoid_robot", "concept_car"],
  });
  assert.equal(inferCadTemplateFromInstruction("做一个通用零件"), undefined);
});

test("几何工人的七种拓扑合同与共享真源保持一致", () => {
  const worker = fs.readFileSync(new URL("../../scripts/cad-worker.mjs", import.meta.url), "utf8");
  assert.match(worker, new RegExp(`manifestVersion:\\s*${CAD_MANIFEST_VERSION}`));
  assert.match(worker, new RegExp(`libraryVersion:\\s*${CAD_LIBRARY_VERSION}`));
  for (const template of CAD_TEMPLATES) {
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`${escaped}:[\\s\\S]*?expectedSolidCount:\\s*${CAD_TEMPLATE_EXPECTED_SOLID_COUNT[template]}[\\s\\S]*?artifactMode:\\s*"${CAD_TEMPLATE_ARTIFACT_MODE[template]}"`);
    assert.match(worker, pattern, template);
  }
});
