import { createHash } from "node:crypto";
import {
  CAD_TEMPLATES,
  type CadTemplate,
} from "./cad-library";

export {
  CAD_LIBRARY_CONTRACTS_BY_VERSION,
  CAD_LIBRARY_VERSION,
  CAD_MANIFEST_VERSION,
  CAD_TEMPLATE_ARTIFACT_MODE,
  CAD_TEMPLATE_EXPECTED_SOLID_COUNT,
  CAD_TEMPLATES,
  TEXT2CAD_TEMPLATE,
  classifyCadTemplateInstruction,
  inferCadTemplateFromInstruction,
  resolveCadArtifactContract,
} from "./cad-library";
export type {
  CadArtifactMode,
  CadArtifactTemplate,
  CadTemplate,
  CadTemplateClassification,
  ResolvedCadArtifactContract,
} from "./cad-library";

/**
 * CAD 的受控规格层。这个模块只描述参数化意图，不执行任何
 * Python/外部命令，也不接受路径或 URL。后续 OCCT/CadQuery worker 只应
 * 消费 normalizeCadDesignSpec 的返回值，不应直接信任模型输出。
 */

export const CAD_SCHEMA_VERSION = 1 as const;
export const CAD_MAX_DIMENSION_MM = 12_000;
export const CAD_MAX_JSON_BYTES = 64 * 1024;

export const CAD_MATERIALS = [
  "aluminum",
  "steel",
  "stainless_steel",
  "abs",
  "pla",
  "nylon",
  "unspecified",
] as const;
export type CadMaterial = (typeof CAD_MATERIALS)[number];

export const CAD_PROCESSES = ["cnc", "3d_print", "sheet_metal", "unspecified"] as const;
export type CadProcess = (typeof CAD_PROCESSES)[number];

export type RequirementSpec = {
  id: string;
  text: string;
  sourceRefs: string[];
  acceptance?: string;
};

export type CadParameter = {
  value: number;
  unit: "mm" | "count";
  requirementRefs: string[];
};

export type CadFeatureKind =
  | "base_profile"
  | "extrude"
  | "revolve"
  | "union"
  | "shell"
  | "lid_seat"
  | "bore"
  | "hole_pattern"
  | "set_screw_pattern"
  | "fillet"
  | "assembly_layout"
  | "component_set"
  | "wheel_set";

export type CadFeatureNode = {
  id: string;
  kind: CadFeatureKind;
  operation: "add" | "cut" | "finish";
  dependsOn: string[];
  parameterRefs: string[];
  requirementRefs: string[];
};

export type FeatureGraph = {
  nodes: CadFeatureNode[];
};

export type CadDesignSpec = {
  schemaVersion: typeof CAD_SCHEMA_VERSION;
  unit: "mm";
  template: CadTemplate;
  name: string;
  material: CadMaterial;
  process: CadProcess;
  requirements: RequirementSpec[];
  parameters: Record<string, CadParameter>;
  featureGraph: FeatureGraph;
};

export type CadSpecIssue = {
  path: string;
  code: string;
  message: string;
};

export class CadSpecValidationError extends Error {
  readonly issues: readonly CadSpecIssue[];

  constructor(issue: CadSpecIssue | CadSpecIssue[]) {
    const issues = Array.isArray(issue) ? issue : [issue];
    super(issues.map((item) => `${item.path}: ${item.message}`).join("; "));
    this.name = "CadSpecValidationError";
    this.issues = issues;
  }
}

type ParamDefinition = {
  defaultValue: number;
  min: number;
  max: number;
  integer?: boolean;
};

type TemplateDefinition = {
  name: string;
  parameters: Record<string, ParamDefinition>;
  graph: ReadonlyArray<{
    id: string;
    kind: CadFeatureKind;
    operation: CadFeatureNode["operation"];
    dependsOn: string[];
    parameterRefs: string[];
  }>;
  validate(values: Record<string, number>): void;
};

const mm = (defaultValue: number, min: number, max: number): ParamDefinition => ({
  defaultValue,
  min,
  max: Math.min(max, CAD_MAX_DIMENSION_MM),
});
const count = (defaultValue: number, min: number, max: number): ParamDefinition => ({
  defaultValue,
  min,
  max,
  integer: true,
});

function issue(path: string, code: string, message: string): never {
  throw new CadSpecValidationError({ path, code, message });
}

function assertRule(condition: boolean, path: string, message: string): void {
  if (!condition) issue(path, "business_rule", message);
}

type Point2 = [number, number];

