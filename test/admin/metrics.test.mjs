// 数据工作台指标层。
//
// 这里测的全是「口径」——指标算错不会报错,只会给出一个看着合理的错数字,
// 然后被拿去做决策。每一条排除规则都对应一个真实的失真场景:
// 影子源会把导入量翻几倍、发行流水会把「消耗」算成净增、空笔记本的对话
// 会把引用命中率打到地板。这些都得钉死。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("metrics");
const M = await import("../../lib/metrics.ts");
const { getPool } = await import("../../lib/pg.ts");

const TZ = 8 * 3600_000;
const DAY = 86400_000;
/** 第 n 天前的北京中午(挑中午是为了避开任何边界歧义)。 */
const daysAgo = (n) => {
  const todayIdx = Math.floor((Date.now() + TZ) / DAY);
  return (todayIdx - n) * DAY - TZ + 12 * 3600_000;
};
/** 取某指标在「n 天前」那一格的值。 */
const at = (series, labels, n) => {
  const idx = labels.length - 1 - n;
  return series.values[idx];
};

test("时间上下文:东八区日切,定长,末位是今天", () => {
  const ctx = M.buildCtx(30);
  assert.equal(ctx.days, 30);
  assert.equal(ctx.dayIdxs.length, 30);
  // 相邻日序号严格 +1,不能有空洞
  for (let i = 1; i < ctx.dayIdxs.length; i++) {
    assert.equal(ctx.dayIdxs[i] - ctx.dayIdxs[i - 1], 1);
  }
  // 末位就是今天(北京)
  assert.equal(ctx.dayIdxs[29], Math.floor((Date.now() + TZ) / DAY));
  // sinceMs 应正好是首日的北京 0 点
  assert.equal(ctx.sinceMs, ctx.dayIdxs[0] * DAY - TZ);
});

test("时间上下文:天数被夹在 1..365", () => {
  assert.equal(M.buildCtx(0).days, 30, "0 视为缺省 30");
  assert.equal(M.buildCtx(-5).days, 1);
  assert.equal(M.buildCtx(9999).days, 365);
  assert.equal(M.buildCtx(1).days, 1);
});

test("注册表:分组与指标一一对应,无遗漏无多余", () => {
  const inGroups = M.METRIC_GROUPS.flatMap((g) => g.metrics);
  const all = Object.keys(M.METRICS);
  assert.equal(inGroups.length, new Set(inGroups).size, "同一指标不能出现在两个分组里");
  assert.deepEqual([...inGroups].sort(), [...all].sort(), "分组清单必须覆盖且仅覆盖已定义的指标");
  // 每个指标都要有口径说明 —— 没有说明的数字没人敢用
  for (const [id, def] of Object.entries(M.METRICS)) {
    assert.ok(def.desc && def.desc.length > 8, `${id} 缺少口径说明`);
    assert.equal(def.id, id, `${id} 的 id 字段与键名不一致`);
  }
});

/** 建两个笔记本:nb_has 有真实来源,nb_empty 是空本(对话走「智能向导」分支,永不产生引用)。 */
async function seedNotebooks() {
  const pool = getPool();
  await pool.query("INSERT INTO users (id, name, created_at) VALUES ('u1','测试用户',$1) ON CONFLICT DO NOTHING", [daysAgo(30)]);
  for (const nb of ["nb_has", "nb_empty"]) {
    await pool.query(
      "INSERT INTO notebooks (id, user_id, title, created_at) VALUES ($1,'u1',$1,$2) ON CONFLICT DO NOTHING",
      [nb, daysAgo(10)]
    );
  }
}

test("来源导入量:排除笔记影子源与订阅抓取", async () => {
  await seedNotebooks();
  const pool = getPool();
  const ins = (id, origin, ts) =>
    pool.query(
      `INSERT INTO sources (id, notebook_id, title, type, status, content, origin, created_at)
       VALUES ($1,'nb_has',$1,'web','ready','x',$2,$3)`,
      [id, origin, ts]
    );
  const t = daysAgo(1);
  await ins("s_real1", null, t);
  await ins("s_real2", "https://example.com/a", t);
  await ins("s_note", "note:abc", t);          // 笔记影子源,不算
  // 订阅抓来的来源:origin 就是普通网址(和用户手动粘贴的一模一样),
  // 唯一能认出它的是 feed_items.source_id 这条软引用。曾经用 origin LIKE 'feed:%'
  // 判定,那个前缀生产里根本不存在,是一条永远匹配不到的死过滤。
  await ins("s_feed", "https://feed.example.com/post/1", t);
  await pool.query(
    `INSERT INTO feed_channels (id, notebook_id, kind, url, config, enabled, interval_minutes,
       next_poll_at, last_polled_at, last_content_at, daily_ingested, daily_reset_at, fail_count, status, created_at)
     VALUES ('ch1','nb_has','rss','https://feed.example.com/rss','{}',1,60,0,0,0,0,0,0,'active',$1)
     ON CONFLICT DO NOTHING`,
    [daysAgo(9)]
  );
  await pool.query(
    `INSERT INTO feed_items (id, channel_id, guid, title, backfill, retry_after, status, source_id, created_at)
     VALUES ('fi1','ch1','g1','订阅文章',0,0,'ingested','s_feed',$1)`,
    [t]
  );

  const { labels, series } = await M.queryMetrics(["src"], 7);
  assert.equal(at(series[0], labels, 1), 2, "只应算 2 条用户主动导入的来源");
});

