import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAD_REQUEST_PLAN_MODES,
  buildCadRequestPlan,
  canonicalCadRequestPlanHash,
  preflightCadRequest,
} from "../../lib/cad-request-plan.ts";
import {
  findCadObjectIds,
  getCadObjectContract,
} from "../../lib/cad-object-contracts.ts";
import {
  cadFailureDisposition,
  isRepairableCadErrorCode,
  isTerminalCadErrorCode,
} from "../../lib/cad-errors.ts";

const academicSource = {
  id: "paper-1",
  title: "学术论文写作格式规范",
  content: "论文包含摘要、目录、正文和参考文献，页面使用 A4 纸。",
  status: "ready",
};

test("机械臂别名稳定收敛为 robotic_arm，不冒充人形机器人", () => {
  for (const instruction of [
    "机器人手臂",
    "画一个机械臂",
    "生成机械手臂",
    "设计机器人手臂",
    "create a robot arm model",
    "robotic manipulator",
  ]) {
    assert.deepEqual(findCadObjectIds(instruction), ["robotic_arm"], instruction);
  }
  assert.deepEqual(findCadObjectIds("生成人形机器人"), ["humanoid_robot"]);
  const contract = getCadObjectContract("robotic_arm");
  assert.equal(contract.artifactMode, "assembly");
  assert.equal(contract.fidelity, "concept_assembly");
  assert.equal(contract.fixedTemplate, null);
  assert.deepEqual(contract.requiredPartRoles, ["base", "shoulder", "upper_arm", "forearm", "wrist"]);
});

test("明确目标和固定模板不需要伪造来源，仅来源驱动必须有来源", () => {
  const promptDriven = preflightCadRequest({
    mode: "prompt_driven",
    instruction: "机器人手臂，整体高度 600mm",
    allowAssumptions: true,
    sources: [],
  });
  assert.equal(promptDriven.ok, true);
  if (promptDriven.ok) {
    assert.equal(promptDriven.plan.mode, "prompt_driven");
    assert.equal(promptDriven.plan.target.objectId, "robotic_arm");
    assert.deepEqual(promptDriven.plan.sourceSnapshots, []);
  }

  const fixedTemplate = preflightCadRequest({
    mode: "fixed_template",
    templateId: "plate",
    parameters: { length: 120, width: 80, thickness: 5 },
    sources: [],
  });
  assert.equal(fixedTemplate.ok, true);
  if (fixedTemplate.ok) {
    assert.equal(fixedTemplate.plan.mode, "fixed_template");
    assert.equal(fixedTemplate.plan.target.objectId, "plate");
    assert.deepEqual(fixedTemplate.plan.sourceSnapshots, []);
  }

  const sourceDriven = preflightCadRequest({ mode: "source_driven", sources: [] });
  assert.equal(sourceDriven.ok, false);
  if (!sourceDriven.ok) {
    assert.equal(sourceDriven.error.code, "cad_source_required");
    assert.equal(sourceDriven.error.field, "sourceIds");
  }
});

test("显式模式是权威：prompt 空目标拒绝，source 不得静默忽略自由描述", () => {
  const emptyPrompt = preflightCadRequest({
    mode: "prompt_driven",
    instruction: "",
    sources: [{
      id: "plate-source",
      title: "安装板设计要求",
      content: "建模目标为安装板，长度 120mm、宽度 80mm。",
    }],
  });
  assert.equal(emptyPrompt.ok, false);
  if (!emptyPrompt.ok) assert.equal(emptyPrompt.error.code, "cad_target_required");

  const sourceAuthoritative = preflightCadRequest({
    mode: "source_driven",
    instruction: "机器人手臂",
    sources: [{
      id: "plate-source",
      title: "安装板设计要求",
      content: "建模目标为安装板，长度 120mm、宽度 80mm。",
    }],
  });
  assert.equal(sourceAuthoritative.ok, false);
  if (!sourceAuthoritative.ok) {
    assert.equal(sourceAuthoritative.error.code, "cad_request_invalid");
    assert.equal(sourceAuthoritative.error.field, "instruction");
  }
});

