"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BufferGeometry, Material, WebGLRenderer } from "three";
import type { OrbitControls as OrbitControlsType } from "three/examples/jsm/controls/OrbitControls.js";
import { resolveCadArtifactContract } from "@/lib/cad-library";
import type { StudioOutput } from "@/lib/types";
import { toast } from "@/components/Toast";
import { CAD_MODEL_LIBRARY } from "@/components/studio-shared";
import { StyledSelect } from "@/components/StyledSelect";

type CadMeshManifest = {
  manifestVersion: number | null;
  libraryVersion: number | null;
  validation: unknown;
  bounds: unknown;
  volumeMm3: number;
  triangleCount: number;
  hash: string;
  template: string;
  engine: string;
  artifactMode: string;
  partCount: number | null;
};

type CadMeshFeature = {
  id: string;
  kind: string;
  operation: string;
  bounds: unknown;
  volumeMm3: number | null;
};

export type CadMeshPart = {
  id: string;
  name: string;
  material: string;
  color: string | null;
  parentId: string | null;
  vertices: number[];
  normals: number[];
  triangles: number[];
  lines: number[];
  bounds: unknown;
  volumeMm3: number | null;
  features: CadMeshFeature[];
};

export type CadMeshPayload = {
  vertices: number[];
  normals: number[];
  triangles: number[];
  lines: number[];
  parts: CadMeshPart[];
  manifest: CadMeshManifest;
  contractManifest: Record<string, unknown>;
};

type CadRequirementView = {
  id: string;
  text: string;
  sourceRefs: string[];
  acceptance?: string;
};

type CadParameterView = {
  value: number;
  unit: string;
  requirementRefs: string[];
};

type CadFeatureView = {
  id: string;
  kind: string;
  operation: string;
  dependsOn: string[];
  parameterRefs: string[];
  requirementRefs: string[];
  partId?: string;
  plane?: string;
  origin?: [number, number, number];
  distance?: number;
  profile?: Record<string, unknown>;
};

type CadPartView = {
  id: string;
  name: string;
  material: string;
  color: string | null;
  parentId: string | null;
  translate: [number, number, number];
  rotateDeg: [number, number, number];
  features: CadFeatureView[];
};

export type CadDesignView = {
  schemaVersion: 1 | 2;
  engine: string;
  unit: "mm";
  template: string;
  name: string;
  material: string;
  process: string;
  requirements: CadRequirementView[];
  assumptions: string[];
  parameters: Record<string, CadParameterView>;
  featureGraph: { nodes: CadFeatureView[] };
  parts: CadPartView[];
};

type MeshState =
  | { status: "loading" }
  | { status: "ready"; mesh: CadMeshPayload }
  | { status: "error"; message: string };

type ValidationView = {
  ok: boolean | null;
  label: string;
  messages: string[];
};

const MAX_MESH_RESPONSE_BYTES = 80 * 1024 * 1024;
const MAX_VERTEX_VALUES = 3_000_000;
const MAX_TRIANGLE_INDICES = 6_000_000;
const MAX_LINE_VALUES = 6_000_000;
const MAX_MESH_PARTS = 512;

type StandardView = "iso" | "front" | "top" | "right";
type DisplayMode = "solid" | "wireframe";
type InspectorTab = "overview" | "edit" | "structure" | "validation";

const TEMPLATE_LABEL: Record<string, string> = Object.fromEntries(
  CAD_MODEL_LIBRARY.filter((model) => model.id !== "auto").map((model) => [model.id, model.label])
);
const CONCEPT_ASSEMBLY_TEMPLATES: ReadonlySet<string> = new Set(
  CAD_MODEL_LIBRARY.filter((model) => model.artifactMode === "assembly").map((model) => model.id)
);

function artifactModeLabel(mode: string, text2cad = false): string {
  if (mode === "concept_assembly") return "概念装配";
  if (mode === "assembly") return text2cad ? "参数化装配" : "概念装配";
  if (mode === "single_part") return text2cad ? "参数化零件" : "单零件";
  return mode || "待校验";
}

function selectionStrategyLabel(value: unknown): string {
  if (!isRecord(value)) return "历史制品";
  if (value.tutorialExample === true) return "教学示例";
  if (value.mode === "manual" && value.strategy === "manual") return "手动选择";
  if (value.mode === "auto" && value.strategy === "keyword") return "关键词匹配";
  if (value.mode === "auto" && value.strategy === "model") return "自动匹配";
  if (value.mode === "auto" && value.strategy === "text2cad") return "自由参数化";
  if (value.strategy === "concept_fallback") return "概念参数兜底";
  return "待校验";
}

const MATERIAL_LABEL: Record<string, string> = {
  aluminum: "铝合金",
  steel: "钢",
  stainless_steel: "不锈钢",
  abs: "ABS",
  pla: "PLA",
  nylon: "尼龙",
  multi_material: "多材料",
  unspecified: "未指定",
};

const PROCESS_LABEL: Record<string, string> = {
  cnc: "CNC 加工",
  "3d_print": "3D 打印",
  sheet_metal: "钣金",
  parametric_brep: "参数化 B-Rep",
  unspecified: "未指定",
};

const MATERIAL_OPTIONS = Object.entries(MATERIAL_LABEL)
  .filter(([value]) => value !== "multi_material")
  .map(([value, label]) => ({ value, label }));
const PROCESS_OPTIONS = Object.entries(PROCESS_LABEL)
  .filter(([value]) => value !== "parametric_brep")
  .map(([value, label]) => ({ value, label }));

type EditableNumber = number | string;
type EditableProfile = Record<string, unknown> & { kind?: string };
type EditableCadV1 = {
  schemaVersion: 1;
  name: string;
  material: string;
  process: string;
  parameters: Record<string, { value: EditableNumber; unit?: string }>;
};
type EditableCadFeature = {
  id: string;
  origin: EditableNumber[];
  distance: EditableNumber;
  profile: { outer: EditableProfile; holes: EditableProfile[] };
};
type EditableCadPart = {
  id: string;
  name: string;
  material: string;
  color: string;
  placement: { translate: EditableNumber[]; rotateDeg: EditableNumber[] };
  features: EditableCadFeature[];
};
type EditableCadV2 = {
  schemaVersion: 2;
  engine: "text2cad";
  name: string;
  parts: EditableCadPart[];
};
type EditableCadSpec = EditableCadV1 | EditableCadV2;

type CadRevisionDraftResult = {
  patch: Record<string, unknown>;
  dirty: boolean;
  error: string | null;
};

const FEATURE_LABEL: Record<string, string> = {
  sketch: "约束草图",
  base_profile: "基础轮廓",
  extrude: "拉伸",
  pad: "凸台",
  pocket: "凹槽",
  revolve: "旋转体",
  loft: "放样",
  sweep: "扫掠",
  union: "布尔合并",
  intersect: "布尔相交",
  shell: "抽壳",
  lid_seat: "盖板定位台阶",
  bore: "内孔",
  hole_pattern: "孔阵列",
  set_screw_pattern: "紧定螺钉孔阵列",
  fillet: "圆角",
  assembly_layout: "装配布局",
  component_set: "部件集合",
  wheel_set: "车轮组件",
};

const OPERATION_LABEL: Record<string, string> = {
  new: "新建实体",
  add: "添加",
  cut: "切除",
  intersect: "相交",
  finish: "收尾",
};

const PARAMETER_LABEL: Record<string, string> = {
  length: "长度",
  width: "宽度",
  thickness: "厚度",
  corner_radius: "圆角半径",
  hole_diameter: "孔径",
  hole_count: "孔数",
  hole_edge_offset: "孔边距",
  base_length: "底座长度",
  base_width: "底座宽度",
  base_thickness: "底座厚度",
  upright_height: "立板高度",
  upright_thickness: "立板厚度",
  fillet_radius: "圆角半径",
  outer_length: "外部长度",
  outer_width: "外部宽度",
  outer_height: "外部高度",
  wall_thickness: "壁厚",
  lid_clearance: "上盖间隙",
  screw_diameter: "螺钉直径",
  screw_count: "螺钉数量",
  outer_diameter: "外径",
  bore_diameter: "内孔直径",
  bolt_circle_diameter: "螺栓圆直径",
  bolt_hole_diameter: "螺栓孔直径",
  bolt_hole_count: "螺栓孔数量",
  bore_diameter_a: "A 端内孔直径",
  bore_diameter_b: "B 端内孔直径",
  transition_length: "过渡段长度",
  set_screw_diameter: "紧定螺钉直径",
  set_screw_count: "紧定螺钉数量",
  overall_height: "整体高度",
  overall_width: "整体宽度",
  overall_depth: "整体深度",
  limb_diameter: "肢体直径",
  joint_clearance: "关节间隙",
  overall_length: "整体长度",
  wheelbase: "轴距",
  wheel_diameter: "车轮直径",
  wheel_width: "车轮宽度",
  ground_clearance: "离地间隙",
};

