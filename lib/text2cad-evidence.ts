import { classifyCadTemplateInstruction, type CadTemplate } from "./cad-library";
import type { LabeledCadCorpus } from "./cad-source-corpus";
import {
  canonicalCadObjectLabel,
  extractGenericCadObjectLabels,
  normalizeCadIntentText,
} from "./cad-object-intent";
import {
  assertText2CadInstructionCoverage,
  type Text2CadFeature,
  type Text2CadSpec,
} from "./text2cad-spec";
import { getCadObjectContract, type CadObjectId } from "./cad-object-contracts";
import { cadPrimaryObjectIdsForText, cadTargetEvidenceText } from "./cad-request-plan";

type EvidenceOptions = {
  sourceDrivenDefault?: boolean;
  tutorialExample?: boolean;
  validateSourceObjectIntent?: boolean;
  /** 用户在免费预检中是否明确允许设计假设。false 时必须 fail closed。 */
  allowAssumptions?: boolean;
  /** 描述驱动只允许 prompt 成为几何权威，不得借用勾选来源的尺寸。 */
  promptDriven?: boolean;
  /** generator 已直接消费 plan 复核后的 targetEvidence，无需再切分片段。 */
  sourceEvidenceAlreadyTargetScoped?: boolean;
  /** v3 已由免费预检冻结的稳定对象 ID，高于来源全文中的其他对象词。 */
  targetObjectId?: CadObjectId;
};

/**
 * 把免费预检中已冻结的 prompt 约束连到每个几何特征。
 *
 * 这个纯函数只补证据边，不修改任何几何数值。后续仍由
 * assertText2CadEvidenceContract 逐项验证数值是否在 prompt 中出现、
 * 能否作确定性算术，或是否被明确标为设计假设。
 */
export function bindFrozenPromptRequirement(raw: unknown, enabled: boolean): unknown {
  if (!enabled || !raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const candidate = { ...(raw as Record<string, unknown>) };
  const requirements = Array.isArray(candidate.requirements) ? [...candidate.requirements] : [];
  let id = "req_prompt_constraints";
  const existingIds = new Set(requirements.flatMap((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { id?: unknown }).id === "string"
      ? [String((entry as { id: string }).id)]
      : []
  )));
  let suffix = 2;
  while (existingIds.has(id)) id = `req_prompt_constraints_${suffix++}`;
  requirements.push({
    id,
    text: "用户在预检中冻结的对象、尺寸与结构约束",
    sourceRefs: ["prompt:1"],
    acceptance: "所有设计数值均能由明确输入或确定性算术推导",
  });
  const parts = Array.isArray(candidate.parts) ? candidate.parts.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const copy = { ...(part as Record<string, unknown>) };
    if (!Array.isArray(copy.features)) return copy;
    copy.features = copy.features.map((feature) => {
      if (!feature || typeof feature !== "object" || Array.isArray(feature)) return feature;
      const next = { ...(feature as Record<string, unknown>) };
      const refs = Array.isArray(next.requirementRefs)
        ? next.requirementRefs.filter((ref): ref is string => typeof ref === "string")
        : [];
      next.requirementRefs = [...new Set([...refs, id])];
      return next;
    });
    return copy;
  }) : candidate.parts;
  candidate.requirements = requirements;
  candidate.parts = parts;
  return candidate;
}

type FeatureNumberRole = "dimension" | "radius" | "coordinate";
type FeatureNumberClaim = Readonly<{ value: number; role: FeatureNumberRole }>;

function featureNumberClaims(feature: Text2CadFeature): FeatureNumberClaim[] {
  const claims: FeatureNumberClaim[] = [];
  const add = (value: number, role: FeatureNumberRole) => {
    if (Number.isFinite(value)) claims.push({ value, role });
  };
  feature.origin.forEach((value) => add(value, "coordinate"));
  const visitProfile = (profile: Text2CadFeature["profile"]["outer"]) => {
    if (profile.kind === "rectangle") {
      profile.center.forEach((value) => add(value, "coordinate"));
      add(profile.width, "dimension");
      add(profile.height, "dimension");
      add(profile.cornerRadius, "radius");
    } else if (profile.kind === "circle") {
      profile.center.forEach((value) => add(value, "coordinate"));
      add(profile.radius, "radius");
    } else if (profile.kind === "polygon") {
      profile.points.flat().forEach((value) => add(value, "coordinate"));
    } else {
      profile.segments.forEach((segment) => {
        segment.start.forEach((value) => add(value, "coordinate"));
        segment.end.forEach((value) => add(value, "coordinate"));
        if (segment.kind === "arc") segment.mid.forEach((value) => add(value, "coordinate"));
      });
    }
  };
  visitProfile(feature.profile.outer);
  feature.profile.holes.forEach(visitProfile);
  add(feature.distance, "dimension");
  return claims;
}

