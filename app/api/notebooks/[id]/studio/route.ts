import { NextRequest, NextResponse } from "next/server";
import { countActiveJobsByUser, getJobByIdempotency, getNotebook, listActiveJobs, listSources, listStudioOutputs, quotaExceededMessage } from "@/lib/db";
import { creditCostForKind } from "@/lib/credits-config";
import { getAppConfig, isArtifactVisible } from "@/lib/app-config";
import { enqueueChargedArtifact } from "@/lib/jobs";
import { requireAccess, requireNotebookEditAccess } from "@/lib/auth";
import { requireRole } from "@/lib/admin";
import { recordEvent } from "@/lib/activity";
import { getEffectivePlanConfigForUser } from "@/lib/plans-config";
import type { StudioKind } from "@/lib/types";
import { isStudioKind, isStudioLanguage } from "@/lib/generation-contract";
import { normalizeStudioRequestOptions } from "@/lib/studio-request-contract";
import { cadRuntimeHealth } from "@/lib/cad";
import { text2cadRuntimeHealth } from "@/lib/text2cad";
import { MAX_CAD_SOURCE_CHARS, MAX_CAD_SOURCE_COUNT } from "@/lib/cad-source-budget";
import { CadPreflightBusyError, cadPreflightStatus, resolveCadPreflightGuarded } from "@/lib/cad-preflight-server";
import type { CadRequestPlanMode, CadRequestPlanV3 } from "@/lib/cad-request-plan";
import { hasUsageAccess } from "@/lib/membership";
import { MAX_ACTIVE_ARTIFACT_JOBS_PER_USER } from "@/lib/job-types";
import { consumeCadAdmissionRateLimit, consumeStudioAttemptRateLimit } from "@/lib/cad-admission-guard";
import { JsonBodyError, readJsonObjectLimited } from "@/lib/json-body";
import { isCadContractError } from "@/lib/cad-errors";
import { cadWorkerHeartbeatReady } from "@/lib/cad-worker-heartbeat";
import {
  CAD_LIBRARY_VERSION,
  CAD_TEMPLATES,
  TEXT2CAD_TEMPLATE,
  type CadArtifactTemplate,
} from "@/lib/cad-spec";
import { snapshotModelProviderRef } from "@/lib/user-model-config";

