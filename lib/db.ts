import fs from "node:fs";
import path from "node:path";
import nodeCrypto from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "./pg";
import { callCostCNY } from "./credits";
import { deleteOutputMedia } from "./media";
import { getPlan, isEntitledTier, mergePlanOverrides, TRIAL_CREDITS, TRIAL_DAYS, type Plan } from "./plans";
import { effectivePlanTierForUser, hasUsageAccess } from "./membership";
import { isSystemAdminUser } from "./admin-identity";
import {
  isSignupCreditEligible,
  readSignupCreditIssueState,
  SIGNUP_CREDIT_UPGRADE_OP,
} from "./signup-credits";
import { experienceAccountByUserId, type ExperienceAccount } from "./experience-access";
import {
  adminPasswordAccount,
  adminPasswordAccountByUserId,
  AdminPasswordStateError,
  isAdminPasswordLoginEnforced,
  isAdminPasswordUserId,
  type AdminPasswordAccount,
} from "./admin-password-access";
import {
  isLocalPreviewUserId,
  localPreviewAccountByUserId,
  type LocalPreviewAccount,
} from "./local-preview-auth";
import type {
  Notebook,
  Source,
  SourceStatus,
  SourceType,
  Chunk,
  ChatMessage,
  Citation,
  Note,
  NoteKind,
  StudioOutput,
  StudioKind,
  JobKind,
  User,
  Job,
  JobStatus,
  JobLane,
  Notification,
} from "./types";
import type { ExtractionProvenance } from "./extraction/types";

// ---------------------------------------------------------------------------
// PostgreSQL 数据访问层(从同步 better-sqlite3 迁移为异步 pg)。
//   - 所有导出函数签名不变,只是全部改成 async(返回 Promise)。
//   - encodeEmbedding/decodeEmbedding 是纯函数,不碰。
//   - 占位符从 SQLite 的 `?` 改为 PG 的 `$1,$2,...`(每条查询独立从 $1 编号)。
//   - 事务(原 db.transaction)改为从池借一个 client,BEGIN/COMMIT/ROLLBACK。
// ---------------------------------------------------------------------------

// BUILD-1 守卫等价物:`next build`「收集页面数据」阶段 Next 会并行 import 每个 route
// 模块只为读其导出;若任何顶层链偶然触发 DB 就会连库 + 建表。构建期没有请求要处理,
// 抛错让「构建期 import 不小心触发 DB」变响亮而非静默。运行时行为一字不改。
function assertNotBuildPhase(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    throw new Error(
      "BUILD-GUARD: DB accessed during next build collect-page-data phase; a module has an unwanted top-level DB side effect"
    );
  }
}

// 惰性一次性建表(记忆化 Promise,防并发首用时重复建表)。
let inited: Promise<void> | null = null;

async function ensureInited(): Promise<void> {
  assertNotBuildPhase();
  if (!inited) {
    inited = initSchema();
    // 任务宿主拉起(P0-7 冒烟实锤的缺口):worker/订阅源扫描器挂在 lib/jobs 模块加载处,
    // 而 lib/jobs 只有 studio 类路由才 import —— 空站/只浏览的实例永远不轮询订阅源。
    // 首次 DB 访问后主动动态 import 拉起;NEXT_RUNTIME 门禁防旁路脚本(种子/评测)
    // import lib/db 时把 worker 拉起抢队列(压测有案);动态 import 不产生循环依赖问题
    // (此刻 db 模块已初始化完毕)。失败仅告警:路由自身的 import 仍是兜底。
    if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
      void inited
        .then(() => import("./jobs"))
        .catch((e) => console.warn("[db] 任务宿主拉起失败(忽略,路由 import 兜底):", e));
    }
  }
  return inited;
}

/** 池的薄封装:首次使用时惰性跑一次 initSchema()。参数用位置占位符 `$1..`。 */
async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<{ rows: T[]; rowCount: number }> {
  await ensureInited();
  const r = await getPool().query(sql, params);
  return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
}

/** 取一行(无则 undefined)。 */
async function get<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const r = await query<T>(sql, params);
  return r.rows[0];
}

/** 取全部行。 */
async function all<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await query<T>(sql, params)).rows;
}

/** 执行(不关心返回行,只返回受影响行数)。 */
async function run(sql: string, params: unknown[] = []): Promise<number> {
  return (await query(sql, params)).rowCount;
}

// ---- 池直连(不触发 ensureInited):仅供 initSchema 内部使用,避免自死锁 ----
// initSchema 期间 `inited` 已被赋值为尚未 resolve 的本 promise,若内部再走上面的
// query/get/all/run(它们 await ensureInited())就会 await 自己 → 永久挂起。
async function pall<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
async function prun(sql: string, params: unknown[] = []): Promise<number> {
  return (await getPool().query(sql, params)).rowCount ?? 0;
}

/**
 * 建表 + 幂等迁移。读 db/schema.pg.sql 执行(含全部列),再用 ALTER ... ADD COLUMN
 * IF NOT EXISTS 双保险补齐存量库缺失的列(PG 支持 IF NOT EXISTS)。
 * 最后同步独立密码管理员并回收孤儿 running 任务。
 */
