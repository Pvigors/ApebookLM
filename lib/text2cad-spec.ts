import { createHash } from "node:crypto";

/**
 * Text2CAD V2 的纯规格层。
 *
 * 本模块只接收受控 JSON 数据，不执行模型生成的代码，也不接受路径、URL、
 * 命令或任意几何脚本。几何执行器只能消费 normalizeText2CadSpec 的返回值。
 */

export const TEXT2CAD_SCHEMA_VERSION = 2 as const;
export const TEXT2CAD_ENGINE = "text2cad" as const;
export const TEXT2CAD_UNIT = "mm" as const;
export const TEXT2CAD_MAX_JSON_BYTES = 256 * 1024;
export const TEXT2CAD_MAX_DIMENSION_MM = 12_000;
export const TEXT2CAD_MAX_PARTS = 24;
export const TEXT2CAD_MAX_FEATURES_PER_PART = 32;

export const TEXT2CAD_OPERATIONS = ["new", "add", "cut", "intersect"] as const;
export type Text2CadOperation = (typeof TEXT2CAD_OPERATIONS)[number];

export const TEXT2CAD_PLANES = ["XY", "XZ", "YZ"] as const;
export type Text2CadPlane = (typeof TEXT2CAD_PLANES)[number];

export type Text2CadPoint2 = [number, number];
export type Text2CadPoint3 = [number, number, number];

export type Text2CadRequirement = {
  id: string;
  text: string;
  sourceRefs: string[];
  acceptance?: string;
};

export type Text2CadPlacement = {
  translate: Text2CadPoint3;
  rotateDeg: Text2CadPoint3;
};

export type Text2CadRectangleProfile = {
  kind: "rectangle";
  center: Text2CadPoint2;
  width: number;
  height: number;
  cornerRadius: number;
};

export type Text2CadCircleProfile = {
  kind: "circle";
  center: Text2CadPoint2;
  radius: number;
};

export type Text2CadPolygonProfile = {
  kind: "polygon";
  points: Text2CadPoint2[];
};

export type Text2CadLineSegment = {
  kind: "line";
  start: Text2CadPoint2;
  end: Text2CadPoint2;
};

export type Text2CadThreePointArcSegment = {
  kind: "arc";
  start: Text2CadPoint2;
  mid: Text2CadPoint2;
  end: Text2CadPoint2;
};

export type Text2CadPathSegment = Text2CadLineSegment | Text2CadThreePointArcSegment;

export type Text2CadPathProfile = {
  kind: "path";
  segments: Text2CadPathSegment[];
};

export type Text2CadProfile =
  | Text2CadRectangleProfile
  | Text2CadCircleProfile
  | Text2CadPolygonProfile
  | Text2CadPathProfile;

export type Text2CadProfileSet = {
  outer: Text2CadProfile;
  holes: Text2CadProfile[];
};

export type Text2CadExtrudeFeature = {
  id: string;
  kind: "extrude";
  operation: Text2CadOperation;
  plane: Text2CadPlane;
  origin: Text2CadPoint3;
  profile: Text2CadProfileSet;
  distance: number;
  requirementRefs: string[];
};

export type Text2CadFeature = Text2CadExtrudeFeature;

export type Text2CadPart = {
  id: string;
  name: string;
  material: string;
  color: string;
  placement: Text2CadPlacement;
  features: Text2CadExtrudeFeature[];
};

export type Text2CadSpec = {
  schemaVersion: typeof TEXT2CAD_SCHEMA_VERSION;
  engine: typeof TEXT2CAD_ENGINE;
  unit: typeof TEXT2CAD_UNIT;
  name: string;
  /** 与几何一起冻结的制造工艺元数据；未明确时为 unspecified。 */
  process: string;
  requirements: Text2CadRequirement[];
  assumptions: string[];
  parts: Text2CadPart[];
};

export type Text2CadSpecIssue = {
  path: string;
  code: string;
  message: string;
};

export class Text2CadSpecValidationError extends Error {
  readonly issues: readonly Text2CadSpecIssue[];

  constructor(issueValue: Text2CadSpecIssue | Text2CadSpecIssue[]) {
    const issues = Array.isArray(issueValue) ? issueValue : [issueValue];
    super(issues.map((item) => `${item.path}: ${item.message}`).join("; "));
    this.name = "Text2CadSpecValidationError";
    this.issues = issues;
  }
}

const RESERVED_REQUIREMENT_ID = "req_model_input";
const RESERVED_REQUIREMENT = Object.freeze({
  id: RESERVED_REQUIREMENT_ID,
  text: "使用经受控规范化的 Text2CAD 输入生成模型",
  sourceRefs: Object.freeze(["model:input"] as const),
});

function reservedRequirement(): Text2CadRequirement {
  return {
    id: RESERVED_REQUIREMENT.id,
    text: RESERVED_REQUIREMENT.text,
    sourceRefs: [...RESERVED_REQUIREMENT.sourceRefs],
  };
}

const ZERO_POINT_2: Text2CadPoint2 = [0, 0];
const ZERO_POINT_3: Text2CadPoint3 = [0, 0, 0];

export const TEXT2CAD_DEFAULTS = Object.freeze({
  name: "未命名 CAD 模型",
  material: "unspecified",
  process: "unspecified",
  color: "#6D5CE7",
  placement: Object.freeze({
    translate: Object.freeze([0, 0, 0] as const),
    rotateDeg: Object.freeze([0, 0, 0] as const),
  }),
  feature: Object.freeze({
    plane: "XY" as const,
    origin: Object.freeze([0, 0, 0] as const),
    requirementRefs: Object.freeze([RESERVED_REQUIREMENT_ID] as const),
  }),
});

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "engine",
  "unit",
  "name",
  "process",
  "requirements",
  "assumptions",
  "parts",
]);
const REQUIREMENT_KEYS = new Set(["id", "text", "sourceRefs", "acceptance"]);
const PART_KEYS = new Set(["id", "name", "material", "color", "placement", "features"]);
const PLACEMENT_KEYS = new Set(["translate", "rotateDeg"]);
const FEATURE_KEYS = new Set([
  "id",
  "kind",
  "operation",
  "plane",
  "origin",
  "profile",
  "distance",
  "requirementRefs",
]);
const PROFILE_SET_KEYS = new Set(["outer", "holes"]);
const RECTANGLE_KEYS = new Set(["kind", "center", "width", "height", "cornerRadius"]);
const CIRCLE_KEYS = new Set(["kind", "center", "radius"]);
const POLYGON_KEYS = new Set(["kind", "points"]);
const PATH_KEYS = new Set(["kind", "segments"]);
const LINE_SEGMENT_KEYS = new Set(["kind", "start", "end"]);
const ARC_SEGMENT_KEYS = new Set(["kind", "start", "mid", "end"]);

