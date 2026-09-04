// 按用户用量计量 + 头像落库。(记忆空间模块已移除,相关测试随之删除)
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("memory_usage");

test("用量:recordUserUsage 累加,getUserUsage 返回今日/本月", async () => {
  const u = await db.createUserByPhone("138" + "00001002", "用量用户");
  const { getPool } = await import("../../lib/pg.ts");
  await getPool().query("UPDATE users SET plan_tier='starter', plan_expires_at=$1 WHERE id=$2", [Date.now() + 31 * 86400_000, u.id]);
  assert.deepEqual(await db.getUserUsage(u.id), { today: 0, month: 0 });
  await db.recordUserUsage(u.id);
  await db.recordUserUsage(u.id);
  await db.recordUserUsage(u.id, 2);
  const g = await db.getUserUsage(u.id);
  assert.equal(g.today, 4);
  assert.equal(g.month, 4);
});

test("头像:updateUserProfile {avatar} 落库", async () => {
  const u = await db.createUserByPhone("138" + "00001003", "头像用户");
  const data = "data:image/jpeg;base64,/9j/AAA";
  const upd = await db.updateUserProfile(u.id, { avatar: data });
  assert.equal(upd?.avatar, data);
  assert.equal((await db.getUserById(u.id))?.avatar, data);
});
