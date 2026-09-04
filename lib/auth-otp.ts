// ---------------------------------------------------------------------------
// One-time-passcode + WeChat-ticket logic — DEV MODE, in-memory.
//
// Split out from auth.ts so it can be unit-tested in plain Node: this module
// imports nothing from next/* or the database, it only uses built-ins
// (globalThis, Date, node:crypto). Swap the in-memory stores for a real SMS
// provider / WeChat OAuth to go live; the state machines below stay the same.
// ---------------------------------------------------------------------------

import { randomInt } from "node:crypto";

// Stores live on globalThis so all (separately-bundled) route modules share one
// instance in a single server process — the same pattern db.ts uses.
const g = globalThis as unknown as {
  __nbPhoneCodes?: Map<string, { code: string; expires: number; attempts: number }>;
  __nbWeChatTickets?: Map<string, WeChatTicket>;
};

// 单条最多允许的校验失败次数,超过即作废验证码强制重发(M4:防 6 位码 5 分钟内暴力枚举)。
const MAX_OTP_ATTEMPTS = 5;
// 内存表上限(M7:无认证端点可刷至 OOM);超限时先清理过期项。
const MAX_MAP_ENTRIES = 50_000;

// ---- phone verification codes ---------------------------------------------

const phoneCodes = (g.__nbPhoneCodes ??= new Map());

// 清理过期项,避免内存表单调增长(M7)。在每次写入时机会式调用。
function sweepExpired() {
  const now = Date.now();
  for (const [k, v] of phoneCodes) if (v.expires < now) phoneCodes.delete(k);
  for (const [k, v] of wechatTickets) if (v.expires < now) wechatTickets.delete(k);
}

export function genCode(): string {
  // 密码学安全随机(randomInt),而非 Math.random()——OTP 不可预测,防被推算枚举。
  return String(randomInt(100000, 1000000));
}

export function isValidPhone(p: string): boolean {
  return /^1[3-9]\d{9}$/.test(p);
}

export function setPhoneCode(phone: string, code: string, ttlMs = 300000): void {
  if (phoneCodes.size >= MAX_MAP_ENTRIES) sweepExpired();
  phoneCodes.set(phone, { code, expires: Date.now() + ttlMs, attempts: 0 });
}

export function checkPhoneCode(phone: string, code: string): boolean {
  const e = phoneCodes.get(phone);
  if (!e || e.expires < Date.now()) {
    phoneCodes.delete(phone);
    return false;
  }
  const ok = e.code === code.trim();
  if (ok) {
    phoneCodes.delete(phone);
    return true;
  }
  // 失败累计:达上限即作废,迫使重新发码,杜绝同一码的穷举(M4)。
  e.attempts += 1;
  if (e.attempts >= MAX_OTP_ATTEMPTS) phoneCodes.delete(phone);
  return false;
}

// ---- WeChat login tickets --------------------------------------------------

export type WeChatTicket = {
  status: "pending" | "confirmed" | "expired";
  userId?: string;
  expires: number;
  // 绑定发起登录的浏览器(CSRF-1):start 时下发 httpOnly nonce cookie,poll 时核对。
  // 攻击者用自己确认过的票据无法在受害者浏览器兑换(受害者没有这枚 nonce)。
  nonce: string;
  /** 邀请码随登录票据走完微信链路；仅新建用户时消费。 */
  inviteCode?: string;
};

const wechatTickets = (g.__nbWeChatTickets ??= new Map<string, WeChatTicket>());

export function createWeChatTicket(inviteCode?: string): { id: string; nonce: string } {
  if (wechatTickets.size >= MAX_MAP_ENTRIES) sweepExpired();
  const id = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const normalizedInvite = String(inviteCode || "").trim().slice(0, 64);
  wechatTickets.set(id, {
    status: "pending",
    expires: Date.now() + 300000,
    nonce,
    ...(normalizedInvite ? { inviteCode: normalizedInvite } : {}),
  });
  return { id, nonce };
}

export function getWeChatTicket(id: string): WeChatTicket | undefined {
  const t = wechatTickets.get(id);
  if (t && t.expires < Date.now()) t.status = "expired";
  return t;
}

/**
 * 兑换票据为登录用户(poll 调用)。仅当票据已确认、未过期、且 nonce 与发起浏览器
 * 持有的 cookie 匹配时返回 userId,否则 null。这是 login-CSRF 的关键闸门(CSRF-1)。
 */
export function redeemWeChatTicket(id: string, nonce: string): string | null {
  const t = wechatTickets.get(id);
  if (!t || t.expires < Date.now()) return null;
  if (t.status !== "confirmed" || !t.userId) return null;
  if (!nonce || t.nonce !== nonce) return null;
  return t.userId;
}

export function confirmWeChatTicket(id: string, userId: string): boolean {
  const t = wechatTickets.get(id);
  if (!t || t.status !== "pending") return false;
  t.status = "confirmed";
  t.userId = userId;
  return true;
}
