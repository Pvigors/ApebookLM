import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/admin";
import { creditConsumptionByDaySince } from "@/lib/db";
import { getPool } from "@/lib/pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 数据分析:用户增长 / 留存 / 内容生产 / 搜索与积分 / 推广转化。只读聚合,无管理动作。
 *  全部日切按东八区(UTC+8),与用户侧额度、积分对账同口径(见 lib/db.ts usageDay)。 */

const TZ = 8 * 3600_000; // 东八区偏移
const DAYS = 30;

// 东八区日序号(floor((ts+TZ)/86400000))→ 'MM-DD' 标签:把日序号按 UTC 展开即得北京墙钟日期。
const dayLabel = (d: number) => {
  const t = new Date(d * 86400_000);
  return `${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};

export async function GET(req: NextRequest) {
  const g = await requireRole(req, "analytics");
  if (g instanceof NextResponse) return g;
  const pool = getPool();
  const one = async (sql: string, ...args: unknown[]) =>
    Number(((await pool.query(sql, args)).rows[0] as { n: number } | undefined)?.n ?? 0);

  const todayIdx = Math.floor((Date.now() + TZ) / 86400_000);
  const startIdx = todayIdx - (DAYS - 1);
  const sinceMs = startIdx * 86400_000 - TZ; // 30 天窗口首日的北京 0 点(UTC 毫秒)
  // SQL 里的东八区日序号表达式(列名参数化拼接,均为内部常量)。
  const dayOf = (col: string) => `CAST((${col} + ${TZ}) / 86400000 AS INTEGER)`;

  // 逐日聚合 → 补零成连续 30 天序列。
  const byDay = async (sql: string, ...args: unknown[]): Promise<Map<number, number>> => {
    const rows = (await pool.query(sql, args)).rows as { day: number; n: number }[];
    return new Map(rows.map((r) => [Number(r.day), Number(r.n)]));
  };
  const days = Array.from({ length: DAYS }, (_, i) => startIdx + i);

  // ---- 用户增长:每日新注册 + 每日活跃(activity_log 用户事件去重,保留 90 天,够用)----
  const newMap = await byDay(
    `SELECT ${dayOf("created_at")} AS day, COUNT(*) AS n FROM users WHERE created_at >= $1 GROUP BY day`,
    sinceMs
  );
  const actMap = await byDay(
    `SELECT ${dayOf("ts")} AS day, COUNT(DISTINCT actor_id) AS n FROM activity_log
     WHERE ts >= $1 AND actor_kind = 'user' AND actor_id IS NOT NULL GROUP BY day`,
    sinceMs
  );
  const growth = days.map((d) => ({
    day: dayLabel(d),
    newUsers: newMap.get(d) ?? 0,
    activeUsers: actMap.get(d) ?? 0,
  }));

  // ---- KPI:DAU / WAU / 次日留存 / 7 日留存 ----
  const distinctActive = (fromIdx: number) =>
    one(
      "SELECT COUNT(DISTINCT actor_id) n FROM activity_log WHERE ts >= $1 AND actor_kind = 'user' AND actor_id IS NOT NULL",
      fromIdx * 86400_000 - TZ
    );
  const dau = await distinctActive(todayIdx);
  const wau = await distinctActive(todayIdx - 6);

  // 留存:某日新注册用户中,第 offset 日在 activity_log 有任意事件的比例(合并窗口内全部
  // 队列做加权平均,小样本下比逐日平均稳)。样本为 0 → null(前端显示「样本不足」)。
  const retention = async (offset: number, fromIdx: number, toIdx: number): Promise<number | null> => {
    const r = (
      await pool.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM((EXISTS(
                  SELECT 1 FROM activity_log a
                  WHERE a.actor_id = u.id AND a.actor_kind = 'user'
                    AND ${dayOf("a.ts")} = ${dayOf("u.created_at")} + ${offset}
                ))::int), 0) AS kept
         FROM users u WHERE ${dayOf("u.created_at")} BETWEEN $1 AND $2`,
        [fromIdx, toIdx]
      )
    ).rows[0] as { total: number; kept: number };
    const total = Number(r.total);
    const kept = Number(r.kept);
    return total > 0 ? Math.round((kept / total) * 1000) / 10 : null;
  };
  const kpi = {
    dau,
    wau,
    d1: await retention(1, todayIdx - 14, todayIdx - 1), // 近 14 天注册队列(次日已过完整一天)
    d7: await retention(7, todayIdx - 28, todayIdx - 7), // 近 4 周注册队列(第 7 日已到)
  };

  // ---- 内容生产:来源(排除笔记影子源)/ 制品 / 用户提问 ----
  const srcMap = await byDay(
    `SELECT ${dayOf("created_at")} AS day, COUNT(*) AS n FROM sources
     WHERE created_at >= $1 AND (origin IS NULL OR origin NOT LIKE 'note:%') GROUP BY day`,
    sinceMs
  );
  const outMap = await byDay(
    `SELECT ${dayOf("created_at")} AS day, COUNT(*) AS n FROM studio_outputs WHERE created_at >= $1 GROUP BY day`,
    sinceMs
  );
  const msgMap = await byDay(
    `SELECT ${dayOf("created_at")} AS day, COUNT(*) AS n FROM messages WHERE created_at >= $1 AND role = 'user' GROUP BY day`,
    sinceMs
  );
  const content = days.map((d) => ({
    day: dayLabel(d),
    sources: srcMap.get(d) ?? 0,
    outputs: outMap.get(d) ?? 0,
    messages: msgMap.get(d) ?? 0,
  }));

  // ---- 制品分布(近 30 天,按类型)----
  const outputsByKind = (
    await pool.query(
      "SELECT kind, COUNT(*) AS n FROM studio_outputs WHERE created_at >= $1 GROUP BY kind ORDER BY n DESC",
      [sinceMs]
    )
  ).rows as { kind: string; n: number }[];

  // ---- 搜索使用量(发现搜索,activity_log 埋点)----
  const discMap = await byDay(
    `SELECT ${dayOf("ts")} AS day, COUNT(*) AS n FROM activity_log
     WHERE ts >= $1 AND action = 'discover.search' GROUP BY day`,
    sinceMs
  );
  const discoverByDay = days.map((d) => ({ day: dayLabel(d), n: discMap.get(d) ?? 0 }));

  // ---- 积分净消耗 ----
  // 与积分对账、数据工作台共用数据库真源：排除管理员赠送/邀请/注册赠送/补偿，
  // 保留 refund:/settle: 负流水冲抵原消费。
  const credMap = new Map(
    (await creditConsumptionByDaySince(sinceMs)).map((row) => [Number(row.day), Number(row.credits)])
  );
  const credits = days.map((d) => ({ day: dayLabel(d), credits: credMap.get(d) ?? 0 }));

  // ---- 邀请推广(累计口径)----
  const referral = {
    invited: await one("SELECT COUNT(DISTINCT referee_id) n FROM referrals"),
    milestones: await one("SELECT COUNT(*) n FROM referrals"),
    totalCredits: await one("SELECT COALESCE(SUM(credits), 0) n FROM referrals"),
    topInviters: (
      await pool.query(
        `SELECT COALESCE(u.name, '(已注销)') AS name,
                COUNT(DISTINCT r.referee_id) AS invitees,
                COALESCE(SUM(r.credits), 0) AS credits
         FROM referrals r LEFT JOIN users u ON u.id = r.referrer_id
         GROUP BY r.referrer_id, u.name ORDER BY credits DESC, invitees DESC LIMIT 5`
      )
    ).rows as { name: string; invitees: number; credits: number }[],
  };

  return NextResponse.json({ growth, kpi, content, outputsByKind, discoverByDay, credits, referral });
}
