import { createHash } from "node:crypto";
import {
  canonicalCadDesignJson,
  normalizeCadDesignSpec,
  type CadDesignSpec,
} from "./cad-spec";
import { renderCadSpec, type CadManifest } from "./cad";
import {
  canonicalText2CadDesignJson,
  normalizeText2CadDesignSpec,
  type Text2CadDesignSpec,
  type Text2CadProfileSet,
} from "./text2cad-spec";
import { renderText2CadSpec, type Text2CadManifest } from "./text2cad";

const RESERVED_REQUIREMENTS = new Set(["req_model_input", "req_template_defaults"]);
const MAX_PATCH_BYTES = 256 * 1024;

type CadV1Patch = {
  name?: string;
  material?: string;
  process?: string;
  parameters?: Record<string, number>;
};

type CadV2FeaturePatch = {
  id: string;
  origin?: [number, number, number];
  distance?: number;
  profile?: Text2CadProfileSet;
};

type CadV2PartPatch = {
  id: string;
  name?: string;
  material?: string;
  color?: string;
  placement?: {
    translate?: [number, number, number];
    rotateDeg?: [number, number, number];
  };
  features?: CadV2FeaturePatch[];
};

type CadV2Patch = {
  name?: string;
  parts?: CadV2PartPatch[];
};

export type CadRevisionPatch = CadV1Patch | CadV2Patch;

export type PreparedCadRevision =
  | {
      schemaVersion: 1;
      spec: CadDesignSpec;
      content: string;
      hash: string;
      title: string;
      changedFields: string[];
      unchanged: boolean;
    }
  | {
      schemaVersion: 2;
      spec: Text2CadDesignSpec;
      content: string;
      hash: string;
      title: string;
      changedFields: string[];
      unchanged: boolean;
    };

export type RenderedCadRevision = {
  content: string;
  tmpDir: string;
  manifest: CadManifest | Text2CadManifest;
};

export class CadRevisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CadRevisionValidationError";
  }
}

function fail(message: string): never {
  throw new CadRevisionValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) fail(`${label}不支持字段 ${unknown}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertPatchSize(patch: unknown): void {
  let size = Infinity;
  try {
    size = Buffer.byteLength(JSON.stringify(patch), "utf8");
  } catch {
    fail("编辑参数不是合法 JSON");
  }
  if (size > MAX_PATCH_BYTES) fail("编辑参数过大");
}

function rawSpec(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) fail("原 CAD 规格无效");
    return parsed;
  } catch (error) {
    if (error instanceof CadRevisionValidationError) throw error;
    fail("原 CAD 规格无法解析");
  }
}

function explicitRequirements(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => (
    isRecord(entry)
    && typeof entry.id === "string"
    && !RESERVED_REQUIREMENTS.has(entry.id)
  ));
}

function restoreV1(content: string): CadDesignSpec {
  const raw = rawSpec(content);
  if (raw.schemaVersion !== 1) fail("原 CAD 规格版本不支持模板参数编辑");
  const parameters = isRecord(raw.parameters)
    ? Object.fromEntries(Object.entries(raw.parameters).map(([key, value]) => {
        if (!isRecord(value)) return [key, value];
        return [key, {
          value: value.value,
          requirementRefs: value.requirementRefs,
        }];
      }))
    : raw.parameters;
  return normalizeCadDesignSpec({
    schemaVersion: raw.schemaVersion,
    unit: raw.unit,
    template: raw.template,
    name: raw.name,
    material: raw.material,
    process: raw.process,
    requirements: explicitRequirements(raw.requirements),
    parameters,
  });
}

function restoreV2(content: string): Text2CadDesignSpec {
  const raw = rawSpec(content);
  if (raw.schemaVersion !== 2) fail("原 CAD 规格版本不支持 Text2CAD 参数编辑");
  return normalizeText2CadDesignSpec({
    schemaVersion: raw.schemaVersion,
    engine: raw.engine,
    unit: raw.unit,
    name: raw.name,
    process: raw.process,
    requirements: explicitRequirements(raw.requirements),
    assumptions: raw.assumptions,
    parts: raw.parts,
  });
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label}必须是有限数值`);
  return Object.is(value, -0) ? 0 : value;
}

function point3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) fail(`${label}必须包含 X、Y、Z 三个数值`);
  return [
    numberValue(value[0], `${label}.X`),
    numberValue(value[1], `${label}.Y`),
    numberValue(value[2], `${label}.Z`),
  ];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function profileTopology(value: unknown): unknown {
  if (typeof value === "number") return "#";
  if (Array.isArray(value)) return value.map(profileTopology);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, profileTopology(value[key])])
    );
  }
  return value;
}

