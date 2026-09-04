// 诚实性规则的【端到端断言】(R1 重做的验收闸,先红后绿)。
// 上一轮 P0 的教训:测试测的是 PG 原语(SKIP LOCKED/ON CONFLICT),不是业务编排 ——
// 本文件直接驱动 runFeedIngest 全链(真 HTTP fixture 抓取、真分块、真嵌入子进程),
// 断言的是设计 §7 诚实性规则本身:
//   ①回填不是更新(静默:0 简报 0 通知 0 未读,即使有订阅者)
//   ③徽章数 = 点进去看得到的篇数(回填条目不计未读)
//   ④简报不编造(薄源即使有 gist 也只列标题+链接 —— 纯函数单测)
//   幂等:同批双跑并发不双入库、简报恰一期、订阅者通知恰一条(确定性 id)
//   drain:含 ingesting 的批不算排空(死批不会让频道过早转 active)
//
// 环境:独占 PG 库(freshPgDb);LLM 无 key(guide 失败被吞,断言不依赖);
// 抓取走本地 fixture(NBLM_SSRF_ALLOW_LOCAL=1 测试逃生门);嵌入真跑子进程。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { freshPgDb } from "../helpers/pgdb.mjs";

process.env.NBLM_SSRF_ALLOW_LOCAL = "1"; // 仅测试:允许 ssrfSafeFetch 访问 127.0.0.1 fixture

const db = await freshPgDb("feed_e2e");
const { getPool } = await import("../../lib/pg.ts");
const jobs = await import("../../lib/jobs.ts");
const { buildFeedBrief } = await import("../../lib/feeds.ts");
const embedModule = await import("../../lib/embed.ts");
const embed = embedModule.shutdownEmbedWorker ? embedModule : embedModule.default;

// ---------- 本地文章 fixture(可控正文,不打真网) ----------
let baseUrl = "";
const server = http.createServer((req, res) => {
  if (req.url === "/a/boom") { req.socket.destroy(); return; } // 瞬态故障源:连接直接断
  if (req.url?.startsWith("/t/")) {
    // 薄源:有页面但无实质正文(反爬占位页形态)
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html><head><title>占位</title></head><body><p>请开启 JavaScript。</p></body></html>`);
    return;
  }
  const m = req.url?.match(/^\/a\/(\d+)/);
  if (m) {
    const body = `智库文章${m[1]}正文。`.repeat(120); // ~1000 字,过质量门
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html><head><title>报告 ${m[1]}</title></head><body><article><h1>报告 ${m[1]}</h1><p>${body}</p></article></body></html>`);
    return;
  }
  if (req.url === "/feed.xml") {
    // 条件请求语义:带匹配 etag 的轮询 → 304(RSS 没新文的常态)
    if (req.headers["if-none-match"] === '"v1"') { res.writeHead(304, { etag: '"v1"' }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/rss+xml", etag: '"v1"' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>测试源</title></channel></rss>`);
    return;
  }
  res.writeHead(404); res.end("nope");
});
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
  baseUrl = `http://127.0.0.1:${(server.address()).port}`;
});
after(async () => {
  // closeAllConnections 必须先行:extractUrl 的 keep-alive 连接不主动断,
  // 只调 close() 会等连接自然结束 → 测试进程永不退出(实锤:全量回归挂死 150s+)。
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await embed.shutdownEmbedWorker();
});

// ---------- 场景搭建 ----------
async function mkThinkTank({ status = "backfilling", withSubscriber = true } = {}) {
  const owner = await db.createUserByPhone(`138${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, "策展");
  const nb = await db.createNotebook(owner.id, "测试智库", "🏛️");
  await db.setNotebookFeatured(nb.id, { featured: true, publisher: "测试智库社" });
  await db.setNotebookPublic(nb.id, true);
  const chId = await db.createFeedChannel({ notebookId: nb.id, kind: "rss", url: `${baseUrl}/feed.xml` });
  if (status !== "backfilling") {
    await getPool().query("UPDATE feed_channels SET status = $2 WHERE id = $1", [chId, status]);
  }
  let subscriber = null;
  if (withSubscriber) {
    subscriber = await db.createUserByPhone(`139${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, "订阅者");
    await db.addFavorite(subscriber.id, nb.id, Date.now());
  }
  return { nb, chId, subscriber, owner };
}

