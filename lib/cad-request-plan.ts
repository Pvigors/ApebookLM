import { createHash } from "node:crypto";
import {
  CadContractError,
  cadFailureDisposition,
  type CadErrorCode,
} from "./cad-errors";
import {
  CAD_OBJECT_CONTRACT_VERSION,
  findCadObjectMentions,
  findCadObjectIds,
  getCadObjectContract,
  isCadFixedTemplateV3,
  isCadObjectId,
  type CadArtifactModeV3,
  type CadFidelity,
  type CadFixedTemplateV3,
  type CadObjectId,
} from "./cad-object-contracts";
import {
  CadSpecValidationError,
  normalizeCadDesignSpec,
  type CadTemplate,
} from "./cad-spec";
import {
  MAX_CAD_SOURCE_BYTES,
  MAX_CAD_SOURCE_CHARS,
  MAX_CAD_SOURCE_COUNT,
} from "./cad-source-limits";

export const CAD_REQUEST_PLAN_VERSION = 3 as const;
export const CAD_REQUEST_PLAN_MODES = ["prompt_driven", "source_driven", "fixed_template"] as const;
export type CadRequestPlanMode = (typeof CAD_REQUEST_PLAN_MODES)[number];

export const CAD_REQUEST_PLAN_MAX_SOURCES = MAX_CAD_SOURCE_COUNT;
export const CAD_REQUEST_PLAN_MAX_SOURCE_BYTES = MAX_CAD_SOURCE_BYTES;
export const CAD_REQUEST_PLAN_MAX_SOURCE_CHARS = MAX_CAD_SOURCE_CHARS;
export const CAD_REQUEST_PLAN_MAX_INSTRUCTION_CHARS = 4_000;

export type CadPreflightSource = Readonly<{
  id: string;
  title: string;
  content: string;
  status?: "ready" | "processing" | "error";
  /** Optional trusted extraction result; unknown IDs are rejected, not ignored. */
  objectIds?: readonly CadObjectId[];
}>;

export type CadPlanParameterValue = string | number | boolean | null;
export type CadTemplateIdV3 = CadFixedTemplateV3 | "text2cad" | "auto";

export type CadRequestPlanInput = Readonly<{
  /** Optional caller intent. When supplied it must agree with the resolved mode. */
  mode?: CadRequestPlanMode;
  instruction?: string;
  /** `templateId` is the v3 name; `template` remains a short migration alias. */
  templateId?: CadTemplateIdV3 | string | null;
  template?: CadTemplateIdV3 | string | null;
  targetObjectId?: CadObjectId | string | null;
  parameters?: Readonly<Record<string, CadPlanParameterValue>>;
  allowAssumptions?: boolean;
  tutorialExample?: boolean;
  sources: readonly CadPreflightSource[];
}>;

export type CadSourceSnapshotV3 = Readonly<{
  id: string;
  title: string;
  textHash: string;
  byteLength: number;
  objectIds: readonly CadObjectId[];
  designObjectIds: readonly CadObjectId[];
  constraintExpressions: readonly string[];
  unsupportedFeatures: readonly string[];
  constraintExpressionsByObject: Readonly<Partial<Record<CadObjectId, readonly string[]>>>;
  unsupportedFeaturesByObject: Readonly<Partial<Record<CadObjectId, readonly string[]>>>;
}>;

export type CadConstraintV3 = Readonly<{
  id: string;
  expression: string;
  provenance: "prompt" | "source" | "template";
  sourceIds: readonly string[];
}>;

export type CadRequestPlanV3 = Readonly<{
  schemaVersion: typeof CAD_REQUEST_PLAN_VERSION;
  objectContractVersion: typeof CAD_OBJECT_CONTRACT_VERSION;
  mode: CadRequestPlanMode;
  templateId: CadFixedTemplateV3 | "text2cad";
  instruction: string | null;
  parameters: Readonly<Record<string, CadPlanParameterValue>>;
  allowAssumptions: boolean;
  tutorialExample: boolean;
  target: Readonly<{
    objectId: CadObjectId;
    label: string;
    provenance: "prompt" | "source" | "template";
    sourceIds: readonly string[];
    artifactMode: CadArtifactModeV3;
    fidelity: CadFidelity;
    minParts: number;
    maxParts: number;
    requiredPartRoles: readonly string[];
  }>;
  capability: Readonly<{
    supportedOperations: readonly string[];
    limitations: readonly string[];
  }>;
  evidencePolicy: Readonly<{
    promptHasPriority: true;
    requireSourceBackedGeometry: boolean;
    permitDesignAssumptions: boolean;
  }>;
  constraints: readonly CadConstraintV3[];
  missingFields: readonly string[];
  sourceSnapshots: readonly CadSourceSnapshotV3[];
  sourceSnapshotHash: string;
  planHash: string;
}>;

export type CadPreflightFailure = Readonly<{
  ok: false;
  error: Readonly<{
    code: CadErrorCode;
    message: string;
    disposition: ReturnType<typeof cadFailureDisposition>;
    field?: string;
    hint?: string;
    details?: Readonly<Record<string, unknown>>;
  }>;
}>;

export type CadPreflightResult = Readonly<{ ok: true; plan: CadRequestPlanV3 }> | CadPreflightFailure;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type CachedCadSourceAnalysis = Readonly<{
  objectIds: readonly CadObjectId[];
  designObjectIds: readonly CadObjectId[];
  constraintExpressionsByObject: Readonly<Partial<Record<CadObjectId, readonly string[]>>>;
  unsupportedFeaturesByObject: Readonly<Partial<Record<CadObjectId, readonly string[]>>>;
}>;

const analysisGlobal = globalThis as unknown as {
  __cadSourceAnalysis?: Map<string, { at: number; value: CachedCadSourceAnalysis }>;
};
const sourceAnalysisCache = (analysisGlobal.__cadSourceAnalysis ??= new Map());