const cn = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function textField(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function normalizeRequirement(value: unknown, index: number): CadRequirementView {
  if (typeof value === "string" && value.trim()) {
    return { id: `req-${index + 1}`, text: value.trim(), sourceRefs: [] };
  }
  if (!isRecord(value)) throw new Error("需求追溯字段不完整");
  const text = textField(value, ["text", "description", "requirement"]);
  if (!text) throw new Error("需求追溯字段不完整");
  return {
    id: textField(value, ["id"]) ?? `req-${index + 1}`,
    text,
    sourceRefs: isStringArray(value.sourceRefs) ? value.sourceRefs : [],
    acceptance: textField(value, ["acceptance"]) ?? undefined,
  };
}

function normalizeFeature(value: unknown, index: number, partId?: string): CadFeatureView {
  if (!isRecord(value)) throw new Error("特征历史字段不完整");
  const id = textField(value, ["id"]) ?? `${partId ?? "feature"}-${index + 1}`;
  const kind = textField(value, ["kind", "type"]) ?? "feature";
  const operation = textField(value, ["operation", "action"]) ?? "finish";
  const distance = typeof value.distance === "number" && Number.isFinite(value.distance)
    ? value.distance
    : undefined;
  return {
    id,
    kind,
    operation,
    dependsOn: isStringArray(value.dependsOn) ? value.dependsOn : [],
    parameterRefs: isStringArray(value.parameterRefs) ? value.parameterRefs : [],
    requirementRefs: isStringArray(value.requirementRefs) ? value.requirementRefs : [],
    partId,
    plane: textField(value, ["plane"]) ?? undefined,
    origin: vectorOf(value.origin) ?? undefined,
    distance,
    profile: isRecord(value.profile) ? value.profile : undefined,
  };
}

function normalizeText2CadPart(value: unknown, index: number): CadPartView {
  if (!isRecord(value)) throw new Error("部件字段不完整");
  const id = textField(value, ["id"]) ?? `part-${index + 1}`;
  const name = textField(value, ["name", "label"]) ?? `部件 ${index + 1}`;
  const placement = isRecord(value.placement) ? value.placement : {};
  const rawFeatures = Array.isArray(value.features) ? value.features : [];
  const features = rawFeatures.map((feature, featureIndex) => normalizeFeature(feature, featureIndex, id));
  for (let featureIndex = 1; featureIndex < features.length; featureIndex++) {
    if (!features[featureIndex].dependsOn.length) {
      features[featureIndex].dependsOn = [features[featureIndex - 1].id];
    }
  }
  return {
    id,
    name,
    material: textField(value, ["material"]) ?? "unspecified",
    color: normalizeColor(value.color),
    parentId: textField(value, ["parentId", "parent"]),
    translate: vectorOf(placement.translate) ?? [0, 0, 0],
    rotateDeg: vectorOf(placement.rotateDeg) ?? [0, 0, 0],
    features,
  };
}

export function parseCadDesignSpec(content: string): { spec: CadDesignView | null; error: string | null } {
  if (!content.trim()) return { spec: null, error: "CAD 规格为空，无法展示设计详情。" };
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value)) throw new Error("规格根节点不是对象");
    const schemaVersion = Number(value.schemaVersion);
    if (schemaVersion === 2) {
      if (
        value.unit !== "mm" ||
        value.engine !== "text2cad" ||
        typeof value.name !== "string" ||
        !Array.isArray(value.requirements) ||
        !Array.isArray(value.assumptions) ||
        !Array.isArray(value.parts) ||
        value.parts.length === 0
      ) {
        throw new Error("Text2CAD 规格字段不完整");
      }
      const requirements = value.requirements.map(normalizeRequirement);
      const assumptions = value.assumptions.map((item) => {
        if (typeof item === "string" && item.trim()) return item.trim();
        if (isRecord(item)) return textField(item, ["text", "description", "message"]) ?? "";
        return "";
      }).filter(Boolean);
      const parts = value.parts.map(normalizeText2CadPart);
      const ids = new Set<string>();
      for (const part of parts) {
        if (ids.has(part.id)) throw new Error("部件标识重复");
        ids.add(part.id);
      }
      const features = parts.flatMap((part) => part.features);
      const materialSet = [...new Set(parts.map((part) => part.material).filter((item) => item !== "unspecified"))];
      return {
        spec: {
          schemaVersion: 2,
          engine: "text2cad",
          unit: "mm",
          template: typeof value.template === "string" && value.template.trim() ? value.template.trim() : "text2cad",
          name: value.name.trim(),
          material: materialSet.length === 0 ? "unspecified" : materialSet.length === 1 ? materialSet[0] : "multi_material",
          process: typeof value.process === "string" && value.process.trim()
            ? value.process.trim()
            : "unspecified",
          requirements,
          assumptions,
          parameters: {},
          featureGraph: { nodes: features },
          parts,
        },
        error: null,
      };
    }
    if (
      schemaVersion !== 1 ||
      value.unit !== "mm" ||
      typeof value.template !== "string" ||
      typeof value.name !== "string" ||
      typeof value.material !== "string" ||
      typeof value.process !== "string" ||
      !Array.isArray(value.requirements) ||
      !isRecord(value.parameters) ||
      !isRecord(value.featureGraph) ||
      !Array.isArray(value.featureGraph.nodes)
    ) {
      throw new Error("规格字段不完整");
    }
    for (const requirement of value.requirements) {
      if (
        !isRecord(requirement) ||
        typeof requirement.id !== "string" ||
        typeof requirement.text !== "string" ||
        !isStringArray(requirement.sourceRefs) ||
        (requirement.acceptance !== undefined && typeof requirement.acceptance !== "string")
      ) {
        throw new Error("需求追溯字段不完整");
      }
    }
    for (const parameter of Object.values(value.parameters)) {
      if (
        !isRecord(parameter) ||
        typeof parameter.value !== "number" ||
        !Number.isFinite(parameter.value) ||
        (parameter.unit !== "mm" && parameter.unit !== "count") ||
        !isStringArray(parameter.requirementRefs)
      ) {
        throw new Error("参数字段不完整");
      }
    }
    for (const node of value.featureGraph.nodes) {
      if (
        !isRecord(node) ||
        typeof node.id !== "string" ||
        typeof node.kind !== "string" ||
        typeof node.operation !== "string" ||
        !isStringArray(node.dependsOn) ||
        !isStringArray(node.parameterRefs) ||
        !isStringArray(node.requirementRefs)
      ) {
        throw new Error("特征图字段不完整");
      }
    }
    return {
      spec: {
        schemaVersion: 1,
        engine: "template",
        unit: "mm",
        template: value.template,
        name: value.name,
        material: value.material,
        process: value.process,
        requirements: value.requirements as CadRequirementView[],
        assumptions: [],
        parameters: value.parameters as Record<string, CadParameterView>,
        featureGraph: { nodes: value.featureGraph.nodes as CadFeatureView[] },
        parts: [],
      },
      error: null,
    };
  } catch (error) {
    return {
      spec: null,
      error: `CAD 规格无法解析：${error instanceof Error ? error.message : "格式异常"}`,
    };
  }
}

function assertNumericArray(
  value: unknown,
  label: string,
  maxLength: number,
  multiple: number,
  integer = false
): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxLength || value.length % multiple !== 0) {
    throw new Error(`${label}数组长度无效`);
  }
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item) || (integer && !Number.isInteger(item))) {
      throw new Error(`${label}包含无效数值`);
    }
  }
  return value as number[];
}

function optionalNumericArray(
  value: unknown,
  label: string,
  maxLength: number,
  multiple: number,
  integer = false
): number[] {
  if (value == null || (Array.isArray(value) && value.length === 0)) return [];
  return assertNumericArray(value, label, maxLength, multiple, integer);
}

