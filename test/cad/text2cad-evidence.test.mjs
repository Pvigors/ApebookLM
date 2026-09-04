import { test } from "node:test";
import assert from "node:assert/strict";
import { labelCadCorpusBlocks } from "../../lib/cad-source-corpus.ts";
import { createText2CadConceptFallback } from "../../lib/text2cad-concept-fallback.ts";
import { createText2CadTutorialExample } from "../../lib/text2cad-tutorial-example.ts";
import {
  assertText2CadEvidenceContract,
  assertText2CadObjectIntentCoverage,
  assertText2CadSourceBoundsCoverage,
} from "../../lib/text2cad-evidence.ts";
import { normalizeText2CadSpec } from "../../lib/text2cad-spec.ts";

test("明确汽车、人形机器人和设备外壳不能被四孔安装板冒充", () => {
  const plate = createText2CadTutorialExample();
  for (const instruction of ["生成一辆汽车", "生成一个人形机器人", "生成电子设备外壳"]) {
    assert.throws(
      () => assertText2CadObjectIntentCoverage(plate, instruction),
      /没有覆盖明确建模对象/
    );
  }
  assert.doesNotThrow(() => assertText2CadObjectIntentCoverage(plate, "生成安装平板"));

  const car = createText2CadConceptFallback("生成一辆概念汽车，整体尺寸 4500×1800×1500mm，轴距 2800mm");
  const humanoid = createText2CadConceptFallback("生成人形机器人概念装配，整体尺寸 600×300×1700mm");
  assert.ok(car);
  assert.ok(humanoid);
  assert.doesNotThrow(() => assertText2CadObjectIntentCoverage(car, "生成一辆汽车"));
  assert.doesNotThrow(() => assertText2CadObjectIntentCoverage(humanoid, "生成一个人形机器人"));
});

function simpleSpec(requirement) {
  return normalizeText2CadSpec({
    schemaVersion: 2,
    engine: "text2cad",
    unit: "mm",
    name: "安装平板",
    requirements: [requirement],
    assumptions: [],
    parts: [{
      id: "part_plate",
      name: "安装平板",
      material: "unspecified",
      color: "#6D5CE7",
      placement: { translate: [0, 0, 0], rotateDeg: [0, 0, 0] },
      features: [{
        id: "feat_plate",
        kind: "extrude",
        operation: "new",
        plane: "XY",
        origin: [0, 0, 0],
        profile: {
          outer: { kind: "rectangle", center: [0, 0], width: 100, height: 60, cornerRadius: 0 },
          holes: [],
        },
        distance: 5,
        requirementRefs: [requirement.id],
      }],
    }],
  });
}

test("特征数值不能把 source:2 的证据错绑到 source:1", () => {
  const labeled = labelCadCorpusBlocks([
    { sourceId: "s1", sourceTitle: "来源一", body: "安装板高度 60mm，厚度 5mm。" },
    { sourceId: "s2", sourceTitle: "来源二", body: "安装板宽度 100mm。" },
  ]);
  const wrong = simpleSpec({
    id: "req_source",
    text: "安装板尺寸",
    sourceRefs: ["source:1"],
  });
  assert.throws(
    () => assertText2CadEvidenceContract(wrong, labeled, "生成安装平板"),
    /数值 100 没有被其引用来源支持/
  );
});

test("来源驱动默认目标不能伪装成 prompt，且至少一项几何必须追溯真实来源", () => {
  const labeled = labelCadCorpusBlocks([
    { sourceId: "s1", sourceTitle: "安装板规格", body: "安装板宽度 100mm，高度 60mm，厚度 5mm。" },
  ]);
  const grounded = simpleSpec({
    id: "req_source",
    text: "来源安装板规格",
    sourceRefs: ["source:1"],
  });
  assert.doesNotThrow(() => assertText2CadEvidenceContract(
    grounded,
    labeled,
    "请根据所选来源识别主要设计对象",
    { sourceDrivenDefault: true }
  ));

  const fakePrompt = simpleSpec({
    id: "req_prompt",
    text: "系统默认目标",
    sourceRefs: ["prompt:1"],
  });
  assert.throws(
    () => assertText2CadEvidenceContract(
      fakePrompt,
      labeled,
      "请根据所选来源识别主要设计对象",
      { sourceDrivenDefault: true }
    ),
    /不得持久化为 prompt:1/
  );
});