function cachedSourceAnalysis(
  key: string,
  compute: () => CachedCadSourceAnalysis
): CachedCadSourceAnalysis {
  const now = Date.now();
  const cached = sourceAnalysisCache.get(key);
  if (cached && now - cached.at <= 10 * 60_000) return cached.value;
  const value = compute();
  sourceAnalysisCache.set(key, { at: now, value });
  if (sourceAnalysisCache.size > 256) {
    const oldest = [...sourceAnalysisCache.entries()]
      .sort((left, right) => left[1].at - right[1].at)
      .slice(0, sourceAnalysisCache.size - 192);
    oldest.forEach(([entryKey]) => sourceAnalysisCache.delete(entryKey));
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CadContractError({ code: "cad_request_invalid", message: "CAD 请求包含无效数值" });
  }
  return value;
}

export function canonicalCadRequestPlanJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalCadRequestPlanHash(
  value: Omit<CadRequestPlanV3, "planHash"> | CadRequestPlanV3
): string {
  const { planHash: _ignored, ...payload } = value as CadRequestPlanV3;
  return sha256(canonicalCadRequestPlanJson(payload));
}

const normalizeInstruction = (value: string | undefined) => (value ?? "")
  .normalize("NFKC")
  .replace(/[\u200B-\u200D\uFEFF]/g, "")
  .replace(/\s+/g, " ")
  .trim();

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const SOURCE_AUTHORITATIVE_DESIGN_CUE = /(?:建模目标|设计对象|设计任务书|设计要求|项目需求|客户要求|待加工|用于制造|工程图|图纸|规格书|参数表|外形尺寸|整体尺寸|\b(?:model(?:ing)? target|design object|design brief|design requirements?|project requirements?|customer requirements?|part to manufacture|engineering drawing|specification|parameter table|overall dimensions?|envelope dimensions?)\b)/i;
const SOURCE_DEFINITIVE_TARGET_CUE = /(?:建模目标|设计对象|客户要求|待加工|用于制造|\b(?:model(?:ing)? target|design object|customer requirements?|part to manufacture)\b)/i;
const SOURCE_EXAMPLE_ONLY_CUE = /(?:教程|教学|示例|案例|例如|为例|演示|练习|参考|\b(?:tutorial|example|demo|exercise|reference case)\b)/i;
const SOURCE_CONTEXT_BREAK_CUE = /(?:附录|另一(?:个|种)?(?:对象|产品|设备|零件|方案|型号)|其他(?:对象|产品|设备|零件|方案|型号)|别的(?:对象|产品|设备|零件)|对比|对照|历史案例|\b(?:appendix|another (?:object|product|device|part|design|model)|other (?:object|product|device|part|design|model)|comparison|historical case)\b)/i;
const SOURCE_DRIVEN_DIRECTIVE = /(?:所选来源|根据来源|结合来源|根据资料|结合资料)/i;
const CAD_CONSTRAINT_PATTERNS = [
  /\d+(?:\.\d+)?\s*[xX×*]\s*\d+(?:\.\d+)?(?:\s*[xX×*]\s*\d+(?:\.\d+)?)?\s*(?:mm|毫米|cm|厘米|m|米|in|英寸)?/gi,
  /(?:整体|外形|长度|长边|长|宽度|宽边|宽|高度|高|深度|壁厚|板厚|厚度|孔径|孔边距|边距|外径|内孔直径|内径|直径|半径|轴距|孔距|间距|公差)\s*(?:为|是|约|=|:|：)?\s*\d+(?:\.\d+)?\s*(?:mm|毫米|cm|厘米|m|米|in|英寸)?/gi,
  /\b(?:length|width|height|depth|wall\s+thickness|plate\s+thickness|thickness|hole\s+diameter|edge\s+offset|outer\s+diameter|inner\s+diameter|bore\s+diameter|diameter|radius|wheelbase|spacing|tolerance)\b\s*(?:is|about|=|:)?\s*\d+(?:\.\d+)?\s*(?:mm|cm|m|in|inch|inches)?/gi,
  /(?:材料|工艺)\s*(?:为|是|采用|要求|=|:|：)\s*[^,。；;\n]{1,48}/gi,
  /(?:包含|由)\s*[^,。；;\n]{2,100}?(?:组成|部件|底座|肩部|上臂|前臂|腕部|孔)/gi,
] as const;

function extractConstraintExpressions(value: string): string[] {
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ");
  return [...new Set(CAD_CONSTRAINT_PATTERNS.flatMap((pattern) => (
    [...normalized.matchAll(new RegExp(pattern.source, pattern.flags))]
      .map((match) => match[0].trim())
  )).filter(Boolean))].slice(0, 24);
}

function sourceSegments(title: string, content: string): string[] {
  return [title, ...content.split(/[\n\r。！？!?;；]+/)]
    .map((segment) => normalizeInstruction(segment))
    .filter(Boolean)
    .slice(0, 20_000);
}

function orderedObjectIds(value: string): CadObjectId[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  return findCadObjectMentions(value)
    .map((mention) => ({
      objectId: mention.objectId,
      index: normalized.indexOf(mention.alias.normalize("NFKC").toLocaleLowerCase("en-US")),
    }))
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.objectId);
}

/** 权威语义段的顶层对象；明确目标谓词后最先出现的对象高于后续部件别名。 */
export function cadPrimaryObjectIdsForText(value: string): CadObjectId[] {
  const targetPrefix = /(?:建模目标|设计对象|待加工对象|生成|创建|绘制|画一个|设计一个|建模|\bmodel(?:ing)?\s+target\b|\bdesign\s+object\b|\bpart\s+to\s+manufacture\b|\b(?:create|generate|draw|design|model)\b)(?:结果)?(?:为|是|包括|\s+(?:is|as|includes?)|:|：)?\s*/i;
  const targetMatch = targetPrefix.exec(value);
  if (targetMatch) {
    const tail = value.slice(targetMatch.index + targetMatch[0].length);
    const clause = tail.split(/[,，。；;\n\r]/, 1)[0] ?? tail;
    const clauseIds = orderedObjectIds(clause);
    if (clauseIds.length > 1 && /(?:、|和|及|与)/.test(clause)) return [...new Set(clauseIds)];
    if (clauseIds.length > 0) return [clauseIds[0]];
    const tailIds = orderedObjectIds(tail);
    if (tailIds.length > 0) return [tailIds[0]];
  }
  const ordered = orderedObjectIds(value);
  if (ordered.length <= 1) return [...new Set(ordered)];
  if (/(?:采用|包含|由|内部|底座|车轮|通过|连接|安装于|作为部件)/i.test(value)) return [ordered[0]];
  // 用户/来源明确说“多个设计对象”时保留冲突，不得只挑第一个。
  if (/(?:建模目标|设计对象|生成|创建|设计|建模)[^,。；;]{0,100}(?:、|和|及|与)[^,。；;]{0,60}/i.test(value)) {
    return [...new Set(ordered)];
  }
  return [ordered[0]];
}