test("制品生成量:只统计已发布 ready,不把 processing 半成品算进去", async () => {
  await seedNotebooks();
  const pool = getPool();
  const n = 2;
  const beforeResult = await M.queryMetrics(["out"], 7);
  const before = at(beforeResult.series[0], beforeResult.labels, n);
  const ts = daysAgo(n);
  await pool.query(
    `INSERT INTO studio_outputs (id, notebook_id, kind, title, content, status, created_at)
     VALUES ('out_ready_metric','nb_has','briefing','ready','x','ready',$1),
            ('out_processing_metric','nb_has','briefing','processing','x','processing',$1)`,
    [ts]
  );

  const { labels, series } = await M.queryMetrics(["out"], 7);
  assert.equal(at(series[0], labels, n), before + 1, "只有 ready 行应增加制品生成量");
});

test("积分消耗:排除补发/邀请/赠送/补偿等发行类流水", async () => {
  const pool = getPool();
  const ins = (op, credits, ts) =>
    pool.query("INSERT INTO credit_ledger (user_id, op, credits, ts) VALUES ('u1',$1,$2,$3)", [op, credits, ts]);
  const t = daysAgo(2);
  await ins("studio:podcast", 30, t);
  await ins("chat:ask", 12, t);
  await ins("admin:grant", 500, t);         // 发行,不算
  await ins("referral:milestone", 100, t);  // 发行,不算
  await ins("bonus:signup", 50, t);         // 发行,不算
  await ins("compensation:outage", 20, t);  // 发行,不算

  const { labels, series } = await M.queryMetrics(["crd"], 7);
  assert.equal(at(series[0], labels, 2), 42, "只应算 30+12 的真实消耗");
});

test("引用命中率:排除无来源笔记本 —— 空本瞎聊不该拉低命中率", async () => {
  await seedNotebooks();
  const pool = getPool();
  const ins = (nb, role, citations, ts) =>
    pool.query(
      "INSERT INTO messages (id, notebook_id, role, content, citations, created_at) VALUES ($1,$2,$3,'x',$4,$5)",
      [`m_${Math.random().toString(36).slice(2)}`, nb, role, citations, ts]
    );
  const t = daysAgo(4);
  // 有来源的本:3 条回答,2 条带引用 → 命中率应为 66.7%
  await ins("nb_has", "assistant", '[{"number":1}]', t);
  await ins("nb_has", "assistant", '[{"number":2}]', t);
  await ins("nb_has", "assistant", "[]", t);
  // 空本:5 条回答全无引用。若不剔除,命中率会被打到 2/8=25%
  for (let i = 0; i < 5; i++) await ins("nb_empty", "assistant", "[]", t);
  // 用户提问不参与命中率计算
  await ins("nb_has", "user", "[]", t);

  const { labels, series } = await M.queryMetrics(["cit"], 7);
  assert.equal(at(series[0], labels, 4), 66.7, "只应统计有来源笔记本里的回答");
});

test("引用命中率:当天没有样本时给 null 而不是 0", async () => {
  const { labels, series } = await M.queryMetrics(["cit"], 7);
  // 第 6 天前没插过任何消息
  assert.equal(at(series[0], labels, 6), null, "无样本必须是 null,画成 0 会凭空多出断崖");
});

test("模型成本超过 7 天硬边界时不出数并说明原因", async () => {
  const long = await M.queryMetrics(["cost"], 30);
  for (const s of long.series) {
    assert.ok(s.unavailable, `${s.id} 在 30 天范围应标记为不可用`);
    assert.match(s.unavailable, /7 天/);
    assert.ok(s.values.every((v) => v === null), `${s.id} 不可用时不应给出任何数值`);
  }
  // 7 天以内正常出数
  const short = await M.queryMetrics(["cost"], 7);
  assert.equal(short.series[0].unavailable, undefined);
  assert.equal(short.series[0].values.length, 7);
});