test("来源里的汽车、人形机器人和外壳对象同样进入身份门，安装平板不能冒充", () => {
  for (const body of [
    "本项目需要设计一辆汽车，整体尺寸 4500×1800×1500mm。",
    "设计 humanoid robot assembly，整体高度 1700mm。",
    "电子设备外壳尺寸 120×80×35mm。",
  ]) {
    const labeled = labelCadCorpusBlocks([{ sourceId: "s1", sourceTitle: "真实设计规格", body }]);
    const wrong = simpleSpec({
      id: "req_source_object",
      text: "来源设计对象",
      sourceRefs: ["source:1"],
    });
    assert.throws(
      () => assertText2CadEvidenceContract(
        wrong,
        labeled,
        "请根据所选来源识别主要设计对象",
        { sourceDrivenDefault: true }
      ),
      /没有覆盖明确建模对象/
    );
  }
});

test("来源标题与 OCR 词内空白也进入对象身份门", () => {
  for (const { title, body } of [
    { title: "汽车设计规格", body: "主体尺寸 100×60，厚度 5mm。" },
    { title: "人形机器人设计规格", body: "主体尺寸 100×60，厚度 5mm。" },
    { title: "电子设备外壳设计规格", body: "主体尺寸 100×60，厚度 5mm。" },
    { title: "OCR 规格", body: "一辆汽 车，主体尺寸 100×60，厚度 5mm。" },
    { title: "OCR 规格", body: "人 形 机 器 人，主体尺寸 100×60，厚度 5mm。" },
    { title: "OCR 规格", body: "human\noid robot，主体尺寸 100×60，厚度 5mm。" },
  ]) {
    const labeled = labelCadCorpusBlocks([{ sourceId: "s1", sourceTitle: title, body }]);
    const wrong = simpleSpec({ id: "req_source_object", text: "来源设计对象", sourceRefs: ["source:1"] });
    assert.throws(
      () => assertText2CadEvidenceContract(
        wrong,
        labeled,
        "请根据所选来源识别主要设计对象",
        { sourceDrivenDefault: true }
      ),
      /没有覆盖明确建模对象/
    );
  }
});

test("normalized 与 compact 对象分类取并集，且不同来源边界不会拼词", () => {
  const mixed = labelCadCorpusBlocks([{
    sourceId: "s1",
    sourceTitle: "汽车设计规格",
    body: "另需人 形 机 器 人，主体尺寸 100×60，厚度 5mm。",
  }]);
  const car = createText2CadConceptFallback("生成一辆概念汽车，整体尺寸 4500×1800×1500mm，轴距 2800mm");
  assert.throws(
    () => assertText2CadEvidenceContract(
      car,
      mixed,
      "请根据所选来源识别主要设计对象",
      { sourceDrivenDefault: true }
    ),
    /建模对象存在冲突/
  );

  const separated = labelCadCorpusBlocks([
    { sourceId: "a", sourceTitle: "分段汽", body: "主体尺寸 100×60，厚度 5mm。" },
    { sourceId: "b", sourceTitle: "车分段", body: "主体尺寸 100×60，厚度 5mm。" },
  ]);
  const plate = simpleSpec({ id: "req_source", text: "来源尺寸", sourceRefs: ["source:1", "source:2"] });
  assert.doesNotThrow(() => assertText2CadEvidenceContract(
    plate,
    separated,
    "请根据所选来源识别主要设计对象",
    { sourceDrivenDefault: true }
  ));
});