/**
 * 只把与权威设计语境在同一语义段内的对象当作“待建模目标”。
 * 文档中随口出现“教程以机械臂为例，示例长度 100mm”只是教学内容，
 * 不能因另一处出现尺寸词就被提升为可执行 CAD 任务。
 */
function designObjectIdsForSource(
  title: string,
  content: string,
  trustedObjectIds: readonly CadObjectId[]
): CadObjectId[] {
  const accepted = new Set<CadObjectId>(trustedObjectIds);
  const segments = sourceSegments(title, content);
  for (const segment of segments) {
    if (!SOURCE_AUTHORITATIVE_DESIGN_CUE.test(segment)) continue;
    if (SOURCE_EXAMPLE_ONLY_CUE.test(segment) && !SOURCE_DEFINITIVE_TARGET_CUE.test(segment)) continue;
    for (const objectId of cadPrimaryObjectIdsForText(segment)) accepted.add(objectId);
  }
  return [...accepted].sort();
}

/**
 * 把来源正文收窄为与已冻结顶层对象同一语义链的证据。
 * 教程、附录、对比对象会终止当前上下文，不能把它们的尺寸借给主目标。
 */
export function cadTargetEvidenceText(
  title: string,
  content: string,
  targetObjectId: CadObjectId
): string {
  const segments = sourceSegments(title, content);
  const selected: string[] = [];
  let inTargetContext = false;
  for (const [index, segment] of segments.entries()) {
    const primaryIds = cadPrimaryObjectIdsForText(segment);
    const mentionsTarget = primaryIds.includes(targetObjectId);
    const mentionsOtherPrimary = primaryIds.some((objectId) => objectId !== targetObjectId);
    const exampleOnly = SOURCE_EXAMPLE_ONLY_CUE.test(segment) && !SOURCE_DEFINITIVE_TARGET_CUE.test(segment);
    const declaresOtherTopLevel = mentionsOtherPrimary && SOURCE_AUTHORITATIVE_DESIGN_CUE.test(segment);
    if (exampleOnly || SOURCE_CONTEXT_BREAK_CUE.test(segment) || declaresOtherTopLevel) {
      inTargetContext = false;
      continue;
    }
    if (mentionsTarget && (SOURCE_AUTHORITATIVE_DESIGN_CUE.test(segment) || index === 0)) {
      inTargetContext = true;
    }
    if (inTargetContext) selected.push(segment);
  }
  return selected.join("\n");
}

const CAD_UNSUPPORTED_FEATURES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "自由曲面", pattern: /自由曲面|NURBS|Class\s*A\s*surface/i },
  { label: "精确齿形", pattern: /精确齿形|渐开线齿|变位齿轮/i },
  { label: "真实螺纹", pattern: /真实螺纹|可制造螺纹|螺旋齿形/i },
  { label: "BIM/建筑模型", pattern: /\bBIM\b|建筑模型|房屋结构/i },
  { label: "生产级运动学", pattern: /生产级[^,。；;\n]{0,12}(?:运动学|驱动|线束)|完整运动学/i },
] as const;

function unsupportedCadFeatures(value: string): string[] {
  return CAD_UNSUPPORTED_FEATURES.filter((entry) => entry.pattern.test(value)).map((entry) => entry.label);
}

function failure(error: CadContractError): CadPreflightFailure {
  return { ok: false, error: error.toJSON() } as CadPreflightFailure;
}

function contractFailure(args: ConstructorParameters<typeof CadContractError>[0]): never {
  throw new CadContractError(args);
}

