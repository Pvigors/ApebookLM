/** Versioned semantic object contracts for the CAD v3 admission layer. */
export const CAD_OBJECT_CONTRACT_VERSION = 1 as const;

export type CadArtifactModeV3 = "single_part" | "assembly";
export type CadFidelity = "parametric_part" | "concept_assembly";

export type CadObjectContract = Readonly<{
  version: typeof CAD_OBJECT_CONTRACT_VERSION;
  label: string;
  aliases: readonly string[];
  artifactMode: CadArtifactModeV3;
  fidelity: CadFidelity;
  fixedTemplate: string | null;
  minParts: number;
  maxParts: number;
  requiredPartRoles: readonly string[];
  supportedOperations: readonly ("extrude" | "boolean" | "placement")[];
  limitations: readonly string[];
}>;

export const CAD_OBJECT_CONTRACTS = {
  robotic_arm: {
    version: CAD_OBJECT_CONTRACT_VERSION,
    label: "机械臂",
    aliases: [
      "机械臂",
      "机械手臂",
      "机器人手臂",
      "机器人臂",
      "robot arm",
      "robotic arm",
      "articulated arm",
      "robotic manipulator",
      "manipulator arm",
    ],
    artifactMode: "assembly",
    fidelity: "concept_assembly",
    fixedTemplate: null,
    minParts: 5,
    maxParts: 8,
    requiredPartRoles: ["base", "shoulder", "upper_arm", "forearm", "wrist"],
    supportedOperations: ["extrude", "boolean", "placement"],
    limitations: ["仅生成概念参数化装配", "不包含运动学、驱动、线束与生产级关节设计"],
  },
  humanoid_robot: {
    version: CAD_OBJECT_CONTRACT_VERSION,
    label: "人形机器人",
    aliases: ["人形机器人", "仿人机器人", "humanoid", "humanoid robot"],
    artifactMode: "assembly",
    fidelity: "concept_assembly",
    fixedTemplate: "humanoid_robot",
    minParts: 7,
    maxParts: 24,
    requiredPartRoles: ["head", "torso", "left_arm", "right_arm", "left_leg", "right_leg"],
    supportedOperations: ["extrude", "boolean", "placement"],
    limitations: ["仅生成概念参数化装配", "不包含运动学、驱动与生产级关节设计"],
  },
  concept_car: {
    version: CAD_OBJECT_CONTRACT_VERSION,
    label: "概念汽车",
    aliases: ["概念汽车", "概念车", "汽车", "轿车", "乘用车", "concept car", "automobile", "vehicle"],
    artifactMode: "assembly",
    fidelity: "concept_assembly",
    fixedTemplate: "concept_car",
    minParts: 5,
    maxParts: 12,
    requiredPartRoles: ["body", "front_left_wheel", "front_right_wheel", "rear_left_wheel", "rear_right_wheel"],
    supportedOperations: ["extrude", "boolean", "placement"],
    limitations: ["仅生成概念参数化装配", "不包含生产级曲面、悬架、驱动与内饰"],
  },
  mounting_bracket: {
    version: CAD_OBJECT_CONTRACT_VERSION,
    label: "安装支架",
    aliases: ["安装支架", "安装托架", "托架", "mounting bracket"],
    artifactMode: "single_part",
    fidelity: "parametric_part",
    fixedTemplate: "mounting_bracket",
    minParts: 1,
    maxParts: 1,
    requiredPartRoles: ["bracket"],
    supportedOperations: ["extrude", "boolean"],
    limitations: ["不支持自由曲面和复杂折弯工艺"],
  },
  enclosure: {
    version: CAD_OBJECT_CONTRACT_VERSION,
    label: "设备外壳",
    aliases: ["电子设备外壳", "设备外壳", "外壳", "壳体", "机箱", "enclosure", "housing"],
    artifactMode: "single_part",
    fidelity: "parametric_part",
    fixedTemplate: "enclosure",
    minParts: 1,
    maxParts: 1,
    requiredPartRoles: ["housing"],
    supportedOperations: ["extrude", "boolean"],
    limitations: ["不支持自由曲面、卡扣和复杂拔模"],
  },
  flange: {
    version: CAD_OBJECT_CONTRACT_VERSION,
    label: "法兰",
    aliases: ["法兰", "flange"],
    artifactMode: "single_part",
    fidelity: "parametric_part",
    fixedTemplate: "flange",
    minParts: 1,
    maxParts: 1,
    requiredPartRoles: ["flange"],
    supportedOperations: ["extrude", "boolean"],
    limitations: ["不支持生产级密封面与标准公差自动选型"],
  },
  shaft_adapter: {
    version: CAD_OBJECT_CONTRACT_VERSION,
    label: "轴径转接套",
    aliases: ["轴径转接套", "轴套", "转接套", "shaft adapter", "shaft sleeve"],
    artifactMode: "single_part",
    fidelity: "parametric_part",
    fixedTemplate: "shaft_adapter",
    minParts: 1,
    maxParts: 1,
    requiredPartRoles: ["adapter"],
    supportedOperations: ["extrude", "boolean"],
    limitations: ["不支持真实螺纹齿形和公差配合自动计算"],
  },
  plate: {
    version: CAD_OBJECT_CONTRACT_VERSION,
    label: "安装板",
    aliases: ["四孔安装板", "安装平板", "安装板", "底板", "mounting plate"],
    artifactMode: "single_part",
    fidelity: "parametric_part",
    fixedTemplate: "plate",
    minParts: 1,
    maxParts: 1,
    requiredPartRoles: ["plate"],
    supportedOperations: ["extrude", "boolean"],
    limitations: ["不支持复杂曲面和多工序冲压仿真"],
  },
} as const satisfies Record<string, CadObjectContract>;