test("成本预加载失败只降级 cost，同请求其它指标照常返回且错误脱敏", async () => {
  const pool = getPool();
  await pool.query("ALTER TABLE ai_calls RENAME COLUMN cost_micros TO cost_micros_broken");
  try {
    const { labels, series } = await M.queryMetrics(["new", "cost"], 7);
    assert.equal(labels.length, 7);

    const normal = series.find((s) => s.id === "new");
    assert.ok(normal, "非成本指标必须保留");
    assert.equal(normal.unavailable, undefined, "非成本指标不得被成本查询拖累");
    assert.equal(normal.values.length, 7);

    for (const id of ["cost"]) {
      const degraded = series.find((s) => s.id === id);
      assert.ok(degraded, `${id} 必须返回占位系列`);
      assert.equal(degraded.unavailable, "成本数据查询失败,请稍后重试");
      assert.ok(degraded.values.every((v) => v === null));
      assert.doesNotMatch(degraded.unavailable, /ai_calls|cost_micros|SELECT|column/i, "客户端错误不得泄露 SQL 结构");
    }
  } finally {
    await pool.query("ALTER TABLE ai_calls RENAME COLUMN cost_micros_broken TO cost_micros");
  }
});

test("每个指标都能独立跑通,且返回定长序列", async () => {
  const ids = Object.keys(M.METRICS);
  for (const id of ids) {
    const days = M.METRICS[id].maxDays ?? 14;
    const { labels, series } = await M.queryMetrics([id], days);
    assert.equal(series.length, 1, `${id} 应返回一条序列`);
    assert.equal(series[0].values.length, days, `${id} 序列长度应等于天数`);
    assert.equal(labels.length, days);
  }
});

// ───────────────────────────────────────────────────────────────
// 以下几条是对抗审查(变异测试)之后补的。审查用真实变异证明:改坏 dayOf 的时区、
// 改坏微元换算时，原有断言不会变红。
// 原因是所有 fixture 都种在「北京中午」这个两种时区下都安全的位置，且 cost
// 从来没被喂过数据。下面每一条都对应一个已被证实能存活的变异。
// ───────────────────────────────────────────────────────────────

/** 第 n 天前的北京 h 点(可取小数,如 0.5 表示 00:30)。 */
const beijingHour = (n, h) => {
  const todayIdx = Math.floor((Date.now() + TZ) / DAY);
  return (todayIdx - n) * DAY - TZ + Math.round(h * 3600_000);
};

test("日切:同一北京日的 00:30 / 12:00 / 23:30 必须落进同一格", async () => {
  await seedNotebooks();
  const pool = getPool();
  const n = 5;
  let i = 0;
  for (const h of [0.5, 12, 23.5]) {
    await pool.query(
      `INSERT INTO sources (id, notebook_id, title, type, status, content, origin, created_at)
       VALUES ($1,'nb_has',$1,'web','ready','x',NULL,$2)`,
      [`s_tz_${i++}`, beijingHour(n, h)]
    );
  }
  const { labels, series } = await M.queryMetrics(["src"], 10);
  // 若 dayOf 退回 UTC 日切,北京 00:30 那条会掉到前一天,本格变 2、前一格变 1。
  assert.equal(at(series[0], labels, n), 3, "三条都应记在同一个北京自然日");
  assert.equal(at(series[0], labels, n + 1), 0, "前一天不该被蹭进去");
});

test("成本:微元换算与 ok=1 过滤", async () => {
  const pool = getPool();
  const n = 2;
  const ins = (ok, micros) =>
    pool.query(
      `INSERT INTO ai_calls (ts, provider, model, ms, ok, tokens_in, tokens_out, cost_micros)
       VALUES ($1,'primary','test-model',100,$2,10,20,$3)`,
      [beijingHour(n, 10), ok, micros]
    );
  await ins(1, 1_500_000); // 1.5 元
  await ins(1, 500_000);   // 0.5 元
  await ins(0, 9_000_000); // 失败调用,不该计成花掉的钱

  const { labels, series } = await M.queryMetrics(["cost"], 7);
  // 这一条断言同时钉死两件事:1e6 的微元换算,以及 ok=1 过滤。
  assert.equal(at(series[0], labels, n), 2, "应为 (1.5e6+0.5e6)/1e6 = 2 元");
});

test("日活:同一用户当天多次活动只算一个人", async () => {
  const pool = getPool();
  const n = 4;
  const ins = (uid, h) =>
    pool.query(
      "INSERT INTO activity_log (ts, actor_id, actor_kind, action) VALUES ($1,$2,'user','studio.generate')",
      [beijingHour(n, h), uid]
    );
  await ins("u_a", 9);
  await ins("u_a", 14);
  await ins("u_a", 20);
  await ins("u_b", 15);
  const { labels, series } = await M.queryMetrics(["dau"], 10);
  // COUNT(DISTINCT actor_id) 退化成 COUNT(actor_id) 就会变成 4。
  assert.equal(at(series[0], labels, n), 2, "两个人,不是四条事件");
});

