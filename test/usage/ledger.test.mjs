// 积分用量分页 getLedgerPage:筛选(all/acquired/consumed)+ 游标分页 + 排除 credits=0 留痕。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb, withoutTrial } from "../helpers/pgdb.mjs";

const db = await freshPgDb("ledger");
const { getPool } = await import("../../lib/pg.ts");
const { STARTER_DAILY_CREDITS } = await import("../../lib/plans.ts");
const { finalStudioCreditsForOutput, studioCreditsFromTokenUsage } = await import("../../lib/credits.ts");

// 本文件验的是台账/扣费/退款的精确数值,一律从零余额起算;
// 注册赠送的试用积分会污染每一条断言,建完即退掉。
const mkUser = async (email, name) => {
  const u = await db.createUserByEmail(email, name);
  await withoutTrial(u.id);
  return u;
};

const activate = async (user) => {
  await getPool().query("UPDATE users SET plan_tier='starter', plan_expires_at=$1 WHERE id=$2", [Date.now() + 31 * 86400_000, user.id]);
  return db.getUserById(user.id);
};

const u = await mkUser("ledger@example.com", "台账测试");
// 按时间顺序插入(id 递增 = 时间顺序):3 消耗(credits 正)+ 2 入账(credits 负)+ 1 留痕(0,应排除)
const rows = [
  ["chat", 1], ["studio:video", 30], ["admin:grant", -50],
  ["studio:mindmap", 5], ["refund:chat", -1], ["pay:wechat", 0],
];
let ts = 1_700_000_000_000;
for (const [op, c] of rows) {
  await getPool().query("INSERT INTO credit_ledger (user_id, op, credits, bonus, ts) VALUES ($1,$2,$3,0,$4)", [u.id, op, c, ts++]);
}

test("all:排除 0 分留痕,倒序,change 反号", async () => {
  const { entries, hasMore } = await db.getLedgerPage(u.id, { type: "all" });
  assert.equal(entries.length, 5, "6 条里排除 1 条 credits=0 → 5 条");
  assert.equal(hasMore, false);
  assert.ok(entries.every((e) => e.op !== "pay:wechat"), "0 分留痕被排除");
  // 最新在前:最后插入的非零是 refund:chat(credits=-1)
  assert.equal(entries[0].op, "refund:chat");
  // 反号:消耗 credits>0、入账 credits<0(展示层再取 -credits)
  const chat = entries.find((e) => e.op === "chat");
  assert.equal(chat.credits, 1, "消耗台账记正");
  const grant = entries.find((e) => e.op === "admin:grant");
  assert.equal(grant.credits, -50, "入账台账记负");
});

test("consumed / acquired 筛选", async () => {
  const consumed = await db.getLedgerPage(u.id, { type: "consumed" });
  assert.deepEqual(consumed.entries.map((e) => e.op).sort(), ["chat", "studio:mindmap", "studio:video"]);
  const acquired = await db.getLedgerPage(u.id, { type: "acquired" });
  assert.deepEqual(acquired.entries.map((e) => e.op).sort(), ["admin:grant", "refund:chat"]);
});

test("游标分页 hasMore + before", async () => {
  const p1 = await db.getLedgerPage(u.id, { type: "all", limit: 2 });
  assert.equal(p1.entries.length, 2);
  assert.equal(p1.hasMore, true, "还有更多");
  const p2 = await db.getLedgerPage(u.id, { type: "all", limit: 2, beforeId: p1.entries[1].id });
  assert.equal(p2.entries.length, 2);
  assert.ok(p2.entries[0].id < p1.entries[1].id, "第二页 id 更小(更早)");
  // 两页不重叠
  const ids = new Set([...p1.entries, ...p2.entries].map((e) => e.id));
  assert.equal(ids.size, 4, "两页共 4 条不重复");
});

test("note 笔记本名往返 + consumeDailyQuota 落 note", async () => {
  const u2 = await mkUser("noteledger@example.com", "笔记本名");
  const member = await activate(u2);
  await db.consumeDailyQuota(member, "studio:slides", 8, "设计规范手册");
  await db.consumeDailyQuota(member, "chat", 1, "世界杯全解析");
  const { entries } = await db.getLedgerPage(u2.id, { type: "all" });
  const slides = entries.find((e) => e.op === "studio:slides");
  assert.equal(slides.note, "设计规范手册", "笔记本名快照落库并回读");
  const chat = entries.find((e) => e.op === "chat");
  assert.equal(chat.note, "世界杯全解析");
});

