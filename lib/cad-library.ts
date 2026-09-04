/**
 * CAD 模型库的零依赖合同真源。
 *
 * 这个模块可同时被服务端路由和客户端 Viewer 导入，因此不得引入
 * node:* 或 server-only。几何工人有一份运行时白名单，测试必须校验两者全等。
 */

export const CAD_LIBRARY_VERSION = 2 as const;
export const CAD_MANIFEST_VERSION = 2 as const;
const SUPPORTED_MANIFEST_VERSIONS: ReadonlySet<number> = new Set([2]);
export const TEXT2CAD_TEMPLATE = "text2cad" as const;

export const CAD_TEMPLATES = [
  "mounting_bracket",
  "enclosure",
  "flange",
  "shaft_adapter",
  "plate",
  "humanoid_robot",
  "concept_car",
] as const;
export type CadTemplate = (typeof CAD_TEMPLATES)[number];
export type CadArtifactTemplate = CadTemplate | typeof TEXT2CAD_TEMPLATE;

export type CadArtifactMode = "single_part" | "assembly";

export type CadTemplateContract = Readonly<{ artifactMode: CadArtifactMode; partCount: number }>;

/** v1 已发布字面量快照；不得改成由“当前”表动态派生。 */
const LIBRARY_V1_CONTRACTS: Readonly<Record<CadTemplate, CadTemplateContract>> = Object.freeze({
  mounting_bracket: Object.freeze({ artifactMode: "single_part", partCount: 1 }),
  enclosure: Object.freeze({ artifactMode: "single_part", partCount: 1 }),
  flange: Object.freeze({ artifactMode: "single_part", partCount: 1 }),
  shaft_adapter: Object.freeze({ artifactMode: "single_part", partCount: 1 }),
  plate: Object.freeze({ artifactMode: "single_part", partCount: 1 }),
  humanoid_robot: Object.freeze({ artifactMode: "assembly", partCount: 16 }),
  concept_car: Object.freeze({ artifactMode: "assembly", partCount: 5 }),
});

/** v2 保留全部 v1 固定模板，新增动态 Text2CAD 命令序列能力。 */
const LIBRARY_V2_CONTRACTS: Readonly<Record<CadTemplate, CadTemplateContract>> = Object.freeze({
  mounting_bracket: Object.freeze({ artifactMode: "single_part", partCount: 1 }),
  enclosure: Object.freeze({ artifactMode: "single_part", partCount: 1 }),
  flange: Object.freeze({ artifactMode: "single_part", partCount: 1 }),
  shaft_adapter: Object.freeze({ artifactMode: "single_part", partCount: 1 }),
  plate: Object.freeze({ artifactMode: "single_part", partCount: 1 }),
  humanoid_robot: Object.freeze({ artifactMode: "assembly", partCount: 16 }),
  concept_car: Object.freeze({ artifactMode: "assembly", partCount: 5 }),
});

const CURRENT_LIBRARY_CONTRACTS = LIBRARY_V2_CONTRACTS;

export const CAD_TEMPLATE_EXPECTED_SOLID_COUNT: Readonly<Record<CadTemplate, number>> = Object.freeze(
  Object.fromEntries(CAD_TEMPLATES.map((template) => [template, CURRENT_LIBRARY_CONTRACTS[template].partCount]))
) as Readonly<Record<CadTemplate, number>>;

export const CAD_TEMPLATE_ARTIFACT_MODE: Readonly<Record<CadTemplate, CadArtifactMode>> = Object.freeze(
  Object.fromEntries(CAD_TEMPLATES.map((template) => [template, CURRENT_LIBRARY_CONTRACTS[template].artifactMode]))
) as Readonly<Record<CadTemplate, CadArtifactMode>>;

/**
 * 已发布的 libraryVersion 合同不得原地修改或删除。未来升级时追加新键，
 * 下载路由仍能校验旧制品，不会因当前模型库升级将其误判为 409。
 */
export const CAD_LIBRARY_CONTRACTS_BY_VERSION: Readonly<
  Record<number, Readonly<Partial<Record<CadTemplate, CadTemplateContract>>>>
> = Object.freeze({ 1: LIBRARY_V1_CONTRACTS, 2: LIBRARY_V2_CONTRACTS });

const TEXT2CAD_LIBRARY_VERSIONS: ReadonlySet<number> = new Set([2]);

const LEGACY_SINGLE_PART_TEMPLATES: ReadonlySet<string> = new Set([
  "mounting_bracket",
  "enclosure",
  "flange",
  "shaft_adapter",
  "plate",
]);
const CONTRACT_FIELDS = ["manifestVersion", "libraryVersion", "artifactMode", "partCount"] as const;

const CAD_TEMPLATE_KEYWORDS: ReadonlyArray<{ template: CadTemplate; pattern: RegExp }> = [
  { template: "humanoid_robot", pattern: /人形(?:机器人)?|机器人|humanoid(?:\s+robot)?/i },
  { template: "concept_car", pattern: /汽车|轿车|乘用车|车辆|概念车|车身|轴距|automobile|vehicle|concept\s*car|\bcar\b/i },
  { template: "mounting_bracket", pattern: /安装支架|托架|bracket/i },
  { template: "enclosure", pattern: /设备外壳|壳体|机箱|enclosure/i },
  { template: "flange", pattern: /法兰|flange/i },
  { template: "shaft_adapter", pattern: /轴径转接套|轴套|转接套|shaft\s*adapter/i },
  { template: "plate", pattern: /安装平板|底板|mounting\s*plate/i },
];

