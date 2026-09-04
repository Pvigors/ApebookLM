import { getPool } from "@/lib/pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 公开无鉴权健康检查:给负载均衡 / compose healthcheck / UptimeRobot 用。
// 只探一次数据库连通性,响应仅含 ok + 时间戳,绝不泄露任何内部信息。
export async function GET() {
  try {
    await getPool().query("SELECT 1");
    return Response.json({ ok: true, ts: Date.now() });
  } catch {
    return Response.json({ ok: false, error: "db down" }, { status: 503 });
  }
}
