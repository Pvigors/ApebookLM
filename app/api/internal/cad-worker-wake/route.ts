import { NextResponse } from "next/server";
import { cadWorkerReadiness, kickWorker } from "@/lib/jobs";
import { freeCadStepValidatorHealth } from "@/lib/cad-step-validation";
import { setSetting } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 仅独立 cad-worker 容器开启的内部健康/唤醒点。web 容器固定返回 404，
 * cad-worker 也不映射宿主机端口，因此不形成公网控制面。
 */
export async function GET() {
  if (
    process.env.NBLM_INTERNAL_CAD_WORKER_HOST !== "1"
    || process.env.NBLM_CAD_WORKER_ENABLED === "0"
  ) {
    return new NextResponse(null, { status: 404 });
  }
  const validator = await freeCadStepValidatorHealth();
  if (!validator.ok) {
    return NextResponse.json(
      { error: "CAD 独立 STEP 复读器不可用", code: "cad_validator_unavailable" },
      { status: 503 }
    );
  }
  const worker = await cadWorkerReadiness();
  if (worker.eligible) {
    await setSetting("jobs.cad_worker_heartbeat", JSON.stringify({
      ts: Date.now(),
      workerId: worker.workerId,
      validator: "freecad-native",
      version: validator.version ?? "unknown",
      libraryVersion: worker.libraryVersion,
    }), "system:cad-worker");
  }
  kickWorker();
  return NextResponse.json({
    ok: true,
    lane: "cad",
    validator: "freecad-native",
    version: validator.version,
    eligible: worker.eligible,
    workerId: worker.workerId,
    libraryVersion: worker.libraryVersion,
  });
}