/** 与 scripts/cad-worker.mjs 同构的矩形周边阵列，用于在入内核前证明孔/柱不重叠。 */
function rectanglePerimeterPoints(
  pointCount: number,
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number
): Point2[] {
  if (pointCount <= 0) return [];
  if (pointCount === 1) return [[(xMin + xMax) / 2, (yMin + yMax) / 2]];
  if (pointCount === 2) return [[xMin, (yMin + yMax) / 2], [xMax, (yMin + yMax) / 2]];
  const width = Math.max(0, xMax - xMin);
  const height = Math.max(0, yMax - yMin);
  const perimeter = 2 * (width + height);
  if (perimeter <= 0) return Array.from({ length: pointCount }, () => [xMin, yMin]);
  return Array.from({ length: pointCount }, (_, index) => {
    let distance = (index / pointCount) * perimeter;
    if (distance <= width) return [xMin + distance, yMin];
    distance -= width;
    if (distance <= height) return [xMax, yMin + distance];
    distance -= height;
    if (distance <= width) return [xMax - distance, yMax];
    distance -= width;
    return [xMin, yMax - distance];
  });
}

function assertPatternClearance(
  points: Point2[],
  occupiedDiameter: number,
  path: string,
  label: string,
  minWeb = 1
): void {
  const required = occupiedDiameter + minWeb;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const distance = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
      assertRule(distance >= required, path, `${label}相邻间距不足，至少需保留 ${minWeb}mm 材料`);
    }
  }
}

