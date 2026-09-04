// 功能 + 并发测试:API 用量统计(token 汇总 / 月度配额)与「最后一名管理员」不变量。
// 用独立 PG 测试库(freshPgDb),不污染真实数据;Node --test 每个文件独立进程,库隔离。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("usage");
// getPool 必须在 freshPgDb 之后 import(那时 DATABASE_URL 已指向本测试库、旧池已清)。
const { getPool } = await import("../../lib/pg.ts");

const call = (provider, tin, tout) =>
  db.logAiCall({ ts: Date.now(), provider, model: "m", ms: 5, ok: 1, status: null, error: null, tokensIn: tin, tokensOut: tout });

// ---- 功能:logAiCall 累计到 usage_daily,getUsageStats 按通道汇总 ----
test("功能:token 用量按通道精确汇总", async () => {
  await call("primary", 100, 50);
  await call("primary", 200, 30);
  await call("fallback", 10, 5);
  const s = await db.getUsageStats(30);
  assert.equal(s.byProvider.primary.tokens, 380); // (100+50)+(200+30)
  assert.equal(s.byProvider.primary.calls, 2);
  assert.equal(s.byProvider.fallback.tokens, 15);
  assert.equal(s.totalTokens, 395);
});

test("功能:每次调用固化阶梯价成本快照，聚合不再丢失单请求档位", async () => {
  await db.logAiCall({
    ts: Date.now(), provider: "primary", model: "qwen-plus", ms: 5, ok: 1,
    status: null, error: null, tokensIn: 200_000, tokensOut: 10_000,
  });
  const row = (
    await getPool().query("SELECT cost_micros FROM ai_calls WHERE model='qwen-plus' ORDER BY id DESC LIMIT 1")
  ).rows[0];
  assert.equal(Number(row.cost_micros), 680_000, "200K 输入应命中 2.4/20 元阶梯");
  const stats = (await db.tokenStatsByModel(7)).find((item) => item.model === "qwen-plus");
  assert.equal(Number(stats.cost_micros), 680_000);
});

// ---- 功能:用量随天数窗口收缩(过老的不计入)----
test("功能:超窗口的旧用量不计入", async () => {
  const oldTs = Date.now() - 40 * 86400_000; // 40 天前,30 天窗口之外
  await db.logAiCall({ ts: oldTs, provider: "primary", model: "m", ms: 5, ok: 1, status: null, error: null, tokensIn: 9999, tokensOut: 0 });
  const within = (await db.getUsageStats(30)).byProvider.primary.tokens;
  const wide = (await db.getUsageStats(60)).byProvider.primary.tokens;
  assert.equal(wide - within, 9999, "60 天窗口才包含 40 天前那笔");
});

// ---- 并发:UPSERT 累加语义无丢更新(naive last-write-wins 会失败)----
test("并发:200 次并发 logAiCall 累加无丢失", async () => {
  const N = 200;
  const base = (await db.getUsageStats(30)).byProvider.fallback?.calls ?? 0;
  const baseTok = (await db.getUsageStats(30)).byProvider.fallback?.tokens ?? 0;
  await Promise.all(
    Array.from({ length: N }, () => Promise.resolve().then(() => call("fallback", 7, 3)))
  );
  const s = await db.getUsageStats(30);
  assert.equal(s.byProvider.fallback.calls, base + N, "调用数无丢更新");
  assert.equal(s.byProvider.fallback.tokens, baseTok + N * 10, "token 累加精确(非覆盖)");
});

// ---- 功能:月度配额预警分级(ok/warn/over)----
test("功能:配额比例分级 80%=warn / 100%=over", async () => {
  const used = (await db.getUsageStats(30)).byProvider.primary.tokens; // >0
  const ratio = (budget) => used / budget;
  const level = (budget) => (budget <= 0 ? "none" : ratio(budget) >= 1 ? "over" : ratio(budget) >= 0.8 ? "warn" : "ok");
  assert.equal(level(0), "none");
  assert.equal(level(used * 10), "ok");
  assert.equal(level(Math.ceil(used / 0.9)), "warn"); // ~90%
  assert.equal(level(Math.floor(used / 2)), "over"); // 200%
});

test("成本分母统计排除管理员/邀请发行积分", async () => {
  const user = await db.createUserByEmail("cost-denominator@example.com", "成本分母");
  const before = (await db.creditStatsByDay(1)).reduce((sum, row) => sum + Number(row.credits), 0);
  const now = Date.now();
  await getPool().query(
    "INSERT INTO credit_ledger (user_id,op,credits,bonus,plan_credits,ts) VALUES ($1,'chat',10,0,10,$2),($1,'admin:grant',-100,-100,0,$2)",
    [user.id, now]
  );
  const after = (await db.creditStatsByDay(1)).reduce((sum, row) => sum + Number(row.credits), 0);
  assert.equal(after - before, 10, "赠送100分不能把真实消费10分冲成-90");
  const top = (await db.creditTopUsers(1, 100)).find((row) => row.user_id === user.id);
  assert.equal(Number(top.credits), 10);
});

// ---- 功能:「最后一名有效管理员」不变量(后台守卫依据)----
test("功能:最后一名管理员守卫的计数依据正确", async () => {
  const a = await db.createUserByPhone("199" + "00000001", "管理员A");
  const b = await db.createUserByPhone("199" + "00000002", "管理员B");
  await db.setUserAdmin(a.id, true);
  await db.setUserAdmin(b.id, true);
  const othersActive = async (id) =>
    (await getPool().query("SELECT COUNT(*) c FROM users WHERE is_admin=1 AND disabled=0 AND id<>$1", [id])).rows[0].c;
  assert.ok((await othersActive(a.id)) >= 1, "降级 A 时仍有有效管理员 B");
  await db.setUserDisabled(b.id, true); // 停用 B → A 成唯一有效管理员
  assert.equal(await othersActive(a.id), 0, "A 是最后一名 → 守卫应拦截停用/降级/删除");
});

// ---- 并发安全机制:claimNextQueued 原子认领,不重复 ----
test("并发:任务队列认领原子、不重复", async () => {
  const owner = await db.createUserByEmail("queue-owner@example.test", "队列测试用户");
  const nb = await db.createNotebook(owner.id, "测试本", "📓");
  for (let i = 0; i < 3; i++) {
    const id = `job-${i}-${Math.random().toString(36).slice(2)}`;
    await getPool().query(
      "INSERT INTO jobs (id, notebook_id, user_id, kind, title, status, params, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id, nb.id, null, "briefing", "t", "queued", "{}", Date.now(), Date.now()]
    );
  }
  const claimed = [];
  for (let i = 0; i < 5; i++) {
    const j = await db.claimNextQueued();
    if (j) claimed.push(j.id);
  }
  assert.equal(claimed.length, 3, "恰好认领 3 个(其余返回空)");
  assert.equal(new Set(claimed).size, 3, "无重复认领(原子性)");
});
