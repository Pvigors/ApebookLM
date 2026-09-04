import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAD_MAX_JSON_BYTES,
  CAD_MATERIALS,
  CAD_PROCESSES,
  CAD_TEMPLATE_ARTIFACT_MODE,
  CAD_TEMPLATE_DEFAULTS,
  CAD_TEMPLATE_EXPECTED_SOLID_COUNT,
  CAD_TEMPLATES,
  CadSpecValidationError,
  canonicalCadDesignHash,
  canonicalCadDesignJson,
  normalizeCadDesignSpec,
  parseCadDesignSpecJson,
  stableCanonicalJson,
} from "../../lib/cad-spec.ts";
import {
  cadValueIsExplicitlyMentioned,
  normalizeCadDraftRequirementIds,
  unsupportedCadIntentReason,
} from "../../lib/cad-draft.ts";

const base = (template = "plate") => ({
  schemaVersion: 1,
  unit: "mm",
  template,
});

function expectIssue(fn, code, path) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CadSpecValidationError);
    assert.equal(error.issues[0]?.code, code);
    if (path) assert.equal(error.issues[0]?.path, path);
    return true;
  });
}

test("七种受控模板的默认规格全部可用，且特征图引用闭合", () => {
  for (const template of CAD_TEMPLATES) {
    const spec = normalizeCadDesignSpec(base(template));
    assert.equal(spec.schemaVersion, 1);
    assert.equal(spec.unit, "mm");
    assert.equal(spec.template, template);
    assert.equal(spec.material, "unspecified");
    assert.equal(spec.process, "unspecified");
    assert.deepEqual(
      Object.fromEntries(Object.entries(spec.parameters).map(([key, p]) => [key, p.value])),
      CAD_TEMPLATE_DEFAULTS[template]
    );

    const requirementIds = new Set(spec.requirements.map((requirement) => requirement.id));
    const parameterIds = new Set(Object.keys(spec.parameters));
    const seenFeatures = new Set();
    assert.ok(spec.featureGraph.nodes.length >= 3);
    for (const node of spec.featureGraph.nodes) {
      assert.ok(node.requirementRefs.length > 0, `${template}.${node.id} 必须可追溯到需求`);
      assert.ok(node.requirementRefs.every((ref) => requirementIds.has(ref)));
      assert.ok(node.parameterRefs.every((ref) => parameterIds.has(ref)));
      assert.ok(node.dependsOn.every((id) => seenFeatures.has(id)), "特征图必须是已排序 DAG");
      seenFeatures.add(node.id);
    }
  }
});

test("机器人与概念汽车默认参数和总成拓扑合同保持稳定", () => {
  assert.deepEqual(CAD_TEMPLATE_DEFAULTS.humanoid_robot, {
    overall_height: 1_700,
    overall_width: 650,
    overall_depth: 380,
    limb_diameter: 100,
    joint_clearance: 15,
  });
  assert.deepEqual(CAD_TEMPLATE_DEFAULTS.concept_car, {
    overall_length: 4_500,
    overall_width: 1_800,
    overall_height: 1_450,
    wheelbase: 2_700,
    wheel_diameter: 650,
    wheel_width: 220,
    ground_clearance: 160,
  });
  assert.equal(CAD_TEMPLATE_EXPECTED_SOLID_COUNT.humanoid_robot, 16);
  assert.equal(CAD_TEMPLATE_EXPECTED_SOLID_COUNT.concept_car, 5);
  assert.equal(CAD_TEMPLATE_ARTIFACT_MODE.humanoid_robot, "assembly");
  assert.equal(CAD_TEMPLATE_ARTIFACT_MODE.concept_car, "assembly");
  for (const template of ["plate", "mounting_bracket", "enclosure", "flange", "shaft_adapter"]) {
    assert.equal(CAD_TEMPLATE_EXPECTED_SOLID_COUNT[template], 1);
    assert.equal(CAD_TEMPLATE_ARTIFACT_MODE[template], "single_part");
  }
});

test("材料与工艺仅接受受控枚举", () => {
  for (const material of CAD_MATERIALS) {
    assert.equal(normalizeCadDesignSpec({ ...base(), material }).material, material);
  }
  for (const process of CAD_PROCESSES) {
    assert.equal(normalizeCadDesignSpec({ ...base(), process }).process, process);
  }
  expectIssue(() => normalizeCadDesignSpec({ ...base(), material: "titanium" }), "material", "$.material");
  expectIssue(() => normalizeCadDesignSpec({ ...base(), process: "casting" }), "process", "$.process");
});