const TEMPLATE_DEFINITIONS: Record<CadTemplate, TemplateDefinition> = {
  plate: {
    name: "安装平板",
    parameters: {
      length: mm(100, 10, 2_000),
      width: mm(60, 10, 2_000),
      thickness: mm(5, 0.5, 100),
      corner_radius: mm(3, 0, 500),
      hole_diameter: mm(6, 1, 100),
      hole_count: count(4, 0, 64),
      hole_edge_offset: mm(10, 1, 500),
    },
    graph: [
      { id: "base", kind: "base_profile", operation: "add", dependsOn: [], parameterRefs: ["length", "width", "corner_radius"] },
      { id: "body", kind: "extrude", operation: "add", dependsOn: ["base"], parameterRefs: ["thickness"] },
      { id: "holes", kind: "hole_pattern", operation: "cut", dependsOn: ["body"], parameterRefs: ["length", "width", "hole_diameter", "hole_count", "hole_edge_offset"] },
    ],
    validate(v) {
      const short = Math.min(v.length, v.width);
      assertRule(v.corner_radius === 0 || v.corner_radius < short / 2, "$.parameters.corner_radius", "圆角半径必须小于短边的一半");
      if (v.hole_count > 0) {
        assertRule(v.hole_edge_offset >= v.hole_diameter / 2 + 1, "$.parameters.hole_edge_offset", "孔边距必须保留至少 1mm 材料");
        assertRule(v.hole_edge_offset * 2 <= short, "$.parameters.hole_edge_offset", "孔位边距无法容纳在平板范围内");
        assertPatternClearance(
          rectanglePerimeterPoints(v.hole_count, v.hole_edge_offset, v.length - v.hole_edge_offset, v.hole_edge_offset, v.width - v.hole_edge_offset),
          v.hole_diameter,
          "$.parameters.hole_count",
          "安装孔"
        );
      }
    },
  },
  mounting_bracket: {
    name: "安装支架",
    parameters: {
      base_length: mm(80, 20, 2_000),
      base_width: mm(40, 20, 1_000),
      base_thickness: mm(5, 1, 100),
      upright_height: mm(50, 10, 1_000),
      upright_thickness: mm(5, 1, 100),
      hole_diameter: mm(6, 1, 100),
      hole_count: count(4, 0, 32),
      hole_edge_offset: mm(10, 1, 500),
      fillet_radius: mm(3, 0, 50),
    },
    graph: [
      { id: "base", kind: "extrude", operation: "add", dependsOn: [], parameterRefs: ["base_length", "base_width", "base_thickness"] },
      { id: "upright", kind: "union", operation: "add", dependsOn: ["base"], parameterRefs: ["base_length", "upright_height", "upright_thickness"] },
      { id: "holes", kind: "hole_pattern", operation: "cut", dependsOn: ["upright"], parameterRefs: ["base_length", "base_width", "upright_height", "upright_thickness", "hole_diameter", "hole_count", "hole_edge_offset"] },
      { id: "edge_fillet", kind: "fillet", operation: "finish", dependsOn: ["holes"], parameterRefs: ["fillet_radius"] },
    ],
    validate(v) {
      assertRule(v.upright_thickness < v.base_length, "$.parameters.upright_thickness", "立板厚度必须小于底板长度");
      assertRule(v.fillet_radius <= Math.min(v.base_thickness, v.upright_thickness), "$.parameters.fillet_radius", "圆角半径不能超过最小壁厚");
      if (v.hole_count > 0) {
        assertRule(v.hole_edge_offset >= v.hole_diameter / 2 + 1, "$.parameters.hole_edge_offset", "孔边距必须保留至少 1mm 材料");
        assertRule(v.hole_edge_offset * 2 <= Math.min(v.base_length, v.base_width, v.upright_height), "$.parameters.hole_edge_offset", "孔位超出支架可用范围");
        const baseCount = Math.ceil(v.hole_count / 2);
        const uprightCount = Math.floor(v.hole_count / 2);
        assertPatternClearance(
          rectanglePerimeterPoints(baseCount, v.hole_edge_offset, v.base_length - v.hole_edge_offset, v.hole_edge_offset, v.base_width - v.hole_edge_offset),
          v.hole_diameter,
          "$.parameters.hole_count",
          "底板安装孔"
        );
        assertPatternClearance(
          rectanglePerimeterPoints(uprightCount, v.hole_edge_offset, v.base_length - v.hole_edge_offset, v.hole_edge_offset, v.upright_height - v.hole_edge_offset),
          v.hole_diameter,
          "$.parameters.hole_count",
          "立板安装孔"
        );
      }
    },
  },
  enclosure: {
    name: "设备外壳",
    parameters: {
      outer_length: mm(120, 20, 2_000),
      outer_width: mm(80, 20, 2_000),
      outer_height: mm(40, 10, 1_000),
      wall_thickness: mm(3, 0.8, 50),
      corner_radius: mm(5, 0, 200),
      lid_clearance: mm(0.4, 0, 5),
      screw_diameter: mm(3, 1, 20),
      screw_count: count(4, 0, 16),
    },
    graph: [
      { id: "outer_body", kind: "extrude", operation: "add", dependsOn: [], parameterRefs: ["outer_length", "outer_width", "outer_height", "corner_radius"] },
      { id: "cavity", kind: "shell", operation: "cut", dependsOn: ["outer_body"], parameterRefs: ["outer_length", "outer_width", "outer_height", "wall_thickness", "corner_radius"] },
      { id: "lid_seat", kind: "lid_seat", operation: "add", dependsOn: ["cavity"], parameterRefs: ["outer_length", "outer_width", "outer_height", "wall_thickness", "lid_clearance"] },
      { id: "screw_holes", kind: "hole_pattern", operation: "cut", dependsOn: ["lid_seat"], parameterRefs: ["outer_length", "outer_width", "outer_height", "wall_thickness", "lid_clearance", "screw_diameter", "screw_count"] },
    ],
    validate(v) {
      assertRule(v.wall_thickness * 2 < Math.min(v.outer_length, v.outer_width), "$.parameters.wall_thickness", "两侧壁厚必须小于外壳短边");
      assertRule(v.wall_thickness < v.outer_height, "$.parameters.wall_thickness", "壁厚必须小于外壳高度");
      assertRule(v.corner_radius === 0 || v.corner_radius < Math.min(v.outer_length, v.outer_width) / 2, "$.parameters.corner_radius", "圆角半径必须小于外壳短边的一半");
      assertRule(v.lid_clearance <= v.wall_thickness, "$.parameters.lid_clearance", "盖板间隙不能超过壁厚");
      assertRule(v.wall_thickness * 2 + v.lid_clearance * 2 < Math.min(v.outer_length, v.outer_width), "$.parameters.wall_thickness", "壁厚与盖板间隙挤占了全部内腔");
      if (v.screw_count > 0) {
        assertRule(v.screw_diameter + 2 <= Math.min(v.outer_length, v.outer_width) - 2 * v.wall_thickness, "$.parameters.screw_diameter", "螺钉孔无法容纳在外壳内");
        const postRadius = v.screw_diameter / 2 + Math.max(1, v.wall_thickness * 0.65);
        const postOffset = v.wall_thickness + postRadius + v.lid_clearance;
        assertRule(postOffset * 2 <= Math.min(v.outer_length, v.outer_width), "$.parameters.wall_thickness", "螺柱包络超出外壳边界");
        assertPatternClearance(
          rectanglePerimeterPoints(v.screw_count, postOffset, v.outer_length - postOffset, postOffset, v.outer_width - postOffset),
          postRadius * 2,
          "$.parameters.screw_count",
          "螺柱"
        );
      }
    },
  },
  flange: {
    name: "连接法兰",
    parameters: {
      outer_diameter: mm(100, 10, 2_000),
      thickness: mm(10, 1, 200),
      bore_diameter: mm(30, 1, 1_900),
      bolt_circle_diameter: mm(70, 5, 1_950),
      bolt_hole_diameter: mm(8, 1, 100),
      bolt_hole_count: count(6, 3, 64),
    },
    graph: [
      { id: "disc", kind: "revolve", operation: "add", dependsOn: [], parameterRefs: ["outer_diameter", "thickness"] },
      { id: "bore", kind: "bore", operation: "cut", dependsOn: ["disc"], parameterRefs: ["bore_diameter"] },
      { id: "bolt_holes", kind: "hole_pattern", operation: "cut", dependsOn: ["bore"], parameterRefs: ["bolt_circle_diameter", "bolt_hole_diameter", "bolt_hole_count"] },
    ],
    validate(v) {
      assertRule(v.bore_diameter + 2 < v.outer_diameter, "$.parameters.bore_diameter", "中心孔外侧必须保留至少 1mm 材料");
      assertRule(v.bolt_circle_diameter - v.bolt_hole_diameter >= v.bore_diameter + 2, "$.parameters.bolt_circle_diameter", "螺栓孔与中心孔之间材料不足");
      assertRule(v.bolt_circle_diameter + v.bolt_hole_diameter <= v.outer_diameter - 2, "$.parameters.bolt_circle_diameter", "螺栓孔与法兰外缘之间材料不足");
      const adjacentChord = v.bolt_circle_diameter * Math.sin(Math.PI / v.bolt_hole_count);
      assertRule(adjacentChord >= v.bolt_hole_diameter + 1, "$.parameters.bolt_hole_count", "相邻螺栓孔间距不足，至少需保留 1mm 材料");
    },
  },
  shaft_adapter: {
    name: "轴径转接套",
    parameters: {
      length: mm(50, 10, 1_000),
      outer_diameter: mm(30, 5, 500),
      bore_diameter_a: mm(10, 0.5, 450),
      bore_diameter_b: mm(12, 0.5, 450),
      transition_length: mm(10, 1, 500),
      set_screw_diameter: mm(4, 1, 30),
      set_screw_count: count(1, 0, 8),
    },
    graph: [
      { id: "body", kind: "revolve", operation: "add", dependsOn: [], parameterRefs: ["length", "outer_diameter"] },
      { id: "bore_a", kind: "bore", operation: "cut", dependsOn: ["body"], parameterRefs: ["bore_diameter_a", "length", "transition_length"] },
      { id: "bore_b", kind: "bore", operation: "cut", dependsOn: ["bore_a"], parameterRefs: ["bore_diameter_a", "bore_diameter_b", "length", "transition_length"] },
      { id: "set_screws", kind: "set_screw_pattern", operation: "cut", dependsOn: ["bore_b"], parameterRefs: ["length", "outer_diameter", "bore_diameter_a", "bore_diameter_b", "set_screw_diameter", "set_screw_count"] },
    ],
    validate(v) {
      const bore = Math.max(v.bore_diameter_a, v.bore_diameter_b);
      assertRule(bore + 2 <= v.outer_diameter, "$.parameters.outer_diameter", "最大轴孔外侧必须保留至少 1mm 壁厚");
      assertRule(v.transition_length < v.length, "$.parameters.transition_length", "过渡段必须短于转接套总长");
      if (v.set_screw_count > 0) {
        assertRule(v.set_screw_diameter <= v.length / 2, "$.parameters.set_screw_diameter", "紧定螺钉孔直径相对总长过大");
        if (v.set_screw_count > 1) {
          const innerRadius = Math.max(v.bore_diameter_a, v.bore_diameter_b) / 2;
          const adjacentChord = 2 * innerRadius * Math.sin(Math.PI / v.set_screw_count);
          assertRule(adjacentChord >= v.set_screw_diameter + 0.5, "$.parameters.set_screw_count", "紧定螺钉孔在内孔侧相交");
        }
      }
    },
  },
  humanoid_robot: {
    name: "人形机器人概念总成",
    parameters: {
      overall_height: mm(1_700, 500, 3_000),
      overall_width: mm(650, 250, 2_000),
      overall_depth: mm(380, 150, 1_200),
      limb_diameter: mm(100, 30, 300),
      joint_clearance: mm(15, 2, 100),
    },
    graph: [
      {
        id: "assembly_layout",
        kind: "assembly_layout",
        operation: "add",
        dependsOn: [],
        parameterRefs: ["overall_height", "overall_width", "overall_depth", "joint_clearance"],
      },
      {
        id: "central_components",
        kind: "component_set",
        operation: "add",
        dependsOn: ["assembly_layout"],
        parameterRefs: ["overall_height", "overall_width", "overall_depth", "limb_diameter", "joint_clearance"],
      },
      {
        id: "limb_components",
        kind: "component_set",
        operation: "add",
        dependsOn: ["central_components"],
        parameterRefs: ["overall_height", "overall_width", "overall_depth", "limb_diameter", "joint_clearance"],
      },
    ],
    validate(v) {
      const torsoWidth = v.overall_width * 0.28;
      const sideUsable = (v.overall_width - torsoWidth) / 2 - 3 * v.joint_clearance;
      const fixedHeight = v.overall_height * (0.12 + 0.04 + 0.24 + 0.10 + 0.055);
      const legSegmentHeight = (v.overall_height - fixedHeight - 6 * v.joint_clearance) / 2;
      assertRule(
        v.limb_diameter + 2 * v.joint_clearance <= v.overall_depth,
        "$.parameters.limb_diameter",
        "肢体直径与关节间隙无法容纳在总深度内"
      );
      assertRule(
        2 * v.limb_diameter + v.joint_clearance < v.overall_width,
        "$.parameters.limb_diameter",
        "双腿与中间关节间隙无法容纳在总宽度内"
      );
      assertRule(
        sideUsable > 5 * v.joint_clearance,
        "$.parameters.overall_width",
        "总宽度不足以布置手、前臂、上臂及关节间隙"
      );
      assertRule(
        legSegmentHeight > v.limb_diameter + v.joint_clearance,
        "$.parameters.overall_height",
        "总高度不足以布置脚、小腿、大腿及关节间隙"
      );
      assertRule(
        v.limb_diameter < v.overall_height * 0.24,
        "$.parameters.limb_diameter",
        "肢体直径必须小于躯干高度"
      );
    },
  },
  concept_car: {
    name: "概念汽车总成",
    parameters: {
      overall_length: mm(4_500, 1_000, 12_000),
      overall_width: mm(1_800, 800, 4_000),
      overall_height: mm(1_450, 500, 4_000),
      wheelbase: mm(2_700, 500, 8_000),
      wheel_diameter: mm(650, 200, 1_500),
      wheel_width: mm(220, 50, 600),
      ground_clearance: mm(160, 20, 600),
    },
    graph: [
      {
        id: "assembly_layout",
        kind: "assembly_layout",
        operation: "add",
        dependsOn: [],
        parameterRefs: ["overall_length", "overall_width", "overall_height"],
      },
      {
        id: "main_body",
        kind: "component_set",
        operation: "add",
        dependsOn: ["assembly_layout"],
        parameterRefs: ["overall_length", "overall_width", "overall_height", "ground_clearance", "wheel_width"],
      },
      {
        id: "wheel_set",
        kind: "wheel_set",
        operation: "add",
        dependsOn: ["main_body"],
        parameterRefs: ["overall_length", "overall_width", "wheelbase", "wheel_diameter", "wheel_width"],
      },
    ],
    validate(v) {
      const sideGap = Math.max(10, v.overall_width * 0.01);
      assertRule(
        v.wheelbase + v.wheel_diameter <= v.overall_length,
        "$.parameters.wheelbase",
        "轴距与轮径无法容纳在整车长度内"
      );
      assertRule(
        v.wheelbase > v.wheel_diameter,
        "$.parameters.wheelbase",
        "前后车轮不得相交"
      );
      assertRule(
        2 * (v.wheel_width + sideGap) < v.overall_width,
        "$.parameters.wheel_width",
        "轮宽与安全侧隙挤占了全部车身宽度"
      );
      assertRule(
        v.wheel_diameter <= v.overall_height,
        "$.parameters.wheel_diameter",
        "轮径不得超过整车高度"
      );
      assertRule(
        v.ground_clearance < v.overall_height,
        "$.parameters.ground_clearance",
        "离地间隙必须小于整车高度"
      );
    },
  },
};

