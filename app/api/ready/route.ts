import { getSettingsByPrefix } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 蓝绿切流前的业务就绪探针。与只做 SELECT 1 的 /api/health 不同，
 * 这里会经过 lib/db 的幂等 schema 初始化，但不返回任何配置值。
 */
export async function GET() {
  try {
    await getSettingsByPrefix("__readiness__.");
    return Response.json({ ok: true, ready: true, ts: Date.now() });
  } catch {
    return Response.json({ ok: false, ready: false }, { status: 503 });
  }
}