export type CadObjectId = keyof typeof CAD_OBJECT_CONTRACTS;
export type CadFixedTemplateV3 = Exclude<CadObjectId, "robotic_arm">;

export type CadObjectMention = Readonly<{
  objectId: CadObjectId;
  alias: string;
}>;

export function isCadObjectId(value: unknown): value is CadObjectId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CAD_OBJECT_CONTRACTS, value);
}

export function isCadFixedTemplateV3(value: unknown): value is CadFixedTemplateV3 {
  return isCadObjectId(value) && CAD_OBJECT_CONTRACTS[value].fixedTemplate === value;
}

export function getCadObjectContract(objectId: CadObjectId): CadObjectContract {
  return CAD_OBJECT_CONTRACTS[objectId];
}

const normalizeText = (value: string) => value
  .normalize("NFKC")
  .replace(/[\u200B-\u200D\uFEFF]/g, "")
  .toLocaleLowerCase("en-US");

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function containsAlias(text: string, alias: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedAlias = normalizeText(alias).trim();
  if (!normalizedAlias) return false;
  if (/^[a-z0-9 _-]+$/i.test(normalizedAlias)) {
    const words = normalizedAlias.split(/[\s_-]+/).filter(Boolean).map(escapeRegExp).join("[\\s_-]+");
    return new RegExp(`(^|[^a-z0-9])${words}(?=$|[^a-z0-9])`, "i").test(normalizedText);
  }
  const compactText = normalizedText.replace(/[\s·•_-]+/g, "");
  const compactAlias = normalizedAlias.replace(/[\s·•_-]+/g, "");
  return compactText.includes(compactAlias);
}

/**
 * Resolve only versioned, deliberately non-overlapping aliases. In particular,
 * generic "机器人" is not a humanoid alias, so "机器人手臂" resolves to
 * `robotic_arm` instead of conflicting with `humanoid_robot`.
 */
export function findCadObjectMentions(value: string): CadObjectMention[] {
  const mentions: CadObjectMention[] = [];
  for (const objectId of Object.keys(CAD_OBJECT_CONTRACTS) as CadObjectId[]) {
    const contract = CAD_OBJECT_CONTRACTS[objectId];
    const alias = contract.aliases.find((candidate) => containsAlias(value, candidate));
    if (alias) mentions.push({ objectId, alias });
  }
  return mentions;
}

export function findCadObjectIds(value: string): CadObjectId[] {
  return findCadObjectMentions(value).map((mention) => mention.objectId);
}
