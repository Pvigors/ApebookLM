import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEXT2CAD_DEFAULTS,
  TEXT2CAD_ENGINE,
  TEXT2CAD_MAX_FEATURES_PER_PART,
  TEXT2CAD_MAX_JSON_BYTES,
  TEXT2CAD_MAX_PARTS,
  TEXT2CAD_SCHEMA_VERSION,
  Text2CadSpecValidationError,
  assertText2CadInstructionCoverage,
  assertText2CadRenderedBoundsCoverage,
  canonicalText2CadDesignHash,
  canonicalText2CadDesignJson,
  canonicalText2CadHash,
  canonicalText2CadJson,
  createDefaultText2CadSpec,
  normalizeText2CadDesignSpec,
  normalizeText2CadSpec,
  parseText2CadDesignSpecJson,
  parseText2CadSpecJson,
  stableText2CadCanonicalJson,
} from "../../lib/text2cad-spec.ts";

const rectangleFeature = (overrides = {}) => ({
  id: "feat_body",
  kind: "extrude",
  operation: "new",
  plane: "XY",
  origin: [0, 0, 0],
  profile: {
    outer: { kind: "rectangle", center: [0, 0], width: 100, height: 60, cornerRadius: 4 },
    holes: [],
  },
  distance: 10,
  requirementRefs: ["req_model_input"],
  ...overrides,
});

const baseSpec = (overrides = {}) => ({
  schemaVersion: 2,
  engine: "text2cad",
  unit: "mm",
  name: "测试装配",
  requirements: [],
  assumptions: [],
  parts: [
    {
      id: "part_body",
      name: "主体",
      material: "aluminum_6061",
      color: "#6d5ce7",
      placement: { translate: [0, 0, 0], rotateDeg: [0, 0, 0] },
      features: [rectangleFeature()],
    },
  ],
  ...overrides,
});

function expectIssue(fn, code, path) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Text2CadSpecValidationError);
    assert.equal(error.issues[0]?.code, code);
    if (path) assert.equal(error.issues[0]?.path, path);
    return true;
  });
}

test("Text2CAD V2 默认规格可规范化且完整补齐默认值", () => {
  const spec = createDefaultText2CadSpec();
  assert.equal(spec.schemaVersion, TEXT2CAD_SCHEMA_VERSION);
  assert.equal(spec.engine, TEXT2CAD_ENGINE);
  assert.equal(spec.unit, "mm");
  assert.equal(spec.name, TEXT2CAD_DEFAULTS.name);
  assert.equal(spec.process, TEXT2CAD_DEFAULTS.process);
  assert.deepEqual(spec.requirements, [
    {
      id: "req_model_input",
      text: "使用经受控规范化的 Text2CAD 输入生成模型",
      sourceRefs: ["model:input"],
    },
  ]);
  assert.deepEqual(spec.assumptions, []);
  assert.equal(spec.parts.length, 1);
  assert.equal(spec.parts[0].material, TEXT2CAD_DEFAULTS.material);
  assert.equal(spec.parts[0].color, TEXT2CAD_DEFAULTS.color);
  assert.deepEqual(spec.parts[0].placement, { translate: [0, 0, 0], rotateDeg: [0, 0, 0] });
  assert.deepEqual(spec.parts[0].features[0].origin, [0, 0, 0]);
  assert.deepEqual(spec.parts[0].features[0].requirementRefs, ["req_model_input"]);
});

