import { getSource, listSources } from "./db";
import {
  CAD_REQUEST_PLAN_MODES,
  preflightCadRequest,
  type CadPlanParameterValue,
  type CadPreflightSource,
  type CadPreflightResult,
  type CadRequestPlanInput,
  type CadRequestPlanMode,
} from "./cad-request-plan";
import { MAX_CAD_SOURCE_CHARS } from "./cad-source-limits";
import { CadContractError } from "./cad-errors";

const MAX_PARAMETER_FIELDS = 64;

export type CadPreflightBody = Readonly<{
  mode?: unknown;
  sourceIds?: unknown;
  instruction?: unknown;
  templateId?: unknown;
  cadTemplate?: unknown;
  targetObjectId?: unknown;
  parameters?: unknown;
  allowAssumptions?: unknown;
  tutorialExample?: unknown;
}>;

export type ResolvedCadPreflight = Readonly<{
  result: CadPreflightResult;
  sourceIds: string[];
  input: CadRequestPlanInput;
}>;

type CadPreflightRuntime = {
  active: number;
  inflight: Map<string, Promise<ResolvedCadPreflight>>;
  cache: Map<string, { expiresAt: number; value: ResolvedCadPreflight }>;
};

const runtimeGlobal = globalThis as unknown as { __cadPreflightRuntime?: CadPreflightRuntime };
const preflightRuntime = (runtimeGlobal.__cadPreflightRuntime ??= {
  active: 0,
  inflight: new Map(),
  cache: new Map(),
});
const MAX_CONCURRENT_INTERACTIVE_PREFLIGHT = 4;
const INTERACTIVE_PREFLIGHT_CACHE_MS = 3_000;

export class CadPreflightBusyError extends Error {
  constructor() {
    super("CAD 预检服务繁忙，请稍后重试");
    this.name = "CadPreflightBusyError";
  }
}

function interactivePreflightKey(notebookId: string, body: CadPreflightBody): string {
  const normalized = {
    notebookId,
    mode: body.mode ?? null,
    sourceIds: sourceIdsOf(body.sourceIds).sort(),
    instruction: instructionOf(body.instruction) ?? null,
    templateId: body.templateId ?? body.cadTemplate ?? null,
    targetObjectId: body.targetObjectId ?? null,
    parameters: parametersOf(body.parameters) ?? null,
    allowAssumptions: body.allowAssumptions === true,
    tutorialExample: body.tutorialExample === true,
  };
  return JSON.stringify(normalized);
}

export function cadPreflightStatus(result: CadPreflightResult):
  | "ready"
  | "needs_input"
  | "conflict"
  | "unsupported" {
  if (result.ok) return "ready";
  if (result.error.code === "cad_capability_limit") return "unsupported";
  if (result.error.code === "cad_object_conflict" || result.error.code === "cad_source_conflict" || result.error.code === "cad_template_conflict") {
    return "conflict";
  }
  return "needs_input";
}

function requestedMode(value: unknown): CadRequestPlanMode | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" && (CAD_REQUEST_PLAN_MODES as readonly string[]).includes(value)
    ? value as CadRequestPlanMode
    : undefined;
}

function sourceIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item && !item.startsWith("__"))
  )];
}

function instructionOf(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 4_001) : undefined;
}

function parametersOf(value: unknown): Record<string, CadPlanParameterValue> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { __invalid: null };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PARAMETER_FIELDS) return { __invalid: null };
  const parameters: Record<string, CadPlanParameterValue> = {};
  for (const [key, raw] of entries) {
    if (typeof raw === "number" || typeof raw === "boolean" || raw === null) {
      parameters[key] = raw;
      continue;
    }
    if (typeof raw !== "string") {
      parameters[key] = null;
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const numeric = Number(trimmed);
    parameters[key] = Number.isFinite(numeric) && /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)
      ? numeric
      : trimmed;
  }
  return parameters;
}

/**
 * Resolve an authorized notebook's source snapshot and run the pure v3 CAD
 * admission contract. This function never calls a model, creates a job, or
 * charges credits, so both the preflight route and the enqueue route can
 * recompute exactly the same plan without trusting the browser's copy.
 */
