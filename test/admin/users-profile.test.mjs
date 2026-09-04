// 后台用户资料回归：微信名与产品昵称分离、登录会话原子计数、存量会话保守回填。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("admin_users_profile");
const { getPool } = await import("../../lib/pg.ts");
const pool = getPool();

test("用户表使用紧凑固定列宽，首列不再吞掉整行剩余空间", () => {
  const source = fs.readFileSync(new URL("../../app/admin/users/page.tsx", import.meta.url), "utf8");
  assert.match(source, /min-w-\[1328px\] table-fixed/);
  assert.match(source, /<col className="w-\[190px\]" \/>/);
  assert.doesNotMatch(source, /<th className="w-full pb-2 pr-3 font-medium">用户<\/th>/);
  assert.match(source, /sticky right-0 border-l border-edge\/60/);
});

test("微信名独立于用户自改昵称，解绑时清除", async () => {
  const user = await db.createUserByWechat("wx_admin_profile", "微信原名");
  assert.equal(user.name, "微信原名");
  assert.equal(user.wechat_nickname, "微信原名");

  await db.updateUserProfile(user.id, { name: "站内自定义名" });
  await db.updateUserProfile(user.id, { wechat_nickname: "微信新名" });
  let stored = await db.getUserById(user.id);
  assert.equal(stored?.name, "站内自定义名", "微信名同步不能覆盖用户自改 name");
  assert.equal(stored?.wechat_nickname, "微信新名");

  stored = await db.setWechatOpenid(user.id, null);
  assert.equal(stored?.wechat_openid, null);
  assert.equal(stored?.wechat_nickname, null, "解绑后应停止保留旧微信名");

  stored = await db.setWechatOpenid(user.id, "wx_admin_profile_rebound");
  assert.equal(stored?.wechat_openid, "wx_admin_profile_rebound");
  assert.equal(stored?.wechat_nickname, null, "只绑 openid 不得用 name 猜测微信名");
});

test("createSession 并发颁发时精确累加，日常会话解析不重复计数", async () => {
  const user = await db.createUserByPhone("139" + "00009101", "登录计数");
  const before = Date.now();
  const [token1, token2] = await Promise.all([
    db.createSession(user.id),
    db.createSession(user.id),
  ]);

  let stored = await db.getUserById(user.id);
  assert.equal(stored?.login_count, 2, "login_count = login_count + 1 必须承受并发");
  assert.ok(Number(stored?.last_login_at) >= before);
  const loginAt = stored?.last_login_at;

  assert.equal((await db.getSessionUser(token1))?.id, user.id);
  assert.equal((await db.getSessionUser(token2))?.id, user.id);
  stored = await db.getUserById(user.id);
  assert.equal(stored?.login_count, 2, "已登录后的每次请求只刷 last_seen");
  assert.equal(stored?.last_login_at, loginAt);
});

test("较早的并发登录晚提交时，最近登录时间只前进不倒退", async () => {
  const user = await db.createUserByPhone("139" + "00009103", "登录时间单调");
  const future = Date.now() + 60_000;
  await pool.query("UPDATE users SET last_login_at = $1 WHERE id = $2", [future, user.id]);

  await db.createSession(user.id);
  const stored = await db.getUserById(user.id);
  assert.equal(stored?.login_count, 1);
  assert.equal(stored?.last_login_at, future, "旧时间戳不得覆盖已经提交的较新登录");
});

test("存量 sessions 只做保守下界回填，重复启动和会话删除都不回退", async () => {
  const user = await db.createUserByPhone("139" + "00009102", "存量回填");
  const first = 1_700_000_000_000;
  const second = first + 10_000;
  await pool.query(
    `INSERT INTO sessions (token, user_id, created_at, expires_at)
     VALUES ('legacy-session-1', $1, $2, $4), ('legacy-session-2', $1, $3, $4)`,
    [user.id, first, second, Date.now() + 86400_000]
  );

  await db.initSchema();
  let stored = await db.getUserById(user.id);
  assert.equal(stored?.login_count, 2);
  assert.equal(stored?.last_login_at, second);

  await db.initSchema();
  stored = await db.getUserById(user.id);
  assert.equal(stored?.login_count, 2, "幂等迁移不能每次启动叠加");
  assert.equal(stored?.last_login_at, second);

  await pool.query("DELETE FROM sessions WHERE token = 'legacy-session-2'");
  await db.initSchema();
  stored = await db.getUserById(user.id);
  assert.equal(stored?.login_count, 2, "退出/撤销会话不能让历史计数倒退");
  assert.equal(stored?.last_login_at, second);
});