test("支持多零件、四种布尔操作、三个平面和全部受控轮廓", () => {
  const spec = normalizeText2CadSpec({
    ...baseSpec(),
    requirements: [
      {
        id: "req_mount",
        text: "安装孔中心距需要与设备安装面匹配",
        sourceRefs: ["prompt:1", "source:2"],
        acceptance: "两个安装孔中心距为 90mm",
      },
      {
        id: "req_shell",
        text: "外壳需要保留顶部观察窗",
        sourceRefs: ["system:design-assumption"],
      },
    ],
    assumptions: ["默认使用右手坐标系", "未标注公差按概念设计处理"],
    parts: [
      {
        id: "part_base",
        name: "安装底座",
        material: "aluminum_6061",
        color: "#3366cc",
        placement: { translate: [10, 20, 30], rotateDeg: [0, 0, 90] },
        features: [
          rectangleFeature({
            id: "feat_base",
            profile: {
              outer: { kind: "rectangle", center: [0, 0], width: 120, height: 80, cornerRadius: 5 },
              holes: [
                { kind: "circle", center: [-45, -25], radius: 3 },
                { kind: "circle", center: [45, -25], radius: 3 },
              ],
            },
            requirementRefs: ["req_mount"],
          }),
          rectangleFeature({
            id: "feat_boss",
            operation: "add",
            plane: "XZ",
            origin: [0, 0, 10],
            profile: {
              outer: { kind: "polygon", points: [[-20, 0], [20, 0], [15, 30], [-15, 30]] },
              holes: [],
            },
            distance: 8,
            requirementRefs: ["req_mount", "req_shell"],
          }),
          rectangleFeature({
            id: "feat_window",
            operation: "cut",
            plane: "YZ",
            profile: {
              outer: {
                kind: "path",
                segments: [
                  { kind: "line", start: [-10, 0], end: [10, 0] },
                  { kind: "arc", start: [10, 0], mid: [15, 10], end: [10, 20] },
                  { kind: "line", start: [10, 20], end: [-10, 20] },
                  { kind: "arc", start: [-10, 20], mid: [-15, 10], end: [-10, 0] },
                ],
              },
              holes: [],
            },
            distance: 5,
            requirementRefs: ["req_shell"],
          }),
          rectangleFeature({
            id: "feat_trim",
            operation: "intersect",
            profile: {
              outer: { kind: "circle", center: [0, 0], radius: 50 },
              holes: [],
            },
            distance: 20,
          }),
        ],
      },
      {
        id: "part_cover",
        features: [
          rectangleFeature({
            id: "feat_cover",
            profile: {
              outer: { kind: "polygon", points: [[0, 0], [60, 0], [60, 40], [0, 40]] },
              holes: [],
            },
            distance: 2,
          }),
        ],
      },
    ],
  });

  assert.deepEqual(spec.parts.map((part) => part.id), ["part_base", "part_cover"]);
  assert.deepEqual(spec.parts[0].features.map((feature) => feature.operation), ["new", "add", "cut", "intersect"]);
  assert.deepEqual(spec.parts[0].features.map((feature) => feature.plane), ["XY", "XZ", "YZ", "XY"]);
  assert.equal(spec.parts[0].features[2].profile.outer.kind, "path");
  assert.equal(spec.parts[0].features[2].profile.outer.segments[1].kind, "arc");
  assert.deepEqual(spec.requirements.find((entry) => entry.id === "req_mount"), {
    id: "req_mount",
    text: "安装孔中心距需要与设备安装面匹配",
    sourceRefs: ["prompt:1", "source:2"],
    acceptance: "两个安装孔中心距为 90mm",
  });
  assert.equal(spec.parts[1].name, "cover");
  assert.equal(spec.parts[1].color, "#6D5CE7");
});

test("每条用户需求必须被至少一个几何特征引用", () => {
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      requirements: [{
        id: "req_hole",
        text: "中心直径 6mm 通孔",
        sourceRefs: ["prompt:1"],
      }],
    }),
    "uncovered_requirement",
    "$.requirements"
  );
});

test("用户明确尺寸、孔径和孔数必须反向落到受控特征", () => {
  const requirement = {
    id: "req_plate",
    text: "安装板及中心通孔",
    sourceRefs: ["prompt:1"],
  };
  const noHole = normalizeText2CadSpec({
    ...baseSpec(),
    requirements: [requirement],
    parts: [{
      ...baseSpec().parts[0],
      features: [rectangleFeature({
        distance: 6,
        requirementRefs: ["req_plate"],
      })],
    }],
  });
  expectIssue(
    () => assertText2CadInstructionCoverage(noHole, "做一块 100×60×6mm 安装板，中心直径 6mm 通孔"),
    "explicit_diameter_missing",
    "$.parts"
  );

  const fourHoles = normalizeText2CadSpec({
    ...baseSpec(),
    requirements: [requirement],
    parts: [{
      ...baseSpec().parts[0],
      features: [rectangleFeature({
        distance: 6,
        profile: {
          outer: { kind: "rectangle", center: [0, 0], width: 100, height: 60, cornerRadius: 4 },
          holes: [
            { kind: "circle", center: [-40, -20], radius: 3 },
            { kind: "circle", center: [40, -20], radius: 3 },
            { kind: "circle", center: [-40, 20], radius: 3 },
            { kind: "circle", center: [40, 20], radius: 3 },
          ],
        },
        requirementRefs: ["req_plate"],
      })],
    }],
  });
  assert.doesNotThrow(() => assertText2CadInstructionCoverage(
    fourHoles,
    "做一块 100×60×6mm 安装板，4 个直径 6mm 通孔"
  ));
  expectIssue(
    () => assertText2CadInstructionCoverage(fourHoles, "做一块 100×60×6mm 安装板，2 个直径 6mm 通孔"),
    "explicit_hole_count_missing",
    "$.parts"
  );
});

