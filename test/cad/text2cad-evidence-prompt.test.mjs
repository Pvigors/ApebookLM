import { test } from "node:test";
import assert from "node:assert/strict";
import { labelCadCorpusBlocks } from "../../lib/cad-source-corpus.ts";
import {
  assertText2CadEvidenceContract,
  assertText2CadStableObjectContract,
  bindFrozenPromptRequirement,
} from "../../lib/text2cad-evidence.ts";
import { normalizeText2CadSpec } from "../../lib/text2cad-spec.ts";

const instruction = "生成一个120×80×5mm的四孔安装板，孔径6mm，孔边距10mm";

function rawFourHolePlate() {
  return {
    schemaVersion: 2,
    engine: "text2cad",
    unit: "mm",
    name: "四孔安装板",
    requirements: [{
      id: "req_holes",
      text: "生成四个安装孔",
      sourceRefs: ["prompt:1"],
    }],
    assumptions: [],
    parts: [{
      id: "part_plate",
      name: "四孔安装板",
      material: "unspecified",
      color: "#6D5CE7",
      placement: { translate: [0, 0, 0], rotateDeg: [0, 0, 0] },
      features: [{
        id: "feat_base",
        kind: "extrude",
        operation: "new",
        plane: "XY",
        origin: [0, 0, 0],
        profile: {
          outer: { kind: "rectangle", center: [60, 40], width: 120, height: 80, cornerRadius: 0 },
          holes: [],
        },
        distance: 5,
        // 真实 provider 会出现：全局有 prompt requirement，但底板特征没连上该证据边。
        requirementRefs: ["req_model_input"],
      }, ...[
        [10, 10],
        [110, 10],
        [10, 70],
        [110, 70],
      ].map((center, index) => ({
        id: `feat_hole_${index + 1}`,
        kind: "extrude",
        operation: "cut",
        plane: "XY",
        origin: [0, 0, 0],
        profile: {
          outer: { kind: "circle", center, radius: 3 },
          holes: [],
        },
        distance: 5,
        requirementRefs: ["req_holes"],
      }))],
    }],
  };
}

test("bindFrozenPromptRequirement 只补 prompt 证据边，不改几何或原有引用", () => {
  const raw = rawFourHolePlate();
  const beforeGeometry = structuredClone(raw.parts);
  const bound = bindFrozenPromptRequirement(raw, true);

  assert.deepEqual(bound.parts[0].features[0].requirementRefs, [
    "req_model_input",
    "req_prompt_constraints",
  ]);
  assert.deepEqual(
    bound.requirements.find((entry) => entry.id === "req_prompt_constraints")?.sourceRefs,
    ["prompt:1"]
  );
  assert.deepEqual(
    { ...bound.parts[0], features: bound.parts[0].features.map(({ requirementRefs, ...feature }) => feature) },
    { ...beforeGeometry[0], features: beforeGeometry[0].features.map(({ requirementRefs, ...feature }) => feature) }
  );
  assert.deepEqual(raw.parts[0].features[0].requirementRefs, ["req_model_input"]);
});

test("四孔板的半径和孔中心可由用户数值做确定性算术，任意数值仍被拒绝", () => {
  const labeled = labelCadCorpusBlocks([]);
  const bound = normalizeText2CadSpec(bindFrozenPromptRequirement(rawFourHolePlate(), true));

  assert.doesNotThrow(() => assertText2CadEvidenceContract(bound, labeled, instruction));

  const invented = structuredClone(bound);
  invented.parts[0].features[1].profile.outer.center[0] = 47;
  assert.throws(
    () => assertText2CadEvidenceContract(invented, labeled, instruction),
    /数值 47 没有被其引用来源支持/
  );
});

test("未允许设计假设时，IR 即使正确标了 system:design-assumption 也必须拒绝", () => {
  const raw = rawFourHolePlate();
  raw.requirements = [{
    id: "req_assumption",
    text: "模型自行补齐尺寸",
    sourceRefs: ["system:design-assumption"],
  }];
  raw.assumptions = ["安装板采用默认尺寸"];
  raw.parts[0].features.forEach((feature) => {
    feature.requirementRefs = ["req_assumption"];
  });
  const spec = normalizeText2CadSpec(raw);
  const labeled = labelCadCorpusBlocks([]);

  assert.throws(
    () => assertText2CadEvidenceContract(spec, labeled, "生成安装板", { allowAssumptions: false }),
    /未允许设计假设/
  );
  assert.doesNotThrow(() => assertText2CadEvidenceContract(
    spec,
    labeled,
    "生成安装板",
    { allowAssumptions: true }
  ));
});