test("泵体、阀体和异形夹持块等开放对象也不能被安装平板冒充", () => {
  for (const { title, body } of [
    { title: "泵体设计规格", body: "创建一个泵体模型，主体尺寸 100×60，厚度 5mm。" },
    { title: "阀体设计要求", body: "创建一个阀体模型，主体尺寸 100×60，厚度 5mm。" },
    { title: "异形夹持块设计", body: "创建一个异形夹持块模型，主体尺寸 100×60，厚度 5mm。" },
    { title: "泵体规格书", body: "主体尺寸 100×60，厚度 5mm。" },
    { title: "阀体技术要求", body: "主体尺寸 100×60，厚度 5mm。" },
    { title: "夹持块图纸", body: "主体尺寸 100×60，厚度 5mm。" },
  ]) {
    const labeled = labelCadCorpusBlocks([{ sourceId: "s1", sourceTitle: title, body }]);
    const wrong = simpleSpec({ id: "req_unknown_object", text: "来源对象", sourceRefs: ["source:1"] });
    assert.throws(
      () => assertText2CadEvidenceContract(
        wrong,
        labeled,
        "请根据所选来源识别主要设计对象",
        { sourceDrivenDefault: true }
      ),
      /没有覆盖明确建模对象/
    );
  }
});

test("显式未知对象、OCR 空白和 known+unknown 混合请求同样 fail closed", () => {
  const plate = createText2CadTutorialExample();
  for (const instruction of [
    "生成一个泵体模型，主体尺寸 100×60，厚度 5mm",
    "设计异形夹持块零件，主体尺寸 100×60，厚度 5mm",
    "创建一个泵 体模型，主体尺寸 100×60，厚度 5mm",
    "设计异 形 夹 持 块零件，主体尺寸 100×60，厚度 5mm",
    "generate a pump housing model, 100 by 60 by 5 mm",
    "design valve body part, 100 by 60 by 5 mm",
    "做一个泵体，尺寸 100×60×5mm",
    "帮我做个阀体，尺寸 100×60×5mm",
    "请画泵体，尺寸 100×60×5mm",
    "需要一个夹持块，尺寸 100×60×5mm",
  ]) {
    assert.throws(() => assertText2CadObjectIntentCoverage(plate, instruction), /没有覆盖明确建模对象/);
  }
  assert.throws(
    () => assertText2CadObjectIntentCoverage(
      createText2CadConceptFallback("生成一辆概念汽车，整体尺寸 4500×1800×1500mm，轴距 2800mm"),
      "生成汽车并设计一个泵体模型"
    ),
    /建模对象存在冲突/
  );
});

test("同一对象的简称与修饰词标签会折叠，不误报冲突", () => {
  const labeled = labelCadCorpusBlocks([{
    sourceId: "s1",
    sourceTitle: "泵体设计规格",
    body: "创建一个高压泵体模型，宽度 100mm，高度 60mm，厚度 5mm。",
  }]);
  const correct = simpleSpec({ id: "req_pump", text: "高压泵体", sourceRefs: ["source:1"] });
  correct.name = "高压泵体";
  correct.parts[0].name = "高压泵体";
  assert.doesNotThrow(() => assertText2CadEvidenceContract(
    correct,
    labeled,
    "请根据所选来源识别主要设计对象",
    { sourceDrivenDefault: true }
  ));
});

test("显式补充颜色或风格不能关闭来源对象身份校验", () => {
  const labeled = labelCadCorpusBlocks([{
    sourceId: "s1",
    sourceTitle: "汽车设计规格",
    body: "整车尺寸 4500×1800×1500mm。",
  }]);
  const wrong = simpleSpec({ id: "req_source", text: "来源整车", sourceRefs: ["source:1"] });
  assert.throws(
    () => assertText2CadEvidenceContract(
      wrong,
      labeled,
      "请使用蓝色",
      { validateSourceObjectIntent: true }
    ),
    /没有覆盖明确建模对象/
  );
});

test("显式补充说明时仍必须至少一项几何追溯真实来源", () => {
  const labeled = labelCadCorpusBlocks([{
    sourceId: "s1",
    sourceTitle: "安装平板规格",
    body: "安装平板宽 100mm，高 60mm，厚 5mm。",
  }]);
  const promptOnly = simpleSpec({
    id: "req_prompt_only",
    text: "蓝色安装平板",
    sourceRefs: ["prompt:1", "system:design-assumption"],
  });
  promptOnly.assumptions = ["首版尺寸假设"];
  assert.throws(
    () => assertText2CadEvidenceContract(
      promptOnly,
      labeled,
      "请使用蓝色",
      { validateSourceObjectIntent: true }
    ),
    /至少需要一个几何特征追溯真实 source:N/
  );
});