test("daySpent = 当日累计消耗(余额基数);跨页/跨日正确", async () => {
  const u3 = await mkUser("balance@example.com", "余额");
  // 同一东八区自然日内三笔消耗(id 递增=时间序):5, 30, 1;dayspent 应为 5 / 35 / 36。
  const day0 = 1_700_000_000_000; // 任取,同日
  const seq = [["studio:mindmap", 5], ["studio:video", 30], ["chat", 1]];
  let t = day0;
  for (const [op, c] of seq) {
    await getPool().query("INSERT INTO credit_ledger (user_id, op, credits, bonus, ts) VALUES ($1,$2,$3,0,$4)", [u3.id, op, c, t]);
    t += 60_000;
  }
  // 次日一笔:dayspent 应重新从该笔算起(=2),不含前一日的 36。
  await getPool().query("INSERT INTO credit_ledger (user_id, op, credits, bonus, ts) VALUES ($1,$2,$3,0,$4)", [u3.id, "chat", 2, day0 + 30 * 3600_000]);

  const { entries } = await db.getLedgerPage(u3.id, { type: "all", limit: 10 });
  const bySpentByOp = Object.fromEntries(entries.map((e) => [`${e.op}:${e.credits}`, e.daySpent]));
  assert.equal(bySpentByOp["studio:mindmap:5"], 5, "第一笔累计 5");
  assert.equal(bySpentByOp["studio:video:30"], 35, "累计 5+30=35");
  assert.equal(bySpentByOp["chat:1"], 36, "累计 35+1=36");
  assert.equal(bySpentByOp["chat:2"], 2, "跨日重置,次日首笔累计=2(不含前日 36)");

  // 分页不改变 daySpent:窗口在全量账本上算,翻到第二页也对。
  const p1 = await db.getLedgerPage(u3.id, { type: "all", limit: 2 });
  const p2 = await db.getLedgerPage(u3.id, { type: "all", limit: 2, beforeId: p1.entries[1].id });
  const video = [...p1.entries, ...p2.entries].find((e) => e.op === "studio:video");
  assert.equal(video.daySpent, 35, "翻页后 video 当日累计仍为 35(窗口在全量上算)");
});

test("任务成功收尾：状态、真实 Token 与差额退款原子结算", async () => {
  const u4 = await mkUser("settlement@example.com", "结算测试");
  const member = await activate(u4);
  const nb = await db.createNotebook(u4.id, "Token 结算本", "📓");
  // 先用到只剩 2 套餐积分，再用 8 分生成：2 分走套餐额度、6 分走奖励积分。
  await db.consumeDailyQuota(member, "setup", STARTER_DAILY_CREDITS - 2, nb.title);
  await db.grantBonusCredits(u4.id, 10);
  const charge = await db.consumeDailyQuota(member, "studio:slides", 8, nb.title);
  assert.ok(charge.ledgerId > 0, "扣费返回精确流水 id");
  assert.equal(await db.getBonusCredits(u4.id), 4);

  const job = await db.createJob(nb.id, u4.id, "slides", "演示文稿", {
    __creditLedgerId: charge.ledgerId,
  });
  await db.setJobReservedCredits(job.id, 8);
  const claimed = await db.claimNextQueued();
  assert.equal(claimed?.id, job.id);
  const output = await db.createStudioOutputForRun(
    job.id, claimed.run_attempt, nb.id, "slides", "结算测试产物", "{}"
  );
  assert.ok(output);
  const won = await db.finalizeJobDone(job.id, output.id, {
    userId: u4.id,
    op: "studio:slides",
    reservedCredits: 8,
    finalCredits: 3,
    tokensIn: 2_000,
    tokensOut: 600,
    notebookTitle: nb.title,
    ledgerId: charge.ledgerId,
  }, claimed.run_attempt);
  assert.equal(won, true);

  const done = await db.getJob(job.id);
  assert.equal(done.status, "done");
  assert.equal(done.credits_reserved, 8);
  assert.equal(done.credits_final, 3);
  assert.equal(done.tokens_in, 2_000);
  assert.equal(done.tokens_out, 600);
  assert.equal(
    (await db.getUserUsage(u4.id)).today,
    STARTER_DAILY_CREDITS,
    "套餐桶只记到每日上限，最终第 3 分来自奖励桶"
  );
  assert.equal(await db.getBonusCredits(u4.id), 9, "差额 5 分优先退回奖励口袋");

  const settle = (
    await getPool().query(
      "SELECT credits, bonus, note FROM credit_ledger WHERE user_id=$1 AND op='settle:studio:slides'",
      [u4.id]
    )
  ).rows[0];
  assert.equal(settle.credits, -5);
  assert.equal(settle.bonus, -5);
  assert.match(settle.note, /实际 Token 2600/);
});

