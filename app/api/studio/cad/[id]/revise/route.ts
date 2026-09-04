import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getStudioOutput, quotaExceededMessage } from "@/lib/db";
import { requireAccess } from "@/lib/auth";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import { enqueueCadRevisionArtifact } from "@/lib/jobs";
import { cadRuntimeHealth } from "@/lib/cad";
import { text2cadRuntimeHealth } from "@/lib/text2cad";
import { CadRevisionValidationError, prepareCadRevision } from "@/lib/cad-revision";
import { recordEvent } from "@/lib/activity";
import { creditCostForOp } from "@/lib/credits-config";
import { getAppConfig, isArtifactVisible } from "@/lib/app-config";
import { requireRole } from "@/lib/admin";
import { cadWorkerHeartbeatReady } from "@/lib/cad-worker-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 320 * 1024;

async function readLimitedJson(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new CadRevisionValidationError("请求格式无效");
  const declared = req.headers.get("content-length")?.trim() ?? "";
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new CadRevisionValidationError("请求体过大");
  }
  if (!req.body) throw new CadRevisionValidationError("请求内容为空");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel("cad revision body too large").catch(() => {});
        throw new CadRevisionValidationError("请求体过大");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(merged));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("object required");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new CadRevisionValidationError("请求内容不是合法 JSON");
  }
}

/** POST { baseHash, patch } —— 校验受控参数后排队生成新 CAD 版本，原版保持不变。 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "CAD 制品 ID 无效" }, { status: 400 });
  }
  const out = await getStudioOutput(id);
  if (!out || out.kind !== "cad") {
    return NextResponse.json({ error: "CAD 制品不存在" }, { status: 404 });
  }
  const user = await requireAccess(req, out.notebook_id, true);
  if (user instanceof NextResponse) return user;

  // 修订与首次生成必须共用同一 CAD 灰度门。否则入口下架后，知道旧制品 ID 的
  // 普通成员仍可直接调用本路由继续生成并扣费。管理员保留受审计的验收通道。
  const appConfig = await getAppConfig();
  if (!isArtifactVisible("cad", appConfig, false)) {
    const elevated = await requireRole(req, "settings", { write: true });
    if (elevated instanceof NextResponse) {
      return NextResponse.json({ error: "CAD 模型暂未开放" }, { status: 403 });
    }
  }

  const perUser = rateLimit(`cad-revise:${user.id}`, 10, 60_000);
  if (!perUser.ok) return tooMany(perUser.retryAfter);
  const perOutput = rateLimit(`cad-revise-output:${user.id}:${id}`, 5, 60_000);
  if (!perOutput.ok) return tooMany(perOutput.retryAfter);

  let body: Record<string, unknown>;
  try {
    body = await readLimitedJson(req);
  } catch (error) {
    const message = error instanceof CadRevisionValidationError ? error.message : "请求内容无效";
    return NextResponse.json(
      { error: message },
      { status: message === "请求体过大" ? 413 : message === "请求格式无效" ? 415 : 400 }
    );
  }
  const unknownBodyKey = Object.keys(body).find((key) => key !== "baseHash" && key !== "patch");
  if (unknownBodyKey) {
    return NextResponse.json({ error: `请求不支持字段 ${unknownBodyKey}` }, { status: 400 });
  }
  const baseHash = typeof body.baseHash === "string" ? body.baseHash.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(baseHash)) {
    return NextResponse.json({ error: "原版本校验值无效" }, { status: 400 });
  }
  const currentHash = createHash("sha256").update(out.content || "", "utf8").digest("hex");
  let frozenHash = "";
  try {
    const data = JSON.parse(out.data || "{}") as {
      manifest?: { hash?: unknown };
      modelSelection?: { tutorialExample?: unknown };
    };
    if (data.modelSelection?.tutorialExample === true) {
      return NextResponse.json(
        { error: "教学示例使用系统默认尺寸，请填写明确建模目标后重新生成正式模型" },
        { status: 409 }
      );
    }
    frozenHash = typeof data.manifest?.hash === "string" ? data.manifest.hash : "";
  } catch {
    return NextResponse.json({ error: "原 CAD 数据快照无效" }, { status: 409 });
  }
  if (baseHash !== currentHash || frozenHash !== currentHash) {
    return NextResponse.json({ error: "原 CAD 版本已变化，请刷新后重新编辑" }, { status: 409 });
  }

  let prepared;
  try {
    prepared = prepareCadRevision(out.content, body.patch);
  } catch (error) {
    const message = error instanceof Error && /[一-鿿]/.test(error.message)
      ? error.message.slice(0, 180)
      : "编辑参数不符合当前 CAD 规格";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (prepared.unchanged) {
    return NextResponse.json({ unchanged: true, output: out });
  }
  const worker = await cadWorkerHeartbeatReady();
  if (!worker.ok) {
    return NextResponse.json(
      { error: worker.error, code: "cad_worker_unavailable" },
      { status: 503, headers: { "Retry-After": "10" } }
    );
  }
  const health = prepared.schemaVersion === 2
    ? await text2cadRuntimeHealth()
    : await cadRuntimeHealth();
  if (!health.ok) {
    return NextResponse.json({ error: health.error, code: "cad_runtime_unavailable" }, { status: 503 });
  }

  const cost = await creditCostForOp("cad_rebuild");
  let queued;
  try {
    queued = await enqueueCadRevisionArtifact(
      out.notebook_id,
      user.id,
      {
        parentOutputId: out.id,
        baseHash,
        targetHash: prepared.hash,
        patch: body.patch,
      },
      cost,
      out.title
    );
  } catch (error) {
    console.error("[cad revise] 入队失败:", error);
    return NextResponse.json({ error: "CAD 新版本任务创建失败，请重试" }, { status: 500 });
  }
  if (queued.conflict) {
    return NextResponse.json(
      { error: "该 CAD 版本已有修订任务，请等待完成后再编辑" },
      { status: 409 }
    );
  }
  if (queued.over || !queued.job) {
    const quota = queued.quota;
    return NextResponse.json(
      {
        error: quota
          ? quotaExceededMessage(quota, cost)
          : "CAD 任务排队过多，请等待当前任务完成后再试",
        code: quota ? "quota" : "too_many_jobs",
      },
      { status: 429 }
    );
  }
  const job = queued.job;
  await recordEvent({
    actorId: user.id,
    actorKind: "user",
    action: "studio.cad.revise",
    targetType: "job",
    targetId: job.id,
    notebookId: out.notebook_id,
    meta: {
      parentOutputId: out.id,
      baseHash,
      schemaVersion: prepared.schemaVersion,
      changedFields: prepared.changedFields,
    },
  });
  return NextResponse.json(
    {
      job,
      baseOutputId: out.id,
      baseHash,
      reused: queued.reused,
      billing: { reservedCredits: Number(job.credits_reserved ?? cost), settlement: "deterministic_geometry" },
    },
    { status: 202 }
  );
}
