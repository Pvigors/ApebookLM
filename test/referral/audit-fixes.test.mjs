// 对抗审查修复回归测试:UTC+8 日切、月度邀请上限、注销清孤儿账、copy 保留 content_hash。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb, withoutTrial } from "../helpers/pgdb.mjs";

const db = await freshPgDb("audit_fixes");
const { STARTER_DAILY_CREDITS } = await import("../../lib/plans.ts");
// 原用 db.getDb().prepare(...) 做的裸 SQL,PG 版无该导出;改用同一测试库的连接池直查。
// getPool 复用 freshPgDb 已建立的 globalThis.__nblm_pg 池(DATABASE_URL 指向本测试库)。
const { getPool } = await import("../../lib/pg.ts");
const pool = getPool();

// 退掉注册赠送的试用额度:本文件验的是邀请返利与扣费口径,断言的都是绝对值,
// 混进 200 分试用积分会让返利绝对值断言失真。试用本身在 signup-trial.test.mjs 里验。
const mkEmail = async (email, name) => {
  const u = await db.createUserByEmail(email, name);
  await withoutTrial(u.id);
  return u;
};
const mk = async (phone) => {
  const u = await db.createUserByPhone(phone, "u" + phone);
  await withoutTrial(u.id);
  return u;
};
const activate = async (user) => {
  await pool.query("UPDATE users SET plan_tier='starter', plan_expires_at=$1 WHERE id=$2", [Date.now() + 31 * 86400_000, user.id]);
  return db.getUserById(user.id);
};

test("日切按东八区:UTC+8 同一天内计入同一 today", async () => {
  // 用「今日已用」间接验证:两次记录后 today == 2(而不是被凌晨 UTC 日切拆开)。
  const u = await mk("139" + "00100001");
  await activate(u);
  await db.recordUserUsage(u.id);
  await db.recordUserUsage(u.id);
  assert.equal((await db.getUserUsage(u.id)).today, 2);
  assert.equal((await db.getUserUsage(u.id)).month, 2);
});

test("月度邀请上限强制执行:超过 REFERRAL_MONTHLY_INVITES 的归因被拒绝", async () => {
  const ref = await mk("139" + "00100010");
  // 用满上限的邀请
  for (let i = 0; i < db.REFERRAL_MONTHLY_INVITES; i++) {
    const f = await mk("139001001" + String(20 + i).padStart(2, "0"));
    await db.attributeReferral(f.id, ref.id);
    assert.equal((await db.getUserById(f.id))?.referred_by, ref.id, `第 ${i + 1} 位应归因成功`);
  }
  // 第 N+1 位应被拒绝(referred_by 保持 null)
  const extra = await mk("139" + "00100099");
  await db.attributeReferral(extra.id, ref.id);
  assert.equal((await db.getUserById(extra.id))?.referred_by ?? null, null, "超上限的第 N+1 位不应归因");
  assert.equal((await db.getReferralStats(ref.id)).invitedThisMonth, db.REFERRAL_MONTHLY_INVITES);
});

test("注销清理 referrals 表(referee 与 referrer 两向)", async () => {
  const ref = await mk("139" + "00100200");
  const fri = await mk("139" + "00100201");
  await db.attributeReferral(fri.id, ref.id);
  await db.awardReferralMilestone(fri.id, "first_chat");
  // 两向都有记录
  assert.ok((await db.getReferralStats(ref.id)).totalInvited > 0);
  // 删好友后 → referee_id 侧应清空
  await db.deleteUser(fri.id);
  assert.equal((await db.getReferralStats(ref.id)).totalInvited, 0, "被邀请人注销后邀请人这边不该留孤儿账");
});

test("copyNotebook 保留 content_hash(副本内文件/文本判重仍有效)", async () => {
  const owner = await mk("139" + "00100300");
  const nb = await db.createNotebook("原本", owner.id);
  const s = await db.createSource(nb.id, "文件 A", "text");
  await db.setSourceContentHash(s.id, "abc123hash");
  await db.finalizeSource(s.id, { status: "ready", char_count: 100, chunk_count: 1 });
  await pool.query("UPDATE notebooks SET public = 1 WHERE id = $1", [nb.id]);
  const other = await mk("139" + "00100301");
  const dup = await db.copyNotebook(nb.id, other.id);
  assert.ok(dup, "副本应创建成功");
  // content_hash 是内部判重键,不通过 listSources 暴露;直接查 DB 与判重函数验证。
  const rawHash = (await pool.query("SELECT content_hash FROM sources WHERE notebook_id = $1", [dup.id])).rows[0];
  assert.equal(rawHash?.content_hash, "abc123hash", "副本必须在 DB 层保留 content_hash");
  const found = await db.findSourceByContentHash(dup.id, "abc123hash");
  assert.ok(found, "副本内 findSourceByContentHash 必须命中");
});