function unitNumber(raw: string, unitRaw = ""): number {
  const amount = Number(raw);
  const unit = unitRaw.toLowerCase();
  if (unit === "cm" || unit === "厘米") return amount * 10;
  if (unit === "m" || unit === "米") return amount * 1_000;
  if (unit === "in" || unit === "英寸") return amount * 25.4;
  return amount;
}

function valueMentioned(value: number, evidence: string, role: FeatureNumberRole): boolean {
  if (value === 0) return true;
  const text = String(Object.is(value, -0) ? 0 : value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalized = evidence.normalize("NFKC");
  if (new RegExp(`(^|[^\\d.])${text}(?![\\d.])`).test(normalized)) return true;
  // 只允许从用户明确数值做有界、可重现的小学算术：半径=直径/2、
  // 中心=总尺寸/2、另一边孔位=总尺寸-边距。不允许任意公式或宽容差洗白臆造值。
  const numbers = [...normalized.matchAll(/(^|[^\d.])(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米|in|英寸)?/giu)]
    .slice(0, 32)
    .map((match) => unitNumber(match[2], match[3] ?? "mm"))
    .filter((number) => Number.isFinite(number));
  if (role === "dimension") return false;
  const derived = new Set<number>();
  const add = (number: number) => {
    if (Number.isFinite(number) && Math.abs(number) <= 12_000) derived.add(Math.round(number * 1_000) / 1_000);
  };
  if (role === "radius") {
    const diameterNumbers = [
      ...normalized.matchAll(/(?:孔径|直径|外径|内径|diameter|bore)\s*(?:为|是|约|=|:|：)?\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米|in|英寸)?/giu),
      ...normalized.matchAll(/(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米|in|英寸)?\s*(?:孔径|直径|外径|内径|diameter|bore)/giu),
    ].map((match) => unitNumber(match[1], match[2] ?? "mm"));
    diameterNumbers.forEach((number) => add(number / 2));
  } else {
    numbers.forEach((number) => add(number / 2));
    if (/(?:孔边距|边距|边距|边缘距离|margin|edge\s*offset)/i.test(normalized)) {
      for (let left = 0; left < numbers.length; left++) {
        for (let right = 0; right < numbers.length; right++) {
          if (left === right) continue;
          add(numbers[left] - numbers[right]);
          add(numbers[left] / 2 - numbers[right]);
        }
      }
    }
  }
  const expected = Math.round(value * 1_000) / 1_000;
  // 坐标原点在中心时，同一个孔位推导值会以 ±d 成对出现。
  // 只放行已确定推导出的值的符号镜像，不引入新的尺寸或容差。
  return derived.has(expected) || derived.has(-expected);
}

type DimensionConstraint = {
  kind: "overall" | "holeSpacing" | "featureProfile" | "width" | "height" | "thickness" | "length" | "depth" | "holeDiameter" | "diameter" | "radius";
  values: number[];
  globalScope?: boolean;
  operation?: "add" | "cut";
};

function toMillimeters(raw: string, unitRaw = ""): number {
  const amount = Number(raw);
  const unit = unitRaw.toLowerCase();
  if (unit === "cm" || unit === "厘米") return amount * 10;
  if (unit === "m" || unit === "米") return amount * 1_000;
  if (unit === "in" || unit === "inch" || unit === "inches" || unit === "英寸") return amount * 25.4;
  return amount;
}

