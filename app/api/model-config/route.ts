import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import {
  deleteUserModelConfig,
  disableUserModelConfig,
  getUserModelConfig,
} from "@/lib/db";
import { JsonBodyError, readJsonObjectLimited } from "@/lib/json-body";
import { publicModelProviderCatalog } from "@/lib/model-provider-catalog";
import { sameOriginError } from "@/lib/request-origin";
import {
  modelConfigEncryptionReady,
  saveUserModelConfigDraft,
  UserModelConfigError,
  userModelConfigStatus,
} from "@/lib/user-model-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function responseBody(row: Awaited<ReturnType<typeof getUserModelConfig>>) {
  return {
    encryptionReady: modelConfigEncryptionReady(),
    providers: publicModelProviderCatalog(),
    config: userModelConfigStatus(row),
  };
}

function jsonError(error: unknown) {
  if (error instanceof JsonBodyError) {
    return NextResponse.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  }
  if (error instanceof UserModelConfigError) {
    const status = error.code === "config_stale" ? 409 : error.code === "encryption_unavailable" ? 503 : 400;
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status, headers: NO_STORE }
    );
  }
  return NextResponse.json(
    { error: "模型配置保存失败，请重试", code: "save_failed" },
    { status: 500, headers: NO_STORE }
  );
}

async function requireUser(req: NextRequest) {
  const user = await userFromRequest(req);
  return user ?? NextResponse.json({ error: "未登录" }, { status: 401, headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  return NextResponse.json(responseBody(await getUserModelConfig(user.id)), { headers: NO_STORE });
}

export async function PUT(req: NextRequest) {
  const originError = sameOriginError(req);
  if (originError) return originError;
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  try {
    const body = await readJsonObjectLimited(req, 4 * 1024);
    const allowed = new Set(["providerId", "chatModel", "visionModel", "researchModel", "apiKey"]);
    const unknown = Object.keys(body).find((key) => !allowed.has(key));
    if (unknown) {
      return NextResponse.json(
        { error: `不允许的配置字段：${unknown}`, code: "unknown_field" },
        { status: 400, headers: NO_STORE }
      );
    }
    if (!("providerId" in body) || !("chatModel" in body) || !("visionModel" in body)) {
      return NextResponse.json(
        { error: "供应商、对话模型和视觉模型字段不完整", code: "config_invalid" },
        { status: 400, headers: NO_STORE }
      );
    }
    const saved = await saveUserModelConfigDraft(user.id, {
      providerId: body.providerId,
      chatModel: body.chatModel,
      visionModel: body.visionModel,
      ...(Object.prototype.hasOwnProperty.call(body, "researchModel") ? { researchModel: body.researchModel } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "apiKey") ? { apiKey: body.apiKey } : {}),
    });
    return NextResponse.json(responseBody(saved), { headers: NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(req: NextRequest) {
  const originError = sameOriginError(req);
  if (originError) return originError;
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  try {
    const body = await readJsonObjectLimited(req, 512);
    if (Object.keys(body).length !== 1 || body.enabled !== false) {
      return NextResponse.json(
        { error: "停用请求格式无效", code: "config_invalid" },
        { status: 400, headers: NO_STORE }
      );
    }
    await disableUserModelConfig(user.id);
    return NextResponse.json(responseBody(await getUserModelConfig(user.id)), { headers: NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: NextRequest) {
  const originError = sameOriginError(req);
  if (originError) return originError;
  const user = await requireUser(req);
  if (user instanceof NextResponse) return user;
  await deleteUserModelConfig(user.id);
  return NextResponse.json(responseBody(undefined), { headers: NO_STORE });
}