test("source:N 与 assumption 同时引用也不能覆盖来源明确尺寸", () => {
  const labeled = labelCadCorpusBlocks([{
    sourceId: "s1",
    sourceTitle: "安装平板规格",
    body: "安装平板整体尺寸 100×60×5mm。",
  }]);
  const wrong = simpleSpec({
    id: "req_mixed",
    text: "来源尺寸与假设",
    sourceRefs: ["source:1", "prompt:1", "system:design-assumption"],
  });
  wrong.assumptions = ["错误地用假设覆盖来源尺寸"];
  wrong.parts[0].features[0].profile.outer.width = 70;
  wrong.parts[0].features[0].profile.outer.height = 40;
  wrong.parts[0].features[0].distance = 3;
  wrong.parts[0].features[0].origin = [100, 60, 5];
  assert.throws(
    () => assertText2CadEvidenceContract(
      wrong,
      labeled,
      "请使用蓝色",
      { validateSourceObjectIntent: true }
    ),
    /未采用来源 source:1 的明确尺寸/
  );
});

test("来源 cm、m、inch 尺寸统一换算为 mm 后允许正确规格", () => {
  for (const { body, sizes } of [
    { body: "安装平板宽度 10cm，高度 6cm，厚度 0.5cm。", sizes: [100, 60, 5] },
    { body: "安装平板宽度 0.1m，高度 0.06m，厚度 0.005m。", sizes: [100, 60, 5] },
    { body: "安装平板宽度 2in，高度 1inch，厚度 0.2英寸。", sizes: [50.8, 25.4, 5.08] },
  ]) {
    const labeled = labelCadCorpusBlocks([{ sourceId: "s1", sourceTitle: "安装平板规格", body }]);
    const spec = simpleSpec({
      id: "req_units",
      text: "来源尺寸",
      sourceRefs: ["source:1", "system:design-assumption"],
    });
    spec.assumptions = ["未说明的圆角使用首版假设"];
    spec.parts[0].features[0].profile.outer.width = sizes[0];
    spec.parts[0].features[0].profile.outer.height = sizes[1];
    spec.parts[0].features[0].distance = sizes[2];
    assert.doesNotThrow(() => assertText2CadEvidenceContract(
      spec,
      labeled,
      "请使用蓝色",
      { validateSourceObjectIntent: true }
    ));
  }
});

test("宽高厚按字段语义绑定，不能只把相同数字塞进其它尺寸字段", () => {
  const labeled = labelCadCorpusBlocks([{
    sourceId: "s1",
    sourceTitle: "安装平板规格",
    body: "安装平板宽度 100mm，高度 60mm，厚度 5mm。",
  }]);
  for (const [width, height, thickness] of [[60, 100, 5], [100, 5, 60]]) {
    const wrong = simpleSpec({
      id: "req_semantic_dims",
      text: "来源尺寸",
      sourceRefs: ["source:1", "system:design-assumption"],
    });
    wrong.assumptions = ["错误字段占位"];
    wrong.parts[0].features[0].profile.outer.width = width;
    wrong.parts[0].features[0].profile.outer.height = height;
    wrong.parts[0].features[0].distance = thickness;
    assert.throws(
      () => assertText2CadEvidenceContract(
        wrong,
        labeled,
        "请使用蓝色",
        { validateSourceObjectIntent: true }
      ),
      /未采用来源 source:1 的明确尺寸/
    );
  }
});