function normalizedSourceSnapshots(sources: readonly CadPreflightSource[]): CadSourceSnapshotV3[] {
  if (!Array.isArray(sources)) {
    contractFailure({ code: "cad_request_invalid", message: "CAD 来源快照无效", field: "sources" });
  }
  if (sources.length > CAD_REQUEST_PLAN_MAX_SOURCES) {
    contractFailure({
      code: "cad_source_budget_exceeded",
      message: `CAD 每次最多选择 ${CAD_REQUEST_PLAN_MAX_SOURCES} 个来源`,
      field: "sourceIds",
    });
  }
  const snapshots = new Map<string, CadSourceSnapshotV3>();
  let totalBytes = 0;
  let totalChars = 0;
  for (const source of sources) {
    const id = typeof source?.id === "string" ? source.id.trim() : "";
    const title = typeof source?.title === "string" ? normalizeInstruction(source.title).slice(0, 200) : "";
    const rawContent = typeof source?.content === "string" ? source.content : "";
    if (totalChars + rawContent.length > CAD_REQUEST_PLAN_MAX_SOURCE_CHARS) {
      contractFailure({
        code: "cad_source_budget_exceeded",
        message: "CAD 所选来源正文过长，请缩小取材范围后重试",
        field: "sourceIds",
      });
    }
    const content = rawContent.normalize("NFKC");
    if (!id || id.startsWith("__")) {
      contractFailure({ code: "cad_request_invalid", message: "CAD 来源 ID 无效", field: "sourceIds" });
    }
    if (source.status && source.status !== "ready") {
      contractFailure({
        code: "cad_source_unavailable",
        message: "CAD 取材范围包含未就绪的来源",
        field: "sourceIds",
        details: { sourceId: id, status: source.status },
      });
    }
    for (const objectId of source.objectIds ?? []) {
      if (!isCadObjectId(objectId)) {
        contractFailure({
          code: "cad_request_invalid",
          message: "CAD 来源包含未知建模对象",
          field: "sources.objectIds",
          details: { sourceId: id, objectId },
        });
      }
    }
    const bytes = byteLength(content);
    totalBytes += bytes;
    totalChars += content.length;
    if (totalChars > CAD_REQUEST_PLAN_MAX_SOURCE_CHARS) {
      contractFailure({
        code: "cad_source_budget_exceeded",
        message: "CAD 所选来源正文过长，请缩小取材范围后重试",
        field: "sourceIds",
      });
    }
    if (totalBytes > CAD_REQUEST_PLAN_MAX_SOURCE_BYTES) {
      contractFailure({
        code: "cad_source_budget_exceeded",
        message: "CAD 所选来源正文过长，请缩小取材范围后重试",
        field: "sourceIds",
      });
    }
    const textHash = sha256(`${title}\n${content}`);
    const trustedIds = [...new Set(source.objectIds ?? [])].sort() as CadObjectId[];
    const analysis = cachedSourceAnalysis(`${textHash}:${trustedIds.join(",")}`, () => {
      const extractedIds = findCadObjectIds(`${title}\n${content}`);
      const objectIds = [...new Set([...trustedIds, ...extractedIds])].sort() as CadObjectId[];
      const designObjectIds = designObjectIdsForSource(title, content, trustedIds);
      const evidenceByObject = Object.fromEntries(designObjectIds.map((objectId) => [
        objectId,
        cadTargetEvidenceText(title, content, objectId),
      ])) as Partial<Record<CadObjectId, string>>;
      const constraintExpressionsByObject = Object.fromEntries(designObjectIds.map((objectId) => [
        objectId,
        extractConstraintExpressions(evidenceByObject[objectId] ?? ""),
      ])) as Partial<Record<CadObjectId, string[]>>;
      const unsupportedFeaturesByObject = Object.fromEntries(designObjectIds.map((objectId) => [
        objectId,
        unsupportedCadFeatures(evidenceByObject[objectId] ?? ""),
      ])) as Partial<Record<CadObjectId, string[]>>;
      return { objectIds, designObjectIds, constraintExpressionsByObject, unsupportedFeaturesByObject };
    });
    const snapshot: CadSourceSnapshotV3 = {
      id,
      title,
      textHash,
      byteLength: bytes,
      objectIds: analysis.objectIds,
      designObjectIds: analysis.designObjectIds,
      constraintExpressions: [...new Set(Object.values(analysis.constraintExpressionsByObject).flat())],
      unsupportedFeatures: [...new Set(Object.values(analysis.unsupportedFeaturesByObject).flat())],
      constraintExpressionsByObject: analysis.constraintExpressionsByObject,
      unsupportedFeaturesByObject: analysis.unsupportedFeaturesByObject,
    };
    const previous = snapshots.get(id);
    if (previous && previous.textHash !== snapshot.textHash) {
      contractFailure({
        code: "cad_request_invalid",
        message: "同一 CAD 来源 ID 对应了不同内容",
        field: "sourceIds",
        details: { sourceId: id },
      });
    }
    snapshots.set(id, snapshot);
  }
  const result = [...snapshots.values()].sort((left, right) => left.id.localeCompare(right.id));
  if (result.length > 0 && !result.some((source) => source.byteLength > 0)) {
    contractFailure({
      code: "cad_source_unavailable",
      message: "所选来源没有可用于 CAD 建模的有效正文",
      field: "sourceIds",
    });
  }
  return result;
}

function validateFixedTemplateParameters(
  template: CadFixedTemplateV3,
  parameters: Record<string, CadPlanParameterValue>
): void {
  try {
    normalizeCadDesignSpec({
      schemaVersion: 1,
      unit: "mm",
      template: template as CadTemplate,
      parameters,
    });
  } catch (error) {
    if (error instanceof CadSpecValidationError) {
      const first = error.issues[0];
      contractFailure({
        code: "cad_invalid_explicit_constraint",
        message: `CAD 固定模板参数无效：${first?.message ?? "不符合几何约束"}`,
        field: first?.path ?? "parameters",
        details: {
          template,
          issues: error.issues.slice(0, 8).map((issue) => ({
            code: issue.code,
            path: issue.path,
            message: issue.message,
          })),
        },
      });
    }
    throw error;
  }
}

function normalizeParameters(
  value: Readonly<Record<string, CadPlanParameterValue>> | undefined
): Record<string, CadPlanParameterValue> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    contractFailure({ code: "cad_request_invalid", message: "CAD 参数快照无效", field: "parameters" });
  }
  const entries = Object.entries(value);
  if (entries.length > 64) {
    contractFailure({ code: "cad_request_invalid", message: "CAD 参数过多", field: "parameters" });
  }
  const result: Record<string, CadPlanParameterValue> = {};
  for (const [rawKey, rawValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const key = rawKey.trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      contractFailure({
        code: "cad_request_invalid",
        message: "CAD 参数名无效",
        field: `parameters.${rawKey}`,
      });
    }
    if (
      rawValue !== null
      && typeof rawValue !== "string"
      && typeof rawValue !== "number"
      && typeof rawValue !== "boolean"
    ) {
      contractFailure({
        code: "cad_request_invalid",
        message: "CAD 参数值无效",
        field: `parameters.${key}`,
      });
    }
    if (typeof rawValue === "number" && !Number.isFinite(rawValue)) {
      contractFailure({
        code: "cad_invalid_explicit_constraint",
        message: "CAD 参数必须是有限数值",
        field: `parameters.${key}`,
      });
    }
    if (typeof rawValue === "string" && rawValue.length > 500) {
      contractFailure({
        code: "cad_request_invalid",
        message: "CAD 参数文本过长",
        field: `parameters.${key}`,
      });
    }
    result[key] = typeof rawValue === "string" ? normalizeInstruction(rawValue) : rawValue;
  }
  return result;
}