test("模型参数、需求与特征节点保持双向可追溯", () => {
  const spec = normalizeCadDesignSpec({
    ...base("flange"),
    name: "泵体连接法兰",
    material: "stainless_steel",
    process: "cnc",
    requirements: [
      {
        id: "req_mounting_face",
        text: "螺栓孔必须与对接法兰匹配",
        sourceRefs: ["prompt:1", "sketch:front"],
        acceptance: "螺栓孔中心圆直径为 80mm",
      },
    ],
    parameters: {
      bolt_circle_diameter: { value: 80, requirementRefs: ["req_mounting_face"] },
      outer_diameter: 110,
    },
  });
  assert.equal(spec.parameters.bolt_circle_diameter.value, 80);
  assert.deepEqual(spec.parameters.bolt_circle_diameter.requirementRefs, ["req_mounting_face"]);
  assert.deepEqual(spec.parameters.outer_diameter.requirementRefs, ["req_model_input"]);
  assert.deepEqual(spec.parameters.thickness.requirementRefs, ["req_template_defaults"]);
  const boltFeature = spec.featureGraph.nodes.find((node) => node.id === "bolt_holes");
  assert.ok(boltFeature.requirementRefs.includes("req_mounting_face"));
  assert.equal(spec.requirements.find((r) => r.id === "req_mounting_face").sourceRefs[0], "prompt:1");
});

test("模型不能注入特征图、代码、路径或 URL", () => {
  expectIssue(
    () => normalizeCadDesignSpec({ ...base(), featureGraph: { nodes: [] } }),
    "unknown_field",
    "$.featureGraph"
  );
  for (const [key, value] of [
    ["code", "import os"],
    ["python", "print(1)"],
    ["path", "/tmp/a.step"],
    ["url", "https://example.com/a"],
    ["command", "freecadcmd"],
  ]) {
    expectIssue(() => normalizeCadDesignSpec({ ...base(), [key]: value }), "forbidden_field", `$.${key}`);
  }
  expectIssue(
    () => normalizeCadDesignSpec({ ...base(), requirements: [{ id: "req_a", text: "x", sourceRefs: ["https://x"] }] }),
    "unsafe_source_ref",
    "$.requirements[0].sourceRefs[0]"
  );
  expectIssue(
    () => parseCadDesignSpecJson('{"schemaVersion":1,"unit":"mm","template":"plate","__proto__":{"code":"x"}}'),
    "forbidden_field",
    "$.__proto__"
  );
});

test("顶层 schema 严格：版本、单位、模板、参数键都不得漂移", () => {
  expectIssue(() => normalizeCadDesignSpec({ unit: "mm", template: "plate" }), "schema_version", "$.schemaVersion");
  expectIssue(() => normalizeCadDesignSpec({ ...base(), unit: "inch" }), "unit", "$.unit");
  expectIssue(() => normalizeCadDesignSpec({ ...base("gear") }), "template", "$.template");
  expectIssue(() => normalizeCadDesignSpec({ ...base(), unknown: 1 }), "unknown_field", "$.unknown");
  expectIssue(
    () => normalizeCadDesignSpec({ ...base(), parameters: { pitch: 12 } }),
    "unknown_parameter",
    "$.parameters.pitch"
  );
});

test("数值必须有限、最多三位小数、计数为整数并受尺寸上限约束", () => {
  expectIssue(() => normalizeCadDesignSpec({ ...base(), parameters: { length: NaN } }), "finite_number");
  expectIssue(() => normalizeCadDesignSpec({ ...base(), parameters: { width: Infinity } }), "finite_number");
  expectIssue(() => normalizeCadDesignSpec({ ...base(), parameters: { thickness: 1.2345 } }), "precision");
  expectIssue(() => normalizeCadDesignSpec({ ...base(), parameters: { hole_count: 2.5 } }), "integer_required");
  expectIssue(() => normalizeCadDesignSpec({ ...base(), parameters: { length: 2001 } }), "range");
  expectIssue(() => normalizeCadDesignSpec({ ...base(), parameters: { thickness: 0.1 } }), "range");
});

test("每个模板的业务几何约束都会 fail closed", () => {
  const invalid = [
    { template: "plate", parameters: { length: 20, width: 20, corner_radius: 11 } },
    { template: "mounting_bracket", parameters: { base_thickness: 2, fillet_radius: 3 } },
    { template: "enclosure", parameters: { outer_width: 20, wall_thickness: 10 } },
    { template: "flange", parameters: { outer_diameter: 50, bolt_circle_diameter: 48, bolt_hole_diameter: 8 } },
    { template: "shaft_adapter", parameters: { length: 20, transition_length: 20 } },
    { template: "humanoid_robot", parameters: { overall_width: 250, joint_clearance: 30 } },
    { template: "concept_car", parameters: { wheelbase: 3_900 } },
    { template: "concept_car", parameters: { overall_width: 800, wheel_width: 400 } },
  ];
  for (const entry of invalid) {
    expectIssue(() => normalizeCadDesignSpec({ ...base(entry.template), parameters: entry.parameters }), "business_rule");
  }
  expectIssue(
    () => normalizeCadDesignSpec({ ...base("plate"), parameters: { length: 10, width: 10, corner_radius: 5, hole_count: 0 } }),
    "business_rule",
    "$.parameters.corner_radius"
  );
});

