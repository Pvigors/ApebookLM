import { getPool } from "@/lib/pg";
import { creditConsumptionByDaySince } from "@/lib/db";
import type { AdminModule } from "@/lib/admin";

/**
 * 后台数据工作台的指标层。
 *
 * 为什么要单独一层:原来的 app/api/admin/analytics/route.ts 是一次性把七段固定报表
 * 全查出来返回,前端只能整块用。工作台要的是「指标自由组合」——用户拖哪个就查哪个,
 * 时间范围和拆分维度还要能变。所以把每个指标抽成独立算子,由路由按需调度。
 *
 * 三条贯穿全文件的约定:
 *
 * 1. **一律东八区日切**。全站(analytics、用户侧每日额度、credit_ledger)都按北京时间
 *    切天,这里必须跟上,否则同一张画布上的两条线会错开一天,而且新旧报表对不上账。
 * 2. **返回定长数组**。缺失的日子补 0(计数型)或 null(比率型) —— 前端画图不必再处理空洞。
 *    比率型用 null 而不是 0,是因为「当天没有样本」和「当天命中率为 0」是两回事,
 *    画成 0 会凭空多出一个断崖。
 * 3. **算不准就明说**。指标带 maxDays / note 声明自己的边界(比如成本只有 7 天原始数据),
 *    路由据此裁剪、前端据此禁用并解释原因。宁可不给数,也不给一个没法解释的数。
 */

/** 东八区偏移。与 lib/db.ts:2178 的 TZ_OFFSET_MS、analytics 路由的 TZ 是同一个值。 */
const TZ = 8 * 3600_000;

/**
 * 活动日志的保留天数。超出这个范围,分子必然查不到,留存和日活会被画成
 * 实打实的 0 和 0.0% —— 那不是「那天没人活跃」,是「日志已经被删了」。
 * 两者在图上长得一模一样,所以依赖 activity_log 的指标一律以此为回看上限。
 */
const ACTIVITY_RETENTION_DAYS = 90;

/**
 * 一次取数最多同时压几条 SQL。全站共用一个 pg 池(max 默认 10),这里刻意留得很小:
 * 后台看报表慢几秒没人在意,把线上业务的连接抢光才是事故。
 */
const QUERY_CONCURRENCY = 3;

export type MetricGroup = "growth" | "content" | "usage" | "cost";

export type MetricId =
  | "dau" | "new" | "d1" | "d7"
  | "src" | "out" | "msg" | "cit"
  | "crd" | "cost";

/** 值的呈现方式,决定前端用什么格式化和什么图形。 */
export type MetricUnit = "count" | "percent" | "cny" | "credits";

export type MetricCtx = {
  /** 窗口首日的东八区日序号 */
  startIdx: number;
  /** 天数 */
  days: number;
  /** 窗口内每一天的日序号,定长 */
  dayIdxs: number[];
  /** 窗口起点对应的 UTC 毫秒(= startIdx 那天的北京 0 点) */
  sinceMs: number;
  /**
   * 当日模型成本(元)。只有当本次查询含成本类指标时才会加载。
   * 放在上下文里而不是模块级变量 —— 模块级会被并发请求共享,
   * 一个查 7 天、一个查 3 天就会互相读到对方的数据。
   */
  costByDay?: Map<number, number>;
  /** 成本预加载失败时的脱敏原因；只影响 cost，不得拖垮同请求其它指标。 */
  costUnavailable?: string;
};