function explicitDimensionConstraints(value: string): DimensionConstraint[] {
  const text = value.normalize("NFKC");
  const constraints: DimensionConstraint[] = [];
  for (const match of text.matchAll(
    /(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)(?:\s*[×xX*]\s*(\d+(?:\.\d+)?))?\s*(mm|毫米|cm|厘米|m|米|inches|inch|in|英寸)?/gi
  )) {
    const unit = match[4] ?? "";
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 20), match.index ?? 0);
    const holeSpacing = /(?:孔距|孔间距|孔位|开孔区域|孔阵列|阵列)\s*(?:为|是|约|=|:|：)?\s*$/.test(prefix);
    const cutProfile = /(?:槽|开口|窗口|矩形孔|凹槽|切口)\s*(?:尺寸)?\s*(?:为|是|约|=|:|：)?\s*$/.test(prefix);
    const addProfile = /(?:凸台|加强台|凸起)\s*(?:尺寸)?\s*(?:为|是|约|=|:|：)?\s*$/.test(prefix);
    const values = match.slice(1, 4).filter(Boolean).map((item) => toMillimeters(item, unit));
    const globalScope = /(?:整体|总体|外形|整车|整机|总)尺寸\s*(?:为|是|约|=|:|：)?\s*$/.test(prefix);
    const kind: DimensionConstraint["kind"] | null = holeSpacing
      ? "holeSpacing"
      : cutProfile || addProfile
        ? "featureProfile"
        : globalScope || values.length === 3
          ? "overall"
          : null;
    if (!kind) continue;
    constraints.push({
      kind,
      values,
      globalScope,
      operation: cutProfile ? "cut" : addProfile ? "add" : undefined,
    });
  }
  for (const match of text.matchAll(
    /(长度|长|宽度|宽|高度|高|深度|深|厚度|厚|孔径|直径|半径)\s*(?:为|是|约|=|:|：)?\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米|inches|inch|in|英寸)?/gi
  )) {
    const keyword = match[1];
    const kind: DimensionConstraint["kind"] = /孔径/.test(keyword)
      ? "holeDiameter"
      : /直径/.test(keyword)
        ? "diameter"
        : /半径/.test(keyword)
          ? "radius"
          : /厚/.test(keyword)
            ? "thickness"
            : /深/.test(keyword)
              ? "depth"
              : /高/.test(keyword)
                ? "height"
                : /宽/.test(keyword)
                  ? "width"
                  : "length";
    constraints.push({ kind, values: [toMillimeters(match[2], match[3] ?? "")] });
  }
  return constraints.filter((constraint) => constraint.values.every((item) => Number.isFinite(item) && item > 0));
}

function explicitGlobalAxisConstraints(value: string): DimensionConstraint[] {
  const text = value.normalize("NFKC");
  const constraints: DimensionConstraint[] = [];
  for (const match of text.matchAll(
    /(?:整体|总体|外形|整车|整机|车|机身|身)(长度|长|宽度|宽|高度|高|深度|深)\s*(?:为|是|约|=|:|：)?\s*(\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米|m|米|inches|inch|in|英寸)?/gi
  )) {
    const kind: DimensionConstraint["kind"] = /高/.test(match[1])
      ? "height"
      : /宽|深/.test(match[1])
        ? "width"
        : "length";
    constraints.push({ kind, values: [toMillimeters(match[2], match[3] ?? "")], globalScope: true });
  }
  return constraints;
}

function profileDimensions(feature: Text2CadFeature): number[] {
  const outer = feature.profile.outer;
  if (outer.kind === "rectangle") return [outer.width, outer.height, feature.distance];
  if (outer.kind === "circle" && "radius" in outer) return [outer.radius * 2, outer.radius * 2, feature.distance];
  {
    const points = outer.kind === "polygon"
      ? outer.points
      : outer.segments.flatMap((segment) => [segment.start, segment.end]);
    if (points.length) {
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), feature.distance];
    }
  }
  return [feature.distance];
}

const dimensionEquals = (actual: number, expected: number) => Math.abs(actual - expected) <= 0.001;