test("新增总成模板拒绝越界尺寸和无法装配的参数组合", () => {
  expectIssue(
    () => normalizeCadDesignSpec({ ...base("concept_car"), parameters: { overall_length: 12_001 } }),
    "range",
    "$.parameters.overall_length.value"
  );
  expectIssue(
    () => normalizeCadDesignSpec({ ...base("humanoid_robot"), parameters: { limb_diameter: 300, overall_depth: 300 } }),
    "business_rule",
    "$.parameters.limb_diameter"
  );
  expectIssue(
    () => normalizeCadDesignSpec({ ...base("concept_car"), parameters: { overall_height: 500, wheel_diameter: 650 } }),
    "business_rule",
    "$.parameters.wheel_diameter"
  );
});

test("高密度孔阵列、越界外壳螺柱与相交紧定孔在入内核前被拒绝", () => {
  expectIssue(
    () => normalizeCadDesignSpec({
      ...base("flange"),
      parameters: {
        outer_diameter: 100,
        bore_diameter: 10,
        bolt_circle_diameter: 70,
        bolt_hole_diameter: 20,
        bolt_hole_count: 64,
      },
    }),
    "business_rule",
    "$.parameters.bolt_hole_count"
  );
  expectIssue(
    () => normalizeCadDesignSpec({
      ...base("enclosure"),
      parameters: {
        outer_length: 104,
        outer_width: 104,
        outer_height: 51,
        wall_thickness: 50,
        screw_diameter: 1,
        screw_count: 4,
      },
    }),
    "business_rule"
  );
  expectIssue(
    () => normalizeCadDesignSpec({
      ...base("plate"),
      parameters: { hole_count: 64, hole_diameter: 10 },
    }),
    "business_rule",
    "$.parameters.hole_count"
  );
  expectIssue(
    () => normalizeCadDesignSpec({
      ...base("shaft_adapter"),
      parameters: { set_screw_count: 8, set_screw_diameter: 6 },
    }),
    "business_rule",
    "$.parameters.set_screw_count"
  );
});

test("需求 schema 严格校验 ID、来源引用、验收文本与参数引用", () => {
  expectIssue(
    () => normalizeCadDesignSpec({ ...base(), requirements: [{ id: "bad", text: "x", sourceRefs: ["prompt:1"] }] }),
    "requirement_id"
  );
  expectIssue(
    () => normalizeCadDesignSpec({ ...base(), requirements: [{ id: "req_template_defaults", text: "x", sourceRefs: ["prompt:1"] }] }),
    "reserved_id"
  );
  expectIssue(
    () => normalizeCadDesignSpec({ ...base(), requirements: [{ id: "req_a", text: "x", sourceRefs: [] }] }),
    "source_ref_count"
  );
  expectIssue(
    () => normalizeCadDesignSpec({ ...base(), requirements: [{ id: "req_a", text: "x", sourceRefs: ["prompt:1"], extra: 1 }] }),
    "unknown_field"
  );
  expectIssue(
    () => normalizeCadDesignSpec({ ...base(), parameters: { length: { value: 100, requirementRefs: ["req_missing"] } } }),
    "missing_requirement"
  );
});

test("名称可正规化但不得被当作路径", () => {
  const spec = normalizeCadDesignSpec({ ...base(), name: "  我的   安装板  " });
  assert.equal(spec.name, "我的 安装板");
  expectIssue(() => normalizeCadDesignSpec({ ...base(), name: "../../secret" }), "unsafe_name", "$.name");
  expectIssue(() => normalizeCadDesignSpec({ ...base(), name: "folder\\part" }), "unsafe_name", "$.name");
});

test("canonical JSON/hash 不受输入对象键顺序或需求顺序影响", () => {
  const a = normalizeCadDesignSpec({
    ...base("plate"),
    material: "aluminum",
    requirements: [
      { id: "req_b", text: "B", sourceRefs: ["image:1"] },
      { id: "req_a", text: "A", sourceRefs: ["prompt:1"] },
    ],
    parameters: {
      width: { value: 70, requirementRefs: ["req_b"] },
      length: { value: 120, requirementRefs: ["req_a"] },
    },
  });
  const b = normalizeCadDesignSpec({
    template: "plate",
    unit: "mm",
    schemaVersion: 1,
    parameters: {
      length: { requirementRefs: ["req_a"], value: 120 },
      width: { requirementRefs: ["req_b"], value: 70 },
    },
    requirements: [
      { sourceRefs: ["prompt:1"], text: "A", id: "req_a" },
      { sourceRefs: ["image:1"], text: "B", id: "req_b" },
    ],
    material: "aluminum",
  });
  assert.equal(canonicalCadDesignJson(a), canonicalCadDesignJson(b));
  assert.equal(canonicalCadDesignHash(a), canonicalCadDesignHash(b));
  assert.match(canonicalCadDesignHash(a), /^[a-f0-9]{64}$/);
  assert.notEqual(
    canonicalCadDesignHash(a),
    canonicalCadDesignHash(normalizeCadDesignSpec({ ...base("plate"), material: "steel" }))
  );
});