test("请求计划只有三种稳定模式", () => {
  assert.deepEqual(CAD_REQUEST_PLAN_MODES, ["prompt_driven", "source_driven", "fixed_template"]);
});

test("教学示例必须作为显式固定安装板动作写入冻结计划", () => {
  const accepted = preflightCadRequest({
    mode: "fixed_template",
    templateId: "plate",
    parameters: { length: 100, width: 60, thickness: 5, hole_count: 4, hole_diameter: 6 },
    tutorialExample: true,
    allowAssumptions: true,
    sources: [],
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.plan.tutorialExample, true);

  const rejected = preflightCadRequest({
    mode: "prompt_driven",
    instruction: "生成长度 120mm 的安装板",
    tutorialExample: true,
    sources: [],
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.field, "tutorialExample");
});

test("明确机械臂目标不会被无关论文提升为冲突的几何权威", () => {
  const result = preflightCadRequest({
    instruction: "画一个机械手臂，高度 600mm",
    allowAssumptions: true,
    sources: [academicSource],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.schemaVersion, 3);
  assert.equal(result.plan.mode, "prompt_driven");
  assert.equal(result.plan.target.objectId, "robotic_arm");
  assert.equal(result.plan.target.provenance, "prompt");
  assert.equal(result.plan.evidencePolicy.requireSourceBackedGeometry, false);
  assert.deepEqual(result.plan.target.sourceIds, []);
  assert.match(result.plan.planHash, /^[a-f0-9]{64}$/);
  assert.equal(canonicalCadRequestPlanHash(result.plan), result.plan.planHash);
});

test("缺少关键约束时必须由用户显式允许首版假设", () => {
  const rejected = preflightCadRequest({
    mode: "prompt_driven",
    instruction: "生成一个机械臂",
    allowAssumptions: false,
    sources: [],
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "cad_invalid_explicit_constraint");

  const accepted = preflightCadRequest({
    mode: "prompt_driven",
    instruction: "生成一个机械臂",
    allowAssumptions: true,
    sources: [],
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.deepEqual(accepted.plan.constraints, []);
    assert.deepEqual(accepted.plan.missingFields, ["key_dimensions", "component_proportions", "joint_clearances"]);
    assert.equal(accepted.plan.evidencePolicy.permitDesignAssumptions, true);
  }
});

test("超出 IR 能力的请求在扣分前精确拒绝", () => {
  const result = preflightCadRequest({
    mode: "prompt_driven",
    instruction: "生成带生产级运动学和线束的机械臂，高度 600mm",
    allowAssumptions: false,
    sources: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cad_capability_limit");
    assert.equal(result.error.disposition, "terminal");
    assert.deepEqual(result.error.details?.unsupportedFeatures, ["生产级运动学"]);
  }
});

test("buildCadRequestPlan 导出路由可直接冻结的计划和哈希", () => {
  const built = buildCadRequestPlan({
    mode: "prompt_driven",
    instruction: "生成一个整体高度 600mm 的机械臂",
    templateId: "text2cad",
    allowAssumptions: true,
    sources: [academicSource],
  });
  assert.equal(built.planHash, built.plan.planHash);
  assert.equal(built.plan.templateId, "text2cad");
  assert.deepEqual(built.plan.parameters, {});
  assert.equal(built.plan.allowAssumptions, true);
  assert.equal(built.plan.evidencePolicy.permitDesignAssumptions, true);
});

test("提示/来源模式不接受会被生成器忽略的隐藏参数", () => {
  for (const input of [
    { mode: "prompt_driven", instruction: "生成长度 120mm 的安装板", parameters: { hidden: 1 }, sources: [] },
    { mode: "source_driven", parameters: { hidden: 1 }, sources: [{ id: "s", title: "安装板设计", content: "建模目标为安装板，长度 120mm。" }] },
  ]) {
    const result = preflightCadRequest(input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "cad_request_invalid");
      assert.equal(result.error.field, "parameters");
    }
  }
});

test("来源驱动只在强设计语境下接受唯一对象", () => {
  const result = preflightCadRequest({
    sources: [{
      id: "spec-1",
      title: "机械臂设计任务书",
      content: "建模目标为机械臂，整体高度 600mm，由底座、肩部、上臂、前臂和腕部组成。",
    }],
    allowAssumptions: true,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.plan.mode, "source_driven");
  assert.equal(result.plan.target.objectId, "robotic_arm");
  assert.equal(result.plan.evidencePolicy.requireSourceBackedGeometry, true);
  assert.deepEqual(result.plan.target.sourceIds, ["spec-1"]);
});

test("泛资料与空目标在扣费前终止", () => {
  const result = preflightCadRequest({ sources: [academicSource] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "cad_target_required");
  assert.equal(result.error.disposition, "terminal");
  assert.equal(result.error.field, "instruction");
});

test("多来源出现不同设计对象时要求用户选择", () => {
  const result = preflightCadRequest({
    instruction: "请根据所选来源生成 CAD 模型",
    sources: [
      { id: "arm", title: "机械臂设计要求", content: "建模目标为机械臂，高度 600mm。" },
      { id: "plate", title: "安装板项目需求", content: "客户要求安装板长度 120mm，宽度 80mm。" },
    ],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "cad_source_conflict");
  assert.equal(result.error.disposition, "terminal");
  assert.deepEqual(result.error.details?.objectIds, ["plate", "robotic_arm"]);
});

test("固定模板高于来源，但不允许与用户明确对象冲突", () => {
  const accepted = preflightCadRequest({
    template: "plate",
    instruction: "生成一块 120×80×5mm 安装板",
    sources: [academicSource],
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.plan.mode, "fixed_template");
    assert.equal(accepted.plan.target.objectId, "plate");
  }

  const rejected = preflightCadRequest({
    template: "plate",
    instruction: "生成一个机械臂",
    sources: [academicSource],
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "cad_template_conflict");
});

test("固定模板在免费预检阶段执行现有尺寸范围与几何业务规则", () => {
  for (const [parameters, expectedPath] of [
    [{ thickness: 0.1 }, "$.parameters.thickness.value"],
    [{ hole_diameter: 8, hole_edge_offset: 3 }, "$.parameters.hole_edge_offset"],
  ]) {
    const result = preflightCadRequest({
      mode: "fixed_template",
      templateId: "plate",
      parameters,
      sources: [],
    });
    assert.equal(result.ok, false, JSON.stringify(parameters));
    if (!result.ok) {
      assert.equal(result.error.code, "cad_invalid_explicit_constraint");
      assert.equal(result.error.disposition, "terminal");
      assert.equal(result.error.field, expectedPath);
    }
  }
});

test("规范哈希不受来源顺序影响，内容变化必然换哈希", () => {
  const sourceA = { id: "a", title: "A", content: "建模目标为安装板，长度 120mm，厚度 5mm。" };
  const sourceB = { id: "b", title: "B", content: "安装板设计要求：宽度 80mm。" };
  const first = preflightCadRequest({ mode: "source_driven", allowAssumptions: false, sources: [sourceA, sourceB] });
  const reordered = preflightCadRequest({ mode: "source_driven", allowAssumptions: false, sources: [sourceB, sourceA] });
  const changed = preflightCadRequest({
    mode: "source_driven",
    allowAssumptions: false,
    sources: [sourceA, { ...sourceB, content: "安装板设计要求：宽度 81mm。" }],
  });
  assert.equal(first.ok && reordered.ok && changed.ok, true);
  if (!first.ok || !reordered.ok || !changed.ok) return;
  assert.equal(first.plan.sourceSnapshotHash, reordered.plan.sourceSnapshotHash);
  assert.equal(first.plan.planHash, reordered.plan.planHash);
  assert.notEqual(first.plan.sourceSnapshotHash, changed.plan.sourceSnapshotHash);
  assert.notEqual(first.plan.planHash, changed.plan.planHash);
});

test("终态与可修复错误分类是封闭且稳定的", () => {
  for (const code of [
    "cad_target_required",
    "cad_object_conflict",
    "cad_source_conflict",
    "cad_capability_limit",
  ]) {
    assert.equal(cadFailureDisposition(code), "terminal");
    assert.equal(isTerminalCadErrorCode(code), true);
    assert.equal(isRepairableCadErrorCode(code), false);
  }
  for (const code of [
    "cad_ir_schema_invalid",
    "cad_boolean_no_effect",
    "cad_part_interference",
    "cad_step_roundtrip_failed",
  ]) {
    assert.equal(cadFailureDisposition(code), "repairable");
    assert.equal(isRepairableCadErrorCode(code), true);
    assert.equal(isTerminalCadErrorCode(code), false);
  }
});

test("来源就绪、重复 ID 与真实字节预算会 fail closed", () => {
  const unavailable = preflightCadRequest({
    instruction: "生成安装板",
    sources: [{ ...academicSource, status: "processing" }],
  });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, "cad_source_unavailable");

  const conflictingDuplicate = preflightCadRequest({
    instruction: "生成安装板",
    sources: [academicSource, { ...academicSource, content: "不同内容" }],
  });
  assert.equal(conflictingDuplicate.ok, false);
  if (!conflictingDuplicate.ok) assert.equal(conflictingDuplicate.error.code, "cad_request_invalid");

  const tooLarge = preflightCadRequest({
    instruction: "生成安装板",
    sources: [{ id: "large", title: "large", content: "界".repeat(2_100_000) }],
  });
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.error.code, "cad_source_budget_exceeded");

  const boundaryPrefix = "建模目标为安装板，长度 120mm，宽度 80mm，厚度 5mm。";
  const exactChars = preflightCadRequest({
    mode: "source_driven",
    allowAssumptions: false,
    sources: [{
      id: "exact",
      title: "安装板规格书",
      content: boundaryPrefix + "a".repeat(512_000 - boundaryPrefix.length),
    }],
  });
  assert.equal(exactChars.ok, true);
  const tooManyChars = preflightCadRequest({
    mode: "source_driven",
    allowAssumptions: false,
    sources: [{
      id: "chars",
      title: "安装板规格书",
      content: boundaryPrefix + "a".repeat(512_001 - boundaryPrefix.length),
    }],
  });
  assert.equal(tooManyChars.ok, false);
  if (!tooManyChars.ok) assert.equal(tooManyChars.error.code, "cad_source_budget_exceeded");
});

test("教程示例中出现对象和尺寸，不得被提升为来源驱动的建模目标", () => {
  const result = preflightCadRequest({
    mode: "source_driven",
    sources: [{
      id: "tutorial-1",
      title: "CAD 入门教程",
      content: "本教程以机械臂为例，示例长度 100mm，用于说明软件操作。",
    }],
    allowAssumptions: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "cad_target_required");
});

test("来源安装板只有长度且未允许假设时，预检直接提示缺失宽度和厚度", () => {
  const result = preflightCadRequest({
    mode: "source_driven",
    sources: [{
      id: "plate-incomplete",
      title: "安装板规格书",
      content: "建模目标为安装板，长度 120mm。",
    }],
    allowAssumptions: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "cad_invalid_explicit_constraint");
    assert.equal(result.error.field, "sourceIds");
    assert.deepEqual(result.error.details?.missingFields, ["width", "thickness"]);
  }
});

test("来源约束只能绑定同一权威目标语义链，教程/附录尺寸不得借给安装板", () => {
  for (const content of [
    "设计对象为安装板。教程示例：法兰整体尺寸 120×80×5mm。",
    "设计对象为安装板。附录记录另一设备整体尺寸 120×80×5mm。",
  ]) {
    const result = preflightCadRequest({
      mode: "source_driven",
      sources: [{ id: "bound", title: "项目文档", content }],
      allowAssumptions: false,
    });
    assert.equal(result.ok, false, content);
    if (!result.ok) assert.equal(result.error.code, "cad_invalid_explicit_constraint");
  }
});

test("主对象后的部件别名不得被误判为并列建模目标", () => {
  const source = preflightCadRequest({
    mode: "source_driven",
    sources: [{
      id: "arm",
      title: "机械臂设计任务书",
      content: "设计对象为机械臂，底座采用安装板，整体高度 600mm。",
    }],
    allowAssumptions: true,
  });
  assert.equal(source.ok, true);
  if (source.ok) assert.equal(source.plan.target.objectId, "robotic_arm");

  const prompt = preflightCadRequest({
    mode: "prompt_driven",
    instruction: "生成机械臂，底座采用安装板，整体高度 600mm",
    allowAssumptions: true,
    sources: [],
  });
  assert.equal(prompt.ok, true);
  if (prompt.ok) assert.equal(prompt.plan.target.objectId, "robotic_arm");
});

test("明确目标谓词高于前置部件词，不会生成错误对象", () => {
  for (const [instruction, expected] of [
    ["安装板作为底座，建模目标为机械臂，整体高度600mm", "robotic_arm"],
    ["安装支架位于内部，设计对象是设备外壳，外形尺寸120×80×50mm，壁厚3mm", "enclosure"],
    ["轴套用于车轮连接，本项目建模目标为概念汽车，整体尺寸4000×1800×1500mm", "concept_car"],
  ]) {
    const result = preflightCadRequest({ mode: "prompt_driven", instruction, allowAssumptions: true, sources: [] });
    assert.equal(result.ok, true, instruction);
    if (result.ok) assert.equal(result.plan.target.objectId, expected);
  }
});

test("来源中的部件句不中断主目标上下文，后续总尺寸仍属于主目标", () => {
  for (const [content, expected] of [
    ["设计对象为机械臂。底座采用安装板。整体高度600mm。", "robotic_arm"],
    ["建模目标是设备外壳。内部包含安装支架。外形尺寸120×80×50mm。壁厚3mm。", "enclosure"],
    ["建模目标是概念汽车。车轮通过轴套连接。整体尺寸4000×1800×1500mm。", "concept_car"],
  ]) {
    const result = preflightCadRequest({
      mode: "source_driven",
      sources: [{ id: `source-${expected}`, title: "设计任务书", content }],
      allowAssumptions: true,
    });
    assert.equal(result.ok, true, content);
    if (result.ok) assert.equal(result.plan.target.objectId, expected);
  }
});

test("同一来源含多个顶层设计时，targetObjectId 能选择对应证据和约束", () => {
  const multi = {
    id: "multi-design",
    title: "多产品设计任务书",
    content: "设计对象为安装板。整体尺寸120×80×5mm。设计对象为法兰。外径100mm，内径40mm，厚度10mm。",
  };
  const conflict = preflightCadRequest({ mode: "source_driven", sources: [multi], allowAssumptions: false });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "cad_source_conflict");
  for (const objectId of ["plate", "flange"]) {
    const selected = preflightCadRequest({
      mode: "source_driven",
      targetObjectId: objectId,
      sources: [multi],
      allowAssumptions: false,
    });
    assert.equal(selected.ok, true, objectId);
    if (selected.ok) {
      assert.equal(selected.plan.target.objectId, objectId);
      assert.ok(selected.plan.constraints.length >= 1);
    }
  }
});

test("无关教程/附录中的超出能力词不阻断主目标", () => {
  for (const suffix of ["附录介绍另一产品 NURBS 自由曲面。", "教程对比真实螺纹。"]) {
    const result = preflightCadRequest({
      mode: "source_driven",
      sources: [{
        id: "plate-capability",
        title: "安装板设计任务书",
        content: `设计对象为安装板。整体尺寸120×80×5mm。${suffix}`,
      }],
      allowAssumptions: false,
    });
    assert.equal(result.ok, true, suffix);
  }
});

test("英文 prompt 和 specification 与中文使用同一预检合同", () => {
  const prompt = preflightCadRequest({
    mode: "prompt_driven",
    instruction: "Create a mounting plate, length 120mm, width 80mm, thickness 5mm",
    allowAssumptions: false,
    sources: [],
  });
  assert.equal(prompt.ok, true);
  if (prompt.ok) assert.equal(prompt.plan.target.objectId, "plate");

  const source = preflightCadRequest({
    mode: "source_driven",
    allowAssumptions: false,
    sources: [{
      id: "english-spec",
      title: "Mounting plate specification",
      content: "Design object is a mounting plate. Overall dimensions 120x80x5mm.",
    }],
  });
  assert.equal(source.ok, true);
  if (source.ok) assert.equal(source.plan.target.objectId, "plate");
});
