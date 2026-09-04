import { NextRequest, NextResponse } from "next/server";
import { requireNotebookEditAccess } from "@/lib/auth";
import { requireRole } from "@/lib/admin";
import { getAppConfig, isArtifactVisible } from "@/lib/app-config";
import {
  CadPreflightBusyError,
  cadPreflightStatus,
  resolveCadPreflightGuarded,
  type CadPreflightBody,
} from "@/lib/cad-preflight-server";
import { consumeCadAdmissionRateLimit } from "@/lib/cad-admission-guard";
import { JsonBodyError, readJsonObjectLimited } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireNotebookEditAccess(req, id);
  if (guard instanceof NextResponse) return guard;

  const config = await getAppConfig();
  if (!isArtifactVisible("cad", config, false)) {
    const elevated = await requireRole(req, "settings", { write: true });
    if (elevated instanceof NextResponse) {
      return NextResponse.json({ error: "该智能输出类型暂未开放", code: "cad_disabled" }, { status: 403 });
    }
  }

  // 免费不等于无界：在读取/正则扫描/哈希最多 6MB 来源前，先过
  // 用户 + 笔记本 + 全局的进程内与 PG 共享限流。
  const limit = await consumeCadAdmissionRateLimit("preflight", guard.id, id);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "CAD 预检过于频繁，请稍后重试", code: "cad_preflight_rate_limited" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }

  let body: CadPreflightBody;
  try {
    body = await readJsonObjectLimited(req, 32 * 1024) as CadPreflightBody;
  } catch (error) {
    if (error instanceof JsonBodyError) {
      return NextResponse.json({ error: error.message, code: "cad_request_invalid" }, { status: error.status });
    }
    throw error;
  }
  const allowedBodyKeys = new Set([
    "mode", "sourceIds", "instruction", "templateId", "cadTemplate", "targetObjectId",
    "parameters", "allowAssumptions", "tutorialExample",
  ]);
  const unknownBodyKey = Object.keys(body as Record<string, unknown>).find((key) => !allowedBodyKeys.has(key));
  if (unknownBodyKey) {
    return NextResponse.json(
      { error: `CAD 预检不支持字段 ${unknownBodyKey}`, code: "cad_request_invalid" },
      { status: 400 }
    );
  }
  let resolved;
  try {
    resolved = await resolveCadPreflightGuarded(id, body, { cache: true });
  } catch (error) {
    if (error instanceof CadPreflightBusyError) {
      return NextResponse.json(
        { error: error.message, code: "cad_preflight_busy" },
        { status: 429, headers: { "Retry-After": "2" } }
      );
    }
    throw error;
  }
  const status = cadPreflightStatus(resolved.result);
  if (!resolved.result.ok) {
    return NextResponse.json({
      status,
      code: resolved.result.error.code,
      error: resolved.result.error.message,
      issues: [resolved.result.error],
    }, { status: 422 });
  }
  return NextResponse.json({
    status,
    plan: resolved.result.plan,
    planHash: resolved.result.plan.planHash,
    issues: [],
  });
}
