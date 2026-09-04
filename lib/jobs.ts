import { activateChargedJob, awardReferralMilestone, claimNextQueued, cleanupStaleDraftJobs, countActiveArtifactJobs, countQueuedJobs, createCadRevisionJobAtomic, createJob, createNotification, createStudioOutputForRun, deleteDraftJob, deleteStudioOutput, failJobAndQueueRefund, finalizeJobDone, getJob, getJobByIdempotency, getNotebook, getSetting, getStudioOutput, getStudioOutputAny, getUserById, listProcessingJobOutputs, listSources, listStudioOutputs, listSupersededJobOutputs, listTerminalProcessingOutputs, processCreditRefundOutbox, recoverStaleJobsInDb, requeueJobForRetry, setJobReservedCredits, setNotebookOverview, sweepStaleJobs, updateJobForRun } from "./db";
import { generateNotebookOverview } from "./rag";
import {
  FEED_BATCH_SIZE,
  bumpFeedDailyIngested,
  claimDueFeedChannels,
  claimFeedBatch,
  claimFeedItemForIngest,
  cleanupFeedRetention,
  compensateStaleFeedClaims,
  feedDailyRemaining,
  feedPollSuccess,
  finishBackfillIfDrained,
  getFeedChannel,
  getSource,
  listBatchItems,
  listBatchPendingItems,
  listSubscriberIds,
  markFeedContent,
  reclaimOrphanFeedBatches,
  recordFeedItem,
  releaseFeedItemForRetry,
  renewFeedLease,
  setFeedItemStatus,
  upsertFeedBriefNote,
} from "./db";
import { buildFeedBrief, enumerateChannel } from "./feeds";
import { addUrlSource } from "./ingest";
import { resolveWorkerGates, type WorkerGates } from "./worker-gates";

// 篇间错峰间隔:嵌入是全局单 fork 子进程,批量入库会拖慢全站检索。
const FEED_ITEM_PACING_MS = 2_000;
import { creditCostForKind } from "./credits-config";
import { finalStudioCreditsForOutput, studioCreditsFromTokenUsage } from "./credits";
import { MAX_CAD_SOURCE_COUNT } from "./cad-source-budget";
import { withAiUsageMeter } from "./ai-usage-context";
import { withUserModelRuntime } from "./ai-provider-context";
import { parseModelProviderRef, resolveUserModelRuntimeForNotebook, type ModelProviderRef } from "./user-model-config";
import { getEffectivePlanConfigForUser } from "./plans-config";
import { getFeatureFlag } from "./flags";
import { getNotebookDirective } from "./settings";
import {
  generateCustomReport,
  generateFlashcards,
  generateMindmap,
  generateQuiz,
  prepareQuizGenerationInput,
  quizFromCorpus,
  generateReport,
  isReportKind,
} from "./studio";
import { AUDIO_DIR, commitAudioFile, generateAudioOverview } from "./audio";
import { VIDEO_DIR, commitVideoFile, generateVideoOverview } from "./video";
import { commitInfographicPng, generateInfographic, INFOGRAPHIC_DIR } from "./infographic";
import { commitXhsCards, generateXhsCards, XHS_DIR } from "./xhs";
import { generateSlides } from "./slides";
import { generateExcalidraw } from "./excalidraw";
import { generateDrawviso } from "./drawviso";
import { cleanupStaleCadTemps, commitCadBundle, discardCadTemp } from "./cad";
import { rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deleteOutputMedia } from "./media";
import type { Job, StudioKind } from "./types";
import type { QuotaChargeResult } from "./db";
import {
  cadJobProgressForStage,
  cadJobStageFromProgress,
  MAX_ACTIVE_ARTIFACT_JOBS_PER_USER,
  type CadJobRunningStage,
  type CadJobStageUpdate,
} from "./job-types";
import { CadContractError, isCadContractError } from "./cad-errors";
import { resolveCadPreflight } from "./cad-preflight-server";
import {
  CAD_LIBRARY_VERSION,
  CAD_TEMPLATES,
  TEXT2CAD_TEMPLATE,
  type CadArtifactTemplate,
} from "./cad-spec";
import {
  canonicalCadRequestPlanHash,
  cadTargetEvidenceText,
  type CadPreflightSource,
  type CadRequestPlanMode,
  type CadRequestPlanV3,
} from "./cad-request-plan";

const KIND_TITLE: Record<string, string> = {
  audio: "音频概览",
  video: "视频概览",
  mindmap: "思维导图",
  infographic: "信息图",
  xhs: "小红书卡组",
  slides: "幻灯片",
  excalidraw: "画板",
  drawviso: "专业图表",
  flashcards: "闪卡",
  quiz: "测验",
  custom: "自定义报告",
  study_guide: "学习指南",
  briefing: "简报",
  faq: "常见问答",
  timeline: "时间线",
  toc: "目录",
  blog: "博客",
  cad: "CAD 模型",
};

type Params = {
  sourceIds?: string[];
  format?: string;
  focus?: string;
  length?: string;
  audience?: string;
  prompt?: string;
  /** 生成配置弹窗:自定义指令 / 语言 / 主题配色 */
  instruction?: string;
  language?: string;
  theme?: string;
  /** 测验:难度(easy|medium|hard)与题量 */
  difficulty?: string;
  count?: number;
  /** 音频:音色组合预设 key(components/studio-shared VOICE_PRESETS);空/未知=默认对 */
  voices?: string;
  /** CAD 模型库显式选择；空值=自动走 Text2CAD V2。 */
  cadTemplate?: string;
  cadSelectionMode?: "auto" | "manual";
  cadLibraryVersion?: number;
  /** CAD v3 的免费预检冻结快照；旧任务不含这些字段，继续按 v2 读取。 */
  cadMode?: CadRequestPlanMode;
  cadParameters?: Readonly<Record<string, string | number | boolean | null>>;
  cadTargetObjectId?: string;
  cadAllowAssumptions?: boolean;
  cadPreflightPlanHash?: string;
  cadRequestPlan?: CadRequestPlanV3;
  cadPipelineVersion?: number;
  cadIdempotencyKey?: string;
  cadTutorialExample?: boolean;
  /** CAD 在线参数编辑：按父制品与 hash 锁定，只接受服务端再次校验的受控 patch。 */
  cadRevision?: {
    parentOutputId: string;
    baseHash: string;
    targetHash: string;
    patch: unknown;
  };
  /** 路由原子扣减后写入；积分退回与最终 Token 结算必须使用这一刻的权重。 */
  __reservedCredits?: number;
  __creditLedgerId?: number;
  /** 扣费/入队时的水印权益快照，避免排队跨会员到期点后漂移。 */
  __watermark?: boolean;
  /** 管理员/平台赞助任务：保留发起人记忆，但不向其积分账户扣费。 */
  __sponsored?: boolean;
  /** 人工重试次数由服务端原子递增；最多一次，防止重复点击无限烧供应商成本。 */
  __adminRetryCount?: number;
  /** 不调用模型的确定性重建任务。仅 CAD 参数修订入口可写，不计模型积分。 */
  __deterministic?: boolean;
  /** 入队时冻结的模型数据路由；只含 providerId/revision，绝不保存密钥或 URL。 */
  __modelProviderRef?: ModelProviderRef;
};

export async function assertCadRequestPlanStillCurrent(args: {
  notebookId: string;
  sourceIds?: string[];
  instruction?: string;
  cadTemplate?: string;
  cadParameters?: Readonly<Record<string, string | number | boolean | null>>;
  cadTargetObjectId?: string;
  cadAllowAssumptions?: boolean;
  cadTutorialExample?: boolean;
  plan: CadRequestPlanV3;
}): Promise<readonly CadPreflightSource[]> {
  const current = await resolveCadPreflight(args.notebookId, {
    mode: args.plan.mode,
    sourceIds: args.sourceIds,
    instruction: args.instruction,
    templateId: args.cadTemplate,
    parameters: args.cadParameters,
    targetObjectId: args.cadTargetObjectId,
    allowAssumptions: args.cadAllowAssumptions,
    tutorialExample: args.cadTutorialExample,
  });
  if (!current.result.ok) {
    throw new CadContractError({
      code: current.result.error.code,
      message: current.result.error.message,
      field: current.result.error.field,
      hint: current.result.error.hint,
      details: current.result.error.details,
    });
  }
  if (current.result.plan.planHash !== args.plan.planHash) {
    throw new CadContractError({
      code: "cad_source_conflict",
      message: "CAD 来源或约束在排队期间已变化，请重新预检",
      field: "sourceIds",
      details: {
        admittedPlanHash: args.plan.planHash,
        currentPlanHash: current.result.plan.planHash,
      },
    });
  }
  return current.input.sources;
}