test("描述驱动不能借用勾选来源中的数值作为几何证据", () => {
  const labeled = labelCadCorpusBlocks([
    { sourceId: "unrelated", sourceTitle: "无关机械臂来源", body: "机械臂整体高度 600mm。" },
  ]);
  const raw = rawFourHolePlate();
  raw.requirements = [{ id: "req_source", text: "借用来源尺寸", sourceRefs: ["source:1"] }];
  raw.parts[0].features.forEach((feature) => {
    feature.requirementRefs = ["req_source"];
  });
  const spec = normalizeText2CadSpec(raw);
  assert.throws(
    () => assertText2CadEvidenceContract(spec, labeled, instruction, { promptDriven: true }),
    /描述驱动建模只能使用/
  );
});

test("未允许假设时，不能用无语义的数值加减为新几何尺寸作证", () => {
  const raw = rawFourHolePlate();
  raw.parts[0].features.push({
    id: "feat_invented_add",
    kind: "extrude",
    operation: "add",
    plane: "XY",
    origin: [0, 0, 5],
    profile: {
      outer: { kind: "rectangle", center: [60, 40], width: 120, height: 80, cornerRadius: 0 },
      holes: [],
    },
    distance: 200,
    requirementRefs: ["req_holes"],
  });
  const spec = normalizeText2CadSpec(bindFrozenPromptRequirement(raw, true));
  assert.throws(
    () => assertText2CadEvidenceContract(spec, labelCadCorpusBlocks([]), instruction, {
      promptDriven: true,
      allowAssumptions: false,
      targetObjectId: "plate",
    }),
    /数值 200 没有被其引用来源支持/
  );
});

test("来源驱动的几何证据与预检使用同一 targetEvidence，附录孔径不能被发布", () => {
  const labeled = labelCadCorpusBlocks([{
    sourceId: "plate-spec",
    sourceTitle: "安装板设计任务书",
    body: "设计对象为安装板。整体尺寸 120×80×5mm。附录：另一设备孔径 20mm。",
  }]);
  const raw = rawFourHolePlate();
  raw.requirements = [{ id: "req_source", text: "来源尺寸", sourceRefs: ["source:1"] }];
  raw.parts[0].features = [
    {
      ...raw.parts[0].features[0],
      requirementRefs: ["req_source"],
    },
    {
      id: "feat_appendix_hole",
      kind: "extrude",
      operation: "cut",
      plane: "XY",
      origin: [0, 0, 0],
      profile: { outer: { kind: "circle", center: [60, 40], radius: 10 }, holes: [] },
      distance: 5,
      requirementRefs: ["req_source"],
    },
  ];
  const spec = normalizeText2CadSpec(raw);
  assert.throws(
    () => assertText2CadEvidenceContract(spec, labeled, "按来源建模", {
      sourceDrivenDefault: true,
      validateSourceObjectIntent: true,
      targetObjectId: "plate",
      allowAssumptions: false,
    }),
    /数值 10 没有被其引用来源支持/
  );
});

test("冻结材料和工艺必须进入受控 IR，不得只显示为未执行文案", () => {
  const explicit = "生成 120×80×5mm 安装板，材料为6061铝合金，制造工艺采用CNC加工";
  const base = rawFourHolePlate();
  base.requirements = [];
  base.parts[0].features = [base.parts[0].features[0]];
  const wrong = normalizeText2CadSpec(bindFrozenPromptRequirement({
    ...base,
    process: "3D打印",
    parts: base.parts.map((part) => ({ ...part, material: "ABS塑料" })),
  }, true));
  assert.throws(
    () => assertText2CadEvidenceContract(wrong, labelCadCorpusBlocks([]), explicit, {
      promptDriven: true,
      allowAssumptions: false,
      targetObjectId: "plate",
    }),
    /未实现冻结材料约束/
  );

  const correct = structuredClone(wrong);
  correct.parts.forEach((part) => { part.material = "6061铝合金"; });
  correct.process = "CNC加工";
  assert.doesNotThrow(() => assertText2CadEvidenceContract(
    correct,
    labelCadCorpusBlocks([]),
    explicit,
    { promptDriven: true, allowAssumptions: false, targetObjectId: "plate" }
  ));
});