async function seedItems(chId, n, { backfill, startAt = 1 } = {}) {
  for (let i = startAt; i < startAt + n; i++) {
    await db.recordFeedItem({
      channelId: chId, guid: `g-${chId}-${i}`, url: `${baseUrl}/a/${i}`, title: `报告 ${i}`, backfill,
    });
  }
}

const briefCount = async (nbId) =>
  Number((await getPool().query("SELECT COUNT(*) FROM notes WHERE notebook_id = $1 AND id LIKE 'feedbrief-%'", [nbId])).rows[0].count);
const feedNotifCount = async (userId) =>
  Number((await getPool().query("SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND type = 'feed'", [userId])).rows[0].count);

// ---------- ①③ 回填静默:0 简报 / 0 通知 / 0 未读,drain 后才转 active ----------
test("诚实性①③:回填批全程静默 —— 即使有订阅者,也不出简报不发通知不亮徽章", { timeout: 300_000 }, async () => {
  const { nb, chId, subscriber } = await mkThinkTank({ status: "backfilling" });
  await seedItems(chId, 3, { backfill: true });
  const batch = await db.claimFeedBatch(chId, "bf-batch-1", 5);
  assert.equal(batch.length, 3);
  await jobs.runFeedIngest(chId, "bf-batch-1");

  // 入库真的发生了(全链:fixture 抓取 → 分块 → 嵌入 → ready)
  const srcs = (await getPool().query(
    "SELECT status FROM sources WHERE notebook_id = $1", [nb.id])).rows;
  assert.equal(srcs.length, 3, "3 篇应真实入库");
  assert.ok(srcs.every((s) => s.status === "ready"), "全部应为 ready(嵌入真跑)");

  // 静默三断言
  assert.equal(await briefCount(nb.id), 0, "回填不出简报(诚实性①)");
  assert.equal(await feedNotifCount(subscriber.id), 0, "回填不发通知(诚实性①)");
  const unread = await db.unreadByNotebook(subscriber.id);
  assert.equal(unread.get(nb.id) ?? 0, 0, "回填条目不计未读徽章(诚实性③)");

  // 回填排空 → 频道转 active
  const ch = await db.getFeedChannel(chId);
  assert.equal(ch.status, "active", "pending 清空后应自动转 active");
});

// ---------- 真更新:恰一期简报 + 每订阅者恰一条通知;重复跑不加倍 ----------
test("真更新发布:一批=一期简报+每订阅者一条通知;同批重跑(超时重试语义)零重复", { timeout: 300_000 }, async () => {
  const { nb, chId, subscriber } = await mkThinkTank({ status: "active" });
  await seedItems(chId, 2, { backfill: false, startAt: 11 });
  const batch = await db.claimFeedBatch(chId, "up-batch-1", 5);
  assert.equal(batch.length, 2);
  await jobs.runFeedIngest(chId, "up-batch-1");

  assert.equal(await briefCount(nb.id), 1, "恰一期简报");
  assert.equal(await feedNotifCount(subscriber.id), 1, "订阅者恰一条通知");
  const unread = await db.unreadByNotebook(subscriber.id);
  assert.equal(unread.get(nb.id), 2, "未读=真的能看到的 2 篇(诚实性③)");

  // 模拟超时重试跑:同批再来一遍(listBatchPendingItems 已空,但批尾逻辑会再走)
  await jobs.runFeedIngest(chId, "up-batch-1");
  assert.equal(await briefCount(nb.id), 1, "重跑不出第二期(简报确定性 id)");
  assert.equal(await feedNotifCount(subscriber.id), 1, "重跑不重发通知(通知确定性 id)");
});