function mergeV1(content: string, patchValue: unknown): PreparedCadRevision {
  if (!isRecord(patchValue)) fail("编辑参数必须是对象");
  assertExactKeys(patchValue, ["name", "material", "process", "parameters"], "模板编辑");
  const current = restoreV1(content);
  const next = clone(current);
  const changedFields: string[] = [];

  if (patchValue.name !== undefined) {
    if (typeof patchValue.name !== "string") fail("模型名称必须是文字");
    if (patchValue.name.trim() !== current.name) changedFields.push("模型名称");
    next.name = patchValue.name;
  }
  if (patchValue.material !== undefined) {
    if (typeof patchValue.material !== "string") fail("材料必须是文字");
    if (patchValue.material !== current.material) changedFields.push("材料");
    next.material = patchValue.material as CadDesignSpec["material"];
  }
  if (patchValue.process !== undefined) {
    if (typeof patchValue.process !== "string") fail("制造工艺必须是文字");
    if (patchValue.process !== current.process) changedFields.push("制造工艺");
    next.process = patchValue.process as CadDesignSpec["process"];
  }
  if (patchValue.parameters !== undefined) {
    if (!isRecord(patchValue.parameters)) fail("参数修改必须是对象");
    for (const [key, raw] of Object.entries(patchValue.parameters)) {
      const existing = current.parameters[key];
      if (!existing) fail(`当前模板不存在参数 ${key}`);
      const value = numberValue(raw, `参数 ${key}`);
      if (value !== existing.value) changedFields.push(key);
      next.parameters[key] = {
        ...existing,
        value,
        requirementRefs: value === existing.value
          ? existing.requirementRefs
          : [...new Set([...existing.requirementRefs, "req_model_input"])].sort(),
      };
    }
  }

  const referenced = new Set(
    Object.values(next.parameters).flatMap((parameter) => parameter.requirementRefs)
  );
  const safe = normalizeCadDesignSpec({
    schemaVersion: 1,
    unit: "mm",
    template: current.template,
    name: next.name,
    material: next.material,
    process: next.process,
    requirements: current.requirements.filter((requirement) => (
      !RESERVED_REQUIREMENTS.has(requirement.id) && referenced.has(requirement.id)
    )),
    parameters: Object.fromEntries(
      Object.entries(next.parameters).map(([key, parameter]) => [
        key,
        { value: parameter.value, requirementRefs: parameter.requirementRefs },
      ])
    ),
  });
  const nextContent = canonicalCadDesignJson(safe);
  const currentContent = canonicalCadDesignJson(current);
  return {
    schemaVersion: 1,
    spec: safe,
    content: nextContent,
    hash: jsonHash(nextContent),
    title: safe.name,
    changedFields: [...new Set(changedFields)].slice(0, 64),
    unchanged: nextContent === currentContent,
  };
}

