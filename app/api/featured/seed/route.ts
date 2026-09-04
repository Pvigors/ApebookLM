import { NextRequest, NextResponse } from "next/server";
import { seedFeatured } from "@/lib/featured-seed";
import { requireRole } from "@/lib/admin";
import { recordEvent } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Idempotent seed of the curated "快速上手" featured notebook (管理员限定)。
// POST ?force=1 rebuilds it from scratch (used after editing the seed content).
export async function POST(req: NextRequest) {
  const g = await requireRole(req, "featured", { write: true });
  if (g instanceof NextResponse) return g;
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const r = await seedFeatured({ force });
    recordEvent({ actorId: g.id, actorKind: "admin", action: "admin.featured_seed", meta: { force } });
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