function constraintSatisfied(features: Text2CadFeature[], constraint: DimensionConstraint): boolean {
  if (constraint.kind === "featureProfile") {
    return features.some((feature) => (
      (!constraint.operation || feature.operation === constraint.operation)
      && constraint.values.every((expected, axis) => dimensionEquals(profileDimensions(feature)[axis] ?? NaN, expected))
    ));
  }
  if (constraint.kind === "holeSpacing") {
    const centers = features.flatMap((feature) => {
      const profileCenters = feature.profile.holes.flatMap((hole) => (
        "center" in hole ? [hole.center] : []
      ));
      const outer = feature.profile.outer;
      if (feature.operation === "cut" && outer.kind === "circle" && "center" in outer) {
        profileCenters.push(outer.center);
      }
      return profileCenters;
    });
    if (centers.length < 2) return false;
    const spans = [0, 1].map((axis) => (
      Math.max(...centers.map((center) => center[axis])) - Math.min(...centers.map((center) => center[axis]))
    ));
    return constraint.values.every((expected, axis) => dimensionEquals(spans[axis] ?? NaN, expected));
  }
  if (constraint.kind === "overall") {
    return features.some((feature) => {
      if (feature.operation !== "new") return false;
      const dimensions = profileDimensions(feature);
      return constraint.values.every((expected, index) => dimensionEquals(dimensions[index] ?? NaN, expected));
    });
  }
  const expected = constraint.values[0];
  return features.some((feature) => {
    const dimensions = profileDimensions(feature);
    if (constraint.kind === "width" || constraint.kind === "length") return dimensionEquals(dimensions[0] ?? NaN, expected);
    if (constraint.kind === "height") return dimensionEquals(dimensions[1] ?? NaN, expected);
    if (constraint.kind === "thickness" || constraint.kind === "depth") return dimensionEquals(feature.distance, expected);
    const outer = feature.profile.outer;
    const outerRadii = outer.kind === "circle" && "radius" in outer
      ? [Number((outer as { radius: number }).radius)]
      : [];
    const holeRadii = feature.profile.holes.flatMap((hole) => (
      hole.kind === "circle" && "radius" in hole ? [Number((hole as { radius: number }).radius)] : []
    ));
    if (constraint.kind === "radius") return [...outerRadii, ...holeRadii].some((radius) => dimensionEquals(radius, expected));
    const diameters = (constraint.kind === "holeDiameter" ? holeRadii : [...outerRadii, ...holeRadii])
      .map((radius) => radius * 2);
    return diameters.some((diameter) => dimensionEquals(diameter, expected));
  });
}

function semanticNames(spec: Text2CadSpec): string {
  return [spec.name, ...spec.parts.map((part) => part.name)].join(" ");
}

function hasOuterKind(spec: Text2CadSpec, kinds: string[]): boolean {
  return spec.parts.some((part) => part.features.some((feature) => (
    kinds.includes(feature.profile.outer.kind)
  )));
}

function hasCircularPart(spec: Text2CadSpec, namePattern?: RegExp): number {
  return spec.parts.filter((part) => (
    (!namePattern || namePattern.test(part.name))
    && part.features.some((feature) => feature.profile.outer.kind === "circle")
  )).length;
}

function hasCavity(spec: Text2CadSpec): boolean {
  return spec.parts.length >= 4 || spec.parts.some((part) => part.features.some((feature) => (
    feature.operation === "cut" || feature.profile.holes.length > 0
  )));
}

function objectContractSatisfied(spec: Text2CadSpec, template: CadTemplate): boolean {
  const names = semanticNames(spec);
  const planes = new Set(spec.parts.flatMap((part) => part.features.map((feature) => feature.plane)));
  switch (template) {
    case "concept_car":
      return /汽车|车辆|车身|car|vehicle/i.test(names)
        && hasCircularPart(spec, /轮|wheel/i) >= 4
        && spec.parts.some((part) => !/轮|wheel/i.test(part.name));
    case "humanoid_robot":
      return spec.parts.length >= 7
        && /头|head/i.test(names)
        && /躯干|身体|torso|body/i.test(names)
        && /臂|手臂|arm/i.test(names)
        && /腿|leg/i.test(names);
    case "mounting_bracket":
      return /支架|托架|bracket/i.test(names) && (spec.parts.length >= 2 || planes.size >= 2);
    case "enclosure":
      return /外壳|壳体|机箱|enclosure|housing/i.test(names) && hasCavity(spec);
    case "flange":
      return /法兰|flange/i.test(names) && hasOuterKind(spec, ["circle"]) && hasCavity(spec);
    case "shaft_adapter":
      return /轴套|转接套|轴径|shaft|adapter/i.test(names) && hasOuterKind(spec, ["circle"]) && hasCavity(spec);
    case "plate":
      return /安装板|安装平板|底板|plate/i.test(names) && hasOuterKind(spec, ["rectangle", "polygon", "path"]);
  }
}

