export type WorkerGates = {
  general: boolean;
  cad: boolean;
  ownerMatched: boolean;
};

type WorkerGateEnv = {
  NBLM_WORKER_ENABLED?: string;
  NBLM_NON_CAD_WORKER_ENABLED?: string;
  NBLM_CAD_WORKER_ENABLED?: string;
  NBLM_WORKER_ID?: string;
};

/**
 * 通用/CAD 任务领取闸门的唯一真源。两条 lane 可在不同容器独立开启；
 * owner 不匹配时两条 lane 都关闭，避免蓝绿两色同时消费共享队列。
 */
export function resolveWorkerGates(
  settings: Record<string, string>,
  env: WorkerGateEnv = process.env as WorkerGateEnv
): WorkerGates {
  const self = env.NBLM_WORKER_ID || "standalone";
  const owner = settings["jobs.worker_owner"] || "";
  const ownerMatched = !owner || owner === self;
  const baseEnabled =
    env.NBLM_WORKER_ENABLED !== "0" &&
    settings["jobs.worker_v2_enabled"] !== "0" &&
    ownerMatched;
  const general = baseEnabled && env.NBLM_NON_CAD_WORKER_ENABLED !== "0";
  const cad =
    baseEnabled &&
    env.NBLM_CAD_WORKER_ENABLED !== "0" &&
    settings["jobs.cad_worker_enabled"] !== "0";
  return { general, cad, ownerMatched };
}
