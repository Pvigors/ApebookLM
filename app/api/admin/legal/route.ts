import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import {
  getLegalDoc,
  getDefaultLegalDoc,
  isLegalOverridden,
  setLegalDoc,
  resetLegalDoc,
  type LegalSlug,
} from "@/lib/legal";
import { recordEvent } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUGS: LegalSlug[] = ["agreement", "privacy"];

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "legal");
  if (g instanceof NextResponse) return g;
  const docs = await Promise.all(
    SLUGS.map(async (s) => ({ slug: s, doc: await getLegalDoc(s), overridden: await isLegalOverridden(s) }))
  );
  return NextResponse.json({ docs });
}

export async function PUT(req: NextRequest) {
  const g = await requireRole(req, "legal", { write: true });
  if (g instanceof NextResponse) return g;
  const body = await req.json().catch(() => ({}));
  const slug = body.slug as LegalSlug;
  if (!SLUGS.includes(slug)) return NextResponse.json({ error: "无效文档" }, { status: 400 });
  if (body.reset) {
    await resetLegalDoc(slug);
    await recordEvent({ actorId: g.id, actorKind: "admin", action: "admin.legal_reset", targetType: "setting", targetId: `legal.${slug}` });
    return NextResponse.json({ doc: getDefaultLegalDoc(slug), overridden: false });
  }
  await setLegalDoc(slug, body.doc || {}, g.id);
  await recordEvent({ actorId: g.id, actorKind: "admin", action: "admin.legal_update", targetType: "setting", targetId: `legal.${slug}` });
  return NextResponse.json({ doc: await getLegalDoc(slug), overridden: true });
}