const ROLE_PATTERNS: Record<CadObjectId, Record<string, RegExp>> = {
  robotic_arm: {
    base: /底座|base/i,
    shoulder: /肩|shoulder/i,
    upper_arm: /上臂|upper\s*arm/i,
    forearm: /前臂|forearm/i,
    wrist: /腕|wrist/i,
  },
  humanoid_robot: {
    head: /头|head/i,
    torso: /躯干|身体|torso|body/i,
    left_arm: /左(?:臂|手臂)|left[^,;。]{0,12}arm/i,
    right_arm: /右(?:臂|手臂)|right[^,;。]{0,12}arm/i,
    left_leg: /左腿|left[^,;。]{0,12}leg/i,
    right_leg: /右腿|right[^,;。]{0,12}leg/i,
  },
  concept_car: {
    body: /车身|body|chassis/i,
    front_left_wheel: /(?:左前|前左)(?:车)?轮|front[^,;。]{0,12}left[^,;。]{0,12}wheel|left[^,;。]{0,12}front[^,;。]{0,12}wheel/i,
    front_right_wheel: /(?:右前|前右)(?:车)?轮|front[^,;。]{0,12}right[^,;。]{0,12}wheel|right[^,;。]{0,12}front[^,;。]{0,12}wheel/i,
    rear_left_wheel: /(?:左后|后左)(?:车)?轮|rear[^,;。]{0,12}left[^,;。]{0,12}wheel|left[^,;。]{0,12}rear[^,;。]{0,12}wheel/i,
    rear_right_wheel: /(?:右后|后右)(?:车)?轮|rear[^,;。]{0,12}right[^,;。]{0,12}wheel|right[^,;。]{0,12}rear[^,;。]{0,12}wheel/i,
  },
  mounting_bracket: { bracket: /安装支架|托架|bracket/i },
  enclosure: { housing: /外壳|壳体|机箱|housing|enclosure/i },
  flange: { flange: /法兰|flange/i },
  shaft_adapter: { adapter: /轴径转接套|轴套|转接套|shaft\s*(?:adapter|sleeve)|adapter/i },
  plate: { plate: /安装板|安装平板|底板|plate/i },
};

function stableObjectContractSatisfied(spec: Text2CadSpec, objectId: CadObjectId): boolean {
  const contract = getCadObjectContract(objectId);
  if (spec.parts.length < contract.minParts || spec.parts.length > contract.maxParts) return false;
  if (contract.artifactMode === "single_part" && spec.parts.length !== 1) return false;
  const patterns = ROLE_PATTERNS[objectId];
  // 角色必须一对一绑定不同部件。否则一个叫“底座肩部上臂前臂腕部”的零件
  // 就能伪装整套机械臂。用小规模二分图回溯完成独占匹配。
  const candidates = contract.requiredPartRoles.map((role) => ({
    role,
    indexes: spec.parts.flatMap((part, index) => patterns[role]?.test(part.name) ? [index] : []),
  })).sort((left, right) => left.indexes.length - right.indexes.length);
  const assignDistinct = (position: number, used: Set<number>): boolean => {
    if (position >= candidates.length) return true;
    for (const index of candidates[position].indexes) {
      if (used.has(index)) continue;
      used.add(index);
      if (assignDistinct(position + 1, used)) return true;
      used.delete(index);
    }
    return false;
  };
  if (candidates.some((candidate) => candidate.indexes.length === 0) || !assignDistinct(0, new Set())) return false;
  // 角色合同通过后仍保留旧几何语义门（腔体、圆形、多平面等）。
  return objectId === "robotic_arm"
    ? /机械臂|机械手臂|机器人手臂|robot(?:ic)?\s*arm|manipulator/i.test(semanticNames(spec))
    : objectContractSatisfied(spec, objectId as Exclude<CadObjectId, "robotic_arm">);
}

export function assertText2CadStableObjectContract(spec: Text2CadSpec, objectId: CadObjectId): void {
  if (!stableObjectContractSatisfied(spec, objectId)) {
    throw new Error(`Text2CAD 输出没有覆盖预检建模对象 ${objectId}`);
  }
}

function classifiedTemplates(text: string): Set<CadTemplate> {
  const { normalized, compact } = normalizeCadIntentText(text);
  const templates = new Set<CadTemplate>();
  for (const candidate of [normalized, compact]) {
    const result = classifyCadTemplateInstruction(candidate);
    if (result.status === "matched") templates.add(result.template);
    else if (result.status === "ambiguous") result.templates.forEach((template) => templates.add(template));
  }
  return templates;
}

function assertObjectTemplates(spec: Text2CadSpec, templates: Set<CadTemplate>): void {
  if (templates.size > 1) throw new Error(`Text2CAD 建模对象存在冲突:${[...templates].join(",")}`);
  const template = [...templates][0];
  if (template && !objectContractSatisfied(spec, template)) {
    throw new Error(`Text2CAD 输出没有覆盖明确建模对象 ${template}`);
  }
}

function assertGenericObjectLabels(spec: Text2CadSpec, labels: Set<string>): void {
  if (labels.size > 1) throw new Error(`Text2CAD 建模对象存在冲突:${[...labels].join(",")}`);
  const label = [...labels][0];
  if (!label) return;
  const names = canonicalCadObjectLabel(semanticNames(spec));
  if (!names.includes(label) && !label.includes(names)) {
    throw new Error(`Text2CAD 输出没有覆盖明确建模对象 ${label}`);
  }
}