export async function initSchema(): Promise<void> {
  assertNotBuildPhase();
  const pool = getPool();

  // 1) 主 DDL(CREATE TABLE IF NOT EXISTS,幂等)。
  const schemaPath = path.join(process.cwd(), "db", "schema.pg.sql");
  const ddl = fs.readFileSync(schemaPath, "utf8");
  await pool.query(ddl);

  // 2) 双保险:存量库补列(schema.pg.sql 已含,这里对老库幂等 ALTER)。
  const addCol = async (table: string, col: string, decl: string) => {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${decl}`);
  };
  await addCol("user_model_configs", "research_model", "TEXT NOT NULL DEFAULT ''");
  await addCol("sources", "selected", "BIGINT NOT NULL DEFAULT 1");
  await addCol("sources", "pages", "BIGINT NOT NULL DEFAULT 0");
  await addCol("sources", "summary", "TEXT");
  await addCol("sources", "key_topics", "TEXT NOT NULL DEFAULT '[]'");
  await addCol("sources", "origin", "TEXT");
  await addCol("sources", "content_hash", "TEXT");
  await addCol("sources", "fetched_at", "BIGINT");
  await addCol("sources", "extraction_backend", "TEXT NOT NULL DEFAULT 'native'");
  await addCol("sources", "extraction_version", "TEXT");
  await addCol("sources", "extraction_meta", "TEXT NOT NULL DEFAULT '{}'");
  await addCol("sources", "ingest_authored", "BIGINT NOT NULL DEFAULT 0");
  await addCol("sources", "ingest_lease_until", "BIGINT NOT NULL DEFAULT 0");
  await addCol("sources", "ingest_claim_token", "TEXT NOT NULL DEFAULT ''");
  await addCol("sources", "ingest_attempts", "BIGINT NOT NULL DEFAULT 0");
  await addCol("sources", "enrich_lease_until", "BIGINT NOT NULL DEFAULT 0");
  await addCol("sources", "enrich_claim_token", "TEXT NOT NULL DEFAULT ''");
  await addCol("sources", "enrich_attempts", "BIGINT NOT NULL DEFAULT 0");
  await addCol("sources", "enrich_retry_at", "BIGINT NOT NULL DEFAULT 0");
  await addCol("sources", "enriched_at", "BIGINT NOT NULL DEFAULT 0");
  // 存量 ready + 已有导读是旧链路已执行过增补的最可靠标记。只能在
  // 新列上线时回填一次：若每次启动都回填，新链路在“导读成功、概览前
  // SIGKILL”后会被误标完成。DB marker 同时保证多实例仅一个执行回填。
  await pool.query(
    `WITH marker AS (
       INSERT INTO app_settings(key, value, updated_at)
       VALUES ('migration.sources_enriched_at.v1', 'done', $1)
       ON CONFLICT(key) DO NOTHING
       RETURNING key
     )
     UPDATE sources
        SET enriched_at = GREATEST(COALESCE(fetched_at, 0), created_at)
      WHERE enriched_at = 0 AND status = 'ready' AND COALESCE(BTRIM(summary), '') <> ''
        AND EXISTS (SELECT 1 FROM marker)`,
    [Date.now()]
  );
  // 索引放在 addCol 之后：存量库先执行 schema.pg.sql 时 sources 表已存在，
  // 若在 schema 文件里直接引用新列，会在 ALTER 补列之前失败。
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_sources_ingest_recovery ON sources(notebook_id, ingest_lease_until) WHERE status = 'processing'"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_sources_enrich_recovery ON sources(notebook_id, enrich_lease_until) WHERE status = 'ready' AND enriched_at = 0"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_sources_enrich_due ON sources(notebook_id, enrich_retry_at, enrich_lease_until) WHERE status = 'ready' AND enriched_at = 0"
  );
  await addCol("messages", "feedback", "TEXT");
  await addCol("messages", "skill_id", "TEXT");
  await addCol("messages", "message_seq", "BIGSERIAL");
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_messages_stable_order ON messages(notebook_id, created_at, message_seq)"
  );
  await addCol("feedback", "images", "TEXT");
  await addCol("users", "email", "TEXT");
  // 不用存量 name 回填：name 可被用户自改，冒充微信名会制造错误事实。等下次真实授权同步。
  await addCol("users", "wechat_nickname", "TEXT");
  await addCol("users", "wechat_unionid", "TEXT");
  await addCol("users", "login_count", "BIGINT NOT NULL DEFAULT 0");
  await addCol("users", "last_login_at", "BIGINT NOT NULL DEFAULT 0");
  await addCol("users", "disabled", "BIGINT NOT NULL DEFAULT 0");
  await addCol("users", "is_admin", "BIGINT NOT NULL DEFAULT 0");
  await addCol("users", "admin_role", "TEXT");
  await addCol("users", "default_output_language", "TEXT");
  await addCol("users", "plan_tier", "TEXT NOT NULL DEFAULT 'free'");
  await addCol("users", "invite_code", "TEXT");
  await addCol("users", "referred_by", "TEXT");
  await addCol("users", "bonus_credits", "BIGINT NOT NULL DEFAULT 0");
  // 注册试用的发放时间戳。用它而不是「bonus_credits > 0」判重 —— 额度用完就归零,
  // 那样判会让每个把试用花光的人再领一次。
  await addCol("users", "trial_granted_at", "BIGINT NOT NULL DEFAULT 0");
  await addCol("users", "signup_credits_granted", "BIGINT NOT NULL DEFAULT 0");
  await addCol("users", "trial_expires_at", "BIGINT NOT NULL DEFAULT 0");
  await addCol("users", "plan_expires_at", "BIGINT NOT NULL DEFAULT 0");
  // 独立管理员配置指纹：存量 WIP 库先以空值迁移，下面的可信环境同步会立刻
  // 写入真实 SHA-256 指纹并撤销旧会话。
  await addCol("admin_password_principals", "credential_fingerprint", "TEXT NOT NULL DEFAULT ''");
  // 历史登录次数无法精确重建：activity_log 仅保留 90 天且旧微信链路会重复记事件。
  // sessions 每行确实对应一次成功颁发会话，因此只按尚存会话做保守下界回填。
  // GREATEST 只前进不后退，连续启动或退出/撤销会话都不会重复累加或冲掉新计数。
  await pool.query(
    `WITH legacy_sessions AS (
       SELECT user_id, COUNT(*)::BIGINT AS login_count, MAX(created_at)::BIGINT AS last_login_at
         FROM sessions
        GROUP BY user_id
     )
     UPDATE users u
        SET login_count = GREATEST(u.login_count, s.login_count),
            last_login_at = GREATEST(u.last_login_at, s.last_login_at)
       FROM legacy_sessions s
      WHERE u.id = s.user_id
        AND (u.login_count < s.login_count OR u.last_login_at < s.last_login_at)`
  );
  // db8ea00 已发放的试用用户没有独立到期快照。活跃 trial 以当前到期为准，
  // 已升级/已到期者按发放时 + 7 天回填，连续启动不会改写已有快照。
  await pool.query(
    `UPDATE users
        SET trial_expires_at = CASE
          WHEN plan_tier = 'trial' AND plan_expires_at > 0 THEN plan_expires_at
          ELSE trial_granted_at + $1
        END
      WHERE trial_expires_at = 0 AND trial_granted_at > 0`,
    [TRIAL_DAYS * 86400_000]
  );
  // 用户自定义隐藏的生成磁贴(逗号分隔 tile id;空=全显示,与后台 hidden_artifacts 同构的隐藏集语义)。
  await addCol("users", "hidden_tiles", "TEXT NOT NULL DEFAULT ''");
  await addCol("credit_ledger", "bonus", "BIGINT NOT NULL DEFAULT 0");
  // 新版双桶账本：NULL 专门标识部署前的旧流水，退回时按旧 user_usage 全额口径兼容。
  await addCol("credit_ledger", "plan_credits", "BIGINT");
  await addCol("credit_ledger", "unlimited_at_charge", "BIGINT NOT NULL DEFAULT 0");
  await addCol("credit_ledger", "refunded", "BIGINT NOT NULL DEFAULT 0");
  // 积分明细的「· 笔记本名」:消费时快照笔记本标题(存量行为 NULL,只显操作名)。
  await addCol("credit_ledger", "note", "TEXT");
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_signup_upgrade_200
       ON credit_ledger(user_id, op)
       WHERE op = 'bonus:signup:upgrade:200:v1'`
  );
  await addCol("notebooks", "summary", "TEXT");
  await addCol("notebooks", "suggested_questions", "TEXT NOT NULL DEFAULT '[]'");
  await addCol("notebooks", "chat_style", "TEXT NOT NULL DEFAULT 'default'");
  await addCol("notebooks", "chat_instructions", "TEXT");
  await addCol("notebooks", "response_length", "TEXT NOT NULL DEFAULT 'default'");
  await addCol("notebooks", "output_language", "TEXT");
  await addCol("notebooks", "public", "BIGINT NOT NULL DEFAULT 0");
  await addCol("notebooks", "pinned", "BIGINT NOT NULL DEFAULT 0");
  await addCol("notebooks", "user_id", "TEXT");
  await addCol("notebooks", "featured", "BIGINT NOT NULL DEFAULT 0");
  await addCol("notebooks", "featured_order", "BIGINT NOT NULL DEFAULT 0");
  await addCol("notebooks", "featured_category", "TEXT");
  await addCol("notebooks", "cover", "TEXT");
  await addCol("notebooks", "cover_image", "TEXT");
  await addCol("notebooks", "publisher", "TEXT");
  await addCol("notebooks", "publisher_avatar", "TEXT");
  await addCol("studio_outputs", "converted_to_source", "BIGINT NOT NULL DEFAULT 0");
  await addCol("studio_outputs", "job_id", "TEXT");
  await addCol("studio_outputs", "run_attempt", "BIGINT");
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_studio_job_processing ON studio_outputs(job_id, status) WHERE job_id IS NOT NULL"
  );
  await addCol("notes", "converted_to_source", "BIGINT NOT NULL DEFAULT 0");
  await addCol("notes", "shadow_source_id", "TEXT");
  await addCol("chunks", "section", "TEXT");
  await addCol("jobs", "priority", "BIGINT NOT NULL DEFAULT 0");
  await addCol("jobs", "run_attempt", "BIGINT NOT NULL DEFAULT 0");
  await addCol("jobs", "lane", "TEXT");
  await addCol("jobs", "started_at", "BIGINT NOT NULL DEFAULT 0");
  await addCol("jobs", "finished_at", "BIGINT NOT NULL DEFAULT 0");
  await addCol("jobs", "stage", "TEXT");
  await addCol("jobs", "stage_started_at", "BIGINT NOT NULL DEFAULT 0");
  // 真实 Token 结算：预留价在入队前写入；成功收尾时与最终价/Token 原子落库。
  await addCol("jobs", "credits_reserved", "BIGINT NOT NULL DEFAULT 0");
  await addCol("jobs", "credits_final", "BIGINT NOT NULL DEFAULT 0");
  await addCol("jobs", "tokens_in", "BIGINT NOT NULL DEFAULT 0");
  await addCol("jobs", "tokens_out", "BIGINT NOT NULL DEFAULT 0");
  // R1:feed 系统任务所属频道(用户任务 NULL)。补偿器/孤儿批按此索引列联查,
  // 替代 params LIKE 子串匹配(语义脆 + O(jobs) 全扫描)。
  await addCol("jobs", "channel_id", "TEXT");
  await addCol("jobs", "idempotency_key", "TEXT");
  // 该列的索引必须在 addCol 之后建(不能放 schema.pg.sql):存量库先执行整文件 DDL
  // 时 jobs 表已存在、列还没补,索引先执行会炸 —— 全新库(e2e)测不出,只有存量库中招(实锤)。
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_jobs_channel ON jobs(channel_id) WHERE channel_id IS NOT NULL"
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_user_idempotency
       ON jobs(user_id,idempotency_key) WHERE user_id IS NOT NULL AND idempotency_key IS NOT NULL`
  );
  await addCol("feed_items", "retry_after", "BIGINT NOT NULL DEFAULT 0");
  // 滚动对话摘要:超出对话窗口(CHAT_HISTORY_WINDOW)的旧轮次压缩成背景摘要,
  // upto = 已折叠进摘要的消息数(messages 按 created_at ASC 的前缀长度)。
  await addCol("notebooks", "chat_summary", "TEXT");
  await addCol("notebooks", "chat_summary_upto", "BIGINT NOT NULL DEFAULT 0");
  await addCol("notebooks", "chat_epoch", "BIGINT NOT NULL DEFAULT 0");
  await addCol("notebooks", "overview_epoch", "BIGINT NOT NULL DEFAULT 0");
  await addCol("ai_calls", "tokens_in", "BIGINT NOT NULL DEFAULT 0");
  await addCol("ai_calls", "tokens_out", "BIGINT NOT NULL DEFAULT 0");
  await addCol("ai_calls", "cost_micros", "BIGINT NOT NULL DEFAULT 0");
  // 迁移窗口内给仍保留的 7 天 AI 明细补一次“按单请求”成本快照，避免上线首周报表归零。
  const uncosted = await pool.query<{
    id: number;
    model: string;
    tokens_in: number;
    tokens_out: number;
  }>(
    `SELECT id, model, tokens_in, tokens_out FROM ai_calls
       WHERE ok = 1 AND cost_micros = 0 AND (tokens_in > 0 OR tokens_out > 0)`
  );
  for (const call of uncosted.rows) {
    const micros = Math.max(
      0,
      Math.round(callCostCNY(call.model, Number(call.tokens_in), Number(call.tokens_out)) * 1_000_000)
    );
    await pool.query("UPDATE ai_calls SET cost_micros = $1 WHERE id = $2 AND cost_micros = 0", [
      micros,
      call.id,
    ]);
  }
  // 领域智库订阅(P0):编者按独立成列(防加源概览重写覆盖)+ 订阅注意力游标 + 免打扰。
  await addCol("notebooks", "editorial_note", "TEXT");
  await addCol("notebook_favorites", "last_seen_at", "BIGINT NOT NULL DEFAULT 0");
  await addCol("notebook_favorites", "muted", "BIGINT NOT NULL DEFAULT 0");

  // email/invite_code 存在时唯一(部分唯一索引,ALTER 无法内联加带谓词的 UNIQUE)。
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL"
  );
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code) WHERE invite_code IS NOT NULL"
  );

  // 编者按迁移三件套①:存量精选笔记本的编者按现存 notebooks.summary,一次性搬进
  // editorial_note(幂等:仅 editorial_note 尚空的行)。此后 summary 回归纯机器概览语义,
  // 加源的概览重写不再覆盖策展人手写编者按。读端走 COALESCE(editorial_note, summary) 过渡。
  await pool.query(
    "UPDATE notebooks SET editorial_note = summary WHERE featured = 1 AND editorial_note IS NULL AND summary IS NOT NULL"
  );

  // R1 诚实性②对存量用户兑现:老收藏行的 last_seen_at 仍是 DEFAULT 0 —— 频道一旦
  // 产出新内容,他们会看到「全部历史都未读」的爆炸徽章。回填为收藏时刻(幂等)。
  await pool.query(
    "UPDATE notebook_favorites SET last_seen_at = created_at WHERE last_seen_at = 0"
  );

  // 3.5) 独立系统管理员配置是可信部署输入：启动期就原子同步凭据版本/指纹，
  // 这样蓝绿发布无需等第一次成功登录才撤销旧会话。碰撞、降权或版本回滚只
  // 让管理入口 fail closed，不拖垮前台业务进程。
  if (isAdminPasswordLoginEnforced()) {
    const configuredAdmin = adminPasswordAccount();
    if (!configuredAdmin) {
      // 畸形开关/B64/过期配置必须让未出示的旧 Cookie 也失效；只在请求解析时
      // 单 token 删除会让它们在配置修回后复活。
      await pool.query("DELETE FROM admin_sessions");
      await pool.query(
        "DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM admin_password_principals)"
      );
      console.error("[bootstrap] 独立系统管理员配置无效或已过期，后台保持关闭");
    } else {
      try {
        await ensureAdminPasswordAccount(configuredAdmin);
      } catch (error) {
        console.error(
          "[bootstrap] 独立系统管理员同步失败，后台保持关闭:",
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  // 4) 启动恢复:回收「进程已死留下的孤儿 running 任务」。
  // ⚠️ 只有 worker 宿主进程(Next server,NEXT_RUNTIME 有值)才允许回收:任何旁路脚本
  // (评测/迁移/临时验证)import 本模块都会跑到这里,若无门禁,脚本进程按「空名册」
  // 把主进程正在跑的任务误判孤儿(压测实锤)。
  if (process.env.NEXT_RUNTIME) await reclaimStaleRunningJobs();
}

// running 任务超过此时长无心跳(updateJob 刷新 updated_at)即视为「孤儿」——其 worker
// 所在进程已死。活着的任务每 800ms 有心跳,正常永远不会 stale。
// ⚠️ 240s 而非 90s:dev 的按需编译/重负载会把事件环阻塞很久,心跳完全不 fire ——
// 压测实锤 90s 窗口误杀过心跳停摆但仍在跑的任务。回收是「进程真死」的兜底,宁慢勿
// 误杀;且回收现在优先重新排队而非判死,真孤儿只是晚几分钟重跑。
export const JOB_STALE_MS = 240_000;

/** 每单任务最多执行次数(首跑 + 自动重试)。孤儿回收/启动恢复/瞬态失败统一走重新排队,
 *  以 params.__attempts 计数;用尽才置 error + 退积分,防「毒任务」无限重试拖垮 worker。 */
export const JOB_MAX_ATTEMPTS = 3;

/** running → queued 的原子重排队(__attempts+1):仅当重试次数未用尽、且仍是 running
 *  (与取消/完成的条件更新互斥)。可选追加「无心跳(updated_at < cutoff)」条件。 */
async function requeueRunningJob(
  exec: (sql: string, params: unknown[]) => Promise<number>,
  id: string,
  cutoff?: number,
  expectedAttempt?: number
): Promise<boolean> {
  const cond: string[] = [];
  const args: unknown[] = [Date.now(), id];
  if (cutoff != null) {
    args.push(cutoff);
    cond.push(`updated_at < $${args.length}`);
  }
  if (expectedAttempt != null) {
    args.push(expectedAttempt);
    cond.push(`run_attempt = $${args.length}`);
  }
  const changed = await exec(
    `UPDATE jobs SET status = 'queued', progress = 0, error = NULL, updated_at = $1,
       finished_at = 0,
       stage = CASE WHEN kind='cad' THEN 'queued' ELSE NULL END,
       stage_started_at = CASE WHEN kind='cad' THEN $1::bigint ELSE 0::bigint END,
       params = (COALESCE(NULLIF(params, ''), '{}')::jsonb
                 || jsonb_build_object('__attempts', COALESCE((NULLIF(params, '')::jsonb->>'__attempts')::int, 0) + 1))::text
     WHERE id = $2 AND status = 'running'${cond.length ? ` AND ${cond.join(" AND ")}` : ""}
       AND COALESCE((NULLIF(params, '')::jsonb->>'__attempts')::int, 0) < ${JOB_MAX_ATTEMPTS - 1}`,
    args
  );
  return changed > 0;
}

async function reclaimStaleRunningJobs(throwOnError = false): Promise<number> {
  try {
    const cutoff = Date.now() - JOB_STALE_MS;
    // 先取受影响行(user_id/kind):置终态后条件不再命中,退分无从查起。
    // 用池直连:本函数在 initSchema 末尾被调用,那时 inited 尚未 resolve,走 ensureInited
    // 会自死锁(await 自己)。sweepStaleJobs 会先 ensureInited 再调本函数,故此处安全。
    const victims = await pall<{ id: string; user_id: string | null; kind: string; credits_reserved: number; params: string | null; run_attempt: number }>(
      "SELECT id, user_id, kind, credits_reserved, params, run_attempt FROM jobs WHERE status = 'running' AND updated_at < $1",
      [cutoff]
    );
    if (!victims.length) return 0;
    // 在跑名册(lib/jobs.ts runOne 维护于 process 对象 —— Turbopack dev 会给每个
    // server bundle 实例隔离 globalThis,process 是跨实例共享的进程单例):同进程
    // worker 正在跑的任务,无论 updated_at 多旧都绝不回收 —— 时间窗对「事件环被
    // 编译/长同步阻塞」不可靠。
    const inflight = (process as unknown as { __nbInflight?: Set<string> }).__nbInflight;
    let reclaimed = 0;
    for (const v of victims) {
      if (inflight?.has(v.id)) continue; // 本进程正在跑 → 活着,跳过
      // 优先重新排队(重试次数未用尽):把「进程死亡/心跳停摆」变成延迟成功而非直接失败。
      // 不退分 —— 任务还会跑,积分照常消费。
      if (await requeueRunningJob(prun, v.id, cutoff, Number(v.run_attempt))) {
        reclaimed += 1;
        console.warn(`[db] 孤儿任务已重新排队:${v.kind} ${v.id}`);
        continue;
      }
      // 次数用尽(或状态已变)→ 置错。逐条按 id 复核条件:期间恢复心跳/已完成的不动。
      const changed = await failJobAndQueueRefund(
        v.id,
        Number(v.run_attempt),
        "生成多次中断,已停止自动重试,请手动重新生成",
        cutoff
      );
      if (!changed) continue;
      reclaimed += 1;
    }
    await processCreditRefundOutbox().catch(() => {});
    return reclaimed;
  } catch (error) {
    if (throwOnError) throw error;
    return 0; // 恢复失败不阻断启动
  }
}

/** 瞬态失败(限流/网络/超时)的任务级自动重试:running → queued 并计数。
 *  返回 false = 次数用尽或状态已变(取消/完成),调用方走终判失败路径。 */
export async function requeueJobForRetry(id: string, expectedAttempt: number): Promise<boolean> {
  await ensureInited();
  return requeueRunningJob(run, id, undefined, expectedAttempt);
}

/** 周期性兜底回收孤儿任务(见 lib/jobs.ts 的定时器)。只回收长时间无心跳的 running。 */
export async function sweepStaleJobs(): Promise<number> {
  await ensureInited();
  // 周期 worker 与管理接口的调用方都有显式 catch；这里把查询失败交给调用方，
  // 避免后台把“恢复失败”伪报成“没有卡死任务”。启动初始化仍走默认吞错路径。
  return reclaimStaleRunningJobs(true);
}

function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

// ---- embedding (de)serialization(纯函数,不碰)----

export function encodeEmbedding(vec: number[]): Buffer {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeEmbedding(buf: Buffer): Float32Array {
  // pg 把 bytea 读回为 Node Buffer;确保按 4 字节对齐拷贝(Buffer 可能非 4 对齐的视图)。
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function uid(): string {
  return crypto.randomUUID();
}

// ---- notebooks ----

export async function createNotebook(userId: string, title: string, emoji: string): Promise<Notebook> {
  const nb: Notebook = {
    id: uid(),
    // L5:标题封顶 200 字符(与 source/note 标题一致),防几 MB 标题膨胀行。
    title: title.trim().slice(0, 200) || "Untitled notebook",
    emoji: emoji || "📓",
    created_at: Date.now(),
    user_id: userId,
  };
  await run(
    "INSERT INTO notebooks (id, title, emoji, created_at, user_id) VALUES ($1, $2, $3, $4, $5)",
    [nb.id, nb.title, nb.emoji, nb.created_at, nb.user_id]
  );
  return nb;
}

/** 套餐笔记本数量上限已达。路由捕获转 403。 */
export class NotebookLimitError extends Error {
  constructor(public limit: number) {
    super("notebook limit reached");
    this.name = "NotebookLimitError";
  }
}

/** 事务内锁住用户行后再计数校验上限,消除「先查后建」的并发绕过(check-then-act)。
 *  maxNotebooks<0 表示不限量。同一用户的并发创建/复制都在该 FOR UPDATE 上串行,
 *  后到者读到已更新的计数,超限即抛 NotebookLimitError。 */
async function assertNotebookSlot(
  client: PoolClient,
  userId: string,
  maxNotebooks: number
): Promise<void> {
  if (maxNotebooks < 0) return; // 无限档,免锁免查
  await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [userId]);
  const n = Number(
    (await client.query("SELECT COUNT(*) AS c FROM notebooks WHERE user_id = $1", [userId])).rows[0].c
  );
  if (n >= maxNotebooks) throw new NotebookLimitError(maxNotebooks);
}

/** 受套餐上限约束地创建笔记本(原子):锁用户行→计数→未超才插入。超限抛 NotebookLimitError。 */
export async function createNotebookWithLimit(
  userId: string,
  title: string,
  emoji: string,
  maxNotebooks: number
): Promise<Notebook> {
  const nb: Notebook = {
    id: uid(),
    title: title.trim().slice(0, 200) || "Untitled notebook",
    emoji: emoji || "📓",
    created_at: Date.now(),
    user_id: userId,
  };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertNotebookSlot(client, userId, maxNotebooks);
    await client.query(
      "INSERT INTO notebooks (id, title, emoji, created_at, user_id) VALUES ($1, $2, $3, $4, $5)",
      [nb.id, nb.title, nb.emoji, nb.created_at, nb.user_id]
    );
    await client.query("COMMIT");
    return nb;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

type NotebookRow = Omit<Notebook, "suggested_questions" | "public" | "featured" | "pinned"> & {
  suggested_questions: string | null;
  public?: number;
  featured?: number;
  pinned?: number;
};

function rowToNotebook(r: NotebookRow): Notebook {
  return {
    ...r,
    suggested_questions: safeJsonArray(r.suggested_questions),
    public: !!r.public,
    featured: !!r.featured,
    pinned: !!r.pinned,
  };
}

/** 置顶笔记本(每用户至多一个):置顶时先取消同一所有者的其它置顶。 */
export async function setNotebookPinned(id: string, pinned: boolean): Promise<void> {
  const nb = await get<{ user_id: string | null }>(
    "SELECT user_id FROM notebooks WHERE id = $1",
    [id]
  );
  if (!nb) return;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (pinned) {
      if (nb.user_id)
        await client.query("UPDATE notebooks SET pinned = 0 WHERE user_id = $1", [nb.user_id]);
      await client.query("UPDATE notebooks SET pinned = 1 WHERE id = $1", [id]);
    } else {
      await client.query("UPDATE notebooks SET pinned = 0 WHERE id = $1", [id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Curated featured notebooks (公开 + featured), visible to everyone — no owner filter. */
export async function listFeaturedNotebooks(): Promise<Notebook[]> {
  const rows = await all<NotebookRow>(
    `SELECT n.*, (SELECT COUNT(*) FROM sources s WHERE s.notebook_id = n.id AND (s.origin IS NULL OR s.origin NOT LIKE 'note:%')) AS source_count
       FROM notebooks n
       WHERE n.featured = 1 AND n.public = 1
       ORDER BY n.featured_order ASC, n.created_at ASC`
  );
  return rows.map(rowToNotebook);
}

// ---------------------------------------------------------------------------
// 收藏(user-scoped 收藏夹):用户收藏精选笔记本。「精选笔记本」tab 展示 = 我收藏的。
// ---------------------------------------------------------------------------

/** 收藏/订阅一本笔记本(幂等)。last_seen_at 初始化 = 订阅时刻:订阅之前的历史不算未读
 *  (诚实性规则②,防首订就显示「+46 新」)。重复订阅不重置游标(DO NOTHING);退订再订=新行 = now。 */
export async function addFavorite(userId: string, notebookId: string, ts: number): Promise<void> {
  await run(
    `INSERT INTO notebook_favorites (user_id, notebook_id, created_at, last_seen_at) VALUES ($1, $2, $3, $3)
       ON CONFLICT (user_id, notebook_id) DO NOTHING`,
    [userId, notebookId, ts]
  );
}

/** 取消收藏(幂等)。 */
export async function removeFavorite(userId: string, notebookId: string): Promise<void> {
  await run("DELETE FROM notebook_favorites WHERE user_id = $1 AND notebook_id = $2", [
    userId,
    notebookId,
  ]);
}

/** 某用户收藏过的全部 notebook id 集合(用于给列表打 favorited 标)。 */
export async function listFavoriteIds(userId: string): Promise<Set<string>> {
  const rows = await all<{ notebook_id: string }>(
    "SELECT notebook_id FROM notebook_favorites WHERE user_id = $1",
    [userId]
  );
  return new Set(rows.map((r) => r.notebook_id));
}

/** 是否已收藏某本。 */
export async function isFavorited(userId: string, notebookId: string): Promise<boolean> {
  const r = await get<{ one: number }>(
    "SELECT 1 AS one FROM notebook_favorites WHERE user_id = $1 AND notebook_id = $2",
    [userId, notebookId]
  );
  return !!r;
}

/** 订阅注意力游标推进:前台可见时【显式】调用(绝非 GET 副作用,防后台标签自动 refetch 误标已读)。
 *  只前进不后退(last_seen_at < ts 才更新),多标签/多设备并发安全。 */
export async function setFavoriteSeen(userId: string, notebookId: string, ts: number): Promise<void> {
  await run(
    "UPDATE notebook_favorites SET last_seen_at = $3 WHERE user_id = $1 AND notebook_id = $2 AND last_seen_at < $3",
    [userId, notebookId, ts]
  );
}

/** 免打扰:保留未读徽章,不进站内铃铛。 */
export async function setFavoriteMuted(userId: string, notebookId: string, muted: boolean): Promise<void> {
  await run("UPDATE notebook_favorites SET muted = $3 WHERE user_id = $1 AND notebook_id = $2", [
    userId,
    notebookId,
    muted ? 1 : 0,
  ]);
}

/** 某用户在各订阅智库的未读数。诚实性规则③:只计【真正入库】(status='ingested')且 ingested_at
 *  晚于该用户游标的条目 —— 「+N」点进去看得到的正好是 N 篇。返回 Map<notebookId, unread>。 */
export async function unreadByNotebook(userId: string): Promise<Map<string, number>> {
  const rows = await all<{ notebook_id: string; cnt: number | string }>(
    `SELECT fc.notebook_id AS notebook_id, COUNT(*) AS cnt
       FROM feed_items fi
       JOIN feed_channels fc ON fc.id = fi.channel_id
       JOIN notebook_favorites nf ON nf.notebook_id = fc.notebook_id AND nf.user_id = $1
      WHERE fi.status = 'ingested' AND fi.backfill = 0 AND fi.ingested_at > nf.last_seen_at
      GROUP BY fc.notebook_id`,
    [userId]
  );
  return new Map(rows.map((r) => [r.notebook_id, Number(r.cnt)]));
}

/** 各智库「最近真的抓到新内容」时刻(= 其启用频道 last_content_at 的最大值)。
 *  给卡片「今日更新 / 上次更新」文案与未读徽章亮灭。返回 Map<notebookId, ms>。 */
export async function lastContentByNotebook(): Promise<Map<string, number>> {
  const rows = await all<{ notebook_id: string; lca: number | string }>(
    "SELECT notebook_id, MAX(last_content_at) AS lca FROM feed_channels WHERE enabled = 1 GROUP BY notebook_id"
  );
  return new Map(rows.map((r) => [r.notebook_id, Number(r.lca)]));
}

// ---------------------------------------------------------------------------
// 领域智库订阅源(feed_channels / feed_items)—— 基础访问层。
// 轮询抢占 / 批 batch_id 认领 / AIMD 写回等竞态核心在 P0-4(lib/jobs 与专用原子 SQL)。
// 设计见 docs/featured-subscription-design.md v2 + docs/thinktank-library-design.md。
// ---------------------------------------------------------------------------

export type FeedChannelKind = "rss" | "weblist" | "sitemap" | "manual";
export type FeedChannelStatus = "active" | "backfilling" | "broken";

export interface FeedChannel {
  id: string;
  notebook_id: string;
  kind: FeedChannelKind;
  url: string;
  config: string; // JSON: { ua?, tls_lax?, item_filter?, selector? }
  enabled: number;
  interval_minutes: number;
  next_poll_at: number;
  poll_token: string | null;
  last_polled_at: number;
  last_content_at: number;
  daily_ingested: number;
  daily_reset_at: number;
  fail_count: number;
  status: FeedChannelStatus;
  last_error: string | null;
  etag: string | null;
  last_modified: string | null;
  created_at: number;
  created_by: string | null;
}

export type FeedItemStatus = "pending" | "ingested" | "failed" | "skipped";

export interface FeedItem {
  id: string;
  channel_id: string;
  guid: string;
  url: string | null;
  title: string;
  batch_id: string | null;
  source_id: string | null;
  status: FeedItemStatus;
  error: string | null;
  published_at: number | null;
  ingested_at: number | null;
  /** R1:回填身份(1=历史回填,枚举时定格)。回填条目永不进简报/通知/未读徽章。 */
  backfill: number;
  /** 首败时间退避:此刻之前不可被认领(claimFeedBatch 过滤)。 */
  retry_after: number;
  created_at: number;
}

/** 建订阅源频道(一家智库一般一条)。返回频道 id。 */
export async function createFeedChannel(input: {
  notebookId: string;
  kind: FeedChannelKind;
  url?: string;
  config?: Record<string, unknown>;
  intervalMinutes?: number;
  createdBy?: string | null;
}): Promise<string> {
  const id = uid();
  // 新频道一律从 backfilling 起步:首批(历史存量)静默入库,不简报/不通知/不 bump ——
  // 诚实性规则①「回填不是更新」的机制保证(30 条历史的 RSS 否则会连发多期简报轰炸订阅者)。
  await run(
    `INSERT INTO feed_channels (id, notebook_id, kind, url, config, interval_minutes, next_poll_at, status, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'backfilling', $7, $8)`,
    [
      id,
      input.notebookId,
      input.kind,
      input.url ?? "",
      JSON.stringify(input.config ?? {}),
      input.intervalMinutes ?? 360,
      Date.now(),
      input.createdBy ?? null,
    ]
  );
  return id;
}

export async function getFeedChannel(id: string): Promise<FeedChannel | undefined> {
  return get<FeedChannel>("SELECT * FROM feed_channels WHERE id = $1", [id]);
}

/** 某笔记本(智库)的全部订阅源。 */
export async function listFeedChannels(notebookId: string): Promise<FeedChannel[]> {
  return all<FeedChannel>(
    "SELECT * FROM feed_channels WHERE notebook_id = $1 ORDER BY created_at ASC",
    [notebookId]
  );
}

/** 后台全量订阅源(策展台监控用),附所属笔记本标题;broken 置顶。 */
export async function listAllFeedChannels(): Promise<(FeedChannel & { title: string })[]> {
  return all<FeedChannel & { title: string }>(
    `SELECT fc.*, n.title AS title FROM feed_channels fc
       JOIN notebooks n ON n.id = fc.notebook_id
      ORDER BY (fc.status = 'broken') DESC, fc.last_polled_at DESC`
  );
}

/** 更新订阅源可后台改字段(合并语义,只覆盖传入项)。改 enabled/interval 会把
 *  next_poll_at 归零立即重扫。resetPollState=true(feed_set 换 URL / broken 恢复)
 *  会清 etag/last_modified/fail_count/poll_token(审查修复:换源不该带旧条件头
 *  且不能被在途轮询补偿逻辑记假失败)。 */
export async function updateFeedChannel(
  id: string,
  patch: {
    url?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
    intervalMinutes?: number;
    status?: FeedChannelStatus;
    resetPollState?: boolean;
  }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.url !== undefined) { sets.push(`url = $${i++}`); vals.push(patch.url); }
  if (patch.config !== undefined) { sets.push(`config = $${i++}`); vals.push(JSON.stringify(patch.config)); }
  if (patch.enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(patch.enabled ? 1 : 0); }
  if (patch.intervalMinutes !== undefined) {
    // 审查修复:interval 服务端钳到 [15,1440] —— 0/负值会让租约 LEAST(0,10min)=0,
    // 每拍被补偿计假失败,5 拍即熔断。
    sets.push(`interval_minutes = $${i++}`);
    vals.push(Math.min(1440, Math.max(FEED_INTERVAL_MIN, Math.round(patch.intervalMinutes) || 360)));
  }
  if (patch.status !== undefined) { sets.push(`status = $${i++}`); vals.push(patch.status); }
  if (patch.resetPollState) {
    // 换源/修复场景:清条件请求缓存与失败计数(旧 URL 的 etag 发给新 URL 是陈旧条件头),
    // 并清 poll_token —— 管理端写入不该被在途轮询的补偿逻辑记假失败(审查修复)。
    sets.push(`etag = NULL`, `last_modified = NULL`, `fail_count = 0`, `last_error = NULL`, `poll_token = NULL`);
  }
  if (patch.enabled === true || patch.intervalMinutes !== undefined || patch.resetPollState) {
    sets.push(`next_poll_at = 0`, `poll_token = NULL`);
  }
  if (!sets.length) return;
  vals.push(id);
  await run(`UPDATE feed_channels SET ${sets.join(", ")} WHERE id = $${i}`, vals);
}

/**
 * 撤精选/转私有时原子停掉该本全部订阅频道与尚在队列中的 feed 系统任务。
 *
 * 这是用户管理与精选管理共用的唯一停订阅入口。清 poll_token 可让已经开始的 enum
 * 旧跑在 CAS 写回时失权；运行中的 ingest 任务也会因 job 终态栅栏停止后续收尾。
 */
export async function retireFeaturedNotebook(
  notebookId: string,
  opts: { makePrivate?: boolean } = {}
): Promise<{ channels: number; jobs: number } | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const notebook = await client.query(
      `UPDATE notebooks
          SET featured=0,
              public=CASE WHEN $2=1 THEN 0 ELSE public END
        WHERE id=$1
      RETURNING id`,
      [notebookId, opts.makePrivate ? 1 : 0]
    );
    if (notebook.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    const channels = await client.query<{ id: string }>(
      `UPDATE feed_channels
          SET enabled=0, poll_token=NULL
        WHERE notebook_id=$1 AND enabled<>0
      RETURNING id`,
      [notebookId]
    );
    const jobs = await client.query(
      `UPDATE jobs
          SET status='canceled', error='订阅源已由管理员停用', updated_at=$2
        WHERE notebook_id=$1
          AND kind IN ('feed_enum','feed_ingest')
          AND status IN ('queued','running')`,
      [notebookId, Date.now()]
    );
    await client.query("COMMIT");
    return {
      channels: Number(channels.rowCount ?? 0),
      jobs: Number(jobs.rowCount ?? 0),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteFeedChannel(id: string): Promise<void> {
  await run("DELETE FROM feed_channels WHERE id = $1", [id]);
}

/** 已见判重:某频道内是否已见过该 guid。 */
export async function findFeedItem(channelId: string, guid: string): Promise<FeedItem | undefined> {
  return get<FeedItem>("SELECT * FROM feed_items WHERE channel_id = $1 AND guid = $2", [channelId, guid]);
}

/** 记录一个新发现的条目(pending)。UNIQUE(channel,guid) 去重,已见则忽略;返回是否真的新插入。 */
export async function recordFeedItem(input: {
  channelId: string;
  guid: string;
  url?: string | null;
  title?: string;
  publishedAt?: number | null;
  /** R1:回填身份在条目粒度定格(枚举时按频道当时状态打标)—— 此后无论频道状态
   *  怎么变、批怎么死怎么复活,「这是历史回填」的事实不丢(诚实性①③的机制根)。 */
  backfill?: boolean;
}): Promise<boolean> {
  const n = await run(
    `INSERT INTO feed_items (id, channel_id, guid, url, title, published_at, backfill, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (channel_id, guid) DO NOTHING`,
    [uid(), input.channelId, input.guid, input.url ?? null, input.title ?? "", input.publishedAt ?? null, input.backfill ? 1 : 0, Date.now()]
  );
  return n > 0;
}

/** 标记条目入库结果。ingested 时落 ingested_at + source_id;ingestedAt 可显式覆写
 *  (回填批写发布时间,使历史条目天然早于订阅游标 → 不进未读徽章)。 */
export async function setFeedItemStatus(
  id: string,
  status: FeedItemStatus,
  opts?: { sourceId?: string | null; error?: string | null; ingestedAt?: number | null }
): Promise<void> {
  await run(
    `UPDATE feed_items SET status = $2, source_id = $3, error = $4,
       ingested_at = CASE WHEN $2 = 'ingested' THEN $5::bigint ELSE ingested_at END
      WHERE id = $1`,
    [id, status, opts?.sourceId ?? null, opts?.error ?? null, opts?.ingestedAt ?? Date.now()]
  );
}

/** 抓取瞬态失败的一次重试机会:放回待认领池(pending + 清 batch),记下错误 ——
 *  下一轮批会再试;若 error 已非空(第二次失败)调用方应改标 failed 终态。 */
export async function releaseFeedItemForRetry(id: string, error: string): Promise<void> {
  // retry_after:重试语义是「过一会儿再试一次」不是「立刻再试」—— 批尾接力按发布时间
  // 升序认领,刚 release 的回填条目往往是池里最老的,没有退避会被同一批尾秒级重认领,
  // 二败即永久 failed(瞬态故障 10 分钟 = 全池判死)。
  await run(
    "UPDATE feed_items SET status = 'pending', batch_id = NULL, error = $2, retry_after = $3 WHERE id = $1",
    [id, error.slice(0, 300), Date.now() + FEED_RETRY_BACKOFF_MS]
  );
}

/** 某频道的条目时间线(左栏资料流 / 频道页),按发布时间新→旧。 */
export async function listFeedItems(channelId: string, limit = 100): Promise<FeedItem[]> {
  return all<FeedItem>(
    "SELECT * FROM feed_items WHERE channel_id = $1 ORDER BY COALESCE(published_at, created_at) DESC LIMIT $2",
    [channelId, limit]
  );
}

// ---------------------------------------------------------------------------
// feed 轮询竞态核心(P0-4)。全部裁决走 DB(条件 UPDATE + rowCount / SKIP LOCKED),
// 内存旗标在 Turbopack dev 多上下文不可靠(有案)。三条不可省(设计 v2):
//  ① 短租约抢占:next_poll_at 只推 min(interval,10min),真值由 job 尾 CAS 写回 ——
//     抢占后进程死,损失上限 10 分钟而非一整个 interval。
//  ② batch_id 批幂等:withJobTimeout 不杀底层,超时重试=新旧双跑并发;批认领 +
//     简报确定性 id 是防重复入库/双份简报的唯一屏障。
//  ③ 失败写回不依赖 job 自身:租约过期仍带 poll_token = 上一跑没有正常收尾(超时/
//     崩溃/attempts 耗尽),扫描器补偿计一次失败 —— 否则 fail_count 恒 0,熔断
//     对最需要熔断的故障永不触发。
// ---------------------------------------------------------------------------

export const FEED_LEASE_MS = 10 * 60_000; // 抢占短租约
export const FEED_DAILY_LIMIT = 30; // 每频道每日【抓取尝试】配额(计失败/薄源,防接力+AIMD 放大;对抗审查 F2)
export const FEED_BATCH_SIZE = 5; // 每轮每频道最多入库篇数
export const FEED_RETRY_BACKOFF_MS = 30 * 60_000; // 首败条目时间退避:接力是秒级的,没有它「两击重试」变瞬态故障秒杀(对抗审查 F1)
export const FEED_INTERVAL_MIN = 15; // AIMD 下限(分钟)
export const FEED_INTERVAL_MAX = 1440; // AIMD 上限(24h)
export const FEED_FAIL_BROKEN = 5; // 连续失败 N 次即熔断报警(不等自然到 8)
export const FEED_BACKOFF_CAP_MS = 7 * 24 * 3600_000; // 退避总量钳制(≤7 天)

/** 扫描器①:原子抢占到期频道(每 tick 上限 limit 个)。写短租约 + poll_token,
 *  SKIP LOCKED 防多实例双抢。返回抢到的频道(含新 token)。 */
export async function claimDueFeedChannels(limit = 3): Promise<FeedChannel[]> {
  const now = Date.now();
  const { rows } = await query<FeedChannel>(
    `UPDATE feed_channels fc SET
        next_poll_at = $1 + LEAST(fc.interval_minutes * 60000, $2),
        poll_token = md5(random()::text || clock_timestamp()::text),
        last_polled_at = $1
      WHERE fc.id IN (
        SELECT id FROM feed_channels
         WHERE enabled = 1 AND kind <> 'manual' AND status <> 'broken' AND next_poll_at <= $1
         ORDER BY next_poll_at ASC LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING fc.*`,
    [now, FEED_LEASE_MS, limit]
  );
  return rows;
}

/** 扫描器②(失败补偿):租约已过期却仍带 poll_token = 上一跑没写回(超时/进程死/
 *  attempts 耗尽)。逐个记一次失败(指数退避 + 熔断),清 token。返回补偿的频道数。
 *  【审查修复 high】排除「对应 feed job 仍在排队/在跑」的频道:feed 任务是全队列最低
 *  优先级,单 worker 被一个 900s 音频任务顶住就超过 10min 租约 —— 排队不是死亡,
 *  误计会让健康频道 5 轮假失败后被熔断 broken(且全程静默)。params 存 JSON 文本,
 *  按 channelId 子串联查(uid 无歧义)。 */
export async function compensateStaleFeedClaims(): Promise<number> {
  const now = Date.now();
  // R1:联查走 jobs.channel_id 索引列(废 params LIKE 子串:语义脆 + O(jobs) 全扫)。
  // 同时带出 poll_token 作 CAS 凭据 —— SELECT 与 failure 写回之间若新一轮已抢占
  // (token 换新),按旧 token 条件更新命中 0 行,健康频道不被记假失败。
  const stale = await all<{ id: string; poll_token: string }>(
    `SELECT fc.id, fc.poll_token FROM feed_channels fc
      WHERE fc.poll_token IS NOT NULL AND fc.next_poll_at <= $1
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.channel_id = fc.id AND j.status IN ('queued','running'))`,
    [now]
  );
  let n = 0;
  for (const s of stale) {
    if (await feedPollFailure(s.id, "上一轮轮询未正常结束(超时或进程中断)", s.poll_token)) n++;
  }
  return n;
}

/** 排队续租(审查修复 high 的另一半):feed_enum 真正开跑时先把租约推到「现在+租期」,
 *  CAS by token —— 排队等待时间不再吃掉执行租期。rowCount=0 = token 已被换/清,弃权。 */
export async function renewFeedLease(channelId: string, token: string): Promise<boolean> {
  const n = await run(
    "UPDATE feed_channels SET next_poll_at = $2 WHERE id = $1 AND poll_token = $3",
    [channelId, Date.now() + FEED_LEASE_MS, token]
  );
  return n > 0;
}

/** 孤儿批回收(审查修复 high):批被认领(batch_id 非空)但其 feed_ingest job 已死
 *  (error/崩溃窗口/attempts 耗尽)→ 条目永久搁浅,回填频道永不转 active。
 *  条件:仍是 pending/ingesting、认领超过 2 小时、且无对应活跃 job → 复位回可认领态。 */
export async function reclaimOrphanFeedBatches(): Promise<string[]> {
  const cutoff = Date.now() - 2 * 3600_000;
  // R1:联查改走 jobs.channel_id 索引列(经 feed_items.channel_id 关联),废 params LIKE。
  // 返回受影响频道(去重):复活的条目必须由调用方立刻接力,否则又停滞到下一次轮询
  // (broken 频道则永久搁浅 —— 对抗审查 F3)。
  const { rows } = await query<{ channel_id: string }>(
    `UPDATE feed_items fi SET batch_id = NULL, status = 'pending'
      WHERE fi.batch_id IS NOT NULL AND fi.status IN ('pending','ingesting') AND fi.created_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.channel_id = fi.channel_id AND j.kind = 'feed_ingest' AND j.status IN ('queued','running'))
      RETURNING fi.channel_id`,
    [cutoff]
  );
  return [...new Set(rows.map((r) => r.channel_id))];
}

/** R1:feed 数据保留 —— 已消化条目(ingested/skipped/failed)与 feed 类通知各保留 90 天。
 *  pending/ingesting 不清(是断点)。设计 §4 写了、上轮代码没做的「表增长闸」。 */
export async function cleanupFeedRetention(): Promise<{ items: number; notifs: number }> {
  const cutoff = Date.now() - 90 * 24 * 3600_000;
  const items = await run(
    "DELETE FROM feed_items WHERE status IN ('ingested','skipped','failed') AND created_at < $1",
    [cutoff]
  );
  const notifs = await run("DELETE FROM notifications WHERE type = 'feed' AND created_at < $1", [cutoff]);
  return { items, notifs };
}

/** 条目粒度原子占位(审查修复 high):withJobTimeout 不杀底层,同一批的超时重试跑与
 *  僵尸旧跑会并发处理同一条目 —— 批认领只挡跨批,同批必须逐条 CAS。rowCount=1 才归我。 */
export async function claimFeedItemForIngest(id: string): Promise<boolean> {
  const n = await run(
    "UPDATE feed_items SET status = 'ingesting' WHERE id = $1 AND status = 'pending'",
    [id]
  );
  return n > 0;
}

/** 手动补录定向认领(审查修复):按【本次插入的条目 id】打批,不与轮询积压混池 ——
 *  否则按时间升序认领会拿走最老积压,运营贴的急件反而躺着。 */
export async function claimFeedItemsByIds(ids: string[], batchId: string): Promise<number> {
  if (!ids.length) return 0;
  return run(
    "UPDATE feed_items SET batch_id = $2 WHERE id = ANY($1) AND status = 'pending' AND batch_id IS NULL",
    [ids, batchId]
  );
}

/** job 尾成功写回(CAS:WHERE poll_token = 本跑抢到的 token)。AIMD:有新内容 ÷2 收紧、
 *  空转 ×1.5 放宽、304 不动;清 fail/token,更新 etag。rowCount=0 = 僵尸旧跑晚到/运营已手改,弃写。 */
export async function feedPollSuccess(
  channelId: string,
  token: string,
  outcome: { freshCount: number; notModified: boolean; etag?: string | null; lastModified?: string | null }
): Promise<boolean> {
  const ch = await getFeedChannel(channelId);
  if (!ch) return false;
  let interval = ch.interval_minutes;
  if (outcome.freshCount > 0) interval = Math.max(FEED_INTERVAL_MIN, Math.floor(interval / 2));
  else if (!outcome.notModified) interval = Math.min(FEED_INTERVAL_MAX, Math.round(interval * 1.5));
  const now = Date.now();
  const n = await run(
    `UPDATE feed_channels SET
        interval_minutes = $2, next_poll_at = $3, poll_token = NULL, fail_count = 0,
        last_error = NULL, etag = COALESCE($4, etag), last_modified = COALESCE($5, last_modified)
      WHERE id = $1 AND poll_token = $6`,
    [channelId, interval, now + interval * 60_000, outcome.etag ?? null, outcome.lastModified ?? null, token]
  );
  return n > 0;
}

/** 失败写回:fail_count+1、指数退避(钳 ≤7 天)、连败 ≥5 熔断 broken。
 *  不带 token 条件(补偿路径的租约已过期);WHERE poll_token IS NOT NULL 防同一轮重复计。 */
export async function feedPollFailure(channelId: string, error: string, expectedToken?: string): Promise<boolean> {
  const ch = await getFeedChannel(channelId);
  if (!ch) return false;
  const fails = ch.fail_count + 1;
  const backoff = Math.min(ch.interval_minutes * 60_000 * Math.pow(2, fails), FEED_BACKOFF_CAP_MS);
  // $2 同时参与赋值与比较,PG 参数类型推断会打架(42P08)—— 显式 ::bigint 收口。
  // R1:expectedToken CAS —— 补偿器 SELECT 与本写回之间若新一轮已抢占(token 换新),
  // 命中 0 行,健康的新抢占不被记假失败(与 §3.1 抢占凭据同一套仲裁纪律)。
  const n = await run(
    `UPDATE feed_channels SET
        fail_count = $2::bigint, next_poll_at = $3, poll_token = NULL,
        last_error = $4, status = CASE WHEN $2::bigint >= $5::bigint THEN 'broken' ELSE status END
      WHERE id = $1 AND poll_token IS NOT NULL AND ($6::text IS NULL OR poll_token = $6)`,
    [channelId, fails, Date.now() + backoff, error.slice(0, 500), FEED_FAIL_BROKEN, expectedToken ?? null]
  );
  return n > 0;
}

/** 每日配额窗口:返回本日还可入库的篇数(窗口过期先归零)。 */
export async function feedDailyRemaining(channelId: string): Promise<number> {
  const ch = await getFeedChannel(channelId);
  if (!ch) return 0;
  const dayStart = new Date().setHours(0, 0, 0, 0);
  if (ch.daily_reset_at < dayStart) {
    await run("UPDATE feed_channels SET daily_ingested = 0, daily_reset_at = $2 WHERE id = $1", [
      channelId,
      dayStart,
    ]);
    return FEED_DAILY_LIMIT;
  }
  return Math.max(0, FEED_DAILY_LIMIT - ch.daily_ingested);
}

export async function bumpFeedDailyIngested(channelId: string, n: number): Promise<void> {
  if (n <= 0) return;
  const dayStart = new Date().setHours(0, 0, 0, 0);
  // 窗口感知:窗口重置原来只写在读侧(feedDailyRemaining)—— 每天第一笔 bump 若先于
  // 任何读发生(新频道首批/接力批尾顺序是先 bump 后读),随后的读侧重置会把这笔
  // 消耗抹掉,每日第一批漏计。写侧同样处理窗口即根治。
  await run(
    `UPDATE feed_channels SET
       daily_ingested = CASE WHEN daily_reset_at < $3 THEN $2 ELSE daily_ingested + $2 END,
       daily_reset_at = GREATEST(daily_reset_at, $3)
     WHERE id = $1`,
    [channelId, n, dayStart]
  );
}

/** 批认领(幂等核心):把该频道最多 limit 条 pending 且未属于任何批的条目打上 batch_id。
 *  SKIP LOCKED + batch_id IS NULL 双闸:僵尸旧跑与新跑并发时,一条条目只会属于一个批。 */
export async function claimFeedBatch(channelId: string, batchId: string, limit: number): Promise<FeedItem[]> {
  const { rows } = await query<FeedItem>(
    `UPDATE feed_items SET batch_id = $2
      WHERE id IN (
        SELECT id FROM feed_items
         WHERE channel_id = $1 AND status = 'pending' AND batch_id IS NULL AND retry_after <= $4
         ORDER BY COALESCE(published_at, created_at) ASC LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [channelId, batchId, limit, Date.now()]
  );
  return rows;
}

/** 某批内仍待处理的条目(feed_ingest 重试跑续作断点:已 ingested/skipped 的不重做)。 */
export async function listBatchPendingItems(batchId: string): Promise<FeedItem[]> {
  return all<FeedItem>(
    "SELECT * FROM feed_items WHERE batch_id = $1 AND status = 'pending' ORDER BY COALESCE(published_at, created_at) ASC",
    [batchId]
  );
}

export async function listBatchItems(batchId: string): Promise<FeedItem[]> {
  return all<FeedItem>("SELECT * FROM feed_items WHERE batch_id = $1", [batchId]);
}

/** 「最近真的抓到新内容」:未读徽章与卡片文案的比较基准。只前进。 */
export async function markFeedContent(channelId: string, ts: number): Promise<void> {
  await run("UPDATE feed_channels SET last_content_at = GREATEST(last_content_at, $2) WHERE id = $1", [
    channelId,
    ts,
  ]);
}

/** 回填收尾:backfilling 且已无 pending → active(此后的新内容才开始发简报/通知)。 */
export async function finishBackfillIfDrained(channelId: string): Promise<void> {
  // R1 审查修复(high):判空必须含 ingesting —— 死批半途的条目停在 ingesting,
  // 只查 pending 会让邻批把频道过早转 active;2h 后孤儿回收把它们复位 pending,
  // 新批在 active 状态下把这些【历史旧文】当「新增」广播(诚实性①被击穿的实锤路径)。
  await run(
    `UPDATE feed_channels SET status = 'active'
      WHERE id = $1 AND status = 'backfilling'
        AND NOT EXISTS (SELECT 1 FROM feed_items WHERE channel_id = $1 AND status IN ('pending','ingesting'))`,
    [channelId]
  );
}

/** 每批一期更新简报(note)。确定性 id = feedbrief-<batchId>,ON CONFLICT DO NOTHING:
 *  超时重试跑再走到批尾也只会有一期(诚实性「每批恰一期」的机制保证,不是愿望)。
 *  返回是否真的新插入 —— 通知 fan-out 只挂在 true 上,防重发。 */
export async function upsertFeedBriefNote(
  notebookId: string,
  batchId: string,
  title: string,
  content: string
): Promise<boolean> {
  const n = await run(
    `INSERT INTO notes (id, notebook_id, title, content, kind, created_at)
       VALUES ($1, $2, $3, $4, 'report', $5)
       ON CONFLICT (id) DO NOTHING`,
    [`feedbrief-${batchId}`, notebookId, title.slice(0, 200), content, Date.now()]
  );
  return n > 0;
}

/** 订阅者列表(未免打扰的),通知 fan-out 用。 */
export async function listSubscriberIds(notebookId: string): Promise<string[]> {
  const rows = await all<{ user_id: string }>(
    "SELECT user_id FROM notebook_favorites WHERE notebook_id = $1 AND muted = 0",
    [notebookId]
  );
  return rows.map((r) => r.user_id);
}

/** 订阅者总数(含免打扰的)—— 公开页订阅动态条的真实数字。 */
export async function countSubscribers(notebookId: string): Promise<number> {
  const r = await get<{ c: string | number }>(
    "SELECT COUNT(*) c FROM notebook_favorites WHERE notebook_id = $1",
    [notebookId]
  );
  return Number(r?.c ?? 0);
}

/** 笔记本维度的在途制品任务数(排除 feed 调度任务):频道预生成的幂等闸 ——
 *  已排过一组就不再重复排,防批尾钩子每批都灌任务。 */