// L3:自定义文本字段长度上限,防超长 prompt 放大 token。
const MAX_PROMPT = 4000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id);
  if (g instanceof NextResponse) return g;
  const [outputs, jobs] = await Promise.all([
    listStudioOutputs(id),
    listActiveJobs(id),
  ]);
  // 失败任务只在后台保留审计、幂等与积分退回凭证，不进入用户的
  // 智能笔记记录。保留空字段兼容已加载的旧前端包。
  return NextResponse.json({ outputs, jobs, failedCadJobs: [] });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // L3:生成需编辑权限(此前只读协作者也能触发昂贵生成)。
  const guard = await requireNotebookEditAccess(req, id);
  if (guard instanceof NextResponse) return guard;
  const user = guard;
  const nb = await getNotebook(id);
  if (!nb) {
    return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  }
  const modelProviderRef = await snapshotModelProviderRef(user.id, nb);
  const attemptLimit = await consumeStudioAttemptRateLimit(user.id, id);
  if (!attemptLimit.ok) {
    return NextResponse.json(
      { error: "生成请求过于频繁，请稍后重试", code: "studio_rate_limited" },
      { status: 429, headers: { "Retry-After": String(attemptLimit.retryAfter) } }
    );
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonObjectLimited(req, 64 * 1024);
  } catch (error) {
    if (error instanceof JsonBodyError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  const rawKind = String(body.kind || "");
  if (!isStudioKind(rawKind)) return NextResponse.json({ error: "生成类型无效" }, { status: 400 });
  const kind = rawKind as StudioKind;
  const requestOptions = normalizeStudioRequestOptions(kind, {
    count: body.count,
    difficulty: body.difficulty,
  });
  if (!requestOptions.ok) return NextResponse.json({ error: requestOptions.error }, { status: 400 });
  const { count, difficulty } = requestOptions;
  // 用户可控 prompt 字段统一在这里归一；避免 API 调用者传 prompt/style/template
  // 得到 202，随后却被 worker 静默忽略。
  const cap = (v: unknown) => typeof v === "string" ? v.slice(0, MAX_PROMPT).trim() || undefined : undefined;
  const rawInstruction = cap(body.instruction);
  const rawPrompt = cap(body.prompt);
  const style = cap(body.style);
  const withStyle = (value?: string) => [value, style ? `样式要求:${style}` : ""].filter(Boolean).join("\n") || undefined;
  const instruction = kind === "custom" ? rawInstruction : withStyle(rawInstruction ?? rawPrompt);
  const prompt = kind === "custom" ? withStyle(rawPrompt ?? rawInstruction) : rawPrompt;
  const focus = (kind === "audio" || kind === "video")
    ? withStyle(cap(body.focus) ?? rawInstruction ?? rawPrompt)
    : cap(body.focus);
  const rawLanguage = typeof body.language === "string" ? body.language.trim() : "";
  if (rawLanguage && !isStudioLanguage(rawLanguage)) {
    return NextResponse.json({ error: "输出语言无效" }, { status: 400 });
  }
  const language = rawLanguage || undefined;
  const rawCadTemplate = typeof body.cadTemplate === "string" ? body.cadTemplate.trim() : "";
  if (
    kind === "cad"
    && rawCadTemplate
    && rawCadTemplate !== "auto"
    && !(CAD_TEMPLATES as readonly string[]).includes(rawCadTemplate)
    && rawCadTemplate !== TEXT2CAD_TEMPLATE
  ) {
    return NextResponse.json({ error: "CAD 模型库模板无效" }, { status: 400 });
  }
  const cadTemplate = kind === "cad" && rawCadTemplate && rawCadTemplate !== "auto"
    ? rawCadTemplate as CadArtifactTemplate
    : undefined;
  const rawCadMode = typeof body.cadMode === "string" ? body.cadMode.trim() : "";
  const cadMode = kind === "cad" && ["source_driven", "prompt_driven", "fixed_template"].includes(rawCadMode)
    ? rawCadMode as CadRequestPlanMode
    : undefined;
  if (kind === "cad" && rawCadMode && !cadMode) {
    return NextResponse.json({ error: "CAD 建模方式无效", code: "cad_request_invalid" }, { status: 400 });
  }
  if (kind === "cad" && !cadMode) {
    return NextResponse.json(
      { error: "CAD 生成必须先选择建模方式并完成免费预检", code: "cad_preflight_required" },
      { status: 400 }
    );
  }
  const submittedCadPlanHash = kind === "cad" && typeof body.cadPreflightPlanHash === "string"
    ? body.cadPreflightPlanHash.trim()
    : "";
  const cadIdempotencyKey = kind === "cad" && typeof body.cadIdempotencyKey === "string"
    ? body.cadIdempotencyKey.trim().toLowerCase()
    : "";
  if (kind === "cad" && cadMode && cadIdempotencyKey && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(cadIdempotencyKey)) {
    return NextResponse.json({ error: "CAD 生成请求缺少有效幂等键，请重新预检", code: "cad_idempotency_required" }, { status: 400 });
  }
  const theme = typeof (body.theme ?? body.template) === "string"
    ? String(body.theme ?? body.template).slice(0, 100)
    : undefined;
  // 后台隐藏的输出类型默认服务端拒绝。只有具备“应用设置”写权限的 super/operator
  // 可用于验收；super 在独立管理员模式下还必须携带短期管理 Cookie。auditor 只读，
  // 普通 nb_session 或直接绕 API 都不能穿透下架开关。
  const appConfig = await getAppConfig();
  if (!isArtifactVisible(kind, appConfig, false)) {
    const elevated = await requireRole(req, "settings", { write: true });
    if (elevated instanceof NextResponse) {
      return NextResponse.json({ error: "该智能输出类型暂未开放" }, { status: 403 });
    }
  }
  // 响应丢失后，来源可能已被重新摄取。幂等恢复只用“原 key + 原 planHash”
  // 识别已扣费任务，必须早于任何当前来源重算、在途上限、余额和 runtime 体检。
  if (kind === "cad" && cadMode && cadIdempotencyKey && /^[a-f0-9]{64}$/.test(submittedCadPlanHash)) {
    let existing = await getJobByIdempotency(user.id, cadIdempotencyKey);
    for (let attempt = 0; existing?.status === "draft" && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      existing = await getJobByIdempotency(user.id, cadIdempotencyKey);
    }
    if (existing) {
      let existingPlanHash = "";
      try { existingPlanHash = String((JSON.parse(existing.params || "{}") as { cadPreflightPlanHash?: unknown }).cadPreflightPlanHash || ""); }
      catch { /* mismatch below */ }
      if (existing.notebook_id !== id || existing.kind !== "cad" || existingPlanHash !== submittedCadPlanHash) {
        return NextResponse.json({ error: "CAD 幂等键已绑定另一个请求", code: "cad_idempotency_conflict" }, { status: 409 });
      }
      if (existing.status === "draft") {
        return NextResponse.json({ error: "CAD 请求正在原子扣费入队，请稍后用同一请求编号重试", code: "cad_idempotency_pending" }, { status: 409 });
      }
      return NextResponse.json({
        job: existing,
        reused: true,
        billing: { reservedCredits: Number(existing.credits_reserved ?? 0), settlement: "actual_tokens" },
      }, { status: 202 });
    }
  }
  if (kind === "custom" && !prompt) {
    return NextResponse.json({ error: "请描述你想要的报告" }, { status: 400 });
  }
  if (kind === "timeline" && (instruction || focus || language)) {
    return NextResponse.json(
      { error: "时间线为原文日期的确定性生成，不支持改写、翻译或补充说明" },
      { status: 400 }
    );
  }
  // CAD 的当前来源重算最多需读取/哈希 2MiB。幂等恢复已在上方提前返回；
  // 新请求先过余额、在途任务与多实例共享限流，再进入重型免费预检重算。
  if (kind === "cad") {
    const worker = await cadWorkerHeartbeatReady();
    if (!worker.ok) {
      return NextResponse.json(
        { error: worker.error, code: "cad_worker_unavailable" },
        { status: 503, headers: { "Retry-After": "10" } }
      );
    }
    if (!hasUsageAccess(user)) {
      return NextResponse.json(
        { error: "积分不足，可通过邀请活动获取积分或联系管理员补充", code: "quota" },
        { status: 429 }
      );
    }
    if ((await countActiveJobsByUser(user.id)) >= MAX_ACTIVE_ARTIFACT_JOBS_PER_USER) {
      return NextResponse.json(
        { error: "生成任务排队过多,请等当前任务完成后再试", code: "inflight_limit" },
        { status: 429 }
      );
    }
    const limit = await consumeCadAdmissionRateLimit("enqueue", user.id, id);
    if (!limit.ok) {
      return NextResponse.json(
        { error: "CAD 生成请求过于频繁，请稍后重试", code: "cad_enqueue_rate_limited" },
        { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
      );
    }
  }
  const requestedSourceIds = Array.isArray(body.sourceIds)
    ? [...new Set(
        (body.sourceIds.filter((s: unknown) => typeof s === "string") as string[])
          .map((sourceId) => sourceId.trim())
          .filter((sourceId) => sourceId && !sourceId.startsWith("__"))
      )]
    : undefined;
  const sourceIds = kind === "cad" && (cadMode === "prompt_driven" || cadMode === "fixed_template")
    ? []
    : requestedSourceIds;
  if (kind !== "cad" && Array.isArray(body.sourceIds) && !sourceIds?.length) {
    return NextResponse.json({ error: "请至少勾选一个来源后再生成" }, { status: 400 });
  }
  if (kind === "cad" && sourceIds?.length) {
    if ((sourceIds?.length ?? 0) > MAX_CAD_SOURCE_COUNT) {
      return NextResponse.json({ error: `CAD 每次最多选择 ${MAX_CAD_SOURCE_COUNT} 个来源` }, { status: 400 });
    }
    const readySources = (await listSources(id)).filter((source) => source.status === "ready");
    const readyIds = new Set(readySources.map((source) => source.id));
    if (sourceIds?.some((sourceId) => !readyIds.has(sourceId))) {
      return NextResponse.json({ error: "CAD 取材范围包含无效或未就绪的来源" }, { status: 400 });
    }
    const requested = new Set(sourceIds);
    const selectedChars = readySources
      .filter((source) => requested.has(source.id))
      .reduce((sum, source) => sum + Math.max(0, Number(source.char_count) || 0), 0);
    if (selectedChars > MAX_CAD_SOURCE_CHARS) {
      return NextResponse.json({ error: "CAD 所选来源正文过长，请缩小取材范围后重试" }, { status: 400 });
    }
  }
  let cadRequestPlan: CadRequestPlanV3 | undefined;
  if (kind === "cad" && cadMode) {
    let resolved;
    try {
      resolved = await resolveCadPreflightGuarded(id, {
        mode: cadMode,
        sourceIds,
        instruction,
        templateId: rawCadTemplate || undefined,
        targetObjectId: typeof body.targetObjectId === "string" ? body.targetObjectId : undefined,
        parameters: body.cadParameters,
        allowAssumptions: body.cadAllowAssumptions,
        tutorialExample: body.cadTutorialExample,
      }, { cache: false });
    } catch (error) {
      if (error instanceof CadPreflightBusyError) {
        return NextResponse.json(
          { error: error.message, code: "cad_preflight_busy" },
          { status: 429, headers: { "Retry-After": "2" } }
        );
      }
      throw error;
    }
    if (!resolved.result.ok) {
      return NextResponse.json({
        status: cadPreflightStatus(resolved.result),
        code: resolved.result.error.code,
        error: resolved.result.error.message,
        issues: [resolved.result.error],
      }, { status: 422 });
    }
    if (!/^[a-f0-9]{64}$/.test(submittedCadPlanHash)) {
      return NextResponse.json({
        error: "请先完成 CAD 免费预检后再生成",
        code: "cad_preflight_required",
      }, { status: 409 });
    }
    if (submittedCadPlanHash !== resolved.result.plan.planHash) {
      return NextResponse.json({
        error: "CAD 目标、参数或来源在预检后已变化，请重新检查",
        code: "cad_preflight_stale",
      }, { status: 409 });
    }
    cadRequestPlan = resolved.result.plan;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(cadIdempotencyKey)) {
      return NextResponse.json({
        error: "CAD 生成请求缺少有效幂等键，请重新预检",
        code: "cad_idempotency_required",
      }, { status: 400 });
    }
  }
  if (kind !== "cad" && !hasUsageAccess(user)) {
    return NextResponse.json(
      { error: "积分不足，可通过邀请活动获取积分或联系管理员补充", code: "quota" },
      { status: 429 }
    );
  }
  // M9:在途任务上限,防单用户连发数百次灌满全局单 worker。紧贴 enqueue。
  if (kind !== "cad" && (await countActiveJobsByUser(user.id)) >= MAX_ACTIVE_ARTIFACT_JOBS_PER_USER) {
    return NextResponse.json(
      { error: "生成任务排队过多,请等当前任务完成后再试" },
      { status: 429 }
    );
  }
  // 冷启动几何体检会加载 OCCT/WASM；先拦截无效请求与超额在途任务，
  // 再进入进程级 singleflight 体检，避免未扣费并发请求放大内存。
  if (kind === "cad") {
    const health = !cadTemplate || cadTemplate === TEXT2CAD_TEMPLATE
      ? await text2cadRuntimeHealth()
      : await cadRuntimeHealth();
    if (!health.ok) {
      return NextResponse.json({ error: health.error, code: "cad_runtime_unavailable" }, { status: 503 });
    }
  }
  const cost = await creditCostForKind(kind); // 后台可调价,读当前生效单价
  // 水印权益按发起/扣减时快照，排队跨到期点也不能改变请求的水印状态。
  const watermarkAtCharge = (await getEffectivePlanConfigForUser(user)).watermark;
  let queued;
  try {
    // draft job → 双桶扣费 → ledgerId/预留价写回 → queued 在一个数据库事务内激活。
    queued = await enqueueChargedArtifact(id, user.id, kind, cost, nb.title, {
      sourceIds,
      format: typeof body.format === "string" ? body.format : undefined,
      focus,
      length: typeof body.length === "string" ? body.length : undefined,
      audience: cap(body.audience),
      prompt,
      instruction,
      language,
      theme,
      difficulty: difficulty ?? undefined,
      count: count ?? undefined,
      cadTemplate,
      cadSelectionMode: kind === "cad" ? (cadTemplate ? "manual" : "auto") : undefined,
      cadLibraryVersion: kind === "cad" ? CAD_LIBRARY_VERSION : undefined,
      cadMode: cadRequestPlan?.mode,
      cadParameters: cadRequestPlan?.parameters,
      cadTargetObjectId: cadRequestPlan?.target.objectId,
      cadAllowAssumptions: cadRequestPlan?.allowAssumptions,
      cadPreflightPlanHash: cadRequestPlan?.planHash,
      cadRequestPlan,
      cadPipelineVersion: cadRequestPlan ? 3 : undefined,
      cadIdempotencyKey,
      cadTutorialExample: kind === "cad" && body.cadTutorialExample === true ? true : undefined,
      __watermark: watermarkAtCharge,
      // C5 音频音色组合:预设 key 白名单透传(未知 key 在 lib/tts 查表落空 → 默认对,无需校验)。
      voices: typeof body.voices === "string" ? body.voices : undefined,
      // 只冻结无密钥的数据路由引用。worker 必须按相同 revision 解密，禁止取最新配置。
      __modelProviderRef: modelProviderRef,
    });
  } catch (error) {
    if (isCadContractError(error) && error.code === "cad_idempotency_conflict") {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 409 }
      );
    }
    console.error("[studio] 入队失败:", error);
    return NextResponse.json({ error: "生成任务创建失败，未扣除积分，请重试" }, { status: 500 });
  }
  if (queued.activeLimitExceeded) {
    return NextResponse.json(
      { error: "生成任务排队过多,请等当前任务完成后再试", code: "inflight_limit" },
      { status: 429 }
    );
  }
  if (queued.over || !queued.job) {
    return NextResponse.json(
      {
        error: quotaExceededMessage(queued, cost),
        code: "quota",
      },
      { status: 429 }
    );
  }
  const job = queued.job;
  await recordEvent({
    actorId: user.id,
    actorKind: "user",
    action: "studio.generate",
    targetType: "job",
    targetId: job.id,
    notebookId: id,
    meta: {
      kind,
      sources: sourceIds?.length,
      ...(kind === "cad" ? {
        cadSelectionMode: cadTemplate ? "manual" : "auto",
        cadTemplate: cadTemplate ?? null,
        cadLibraryVersion: CAD_LIBRARY_VERSION,
        cadMode: cadRequestPlan?.mode ?? null,
        cadPipelineVersion: cadRequestPlan ? 3 : null,
        cadPreflightPlanHash: cadRequestPlan?.planHash ?? null,
        cadIdempotencyKey: cadIdempotencyKey ?? null,
      } : {}),
    },
  });
  return NextResponse.json(
    {
      job,
      billing: {
        reservedCredits: cost,
        settlement: "actual_tokens",
      },
    },
    { status: 202 }
  );
}
