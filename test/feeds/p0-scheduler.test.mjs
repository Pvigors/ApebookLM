// P0-4 调度竞态核心:短租约抢占 / 失败补偿(fail_count 必须真的会涨)/ AIMD CAS 写回 /
// batch 认领幂等 / 简报恰一期。全部走独占 PG 库真 SQL,不打真网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("feed_sched");
const { getPool } = await import("../../lib/pg.ts");

async function mkChannel(overrides = {}) {
  const u = await db.createUserByPhone(`139${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, "t");
  const nb = await db.createNotebook(u.id, "智库", "🏛️");
  const id = await db.createFeedChannel({ notebookId: nb.id, kind: "rss", url: "https://x.example/feed" });
  // 新频道默认 backfilling(回填静默);本测试聚焦调度竞态,统一置回 active,需要时用 overrides 覆盖。
  await getPool().query("UPDATE feed_channels SET status = 'active' WHERE id = $1", [id]);
  for (const [k, v] of Object.entries(overrides)) {
    await getPool().query(`UPDATE feed_channels SET ${k} = $1 WHERE id = $2`, [v, id]);
  }
  return { id, nb, u };
}

test("抢占:到期才被抢,写短租约+token;未到期/manual/broken 不被抢", async () => {
  const a = await mkChannel({ next_poll_at: 0 }); // 到期
  const b = await mkChannel({ next_poll_at: Date.now() + 3600_000 }); // 未到期
  const c = await mkChannel({ next_poll_at: 0, kind: "manual" });
  const d = await mkChannel({ next_poll_at: 0, status: "broken" });
  const got = await db.claimDueFeedChannels(10);
  const ids = got.map((x) => x.id);
  assert.ok(ids.includes(a.id), "到期频道应被抢占");
  assert.ok(!ids.includes(b.id) && !ids.includes(c.id) && !ids.includes(d.id), "未到期/manual/broken 不该被抢");
  const ch = await db.getFeedChannel(a.id);
  assert.ok(ch.poll_token, "抢占应写 poll_token");
  const lease = ch.next_poll_at - Date.now();
  assert.ok(lease > 0 && lease <= db.FEED_LEASE_MS + 5_000, `短租约应 ≤10min,实际 ${lease}ms`);
  // 已被抢的(带 token 且租约未到)不会被再次抢
  const again = await db.claimDueFeedChannels(10);
  assert.ok(!again.map((x) => x.id).includes(a.id), "租约内不该被二次抢占");
});

test("失败补偿:租约过期仍带 token → fail_count+1,连败到阈值熔断 broken", async () => {
  const { id } = await mkChannel({ next_poll_at: 0, interval_minutes: 15 });
  for (let i = 1; i <= db.FEED_FAIL_BROKEN; i++) {
    const got = await db.claimDueFeedChannels(10); // 抢占(写 token)
    assert.ok(got.some((x) => x.id === id), `第 ${i} 轮应能抢到`);
    // 模拟 job 超时/进程死:不写回,直接把租约推成过期
    await getPool().query("UPDATE feed_channels SET next_poll_at = $1 WHERE id = $2", [Date.now() - 1000, id]);
    await db.compensateStaleFeedClaims();
    const ch = await db.getFeedChannel(id);
    assert.equal(ch.fail_count, i, `补偿后 fail_count 应为 ${i}(设计 rel-2:失败写回不依赖 job 自身)`);
    assert.equal(ch.poll_token, null, "补偿后应清 token(防重复计)");
    if (i < db.FEED_FAIL_BROKEN) {
      assert.equal(ch.status, "active");
      await getPool().query("UPDATE feed_channels SET next_poll_at = 0 WHERE id = $1", [id]); // 让下一轮立即到期
    } else {
      assert.equal(ch.status, "broken", "连败到阈值应熔断报警");
    }
  }
  // 二次补偿不重复计(token 已清)
  const before = (await db.getFeedChannel(id)).fail_count;
  await db.compensateStaleFeedClaims();
  assert.equal((await db.getFeedChannel(id)).fail_count, before, "无 token 不该重复计失败");
});

test("AIMD CAS 写回:有新内容收紧÷2、空转放宽×1.5、304 不动;错 token 弃写", async () => {
  const { id } = await mkChannel({ next_poll_at: 0, interval_minutes: 360 });
  let [ch] = await db.claimDueFeedChannels(1);
  assert.ok(await db.feedPollSuccess(id, ch.poll_token, { freshCount: 3, notModified: false }));
  let cur = await db.getFeedChannel(id);
  assert.equal(cur.interval_minutes, 180, "有新内容:360÷2=180");
  assert.equal(cur.fail_count, 0);
  assert.equal(cur.poll_token, null);

  await getPool().query("UPDATE feed_channels SET next_poll_at = 0 WHERE id = $1", [id]);
  [ch] = await db.claimDueFeedChannels(1);
  assert.ok(await db.feedPollSuccess(id, ch.poll_token, { freshCount: 0, notModified: false }));
  cur = await db.getFeedChannel(id);
  assert.equal(cur.interval_minutes, 270, "空转:180×1.5=270");

  await getPool().query("UPDATE feed_channels SET next_poll_at = 0 WHERE id = $1", [id]);
  [ch] = await db.claimDueFeedChannels(1);
  const won = await db.feedPollSuccess(id, "wrong-token", { freshCount: 5, notModified: false });
  assert.equal(won, false, "错 token(僵尸旧跑/运营手改后)必须弃写");
  cur = await db.getFeedChannel(id);
  assert.equal(cur.interval_minutes, 270, "弃写后 interval 不变");
  assert.ok(cur.poll_token, "弃写不清别人的 token");
  assert.ok(await db.feedPollSuccess(id, ch.poll_token, { freshCount: 0, notModified: true }));
  cur = await db.getFeedChannel(id);
  assert.equal(cur.interval_minutes, 270, "304 空转不改 interval");
});

test("批认领幂等:两批不重叠;断点续作只取 pending;简报恰一期", async () => {
  const { id, nb } = await mkChannel({});
  for (let i = 0; i < 8; i++) await db.recordFeedItem({ channelId: id, guid: `g${i}`, title: `文${i}`, url: `https://x/${i}` });
  const b1 = await db.claimFeedBatch(id, "batch-A", 5);
  assert.equal(b1.length, 5);
  const b2 = await db.claimFeedBatch(id, "batch-B", 5); // 并发双跑场景:同池再认领
  assert.equal(b2.length, 3, "第二批只能拿到剩余 3 条(batch_id IS NULL 闸)");
  const overlap = b1.filter((x) => b2.some((y) => y.id === x.id));
  assert.equal(overlap.length, 0, "两批绝不重叠 —— 双跑重复入库的根被斩断");

  // 断点续作:batch-A 处理了 2 条后重试,listBatchPendingItems 只回剩下 3 条
  await db.setFeedItemStatus(b1[0].id, "ingested", { sourceId: "s1" });
  await db.setFeedItemStatus(b1[1].id, "skipped");
  const rest = await db.listBatchPendingItems("batch-A");
  assert.equal(rest.length, 3, "重试跑只处理批内仍 pending 的条目");

  // 简报幂等:同 batchId 第二次 upsert 不再插入(超时重试跑到批尾也只有一期)
  assert.equal(await db.upsertFeedBriefNote(nb.id, "batch-A", "更新简报", "本期 2 篇"), true);
  assert.equal(await db.upsertFeedBriefNote(nb.id, "batch-A", "更新简报", "本期 2 篇"), false, "同批第二次必须幂等");
});