export type MetricDef = {
  id: MetricId;
  label: string;
  group: MetricGroup;
  unit: MetricUnit;
  /** 一句话说明这个数到底算的是什么 —— 会显示在图表的信息浮层里,避免口径靠猜。 */
  desc: string;
  /** 能回看的最大天数。不设则不限。 */
  maxDays?: number;
  /** 该指标已知的口径局限,前端原样展示。没有局限就不写。 */
  caveat?: string;
  /**
   * 这个数归哪个后台模块管。不写则等同 analytics(普通分析数据,运营员可看)。
   * 用途是让权限跟着**数据敏感度**走而不是跟着页面走 —— 工作台是一个页面,
   * 但画布上可以放成本这类比普通分析更敏感的数。眼下 credits
   * 对运营员可读,所以标了也不会挡住谁;真正的价值是将来加 super-only
   * 的指标(比如模型单价、利润明细)时,不必再回头改路由就自动受控。
   */
  scope?: AdminModule;
  series(ctx: MetricCtx): Promise<(number | null)[]>;
};

// ─────────────────────────── 共用工具 ───────────────────────────

/** SQL 里的东八区日序号表达式。列名是内部常量拼接,不接受外部输入。 */
const dayOf = (col: string) => `CAST((${col} + ${TZ}) / 86400000 AS INTEGER)`;

/** 跑一条「按日分组」的查询,收成 日序号 → 值 的 Map。SQL 必须返回 day 与 n 两列。 */
async function byDay(sql: string, ...args: unknown[]): Promise<Map<number, number>> {
  const rows = (await getPool().query(sql, args)).rows as { day: number | string; n: number | string }[];
  return new Map(rows.map((r) => [Number(r.day), Number(r.n)]));
}

/**
 * 极简并发闸。**不能用裸 Promise.all 扇出所有指标** —— pg 的 Pool 是每条 query
 * 借一条连接,全站共用一个池且 max 默认只有 10(lib/pg.ts)。一次画布查 8 个指标
 * 就要占掉 8 条,两个管理员同时点就把池打满,之后所有请求(登录、对话、笔记本列表)
 * 都在 connect 上排队,10 秒后统一抛超时。一次后台取数足以把整个产品打挂,
 * 而且日志里看起来是「数据库连不上」,排查方向会被完全带偏。
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 把 Map 摊平成定长数组,缺的日子补 fallback。 */
function spread(ctx: MetricCtx, m: Map<number, number>, fallback: number | null = 0): (number | null)[] {
  return ctx.dayIdxs.map((d) => m.get(d) ?? fallback);
}

/** 计数型指标的通用实现:某张表按某个时间列逐日 COUNT。 */
function countBy(table: string, tsCol: string, extraWhere = ""): MetricDef["series"] {
  return async (ctx) =>
    spread(
      ctx,
      await byDay(
        `SELECT ${dayOf(tsCol)} AS day, COUNT(*) AS n FROM ${table}
         WHERE ${tsCol} >= $1 ${extraWhere} GROUP BY day`,
        ctx.sinceMs
      )
    );
}

// ─────────────────────────── 增长 ───────────────────────────

const dau: MetricDef = {
  id: "dau",
  label: "日活跃用户",
  group: "growth",
  unit: "count",
  desc: "当天在活动日志里有过任意行为的去重用户数(东八区自然日)。",
  maxDays: ACTIVITY_RETENTION_DAYS,
  caveat:
    "对话链路目前不写活动日志,只用对话的用户不会被计入,该值系统性偏低。补上对话埋点后此说明可移除。",
  series: async (ctx) =>
    spread(
      ctx,
      await byDay(
        `SELECT ${dayOf("ts")} AS day, COUNT(DISTINCT actor_id) AS n FROM activity_log
         WHERE ts >= $1 AND actor_kind = 'user' AND actor_id IS NOT NULL GROUP BY day`,
        ctx.sinceMs
      )
    ),
};

const newUsers: MetricDef = {
  id: "new",
  label: "新注册",
  group: "growth",
  unit: "count",
  desc: "当天创建的用户账号数。",
  series: countBy("users", "created_at"),
};