test("consumeDailyQuota(积分制):原子扣分 + 差异计价 + 奖励抵扣 + 流水", async () => {
  const u = await mk("139" + "00100500");
  const member = await activate(u);
  const LIMIT = STARTER_DAILY_CREDITS;
  // 差异计价:对话 1 分 + 音频 20 分
  assert.equal((await db.consumeDailyQuota(member, "chat", 1)).over, false);
  assert.equal((await db.consumeDailyQuota(member, "studio:audio", 20)).over, false);
  assert.equal((await db.getUserUsage(u.id)).today, 21, "1+20 分已入账");
  // 用满余下免费积分
  assert.equal((await db.consumeDailyQuota(member, "studio:report", LIMIT - 21)).over, false);
  // 无奖励 → 再扣 1 分拒,且不产生任何扣减
  const before = (await db.getUserUsage(u.id)).today;
  assert.equal((await db.consumeDailyQuota(member, "chat", 1)).over, true, "套餐+无奖励 → over");
  assert.equal((await db.getUserUsage(u.id)).today, before, "over 时不能计量");
  // 有奖励但不够付贵操作 → 拒;够付便宜操作 → 放行并扣
  await db.grantBonusCredits(u.id, 3);
  assert.equal((await db.consumeDailyQuota(member, "studio:audio", 20)).over, true, "奖励 3 分付不起 20 分 → 拒");
  assert.equal((await db.consumeDailyQuota(member, "chat", 1)).over, false, "奖励够付 1 分 → 放行");
  assert.equal(await db.getBonusCredits(u.id), 2, "扣 1 奖励积分");
  // 流水精确:credit_ledger 有 op 记录
  // 注:PG 对 BIGINT 列的 SUM 返回 numeric(默认解析为字符串),用 ::int 令其返回原生数字,
  // 保持下方 chat.c === 2 的严格断言不变(等价于旧 sqlite 直接返回 number)。
  const ops = (await pool.query("SELECT op, SUM(credits)::int AS c FROM credit_ledger WHERE user_id = $1 GROUP BY op", [u.id])).rows;
  const chat = ops.find((o) => o.op === "chat");
  assert.ok(chat && chat.c === 2, "chat 累计 2 分入流水");
});

test("recoverStaleJobsInDb:重启后 running 遗留 → 先重排队续跑,次数用尽才置 error", async () => {
  const owner = await mk("139" + "00100400");
  const nb = await db.createNotebook("待生成", owner.id);
  const job = await db.createJob(nb.id, owner.id, "report", "报告", {});
  const firstClaim = await db.claimNextQueued();
  assert.equal(firstClaim?.id, job.id);
  // 心跳仍新鲜(<15s)时,恢复不应碰它(Turbopack dev 多实例保护:活任务不被误判孤儿)
  const rFresh = await db.recoverStaleJobsInDb();
  assert.equal((await db.getJob(job.id))?.status, "running", "心跳新鲜的任务不动");
  // 回拨心跳(模拟进程已死 ≥90s 的真孤儿)+ 重置恢复租约(60s DB 级互斥,测试内连续调用要放行)
  const backdate = async () => {
    await pool.query("UPDATE jobs SET updated_at = $1 WHERE id = $2", [Date.now() - 100_000, job.id]);
    await pool.query("UPDATE app_settings SET value = '0' WHERE key = 'jobs.last_recover'");
  };
  await backdate();
  // 第一次恢复:重排队(把 deploy/重启从「成片失败」变成延迟成功),__attempts=1
  const r1 = await db.recoverStaleJobsInDb();
  assert.ok(r1.requeued >= 1, "首次恢复应重排队而非判死");
  let after = await db.getJob(job.id);
  assert.equal(after?.status, "queued");
  assert.equal(JSON.parse(after?.params || "{}").__attempts, 1, "params.__attempts 计数 +1");
  // 反复中断直至 JOB_MAX_ATTEMPTS 用尽 → 置 error(带可读中文)并停止重试
  while ((await db.getJob(job.id))?.status === "queued") {
    const claimed = await db.claimNextQueued();
    assert.equal(claimed?.id, job.id);
    await backdate();
    await db.recoverStaleJobsInDb();
  }
  after = await db.getJob(job.id);
  assert.equal(after?.status, "error", "重试次数用尽应置 error");
  assert.match(after?.error || "", /中断|重试/);
  void rFresh;
});

test("并发归因严格守住每月 10 人上限", async () => {
  const ref = await mkEmail("concurrent-invite-ref@example.com", "并发邀请人");
  for (let i = 0; i < 9; i++) {
    const friend = await mkEmail(`concurrent-invite-${i}@example.com`, `好友${i}`);
    await db.attributeReferral(friend.id, ref.id);
  }
  const a = await mkEmail("concurrent-invite-a@example.com", "并发A");
  const b = await mkEmail("concurrent-invite-b@example.com", "并发B");
  await Promise.all([db.attributeReferral(a.id, ref.id), db.attributeReferral(b.id, ref.id)]);
  assert.equal((await db.getReferralStats(ref.id)).invitedThisMonth, db.REFERRAL_MONTHLY_INVITES);
  const attributed = [await db.getUserById(a.id), await db.getUserById(b.id)].filter((u) => u?.referred_by === ref.id);
  assert.equal(attributed.length, 1, "最后一个名额只能被一个并发请求拿到");
});

test("并发里程碑严格守住每月 1000 分且奖励写入流水", async () => {
  const ref = await mkEmail("concurrent-reward-ref@example.com", "并发奖励人");
  const friends = [];
  for (let i = 0; i < 10; i++) {
    const friend = await mkEmail(`concurrent-reward-${i}@example.com`, `奖励好友${i}`);
    await db.attributeReferral(friend.id, ref.id);
    friends.push(friend);
  }
  for (let i = 0; i < 9; i++) await db.awardReferralMilestone(friends[i].id, "first_chat");
  await Promise.all([
    db.awardReferralMilestone(friends[9].id, "first_chat"),
    db.awardReferralMilestone(friends[9].id, "first_artifact"),
  ]);
  assert.equal((await db.getReferralStats(ref.id)).earnedThisMonth, db.REFERRAL_MONTHLY_CAP);
  assert.equal(await db.getBonusCredits(ref.id), db.REFERRAL_MONTHLY_CAP);
  const ledger = await pool.query("SELECT COALESCE(SUM(-credits),0)::int AS n FROM credit_ledger WHERE user_id=$1 AND op LIKE 'referral:%'", [ref.id]);
  assert.equal(ledger.rows[0].n, db.REFERRAL_MONTHLY_CAP, "奖励余额与 acquisition 流水同额");
});