test("CAD 教学示例预留 12 分后最终结算 5 分并原子退回 7 分", async () => {
  const user = await mkUser("cad-tutorial-settlement@example.com", "CAD 教学结算");
  const member = await activate(user);
  const notebook = await db.createNotebook(user.id, "CAD 教学结算本", "📐");
  const charge = await db.consumeDailyQuota(member, "studio:cad", 12, notebook.title);
  const job = await db.createJob(notebook.id, user.id, "cad", "CAD 模型", {
    __creditLedgerId: charge.ledgerId,
  });
  await db.setJobReservedCredits(job.id, 12);
  const claimed = await db.claimNextQueued();
  assert.equal(claimed?.id, job.id);
  const output = await db.createStudioOutputForRun(
    job.id,
    claimed.run_attempt,
    notebook.id,
    "cad",
    "教学示例：四孔安装平板",
    "{}",
    JSON.stringify({ modelSelection: { tutorialExample: true } })
  );
  assert.ok(output);
  const quote = studioCreditsFromTokenUsage("cad", 0, 0, 12);
  const finalCredits = finalStudioCreditsForOutput("cad", 12, quote.credits, output.data);
  assert.equal(finalCredits, 5);
  assert.equal(await db.finalizeJobDone(job.id, output.id, {
    userId: user.id,
    op: "studio:cad",
    reservedCredits: 12,
    finalCredits,
    tokensIn: 0,
    tokensOut: 0,
    notebookTitle: notebook.title,
    ledgerId: charge.ledgerId,
  }, claimed.run_attempt), true);

  const done = await db.getJob(job.id);
  assert.equal(done.credits_reserved, 12);
  assert.equal(done.credits_final, 5);
  const settlement = (
    await getPool().query(
      "SELECT credits FROM credit_ledger WHERE user_id=$1 AND op='settle:studio:cad' ORDER BY id DESC LIMIT 1",
      [user.id]
    )
  ).rows[0];
  assert.equal(Number(settlement.credits), -7);
  assert.equal((await db.getUserUsage(user.id)).today, 5);
});

test("跨东八区日退款把套餐积分转为可用奖励补偿", async () => {
  const u5 = await mkUser("crossday-refund@example.com", "跨日退款");
  const member = await activate(u5);
  const charge = await db.consumeDailyQuota(member, "studio:briefing", 5, "跨日任务");
  assert.ok(charge.ledgerId);
  const yesterday = Date.now() - 86400_000;
  const oldDay = Math.floor((yesterday + 8 * 3600_000) / 86400_000);
  await getPool().query("UPDATE credit_ledger SET ts=$1 WHERE id=$2", [yesterday, charge.ledgerId]);
  await getPool().query("UPDATE user_usage SET day=$1 WHERE user_id=$2", [oldDay, u5.id]);

  await db.refundCredits(u5.id, "studio:briefing", 5, charge.ledgerId);
  assert.equal(await db.getBonusCredits(u5.id), 5, "过期日额度必须转成可结转补偿");
  const refund = (
    await getPool().query(
      "SELECT credits, bonus, plan_credits, note FROM credit_ledger WHERE user_id=$1 AND op='refund:studio:briefing'",
      [u5.id]
    )
  ).rows[0];
  assert.deepEqual(
    { credits: Number(refund.credits), bonus: Number(refund.bonus), plan: Number(refund.plan_credits) },
    { credits: -5, bonus: -5, plan: 0 }
  );
  assert.match(refund.note, /跨日套餐积分转奖励补偿 5/);
});

test("精确退款：缺失或错误 ledgerId 不得制造幻影退款，重复请求幂等", async () => {
  const u6 = await mkUser("exact-refund@example.com", "精确退款");
  const member = await activate(u6);
  const charge = await db.consumeDailyQuota(member, "chat", 1);
  assert.ok(charge.ledgerId);
  const before = await db.getUserUsage(u6.id);
  await db.refundCredits(u6.id, "chat", 1, Number(charge.ledgerId) + 99999);
  assert.deepEqual(await db.getUserUsage(u6.id), before, "错误 id 不得回冲用量");
  assert.equal(
    Number((await getPool().query("SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id=$1 AND op='refund:chat'", [u6.id])).rows[0].n),
    0
  );
  await db.refundCredits(u6.id, "chat", 1, charge.ledgerId);
  await db.refundCredits(u6.id, "chat", 1, charge.ledgerId);
  assert.equal(
    Number((await getPool().query("SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id=$1 AND op='refund:chat'", [u6.id])).rows[0].n),
    1,
    "同一扣费只能退款一次"
  );
});