test("每日配额:窗口内累加,跨日归零", async () => {
  const { id } = await mkChannel({});
  assert.equal(await db.feedDailyRemaining(id), db.FEED_DAILY_LIMIT);
  await db.bumpFeedDailyIngested(id, 28);
  assert.equal(await db.feedDailyRemaining(id), db.FEED_DAILY_LIMIT - 28);
  // 模拟昨天的窗口
  await getPool().query("UPDATE feed_channels SET daily_reset_at = $1 WHERE id = $2", [Date.now() - 48 * 3600_000, id]);
  assert.equal(await db.feedDailyRemaining(id), db.FEED_DAILY_LIMIT, "跨日应重置");
});

test("parseFeedXml:RSS2/Atom/CDATA/畸形输入", async () => {
  const { parseFeedXml, parseDate } = await import("../../lib/feeds.ts");
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[报告 A & 分析]]></title><link>https://x/a</link><guid>guid-a</guid><pubDate>Wed, 15 Jul 2026 08:00:00 GMT</pubDate></item>
    <item><title>报告 B</title><link>https://x/b</link></item>
  </channel></rss>`;
  const r = parseFeedXml(rss);
  assert.equal(r.length, 2);
  assert.equal(r[0].guid, "guid-a");
  assert.equal(r[0].title, "报告 A & 分析", "CDATA+实体应清干净");
  assert.ok(r[0].publishedAt > 0);
  assert.equal(r[1].guid, "https://x/b", "无 guid 回落 link");

  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><id>tag:x,2026:1</id><title>Atom 文</title><link rel="alternate" href="https://x/atom1"/><published>2026-07-15T08:00:00Z</published></entry>
  </feed>`;
  const a = parseFeedXml(atom);
  assert.equal(a.length, 1);
  assert.equal(a[0].url, "https://x/atom1", "Atom link 取 rel=alternate 的 href");

  // 畸形:未闭合/嵌套 CDATA 垃圾 —— 只要不抛不挂,解析出 0..n 条都算通过(非回溯保证)
  const bad = "<rss><item><title>x".repeat(2000);
  const t0 = Date.now();
  const out = parseFeedXml(bad);
  assert.ok(Date.now() - t0 < 2000, "畸形输入必须毫秒级返回(禁灾难性回溯)");
  assert.ok(Array.isArray(out));

  // Bruegel 式非标日期
  assert.ok(parseDate("Thu, 07/16/2026 - 14:05") > 0, "Bruegel 非标 pubDate 需兼容");
});