function creditLedgerIdOf(job: Job): number | undefined {
  try {
    const id = Number((JSON.parse(job.params || "{}") as Params).__creditLedgerId ?? 0);
    return id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function sponsoredJob(job: Job): boolean {
  try {
    return (JSON.parse(job.params || "{}") as Params).__sponsored === true;
  } catch {
    return false;
  }
}

/**
 * 纯状态机判定：只有「仍在 running 且认领代次完全相同」才是本跑。
 *
 * 不能只看 status=running：旧跑超时后会被重排，新跑也是 running。
 * 此函数保持纯函数，便于对「取消 / 重排 / 新跑」做状态机回归；
 * 真正写入仍必须由 DB 的 status + run_attempt 条件更新做原子仲裁。
 */
export function isCurrentJobRun(
  snapshot: Pick<Job, "status" | "run_attempt"> | null | undefined,
  expectedAttempt: number
): boolean {
  return (
    snapshot?.status === "running" &&
    Number.isInteger(expectedAttempt) &&
    expectedAttempt > 0 &&
    Number(snapshot.run_attempt) === expectedAttempt
  );
}

/** CAD 是可中止的重任务；取消、重排或新 attempt 接管后必须立即终止底层请求/子进程。 */
export function abortGenerationWhenRunLost(
  controller: AbortController | undefined,
  snapshot: Pick<Job, "status" | "run_attempt"> | null | undefined,
  expectedAttempt: number
): boolean {
  if (!controller || isCurrentJobRun(snapshot, expectedAttempt)) return false;
  controller.abort();
  return true;
}

/** 兼容既有 CAD 状态机测试/调用名。 */
export const abortCadWhenRunLost = abortGenerationWhenRunLost;

function claimedRunAttempt(job: Job): number {
  const attempt = Number(job.run_attempt);
  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw new Error(`任务 ${job.id} 缺少有效的 run_attempt，拒绝无栅栏执行`);
  }
  return attempt;
}

/** 本跑已被取消、重排或更新代次取代；旧跑只能静默放弃。 */
class JobRunLostError extends Error {
  constructor() {
    super("job run superseded");
    this.name = "JobRunLostError";
  }
}

/**
 * 失权旧跑的产物补偿清理。studio_outputs 行与本地媒体要一起撤掉；
 * xhs 是目录而 deleteOutputMedia 只处理单文件，所以在此额外清理。OSS
 * 旁标也不应留下指向已不存在制品的入口。全部 best-effort，不得让
 * 清理失败反过来帮旧跑取得终判权。
 */
async function discardStudioOutput(outputId: string): Promise<void> {
  await Promise.allSettled([
    deleteStudioOutput(outputId),
    deleteOutputMedia(outputId),
    rm(path.join(XHS_DIR, outputId), { recursive: true, force: true }),
    rm(path.join(XHS_DIR, `${outputId}.osskey`), { force: true }),
    rm(path.join(AUDIO_DIR, `${outputId}.osskey`), { force: true }),
    rm(path.join(VIDEO_DIR, `${outputId}.osskey`), { force: true }),
    rm(path.join(INFOGRAPHIC_DIR, `${outputId}.osskey`), { force: true }),
  ]);
}

export async function cleanupProcessingJobOutputs(jobId: string): Promise<void> {
  for (const output of await listProcessingJobOutputs(jobId)) {
    await discardStudioOutput(output.id);
  }
}

async function cleanupTerminalProcessingOutputs(): Promise<void> {
  for (const output of await listTerminalProcessingOutputs()) {
    await discardStudioOutput(output.id);
  }
}

/** Run one artifact-generation job; returns the created studio_output id. */
async function runArtifactJob(
  job: Job,
  expectedAttempt: number,
  signal?: AbortSignal,
  onCadStage?: CadJobStageUpdate
): Promise<string> {
  const p: Params = job.params ? JSON.parse(job.params) : {};
  // 取消 / 跑代守卫:LLM 生成完成、写产物之前统一在 createStudioOutput
  // 入口检查任务是否仍属于本次 run_attempt(免得每个 kind 分支各查一遍)。
  // 已取消 / 重排 / 新跑接管 → 抛 JobRunLostError 丢弃产物;audio/video
  // 分支的临时媒体文件走各自 catch 的 best-effort 清理后原样上抛。
  // 'queued' 同样中止:本次执行已被孤儿回收误判并重排队(心跳停摆场景),新一跑随后
  // 接手 —— 旧跑手静默放弃,避免双跑双产物(finalize 条件更新是最后一道仲裁)。
  const createOutput = async (
    notebookId: string,
    kind: StudioKind,
    title: string,
    content: string,
    outputData: string | null = null
  ) => {
    // 【产物栅栏】「先 getJob 再 INSERT」存在 TOCTOU：检查后、落库前
    // 可能恰好被重排并开始新一跑。因此检查和 studio_outputs INSERT
    // 必须由 DB 在同一事务内完成。undefined = 本跑已丢失所有权。
    const out = await createStudioOutputForRun(
      job.id,
      expectedAttempt,
      notebookId,
      kind,
      title,
      content,
      outputData
    );
    if (!out) throw new JobRunLostError();
    return out;
  };
  const finishOutput = async (out: { id: string }): Promise<string> => {
    // 【返回前二次栅栏】媒体制品的时间线是：原子 INSERT output →
    // commit 本地/OSS → return。若硬超时恰发生在 INSERT 之后、return 之前，
    // 外层 Promise.race 拿不到 outputId，只能靠这里在底层生成继续返回时
    // 识别已换代。updateJobForRun 的空 patch 是原子心跳/CAS；失败就撤掉
    // 刚落的行与媒体，绝不把 outputId 交给旧跑继续收尾。
    if (await updateJobForRun(job.id, expectedAttempt, {})) return out.id;
    await discardStudioOutput(out.id);
    throw new JobRunLostError();
  };
  const sourceIds = Array.isArray(p.sourceIds)
    ? [...new Set(
        p.sourceIds
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("__"))
      )]
    : undefined;
  const nb = job.notebook_id;
  // 系统任务(feed_*)在 runOne 已分派,绝不该进到这里 —— 类型收窄 + 运行时双保险。
  if (job.kind === "feed_enum" || job.kind === "feed_ingest") {
    throw new Error(`系统任务 ${job.kind} 不产制品`);
  }
  const kind = job.kind;
  if (kind === "cad") await onCadStage?.("validating_input");
  if (kind === "cad" && !p.cadRevision) {
    const sourceRequired = p.cadRequestPlan?.mode === "source_driven" || !p.cadRequestPlan;
    if (sourceRequired && !sourceIds?.length) {
      throw new Error("请至少选择一个已就绪来源后再生成 CAD 模型");
    }
    if ((sourceIds?.length ?? 0) > MAX_CAD_SOURCE_COUNT) {
      throw new Error(`CAD 每次最多选择 ${MAX_CAD_SOURCE_COUNT} 个来源`);
    }
    const readyIds = new Set(
      (await listSources(nb)).filter((source) => source.status === "ready").map((source) => source.id)
    );
    if (sourceIds?.some((sourceId) => !readyIds.has(sourceId))) {
      throw new Error("CAD 取材来源已删除、失效或尚未处理完成，请重新发起生成");
    }
  }
  // 记忆跟「发起这次生成的人」走(而非笔记本所有者)—— 在他人/共享/精选笔记本里
  // 生成时也用上自己的长期记忆。user_id=null 是官方预生成(频道制品架),不注入任何人记忆。
  const memberId = job.user_id;
  // 水印权益：基础档生成的可视制品带实例品牌水印，免水印权益档不带水印。
  // 官方预生成(memberId=null)不打 —— 水印是免费档【用户】的导出门槛,不是官方内容的属性。
  const watermark = typeof p.__watermark === "boolean"
    ? p.__watermark
    : memberId
      ? (await getEffectivePlanConfigForUser(await getUserById(memberId))).watermark
      : false;

  // Which sources this artifact draws on — the explicit selection (any stray
  // "__"-prefixed legacy id defensively stripped), or every ready source when
  // nothing was specified. Stored so the row can show "N 个来源" and "查看来源".
  const realSelected = sourceIds ?? [];
  const usedSourceIds = realSelected.length > 0
    ? realSelected
    : (await listSources(nb)).filter((s) => s.status === "ready").map((s) => s.id);
  // 取材统一基于来源 → 查看器副标题恒为「N 个来源」(不再有会话/笔记范围)。
  // watermark 一并落进每个制品的 data:客户端导出型制品(思维导图 PNG / 画板导出图 /
  // 报告 PDF)在导出时读 output.data.watermark 决定是否叠加水印(免费档 true)。
  // 服务端已烧录的制品(图片/视频/PPT)不读它,冗余无害。
  const promptHash = (value?: string) => value
    ? createHash("sha256").update(value).digest("hex").slice(0, 24)
    : undefined;
  const generation = {
    instructionPresent: !!p.instruction,
    instructionHash: promptHash(p.instruction),
    promptPresent: kind === "custom" && !!p.prompt,
    promptHash: kind === "custom" ? promptHash(p.prompt) : undefined,
    focusPresent: !!p.focus,
    focusHash: promptHash(p.focus),
    language: p.language,
    theme: p.theme,
    format: p.format,
    length: p.length,
    audiencePresent: !!p.audience,
    audienceHash: promptHash(p.audience),
    difficulty: p.difficulty,
    count: p.count,
    voices: p.voices,
    cadTemplate: p.cadTemplate,
    cadSelectionMode: p.cadSelectionMode,
    cadLibraryVersion: p.cadLibraryVersion,
    contractVersion: 1,
  };
  const data = (extra?: Record<string, unknown>) =>
    JSON.stringify({
      ...(extra ?? {}),
      sources: usedSourceIds.length,
      sourceIds: usedSourceIds,
      watermark,
      generation,
    });

  if (kind === "audio") {
    const { title, transcript, mp3Path, voiceDowngraded } = await generateAudioOverview(nb, sourceIds, {
      format: p.format,
      focus: p.focus || p.instruction,
      length: p.length,
      language: p.language,
      voices: p.voices,
      memberId,
    });
    try {
      const out = await createOutput(nb, "audio", title, transcript, data({ audio: true, voiceDowngraded }));
      await commitAudioFile(mp3Path, out.id);
      // 音色降级差额并入 runOne 的最终 Token 结算，避免部分退回找不到原扣减行、
      // 无法对称还原奖励积分口袋。data 标志供成功收尾读取。
      return await finishOutput(out);
    } catch (e) {
      // 失败路径(如笔记本已删致 createStudioOutput FK 错误,或 commit 未完成):
      // generateAudioOverview 已产出的临时 mp3 尚在 .data/audio、未被 rename 走 →
      // best-effort 清理,避免失败任务在磁盘长期堆积。
      await rm(mp3Path, { force: true }).catch(() => {});
      throw e;
    }
  }
  if (kind === "video") {
    const { title, transcript, mp4Path } = await generateVideoOverview(nb, sourceIds, {
      // 视频已在 UI 上架:配置弹窗的「补充说明」走通用 instruction 通道,
      // 这里让 focus 兜底取 instruction,两条路都通。
      focus: p.focus || p.instruction,
      audience: p.audience,
      language: p.language,
      watermark, // 基础档视频带实例品牌水印，免水印权益档不带
      memberId,
    });
    try {
      const out = await createOutput(nb, "video", title, transcript, data({ video: true }));
      await commitVideoFile(mp4Path, out.id);
      return await finishOutput(out);
    } catch (e) {
      // 失败路径同 audio:generateVideoOverview 已产出的临时 mp4 尚在 .data/video、未被
      // rename 走 → best-effort 清理,避免失败任务在磁盘长期堆积。
      await rm(mp4Path, { force: true }).catch(() => {});
      throw e;
    }
  }
  if (kind === "infographic") {
    const { title, content, png } = await generateInfographic(nb, sourceIds, { theme: p.theme, language: p.language, instruction: p.instruction, watermark, memberId });
    const out = await createOutput(nb, "infographic", title, content, data({ image: true }));
    try {
      await commitInfographicPng(out.id, png);
      return await finishOutput(out);
    } catch (e) {
      // png 是内存 Buffer,createStudioOutput 失败不落盘;但 commit 半途失败会在
      // .data/infographic 留下残缺 <id>.png(与 out.id 绑定,重试用新 id 不会覆盖)→
      // best-effort 清理。
      await rm(path.join(INFOGRAPHIC_DIR, `${out.id}.png`), { force: true }).catch(() => {});
      throw e;
    }
  }
  if (kind === "xhs") {
    const { title, content, pages, tmpDir } = await generateXhsCards(nb, sourceIds, {
      count: p.count,
      language: p.language,
      instruction: p.instruction,
      theme: p.theme, // 用户在弹窗手选的配色模版(暖米/奶油绿/雾蓝);空/auto 时自动挑
      watermark, // 基础档带实例品牌水印，免水印权益档不带
      memberId,
    });
    try {
      const out = await createOutput(nb, "xhs", title, content, data({ image: true, pages }));
      await commitXhsCards(tmpDir, out.id);
      return await finishOutput(out);
    } catch (e) {
      // 失败路径同 audio/video:已渲染好的整组 PNG 还留在 .data/xhs/tmp-*(未被 rename 走)
      // → best-effort 清理,避免失败任务在磁盘长期堆积(commit 成功后 rm 目标不存在,无害)。
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }
  if (kind === "slides") {
    const r = await generateSlides(nb, sourceIds, { instruction: p.instruction, language: p.language, theme: p.theme, watermark, memberId });
    return await finishOutput(await createOutput(nb, "slides", r.title, r.content, data()));
  }
  if (kind === "cad") {
    if (p.cadRevision) {
      const parent = await getStudioOutput(p.cadRevision.parentOutputId);
      if (!parent || parent.kind !== "cad" || parent.notebook_id !== nb) {
        throw new Error("原 CAD 版本不存在，请刷新后重试");
      }
      const baseHash = createHash("sha256").update(parent.content || "", "utf8").digest("hex");
      let parentData: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(parent.data || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parentData = parsed as Record<string, unknown>;
        }
      } catch {
        throw new Error("原 CAD 版本数据快照无效");
      }
      const frozen = parentData.manifest && typeof parentData.manifest === "object" && !Array.isArray(parentData.manifest)
        ? parentData.manifest as Record<string, unknown>
        : null;
      if (
        !/^[a-f0-9]{64}$/.test(p.cadRevision.baseHash)
        || p.cadRevision.baseHash !== baseHash
        || frozen?.hash !== baseHash
      ) {
        throw new Error("原 CAD 版本已变化，请刷新后重新编辑");
      }
      const { prepareCadRevision, renderPreparedCadRevision } = await import("./cad-revision");
      const prepared = prepareCadRevision(parent.content, p.cadRevision.patch);
      if (!/^[a-f0-9]{64}$/.test(p.cadRevision.targetHash) || prepared.hash !== p.cadRevision.targetHash) {
        throw new Error("CAD 修订目标校验值不一致，请重新提交");
      }
      if (prepared.unchanged) throw new Error("参数没有变化，无需生成新版本");
      await onCadStage?.("validating_spec");
      await onCadStage?.("building_geometry");
      const rendered = await renderPreparedCadRevision(prepared, signal, {
        onGeometryBuilt: () => onCadStage?.("checking_geometry") ?? Promise.resolve(),
        onStepValidation: () => onCadStage?.("validating_step") ?? Promise.resolve(),
      });
      const parentRevision = parentData.revision && typeof parentData.revision === "object" && !Array.isArray(parentData.revision)
        ? parentData.revision as Record<string, unknown>
        : {};
      const parentSequenceValue = Number(parentRevision.sequence ?? 1);
      const sequence = Number.isInteger(parentSequenceValue) && parentSequenceValue > 0
        ? parentSequenceValue + 1
        : 2;
      const rootOutputId = typeof parentRevision.rootOutputId === "string"
        ? parentRevision.rootOutputId
        : parent.id;
      const sourceReferenceMap = parentData.sourceReferenceMap && typeof parentData.sourceReferenceMap === "object" && !Array.isArray(parentData.sourceReferenceMap)
        ? parentData.sourceReferenceMap as Record<string, unknown>
        : {};
      const outputData = JSON.stringify({
        ...parentData,
        cad: true,
        cadPipelineVersion: 3,
        manifest: rendered.manifest,
        sourceReferenceMap: {
          ...sourceReferenceMap,
          "model:input": "在线参数编辑",
        },
        revision: {
          parentOutputId: parent.id,
          rootOutputId,
          baseHash,
          sequence,
          mode: "parameter_edit",
          changedFields: prepared.changedFields,
        },
      });
      try {
        // rendered.tmpDir 已存在；阶段 CAS 失权也必须进入同一清理边界。
        await onCadStage?.("preparing_output");
        await onCadStage?.("publishing_output");
        const out = await createOutput(
          nb,
          "cad",
          `${prepared.title} · v${sequence}`,
          rendered.content,
          outputData
        );
        await commitCadBundle(rendered.tmpDir, out.id);
        return await finishOutput(out);
      } catch (error) {
        await discardCadTemp(rendered.tmpDir).catch(() => {});
        throw error;
      }
    }
    const cadSelectionMode = p.cadSelectionMode ?? (p.cadTemplate ? "manual" : "auto");
    if (p.cadLibraryVersion !== undefined && p.cadLibraryVersion !== CAD_LIBRARY_VERSION) {
      throw new Error(`CAD 模型库版本已变更（任务 ${p.cadLibraryVersion}，当前 ${CAD_LIBRARY_VERSION}），请重新发起生成`);
    }
    if (!p.cadRequestPlan && (
      (cadSelectionMode === "manual" && !p.cadTemplate)
      || (cadSelectionMode === "auto" && !!p.cadTemplate)
      || (
        p.cadTemplate
        && !(CAD_TEMPLATES as readonly string[]).includes(p.cadTemplate)
        && p.cadTemplate !== TEXT2CAD_TEMPLATE
      )
    )) {
      throw new Error("CAD 模型库选择快照无效，请重新发起生成");
    }
    let frozenCadSources: readonly CadPreflightSource[] | undefined;
    if (p.cadRequestPlan) {
      const plan = p.cadRequestPlan;
      if (
        p.cadPipelineVersion !== 3
        || plan.schemaVersion !== 3
        || p.cadMode !== plan.mode
        || p.cadPreflightPlanHash !== plan.planHash
        || canonicalCadRequestPlanHash(plan) !== plan.planHash
      ) {
        throw new Error("CAD 免费预检快照无效或已被篡改，请重新发起生成");
      }
      // 排队期间来源可能被重新导入。在任何 provider 调用前重读当前正文并重算
      // planHash；不一致就终止并退分，绝不允许用“新来源 + 旧证据快照”生成。
      const verifiedSources = await assertCadRequestPlanStillCurrent({
        notebookId: nb,
        sourceIds,
        instruction: p.instruction,
        cadTemplate: p.cadTemplate,
        cadParameters: p.cadParameters,
        cadTargetObjectId: p.cadTargetObjectId,
        cadAllowAssumptions: p.cadAllowAssumptions,
        cadTutorialExample: p.cadTutorialExample,
        plan,
      });
      const geometrySourceIds = new Set(plan.target.sourceIds);
      frozenCadSources = verifiedSources
        .filter((source) => geometrySourceIds.has(source.id))
        .map((source) => ({
          ...source,
          content: cadTargetEvidenceText(source.title, source.content, plan.target.objectId),
        }));
    }
    // 模型提示词留在 server-only 模块；普通 jobs 状态机单测 import 本文件时
    // 不应加载 prompt/模型客户端，更不能把它们拉进其它 bundle。
    const { generateCadModel } = await import("./cad-generator");
    const generationSourceIds = p.cadRequestPlan?.mode === "source_driven"
      ? [...p.cadRequestPlan.target.sourceIds]
      : sourceIds;
    const generated = await generateCadModel(nb, generationSourceIds, {
      instruction: p.instruction,
      template: p.cadTemplate as CadArtifactTemplate | undefined,
      mode: p.cadMode,
      parameters: p.cadParameters,
      requestPlan: p.cadRequestPlan,
      allowAssumptions: p.cadAllowAssumptions,
      frozenSources: frozenCadSources,
      onStage: onCadStage,
      signal,
    });
    try {
      // generated.tmpDir 已存在；阶段 CAS 失权也必须进入同一清理边界。
      // provider/OCCT 执行期间来源仍可能被重新摄取。发布前再次重算同一冻结
      // plan；若发生漂移，丢弃临时几何并走统一失败/退分链，绝不发布混合快照产物。
      if (p.cadRequestPlan) {
        await assertCadRequestPlanStillCurrent({
          notebookId: nb,
          sourceIds,
          instruction: p.instruction,
          cadTemplate: p.cadTemplate,
          cadParameters: p.cadParameters,
          cadTargetObjectId: p.cadTargetObjectId,
          cadAllowAssumptions: p.cadAllowAssumptions,
          cadTutorialExample: p.cadTutorialExample,
          plan: p.cadRequestPlan,
        });
      }
      // no_cad_target 教学件的几何完全来自系统默认值；所选来源只用于判定
      // “没有可执行 CAD 目标”，不能被 usedSourceIds / 查看来源冒充为几何依据。
      const cadUsedSourceIds = generated.modelSelection.tutorialContext === "no_cad_target"
        ? []
        : [...new Set(
            Object.values(generated.sourceReferenceBindings).map((binding) => binding.id)
          )];
      await onCadStage?.("preparing_output");
      await onCadStage?.("publishing_output");
      const out = await createOutput(
        nb,
        "cad",
        generated.title,
        generated.content,
        data({
          cad: true,
          manifest: generated.manifest,
          sourceReferenceMap: generated.sourceReferenceMap,
          sourceReferenceBindings: generated.sourceReferenceBindings,
          sourceEvidenceMap: generated.sourceEvidenceMap,
          modelSelection: generated.modelSelection,
          cadRequestPlan: p.cadRequestPlan,
          cadPipelineVersion: p.cadRequestPlan ? 3 : 2,
          selectedSourceIds: usedSourceIds,
          usedSourceIds: cadUsedSourceIds,
        })
      );
      await commitCadBundle(generated.tmpDir, out.id);
      return await finishOutput(out);
    } catch (error) {
      await discardCadTemp(generated.tmpDir).catch(() => {});
      throw error;
    }
  }
  if (kind === "excalidraw") {
    const r = await generateExcalidraw(nb, sourceIds, { instruction: p.instruction, language: p.language, memberId });
    return await finishOutput(await createOutput(nb, "excalidraw", r.title, r.content, data({ excalidraw: true })));
  }
  if (kind === "drawviso") {
    const r = await generateDrawviso(nb, sourceIds, { instruction: p.instruction, language: p.language, memberId });
    return await finishOutput(await createOutput(nb, "drawviso", r.title, r.content, data()));
  }
  if (kind === "custom") {
    const r = await generateCustomReport(nb, p.prompt ?? "", sourceIds, { language: p.language, memberId });
    return await finishOutput(await createOutput(nb, "custom", r.title, r.content, data()));
  }
  if (kind === "flashcards") {
    const r = await generateFlashcards(nb, sourceIds, {
      count: p.count,
      instruction: p.instruction,
      language: p.language,
      memberId,
    });
    return await finishOutput(await createOutput(nb, kind, r.title, r.content, data()));
  }
  if (kind === "quiz") {
    const directive = await getNotebookDirective(nb, memberId);
    const quizOptions = {
      difficulty: p.difficulty,
      count: p.count,
      instruction: p.instruction,
      language: p.language,
      memberId,
      signal,
      directive,
    };
    const useLangGraph =
      process.env.NBLM_LANGGRAPH_QUIZ_ENABLED === "1" &&
      getFeatureFlag(memberId, "langgraph_quiz");
    if (useLangGraph) {
      // 语料只读一次：hash 与实际生成复用同一快照，避免来源在
      // “计算版本→构建语料”之间刷新，造成审计 hash 指向 A、题目却来自 B。
      const prepared = await prepareQuizGenerationInput(nb, sourceIds, quizOptions);
      const requestHash = createHash("sha256").update(JSON.stringify({
        flowVersion: 1,
        notebookId: nb,
        memberId,
        sourceIds: usedSourceIds,
        corpusHash: createHash("sha256").update(prepared.corpus, "utf8").digest("hex"),
        difficulty: p.difficulty,
        count: p.count,
        instructionHash: generation.instructionHash,
        directiveHash: createHash("sha256").update(directive, "utf8").digest("hex"),
        language: p.language,
      })).digest("hex");
      const { runQuizGenerationGraph } = await import("./quiz-workflow");
      const r = await runQuizGenerationGraph({
        requestHash,
        signal,
        generate: () => quizFromCorpus(prepared.corpus, prepared.directive, quizOptions),
        onPhase: async (phase) => {
          const progress = phase === "prepare" ? 20 : phase === "generate" ? 35 : phase === "verify" ? 82 : 88;
          if (!(await updateJobForRun(job.id, expectedAttempt, { progress }))) {
            throw new JobRunLostError();
          }
        },
      });
      return await finishOutput(await createOutput(
        nb,
        kind,
        r.title,
        r.content,
        data({ workflow: r.workflow, questionCount: r.questionCount })
      ));
    }
    const r = await generateQuiz(nb, sourceIds, quizOptions);
    return await finishOutput(await createOutput(nb, kind, r.title, r.content, data()));
  }
  if (kind === "mindmap") {
    const r = await generateMindmap(nb, sourceIds, { instruction: p.instruction, language: p.language, memberId });
    return await finishOutput(await createOutput(nb, "mindmap", r.title, r.content, data()));
  }
  if (isReportKind(kind)) {
    const r = await generateReport(nb, kind, sourceIds, { instruction: p.instruction, language: p.language, memberId });
    return await finishOutput(await createOutput(nb, kind, r.title, r.content, data()));
  }
  throw new Error(`Unsupported studio kind: ${kind}`);
}

