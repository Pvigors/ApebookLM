import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import { AppConfigValidationError, getAppConfig, setAppConfig } from "@/lib/app-config";
import { recordEvent } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "settings");
  if (g instanceof NextResponse) return g;
  return NextResponse.json({ config: await getAppConfig() });
}

export async function PUT(req: NextRequest) {
  const g = await requireRole(req, "settings", { write: true });
  if (g instanceof NextResponse) return g;
  const body = await req.json().catch(() => ({}));
  try {
    await setAppConfig(body.config || {}, g.id);
  } catch (error) {
    if (error instanceof AppConfigValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  await recordEvent({
    actorId: g.id,
    actorKind: "admin",
    action: "admin.settings_update",
    targetType: "setting",
    meta: { keys: Object.keys(body.config || {}) },
  });
  return NextResponse.json({ config: await getAppConfig() });
}