test("中心距与轴距按受控坐标差反查，不要求派生尺寸以原值存储", () => {
  const makeTwoHoles = (halfSpacing) => normalizeText2CadSpec({
    ...baseSpec(),
    requirements: [{ id: "req_holes", text: "双孔定位", sourceRefs: ["prompt:1"] }],
    parts: [{
      ...baseSpec().parts[0],
      features: [rectangleFeature({
        distance: 6,
        profile: {
          outer: { kind: "rectangle", center: [0, 0], width: 120, height: 60, cornerRadius: 4 },
          holes: [
            { kind: "circle", center: [-halfSpacing, 0], radius: 3 },
            { kind: "circle", center: [halfSpacing, 0], radius: 3 },
          ],
        },
        requirementRefs: ["req_holes"],
      })],
    }],
  });
  assert.doesNotThrow(() => assertText2CadInstructionCoverage(
    makeTwoHoles(45),
    "做 120×60×6mm 安装板，2 个直径 6mm 通孔，90mm 孔中心距"
  ));
  expectIssue(
    () => assertText2CadInstructionCoverage(
      makeTwoHoles(40),
      "做 120×60×6mm 安装板，2 个直径 6mm 通孔，中心距 90mm"
    ),
    "explicit_spacing_missing",
    "$.parts"
  );

  const separateCuts = normalizeText2CadSpec({
    ...baseSpec(),
    requirements: [{ id: "req_holes", text: "双孔定位", sourceRefs: ["prompt:1"] }],
    parts: [{
      ...baseSpec().parts[0],
      features: [
        rectangleFeature({ id: "feat_base", distance: 6, requirementRefs: ["req_holes"] }),
        rectangleFeature({
          id: "feat_hole_left",
          operation: "cut",
          profile: { outer: { kind: "circle", center: [-45, 0], radius: 3 }, holes: [] },
          distance: 6,
          requirementRefs: ["req_holes"],
        }),
        rectangleFeature({
          id: "feat_hole_right",
          operation: "cut",
          profile: { outer: { kind: "circle", center: [45, 0], radius: 3 }, holes: [] },
          distance: 6,
          requirementRefs: ["req_holes"],
        }),
      ],
    }],
  });
  assert.doesNotThrow(() => assertText2CadInstructionCoverage(
    separateCuts,
    "2 个直径 6mm 通孔，90mm 孔中心距"
  ));

  const axlePlacement = normalizeText2CadSpec({
    ...baseSpec(),
    requirements: [{ id: "req_axle", text: "前后轴定位", sourceRefs: ["prompt:1"] }],
    parts: [
      {
        ...baseSpec().parts[0],
        id: "part_front",
        placement: { translate: [1400, 0, 0], rotateDeg: [0, 0, 0] },
        features: [rectangleFeature({ requirementRefs: ["req_axle"] })],
      },
      {
        ...baseSpec().parts[0],
        id: "part_rear",
        placement: { translate: [-1400, 0, 0], rotateDeg: [0, 0, 0] },
        features: [rectangleFeature({ requirementRefs: ["req_axle"] })],
      },
    ],
  });
  assert.doesNotThrow(() => assertText2CadInstructionCoverage(axlePlacement, "2800mm 轴距"));
  const wrongAxleAxis = structuredClone(axlePlacement);
  wrongAxleAxis.parts[0].placement.translate = [0, 0, 1400];
  wrongAxleAxis.parts[1].placement.translate = [0, 0, -1400];
  expectIssue(
    () => assertText2CadInstructionCoverage(wrongAxleAxis, "轴距 2800mm"),
    "explicit_spacing_missing",
    "$.parts"
  );
});

test("整车与整机总长宽高延迟到最终 B-Rep 包围盒验收", () => {
  const spec = createDefaultText2CadSpec();
  assert.doesNotThrow(() => assertText2CadInstructionCoverage(
    spec,
    "整体尺寸 4500×1800×1500mm"
  ));
  assert.doesNotThrow(() => assertText2CadRenderedBoundsCoverage(
    [[-2250, -900, 0], [2250, 900, 1500]],
    "整体尺寸 4500×1800×1500mm"
  ));
  assert.doesNotThrow(() => assertText2CadRenderedBoundsCoverage(
    [[-300, -200, 0], [300, 200, 1700]],
    "人形机器人身高 1700mm"
  ));
  expectIssue(
    () => assertText2CadRenderedBoundsCoverage(
      [[-2250, -900, 0], [2250, 900, 1400]],
      "整体尺寸 4500×1800×1500mm"
    ),
    "explicit_overall_dimension_missing",
    "$.bounds"
  );
});