export const CAD_TEMPLATE_DEFAULTS: Record<CadTemplate, Readonly<Record<string, number>>> =
  Object.fromEntries(
    CAD_TEMPLATES.map((template) => [
      template,
      Object.freeze(
        Object.fromEntries(
          Object.entries(TEMPLATE_DEFINITIONS[template].parameters).map(([key, def]) => [key, def.defaultValue])
        )
      ),
    ])
  ) as Record<CadTemplate, Readonly<Record<string, number>>>;

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "unit",
  "template",
  "name",
  "material",
  "process",
  "requirements",
  "parameters",
]);
const REQUIREMENT_KEYS = new Set(["id", "text", "sourceRefs", "acceptance"]);
const PARAMETER_VALUE_KEYS = new Set(["value", "requirementRefs"]);
const RESERVED_REQUIREMENT_IDS = new Set(["req_template_defaults", "req_model_input"]);
const FORBIDDEN_NORMALIZED_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "python",
  "pythoncode",
  "code",
  "script",
  "path",
  "filepath",
  "filename",
  "url",
  "uri",
  "command",
  "shell",
  "import",
  "module",
  "executable",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function assertSafeShape(value: unknown, path = "$", depth = 0, state = { nodes: 0 }): void {
  state.nodes++;
  if (state.nodes > 4_096) issue(path, "too_complex", "输入节点过多");
  if (depth > 8) issue(path, "too_deep", "输入嵌套过深");
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeShape(item, `${path}[${index}]`, depth + 1, state));
    return;
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainRecord(value)) issue(path, "object_type", "只接受普通 JSON 对象");
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_NORMALIZED_KEYS.has(normalizeKey(key))) {
        issue(`${path}.${key}`, "forbidden_field", `禁止字段 ${key}`);
      }
      assertSafeShape(child, `${path}.${key}`, depth + 1, state);
    }
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(`${path}.${key}`, "unknown_field", `未知字段 ${key}`);
  }
}