const FORBIDDEN_NORMALIZED_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "python",
  "pythoncode",
  "javascript",
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

function issue(path: string, code: string, message: string): never {
  throw new Text2CadSpecValidationError({ path, code, message });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function assertSafeShape(
  value: unknown,
  path = "$",
  depth = 0,
  state: { nodes: number; active: Set<object> } = { nodes: 0, active: new Set() }
): void {
  state.nodes++;
  if (state.nodes > 32_768) issue(path, "too_complex", "输入节点过多");
  if (depth > 14) issue(path, "too_deep", "输入嵌套过深");
  if (Array.isArray(value)) {
    if (state.active.has(value)) issue(path, "cycle", "输入不能包含循环引用");
    state.active.add(value);
    try {
      value.forEach((item, index) => assertSafeShape(item, `${path}[${index}]`, depth + 1, state));
    } finally {
      state.active.delete(value);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainRecord(value)) issue(path, "object_type", "只接受普通 JSON 对象");
    if (state.active.has(value)) issue(path, "cycle", "输入不能包含循环引用");
    state.active.add(value);
    try {
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_NORMALIZED_KEYS.has(normalizeKey(key))) {
          issue(`${path}.${key}`, "forbidden_field", `禁止字段 ${key}`);
        }
        assertSafeShape(child, `${path}.${key}`, depth + 1, state);
      }
    } finally {
      state.active.delete(value);
    }
  }
}

function assertInputSize(value: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    issue("$", "invalid_json_value", "输入必须可序列化为 JSON");
  }
  if (Buffer.byteLength(encoded, "utf8") > TEXT2CAD_MAX_JSON_BYTES) {
    issue("$", "json_too_large", `JSON 不能超过 ${TEXT2CAD_MAX_JSON_BYTES} 字节`);
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(`${path}.${key}`, "unknown_field", `未知字段 ${key}`);
  }
}