function collapseGenericLabels(values: Iterable<string>): Set<string> {
  const labels = [...values].sort((left, right) => left.length - right.length);
  const collapsed: string[] = [];
  for (const label of labels) {
    if (collapsed.some((existing) => label.includes(existing) || existing.includes(label))) continue;
    collapsed.push(label);
  }
  return new Set(collapsed);
}

function unknownGenericLabels(text: string): Set<string> {
  return collapseGenericLabels(
    extractGenericCadObjectLabels(text).filter((label) => classifiedTemplates(label).size === 0)
  );
}

function normalizeEngineeringMetadata(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s、,，。.;；:_-]+/g, "");
}

function explicitMetadataValues(
  text: string,
  kind: "material" | "process"
): string[] {
  const patterns = kind === "material"
    ? [
        /(?:材料|材质)\s*(?:为|是|采用|要求|=|:|：)\s*([^,，。；;\n]{1,48})/giu,
        /\bmaterial\s*(?:is|shall be|=|:)\s*([^,.;\n]{1,48})/giu,
      ]
    : [
        /(?:制造工艺|加工工艺|工艺)\s*(?:为|是|采用|要求|=|:|：)\s*([^,，。；;\n]{1,48})/giu,
        /\b(?:manufacturing\s+)?process\s*(?:is|shall be|=|:)\s*([^,.;\n]{1,48})/giu,
      ];
  return [...new Set(patterns.flatMap((pattern) => (
    [...text.matchAll(pattern)].map((match) => match[1].trim()).filter(Boolean)
  )))];
}

function metadataMatches(actual: string, expected: string): boolean {
  const left = normalizeEngineeringMetadata(actual);
  const right = normalizeEngineeringMetadata(expected);
  return !!left && !!right && (left === right || left.includes(right) || right.includes(left));
}

function assertCombinedObjectIntent(
  spec: Text2CadSpec,
  templates: Set<CadTemplate>,
  genericLabels: Set<string>
): void {
  const collapsedLabels = collapseGenericLabels(genericLabels);
  if (templates.size && collapsedLabels.size) {
    throw new Error(`Text2CAD 建模对象存在冲突:${[...templates, ...collapsedLabels].join(",")}`);
  }
  assertObjectTemplates(spec, templates);
  assertGenericObjectLabels(spec, collapsedLabels);
}

/** 阻止模型把明确对象偷换成另一种几何，例如把汽车请求发布成安装平板。 */
export function assertText2CadObjectIntentCoverage(spec: Text2CadSpec, instruction: string): void {
  assertCombinedObjectIntent(spec, classifiedTemplates(instruction), unknownGenericLabels(instruction));
}

/** 装配件在真实几何生成后，用最终包围盒校验来源里的整体/外形尺寸（X/Y/Z=长/宽/高）。 */
export function assertText2CadSourceBoundsCoverage(
  bounds: number[][],
  labeled: LabeledCadCorpus
): void {
  if (bounds.length !== 2 || bounds.some((point) => point.length !== 3)) {
    throw new Error("Text2CAD 最终包围盒格式无效");
  }
  const extents = bounds[1].map((value, axis) => value - bounds[0][axis]);
  for (const [ref, binding] of Object.entries(labeled.sourceReferenceBindings)) {
    const evidence = labeled.evidenceByRef[ref] ?? "";
    const hasObject = classifiedTemplates(binding.title).size > 0
      || classifiedTemplates(evidence).size > 0
      || unknownGenericLabels(binding.title).size > 0
      || unknownGenericLabels(evidence).size > 0;
    if (!hasObject) continue;
    const constraints = [
      ...explicitDimensionConstraints(evidence).filter((constraint) => (
        constraint.kind === "overall" && constraint.globalScope === true
      )),
      ...explicitGlobalAxisConstraints(evidence),
    ];
    for (const constraint of constraints) {
      let matches = true;
      if (constraint.kind === "overall") {
        matches = constraint.values.every((expected, axis) => dimensionEquals(extents[axis] ?? NaN, expected));
      } else if (constraint.kind === "length") matches = dimensionEquals(extents[0], constraint.values[0]);
      else if (constraint.kind === "width" || constraint.kind === "depth") matches = dimensionEquals(extents[1], constraint.values[0]);
      else if (constraint.kind === "height") matches = dimensionEquals(extents[2], constraint.values[0]);
      else continue;
      if (!matches) {
        throw new Error(`Text2CAD 最终包围盒未采用来源 ${ref} 的明确尺寸 ${constraint.values.join("×")}`);
      }
    }
  }
}