// ---------- 双跑并发:同批两个 runFeedIngest 同时跑,不双入库不双发 ----------
test("双跑并发(withJobTimeout 不杀底层的真场景):同 origin 零重复、简报一期、通知一条", { timeout: 300_000 }, async () => {
  const { nb, chId, subscriber } = await mkThinkTank({ status: "active" });
  await seedItems(chId, 3, { backfill: false, startAt: 21 });
  await db.claimFeedBatch(chId, "race-batch", 5);
  await Promise.all([
    jobs.runFeedIngest(chId, "race-batch"),
    jobs.runFeedIngest(chId, "race-batch"),
  ]);
  const dup = (await getPool().query(
    "SELECT origin, COUNT(*) c FROM sources WHERE notebook_id = $1 GROUP BY origin HAVING COUNT(*) > 1", [nb.id])).rows;
  assert.equal(dup.length, 0, `同一 origin 不得重复入库,实际重复:${JSON.stringify(dup)}`);
  assert.equal(await briefCount(nb.id), 1, "双跑简报仍恰一期");
  assert.equal(await feedNotifCount(subscriber.id), 1, "双跑通知仍恰一条");
});

// ---------- drain 判定:ingesting(死批半途)不算排空 ----------
test("drain 含 ingesting:死批半途的频道绝不过早转 active(回填身份不丢)", async () => {
  const { chId } = await mkThinkTank({ status: "backfilling", withSubscriber: false });
  await seedItems(chId, 2, { backfill: true, startAt: 31 });
  // 模拟死批:一条已被占位为 ingesting(job 半途死),一条已消化
  const items = (await getPool().query("SELECT id FROM feed_items WHERE channel_id = $1", [chId])).rows;
  await getPool().query("UPDATE feed_items SET status = 'ingesting', batch_id = 'dead' WHERE id = $1", [items[0].id]);
  await getPool().query("UPDATE feed_items SET status = 'ingested', batch_id = 'done' WHERE id = $1", [items[1].id]);
  await db.finishBackfillIfDrained(chId);
  assert.equal((await db.getFeedChannel(chId)).status, "backfilling",
    "还有 ingesting(死批)时不得转 active —— 否则孤儿回收后旧文会被当『新增』广播");
});

// ---------- 多批接力:消化不等 RSS 轮询周期 ----------
test("回填多批接力:批尾自动续排直到排空 —— 已枚举条目的消化不被 AIMD 轮询周期绑架", { timeout: 300_000 }, async () => {
  const { nb, chId, subscriber } = await mkThinkTank({ status: "backfilling" });
  await seedItems(chId, 7, { backfill: true, startAt: 41 }); // > FEED_BATCH_SIZE(5),必然跨批
  await db.claimFeedBatch(chId, "relay-b1", 5);
  await jobs.runFeedIngest(chId, "relay-b1");

  // 核心断言:批尾必须已续排下一批(否则剩余 2 条要等 3~6 小时后的下一次轮询 —— dev 实锤的停滞)
  const relay = (await getPool().query(
    "SELECT id, params FROM jobs WHERE kind = 'feed_ingest' AND status = 'queued' AND channel_id = $1", [chId])).rows;
  assert.ok(relay.length > 0, "批尾应续排下一批 ingest job(已枚举的 pending 不等下一次轮询)");

  // 手动扮演 worker(测试进程不自启 worker):逐个执行续排批直到排空
  for (let round = 0; round < 5; round++) {
    const rows = (await getPool().query(
      "SELECT id, params FROM jobs WHERE kind = 'feed_ingest' AND status = 'queued' AND channel_id = $1", [chId])).rows;
    if (!rows.length) break;
    for (const row of rows) {
      await getPool().query("UPDATE jobs SET status = 'done' WHERE id = $1", [row.id]);
      await jobs.runFeedIngest(chId, JSON.parse(row.params).batchId);
    }
  }

  const left = Number((await getPool().query(
    "SELECT COUNT(*) FROM feed_items WHERE channel_id = $1 AND status = 'pending'", [chId])).rows[0].count);
  assert.equal(left, 0, "接力应消化到排空");
  assert.equal((await db.getFeedChannel(chId)).status, "active", "排空后转 active");
  // 静默三查跨批仍成立(接力不破诚实性①③)
  assert.equal(await briefCount(nb.id), 0, "多批回填仍不出简报");
  assert.equal(await feedNotifCount(subscriber.id), 0, "多批回填仍不发通知");
  const unread = await db.unreadByNotebook(subscriber.id);
  assert.equal(unread.get(nb.id) ?? 0, 0, "多批回填仍不亮徽章");
});