function safeText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") issue(path, "string_required", "必须是字符串");
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) issue(path, "empty_string", "不能为空");
  if (text.length > maxLength) issue(path, "string_too_long", `最长 ${maxLength} 字符`);
  if (/[\u0000-\u001f\u007f]/.test(text)) issue(path, "control_character", "不能包含控制字符");
  return text;
}

function safeName(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  const name = safeText(value, "$.name", 80);
  if (/[\\/]/.test(name) || /(^|\s)\.\.?($|\s)/.test(name)) {
    issue("$.name", "unsafe_name", "名称不能包含路径分隔符或相对路径");
  }
  return name;
}

function parseSourceRefs(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) issue(path, "array_required", "sourceRefs 必须是数组");
  if (value.length === 0 || value.length > 8) issue(path, "source_ref_count", "sourceRefs 需 1–8 项");
  const refs = value.map((ref, index) => {
    if (typeof ref !== "string") issue(`${path}[${index}]`, "string_required", "来源引用必须是字符串");
    const normalized = ref.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(normalized)) {
      issue(`${path}[${index}]`, "unsafe_source_ref", "来源引用只允许安全 ID，不允许路径或 URL");
    }
    return normalized;
  });
  if (new Set(refs).size !== refs.length) issue(path, "duplicate_source_ref", "sourceRefs 不能重复");
  return [...refs].sort();
}