test("孔距 tuple 绑定孔中心跨度，不会被误当成零件外形尺寸", () => {
  const labeled = labelCadCorpusBlocks([{
    sourceId: "s1",
    sourceTitle: "安装平板规格",
    body: "安装平板整体尺寸 100×60×5mm，四孔孔距 80×40mm。",
  }]);
  const spec = simpleSpec({
    id: "req_hole_spacing",
    text: "外形与孔距",
    sourceRefs: ["source:1", "system:design-assumption"],
  });
  spec.assumptions = ["孔径采用首版假设"];
  spec.parts[0].features[0].profile.holes = [
    { kind: "circle", center: [-40, -20], radius: 3 },
    { kind: "circle", center: [40, -20], radius: 3 },
    { kind: "circle", center: [-40, 20], radius: 3 },
    { kind: "circle", center: [40, 20], radius: 3 },
  ];
  assert.doesNotThrow(() => assertText2CadEvidenceContract(
    spec,
    labeled,
    "请使用蓝色",
    { validateSourceObjectIntent: true }
  ));
  spec.parts[0].features[0].profile.holes[1].center = [35, -20];
  spec.parts[0].features[0].profile.holes[2].center = [-40, 15];
  spec.parts[0].features[0].profile.holes[3].center = [35, 15];
  assert.throws(
    () => assertText2CadEvidenceContract(
      spec,
      labeled,
      "请使用蓝色",
      { validateSourceObjectIntent: true }
    ),
    /未采用来源 source:1 的明确尺寸/
  );
});

test("槽和凸台 tuple 绑定对应 cut/add 轮廓，不误当整体外形", () => {
  const labeled = labelCadCorpusBlocks([{
    sourceId: "s1",
    sourceTitle: "安装平板规格",
    body: "安装平板整体尺寸 100×60×5mm，中央矩形槽尺寸 20×10mm。",
  }]);
  const spec = simpleSpec({
    id: "req_slot",
    text: "外形与矩形槽",
    sourceRefs: ["source:1", "system:design-assumption"],
  });
  spec.assumptions = ["槽深采用贯穿首版假设"];
  spec.parts[0].features.push({
    id: "feat_slot",
    kind: "extrude",
    operation: "cut",
    plane: "XY",
    origin: [0, 0, 0],
    profile: {
      outer: { kind: "rectangle", center: [0, 0], width: 20, height: 10, cornerRadius: 0 },
      holes: [],
    },
    distance: 5,
    requirementRefs: ["req_slot"],
  });
  assert.doesNotThrow(() => assertText2CadEvidenceContract(
    spec,
    labeled,
    "请使用蓝色",
    { validateSourceObjectIntent: true }
  ));
  spec.parts[0].features[1].profile.outer.width = 18;
  assert.throws(
    () => assertText2CadEvidenceContract(
      spec,
      labeled,
      "请使用蓝色",
      { validateSourceObjectIntent: true }
    ),
    /未采用来源 source:1 的明确尺寸/
  );
});

test("装配件最终包围盒必须采用来源整体尺寸，不能用 assumption 覆盖汽车规格", () => {
  const labeled = labelCadCorpusBlocks([{
    sourceId: "s1",
    sourceTitle: "汽车设计规格",
    body: "汽车整体尺寸 5200×2100×1800mm，轴距 3200mm。",
  }]);
  assert.throws(
    () => assertText2CadSourceBoundsCoverage([[0, 0, 0], [4500, 1800, 1500]], labeled),
    /最终包围盒未采用来源 source:1 的明确尺寸/
  );
  assert.doesNotThrow(
    () => assertText2CadSourceBoundsCoverage([[0, 0, 0], [5200, 2100, 1800]], labeled)
  );

  const withPartDimensions = labelCadCorpusBlocks([{
    sourceId: "s1",
    sourceTitle: "汽车设计规格",
    body: "汽车整体尺寸 4500×1800×1500mm，车轮宽度 245mm，车轮直径 700mm。",
  }]);
  assert.doesNotThrow(
    () => assertText2CadSourceBoundsCoverage([[0, 0, 0], [4500, 1800, 1500]], withPartDimensions)
  );
  for (const body of [
    "汽车整体设计要求：车轮尺寸 700×245mm。",
    "整车方案包含四个车轮，车轮规格 700×245mm。",
  ]) {
    const wheelOnly = labelCadCorpusBlocks([{
      sourceId: "s1",
      sourceTitle: "汽车设计规格",
      body,
    }]);
    assert.doesNotThrow(
      () => assertText2CadSourceBoundsCoverage([[0, 0, 0], [4500, 1800, 1500]], wheelOnly)
    );
  }
});
