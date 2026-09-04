import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import { countEvents, listEvents, type ListEventsOpts } from "@/lib/activity";
import { getPool } from "@/lib/pg";
import type { ActivityActorKind } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set(["user", "admin", "anon", "system"]);

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "audit");
  if (g instanceof NextResponse) return g;
  const sp = req.nextUrl.searchParams;

  const opts: ListEventsOpts = {
    limit: Math.min(Number(sp.get("limit")) || 50, 200),
    offset: Math.max(Number(sp.get("offset")) || 0, 0),
  };
  const kind = sp.get("kind");
  if (kind && KINDS.has(kind)) opts.actorKind = kind as ActivityActorKind;
  const action = sp.get("action");
  if (action) opts.action = action;
  const prefix = sp.get("prefix");
  if (prefix) opts.actionPrefix = prefix;
  const notebook = sp.get("notebook");
  if (notebook) opts.notebookId = notebook;
  const actor = sp.get("actor");
  if (actor) opts.actorId = actor;
  const since = Number(sp.get("since"));
  if (since) opts.since = since;
  const until = Number(sp.get("until"));
  if (until) opts.until = until;

  // 供前端筛选下拉用的去重动作列表。
  const actions = (
    (await getPool().query("SELECT DISTINCT action FROM activity_log ORDER BY action")).rows as {
      action: string;
    }[]
  ).map((r) => r.action);

  return NextResponse.json({
    events: await listEvents(opts),
    total: await countEvents(opts),
    actions,
  });
}