function assertSafeTextContent(text: string, path: string): void {
  if (/(?:https?|ftp|file):\/\/|\bwww\./i.test(text)) {
    issue(path, "forbidden_url", "不能包含 URL");
  }
  if (/(?:^|[\s"'`])(?:\.{0,2}[\\/][A-Za-z0-9._-]+){2,}(?:$|[\s"'`])|[A-Za-z]:[\\/]/.test(text)) {
    issue(path, "forbidden_path", "不能包含文件路径");
  }
  if (
    /```|<script\b|#!\s*\//i.test(text) ||
    /\b(?:eval|exec|spawn|system|require)\s*\(/i.test(text) ||
    /\bimport\s+(?:[^，。,.]{0,40}\s+from\s+)?["']/i.test(text)
  ) {
    issue(path, "forbidden_code", "不能包含代码或可执行指令");
  }
}

function safeText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") issue(path, "string_required", "必须是字符串");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) issue(path, "empty_string", "不能为空");
  if (normalized.length > maxLength) issue(path, "string_too_long", `最长 ${maxLength} 字符`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) issue(path, "control_character", "不能包含控制字符");
  assertSafeTextContent(normalized, path);
  return normalized;
}

function safeName(value: unknown, path: string, fallback: string): string {
  if (value === undefined) return fallback;
  const normalized = safeText(value, path, 80);
  if (/[\\/]/.test(normalized) || /(^|\s)\.\.?(?:$|\s)/.test(normalized)) {
    issue(path, "unsafe_name", "名称不能包含路径分隔符或相对路径");
  }
  return normalized;
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

function safeNumber(
  value: unknown,
  path: string,
  options: { min: number; max: number }
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issue(path, "finite_number", "必须是有限数");
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  if (decimalPlaces(normalized) > 3) issue(path, "precision", "数值最多保留 3 位小数");
  if (normalized < options.min || normalized > options.max) {
    issue(path, "range", `数值需在 ${options.min}–${options.max} 之间`);
  }
  return normalized;
}

function point2(value: unknown, path: string): Text2CadPoint2 {
  if (!Array.isArray(value) || value.length !== 2) issue(path, "point2", "必须是两个数值组成的坐标");
  return [
    safeNumber(value[0], `${path}[0]`, { min: -TEXT2CAD_MAX_DIMENSION_MM, max: TEXT2CAD_MAX_DIMENSION_MM }),
    safeNumber(value[1], `${path}[1]`, { min: -TEXT2CAD_MAX_DIMENSION_MM, max: TEXT2CAD_MAX_DIMENSION_MM }),
  ];
}

function point3(value: unknown, path: string): Text2CadPoint3 {
  if (!Array.isArray(value) || value.length !== 3) issue(path, "point3", "必须是三个数值组成的坐标");
  return [
    safeNumber(value[0], `${path}[0]`, { min: -TEXT2CAD_MAX_DIMENSION_MM, max: TEXT2CAD_MAX_DIMENSION_MM }),
    safeNumber(value[1], `${path}[1]`, { min: -TEXT2CAD_MAX_DIMENSION_MM, max: TEXT2CAD_MAX_DIMENSION_MM }),
    safeNumber(value[2], `${path}[2]`, { min: -TEXT2CAD_MAX_DIMENSION_MM, max: TEXT2CAD_MAX_DIMENSION_MM }),
  ];
}

function rotation3(value: unknown, path: string): Text2CadPoint3 {
  if (!Array.isArray(value) || value.length !== 3) issue(path, "rotation3", "必须是三个数值组成的欧拉角");
  return [
    safeNumber(value[0], `${path}[0]`, { min: -360, max: 360 }),
    safeNumber(value[1], `${path}[1]`, { min: -360, max: 360 }),
    safeNumber(value[2], `${path}[2]`, { min: -360, max: 360 }),
  ];
}

function samePoint(a: Text2CadPoint2, b: Text2CadPoint2): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function polygonArea(points: Text2CadPoint2[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(twiceArea) / 2;
}

function parsePathSegment(value: unknown, path: string): Text2CadPathSegment {
  if (!isPlainRecord(value)) issue(path, "object_required", "路径段必须是对象");
  if (value.kind === "line") {
    assertExactKeys(value, LINE_SEGMENT_KEYS, path);
    const start = point2(value.start, `${path}.start`);
    const end = point2(value.end, `${path}.end`);
    if (samePoint(start, end)) issue(path, "zero_length", "直线段起终点不能重合");
    return { kind: "line", start, end };
  }
  if (value.kind === "arc") {
    assertExactKeys(value, ARC_SEGMENT_KEYS, path);
    const start = point2(value.start, `${path}.start`);
    const mid = point2(value.mid, `${path}.mid`);
    const end = point2(value.end, `${path}.end`);
    if (samePoint(start, mid) || samePoint(mid, end) || samePoint(start, end)) {
      issue(path, "invalid_arc", "三点圆弧的三个点不能重合");
    }
    const cross = (mid[0] - start[0]) * (end[1] - start[1]) - (mid[1] - start[1]) * (end[0] - start[0]);
    if (Math.abs(cross) < 1e-9) issue(path, "invalid_arc", "三点圆弧的三个点不能共线");
    return { kind: "arc", start, mid, end };
  }
  issue(`${path}.kind`, "segment_kind", "路径段仅支持 line 或 arc");
}

function parseProfile(value: unknown, path: string): Text2CadProfile {
  if (!isPlainRecord(value)) issue(path, "object_required", "轮廓必须是对象");
  if (value.kind === "rectangle") {
    assertExactKeys(value, RECTANGLE_KEYS, path);
    const center = value.center === undefined ? [...ZERO_POINT_2] as Text2CadPoint2 : point2(value.center, `${path}.center`);
    const width = safeNumber(value.width, `${path}.width`, { min: 0.001, max: TEXT2CAD_MAX_DIMENSION_MM });
    const height = safeNumber(value.height, `${path}.height`, { min: 0.001, max: TEXT2CAD_MAX_DIMENSION_MM });
    const cornerRadius = value.cornerRadius === undefined
      ? 0
      : safeNumber(value.cornerRadius, `${path}.cornerRadius`, { min: 0, max: TEXT2CAD_MAX_DIMENSION_MM });
    if (cornerRadius * 2 >= Math.min(width, height) && cornerRadius !== 0) {
      issue(`${path}.cornerRadius`, "profile_rule", "矩形圆角半径必须小于短边的一半");
    }
    return { kind: "rectangle", center, width, height, cornerRadius };
  }
  if (value.kind === "circle") {
    assertExactKeys(value, CIRCLE_KEYS, path);
    return {
      kind: "circle",
      center: value.center === undefined ? [...ZERO_POINT_2] as Text2CadPoint2 : point2(value.center, `${path}.center`),
      radius: safeNumber(value.radius, `${path}.radius`, { min: 0.001, max: TEXT2CAD_MAX_DIMENSION_MM / 2 }),
    };
  }
  if (value.kind === "polygon") {
    assertExactKeys(value, POLYGON_KEYS, path);
    if (!Array.isArray(value.points)) issue(`${path}.points`, "array_required", "多边形 points 必须是数组");
    if (value.points.length < 3 || value.points.length > 128) {
      issue(`${path}.points`, "point_count", "多边形需要 3–128 个点");
    }
    const points = value.points.map((entry, index) => point2(entry, `${path}.points[${index}]`));
    for (let index = 0; index < points.length; index++) {
      if (samePoint(points[index], points[(index + 1) % points.length])) {
        issue(`${path}.points[${index}]`, "duplicate_point", "相邻多边形点不能重合");
      }
    }
    if (polygonArea(points) < 0.000001) issue(`${path}.points`, "zero_area", "多边形面积必须大于 0");
    return { kind: "polygon", points };
  }
  if (value.kind === "path") {
    assertExactKeys(value, PATH_KEYS, path);
    if (!Array.isArray(value.segments)) issue(`${path}.segments`, "array_required", "path.segments 必须是数组");
    if (value.segments.length < 2 || value.segments.length > 128) {
      issue(`${path}.segments`, "segment_count", "闭合路径需要 2–128 段");
    }
    const segments = value.segments.map((entry, index) => parsePathSegment(entry, `${path}.segments[${index}]`));
    for (let index = 1; index < segments.length; index++) {
      if (!samePoint(segments[index - 1].end, segments[index].start)) {
        issue(`${path}.segments[${index}].start`, "path_disconnected", "路径段必须首尾连续");
      }
    }
    if (!samePoint(segments.at(-1)!.end, segments[0].start)) {
      issue(`${path}.segments`, "path_open", "路径必须闭合");
    }
    return { kind: "path", segments };
  }
  issue(`${path}.kind`, "profile_kind", "轮廓仅支持 rectangle、circle、polygon 或 path");
}

function parseRequirementRefs(value: unknown, path: string, requirementIds: Set<string>): string[] {
  if (value === undefined) return [RESERVED_REQUIREMENT_ID];
  if (!Array.isArray(value)) issue(path, "array_required", "requirementRefs 必须是数组");
  if (value.length < 1 || value.length > 32) issue(path, "requirement_ref_count", "requirementRefs 需 1–32 项");
  const refs = value.map((entry, index) => {
    if (typeof entry !== "string" || !/^req_[a-z][a-z0-9_]{0,47}$/.test(entry)) {
      issue(`${path}[${index}]`, "requirement_ref", "需引用合法的需求 ID");
    }
    if (!requirementIds.has(entry)) issue(`${path}[${index}]`, "missing_requirement", `需求 ${entry} 不存在`);
    return entry;
  });
  if (new Set(refs).size !== refs.length) issue(path, "duplicate_ref", "requirementRefs 不能重复");
  return [...refs].sort();
}

function parseSourceRefs(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) issue(path, "array_required", "sourceRefs 必须是数组");
  if (value.length < 1 || value.length > 16) issue(path, "source_ref_count", "sourceRefs 需 1–16 项");
  const refs = value.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      !/^(?:prompt:1|source:[1-9][0-9]{0,5}|system:design-assumption|model:input)$/.test(entry)
    ) {
      issue(
        `${path}[${index}]`,
        "source_ref",
        "来源引用仅支持 prompt:1、source:N、system:design-assumption 或 model:input"
      );
    }
    return entry;
  });
  if (new Set(refs).size !== refs.length) issue(path, "duplicate_source_ref", "sourceRefs 不能重复");
  return [...refs].sort();
}

function parseRequirements(value: unknown): Text2CadRequirement[] {
  if (value === undefined) return [reservedRequirement()];
  if (!Array.isArray(value)) issue("$.requirements", "array_required", "requirements 必须是数组");
  if (value.length > 64) issue("$.requirements", "requirement_count", "需求最多 64 项");
  const seen = new Set<string>();
  const requirements = value.map((entry, index) => {
    const path = `$.requirements[${index}]`;
    if (!isPlainRecord(entry)) issue(path, "object_required", "需求必须是对象");
    assertExactKeys(entry, REQUIREMENT_KEYS, path);
    if (typeof entry.id !== "string" || !/^req_[a-z][a-z0-9_]{0,47}$/.test(entry.id)) {
      issue(`${path}.id`, "requirement_id", "需求 ID 必须匹配 req_[a-z][a-z0-9_]*");
    }
    if (entry.id === RESERVED_REQUIREMENT_ID) issue(`${path}.id`, "reserved_id", "该需求 ID 为系统保留值");
    if (seen.has(entry.id)) issue(`${path}.id`, "duplicate_id", "需求 ID 不能重复");
    seen.add(entry.id);
    const requirement: Text2CadRequirement = {
      id: entry.id,
      text: safeText(entry.text, `${path}.text`, 500),
      sourceRefs: parseSourceRefs(entry.sourceRefs, `${path}.sourceRefs`),
    };
    if (entry.acceptance !== undefined) {
      requirement.acceptance = safeText(entry.acceptance, `${path}.acceptance`, 300);
    }
    return requirement;
  });
  return [reservedRequirement(), ...requirements].sort((a, b) => a.id.localeCompare(b.id));
}

function parseAssumptions(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) issue("$.assumptions", "array_required", "assumptions 必须是数组");
  if (value.length > 32) issue("$.assumptions", "assumption_count", "假设最多 32 项");
  const assumptions = value.map((entry, index) => safeText(entry, `$.assumptions[${index}]`, 300));
  if (new Set(assumptions).size !== assumptions.length) issue("$.assumptions", "duplicate_assumption", "假设不能重复");
  return [...assumptions].sort();
}

function parsePlacement(value: unknown, path: string): Text2CadPlacement {
  if (value === undefined) {
    return { translate: [...ZERO_POINT_3], rotateDeg: [...ZERO_POINT_3] };
  }
  if (!isPlainRecord(value)) issue(path, "object_required", "placement 必须是对象");
  assertExactKeys(value, PLACEMENT_KEYS, path);
  return {
    translate: value.translate === undefined ? [...ZERO_POINT_3] : point3(value.translate, `${path}.translate`),
    rotateDeg: value.rotateDeg === undefined ? [...ZERO_POINT_3] : rotation3(value.rotateDeg, `${path}.rotateDeg`),
  };
}

function parseProfileSet(value: unknown, path: string): Text2CadProfileSet {
  if (!isPlainRecord(value)) issue(path, "object_required", "profile 必须是对象");
  assertExactKeys(value, PROFILE_SET_KEYS, path);
  if (!Array.isArray(value.holes)) issue(`${path}.holes`, "array_required", "profile.holes 必须是数组");
  if (value.holes.length > 32) issue(`${path}.holes`, "hole_count", "孔轮廓最多 32 个");
  return {
    outer: parseProfile(value.outer, `${path}.outer`),
    holes: value.holes.map((entry, index) => parseProfile(entry, `${path}.holes[${index}]`)),
  };
}

function parseFeature(
  value: unknown,
  path: string,
  index: number,
  featureIds: Set<string>,
  requirementIds: Set<string>
): Text2CadExtrudeFeature {
  if (!isPlainRecord(value)) issue(path, "object_required", "特征必须是对象");
  assertExactKeys(value, FEATURE_KEYS, path);
  if (typeof value.id !== "string" || !/^feat_[a-z][a-z0-9_]{0,47}$/.test(value.id)) {
    issue(`${path}.id`, "feature_id", "特征 ID 必须匹配 feat_[a-z][a-z0-9_]*");
  }
  if (featureIds.has(value.id)) issue(`${path}.id`, "duplicate_id", "同一零件内的特征 ID 不能重复");
  featureIds.add(value.id);
  if (value.kind !== "extrude") issue(`${path}.kind`, "feature_kind", "V2 仅支持 extrude 特征");
  if (typeof value.operation !== "string" || !(TEXT2CAD_OPERATIONS as readonly string[]).includes(value.operation)) {
    issue(`${path}.operation`, "operation", `operation 仅支持 ${TEXT2CAD_OPERATIONS.join(", ")}`);
  }
  if (index === 0 && value.operation !== "new") {
    issue(`${path}.operation`, "feature_order", "每个零件的首个特征必须使用 new");
  }
  if (index > 0 && value.operation === "new") {
    issue(`${path}.operation`, "feature_order", "同一零件只有首个特征可以使用 new");
  }
  if (typeof value.plane !== "string" || !(TEXT2CAD_PLANES as readonly string[]).includes(value.plane)) {
    issue(`${path}.plane`, "plane", `plane 仅支持 ${TEXT2CAD_PLANES.join(", ")}`);
  }
  return {
    id: value.id,
    kind: "extrude",
    operation: value.operation as Text2CadOperation,
    plane: value.plane as Text2CadPlane,
    origin: value.origin === undefined ? [...ZERO_POINT_3] : point3(value.origin, `${path}.origin`),
    profile: parseProfileSet(value.profile, `${path}.profile`),
    distance: safeNumber(value.distance, `${path}.distance`, { min: 0.001, max: TEXT2CAD_MAX_DIMENSION_MM }),
    requirementRefs: parseRequirementRefs(value.requirementRefs, `${path}.requirementRefs`, requirementIds),
  };
}

function parseColor(value: unknown, path: string): string {
  if (value === undefined) return TEXT2CAD_DEFAULTS.color;
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    issue(path, "color", "颜色必须是 #RRGGBB");
  }
  return value.toUpperCase();
}

function parseParts(value: unknown, requirementIds: Set<string>): Text2CadPart[] {
  if (!Array.isArray(value)) issue("$.parts", "array_required", "parts 必须是数组");
  if (value.length < 1 || value.length > TEXT2CAD_MAX_PARTS) {
    issue("$.parts", "part_count", `parts 需 1–${TEXT2CAD_MAX_PARTS} 项`);
  }
  const partIds = new Set<string>();
  const parts = value.map((entry, partIndex) => {
    const path = `$.parts[${partIndex}]`;
    if (!isPlainRecord(entry)) issue(path, "object_required", "零件必须是对象");
    assertExactKeys(entry, PART_KEYS, path);
    if (typeof entry.id !== "string" || !/^part_[a-z][a-z0-9_]{0,47}$/.test(entry.id)) {
      issue(`${path}.id`, "part_id", "零件 ID 必须匹配 part_[a-z][a-z0-9_]*");
    }
    if (partIds.has(entry.id)) issue(`${path}.id`, "duplicate_id", "零件 ID 不能重复");
    partIds.add(entry.id);
    const material = entry.material === undefined
      ? TEXT2CAD_DEFAULTS.material
      : safeText(entry.material, `${path}.material`, 80);
    if (!Array.isArray(entry.features)) issue(`${path}.features`, "array_required", "features 必须是数组");
    if (entry.features.length < 1 || entry.features.length > TEXT2CAD_MAX_FEATURES_PER_PART) {
      issue(`${path}.features`, "feature_count", `每个零件需 1–${TEXT2CAD_MAX_FEATURES_PER_PART} 个特征`);
    }
    const featureIds = new Set<string>();
    return {
      id: entry.id,
      name: safeName(entry.name, `${path}.name`, entry.id.replace(/^part_/, "")),
      material,
      color: parseColor(entry.color, `${path}.color`),
      placement: parsePlacement(entry.placement, `${path}.placement`),
      features: entry.features.map((feature, featureIndex) =>
        parseFeature(feature, `${path}.features[${featureIndex}]`, featureIndex, featureIds, requirementIds)
      ),
    };
  });
  return parts.sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeText2CadSpec(input: unknown): Text2CadSpec {
  assertSafeShape(input);
  assertInputSize(input);
  if (!isPlainRecord(input)) issue("$", "object_required", "Text2CAD 规格必须是 JSON 对象");
  assertExactKeys(input, TOP_LEVEL_KEYS, "$");
  if (input.schemaVersion !== TEXT2CAD_SCHEMA_VERSION) {
    issue("$.schemaVersion", "schema_version", `schemaVersion 必须为 ${TEXT2CAD_SCHEMA_VERSION}`);
  }
  if (input.engine !== TEXT2CAD_ENGINE) issue("$.engine", "engine", `engine 必须为 ${TEXT2CAD_ENGINE}`);
  if (input.unit !== TEXT2CAD_UNIT) issue("$.unit", "unit", `仅支持 ${TEXT2CAD_UNIT}`);

  const requirements = parseRequirements(input.requirements);
  const requirementIds = new Set(requirements.map((entry) => entry.id));
  const parts = parseParts(input.parts, requirementIds);
  const referencedRequirementIds = new Set(
    parts.flatMap((part) => part.features.flatMap((feature) => feature.requirementRefs))
  );
  const uncoveredRequirement = requirements.find(
    (requirement) => requirement.id !== RESERVED_REQUIREMENT_ID && !referencedRequirementIds.has(requirement.id)
  );
  if (uncoveredRequirement) {
    issue(
      "$.requirements",
      "uncovered_requirement",
      `需求 ${uncoveredRequirement.id} 未被任何几何特征引用`
    );
  }
  return {
    schemaVersion: TEXT2CAD_SCHEMA_VERSION,
    engine: TEXT2CAD_ENGINE,
    unit: TEXT2CAD_UNIT,
    name: safeName(input.name, "$.name", TEXT2CAD_DEFAULTS.name),
    process: input.process === undefined
      ? TEXT2CAD_DEFAULTS.process
      : safeText(input.process, "$.process", 120),
    requirements,
    assumptions: parseAssumptions(input.assumptions),
    parts,
  };
}

type ExplicitEngineeringValue = { value: number; label: string };

function engineeringScale(unit: string | undefined): number {
  if (unit === "cm" || unit === "厘米") return 10;
  if (unit === "m" || unit === "米") return 1_000;
  return 1;
}

function explicitEngineeringValues(instruction: string): ExplicitEngineeringValue[] {
  const found: ExplicitEngineeringValue[] = [];
  const add = (raw: string, unit?: string) => {
    const value = Number(raw) * engineeringScale(unit);
    if (!Number.isFinite(value) || value < 0 || value > TEXT2CAD_MAX_DIMENSION_MM) return;
    if (!found.some((entry) => Math.abs(entry.value - value) < 0.000001)) {
      found.push({ value, label: `${raw}${unit || "mm"}` });
    }
  };
  const unitPattern = "(毫米|厘米|mm|cm|米|m)?";
  const compound = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*(?:x|X|×|\\*)\\s*(\\d+(?:\\.\\d+)?)(?:\\s*(?:x|X|×|\\*)\\s*(\\d+(?:\\.\\d+)?))?\\s*${unitPattern}`,
    "g"
  );
  for (const match of instruction.matchAll(compound)) {
    const unit = match[4];
    add(match[1], unit);
    add(match[2], unit);
    if (match[3]) add(match[3], unit);
  }
  const withUnit = /(\d+(?:\.\d+)?)\s*(毫米|厘米|mm|cm|米|m)(?![a-z])/gi;
  for (const match of instruction.matchAll(withUnit)) add(match[1], match[2].toLowerCase());
  const keywordBefore = new RegExp(
    `(?:厚度?|长度?|宽度?|高度?|深度?|孔中心距|中心距|轴距|孔距|轮距|间距|边距|离地间隙|圆角(?:半径)?|直径|孔径|外径|内径|半径)\\s*(?:为|是|约|=|:|：)?\\s*(?:φ|Φ|Ø)?\\s*(\\d+(?:\\.\\d+)?)\\s*${unitPattern}`,
    "gi"
  );
  for (const match of instruction.matchAll(keywordBefore)) add(match[1], match[2]?.toLowerCase());
  const keywordAfter = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*${unitPattern}\\s*(?:厚|长|宽|高|深|直径|孔径|外径|内径|半径|轴距|间距|边距|圆角)`,
    "gi"
  );
  for (const match of instruction.matchAll(keywordAfter)) add(match[1], match[2]?.toLowerCase());
  return found;
}

function collectSpecNumbers(spec: Text2CadSpec): number[] {
  const numbers: number[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) numbers.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(spec.parts);
  return numbers;
}

function circleMetrics(spec: Text2CadSpec): { radii: number[]; diameters: number[]; holeDiameters: number[]; holeCount: number } {
  const radii: number[] = [];
  const diameters: number[] = [];
  const holeDiameters: number[] = [];
  let holeCount = 0;
  for (const part of spec.parts) {
    for (const feature of part.features) {
      const outer = feature.profile.outer;
      if (outer.kind === "circle") {
        radii.push(outer.radius);
        diameters.push(outer.radius * 2);
        if (feature.operation === "cut") {
          holeDiameters.push(outer.radius * 2);
          holeCount++;
        }
      } else if (feature.operation === "cut") {
        holeCount++;
      }
      for (const hole of feature.profile.holes) {
        holeCount++;
        if (hole.kind === "circle") {
          radii.push(hole.radius);
          diameters.push(hole.radius * 2);
          holeDiameters.push(hole.radius * 2);
        }
      }
    }
  }
  return { radii, diameters, holeDiameters, holeCount };
}

function profileReferencePoints(profile: Text2CadProfile): Text2CadPoint2[] {
  if (profile.kind === "rectangle" || profile.kind === "circle") return [profile.center];
  if (profile.kind === "polygon") return profile.points;
  return profile.segments.flatMap((segment) => (
    segment.kind === "arc" ? [segment.start, segment.mid, segment.end] : [segment.start, segment.end]
  ));
}

type SpacingMetrics = { any: number[]; x: number[]; y: number[]; z: number[] };

function addPairwiseDistances(points: number[][], metrics: SpacingMetrics): void {
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      const deltas = points[left].map((value, axis) => Math.abs(value - points[right][axis]));
      const axes = [metrics.x, metrics.y, metrics.z];
      deltas.forEach((value, axis) => {
        if (value <= 0) return;
        axes[axis].push(value);
        metrics.any.push(value);
      });
      const euclidean = Math.sqrt(deltas.reduce((sum, value) => sum + value * value, 0));
      if (euclidean > 0) metrics.any.push(euclidean);
    }
  }
}

function featurePoint3(feature: Text2CadExtrudeFeature, point: Text2CadPoint2): Text2CadPoint3 {
  const [u, v] = point;
  const [x, y, z] = feature.origin;
  if (feature.plane === "XY") return [x + u, y + v, z];
  if (feature.plane === "XZ") return [x + u, y, z + v];
  return [x, y + u, z + v];
}

/** 仅供“中心距/轴距/间距”语义门使用，不混入普通尺寸匹配。 */
function collectSpacingValues(spec: Text2CadSpec): SpacingMetrics {
  const metrics: SpacingMetrics = { any: [], x: [], y: [], z: [] };
  const placements = spec.parts.map((part) => [...part.placement.translate]);
  addPairwiseDistances(placements, metrics);
  for (const part of spec.parts) {
    const partPoints: number[][] = [];
    for (const feature of part.features) {
      const localPoints = [
        ...profileReferencePoints(feature.profile.outer),
        ...feature.profile.holes.flatMap(profileReferencePoints),
      ];
      for (const point of localPoints) {
        const mapped = featurePoint3(feature, point);
        partPoints.push(mapped.map((value, axis) => value + part.placement.translate[axis]));
      }
    }
    addPairwiseDistances(partPoints, metrics);
  }
  return metrics;
}

function matchNumber(values: number[], expected: number): boolean {
  return values.some((value) => Math.abs(value - expected) < 0.000001);
}

function explicitEdgeOffsets(instruction: string, unit: string): ExplicitEngineeringValue[] {
  return [
    ...explicitPatternValues(
      instruction,
      new RegExp(`(?:孔边距|安装孔边距|边距)\\s*(?:为|是|约|=|:|：)?\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`, "gi")
    ),
    ...explicitPatternValues(
      instruction,
      new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}\\s*(?:孔边距|边距)`, "gi")
    ),
  ];
}