/**
 * 逐特征核对证据：某个数值只能由该特征实际引用的 prompt/source 证明；
 * 若未出现，必须让该特征直接引用 system:design-assumption，不能用全局无关假设放行。
 */
export function assertText2CadEvidenceContract(
  spec: Text2CadSpec,
  labeled: LabeledCadCorpus,
  instruction: string,
  options: EvidenceOptions = {}
): void {
  const allowedRefs = new Set([
    ...Object.keys(labeled.sourceReferenceMap),
    "prompt:1",
    "system:design-assumption",
    "model:input",
  ]);
  const unknownRef = spec.requirements
    .flatMap((requirement) => requirement.sourceRefs)
    .find((ref) => !allowedRefs.has(ref));
  if (unknownRef) throw new Error(`需求引用了本次上下文中不存在的来源 ${unknownRef}`);

  const hasDesignAssumptionRef = spec.requirements.some((requirement) => (
    requirement.sourceRefs.includes("system:design-assumption")
  ));
  if (options.allowAssumptions === false && (spec.assumptions.length > 0 || hasDesignAssumptionRef)) {
    throw new Error("本次预检未允许设计假设，Text2CAD 不得使用 system:design-assumption 或生成假设尺寸");
  }
  if (
    options.promptDriven
    && spec.requirements.some((requirement) => requirement.sourceRefs.some((ref) => /^source:[1-9][0-9]{0,5}$/.test(ref)))
  ) {
    throw new Error("描述驱动建模只能使用冻结的用户描述或明确设计假设，不得借用未绑定来源的尺寸作证");
  }
  const sourceEvidence = (ref: string): string => {
    const raw = labeled.evidenceByRef[ref] ?? "";
    if (
      !options.sourceEvidenceAlreadyTargetScoped
      && options.targetObjectId
      && (options.sourceDrivenDefault || options.validateSourceObjectIntent)
    ) {
      return cadTargetEvidenceText(
        labeled.sourceReferenceBindings[ref]?.title ?? "",
        raw,
        options.targetObjectId
      );
    }
    return raw;
  };
  const metadataEvidence = [
    ...(options.promptDriven ? [instruction] : []),
    ...(options.sourceDrivenDefault || options.validateSourceObjectIntent
      ? Object.keys(labeled.sourceReferenceBindings)
          .filter((ref) => /^source:[1-9][0-9]{0,5}$/.test(ref))
          .map(sourceEvidence)
      : []),
  ].join("\n");
  if (!options.tutorialExample && metadataEvidence) {
    const expectedMaterials = explicitMetadataValues(metadataEvidence, "material");
    const expectedProcesses = explicitMetadataValues(metadataEvidence, "process");
    if (expectedMaterials.length) {
      const mismatch = spec.parts.find((part) => (
        !expectedMaterials.some((expected) => metadataMatches(part.material, expected))
      ));
      if (mismatch) {
        throw new Error(
          `部件 ${mismatch.id} 的材料 ${mismatch.material} 未实现冻结材料约束 ${expectedMaterials.join("、")}`
        );
      }
    } else if (
      options.allowAssumptions === false
      && spec.parts.some((part) => normalizeEngineeringMetadata(part.material) !== "unspecified")
    ) {
      throw new Error("本次未允许设计假设，Text2CAD 不得自行指定材料");
    }
    if (expectedProcesses.length) {
      if (!expectedProcesses.some((expected) => metadataMatches(spec.process, expected))) {
        throw new Error(
          `Text2CAD 制造工艺 ${spec.process} 未实现冻结工艺约束 ${expectedProcesses.join("、")}`
        );
      }
    } else if (
      options.allowAssumptions === false
      && normalizeEngineeringMetadata(spec.process) !== "unspecified"
    ) {
      throw new Error("本次未允许设计假设，Text2CAD 不得自行指定制造工艺");
    }
  }

  // 教学示例的 instruction 是系统内部“按来源识别对象”目标，不是用户提交的
  // 几何要求。它仍需经过下方引用白名单、逐特征假设和“不得冒充来源”门禁，
  // 但不能把这句系统文案反向当成必须在四孔板中实现的建模对象。
  if (!options.tutorialExample) {
    assertText2CadInstructionCoverage(spec, instruction);
    if (options.targetObjectId) assertText2CadStableObjectContract(spec, options.targetObjectId);
    else assertText2CadObjectIntentCoverage(spec, instruction);
  }
  if ((options.sourceDrivenDefault || options.validateSourceObjectIntent) && !options.targetObjectId) {
    const templates = new Set<CadTemplate>();
    const genericLabels = new Set<string>();
    for (const [ref, binding] of Object.entries(labeled.sourceReferenceBindings)) {
      if (!/^source:[1-9][0-9]{0,5}$/.test(ref)) continue;
      for (const field of [binding.title, labeled.evidenceByRef[ref] ?? ""]) {
        classifiedTemplates(field).forEach((template) => templates.add(template));
        unknownGenericLabels(field).forEach((label) => genericLabels.add(label));
      }
    }
    assertCombinedObjectIntent(spec, templates, genericLabels);
  }

  if (
    options.sourceDrivenDefault
    && spec.requirements.some((requirement) => requirement.sourceRefs.includes("prompt:1"))
  ) {
    throw new Error("来源驱动默认目标不是用户输入，不得持久化为 prompt:1");
  }

  const requirements = new Map(spec.requirements.map((requirement) => [requirement.id, requirement]));
  let sourceBackedGeometry = false;
  const sourceGeometryFeatures = new Map<string, Text2CadFeature[]>();
  for (const part of spec.parts) {
    for (const feature of part.features) {
      const linked = feature.requirementRefs
        .map((ref) => requirements.get(ref))
        .filter((requirement): requirement is NonNullable<typeof requirement> => !!requirement);
      const refs = new Set(linked.flatMap((requirement) => requirement.sourceRefs));
      const sourceRefs = [...refs].filter((ref) => /^source:[1-9][0-9]{0,5}$/.test(ref));
      if (sourceRefs.length) {
        sourceBackedGeometry = true;
        for (const ref of sourceRefs) {
          if (options.targetObjectId && (options.sourceDrivenDefault || options.validateSourceObjectIntent)) {
            const binding = labeled.sourceReferenceBindings[ref];
            const stableIds = new Set(cadPrimaryObjectIdsForText(
              `${binding?.title ?? ""}\n${sourceEvidence(ref)}`
            ));
            if (
              stableIds.size > 0
              && (stableIds.size !== 1 || !stableIds.has(options.targetObjectId))
            ) {
              throw new Error(
                `来源 ${ref} 的几何证据与预检对象 ${options.targetObjectId} 不一致`
              );
            }
          }
          sourceGeometryFeatures.set(ref, [...(sourceGeometryFeatures.get(ref) ?? []), feature]);
        }
      }
      const evidence = [
        ...(refs.has("prompt:1") ? [instruction] : []),
        ...sourceRefs.map((ref) => sourceEvidence(ref)),
      ].join("\n");
      const usesAssumption = refs.has("system:design-assumption");
      const missing = featureNumberClaims(feature).find((claim) => (
        !valueMentioned(claim.value, evidence, claim.role)
      ));
      if (missing !== undefined && (!usesAssumption || !spec.assumptions.length)) {
        throw new Error(`特征 ${feature.id} 的数值 ${missing.value} 没有被其引用来源支持，也未直接追溯设计假设`);
      }
    }
  }

  if (options.sourceDrivenDefault || options.validateSourceObjectIntent) {
    if (!sourceBackedGeometry) {
      throw new Error("来源驱动模型至少需要一个几何特征追溯真实 source:N");
    }
  }

  if (options.validateSourceObjectIntent && spec.parts.length === 1) {
    for (const [ref, features] of sourceGeometryFeatures) {
      const binding = labeled.sourceReferenceBindings[ref];
      const evidence = sourceEvidence(ref);
      if (!binding) continue;
      const hasObject = classifiedTemplates(binding.title).size > 0
        || classifiedTemplates(evidence).size > 0
        || unknownGenericLabels(binding.title).size > 0
        || unknownGenericLabels(evidence).size > 0;
      if (!hasObject) continue;
      const missing = explicitDimensionConstraints(evidence).find((constraint) => (
        !constraintSatisfied(features, constraint)
      ));
      if (missing) {
        throw new Error(`Text2CAD 输出未采用来源 ${ref} 的明确尺寸 ${missing.values.join("×")}`);
      }
    }
  }

  if (options.tutorialExample && sourceBackedGeometry) {
    throw new Error("教学示例的几何不得冒充来源约束");
  }
}
