import type { NextRequest } from "next/server";
import { getPool } from "./pg";
import type { ActivityActorKind, ActivityEvent } from "./types";

/**
 * 取客户端 IP。X-Forwarded-For 形如「client, proxy1, proxy2」,**最左是客户端可伪造的**,
 * 因此取「从右数第 TRUSTED_PROXY_HOPS 跳」——即可信反代追加的、它实际看到的对端地址,
 * 防止客户端在左侧塞假 IP 绕过 IP 维度限流。部署在单个可信反代后时默认 hops=1(取最右)。
 * 注意:仍要求反代覆盖/剥离客户端传入的 XFF(见 docs/SECURITY-REVIEW.md 部署要求)。
 */
export function clientIp(req: NextRequest): string | null {
  const hops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS || "1"));
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[Math.max(0, parts.length - hops)] || null;
  }
  return req.headers.get("x-real-ip") || null;
}

/** 从请求取客户端 IP / UA(给 auth 等记录用)。 */
export function reqMeta(req: NextRequest): { ip: string | null; ua: string | null } {
  return { ip: clientIp(req), ua: req.headers.get("user-agent") };
}

/**
 * 统一活动 / 审计记录层 —— 谁在何时对什么做了什么。
 *
 * 设计取舍(对齐 logAiCall):
 * - **吞掉自身异常**:记录失败绝不能拖垮业务请求。
 * - **append-only**:只插不改,管理审计可信。
 * - meta 走 JSON 旁注,密钥等敏感值在调用方脱敏后再传入。
 */
export interface RecordEventInput {
  actorId?: string | null;
  actorKind: ActivityActorKind;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  notebookId?: string | null;
  meta?: unknown;
  ip?: string | null;
  ua?: string | null;
}

// META-1:meta 含调用方可控原文(协作者 account、discover query 等)。落库前
// 序列化并硬截断 + 剥离控制字符,防止超长内容撑大审计表 / CRLF 污染日志视图。
function safeMeta(meta: unknown): string | null {
  if (meta === undefined) return null;
  const s = JSON.stringify(meta);
  if (s == null) return null;
  // 剥离控制字符(<0x20 与 0x7f),逐码点过滤,避免 CRLF/ANSI 注入日志视图。
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? " " : ch;
  }
  return out.length > 4000 ? out.slice(0, 4000) : out;
}

export async function recordEvent(e: RecordEventInput): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO activity_log
         (ts, actor_id, actor_kind, action, target_type, target_id, notebook_id, meta, ip, ua)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        Date.now(),
        e.actorId ?? null,
        e.actorKind,
        e.action,
        e.targetType ?? null,
        e.targetId ?? null,
        e.notebookId ?? null,
        safeMeta(e.meta),
        e.ip ?? null,
        e.ua ?? null,
      ]
    );
  } catch {
    /* 记录失败不影响主流程 */
  }
}

export interface ListEventsOpts {
  actorKind?: ActivityActorKind;
  actorId?: string;
  action?: string;
  targetType?: string;
  notebookId?: string;
  /** action 前缀过滤,如 "admin." 取所有管理操作。 */
  actionPrefix?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

// 返回 $N 占位起始编号由 next() 递增,便于 listEvents 追加的 LIMIT/OFFSET 续号。
function buildWhere(opts: ListEventsOpts): { sql: string; args: unknown[] } {
  const conds: string[] = [];
  const args: unknown[] = [];
  const ph = () => `$${args.length + 1}`;
  if (opts.actorKind) {
    conds.push(`a.actor_kind = ${ph()}`);
    args.push(opts.actorKind);
  }
  if (opts.actorId) {
    conds.push(`a.actor_id = ${ph()}`);
    args.push(opts.actorId);
  }
  if (opts.action) {
    conds.push(`a.action = ${ph()}`);
    args.push(opts.action);
  }
  if (opts.actionPrefix) {
    conds.push(`a.action LIKE ${ph()}`);
    args.push(opts.actionPrefix + "%");
  }
  if (opts.targetType) {
    conds.push(`a.target_type = ${ph()}`);
    args.push(opts.targetType);
  }
  if (opts.notebookId) {
    conds.push(`a.notebook_id = ${ph()}`);
    args.push(opts.notebookId);
  }
  if (opts.since) {
    conds.push(`a.ts >= ${ph()}`);
    args.push(opts.since);
  }
  if (opts.until) {
    conds.push(`a.ts <= ${ph()}`);
    args.push(opts.until);
  }
  return { sql: conds.length ? "WHERE " + conds.join(" AND ") : "", args };
}

/** 倒序拉取活动记录,联表带出操作者名。 */
export async function listEvents(opts: ListEventsOpts = {}): Promise<ActivityEvent[]> {
  const { sql, args } = buildWhere(opts);
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const limitPh = `$${args.length + 1}`;
  const offsetPh = `$${args.length + 2}`;
  const res = await getPool().query(
    `SELECT a.*, u.name AS actor_name
       FROM activity_log a LEFT JOIN users u ON u.id = a.actor_id
       ${sql}
       ORDER BY a.ts DESC
       LIMIT ${limitPh} OFFSET ${offsetPh}`,
    [...args, limit, offset]
  );
  return res.rows as ActivityEvent[];
}

export async function countEvents(opts: ListEventsOpts = {}): Promise<number> {
  const { sql, args } = buildWhere(opts);
  const res = await getPool().query(
    `SELECT COUNT(*) n FROM activity_log a ${sql}`,
    args
  );
  return (res.rows[0] as { n: number } | undefined)?.n ?? 0;
}

/**
 * 删除 N 天前的活动记录,返回删除行数。
 * 默认只清理「用户/匿名/系统」活动;管理操作(actor_kind='admin' / action 'admin.*')长期保留,
 * 与后台「管理操作长期保留」承诺一致。传 includeAdmin=true 才一并清理。
 */
export async function purgeEvents(beforeTs: number, includeAdmin = false): Promise<number> {
  const sql = includeAdmin
    ? "DELETE FROM activity_log WHERE ts < $1"
    : "DELETE FROM activity_log WHERE ts < $1 AND actor_kind <> 'admin' AND action NOT LIKE 'admin.%'";
  const res = await getPool().query(sql, [beforeTs]);
  return res.rowCount ?? 0;
}