/** 任务失败时给用户的可读文案 —— 原始错误(可能含接口配额详情、key 名)只进
 *  服务端日志,绝不直接展示。 */
function friendlyJobError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number })?.status;
  if (status === 429 || /rate limit|TPM|RPM|quota/i.test(msg))
    return "模型接口限流,请等待约 1 分钟后重试。";
  if (status === 401 || status === 403 || /api key|unauthorized/i.test(msg))
    return "模型接口鉴权失败,请检查 API Key 配置。";
  if (/connection|network|fetch failed|timeout|ECONN|socket/i.test(msg))
    return "网络连接失败,请重试。";
  // 业务侧自带的中文提示原样透出,其余截断
  return /[一-鿿]/.test(msg) ? msg.slice(0, 120) : `生成失败:${msg.slice(0, 100)}`;
}

function cadFailureCodeOf(error: unknown): string {
  if (isCadContractError(error)) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  const repairHint = error && typeof error === "object" && typeof (error as { repairHint?: unknown }).repairHint === "string"
    ? String((error as { repairHint: string }).repairHint)
    : "";
  const combined = `${message}\n${repairHint}`;
  if (/STEP|round.?trip|回读/i.test(combined)) return "cad_step_roundtrip_failed";
  if (/干涉|相交|interference/i.test(combined)) return "cad_part_interference";
  if (/cut 未实质|布尔|boolean/i.test(combined)) return "cad_boolean_no_effect";
  if (/包围盒|边界|bounds/i.test(combined)) return "cad_bounds_mismatch";
  if (/规格|schema|JSON/i.test(combined)) return "cad_ir_schema_invalid";
  return "cad_internal_error";
}