test("所有层级严格拒绝未知字段和代码、路径、URL 字段", () => {
  expectIssue(() => normalizeText2CadSpec({ ...baseSpec(), extra: true }), "unknown_field", "$.extra");
  expectIssue(
    () => normalizeText2CadSpec({ ...baseSpec(), parts: [{ ...baseSpec().parts[0], extra: true }] }),
    "unknown_field",
    "$.parts[0].extra"
  );
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{ ...baseSpec().parts[0], features: [{ ...rectangleFeature(), extra: true }] }],
    }),
    "unknown_field",
    "$.parts[0].features[0].extra"
  );
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{
        ...baseSpec().parts[0],
        features: [{
          ...rectangleFeature(),
          profile: {
            outer: { kind: "circle", center: [0, 0], radius: 10, diameter: 20 },
            holes: [],
          },
        }],
      }],
    }),
    "unknown_field",
    "$.parts[0].features[0].profile.outer.diameter"
  );
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{ ...baseSpec().parts[0], features: [{ ...rectangleFeature(), code: "box()" }] }],
    }),
    "forbidden_field",
    "$.parts[0].features[0].code"
  );
  expectIssue(
    () => normalizeText2CadSpec({ ...baseSpec(), path: "/tmp/model.step" }),
    "forbidden_field",
    "$.path"
  );
  expectIssue(
    () => parseText2CadSpecJson('{"schemaVersion":2,"engine":"text2cad","unit":"mm","parts":[],"__proto__":{"url":"https://x"}}'),
    "forbidden_field",
    "$.__proto__"
  );
});

test("名称、材料、需求与假设拒绝 URL、路径和可执行代码", () => {
  expectIssue(() => normalizeText2CadSpec({ ...baseSpec(), name: "../../secret" }), "forbidden_path", "$.name");
  expectIssue(
    () => normalizeText2CadSpec({ ...baseSpec(), requirements: [{ id: "req_bad", text: "详情见 https://example.com/x" }] }),
    "forbidden_url",
    "$.requirements[0].text"
  );
  expectIssue(
    () => normalizeText2CadSpec({ ...baseSpec(), assumptions: ["读取 C:\\secret\\model.step"] }),
    "forbidden_path",
    "$.assumptions[0]"
  );
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{ ...baseSpec().parts[0], material: "eval(process.exit())" }],
    }),
    "forbidden_code",
    "$.parts[0].material"
  );
});

test("schema、engine、单位、枚举与特征顺序严格受控", () => {
  expectIssue(() => normalizeText2CadSpec({ ...baseSpec(), schemaVersion: 1 }), "schema_version", "$.schemaVersion");
  expectIssue(() => normalizeText2CadSpec({ ...baseSpec(), engine: "openscad" }), "engine", "$.engine");
  expectIssue(() => normalizeText2CadSpec({ ...baseSpec(), unit: "inch" }), "unit", "$.unit");
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{ ...baseSpec().parts[0], features: [{ ...rectangleFeature(), kind: "revolve" }] }],
    }),
    "feature_kind"
  );
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{ ...baseSpec().parts[0], features: [{ ...rectangleFeature(), operation: "cut" }] }],
    }),
    "feature_order"
  );
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{ ...baseSpec().parts[0], features: [rectangleFeature(), rectangleFeature({ id: "feat_two" })] }],
    }),
    "feature_order",
    "$.parts[0].features[1].operation"
  );
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{ ...baseSpec().parts[0], features: [{ ...rectangleFeature(), plane: "ZX" }] }],
    }),
    "plane"
  );
  expectIssue(
    () => normalizeText2CadSpec({ ...baseSpec(), parts: [{ ...baseSpec().parts[0], color: "purple" }] }),
    "color"
  );
});

