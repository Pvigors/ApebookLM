import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { freshPgDb } from "../helpers/pgdb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const db = await freshPgDb("community_release");
const { getPool } = await import("../../lib/pg.ts");
const { isStrongAdminScryptPasswordHash } = await import("../../lib/password-credential.ts");

test("公开树合同脚本通过", () => {
  const output = execFileSync(process.execPath, ["scripts/check-public-release.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(output, /公开树检查通过/);
});

test("资金交易路由、订单后台和交易内核不存在", () => {
  for (const relative of [
    "app/api/pay/create/route.ts",
    "app/api/pay/status/route.ts",
    "app/api/pay/orders/route.ts",
    "app/api/plans/route.ts",
    "app/api/admin/orders/route.ts",
    "app/admin/orders/page.tsx",
    "lib/pay.ts",
    "lib/pay-notify.ts",
    "lib/payment-policy.ts",
  ]) {
    assert.equal(existsSync(path.join(root, relative)), false, `${relative} 不得进入社区版`);
  }
});

test("社区版不包含公司绑定的登录入口或隐式管理员配置", () => {
  for (const relative of [
    "app/api/wechat/mp/route.ts",
    "app/api/wechat/follow-qr/route.ts",
    "app/api/wechat/follow/start/route.ts",
    "app/api/wechat/follow/poll/route.ts",
    "app/api/wechat/oauth/route.ts",
    "components/FollowCard.tsx",
    "lib/wechat-mp.ts",
    "lib/wechat-mp-proto.ts",
    "public/brand/card-thumb.png",
    "public/brand/wx-login-card.png",
  ]) {
    assert.equal(existsSync(path.join(root, relative)), false, `${relative} 不得进入社区版`);
  }

  const joined = [
    ".env.example",
    "lib/admin-identity.ts",
    "lib/db.ts",
    "lib/sms.ts",
    "app/api/admin/providers/route.ts",
    "app/admin/providers/page.tsx",
  ].map((relative) => readFileSync(path.join(root, relative), "utf8")).join("\n");
  for (const forbidden of ["WECHAT_MP_", "SUPER_ADMIN_PHONE", "ADMIN_PHONES", "ADMIN_IDS", "sms.aliyun."]) {
    assert.equal(joined.includes(forbidden), false, `${forbidden} 不得进入社区配置面`);
  }
});

test("fresh PostgreSQL 不创建交易表，但保留积分退回安全链", async () => {
  const rows = (
    await getPool().query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' ORDER BY table_name`
    )
  ).rows.map((row) => row.table_name);

  assert.equal(rows.includes("orders"), false);
  for (const required of ["users", "user_usage", "credit_ledger", "credit_refund_outbox", "jobs"]) {
    assert.equal(rows.includes(required), true, `${required} 必须保留`);
  }
  assert.equal(Number((await getPool().query("SELECT COUNT(*) n FROM users")).rows[0].n), 0, "社区版不得自动播种固定账号");
});

test("积分失败退回保持幂等", async () => {
  const user = await db.createUserByEmail("release-check@example.test", "发行检查用户");
  const charged = await db.consumeDailyQuota(user, "chat", 3);
  assert.equal(charged.over, false);
  assert.ok(charged.ledgerId);
  assert.equal(await db.refundCredits(user.id, "chat", 3, charged.ledgerId), true);
  assert.equal(await db.refundCredits(user.id, "chat", 3, charged.ledgerId), true);
  const ledger = (
    await getPool().query("SELECT refunded FROM credit_ledger WHERE id=$1", [charged.ledgerId])
  ).rows[0];
  assert.equal(Number(ledger.refunded), 1);
});

test("纯 Node 管理员配置生成器可供 Docker 自托管使用", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/generate-admin-password-config.mjs", "--username", "admin"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ADMIN_CONFIG_PASSWORD: "community-admin-password-2026" },
    }
  );
  const encoded = output.match(/^ADMIN_PASSWORD_ACCOUNT_B64=(.+)$/m)?.[1];
  assert.ok(encoded);
  const account = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.equal(account.username, "admin");
  assert.equal(isStrongAdminScryptPasswordHash(account.passwordHash), true);
});