/**
 * 留存。与 analytics 路由那版的区别:那版把整个窗口的队列合并成**一个数**,
 * 工作台要画趋势线,所以改成按注册日分组、每个队列各算各的。
 *
 * 写法上刻意**不把 EXISTS 放进 SELECT 列表**。PostgreSQL 的 pull_up_sublinks 只把
 * WHERE / JOIN 条件里的 EXISTS 拍平成 semi-join;写在聚合表达式里(SUM((EXISTS ...)::int))
 * 就只能退化成相关 SubPlan,对 users 的每一行重放一次子查询,而「这人当天没活动」
 * 恰恰是最常见的分支 —— 每次都得把这个人的日志全扫完才能确定为假。
 * 改成两个 CTE 再 LEFT JOIN,活动那一支只扫一遍、能吃 idx_activity_ts 的范围扫。
 */
function retention(offset: number): MetricDef["series"] {
  return async (ctx) => {
    const rows = (
      await getPool().query(
        `WITH cohort AS (
           SELECT id, ${dayOf("created_at")} AS day FROM users WHERE created_at >= $1
         ), act AS (
           SELECT DISTINCT actor_id, ${dayOf("ts")} AS day FROM activity_log
           WHERE ts >= $1 AND actor_kind = 'user' AND actor_id IS NOT NULL
         )
         SELECT c.day AS day, COUNT(*) AS total, COUNT(a.actor_id) AS kept
         FROM cohort c LEFT JOIN act a ON a.actor_id = c.id AND a.day = c.day + ${offset}
         GROUP BY c.day`,
        [ctx.sinceMs]
      )
    ).rows as { day: number | string; total: number | string; kept: number | string }[];

    const m = new Map<number, number>();
    for (const r of rows) {
      const total = Number(r.total);
      if (total > 0) m.set(Number(r.day), Math.round((Number(r.kept) / total) * 1000) / 10);
    }
    const todayIdx = Math.floor((Date.now() + TZ) / 86400_000);
    // 观察期未满的队列一律不出数,否则线尾会假性跳水 —— 留存图最常见的误读来源。
    // 判据是 >= 而不是 >:d + offset === todayIdx 意味着观察日就是今天,而今天还没过完,
    // 那个队列只统计到此刻为止的活动,必然偏低。差这一天,最后一个点就是错的。
    return ctx.dayIdxs.map((d) => (d + offset >= todayIdx ? null : m.get(d) ?? null));
  };
}

const d1: MetricDef = {
  id: "d1",
  label: "次日留存",
  group: "growth",
  unit: "percent",
  desc: "按注册日分队列:该日注册的用户中,第二天还有活动的比例。观察期未满的队列不出数。",
  maxDays: ACTIVITY_RETENTION_DAYS,
  caveat: "分子依赖活动日志,而对话不打点,留存被系统性低估。",
  series: retention(1),
};

const d7: MetricDef = {
  id: "d7",
  label: "七日留存",
  group: "growth",
  unit: "percent",
  desc: "按注册日分队列:该日注册的用户中,第 7 天还有活动的比例。",
  maxDays: ACTIVITY_RETENTION_DAYS,
  caveat: "同次日留存。",
  series: retention(7),
};

// ─────────────────────────── 内容 ───────────────────────────

const src: MetricDef = {
  id: "src",
  label: "来源导入量",
  group: "content",
  unit: "count",
  desc: "当天新增的来源数,已排除笔记影子源与订阅自动抓取。",
  // 复制来的来源在库里与真导入**完全无法区分**:copyNotebook 把原来源整行重插、
  // created_at 换成复制时刻、origin 原样照抄。要区分得在 sources 上加一列,
  // 那是产品改动不是指标改动 —— 在此之前只能如实声明,不能让 desc 继续吹「只算主动导入」。
  caveat: "复制笔记本会把原有来源以复制时刻重新入库,这部分会被计入 —— 库里没有字段能把复制品和真导入区分开。",
  series: async (ctx) =>
    spread(
      ctx,
      await byDay(
        // 订阅抓取**没有**自己的 origin 前缀:它走的是和用户粘贴 URL 完全相同的
        // addUrlSource,origin 就是规范化后的网址(lib/ingest.ts:79)。这里曾经写成
        // origin NOT LIKE 'feed:%',那是一条永远匹配不到任何行的死过滤 —— 排除承诺是假的,
        // 订阅抓的全被算进了「用户主动导入」。唯一可靠的判据是 feed_items.source_id 这条软引用。
        `SELECT ${dayOf("s.created_at")} AS day, COUNT(*) AS n FROM sources s
         WHERE s.created_at >= $1
           AND (s.origin IS NULL OR s.origin NOT LIKE 'note:%')
           AND NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.source_id = s.id)
         GROUP BY day`,
        ctx.sinceMs
      )
    ),
};