/** 从矩形轮廓边界与圆孔中心的实际几何关系计算边距。 */
function collectEdgeOffsets(spec: Text2CadSpec): number[] {
  const values: number[] = [];
  const origin2 = (feature: Text2CadExtrudeFeature): Text2CadPoint2 => (
    feature.plane === "XY"
      ? [feature.origin[0], feature.origin[1]]
      : feature.plane === "XZ"
        ? [feature.origin[0], feature.origin[2]]
        : [feature.origin[1], feature.origin[2]]
  );
  for (const part of spec.parts) {
    for (const rectangleFeature of part.features) {
      const rectangle = rectangleFeature.profile.outer;
      if (rectangle.kind !== "rectangle" || rectangleFeature.operation !== "new") continue;
      const baseOrigin = origin2(rectangleFeature);
      const center: Text2CadPoint2 = [baseOrigin[0] + rectangle.center[0], baseOrigin[1] + rectangle.center[1]];
      const bounds = [
        center[0] - rectangle.width / 2,
        center[0] + rectangle.width / 2,
        center[1] - rectangle.height / 2,
        center[1] + rectangle.height / 2,
      ];
      for (const feature of part.features) {
        if (feature.plane !== rectangleFeature.plane) continue;
        const featureOrigin = origin2(feature);
        const circles = [
          ...(feature.operation === "cut" && feature.profile.outer.kind === "circle" ? [feature.profile.outer] : []),
          ...feature.profile.holes.filter((profile): profile is Extract<Text2CadProfile, { kind: "circle" }> => profile.kind === "circle"),
        ];
        for (const circle of circles) {
          const x = featureOrigin[0] + circle.center[0];
          const y = featureOrigin[1] + circle.center[1];
          if (x < bounds[0] || x > bounds[1] || y < bounds[2] || y > bounds[3]) continue;
          for (const distance of [x - bounds[0], bounds[1] - x, y - bounds[2], bounds[3] - y]) {
            if (distance >= 0) values.push(distance);
          }
        }
      }
    }
  }
  return values;
}