function createPlan(args: {
  mode: CadRequestPlanMode;
  instruction: string;
  objectId: CadObjectId;
  provenance: "prompt" | "source" | "template";
  sourceIds: string[];
  sourceSnapshots: CadSourceSnapshotV3[];
  parameters: Record<string, CadPlanParameterValue>;
  allowAssumptions: boolean;
  constraints: CadConstraintV3[];
  missingFields?: string[];
  tutorialExample?: boolean;
}): CadRequestPlanV3 {
  const contract = getCadObjectContract(args.objectId);
  const sourceSnapshotHash = sha256(canonicalCadRequestPlanJson(args.sourceSnapshots));
  const payload: Omit<CadRequestPlanV3, "planHash"> = {
    schemaVersion: CAD_REQUEST_PLAN_VERSION,
    objectContractVersion: CAD_OBJECT_CONTRACT_VERSION,
    mode: args.mode,
    templateId: args.mode === "fixed_template" ? args.objectId as CadFixedTemplateV3 : "text2cad",
    instruction: args.instruction || null,
    parameters: args.parameters,
    allowAssumptions: args.allowAssumptions,
    tutorialExample: args.tutorialExample === true,
    target: {
      objectId: args.objectId,
      label: contract.label,
      provenance: args.provenance,
      sourceIds: [...new Set(args.sourceIds)].sort(),
      artifactMode: contract.artifactMode,
      fidelity: contract.fidelity,
      minParts: contract.minParts,
      maxParts: contract.maxParts,
      requiredPartRoles: [...contract.requiredPartRoles],
    },
    capability: {
      supportedOperations: [...contract.supportedOperations],
      limitations: [...contract.limitations],
    },
    evidencePolicy: {
      promptHasPriority: true,
      requireSourceBackedGeometry: args.mode === "source_driven",
      permitDesignAssumptions: args.allowAssumptions,
    },
    constraints: args.constraints,
    missingFields: args.missingFields ?? [],
    sourceSnapshots: args.sourceSnapshots,
    sourceSnapshotHash,
  };
  return { ...payload, planHash: canonicalCadRequestPlanHash(payload) };
}

function promptConstraintFields(
  instruction: string,
  allowAssumptions: boolean,
  objectId: CadObjectId
): Pick<Parameters<typeof createPlan>[0], "constraints" | "missingFields"> {
  const constraints: CadConstraintV3[] = extractConstraintExpressions(instruction).map((expression, index) => ({
    id: `constraint_prompt_${index + 1}`,
    expression,
    provenance: "prompt",
    sourceIds: [],
  }));
  if (!constraints.length && !allowAssumptions) {
    contractFailure({
      code: "cad_invalid_explicit_constraint",
      message: "请补充至少一项关键尺寸或明确允许首版设计假设",
      field: "instruction",
      hint: "例如：整体高度 600mm",
    });
  }
  if (getCadObjectContract(objectId).fidelity === "concept_assembly" && !allowAssumptions) {
    contractFailure({
      code: "cad_invalid_explicit_constraint",
      message: "当前概念装配需要使用明确披露的首版比例和布局假设",
      field: "allowAssumptions",
      hint: "请勾选“允许首版设计假设”，或改用经验证的固定模板",
    });
  }
  const semanticMissing = assertRequiredDimensionsOrAssumptions(
    objectId,
    constraints.map((constraint) => constraint.expression),
    allowAssumptions,
    "instruction"
  );
  const missingFields = [
    ...(!constraints.length ? ["key_dimensions"] : []),
    ...(getCadObjectContract(objectId).fidelity === "concept_assembly" ? ["component_proportions", "joint_clearances"] : []),
    ...semanticMissing,
  ];
  return { constraints, missingFields: [...new Set(missingFields)] };
}

function templateConstraintFields(
  parameters: Record<string, CadPlanParameterValue>
): Pick<Parameters<typeof createPlan>[0], "constraints" | "missingFields"> {
  return {
    constraints: Object.entries(parameters).map(([key, value], index) => ({
      id: `constraint_template_${index + 1}`,
      expression: `${key}=${String(value)}`,
      provenance: "template",
      sourceIds: [],
    })),
    missingFields: [],
  };
}

function sourceConstraintFields(
  sourceSnapshots: CadSourceSnapshotV3[],
  targetSourceIds: string[],
  targetObjectId: CadObjectId
): Pick<Parameters<typeof createPlan>[0], "constraints" | "missingFields"> {
  const constraints: CadConstraintV3[] = sourceSnapshots
    .filter((source) => targetSourceIds.includes(source.id))
    .flatMap((source) => (
      source.constraintExpressionsByObject[targetObjectId] ?? []
    ).map((expression) => ({ expression, sourceId: source.id })))
    .map((entry, index) => ({
      id: `constraint_source_${index + 1}`,
      expression: entry.expression,
      provenance: "source",
      sourceIds: [entry.sourceId],
    }));
  if (!constraints.length) {
    contractFailure({
      code: "cad_invalid_explicit_constraint",
      message: "来源中已识别到对象，但没有可执行的尺寸、材料或部件关系",
      field: "sourceIds",
    });
  }
  return { constraints, missingFields: [] };
}

type RequiredDimensionKey = "length" | "width" | "height" | "thickness" | "outer_diameter" | "bore_diameter";
type RequiredDimensionField = Readonly<{ key: RequiredDimensionKey; label: string; pattern: RegExp }>;

const NAMED_DIMENSION_FIELDS: Record<RequiredDimensionKey, RequiredDimensionField> = {
  length: { key: "length", label: "长度", pattern: /(?:长度|长边|长|\blength\b)\s*(?:为|是|约|=|:|：)?\s*\d/i },
  width: { key: "width", label: "宽度", pattern: /(?:宽度|宽边|宽|\bwidth\b)\s*(?:为|是|约|=|:|：)?\s*\d/i },
  height: { key: "height", label: "高度", pattern: /(?:高度|高|\bheight\b)\s*(?:为|是|约|=|:|：)?\s*\d/i },
  thickness: { key: "thickness", label: "厚度", pattern: /(?:壁厚|板厚|厚度|\bthickness\b)\s*(?:为|是|约|=|:|：)?\s*\d/i },
  outer_diameter: { key: "outer_diameter", label: "外径", pattern: /(?:外径|外圆直径|\bouter\s+diameter\b|(?<!孔|内)直径)\s*(?:为|是|约|=|:|：)?\s*\d/i },
  bore_diameter: { key: "bore_diameter", label: "内孔直径", pattern: /(?:内孔直径|内径|孔径|轴孔直径|中心孔(?:直径)?|\b(?:bore|inner)\s+diameter\b)\s*(?:为|是|约|=|:|：)?\s*\d/i },
};