test("留存:观察期未满的队列不出数(含今天这个只走了一半的日子)", async () => {
  const pool = getPool();
  // 6 天前注册两人,其中一人第二天有活动 → d1 应为 50%
  for (const [uid, days] of [["u_r1", 6], ["u_r2", 6]]) {
    await pool.query("INSERT INTO users (id, name, created_at) VALUES ($1,$1,$2) ON CONFLICT DO NOTHING", [uid, beijingHour(days, 10)]);
  }
  await pool.query(
    "INSERT INTO activity_log (ts, actor_id, actor_kind, action) VALUES ($1,'u_r1','user','source.add')",
    [beijingHour(5, 10)]
  );
  // 昨天注册一人、今天已经回来过 —— 这一格必须是 null 而不是 100%:
  // 它的观察日是今天,而今天才走了一半,现在量出来的任何数都偏低。
  // 这条 fixture 是必须的:如果昨天压根没人注册,判据写成 > 还是 >= 都会返回 null,
  // off-by-one 就测不出来(第一版就是这么漏掉的)。
  await pool.query("INSERT INTO users (id, name, created_at) VALUES ('u_r3','u_r3',$1) ON CONFLICT DO NOTHING", [beijingHour(1, 10)]);
  await pool.query(
    "INSERT INTO activity_log (ts, actor_id, actor_kind, action) VALUES ($1,'u_r3','user','source.add')",
    [beijingHour(0, 9)]
  );

  const { labels, series } = await M.queryMetrics(["d1"], 10);
  assert.equal(at(series[0], labels, 6), 50, "两人注册、一人次日回来 → 50%");
  assert.equal(at(series[0], labels, 1), null, "观察日落在今天的队列必须为 null,不能是 100%");
  assert.equal(at(series[0], labels, 0), null, "今天注册的队列更不可能有次日数据");
});

test("指标声明的回看上限会被真正执行", async () => {
  // 依赖 activity_log 的三个指标都以日志保留期为上限
  for (const id of ["dau", "d1", "d7"]) {
    const { series } = await M.queryMetrics([id], 120);
    assert.ok(series[0].unavailable, `${id} 超过 90 天应标记不可用`);
    assert.ok(series[0].values.every((v) => v === null));
  }
  const ok = await M.queryMetrics(["dau"], 90);
  assert.equal(ok.series[0].unavailable, undefined, "正好 90 天应可用");
});

test("引用命中率:「有来源」的判据必须与对话路由一致", async () => {
  const pool = getPool();
  const t = beijingHour(6, 10);
  const mkNb = (id) =>
    pool.query("INSERT INTO notebooks (id, user_id, title, created_at) VALUES ($1,'u1',$1,$2) ON CONFLICT DO NOTHING", [id, daysAgo(10)]);
  const mkSrc = (id, nb, status, origin) =>
    pool.query(
      `INSERT INTO sources (id, notebook_id, title, type, status, content, origin, created_at)
       VALUES ($1,$2,$1,'web',$3,'x',$4,$5)`,
      [id, nb, status, origin, t]
    );
  const mkMsg = (nb, citations) =>
    pool.query(
      "INSERT INTO messages (id, notebook_id, role, content, citations, created_at) VALUES ($1,$2,'assistant','x',$3,$4)",
      [`m_${Math.random().toString(36).slice(2)}`, nb, citations, t]
    );

  // A. 只有导入失败来源的笔记本:对话路由算 readyCount=0 → 走向导分支 → 永不产生引用。
  //    必须**排除**,否则它的空引用会白白拉低命中率。
  await mkNb("nb_err");
  await mkSrc("s_err", "nb_err", "error", "https://x.example.com/1");
  await mkMsg("nb_err", "[]");

  // B. 只有笔记影子源的笔记本:对话路由把影子源计入 readyCount → 正常检索 → 会有引用。
  //    必须**计入**,否则等于把一批真实的成功引用丢掉。
  await mkNb("nb_note");
  await mkSrc("s_shadow", "nb_note", "ready", "note:n1");
  await mkMsg("nb_note", '[{"number":1}]');

  const { labels, series } = await M.queryMetrics(["cit"], 10);
  // 参与统计的只有 B 的那一条,且它带引用 → 100%。
  // 若判据退回「排除 note 影子源」,B 被剔除、只剩 A 的空引用 → 0%;
  // 若判据不看 status,A 被计入 → 50%。三种写法给出三个不同的数。
  assert.equal(at(series[0], labels, 6), 100);
});
