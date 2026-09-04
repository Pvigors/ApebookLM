// Unit tests for the WeChat scan-to-confirm ticket state machine
// (lib/auth-otp.ts) — plain Node, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWeChatTicket,
  getWeChatTicket,
  redeemWeChatTicket,
  confirmWeChatTicket,
} from "../../lib/auth-otp.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("createWeChatTicket mints a UUID id + nonce and starts pending", () => {
  const { id, nonce } = createWeChatTicket();
  assert.match(id, UUID);
  assert.match(nonce, UUID);
  const t = getWeChatTicket(id);
  assert.ok(t, "ticket should exist");
  assert.equal(t.status, "pending");
  assert.equal(t.userId, undefined);
});

test("createWeChatTicket returns unique ids", () => {
  const ids = new Set(Array.from({ length: 20 }, () => createWeChatTicket().id));
  assert.equal(ids.size, 20);
});

test("微信登录票据保留邀请归因，且会裁剪异常长输入", () => {
  const { id } = createWeChatTicket(`  ${"a".repeat(100)}  `);
  assert.equal(getWeChatTicket(id).inviteCode, "a".repeat(64));
  const plain = createWeChatTicket();
  assert.equal(getWeChatTicket(plain.id).inviteCode, undefined);
});

test("getWeChatTicket returns undefined for an unknown id", () => {
  assert.equal(getWeChatTicket("not-a-real-ticket"), undefined);
});

test("confirmWeChatTicket moves pending → confirmed and stores the user", () => {
  const { id } = createWeChatTicket();
  assert.equal(confirmWeChatTicket(id, "user-123"), true);
  const t = getWeChatTicket(id);
  assert.equal(t.status, "confirmed");
  assert.equal(t.userId, "user-123");
});

test("confirmWeChatTicket is idempotent-safe — a second confirm fails", () => {
  const { id } = createWeChatTicket();
  assert.equal(confirmWeChatTicket(id, "user-a"), true);
  assert.equal(confirmWeChatTicket(id, "user-b"), false, "already-confirmed ticket cannot be reconfirmed");
  // the original user must be preserved
  assert.equal(getWeChatTicket(id).userId, "user-a");
});

test("confirmWeChatTicket returns false for an unknown id", () => {
  assert.equal(confirmWeChatTicket("ghost-ticket", "user-x"), false);
});

// ---- CSRF-1: nonce binding ------------------------------------------------

test("redeemWeChatTicket returns the userId only with the matching nonce", () => {
  const { id, nonce } = createWeChatTicket();
  confirmWeChatTicket(id, "user-bind");
  // 错误 nonce(攻击者浏览器没有发起方的 cookie)→ 拒绝兑换
  assert.equal(redeemWeChatTicket(id, "wrong-nonce"), null);
  assert.equal(redeemWeChatTicket(id, ""), null);
  // 正确 nonce → 兑换成功
  assert.equal(redeemWeChatTicket(id, nonce), "user-bind");
});

test("redeemWeChatTicket refuses a pending (unconfirmed) ticket", () => {
  const { id, nonce } = createWeChatTicket();
  assert.equal(redeemWeChatTicket(id, nonce), null);
});

test("redeemWeChatTicket refuses an unknown ticket", () => {
  assert.equal(redeemWeChatTicket("ghost", "x"), null);
});