function parseRequirementRefs(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) issue(path, "array_required", "requirementRefs 必须是数组");
  if (value.length === 0 || value.length > 16) issue(path, "requirement_ref_count", "requirementRefs 需 1–16 项");
  const refs = value.map((ref, index) => {
    if (typeof ref !== "string" || !/^req_[a-z][a-z0-9_]{0,47}$/.test(ref)) {
      issue(`${path}[${index}]`, "requirement_ref", "需引用合法的需求 ID");
    }
    return ref;
  });
  return [...new Set(refs)].sort();
}

function parseRequirements(value: unknown): RequirementSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) issue("$.requirements", "array_required", "requirements 必须是数组");
  if (value.length > 32) issue("$.requirements", "too_many_requirements", "需求最多 32 项");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const path = `$.requirements[${index}]`;
    if (!isPlainRecord(entry)) issue(path, "object_required", "需求必须是对象");
    assertExactKeys(entry, REQUIREMENT_KEYS, path);
    const id = entry.id;
    if (typeof id !== "string" || !/^req_[a-z][a-z0-9_]{0,47}$/.test(id)) {
      issue(`${path}.id`, "requirement_id", "需求 ID 必须匹配 req_[a-z][a-z0-9_]*");
    }
    if (RESERVED_REQUIREMENT_IDS.has(id)) issue(`${path}.id`, "reserved_id", "该需求 ID 为系统保留值");
    if (seen.has(id)) issue(`${path}.id`, "duplicate_id", "需求 ID 不能重复");
    seen.add(id);
    const requirement: RequirementSpec = {
      id,
      text: safeText(entry.text, `${path}.text`, 500),
      sourceRefs: parseSourceRefs(entry.sourceRefs, `${path}.sourceRefs`),
    };
    if (entry.acceptance !== undefined) {
      requirement.acceptance = safeText(entry.acceptance, `${path}.acceptance`, 300);
    }
    return requirement;
  });
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  if (text.includes("e")) {
    const [coefficient, exponentText] = text.split("e");
    const exponent = Number(exponentText);
    const fraction = (coefficient.split(".")[1] ?? "").length;
    return Math.max(0, fraction - exponent);
  }
  return (text.split(".")[1] ?? "").length;
}

