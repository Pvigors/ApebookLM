import crypto from "node:crypto";
import {
  adminPasswordAccount,
  type AdminPasswordAccount,
} from "./admin-password-access";

const PREVIEW_USER_PREFIX = "local-preview-";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type LocalPreviewAccount = {
  userId: string;
  displayName: string;
  expiresAt: number;
  owner: AdminPasswordAccount;
};

function configuredLoopbackOrigin(): string | null {
  if (process.env.LOCAL_PREVIEW_AUTO_LOGIN_ENABLED !== "1") return null;
  const raw = (process.env.PUBLIC_ORIGIN ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "http:" ||
      !LOOPBACK_HOSTS.has(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      raw !== url.origin
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 本机演示专用免密入口。它同时要求精确开关、回环 Origin 与有效的本地管理员配置，
 * 任一条件不满足都 fail closed。客户端只能接收布尔值，不能接触 owner 配置。
 */
export function localPreviewAccount(): LocalPreviewAccount | null {
  if (!configuredLoopbackOrigin()) return null;
  const owner = adminPasswordAccount();
  if (!owner) return null;
  const suffix = crypto.createHash("sha256").update(owner.userId, "utf8").digest("hex").slice(0, 32);
  return {
    userId: `${PREVIEW_USER_PREFIX}${suffix}`,
    displayName: "本地试用账号",
    expiresAt: owner.expiresAt,
    owner,
  };
}

export function localPreviewOrigin(): string | null {
  return localPreviewAccount() ? configuredLoopbackOrigin() : null;
}

export function isLocalPreviewAutoLoginEnabled(): boolean {
  return localPreviewAccount() !== null;
}

export function isLocalPreviewUserId(userId: string): boolean {
  return /^local-preview-[a-f0-9]{32}$/.test(userId);
}

export function localPreviewAccountByUserId(userId: string): LocalPreviewAccount | null {
  const account = localPreviewAccount();
  return account && account.userId === userId ? account : null;
}