function explicitPatternValues(instruction: string, pattern: RegExp): ExplicitEngineeringValue[] {
  const values: ExplicitEngineeringValue[] = [];
  for (const match of instruction.matchAll(pattern)) {
    const value = Number(match[1]) * engineeringScale(match[2]?.toLowerCase());
    if (Number.isFinite(value) && !values.some((entry) => Math.abs(entry.value - value) < 0.000001)) {
      values.push({ value, label: match[0] });
    }
  }
  return values;
}

type ExplicitOverallDimension = ExplicitEngineeringValue & { axis: 0 | 1 | 2 };
type ExplicitSpacing = ExplicitEngineeringValue & { axis: "x" | "y" | "any" };

function explicitSpacingExpectations(instruction: string, unit: string): ExplicitSpacing[] {
  const values: ExplicitSpacing[] = [];
  const definitions: Array<{ keyword: string; axis: ExplicitSpacing["axis"] }> = [
    { keyword: "轴距", axis: "x" },
    { keyword: "轮距", axis: "y" },
    { keyword: "(?:孔中心距|中心距|孔距|间距)", axis: "any" },
  ];
  for (const definition of definitions) {
    const matches = [
      ...explicitPatternValues(
        instruction,
        new RegExp(`${definition.keyword}\\s*(?:为|是|约|=|:|：)?\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`, "gi")
      ),
      ...explicitPatternValues(
        instruction,
        new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}\\s*${definition.keyword}`, "gi")
      ),
    ];
    for (const match of matches) {
      if (!values.some((entry) => entry.axis === definition.axis && Math.abs(entry.value - match.value) < 0.000001)) {
        values.push({ ...match, axis: definition.axis });
      }
    }
  }
  return values;
}

function explicitOverallDimensions(instruction: string): ExplicitOverallDimension[] {
  const values: ExplicitOverallDimension[] = [];
  const add = (axis: 0 | 1 | 2, raw: string, unit?: string, label?: string) => {
    const value = Number(raw) * engineeringScale(unit?.toLowerCase());
    if (!Number.isFinite(value) || value <= 0 || value > TEXT2CAD_MAX_DIMENSION_MM) return;
    if (!values.some((entry) => entry.axis === axis && Math.abs(entry.value - value) < 0.000001)) {
      values.push({ axis, value, label: label || `${raw}${unit || "mm"}` });
    }
  };
  const unit = "(毫米|厘米|mm|cm|米|m)?";
  const compound = new RegExp(
    `(?:整体尺寸|总体尺寸|外形尺寸)\\s*(?:为|是|=|:|：)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:x|X|×|\\*)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:x|X|×|\\*)\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`,
    "gi"
  );
  for (const match of instruction.matchAll(compound)) {
    add(0, match[1], match[4], match[0]);
    add(1, match[2], match[4], match[0]);
    add(2, match[3], match[4], match[0]);
  }
  const definitions: Array<{ axis: 0 | 1 | 2; keyword: string }> = [
    { axis: 0, keyword: "(?:整体长度|总体长度|总长|车长)" },
    { axis: 1, keyword: "(?:整体宽度|总体宽度|总宽|车宽|整体深度|总深)" },
    { axis: 2, keyword: "(?:整体高度|总体高度|总高|车高|身高)" },
  ];
  for (const definition of definitions) {
    const before = new RegExp(
      `${definition.keyword}\\s*(?:为|是|约|=|:|：)?\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`,
      "gi"
    );
    for (const match of instruction.matchAll(before)) add(definition.axis, match[1], match[2], match[0]);
    const after = new RegExp(
      `(\\d+(?:\\.\\d+)?)\\s*${unit}\\s*${definition.keyword}`,
      "gi"
    );
    for (const match of instruction.matchAll(after)) add(definition.axis, match[1], match[2], match[0]);
  }
  return values;
}

export function extractText2CadConceptMeasurements(instruction: string): {
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  wheelbaseMm?: number;
} {
  const overall = explicitOverallDimensions(instruction);
  const spacing = explicitSpacingExpectations(instruction, "(毫米|厘米|mm|cm|米|m)?");
  return {
    lengthMm: overall.find((entry) => entry.axis === 0)?.value,
    widthMm: overall.find((entry) => entry.axis === 1)?.value,
    heightMm: overall.find((entry) => entry.axis === 2)?.value,
    wheelbaseMm: spacing.find((entry) => entry.axis === "x" && /轴距/.test(entry.label))?.value,
  };
}

/**
 * 反向契约：用户明确写出的工程数值必须真正进入受控特征，不能只留在 requirements 文字中。
 */
export function assertText2CadInstructionCoverage(spec: Text2CadSpec, instruction: string): void {
  const specNumbers = collectSpecNumbers(spec);
  const metrics = circleMetrics(spec);
  const unit = "(毫米|厘米|mm|cm|米|m)?";
  const spacingExpectations = explicitSpacingExpectations(instruction, unit);
  const overallExpectations = explicitOverallDimensions(instruction);
  const edgeExpectations = explicitEdgeOffsets(instruction, unit);
  // 用户写的是直径，schema 保存的是半径；通用数值反查同时接受确定性派生的直径。
  const missing = explicitEngineeringValues(instruction)
    .find((entry) => (
      !spacingExpectations.some((spacing) => Math.abs(spacing.value - entry.value) < 0.000001)
      && !overallExpectations.some((overall) => Math.abs(overall.value - entry.value) < 0.000001)
      && !edgeExpectations.some((edge) => Math.abs(edge.value - entry.value) < 0.000001)
      && !matchNumber([...specNumbers, ...metrics.diameters], entry.value)
    ));
  if (missing) {
    issue("$.parts", "explicit_dimension_missing", `用户明确尺寸 ${missing.label} 未进入任何受控特征`);
  }
  const spacingValues = collectSpacingValues(spec);
  const missingSpacing = spacingExpectations.find((entry) => (
    !matchNumber(entry.axis === "x" ? spacingValues.x : entry.axis === "y" ? spacingValues.y : spacingValues.any, entry.value)
  ));
  if (missingSpacing) {
    issue("$.parts", "explicit_spacing_missing", `用户明确间距 ${missingSpacing.label} 未进入受控坐标或部件放置`);
  }
  const edgeOffsets = collectEdgeOffsets(spec);
  const missingEdge = edgeExpectations.find((entry) => !matchNumber(edgeOffsets, entry.value));
  if (missingEdge) {
    issue("$.parts", "explicit_edge_offset_missing", `用户明确边距 ${missingEdge.label} 未进入孔位与轮廓边界关系`);
  }
  const diameters = explicitPatternValues(
    instruction,
    new RegExp(`(?:直径|外径|内径|φ|Φ|Ø)\\s*(?:为|是|约|=|:|：)?\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`, "gi")
  );
  const missingDiameter = diameters.find((entry) => !matchNumber(metrics.diameters, entry.value));
  if (missingDiameter) {
    issue("$.parts", "explicit_diameter_missing", `用户明确直径 ${missingDiameter.label} 未进入圆形特征`);
  }

  const holeDiameters = [
    ...explicitPatternValues(
      instruction,
      new RegExp(`(?:孔径|中心孔(?:直径)?|通孔(?:直径)?)\\s*(?:为|是|约|=|:|：)?\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`, "gi")
    ),
    ...explicitPatternValues(
      instruction,
      new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}\\s*(?:通孔|孔径)`, "gi")
    ),
    ...explicitPatternValues(
      instruction,
      new RegExp(`(?:直径|φ|Φ|Ø)\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}(?=[^。；,\\n]{0,8}(?:孔|通孔))`, "gi")
    ),
  ];
  const missingHoleDiameter = holeDiameters.find((entry) => !matchNumber(metrics.holeDiameters, entry.value));
  if (missingHoleDiameter) {
    issue("$.parts", "explicit_hole_diameter_missing", `用户明确孔径 ${missingHoleDiameter.label} 未进入孔特征`);
  }

  const radii = explicitPatternValues(
    instruction,
    new RegExp(`半径\\s*(?:为|是|约|=|:|：)?\\s*(\\d+(?:\\.\\d+)?)\\s*${unit}`, "gi")
  );
  const missingRadius = radii.find((entry) => !matchNumber(metrics.radii, entry.value));
  if (missingRadius) {
    issue("$.parts", "explicit_radius_missing", `用户明确半径 ${missingRadius.label} 未进入圆形特征`);
  }

  const holeCountMatch = instruction.match(/(?:^|[^\d.])(\d{1,2})\s*(?:个|处|组)?\s*(?:通孔|螺栓孔|孔)(?:均布)?/)
    ?? instruction.match(
      new RegExp(
        `(?:^|[^\\d.])(\\d{1,2})\\s*(?:个|处|组)?\\s*(?:(?:直径|孔径|φ|Φ|Ø)?\\s*\\d+(?:\\.\\d+)?\\s*${unit}\\s*)?(?:通孔|螺栓孔|孔)(?:均布)?`,
        "i"
      )
    );
  if (holeCountMatch && metrics.holeCount !== Number(holeCountMatch[1])) {
    issue("$.parts", "explicit_hole_count_missing", `用户明确要求 ${holeCountMatch[1]} 个孔，规格实际为 ${metrics.holeCount} 个`);
  }
  const partCountMatch = instruction.match(/(?:^|[^\d.])(\d{1,2})\s*(?:个|件)?\s*(?:部件|零件)/);
  if (partCountMatch && spec.parts.length !== Number(partCountMatch[1])) {
    issue("$.parts", "explicit_part_count_missing", `用户明确要求 ${partCountMatch[1]} 个部件，规格实际为 ${spec.parts.length} 个`);
  }
}