function parseParameterValue(
  raw: unknown,
  definition: ParamDefinition,
  key: string,
  requirementIds: Set<string>
): CadParameter {
  const path = `$.parameters.${key}`;
  let value: unknown = raw;
  let refs = ["req_model_input"];
  if (isPlainRecord(raw)) {
    assertExactKeys(raw, PARAMETER_VALUE_KEYS, path);
    value = raw.value;
    if (raw.requirementRefs !== undefined) refs = parseRequirementRefs(raw.requirementRefs, `${path}.requirementRefs`);
  } else if (typeof raw !== "number") {
    issue(path, "number_required", "参数必须是数值或 {value, requirementRefs}");
  }
  if (typeof value !== "number" || !Number.isFinite(value)) issue(`${path}.value`, "finite_number", "参数必须是有限数");
  const normalized = Object.is(value, -0) ? 0 : value;
  if (decimalPlaces(normalized) > 3) issue(`${path}.value`, "precision", "参数最多保留 3 位小数");
  if (definition.integer && !Number.isInteger(normalized)) issue(`${path}.value`, "integer_required", "该参数必须是整数");
  if (normalized < definition.min || normalized > definition.max) {
    issue(`${path}.value`, "range", `参数需在 ${definition.min}–${definition.max} 之间`);
  }
  for (const ref of refs) {
    if (!requirementIds.has(ref)) issue(`${path}.requirementRefs`, "missing_requirement", `需求 ${ref} 不存在`);
  }
  return { value: normalized, unit: definition.integer ? "count" : "mm", requirementRefs: refs };
}

function deriveFeatureGraph(
  definition: TemplateDefinition,
  parameters: Record<string, CadParameter>
): FeatureGraph {
  const seen = new Set<string>();
  const nodes = definition.graph.map((node) => {
    for (const dependency of node.dependsOn) {
      if (!seen.has(dependency)) issue("$.featureGraph", "invalid_graph", `特征 ${node.id} 依赖不存在或尚未定义的 ${dependency}`);
    }
    for (const ref of node.parameterRefs) {
      if (!parameters[ref]) issue("$.featureGraph", "invalid_graph", `特征 ${node.id} 引用不存在的参数 ${ref}`);
    }
    seen.add(node.id);
    const requirementRefs = [...new Set(node.parameterRefs.flatMap((ref) => parameters[ref].requirementRefs))].sort();
    return {
      id: node.id,
      kind: node.kind,
      operation: node.operation,
      dependsOn: [...node.dependsOn],
      parameterRefs: [...node.parameterRefs],
      requirementRefs,
    };
  });
  return { nodes };
}