const out: MetricDef = {
  id: "out",
  label: "制品生成量",
  group: "content",
  unit: "count",
  desc: "当天生成的工作室制品数(播客/导图/测验/信息图等全部类型合计)。",
  caveat: "复制笔记本会把原有制品以复制时刻重新入库,这部分会被计入,但它不产生任何模型调用 —— 看成本时别把这段增量当成用量。",
  // worker 会先写 processing 产物，任务与积分结算全部成功后才原子发布为 ready。
  // processing 可能仍在生成、已失权或等待清理，不能提前算作用户真正拿到的制品。
  series: countBy("studio_outputs", "created_at", "AND status = 'ready'"),
};

const msg: MetricDef = {
  id: "msg",
  label: "提问数",
  group: "content",
  unit: "count",
  desc: "当天用户发出的提问条数(不含系统回答)。",
  series: countBy("messages", "created_at", "AND role = 'user'"),
};

/**
 * 引用命中率 —— 「答案有出处、句句可回溯」这句产品承诺的量化指标。
 *
 * 判定依据是 messages.citations:对话路由在生成回答后,用正则扫正文里出现的 [n],
 * 与本次检索到的块编号取交集,只有真被引用的块才写进去。所以 citations <> '[]'
 * 就等于「这条回答带出处」。
 *
 * 必须剔除无来源笔记本:那条路径走的是「智能向导」分支,代码里硬编码写空引用数组,
 * 天然永远不命中。不剔除的话,新用户建个空本随便聊两句就能把命中率打到地板,
 * 指标会变成「有多少人在空本里瞎聊」而不是「引用做得好不好」。
 *
 * 「有没有来源」的判据必须和对话路由**逐字一致**,否则两边分岔就会系统性歪曲命中率。
 * 对话路由(app/api/notebooks/[id]/chat/route.ts:132-134)算的是
 * `status==='ready' 的来源数 + 笔记影子源数`,所以这里也是这两项取并 ——
 * 曾经写成「排除 note 影子源、且不看 status」,两个方向都错:有导入失败来源的笔记本
 * 被当成有来源(它其实走向导分支、永不产生引用),纯笔记的笔记本反被剔掉
 * (它其实会正常检索并给出引用)。
 */
const cit: MetricDef = {
  id: "cit",
  label: "引用命中率",
  group: "content",
  unit: "percent",
  desc: "当天的回答中,带出处引用的比例。已排除无来源笔记本(那类对话不产生引用)。",
  caveat:
    "「有没有来源」按查询时刻的状态判定,不是回答发生时的状态。用户事后删光来源,那天的历史命中率会跟着变 —— 要根治得在消息上记下当时的来源数。",
  series: async (ctx) => {
    const rows = (
      await getPool().query(
        `SELECT ${dayOf("m.created_at")} AS day,
                COUNT(*) AS total,
                COALESCE(SUM((m.citations <> '[]')::int), 0) AS hit
         FROM messages m
         WHERE m.created_at >= $1 AND m.role = 'assistant'
           AND EXISTS(
             SELECT 1 FROM sources s
             WHERE s.notebook_id = m.notebook_id
               AND (s.status = 'ready' OR s.origin LIKE 'note:%')
           )
         GROUP BY day`,
        [ctx.sinceMs]
      )
    ).rows as { day: number | string; total: number | string; hit: number | string }[];
    const m = new Map<number, number>();
    for (const r of rows) {
      const total = Number(r.total);
      if (total > 0) m.set(Number(r.day), Math.round((Number(r.hit) / total) * 1000) / 10);
    }
    return ctx.dayIdxs.map((d) => m.get(d) ?? null);
  },
};

