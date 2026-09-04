import type { JobStatus } from "./types";

/**
 * 单用户同时允许的制品生成任务数。
 *
 * route 的早期检查只是快速失败；真正的并发门禁必须在扣费/激活
 * 事务中按用户行串行化执行。两处共用这一常量，避免配置漂移。
 */
export const MAX_ACTIVE_ARTIFACT_JOBS_PER_USER = 3;

/**
 * CAD 任务的稳定阶段合同。
 *
 * 阶段以 jobs.progress 的固定边界持久化，不改动旧任务 params，
 * 也不要求数据库迁移。旧任务的任意进度值依然可按最近的已达边界读取。
 * 只有 worker 确实进入下一步时才允许写边界；心跳不得推进它。
 */
export const CAD_JOB_STAGE_PROGRESS = {
  queued: 0,
  starting: 5,
  validating_input: 10,
  reading_sources: 18,
  extracting_constraints: 28,
  planning_geometry: 38,
  validating_spec: 50,
  building_geometry: 62,
  checking_geometry: 75,
  validating_step: 84,
  preparing_output: 90,
  publishing_output: 94,
  finalizing: 98,
  completed: 100,
} as const;

export type CadJobStage = keyof typeof CAD_JOB_STAGE_PROGRESS;
export type CadJobRunningStage = Exclude<CadJobStage, "queued" | "completed">;
export type CadJobDisplayStage = CadJobStage | "failed" | "canceled";
export type CadJobStageUpdate = (stage: CadJobRunningStage) => Promise<void>;

export const CAD_JOB_STAGE_LABEL: Record<CadJobDisplayStage, string> = {
  queued: "排队中",
  starting: "正在启动 CAD 任务",
  validating_input: "正在校验来源与建模参数",
  reading_sources: "正在读取冻结来源",
  extracting_constraints: "正在提取对象与建模约束",
  planning_geometry: "正在规划部件与特征",
  validating_spec: "正在校验参数规格",
  building_geometry: "正在构建三维几何",
  checking_geometry: "正在检查实体、布尔与干涉",
  validating_step: "正在独立回读 STEP 文件",
  preparing_output: "正在整理 CAD 文件包",
  publishing_output: "正在发布 CAD 文件",
  finalizing: "正在完成任务与积分结算",
  completed: "CAD 模型已生成",
  failed: "CAD 模型生成失败",
  canceled: "CAD 模型生成已取消",
};

const ORDERED_RUNNING_STAGES = (
  Object.keys(CAD_JOB_STAGE_PROGRESS) as CadJobStage[]
).filter((stage) => stage !== "queued" && stage !== "completed");

export function cadJobProgressForStage(stage: CadJobStage): number {
  return CAD_JOB_STAGE_PROGRESS[stage];
}

/** 把旧任务或未知进度收敛到最近的已达真实阶段。 */
export function cadJobStageFromProgress(progress: number): CadJobStage {
  const safe = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
  if (safe >= CAD_JOB_STAGE_PROGRESS.completed) return "completed";
  let current: CadJobStage = "queued";
  for (const stage of ORDERED_RUNNING_STAGES) {
    if (safe < CAD_JOB_STAGE_PROGRESS[stage]) break;
    current = stage;
  }
  return current;
}

/** status 是终态真相；progress 只在 queued/running/done 内表示阶段。 */
export function cadJobDisplayStage(
  status: JobStatus,
  progress: number
): CadJobDisplayStage {
  if (status === "error") return "failed";
  if (status === "canceled") return "canceled";
  if (status === "done") return "completed";
  if (status === "queued" || status === "draft") return "queued";
  return cadJobStageFromProgress(progress);
}