export async function resolveCadPreflight(
  notebookId: string,
  body: CadPreflightBody
): Promise<ResolvedCadPreflight> {
  const tutorialExample = body.tutorialExample === true;
  const mode = tutorialExample ? "fixed_template" : requestedMode(body.mode);
  const templateCandidate = tutorialExample
    ? "plate"
    : typeof body.templateId === "string"
      ? body.templateId
      : typeof body.cadTemplate === "string"
        ? body.cadTemplate
        : undefined;
  const baseInput: CadRequestPlanInput = {
    mode,
    instruction: tutorialExample ? undefined : instructionOf(body.instruction),
    templateId: templateCandidate,
    targetObjectId: typeof body.targetObjectId === "string" ? body.targetObjectId : undefined,
    parameters: parametersOf(body.parameters),
    allowAssumptions: tutorialExample ? true : body.allowAssumptions === true,
    tutorialExample,
    sources: [],
  };
  // 模式/参数/自由文本不合法时先结束，不读取最多 24 份 2MiB 正文。
  if (mode === "source_driven") {
    const cheap = preflightCadRequest(baseInput);
    if (!cheap.ok && [
      "cad_request_invalid",
      "cad_template_invalid",
      "cad_template_conflict",
      "cad_capability_limit",
      "cad_target_required",
    ].includes(cheap.error.code)) {
      return { result: cheap, sourceIds: [], input: baseInput };
    }
  }
  // 三种模式的证据权威必须互斥：只有 source-driven 会把来源带入计划/语料。
  // prompt/fixed 中即使浏览器仍携带了左栏勾选，也不能让无关来源为几何尺寸作证。
  const sourceIds = mode === "source_driven" || mode === undefined ? sourceIdsOf(body.sourceIds) : [];
  const allSources = sourceIds.length ? await listSources(notebookId) : [];
  const requested = new Set(sourceIds);
  const selected = allSources.filter((source) => requested.has(source.id));
  const metadataChars = selected.reduce((sum, source) => (
    sum + Math.max(0, Number(source.char_count) || 0)
  ), 0);
  if (metadataChars > MAX_CAD_SOURCE_CHARS) {
    const error = new CadContractError({
      code: "cad_source_budget_exceeded",
      message: "CAD 所选来源正文过长，请缩小取材范围后重试",
      field: "sourceIds",
    });
    return { result: { ok: false, error: error.toJSON() }, sourceIds, input: baseInput };
  }

  // Unknown IDs must be represented as unavailable inputs rather than silently
  // disappearing; otherwise a stale browser selection could hash a different
  // source set and still enqueue.
  const selectedById = new Map(selected.map((source) => [source.id, source]));
  const sources: CadPreflightSource[] = [];
  for (const sourceId of sourceIds) {
    const source = selectedById.get(sourceId);
    if (!source) {
      sources.push({ id: sourceId, title: "", content: "", status: "error" });
      continue;
    }
    const content = (await getSource(sourceId))?.content ?? "";
    sources.push({
      id: source.id,
      title: source.title,
      content,
      status: source.status === "ready" ? "ready" : source.status === "processing" ? "processing" : "error",
    });
  }

  const input: CadRequestPlanInput = {
    ...baseInput,
    sources,
  };
  return { result: preflightCadRequest(input), sourceIds, input };
}

/**
 * 交互请求专用的小并发槽 + singleflight。免费预检可短暂复用相同结果；
 * 真正入队仅合并同时到达的完全相同请求，不读 TTL 缓存。worker 始终调用
 * resolveCadPreflight 原语义重算，不受交互槽和缓存影响。
 */
export async function resolveCadPreflightGuarded(
  notebookId: string,
  body: CadPreflightBody,
  options: { cache?: boolean } = {}
): Promise<ResolvedCadPreflight> {
  const key = `${options.cache === false ? "strict" : "cached"}:${interactivePreflightKey(notebookId, body)}`;
  const now = Date.now();
  for (const [cachedKey, cached] of preflightRuntime.cache) {
    if (cached.expiresAt <= now) preflightRuntime.cache.delete(cachedKey);
  }
  if (options.cache !== false) {
    const cached = preflightRuntime.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
  }
  const inflight = preflightRuntime.inflight.get(key);
  if (inflight) return inflight;
  if (preflightRuntime.active >= MAX_CONCURRENT_INTERACTIVE_PREFLIGHT) {
    throw new CadPreflightBusyError();
  }
  preflightRuntime.active++;
  const pending = resolveCadPreflight(notebookId, body);
  preflightRuntime.inflight.set(key, pending);
  try {
    const value = await pending;
    if (options.cache !== false) {
      // 缓存只保留计划/哈希，不在全局 Map 里留住最多 2MiB 的来源正文。
      const cacheValue: ResolvedCadPreflight = {
        ...value,
        input: { ...value.input, sources: [] },
      };
      preflightRuntime.cache.set(key, {
        expiresAt: Date.now() + INTERACTIVE_PREFLIGHT_CACHE_MS,
        value: cacheValue,
      });
      if (preflightRuntime.cache.size > 16) {
        [...preflightRuntime.cache.entries()]
          .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
          .slice(0, preflightRuntime.cache.size - 16)
          .forEach(([cachedKey]) => preflightRuntime.cache.delete(cachedKey));
      }
    }
    return value;
  } finally {
    preflightRuntime.inflight.delete(key);
    preflightRuntime.active = Math.max(0, preflightRuntime.active - 1);
  }
}
