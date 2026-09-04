// 领域智库订阅 P0-1 数据地基:两表两列、feed CRUD、诚实性未读计数、editorial 迁移。
// 独占 PG 库(freshPgDb),真跑 initSchema(验 DDL/addCol 语法)+ 逐条 CRUD。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("feed_p0");
// getPool 必须在 freshPgDb 设好 DATABASE_URL【之后】才 import(动态),否则池会抢先连开发库。
const { getPool } = await import("../../lib/pg.ts");

test("initSchema 建出 feed 两表两列(DDL/addCol 语法正确)", async () => {
  const tbl = await getPool().query(
    "SELECT table_name FROM information_schema.tables WHERE table_name IN ('feed_channels','feed_items')"
  );
  assert.equal(tbl.rowCount, 2, "feed_channels + feed_items 都应建出");
  const col = await getPool().query(
    `SELECT column_name FROM information_schema.columns
       WHERE (table_name='notebook_favorites' AND column_name IN ('last_seen_at','muted'))
          OR (table_name='notebooks' AND column_name='editorial_note')`
  );
  assert.equal(col.rowCount, 3, "last_seen_at/muted/editorial_note 三列都应加出");
});

test("feed_channels/feed_items CRUD + UNIQUE 去重", async () => {
  const u = await db.createUserByPhone("139" + "00010001", "策展人");
  const nb = await db.createNotebook(u.id, "兰德公司", "🎖️");
  const chId = await db.createFeedChannel({
    notebookId: nb.id, kind: "rss", url: "https://rand.org/pubs/new.xml",
    config: { ua: true }, intervalMinutes: 360, createdBy: u.id,
  });
  const ch = await db.getFeedChannel(chId);
  assert.equal(ch.kind, "rss");
  assert.equal(ch.enabled, 1);
  assert.equal(JSON.parse(ch.config).ua, true);
  assert.equal((await db.listFeedChannels(nb.id)).length, 1);

  // 首见 = 新插入;重复 guid = 去重返回 false
  assert.equal(await db.recordFeedItem({ channelId: chId, guid: "g1", title: "报告A", url: "https://x/1" }), true);
  assert.equal(await db.recordFeedItem({ channelId: chId, guid: "g1", title: "报告A" }), false, "同 guid 应被 UNIQUE 去重");
  const items = await db.listFeedItems(chId);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "pending");
  assert.equal(items[0].ingested_at, null);

  // 标记入库 → ingested_at 落
  await db.setFeedItemStatus(items[0].id, "ingested", { sourceId: "src-1" });
  const after = await db.findFeedItem(chId, "g1");
  assert.equal(after.status, "ingested");
  assert.ok(after.ingested_at > 0, "ingested 时应落 ingested_at");
  assert.equal(after.source_id, "src-1");
});

test("订阅游标 + 诚实性未读:只计 ingested 且晚于游标的条目", async () => {
  const u = await db.createUserByPhone("139" + "00010002", "订阅者");
  const nb = await db.createNotebook(u.id, "NBER", "📊");
  const chId = await db.createFeedChannel({ notebookId: nb.id, kind: "rss", url: "https://nber.org/rss" });

  const t0 = Date.now() - 100000;
  // 订阅前就存在的旧条目(ingested,但订阅时游标=now → 不算未读)
  await db.recordFeedItem({ channelId: chId, guid: "old1", title: "旧文" });
  await db.setFeedItemStatus((await db.findFeedItem(chId, "old1")).id, "ingested");

  // 订阅:last_seen_at = now(订阅前历史不算未读)
  const subAt = Date.now();
  await db.addFavorite(u.id, nb.id, subAt);
  const m0 = await db.unreadByNotebook(u.id);
  assert.equal(m0.get(nb.id) ?? 0, 0, "订阅那刻:历史旧文不算未读(诚实性②)");

  // 订阅后新入库 3 篇(ingested_at > 游标)+ 1 篇 skipped(薄源,不该计)
  for (const [index, g] of ["n1", "n2", "n3"].entries()) {
    await db.recordFeedItem({ channelId: chId, guid: g, title: g });
    const item = await db.findFeedItem(chId, g);
    await db.setFeedItemStatus(item.id, "ingested");
    // Date.now() 毫秒粒度下，订阅游标与首篇入库可能同毫秒；显式固定为游标之后，
    // 测试语义不应依赖机器快慢。
    await getPool().query("UPDATE feed_items SET ingested_at=$1 WHERE id=$2", [subAt + index + 1, item.id]);
  }
  await db.recordFeedItem({ channelId: chId, guid: "skip1", title: "薄源" });
  await db.setFeedItemStatus((await db.findFeedItem(chId, "skip1")).id, "skipped");

  const m1 = await db.unreadByNotebook(u.id);
  assert.equal(m1.get(nb.id), 3, "只计 ingested、且晚于游标的 3 篇(skipped 不计 —— 诚实性③)");

  // 打开频道页推进游标 → 未读清零(只前进)
  await db.setFavoriteSeen(u.id, nb.id, Date.now() + 1);
  const m2 = await db.unreadByNotebook(u.id);
  assert.equal(m2.get(nb.id) ?? 0, 0, "游标推进后未读清零");
});

test("editorial 迁移三件套:门面弹窗写 editorial_note、backfill 幂等", async () => {
  const u = await db.createUserByPhone("139" + "00010003", "运营");
  const nb = await db.createNotebook(u.id, "旧精选", "📓");
  // 模拟存量:featured=1 且编者按曾写在 summary(旧世界)
  await getPool().query(
    "UPDATE notebooks SET featured=1, public=1, summary='老编者按', editorial_note=NULL WHERE id=$1",
    [nb.id]
  );
  // 重跑 initSchema(幂等):backfill 应把 summary 搬进 editorial_note
  await db.initSchema();
  const r = await getPool().query("SELECT summary, editorial_note FROM notebooks WHERE id=$1", [nb.id]);
  assert.equal(r.rows[0].editorial_note, "老编者按", "backfill 应把存量编者按搬进 editorial_note");
});