test("零件、特征、需求 ID 和需求引用闭合且唯一", () => {
  const duplicateParts = [baseSpec().parts[0], { ...baseSpec().parts[0] }];
  expectIssue(() => normalizeText2CadSpec({ ...baseSpec(), parts: duplicateParts }), "duplicate_id", "$.parts[1].id");
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{ ...baseSpec().parts[0], features: [rectangleFeature(), rectangleFeature({ operation: "add" })] }],
    }),
    "duplicate_id",
    "$.parts[0].features[1].id"
  );
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      requirements: [{ id: "bad", text: "非法 ID", sourceRefs: ["prompt:1"] }],
    }),
    "requirement_id"
  );
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      requirements: [{ id: "req_model_input", text: "伪造系统需求", sourceRefs: ["model:input"] }],
    }),
    "reserved_id"
  );
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{
        ...baseSpec().parts[0],
        features: [{ ...rectangleFeature(), requirementRefs: ["req_missing"] }],
      }],
    }),
    "missing_requirement"
  );
});

test("需求来源引用只允许受控来源格式，需求对象仍严格拒绝未知字段", () => {
  for (const sourceRef of ["prompt:1", "source:1", "source:999999", "system:design-assumption", "model:input"]) {
    const spec = normalizeText2CadSpec({
      ...baseSpec(),
      requirements: [{ id: "req_source", text: "来自受控来源的需求", sourceRefs: [sourceRef] }],
      parts: [{
        ...baseSpec().parts[0],
        features: [rectangleFeature({ requirementRefs: ["req_source"] })],
      }],
    });
    assert.deepEqual(spec.requirements.find((entry) => entry.id === "req_source")?.sourceRefs, [sourceRef]);
  }
  for (const sourceRef of ["prompt:2", "source:0", "source:abc", "https://example.com", "file:/tmp/a"] ) {
    expectIssue(
      () => normalizeText2CadSpec({
        ...baseSpec(),
        requirements: [{ id: "req_source", text: "来源格式错误", sourceRefs: [sourceRef] }],
      }),
      "source_ref",
      "$.requirements[0].sourceRefs[0]"
    );
  }
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      requirements: [{ id: "req_source", text: "存在未知字段", sourceRefs: ["prompt:1"], extra: true }],
    }),
    "unknown_field",
    "$.requirements[0].extra"
  );
});

test("parts 与 features 数量门禁严格执行", () => {
  expectIssue(() => normalizeText2CadSpec({ ...baseSpec(), parts: [] }), "part_count", "$.parts");
  const tooManyParts = Array.from({ length: TEXT2CAD_MAX_PARTS + 1 }, (_, index) => ({
    ...baseSpec().parts[0],
    id: `part_item_${index}`,
  }));
  expectIssue(() => normalizeText2CadSpec({ ...baseSpec(), parts: tooManyParts }), "part_count", "$.parts");
  expectIssue(
    () => normalizeText2CadSpec({ ...baseSpec(), parts: [{ ...baseSpec().parts[0], features: [] }] }),
    "feature_count"
  );
  const tooManyFeatures = Array.from({ length: TEXT2CAD_MAX_FEATURES_PER_PART + 1 }, (_, index) =>
    rectangleFeature({ id: `feat_item_${index}`, operation: index === 0 ? "new" : "add" })
  );
  expectIssue(
    () => normalizeText2CadSpec({ ...baseSpec(), parts: [{ ...baseSpec().parts[0], features: tooManyFeatures }] }),
    "feature_count"
  );
});

test("所有几何数值必须有限、三位小数以内且处于安全范围", () => {
  const withFeature = (feature) => ({
    ...baseSpec(),
    parts: [{ ...baseSpec().parts[0], features: [feature] }],
  });
  expectIssue(() => normalizeText2CadSpec(withFeature({ ...rectangleFeature(), distance: NaN })), "finite_number");
  expectIssue(() => normalizeText2CadSpec(withFeature({ ...rectangleFeature(), distance: Infinity })), "finite_number");
  expectIssue(() => normalizeText2CadSpec(withFeature({ ...rectangleFeature(), distance: 1.2345 })), "precision");
  expectIssue(() => normalizeText2CadSpec(withFeature({ ...rectangleFeature(), distance: 12_001 })), "range");
  expectIssue(() => normalizeText2CadSpec(withFeature({ ...rectangleFeature(), origin: [0, 0, 12_001] })), "range");
  expectIssue(
    () => normalizeText2CadSpec({
      ...baseSpec(),
      parts: [{ ...baseSpec().parts[0], placement: { translate: [0, 0, 0], rotateDeg: [0, 361, 0] } }],
    }),
    "range"
  );
  const rotated = normalizeText2CadSpec({
    ...baseSpec(),
    parts: [{ ...baseSpec().parts[0], placement: { translate: [1, 2, 3], rotateDeg: [10, 20, 30] } }],
  });
  assert.deepEqual(rotated.parts[0].placement.rotateDeg, [10, 20, 30]);
  assert.equal(rotated.parts[0].placement.rotateDeg.length, 3);
});