// 单个任务的硬超时(兜底):底层若卡死(系统语音进程、embed 子进程 wedge、
// ffmpeg 死循环…)会永远 await → 单进程 worker 被顶死,后续任务全部滞留、用户端「一直转」。
// 心跳会一直刷新 updated_at 让孤儿回收也误判为「活着」,所以必须有独立的硬超时。超时后抛错,
// runOne 的 catch 把本任务置失败并释放 worker(底层资源由各自定时器另行 kill,见 embed/tts)。
const JOB_TIMEOUT_MS: Record<string, number> = { audio: 900_000, video: 900_000, infographic: 480_000, slides: 480_000, xhs: 480_000, cad: 300_000, feed_enum: 120_000, feed_ingest: 480_000 };
const DEFAULT_JOB_TIMEOUT_MS = 300_000;
function withJobTimeout<T>(kind: string, p: Promise<T>, onTimeout?: () => void): Promise<T> {
  const ms = JOB_TIMEOUT_MS[kind] ?? DEFAULT_JOB_TIMEOUT_MS;
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => {
      try { onTimeout?.(); } catch { /* 中止回调不得吞掉超时终判 */ }
      rej(new Error(`生成超时(超过 ${Math.round(ms / 1000)} 秒),请重试`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

async function runOne(job: Job): Promise<void> {
  // claimNextQueued 必须在 queued → running 的同一条 SQL/事务中将
  // run_attempt 原子 +1 并返回新值。整个本跑只使用这份不变快照；
  // 绝不从后续 getJob 「更新」它，否则旧跑会冒用新跑的代次。
  const expectedAttempt = claimedRunAttempt(job);
  // 上一进程可能在 processing output INSERT 后崩溃。新 attempt 开跑前清理旧代次，
  // 这些行从未 ready、用户不可见；媒体清理失败也不会让它们被错误发布。
  for (const stale of await listSupersededJobOutputs(job.id, expectedAttempt)) {
    await discardStudioOutput(stale.id);
  }
  // 「在跑」内存名册(挂 process 对象:Turbopack dev 给每个 server bundle 实例隔离
  // globalThis,process 才是真正的进程单例;db.ts 的孤儿回收读它):
  // dev 的按需编译发生在同一个 Node 进程里,一次大编译(几千模块)会把事件环阻塞
  // 几十秒 —— 心跳 setInterval 期间完全不 fire,updated_at 停摆,周期回收就把
  // 还活着的任务当孤儿杀掉(「服务已重启,本次生成中断」+ 误退分)。时间窗判定
  // 对「同进程还在跑」的任务天然不可靠,名册才是硬凭据:在册 = 绝不回收。
  const gi = process as unknown as { __nbInflight?: Set<string> };
  const inflight = (gi.__nbInflight ??= new Set<string>());
  inflight.add(job.id);
  // 所有用户制品都要把硬超时/取消真正传给模型 SDK；系统订阅任务仍走原平台链。
  const generationAbort = job.user_id ? new AbortController() : undefined;
  let lastCadProgress = 0;
  const updateCadStage: CadJobStageUpdate | undefined = job.kind === "cad"
    ? async (stage: CadJobRunningStage) => {
        const nextProgress = cadJobProgressForStage(stage);
        const advances = nextProgress > lastCadProgress;
        const won = await updateJobForRun(job.id, expectedAttempt, {
          // 定向修复可能重新进入规格/几何步骤，但用户看到的真实阶段
          // 只能单调前进，不得从 STEP 校验倒退到“规划中”。
          ...(advances
            ? { progress: nextProgress, stage, stage_started_at: Date.now() }
            : {}),
        });
        if (won) {
          lastCadProgress = Math.max(lastCadProgress, nextProgress);
          return;
        }
        generationAbort?.abort();
        throw new JobRunLostError();
      }
    : undefined;
  // 心跳只证明 worker 还活着。CAD 的 progress 是真实阶段编码，
  // 不得像旧通用任务一样每 800ms 伪增到 90。非 CAD 行为保持不变。
  const tick = setInterval(() => {
    // try/catch:tick 里异步命中 DB,若某次 query 抛错(磁盘满/锁),未捕获会经
    // instrumentation 的 unhandledRejection 处理器整垮服务 —— 拖垮所有在途任务。
    // 单次心跳失败降级为 warning。void 让 setInterval 回调保持同步返回。
    void (async () => {
      try {
        const j = await getJob(job.id);
        if (abortGenerationWhenRunLost(generationAbort, j, expectedAttempt)) return;
        // 心跳:每 800ms 刷新 updated_at。即使进度已到 90(在等 LLM 返回)也刷新 ——
        // 这样「孤儿回收」(reclaimStaleRunningJobs)能可靠区分「活着的任务(持续心跳)」
        // 与「进程已死的孤儿(心跳停止 → updated_at 变旧)」,不再误杀正在跑的生成。
        if (j && isCurrentJobRun(j, expectedAttempt)) {
          await updateJobForRun(
            job.id,
            expectedAttempt,
            job.kind === "cad"
              ? {}
              : { progress: j.progress < 90 ? j.progress + 7 : 90 }
          );
        }
      } catch (e) {
        console.warn("[jobs] 心跳刷新失败(忽略):", e);
      }
    })();
  }, 800);
  try {
    // 初始进度也是一次栅栏写。认领后若在真正开跑前已被取消/
    // 重排，本跑应直接退出，连昂贵的生成都不启动。
    if (updateCadStage) await updateCadStage("starting");
    else if (!(await updateJobForRun(job.id, expectedAttempt, { progress: 12 }))) return;
    // 系统任务(feed_enum/feed_ingest)在进 runArtifactJob 之前分派 —— 它们不是用户制品,
    // 不产 output;但白捡 runOne 的心跳/硬超时/瞬态重试/孤儿回收全套(设计 v2 §3.1)。
    const isSystemJob = job.kind === "feed_enum" || job.kind === "feed_ingest";
    let outputId: string | null;
    let tokensIn = 0;
    let tokensOut = 0;
    if (!isSystemJob && job.user_id) {
      let parsedParams: Params;
      try {
        parsedParams = job.params ? JSON.parse(job.params) as Params : {};
      } catch {
        throw new Error("任务参数无效");
      }
      const modelRef = parseModelProviderRef(parsedParams.__modelProviderRef);
      const currentNotebook = await getNotebook(job.notebook_id);
      if (!currentNotebook) throw new Error("笔记本不存在");
      const modelRuntime = await resolveUserModelRuntimeForNotebook(job.user_id, currentNotebook, modelRef);
      const jobModelRuntime = modelRuntime
        ? { ...modelRuntime, signal: generationAbort?.signal }
        : null;
      const metered = await withUserModelRuntime(jobModelRuntime, () =>
        withAiUsageMeter(
          { userId: job.user_id!, op: `studio:${job.kind}`, jobId: job.id },
          () => withJobTimeout(
            job.kind,
            runArtifactJob(job, expectedAttempt, generationAbort?.signal, updateCadStage),
            () => generationAbort?.abort()
          )
        )
      );
      outputId = metered.result;
      tokensIn = metered.tokensIn;
      tokensOut = metered.tokensOut;
    } else {
      outputId = await withJobTimeout(
        job.kind,
        isSystemJob
          ? runFeedJob(job).then(() => null as string | null)
          : runArtifactJob(job, expectedAttempt, generationAbort?.signal, updateCadStage),
        () => generationAbort?.abort()
      );
    }

    if (updateCadStage) {
      try {
        await updateCadStage("finalizing");
      } catch (error) {
        // runArtifactJob 已返回时，processing 行与媒体可能已落地。
        // 若在结算前失去 attempt，必须立即撤掉这份未发布产物。
        if (outputId) await discardStudioOutput(outputId);
        throw error;
      }
    }

    let billing: Parameters<typeof finalizeJobDone>[2] | undefined;
    if (job.user_id && !isSystemJob && !sponsoredJob(job)) {
      const reservedCredits =
        Number(job.credits_reserved) > 0
          ? Number(job.credits_reserved)
          : await creditCostForKind(job.kind);
      const quote = studioCreditsFromTokenUsage(
        job.kind,
        tokensIn,
        tokensOut,
        reservedCredits
      );
      let finalCredits = quote.credits;
      if (job.kind === "cad" && outputId) {
        const out = await getStudioOutputAny(outputId);
        finalCredits = finalStudioCreditsForOutput(
          job.kind,
          reservedCredits,
          finalCredits,
          out?.data
        );
      }
      // 高级音色降级到免费兜底时，最终价最多收预留价的一半；Token 明细仍照实记录。
      if (job.kind === "audio" && outputId) {
        const out = await getStudioOutputAny(outputId);
        try {
          if ((JSON.parse(out?.data || "{}") as { voiceDowngraded?: boolean }).voiceDowngraded) {
            finalCredits = Math.min(finalCredits, Math.max(1, Math.floor(reservedCredits / 2)));
          }
        } catch {
          /* data 非 JSON 时不额外折价 */
        }
      }
      billing = {
        userId: job.user_id,
        op: `studio:${job.kind}`,
        reservedCredits,
        finalCredits,
        tokensIn: quote.tokensIn,
        tokensOut: quote.tokensOut,
        notebookTitle: (await getNotebook(job.notebook_id))?.title,
        ledgerId: creditLedgerIdOf(job),
      };
    }
    // 【竞态守卫】条件收尾:仅当任务仍 running 才置 done。若期间被取消(DELETE /api/jobs 已置
    // canceled + 积分退回），finalize 命中 0 行 → 撤掉刚落库的制品，不发通知/奖励。
    // 否则会「取消退了款、制品却仍在 listStudioOutputs 里可见可用」= 白嫖。
    const won = await finalizeJobDone(job.id, outputId, billing, expectedAttempt);
    if (!won) {
      if (outputId) await discardStudioOutput(outputId);
      return;
    }
    // 生成完成 → 给发起用户写一条消息中心通知(失败不影响任务)。
    if (job.user_id) {
      const nbTitle = (await getNotebook(job.notebook_id))?.title ?? "笔记本";
      await createNotification({
        userId: job.user_id,
        type: "generation",
        title: `「${nbTitle}」${job.title}已生成`,
        summary: "点击查看",
        link: job.notebook_id,
      });
      await awardReferralMilestone(job.user_id, "first_artifact"); // 被邀请人首个制品 → 邀请人返利(幂等)
    }
  } catch (e) {
    // 用户已取消:状态已被取消接口置为 canceled、积分已退 → 直接丢弃返回,
    // 不写 output、不置 error、不再退分。第二个条件兜「取消后生成器自身又抛错
    // (超时/网络)」的竞态,避免把 canceled 改写成 error 并二次退分。
    // 'queued' = 本次执行已被孤儿回收重排队(新一跑接手)→ 同样静默退出,不退分。
    if (e instanceof JobRunLostError) return;
    // 只看 status 不够：超时旧跑看到的「新跑 running」不属于自己。
    // 这里的读判定只是早退优化，下面每个写仍由 DB CAS 作最终仲裁。
    const currentRun = await getJob(job.id);
    if (!isCurrentJobRun(currentRun, expectedAttempt)) return;
    // 瞬态失败(限流/网络/超时):自动重排队重试(次数上限 JOB_MAX_ATTEMPTS),把一过性
    // 故障变成延迟成功。短暂退避后由本循环或 15s 周期兜底重新认领;不置 error、不退分。
    const msg = e instanceof Error ? e.message : String(e);
    const errorName = String((e as { name?: unknown })?.name || "");
    const httpStatus = (e as { status?: number })?.status;
    // withJobTimeout 只能停止外层 await，无法强制取消已进入供应商的请求。
    // 硬超时若再立即重排，旧跑与新跑会并行烧 Token；因此硬超时直接
    // 终止并退分。供应商 429/5xx/普通网络瞬断仍保留有上限的重试。
    const hardTimeout = /生成超时\(超过\s*\d+\s*秒\)/.test(msg);
    // 供应商 SDK 的单请求超时可能发生在上游已开始生成后。整任务重排会
    // 把 240s 网关超时放大为 8–12 分钟，并有重复 Token 风险；此类直接终判退分。
    const providerRequestTimeout =
      /APIConnectionTimeoutError|APITimeoutError/i.test(errorName) ||
      /request timed out/i.test(msg) ||
      (errorName === "UserModelRequestError" && (e as { code?: unknown }).code === "timeout");
    const transient =
      !hardTimeout && !providerRequestTimeout && (
        httpStatus === 429 ||
        (httpStatus != null && httpStatus >= 500) ||
        /rate limit|TPM|RPM|connection|network|fetch failed|timeout|ECONN|socket|超时/i.test(msg)
      );
    if (transient && (await requeueJobForRetry(job.id, expectedAttempt))) {
      console.warn(`[jobs] ${job.kind} 瞬态失败,已重排队重试:`, msg.slice(0, 120));
      await new Promise((r) => setTimeout(r, 8_000)); // 单 worker 串行,顺带充当重试退避
      return;
    }
    // 终判同样要用 attempt CAS：若这一刻已由别的 worker 重排/认领，
    // 旧跑不得把新跑改成 error，更不得退掉新跑正在消费的积分。
    const failed = await failJobAndQueueRefund(
      job.id,
      expectedAttempt,
      friendlyJobError(e),
      undefined,
      job.kind === "cad"
        ? {
            code: cadFailureCodeOf(e),
            stage: cadJobStageFromProgress(Number(currentRun?.progress ?? 0)),
          }
        : undefined
    );
    if (!failed) return;
    console.error(`[jobs] ${job.kind} failed:`, e);
    await cleanupProcessingJobOutputs(job.id);
    // 终态与积分退回 outbox 同事务；当前进程立即尝试，失败由启动/周期扫描继续补偿。
    await processCreditRefundOutbox().catch((re) => {
      console.warn("[jobs] 积分退回 outbox 本轮处理失败，将自动重试:", re);
    });
  } finally {
    clearInterval(tick);
    inflight.delete(job.id);
  }
}

// 两条独立车道共用 run_attempt/计费/取消状态机，但不共用串行执行权。
// CAD 上游模型或几何内核卡住时，测验、导图、报告和系统任务仍能由
// non_cad 车道继续处理。标志放在 process，仍然防止 Turbopack bundle 重复起 worker。
const g = process as unknown as {
  __nbWorker?: boolean;
  __nbPending?: boolean;
  __nbCadWorker?: boolean;
  __nbCadPending?: boolean;
};

let workerGateCache: { until: number; gates: WorkerGates } | null = null;
async function workerGates(): Promise<WorkerGates> {
  const now = Date.now();
  if (workerGateCache && workerGateCache.until > now) return workerGateCache.gates;
  try {
    const [general, cad, owner] = await Promise.all([
      getSetting("jobs.worker_v2_enabled"),
      getSetting("jobs.cad_worker_enabled"),
      getSetting("jobs.worker_owner"),
    ]);
    const gates = resolveWorkerGates({
      ...(general == null ? {} : { "jobs.worker_v2_enabled": general }),
      ...(cad == null ? {} : { "jobs.cad_worker_enabled": cad }),
      ...(owner == null ? {} : { "jobs.worker_owner": owner }),
    });
    workerGateCache = { until: now + 1_000, gates };
    return gates;
  } catch {
    // 读不到共享闸门时 fail closed，避免蓝绿两色同时抢队列。
    const gates = { general: false, cad: false, ownerMatched: false };
    workerGateCache = { until: now + 1_000, gates };
    return gates;
  }
}

async function nonCadWorkerEnabled(): Promise<boolean> {
  return (await workerGates()).general;
}

async function cadWorkerEnabled(): Promise<boolean> {
  return (await workerGates()).cad;
}

/** 供独立 worker 内部健康点报告 DB owner/总闸裁决，不对公网暴露。 */
export async function cadWorkerReadiness(): Promise<{ eligible: boolean; workerId: string; libraryVersion: number }> {
  return {
    eligible: IS_WORKER_HOST && await cadWorkerEnabled(),
    workerId: process.env.NBLM_WORKER_ID || "standalone",
    libraryVersion: CAD_LIBRARY_VERSION,
  };
}

type WorkerLane = "cad" | "non_cad";

async function runLoop(lane: WorkerLane): Promise<void> {
  const cadLane = lane === "cad";
  try {
    do {
      if (cadLane) g.__nbCadPending = false;
      else g.__nbPending = false;
      let job: Job | undefined;
      const enabled = cadLane ? cadWorkerEnabled : nonCadWorkerEnabled;
      while ((await enabled()) && (job = await claimNextQueued(lane))) {
        await runOne(job);
      }
    } while (cadLane ? g.__nbCadPending : g.__nbPending);
  } finally {
    // 审查修复:任何逸出异常(如 claimNextQueued 抛错)都要复位标志,
    // 否则 __nbWorker 卡 true,worker 永久失活、后续任务全部滞留。
    if (cadLane) g.__nbCadWorker = false;
    else g.__nbWorker = false;
  }
}

function kickWorkerLane(lane: WorkerLane): void {
  // 旁路进程(脚本/评测)只入队不认领:任务留给 server worker(15s 周期兜底会拾取)。
  if (!IS_WORKER_HOST) return;
  const cadLane = lane === "cad";
  if (cadLane ? g.__nbCadWorker : g.__nbWorker) {
    if (cadLane) g.__nbCadPending = true;
    else g.__nbPending = true;
    return;
  }
  if (cadLane) g.__nbCadWorker = true;
  else g.__nbWorker = true;
  setTimeout(() => {
    void (async () => {
      const enabled = cadLane ? await cadWorkerEnabled() : await nonCadWorkerEnabled();
      if (!enabled) {
        if (cadLane) g.__nbCadWorker = false;
        else g.__nbWorker = false;
        return;
      }
      await runLoop(lane);
    })();
  }, 0);
}

export function kickWorker(): void {
  kickWorkerLane("non_cad");
  kickWorkerLane("cad");
}

/** 审查修复(启动恢复):重启后把遗留 running 任务置为 error、消费遗留 queued。
 *  由 instrumentation.register(nodejs runtime)在服务启动时调用一次。 */
export async function recoverStaleJobs(): Promise<void> {
  try {
    const { failed, requeued, queued } = await recoverStaleJobsInDb();
    if (requeued) console.warn(`[jobs] 启动恢复:${requeued} 个中断任务已重新排队续跑`);
    if (failed) console.warn(`[jobs] 启动恢复:${failed} 个多次中断任务已置为失败`);
    if (queued) kickWorker();
  } catch (e) {
    console.error("[jobs] 启动恢复失败:", e);
  }
}

/** Enqueue an artifact-generation job and ensure the worker is running.
 *  护城河 2:按发起用户的 plan_tier 查 getPlan(tier).queuePriority 作为队列优先级
 *  (Pro=0 / Max=5 / Ultra=10)。系统任务 / 查不到用户 → 0 兜底,等同 FIFO;
 *  数据库查询失败(极少)也 catch 兜底成 0,绝不阻断入队。route 侵入为零。 */
async function queuePriorityFor(userId: string | null): Promise<number> {
  if (!userId) return 0;
  try {
    return (await getEffectivePlanConfigForUser(await getUserById(userId))).queuePriority ?? 0;
  } catch {
    return 0;
  }
}

export async function enqueueChargedArtifact(
  notebookId: string,
  userId: string,
  kind: StudioKind,
  cost: number,
  note: string | null | undefined,
  params: Params
): Promise<QuotaChargeResult & { job?: Job; reused?: boolean }> {
  const priority = await queuePriorityFor(userId);
  const idempotencyKey = kind === "cad"
    && typeof params.cadIdempotencyKey === "string"
    && /^[a-f0-9]{8}-[a-f0-9-]{27,72}$/i.test(params.cadIdempotencyKey)
    ? params.cadIdempotencyKey
    : null;
  const reusable = async (): Promise<Job | undefined> => {
    if (!idempotencyKey) return undefined;
    let existing = await getJobByIdempotency(userId, idempotencyKey);
    // 极短窗口内另一请求可能已插入 draft，正在同一事务中扣分激活。
    // 只等待这一个已存在任务，绝不再建第二件或再扣一次。
    for (let attempt = 0; existing?.status === "draft" && attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      existing = await getJobByIdempotency(userId, idempotencyKey);
    }
    if (existing) {
      let existingParams: Params = {};
      try { existingParams = JSON.parse(existing.params || "{}") as Params; } catch { /* mismatch below */ }
      if (
        existing.notebook_id !== notebookId
        || existing.kind !== kind
        || existingParams.cadPreflightPlanHash !== params.cadPreflightPlanHash
      ) {
        throw new CadContractError({
          code: "cad_idempotency_conflict",
          message: "CAD 幂等键已绑定另一个生成请求",
          field: "cadIdempotencyKey",
        });
      }
    }
    return existing?.status === "draft" ? undefined : existing;
  };
  const existing = await reusable();
  if (existing) return {
    over: false,
    limit: 0,
    used: 0,
    bonus: 0,
    job: existing,
    reused: true,
  };

  let draft: Job;
  try {
    draft = await createJob(
      notebookId,
      userId,
      kind,
      KIND_TITLE[kind] ?? kind,
      params,
      priority,
      null,
      "draft",
      idempotencyKey
    );
  } catch (error) {
    if (idempotencyKey && String((error as { code?: unknown })?.code) === "23505") {
      const raced = await reusable();
      if (raced) return {
        over: false,
        limit: 0,
        used: 0,
        bonus: 0,
        job: raced,
        reused: true,
      };
    }
    throw error;
  }
  try {
    const activated = await activateChargedJob(
      draft.id,
      userId,
      `studio:${kind}`,
      cost,
      note,
      MAX_ACTIVE_ARTIFACT_JOBS_PER_USER
    );
    if (activated.job) kickWorker();
    return activated;
  } catch (error) {
    await deleteDraftJob(draft.id).catch(() => {});
    throw error;
  }
}

export async function enqueueArtifact(
  notebookId: string,
  userId: string | null,
  kind: StudioKind,
  params: Params
): Promise<Job> {
  if (userId && params.__sponsored !== true) {
    throw new Error("用户制品必须走 enqueueChargedArtifact 原子扣费入口");
  }
  const priority = await queuePriorityFor(userId);
  const job = await createJob(notebookId, userId, kind, KIND_TITLE[kind] ?? kind, params, priority);
  const reserved = params.__sponsored ? 0 : Math.max(0, Math.round(params.__reservedCredits ?? 0));
  if (reserved > 0) {
    await setJobReservedCredits(job.id, reserved);
    job.credits_reserved = reserved;
  }
  kickWorker();
  return job;
}

/**
 * CAD 在线参数编辑的确定性重建入口。
 *
 * 它不调用模型、没有 Token 成本，但仍有 OCCT/WASM 几何重建成本，并进入全局单
 * worker 复用 run_attempt、取消、超时、积分补偿与 processing→ready 发布栅栏。
 * 与 __sponsored 分开标记，避免把用户编辑冒充平台预生成。
 */
export async function enqueueCadRevisionArtifact(
  notebookId: string,
  userId: string,
  revision: NonNullable<Params["cadRevision"]>,
  cost: number,
  note?: string | null
) {
  if (
    !/^[a-f0-9-]{36}$/i.test(revision.parentOutputId)
    || !/^[a-f0-9]{64}$/.test(revision.baseHash)
    || !/^[a-f0-9]{64}$/.test(revision.targetHash)
  ) {
    throw new Error("CAD 修订任务快照无效");
  }
  const priority = await queuePriorityFor(userId);
  const result = await createCadRevisionJobAtomic({
    notebookId,
    userId,
    title: "CAD 参数修订",
    params: { cadRevision: revision, __deterministic: true },
    priority,
    maxActive: 3,
    cost,
    note,
  });
  if (result.job && !result.reused) kickWorker();
  return result;
}

// BUILD-1:构建期(next build「收集页面数据」)会并行 import 每个路由模块来读其
// 导出;若在此阶段执行下面的启动兜底,会触发 getDb()→db.init() 的建表/迁移,多个
// 构建 worker 对同一 SQLite 文件并发初始化→better-sqlite3 原生崩溃→worker 死→
// 「Failed to collect page data / Cannot find module for page」(自项目基线起 next
// build 一直失败的根因)。构建期本就没有 server 在跑任务,直接跳过这些模块级副作用。
const isNextBuild = process.env.NEXT_PHASE === "phase-production-build";

// 只有 worker 宿主进程(Next server,NEXT_RUNTIME 有值)才允许认领任务/回收孤儿:
// 任何旁路脚本(评测/迁移/临时验证)import 本模块都会触发下面的模块级兜底,若无门禁,
// 脚本进程会认领共享队列里的任务、随进程退出留下无心跳孤儿(压测实锤:历史大量
// 「服务已重启」失败即源于此)。旁路进程仍可 enqueue,任务留给 server worker 拾取。
const IS_WORKER_HOST = !!process.env.NEXT_RUNTIME && !isNextBuild;

// 启动兜底(模块加载即执行):进程重启后 ① 遗留的 running 是死孤儿 → recoverStaleJobs
// 重排队续跑(instrumentation 不能 import 本模块 —— 会把重依赖拉进 client bundle 炸编译,
// 故启动恢复挂在这里,globalThis 去重保证每进程只跑一次);② 遗留的 queued 无人认领
// (worker 只在 enqueue 时被拉起)→ 检查并拉起。kickWorker 幂等,dev 热重载重复执行无害。
const gBoot = process as unknown as { __nbBootRecovered?: boolean };
if (IS_WORKER_HOST && !gBoot.__nbBootRecovered) {
  gBoot.__nbBootRecovered = true;
  // 异步 IIFE 承接 Promise,失败不阻断模块加载。
  void (async () => {
    try {
      if (!(await workerGates()).general) return;
      await recoverStaleJobs(); // 内部:重排队 + 有 queued 则 kickWorker
      if ((await countQueuedJobs()) > 0) kickWorker();
    } catch {
      /* 启动兜底失败不阻断 */
    }
  })();
}

// 孤儿任务周期兜底:db.init 只在进程首次 getDb 时回收一次,若进程重启很快、孤儿的
// updated_at 当时还没超过 JOB_STALE_MS,就漏回收了(生产单进程尤甚)。这里每 15s 扫一次
// 「长时间无心跳的 running」并重排队/置失败——只碰孤儿,绝不动正在心跳的活任务。
// 跨 dev 热重载/多 bundle 实例用 process 去重,避免堆叠多个定时器。
const gSweep = process as unknown as { __nbStaleSweep?: ReturnType<typeof setInterval> };
if (IS_WORKER_HOST && !gSweep.__nbStaleSweep) {
  gSweep.__nbStaleSweep = setInterval(() => {
    // sweepStaleJobs 现为异步(pg):void 让回调保持同步返回,拒绝在内部吞掉。
    void (async () => {
      try {
        if (!(await workerGates()).general) return;
        const n = await sweepStaleJobs();
        if (n) console.warn(`[jobs] 周期回收:${n} 个无心跳的中断任务已处理(重排队或置失败)`);
        await processCreditRefundOutbox();
        await cleanupTerminalProcessingOutputs();
        await cleanupStaleDraftJobs();
        await cleanupStaleCadTemps();
        // 捡漏拉起:孤儿重排队的任务、旁路进程只入队没 worker 的任务,15s 内被认领。
        if ((await countQueuedJobs()) > 0) kickWorker();
      } catch {
        /* 忽略单次扫描失败 */
      }
    })();
  }, 15_000);
  // 不要让这个定时器拖住进程退出(dev 下无所谓,但语义更干净)。
  (gSweep.__nbStaleSweep as unknown as { unref?: () => void }).unref?.();
}

// ---------------------------------------------------------------------------
// 领域智库订阅轮询(P0-4)。两级系统任务跑在本 worker 里(白捡心跳/硬超时/瞬态
// 重试/孤儿回收):feed_enum 轻(枚举 diff + 批认领),feed_ingest 重(逐篇抓取
// 入库,480s 预算)。设计:featured-subscription-design.md v2 §1/§3。
//
// 失败写回不依赖 job 自身:任何非成功路径(超时/崩溃/attempts 耗尽)都不会调
// feedPollSuccess → 短租约到期后扫描器的 compensateStaleFeedClaims 统一计失败
// (指数退避+熔断)。这比在 runOne 里 hook 更鲁棒:连进程死亡都覆盖。
// ---------------------------------------------------------------------------

const feedSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runFeedJob(job: Job): Promise<void> {
  const p = JSON.parse(job.params || "{}") as { channelId?: string; pollToken?: string; batchId?: string };
  if (!p.channelId) return;
  if (job.kind === "feed_enum") await runFeedEnum(p.channelId, p.pollToken ?? "");
  else await runFeedIngest(p.channelId, p.batchId ?? "");
}

/** 一级:枚举源 → diff 已见集 → 认领一批 → 派生 feed_ingest → AIMD 成功写回(CAS)。 */
/** 存货接力:频道还有已枚举未消化(pending)的条目且日配额未尽 → 认领一批排 ingest。
 *  三处调用:enum 完整路径 / enum 304 早退(RSS 没新文 ≠ 没存货)/ ingest 批尾
 *  (消化不等 AIMD 轮询周期 —— 那是给抓 RSS 的,不是给消化存货的)。
 *  收敛性:条目失败最多 release 一次(二败终态),pending 池单调缩;
 *  认领到 0 条不排 job;日配额尽则停,次日轮询重启接力。 */
async function relayFeedIngest(ch: { id: string; notebook_id: string; enabled: number }): Promise<void> {
  if (!ch.enabled) return;
  const remaining = await feedDailyRemaining(ch.id);
  const take = Math.min(FEED_BATCH_SIZE, remaining);
  if (take <= 0) return;
  const batchId = `fb-${ch.id.slice(0, 8)}-${Date.now().toString(36)}`;
  const batch = await claimFeedBatch(ch.id, batchId, take);
  if (batch.length > 0) {
    await createJob(ch.notebook_id, null, "feed_ingest", "订阅源入库", { channelId: ch.id, batchId }, -10, ch.id);
    kickWorker();
  }
}

/** 孤儿回收 + 立即接力:死批条目复位回 pending 后,同一拍就认领排 ingest ——
 *  接力只存在于活跑批尾,而死批被回收时恰恰没有活跑;不接力的话条目又停滞到
 *  下一次轮询(AIMD 可达 24h/退避 7 天,broken 频道则永久搁浅)。 */
export async function rescueOrphanFeedItems(): Promise<number> {
  const channelIds = await reclaimOrphanFeedBatches();
  for (const id of channelIds) {
    const ch = await getFeedChannel(id);
    if (ch) await relayFeedIngest(ch);
  }
  return channelIds.length;
}

export async function runFeedEnum(channelId: string, pollToken: string): Promise<void> {
  const ch = await getFeedChannel(channelId);
  if (!ch || !ch.enabled) return;
  // 僵尸自检:抢占凭据已换人(新一轮已开始)→ 本跑立即弃权,绝不产生副作用。
  if (ch.poll_token !== pollToken) return;
  // 排队续租(审查修复 high):租约从扫描器抢占起算,而本任务是全队列最低优先级 ——
  // 排队 >10min(一个音频任务就够)会被补偿器当「上一跑没收尾」记假失败。真正开跑时
  // 先 CAS 续租,把排队时间从租期里剔掉;续不上 = token 已被换,弃权。
  if (!(await renewFeedLease(channelId, pollToken))) return;

  const result = await enumerateChannel(ch);
  if (result.notModified) {
    // 304 早退前先消化存货(dev 实锤:etag 稳定的源,回填存货曾无限期停滞在这条路径)。
    await relayFeedIngest(ch);
    await feedPollSuccess(channelId, pollToken, { freshCount: 0, notModified: true });
    return;
  }
  let fresh = 0;
  // R1:回填身份在【枚举时刻】定格到条目(诚实性①③的机制根)—— 此后频道状态怎么变、
  // 批怎么死怎么被孤儿回收复活,这些条目都不会被当「新增」广播。
  const isBackfill = ch.status === "backfilling";
  for (const it of result.items) {
    if (await recordFeedItem({ channelId, guid: it.guid, url: it.url, title: it.title, publishedAt: it.publishedAt, backfill: isBackfill })) {
      fresh++;
    }
  }
  await relayFeedIngest(ch);
  await feedPollSuccess(channelId, pollToken, {
    freshCount: fresh,
    notModified: false,
    etag: result.etag,
    lastModified: result.lastModified,
  });
}

/** 二级:逐篇抓取入库(串行+错峰,嵌入是全局单子进程)→ 批尾简报(幂等)+ 通知合并 fan-out。
 *  重试跑只处理批内仍 pending 的条目(断点续作);简报按 note 确定性 id 恰一期。 */
export async function runFeedIngest(channelId: string, batchId: string): Promise<void> {
  const ch = await getFeedChannel(channelId);
  // enabled 复核:停用频道已在队列里的接力子 job 直接弃权(条目留 pending,孤儿回收兜底)。
  if (!ch || !ch.enabled || !batchId) return;
  const pending = await listBatchPendingItems(batchId);
  let attempted = 0; // 真实抓取次数(含失败/薄源,不含库内判重)—— 配额按它计,否则失败抓取免费
  let stopped = false;
  for (const it of pending) {
    // 运营撤精选/转私有会原子停频道并取消 feed job。底层抓取无法强杀，但每篇开始前
    // 复核能把最坏影响收敛为“正在处理的这一篇”，不会继续跑完整批次。
    const live = await getFeedChannel(channelId);
    if (!live?.enabled) {
      stopped = true;
      break;
    }
    // 条目粒度原子占位(审查修复 high):withJobTimeout 不杀底层,超时重试跑与僵尸旧跑
    // 会拿到同一份 pending 快照 —— 逐条 CAS,rowCount=0 = 另一跑已在处理,跳过。
    if (!(await claimFeedItemForIngest(it.id))) continue;
    if (!it.url) {
      await setFeedItemStatus(it.id, "skipped", { error: "无正文链接" });
      continue;
    }
    const r = await addUrlSource(ch.notebook_id, it.url, { fallbackTitle: it.title });
    if (!(r.ok && r.duplicate)) attempted++; // duplicate 是抓取前的库内判重,零网络成本不计
    if (r.ok && r.duplicate) {
      // 已在库(审查修复 high):不算「本期新增」—— 否则轮换参数/轮换 guid 的源每轮把
      // 旧文刷成简报「新增 N 篇」+徽章 +N,点进去没有新东西(设计 §0 点名的信任杀手)。
      await setFeedItemStatus(it.id, "skipped", { sourceId: r.sourceId, error: "已在库(重复条目)" });
    } else if (r.ok) {
      // R1:回填身份读【条目】自带的 backfill 标志(枚举时定格),不再读频道当前
      // status —— 频道状态是 read-then-decide,死批经孤儿回收复活后身份会丢
      // (第一性审查的头号 correctness 发现)。回填条目 ingested_at 写发布时间,
      // 天然早于任何订阅游标 → 不进未读徽章(诚实性③),无 pubDate 时兜 created_at。
      await setFeedItemStatus(it.id, "ingested", {
        sourceId: r.sourceId,
        ingestedAt: it.backfill ? it.published_at ?? it.created_at : undefined,
      });
    } else if (r.kind === "thin") {
      // 薄源(反爬页/纯导航):skipped 且【不重试】—— error 源每轮重抓的坑。
      await setFeedItemStatus(it.id, "skipped", { error: r.error });
    } else if (r.kind === "fetch" && !it.error) {
      // 抓取瞬态失败(审查修复):首败放回待认领池(下一轮批再试一次);二败才终态 failed。
      await releaseFeedItemForRetry(it.id, r.error);
    } else {
      await setFeedItemStatus(it.id, "failed", { error: r.error });
    }
    await feedSleep(FEED_ITEM_PACING_MS); // 篇间错峰:嵌入是全局单 fork 子进程,批量会拖慢全站检索
  }
  // 配额记【尝试】不记【成功】:轮换 guid + 反爬占位页的源,失败/薄源抓取若不计费,
  // 接力会把 FEED_DAILY_LIMIT 这道闸从最贵的工作(网络抓取)下面抽走
  // (AIMD 15min × 每轮全池 = 数千次抓取/天)。
  await bumpFeedDailyIngested(channelId, attempted);
  const stillEnabled = (await getFeedChannel(channelId))?.enabled;
  if (stopped || !stillEnabled) return;

  // 回填收尾与发布分流都按【条目标志】,与频道当前状态解耦。
  await finishBackfillIfDrained(channelId);

  // 频道门面补齐(幂等,失败静默):摄取链路不走工作台的生成入口,访客页的
  // 推荐问题与制品架长期空置(对标 NotebookLM 精选页,右栏应是点开即看即听的
  // 制品架,不是等简报的空架子)。
  // ①推荐问题:为空且 ≥3 篇 ready 时生成一次(此后不再调 LLM);
  // ②制品架:无制品、无在途任务且 ≥5 篇 ready 时,预生成一组官方制品
  //   (导图/报告/播客;userId=null → 不扣积分、不注入任何人记忆、不打水印)。
  try {
    const nbQ = await getNotebook(ch.notebook_id);
    if (nbQ) {
      const ready = (await listSources(ch.notebook_id)).filter((s) => s.status === "ready");
      if (!(nbQ.suggested_questions ?? []).length && ready.length >= 3) {
        const ov = await generateNotebookOverview(ready.map((s) => ({ title: s.title, summary: s.summary })));
        if (ov.suggested_questions.length) {
          await setNotebookOverview(ch.notebook_id, nbQ.summary || ov.summary, ov.suggested_questions);
        }
      }
      if (
        ready.length >= 5 &&
        (await listStudioOutputs(ch.notebook_id)).length === 0 &&
        (await countActiveArtifactJobs(ch.notebook_id)) === 0
      ) {
        for (const kind of ["mindmap", "briefing", "audio"] as const) {
          // language 显式锁中文:导图/播客默认跟「来源主导语言」,英文智库源会产出
          // 全英文制品(实锤:兰德播客整集英文)—— 官方制品面向中文用户。
          await enqueueArtifact(ch.notebook_id, null, kind, { language: "简体中文" });
        }
      }
    }
  } catch {
    /* 门面补齐失败不阻断摄取 */
  }

  // 批尾接力(enabled 用 fresh 读:停用频道不再续排)。
  const chNow = await getFeedChannel(channelId);
  if (chNow) await relayFeedIngest(chNow);

  const batch = await listBatchItems(batchId);
  // 只有「非回填且真的新入库」的条目才构成一次「更新」(诚实性①:回填不是更新)。
  const fresh = batch.filter((b) => b.status === "ingested" && b.source_id && !b.backfill);
  if (fresh.length === 0) return;

  // 每批一期更新简报(note,确定性 id 幂等)。内容生成走纯函数 buildFeedBrief ——
  // 诚实性④(薄源即使有 gist 也只列标题+链接、全薄跳过)在那里被单测锁死。
  const briefItems = [];
  for (const b of fresh) {
    const src = b.source_id ? await getSource(b.source_id) : undefined;
    briefItems.push({
      title: b.title,
      url: b.url,
      charCount: src?.char_count ?? 0,
      gist: src?.summary ?? null,
    });
  }
  const brief = buildFeedBrief(briefItems);
  await markFeedContent(channelId, Date.now());
  if (!brief) return; // 全薄批:只更时间线,不出简报不发通知

  const inserted = await upsertFeedBriefNote(ch.notebook_id, batchId, brief.title, brief.content);
  if (!inserted) return; // 简报已在(重试跑):通知靠确定性 id 自身幂等,无需再走

  // 通知 fan-out。审查修复三件:①发送前复核笔记本仍 公开+精选(撤场不发死链);
  // ②确定性 id feednotif-<nb>-<uid>-<日> —— 按日合并语义内建于 id(替代
  // check-then-act 的 hasFeedNotifToday),且 fan-out 半途崩溃后重试跑会补发
  // 未发的订阅者、绝不重发已发的;③单人失败只跳过该人。
  const nb = await getNotebook(ch.notebook_id);
  if (!nb || !nb.public || !nb.featured) return;
  const name = nb?.publisher || nb?.title || "订阅智库";
  const subs = await listSubscriberIds(ch.notebook_id);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (const uid of subs) {
    try {
      await createNotification({
        id: `feednotif-${ch.notebook_id}-${uid}-${day}`,
        userId: uid,
        type: "feed",
        title: `《${name}》更新了 ${fresh.length} 篇`,
        summary: `${fresh[0].title.slice(0, 60)} 等 · 本期简报已生成`,
        link: ch.notebook_id,
      });
    } catch (e) {
      console.warn("[feeds] 通知发送失败(跳过该订阅者):", e);
    }
  }
}

// 订阅源扫描器:60s 一拍。①补偿上一轮未写回的失败(租约过期仍带 token);②原子抢占
// 到期频道(每拍 ≤3,防批量轮询占住单 worker)→ 逐个入队 feed_enum(per-channel
// try/catch,一个失败不连坐同拍其余)。与 gSweep 同款 process 单例 + unref 范式。
const gFeed = process as unknown as { __nbFeedScan?: ReturnType<typeof setInterval> };
if (IS_WORKER_HOST && !gFeed.__nbFeedScan) {
  gFeed.__nbFeedScan = setInterval(() => {
    void (async () => {
      try {
        if (!(await nonCadWorkerEnabled())) return;
        const compensated = await compensateStaleFeedClaims();
        if (compensated) console.warn(`[feeds] 补偿 ${compensated} 个未正常收尾的轮询(计入失败退避)`);
        // 孤儿批回收(审查修复 high):job 死透的批把条目复位回可认领并立即接力,
        // 防「一个死批 = 频道永远卡 backfilling、此后所有新内容永久静默」。
        const orphans = await rescueOrphanFeedItems();
        if (orphans) console.warn(`[feeds] 回收 ${orphans} 个频道的孤儿批条目并已接力`);
        // R1:表增长闸 —— 已消化条目 / feed 通知各保留 90 天(设计 §4,上轮零实现)。
        await cleanupFeedRetention();
        const due = await claimDueFeedChannels(3);
        for (const ch of due) {
          try {
            await createJob(ch.notebook_id, null, "feed_enum", "订阅源轮询", { channelId: ch.id, pollToken: ch.poll_token }, -10, ch.id);
          } catch (e) {
            console.warn("[feeds] 频道入队失败(跳过,租约到期后自动补偿):", e);
          }
        }
        if (due.length) kickWorker();
      } catch (e) {
        console.warn("[feeds] 扫描失败(忽略本拍):", e);
      }
    })();
  }, 60_000);
  (gFeed.__nbFeedScan as unknown as { unref?: () => void }).unref?.();
}