/** 整车/整机的总长宽高只能在几何生成后以真实 B-Rep 包围盒验收。X=长，Y=宽/深，Z=高。 */
export function assertText2CadRenderedBoundsCoverage(bounds: number[][], instruction: string): void {
  const expectations = explicitOverallDimensions(instruction);
  if (!expectations.length) return;
  if (!isFiniteBoundsForCoverage(bounds)) {
    issue("$.bounds", "rendered_bounds_invalid", "Text2CAD 几何包围盒无效");
  }
  const spans = [0, 1, 2].map((axis) => bounds[1][axis] - bounds[0][axis]);
  const missing = expectations.find((entry) => (
    Math.abs(spans[entry.axis] - entry.value) > Math.max(0.01, entry.value * 0.000001)
  ));
  if (missing) {
    const axisLabel = ["长度(X)", "宽度/深(Y)", "高度(Z)"][missing.axis];
    issue(
      "$.bounds",
      "explicit_overall_dimension_missing",
      `用户明确${axisLabel} ${missing.label}，实际几何为 ${Number(spans[missing.axis].toFixed(3))}mm`
    );
  }
}

function isFiniteBoundsForCoverage(bounds: number[][]): boolean {
  return Array.isArray(bounds)
    && bounds.length === 2
    && bounds.every((point) => (
      Array.isArray(point) && point.length === 3 && point.every((value) => Number.isFinite(value))
    ));
}