// ─────────────────────────── 用量 ───────────────────────────

/**
 * 积分消耗。必须排除四类「发行」操作 —— 管理员补发、邀请奖励、活动赠送、故障补偿
 * 都是往账户里**加**积分,混进来会让「消耗」这个口径彻底失真。
 * 这个排除清单与 lib/db.ts 的 creditStatsByDay 保持一致。
 */
const crd: MetricDef = {
  id: "crd",
  scope: "credits",
  label: "积分消耗",
  group: "usage",
  unit: "credits",
  desc: "当天净消耗的积分,已排除管理员补发、邀请奖励、活动赠送、故障补偿等发行类流水。",
  series: async (ctx) =>
    spread(
      ctx,
      new Map(
        (await creditConsumptionByDaySince(ctx.sinceMs)).map((row) => [
          Number(row.day),
          Number(row.credits),
        ])
      )
    ),
};

// ─────────────────────────── 成本 ───────────────────────────

/**
 * 模型成本指标有一条**硬边界:只有近 7 天**。
 *
 * 原因是 ai_calls 明细按 7 天硬删(lib/db.ts 的定期清理),而长期兜底表 usage_daily
 * 里根本没有成本列 —— 它只有 day/provider/tokens_in/tokens_out/calls,而且 provider
 * 只有 "primary"/"fallback" 两个值,连供应商名都不是,更谈不上按模型套单价。
 *
 * 所以超过 7 天没有任何靠谱的算法:拿 7 天的混合单价去乘 30 天的用量,误差量级
 * 不可控。这里选择**直接不给数**而不是给一个标着「估算」的数字 —— 后台数字一旦
 * 显示出来就会被拿去做决策,一个没法解释误差范围的成本数比空白更危险。
 */
const COST_MAX_DAYS = 7;
const COST_CAVEAT =
  "调用明细仅保留 7 天,且长期表不含成本列,故只能回看 7 天。选择更长范围时本指标不出数。";

const cost: MetricDef = {
  id: "cost",
  scope: "credits",
  label: "模型调用成本",
  group: "cost",
  unit: "cny",
  desc: "当天成功调用的模型费用(元),按调用发生时固化的单价计,不受后续改价影响。",
  maxDays: COST_MAX_DAYS,
  caveat: COST_CAVEAT,
  series: async (ctx) => ctx.dayIdxs.map((d) => ctx.costByDay?.get(d) ?? 0),
};

/**
 * 当日成本聚合。由 queryMetrics 按需加载后挂到上下文上。
 * cost_micros 是人民币微元(1 元 = 1e6)。
 */
async function loadCostByDay(ctx: MetricCtx): Promise<Map<number, number>> {
  const m = await byDay(
    `SELECT ${dayOf("ts")} AS day, COALESCE(SUM(cost_micros),0) AS n
     FROM ai_calls WHERE ts >= $1 AND ok = 1 GROUP BY day`,
    ctx.sinceMs
  );
  return new Map([...m].map(([d, micros]) => [d, micros / 1_000_000]));
}

// ─────────────────────────── 注册表 ───────────────────────────

export const METRICS: Record<MetricId, MetricDef> = {
  dau, new: newUsers, d1, d7,
  src, out, msg, cit,
  crd, cost,
};

export const METRIC_GROUPS: { id: MetricGroup; label: string; metrics: MetricId[] }[] = [
  { id: "growth", label: "增长", metrics: ["dau", "new", "d1", "d7"] },
  { id: "content", label: "内容", metrics: ["src", "out", "msg", "cit"] },
  { id: "usage", label: "用量", metrics: ["crd"] },
  { id: "cost", label: "成本", metrics: ["cost"] },
];

