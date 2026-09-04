import { test } from "node:test";
import assert from "node:assert/strict";
import { createText2CadConceptFallback } from "../../lib/text2cad-concept-fallback.ts";
import {
  assertText2CadInstructionCoverage,
  assertText2CadRenderedBoundsCoverage,
} from "../../lib/text2cad-spec.ts";
import { discardText2CadTemp, renderText2CadSpec } from "../../lib/text2cad.ts";

test("Text2CAD 概念汽车兜底保持轴距、四轮、无干涉和精确整车包围盒", { timeout: 60_000 }, async () => {
  const instruction = "生成一辆概念汽车，整体尺寸 4500×1800×1500mm，轴距 2800mm，四轮布局，车身用分段棱面表达";
  const spec = createText2CadConceptFallback(instruction);
  assert.ok(spec);
  assert.equal(spec.parts.length, 5);
  assert.deepEqual(
    spec.parts.filter((part) => part.id.startsWith("part_wheel_")).map((part) => part.placement.translate[0]).sort((a, b) => a - b),
    [-1400, -1400, 1400, 1400]
  );
  assert.doesNotThrow(() => assertText2CadInstructionCoverage(spec, instruction));
  const rendered = await renderText2CadSpec(spec);
  try {
    assert.equal(rendered.manifest.partCount, 5);
    assert.equal(rendered.manifest.validation.interferenceFree, true);
    assert.deepEqual(rendered.manifest.bounds, [[-2250, -900, 0], [2250, 900, 1500]]);
    assert.doesNotThrow(() => assertText2CadRenderedBoundsCoverage(rendered.manifest.bounds, instruction));
  } finally {
    await discardText2CadTemp(rendered.tmpDir);
  }
});

test("Text2CAD 人形机器人兜底保持对称部件、无干涉和精确身高", { timeout: 60_000 }, async () => {
  const instruction = "生成人形机器人概念装配，整体尺寸 600×300×1700mm";
  const spec = createText2CadConceptFallback(instruction);
  assert.ok(spec);
  assert.equal(spec.parts.length, 7);
  assert.doesNotThrow(() => assertText2CadInstructionCoverage(spec, instruction));
  const rendered = await renderText2CadSpec(spec);
  try {
    assert.equal(rendered.manifest.partCount, 7);
    assert.equal(rendered.manifest.validation.interferenceFree, true);
    assert.deepEqual(rendered.manifest.bounds, [[-300, -150, 0], [300, 150, 1700]]);
    assert.doesNotThrow(() => assertText2CadRenderedBoundsCoverage(rendered.manifest.bounds, instruction));
  } finally {
    await discardText2CadTemp(rendered.tmpDir);
  }
});

test("生产级整机要求不得被概念兜底偷换，普通零件也不误命中", () => {
  const blocked = [
    "生成可直接制造的生产级汽车悬架运动学模型",
    "生成可量产、可下厂加工的汽车模型",
    "production-ready manufacturable SUV",
    "生成带精确齿轮传动的人形机器人模型",
    "生成汽车自由曲面车身模型",
    "设计汽车刹车盘",
    "汽车座椅安装支架",
    "人形机器人手臂支架",
    "概念汽车模型，车轮宽度 300mm",
    "汽车和人形机器人对比模型",
    "生成六轮概念汽车",
    "生成 6 个车轮的汽车模型",
    "生成四臂人形机器人模型",
    "生成无头人形机器人模型",
    "不要人形机器人模型，只要概念汽车",
    "不含悬架但需要完整动力总成的概念汽车模型",
    "无需 BIM，但要可量产的概念汽车模型",
    "without suspension but production-ready SUV",
    "需要完整驱动的概念汽车模型",
    "生成带四驱系统和发动机的汽车模型",
    "concept car with AWD engine",
    "需要完整线束的汽车模型",
    "需要驱动的汽车模型",
    "需要内饰的汽车模型",
    "不要遗漏生产级要求的汽车模型",
    "不得忽略完整驱动的概念汽车模型",
    "不能删除动力总成要求的概念汽车模型",
    "可上路行驶的汽车模型",
    "可实际投入运营的车辆模型",
    "用于真实道路测试的汽车模型",
    "验收后交付客户的汽车模型",
    "可上路行驶的概念汽车模型",
    "生成 100×60×6mm 安装板",
  ];
  for (const instruction of blocked) {
    assert.equal(createText2CadConceptFallback(instruction), null, instruction);
  }
  assert.equal(createText2CadConceptFallback("生成一辆概念汽车，不做自由曲面"), null);
  assert.ok(createText2CadConceptFallback("生成一辆概念汽车，整体尺寸 4500×1800×1500mm，轴距 2800mm"));
});