test("stableCanonicalJson 按键排序，并拒绝循环、undefined 和非有限数", () => {
  assert.equal(stableCanonicalJson({ z: 1, a: { y: 2, x: [3, 4] } }), '{"a":{"x":[3,4],"y":2},"z":1}');
  const cycle = {};
  cycle.self = cycle;
  expectIssue(() => stableCanonicalJson(cycle), "canonical_cycle");
  expectIssue(() => stableCanonicalJson({ a: undefined }), "canonical_type");
  expectIssue(() => stableCanonicalJson({ a: NaN }), "canonical_number");
});

test("JSON 入口有语法和 64KB 体积门禁", () => {
  assert.equal(parseCadDesignSpecJson(JSON.stringify(base("enclosure"))).template, "enclosure");
  expectIssue(() => parseCadDesignSpecJson("{"), "invalid_json");
  const huge = " ".repeat(CAD_MAX_JSON_BYTES + 1);
  expectIssue(() => parseCadDesignSpecJson(huge), "json_too_large");
});

test("模型草稿需求 ID 可确定性重编号，参数引用同步但安全校验不放宽", () => {
  const draft = normalizeCadDraftRequirementIds({
    ...base("plate"),
    requirements: [
      { id: "req_1", text: "长度为 120mm", sourceRefs: ["prompt:1"] },
      { id: "尺寸-二", text: "宽度为 80mm", sourceRefs: ["prompt:1"] },
    ],
    parameters: {
      length: { value: 120, requirementRefs: ["req_1"] },
      width: { value: 80, requirementRefs: ["尺寸-二"] },
    },
  });
  const spec = normalizeCadDesignSpec(draft);
  assert.equal(spec.requirements.some((requirement) => requirement.id === "req_r1"), true);
  assert.equal(spec.requirements.some((requirement) => requirement.id === "req_r2"), true);
  assert.deepEqual(spec.parameters.length.requirementRefs, ["req_r1"]);
  assert.deepEqual(spec.parameters.width.requirementRefs, ["req_r2"]);

  expectIssue(
    () => normalizeCadDesignSpec(normalizeCadDraftRequirementIds({ ...base(), code: "print(1)" })),
    "forbidden_field",
    "$.code"
  );
  assert.throws(
    () => normalizeCadDraftRequirementIds({
      ...base(),
      requirements: [
        { id: "req_1", text: "A", sourceRefs: ["prompt:1"] },
        { id: "req_1", text: "B", sourceRefs: ["prompt:1"] },
      ],
    }),
    /需求 ID 重复/
  );
});

test("非默认精密参数证据识别支持数字与中文孔数，不接受来源中不存在的值", () => {
  assert.equal(cadValueIsExplicitlyMentioned(120, "mm", "板长 120×80×6mm"), true);
  assert.equal(cadValueIsExplicitlyMentioned(4, "count", "四角各开一个通孔"), true);
  assert.equal(cadValueIsExplicitlyMentioned(8, "mm", "孔径为 6mm"), false);
});

test("明显超出七模板的核心建模意图在规格解析前 fail closed", () => {
  assert.match(unsupportedCadIntentReason("帮我生成一个齿轮") || "", /超出/);
  assert.match(unsupportedCadIntentReason("Design a freeform assembly") || "", /超出/);
  assert.equal(unsupportedCadIntentReason("为传感器设计一个安装支架"), null);
  assert.equal(unsupportedCadIntentReason("设计一个齿轮箱外壳"), null);
  assert.equal(unsupportedCadIntentReason("设计一个用于齿轮箱的安装支架"), null);
  assert.equal(unsupportedCadIntentReason("设计一个安装齿轮的法兰"), null);
  assert.match(unsupportedCadIntentReason("设计一个自由曲面外壳") || "", /超出/);
  assert.match(unsupportedCadIntentReason("设计一个带齿轮和 M6 螺纹的安装板") || "", /超出/);
  assert.equal(unsupportedCadIntentReason("做一个 4500mm 整机", "concept_car"), null);
  assert.match(unsupportedCadIntentReason("做一个飞机整机", "concept_car") || "", /超出/);
});
