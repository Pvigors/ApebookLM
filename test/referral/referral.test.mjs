// 推广返利:归因、双里程碑幂等返利、月度上限、奖励额度抵扣配额。
// PG 测试库:freshPgDb 建独立库、返回全 async 的 lib/db。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb, withoutTrial } from "../helpers/pgdb.mjs";

const db = await freshPgDb("referral");
const { STARTER_DAILY_CREDITS } = await import("../../lib/plans.ts");
const { getPool } = await import("../../lib/pg.ts");

// 退掉注册赠送的试用额度:本文件验的是邀请返利与扣费口径,断言的都是绝对值,
// 混进 200 分试用积分会让返利绝对值断言失真。试用本身在 signup-trial.test.mjs 里验。
const mk = async (phone) => {
  const u = await db.createUserByPhone(phone, "u" + phone);
  await withoutTrial(u.id);
  return u;
};

test("邀请码:惰性生成、稳定、可反查", async () => {
  const a = await mk("139" + "00000001");
  const code = await db.getOrCreateInviteCode(a.id);
  assert.ok(code && code.length >= 6);
  assert.equal(await db.getOrCreateInviteCode(a.id), code, "重复取应稳定");
  assert.equal((await db.getUserByInviteCode(code))?.id, a.id);
});

test("归因:referred_by 一次性写入,不可覆盖 + signup 账本", async () => {
  const ref = await mk("139" + "00000010");
  const fri = await mk("139" + "00000011");
  await db.attributeReferral(fri.id, ref.id);
  assert.equal((await db.getUserById(fri.id))?.referred_by, ref.id);
  await db.attributeReferral(fri.id, (await mk("139" + "00000012")).id); // 再归因
  assert.equal((await db.getUserById(fri.id))?.referred_by, ref.id, "referred_by 不可被覆盖");
  assert.equal((await db.getReferralStats(ref.id)).invitedThisMonth, 1);
});

test("自我归因无效", async () => {
  const a = await mk("139" + "00000015");
  await db.attributeReferral(a.id, a.id);
  assert.equal((await db.getUserById(a.id))?.referred_by ?? null, null);
});

test("里程碑:双里程碑各返利一次,幂等不重复", async () => {
  const ref = await mk("139" + "00000020");
  const fri = await mk("139" + "00000021");
  await db.attributeReferral(fri.id, ref.id);

  await db.awardReferralMilestone(fri.id, "first_chat");
  assert.equal(await db.getBonusCredits(ref.id), db.REFERRAL_REWARD, "首次对话 +10");
  await db.awardReferralMilestone(fri.id, "first_chat"); // 重复
  assert.equal(await db.getBonusCredits(ref.id), db.REFERRAL_REWARD, "幂等:不重复返");

  await db.awardReferralMilestone(fri.id, "first_artifact");
  assert.equal(await db.getBonusCredits(ref.id), db.REFERRAL_REWARD * 2, "首个制品再 +10");

  const s = await db.getReferralStats(ref.id);
  assert.equal(s.earnedThisMonth, db.REFERRAL_REWARD * 2);
  assert.equal(s.totalEarned, db.REFERRAL_REWARD * 2);
});

test("无邀请人触发里程碑:不返利", async () => {
  const lone = await mk("139" + "00000030");
  await db.awardReferralMilestone(lone.id, "first_chat");
  assert.equal((await db.getReferralStats(lone.id)).totalEarned, 0);
});

test("月度赚取上限:封顶 REFERRAL_MONTHLY_CAP", async () => {
  const ref = await mk("139" + "00000050");
  // 造 (cap/reward)+2 个好友各完成两个里程碑,验证不超过上限
  const per = db.REFERRAL_REWARD;
  const need = Math.ceil(db.REFERRAL_MONTHLY_CAP / (per * 2)) + 2;
  for (let i = 0; i < need; i++) {
    const f = await mk("139001000" + String(10 + i).padStart(2, "0"));
    await db.attributeReferral(f.id, ref.id);
    await db.awardReferralMilestone(f.id, "first_chat");
    await db.awardReferralMilestone(f.id, "first_artifact");
  }
  assert.equal((await db.getReferralStats(ref.id)).earnedThisMonth, db.REFERRAL_MONTHLY_CAP, "本月赚取封顶");
  assert.equal(await db.getBonusCredits(ref.id), db.REFERRAL_MONTHLY_CAP);
});

test("奖励积分无需限时权益即可使用；启用权益后仍在每日积分用尽时抵扣", async () => {
  const ref = await mk("139" + "00000060");
  const fri = await mk("139" + "00000061");
  await db.attributeReferral(fri.id, ref.id);
  await db.awardReferralMilestone(fri.id, "first_chat"); // +REFERRAL_REWARD 积分
  const bonus0 = await db.getBonusCredits(ref.id);
  assert.equal(bonus0, db.REFERRAL_REWARD);

  let u = await db.getUserById(ref.id);
  const direct = await db.consumeDailyQuota(u, "chat", 1);
  assert.equal(direct.over, false, "仅持有奖励积分也应直接放行");
  assert.equal(await db.getBonusCredits(ref.id), bonus0 - 1, "应直接从奖励积分扣减");

  await getPool().query("UPDATE users SET plan_tier='starter', plan_expires_at=$1 WHERE id=$2", [Date.now() + 31 * 86400_000, ref.id]);
  u = await db.getUserById(ref.id);
  const limit = STARTER_DAILY_CREDITS;
  // 用满每日权益积分（一次扣 limit 分）
  const r1 = await db.consumeDailyQuota(u, "studio:report", limit);
  assert.equal(r1.over, false);
  // 每日权益用尽但有奖励积分 → 仍放行，差额从奖励扣
  const r2 = await db.consumeDailyQuota(u, "chat", 1);
  assert.equal(r2.over, false, "每日权益用尽但有奖励积分 → 放行");
  assert.equal(await db.getBonusCredits(ref.id), bonus0 - 2, "1 分从奖励积分抵扣");

  // 把奖励积分耗尽后再扣 → over
  await db.consumeDailyQuota(u, "studio:report", bonus0 - 2);
  assert.equal(await db.getBonusCredits(ref.id), 0);
  assert.equal((await db.consumeDailyQuota(u, "chat", 1)).over, true, "每日权益和奖励都用尽 → over");
});
