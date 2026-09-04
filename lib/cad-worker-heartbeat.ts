import { getSetting } from "./db";
import { CAD_LIBRARY_VERSION } from "./cad-spec";

export async function cadWorkerHeartbeatReady(
  required = process.env.CAD_REQUIRE_WORKER_HEARTBEAT === "1"
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!required) return { ok: true };
  let heartbeat: {
    ts?: unknown;
    workerId?: unknown;
    validator?: unknown;
    libraryVersion?: unknown;
  } = {};
  try {
    heartbeat = JSON.parse((await getSetting("jobs.cad_worker_heartbeat")) || "{}") as typeof heartbeat;
  } catch {
    heartbeat = {};
  }
  const owner = await getSetting("jobs.worker_owner");
  const fresh = Date.now() - Number(heartbeat.ts ?? 0) <= 30_000;
  const ownerMatches = !owner || heartbeat.workerId === owner;
  if (
    !fresh
    || !ownerMatches
    || heartbeat.validator !== "freecad-native"
    || Number(heartbeat.libraryVersion) !== CAD_LIBRARY_VERSION
  ) {
    return { ok: false, error: "CAD 生成服务正在启动或暂时不可用，本次未扣积分" };
  }
  return { ok: true };
}