export async function countActiveArtifactJobs(notebookId: string): Promise<number> {
  const r = await get<{ c: string | number }>(
    `SELECT COUNT(*) c FROM jobs
      WHERE notebook_id = $1 AND status IN ('queued','running') AND kind NOT LIKE 'feed%'`,
    [notebookId]
  );
  return Number(r?.c ?? 0);
}

/** 近期真实更新篇数(非回填 · 已入库):公开页「更新频率」的数据源。
 *  只计 backfill=0 —— 回填的历史文章不冒充更新节奏(诚实性①)。 */
export async function countRecentFreshFeedItems(notebookId: string, sinceMs: number): Promise<number> {
  const r = await get<{ c: string | number }>(
    `SELECT COUNT(*) c FROM feed_items fi
       JOIN feed_channels fc ON fc.id = fi.channel_id
      WHERE fc.notebook_id = $1 AND fi.backfill = 0 AND fi.status = 'ingested' AND fi.ingested_at > $2`,
    [notebookId, sinceMs]
  );
  return Number(r?.c ?? 0);
}

/** 通知按「智库×订阅者×自然日」合并:当日已有该笔记本的 feed 通知则不再发(防高产源轰炸)。 */
export async function hasFeedNotifToday(userId: string, notebookId: string): Promise<boolean> {
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const r = await get<{ one: number }>(
    "SELECT 1 AS one FROM notifications WHERE user_id = $1 AND type = 'feed' AND link = $2 AND created_at >= $3 LIMIT 1",
    [userId, notebookId, dayStart]
  );
  return !!r;
}

export async function setNotebookFeatured(
  id: string,
  opts: {
    featured?: boolean;
    order?: number;
    cover?: string | null;
    publisher?: string | null;
    publisherAvatar?: string | null;
    category?: string | null;
  }
): Promise<void> {
  // 合并语义:只覆盖显式传入的字段,其余保留现值(避免「设/撤精选」误清封面、出版方、分类)。
  const cur = await get<{
    featured: number;
    featured_order: number;
    cover: string | null;
    publisher: string | null;
    publisher_avatar: string | null;
    featured_category: string | null;
  }>(
    "SELECT featured, featured_order, cover, publisher, publisher_avatar, featured_category FROM notebooks WHERE id = $1",
    [id]
  );
  if (!cur) return;
  await run(
    `UPDATE notebooks
       SET featured = $1, featured_order = $2, cover = $3,
           publisher = $4, publisher_avatar = $5, featured_category = $6
       WHERE id = $7`,
    [
      (opts.featured ?? !!cur.featured) ? 1 : 0,
      opts.order ?? cur.featured_order ?? 0,
      opts.cover !== undefined ? opts.cover : cur.cover,
      opts.publisher !== undefined ? opts.publisher : cur.publisher,
      opts.publisherAvatar !== undefined ? opts.publisherAvatar : cur.publisher_avatar,
      opts.category !== undefined ? opts.category : cur.featured_category,
      id,
    ]
  );
}

/** Deep-copy a notebook (sources + chunks + studio outputs) into a user's own private notebook.
 *  maxNotebooks 传入时(≥0)在同一事务内先锁用户行+计数校验上限,超限抛 NotebookLimitError,
 *  消除「先 checkNotebookQuota 后 copy」的并发绕过;传 -1/省略则不限量。 */