function missingRequiredDimensions(objectId: CadObjectId, expressions: readonly string[]): string[] {
  if (getCadObjectContract(objectId).fidelity === "concept_assembly") return [];
  const text = expressions.join(" ").normalize("NFKC");
  const bundles = [...text.matchAll(
    /\d+(?:\.\d+)?\s*[xX×*]\s*\d+(?:\.\d+)?(?:\s*[xX×*]\s*\d+(?:\.\d+)?)?/g
  )].map((match) => (match[0].match(/[xX×*]/g)?.length ?? 0) + 1);
  const has2dBundle = bundles.some((arity) => arity >= 2);
  const has3dBundle = bundles.some((arity) => arity >= 3);
  const has = (key: RequiredDimensionKey) => NAMED_DIMENSION_FIELDS[key].pattern.test(text);
  const required: RequiredDimensionField[] = (() => {
    switch (objectId) {
      case "plate":
        return [
          ...(!has2dBundle ? [NAMED_DIMENSION_FIELDS.length, NAMED_DIMENSION_FIELDS.width] : []),
          ...(!has3dBundle ? [NAMED_DIMENSION_FIELDS.thickness] : []),
        ];
      case "mounting_bracket":
        return [
          ...(!has3dBundle ? [NAMED_DIMENSION_FIELDS.length, NAMED_DIMENSION_FIELDS.width, NAMED_DIMENSION_FIELDS.height] : []),
          NAMED_DIMENSION_FIELDS.thickness,
        ];
      case "enclosure":
        return [
          ...(!has3dBundle ? [NAMED_DIMENSION_FIELDS.length, NAMED_DIMENSION_FIELDS.width, NAMED_DIMENSION_FIELDS.height] : []),
          NAMED_DIMENSION_FIELDS.thickness,
        ];
      case "flange":
      case "shaft_adapter":
        return [NAMED_DIMENSION_FIELDS.outer_diameter, NAMED_DIMENSION_FIELDS.bore_diameter, NAMED_DIMENSION_FIELDS.thickness];
      default:
        return [];
    }
  })();
  return [...new Set(required.filter((field) => !has(field.key)).map((field) => field.key))];
}

function assertRequiredDimensionsOrAssumptions(
  objectId: CadObjectId,
  expressions: readonly string[],
  allowAssumptions: boolean,
  field: "instruction" | "sourceIds"
): string[] {
  const missing = missingRequiredDimensions(objectId, expressions);
  if (missing.length && !allowAssumptions) {
    const labels = missing.map((key) => NAMED_DIMENSION_FIELDS[key as RequiredDimensionKey]?.label ?? key);
    contractFailure({
      code: "cad_invalid_explicit_constraint",
      message: `可执行 ${getCadObjectContract(objectId).label} 仍缺少关键尺寸：${labels.join("、")}`,
      field,
      hint: "请补充明确尺寸，或勾选“允许首版设计假设”",
      details: { missingFields: missing },
    });
  }
  return missing;
}

/**
 * Pure CAD admission: no DB, queue, model, filesystem, or runtime access.
 * Callers supply the already-authorized source text/metadata and only enqueue a
 * job when this function returns `{ ok: true }`.
 */