// ---------- 304 存货接力:RSS 没新文 ≠ 没活干 ----------
test("轮询 304 也要消化存货:库里有 pending 时 notModified 早退必须先排 ingest(dev 实锤的无限期停滞)", { timeout: 300_000 }, async () => {
  const { chId } = await mkThinkTank({ status: "backfilling", withSubscriber: false });
  await seedItems(chId, 3, { backfill: true, startAt: 61 }); // 存货:已枚举未消化
  // 频道带 etag → 下一次轮询源站返 304;poll_token 对齐(runFeedEnum 的僵尸自检)
  await getPool().query(
    "UPDATE feed_channels SET etag = $2, poll_token = $3 WHERE id = $1", [chId, '"v1"', "tok-304"]);
  await jobs.runFeedEnum(chId, "tok-304");

  const relay = (await getPool().query(
    "SELECT params FROM jobs WHERE kind = 'feed_ingest' AND status = 'queued' AND channel_id = $1", [chId])).rows;
  assert.ok(relay.length > 0, "304 早退前必须认领存货并排 ingest —— 否则 etag 稳定的源存货永远没人消化");
  await jobs.runFeedIngest(chId, JSON.parse(relay[0].params).batchId);
  const left = Number((await getPool().query(
    "SELECT COUNT(*) FROM feed_items WHERE channel_id = $1 AND status = 'pending'", [chId])).rows[0].count);
  assert.equal(left, 0, "存货应被消化");
  assert.equal((await db.getFeedChannel(chId)).status, "active", "排空后转 active");
});

// ---------- 瞬态失败退避:接力不得把「两击重试」压缩成秒杀 ----------
test("瞬态失败退避:首败条目带时间退避,接力链不会秒级二连击把它永久判死", { timeout: 300_000 }, async () => {
  const { nb, chId } = await mkThinkTank({ status: "backfilling", withSubscriber: false });
  await db.recordFeedItem({ channelId: chId, guid: `boom-${chId}`, url: `${baseUrl}/a/boom`, title: "故障源", backfill: true });
  await seedItems(chId, 1, { backfill: true, startAt: 81 });
  await db.claimFeedBatch(chId, "f1-b1", 5);
  await jobs.runFeedIngest(chId, "f1-b1");

  const boom = (await getPool().query(
    "SELECT status, batch_id, retry_after FROM feed_items WHERE guid = $1", [`boom-${chId}`])).rows[0];
  assert.equal(boom.status, "pending", "首败应 release 回 pending(两击语义的第一击)");
  assert.equal(boom.batch_id, null, "release 应清 batch_id");
  assert.ok(Number(boom.retry_after) > Date.now(), "release 必须带时间退避 —— 否则批尾接力立刻重认领,瞬态故障秒级二连击 = 永久 failed");
  // 接力链对退避中的条目应「无活可干」:不再有排队中的 ingest job
  const queued = (await getPool().query(
    "SELECT COUNT(*) FROM jobs WHERE kind = 'feed_ingest' AND status = 'queued' AND channel_id = $1", [chId])).rows[0];
  assert.equal(Number(queued.count), 0, "池里只剩退避条目时接力应停(claim 0 条不排 job)");

  // 退避到期后:能被再次认领,二败才终态(恢复原「下一轮批再试」语义)
  await getPool().query("UPDATE feed_items SET retry_after = 0 WHERE guid = $1", [`boom-${chId}`]);
  const retry = await db.claimFeedBatch(chId, "f1-b2", 5);
  assert.equal(retry.length, 1, "退避到期的条目应可再认领");
  await jobs.runFeedIngest(chId, "f1-b2");
  const boom2 = (await getPool().query(
    "SELECT status FROM feed_items WHERE guid = $1", [`boom-${chId}`])).rows[0];
  assert.equal(boom2.status, "failed", "二败(error 位已占)才终态");
});