test("矩形、圆、多边形和三点圆弧路径有几何有效性门禁", () => {
  const withOuter = (outer) => normalizeText2CadSpec({
    ...baseSpec(),
    parts: [{
      ...baseSpec().parts[0],
      features: [{ ...rectangleFeature(), profile: { outer, holes: [] } }],
    }],
  });
  expectIssue(
    () => withOuter({ kind: "rectangle", width: 20, height: 10, cornerRadius: 5 }),
    "profile_rule"
  );
  expectIssue(() => withOuter({ kind: "circle", radius: 0 }), "range");
  expectIssue(() => withOuter({ kind: "polygon", points: [[0, 0], [1, 1], [2, 2]] }), "zero_area");
  expectIssue(
    () => withOuter({
      kind: "path",
      segments: [
        { kind: "line", start: [0, 0], end: [10, 0] },
        { kind: "line", start: [9, 0], end: [0, 0] },
      ],
    }),
    "path_disconnected"
  );
  expectIssue(
    () => withOuter({
      kind: "path",
      segments: [
        { kind: "line", start: [0, 0], end: [10, 0] },
        { kind: "line", start: [10, 0], end: [10, 10] },
      ],
    }),
    "path_open"
  );
  expectIssue(
    () => withOuter({
      kind: "path",
      segments: [
        { kind: "arc", start: [0, 0], mid: [5, 0], end: [10, 0] },
        { kind: "line", start: [10, 0], end: [0, 0] },
      ],
    }),
    "invalid_arc"
  );
});

test("JSON 入口具有语法、原型污染与 256KB 体积门禁", () => {
  assert.equal(parseText2CadSpecJson(JSON.stringify(baseSpec())).engine, "text2cad");
  expectIssue(() => parseText2CadSpecJson("{"), "invalid_json");
  expectIssue(() => parseText2CadSpecJson(" ".repeat(TEXT2CAD_MAX_JSON_BYTES + 1)), "json_too_large");
});

test("canonical JSON/hash 对对象键顺序稳定，并重新校验伪造类型", () => {
  const tracedParts = [{
    ...baseSpec().parts[0],
    features: [rectangleFeature({ requirementRefs: ["req_a", "req_z"] })],
  }];
  const a = normalizeText2CadSpec({
    ...baseSpec(),
    assumptions: ["第二项假设", "第一项假设"],
    requirements: [
      { id: "req_z", text: "最后一项需求", sourceRefs: ["source:2"] },
      { id: "req_a", text: "第一项需求", sourceRefs: ["prompt:1"] },
    ],
    parts: tracedParts,
  });
  const b = normalizeText2CadSpec({
    parts: tracedParts,
    assumptions: ["第一项假设", "第二项假设"],
    requirements: [
      { sourceRefs: ["prompt:1"], text: "第一项需求", id: "req_a" },
      { text: "最后一项需求", id: "req_z", sourceRefs: ["source:2"] },
    ],
    name: "测试装配",
    unit: "mm",
    engine: "text2cad",
    schemaVersion: 2,
  });
  assert.equal(canonicalText2CadJson(a), canonicalText2CadJson(b));
  assert.equal(canonicalText2CadHash(a), canonicalText2CadHash(b));
  assert.match(canonicalText2CadHash(a), /^[a-f0-9]{64}$/);
  assert.equal(stableText2CadCanonicalJson({ z: 1, a: { y: 2, x: [3, 4] } }), '{"a":{"x":[3,4],"y":2},"z":1}');

  const forged = structuredClone(a);
  forged.parts[0].features[0].distance = Number.NaN;
  expectIssue(() => canonicalText2CadJson(forged), "finite_number");
});

test("DesignSpec 命名别名与现有短命名完全兼容", () => {
  const byAlias = normalizeText2CadDesignSpec(baseSpec());
  assert.deepEqual(byAlias, normalizeText2CadSpec(baseSpec()));
  assert.deepEqual(parseText2CadDesignSpecJson(JSON.stringify(baseSpec())), parseText2CadSpecJson(JSON.stringify(baseSpec())));
  assert.equal(canonicalText2CadDesignJson(byAlias), canonicalText2CadJson(byAlias));
  assert.equal(canonicalText2CadDesignHash(byAlias), canonicalText2CadHash(byAlias));
});