test("异步制品扣费与 job 激活原子：queued 时预留价和 ledgerId 必已固化", async () => {
  const u7 = await mkUser("atomic-job@example.com", "原子任务");
  await activate(u7);
  const notebook = await db.createNotebook(u7.id, "原子任务本", "⚛️");
  const draft = await db.createJob(
    notebook.id, u7.id, "slides", "演示文稿", { __watermark: false }, 0, null, "draft"
  );
  assert.equal((await db.getJob(draft.id)).status, "draft");
  const activated = await db.activateChargedJob(draft.id, u7.id, "studio:slides", 8, notebook.title);
  assert.equal(activated.over, false);
  assert.ok(activated.ledgerId);
  assert.equal(activated.job.status, "queued");
  assert.equal(activated.job.credits_reserved, 8);
  const params = JSON.parse(activated.job.params);
  assert.equal(params.__reservedCredits, 8);
  assert.equal(params.__creditLedgerId, activated.ledgerId);
  assert.equal(params.__watermark, false);
  assert.equal(await db.cancelJobAndQueueRefund(activated.job.id), true);
  await db.processCreditRefundOutbox();

  const free = await mkUser("atomic-job-free@example.com", "非会员原子任务");
  const freeBook = await db.createNotebook(free.id, "非会员历史本", "📕");
  const blockedDraft = await db.createJob(freeBook.id, free.id, "briefing", "简报", {}, 0, null, "draft");
  const blocked = await db.activateChargedJob(blockedDraft.id, free.id, "studio:briefing", 5, freeBook.title);
  assert.equal(blocked.over, true);
  assert.equal(await db.getJob(blockedDraft.id), undefined, "拒绝扣费时 draft 同事务删除");
});

test("任务终判与退款 outbox 原子：进程重启后仍可完成补偿", async () => {
  const u8 = await mkUser("refund-outbox@example.com", "退款Outbox");
  await activate(u8);
  const notebook = await db.createNotebook(u8.id, "退款Outbox本", "📮");
  const draft = await db.createJob(notebook.id, u8.id, "briefing", "简报", {}, 0, null, "draft");
  const activated = await db.activateChargedJob(draft.id, u8.id, "studio:briefing", 5, notebook.title);
  const run = await db.claimNextQueued();
  assert.equal(run.id, draft.id);
  assert.equal((await db.getUserUsage(u8.id)).today, 5);

  assert.equal(await db.failJobAndQueueRefund(run.id, run.run_attempt, "模拟终判失败"), true);
  const pending = (
    await getPool().query("SELECT state FROM credit_refund_outbox WHERE ledger_id=$1", [activated.ledgerId])
  ).rows[0];
  assert.equal(pending.state, "pending", "终态提交时退款意图必须已持久化");
  assert.equal((await db.getJob(run.id)).status, "error");

  assert.equal(await db.processCreditRefundOutbox(), 1);
  assert.equal((await db.getUserUsage(u8.id)).today, 0);
  const done = (
    await getPool().query("SELECT state FROM credit_refund_outbox WHERE ledger_id=$1", [activated.ledgerId])
  ).rows[0];
  assert.equal(done.state, "done");
});

test("取消与完成并发只能有一个赢家，积分与产物保持同一终态", async () => {
  const u9 = await mkUser("cancel-finalize-race@example.com", "取消完成竞态");
  await activate(u9);
  const notebook = await db.createNotebook(u9.id, "取消完成竞态本", "🏁");
  const draft = await db.createJob(notebook.id, u9.id, "briefing", "简报", {}, 0, null, "draft");
  const activated = await db.activateChargedJob(draft.id, u9.id, "studio:briefing", 5, notebook.title);
  const run = await db.claimNextQueued();
  const output = await db.createStudioOutputForRun(
    run.id, run.run_attempt, notebook.id, "briefing", "竞态产物", "content"
  );
  const [canceled, finalized] = await Promise.all([
    db.cancelJobAndQueueRefund(run.id),
    db.finalizeJobDone(run.id, output.id, {
      userId: u9.id,
      op: "studio:briefing",
      reservedCredits: 5,
      finalCredits: 5,
      tokensIn: 100,
      tokensOut: 20,
      ledgerId: activated.ledgerId,
    }, run.run_attempt),
  ]);
  assert.equal(Number(canceled) + Number(finalized), 1, "cancel/finalize 必须由 job 行锁单选");
  const terminal = await db.getJob(run.id);
  if (finalized) {
    assert.equal(terminal.status, "done");
    assert.equal((await db.getStudioOutput(output.id))?.status, "ready");
    assert.equal((await db.getUserUsage(u9.id)).today, 5);
  } else {
    assert.equal(terminal.status, "canceled");
    assert.equal(await db.getStudioOutput(output.id), undefined, "processing 产物对用户不可见");
    await db.processCreditRefundOutbox();
    assert.equal((await db.getUserUsage(u9.id)).today, 0);
  }
});