export async function copyNotebook(
  srcId: string,
  userId: string,
  maxNotebooks = -1
): Promise<Notebook | null> {
  const src = await get<Record<string, unknown>>("SELECT * FROM notebooks WHERE id = $1", [srcId]);
  if (!src) return null;
  const newId = uid();
  const now = Date.now();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertNotebookSlot(client, userId, maxNotebooks); // 超限抛 NotebookLimitError,进 catch 回滚
    await client.query(
      `INSERT INTO notebooks
         (id, title, emoji, created_at, user_id, summary, suggested_questions,
          chat_style, chat_instructions, response_length, output_language, public, featured)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, 0)`,
      [
        newId,
        `${(src.title as string) ?? "笔记本"} (副本)`,
        (src.emoji as string) || "📓",
        now,
        userId,
        (src.summary as string | null) ?? null,
        (src.suggested_questions as string | null) ?? "[]",
        (src.chat_style as string | null) ?? "default",
        (src.chat_instructions as string | null) ?? null,
        (src.response_length as string | null) ?? "default",
        (src.output_language as string | null) ?? null,
      ]
    );

    // 跳过笔记影子来源(origin='note:<id>'):它们是原作者私有笔记的衍生,不能随
    // 公开/精选笔记本被复制进他人副本(否则原作者私有笔记会跨账号外泄、且成孤儿)。
    const srcRows = (
      await client.query(
        "SELECT * FROM sources WHERE notebook_id = $1 AND (origin IS NULL OR origin NOT LIKE 'note:%')",
        [srcId]
      )
    ).rows as Record<string, unknown>[];
    for (const s of srcRows) {
      const nsid = uid();
      await client.query(
        `INSERT INTO sources
           (id, notebook_id, title, type, status, error, char_count, chunk_count, content, created_at, selected, summary, key_topics, origin, content_hash, fetched_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          nsid,
          newId,
          s.title as string,
          s.type as string,
          s.status as string,
          (s.error as string | null) ?? null,
          (s.char_count as number) ?? 0,
          (s.chunk_count as number) ?? 0,
          (s.content as string) ?? "",
          now,
          (s.selected as number) ?? 1,
          (s.summary as string | null) ?? null,
          (s.key_topics as string | null) ?? "[]",
          (s.origin as string | null) ?? null,
          // 审查修复:副本保留 content_hash / fetched_at(判重键 + 过期提示的抓取时间)。
          (s.content_hash as string | null) ?? null,
          (s.fetched_at as number | null) ?? null,
        ]
      );
      const chunks = (
        await client.query("SELECT * FROM chunks WHERE source_id = $1", [s.id as string])
      ).rows as Record<string, unknown>[];
      for (const c of chunks) {
        await client.query(
          `INSERT INTO chunks (id, source_id, notebook_id, chunk_index, content, embedding, section)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            uid(),
            nsid,
            newId,
            c.chunk_index as number,
            c.content as string,
            c.embedding as Buffer,
            // 审查修复:副本保留 chunks.section(块头/词法信号),否则副本 BM25 词法召回失真。
            (c.section as string | null) ?? null,
          ]
        );
      }
    }

    const outs = (
      await client.query("SELECT * FROM studio_outputs WHERE notebook_id = $1", [srcId])
    ).rows as Record<string, unknown>[];
    for (const o of outs) {
      // CAD 是“数据库行 + .data/cad/<outputId>/ 文件包”的原子制品。复制整本目前
      // 只复制数据库，若照搬会生成永远 404 的坏副本；首版明确跳过。
      if (o.kind === "cad") continue;
      await client.query(
        `INSERT INTO studio_outputs (id, notebook_id, kind, title, content, data, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          uid(),
          newId,
          o.kind as string,
          o.title as string,
          (o.content as string) ?? "",
          (o.data as string | null) ?? null,
          (o.status as string) ?? "ready",
          now,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return (await getNotebook(newId)) ?? null;
}

export async function listNotebooks(userId: string): Promise<Notebook[]> {
  // SQLite 的多参 MAX(a,b,c) 是标量函数;PG 用 GREATEST(a,b,c)。
  const rows = await all<NotebookRow>(
    `SELECT n.*, (SELECT COUNT(*) FROM sources s WHERE s.notebook_id = n.id AND (s.origin IS NULL OR s.origin NOT LIKE 'note:%')) AS source_count,
        GREATEST(
          n.created_at,
          COALESCE((SELECT MAX(created_at) FROM sources WHERE notebook_id = n.id), 0),
          COALESCE((SELECT MAX(created_at) FROM studio_outputs WHERE notebook_id = n.id), 0),
          COALESCE((SELECT MAX(created_at) FROM notes WHERE notebook_id = n.id), 0)
        ) AS last_activity
     FROM notebooks n
     WHERE n.user_id = $1
        OR n.id IN (SELECT notebook_id FROM notebook_collaborators WHERE user_id = $1)
     ORDER BY n.created_at DESC`,
    [userId]
  );
  return rows.map(rowToNotebook);
}

export async function getNotebook(id: string): Promise<Notebook | undefined> {
  const row = await get<NotebookRow>(
    `SELECT n.*, (SELECT COUNT(*) FROM sources s WHERE s.notebook_id = n.id AND (s.origin IS NULL OR s.origin NOT LIKE 'note:%')) AS source_count
       FROM notebooks n WHERE n.id = $1`,
    [id]
  );
  return row ? rowToNotebook(row) : undefined;
}

export async function renameNotebook(id: string, title: string): Promise<void> {
  await run("UPDATE notebooks SET title = $1 WHERE id = $2", [title.trim().slice(0, 200), id]);
}

/** 自动命名(enrichAfterIngest 顺带产出):仅当标题仍是默认「未命名笔记本」时才改名。返回是否真的改了。 */
export async function autoRenameNotebook(id: string, title: string): Promise<boolean> {
  const t = title.trim().slice(0, 30);
  if (!t) return false;
  const changed = await run(
    "UPDATE notebooks SET title = $1 WHERE id = $2 AND title = '未命名笔记本'",
    [t, id]
  );
  return changed > 0;
}

/** Set (or clear, with null) a notebook's custom cover image (data URL). */
export async function setNotebookCoverImage(id: string, image: string | null): Promise<void> {
  await run("UPDATE notebooks SET cover_image = $1 WHERE id = $2", [image, id]);
}

/** Update a notebook's emoji icon. */
export async function setNotebookEmoji(id: string, emoji: string): Promise<void> {
  await run("UPDATE notebooks SET emoji = $1 WHERE id = $2", [emoji.slice(0, 8), id]);
}

export async function deleteNotebook(id: string): Promise<void> {
  // 先取出该笔记本所有制品 id,删行后(外键级联清 DB)best-effort 异步清理其落盘媒体。
  const outs = await all<{ id: string }>(
    "SELECT id FROM studio_outputs WHERE notebook_id = $1",
    [id]
  );
  await run("DELETE FROM notebooks WHERE id = $1", [id]);
  for (const o of outs) void deleteOutputMedia(o.id);
}

// ---- sources ----

export async function createSource(
  notebookId: string,
  title: string,
  type: SourceType
): Promise<Source> {
  const src = {
    id: uid(),
    notebook_id: notebookId,
    title,
    type,
    status: "processing" as const,
    error: null as string | null,
    char_count: 0,
    chunk_count: 0,
    created_at: Date.now(),
  };
  await run(
    `INSERT INTO sources (id, notebook_id, title, type, status, error, char_count, chunk_count, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', $9)`,
    [
      src.id,
      src.notebook_id,
      src.title,
      src.type,
      src.status,
      src.error,
      src.char_count,
      src.chunk_count,
      src.created_at,
    ]
  );
  // selected defaults to 1 in the DB; summary/key_topics filled in later.
  return { ...src, selected: true, summary: null, key_topics: [] };
}

export async function finalizeSource(
  id: string,
  fields: {
    status: SourceStatus;
    error?: string | null;
    char_count?: number;
    chunk_count?: number;
    content?: string;
    pages?: number;
    extraction?: ExtractionProvenance;
  }
): Promise<void> {
  await run(
    `UPDATE sources SET status = $1, error = $2, char_count = $3,
       chunk_count = $4, content = COALESCE($5, content),
       fetched_at = COALESCE($6, fetched_at),
       pages = COALESCE($7, pages),
       extraction_backend = COALESCE($8, extraction_backend),
       extraction_version = COALESCE($9, extraction_version),
       extraction_meta = COALESCE($10, extraction_meta),
       ingest_lease_until = 0, ingest_claim_token = '',
       summary = CASE WHEN $1 = 'ready' THEN NULL ELSE summary END,
       key_topics = CASE WHEN $1 = 'ready' THEN '[]' ELSE key_topics END,
       enriched_at = CASE WHEN $1 = 'ready' THEN 0 ELSE enriched_at END,
       enrich_lease_until = CASE WHEN $1 = 'ready' THEN 0 ELSE enrich_lease_until END,
       enrich_claim_token = CASE WHEN $1 = 'ready' THEN '' ELSE enrich_claim_token END,
       enrich_attempts = CASE WHEN $1 = 'ready' THEN 0 ELSE enrich_attempts END,
       enrich_retry_at = CASE WHEN $1 = 'ready' THEN 0 ELSE enrich_retry_at END
       WHERE id = $11 AND ingest_claim_token = ''`,
    [
      fields.status,
      fields.error ?? null,
      fields.char_count ?? 0,
      fields.chunk_count ?? 0,
      fields.content ?? null,
      // 入库成功即视为「本次抓取完成」:建源首抓与重新导入都走这里;失败保留旧值。
      fields.status === "ready" ? Date.now() : null,
      fields.pages == null ? null : Math.max(0, Math.floor(fields.pages) || 0),
      fields.extraction?.effectiveBackend ?? null,
      fields.extraction?.backendVersion ?? null,
      fields.extraction ? JSON.stringify(fields.extraction) : null,
      id,
    ]
  );
}

/**
 * 将已抽取原文先持久化到 processing 来源。嵌入子进程/容器若在此后中断，
 * 页面轮询可从这份原文继续，不需要再抓网页或重做 OCR/ASR。
 */
export async function stageSourceForIngest(
  id: string,
  content: string,
  authored: boolean,
  claimToken?: string,
  extraction?: { pages?: number; provenance?: ExtractionProvenance }
): Promise<boolean> {
  const changed = await run(
    `UPDATE sources
        SET content = $2, ingest_authored = $3, error = NULL,
            pages = COALESCE($6, pages),
            extraction_backend = COALESCE($7, extraction_backend),
            extraction_version = COALESCE($8, extraction_version),
            extraction_meta = COALESCE($9, extraction_meta)
      WHERE id = $1 AND status = 'processing'
        AND (ingest_claim_token = '' OR ingest_lease_until < $4 OR ingest_claim_token = $5)`,
    [
      id,
      content,
      authored ? 1 : 0,
      Date.now(),
      claimToken ?? "",
      extraction?.pages == null ? null : Math.max(0, Math.floor(extraction.pages) || 0),
      extraction?.provenance?.effectiveBackend ?? null,
      extraction?.provenance?.backendVersion ?? null,
      extraction?.provenance ? JSON.stringify(extraction.provenance) : null,
    ]
  );
  return changed > 0;
}

/** processing 摄取的 DB 租约。返回 token 才代表本进程获得执行权。 */
export async function claimSourceIngest(id: string, leaseMs = 120_000): Promise<string | null> {
  const now = Date.now();
  const token = uid();
  const claimed = await get<{ ingest_claim_token: string }>(
    `UPDATE sources
        SET ingest_claim_token = $2,
            ingest_lease_until = $3,
            ingest_attempts = ingest_attempts + 1
      WHERE id = $1 AND status = 'processing' AND ingest_lease_until < $4
      RETURNING ingest_claim_token`,
    [id, token, now + Math.max(30_000, leaseMs), now]
  );
  return claimed?.ingest_claim_token ?? null;
}

/** ready/error 来源重抓的租约：生成 embedding 期间保留旧 ready 块可读，成功后原子换版。 */
export async function claimSourceRefresh(id: string, leaseMs = 600_000): Promise<string | null> {
  const now = Date.now();
  const token = uid();
  const claimed = await get<{ ingest_claim_token: string }>(
    `UPDATE sources
        SET ingest_claim_token=$2,ingest_lease_until=$3,ingest_attempts=ingest_attempts+1
      WHERE id=$1 AND status IN ('ready','error') AND ingest_lease_until < $4
      RETURNING ingest_claim_token`,
    [id, token, now + Math.max(60_000, leaseMs), now]
  );
  return claimed?.ingest_claim_token ?? null;
}

export async function renewSourceIngestLease(
  id: string,
  token: string,
  leaseMs = 120_000
): Promise<boolean> {
  const changed = await run(
    `UPDATE sources SET ingest_lease_until = $3
      WHERE id = $1 AND status IN ('processing','ready','error') AND ingest_claim_token = $2`,
    [id, token, Date.now() + Math.max(30_000, leaseMs)]
  );
  return changed > 0;
}

export async function releaseSourceIngestLease(id: string, token: string): Promise<boolean> {
  const changed = await run(
    `UPDATE sources SET ingest_lease_until = 0, ingest_claim_token = ''
      WHERE id = $1 AND status IN ('processing','ready','error') AND ingest_claim_token = $2`,
    [id, token]
  );
  return changed > 0;
}

/** 仅当调用者仍持有租约时置失败，防止过期旧跑覆盖新一跑。 */
export async function failClaimedSourceIngest(
  id: string,
  token: string,
  error: string
): Promise<boolean> {
  const changed = await run(
    `UPDATE sources
        SET status = 'error', error = $3, char_count = 0, chunk_count = 0,
            ingest_lease_until = 0, ingest_claim_token = ''
      WHERE id = $1 AND status IN ('processing','error') AND ingest_claim_token = $2`,
    [id, token, error]
  );
  return changed > 0;
}

export type RecoverableSourceIngest = {
  id: string;
  notebook_id: string;
  title: string;
  type: SourceType;
  content: string;
  authored: boolean;
  pages: number;
  extraction?: ExtractionProvenance;
};

/** 只返回已持久化抽取文本且租约已失效的 processing 来源。 */
export async function listRecoverableSourceIngests(
  notebookId: string,
  limit = 8
): Promise<RecoverableSourceIngest[]> {
  const rows = await all<{
    id: string;
    notebook_id: string;
    title: string;
    type: SourceType;
    content: string;
    ingest_authored: number;
    pages: number;
    extraction_meta: string;
  }>(
    `SELECT id, notebook_id, title, type, content, ingest_authored,pages,extraction_meta
       FROM sources
      WHERE notebook_id = $1 AND status = 'processing' AND content <> ''
        AND ingest_lease_until < $2
        AND (origin IS NULL OR origin NOT LIKE 'note:%')
      ORDER BY created_at ASC
      LIMIT $3`,
    [notebookId, Date.now(), Math.max(1, Math.min(32, Math.floor(limit) || 8))]
  );
  return rows.map((row) => ({
    id: row.id,
    notebook_id: row.notebook_id,
    title: row.title,
    type: row.type,
    content: row.content,
    authored: !!row.ingest_authored,
    pages: Math.max(0, Number(row.pages) || 0),
    extraction: (() => {
      try {
        const value = JSON.parse(row.extraction_meta || "{}");
        return value?.schemaVersion === 1 ? value as ExtractionProvenance : undefined;
      } catch {
        return undefined;
      }
    })(),
  }));
}

/** 来源导读+全本概览的跨实例单飞租约。 */
const SOURCE_ENRICH_MAX_ATTEMPTS = 3;

export async function claimSourceEnrichment(id: string, leaseMs = 120_000): Promise<string | null> {
  const now = Date.now();
  const token = uid();
  const claimed = await get<{ enrich_claim_token: string }>(
    `UPDATE sources
        SET enrich_claim_token = $2,
            enrich_lease_until = $3,
            enrich_attempts = enrich_attempts + 1
      WHERE id = $1 AND status = 'ready' AND enriched_at = 0
        AND enrich_lease_until < $4 AND enrich_retry_at <= $4
        AND enrich_attempts < $5
      RETURNING enrich_claim_token`,
    [id, token, now + Math.max(30_000, leaseMs), now, SOURCE_ENRICH_MAX_ATTEMPTS]
  );
  return claimed?.enrich_claim_token ?? null;
}

export async function renewSourceEnrichmentLease(
  id: string,
  token: string,
  leaseMs = 120_000
): Promise<boolean> {
  const changed = await run(
    `UPDATE sources SET enrich_lease_until = $3
      WHERE id = $1 AND status = 'ready' AND enriched_at = 0 AND enrich_claim_token = $2`,
    [id, token, Date.now() + Math.max(30_000, leaseMs)]
  );
  return changed > 0;
}

/** success=false 只释放租约，下次 GET/重复添加会再试；成功才落 enriched_at。 */
export async function finishSourceEnrichment(
  id: string,
  token: string,
  success: boolean
): Promise<boolean> {
  const changed = await run(
    `UPDATE sources
        SET enriched_at = CASE WHEN $3 = 1 THEN $4 ELSE enriched_at END,
            enrich_lease_until = 0,
            enrich_claim_token = '',
            enrich_retry_at = CASE
              WHEN $3 = 1 THEN 0
              WHEN enrich_attempts <= 1 THEN $4 + 60000
              WHEN enrich_attempts = 2 THEN $4 + 900000
              ELSE $4 + 86400000
            END
      WHERE id = $1 AND status = 'ready' AND enrich_claim_token = $2`,
    [id, token, success ? 1 : 0, Date.now()]
  );
  return changed > 0;
}

/** 用户明确重新添加同一来源时，允许对已封顶的增补再试一轮。 */
export async function resetSourceEnrichmentRetry(id: string): Promise<boolean> {
  const changed = await run(
    `UPDATE sources SET enrich_attempts=0,enrich_retry_at=0
      WHERE id=$1 AND status='ready' AND enriched_at=0 AND enrich_lease_until < $2`,
    [id, Date.now()]
  );
  return changed === 1;
}

export async function listSourcesNeedingEnrichment(
  notebookId: string,
  limit = 8
): Promise<{ id: string; notebook_id: string }[]> {
  return all<{ id: string; notebook_id: string }>(
    `SELECT id, notebook_id FROM sources
      WHERE notebook_id = $1 AND status = 'ready' AND enriched_at = 0
        AND enrich_lease_until < $2 AND enrich_retry_at <= $2
        AND enrich_attempts < ${SOURCE_ENRICH_MAX_ATTEMPTS}
        AND (origin IS NULL OR origin NOT LIKE 'note:%')
      ORDER BY created_at ASC
      LIMIT $3`,
    [notebookId, Date.now(), Math.max(1, Math.min(32, Math.floor(limit) || 8))]
  );
}

type SourceRow = Omit<Source, "selected" | "key_topics"> & {
  selected: number;
  key_topics: string | null;
};

function rowToSource(r: SourceRow): Source {
  return { ...r, selected: !!r.selected, key_topics: safeJsonArray(r.key_topics) };
}

export async function listSources(notebookId: string): Promise<Source[]> {
  const rows = await all<SourceRow>(
    `SELECT id, notebook_id, title, type, status, error, char_count, pages, chunk_count,
              created_at, selected, summary, key_topics, origin, fetched_at,
              extraction_backend,extraction_version,extraction_meta
       FROM sources WHERE notebook_id = $1 AND (origin IS NULL OR origin NOT LIKE 'note:%')
       ORDER BY created_at ASC`,
    [notebookId]
  );
  return rows.map(rowToSource);
}

export async function getSource(id: string): Promise<(Source & { content: string }) | undefined> {
  const r = await get<SourceRow & { content: string }>(
    "SELECT * FROM sources WHERE id = $1",
    [id]
  );
  return r ? { ...rowToSource(r), content: r.content } : undefined;
}

export async function deleteSource(id: string): Promise<void> {
  await run("DELETE FROM sources WHERE id = $1", [id]);
}

export async function renameSource(id: string, title: string): Promise<void> {
  await run("UPDATE sources SET title = $1 WHERE id = $2", [title.trim(), id]);
}

export async function setSourceSelected(id: string, selected: boolean): Promise<void> {
  await run("UPDATE sources SET selected = $1 WHERE id = $2", [selected ? 1 : 0, id]);
}

export async function setSourceOrigin(id: string, origin: string): Promise<void> {
  await run("UPDATE sources SET origin = $1 WHERE id = $2", [origin, id]);
}

export async function setSourceContentHash(id: string, hash: string): Promise<void> {
  await run("UPDATE sources SET content_hash = $1 WHERE id = $2", [hash, id]);
}

/** 去重:同一笔记本里按 origin(规范化 URL)找一条非 error 的已存在来源。 */
export async function findSourceByOrigin(notebookId: string, origin: string): Promise<Source | null> {
  const row = await get<SourceRow>(
    `SELECT id, notebook_id, title, type, status, error, char_count,pages,chunk_count,
              created_at, selected, summary, key_topics, origin,fetched_at,
              extraction_backend,extraction_version,extraction_meta
       FROM sources WHERE notebook_id = $1 AND origin = $2 AND status <> 'error' LIMIT 1`,
    [notebookId, origin]
  );
  return row ? rowToSource(row) : null;
}

/** 去重:同一笔记本里按内容哈希(文件/文本)找一条非 error 的已存在来源。 */
export async function findSourceByContentHash(notebookId: string, hash: string): Promise<Source | null> {
  const row = await get<SourceRow>(
    `SELECT id, notebook_id, title, type, status, error, char_count,pages,chunk_count,
              created_at, selected, summary, key_topics, origin,fetched_at,
              extraction_backend,extraction_version,extraction_meta
       FROM sources WHERE notebook_id = $1 AND content_hash = $2 AND status <> 'error' LIMIT 1`,
    [notebookId, hash]
  );
  return row ? rowToSource(row) : null;
}

/** 幂等重导入:删掉某来源的旧 chunks,避免重试/重复摄入把 chunks 翻倍。 */
export async function deleteChunksForSource(sourceId: string): Promise<void> {
  await run("DELETE FROM chunks WHERE source_id = $1", [sourceId]);
}

/** PDF 页数(来源列表副标题「日期 · N 页」);非 PDF/未知为 0。 */
export async function setSourcePages(id: string, pages: number): Promise<void> {
  await run("UPDATE sources SET pages = $2 WHERE id = $1", [id, Math.max(0, Math.floor(pages) || 0)]);
}

/** 按章节区间回填 chunks.section(E 视图目录数据源;检索签名共用)。
 *  ranges 为「起始 chunk_index → 节标题」,区间右开到下一节起点。 */
export async function updateChunkSections(
  sourceId: string,
  ranges: { from: number; title: string }[]
): Promise<void> {
  for (let i = 0; i < ranges.length; i++) {
    const upper = i + 1 < ranges.length ? ranges[i + 1].from : Number.MAX_SAFE_INTEGER;
    await run(
      "UPDATE chunks SET section = $2 WHERE source_id = $1 AND chunk_index >= $3 AND chunk_index < $4",
      [sourceId, ranges[i].title, ranges[i].from, upper]
    );
  }
}

/** 某来源全部 chunk 的开头预览(章节打标的 LLM 输入)。 */
export async function listChunkHeads(sourceId: string): Promise<{ index: number; head: string }[]> {
  const rows = await all<{ chunk_index: number | string; content: string }>(
    "SELECT chunk_index, content FROM chunks WHERE source_id = $1 ORDER BY chunk_index ASC",
    [sourceId]
  );
  return rows.map((r) => ({ index: Number(r.chunk_index), head: r.content.slice(0, 100) }));
}

/** 某来源的章节目录:节标题 + 锚点(该节第一个 chunk 的开头文字,前端在全文里定位切割)。
 *  全部未打标 → [](前端退回整文渲染)。 */
export async function listSourceSections(
  sourceId: string
): Promise<{ title: string; anchor: string }[]> {
  const rows = await all<{ section: string | null; content: string }>(
    "SELECT section, content FROM chunks WHERE source_id = $1 ORDER BY chunk_index ASC",
    [sourceId]
  );
  const out: { title: string; anchor: string }[] = [];
  for (const r of rows) {
    const t = (r.section ?? "").trim();
    if (!t) continue;
    if (out.length === 0 || out[out.length - 1].title !== t) {
      // 锚点与展示 content 同款清洗(PDF 目录点线):两边文本不一致会让前端切割失配丢节。
      out.push({ title: t, anchor: r.content.slice(0, 240).replace(/\.{6,}\s*\d+/g, " ").trim().slice(0, 120) });
    }
  }
  return out;
}

export async function setSourceGuide(id: string, summary: string, keyTopics: string[]): Promise<void> {
  await run("UPDATE sources SET summary = $1, key_topics = $2 WHERE id = $3", [
    summary,
    JSON.stringify(keyTopics),
    id,
  ]);
}

/** 导读只有当前 enrichment lease 持有者能写。 */
export async function setSourceGuideForClaim(
  id: string,
  token: string,
  summary: string,
  keyTopics: string[]
): Promise<boolean> {
  const changed = await run(
    `UPDATE sources SET summary=$1,key_topics=$2
      WHERE id=$3 AND status='ready' AND enriched_at=0 AND enrich_claim_token=$4`,
    [summary, JSON.stringify(keyTopics), id, token]
  );
  return changed === 1;
}

export async function setNotebookOverview(
  id: string,
  summary: string,
  questions: string[]
): Promise<void> {
  await run("UPDATE notebooks SET summary=$1,suggested_questions=$2,overview_epoch=overview_epoch+1 WHERE id=$3", [
    summary,
    JSON.stringify(questions),
    id,
  ]);
}

export type SourceOverviewSnapshot = {
  id: string;
  title: string;
  fetchedAt: number;
  summary: string;
};

export async function getNotebookOverviewEpoch(id: string): Promise<number> {
  const row = await get<{ overview_epoch: number }>(
    "SELECT overview_epoch FROM notebooks WHERE id=$1",
    [id]
  );
  return Number(row?.overview_epoch ?? 0);
}

/** 概览写入与来源 enrichment claim 复核同一事务。 */
export async function setNotebookOverviewForSourceClaim(
  sourceId: string,
  token: string,
  notebookId: string,
  summary: string,
  questions: string[],
  sourceSnapshot: SourceOverviewSnapshot[],
  expectedOverviewEpoch: number
): Promise<boolean> {
  await ensureInited();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const currentSources = (await client.query<{
      id: string;
      title: string;
      fetched_at: number | null;
      summary: string | null;
      enrich_claim_token: string;
      enriched_at: number;
    }>(
      `SELECT id,title,fetched_at,summary,enrich_claim_token,enriched_at
         FROM sources WHERE notebook_id=$1 AND status='ready'
           AND (origin IS NULL OR origin NOT LIKE 'note:%')
         ORDER BY id ASC FOR UPDATE`,
      [notebookId]
    )).rows;
    const trigger = currentSources.find((source) => source.id === sourceId);
    const expectedSources = [...sourceSnapshot].sort((a, b) => a.id.localeCompare(b.id));
    const sameSnapshot = currentSources.length === expectedSources.length && currentSources.every((source, index) =>
      source.id === expectedSources[index]?.id &&
      source.title === expectedSources[index]?.title &&
      Number(source.fetched_at ?? 0) === Number(expectedSources[index]?.fetchedAt ?? 0) &&
      String(source.summary ?? "") === String(expectedSources[index]?.summary ?? "")
    );
    if (!trigger || trigger.enriched_at !== 0 || trigger.enrich_claim_token !== token || !sameSnapshot) {
      await client.query("ROLLBACK");
      return false;
    }
    const notebook = (await client.query<{ overview_epoch: number }>(
      "SELECT overview_epoch FROM notebooks WHERE id=$1 FOR UPDATE",
      [notebookId]
    )).rows[0];
    if (!notebook || Number(notebook.overview_epoch) !== expectedOverviewEpoch) {
      await client.query("ROLLBACK");
      return false;
    }
    const updated = await client.query(
      `UPDATE notebooks SET summary=$1,suggested_questions=$2,overview_epoch=overview_epoch+1
        WHERE id=$3 AND overview_epoch=$4`,
      [summary, JSON.stringify(questions), notebookId, expectedOverviewEpoch]
    );
    if (updated.rowCount !== 1) throw new Error("笔记本已不存在");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** 全量概览落库与“本次扣费已产生成果”同一事务。 */
export async function setNotebookOverviewAndSettleCharge(
  id: string,
  summary: string,
  questions: string[],
  ledgerId: number | undefined,
  sourceSnapshot: SourceOverviewSnapshot[],
  expectedOverviewEpoch: number
): Promise<void> {
  await ensureInited();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const currentSources = (await client.query<{ id: string; title: string; fetched_at: number | null; summary: string | null }>(
      `SELECT id,title,fetched_at,summary FROM sources
        WHERE notebook_id=$1 AND status='ready' AND (origin IS NULL OR origin NOT LIKE 'note:%')
        ORDER BY id ASC FOR UPDATE`,
      [id]
    )).rows;
    const expectedSources = [...sourceSnapshot].sort((a, b) => a.id.localeCompare(b.id));
    const sameSnapshot = currentSources.length === expectedSources.length && currentSources.every((source, index) =>
      source.id === expectedSources[index]?.id && source.title === expectedSources[index]?.title &&
      Number(source.fetched_at ?? 0) === Number(expectedSources[index]?.fetchedAt ?? 0) &&
      String(source.summary ?? "") === String(expectedSources[index]?.summary ?? "")
    );
    const notebook = (await client.query<{ overview_epoch: number }>(
      "SELECT overview_epoch FROM notebooks WHERE id=$1 FOR UPDATE",
      [id]
    )).rows[0];
    if (!sameSnapshot || !notebook || Number(notebook.overview_epoch) !== expectedOverviewEpoch) {
      throw new Error("概览生成期间来源已更新，请重试");
    }
    const updated = await client.query(
      `UPDATE notebooks SET summary=$1,suggested_questions=$2,overview_epoch=overview_epoch+1
        WHERE id=$3 AND overview_epoch=$4`,
      [summary, JSON.stringify(questions), id, expectedOverviewEpoch]
    );
    if (updated.rowCount !== 1) throw new Error("笔记本已不存在");
    await settleCreditRefundGuardInTx(client, ledgerId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function setNotebookPublic(id: string, isPublic: boolean): Promise<void> {
  await run("UPDATE notebooks SET public = $1 WHERE id = $2", [isPublic ? 1 : 0, id]);
}

export async function setNotebookSettings(
  id: string,
  s: {
    chat_style?: string;
    chat_instructions?: string | null;
    response_length?: string;
    output_language?: string | null;
  }
): Promise<void> {
  const cur = await getNotebook(id);
  if (!cur) return;
  await run(
    "UPDATE notebooks SET chat_style = $1, chat_instructions = $2, response_length = $3, output_language = $4 WHERE id = $5",
    [
      s.chat_style ?? cur.chat_style ?? "default",
      s.chat_instructions ?? cur.chat_instructions ?? null,
      s.response_length ?? cur.response_length ?? "default",
      s.output_language ?? cur.output_language ?? null,
      id,
    ]
  );
}

// ---- chunks ----

export type NewChunkRow = {
  source_id: string;
  notebook_id: string;
  chunk_index: number;
  content: string;
  embedding: number[];
  section?: string | null;
};

export async function insertChunks(
  rows: NewChunkRow[]
): Promise<void> {
  if (!rows.length) return;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(
        `INSERT INTO chunks (id, source_id, notebook_id, chunk_index, content, embedding, section)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          uid(),
          r.source_id,
          r.notebook_id,
          r.chunk_index,
          r.content,
          // pg 原生把 Buffer 作为 bytea 参数写入;读回也是 Buffer。
          encodeEmbedding(r.embedding),
          r.section ?? null,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 租约摄取的唯一成功提交口：核对 token、替换 chunks、写 ready/content
 * 与清租约同一事务。过期旧跑即使 embedding 后才醒来，也无权删新块
 * 或覆盖新正文。
 */
export async function commitClaimedSourceIngest(
  sourceId: string,
  notebookId: string,
  claimToken: string,
  rows: NewChunkRow[],
  fields: {
    charCount: number;
    content: string;
    pages?: number;
    extraction?: ExtractionProvenance;
  }
): Promise<boolean> {
  await ensureInited();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      `SELECT 1 FROM sources
        WHERE id=$1 AND notebook_id=$2 AND status IN ('processing','ready','error') AND ingest_claim_token=$3
        FOR UPDATE`,
      [sourceId, notebookId, claimToken]
    );
    if (owner.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("DELETE FROM chunks WHERE source_id=$1", [sourceId]);
    for (const row of rows) {
      await client.query(
        `INSERT INTO chunks (id,source_id,notebook_id,chunk_index,content,embedding,section)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          uid(), row.source_id, row.notebook_id, row.chunk_index, row.content,
          encodeEmbedding(row.embedding), row.section ?? null,
        ]
      );
    }
    const updated = await client.query(
      `UPDATE sources SET status='ready',error=NULL,char_count=$1,chunk_count=$2,content=$3,
          fetched_at=$4,ingest_lease_until=0,ingest_claim_token='',
          pages=COALESCE($8,pages),
          extraction_backend=COALESCE($9,extraction_backend),
          extraction_version=COALESCE($10,extraction_version),
          extraction_meta=COALESCE($11,extraction_meta),
          summary=NULL,key_topics='[]',enriched_at=0,enrich_lease_until=0,
          enrich_claim_token='',enrich_attempts=0,enrich_retry_at=0
        WHERE id=$5 AND notebook_id=$6 AND status IN ('processing','ready','error') AND ingest_claim_token=$7`,
      [
        fields.charCount,
        rows.length,
        fields.content,
        Date.now(),
        sourceId,
        notebookId,
        claimToken,
        fields.pages == null ? null : Math.max(0, Math.floor(fields.pages) || 0),
        fields.extraction?.effectiveBackend ?? null,
        fields.extraction?.backendVersion ?? null,
        fields.extraction ? JSON.stringify(fields.extraction) : null,
      ]
    );
    if (updated.rowCount !== 1) throw new Error("来源摄取租约在提交时失效");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface ChunkWithEmbedding extends Chunk {
  embedding: Float32Array;
  source_title: string;
}

type ChunkRow = Chunk & { embedding: Buffer; source_title: string };

function rowToChunk(r: ChunkRow): ChunkWithEmbedding {
  return {
    id: r.id,
    source_id: r.source_id,
    notebook_id: r.notebook_id,
    chunk_index: r.chunk_index,
    content: r.content,
    section: r.section ?? null,
    source_title: r.source_title,
    embedding: decodeEmbedding(r.embedding),
  };
}

const CHUNK_COLS = `c.id, c.source_id, c.notebook_id, c.chunk_index, c.content, c.section, c.embedding, s.title AS source_title`;

/**
 * Chunks eligible for retrieval. When `sourceIds` is given, restricts to those
 * sources; otherwise uses every source the user has left selected. Always
 * limited to sources that finished processing.
 */
export async function getNotebookChunks(
  notebookId: string,
  sourceIds?: string[],
  maxChunks?: number
): Promise<ChunkWithEmbedding[]> {
  const boundedLimit = Number.isInteger(maxChunks) && Number(maxChunks) > 0
    ? Math.min(Number(maxChunks), 10_000)
    : undefined;
  if (sourceIds) {
    if (sourceIds.length === 0) return [];
    if (boundedLimit) {
      const perSourceLimit = Math.max(1, Math.floor(boundedLimit / sourceIds.length));
      const rows = await all<ChunkRow>(
        `SELECT ${CHUNK_COLS}
           FROM unnest($2::text[]) WITH ORDINALITY requested(source_id, source_order)
           JOIN sources s ON s.id = requested.source_id AND s.status = 'ready'
           CROSS JOIN LATERAL (
             SELECT c0.* FROM chunks c0
              WHERE c0.notebook_id = $1 AND c0.source_id = requested.source_id
              ORDER BY c0.chunk_index ASC LIMIT $3
           ) c
          ORDER BY requested.source_order, c.chunk_index`,
        [notebookId, sourceIds, perSourceLimit]
      );
      return rows.map(rowToChunk);
    }
    // $1=notebookId,来源 id 从 $2 起递增。
    const ph = sourceIds.map((_, i) => `$${i + 2}`).join(",");
    const params: unknown[] = [notebookId, ...sourceIds];
    const limitSql = boundedLimit ? ` ORDER BY c.source_id, c.chunk_index LIMIT $${params.push(boundedLimit)}` : "";
    const rows = await all<ChunkRow>(
      `SELECT ${CHUNK_COLS} FROM chunks c JOIN sources s ON s.id = c.source_id
         WHERE c.notebook_id = $1 AND s.status = 'ready' AND c.source_id IN (${ph})${limitSql}`,
      params
    );
    return rows.map(rowToChunk);
  }
  // 默认「全部就绪来源」**排除**笔记影子来源(origin='note'):笔记是私有的,
  // 只有显式把其 id 传进 sourceIds 时才纳入检索。
  const params: unknown[] = [notebookId];
  const limitSql = boundedLimit ? ` ORDER BY c.source_id, c.chunk_index LIMIT $${params.push(boundedLimit)}` : "";
  const rows = await all<ChunkRow>(
    `SELECT ${CHUNK_COLS} FROM chunks c JOIN sources s ON s.id = c.source_id
       WHERE c.notebook_id = $1 AND s.status = 'ready' AND s.selected = 1
         AND (s.origin IS NULL OR s.origin NOT LIKE 'note:%')${limitSql}`,
    params
  );
  return rows.map(rowToChunk);
}

// ---- messages ----

export type ConversationTailExpectation = {
  userMessageId: string;
  assistantIds: string[];
};

export class ConversationTailConflictError extends Error {
  constructor() {
    super("对话已在其它页面更新，请刷新后重试");
    this.name = "ConversationTailConflictError";
  }
}

async function assertConversationTailInTx(
  client: PoolClient,
  notebookId: string,
  expected: ConversationTailExpectation
): Promise<string[]> {
  const rows = (
    await client.query<{ id: string; role: "user" | "assistant" }>(
      `SELECT id,role FROM messages
        WHERE notebook_id=$1
        ORDER BY created_at DESC,message_seq DESC`,
      [notebookId]
    )
  ).rows;
  const trailing: string[] = [];
  let lastUserId = "";
  for (const row of rows) {
    if (row.role === "assistant") trailing.push(row.id);
    else {
      lastUserId = row.id;
      break;
    }
  }
  const actual = [...trailing].sort();
  const wanted = [...new Set(expected.assistantIds)].sort();
  if (
    !expected.userMessageId || lastUserId !== expected.userMessageId ||
    actual.length !== wanted.length || actual.some((id, index) => id !== wanted[index])
  ) throw new ConversationTailConflictError();
  return trailing;
}

/**
 * 生成请求在扣分同一事务预置了“超时自动退分”。产物落库时必须
 * 锁住该 guard，确认它尚未被退分，再原子结算。这使容器在扣分后
 * SIGKILL/OOM 也不会造成永久误扣，也避免“已退分但结果稍后落库”。
 */
async function settleCreditRefundGuardInTx(
  client: PoolClient,
  ledgerId?: number
): Promise<void> {
  if (!ledgerId) return;
  const guard = (
    await client.query<{ state: string; refunded: number }>(
      `SELECT o.state,l.refunded
         FROM credit_refund_outbox o
         JOIN credit_ledger l ON l.id=o.ledger_id
        WHERE o.ledger_id=$1
        FOR UPDATE OF o,l`,
      [ledgerId]
    )
  ).rows[0];
  if (!guard) throw new Error("扣费补偿保护不存在");
  if (Number(guard.refunded) === 1) throw new Error("本次扣费已超时退回");
  if (guard.state !== "pending") throw new Error("本次扣费已进入退回或结算流程");
  await client.query(
    `UPDATE credit_refund_outbox
        SET state='done',done_at=$1,last_error=NULL
      WHERE ledger_id=$2`,
    [Date.now(), ledgerId]
  );
}

export async function addMessage(
  notebookId: string,
  role: "user" | "assistant",
  content: string,
  citations: Citation[] = [],
  skillId: string | null = null,
  preferredId?: string
): Promise<ChatMessage> {
  await ensureInited();
  const msg = {
    id: preferredId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(preferredId)
      ? preferredId
      : uid(),
    notebook_id: notebookId,
    role,
    content,
    citations: JSON.stringify(citations),
    created_at: Date.now(),
    skill_id: role === "user" && skillId ? skillId.slice(0, 64) : null,
  };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [notebookId]);
    await client.query(
      `INSERT INTO messages (id, notebook_id, role, content, citations, created_at, skill_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [msg.id, msg.notebook_id, msg.role, msg.content, msg.citations, msg.created_at, msg.skill_id]
    );
    await client.query("COMMIT");
    return { ...msg, citations };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** assistant 消息与扣费 guard 原子结算；user 消息仍用 addMessage。 */
export async function addAssistantMessageAndSettleCharge(
  notebookId: string,
  content: string,
  citations: Citation[] = [],
  ledgerId?: number,
  expectedTail?: ConversationTailExpectation
): Promise<ChatMessage> {
  await ensureInited();
  const client = await getPool().connect();
  const msg = {
    id: uid(),
    notebook_id: notebookId,
    role: "assistant" as const,
    content,
    citations: JSON.stringify(citations),
    created_at: Date.now(),
    skill_id: null,
  };
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [notebookId]);
    if (expectedTail) await assertConversationTailInTx(client, notebookId, expectedTail);
    await client.query(
      `INSERT INTO messages (id, notebook_id, role, content, citations, created_at, skill_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [msg.id, msg.notebook_id, msg.role, msg.content, msg.citations, msg.created_at, msg.skill_id]
    );
    await settleCreditRefundGuardInTx(client, ledgerId);
    await client.query("COMMIT");
    return { ...msg, citations };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 重生成成功后的原子替换：旧 assistant 只在新答案 INSERT 同一事务成功时删除。
 * notebook advisory lock 让同一本的并发重生成最终只保留一个尾部答案；失败回滚时
 * 原答案仍在，避免“模型失败但旧答案先被删”的不可恢复窗口。
 */
export async function replaceTrailingAssistant(
  notebookId: string,
  content: string,
  citations: Citation[] = [],
  ledgerId?: number,
  expectedTail?: ConversationTailExpectation
): Promise<ChatMessage> {
  await ensureInited();
  const client = await getPool().connect();
  const msg = {
    id: uid(),
    notebook_id: notebookId,
    role: "assistant" as const,
    content,
    citations: JSON.stringify(citations),
    created_at: Date.now(),
    skill_id: null,
  };
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [notebookId]);
    const trailingAssistantIds = expectedTail
      ? await assertConversationTailInTx(client, notebookId, expectedTail)
      : (await client.query<{ id: string; role: string }>(
          "SELECT id, role FROM messages WHERE notebook_id=$1 ORDER BY created_at DESC, message_seq DESC",
          [notebookId]
        )).rows.filter((row, index, rows) => row.role === "assistant" && rows.slice(0, index).every((prior) => prior.role === "assistant")).map((row) => row.id);
    if (trailingAssistantIds.length) {
      await client.query("DELETE FROM messages WHERE notebook_id=$1 AND id=ANY($2::text[])", [
        notebookId,
        trailingAssistantIds,
      ]);
    }
    await client.query(
      `INSERT INTO messages (id, notebook_id, role, content, citations, created_at, skill_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [msg.id, msg.notebook_id, msg.role, msg.content, msg.citations, msg.created_at, msg.skill_id]
    );
    await settleCreditRefundGuardInTx(client, ledgerId);
    await client.query("COMMIT");
    return { ...msg, citations };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listMessages(notebookId: string): Promise<ChatMessage[]> {
  const rows = await all<Omit<ChatMessage, "citations"> & { citations: string }>(
    "SELECT * FROM messages WHERE notebook_id = $1 ORDER BY created_at ASC, message_seq ASC",
    [notebookId]
  );
  return rows.map((r) => ({ ...r, citations: JSON.parse(r.citations) as Citation[] }));
}

export async function clearMessages(notebookId: string): Promise<void> {
  await ensureInited();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [notebookId]);
    await client.query("DELETE FROM messages WHERE notebook_id=$1", [notebookId]);
    // 对话清空 = 记忆清零:与消息删除同事务，不能与在途答案交错。
    await client.query(
      "UPDATE notebooks SET chat_summary=NULL,chat_summary_upto=0,chat_epoch=chat_epoch+1 WHERE id=$1",
      [notebookId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** 滚动对话摘要:读取(summary 可能为 null;upto=已折叠的消息前缀长度)。 */
export async function getChatSummary(
  notebookId: string
): Promise<{ summary: string | null; upto: number; epoch: number }> {
  const row = await get<{ chat_summary: string | null; chat_summary_upto: number; chat_epoch: number }>(
    "SELECT chat_summary, chat_summary_upto, chat_epoch FROM notebooks WHERE id = $1",
    [notebookId]
  );
  return {
    summary: row?.chat_summary ?? null,
    upto: Number(row?.chat_summary_upto ?? 0),
    epoch: Number(row?.chat_epoch ?? 0),
  };
}

/** 滚动对话摘要:写入(仅在折叠成功后调用,upto 单调递增防倒退)。 */
export async function setChatSummary(
  notebookId: string,
  summary: string,
  upto: number,
  expectedEpoch: number
): Promise<boolean> {
  const changed = await run(
    `UPDATE notebooks SET chat_summary=$1,chat_summary_upto=$2
      WHERE id=$3 AND chat_summary_upto <= $2 AND chat_epoch=$4`,
    [summary.slice(0, 2000), upto, notebookId, expectedEpoch]
  );
  return changed === 1;
}

/** Set 👍/👎 feedback on an assistant message (pass null to clear). */
export async function setMessageFeedback(id: string, feedback: "up" | "down" | null): Promise<void> {
  await run("UPDATE messages SET feedback = $1 WHERE id = $2", [feedback, id]);
}

export async function getMessageNotebookId(id: string): Promise<string | null> {
  const row = await get<{ notebook_id: string }>(
    "SELECT notebook_id FROM messages WHERE id = $1",
    [id]
  );
  return row?.notebook_id ?? null;
}

/**
 * Delete the trailing assistant message(s) of a conversation — used by
 * "regenerate" so a fresh answer replaces the previous one instead of being
 * appended (which would leave a stale answer + duplicate question in history).
 */
export async function deleteTrailingAssistant(notebookId: string): Promise<void> {
  await ensureInited();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [notebookId]);
    const rows = (await client.query<{ id: string; role: "user" | "assistant" }>(
      "SELECT id,role FROM messages WHERE notebook_id=$1 ORDER BY created_at DESC,message_seq DESC",
      [notebookId]
    )).rows;
    const ids: string[] = [];
    for (const row of rows) {
      if (row.role !== "assistant") break;
      ids.push(row.id);
    }
    if (ids.length) await client.query("DELETE FROM messages WHERE id=ANY($1::text[])", [ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---- notes ----

export async function createNote(
  notebookId: string,
  title: string,
  content: string,
  kind: NoteKind = "manual"
): Promise<Note> {
  const note: Note = {
    id: uid(),
    notebook_id: notebookId,
    title: title.trim() || "Untitled note",
    content,
    kind,
    created_at: Date.now(),
  };
  await run(
    `INSERT INTO notes (id, notebook_id, title, content, kind, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [note.id, note.notebook_id, note.title, note.content, note.kind, note.created_at]
  );
  return note;
}

export async function listNotes(notebookId: string): Promise<Note[]> {
  return all<Note>(
    "SELECT * FROM notes WHERE notebook_id = $1 ORDER BY created_at DESC",
    [notebookId]
  );
}

export async function getNote(id: string): Promise<Note | undefined> {
  return get<Note>("SELECT * FROM notes WHERE id = $1", [id]);
}

export async function updateNote(
  id: string,
  fields: { title?: string; content?: string }
): Promise<void> {
  const cur = await getNote(id);
  if (!cur) return;
  await run("UPDATE notes SET title = $1, content = $2 WHERE id = $3", [
    fields.title ?? cur.title,
    fields.content ?? cur.content,
    id,
  ]);
}

export async function markNoteConverted(id: string): Promise<void> {
  await run("UPDATE notes SET converted_to_source = 1 WHERE id = $1", [id]);
}

export async function deleteNote(id: string): Promise<void> {
  await run("DELETE FROM notes WHERE id = $1", [id]);
}

// ---- 笔记影子来源(让笔记内容也能被 RAG 检索;对用户隐藏,不进来源列表) ----

/** 关联(或清除)一条笔记对应的影子来源 id。 */
export async function setNoteShadowSource(noteId: string, sourceId: string | null): Promise<void> {
  await run("UPDATE notes SET shadow_source_id = $1 WHERE id = $2", [sourceId, noteId]);
}

/** 某笔记本下全部「就绪」的笔记影子来源 id —— 检索时并入范围,使笔记始终可被对话搜到。 */
export async function listNoteShadowSourceIds(notebookId: string): Promise<string[]> {
  const rows = await all<{ id: string }>(
    "SELECT id FROM sources WHERE notebook_id = $1 AND origin LIKE 'note:%' AND status = 'ready'",
    [notebookId]
  );
  return rows.map((r) => r.id);
}

/** 删除某笔记本下全部笔记影子来源(清空笔记 / 笔记合并为来源时调用)。 */
export async function removeAllNoteShadows(notebookId: string): Promise<void> {
  await run("DELETE FROM sources WHERE notebook_id = $1 AND origin LIKE 'note:%'", [notebookId]);
}

/** 按精确 origin 标签删源 —— 影子来源用 'note:<noteId>' 标记,据此幂等清掉某笔记的全部影子。 */
export async function deleteSourcesByOrigin(notebookId: string, origin: string): Promise<void> {
  await run("DELETE FROM sources WHERE notebook_id = $1 AND origin = $2", [notebookId, origin]);
}

export async function deleteAllNotes(notebookId: string): Promise<void> {
  await run("DELETE FROM notes WHERE notebook_id = $1", [notebookId]);
}

// ---- studio outputs ----

export async function createStudioOutput(
  notebookId: string,
  kind: StudioKind,
  title: string,
  content: string,
  data: string | null = null,
  status: SourceStatus = "ready"
): Promise<StudioOutput> {
  const out: StudioOutput = {
    id: uid(),
    notebook_id: notebookId,
    kind,
    title,
    content,
    data,
    status,
    created_at: Date.now(),
  };
  await run(
    `INSERT INTO studio_outputs (id, notebook_id, kind, title, content, data, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [out.id, out.notebook_id, out.kind, out.title, out.content, out.data, out.status, out.created_at]
  );
  return out;
}

/**
 * 任务产物的原子栅栏：校验当前 running 代次与 INSERT 在同一事务、同一行锁内。
 * undefined 表示旧跑已被取消/重排/新跑取代，调用方必须清理临时媒体并静默退出。
 */
export async function createStudioOutputForRun(
  jobId: string,
  expectedAttempt: number,
  notebookId: string,
  kind: StudioKind,
  title: string,
  content: string,
  data: string | null = null
): Promise<StudioOutput | undefined> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = (
      await client.query("SELECT status, run_attempt FROM jobs WHERE id = $1 FOR UPDATE", [jobId])
    ).rows[0] as { status: string; run_attempt: number } | undefined;
    if (
      !current ||
      current.status !== "running" ||
      Number(current.run_attempt) !== expectedAttempt
    ) {
      await client.query("ROLLBACK");
      return undefined;
    }
    const out: StudioOutput = {
      id: uid(),
      notebook_id: notebookId,
      kind,
      title,
      content,
      data,
      status: "processing",
      job_id: jobId,
      run_attempt: expectedAttempt,
      created_at: Date.now(),
    };
    await client.query(
      `INSERT INTO studio_outputs (id, notebook_id, kind, title, content, data, status, job_id, run_attempt, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [out.id, out.notebook_id, out.kind, out.title, out.content, out.data, out.status, jobId, expectedAttempt, out.created_at]
    );
    await client.query("COMMIT");
    return out;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listStudioOutputs(notebookId: string): Promise<StudioOutput[]> {
  return all<StudioOutput>(
    "SELECT * FROM studio_outputs WHERE notebook_id = $1 AND status = 'ready' ORDER BY created_at DESC",
    [notebookId]
  );
}

export async function listSupersededJobOutputs(
  jobId: string,
  currentAttempt: number
): Promise<StudioOutput[]> {
  return all<StudioOutput>(
    `SELECT * FROM studio_outputs
       WHERE job_id = $1 AND status = 'processing' AND COALESCE(run_attempt, 0) <> $2`,
    [jobId, currentAttempt]
  );
}

export async function listProcessingJobOutputs(jobId: string): Promise<StudioOutput[]> {
  return all<StudioOutput>(
    "SELECT * FROM studio_outputs WHERE job_id=$1 AND status='processing'",
    [jobId]
  );
}

export async function listTerminalProcessingOutputs(limit = 50): Promise<StudioOutput[]> {
  return all<StudioOutput>(
    `SELECT o.* FROM studio_outputs o JOIN jobs j ON j.id=o.job_id
       WHERE o.status='processing' AND j.status IN ('error','canceled','done')
       ORDER BY o.created_at ASC LIMIT $1`,
    [Math.max(1, Math.min(500, limit))]
  );
}

export async function getStudioOutput(id: string): Promise<StudioOutput | undefined> {
  return get<StudioOutput>("SELECT * FROM studio_outputs WHERE id = $1 AND status = 'ready'", [id]);
}

/** worker 内部读取 processing 产物；API 路由不得使用。 */
export async function getStudioOutputAny(id: string): Promise<StudioOutput | undefined> {
  return get<StudioOutput>("SELECT * FROM studio_outputs WHERE id = $1", [id]);
}

export async function markStudioOutputConverted(id: string): Promise<void> {
  await run("UPDATE studio_outputs SET converted_to_source = 1 WHERE id = $1", [id]);
}

export async function deleteStudioOutput(id: string): Promise<void> {
  await run("DELETE FROM studio_outputs WHERE id = $1", [id]);
}

/** Update an output's content (and optionally title) — used for editing mind maps. */
export async function updateStudioOutput(
  id: string,
  fields: { content?: string; title?: string; data?: string }
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof fields.content === "string") {
    sets.push(`content = $${vals.length + 1}`);
    vals.push(fields.content);
  }
  if (typeof fields.title === "string" && fields.title.trim()) {
    sets.push(`title = $${vals.length + 1}`);
    vals.push(fields.title.trim());
  }
  if (typeof fields.data === "string") {
    sets.push(`data = $${vals.length + 1}`);
    vals.push(fields.data);
  }
  if (!sets.length) return;
  vals.push(id);
  await run(`UPDATE studio_outputs SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
}

// ---- users & sessions ----

export async function getUserById(id: string): Promise<User | undefined> {
  return get<User>("SELECT * FROM users WHERE id = $1", [id]);
}

export async function getUserByPhone(phone: string): Promise<User | undefined> {
  return get<User>("SELECT * FROM users WHERE phone = $1", [phone]);
}

export async function getUserByWechat(openid: string): Promise<User | undefined> {
  return get<User>("SELECT * FROM users WHERE wechat_openid = $1", [openid]);
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  // SQLite 的 COLLATE NOCASE → PG 用 LOWER() 两侧规范化(PG 默认大小写敏感)。
  return get<User>("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email.trim()]);
}

/**
 * 幂等 provision 环境配置中的专用测试账号。
 *
 * - 首次只按随机固定 userId 建号，手机号/邮箱/微信均为空，普通登录链路无法接管；
 * - 已有普通账号碰撞时 fail closed，绝不把真实用户改造成测试号；
 * - 保留 disabled（停用是运维紧急撤销），但每次成功认证都清除任何误授管理员字段；
 * - 不发注册试用，不把密码、用户名或访问密钥写入数据库。
 */
export async function ensureExperienceAccount(
  account: Pick<ExperienceAccount, "userId" | "displayName" | "expiresAt">
): Promise<User> {
  const now = Date.now();
  const row = (
    await query<User>(
      `INSERT INTO users
         (id, name, phone, email, wechat_openid, avatar, created_at, last_seen,
          disabled, is_admin, admin_role, plan_tier, plan_expires_at,
          bonus_credits, trial_granted_at, trial_expires_at)
       VALUES ($1, $2, NULL, NULL, NULL, NULL, $3, $3,
               0, 0, NULL, 'test', $4, 0, 0, 0)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         plan_expires_at = EXCLUDED.plan_expires_at,
         is_admin = 0,
         admin_role = NULL
       WHERE users.plan_tier = 'test'
       RETURNING users.*`,
      [account.userId, account.displayName, now, account.expiresAt]
    )
  ).rows[0];
  if (!row) throw new Error("体验账号 userId 与普通用户冲突");
  return row;
}

/**
 * 幂等 provision 本机演示账号。该账号没有手机号、邮箱、微信或后台角色，
 * 只获得一份随本地管理员配置到期的普通应用权益。
 */
export async function ensureLocalPreviewAccount(
  account: Pick<LocalPreviewAccount, "userId" | "displayName" | "expiresAt">
): Promise<User> {
  const now = Date.now();
  const row = (
    await query<User>(
      `INSERT INTO users
         (id, name, phone, email, wechat_openid, avatar, created_at, last_seen,
          disabled, is_admin, admin_role, plan_tier, plan_expires_at,
          bonus_credits, trial_granted_at, trial_expires_at)
       VALUES ($1, $2, NULL, NULL, NULL, NULL, $3, $3,
               0, 0, NULL, 'pro', $4, 0, 0, 0)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         plan_tier = 'pro',
         plan_expires_at = EXCLUDED.plan_expires_at
       WHERE users.phone IS NULL
         AND users.email IS NULL
         AND users.wechat_openid IS NULL
         AND users.is_admin = 0
         AND users.admin_role IS NULL
       RETURNING users.*`,
      [account.userId, account.displayName, now, account.expiresAt]
    )
  ).rows[0];
  if (!row) throw new Error("本地演示账号标识发生冲突");
  return row;
}

function adminCredentialFingerprint(
  account: Pick<AdminPasswordAccount, "username" | "userId" | "passwordHash" | "expiresAt">
): string {
  return nodeCrypto
    .createHash("sha256")
    .update(
      JSON.stringify([account.username, account.userId, account.passwordHash, account.expiresAt]),
      "utf8"
    )
    .digest("hex");
}

/**
 * 幂等 provision 环境配置中的独立密码系统管理员。
 * 已存在行只有在仍是无手机号/邮箱/微信的专用 super 时才允许同步显示名；
 * 一旦后台撤销角色或发生普通账号 id 碰撞就 fail closed，登录不能擅自恢复权限。
 */
export async function ensureAdminPasswordAccount(
  account: Pick<
    AdminPasswordAccount,
    "userId" | "displayName" | "credentialVersion" | "username" | "passwordHash" | "expiresAt"
  >
): Promise<User> {
  const now = Date.now();
  const credentialFingerprint = adminCredentialFingerprint(account);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // 固定全局锁串行化不同 userId 的蓝绿首次启动；只锁各自 user 行无法看到
    // 对方未提交的 principal，可能留下两个 enabled 密码超管。
    await client.query("SELECT pg_advisory_xact_lock($1)", [904202608]);
    const inserted = await client.query(
      `INSERT INTO users
         (id, name, phone, email, wechat_openid, avatar, created_at, last_seen,
          disabled, is_admin, admin_role, plan_tier, plan_expires_at,
          bonus_credits, trial_granted_at, trial_expires_at)
       VALUES ($1, $2, NULL, NULL, NULL, NULL, $3, $3,
               0, 1, 'super', 'free', 0, 0, 0, 0)
       ON CONFLICT (id) DO NOTHING`,
      [account.userId, account.displayName, now]
    );
    const row = (
      await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [account.userId])
    ).rows[0] as User | undefined;
    if (
      !row ||
      !isAdminPasswordUserId(row.id) ||
      Number(row.is_admin) !== 1 ||
      row.admin_role !== "super" ||
      row.phone !== null ||
      row.email !== null ||
      row.wechat_openid !== null
    ) {
      throw new AdminPasswordStateError("密码管理员 userId 冲突或权限已被撤销");
    }
    if (inserted.rowCount === 1) {
      await client.query(
        `INSERT INTO admin_password_principals
           (user_id,credential_version,credential_fingerprint,enabled,updated_at)
         VALUES($1,$2,$3,1,$4)`,
        [account.userId, account.credentialVersion, credentialFingerprint, now]
      );
    } else {
      const principal = (
        await client.query(
          `SELECT credential_version,credential_fingerprint,enabled
             FROM admin_password_principals WHERE user_id=$1 FOR UPDATE`,
          [account.userId]
        )
      ).rows[0] as {
        credential_version: number;
        credential_fingerprint: string;
        enabled: number;
      } | undefined;
      if (!principal || Number(principal.enabled) !== 1) {
        throw new AdminPasswordStateError("密码管理员缺少可信来源或已停用");
      }
      const storedVersion = Number(principal.credential_version);
      if (account.credentialVersion < storedVersion) {
        throw new AdminPasswordStateError("管理员凭据版本已过期");
      }
      const storedFingerprint = String(principal.credential_fingerprint ?? "");
      if (
        account.credentialVersion === storedVersion &&
        storedFingerprint &&
        storedFingerprint !== credentialFingerprint
      ) {
        throw new AdminPasswordStateError("管理员凭据或有效期已变化，请递增 credentialVersion");
      }
      if (
        account.credentialVersion > storedVersion ||
        !storedFingerprint
      ) {
        await client.query(
          `UPDATE admin_password_principals
              SET credential_version=$1,credential_fingerprint=$2,updated_at=$3
            WHERE user_id=$4`,
          [account.credentialVersion, credentialFingerprint, now, account.userId]
        );
        await client.query("DELETE FROM admin_sessions WHERE user_id=$1", [account.userId]);
        await client.query("DELETE FROM sessions WHERE user_id=$1", [account.userId]);
      }
      await client.query("UPDATE users SET name=$1 WHERE id=$2", [account.displayName, account.userId]);
      row.name = account.displayName;
    }
    // 配置格式只允许一套密码管理员。切换 userId 时在同一事务内先确保新主体
    // 可用，再停用并降权所有旧主体；旧蓝绿实例随即无法再验旧密码或旧 Cookie。
    const revoked = await client.query<{ user_id: string }>(
      `UPDATE admin_password_principals
          SET enabled=0,updated_at=$1
        WHERE user_id<>$2 AND enabled<>0
      RETURNING user_id`,
      [now, account.userId]
    );
    const revokedIds = revoked.rows.map((item) => item.user_id);
    if (revokedIds.length) {
      await client.query("DELETE FROM admin_sessions WHERE user_id=ANY($1::text[])", [revokedIds]);
      await client.query("DELETE FROM sessions WHERE user_id=ANY($1::text[])", [revokedIds]);
      await client.query(
        "UPDATE users SET is_admin=0,admin_role=NULL WHERE id=ANY($1::text[])",
        [revokedIds]
      );
    }
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Find-or-create a user by email — used when sharing to an address with no
 *  account yet (mirrors NotebookLM's "invite anyone by email"). */
/**
 * 注册赠送试用额度:200 积分 / 7 天(见 lib/plans.ts 的 TRIAL_CREDITS/TRIAL_DAYS)。
 *
 * 幂等靠 users 行锁 + trial_granted_at/signup_credits_granted 单调 marker 完成；
 * 同一号码连点、微信回调重放和存量补发都会串行看到最新累计发行额。
 * 同时限定 plan_tier='free'，防止误调用把已有权益用户降成试用档。
 *
 * 发放记 credit_ledger 的 `bonus:trial`,credits 记负数(与邀请奖励同口径,
 * 负数表示发放而非消耗),因此不会被「积分消耗」指标算成消耗。
 *
 * 返回是否真的发了。失败不抛 —— 注册本身不该因为送积分失败而失败,
 * trial_granted_at 保持 0,后续可补发。
 */
export async function grantSignupTrial(userId: string): Promise<boolean> {
  const now = Date.now();
  const fallbackExpiry = now + TRIAL_DAYS * 86400_000;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = (
      await client.query<User>("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId])
    ).rows[0];
    if (
      !locked ||
      locked.plan_tier !== "free" ||
      Number(locked.trial_granted_at ?? 0) !== 0 ||
      !isSignupCreditEligible(locked)
    ) {
      await client.query("ROLLBACK");
      return false;
    }
    const issue = await readSignupCreditIssueState(client, locked);
    if (issue.anomalies.length > 0) {
      throw new Error(`注册送积分流水异常:${issue.anomalies.join(",")}`);
    }
    const delta = Math.max(0, TRIAL_CREDITS - issue.issued);
    if (delta > 0) {
      const op = issue.issued === 0 ? "bonus:trial" : SIGNUP_CREDIT_UPGRADE_OP;
      const inserted = await client.query(
        `INSERT INTO credit_ledger (user_id, op, credits, bonus, plan_credits, ts, note)
           VALUES ($1, $2, $3, $3, 0, $4, $5)
           ON CONFLICT DO NOTHING
           RETURNING id`,
        [
          userId,
          op,
          -delta,
          now,
          op === "bonus:trial"
            ? `注册赠送 ${TRIAL_CREDITS} 积分，附 ${TRIAL_DAYS} 天体验权益`
            : `注册送积分升级补发 ${delta} 积分，累计 ${TRIAL_CREDITS} 积分`,
        ]
      );
      if (inserted.rowCount !== 1) {
        throw new Error("注册送积分流水幂等冲突");
      }
    }
    await client.query(
      `UPDATE users
          SET plan_tier = 'trial',
              plan_expires_at = CASE WHEN trial_expires_at > $1 THEN trial_expires_at ELSE $2 END,
              trial_expires_at = CASE WHEN trial_expires_at > $1 THEN trial_expires_at ELSE $2 END,
              bonus_credits = bonus_credits + $3,
              signup_credits_granted = GREATEST(signup_credits_granted, $4),
              trial_granted_at = $1
        WHERE id = $5`,
      [now, fallbackExpiry, delta, TRIAL_CREDITS, userId]
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    // 注册不能因为送积分失败而失败。这里只记日志,用户仍是 free 档,可事后补发。
    console.error("[trial] 注册试用发放失败:", e);
    return false;
  } finally {
    client.release();
  }
}

function signupTrialPending(user: User): boolean {
  return (
    user.plan_tier === "free" &&
    Number(user.trial_granted_at ?? 0) === 0 &&
    Number(user.trial_expires_at ?? 0) > 0
  );
}

/**
 * 注册同次的权威回读 + 一次幂等补偿。首次发放因瞬时 DB 故障失败时，
 * 返回值仍与 DB 一致；下次登录/会话可凭 trial_expires_at 再安全补发。
 */
export async function ensureSignupTrial(user: User): Promise<User> {
  let stored = user;
  if (signupTrialPending(stored)) {
    await grantSignupTrial(stored.id);
    stored = (await getUserById(stored.id)) ?? stored;
    if (signupTrialPending(stored)) {
      await grantSignupTrial(stored.id);
      stored = (await getUserById(stored.id)) ?? stored;
    }
  }
  // 存量 100→200 只允许显式迁移脚本执行；会话解析不能绕过 dry-run/备份/审计门禁。
  return stored;
}

export async function createUserByEmail(email: string, name?: string): Promise<User> {
  const addr = email.trim();
  const u: User = {
    id: uid(),
    name: name?.trim() || addr.split("@")[0],
    phone: null,
    email: addr,
    wechat_openid: null,
    wechat_nickname: null,
    avatar: null,
    created_at: Date.now(),
    last_seen: Date.now(),
    login_count: 0,
    last_login_at: 0,
    plan_tier: "free",
    plan_expires_at: 0,
    bonus_credits: 0,
    trial_granted_at: 0,
    trial_expires_at: 0,
  };
  u.trial_expires_at = u.created_at + TRIAL_DAYS * 86400_000;
  await run(
    "INSERT INTO users (id, name, phone, email, wechat_openid, avatar, created_at, last_seen, trial_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [u.id, u.name, u.phone, u.email, u.wechat_openid, u.avatar, u.created_at, u.last_seen, u.trial_expires_at]
  );
  return ensureSignupTrial(u);
}

export async function createUserByPhone(phone: string, name?: string): Promise<User> {
  const u: User = {
    id: uid(),
    name: name?.trim() || `用户${phone.slice(-4)}`,
    phone,
    email: null,
    wechat_openid: null,
    wechat_nickname: null,
    avatar: null,
    created_at: Date.now(),
    last_seen: Date.now(),
    login_count: 0,
    last_login_at: 0,
    plan_tier: "free",
    plan_expires_at: 0,
    bonus_credits: 0,
    trial_granted_at: 0,
    trial_expires_at: 0,
  };
  u.trial_expires_at = u.created_at + TRIAL_DAYS * 86400_000;
  await run(
    "INSERT INTO users (id, name, phone, wechat_openid, avatar, created_at, last_seen, trial_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [u.id, u.name, u.phone, u.wechat_openid, u.avatar, u.created_at, u.last_seen, u.trial_expires_at]
  );
  return ensureSignupTrial(u);
}

export async function createUserByWechat(openid: string, name: string, avatar?: string): Promise<User> {
  const wechatNickname = name?.trim() || null;
  const u: User = {
    id: uid(),
    name: wechatNickname || "微信用户",
    phone: null,
    email: null,
    wechat_openid: openid,
    wechat_nickname: wechatNickname,
    // 只存「自托管的 data 图片」;emoji / 外部 http 头像 URL 一律丢弃 → 头像回退首字母。
    avatar: avatar && avatar.startsWith("data:image/") ? avatar : null,
    created_at: Date.now(),
    last_seen: Date.now(),
    login_count: 0,
    last_login_at: 0,
    plan_tier: "free",
    plan_expires_at: 0,
    bonus_credits: 0,
    trial_granted_at: 0,
    trial_expires_at: 0,
  };
  u.trial_expires_at = u.created_at + TRIAL_DAYS * 86400_000;
  await run(
    "INSERT INTO users (id, name, phone, wechat_openid, wechat_nickname, avatar, created_at, last_seen, trial_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [u.id, u.name, u.phone, u.wechat_openid, u.wechat_nickname, u.avatar, u.created_at, u.last_seen, u.trial_expires_at]
  );
  return ensureSignupTrial(u);
}

export async function touchUser(id: string): Promise<void> {
  await run("UPDATE users SET last_seen = $1 WHERE id = $2", [Date.now(), id]);
}

/** 用户自助更新个人资料(昵称 / 默认输出语言 / 头像)。仅更新传入的字段。 */
/** 记录开放平台返回的稳定联合标识（幂等）。 */
export async function setWechatUnionid(id: string, unionid: string): Promise<void> {
  if (!unionid) return;
  await run("UPDATE users SET wechat_unionid = $2 WHERE id = $1 AND (wechat_unionid IS NULL OR wechat_unionid = '')", [id, unionid]);
}

export async function updateUserProfile(
  id: string,
  patch: { name?: string; wechat_nickname?: string | null; default_output_language?: string | null; avatar?: string | null; hidden_tiles?: string }
): Promise<User | undefined> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push(`name = $${vals.length + 1}`);
    vals.push(patch.name);
  }
  // 只有服务端微信授权链路传入此字段；/api/auth/me 的用户自助白名单不接受它。
  if (patch.wechat_nickname !== undefined) {
    sets.push(`wechat_nickname = $${vals.length + 1}`);
    vals.push(patch.wechat_nickname?.trim() || null);
  }
  if (patch.default_output_language !== undefined) {
    sets.push(`default_output_language = $${vals.length + 1}`);
    vals.push(patch.default_output_language || null);
  }
  if (patch.avatar !== undefined) {
    sets.push(`avatar = $${vals.length + 1}`);
    vals.push(patch.avatar || null);
  }
  if (patch.hidden_tiles !== undefined) {
    sets.push(`hidden_tiles = $${vals.length + 1}`);
    vals.push(patch.hidden_tiles);
  }
  if (sets.length) {
    vals.push(id);
    await run(`UPDATE users SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  }
  return getUserById(id);
}

/** 绑定 / 解绑微信(openid=null 即解绑)。调用方需保证解绑后仍有其它登录方式(手机号)。 */
export async function setWechatOpenid(id: string, openid: string | null): Promise<User | undefined> {
  if (openid === null) {
    // 解绑后不再保留/展示旧微信名；其余微信身份字段维持现有兼容语义。
    await run("UPDATE users SET wechat_openid = NULL, wechat_nickname = NULL WHERE id = $1", [id]);
  } else {
    // 绑定 openid 不能自行猜测昵称；昵称只由真实微信授权入口另行写入。
    await run("UPDATE users SET wechat_openid = $1 WHERE id = $2", [openid, id]);
  }
  return getUserById(id);
}

// ---- 按用户用量计量 ----

// 审查修复:产品面向中国用户,「今日/本月」统一按东八区(UTC+8)日切。
const TZ_OFFSET_MS = 8 * 3600_000;
const usageDay = (ts = Date.now()) => Math.floor((ts + TZ_OFFSET_MS) / 86400_000);

/** 套餐配置(代码默认 + app_settings 后台覆盖)。lib/db 内直接读本地 getSettingsByPrefix,
 *  避免与 lib/plans-config 循环依赖;合并逻辑复用 lib/plans 的纯函数 mergePlanOverrides。 */
async function planConfig(tier?: string | null): Promise<Plan> {
  return mergePlanOverrides(getPlan(tier), await getSettingsByPrefix("plan."));
}

function creditLedgerIdFromParams(params: string | null | undefined): number | undefined {
  try {
    const id = Number((JSON.parse(params || "{}") as { __creditLedgerId?: number }).__creditLedgerId ?? 0);
    return id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export type QuotaChargeResult = {
  over: boolean;
  limit: number;
  used: number;
  bonus: number;
  ledgerId?: number;
  /** 入队事务内命中单用户在途上限；此时尚未扣费。 */
  activeLimitExceeded?: boolean;
};

export type CreditRefundGuard = {
  /** 产物未在此时间内原子结算时，持久 outbox 自动退还该笔扣分。 */
  refundAfterMs: number;
  requestId?: string;
};

/** 已处于调用方事务内的套餐/奖励双桶扣费内核。 */
async function consumeDailyQuotaInTx(
  client: PoolClient,
  userId: string,
  op: string,
  credits: number,
  note: string | null | undefined,
  chargedAt: number
): Promise<QuotaChargeResult> {
  const locked = (
    await client.query(
      `SELECT id,phone,wechat_openid,disabled,is_admin,admin_role,
              plan_tier,plan_expires_at,bonus_credits
         FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    )
  ).rows[0] as User | undefined;
  if (!locked) throw new Error("user not found while consuming credits");
  const day = usageDay(chargedAt);
  const entitledTier = isEntitledTier(locked.plan_tier);
  const expiresAt = Number(locked.plan_expires_at ?? 0);
  if (entitledTier && expiresAt <= chargedAt && locked.plan_tier !== "test") {
    await client.query("UPDATE users SET plan_tier='free', plan_expires_at=0 WHERE id=$1", [userId]);
    locked.plan_tier = "free";
    locked.plan_expires_at = 0;
  }
  if (!hasUsageAccess(locked, chargedAt)) {
    return {
      over: true,
      limit: 0,
      used: 0,
      bonus: Number(locked.bonus_credits ?? 0),
    };
  }
  const effectiveTier = effectivePlanTierForUser(locked, chargedAt);
  const systemAdmin = isSystemAdminUser(locked);
  const limit = (await planConfig(effectiveTier)).dailyLimit;
  const before = Number(
    (
      await client.query(
        "SELECT COALESCE(SUM(count),0) AS n FROM user_usage WHERE user_id=$1 AND day=$2",
        [userId, day]
      )
    ).rows[0].n
  );
  let ledgerId: number | undefined;
  const charge = async (fromPlan: number, fromBonus: number) => {
    if (fromPlan > 0) {
      await client.query(
        `INSERT INTO user_usage (user_id,day,count) VALUES ($1,$2,$3)
           ON CONFLICT(user_id,day) DO UPDATE SET count=user_usage.count+excluded.count`,
        [userId, day, fromPlan]
      );
    }
    const inserted = await client.query(
      `INSERT INTO credit_ledger
         (user_id,op,credits,bonus,plan_credits,unlimited_at_charge,ts,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        userId,
        op,
        credits,
        fromBonus,
        fromPlan,
        limit < 0 ? 1 : 0,
        chargedAt,
        note?.slice(0, 120) ?? null,
      ]
    );
    ledgerId = Number(inserted.rows[0]?.id ?? 0) || undefined;
  };
  if (limit < 0) {
    // 系统管理员只写 unlimited ledger/ai_calls，不污染底层真实套餐的每日额度桶。
    await charge(systemAdmin ? 0 : credits, 0);
    return {
      over: false,
      limit,
      used: before + credits,
      bonus: Number(locked.bonus_credits ?? 0),
      ledgerId,
    };
  }
  const planLeft = Math.max(0, limit - before);
  const bonus = Number(locked.bonus_credits ?? 0);
  if (planLeft + bonus < credits) {
    return { over: true, limit, used: before, bonus };
  }
  const fromPlan = Math.min(credits, planLeft);
  const fromBonus = credits - fromPlan;
  await charge(fromPlan, fromBonus);
  if (fromBonus > 0) {
    await client.query("UPDATE users SET bonus_credits=bonus_credits-$1 WHERE id=$2", [fromBonus, userId]);
  }
  return {
    over: false,
    limit,
    used: before + fromPlan,
    bonus: bonus - fromBonus,
    ledgerId,
  };
}

/** 积分制配额:检查 + 双桶扣分 + 流水，在事务内原子完成。 */
export async function consumeDailyQuota(
  user: { id: string; plan_tier?: string },
  op = "chat",
  credits = 1,
  note?: string | null,
  refundGuard?: CreditRefundGuard
): Promise<QuotaChargeResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const chargedAt = Date.now();
    const result = await consumeDailyQuotaInTx(client, user.id, op, credits, note, chargedAt);
    if (!result.over && result.ledgerId && refundGuard) {
      const dueAt = chargedAt + Math.max(30_000, Math.min(60 * 60_000, refundGuard.refundAfterMs));
      const guarded = await client.query(
        `INSERT INTO credit_refund_outbox
           (ledger_id,job_id,user_id,op,credits,state,attempts,next_at,claimed_at,created_at)
         SELECT id,$1,user_id,op,credits,'pending',0,$2,0,$3
           FROM credit_ledger
          WHERE id=$4 AND user_id=$5 AND op=$6 AND credits=$7
         ON CONFLICT(ledger_id) DO NOTHING`,
        [refundGuard.requestId?.slice(0, 120) ?? null, dueAt, chargedAt, result.ledgerId, user.id, op, credits]
      );
      if (guarded.rowCount !== 1) throw new Error("扣费补偿保护建立失败");
    }
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** 退还积分:生成失败(无产物)不该扣费。记一条负流水冲抵,后台统计口径保持精确。
 *  op 传与扣费时相同的 `studio:<kind>` 便于对账。
 *  必须传 consumeDailyQuota 返回的 ledgerId；无 id/不匹配都 no-op，绝不回退“最新同价”。
 *  跨东八区日后，套餐桶已无法重新使用，该部分转为持久 bonus 补偿。 */
export async function refundCredits(
  userId: string | null | undefined,
  op: string,
  credits: number,
  ledgerId?: number
): Promise<boolean> {
  if (!userId || !(credits > 0) || !ledgerId) return false;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // 与 consumeDailyQuota 统一锁顺序：先 users，再精确扣费流水。
    const locked = await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    const row = (
      await client.query(
        `SELECT id, ts, bonus, plan_credits, unlimited_at_charge, refunded FROM credit_ledger
           WHERE id = $1 AND user_id = $2 AND op = $3 AND credits = $4
           FOR UPDATE`,
        [ledgerId, userId, op, credits]
      )
    ).rows[0] as {
      id: number;
      ts: number;
      bonus: number;
      plan_credits: number | null;
      unlimited_at_charge: number;
      refunded: number;
    } | undefined;
    if (!row) {
      await client.query("ROLLBACK");
      return false;
    }
    if (Number(row.refunded) === 1) {
      await client.query("COMMIT");
      return true;
    }
    const refundedAt = Date.now();
    const chargedDay = usageDay(Number(row.ts));
    const refundDay = usageDay(refundedAt);
    const fromBonus = Math.min(Math.max(0, Number(row.bonus ?? 0)), credits);
    // 非 NULL 的 plan_credits 是扣费时权威快照。系统管理员 unlimited ledger 为 0，
    // 积分退回不能用 credits-bonus 重新推导后误回冲原权益日桶。
    const fromPlan = row.plan_credits == null
      ? Math.max(0, credits - fromBonus)
      : Math.max(0, Number(row.plan_credits));
    const wasUnlimited = Number(row.unlimited_at_charge ?? 0) === 1;
    // NULL = 部署前旧流水：当时 user_usage 记的是全额，必须按全额回冲兼容。
    const usageRefund = row.plan_credits == null ? Math.max(0, credits - fromBonus) : fromPlan;
    const crossDayPlanCompensation = !wasUnlimited && chargedDay < refundDay ? fromPlan : 0;
    const persistentBonusRefund = fromBonus + crossDayPlanCompensation;
    const refundedPlanCredits = wasUnlimited || chargedDay >= refundDay ? -fromPlan : 0;
    if (persistentBonusRefund > 0) {
      await client.query("UPDATE users SET bonus_credits = bonus_credits + $1 WHERE id = $2", [
        persistentBonusRefund, userId,
      ]);
    }
    if (usageRefund > 0) {
      await client.query(
        "UPDATE user_usage SET count = GREATEST(0, count - $1) WHERE user_id = $2 AND day = $3",
        [usageRefund, userId, chargedDay]
      );
    }
    await client.query("UPDATE credit_ledger SET refunded = 1 WHERE id = $1", [row.id]);
    // 同日按原双桶逆向记账；跨日权益部分已转 bonus，退回行用 bonus 负值表达当前可用桶的真实增量。
    await client.query(
      `INSERT INTO credit_ledger (user_id, op, credits, bonus, plan_credits, ts, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId, `refund:${op}`, -credits, -persistentBonusRefund,
        refundedPlanCredits, refundedAt,
        crossDayPlanCompensation > 0 ? `跨日套餐积分转奖励补偿 ${crossDayPlanCompensation}` : null,
      ]
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** 数据库瞬态故障下的短重试；精确 ledgerId + refunded 标记保证重试不会多退。 */
export async function refundCreditsWithRetry(
  userId: string | null | undefined,
  op: string,
  credits: number,
  ledgerId?: number,
  attempts = 3
): Promise<boolean> {
  let lastError: unknown;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await refundCredits(userId, op, credits, ledgerId);
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)));
    }
  }
  throw lastError;
}

/**
 * 请求已明确失败时立即激活持久补偿并尝试退分。如果进程在任意
 * 一步被强杀，outbox 仍会在下次 worker 扫描时继续；refundCredits 本身幂等。
 */
export async function refundGuardedCreditsWithRetry(
  userId: string,
  op: string,
  credits: number,
  ledgerId?: number
): Promise<boolean> {
  if (!ledgerId) return refundCreditsWithRetry(userId, op, credits, ledgerId);
  // 用 CAS 抢到 guard 才能退分。若成功落库事务已把它结算为 done，
  // 或 outbox worker 已抢为 processing，这里不得再退——避免极窄竞态下
  // “产物已保存 + 同时退分”。
  const claimed = await query<{ ledger_id: number }>(
    `UPDATE credit_refund_outbox
        SET state='processing',next_at=0,claimed_at=$1,last_error=NULL
      WHERE ledger_id=$2 AND state='pending'
      RETURNING ledger_id`,
    [Date.now(), ledgerId]
  );
  if (claimed.rowCount !== 1) {
    const state = await get<{ state: string; refunded: number }>(
      `SELECT o.state,l.refunded FROM credit_refund_outbox o
       JOIN credit_ledger l ON l.id=o.ledger_id WHERE o.ledger_id=$1`,
      [ledgerId]
    );
    return Number(state?.refunded ?? 0) === 1;
  }
  try {
    const refunded = await refundCreditsWithRetry(userId, op, credits, ledgerId);
    if (refunded) {
      await run(
        `UPDATE credit_refund_outbox
            SET state='done',done_at=$1,last_error=NULL
          WHERE ledger_id=$2`,
        [Date.now(), ledgerId]
      );
    }
    return refunded;
  } catch (error) {
    await run(
      `UPDATE credit_refund_outbox
          SET state='pending',next_at=0,last_error=$1
        WHERE ledger_id=$2 AND state<>'done'`,
      [String(error instanceof Error ? error.message : error).slice(0, 300), ledgerId]
    ).catch(() => {});
    throw error;
  }
}

/** @deprecated 仅兼容旧脚本；生产入口必须直接 consumeDailyQuota 并保存 ledgerId。 */
export async function recordUserUsage(userId: string, n = 1): Promise<void> {
  try {
    const user = await getUserById(userId);
    if (user) await consumeDailyQuota(user, "legacy:usage", n);
  } catch {}
}

/**
 * M6:按套餐校验当日 AI 生成额度。over=true 时调用方应返回 429。
 * dailyLimit < 0 表示不限量。
 */
export async function checkDailyQuota(user: { id: string; plan_tier?: string }): Promise<{
  over: boolean;
  limit: number;
  used: number;
}> {
  const current = await getUserById(user.id);
  if (!current || !hasUsageAccess(current)) {
    return { over: true, limit: 0, used: 0 };
  }
  const limit = (await planConfig(effectivePlanTierForUser(current))).dailyLimit;
  if (limit < 0) return { over: false, limit, used: 0 };
  const used = (await getUserUsage(user.id)).today;
  if (used < limit) return { over: false, limit, used };
  // 套餐日额度已用完但有奖励余额时仍可由 consumeDailyQuota 原子扣减。
  return { over: (await getBonusCredits(user.id)) <= 0, limit, used };
}

/** 当日积分不足时的统一文案(各生成路由共用)。纯函数(不查库),保持同步。 */
export function quotaExceededMessage(
  quota: { limit: number; used: number; bonus: number },
  need?: number
): string {
  const left = Math.max(0, quota.limit - quota.used) + Math.max(0, quota.bonus);
  if (need && left > 0) {
    return `本次操作需 ${need} 积分，当前剩余 ${left} 积分不足`;
  }
  if (quota.limit <= 0) return "积分已用完，可通过邀请活动获取积分或联系管理员补充";
  return `今日积分已用完(每日 ${quota.limit} 积分),明日自动恢复`;
}

/** M10:按套餐校验笔记本数量上限。over=true 时调用方应拒绝创建。 */
export async function checkNotebookQuota(user: { id: string; plan_tier?: string }): Promise<{
  over: boolean;
  limit: number;
  used: number;
}> {
  const current = await getUserById(user.id);
  const limit = (await planConfig(effectivePlanTierForUser(current))).maxNotebooks;
  if (limit < 0) return { over: false, limit, used: 0 };
  // 只统计本人拥有的笔记本(不含受邀协作的)。
  const used = Number(
    (
      await get<{ n: number }>("SELECT COUNT(*) AS n FROM notebooks WHERE user_id = $1", [user.id])
    )?.n ?? 0
  );
  return { over: used >= limit, limit, used };
}

/** 今日 + 本月(东八区口径)的用量。 */
export async function getUserUsage(userId: string): Promise<{ today: number; month: number }> {
  const today = usageDay();
  // 东八区「本月 1 日 0 点」对应的 usageDay。
  const bj = new Date(Date.now() + TZ_OFFSET_MS);
  const monthStartDay = Math.floor(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1) / 86400_000);
  const row = await get<{ today: number; month: number }>(
    "SELECT " +
      "COALESCE(SUM(CASE WHEN day = $1 THEN count END), 0) AS today, " +
      "COALESCE(SUM(CASE WHEN day >= $2 THEN count END), 0) AS month " +
      "FROM user_usage WHERE user_id = $3",
    [today, monthStartDay, userId]
  );
  return { today: Number(row?.today ?? 0), month: Number(row?.month ?? 0) };
}

// ---- 积分统计(后台对账用) ---------------------------------------------------

/** 某用户最近的积分流水。credits 正=消耗、负=入账（赠送/积分退回）。 */
export async function listUserLedger(
  userId: string,
  limit = 50
): Promise<{ id: number; op: string; credits: number; bonus: number; refunded: number; ts: number }[]> {
  return all<{ id: number; op: string; credits: number; bonus: number; refunded: number; ts: number }>(
    "SELECT id, op, credits, bonus, refunded, ts FROM credit_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT $2",
    [userId, Math.min(200, Math.max(1, limit))]
  );
}

/** 用户自助「积分用量」明细(设置内表格)。type: all|acquired|consumed。
 *  游标分页(beforeId，倒序取 id 更小的)。跳过 credits=0 的旧版留痕行。
 *  credits 正=消耗、负=入账 —— 展示侧按 -credits 反号(消耗显负、入账显正)。 */
export async function getLedgerPage(
  userId: string,
  opts: { type?: "all" | "acquired" | "consumed"; limit?: number; beforeId?: number } = {}
): Promise<{
  entries: { id: number; op: string; credits: number; ts: number; note: string | null; daySpent: number }[];
  hasMore: boolean;
}> {
  const type = opts.type ?? "all";
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  // daySpent = 该行所在东八区自然日内、截至本行的套餐桶净消耗。
  // 关键:窗口在【全量账本】上算(内层子查询),再在外层按 beforeId/type 过滤 —— 否则游标翻页
  // 把更新的行滤掉会让当日累计少算、余额算错。API 用它算「当日剩余 = dailyLimit − daySpent」。
  const inner: string[] = ["user_id = $1", "credits <> 0"];
  const params: unknown[] = [userId, TZ_OFFSET_MS];
  const outer: string[] = [];
  if (type === "acquired") outer.push("credits < 0");
  else if (type === "consumed") outer.push("credits > 0");
  if (opts.beforeId && Number.isFinite(opts.beforeId)) {
    params.push(opts.beforeId);
    outer.push(`id < $${params.length}`);
  }
  params.push(limit + 1); // 多取一条判断 hasMore
  const rows = await all<{ id: number; op: string; credits: number; ts: number; note: string | null; dayspent: number }>(
    `SELECT id, op, credits, ts, note, dayspent FROM (
       SELECT id, op, credits, ts, note,
         GREATEST(0, SUM(COALESCE(
           plan_credits,
           CASE WHEN credits > 0 THEN credits
                WHEN op LIKE 'refund:%' OR op LIKE 'settle:%' THEN credits
                ELSE 0 END
         )) OVER (
           PARTITION BY ((ts + $2) / 86400000)::bigint ORDER BY id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         )) AS dayspent
       FROM credit_ledger WHERE ${inner.join(" AND ")}
     ) t${outer.length ? ` WHERE ${outer.join(" AND ")}` : ""}
     ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  return {
    entries: rows.slice(0, limit).map((r) => ({
      id: r.id, op: r.op, credits: r.credits, ts: r.ts, note: r.note, daySpent: Number(r.dayspent),
    })),
    hasMore: rows.length > limit,
  };
}

/** 近 N 天积分消耗:按操作类型汇总(精确,来自 credit_ledger)。 */
export async function creditStatsByOp(days = 30): Promise<{ op: string; credits: number; count: number }[]> {
  const since = Date.now() - days * 86400_000;
  return all<{ op: string; credits: number; count: number }>(
    "SELECT op, COALESCE(SUM(credits),0) AS credits, COUNT(*) AS count FROM credit_ledger WHERE ts >= $1 GROUP BY op ORDER BY credits DESC",
    [since]
  );
}

/** 近 N 天积分消耗:按天汇总(东八区日切,与用户侧额度同口径)。 */
export async function creditStatsByDay(days = 14): Promise<{ day: number; credits: number }[]> {
  const since = Date.now() - days * 86400_000;
  return creditConsumptionByDaySince(since);
}

/**
 * 从给定时刻起按东八区自然日聚合净积分消耗。
 *
 * 发行类流水（管理员赠送、邀请、注册赠送、补偿）不是用户消费，必须排除；
 * refund:/settle: 是原消费的负向调整，刻意保留以得到净消耗。后台固定分析、
 * 数据工作台和积分对账共用这一入口，避免三套 SQL 口径再次漂移。
 */
export async function creditConsumptionByDaySince(
  since: number
): Promise<{ day: number; credits: number }[]> {
  return all<{ day: number; credits: number }>(
    `SELECT CAST((ts + ${TZ_OFFSET_MS}) / 86400000 AS BIGINT) AS day, COALESCE(SUM(credits),0) AS credits
       FROM credit_ledger
       WHERE ts >= $1
         AND op <> 'admin:grant'
         AND op NOT LIKE 'referral:%'
         AND op NOT LIKE 'bonus:%'
         AND op NOT LIKE 'compensation:%'
       GROUP BY day ORDER BY day ASC`,
    [since]
  );
}

/** 近 N 天积分消耗 Top 用户(防滥用排查)。 */
export async function creditTopUsers(
  days = 30,
  limit = 10
): Promise<{ user_id: string; name: string; credits: number }[]> {
  const since = Date.now() - days * 86400_000;
  return all<{ user_id: string; name: string; credits: number }>(
    `SELECT l.user_id, COALESCE(u.name, '(已注销)') AS name, COALESCE(SUM(l.credits),0) AS credits
       FROM credit_ledger l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.ts >= $1
         AND l.op <> 'admin:grant'
         AND l.op NOT LIKE 'referral:%'
         AND l.op NOT LIKE 'bonus:%'
         AND l.op NOT LIKE 'compensation:%'
       GROUP BY l.user_id, u.name ORDER BY credits DESC LIMIT $2`,
    [since, limit]
  );
}

/** 近 N 天各模型 token 用量(成本核算原料;ai_calls 只留 7 天,更久用 usage_daily 聚合)。 */
export async function tokenStatsByModel(
  days = 7,
  sinceOverride?: number
): Promise<{ model: string; tokens_in: number; tokens_out: number; calls: number; cost_micros: number }[]> {
  const since = Math.max(Date.now() - days * 86400_000, sinceOverride ?? 0);
  return all<{ model: string; tokens_in: number; tokens_out: number; calls: number; cost_micros: number }>(
    `SELECT model, COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out,
            COUNT(*) AS calls, COALESCE(SUM(cost_micros),0) AS cost_micros
       FROM ai_calls WHERE ts >= $1 AND ok = 1 GROUP BY model ORDER BY tokens_out DESC`,
    [since]
  );
}

/** 积分账本最早一笔的时间戳(无记录返回 null)。用于对账窗口对齐。 */
export async function creditLedgerEarliestTs(): Promise<number | null> {
  const r = await get<{ t: number | null }>("SELECT MIN(ts) AS t FROM credit_ledger");
  return r?.t ?? null;
}

// ---- 推广返利(邀请链接 → 奖励积分)------------------------------------------

/** 每个激活里程碑奖励的积分;月度赚取上限;月度可返利邀请数上限。 */
export const REFERRAL_REWARD = 100;
export const REFERRAL_MONTHLY_CAP = 1000;
export const REFERRAL_MONTHLY_INVITES = 10;

const monthStartMs = () => {
  // 与 getUserUsage 同口径:东八区「本月 1 日 0 点」的 UTC 毫秒。
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_OFFSET_MS;
};

/** 取本人邀请码;没有则惰性生成一个唯一码。 */
export async function getOrCreateInviteCode(userId: string): Promise<string> {
  const cur = await get<{ invite_code?: string | null }>(
    "SELECT invite_code FROM users WHERE id = $1",
    [userId]
  );
  if (cur?.invite_code) return cur.invite_code;
  for (let i = 0; i < 12; i++) {
    const code = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    try {
      // 不在事务里,单条语句自动提交:唯一索引冲突抛错时 catch 换一个即可。
      await run("UPDATE users SET invite_code = $1 WHERE id = $2 AND invite_code IS NULL", [
        code,
        userId,
      ]);
    } catch {
      continue; // 唯一索引冲突 → 换一个
    }
    const after = await get<{ invite_code?: string }>(
      "SELECT invite_code FROM users WHERE id = $1",
      [userId]
    );
    if (after?.invite_code) return after.invite_code;
  }
  throw new Error("invite code generation failed");
}

export async function getUserByInviteCode(code: string): Promise<User | undefined> {
  return get<User>("SELECT * FROM users WHERE invite_code = $1", [code]);
}

export async function getBonusCredits(userId: string): Promise<number> {
  const r = await get<{ c?: number }>("SELECT bonus_credits AS c FROM users WHERE id = $1", [userId]);
  return Number(r?.c ?? 0);
}
/** 通用持久奖励入账：余额与负数 acquisition 流水同一事务。
 *  业务自己已在事务内时（如邀请里程碑）不调此函数，直接复用同样 SQL。 */
export async function grantBonusCredits(
  userId: string,
  n: number,
  op = "bonus:grant",
  note?: string | null
): Promise<void> {
  if (!(n > 0)) return;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const changed = await client.query(
      "UPDATE users SET bonus_credits = bonus_credits + $1 WHERE id = $2",
      [n, userId]
    );
    if (changed.rowCount !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      `INSERT INTO credit_ledger (user_id, op, credits, bonus, plan_credits, ts, note)
         VALUES ($1, $2, $3, $3, 0, $4, $5)`,
      [userId, op, -n, Date.now(), note?.slice(0, 120) ?? null]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
export async function consumeBonusCredits(userId: string, n: number): Promise<void> {
  if (n > 0)
    await run("UPDATE users SET bonus_credits = GREATEST(0, bonus_credits - $1) WHERE id = $2", [
      n,
      userId,
    ]);
}

/** 注册归因:被邀请人 referred_by 一次性写入 + 账本记一条 signup 行。
 *  审查修复:强制执行月度可返利邀请数上限。超出上限本次注册不归因。 */
export async function attributeReferral(refereeId: string, referrerId: string): Promise<void> {
  if (!referrerId || referrerId === refereeId) return;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // 固定 id 顺序一次锁双方，避免 A↔B 反向归因锁序死锁，并在锁内复核管理员身份。
    const lockedUsers = (await client.query(
      "SELECT * FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
      [[referrerId, refereeId]]
    )).rows as User[];
    const byId = new Map(lockedUsers.map((user) => [user.id, user]));
    const referrer = byId.get(referrerId);
    const referee = byId.get(refereeId);
    if (
      !referrer || !referee ||
      referrer.plan_tier === "test" || referee.plan_tier === "test" ||
      isSystemAdminUser(referrer) || isSystemAdminUser(referee)
    ) {
      await client.query("ROLLBACK");
      return;
    }
    const invited = Number(
      (
        await client.query(
          "SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = $1 AND milestone = 'signup' AND created_at >= $2",
          [referrerId, monthStartMs()]
        )
      ).rows[0]?.n ?? 0
    );
    if (invited >= REFERRAL_MONTHLY_INVITES) {
      await client.query("ROLLBACK");
      return;
    }
    // 条件 UPDATE 是被邀请人归属的唯一仲裁；没抢到就不得为当前 referrer 伪造 signup 账。
    const attributed = await client.query(
      "UPDATE users SET referred_by = $1 WHERE id = $2 AND referred_by IS NULL RETURNING id",
      [referrerId, refereeId]
    );
    if (attributed.rowCount !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      "INSERT INTO referrals (id, referrer_id, referee_id, milestone, credits, created_at) VALUES ($1, $2, $3, 'signup', 0, $4)",
      [uid(), referrerId, refereeId, Date.now()]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.warn("[referral] 注册归因失败:", e);
  } finally {
    client.release();
  }
}

/** 被邀请人达成激活里程碑 → 给邀请人返利。幂等(每人每里程碑一次)、受月度上限约束。失败不抛。 */
export async function awardReferralMilestone(
  refereeId: string,
  milestone: "first_chat" | "first_artifact"
): Promise<void> {
  const client = await getPool().connect();
  let notification: { referrerId: string; grant: number; label: string } | null = null;
  try {
    await client.query("BEGIN");
    const pre = (
      await client.query("SELECT referred_by FROM users WHERE id = $1", [refereeId])
    ).rows[0] as { referred_by: string | null } | undefined;
    const referrerId = pre?.referred_by;
    if (!referrerId || referrerId === refereeId) {
      await client.query("ROLLBACK");
      return;
    }
    const lockedUsers = (await client.query(
      "SELECT * FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
      [[referrerId, refereeId]]
    )).rows as User[];
    const byId = new Map(lockedUsers.map((user) => [user.id, user]));
    const referee = byId.get(refereeId);
    const locked = byId.get(referrerId);
    if (
      !referee || !locked || referee.referred_by !== referrerId ||
      referee.plan_tier === "test" || locked.plan_tier === "test" ||
      isSystemAdminUser(referee) || isSystemAdminUser(locked)
    ) {
      await client.query("ROLLBACK");
      return;
    }
    // 同一邀请人的所有里程碑经过同一 users 行锁，封顶读取与发奖不可交错。
    const exists = await client.query(
      "SELECT 1 FROM referrals WHERE referee_id = $1 AND milestone = $2",
      [refereeId, milestone]
    );
    if (exists.rowCount) {
      await client.query("ROLLBACK");
      return;
    }
    const earned = Number(
      (
        await client.query(
          "SELECT COALESCE(SUM(credits),0) AS s FROM referrals WHERE referrer_id = $1 AND created_at >= $2",
          [referrerId, monthStartMs()]
        )
      ).rows[0]?.s ?? 0
    );
    const grant = Math.max(0, Math.min(REFERRAL_REWARD, REFERRAL_MONTHLY_CAP - earned));
    // 封顶时不落里程碑，留待下个月再触发；有可发额时三件事同一事务。
    if (grant <= 0) {
      await client.query("ROLLBACK");
      return;
    }
    const now = Date.now();
    const inserted = await client.query(
      `INSERT INTO referrals (id, referrer_id, referee_id, milestone, credits, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (referee_id, milestone) DO NOTHING RETURNING id`,
      [uid(), referrerId, refereeId, milestone, grant, now]
    );
    if (inserted.rowCount !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query("UPDATE users SET bonus_credits = bonus_credits + $1 WHERE id = $2", [grant, referrerId]);
    const label = milestone === "first_chat" ? "完成首次对话" : "生成首个制品";
    await client.query(
      `INSERT INTO credit_ledger (user_id, op, credits, bonus, plan_credits, ts, note)
         VALUES ($1, $2, $3, $3, 0, $4, $5)`,
      [referrerId, `referral:${milestone}`, -grant, now, `邀请好友${label}`]
    );
    await client.query("COMMIT");
    notification = { referrerId, grant, label };
  } catch (e) {
    await client.query("ROLLBACK");
    console.warn("[referral] 里程碑发奖失败:", e);
  } finally {
    client.release();
  }
  // 通知是尾部最佳努力，不应为通知故障回滚已生效的资金账。
  if (notification) {
    await createNotification({
      userId: notification.referrerId,
      type: "referral",
      title: `邀请奖励 +${notification.grant} 积分`,
      summary: `你邀请的好友${notification.label},你获得 ${notification.grant} 积分`,
      link: null,
    }).catch(() => {});
  }
}

export async function getReferralStats(userId: string): Promise<{
  invitedThisMonth: number;
  totalInvited: number;
  earnedThisMonth: number;
  totalEarned: number;
  bonusCredits: number;
}> {
  const ms = monthStartMs();
  const n = async (sql: string, params: unknown[]) =>
    Number((await get<{ v: number }>(sql, params))?.v ?? 0);
  return {
    invitedThisMonth: await n(
      "SELECT COUNT(*) AS v FROM referrals WHERE referrer_id = $1 AND milestone='signup' AND created_at >= $2",
      [userId, ms]
    ),
    totalInvited: await n(
      "SELECT COUNT(*) AS v FROM referrals WHERE referrer_id = $1 AND milestone='signup'",
      [userId]
    ),
    earnedThisMonth: await n(
      "SELECT COALESCE(SUM(credits),0) AS v FROM referrals WHERE referrer_id = $1 AND created_at >= $2",
      [userId, ms]
    ),
    totalEarned: await n(
      "SELECT COALESCE(SUM(credits),0) AS v FROM referrals WHERE referrer_id = $1",
      [userId]
    ),
    bonusCredits: await getBonusCredits(userId),
  };
}

// ---- admin: user lifecycle ----

/** 停用 / 启用账号。停用后其 session 立即失效(见 getSessionUser)。 */
export async function setUserDisabled(id: string, disabled: boolean): Promise<void> {
  await run("UPDATE users SET disabled = $1 WHERE id = $2", [disabled ? 1 : 0, id]);
  if (disabled) await revokeUserSessions(id);
}

/** 授予或取消数据库管理员。 */
export async function setUserAdmin(id: string, isAdmin: boolean): Promise<void> {
  await run("UPDATE users SET is_admin = $1 WHERE id = $2", [isAdmin ? 1 : 0, id]);
}

/** 设三员角色(super|operator|auditor,null=撤销后台权限)。role 实时读,降权即时生效。
 *  super 时同步 is_admin=1(与旧字段一致);非 super 清 is_admin,避免旧字段残留提权。 */
export async function setUserAdminRole(id: string, role: string | null): Promise<void> {
  await run("UPDATE users SET admin_role = $1, is_admin = $2 WHERE id = $3", [role, role === "super" ? 1 : 0, id]);
}

async function lockEffectiveSuperIds(client: PoolClient): Promise<{ id: string }[]> {
  if (isAdminPasswordLoginEnforced()) {
    const account = adminPasswordAccount();
    if (!account) return [];
    const fingerprint = adminCredentialFingerprint(account);
    return (
      await client.query(
        `SELECT u.id
           FROM users u
           JOIN admin_password_principals p ON p.user_id=u.id
          WHERE u.id=$1 AND u.disabled=0 AND u.plan_tier<>'test'
            AND u.is_admin=1 AND u.admin_role='super'
            AND p.enabled=1 AND p.credential_version=$2
            AND p.credential_fingerprint=$3
          FOR UPDATE OF u,p`,
        [account.userId, account.credentialVersion, fingerprint]
      )
    ).rows as { id: string }[];
  }
  return (
    await client.query(
      `SELECT id FROM users
        WHERE disabled = 0
          AND plan_tier <> 'test'
          AND id !~ '^password-admin-[a-f0-9-]{16,80}$'
          AND (
            NULLIF(BTRIM(phone),'') IS NOT NULL
            OR NULLIF(BTRIM(wechat_openid),'') IS NOT NULL
          )
          AND (
            admin_role = 'super'
            OR (
              (admin_role IS NULL OR admin_role NOT IN ('super','operator','auditor'))
              AND is_admin = 1
            )
          )
        ORDER BY id
        FOR UPDATE`,
      []
    )
  ).rows as { id: string }[];
}

/**
 * 三员角色的原子变更：锁住全部有效 super 后再判最后超管、写角色并撤销旧会话。
 * 避免两个并发请求各自 count=2 后同时降级，最终把系统管理员清空。
 */
export async function setUserAdminRoleGuarded(
  id: string,
  role: "super" | "operator" | "auditor" | null
): Promise<"ok" | "not_found" | "last_super" | "ineligible"> {
  const activePasswordAdminId = adminPasswordAccount()?.userId ?? "";
  const enforced = isAdminPasswordLoginEnforced();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const supers = await lockEffectiveSuperIds(client);
    const target = (
      await client.query(
        `SELECT id, disabled, is_admin, admin_role, plan_tier, phone, wechat_openid
           FROM users WHERE id = $1 FOR UPDATE`,
        [id]
      )
    ).rows[0] as
      | {
          id: string;
          disabled: number;
          is_admin: number;
          admin_role: string | null;
          plan_tier: string;
          phone: string | null;
          wechat_openid: string | null;
        }
      | undefined;
    if (!target) {
      await client.query("ROLLBACK");
      return "not_found";
    }
    const normalLogin =
      Number(target.disabled) === 0 &&
      target.plan_tier !== "test" &&
      !isAdminPasswordUserId(target.id) &&
      (!!target.phone?.trim() || !!target.wechat_openid?.trim());
    const targetHasAdminLogin =
      role === "super"
        ? enforced
          ? target.id === activePasswordAdminId && Number(target.disabled) === 0 && target.plan_tier !== "test"
          : normalLogin
        : normalLogin;
    if (role !== null && !targetHasAdminLogin) {
      await client.query("ROLLBACK");
      return "ineligible";
    }
    const targetIsActiveSuper = supers.some((superUser) => superUser.id === target.id);
    if (targetIsActiveSuper && role !== "super" && supers.length <= 1) {
      await client.query("ROLLBACK");
      return "last_super";
    }
    await client.query("UPDATE users SET admin_role = $1, is_admin = $2 WHERE id = $3", [
      role,
      role === "super" ? 1 : 0,
      id,
    ]);
    await client.query("DELETE FROM sessions WHERE user_id = $1", [id]);
    await client.query("DELETE FROM admin_sessions WHERE user_id = $1", [id]);
    await client.query("COMMIT");
    return "ok";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 停用/删除前置使用同一有效 super 锁与判据，杜绝假 super 绕过最后超管守卫。 */
export async function guardUserAdminLifecycle(
  id: string,
  action: "disable" | "delete"
): Promise<"ok" | "not_found" | "last_super"> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const supers = await lockEffectiveSuperIds(client);
    const target = (
      await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [id])
    ).rows[0] as { id: string } | undefined;
    if (!target) {
      await client.query("ROLLBACK");
      return "not_found";
    }
    if (supers.some((superUser) => superUser.id === id) && supers.length <= 1) {
      await client.query("ROLLBACK");
      return "last_super";
    }
    if (action === "disable") {
      await client.query("UPDATE users SET disabled=1 WHERE id=$1", [id]);
    } else {
      await client.query(
        "UPDATE users SET disabled=1,is_admin=0,admin_role=NULL WHERE id=$1",
        [id]
      );
    }
    await client.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    await client.query("DELETE FROM admin_sessions WHERE user_id=$1", [id]);
    await client.query("COMMIT");
    return "ok";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 系统管理员(super)总数 —— 最后超管守卫用(不能把最后一个 super 降级/停用)。
 *  含 is_admin=1 的旧管理员(兼容视为 super)。停用者不计。 */
export async function countSuperAdmins(): Promise<number> {
  if (isAdminPasswordLoginEnforced()) {
    const account = adminPasswordAccount();
    if (!account) return 0;
    const fingerprint = adminCredentialFingerprint(account);
    const r = await get<{ c: number }>(
      `SELECT COUNT(*) AS c
         FROM users u
         JOIN admin_password_principals p ON p.user_id=u.id
        WHERE u.id=$1 AND u.disabled=0 AND u.plan_tier<>'test'
          AND u.is_admin=1 AND u.admin_role='super'
          AND p.enabled=1 AND p.credential_version=$2
          AND p.credential_fingerprint=$3`,
      [account.userId, account.credentialVersion, fingerprint]
    );
    return Number(r?.c ?? 0);
  }
  const r = await get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM users
      WHERE disabled = 0
        AND plan_tier <> 'test'
        AND id !~ '^password-admin-[a-f0-9-]{16,80}$'
        AND (
          NULLIF(BTRIM(phone),'') IS NOT NULL
          OR NULLIF(BTRIM(wechat_openid),'') IS NOT NULL
        )
        AND (
          admin_role = 'super'
          OR (
            (admin_role IS NULL OR admin_role NOT IN ('super','operator','auditor'))
            AND is_admin = 1
          )
        )`,
    []
  );
  return Number(r?.c ?? 0);
}

/** 列出所有有后台角色的账户(账户管理页)。含 admin_role 非空 或 is_admin=1。 */
export async function listAdminAccounts(): Promise<
  Array<{ id: string; name: string; phone: string | null; email: string | null; admin_role: string | null; is_admin: number; disabled: number; created_at: number; managed_password: number }>
> {
  const activePasswordAdminId = adminPasswordAccount()?.userId ?? "";
  const rows = await all<{
    id: string; name: string; phone: string | null; email: string | null;
    admin_role: string | null; is_admin: number; disabled: number; created_at: number;
  }>(
    "SELECT id, name, phone, email, admin_role, is_admin, disabled, created_at FROM users WHERE admin_role IS NOT NULL OR is_admin = 1 ORDER BY created_at ASC"
  );
  return rows.map((row) => ({ ...row, managed_password: row.id === activePasswordAdminId ? 1 : 0 }));
}

/** 撤销某用户的全部登录态。返回删除的会话数。 */
export async function revokeUserSessions(id: string): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const normal = await client.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    const admin = await client.query("DELETE FROM admin_sessions WHERE user_id=$1", [id]);
    await client.query("COMMIT");
    return Number(normal.rowCount ?? 0) + Number(admin.rowCount ?? 0);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 硬删除用户。其拥有的笔记本一并删除(逐个走 deleteNotebook 以清理媒体文件)。 */
export async function deleteUser(id: string): Promise<void> {
  const owned = await all<{ id: string }>("SELECT id FROM notebooks WHERE user_id = $1", [id]);
  for (const n of owned) await deleteNotebook(n.id);
  // 审查修复:referrals 无 FK,注销后会留孤儿账(作为被邀请人/邀请人的两向记录)。
  await run("DELETE FROM referrals WHERE referee_id = $1 OR referrer_id = $1", [id]);
  await run("DELETE FROM users WHERE id = $1", [id]); // sessions/collaborators 级联
}

/** 转移笔记本所有者。 */
export async function transferNotebookOwner(notebookId: string, userId: string): Promise<void> {
  // 事务:改 owner 的同时清掉新 owner 残留的协作者行(否则他既是 owner 又在协作者表里)。
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE notebooks SET user_id = $1 WHERE id = $2", [userId, notebookId]);
    await client.query(
      "DELETE FROM notebook_collaborators WHERE notebook_id = $1 AND user_id = $2",
      [notebookId, userId]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Users seen within the window (default 2 min) — "online now". */
export async function listOnlineUsers(windowMs = 120000): Promise<User[]> {
  return all<User>(
    "SELECT * FROM users WHERE last_seen > $1 AND plan_tier <> 'test' AND id NOT LIKE 'password-admin-%' ORDER BY last_seen DESC",
    [Date.now() - windowMs]
  );
}

/**
 * 跨进程/蓝绿实例共享的认证滑动窗口。bucketHash 必须由调用方先做 SHA-256，
 * 表里不保存 IP、用户名或访问密钥原文。单条 UPSERT 原子累加，并发不会丢计数。
 */
let authRateLastSweep = 0;
const AUTH_RATE_RETENTION_MS = 24 * 60 * 60_000;
export async function consumeAuthRateLimit(
  bucketHash: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): Promise<{ ok: boolean; retryAfter: number }> {
  if (
    !/^[a-f0-9]{64}$/.test(bucketHash) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1000 ||
    windowMs > AUTH_RATE_RETENTION_MS
  ) {
    return { ok: false, retryAfter: 60 };
  }
  // 错用户名/轮换 IP 会制造新 bucket；每进程至多每分钟清一次 24h 前的过期行，
  // 蓝绿实例共享同表，任一实例触发即可阻止表单调膨胀。
  if (now < authRateLastSweep || now - authRateLastSweep >= 60_000) {
    authRateLastSweep = now;
    await run("DELETE FROM auth_rate_limits WHERE updated_at < $1", [now - AUTH_RATE_RETENTION_MS]);
  }
  const row = (
    await query<{ attempts: number; window_started_at: number }>(
      `INSERT INTO auth_rate_limits (bucket_hash, window_started_at, attempts, updated_at)
       VALUES ($1, $2, 1, $2)
       ON CONFLICT (bucket_hash) DO UPDATE SET
         attempts = CASE
           WHEN auth_rate_limits.window_started_at <= $2 - $3 THEN 1
           ELSE LEAST(auth_rate_limits.attempts + 1, 1000000)
         END,
         window_started_at = CASE
           WHEN auth_rate_limits.window_started_at <= $2 - $3 THEN $2
           ELSE auth_rate_limits.window_started_at
         END,
         updated_at = $2
       RETURNING attempts, window_started_at`,
      [bucketHash, now, windowMs]
    )
  ).rows[0];
  const attempts = Number(row?.attempts ?? limit + 1);
  const startedAt = Number(row?.window_started_at ?? now);
  return {
    ok: attempts <= limit,
    retryAfter: attempts <= limit ? 0 : Math.max(1, Math.ceil((startedAt + windowMs - now) / 1000)),
  };
}

export async function createSession(userId: string, ttlDays = 30): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  // 单条数据修改 CTE 保证「会话已颁发」与「登录统计已前进」同成同败。
  // 计数收口放在这里而不是 auth.login 日志：微信 callback/mp + poll 的旧日志链路会双记，
  // 而真正给发起登录的浏览器下发 session 只会经过此处一次。
  const changed = await run(
    `WITH new_session AS (
       INSERT INTO sessions (token, user_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id
     )
     UPDATE users u
        SET login_count = u.login_count + 1,
            last_login_at = GREATEST(u.last_login_at, $3)
       FROM new_session s
      WHERE u.id = s.user_id`,
    [token, userId, now, now + ttlDays * 86400000]
  );
  if (changed !== 1) throw new Error("登录用户不存在");
  return token;
}

export const ADMIN_SESSION_IDLE_MS = 30 * 60_000;

function adminSessionTokenHash(token: string): string {
  return nodeCrypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** 系统管理员独立短会话：同一账号只保留最新一份，DB 永不保存明文 token。 */
export async function createAdminSession(
  userId: string,
  credentialVersion: number,
  maxAgeSeconds: number
): Promise<string> {
  const configured = adminPasswordAccountByUserId(userId);
  if (!configured || configured.credentialVersion !== credentialVersion) {
    throw new AdminPasswordStateError("管理员凭据配置不可用");
  }
  const fingerprint = adminCredentialFingerprint(configured);
  const token = nodeCrypto.randomBytes(32).toString("base64url");
  const hash = adminSessionTokenHash(token);
  const now = Date.now();
  const expiresAt = now + maxAgeSeconds * 1000;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const user = (
      await client.query(
        `SELECT u.disabled,u.is_admin,u.admin_role,p.credential_version,
                p.credential_fingerprint,p.enabled
           FROM users u JOIN admin_password_principals p ON p.user_id=u.id
          WHERE u.id=$1 FOR UPDATE OF u,p`,
        [userId]
      )
    ).rows[0] as {
      disabled: number; is_admin: number; admin_role: string | null;
      credential_version: number; credential_fingerprint: string; enabled: number;
    } | undefined;
    if (
      !user || user.disabled || Number(user.is_admin) !== 1 || user.admin_role !== "super" ||
      Number(user.enabled) !== 1 || Number(user.credential_version) !== credentialVersion ||
      user.credential_fingerprint !== fingerprint
    ) {
      throw new AdminPasswordStateError("管理员身份不可用");
    }
    await client.query("DELETE FROM admin_sessions WHERE user_id=$1", [userId]);
    await client.query(
      `INSERT INTO admin_sessions
         (token_hash,user_id,credential_version,created_at,last_seen,expires_at)
       VALUES ($1,$2,$3,$4,$4,$5)`,
      [hash, userId, credentialVersion, now, expiresAt]
    );
    await client.query("COMMIT");
    return token;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 一次事务签发前台短会话 + 后台独立会话，避免只成功一半并确保登录统计只加一次。 */
export async function createAdminLoginSessions(
  userId: string,
  credentialVersion: number,
  maxAgeSeconds: number
): Promise<{ userToken: string; adminToken: string }> {
  const configured = adminPasswordAccountByUserId(userId);
  if (!configured || configured.credentialVersion !== credentialVersion) {
    throw new AdminPasswordStateError("管理员凭据配置不可用");
  }
  const fingerprint = adminCredentialFingerprint(configured);
  const userToken = nodeCrypto.randomBytes(32).toString("hex");
  const adminToken = nodeCrypto.randomBytes(32).toString("base64url");
  const adminHash = adminSessionTokenHash(adminToken);
  const now = Date.now();
  const expiresAt = now + maxAgeSeconds * 1000;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const user = (
      await client.query(
        `SELECT u.disabled,u.is_admin,u.admin_role,p.credential_version,
                p.credential_fingerprint,p.enabled
           FROM users u JOIN admin_password_principals p ON p.user_id=u.id
          WHERE u.id=$1 FOR UPDATE OF u,p`,
        [userId]
      )
    ).rows[0] as {
      disabled: number; is_admin: number; admin_role: string | null;
      credential_version: number; credential_fingerprint: string; enabled: number;
    } | undefined;
    if (
      !user || user.disabled || Number(user.is_admin) !== 1 || user.admin_role !== "super" ||
      Number(user.enabled) !== 1 || Number(user.credential_version) !== credentialVersion ||
      user.credential_fingerprint !== fingerprint
    ) {
      throw new AdminPasswordStateError("管理员身份不可用");
    }
    await client.query("DELETE FROM admin_sessions WHERE user_id=$1", [userId]);
    await client.query(
      `INSERT INTO admin_sessions
         (token_hash,user_id,credential_version,created_at,last_seen,expires_at)
       VALUES ($1,$2,$3,$4,$4,$5)`,
      [adminHash, userId, credentialVersion, now, expiresAt]
    );
    await client.query(
      "INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)",
      [userToken, userId, now, expiresAt]
    );
    await client.query(
      `UPDATE users SET login_count=login_count+1,
         last_login_at=GREATEST(last_login_at,$1) WHERE id=$2`,
      [now, userId]
    );
    await client.query("COMMIT");
    return { userToken, adminToken };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 解析独立管理员会话，并复核 idle/绝对过期、凭据版本、指纹、停用与 DB super。 */
export async function getAdminSessionUser(
  token: string | undefined | null,
  opts: { touch?: boolean } = {}
): Promise<User | undefined> {
  if (!token || token.length > 128) return undefined;
  const hash = adminSessionTokenHash(token);
  const configured = adminPasswordAccount();
  if (!configured) {
    // 配置关闭/畸形/过期不仅拒绝本次请求，也销毁已出示的服务端会话，避免
    // 运维稍后恢复旧配置时同一枚高权 Cookie 自动复活。
    await run("DELETE FROM admin_sessions WHERE token_hash=$1", [hash]);
    return undefined;
  }
  const now = Date.now();
  const fingerprint = adminCredentialFingerprint(configured);
  type AdminSessionRow = User & {
    credential_version: number;
    principal_version: number;
    principal_fingerprint: string;
    principal_enabled: number;
  };
  const params = [
    hash,
    now,
    now - ADMIN_SESSION_IDLE_MS,
    fingerprint,
    configured.credentialVersion,
    configured.userId,
  ];
  const predicate = `s.token_hash=$1
        AND s.user_id=u.id
        AND s.expires_at>$2
        AND s.last_seen>$3
        AND s.credential_version=$5
        AND u.id=$6
        AND u.disabled=0
        AND u.is_admin=1
        AND u.admin_role='super'
        AND p.enabled=1
        AND p.credential_version=s.credential_version
        AND p.credential_fingerprint=$4`;
  const projection = `u.*,s.credential_version,
        p.credential_version AS principal_version,
        p.credential_fingerprint AS principal_fingerprint,
        p.enabled AS principal_enabled`;
  const row = opts.touch === false
    ? await get<AdminSessionRow>(
        `SELECT ${projection}
           FROM admin_sessions s
           JOIN users u ON u.id=s.user_id
           JOIN admin_password_principals p ON p.user_id=u.id
          WHERE ${predicate}`,
        params
      )
    : await get<AdminSessionRow>(
        `UPDATE admin_sessions s
            SET last_seen=$2
           FROM users u
           JOIN admin_password_principals p ON p.user_id=u.id
          WHERE ${predicate}
          RETURNING ${projection}`,
        params
      );
  if (
    !row || row.id !== configured.userId || Number(row.principal_enabled) !== 1 ||
    Number(row.principal_version) !== Number(row.credential_version) ||
    row.principal_fingerprint !== fingerprint ||
    configured.credentialVersion !== Number(row.credential_version)
  ) {
    await run("DELETE FROM admin_sessions WHERE token_hash=$1", [hash]);
    return undefined;
  }
  return row;
}

export async function deleteAdminSession(token: string | undefined | null): Promise<void> {
  if (!token || token.length > 128) return;
  await run("DELETE FROM admin_sessions WHERE token_hash=$1", [adminSessionTokenHash(token)]);
}

/** Resolve a session token to its user (and refresh last_seen). Null if expired. */
export async function getSessionUser(token: string | undefined | null): Promise<User | undefined> {
  if (!token) return undefined;
  const row = await get<User>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > $2`,
    [token, Date.now()]
  );
  // 停用账号:会话立即失效(等同未登录),后台「停用」即时生效。
  if (row?.disabled) return undefined;
  if (!row) return row;
  // 测试账号的生产环境配置是第二道撤销源。删除账号配置或关闭专用入口后，
  // 不必等待 cookie/DB session 到期，现有会话从下一次请求起立即失效。
  if (row.plan_tier === "test") {
    const configured = experienceAccountByUserId(row.id);
    if (!configured) return undefined;
    // 环境配置可续期/缩期；会话解析先同步权威 expiresAt，再返回，绝不能让通用
    // downgrade 把内部 test 永久改成 free（否则续期后也无法再登录）。
    if (Number(row.plan_expires_at ?? 0) !== configured.expiresAt) {
      await run("UPDATE users SET plan_expires_at=$1 WHERE id=$2 AND plan_tier='test'", [
        configured.expiresAt,
        row.id,
      ]);
      row.plan_expires_at = configured.expiresAt;
    }
  }
  // 本机演示账号由精确的回环配置即时授权；关闭开关、改为公网 Origin 或轮换
  // owner 配置后，旧普通会话从下一次请求起立即失效。
  if (isLocalPreviewUserId(row.id)) {
    const configured = localPreviewAccountByUserId(row.id);
    if (
      !configured ||
      Number(row.is_admin) !== 0 ||
      row.admin_role !== null ||
      row.phone !== null ||
      row.email !== null ||
      row.wechat_openid !== null
    ) {
      await revokeUserSessions(row.id);
      return undefined;
    }
    if (row.plan_tier !== "pro" || Number(row.plan_expires_at ?? 0) !== configured.expiresAt) {
      await run(
        "UPDATE users SET plan_tier='pro',plan_expires_at=$1 WHERE id=$2 AND is_admin=0 AND admin_role IS NULL",
        [configured.expiresAt, row.id]
      );
      row.plan_tier = "pro";
      row.plan_expires_at = configured.expiresAt;
    }
  }
  // 独立密码管理员的环境配置同时是会话撤销源。关闭入口、配置过期、轮换到新 userId
  // 或后台撤销 super 后，旧 cookie 从下一次请求起立即失效。
  if (isAdminPasswordUserId(row.id)) {
    const configured = adminPasswordAccountByUserId(row.id);
    const principal = configured
      ? await get<{ credential_version: number; credential_fingerprint: string; enabled: number }>(
          `SELECT credential_version,credential_fingerprint,enabled
             FROM admin_password_principals WHERE user_id=$1`,
          [row.id]
        )
      : undefined;
    if (
      !configured || Number(row.is_admin) !== 1 || row.admin_role !== "super" ||
      !principal || Number(principal.enabled) !== 1 ||
      Number(principal.credential_version) !== configured.credentialVersion ||
      principal.credential_fingerprint !== adminCredentialFingerprint(configured)
    ) {
      await revokeUserSessions(row.id);
      return undefined;
    }
  }
  // 新建用户若在「建号成功、试用流水失败」窗口中断，会凭 trial_expires_at 补发；
  // 存量升级由显式迁移执行，普通会话不得触发财务补发。
  const resolved = await ensureSignupTrial(row);
  await touchUser(resolved.id);
  // 限时权益到期 → 惰性回落 free（每请求最多一次写，降级后不再触发）。
  return downgradeIfExpired(resolved);
}

export async function deleteSession(token: string): Promise<void> {
  await run("DELETE FROM sessions WHERE token = $1", [token]);
}

/** 限时权益到期后惰性回落基础档；每个请求至多写一次。 */
export async function downgradeIfExpired(user: User): Promise<User> {
  // test 的有效性由部署配置和会话解析即时控制，保留档位便于显式续期。
  if (user.plan_tier === "test") return user;
  const expiresAt = Number(user.plan_expires_at ?? 0);
  if (user.plan_tier && user.plan_tier !== "free" && expiresAt <= Date.now()) {
    await run(
      "UPDATE users SET plan_tier='free', plan_expires_at=0 WHERE id=$1 AND plan_expires_at=$2",
      [user.id, expiresAt]
    );
    return { ...user, plan_tier: "free", plan_expires_at: 0 };
  }
  return user;
}

// ---- notebook access control ----

export type NotebookRole = "owner" | "editor" | "viewer";

// ---- jobs (async artifact generation queue) ----

export async function createJob(
  notebookId: string,
  userId: string | null,
  kind: JobKind, // StudioKind + 系统任务(feed_enum/feed_ingest,user_id=null、负优先级)
  title: string,
  params: unknown,
  // 护城河 2:队列优先级(整数,越大越先被认领)。默认 0 = FIFO 行为。
  priority = 0,
  // R1:feed 系统任务所属频道(索引列,补偿器/孤儿批联查用;用户任务不传 = NULL)。
  channelId: string | null = null,
  initialStatus: JobStatus = "queued",
  idempotencyKey: string | null = null
): Promise<Job> {
  const now = Date.now();
  const job: Job = {
    id: uid(),
    notebook_id: notebookId,
    user_id: userId,
    kind,
    title,
    status: initialStatus,
    progress: 0,
    params: params == null ? null : JSON.stringify(params),
    output_id: null,
    error: null,
    created_at: now,
    updated_at: now,
    run_attempt: 0,
    priority,
    lane: null,
    started_at: 0,
    finished_at: 0,
    stage: null,
    stage_started_at: 0,
    credits_reserved: 0,
    credits_final: 0,
    tokens_in: 0,
    tokens_out: 0,
    idempotency_key: idempotencyKey,
  };
  await run(
    `INSERT INTO jobs (id, notebook_id, user_id, kind, title, status, progress, params, output_id, error, created_at, updated_at, priority, channel_id,idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,$15)`,
    [
      job.id,
      job.notebook_id,
      job.user_id,
      job.kind,
      job.title,
      job.status,
      job.progress,
      job.params,
      job.output_id,
      job.error,
      job.created_at,
      job.updated_at,
      job.priority,
      channelId,
      idempotencyKey,
    ]
  );
  return job;
}

export type AdminJobRetryResult =
  | { status: "requeued"; job: Job }
  | { status: "not_found" }
  | { status: "not_retryable" }
  | { status: "retry_limit" }
  | { status: "params_invalid" };

/**
 * 管理端人工重试复用原任务行，原子地 error → queued。
 * canceled 表示明确取消意图，不能被运营员复活；同一任务最多人工重试一次。
 * 原扣费已进入补偿流程，重试快照强制 sponsored 且清空旧台账引用。
 */
export async function requeueFailedJobAsSponsored(id: string): Promise<AdminJobRetryResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const job = (
      await client.query("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [id])
    ).rows[0] as Job | undefined;
    if (!job) {
      await client.query("ROLLBACK");
      return { status: "not_found" };
    }
    if (job.status !== "error") {
      await client.query("ROLLBACK");
      return { status: "not_retryable" };
    }
    let params: Record<string, unknown>;
    try {
      const parsed = job.params ? JSON.parse(job.params) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      params = parsed as Record<string, unknown>;
    } catch {
      await client.query("ROLLBACK");
      return { status: "params_invalid" };
    }
    const retryCount = Number(params.__adminRetryCount ?? 0);
    if (!Number.isSafeInteger(retryCount) || retryCount < 0 || retryCount >= 1) {
      await client.query("ROLLBACK");
      return { status: "retry_limit" };
    }
    delete params.__creditLedgerId;
    delete params.__reservedCredits;
    params.__sponsored = true;
    params.__adminRetryCount = retryCount + 1;
    const now = Date.now();
    const retried = (
      await client.query(
        `UPDATE jobs
            SET status='queued',progress=0,params=$2,output_id=NULL,error=NULL,updated_at=$3::bigint,
                credits_reserved=0,credits_final=0,tokens_in=0,tokens_out=0,
                finished_at=0,
                stage=CASE WHEN kind='cad' THEN 'queued' ELSE NULL END,
                stage_started_at=CASE WHEN kind='cad' THEN $3::bigint ELSE 0::bigint END
          WHERE id=$1 AND status='error'
          RETURNING *`,
        [id, JSON.stringify(params), now]
      )
    ).rows[0] as Job | undefined;
    if (!retried) {
      await client.query("ROLLBACK");
      return { status: "not_retryable" };
    }
    await client.query("COMMIT");
    return { status: "requeued", job: retried };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type CadRevisionJobCreateResult = {
  job?: Job;
  reused: boolean;
  over: boolean;
  conflict: boolean;
  quota?: QuotaChargeResult;
};

/**
 * CAD 确定性修订的原子入队裁决。
 *
 * 同一事务先锁用户行，再完成“同父版本幂等/冲突 → 用户在途上限 → INSERT”。
 * 不能把这三步拆回 route：跨实例并发会同时看见 active=0 后各自建任务，修订请求
 * 就能绕过 M9 灌满全局单 worker。
 */
export async function createCadRevisionJobAtomic(args: {
  notebookId: string;
  userId: string;
  title: string;
  params: {
    cadRevision: {
      parentOutputId: string;
      baseHash: string;
      targetHash: string;
      patch: unknown;
    };
    __deterministic: true;
  };
  priority: number;
  maxActive: number;
  cost: number;
  note?: string | null;
}): Promise<CadRevisionJobCreateResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // 先锁父制品：不同协作者会锁不同 users 行，只锁用户挡不住同一 parent 并发。
    const parent = await client.query(
      "SELECT id FROM studio_outputs WHERE id=$1 AND notebook_id=$2 AND kind='cad' AND status='ready' FOR UPDATE",
      [args.params.cadRevision.parentOutputId, args.notebookId]
    );
    if (parent.rowCount !== 1) throw new Error("CAD 修订父版本不存在");
    const locked = await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [args.userId]);
    if (locked.rowCount !== 1) throw new Error("CAD 修订用户不存在");

    // 同 parent 的在途修订全局唯一（不按 user 过滤），避免两个协作者各建一个同名 v2。
    const activeRows = (
      await client.query(
        `SELECT * FROM jobs
          WHERE notebook_id=$1 AND kind='cad'
            AND status IN ('queued','running')
            AND COALESCE(params,'{}')::jsonb #>> '{cadRevision,parentOutputId}' = $2
          ORDER BY created_at ASC
          FOR UPDATE`,
        [args.notebookId, args.params.cadRevision.parentOutputId]
      )
    ).rows as Job[];
    if (activeRows.length > 0) {
      const existing = activeRows[0];
      let targetHash = "";
      try {
        targetHash = String(
          (JSON.parse(existing.params || "{}") as { cadRevision?: { targetHash?: unknown } })
            .cadRevision?.targetHash ?? ""
        );
      } catch {
        targetHash = "";
      }
      await client.query("COMMIT");
      if (existing.user_id === args.userId && targetHash === args.params.cadRevision.targetHash) {
        return { job: existing, reused: true, over: false, conflict: false };
      }
      return { reused: false, over: false, conflict: true };
    }

    // 首个 202 或轮询响应丢失后，同一用户重试同 targetHash 应复用已完成任务；
    // 不同 targetHash 的后续分支仍允许基于同一父版重新生成。
    const done = (
      await client.query(
        `SELECT j.* FROM jobs j
          WHERE j.user_id=$1 AND j.notebook_id=$2 AND j.kind='cad' AND j.status='done'
            AND j.output_id IS NOT NULL
            AND COALESCE(j.params,'{}')::jsonb #>> '{cadRevision,parentOutputId}' = $3
            AND COALESCE(j.params,'{}')::jsonb #>> '{cadRevision,targetHash}' = $4
            AND EXISTS (
              SELECT 1 FROM studio_outputs o
               WHERE o.id=j.output_id AND o.notebook_id=j.notebook_id AND o.status='ready'
            )
          ORDER BY j.created_at DESC LIMIT 1
          FOR UPDATE`,
        [args.userId, args.notebookId, args.params.cadRevision.parentOutputId, args.params.cadRevision.targetHash]
      )
    ).rows[0] as Job | undefined;
    if (done) {
      await client.query("COMMIT");
      return { job: done, reused: true, over: false, conflict: false };
    }

    const active = Number(
      (
        await client.query(
          "SELECT COUNT(*) AS n FROM jobs WHERE user_id=$1 AND status IN ('queued','running')",
          [args.userId]
        )
      ).rows[0]?.n ?? 0
    );
    if (active >= Math.max(1, Math.min(20, Math.floor(args.maxActive)))) {
      await client.query("COMMIT");
      return { reused: false, over: true, conflict: false };
    }

    const now = Date.now();
    const cost = Math.max(1, Math.round(args.cost));
    const quota = await consumeDailyQuotaInTx(
      client,
      args.userId,
      "studio:cad",
      cost,
      args.note,
      now
    );
    if (quota.over || !quota.ledgerId) {
      await client.query("COMMIT");
      return { reused: false, over: true, conflict: false, quota };
    }
    const storedParams = {
      ...args.params,
      __reservedCredits: cost,
      __creditLedgerId: quota.ledgerId,
    };
    const job: Job = {
      id: uid(),
      notebook_id: args.notebookId,
      user_id: args.userId,
      kind: "cad",
      title: args.title,
      status: "queued",
      progress: 0,
      params: JSON.stringify(storedParams),
      output_id: null,
      error: null,
      created_at: now,
      updated_at: now,
      run_attempt: 0,
      priority: Math.max(-100, Math.min(100, Math.round(args.priority))),
      lane: null,
      started_at: 0,
      finished_at: 0,
      stage: null,
      stage_started_at: 0,
      credits_reserved: cost,
      credits_final: 0,
      tokens_in: 0,
      tokens_out: 0,
    };
    await client.query(
      `INSERT INTO jobs
         (id,notebook_id,user_id,kind,title,status,progress,params,output_id,error,
          created_at,updated_at,priority,channel_id,credits_reserved)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14)`,
      [
        job.id,
        job.notebook_id,
        job.user_id,
        job.kind,
        job.title,
        job.status,
        job.progress,
        job.params,
        job.output_id,
        job.error,
        job.created_at,
        job.updated_at,
        job.priority,
        job.credits_reserved,
      ]
    );
    await client.query("COMMIT");
    return { job, reused: false, over: false, conflict: false, quota };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * draft job 的扣费与 queued 激活同一事务：成功后 job/预留价/ledgerId 同时可见；
 * 失败或进程退出最多留下未扣费 draft，绝不会出现“已退分但 queued 仍执行”。
 */
export async function activateChargedJob(
  jobId: string,
  userId: string,
  op: string,
  credits: number,
  note?: string | null,
  maxActive?: number
): Promise<QuotaChargeResult & { job?: Job }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const draft = (
      await client.query("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [jobId])
    ).rows[0] as Job | undefined;
    if (!draft || draft.status !== "draft" || draft.user_id !== userId) {
      throw new Error("charged job draft is missing or immutable fields mismatch");
    }
    // M9 的最终门禁必须与扣费、draft -> queued 同一事务。
    // 先锁用户行，使同一用户在多实例/多请求下的“统计 + 激活”串行化；
    // route 层的 countActiveJobsByUser 只能作为避免重型体检的快速优化。
    if (maxActive !== undefined) {
      const locked = await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
      if (locked.rowCount !== 1) throw new Error("user not found while activating charged job");
      const active = Number(
        (
          await client.query(
            "SELECT COUNT(*) AS n FROM jobs WHERE user_id=$1 AND status IN ('queued','running')",
            [userId]
          )
        ).rows[0]?.n ?? 0
      );
      const boundedMax = Math.max(1, Math.min(20, Math.floor(maxActive)));
      if (active >= boundedMax) {
        await client.query("DELETE FROM jobs WHERE id=$1 AND status='draft'", [jobId]);
        await client.query("COMMIT");
        return {
          over: true,
          limit: 0,
          used: 0,
          bonus: 0,
          activeLimitExceeded: true,
        };
      }
    }
    const quota = await consumeDailyQuotaInTx(client, userId, op, credits, note, Date.now());
    if (quota.over || !quota.ledgerId) {
      await client.query("DELETE FROM jobs WHERE id=$1 AND status='draft'", [jobId]);
      await client.query("COMMIT");
      return quota;
    }
    const activated = (
      await client.query(
        `UPDATE jobs SET status='queued', credits_reserved=$1, updated_at=$2,
           params=(COALESCE(NULLIF(params,''),'{}')::jsonb ||
             jsonb_build_object('__reservedCredits',$1::bigint,'__creditLedgerId',$3::bigint))::text
         WHERE id=$4 AND status='draft' RETURNING *`,
        [Math.max(0, Math.round(credits)), Date.now(), quota.ledgerId, jobId]
      )
    ).rows[0] as Job | undefined;
    if (!activated) throw new Error("charged job activation lost draft state");
    await client.query("COMMIT");
    return { ...quota, job: activated };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteDraftJob(id: string): Promise<void> {
  await run("DELETE FROM jobs WHERE id=$1 AND status='draft'", [id]);
}

export async function cleanupStaleDraftJobs(olderThanMs = 60 * 60_000): Promise<number> {
  return run("DELETE FROM jobs WHERE status='draft' AND created_at < $1", [Date.now() - olderThanMs]);
}

/** 入队后、worker 启动前写入本次明确展示给用户的预留积分。 */
export async function setJobReservedCredits(id: string, credits: number): Promise<void> {
  await run("UPDATE jobs SET credits_reserved = $1 WHERE id = $2", [
    Math.max(0, Math.round(credits)),
    id,
  ]);
}

export async function getJob(id: string): Promise<Job | undefined> {
  return get<Job>("SELECT * FROM jobs WHERE id = $1", [id]);
}

export async function getJobByIdempotency(userId: string, key: string): Promise<Job | undefined> {
  return get<Job>(
    "SELECT * FROM jobs WHERE user_id=$1 AND idempotency_key=$2 ORDER BY created_at DESC LIMIT 1",
    [userId, key]
  );
}

export async function listActiveJobs(notebookId: string): Promise<Job[]> {
  return all<Job>(
    "SELECT * FROM jobs WHERE notebook_id = $1 AND status IN ('queued','running') ORDER BY created_at ASC",
    [notebookId]
  );
}

export type FailedCadJobSummary = Pick<
  Job,
  "id" | "kind" | "status" | "progress" | "error" | "credits_reserved" | "created_at" | "updated_at"
> & {
  failure_code: string | null;
  failure_stage: string | null;
  refund_state: "done" | "pending" | "processing" | "not_applicable";
};

/** 旧版失败卡兼容查询；现行用户 Studio API 不调用，后台直接从 jobs 审计。 */
export async function listFailedCadJobs(notebookId: string, limit = 5): Promise<FailedCadJobSummary[]> {
  return all<FailedCadJobSummary>(
    `SELECT j.id,j.kind,j.status,j.progress,j.error,j.credits_reserved,j.created_at,j.updated_at,
            NULLIF(COALESCE(NULLIF(j.params,''),'{}')::jsonb->>'cadFailureCode','') AS failure_code,
            NULLIF(COALESCE(NULLIF(j.params,''),'{}')::jsonb->>'cadFailureStage','') AS failure_stage,
            COALESCE(refund.state, CASE WHEN j.credits_reserved > 0 THEN 'pending' ELSE 'not_applicable' END) AS refund_state
       FROM jobs j
       LEFT JOIN LATERAL (
         SELECT state FROM credit_refund_outbox WHERE job_id=j.id ORDER BY created_at DESC LIMIT 1
       ) refund ON TRUE
      WHERE j.notebook_id=$1 AND j.kind='cad' AND j.status='error'
        AND COALESCE((COALESCE(NULLIF(j.params,''),'{}')::jsonb->>'__dismissed')::boolean,false)=false
      ORDER BY j.updated_at DESC LIMIT $2`,
    [notebookId, Math.max(1, Math.min(20, Math.trunc(limit)))]
  );
}

/** 用户“删除记录”只做软隐藏，保留计量、积分退回与审计链。 */
export async function dismissFailedJob(id: string, userId: string): Promise<boolean> {
  return (await run(
    `UPDATE jobs SET params=(COALESCE(NULLIF(params,''),'{}')::jsonb || '{"__dismissed":true}'::jsonb)::text,
                     updated_at=$1
      WHERE id=$2 AND user_id=$3 AND kind='cad' AND status='error'`,
    [Date.now(), id, userId]
  )) === 1;
}

/** M9:统计某用户在途(排队 / 运行中)任务数,用于入队前的并发上限。 */
export async function countActiveJobsByUser(userId: string): Promise<number> {
  return Number(
    (
      await get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM jobs WHERE user_id = $1 AND status IN ('queued','running')",
        [userId]
      )
    )?.n ?? 0
  );
}

/** 仅当前 running 代次可写进度/终态；空 fields 也会原子校验并刷新心跳。 */
export async function updateJobForRun(
  id: string,
  expectedAttempt: number,
  fields: {
    status?: JobStatus;
    progress?: number;
    output_id?: string | null;
    error?: string | null;
    stage?: string | null;
    stage_started_at?: number;
  }
): Promise<boolean> {
  const args: unknown[] = [id, expectedAttempt, Date.now()];
  const sets = ["updated_at = $3"];
  const add = (column: string, value: unknown) => {
    args.push(value);
    sets.push(`${column} = $${args.length}`);
  };
  if (fields.status !== undefined) add("status", fields.status);
  if (fields.progress !== undefined) add("progress", fields.progress);
  if (fields.output_id !== undefined) add("output_id", fields.output_id);
  if (fields.error !== undefined) add("error", fields.error);
  if (fields.stage !== undefined) add("stage", fields.stage);
  if (fields.stage_started_at !== undefined) add("stage_started_at", fields.stage_started_at);
  return (
    (await run(
      `UPDATE jobs SET ${sets.join(", ")}
         WHERE id = $1 AND run_attempt = $2 AND status = 'running'`,
      args
    )) === 1
  );
}

async function terminalJobWithRefund(opts: {
  id: string;
  status: "error" | "canceled";
  error?: string | null;
  expectedAttempt?: number;
  staleBefore?: number;
  failure?: { code?: string; stage?: string };
}): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const job = (
      await client.query("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [opts.id])
    ).rows[0] as Job | undefined;
    if (!job || !["queued", "running"].includes(job.status)) {
      await client.query("ROLLBACK");
      return false;
    }
    if (opts.expectedAttempt != null && Number(job.run_attempt) !== opts.expectedAttempt) {
      await client.query("ROLLBACK");
      return false;
    }
    if (opts.staleBefore != null && Number(job.updated_at) >= opts.staleBefore) {
      await client.query("ROLLBACK");
      return false;
    }
    const finishedAt = Date.now();
    await client.query(
      `UPDATE jobs SET status=$1,error=$2,updated_at=$3,
         finished_at=$3,
         stage=COALESCE($6::text,stage),
         stage_started_at=CASE
           WHEN $6::text IS NOT NULL AND stage IS DISTINCT FROM $6::text THEN $3
           ELSE stage_started_at
         END,
         params=(COALESCE(NULLIF(params,''),'{}')::jsonb ||
           CASE WHEN $5::text IS NULL AND $6::text IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('cadFailureCode',$5::text,'cadFailureStage',$6::text) END)::text
       WHERE id=$4`,
      [opts.status, opts.error ?? job.error, finishedAt, opts.id, opts.failure?.code ?? null, opts.failure?.stage ?? null]
    );
    const ledgerId = creditLedgerIdFromParams(job.params);
    const reserved = Math.max(0, Number(job.credits_reserved ?? 0));
    if (job.user_id && ledgerId && reserved > 0) {
      await client.query(
        `INSERT INTO credit_refund_outbox
           (ledger_id,job_id,user_id,op,credits,state,attempts,next_at,claimed_at,created_at)
         SELECT id,$1,user_id,op,credits,'pending',0,0,0,$2
           FROM credit_ledger
          WHERE id=$3 AND user_id=$4 AND op=$5 AND credits=$6
         ON CONFLICT(ledger_id) DO NOTHING`,
        [opts.id, Date.now(), ledgerId, job.user_id, `studio:${job.kind}`, reserved]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failJobAndQueueRefund(
  id: string,
  expectedAttempt: number,
  error: string,
  staleBefore?: number,
  failure?: { code?: string; stage?: string }
): Promise<boolean> {
  return terminalJobWithRefund({
    id,
    status: "error",
    error,
    expectedAttempt,
    staleBefore,
    failure,
  });
}

export async function cancelJobAndQueueRefund(id: string): Promise<boolean> {
  return terminalJobWithRefund({ id, status: "canceled" });
}

/** 持久积分退回 outbox：进程在终态提交后退出，下一次启动或周期扫描仍会继续处理。 */
export async function processCreditRefundOutbox(limit = 20): Promise<number> {
  const pool = getPool();
  const now = Date.now();
  await pool.query(
    `UPDATE credit_refund_outbox SET state='pending',next_at=$1
       WHERE state='processing' AND claimed_at < $2`,
    [now, now - 60_000]
  );
  let completed = 0;
  for (let i = 0; i < Math.max(1, limit); i++) {
    const client = await pool.connect();
    let row:
      | { ledger_id: number; user_id: string; op: string; credits: number; attempts: number }
      | undefined;
    try {
      await client.query("BEGIN");
      row = (
        await client.query(
          `SELECT ledger_id,user_id,op,credits,attempts FROM credit_refund_outbox
             WHERE state='pending' AND next_at <= $1
             ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`,
          [Date.now()]
        )
      ).rows[0];
      if (!row) {
        await client.query("COMMIT");
        break;
      }
      await client.query(
        `UPDATE credit_refund_outbox
            SET state='processing',claimed_at=$1,attempts=attempts+1
          WHERE ledger_id=$2`,
        [Date.now(), row.ledger_id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!row) break;
    try {
      const ok = await refundCreditsWithRetry(row.user_id, row.op, Number(row.credits), Number(row.ledger_id));
      if (!ok) throw new Error("refund ledger contract mismatch");
      await pool.query(
        "UPDATE credit_refund_outbox SET state='done',done_at=$1,last_error=NULL WHERE ledger_id=$2",
        [Date.now(), row.ledger_id]
      );
      completed++;
    } catch (error) {
      const attempts = Number(row.attempts ?? 0) + 1;
      const delay = Math.min(60 * 60_000, 5_000 * 2 ** Math.min(8, attempts));
      await pool.query(
        `UPDATE credit_refund_outbox
            SET state='pending',next_at=$1,last_error=$2
          WHERE ledger_id=$3`,
        [Date.now() + delay, String(error instanceof Error ? error.message : error).slice(0, 300), row.ledger_id]
      );
    }
  }
  return completed;
}

/** 用户主动取消任务:仅 queued/running 可取消。条件更新保证与 worker 收尾原子互斥 ——
 *  没改到行 = 任务已进入终态(done/error/canceled),由调用方按 409 处理。 */
/** worker 生成成功收尾:仅当任务【仍 running】才置 done(与 cancelJob 的条件更新原子互斥,
 *  兑现 cancelJob 注释承诺的契约）。返回 false = 期间已被取消并完成积分退回，
 *  调用方须撤销已落库的制品，否则会出现已退回积分但制品仍可见。 */
export type JobCreditSettlement = {
  userId: string;
  op: string;
  reservedCredits: number;
  finalCredits: number;
  tokensIn: number;
  tokensOut: number;
  notebookTitle?: string | null;
  ledgerId?: number;
};

/**
 * worker 成功收尾 + Token 结算必须在同一事务：
 * - 只有仍为 running 的任务能赢，与取消操作互斥；
 * - 最终价只会 ≤ 预留价，差额按原扣费口袋（奖励积分优先）原路退回；
 * - 状态、最终积分与 Token 同时可见，客户端不会先读到 done 再读到旧价格。
 */
export async function finalizeJobDone(
  id: string,
  outputId: string | null,
  billing: JobCreditSettlement | undefined,
  expectedAttempt: number
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const job = (
      await client.query("SELECT status, user_id, notebook_id, run_attempt FROM jobs WHERE id = $1 FOR UPDATE", [id])
    ).rows[0] as { status: string; user_id: string | null; notebook_id: string; run_attempt: number } | undefined;
    if (
      !job ||
      job.status !== "running" ||
      Number(job.run_attempt) !== expectedAttempt
    ) {
      await client.query("ROLLBACK");
      return false;
    }

    if (outputId) {
      const published = await client.query(
        `UPDATE studio_outputs SET status = 'ready'
           WHERE id = $1 AND job_id = $2 AND run_attempt = $3
             AND notebook_id = $4 AND status = 'processing'`,
        [outputId, id, expectedAttempt, job.notebook_id]
      );
      if (published.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
    }

    let finalCredits = 0;
    let reservedCredits = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    if (billing && job.user_id === billing.userId) {
      reservedCredits = Math.max(0, Math.round(billing.reservedCredits));
      finalCredits = Math.min(
        reservedCredits,
        Math.max(0, Math.round(billing.finalCredits))
      );
      tokensIn = Math.max(0, Math.round(billing.tokensIn));
      tokensOut = Math.max(0, Math.round(billing.tokensOut));

      const refund = reservedCredits - finalCredits;
      if (refund > 0 && reservedCredits > 0) {
        // 与 consumeDailyQuota 同一把用户行锁，避免差额退回与新扣减交错后余额失真。
        await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [billing.userId]);
        const charged = (
          await client.query(
            `SELECT id, ts, bonus, plan_credits, unlimited_at_charge FROM credit_ledger
               WHERE id = $1 AND user_id = $2 AND op = $3 AND credits = $4 AND refunded = 0
               FOR UPDATE`,
            [billing.ledgerId ?? 0, billing.userId, billing.op, reservedCredits]
          )
        ).rows[0] as {
          id: number;
          ts: number;
          bonus: number;
          plan_credits: number | null;
          unlimited_at_charge: number;
        } | undefined;

        if (charged) {
          // 套餐桶先扣、奖励桶后扣；缩价时逆序先退奖励，再退套餐。
          const originallyBonus = Math.max(0, Number(charged.bonus ?? 0));
          const originallyPlan = charged.plan_credits == null
            ? Math.max(0, reservedCredits - originallyBonus)
            : Math.max(0, Number(charged.plan_credits));
          const refundBonus = Math.min(refund, originallyBonus);
          const refundPlan = Math.min(Math.max(0, refund - refundBonus), originallyPlan);
          const wasUnlimited = Number(charged.unlimited_at_charge ?? 0) === 1;
          const usageRefund = charged.plan_credits == null
            ? Math.max(0, refund - refundBonus)
            : refundPlan;
          const settledAt = Date.now();
          const chargedDay = usageDay(Number(charged.ts));
          const settleDay = usageDay(settledAt);
          const crossDayPlanCompensation = !wasUnlimited && chargedDay < settleDay ? refundPlan : 0;
          const persistentBonusRefund = refundBonus + crossDayPlanCompensation;
          const refundedPlanCredits = wasUnlimited || chargedDay >= settleDay ? -refundPlan : 0;
          if (persistentBonusRefund > 0) {
            await client.query(
              "UPDATE users SET bonus_credits = bonus_credits + $1 WHERE id = $2",
              [persistentBonusRefund, billing.userId]
            );
          }
          if (usageRefund > 0) {
            await client.query(
              "UPDATE user_usage SET count = GREATEST(0, count - $1) WHERE user_id = $2 AND day = $3",
              [usageRefund, billing.userId, chargedDay]
            );
          }
          await client.query(
            `INSERT INTO credit_ledger (user_id, op, credits, bonus, plan_credits, ts, note)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              billing.userId,
              `settle:${billing.op}`,
              -refund,
              -persistentBonusRefund,
              refundedPlanCredits,
              settledAt,
              `${crossDayPlanCompensation > 0 ? `跨日补偿 ${crossDayPlanCompensation} · ` : ""}实际 Token ${tokensIn + tokensOut}（输入 ${tokensIn} / 输出 ${tokensOut}）${billing.notebookTitle ? ` · ${billing.notebookTitle}` : ""}`.slice(0, 120),
            ]
          );
        } else {
          // 找不到原扣减就不能凭空退回；保守按预留权重落账并留下可观测结果。
          finalCredits = reservedCredits;
        }
      }
    }

    const finishedAt = Date.now();
    await client.query(
      `UPDATE jobs SET status = 'done', progress = 100, output_id = $1, updated_at = $2,
         finished_at = $2, stage = CASE WHEN kind='cad' THEN 'completed' ELSE stage END,
         stage_started_at = CASE WHEN kind='cad' THEN $2 ELSE stage_started_at END,
         credits_reserved = $3, credits_final = $4, tokens_in = $5, tokens_out = $6
       WHERE id = $7 AND status = 'running' AND run_attempt = $8`,
      [outputId, finishedAt, reservedCredits, finalCredits, tokensIn, tokensOut, id, expectedAttempt]
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ---- 通知 / 消息中心 ----------------------------------------------------------

/** 写一条通知。绝不因写通知失败而拖垮触发它的业务流程。 */
export async function createNotification(n: {
  userId: string;
  type: string;
  title: string;
  summary?: string | null;
  link?: string | null;
  /** R1:显式确定性 id + ON CONFLICT DO NOTHING = 通知幂等。feed fan-out 用
   *  feednotif-<notebookId>-<userId>-<yyyymmdd>:按日合并语义内建于 id(替代
   *  hasFeedNotifToday 的 check-then-act),且 fan-out 半途崩溃后重试跑会补发
   *  未发的订阅者、绝不重发已发的(根治「简报已写、通知半发」的裂缝)。 */
  id?: string;
}): Promise<void> {
  try {
    await run(
      `INSERT INTO notifications (id, user_id, type, title, summary, link, read, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
         ON CONFLICT (id) DO NOTHING`,
      [
        n.id ?? uid(),
        n.userId,
        n.type,
        n.title.slice(0, 200),
        n.summary?.slice(0, 300) ?? null,
        n.link ?? null,
        Date.now(),
      ]
    );
  } catch {
    /* ignore */
  }
}

export async function listNotifications(userId: string, limit = 30): Promise<Notification[]> {
  return all<Notification>(
    "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, Math.min(limit, 100)]
  );
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  return Number(
    (
      await get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND read = 0",
        [userId]
      )
    )?.n ?? 0
  );
}

/** 标记已读:传 ids 标记指定几条,不传则把该用户全部未读标记已读。返回受影响行数。 */
export async function markNotificationsRead(userId: string, ids?: string[]): Promise<number> {
  if (ids && ids.length) {
    // $1=userId,id 列表从 $2 起递增。
    const ph = ids.map((_, i) => `$${i + 2}`).join(",");
    return run(`UPDATE notifications SET read = 1 WHERE user_id = $1 AND id IN (${ph})`, [
      userId,
      ...ids,
    ]);
  }
  return run("UPDATE notifications SET read = 1 WHERE user_id = $1 AND read = 0", [userId]);
}

/** 审查修复(启动恢复):进程重启后遗留的 running 任务永久僵死。启动时把它们置为 error,
 *  并报告是否有 queued 待消费。供测试与运维手动恢复。 */
export async function recoverStaleJobsInDb(): Promise<{ failed: number; requeued: number; queued: number }> {
  // DB 级互斥:60s 内全进程/全实例只允许跑一次启动恢复。dev(Turbopack)会给每个
  // server bundle 实例隔离 globalThis 甚至 process 对象,内存旗标跨实例全不可靠;
  // 多实例各自 boot 时若都跑恢复,会把彼此正在跑的任务反复重排队直至耗尽重试次数
  // (复测实锤)。数据库是唯一共享真相 —— 原子抢租约,没抢到的直接跳过。
  const now = Date.now();
  await run(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('jobs.last_recover', '0', $1) ON CONFLICT (key) DO NOTHING",
    [now]
  );
  const lease = await run(
    "UPDATE app_settings SET value = $1, updated_at = $2 WHERE key = 'jobs.last_recover' AND value::bigint < $3",
    [String(now), now, now - 60_000]
  );
  if (lease === 0) {
    const queuedNow = Number(
      (await get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'"))?.n ?? 0
    );
    return { failed: 0, requeued: 0, queued: queuedNow };
  }
  // 重启后遗留的 running 都是死孤儿(worker 随进程一起没了)。优先重新排队续跑
  // (deploy/重启不再制造成片「生成失败」),重试次数用尽的才置 error + 退分。
  // ⚠️ 只碰「心跳已停 ≥90s」的:活任务每 800ms 刷 updated_at,心跳新鲜 = 它的 worker
  // 还活着(Turbopack dev 下本模块会被多 bundle 实例重复加载、各自触发启动恢复,内存
  // 名册跨实例不可靠 —— 心跳新鲜度是唯一跨实例可信的活性凭据)。90s 而非 15s:dev 编译
  // 风暴会把事件环阻塞几十秒、心跳假死,15s 窗口仍会误碰活任务(复测实锤 att 被顶到 2);
  // 真重启孤儿最多晚 ~90s 被本恢复捡走,或由 240s 周期回收兜底 —— 宁慢勿误杀。
  const freshCutoff = Date.now() - 90_000;
  const victims = await all<{ id: string; user_id: string | null; kind: string; credits_reserved: number; params: string | null; run_attempt: number }>(
    "SELECT id, user_id, kind, credits_reserved, params, run_attempt FROM jobs WHERE status = 'running' AND updated_at < $1",
    [freshCutoff]
  );
  // 在跑名册保护:本实例正在跑的任务绝不当孤儿动它(对同实例重复调用兜底)。
  const inflight = (process as unknown as { __nbInflight?: Set<string> }).__nbInflight;
  let failed = 0;
  let requeued = 0;
  for (const v of victims) {
    if (inflight?.has(v.id)) continue;
    // cutoff 带进 UPDATE 原子复核:SELECT 后若任务恢复了心跳(活着),这里不会改到行。
    if (await requeueRunningJob(run, v.id, freshCutoff, Number(v.run_attempt))) {
      requeued += 1;
      continue;
    }
    const changed = await failJobAndQueueRefund(
      v.id,
      Number(v.run_attempt),
      "生成多次中断,已停止自动重试,请手动重新生成",
      freshCutoff
    );
    if (!changed) continue;
    failed += 1;
  }
  await processCreditRefundOutbox().catch(() => {});
  const queued = Number(
    (await get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'"))?.n ?? 0
  );
  return { failed, requeued, queued };
}

/** 排队中的任务数(启动兜底:jobs 模块加载时若有遗留 queued 则拉起 worker)。 */
export async function countQueuedJobs(): Promise<number> {
  return Number(
    (await get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'"))?.n ?? 0
  );
}

export type JobDurationStats = {
  count: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
};

export type CadJobObservabilitySummary = {
  since: number;
  generatedAt: number;
  total: number;
  byStatus: Partial<Record<JobStatus, number>>;
  byFailureCode: Record<string, number>;
  byLane: Record<string, number>;
  queueWaitMs: JobDurationStats;
  runDurationMs: JobDurationStats;
};

type DurationAggregateRow = {
  total: number;
  queue_count: number;
  queue_avg: number | null;
  queue_p50: number | null;
  queue_p95: number | null;
  queue_max: number | null;
  run_count: number;
  run_avg: number | null;
  run_p50: number | null;
  run_p95: number | null;
  run_max: number | null;
};

function durationStats(
  row: DurationAggregateRow,
  prefix: "queue" | "run"
): JobDurationStats {
  const numeric = (value: number | null): number | null => (
    value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value))
  );
  return {
    count: Math.max(0, Number(row[`${prefix}_count`] ?? 0)),
    avg: numeric(row[`${prefix}_avg`]),
    p50: numeric(row[`${prefix}_p50`]),
    p95: numeric(row[`${prefix}_p95`]),
    max: numeric(row[`${prefix}_max`]),
  };
}

/**
 * CAD 发布门禁的只读聚合面。
 *
 * started_at 固化首次认领，因此 queueWaitMs 是 created_at→首次开跑；
 * finished_at→started_at 是包含有界重试的总运行历时。旧任务的 0/null 不会
 * 被伪装成 0ms 样本，只计入状态总数和 unknown lane/失败码。
 */
export async function getCadJobObservabilitySummary(
  sinceMs = Date.now() - 24 * 60 * 60_000
): Promise<CadJobObservabilitySummary> {
  const since = Number.isFinite(sinceMs) ? Math.max(0, Math.trunc(sinceMs)) : 0;
  const [duration, statusRows, failureRows, laneRows] = await Promise.all([
    get<DurationAggregateRow>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE started_at > 0) AS queue_count,
              AVG(GREATEST(0,started_at-created_at)) FILTER (WHERE started_at > 0) AS queue_avg,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY GREATEST(0,started_at-created_at))
                FILTER (WHERE started_at > 0) AS queue_p50,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY GREATEST(0,started_at-created_at))
                FILTER (WHERE started_at > 0) AS queue_p95,
              MAX(GREATEST(0,started_at-created_at)) FILTER (WHERE started_at > 0) AS queue_max,
              COUNT(*) FILTER (WHERE started_at > 0 AND finished_at >= started_at) AS run_count,
              AVG(GREATEST(0,finished_at-started_at))
                FILTER (WHERE started_at > 0 AND finished_at >= started_at) AS run_avg,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY GREATEST(0,finished_at-started_at))
                FILTER (WHERE started_at > 0 AND finished_at >= started_at) AS run_p50,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY GREATEST(0,finished_at-started_at))
                FILTER (WHERE started_at > 0 AND finished_at >= started_at) AS run_p95,
              MAX(GREATEST(0,finished_at-started_at))
                FILTER (WHERE started_at > 0 AND finished_at >= started_at) AS run_max
         FROM jobs WHERE kind='cad' AND created_at >= $1`,
      [since]
    ),
    all<{ status: JobStatus; n: number }>(
      "SELECT status,COUNT(*) AS n FROM jobs WHERE kind='cad' AND created_at >= $1 GROUP BY status",
      [since]
    ),
    all<{ code: string; n: number }>(
      `SELECT COALESCE(NULLIF(COALESCE(NULLIF(params,''),'{}')::jsonb->>'cadFailureCode',''),'unknown') AS code,
              COUNT(*) AS n
         FROM jobs
        WHERE kind='cad' AND status='error' AND created_at >= $1
        GROUP BY 1`,
      [since]
    ),
    all<{ lane: string; n: number }>(
      "SELECT COALESCE(lane,'unknown') AS lane,COUNT(*) AS n FROM jobs WHERE kind='cad' AND created_at >= $1 GROUP BY 1",
      [since]
    ),
  ]);
  const base: DurationAggregateRow = duration ?? {
    total: 0,
    queue_count: 0,
    queue_avg: null,
    queue_p50: null,
    queue_p95: null,
    queue_max: null,
    run_count: 0,
    run_avg: null,
    run_p50: null,
    run_p95: null,
    run_max: null,
  };
  return {
    since,
    generatedAt: Date.now(),
    total: Math.max(0, Number(base.total ?? 0)),
    byStatus: Object.fromEntries(statusRows.map((row) => [row.status, Math.max(0, Number(row.n ?? 0))])),
    byFailureCode: Object.fromEntries(failureRows.map((row) => [row.code, Math.max(0, Number(row.n ?? 0))])),
    byLane: Object.fromEntries(laneRows.map((row) => [row.lane, Math.max(0, Number(row.n ?? 0))])),
    queueWaitMs: durationStats(base, "queue"),
    runDurationMs: durationStats(base, "run"),
  };
}

/** Atomically take the highest-priority queued job (created_at tiebreak) and mark it running.
 *  priority DESC 让高优先级权益任务排在基础任务之前；created_at ASC 兜底，同优先级按到达顺序。
 *  PG 并发命门:FOR UPDATE SKIP LOCKED 在事务内锁住选中的行,并让并发 worker 跳过已锁行,
 *  杜绝两个 worker 抢到同一任务(SQLite 单写者天然互斥,PG 多连接必须显式行锁)。 */
export type JobQueueLane = "any" | JobLane;

export async function claimNextQueued(lane: JobQueueLane = "any"): Promise<Job | undefined> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const lanePredicate = lane === "cad"
      ? "AND kind = 'cad'"
      : lane === "non_cad"
        ? "AND kind <> 'cad'"
        : "";
    const row = (
      await client.query(
        `SELECT * FROM jobs WHERE status = 'queued' ${lanePredicate}
         ORDER BY priority DESC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`
      )
    ).rows[0] as Job | undefined;
    if (!row) {
      await client.query("COMMIT");
      return undefined;
    }
    const claimedAt = Date.now();
    const claimedLane: JobLane = row.kind === "cad" ? "cad" : "non_cad";
    const claimed = (
      await client.query(
        `UPDATE jobs SET status = 'running', run_attempt = run_attempt + 1, updated_at = $1,
                         lane = $3,
                         started_at = CASE WHEN started_at > 0 THEN started_at ELSE $1 END,
                         finished_at = 0,
                         stage = CASE WHEN kind='cad' THEN 'starting' ELSE NULL END,
                         stage_started_at = CASE WHEN kind='cad' THEN $1 ELSE 0 END
           WHERE id = $2 AND status = 'queued' RETURNING *`,
        [claimedAt, row.id, claimedLane]
      )
    ).rows[0] as Job | undefined;
    if (!claimed) {
      await client.query("ROLLBACK");
      return undefined;
    }
    await client.query("COMMIT");
    return claimed;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getNotebookAccess(
  notebookId: string,
  userId: string
): Promise<NotebookRole | null> {
  const nb = await get<{ user_id?: string }>("SELECT user_id FROM notebooks WHERE id = $1", [
    notebookId,
  ]);
  if (!nb) return null;
  if (nb.user_id === userId) return "owner";
  const col = await get<{ role?: string }>(
    "SELECT role FROM notebook_collaborators WHERE notebook_id = $1 AND user_id = $2",
    [notebookId, userId]
  );
  if (col?.role === "editor") return "editor";
  if (col?.role) return "viewer";
  return null;
}

export type Collaborator = {
  id: string;
  name: string;
  avatar: string | null;
  phone: string | null;
  email: string | null;
  role: string;
};

export async function addCollaborator(
  notebookId: string,
  userId: string,
  role: "viewer" | "editor"
): Promise<void> {
  await run(
    "INSERT INTO notebook_collaborators (notebook_id, user_id, role, created_at) VALUES ($1, $2, $3, $4) " +
      "ON CONFLICT (notebook_id, user_id) DO UPDATE SET role = excluded.role, created_at = excluded.created_at",
    [notebookId, userId, role, Date.now()]
  );
}

export async function removeCollaborator(notebookId: string, userId: string): Promise<void> {
  await run("DELETE FROM notebook_collaborators WHERE notebook_id = $1 AND user_id = $2", [
    notebookId,
    userId,
  ]);
}

export async function listCollaborators(notebookId: string): Promise<Collaborator[]> {
  return all<Collaborator>(
    `SELECT u.id, u.name, u.avatar, u.phone, u.email, c.role
       FROM notebook_collaborators c JOIN users u ON u.id = c.user_id
       WHERE c.notebook_id = $1 ORDER BY c.created_at ASC`,
    [notebookId]
  );
}

export async function notebookHasCollaborators(notebookId: string): Promise<boolean> {
  return !!(await get<{ present: number }>(
    "SELECT 1 AS present FROM notebook_collaborators WHERE notebook_id=$1 LIMIT 1",
    [notebookId]
  ));
}

// ---------------------------------------------------------------------------
// 后台管理:全局 KV 配置 + AI 调用日志
// ---------------------------------------------------------------------------

export async function getSetting(key: string): Promise<string | null> {
  const row = await get<{ value: string }>("SELECT value FROM app_settings WHERE key = $1", [key]);
  return row?.value ?? null;
}

export type UserModelConfigRow = {
  user_id: string;
  provider_id: string;
  chat_model: string;
  vision_model: string;
  research_model: string;
  key_ciphertext: string;
  key_iv: string;
  key_tag: string;
  key_id: string;
  key_hint: string;
  enabled: number;
  revision: number;
  tested_revision: number;
  last_tested_at: number;
  last_test_status: string;
  created_at: number;
  updated_at: number;
};

/** 用户个人模型配置只允许通过这组 user-scoped 函数读写，管理员设置面不可见。 */
export async function getUserModelConfig(userId: string): Promise<UserModelConfigRow | undefined> {
  return get<UserModelConfigRow>("SELECT * FROM user_model_configs WHERE user_id=$1", [userId]);
}

/**
 * 乐观 CAS 换版。密文的 AAD 含 revision，因此调用方先按 expectedRevision 生成下一版
 * 密文；并发冲突返回 undefined，由调用方重新读取、重新加密后重试。
 */
export async function compareAndSwapUserModelConfig(args: {
  userId: string;
  expectedRevision: number;
  providerId: string;
  chatModel: string;
  visionModel: string;
  researchModel: string;
  keyCiphertext: string;
  keyIv: string;
  keyTag: string;
  keyId: string;
  keyHint: string;
}): Promise<UserModelConfigRow | undefined> {
  const now = Date.now();
  const nextRevision = args.expectedRevision + 1;
  if (args.expectedRevision === 0) {
    return (
      await query<UserModelConfigRow>(
        `INSERT INTO user_model_configs
           (user_id,provider_id,chat_model,vision_model,research_model,key_ciphertext,key_iv,key_tag,key_id,key_hint,
            enabled,revision,tested_revision,last_tested_at,last_test_status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,0,0,'untested',$12,$12)
         ON CONFLICT(user_id) DO NOTHING
         RETURNING *`,
        [
          args.userId,
          args.providerId,
          args.chatModel,
          args.visionModel,
          args.researchModel,
          args.keyCiphertext,
          args.keyIv,
          args.keyTag,
          args.keyId,
          args.keyHint,
          nextRevision,
          now,
        ]
      )
    ).rows[0];
  }
  return (
    await query<UserModelConfigRow>(
      `UPDATE user_model_configs SET
         provider_id=$3,chat_model=$4,vision_model=$5,research_model=$6,key_ciphertext=$7,key_iv=$8,key_tag=$9,
         key_id=$10,key_hint=$11,enabled=0,revision=$12,tested_revision=0,last_tested_at=0,
         last_test_status='untested',updated_at=$13
       WHERE user_id=$1 AND revision=$2
       RETURNING *`,
      [
        args.userId,
        args.expectedRevision,
        args.providerId,
        args.chatModel,
        args.visionModel,
        args.researchModel,
        args.keyCiphertext,
        args.keyIv,
        args.keyTag,
        args.keyId,
        args.keyHint,
        nextRevision,
        now,
      ]
    )
  ).rows[0];
}

export async function setUserModelConfigTestResult(
  userId: string,
  revision: number,
  ok: boolean,
  status: string
): Promise<UserModelConfigRow | undefined> {
  const safeStatus = /^[a-z_]{1,40}$/.test(status) ? status : "request_failed";
  return (
    await query<UserModelConfigRow>(
      `UPDATE user_model_configs SET
         enabled=$3::bigint,tested_revision=CASE WHEN $3::bigint=1 THEN revision ELSE 0 END,
         last_tested_at=$4,last_test_status=$5,updated_at=$4
       WHERE user_id=$1 AND revision=$2 AND last_test_status='testing'
       RETURNING *`,
      [userId, revision, ok ? 1 : 0, Date.now(), safeStatus]
    )
  ).rows[0];
}

/** 跨实例单飞认领连接测试；disabled 表示用户明确停用，迟到测试不得重新开启。 */
export async function claimUserModelConfigTest(
  userId: string,
  revision: number
): Promise<UserModelConfigRow | undefined> {
  return (
    await query<UserModelConfigRow>(
      `UPDATE user_model_configs SET last_test_status='testing',updated_at=$3
       WHERE user_id=$1 AND revision=$2 AND last_test_status NOT IN ('testing','disabled')
       RETURNING *`,
      [userId, revision, Date.now()]
    )
  ).rows[0];
}

export async function disableUserModelConfig(userId: string): Promise<boolean> {
  return (
    await run(
      "UPDATE user_model_configs SET enabled=0,last_test_status='disabled',updated_at=$2 WHERE user_id=$1",
      [userId, Date.now()]
    )
  ) === 1;
}

export async function deleteUserModelConfig(userId: string): Promise<boolean> {
  return (await run("DELETE FROM user_model_configs WHERE user_id=$1", [userId])) === 1;
}

export async function getSettingsByPrefix(prefix: string): Promise<Record<string, string>> {
  const rows = await all<{ key: string; value: string }>(
    "SELECT key, value FROM app_settings WHERE key LIKE $1",
    [prefix + "%"]
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(key: string, value: string, updatedBy?: string): Promise<void> {
  await run(
    "INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2, $3, $4) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    [key, value, Date.now(), updatedBy ?? null]
  );
}

export async function deleteSetting(key: string): Promise<void> {
  await run("DELETE FROM app_settings WHERE key = $1", [key]);
}

// ---------------------------------------------------------------------------
// 用户反馈(设置内提交 → 后台处理)
// ---------------------------------------------------------------------------

export type Feedback = {
  id: string;
  user_id: string | null;
  user_name: string | null;
  category: string;
  content: string;
  contact: string | null;
  images: string | null; // JSON 数组(data URL)
  status: string;
  created_at: number;
  handled_at: number | null;
  handled_by: string | null;
};

export async function createFeedback(f: {
  userId?: string | null;
  userName?: string | null;
  category?: string;
  content: string;
  contact?: string | null;
  images?: string[];
}): Promise<Feedback> {
  const id = "fb_" + Math.random().toString(36).slice(2, 11);
  const now = Date.now();
  const images = f.images && f.images.length ? JSON.stringify(f.images) : null;
  await run(
    `INSERT INTO feedback (id, user_id, user_name, category, content, contact, images, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8)`,
    [id, f.userId ?? null, f.userName ?? null, f.category ?? "other", f.content, f.contact ?? null, images, now]
  );
  return (await get<Feedback>("SELECT * FROM feedback WHERE id = $1", [id])) as Feedback;
}

export async function listFeedback(
  opts: { status?: string; limit?: number; offset?: number } = {}
): Promise<{ rows: Feedback[]; total: number }> {
  const filtered = opts.status && opts.status !== "all";
  const where = filtered ? "WHERE status = $1" : "";
  const total = Number(
    (
      await get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM feedback ${where}`,
        filtered ? [opts.status] : []
      )
    )?.n ?? 0
  );
  // 分页参数在 status 之后接续编号(有 status 时从 $2 起,否则从 $1 起)。
  const base = filtered ? 1 : 0;
  const rows = await all<Feedback>(
    `SELECT * FROM feedback ${where} ORDER BY created_at DESC LIMIT $${base + 1} OFFSET $${base + 2}`,
    filtered
      ? [opts.status, opts.limit ?? 50, opts.offset ?? 0]
      : [opts.limit ?? 50, opts.offset ?? 0]
  );
  return { rows, total };
}

export async function countOpenFeedback(): Promise<number> {
  return Number(
    (await get<{ n: number }>("SELECT COUNT(*) AS n FROM feedback WHERE status = 'open'"))?.n ?? 0
  );
}

export async function setFeedbackStatus(id: string, status: string, adminId: string): Promise<boolean> {
  const changed = await run(
    "UPDATE feedback SET status = $1, handled_at = $2, handled_by = $3 WHERE id = $4",
    [status, status === "resolved" ? Date.now() : null, status === "resolved" ? adminId : null, id]
  );
  return changed > 0;
}

export type AiCall = {
  id: number;
  ts: number;
  provider: string;
  model: string;
  ms: number;
  ok: number;
  status: number | null;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_micros: number;
};

export async function logAiCall(
  c: Omit<AiCall, "id" | "tokens_in" | "tokens_out" | "cost_micros"> & {
    tokensIn?: number;
    tokensOut?: number;
  }
): Promise<void> {
  try {
    const tin = Math.max(0, Math.round(c.tokensIn ?? 0));
    const tout = Math.max(0, Math.round(c.tokensOut ?? 0));
    // 个人自带密钥的调用不计入平台供应商成本；Token 仍进入独立 byok:* 用量通道。
    const costMicros = c.ok && !c.provider.startsWith("byok:")
      ? Math.max(0, Math.round(callCostCNY(c.model, tin, tout) * 1_000_000))
      : 0;
    // BIGSERIAL id,INSERT 不传 id 列。
    await run(
      "INSERT INTO ai_calls (ts, provider, model, ms, ok, status, error, tokens_in, tokens_out, cost_micros) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [c.ts, c.provider, c.model, c.ms, c.ok, c.status, c.error, tin, tout, costMicros]
    );
    // 长期用量汇总:按 UTC 天 + 通道累加(供月度配额/预警;不随 ai_calls 7 天清理而丢失)。
    const day = Math.floor(c.ts / 86400_000);
    await run(
      `INSERT INTO usage_daily (day, provider, tokens_in, tokens_out, calls) VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT(day, provider) DO UPDATE SET
           tokens_in = usage_daily.tokens_in + excluded.tokens_in,
           tokens_out = usage_daily.tokens_out + excluded.tokens_out,
           calls = usage_daily.calls + 1`,
      [day, c.provider, tin, tout]
    );
    // 低频清理 7 天前的「明细」日志(汇总表 usage_daily 不动,~2% 概率触发)。
    if (Math.random() < 0.02) {
      await run("DELETE FROM ai_calls WHERE ts < $1", [Date.now() - 7 * 86400_000]);
      // usage_daily 保留约 13 个月,够月度配额与同比。
      await run("DELETE FROM usage_daily WHERE day < $1", [day - 400]);
    }
  } catch {
    /* 日志失败不影响主链路 */
  }
}

/** 用量汇总:近 N 天(默认 30)按通道的 token / 调用数,用于月度配额与预警。 */
export async function getUsageStats(days = 30): Promise<{
  days: number;
  since: number;
  byProvider: Record<string, { tokensIn: number; tokensOut: number; tokens: number; calls: number }>;
  totalTokens: number;
}> {
  const sinceDay = Math.floor(Date.now() / 86400_000) - (days - 1);
  const rows = await all<{ provider: string; ti: number; to_: number; c: number }>(
    "SELECT provider, SUM(tokens_in) ti, SUM(tokens_out) to_, SUM(calls) c FROM usage_daily WHERE day >= $1 GROUP BY provider",
    [sinceDay]
  );
  const byProvider: Record<string, { tokensIn: number; tokensOut: number; tokens: number; calls: number }> = {};
  let totalTokens = 0;
  for (const r of rows) {
    const ti = Number(r.ti ?? 0);
    const to = Number(r.to_ ?? 0);
    byProvider[r.provider] = { tokensIn: ti, tokensOut: to, tokens: ti + to, calls: Number(r.c ?? 0) };
    totalTokens += ti + to;
  }
  return { days, since: sinceDay * 86400_000, byProvider, totalTokens };
}

export async function listAiCalls(opts: {
  limit?: number;
  provider?: string;
  okOnly?: "ok" | "err";
}): Promise<AiCall[]> {
  const cond: string[] = [];
  const args: unknown[] = [];
  if (opts.provider) {
    args.push(opts.provider);
    cond.push(`provider = $${args.length}`);
  }
  if (opts.okOnly === "ok") cond.push("ok = 1");
  if (opts.okOnly === "err") cond.push("ok = 0");
  const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
  args.push(Math.min(opts.limit ?? 100, 500));
  return all<AiCall>(`SELECT * FROM ai_calls ${where} ORDER BY ts DESC LIMIT $${args.length}`, args);
}

/** 近 N 小时按小时聚合调用量 / 失败量。可选按通道 / 结果过滤(与调用日志筛选联动)。 */
export async function aiCallSeries(
  hours = 24,
  opts: { provider?: string; okOnly?: "ok" | "err" } = {}
): Promise<{ hour: number; total: number; errors: number }[]> {
  const since = Date.now() - hours * 3600_000;
  const args: unknown[] = [since];
  const cond = ["ts >= $1"];
  if (opts.provider) {
    args.push(opts.provider);
    cond.push(`provider = $${args.length}`);
  }
  if (opts.okOnly === "ok") cond.push("ok = 1");
  else if (opts.okOnly === "err") cond.push("ok = 0");
  const rows = await all<{ ts: number; ok: number }>(
    `SELECT ts, ok FROM ai_calls WHERE ${cond.join(" AND ")} ORDER BY ts ASC`,
    args
  );
  const buckets = new Map<number, { total: number; errors: number }>();
  for (const r of rows) {
    const hour = Math.floor(r.ts / 3600_000);
    const b = buckets.get(hour) ?? { total: 0, errors: 0 };
    b.total++;
    if (!r.ok) b.errors++;
    buckets.set(hour, b);
  }
  const out: { hour: number; total: number; errors: number }[] = [];
  const now = Math.floor(Date.now() / 3600_000);
  for (let h = now - hours + 1; h <= now; h++) {
    const b = buckets.get(h);
    out.push({ hour: h, total: b?.total ?? 0, errors: b?.errors ?? 0 });
  }
  return out;
}