test("以原点为中心的四孔板用 ±50/±30 正确实现 10mm 孔边距", () => {
  const raw = rawFourHolePlate();
  raw.parts[0].features[0].profile.outer.center = [0, 0];
  const centers = [[-50, -30], [50, -30], [-50, 30], [50, 30]];
  raw.parts[0].features.slice(1).forEach((feature, index) => {
    feature.profile.outer.center = centers[index];
  });
  const spec = normalizeText2CadSpec(bindFrozenPromptRequirement(raw, true));
  const labeled = labelCadCorpusBlocks([]);
  assert.doesNotThrow(() => assertText2CadEvidenceContract(spec, labeled, instruction));

  const wrong = structuredClone(spec);
  wrong.parts[0].features[1].profile.outer.center[0] = -47;
  assert.throws(
    () => assertText2CadEvidenceContract(wrong, labeled, instruction),
    /数值 -?47 没有被其引用来源支持|明确边距/
  );
});

test("prompt 补边不能让 source:1 特征借用 source:2 的数值", () => {
  const labeled = labelCadCorpusBlocks([
    { sourceId: "s1", sourceTitle: "来源一", body: "安装板中心 X 坐标 60mm，高度 80mm，厚度 5mm。" },
    { sourceId: "s2", sourceTitle: "来源二", body: "安装板宽度 120mm。" },
  ]);
  const raw = rawFourHolePlate();
  raw.requirements = [{ id: "req_source", text: "来源一尺寸", sourceRefs: ["source:1"] }];
  raw.parts[0].features.forEach((feature) => {
    feature.requirementRefs = ["req_source"];
  });
  const spec = normalizeText2CadSpec(bindFrozenPromptRequirement(raw, false));

  assert.throws(
    () => assertText2CadEvidenceContract(spec, labeled, "生成安装板", { validateSourceObjectIntent: true }),
    /数值 120 没有被其引用来源支持/
  );
});

test("v3 稳定对象合同严格执行部件数和全部必需角色", () => {
  const simplePart = (id, name, plane = "XY") => ({
    id: `part_${id}`,
    name,
    material: "unspecified",
    color: "#6D5CE7",
    placement: { translate: [0, 0, 0], rotateDeg: [0, 0, 0] },
    features: [{
      id: `feat_${id}`,
      kind: "extrude",
      operation: "new",
      plane,
      origin: [0, 0, 0],
      profile: { outer: { kind: "rectangle", center: [0, 0], width: 20, height: 10, cornerRadius: 0 }, holes: [] },
      distance: 5,
      requirementRefs: ["req_shape"],
    }],
  });
  const normalizeParts = (name, parts) => normalizeText2CadSpec({
    schemaVersion: 2,
    engine: "text2cad",
    unit: "mm",
    name,
    requirements: [{ id: "req_shape", text: "概念形状", sourceRefs: ["prompt:1"] }],
    assumptions: [],
    parts,
  });

  const twoPartBracket = normalizeParts("安装支架", [
    simplePart("base", "安装支架底板", "XY"),
    simplePart("upright", "安装支架立板", "XZ"),
  ]);
  assert.throws(
    () => assertText2CadStableObjectContract(twoPartBracket, "mounting_bracket"),
    /没有覆盖预检建模对象/
  );

  const armWithoutWrist = normalizeParts("机械臂概念装配", [
    simplePart("base", "底座"),
    simplePart("shoulder", "肩部"),
    simplePart("upper", "上臂"),
    simplePart("forearm", "前臂"),
    simplePart("tool", "末端工具"),
  ]);
  assert.throws(
    () => assertText2CadStableObjectContract(armWithoutWrist, "robotic_arm"),
    /没有覆盖预检建模对象/
  );

  const fusedRoles = normalizeParts("机械臂概念装配", [
    simplePart("all_roles", "机械臂底座肩部上臂前臂腕部"),
    simplePart("two", "零件二"),
    simplePart("three", "零件三"),
    simplePart("four", "零件四"),
    simplePart("five", "零件五"),
  ]);
  assert.throws(
    () => assertText2CadStableObjectContract(fusedRoles, "robotic_arm"),
    /没有覆盖预检建模对象/
  );
});