export function parseText2CadSpecJson(json: string): Text2CadSpec {
  if (typeof json !== "string") issue("$", "json_string", "输入必须是 JSON 字符串");
  if (Buffer.byteLength(json, "utf8") > TEXT2CAD_MAX_JSON_BYTES) {
    issue("$", "json_too_large", `JSON 不能超过 ${TEXT2CAD_MAX_JSON_BYTES} 字节`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    issue("$", "invalid_json", "JSON 解析失败");
  }
  return normalizeText2CadSpec(parsed);
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
    if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry, stack)).join(",")}]`;
    if (!isPlainRecord(value)) issue("$", "canonical_object", "canonical JSON 仅支持普通对象");
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], stack)}`)
      .join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

export function stableText2CadCanonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

export function canonicalText2CadSpecJson(spec: Text2CadSpec): string {
  const safe = normalizeText2CadSpec({
    schemaVersion: spec.schemaVersion,
    engine: spec.engine,
    unit: spec.unit,
    name: spec.name,
    process: spec.process,
    requirements: spec.requirements.filter((entry) => entry.id !== RESERVED_REQUIREMENT_ID),
    assumptions: spec.assumptions,
    parts: spec.parts,
  });
  return stableText2CadCanonicalJson(safe);
}

export function canonicalText2CadSpecHash(spec: Text2CadSpec): string {
  return createHash("sha256").update(canonicalText2CadSpecJson(spec), "utf8").digest("hex");
}

/** 与现有 CAD 命名对齐的短别名。 */
export const canonicalText2CadJson = canonicalText2CadSpecJson;
export const canonicalText2CadHash = canonicalText2CadSpecHash;

export function createDefaultText2CadSpec(): Text2CadSpec {
  return normalizeText2CadSpec({
    schemaVersion: TEXT2CAD_SCHEMA_VERSION,
    engine: TEXT2CAD_ENGINE,
    unit: TEXT2CAD_UNIT,
    parts: [
      {
        id: "part_body",
        features: [
          {
            id: "feat_body",
            kind: "extrude",
            operation: "new",
            plane: TEXT2CAD_DEFAULTS.feature.plane,
            profile: {
              outer: { kind: "rectangle", width: 100, height: 60 },
              holes: [],
            },
            distance: 10,
          },
        ],
      },
    ],
  });
}

export type Text2CadDesignSpec = Text2CadSpec;
export const normalizeText2CadDesignSpec = normalizeText2CadSpec;
export const parseText2CadDesignSpecJson = parseText2CadSpecJson;
export const canonicalText2CadDesignJson = canonicalText2CadSpecJson;
export const canonicalText2CadDesignHash = canonicalText2CadSpecHash;