export function preflightCadRequest(input: CadRequestPlanInput): CadPreflightResult {
  try {
    const instruction = normalizeInstruction(input.instruction);
    if (instruction.length > CAD_REQUEST_PLAN_MAX_INSTRUCTION_CHARS) {
      contractFailure({
        code: "cad_request_invalid",
        message: "CAD 建模要求过长",
        field: "instruction",
      });
    }
    const parameters = normalizeParameters(input.parameters);
    const allowAssumptions = input.allowAssumptions === true;
    const tutorialExample = input.tutorialExample === true;
    // 先拒绝模式不会消费的字段，再扫描最多 6MB 来源；否则攻击者只需
    // 每次变一个无效 parameters 就能绕过 singleflight，白占全文正则/Hash CPU。
    if ((input.mode === "prompt_driven" || input.mode === "source_driven") && Object.keys(parameters).length) {
      contractFailure({
        code: "cad_request_invalid",
        message: input.mode === "source_driven"
          ? "来源驱动模式只使用冻结来源约束，不接受隐藏参数字段"
          : "描述模型的约束必须写入建模描述，不接受隐藏参数字段",
        field: "parameters",
      });
    }
    if (input.mode === "source_driven" && instruction) {
      contractFailure({
        code: "cad_request_invalid",
        message: "来源驱动模式只按来源中的唯一对象建模，不接受另一条自由描述",
        field: "instruction",
      });
    }
    if (input.mode === "fixed_template" && instruction && !tutorialExample) {
      contractFailure({
        code: "cad_request_invalid",
        message: "固定模板只执行页面列出的受控参数，不接受未结构化补充要求",
        field: "instruction",
      });
    }
    // 模式在纯合同层即硬隔离证据域，不依赖 route/UI 帮忙清空。
    // 这使 prompt/fixed 计划的 hash、限额与生成语料都不会被无关勾选来源污染。
    const sourceSnapshots = input.mode === "prompt_driven" || input.mode === "fixed_template" || tutorialExample
      ? []
      : normalizedSourceSnapshots(input.sources);
    const promptUnsupported = unsupportedCadFeatures(instruction);
    if (promptUnsupported.length) {
      contractFailure({
        code: "cad_capability_limit",
        message: `当前 CAD 能力不支持：${promptUnsupported.join("、")}`,
        field: "instruction",
        details: { unsupportedFeatures: promptUnsupported },
      });
    }
    const legacyTemplate = typeof input.template === "string" ? input.template.trim() : "";
    const templateId = typeof input.templateId === "string" ? input.templateId.trim() : "";
    if (legacyTemplate && templateId && legacyTemplate !== templateId) {
      contractFailure({
        code: "cad_template_conflict",
        message: "CAD 模板快照存在冲突",
        field: "templateId",
        details: { template: legacyTemplate, templateId },
      });
    }
    const templateValue = templateId || legacyTemplate;
    if (templateValue && templateValue !== "text2cad" && templateValue !== "auto" && !isCadFixedTemplateV3(templateValue)) {
      contractFailure({
        code: "cad_template_invalid",
        message: "CAD 固定模板无效",
        field: "cadTemplate",
        details: { template: templateValue },
      });
    }
    const targetValue = typeof input.targetObjectId === "string" ? input.targetObjectId.trim() : "";
    if (targetValue && !isCadObjectId(targetValue)) {
      contractFailure({
        code: "cad_target_required",
        message: "请选择受支持的 CAD 建模对象",
        field: "targetObjectId",
        details: { targetObjectId: targetValue },
      });
    }
    const promptObjectIds = cadPrimaryObjectIdsForText(instruction);
    const accept = (plan: CadRequestPlanV3): Extract<CadPreflightResult, { ok: true }> => {
      if (input.mode && input.mode !== plan.mode) {
        contractFailure({
          code: "cad_request_invalid",
          message: "CAD 请求模式与可执行计划不一致",
          field: "mode",
          details: { requestedMode: input.mode, resolvedMode: plan.mode },
        });
      }
      return { ok: true, plan };
    };
    const createSourceDrivenPlan = (): CadRequestPlanV3 => {
      if (sourceSnapshots.length === 0) {
        contractFailure({
          code: "cad_source_required",
          message: "来源驱动建模需要至少一个已就绪来源",
          field: "sourceIds",
        });
      }
      const sourceCandidates = new Map<CadObjectId, string[]>();
      for (const source of sourceSnapshots) {
        for (const objectId of source.designObjectIds) {
          sourceCandidates.set(objectId, [...(sourceCandidates.get(objectId) ?? []), source.id]);
        }
      }
      const sourceObjectIds = [...sourceCandidates.keys()].sort();
      if (targetValue && !sourceCandidates.has(targetValue as CadObjectId)) {
        contractFailure({
          code: "cad_source_conflict",
          message: "所选 CAD 对象不在当前来源的可执行目标中",
          field: "targetObjectId",
          details: { selectedObjectId: targetValue, objectIds: sourceObjectIds },
        });
      }
      if (sourceObjectIds.length > 1 && !targetValue) {
        contractFailure({
          code: "cad_source_conflict",
          message: "所选来源包含多个 CAD 设计对象，请先选择本次要生成的对象",
          field: "sourceIds",
          details: { objectIds: sourceObjectIds },
        });
      }
      if (sourceObjectIds.length === 0) {
        contractFailure({
          code: "cad_target_required",
          message: "所选来源未形成唯一、可执行的 CAD 建模目标",
          field: "instruction",
          hint: "请填写具体对象，或在界面中选择一个受支持的模型",
        });
      }
      const sourceObjectId = (targetValue || sourceObjectIds[0]) as CadObjectId;
      const targetSourceIds = sourceCandidates.get(sourceObjectId) ?? [];
      const sourceUnsupported = [...new Set(
        sourceSnapshots
          .filter((source) => targetSourceIds.includes(source.id))
          .flatMap((source) => source.unsupportedFeaturesByObject[sourceObjectId] ?? [])
      )];
      if (sourceUnsupported.length) {
        contractFailure({
          code: "cad_capability_limit",
          message: `来源要求超出当前 CAD 能力：${sourceUnsupported.join("、")}`,
          field: "sourceIds",
          details: { unsupportedFeatures: sourceUnsupported },
        });
      }
      if (getCadObjectContract(sourceObjectId).fidelity === "concept_assembly" && !allowAssumptions) {
        contractFailure({
          code: "cad_invalid_explicit_constraint",
          message: "来源已给出概念装配对象，但当前证据不足以定义全部部件比例与间隙",
          field: "allowAssumptions",
          hint: "请确认允许将缺失比例列为首版假设",
        });
      }
      const constraintFields = sourceConstraintFields(sourceSnapshots, targetSourceIds, sourceObjectId);
      const semanticMissing = assertRequiredDimensionsOrAssumptions(
        sourceObjectId,
        constraintFields.constraints.map((constraint) => constraint.expression),
        allowAssumptions,
        "sourceIds"
      );
      return createPlan({
        mode: "source_driven",
        // Source-driven mode deliberately carries no prompt geometry authority.
        // The original request may remain in audit logs, but must not alter IR.
        instruction: "",
        objectId: sourceObjectId,
        provenance: "source",
        sourceIds: targetSourceIds,
        sourceSnapshots,
        parameters,
        allowAssumptions,
        ...constraintFields,
        missingFields: [...new Set([
          ...(constraintFields.missingFields ?? []),
          ...semanticMissing,
          ...(getCadObjectContract(sourceObjectId).fidelity === "concept_assembly"
            ? ["component_proportions", "joint_clearances"]
            : []),
        ])],
      });
    };

    if (input.mode === "prompt_driven") {
      if (tutorialExample) {
        contractFailure({ code: "cad_request_invalid", message: "教学示例只能使用固定安装板模板", field: "tutorialExample" });
      }
      if (Object.keys(parameters).length) {
        contractFailure({
          code: "cad_request_invalid",
          message: "描述模型的约束必须写入建模描述，不接受隐藏参数字段",
          field: "parameters",
        });
      }
      if (!instruction) {
        contractFailure({
          code: "cad_target_required",
          message: "提示驱动建模需要明确填写建模对象",
          field: "instruction",
        });
      }
      if (templateValue && templateValue !== "text2cad" && templateValue !== "auto") {
        contractFailure({
          code: "cad_template_conflict",
          message: "提示驱动模式不能同时锁定固定模板",
          field: "templateId",
        });
      }
      const selectedObjectId = targetValue && isCadObjectId(targetValue)
        ? targetValue
        : promptObjectIds.length === 1
          ? promptObjectIds[0]
          : null;
      if (promptObjectIds.length > 1 || (selectedObjectId && promptObjectIds.some((id) => id !== selectedObjectId))) {
        contractFailure({
          code: "cad_object_conflict",
          message: "CAD 建模要求中存在多个对象，请明确本次生成哪一个",
          field: "instruction",
          details: { objectIds: promptObjectIds },
        });
      }
      if (!selectedObjectId) {
        contractFailure({
          code: "cad_target_required",
          message: "请补充具体建模对象和关键尺寸后重试",
          field: "instruction",
        });
      }
      return accept(createPlan({
        mode: "prompt_driven",
        instruction,
        objectId: selectedObjectId,
        provenance: "prompt",
        sourceIds: [],
        sourceSnapshots,
        parameters,
        allowAssumptions,
        ...promptConstraintFields(instruction, allowAssumptions, selectedObjectId),
      }));
    }

    if (input.mode === "source_driven") {
      if (tutorialExample) {
        contractFailure({ code: "cad_request_invalid", message: "来源驱动不能静默转为教学示例", field: "tutorialExample" });
      }
      if (Object.keys(parameters).length) {
        contractFailure({
          code: "cad_request_invalid",
          message: "来源驱动模式只使用冻结来源约束，不接受隐藏参数字段",
          field: "parameters",
        });
      }
      if (instruction) {
        contractFailure({
          code: "cad_request_invalid",
          message: "来源驱动模式只按来源中的唯一对象建模，不接受另一条自由描述",
          field: "instruction",
          hint: "如需指定对象，请切换到“描述模型”",
        });
      }
      if (templateValue && templateValue !== "text2cad" && templateValue !== "auto") {
        contractFailure({
          code: "cad_template_conflict",
          message: "来源驱动模式不能同时锁定固定模板",
          field: "templateId",
        });
      }
      return accept(createSourceDrivenPlan());
    }

    if (
      input.mode === "fixed_template"
      && (!templateValue || templateValue === "text2cad" || templateValue === "auto")
    ) {
      contractFailure({
        code: "cad_template_invalid",
        message: "固定模板模式需要选择有效模板",
        field: "templateId",
      });
    }
    if (input.mode === "fixed_template" && instruction) {
      contractFailure({
        code: "cad_request_invalid",
        message: "固定模板只执行页面列出的受控参数，不接受未结构化补充要求",
        field: "instruction",
        hint: "如需自由描述，请切换到“描述模型”",
      });
    }
    if (tutorialExample && templateValue !== "plate") {
      contractFailure({ code: "cad_template_conflict", message: "教学示例只支持四孔安装板", field: "templateId" });
    }

    if (templateValue && templateValue !== "text2cad" && templateValue !== "auto") {
      const template = templateValue as CadFixedTemplateV3;
      const conflicts = [...new Set([
        ...(targetValue && targetValue !== template ? [targetValue] : []),
        ...promptObjectIds.filter((objectId) => objectId !== template),
      ])];
      if (conflicts.length) {
        contractFailure({
          code: "cad_template_conflict",
          message: "用户选择的 CAD 模板与建模对象冲突",
          field: "cadTemplate",
          details: { template, conflictingObjectIds: conflicts },
        });
      }
      validateFixedTemplateParameters(template, parameters);
      return accept(createPlan({
          mode: "fixed_template",
          instruction,
          objectId: template,
          provenance: "template",
          sourceIds: [],
          sourceSnapshots,
          parameters,
          allowAssumptions,
          ...templateConstraintFields(parameters),
          tutorialExample,
        }));
    }

    if (targetValue) {
      const targetObjectId = targetValue as CadObjectId;
      const conflicts = promptObjectIds.filter((objectId) => objectId !== targetObjectId);
      if (conflicts.length) {
        contractFailure({
          code: "cad_object_conflict",
          message: "CAD 建模要求中存在多个相互冲突的对象",
          field: "instruction",
          details: { selectedObjectId: targetObjectId, conflictingObjectIds: conflicts },
        });
      }
      return accept(createPlan({
          mode: "prompt_driven",
          instruction,
          objectId: targetObjectId,
          provenance: "prompt",
          sourceIds: [],
          sourceSnapshots,
          parameters,
          allowAssumptions,
          ...promptConstraintFields(instruction, allowAssumptions, targetObjectId),
        }));
    }

    const sourceDrivenRequested = !instruction || SOURCE_DRIVEN_DIRECTIVE.test(instruction);
    if (!sourceDrivenRequested) {
      if (promptObjectIds.length > 1) {
        contractFailure({
          code: "cad_object_conflict",
          message: "CAD 建模要求中存在多个对象，请明确本次生成哪一个",
          field: "instruction",
          details: { objectIds: promptObjectIds },
        });
      }
      if (promptObjectIds.length === 1) {
        return accept(createPlan({
            mode: "prompt_driven",
            instruction,
            objectId: promptObjectIds[0],
            provenance: "prompt",
            sourceIds: [],
            sourceSnapshots,
            parameters,
            allowAssumptions,
            ...promptConstraintFields(instruction, allowAssumptions, promptObjectIds[0]),
          }));
      }
      contractFailure({
        code: "cad_target_required",
        message: "请补充具体建模对象和关键尺寸后重试",
        field: "instruction",
        hint: "例如：生成 120×80×5mm 的四孔安装板",
      });
    }

    return accept(createSourceDrivenPlan());
  } catch (error) {
    if (error instanceof CadContractError) return failure(error);
    throw error;
  }
}

/** Throwing adapter for queue admission code that already has structured error handling. */
export function buildCadRequestPlan(
  input: CadRequestPlanInput
): { plan: CadRequestPlanV3; planHash: string } {
  const result = preflightCadRequest(input);
  if (!result.ok) {
    throw new CadContractError({
      code: result.error.code,
      message: result.error.message,
      field: result.error.field,
      hint: result.error.hint,
      details: result.error.details,
    });
  }
  return { plan: result.plan, planHash: result.plan.planHash };
}