export type CadTemplateClassification =
  | { status: "matched"; template: CadTemplate }
  | { status: "ambiguous"; templates: CadTemplate[] }
  | { status: "none" };

/** 对象词唯一命中时锁定模板；多类冲突显式返回 ambiguous，不允许后续流程猜一个。 */
export function classifyCadTemplateInstruction(instruction: string): CadTemplateClassification {
  const matches = CAD_TEMPLATE_KEYWORDS
    .filter(({ pattern }) => pattern.test(instruction))
    .map(({ template }) => template);
  if (matches.length === 1) return { status: "matched", template: matches[0] };
  if (matches.length > 1) return { status: "ambiguous", templates: matches };
  return { status: "none" };
}

export function inferCadTemplateFromInstruction(instruction: string): CadTemplate | undefined {
  const result = classifyCadTemplateInstruction(instruction);
  return result.status === "matched" ? result.template : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export type ResolvedCadArtifactContract = {
  template: CadArtifactTemplate;
  manifestVersion: number;
  libraryVersion: number;
  artifactMode: CadArtifactMode;
  partCount: number;
  legacy: boolean;
};

/**
 * 三方合同校验的唯一实现：文件包清单 + DB 冻结快照 + 不可变模型库版本。
 * 旧五种单零件只在双方四个字段都完整缺失时兼容；任何半新半旧均拒绝。
 */
export function resolveCadArtifactContract(
  templateValue: unknown,
  manifestValue: unknown,
  frozenValue: unknown
): ResolvedCadArtifactContract | null {
  if (
    typeof templateValue !== "string"
    || (!(CAD_TEMPLATES as readonly string[]).includes(templateValue) && templateValue !== TEXT2CAD_TEMPLATE)
  ) {
    return null;
  }
  if (!isRecord(manifestValue) || !isRecord(frozenValue)) return null;
  const template = templateValue as CadArtifactTemplate;
  const manifestPresence = CONTRACT_FIELDS.map((key) => hasOwn(manifestValue, key));
  const frozenPresence = CONTRACT_FIELDS.map((key) => hasOwn(frozenValue, key));
  const allPresence = [...manifestPresence, ...frozenPresence];
  const validation = isRecord(manifestValue.validation) ? manifestValue.validation : {};

  if (template === TEXT2CAD_TEMPLATE) {
    if (!allPresence.every(Boolean)) return null;
    const manifestVersion = Number(manifestValue.manifestVersion);
    const libraryVersion = Number(manifestValue.libraryVersion);
    const partCount = Number(manifestValue.partCount);
    const artifactMode = partCount === 1 ? "single_part" : "assembly";
    if (
      !SUPPORTED_MANIFEST_VERSIONS.has(manifestVersion)
      || Number(frozenValue.manifestVersion) !== manifestVersion
      || !TEXT2CAD_LIBRARY_VERSIONS.has(libraryVersion)
      || Number(frozenValue.libraryVersion) !== libraryVersion
      || !Number.isInteger(partCount)
      || partCount < 1
      || partCount > 24
      || Number(frozenValue.partCount) !== partCount
      || manifestValue.artifactMode !== artifactMode
      || frozenValue.artifactMode !== artifactMode
      || validation.brepValid !== true
      || Number(validation.solidCount) !== partCount
      || typeof manifestValue.partsHash !== "string"
      || !/^[a-f0-9]{64}$/.test(manifestValue.partsHash)
      || frozenValue.partsHash !== manifestValue.partsHash
    ) return null;
    return {
      template,
      manifestVersion,
      libraryVersion,
      artifactMode,
      partCount,
      legacy: false,
    };
  }

  const fixedTemplate = template as CadTemplate;

  if (allPresence.every((present) => !present)) {
    if (
      !LEGACY_SINGLE_PART_TEMPLATES.has(fixedTemplate)
      || validation.brepValid !== true
      || Number(validation.solidCount) !== 1
    ) return null;
    return {
      template: fixedTemplate,
      manifestVersion: 0,
      libraryVersion: 0,
      artifactMode: "single_part",
      partCount: 1,
      legacy: true,
    };
  }
  if (!allPresence.every(Boolean)) return null;

  const manifestVersion = Number(manifestValue.manifestVersion);
  const libraryVersion = Number(manifestValue.libraryVersion);
  if (
    !SUPPORTED_MANIFEST_VERSIONS.has(manifestVersion)
    || Number(frozenValue.manifestVersion) !== manifestVersion
    || !Number.isInteger(libraryVersion)
    || Number(frozenValue.libraryVersion) !== libraryVersion
  ) return null;
  const expected = CAD_LIBRARY_CONTRACTS_BY_VERSION[libraryVersion]?.[fixedTemplate];
  if (!expected) return null;
  if (
    manifestValue.artifactMode !== expected.artifactMode
    || frozenValue.artifactMode !== expected.artifactMode
    || Number(manifestValue.partCount) !== expected.partCount
    || Number(frozenValue.partCount) !== expected.partCount
    || validation.brepValid !== true
    || Number(validation.solidCount) !== expected.partCount
  ) return null;

  return {
    template: fixedTemplate,
    manifestVersion,
    libraryVersion,
    artifactMode: expected.artifactMode,
    partCount: expected.partCount,
    legacy: false,
  };
}