function normalizeColor(value: unknown): string | null {
  if (typeof value === "string") {
    const color = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(color)) {
      return `#${color.slice(1).split("").map((char) => char + char).join("")}`.toLowerCase();
    }
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff) {
    return `#${value.toString(16).padStart(6, "0")}`;
  }
  if (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.slice(0, 3).every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    const channels = value.slice(0, 3).map((item) => {
      const channel = Number(item);
      return Math.max(0, Math.min(255, Math.round(channel <= 1 ? channel * 255 : channel)));
    });
    return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

function assertGeometryIndices(vertices: number[], normals: number[], triangles: number[], label: string): void {
  const vertexCount = vertices.length / 3;
  if (normals.length > 0 && normals.length !== vertices.length) throw new Error(`${label}法线数量与顶点不一致`);
  if (triangles.some((index) => index < 0 || index >= vertexCount)) throw new Error(`${label}三角面引用了不存在的顶点`);
}

function parseMeshPart(value: unknown, index: number): CadMeshPart {
  if (!isRecord(value)) throw new Error(`部件 ${index + 1} 网格格式异常`);
  const vertices = assertNumericArray(value.vertices, `部件 ${index + 1} 顶点`, MAX_VERTEX_VALUES, 3);
  const triangles = assertNumericArray(value.triangles, `部件 ${index + 1} 三角面`, MAX_TRIANGLE_INDICES, 3, true);
  const normals = optionalNumericArray(value.normals, `部件 ${index + 1} 法线`, MAX_VERTEX_VALUES, 3);
  const lines = optionalNumericArray(value.lines, `部件 ${index + 1} 边线`, MAX_LINE_VALUES, 6);
  assertGeometryIndices(vertices, normals, triangles, `部件 ${index + 1} `);
  const rawFeatures = Array.isArray(value.features) ? value.features : [];
  const features = rawFeatures.slice(0, 2_000).map((feature, featureIndex): CadMeshFeature => {
    if (!isRecord(feature)) throw new Error(`部件 ${index + 1} 特征 ${featureIndex + 1} 格式异常`);
    const volume = Number(feature.volumeMm3);
    return {
      id: textField(feature, ["id"]) ?? `mesh-feature-${featureIndex + 1}`,
      kind: textField(feature, ["kind", "type"]) ?? "feature",
      operation: textField(feature, ["operation", "action"]) ?? "finish",
      bounds: feature.bounds,
      volumeMm3: Number.isFinite(volume) && volume >= 0 ? volume : null,
    };
  });
  const volume = Number(value.volumeMm3);
  return {
    id: textField(value, ["id"]) ?? `part-${index + 1}`,
    name: textField(value, ["name", "label"]) ?? `部件 ${index + 1}`,
    material: textField(value, ["material"]) ?? "unspecified",
    color: normalizeColor(value.color),
    parentId: textField(value, ["parentId", "parent"]),
    vertices,
    normals,
    triangles,
    lines,
    bounds: value.bounds,
    volumeMm3: Number.isFinite(volume) && volume >= 0 ? volume : null,
    features,
  };
}

export function parseCadMeshPayload(value: unknown): CadMeshPayload {
  if (!isRecord(value) || !isRecord(value.manifest)) throw new Error("网格响应格式异常");
  const rawParts = Array.isArray(value.parts) ? value.parts : [];
  if (rawParts.length > MAX_MESH_PARTS) throw new Error("部件数量超过浏览器安全上限");
  const parts = rawParts.map(parseMeshPart);
  const vertices = optionalNumericArray(value.vertices, "顶点", MAX_VERTEX_VALUES, 3);
  const triangles = optionalNumericArray(value.triangles, "三角面", MAX_TRIANGLE_INDICES, 3, true);
  const normals = optionalNumericArray(value.normals, "法线", MAX_VERTEX_VALUES, 3);
  const lines = optionalNumericArray(value.lines, "边线", MAX_LINE_VALUES, 6);
  if (!parts.length && (!vertices.length || !triangles.length)) throw new Error("网格响应没有可显示的几何体");
  if (vertices.length || triangles.length) {
    if (!vertices.length || !triangles.length) throw new Error("顶层网格字段不完整");
    assertGeometryIndices(vertices, normals, triangles, "");
  }
  // Text2CAD 同时携带聚合网格和逐部件网格，两者是同一几何的两种索引，不应相加后
  // 误判为超限；分别限制顶层与全部部件的总量，仍能挡住拆成许多小部件绕过上限。
  const totalVertexValues = parts.reduce((sum, part) => sum + part.vertices.length, 0);
  const totalTriangleIndices = parts.reduce((sum, part) => sum + part.triangles.length, 0);
  const totalLineValues = parts.reduce((sum, part) => sum + part.lines.length, 0);
  if (
    totalVertexValues > MAX_VERTEX_VALUES ||
    totalTriangleIndices > MAX_TRIANGLE_INDICES ||
    totalLineValues > MAX_LINE_VALUES
  ) {
    throw new Error("多部件模型数据超过浏览器安全上限");
  }
  const partIds = new Set<string>();
  for (const part of parts) {
    if (partIds.has(part.id)) throw new Error("网格部件标识重复");
    partIds.add(part.id);
  }

  const manifest = value.manifest;
  const computedVolume = parts.reduce((sum, part) => sum + (part.volumeMm3 ?? 0), 0);
  const rawVolume = Number(manifest.volumeMm3);
  const volumeMm3 = Number.isFinite(rawVolume) && rawVolume >= 0 ? rawVolume : computedVolume;
  const computedTriangleCount = triangles.length / 3 + parts.reduce((sum, part) => sum + part.triangles.length / 3, 0);
  const rawTriangleCount = Number(manifest.triangleCount);
  const triangleCount = Number.isInteger(rawTriangleCount) && rawTriangleCount >= 0
    ? rawTriangleCount
    : computedTriangleCount;
  if (!Number.isFinite(volumeMm3) || volumeMm3 < 0) throw new Error("体积数据无效");
  if (!Number.isInteger(triangleCount) || triangleCount < 0) throw new Error("三角面统计无效");
  if (
    typeof manifest.hash !== "string" ||
    typeof manifest.template !== "string" ||
    typeof manifest.engine !== "string"
  ) {
    throw new Error("网格清单字段不完整");
  }
  const artifactMode = typeof manifest.artifactMode === "string" ? manifest.artifactMode.trim() : "";
  const rawPartCount = Number(manifest.partCount);
  const partCount = Number.isInteger(rawPartCount) && rawPartCount > 0
    ? rawPartCount
    : parts.length || null;
  const manifestVersion = Number(manifest.manifestVersion);
  const libraryVersion = Number(manifest.libraryVersion);
  return {
    vertices,
    normals,
    triangles,
    lines,
    parts,
    contractManifest: manifest,
    manifest: {
      manifestVersion: Number.isInteger(manifestVersion) ? manifestVersion : null,
      libraryVersion: Number.isInteger(libraryVersion) ? libraryVersion : null,
      validation: manifest.validation,
      bounds: manifest.bounds,
      volumeMm3,
      triangleCount,
      hash: manifest.hash,
      template: manifest.template,
      engine: manifest.engine,
      artifactMode,
      partCount,
    },
  };
}

function messageOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    for (const key of ["message", "reason", "error", "code"]) {
      if (typeof value[key] === "string") return value[key] as string;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function validationView(value: unknown): ValidationView {
  if (typeof value === "boolean") {
    return { ok: value, label: value ? "几何验证通过" : "几何验证未通过", messages: [] };
  }
  if (typeof value === "string") {
    const ok = /^(?:ok|pass|passed|valid|通过)$/i.test(value.trim());
    return { ok: ok ? true : null, label: ok ? "几何验证通过" : value, messages: [] };
  }
  if (Array.isArray(value)) {
    const messages = value.map(messageOf).filter(Boolean).slice(0, 12);
    return {
      ok: messages.length === 0 ? true : false,
      label: messages.length === 0 ? "几何验证通过" : "发现验证问题",
      messages,
    };
  }
  if (isRecord(value)) {
    const flag = [value.ok, value.valid, value.passed, value.brepValid]
      .find((item) => typeof item === "boolean") as boolean | undefined;
    const buckets = [value.issues, value.errors, value.warnings, value.messages]
      .filter(Array.isArray)
      .flatMap((items) => (items as unknown[]).map(messageOf));
    const messages = buckets.filter(Boolean).slice(0, 12);
    return {
      ok: flag ?? (messages.length ? false : null),
      label: flag === true ? "几何验证通过" : flag === false || messages.length ? "发现验证问题" : "验证结果已记录",
      messages,
    };
  }
  return { ok: null, label: "验证结果已记录", messages: [] };
}

function vectorOf(value: unknown): [number, number, number] | null {
  if (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.slice(0, 3).every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  }
  if (
    isRecord(value) &&
    typeof value.x === "number" && Number.isFinite(value.x) &&
    typeof value.y === "number" && Number.isFinite(value.y) &&
    typeof value.z === "number" && Number.isFinite(value.z)
  ) {
    return [value.x, value.y, value.z];
  }
  return null;
}

function boundsView(value: unknown): Array<{ label: string; value: string }> {
  const pair = Array.isArray(value) && value.length >= 2
    ? { min: vectorOf(value[0]), max: vectorOf(value[1]), size: null }
    : null;
  if (!pair && !isRecord(value)) return value == null ? [] : [{ label: "包围盒", value: messageOf(value).slice(0, 160) }];
  const record = isRecord(value) ? value : null;
  const min = pair?.min ?? vectorOf(record?.min);
  const max = pair?.max ?? vectorOf(record?.max);
  const explicitSize = pair?.size ?? vectorOf(record?.size ?? record?.dimensions);
  const size = explicitSize ?? (min && max ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as [number, number, number] : null);
  const rows: Array<{ label: string; value: string }> = [];
  if (size) rows.push({ label: "外形尺寸", value: `${formatCompact(size[0])} × ${formatCompact(size[1])} × ${formatCompact(size[2])} mm` });
  if (min) rows.push({ label: "最小坐标", value: min.map(formatCompact).join(" / ") });
  if (max) rows.push({ label: "最大坐标", value: max.map(formatCompact).join(" / ") });
  if (!rows.length) rows.push({ label: "包围盒", value: messageOf(value).slice(0, 160) });
  return rows;
}

function formatCompact(value: number): string {
  return Number(value.toFixed(3)).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

function formatParameter(value: number, unit: string): string {
  return unit === "count" ? `${formatCompact(value)} 个` : `${formatCompact(value)} mm`;
}

function sourceRefLabel(ref: string): string {
  if (ref === "system:template-defaults") return "受控模板默认值";
  if (ref === "system:design-assumption") return "设计假设";
  if (ref === "model:input") return "规格输入";
  if (ref.startsWith("prompt:")) return `补充要求 ${ref.slice(7)}`;
  if (ref.startsWith("source:")) return `来源 ${ref.slice(7)}`;
  return ref;
}

function profileLabel(profile: Record<string, unknown> | undefined): string | null {
  if (!profile) return null;
  const outer = typeof profile.outer === "string"
    ? profile.outer
    : isRecord(profile.outer)
      ? textField(profile.outer, ["type", "kind", "shape"])
      : null;
  const shape: Record<string, string> = {
    rectangle: "矩形",
    circle: "圆形",
    polygon: "多边形",
    path: "路径轮廓",
  };
  const holes = Array.isArray(profile.holes) ? profile.holes.length : 0;
  if (!outer && !holes) return null;
  return `${outer ? shape[outer] ?? outer : "复合轮廓"}${holes ? ` · ${holes} 个内环` : ""}`;
}

function placementLabel(part: Pick<CadPartView, "translate" | "rotateDeg">): string | null {
  const moved = part.translate.some((value) => value !== 0);
  const rotated = part.rotateDeg.some((value) => value !== 0);
  if (!moved && !rotated) return null;
  const rows: string[] = [];
  if (moved) rows.push(`位移 ${part.translate.map(formatCompact).join(" / ")} mm`);
  if (rotated) rows.push(`旋转 ${part.rotateDeg.map(formatCompact).join(" / ")}°`);
  return rows.join(" · ");
}

type PartTreeRow = {
  id: string;
  name: string;
  material: string;
  color: string | null;
  parentId: string | null;
  featureCount: number;
  placement: string | null;
  depth: number;
};

function arrangePartTree(rows: Omit<PartTreeRow, "depth">[]): PartTreeRow[] {
  const byParent = new Map<string | null, Array<Omit<PartTreeRow, "depth">>>();
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    const parent = row.parentId && ids.has(row.parentId) && row.parentId !== row.id ? row.parentId : null;
    const bucket = byParent.get(parent) ?? [];
    bucket.push({ ...row, parentId: parent });
    byParent.set(parent, bucket);
  }
  const result: PartTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (row: Omit<PartTreeRow, "depth">, depth: number) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    result.push({ ...row, depth: Math.min(depth, 8) });
    for (const child of byParent.get(row.id) ?? []) visit(child, depth + 1);
  };
  for (const root of byParent.get(null) ?? []) visit(root, 0);
  for (const row of rows) visit(row, 0);
  return result;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseEditableCadSpec(content: string): EditableCadSpec | null {
  try {
    const raw: unknown = JSON.parse(content);
    if (!isRecord(raw)) return null;
    if (
      raw.schemaVersion === 1
      && typeof raw.name === "string"
      && typeof raw.material === "string"
      && typeof raw.process === "string"
      && isRecord(raw.parameters)
    ) {
      return cloneJson(raw) as unknown as EditableCadV1;
    }
    if (
      raw.schemaVersion === 2
      && raw.engine === "text2cad"
      && typeof raw.name === "string"
      && Array.isArray(raw.parts)
    ) {
      return cloneJson(raw) as unknown as EditableCadV2;
    }
    return null;
  } catch {
    return null;
  }
}

class DraftValueError extends Error {}

function draftNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    const number = Number(value);
    return Object.is(number, -0) ? 0 : number;
  }
  throw new DraftValueError(`${label}请输入有效数值`);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeNumericTree(base: unknown, draft: unknown, label: string): unknown {
  if (typeof base === "number") return draftNumber(draft, label);
  if (Array.isArray(base)) {
    if (!Array.isArray(draft) || draft.length !== base.length) throw new DraftValueError(`${label}结构无效`);
    return base.map((entry, index) => normalizeNumericTree(entry, draft[index], `${label}.${index + 1}`));
  }
  if (isRecord(base)) {
    if (!isRecord(draft)) throw new DraftValueError(`${label}结构无效`);
    return Object.fromEntries(
      Object.keys(base).map((key) => [key, normalizeNumericTree(base[key], draft[key], `${label}.${key}`)])
    );
  }
  if (draft !== base) throw new DraftValueError(`${label}不能改变轮廓类型`);
  return draft;
}

function normalizedTriple(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new DraftValueError(`${label}需要三个坐标`);
  return [
    draftNumber(value[0], `${label} X`),
    draftNumber(value[1], `${label} Y`),
    draftNumber(value[2], `${label} Z`),
  ];
}

export function buildCadRevisionPatch(content: string, draft: EditableCadSpec | null): CadRevisionDraftResult {
  const base = parseEditableCadSpec(content);
  if (!base || !draft || base.schemaVersion !== draft.schemaVersion) {
    return { patch: {}, dirty: false, error: "当前 CAD 规格暂不支持在线编辑" };
  }
  try {
    if (base.schemaVersion === 1 && draft.schemaVersion === 1) {
      const patch: Record<string, unknown> = {};
      if (draft.name.trim() !== base.name) patch.name = draft.name;
      if (draft.material !== base.material) patch.material = draft.material;
      if (draft.process !== base.process) patch.process = draft.process;
      const parameters: Record<string, number> = {};
      for (const [key, parameter] of Object.entries(draft.parameters)) {
        const original = base.parameters[key];
        if (!original) throw new DraftValueError(`参数 ${key} 已不存在，请刷新`);
        const value = draftNumber(parameter.value, PARAMETER_LABEL[key] ?? key);
        if (value !== Number(original.value)) parameters[key] = value;
      }
      if (Object.keys(parameters).length) patch.parameters = parameters;
      return { patch, dirty: Object.keys(patch).length > 0, error: null };
    }

    if (base.schemaVersion === 2 && draft.schemaVersion === 2) {
      const patch: Record<string, unknown> = {};
      if (draft.name.trim() !== base.name) patch.name = draft.name;
      const parts: Record<string, unknown>[] = [];
      for (const part of draft.parts) {
        const original = base.parts.find((item) => item.id === part.id);
        if (!original) throw new DraftValueError(`部件 ${part.id} 已不存在，请刷新`);
        const partPatch: Record<string, unknown> = { id: part.id };
        for (const key of ["name", "material", "color"] as const) {
          if (part[key] !== original[key]) partPatch[key] = part[key];
        }
        const placement: Record<string, unknown> = {};
        const translate = normalizedTriple(part.placement.translate, `${part.name} 位移`);
        const rotateDeg = normalizedTriple(part.placement.rotateDeg, `${part.name} 旋转`);
        if (!sameJson(translate, original.placement.translate)) placement.translate = translate;
        if (!sameJson(rotateDeg, original.placement.rotateDeg)) placement.rotateDeg = rotateDeg;
        if (Object.keys(placement).length) partPatch.placement = placement;

        const features: Record<string, unknown>[] = [];
        for (const feature of part.features) {
          const originalFeature = original.features.find((item) => item.id === feature.id);
          if (!originalFeature) throw new DraftValueError(`特征 ${feature.id} 已不存在，请刷新`);
          const featurePatch: Record<string, unknown> = { id: feature.id };
          const origin = normalizedTriple(feature.origin, `${feature.id} 原点`);
          const distance = draftNumber(feature.distance, `${feature.id} 拉伸距离`);
          const profile = normalizeNumericTree(originalFeature.profile, feature.profile, `${feature.id} 轮廓`);
          if (!sameJson(origin, originalFeature.origin)) featurePatch.origin = origin;
          if (distance !== Number(originalFeature.distance)) featurePatch.distance = distance;
          if (!sameJson(profile, originalFeature.profile)) featurePatch.profile = profile;
          if (Object.keys(featurePatch).length > 1) features.push(featurePatch);
        }
        if (features.length) partPatch.features = features;
        if (Object.keys(partPatch).length > 1) parts.push(partPatch);
      }
      if (parts.length) patch.parts = parts;
      return { patch, dirty: Object.keys(patch).length > 0, error: null };
    }
    return { patch: {}, dirty: false, error: "当前 CAD 规格暂不支持在线编辑" };
  } catch (error) {
    return {
      patch: {},
      dirty: false,
      error: error instanceof Error ? error.message : "编辑参数无效",
    };
  }
}

function CadTextField({
  label,
  name,
  value,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] text-muted">{label}</span>
      <input
        name={name}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-xl border border-edge bg-panel px-3 text-xs text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accentSoft"
      />
    </label>
  );
}

