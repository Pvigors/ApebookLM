import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertText2CadTutorialExample,
  createText2CadTutorialExample,
} from "../../lib/text2cad-tutorial-example.ts";
import { discardText2CadTemp, renderText2CadSpec } from "../../lib/text2cad.ts";
import { assertText2CadEvidenceContract } from "../../lib/text2cad-evidence.ts";

test("教程型来源降级为明确标注、不可冒充来源约束的四孔安装平板", () => {
  const spec = createText2CadTutorialExample();
  assert.equal(spec.name, "教学示例：四孔安装平板");
  assert.equal(spec.parts.length, 1);
  assert.equal(spec.parts[0].material, "unspecified");
  assert.equal(spec.parts[0].features.length, 1);

  const feature = spec.parts[0].features[0];
  assert.equal(feature.operation, "new");
  assert.equal(feature.profile.outer.kind, "rectangle");
  assert.equal(feature.profile.outer.width, 100);
  assert.equal(feature.profile.outer.height, 60);
  assert.equal(feature.profile.outer.cornerRadius, 3);
  assert.equal(feature.profile.holes.length, 4);
  assert.deepEqual(feature.profile.holes.map((hole) => hole.radius), [3, 3, 3, 3]);
  assert.equal(feature.distance, 5);

  assert.ok(spec.assumptions.some((item) => item.includes("不代表任何来源中的设计约束")));
  assert.ok(spec.assumptions.some((item) => item.includes("不用于制造")));
  assert.ok(spec.requirements.filter((requirement) => requirement.id !== "req_model_input").every((requirement) => (
    requirement.sourceRefs.length === 1
    && requirement.sourceRefs[0] === "system:design-assumption"
  )));
  assert.ok(spec.parts.every((part) => part.features.every((item) => (
    item.requirementRefs.every((ref) => ref === "req_tutorial_example")
  ))));
  assert.doesNotThrow(() => assertText2CadTutorialExample(spec));
});

test("非 CAD 来源的无目标教学示例不伪称来源是 CAD 教程", () => {
  const spec = createText2CadTutorialExample("no_cad_target");
  const assumptions = spec.assumptions.join("\n");
  assert.match(assumptions, /未从所选来源识别出可执行的 CAD 建模对象与关键尺寸/);
  assert.doesNotMatch(assumptions, /来源仅包含通用 CAD 操作知识/);
  assert.doesNotThrow(() => assertText2CadTutorialExample(spec));
});

test("教学示例后置门禁拒绝伪造材料或把几何尺寸追溯到来源", () => {
  const materialTampered = structuredClone(createText2CadTutorialExample());
  materialTampered.parts[0].material = "aluminum";
  assert.throws(
    () => assertText2CadTutorialExample(materialTampered),
    /不得推断来源未提供的材料/
  );

  const traceTampered = structuredClone(createText2CadTutorialExample());
  traceTampered.requirements.push({
    id: "req_fake_source",
    text: "伪造的来源尺寸",
    sourceRefs: ["source:1"],
  });
  traceTampered.parts[0].features[0].requirementRefs = ["req_fake_source"];
  assert.throws(
    () => assertText2CadTutorialExample(traceTampered),
    /每个几何特征都必须只追溯系统教学假设/
  );
});

test("教学示例不把系统默认目标反向当成用户建模对象", () => {
  const spec = createText2CadTutorialExample();
  const labeled = {
    text: "",
    sourceReferenceMap: {},
    sourceReferenceBindings: {},
    sourceEvidenceMap: {},
    evidenceByRef: {},
  };
  const systemGoal = "请根据所选来源识别主要设计对象，生成证据最充分的受控参数化 CAD 模型。";
  assert.doesNotThrow(() => assertText2CadEvidenceContract(
    spec,
    labeled,
    systemGoal,
    { tutorialExample: true }
  ));
  assert.throws(
    () => assertText2CadEvidenceContract(spec, labeled, systemGoal),
    /Text2CAD 输出没有覆盖明确建模对象/
  );
});

test("四孔安装平板教学示例可生成真实有效几何", { timeout: 60_000 }, async () => {
  const rendered = await renderText2CadSpec(createText2CadTutorialExample());
  try {
    assert.equal(rendered.manifest.partCount, 1);
    assert.equal(rendered.manifest.validation.brepValid, true);
    assert.equal(rendered.manifest.validation.solidCount, 1);
    assert.equal(rendered.manifest.validation.interferenceFree, true);
    assert.deepEqual(rendered.manifest.bounds, [[-50, -30, 0], [50, 30, 5]]);
  } finally {
    await discardText2CadTemp(rendered.tmpDir);
  }
});