function mergeV2(content: string, patchValue: unknown): PreparedCadRevision {
  if (!isRecord(patchValue)) fail("编辑参数必须是对象");
  assertExactKeys(patchValue, ["name", "parts"], "Text2CAD 编辑");
  const current = restoreV2(content);
  const next = clone(current);
  const changedFields: string[] = [];

  if (patchValue.name !== undefined) {
    if (typeof patchValue.name !== "string") fail("模型名称必须是文字");
    if (patchValue.name.trim() !== current.name) changedFields.push("模型名称");
    next.name = patchValue.name;
  }
  if (patchValue.parts !== undefined) {
    if (!Array.isArray(patchValue.parts)) fail("部件修改必须是数组");
    const seenParts = new Set<string>();
    for (const rawPart of patchValue.parts) {
      if (!isRecord(rawPart)) fail("部件修改项必须是对象");
      assertExactKeys(rawPart, ["id", "name", "material", "color", "placement", "features"], "部件编辑");
      if (typeof rawPart.id !== "string" || seenParts.has(rawPart.id)) fail("部件 ID 无效或重复");
      seenParts.add(rawPart.id);
      const partIndex = next.parts.findIndex((part) => part.id === rawPart.id);
      if (partIndex < 0) fail(`当前模型不存在部件 ${rawPart.id}`);
      const part = next.parts[partIndex];
      const originalPart = current.parts.find((item) => item.id === rawPart.id)!;

      for (const key of ["name", "material", "color"] as const) {
        if (rawPart[key] === undefined) continue;
        if (typeof rawPart[key] !== "string") fail(`部件 ${rawPart.id} 的${key}必须是文字`);
        if (rawPart[key] !== originalPart[key]) changedFields.push(`${rawPart.id}.${key}`);
        part[key] = rawPart[key];
      }
      if (rawPart.placement !== undefined) {
        if (!isRecord(rawPart.placement)) fail(`部件 ${rawPart.id} 的放置参数必须是对象`);
        assertExactKeys(rawPart.placement, ["translate", "rotateDeg"], "部件放置编辑");
        let placementChanged = false;
        for (const key of ["translate", "rotateDeg"] as const) {
          if (rawPart.placement[key] === undefined) continue;
          const value = point3(rawPart.placement[key], `${rawPart.id}.${key}`);
          if (!sameValue(value, originalPart.placement[key])) {
            placementChanged = true;
            changedFields.push(`${rawPart.id}.${key}`);
          }
          part.placement[key] = value;
        }
        if (placementChanged) {
          for (const feature of part.features) {
            feature.requirementRefs = [...new Set([...feature.requirementRefs, "req_model_input"])].sort();
          }
        }
      }
      if (rawPart.features !== undefined) {
        if (!Array.isArray(rawPart.features)) fail(`部件 ${rawPart.id} 的特征修改必须是数组`);
        const seenFeatures = new Set<string>();
        for (const rawFeature of rawPart.features) {
          if (!isRecord(rawFeature)) fail("特征修改项必须是对象");
          assertExactKeys(rawFeature, ["id", "origin", "distance", "profile"], "特征编辑");
          if (typeof rawFeature.id !== "string" || seenFeatures.has(rawFeature.id)) fail("特征 ID 无效或重复");
          seenFeatures.add(rawFeature.id);
          const featureIndex = part.features.findIndex((feature) => feature.id === rawFeature.id);
          if (featureIndex < 0) fail(`部件 ${rawPart.id} 不存在特征 ${rawFeature.id}`);
          const feature = part.features[featureIndex];
          const originalFeature = originalPart.features.find((item) => item.id === rawFeature.id)!;
          let geometryChanged = false;
          if (rawFeature.origin !== undefined) {
            const value = point3(rawFeature.origin, `${rawPart.id}.${rawFeature.id}.origin`);
            geometryChanged ||= !sameValue(value, originalFeature.origin);
            feature.origin = value;
          }
          if (rawFeature.distance !== undefined) {
            const value = numberValue(rawFeature.distance, `${rawPart.id}.${rawFeature.id}.distance`);
            geometryChanged ||= value !== originalFeature.distance;
            feature.distance = value;
          }
          if (rawFeature.profile !== undefined) {
            if (!isRecord(rawFeature.profile)) fail("轮廓修改必须是对象");
            if (!sameValue(profileTopology(rawFeature.profile), profileTopology(originalFeature.profile))) {
              fail(`特征 ${rawFeature.id} 只能修改现有轮廓数值，不能改变轮廓拓扑`);
            }
            geometryChanged ||= !sameValue(rawFeature.profile, originalFeature.profile);
            feature.profile = clone(rawFeature.profile) as Text2CadProfileSet;
          }
          if (geometryChanged) {
            changedFields.push(`${rawPart.id}.${rawFeature.id}`);
            feature.requirementRefs = [...new Set([...feature.requirementRefs, "req_model_input"])].sort();
          }
        }
      }
    }
  }

  const referenced = new Set(
    next.parts.flatMap((part) => part.features.flatMap((feature) => feature.requirementRefs))
  );
  const safe = normalizeText2CadDesignSpec({
    schemaVersion: 2,
    engine: "text2cad",
    unit: "mm",
    name: next.name,
    process: current.process,
    requirements: current.requirements.filter((requirement) => (
      requirement.id !== "req_model_input" && referenced.has(requirement.id)
    )),
    assumptions: current.assumptions,
    parts: next.parts,
  });
  const nextContent = canonicalText2CadDesignJson(safe);
  const currentContent = canonicalText2CadDesignJson(current);
  return {
    schemaVersion: 2,
    spec: safe,
    content: nextContent,
    hash: jsonHash(nextContent),
    title: safe.name,
    changedFields: [...new Set(changedFields)].slice(0, 64),
    unchanged: nextContent === currentContent,
  };
}

export function prepareCadRevision(content: string, patch: unknown): PreparedCadRevision {
  assertPatchSize(patch);
  const raw = rawSpec(content);
  if (raw.schemaVersion === 1) return mergeV1(content, patch);
  if (raw.schemaVersion === 2 && raw.engine === "text2cad") return mergeV2(content, patch);
  fail("当前 CAD 规格暂不支持在线参数编辑");
}

export async function renderPreparedCadRevision(
  prepared: PreparedCadRevision,
  signal?: AbortSignal,
  hooks?: { onGeometryBuilt?: () => Promise<void>; onStepValidation?: () => Promise<void> }
): Promise<RenderedCadRevision> {
  if (prepared.schemaVersion === 1) return renderCadSpec(prepared.spec, signal, hooks);
  return renderText2CadSpec(prepared.spec, signal, hooks);
}