// ---------- 配额计尝试:失败/薄源抓取不能是免费的 ----------
test("日配额计『抓取尝试』而非『成功入库』:全薄批也要消耗配额 —— 否则接力把成本闸从抓取下面抽走", { timeout: 300_000 }, async () => {
  const { chId } = await mkThinkTank({ status: "backfilling", withSubscriber: false });
  for (let i = 1; i <= 3; i++) {
    await db.recordFeedItem({ channelId: chId, guid: `thin-${chId}-${i}`, url: `${baseUrl}/t/${i}`, title: `薄源 ${i}`, backfill: true });
  }
  await db.claimFeedBatch(chId, "f2-b1", 5);
  await jobs.runFeedIngest(chId, "f2-b1");
  const ch = (await getPool().query("SELECT daily_ingested FROM feed_channels WHERE id = $1", [chId])).rows[0];
  assert.equal(Number(ch.daily_ingested), 3, "3 次真实抓取(全 thin 零入库)应消耗 3 点配额");
});

// ---------- 孤儿回收后接力:复活的条目不能回到停滞 ----------
test("孤儿批回收后自动接力:死批条目复位的同一拍就排 ingest,不再等下一次轮询", { timeout: 300_000 }, async () => {
  const { chId } = await mkThinkTank({ status: "backfilling", withSubscriber: false });
  await seedItems(chId, 2, { backfill: true, startAt: 91 });
  // 造死批:条目被认领(其一半途 ingesting)、认领早于 2h、无任何活跃 ingest job
  await getPool().query(
    "UPDATE feed_items SET batch_id = 'dead-batch', status = 'ingesting', created_at = $2 WHERE channel_id = $1", [chId, Date.now() - 3 * 3600_000]);
  const rescued = await jobs.rescueOrphanFeedItems();
  assert.ok(rescued >= 1, "应回收到孤儿频道");
  const relay = (await getPool().query(
    "SELECT params FROM jobs WHERE kind = 'feed_ingest' AND status = 'queued' AND channel_id = $1", [chId])).rows;
  assert.ok(relay.length > 0, "回收的同一拍必须接力排 ingest(否则又停滞到下一次轮询,broken 频道则永久搁浅)");
  await jobs.runFeedIngest(chId, JSON.parse(relay[0].params).batchId);
  assert.equal((await db.getFeedChannel(chId)).status, "active", "复活条目消化后排空转 active");
});

// ---------- 停用频道:已排队的接力链不得继续入库 ----------
test("频道停用后:已在队列里的 ingest job 直接弃权,不再入库", { timeout: 300_000 }, async () => {
  const { nb, chId } = await mkThinkTank({ status: "backfilling", withSubscriber: false });
  await seedItems(chId, 1, { backfill: true, startAt: 96 });
  await db.claimFeedBatch(chId, "f6-b1", 5);
  await getPool().query("UPDATE feed_channels SET enabled = 0 WHERE id = $1", [chId]);
  await jobs.runFeedIngest(chId, "f6-b1");
  const n = Number((await getPool().query(
    "SELECT COUNT(*) FROM sources WHERE notebook_id = $1", [nb.id])).rows[0].count);
  assert.equal(n, 0, "停用频道的批不得入库(条目留 pending,由孤儿回收兜底)");
});

// ---------- ④ 简报不编造:纯函数分级(不依赖 LLM) ----------
test("诚实性④:正文 <300 字的条目即使带 gist 也只列标题+链接;全薄批返回 null(跳过简报)", () => {
  const thin = { title: "薄源报告", url: "https://x/thin", charCount: 60, gist: "LLM 基于 60 字编造的自信要点" };
  const fat = { title: "厚源报告", url: "https://x/fat", charCount: 5000, gist: "真实可用的要点概括" };

  const brief = buildFeedBrief([thin, fat]);
  assert.ok(brief, "有厚源时应产出简报");
  assert.ok(!brief.content.includes("编造的自信要点"), "薄源的 gist 绝不进简报(诚实性④)");
  assert.ok(brief.content.includes("正文未能获取全文"), "薄源行应诚实标注");
  assert.ok(brief.content.includes("真实可用的要点概括"), "厚源要点照常呈现");

  assert.equal(buildFeedBrief([thin]), null, "全薄批不出简报,只更时间线");
  assert.equal(buildFeedBrief([]), null, "空批不出简报");
});