export function isMetricId(v: string): v is MetricId {
  return Object.prototype.hasOwnProperty.call(METRICS, v);
}

/** 构造一次查询的时间上下文。days 会被夹到 1..365。 */
export function buildCtx(days: number): MetricCtx {
  const d = Math.max(1, Math.min(365, Math.floor(days) || 30));
  const todayIdx = Math.floor((Date.now() + TZ) / 86400_000);
  const startIdx = todayIdx - (d - 1);
  return {
    startIdx,
    days: d,
    dayIdxs: Array.from({ length: d }, (_, i) => startIdx + i),
    // 窗口首日的北京 0 点对应的 UTC 毫秒
    sinceMs: startIdx * 86400_000 - TZ,
  };
}

/** 日序号 → 'MM-DD'。日序号已含 +8,按 UTC 读出来就是北京墙钟日期。 */
export function dayLabel(dayIdx: number): string {
  const t = new Date(dayIdx * 86400_000);
  return `${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export type MetricSeries = {
  id: MetricId;
  label: string;
  group: MetricGroup;
  unit: MetricUnit;
  desc: string;
  caveat?: string;
  /** 与 labels 等长;比率型指标在无样本的日子为 null */
  values: (number | null)[];
  /** 该指标因为超出自身回看上限而未出数 */
  unavailable?: string;
};

/**
 * 批量取指标。并发查询 —— 原来的 analytics 路由是一条条 await 串下来的,
 * 画布上放五六个指标时那样会把响应时间线性叠加。
 */
export async function queryMetrics(ids: MetricId[], days: number): Promise<{ labels: string[]; series: MetricSeries[] }> {
  const ctx = buildCtx(days);
  const labels = ctx.dayIdxs.map(dayLabel);
  // 去重:同一个 id 传 8 遍会让最重的那条查询并发跑 8 次,是个免费的放大器。
  const wanted = [...new Set(ids.filter(isMetricId))];

  const over = (id: MetricId) => {
    const max = METRICS[id].maxDays;
    return max !== undefined && ctx.days > max;
  };

  // 成本聚合按需加载。days 超过上限时直接返回 unavailable，避免无效查询。
  if (wanted.some((id) => METRICS[id].group === "cost" && !over(id))) {
    try {
      ctx.costByDay = await loadCostByDay(ctx);
    } catch (e) {
      // 成本是可选依赖：失败只能让成本指标降级，不能让同请求里的 DAU 等
      // 已可查询指标一起 500。原始数据库错误只进服务端日志，绝不下发 SQL/表结构。
      console.error("[workbench] 成本预加载失败:", e);
      ctx.costUnavailable = "成本数据查询失败,请稍后重试";
    }
  }

  const series = await mapLimit(wanted, QUERY_CONCURRENCY, async (id): Promise<MetricSeries> => {
    const def = METRICS[id];
    const base = { id, label: def.label, group: def.group, unit: def.unit, desc: def.desc, caveat: def.caveat };
    const blank = ctx.dayIdxs.map(() => null);
    if (over(id)) return { ...base, values: blank, unavailable: `该指标最多回看 ${def.maxDays} 天` };
    if (def.group === "cost" && ctx.costUnavailable) {
      return { ...base, values: blank, unavailable: ctx.costUnavailable };
    }
    try {
      return { ...base, values: await def.series(ctx) };
    } catch (e) {
      // 一个指标查挂了不该让整块画布空掉 —— 其余指标照常返回,这一块单独标记失败。
      // 这里刻意不把原始错误往外抛:数据库报错文本会带上表名和 SQL 片段。
      console.error(`[workbench] 指标 ${id} 查询失败:`, e);
      return { ...base, values: blank, unavailable: "该指标查询失败,请稍后重试" };
    }
  });
  return { labels, series };
}