export function normalizeCadDesignSpec(input: unknown): CadDesignSpec {
  assertSafeShape(input);
  if (!isPlainRecord(input)) issue("$", "object_required", "CAD 规格必须是 JSON 对象");
  assertExactKeys(input, TOP_LEVEL_KEYS, "$");
  if (input.schemaVersion !== CAD_SCHEMA_VERSION) issue("$.schemaVersion", "schema_version", "schemaVersion 必须为 1");
  if (input.unit !== "mm") issue("$.unit", "unit", "仅支持 mm");
  if (typeof input.template !== "string" || !(CAD_TEMPLATES as readonly string[]).includes(input.template)) {
    issue("$.template", "template", `仅支持 ${CAD_TEMPLATES.join(", ")}`);
  }
  const template = input.template as CadTemplate;
  const definition = TEMPLATE_DEFINITIONS[template];
  const material = input.material === undefined ? "unspecified" : input.material;
  if (typeof material !== "string" || !(CAD_MATERIALS as readonly string[]).includes(material)) {
    issue("$.material", "material", `材料仅支持 ${CAD_MATERIALS.join(", ")}`);
  }
  const process = input.process === undefined ? "unspecified" : input.process;
  if (typeof process !== "string" || !(CAD_PROCESSES as readonly string[]).includes(process)) {
    issue("$.process", "process", `工艺仅支持 ${CAD_PROCESSES.join(", ")}`);
  }

  const explicitRequirements = parseRequirements(input.requirements);
  const requirements: RequirementSpec[] = [
    {
      id: "req_template_defaults",
      text: `使用 ${definition.name} 受控模板的安全默认值`,
      sourceRefs: ["system:template-defaults"],
      acceptance: "所有默认参数均通过模板范围与业务规则校验",
    },
    {
      id: "req_model_input",
      text: "使用经受控规范化的模型输入参数",
      sourceRefs: ["model:input"],
    },
    ...explicitRequirements,
  ].sort((a, b) => a.id.localeCompare(b.id));
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));

  const rawParameters = input.parameters === undefined ? {} : input.parameters;
  if (!isPlainRecord(rawParameters)) issue("$.parameters", "object_required", "parameters 必须是对象");
  for (const key of Object.keys(rawParameters)) {
    if (!definition.parameters[key]) issue(`$.parameters.${key}`, "unknown_parameter", `模板 ${template} 不支持参数 ${key}`);
  }

  const parameters: Record<string, CadParameter> = {};
  for (const key of Object.keys(definition.parameters).sort()) {
    const parameterDefinition = definition.parameters[key];
    parameters[key] = Object.prototype.hasOwnProperty.call(rawParameters, key)
      ? parseParameterValue(rawParameters[key], parameterDefinition, key, requirementIds)
      : {
          value: parameterDefinition.defaultValue,
          unit: parameterDefinition.integer ? "count" : "mm",
          requirementRefs: ["req_template_defaults"],
        };
  }
  definition.validate(Object.fromEntries(Object.entries(parameters).map(([key, parameter]) => [key, parameter.value])));

  return {
    schemaVersion: CAD_SCHEMA_VERSION,
    unit: "mm",
    template,
    name: safeName(input.name, definition.name),
    material: material as CadMaterial,
    process: process as CadProcess,
    requirements,
    parameters,
    featureGraph: deriveFeatureGraph(definition, parameters),
  };
}

export function parseCadDesignSpecJson(json: string): CadDesignSpec {
  if (typeof json !== "string") issue("$", "json_string", "输入必须是 JSON 字符串");
  if (Buffer.byteLength(json, "utf8") > CAD_MAX_JSON_BYTES) issue("$", "json_too_large", `JSON 不能超过 ${CAD_MAX_JSON_BYTES} 字节`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    issue("$", "invalid_json", "JSON 解析失败");
  }
  return normalizeCadDesignSpec(parsed);
}

function canonicalize(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issue("$", "canonical_number", "canonical JSON 不支持非有限数");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") issue("$", "canonical_type", "canonical JSON 仅支持 JSON 值");
  if (stack.has(value)) issue("$", "canonical_cycle", "canonical JSON 不支持循环引用");
  stack.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, stack)).join(",")}]`;
    if (!isPlainRecord(value)) issue("$", "canonical_object", "canonical JSON 仅支持普通对象");
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], stack)}`)
      .join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

/** 对键排序、保留数组语义顺序的确定性 JSON。 */
export function stableCanonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

export function canonicalCadDesignJson(spec: CadDesignSpec): string {
  // 再走一次受控规范化，防止调用者伪造类型后将未校验对象拿去 hash。
  const safe = normalizeCadDesignSpec({
    schemaVersion: spec.schemaVersion,
    unit: spec.unit,
    template: spec.template,
    name: spec.name,
    material: spec.material,
    process: spec.process,
    requirements: spec.requirements.filter((requirement) => !RESERVED_REQUIREMENT_IDS.has(requirement.id)),
    parameters: Object.fromEntries(
      Object.entries(spec.parameters).map(([key, parameter]) => [
        key,
        { value: parameter.value, requirementRefs: parameter.requirementRefs },
      ])
    ),
  });
  return stableCanonicalJson(safe);
}

/** SHA-256 内容地址，可用于缓存/幂等键；不包含任何路径。 */
export function canonicalCadDesignHash(spec: CadDesignSpec): string {
  return createHash("sha256").update(canonicalCadDesignJson(spec), "utf8").digest("hex");
}