function CadNumberField({
  label,
  name,
  value,
  onChange,
  step = "0.1",
}: {
  label: string;
  name: string;
  value: EditableNumber;
  onChange: (value: EditableNumber) => void;
  step?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block truncate text-[10px] text-muted" title={label}>{label}</span>
      <input
        name={name}
        autoComplete="off"
        type="number"
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
        className="h-9 w-full rounded-xl border border-edge bg-panel px-3 text-xs tabular-nums text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accentSoft"
      />
    </label>
  );
}

function CadVectorFields({
  label,
  name,
  value,
  onChange,
}: {
  label: string;
  name: string;
  value: EditableNumber[];
  onChange: (value: EditableNumber[]) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] text-muted">{label}</p>
      <div className="grid grid-cols-3 gap-2">
        {["X", "Y", "Z"].map((axis, index) => (
          <CadNumberField
            key={axis}
            label={axis}
            name={`${name}-${axis.toLowerCase()}`}
            value={value[index] ?? ""}
            onChange={(nextValue) => {
              const next = [...value];
              next[index] = nextValue;
              onChange(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function CadProfileFields({
  label,
  name,
  profile,
  onChange,
}: {
  label: string;
  name: string;
  profile: EditableProfile;
  onChange: (profile: EditableProfile) => void;
}) {
  const kind = profile.kind;
  if (kind !== "rectangle" && kind !== "circle") {
    return (
      <p className="rounded-xl bg-panel2/55 px-3 py-2.5 text-[10px] leading-relaxed text-muted">
        {label}为{kind === "polygon" ? "多边形" : "路径"}轮廓，本版仅支持修改位置和拉伸距离。
      </p>
    );
  }
  const center = Array.isArray(profile.center) ? profile.center as EditableNumber[] : [0, 0];
  const update = (key: string, value: unknown) => onChange({ ...profile, [key]: value });
  return (
    <div className="rounded-xl border border-edge bg-panel2/35 p-3">
      <p className="mb-2 text-[10px] font-medium text-ink2">{label} · {kind === "rectangle" ? "矩形" : "圆形"}</p>
      <div className="grid grid-cols-2 gap-2">
        <CadNumberField
          label="中心 X"
          name={`${name}-center-x`}
          value={center[0] ?? 0}
          onChange={(value) => update("center", [value, center[1] ?? 0])}
        />
        <CadNumberField
          label="中心 Y"
          name={`${name}-center-y`}
          value={center[1] ?? 0}
          onChange={(value) => update("center", [center[0] ?? 0, value])}
        />
        {kind === "rectangle" ? (
          <>
            <CadNumberField label="宽度" name={`${name}-width`} value={profile.width as EditableNumber} onChange={(value) => update("width", value)} />
            <CadNumberField label="高度" name={`${name}-height`} value={profile.height as EditableNumber} onChange={(value) => update("height", value)} />
            <CadNumberField label="圆角半径" name={`${name}-corner-radius`} value={profile.cornerRadius as EditableNumber} onChange={(value) => update("cornerRadius", value)} />
          </>
        ) : (
          <CadNumberField label="半径" name={`${name}-radius`} value={profile.radius as EditableNumber} onChange={(value) => update("radius", value)} />
        )}
      </div>
    </div>
  );
}

function CadEditPanel({
  draft,
  onChange,
  dirty,
  error,
  busy,
  progress,
  onReset,
  onSubmit,
}: {
  draft: EditableCadSpec | null;
  onChange: (draft: EditableCadSpec) => void;
  dirty: boolean;
  error: string | null;
  busy: boolean;
  progress: number;
  onReset: () => void;
  onSubmit: () => void;
}) {
  if (!draft) return <EmptyText>当前 CAD 规格暂不支持在线参数编辑。</EmptyText>;
  const change = (mutate: (next: EditableCadSpec) => void) => {
    const next = cloneJson(draft);
    mutate(next);
    onChange(next);
  };
  return (
    <div className="flex min-h-full flex-col">
      <div className="space-y-4 p-4 lg:p-5">
        <div className="rounded-xl border border-accent/20 bg-accentSoft/55 px-3 py-3 text-[11px] leading-relaxed text-ink2">
          修改会重新校验并生成一份新 CAD 版本，当前版本与制造文件保持不变，可随时回退。
        </div>
        <CadTextField
          label="模型名称"
          name="cad-edit-name"
          value={draft.name}
          onChange={(value) => change((next) => { next.name = value; })}
        />

        {draft.schemaVersion === 1 ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div className="block">
                <span className="mb-1.5 block text-[10px] text-muted">材料</span>
                <StyledSelect
                  value={draft.material}
                  options={MATERIAL_OPTIONS}
                  menuAlign="left"
                  triggerClassName="w-full"
                  ariaLabel="材料"
                  onChange={(value) => change((next) => {
                    if (next.schemaVersion === 1) next.material = value;
                  })}
                />
              </div>
              <div className="block">
                <span className="mb-1.5 block text-[10px] text-muted">制造工艺</span>
                <StyledSelect
                  value={draft.process}
                  options={PROCESS_OPTIONS}
                  menuAlign="left"
                  triggerClassName="w-full"
                  ariaLabel="制造工艺"
                  onChange={(value) => change((next) => {
                    if (next.schemaVersion === 1) next.process = value;
                  })}
                />
              </div>
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold text-ink">尺寸参数</h4>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(draft.parameters).map(([key, parameter]) => (
                  <CadNumberField
                    key={key}
                    label={`${PARAMETER_LABEL[key] ?? key}${parameter.unit === "count" ? "（个）" : "（mm）"}`}
                    name={`cad-edit-param-${key}`}
                    value={parameter.value}
                    step={parameter.unit === "count" ? "1" : "0.1"}
                    onChange={(value) => change((next) => {
                      if (next.schemaVersion === 1 && next.parameters[key]) {
                        next.parameters[key].value = value;
                      }
                    })}
                  />
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            {draft.parts.map((part) => (
              <details
                key={part.id}
                className="overflow-hidden rounded-xl border border-edge bg-panel2/30"
              >
                <summary className="cursor-pointer list-none px-3 py-3 text-xs font-semibold text-ink marker:hidden">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate">{part.name}</span>
                    <span className="shrink-0 text-[10px] font-normal text-muted">{part.features.length} 个特征 · 点击展开</span>
                  </span>
                </summary>
                <div className="space-y-3 border-t border-edge px-3 py-3">
                  <div className="grid grid-cols-2 gap-2">
                    <CadTextField
                      label="部件名称"
                      name={`cad-edit-part-${part.id}-name`}
                      value={part.name}
                      onChange={(value) => change((next) => {
                        if (next.schemaVersion === 2) {
                          const target = next.parts.find((item) => item.id === part.id);
                          if (target) target.name = value;
                        }
                      })}
                    />
                    <CadTextField
                      label="材料"
                      name={`cad-edit-part-${part.id}-material`}
                      value={part.material}
                      onChange={(value) => change((next) => {
                        if (next.schemaVersion === 2) {
                          const target = next.parts.find((item) => item.id === part.id);
                          if (target) target.material = value;
                        }
                      })}
                    />
                  </div>
                  <label className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-3 py-2.5">
                    <span className="text-[10px] text-muted">部件颜色</span>
                    <input
                      name={`cad-edit-part-${part.id}-color`}
                      type="color"
                      value={part.color}
                      onChange={(event) => change((next) => {
                        if (next.schemaVersion === 2) {
                          const target = next.parts.find((item) => item.id === part.id);
                          if (target) target.color = event.target.value;
                        }
                      })}
                      className="h-7 w-12 cursor-pointer rounded border-0 bg-transparent p-0"
                    />
                  </label>
                  <CadVectorFields
                    label="位移（mm）"
                    name={`cad-edit-part-${part.id}-translate`}
                    value={part.placement.translate}
                    onChange={(value) => change((next) => {
                      if (next.schemaVersion === 2) {
                        const target = next.parts.find((item) => item.id === part.id);
                        if (target) target.placement.translate = value;
                      }
                    })}
                  />
                  <CadVectorFields
                    label="旋转（°）"
                    name={`cad-edit-part-${part.id}-rotate`}
                    value={part.placement.rotateDeg}
                    onChange={(value) => change((next) => {
                      if (next.schemaVersion === 2) {
                        const target = next.parts.find((item) => item.id === part.id);
                        if (target) target.placement.rotateDeg = value;
                      }
                    })}
                  />

                  {part.features.map((feature) => (
                    <details key={feature.id} className="rounded-xl border border-edge bg-panel">
                      <summary className="cursor-pointer list-none px-3 py-2.5 text-[11px] font-medium text-ink2 marker:hidden">
                        <span className="flex items-center justify-between gap-2">
                          <span>{FEATURE_LABEL.extrude} · {feature.id}</span>
                          <span className="text-[9.5px] font-normal text-muted">点击展开</span>
                        </span>
                      </summary>
                      <div className="space-y-3 border-t border-edge p-3">
                        <CadNumberField
                          label="拉伸距离（mm）"
                          name={`cad-edit-feature-${feature.id}-distance`}
                          value={feature.distance}
                          onChange={(value) => change((next) => {
                            if (next.schemaVersion === 2) {
                              const targetPart = next.parts.find((item) => item.id === part.id);
                              const target = targetPart?.features.find((item) => item.id === feature.id);
                              if (target) target.distance = value;
                            }
                          })}
                        />
                        <CadVectorFields
                          label="特征原点（mm）"
                          name={`cad-edit-feature-${feature.id}-origin`}
                          value={feature.origin}
                          onChange={(value) => change((next) => {
                            if (next.schemaVersion === 2) {
                              const targetPart = next.parts.find((item) => item.id === part.id);
                              const target = targetPart?.features.find((item) => item.id === feature.id);
                              if (target) target.origin = value;
                            }
                          })}
                        />
                        <CadProfileFields
                          label="外轮廓"
                          name={`cad-edit-feature-${feature.id}-outer`}
                          profile={feature.profile.outer}
                          onChange={(profile) => change((next) => {
                            if (next.schemaVersion === 2) {
                              const targetPart = next.parts.find((item) => item.id === part.id);
                              const target = targetPart?.features.find((item) => item.id === feature.id);
                              if (target) target.profile.outer = profile;
                            }
                          })}
                        />
                        {feature.profile.holes.map((hole, holeIndex) => (
                          <CadProfileFields
                            key={`${feature.id}-hole-${holeIndex}`}
                            label={`孔轮廓 ${holeIndex + 1}`}
                            name={`cad-edit-feature-${feature.id}-hole-${holeIndex}`}
                            profile={hole}
                            onChange={(profile) => change((next) => {
                              if (next.schemaVersion === 2) {
                                const targetPart = next.parts.find((item) => item.id === part.id);
                                const target = targetPart?.features.find((item) => item.id === feature.id);
                                if (target) target.profile.holes[holeIndex] = profile;
                              }
                            })}
                          />
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>

      <div className="sticky bottom-0 mt-auto border-t border-edge bg-panel/95 p-4 backdrop-blur">
        {error && <p className="mb-2 text-[11px] leading-relaxed text-red-500">{error}</p>}
        {busy && (
          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between text-[10px] text-muted">
              <span>正在生成新版本…</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-panel2">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(4, progress)}%` }} />
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onReset}
            disabled={busy || !dirty}
            className="rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            重置
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !dirty || !!error}
            className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-onAccent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? "生成中…" : "生成新版本"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-edge px-4 py-4 last:border-b-0 lg:px-5">
      <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl bg-panel2/60 px-3 py-3 text-xs leading-relaxed text-muted">{children}</p>;
}

export function CadView({
  output,
  onClose,
  onDelete,
  onRevise,
}: {
  output: StudioOutput;
  onClose: () => void;
  onDelete?: () => void;
  onRevise?: (
    base: StudioOutput,
    patch: unknown,
    onProgress?: (progress: number) => void
  ) => Promise<StudioOutput | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fitViewRef = useRef<(() => void) | null>(null);
  const zoomViewRef = useRef<((direction: "in" | "out") => void) | null>(null);
  const standardViewRef = useRef<((view: StandardView) => void) | null>(null);
  const displayModeRef = useRef<((mode: DisplayMode) => void) | null>(null);
  const downOnBackdrop = useRef(false);
  const [meshState, setMeshState] = useState<MeshState>({ status: "loading" });
  const [meshRetry, setMeshRetry] = useState(0);
  const [sceneReady, setSceneReady] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("solid");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(null);
  const [downloadAcknowledged, setDownloadAcknowledged] = useState(false);
  const [editDraft, setEditDraft] = useState<EditableCadSpec | null>(() => parseEditableCadSpec(output.content || ""));
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [revisionProgress, setRevisionProgress] = useState(0);
  const revisionInflightRef = useRef(false);
  const parsed = useMemo(() => parseCadDesignSpec(output.content || ""), [output.content]);
  const spec = parsed.spec;
  const requirementReferenceMap = useMemo(
    () => Object.fromEntries(
      (spec?.requirements ?? []).map((requirement, index) => [requirement.id, `需求 ${index + 1}`])
    ),
    [spec]
  );
  const outputData = useMemo(() => {
    try {
      const value: unknown = JSON.parse(output.data || "{}");
      return isRecord(value) ? value : {};
    } catch {
      return {};
    }
  }, [output.data]);
  const artifactSourceCount = useMemo(() => {
    if (Array.isArray(outputData.usedSourceIds)) {
      return new Set(outputData.usedSourceIds.filter((id) => typeof id === "string" && id)).size;
    }
    if (Array.isArray(outputData.sourceIds)) {
      return new Set(outputData.sourceIds.filter((id) => typeof id === "string" && id)).size;
    }
    const count = Number(outputData.sources);
    return Number.isInteger(count) && count > 0 ? count : 0;
  }, [outputData]);
  const sourceReferenceMap = useMemo(() => {
    return isRecord(outputData.sourceReferenceMap)
      ? Object.fromEntries(
          Object.entries(outputData.sourceReferenceMap)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .slice(0, 64)
        )
      : {};
  }, [outputData]);
  const frozenManifest = useMemo(
    () => isRecord(outputData.manifest) ? outputData.manifest : {},
    [outputData]
  );
  const frozenFiles = isRecord(frozenManifest.files) ? frozenManifest.files : {};
  const hasDxfDownload = isRecord(frozenFiles.dxf)
    && Number.isInteger(Number(frozenFiles.dxf.bytes))
    && Number(frozenFiles.dxf.bytes) > 0;
  const modelSelection = useMemo(
    () => isRecord(outputData.modelSelection) ? outputData.modelSelection : null,
    [outputData]
  );
  const isTutorialExample = modelSelection?.tutorialExample === true;
  const requestMode = modelSelection?.requestMode === "fixed_template"
    || modelSelection?.requestMode === "prompt_driven"
    || modelSelection?.requestMode === "source_driven"
    ? modelSelection.requestMode
    : null;
  const tutorialContext = modelSelection?.tutorialContext === "cad_tutorial"
    || modelSelection?.tutorialContext === "no_cad_target"
    || modelSelection?.tutorialContext === "explicit"
    ? modelSelection.tutorialContext
    : null;
  const revisionSequenceValue = isRecord(outputData.revision)
    ? Number(outputData.revision.sequence ?? 1)
    : 1;
  const revisionSequence = Number.isInteger(revisionSequenceValue) && revisionSequenceValue > 0
    ? revisionSequenceValue
    : 1;
  const expectedHash = typeof frozenManifest.hash === "string" ? frozenManifest.hash : "";
  const expectedTemplate = typeof frozenManifest.template === "string" ? frozenManifest.template : "";
  const refLabel = (ref: string) =>
    requirementReferenceMap[ref] || sourceReferenceMap[ref] || sourceRefLabel(ref);
  const mesh = meshState.status === "ready" ? meshState.mesh : null;
  const templateId = String(spec?.template || expectedTemplate || mesh?.manifest.template || "");
  const isText2Cad = spec?.schemaVersion === 2 && spec.engine === "text2cad" && templateId === "text2cad";
  const frozenArtifactMode = typeof frozenManifest.artifactMode === "string" ? frozenManifest.artifactMode : "";
  const frozenPartCount = Number(frozenManifest.partCount);
  const frozenContract = resolveCadArtifactContract(templateId, frozenManifest, frozenManifest);
  const frozenContractFieldsAbsent = ["manifestVersion", "libraryVersion", "artifactMode", "partCount"]
    .every((key) => !Object.prototype.hasOwnProperty.call(frozenManifest, key));
  const legacySinglePart = CAD_MODEL_LIBRARY.some(
    (model) => model.id === templateId && model.artifactMode === "single_part"
  ) && frozenContractFieldsAbsent;
  const resolvedArtifactMode = mesh?.manifest.artifactMode
    || (frozenContract ? frozenArtifactMode : "")
    || (legacySinglePart ? "single_part" : "");
  const resolvedPartCount = mesh?.manifest.partCount
    ?? (frozenContract && Number.isInteger(frozenPartCount) && frozenPartCount > 0 ? frozenPartCount : null)
    ?? (legacySinglePart ? 1 : null);
  const isConceptAssembly = !isText2Cad && (
    resolvedArtifactMode === "concept_assembly"
    || resolvedArtifactMode === "assembly"
    || CONCEPT_ASSEMBLY_TEMPLATES.has(templateId)
  );
  const partTree = useMemo(() => {
    const meshById = new Map((mesh?.parts ?? []).map((part) => [part.id, part]));
    const rows: Array<Omit<PartTreeRow, "depth">> = spec?.parts.length
      ? spec.parts.map((part) => {
          const rendered = meshById.get(part.id);
          return {
            id: part.id,
            name: part.name,
            material: rendered?.material || part.material,
            color: rendered?.color || part.color,
            parentId: rendered?.parentId || part.parentId,
            featureCount: Math.max(part.features.length, rendered?.features.length ?? 0),
            placement: placementLabel(part),
          };
        })
      : (mesh?.parts ?? []).map((part) => ({
          id: part.id,
          name: part.name,
          material: part.material,
          color: part.color,
          parentId: part.parentId,
          featureCount: part.features.length,
          placement: null,
        }));
    return arrangePartTree(rows);
  }, [mesh?.parts, spec?.parts]);
  const validation = mesh ? validationView(mesh.manifest.validation) : null;
  const encodedId = encodeURIComponent(output.id);
  const meshError = meshState.status === "error" ? meshState.message : sceneError;
  const meshLoading = meshState.status === "loading" || (meshState.status === "ready" && !sceneReady && !sceneError);
  const revisionDraft = useMemo(
    () => buildCadRevisionPatch(output.content || "", editDraft),
    [editDraft, output.content]
  );

  const resetEditDraft = () => {
    setEditDraft(parseEditableCadSpec(output.content || ""));
    setRevisionProgress(0);
  };

  const submitRevision = async () => {
    if (!onRevise) {
      toast("当前账号没有 CAD 编辑入口", "error");
      return;
    }
    if (revisionInflightRef.current || revisionBusy) return;
    if (revisionDraft.error) {
      toast(revisionDraft.error, "error");
      return;
    }
    if (!revisionDraft.dirty) {
      toast("参数没有变化");
      return;
    }
    revisionInflightRef.current = true;
    setRevisionBusy(true);
    setRevisionProgress(0);
    try {
      await onRevise(output, revisionDraft.patch, (progress) => setRevisionProgress(progress));
    } catch (error) {
      toast(error instanceof Error ? error.message : "CAD 新版本生成失败，请重试", "error");
    } finally {
      revisionInflightRef.current = false;
      setRevisionBusy(false);
    }
  };

  const downloadCad = (format: "step" | "stl" | "dxf") => {
    if (!downloadAcknowledged) {
      setInspectorTab("validation");
      toast("请先在「验证与导出」中勾选工程复核确认", "error");
      return;
    }
    // 让服务端以 Content-Disposition 流式下发，避免大文件在前端 fetch→Blob
    // 形成双份内存。DXF 是明确标注的 XY 顶视二维边线投影，不冒充三维实体。
    const anchor = document.createElement("a");
    anchor.href = `/api/studio/cad/${encodedId}/${format}`;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? [])].filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setMeshState({ status: "loading" });
    setSceneReady(false);
    setSceneError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/studio/cad/${encodedId}/mesh`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > MAX_MESH_RESPONSE_BYTES) throw new Error("模型数据过大，无法在浏览器中安全预览");
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message = isRecord(body) && typeof body.error === "string" ? body.error : `模型加载失败 (${response.status})`;
          throw new Error(message.slice(0, 180));
        }
        const payload = parseCadMeshPayload(body);
        if (!/^[a-f0-9]{64}$/.test(expectedHash) || !expectedTemplate) {
          throw new Error("CAD 冻结清单缺失，拒绝显示未绑定模型");
        }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(output.content || ""));
        const contentHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        if (
          contentHash !== expectedHash
          || payload.manifest.hash !== expectedHash
          || payload.manifest.template !== expectedTemplate
          || spec?.template !== expectedTemplate
        ) {
          throw new Error("CAD 规格与三维文件包不一致，已拒绝显示");
        }
        const contract = resolveCadArtifactContract(
          expectedTemplate,
          payload.contractManifest,
          frozenManifest
        );
        if (!contract) {
          throw new Error("CAD 发布清单与模型库合同不一致，已拒绝显示");
        }
        if (isText2Cad && payload.parts.length !== contract.partCount) {
          throw new Error("Text2CAD 网格部件与发布清单不一致");
        }
        if (modelSelection) {
          const validMode = modelSelection.mode === "manual" || modelSelection.mode === "auto";
          const validStrategy = modelSelection.strategy === "manual"
            || modelSelection.strategy === "keyword"
            || modelSelection.strategy === "model"
            || modelSelection.strategy === "text2cad"
            || modelSelection.strategy === "concept_fallback";
          const manualMatches = modelSelection.mode !== "manual"
            || ((modelSelection.strategy === "manual" || modelSelection.strategy === "concept_fallback")
              && modelSelection.requestedTemplate === expectedTemplate);
          const autoMatches = modelSelection.mode !== "auto"
            || (modelSelection.strategy !== "manual" && modelSelection.requestedTemplate === null);
          if (
            !validMode
            || !validStrategy
            || !manualMatches
            || !autoMatches
            || modelSelection.resolvedTemplate !== expectedTemplate
            || Number(modelSelection.libraryVersion) !== contract.libraryVersion
          ) {
            throw new Error("CAD 模型库选择记录与发布制品不一致，已拒绝显示");
          }
        }
        payload.manifest = {
          ...payload.manifest,
          manifestVersion: contract.manifestVersion,
          libraryVersion: contract.libraryVersion,
          artifactMode: contract.artifactMode,
          partCount: contract.partCount,
        };
        if (alive) setMeshState({ status: "ready", mesh: payload });
      } catch (error) {
        if (!alive || controller.signal.aborted) return;
        setMeshState({
          status: "error",
          message: error instanceof Error ? error.message : "模型加载失败，请稍后重试。",
        });
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [encodedId, expectedHash, expectedTemplate, frozenManifest, isText2Cad, meshRetry, modelSelection, output.content, spec?.template]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvasHostRef.current;
    if (!canvas || !host || !mesh) return;

    let disposed = false;
    let renderer: WebGLRenderer | null = null;
    let controls: OrbitControlsType | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;
    const geometries: BufferGeometry[] = [];
    const materials: Material[] = [];

    setSceneReady(false);
    setSceneError(null);

    void (async () => {
      try {
        const [THREE, controlsModule] = await Promise.all([
          import("three"),
          import("three/examples/jsm/controls/OrbitControls.js"),
        ]);
        if (disposed) return;

        renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x000000, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.08;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100_000);
        camera.up.set(0, 0, 1);
        controls = new controlsModule.OrbitControls(camera, canvas);
        controls.enableDamping = true;
        controls.dampingFactor = 0.075;
        controls.enablePan = true;
        controls.screenSpacePanning = true;
        controls.minDistance = 0.01;
        controls.maxDistance = 100_000;

        const model = new THREE.Group();
        const solids: Array<{ visible: boolean }> = [];
        const edgeMaterials: Array<{ opacity: number }> = [];
        const palette = ["#7966de", "#2f86a6", "#d17a45", "#4f9d73", "#b15d8f", "#7a8799", "#c69b38", "#4e6fc4"];
        const renderParts: Array<Pick<CadMeshPart, "id" | "name" | "color" | "vertices" | "normals" | "triangles" | "lines">> = mesh.parts.length
          ? mesh.parts
          : [{
              id: "legacy-solid",
              name: "实体",
              color: "#7966de",
              vertices: mesh.vertices,
              normals: mesh.normals,
              triangles: mesh.triangles,
              lines: mesh.lines,
            }];
        for (const [index, part] of renderParts.entries()) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.Float32BufferAttribute(part.vertices, 3));
          geometry.setIndex(part.triangles);
          if (part.normals.length === part.vertices.length) {
            geometry.setAttribute("normal", new THREE.Float32BufferAttribute(part.normals, 3));
          } else {
            geometry.computeVertexNormals();
          }
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();
          geometries.push(geometry);

          const surfaceMaterial = new THREE.MeshStandardMaterial({
            color: part.color ?? palette[index % palette.length],
            metalness: 0.2,
            roughness: 0.48,
            side: THREE.DoubleSide,
          });
          materials.push(surfaceMaterial);
          const solid = new THREE.Mesh(geometry, surfaceMaterial);
          solid.name = part.name;
          solid.userData.partId = part.id;
          solids.push(solid);

          let edgeGeometry: BufferGeometry;
          if (part.lines.length > 0) {
            edgeGeometry = new THREE.BufferGeometry();
            edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(part.lines, 3));
          } else {
            edgeGeometry = new THREE.EdgesGeometry(geometry, 24);
          }
          geometries.push(edgeGeometry);
          const edgeMaterial = new THREE.LineBasicMaterial({
            color: 0x27263f,
            transparent: true,
            opacity: 0.64,
          });
          materials.push(edgeMaterial);
          edgeMaterials.push(edgeMaterial);
          const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
          edges.name = `${part.name} · 边线`;
          model.add(solid, edges);
        }
        const applyDisplayMode = (mode: DisplayMode) => {
          for (const solid of solids) solid.visible = mode === "solid";
          for (const material of edgeMaterials) material.opacity = mode === "wireframe" ? 1 : 0.64;
        };
        displayModeRef.current = applyDisplayMode;
        applyDisplayMode("solid");
        const rawBox = new THREE.Box3().setFromObject(model);
        if (rawBox.isEmpty()) throw new Error("模型没有可显示的几何体");
        const center = rawBox.getCenter(new THREE.Vector3());
        const size = rawBox.getSize(new THREE.Vector3());
        model.position.sub(center);
        scene.add(model);

        const span = Math.max(size.x, size.y, size.z, 1);
        const gridSize = Math.max(10, Math.ceil((span * 1.5) / 10) * 10);
        const grid = new THREE.GridHelper(gridSize, 20, 0x7c8498, 0xb2b7c4);
        grid.rotation.x = Math.PI / 2;
        grid.position.z = -size.z / 2;
        const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
        for (const material of gridMaterials) {
          material.transparent = true;
          material.opacity = 0.16;
          materials.push(material);
        }
        scene.add(grid);

        const axes = new THREE.AxesHelper(Math.max(span * 0.42, 8));
        axes.position.set(-size.x / 2, -size.y / 2, -size.z / 2);
        scene.add(axes);
        geometries.push(axes.geometry);
        const axisMaterials = Array.isArray(axes.material) ? axes.material : [axes.material];
        materials.push(...axisMaterials);

        scene.add(new THREE.HemisphereLight(0xf4f2ff, 0x30343d, 2.15));
        const keyLight = new THREE.DirectionalLight(0xffffff, 2.45);
        keyLight.position.set(span * 2.2, span * 2.8, span * 1.7);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0xa7b7ff, 1.2);
        fillLight.position.set(-span * 1.8, span, -span * 1.2);
        scene.add(fillLight);

        const radius = Math.max(new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere()).radius, 1);
        const setStandardView = (view: StandardView) => {
          camera.near = Math.max(radius / 500, 0.01);
          camera.far = Math.max(radius * 120, 1_000);
          camera.up.set(0, 0, 1);
          if (view === "front") camera.position.set(0, -radius * 2.55, 0);
          else if (view === "top") {
            camera.position.set(0, 0, radius * 2.55);
            camera.up.set(0, 1, 0);
          } else if (view === "right") camera.position.set(radius * 2.55, 0, 0);
          else camera.position.set(radius * 1.8, -radius * 1.8, radius * 1.35);
          camera.updateProjectionMatrix();
          controls?.target.set(0, 0, 0);
          controls?.update();
        };
        const fitView = () => setStandardView("iso");
        fitViewRef.current = fitView;
        standardViewRef.current = setStandardView;
        zoomViewRef.current = (direction) => {
          if (!controls) return;
          const factor = direction === "in" ? 0.82 : 1.22;
          camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);
          controls.update();
        };
        fitView();

        const resize = () => {
          if (disposed || !renderer) return;
          const width = Math.max(1, host.clientWidth);
          const height = Math.max(1, host.clientHeight);
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.render(scene, camera);
        };
        resize();
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
        window.addEventListener("resize", resize);
        resizeTimer = setTimeout(resize, 0);

        const renderFrame = () => {
          if (disposed || !renderer) return;
          controls?.update();
          renderer.render(scene, camera);
          frame = window.requestAnimationFrame(renderFrame);
        };
        renderFrame();
        setSceneReady(true);

        const removeWindowResize = () => window.removeEventListener("resize", resize);
        canvas.dataset.cadResizeCleanup = "registered";
        Object.defineProperty(canvas, "__cadRemoveWindowResize", {
          configurable: true,
          value: removeWindowResize,
        });
      } catch (error) {
        if (!disposed) {
          setSceneError(error instanceof Error ? error.message : "三维场景初始化失败，请稍后重试。");
        }
      }
    })();

    return () => {
      disposed = true;
      setSceneReady(false);
      if (frame) window.cancelAnimationFrame(frame);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      const removeWindowResize = (canvas as HTMLCanvasElement & { __cadRemoveWindowResize?: () => void }).__cadRemoveWindowResize;
      removeWindowResize?.();
      delete (canvas as HTMLCanvasElement & { __cadRemoveWindowResize?: () => void }).__cadRemoveWindowResize;
      delete canvas.dataset.cadResizeCleanup;
      controls?.dispose();
      for (const geometry of new Set(geometries)) geometry.dispose();
      for (const material of new Set(materials)) material.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
      fitViewRef.current = null;
      zoomViewRef.current = null;
      standardViewRef.current = null;
      displayModeRef.current = null;
    };
  }, [mesh]);

  useEffect(() => {
    displayModeRef.current?.(displayMode);
  }, [displayMode, sceneReady]);

  return (
    <div
      data-testid="cad-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-0 lg:p-4"
      onMouseDown={(event) => {
        downOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (downOnBackdrop.current && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal={true}
        aria-labelledby="cad-view-title"
        tabIndex={-1}
        data-testid="cad-view-dialog"
        data-expanded={full ? "true" : "false"}
        className={cn(
          "flex h-dvh w-full flex-col overflow-hidden rounded-none bg-panel shadow-2xl outline-none lg:rounded-2xl lg:border lg:border-edge",
          full ? "lg:h-[94vh] lg:max-w-[96vw]" : "lg:h-[86vh] lg:max-w-4xl"
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-edge px-4 py-3 lg:px-6">
          <div className="min-w-0 flex-1">
            <h2 id="cad-view-title" className="truncate text-[19px] font-semibold leading-tight text-ink" title={output.title}>
              {output.title || "CAD 参数化模型"}
            </h2>
            <p className="mt-0.5 truncate text-[13px] text-muted">
              {isTutorialExample
                ? tutorialContext === "explicit"
                  ? "CAD 教学示例 · 用户明确选择 · 系统默认尺寸"
                  : tutorialContext === "no_cad_target"
                  ? "CAD 教学示例 · 未从所选来源识别出可执行建模目标"
                  : `CAD 教学示例 · 参考 ${artifactSourceCount} 个教程来源`
                : requestMode === "fixed_template"
                  ? "CAD 可视图 · 标准模板 · 不使用来源"
                  : requestMode === "prompt_driven" && artifactSourceCount === 0
                    ? "CAD 可视图 · 按描述生成 · 未使用来源"
                    : `CAD 可视图 · 基于 ${artifactSourceCount} 个来源`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setFull((value) => !value)}
              className="hidden rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent lg:block"
              title={full ? "还原" : "展开"}
              aria-label={full ? "还原 CAD 查看器" : "展开 CAD 查看器"}
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.9}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                {full ? (
                  <>
                    <path d="M4 14h6v6" />
                    <path d="M20 10h-6V4" />
                    <path d="m14 10 7-7" />
                    <path d="m3 21 7-7" />
                  </>
                ) : (
                  <>
                    <path d="M15 3h6v6" />
                    <path d="M9 21H3v-6" />
                    <path d="m21 3-7 7" />
                    <path d="m3 21 7-7" />
                  </>
                )}
              </svg>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-ink"
              aria-label="关闭 CAD 查看器"
              title="关闭"
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-5 pt-4 lg:px-6">
          <div
            ref={canvasHostRef}
            data-testid="cad-view-canvas-host"
            className="relative min-h-0 w-full flex-1 overflow-hidden bg-white"
          >
            <canvas
              ref={canvasRef}
              className="block h-full w-full touch-none"
              aria-label="三维 CAD 模型预览，可拖动旋转并使用滚轮或双指缩放"
            />

            {!meshError && !meshLoading && !inspectorTab && (
              <div className="absolute right-3 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-2">
                <button
                  type="button"
                  onClick={() => fitViewRef.current?.()}
                  className="grid h-9 w-9 place-items-center rounded-full border border-edge bg-panel text-ink2 shadow-md transition hover:bg-panel2 hover:text-accent"
                  aria-label="适应 CAD 可视图"
                  title="适配视图"
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m8 9 4-4 4 4" />
                    <path d="m8 15 4 4 4-4" />
                  </svg>
                </button>
                <div className="overflow-hidden rounded-full border border-edge bg-panel shadow-md">
                  <button
                    type="button"
                    onClick={() => zoomViewRef.current?.("in")}
                    className="grid h-9 w-9 place-items-center text-ink2 transition hover:bg-panel2 hover:text-accent"
                    aria-label="放大 CAD 可视图"
                    title="放大"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <div className="mx-auto h-px w-5 bg-edge" />
                  <button
                    type="button"
                    onClick={() => zoomViewRef.current?.("out")}
                    className="grid h-9 w-9 place-items-center text-ink2 transition hover:bg-panel2 hover:text-accent"
                    aria-label="缩小 CAD 可视图"
                    title="缩小"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                      <path d="M5 12h14" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {inspectorTab && (
              <aside className="absolute inset-x-3 bottom-16 top-[62px] z-40 flex flex-col overflow-hidden rounded-2xl border border-edge bg-panel/95 shadow-[0_16px_40px_-12px_rgba(20,22,40,0.24)] backdrop-blur lg:bottom-3 lg:left-auto lg:right-3 lg:top-3 lg:w-[min(380px,calc(100%_-_24px))]">
                <div className="flex shrink-0 items-center justify-between gap-3 border-b border-edge px-4 py-3">
                  <div>
                    <h3 className="text-sm font-semibold text-ink">
                      {inspectorTab === "overview"
                        ? "设计概览"
                        : inspectorTab === "edit"
                          ? "在线参数编辑"
                          : inspectorTab === "structure"
                            ? "模型结构"
                            : "验证与导出"}
                    </h3>
                    <p className="mt-0.5 text-[11px] text-muted">
                      {inspectorTab === "overview"
                        ? "关键规格与当前结论"
                        : inspectorTab === "edit"
                          ? "修改受控参数并生成新版本"
                          : inspectorTab === "structure"
                            ? "部件、参数与特征历史"
                            : "几何检查与制造文件确认"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInspectorTab(null)}
                    className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-panel2 hover:text-ink"
                    aria-label="收起信息面板"
                    title="收起"
                  >
                    <CloseIcon />
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  {parsed.error && (
                    <div className="border-b border-edge px-4 py-4">
                      <div className="rounded-xl border border-red-200/70 bg-red-50/70 px-3 py-3 text-xs leading-relaxed text-red-700 dark:border-red-900/60 dark:bg-red-950/25 dark:text-red-300">
                        {parsed.error}
                      </div>
                    </div>
                  )}

                  {inspectorTab === "overview" && spec && (
                    <>
                      <Section title="关键信息">
                        <dl className="grid grid-cols-2 gap-2">
                          {[
                            ["模板", TEMPLATE_LABEL[templateId] ?? templateId],
                            ["匹配方式", selectionStrategyLabel(modelSelection)],
                            ["制品形态", artifactModeLabel(resolvedArtifactMode, isText2Cad)],
                            ["部件数量", resolvedPartCount ? `${resolvedPartCount} 个` : "待清单确认"],
                            ["材料", MATERIAL_LABEL[spec.material] ?? spec.material],
                            ["制造工艺", PROCESS_LABEL[spec.process] ?? spec.process],
                            ["规格版本", `v${spec.schemaVersion}`],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded-xl bg-panel2/65 px-3 py-2.5">
                              <dt className="text-[10px] text-muted">{label}</dt>
                              <dd className="mt-1 truncate text-xs font-medium text-ink" title={value}>{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </Section>
                      <Section title="本次结论">
                        <div className="space-y-2">
                          <div
                            className={cn(
                              "flex items-center gap-2 rounded-xl border px-3 py-3 text-xs font-medium",
                              validation?.ok === true
                                ? "border-emerald-200 bg-emerald-50/70 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/25 dark:text-emerald-300"
                                : validation?.ok === false
                                  ? "border-red-200 bg-red-50/70 text-red-700 dark:border-red-900/60 dark:bg-red-950/25 dark:text-red-300"
                                  : "border-edge bg-panel2/60 text-ink2"
                            )}
                          >
                            <span className={cn("h-2 w-2 rounded-full", validation?.ok === true ? "bg-emerald-500" : validation?.ok === false ? "bg-red-500" : "bg-amber-500")} />
                            {validation?.label ?? "正在读取几何结论…"}
                          </div>
                          <p className="rounded-xl bg-panel2/45 px-3 py-3 text-[11px] leading-relaxed text-ink2">
                            {isConceptAssembly
                              ? "当前结果用于确认外形比例、姿态和部件布局，制造前仍需完成整机工程复核。"
                              : "模型已按当前参数生成，制造前请继续核对关键尺寸、材料、公差与工艺。"}
                          </p>
                        </div>
                      </Section>
                    </>
                  )}

                  {inspectorTab === "edit" && (
                    <CadEditPanel
                      draft={editDraft}
                      onChange={setEditDraft}
                      dirty={revisionDraft.dirty}
                      error={revisionDraft.error}
                      busy={revisionBusy}
                      progress={revisionProgress}
                      onReset={resetEditDraft}
                      onSubmit={() => void submitRevision()}
                    />
                  )}

                  {inspectorTab === "structure" && spec && (
                    <>
                      {partTree.length > 0 && (
                        <Section title={`部件树 · ${partTree.length}`}>
                          <ol className="overflow-hidden rounded-xl border border-edge">
                            {partTree.map((part) => (
                              <li
                                key={part.id}
                                className="border-b border-edge bg-panel2/35 px-3 py-2.5 last:border-b-0"
                                style={{ paddingLeft: `${12 + part.depth * 16}px` }}
                              >
                                <div className="flex items-center gap-2">
                                  <span
                                    className="h-3 w-3 shrink-0 rounded-[3px] border border-black/10"
                                    style={{ backgroundColor: part.color ?? "#7966de" }}
                                    aria-hidden
                                  />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-xs font-medium text-ink" title={part.name}>{part.name}</p>
                                    <p className="mt-0.5 truncate text-[9.5px] text-muted" title={part.id}>
                                      {MATERIAL_LABEL[part.material] ?? part.material} · {part.featureCount} 个特征
                                    </p>
                                  </div>
                                </div>
                                {part.placement && <p className="mt-1 pl-5 text-[9.5px] leading-relaxed text-ink2">{part.placement}</p>}
                              </li>
                            ))}
                          </ol>
                        </Section>
                      )}

                      <Section title={`需求追溯 · ${spec.requirements.length}`}>
                        {spec.requirements.length ? (
                          <ol className="space-y-2.5">
                            {spec.requirements.map((requirement, index) => (
                              <li key={requirement.id} className="rounded-xl border border-edge bg-panel2/40 px-3 py-3">
                                <div className="flex items-start gap-2">
                                  <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-accentSoft text-[10px] font-semibold text-accent">
                                    {index + 1}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs leading-relaxed text-ink">{requirement.text}</p>
                                    {requirement.acceptance && (
                                      <p className="mt-1.5 text-[11px] leading-relaxed text-ink2">验收：{requirement.acceptance}</p>
                                    )}
                                  </div>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-1">
                                  {requirement.sourceRefs.map((ref) => (
                                    <span key={ref} className="max-w-full truncate rounded-md bg-panel px-2 py-1 text-[10px] text-muted" title={ref}>
                                      {refLabel(ref)}
                                    </span>
                                  ))}
                                </div>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <EmptyText>这份规格没有需求追溯记录。</EmptyText>
                        )}
                      </Section>

                      {spec.assumptions.length > 0 && (
                        <Section title={`设计假设 · ${spec.assumptions.length}`}>
                          <ul className="space-y-1.5 rounded-xl bg-panel2/45 px-3 py-3 text-[11px] leading-relaxed text-ink2">
                            {spec.assumptions.map((assumption, index) => (
                              <li key={`${assumption}-${index}`} className="flex gap-2">
                                <span className="text-muted">{index + 1}.</span>
                                <span>{assumption}</span>
                              </li>
                            ))}
                          </ul>
                        </Section>
                      )}

                      {Object.keys(spec.parameters).length > 0 && (
                        <Section title={`参数 · ${Object.keys(spec.parameters).length}`}>
                          <dl className="divide-y divide-edge overflow-hidden rounded-xl border border-edge">
                            {Object.entries(spec.parameters).map(([key, parameter]) => (
                              <div key={key} className="flex items-start justify-between gap-3 bg-panel2/35 px-3 py-2.5">
                                <div className="min-w-0">
                                  <dt className="truncate text-[11px] text-ink2" title={key}>{PARAMETER_LABEL[key] ?? key}</dt>
                                  {parameter.requirementRefs.length > 0 && (
                                    <p className="mt-0.5 truncate text-[9.5px] text-muted" title={parameter.requirementRefs.join("、")}>
                                      追溯：{parameter.requirementRefs.map(refLabel).join("、")}
                                    </p>
                                  )}
                                </div>
                                <dd className="shrink-0 text-xs font-semibold tabular-nums text-ink">
                                  {formatParameter(parameter.value, parameter.unit)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </Section>
                      )}

                      <Section title={`${isText2Cad ? "特征历史" : "特征 DAG"} · ${spec.featureGraph.nodes.length}`}>
                        {spec.featureGraph.nodes.length ? (
                          <ol className="relative ml-2 space-y-3 border-l border-accent/25 pl-4">
                            {spec.featureGraph.nodes.map((node, index) => (
                              <li key={node.id} className="relative rounded-xl border border-edge bg-panel2/40 px-3 py-3">
                                <span className="absolute -left-[21px] top-4 h-2.5 w-2.5 rounded-full border-2 border-panel bg-accent" />
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="truncate text-xs font-semibold text-ink">
                                      {index + 1}. {FEATURE_LABEL[node.kind] ?? node.kind}
                                    </p>
                                    <p className="mt-0.5 font-mono text-[9.5px] text-muted">{node.id}</p>
                                  </div>
                                  <span className="shrink-0 rounded-full bg-accentSoft px-2 py-0.5 text-[9.5px] font-medium text-accent">
                                    {OPERATION_LABEL[node.operation] ?? node.operation}
                                  </span>
                                </div>
                                <div className="mt-2 space-y-1 text-[10px] leading-relaxed text-ink2">
                                  {node.partId && <p>部件：{spec.parts.find((part) => part.id === node.partId)?.name ?? node.partId}</p>}
                                  <p>依赖：{node.dependsOn.length ? node.dependsOn.join("、") : "起始特征"}</p>
                                  {node.parameterRefs.length > 0 && <p>参数：{node.parameterRefs.map((ref) => PARAMETER_LABEL[ref] ?? ref).join("、")}</p>}
                                  {node.plane && <p>草图平面：{node.plane}</p>}
                                  {node.origin && <p>原点：{node.origin.map(formatCompact).join(" / ")} mm</p>}
                                  {typeof node.distance === "number" && <p>特征距离：{formatCompact(node.distance)} mm</p>}
                                  {profileLabel(node.profile) && <p>轮廓：{profileLabel(node.profile)}</p>}
                                  <p>需求：{node.requirementRefs.length ? node.requirementRefs.map(refLabel).join("、") : "无"}</p>
                                </div>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <EmptyText>这份规格没有特征节点。</EmptyText>
                        )}
                      </Section>
                    </>
                  )}

                  {inspectorTab === "validation" && (
                    <>
                      <Section title="几何验证">
                        {!mesh || !validation ? (
                          <EmptyText>{meshError ? "网格加载失败，暂无验证结果。" : "正在读取验证结果…"}</EmptyText>
                        ) : (
                          <div className="space-y-3">
                            <div
                              className={cn(
                                "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-medium",
                                validation.ok === true
                                  ? "border-emerald-200 bg-emerald-50/70 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/25 dark:text-emerald-300"
                                  : validation.ok === false
                                    ? "border-red-200 bg-red-50/70 text-red-700 dark:border-red-900/60 dark:bg-red-950/25 dark:text-red-300"
                                    : "border-edge bg-panel2/60 text-ink2"
                              )}
                            >
                              <span className={cn("h-2 w-2 rounded-full", validation.ok === true ? "bg-emerald-500" : validation.ok === false ? "bg-red-500" : "bg-amber-500")} />
                              {validation.label}
                            </div>
                            {validation.messages.length > 0 && (
                              <ul className="space-y-1.5 rounded-xl bg-panel2/45 px-3 py-2.5 text-[11px] leading-relaxed text-ink2">
                                {validation.messages.map((message, index) => <li key={`${message}-${index}`}>· {message}</li>)}
                              </ul>
                            )}
                            <dl className="space-y-2 text-[11px]">
                              {boundsView(mesh.manifest.bounds).map((row) => (
                                <div key={row.label} className="flex items-start justify-between gap-3">
                                  <dt className="text-muted">{row.label}</dt>
                                  <dd className="text-right font-medium tabular-nums text-ink">{row.value}</dd>
                                </div>
                              ))}
                              <div className="flex items-start justify-between gap-3">
                                <dt className="text-muted">实体体积</dt>
                                <dd className="text-right font-medium tabular-nums text-ink">{formatCompact(mesh.manifest.volumeMm3)} mm³</dd>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <dt className="text-muted">三角面</dt>
                                <dd className="text-right font-medium tabular-nums text-ink">{mesh.manifest.triangleCount.toLocaleString("zh-CN")}</dd>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <dt className="text-muted">几何引擎</dt>
                                <dd className="max-w-[210px] truncate text-right font-medium text-ink" title={mesh.manifest.engine}>{mesh.manifest.engine}</dd>
                              </div>
                              <div className="flex items-start justify-between gap-3">
                                <dt className="text-muted">内容哈希</dt>
                                <dd className="max-w-[210px] truncate text-right font-mono text-[10px] text-ink" title={mesh.manifest.hash}>{mesh.manifest.hash}</dd>
                              </div>
                            </dl>
                          </div>
                        )}
                      </Section>
                      <Section title="导出确认">
                        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-edge bg-panel2/45 px-3 py-3 text-xs leading-relaxed text-ink2">
                          <input
                            name="cad-download-ack"
                            type="checkbox"
                            checked={downloadAcknowledged}
                            onChange={(event) => setDownloadAcknowledged(event.target.checked)}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--c-accent))]"
                          />
                          <span>
                            {isConceptAssembly
                              ? "我已确认这是概念装配，仅用于外形比例、姿态、部件布局与方案沟通，不是可直接制造的整机装配；导出前仍需完成机械、电气、安全与公差工程复核。"
                              : "我已核对关键尺寸、模板假设和几何验证结果；首版结果仅作为设计辅助，仍需在制造前完成工程复核。"}
                          </span>
                        </label>
                      </Section>
                    </>
                  )}
                </div>
              </aside>
            )}

            {!meshError && !meshLoading && (
              <div
                className={cn(
                  "absolute bottom-3 left-3 right-3 z-10 flex items-end overflow-x-auto transition-[right]",
                  inspectorTab && "2xl:right-[398px]"
                )}
              >
                <div className="flex shrink-0 items-center overflow-hidden rounded-full border border-edge bg-panel shadow-md" role="group" aria-label="CAD 视图与显示模式">
                  {([
                    ["iso", "等轴"],
                    ["front", "前"],
                    ["top", "顶"],
                    ["right", "右"],
                  ] as const).map(([view, label]) => (
                    <button
                      key={view}
                      type="button"
                      onClick={() => view === "iso" ? fitViewRef.current?.() : standardViewRef.current?.(view)}
                      className="h-9 px-2.5 text-[11px] font-medium text-ink2 transition hover:bg-panel2 hover:text-accent sm:px-3 sm:text-xs"
                    >
                      {label}
                    </button>
                  ))}
                  <span className="h-5 w-px shrink-0 bg-edge" aria-hidden />
                  {(["solid", "wireframe"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={displayMode === mode}
                      onClick={() => setDisplayMode(mode)}
                      className={cn(
                        "h-9 px-2.5 text-[11px] font-medium transition sm:px-3 sm:text-xs",
                        displayMode === mode ? "bg-accentSoft text-accent" : "text-ink2 hover:bg-panel2 hover:text-accent"
                      )}
                    >
                      {mode === "solid" ? "实体" : "线框"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {meshLoading && (
              <div className="absolute inset-0 z-30 grid place-items-center bg-panel2/75 backdrop-blur-[1px]">
                <div className="flex flex-col items-center gap-3 text-sm text-ink2">
                  <span className="h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-accent" />
                  正在加载三维模型…
                </div>
              </div>
            )}

            {meshError && (
              <div className="absolute inset-0 z-30 grid place-items-center bg-panel2/90 p-6">
                <div className="max-w-md rounded-2xl border border-red-200/70 bg-panel p-6 text-center shadow-sm dark:border-red-900/60">
                  <p className="text-[15px] font-semibold text-ink">三维模型暂时无法显示</p>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{meshError}</p>
                  <button
                    type="button"
                    onClick={() => setMeshRetry((value) => value + 1)}
                    className="mt-4 rounded-full border border-edge px-4 py-2 text-sm font-medium text-ink2 transition hover:border-accent hover:text-accent"
                  >
                    重新加载
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="mt-2.5 flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-muted">
            <span>拖动旋转 · 滚轮缩放 · 右键平移</span>
            {mesh && <span className="tabular-nums">· {mesh.manifest.triangleCount.toLocaleString("zh-CN")} 个三角面</span>}
            {isTutorialExample && <span>· 教学默认尺寸 · 不代表来源约束 · 不用于制造</span>}
          </div>
        </main>

        <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-edge bg-panel px-4 py-3 lg:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="shrink-0 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-red-300 hover:text-red-600"
              >
                删除
              </button>
            )}
          </div>
          <div className="ml-auto flex max-w-full items-center gap-2 overflow-x-auto" role="group" aria-label="下载 CAD 文件">
            <button
              type="button"
              onClick={() => downloadCad("stl")}
              className="shrink-0 rounded-full border border-edge px-4 py-2 text-sm font-medium text-ink2 transition hover:border-accent hover:text-accent"
              title="下载用于三维打印和网格交换的 STL 文件"
            >
              下载 STL
            </button>
            {hasDxfDownload && (
              <button
                type="button"
                onClick={() => downloadCad("dxf")}
                className="shrink-0 rounded-full border border-edge px-4 py-2 text-sm font-medium text-ink2 transition hover:border-accent hover:text-accent"
                title="下载毫米单位的 XY 顶视二维边线投影"
              >
                下载 2D DXF（顶视图）
              </button>
            )}
            <button
              type="button"
              onClick={() => downloadCad("step")}
              className="shrink-0 rounded-full bg-accent px-6 py-2 text-sm font-medium text-onAccent transition hover:brightness-110"
              title="下载保留三维 B-Rep 实体的 STEP 文件"
            >
              下载 STEP
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
