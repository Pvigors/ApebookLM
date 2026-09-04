import {
  constantCredentialTextEqual,
  hashAdminPasswordCredential,
  isStrongAdminScryptPasswordHash,
  normalizeCredentialUsername,
  verifyPasswordCredential,
} from "./password-credential";

/**
 * 独立系统管理员密码入口的环境配置。明文密码、用户名均不写数据库；数据库只保存
 * 固定随机 userId 对应的无手机号管理员身份。
 *
 * ADMIN_PASSWORD_ACCOUNT_B64 解码格式：
 * {"v":1,"username":"...","userId":"password-admin-...","displayName":"系统管理员",
 *  "passwordHash":"scrypt$32768$8$3$<salt>$<digest>","credentialVersion":1,
 *  "expiresAt":1893455999000}
 */
export type AdminPasswordAccount = {
  username: string;
  userId: string;
  displayName: string;
  passwordHash: string;
  credentialVersion: number;
  expiresAt: number;
};

export class AdminPasswordStateError extends Error {
  readonly code = "ADMIN_PASSWORD_STATE";

  constructor(message: string) {
    super(message);
    this.name = "AdminPasswordStateError";
  }
}

export function isAdminPasswordStateError(error: unknown): boolean {
  return error instanceof AdminPasswordStateError || (
    !!error && typeof error === "object" &&
    (error as { code?: unknown }).code === "ADMIN_PASSWORD_STATE"
  );
}

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const USER_ID_RE = /^password-admin-[a-f0-9-]{16,80}$/;
const MAX_CONFIG_BYTES = 12_000;

export function isAdminPasswordUserId(userId: string): boolean {
  return USER_ID_RE.test(userId);
}

function isAdminPasswordFlagEnabledExactly(): boolean {
  return process.env.ADMIN_PASSWORD_LOGIN_ENABLED === "1";
}

/**
 * 空值/未设置/精确 0 才表示关闭；其它非空畸形值同样锁住旧短信 super，但不会
 * 解析管理员账号。避免生产把布尔误填为 true、01 或带空格时静默 fail open。
 */
export function isAdminPasswordLoginEnforced(): boolean {
  const raw = process.env.ADMIN_PASSWORD_LOGIN_ENABLED;
  return raw !== undefined && raw !== "" && raw !== "0";
}

function parseAccount(): AdminPasswordAccount | null {
  if (!isAdminPasswordFlagEnabledExactly()) return null;
  const encoded = (process.env.ADMIN_PASSWORD_ACCOUNT_B64 ?? "").trim();
  if (!encoded || encoded.length > MAX_CONFIG_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (!decoded.length || decoded.length > MAX_CONFIG_BYTES) return null;
    const raw = JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
    const usernameRaw = typeof raw.username === "string" ? raw.username.trim() : "";
    const username = normalizeCredentialUsername(usernameRaw);
    const userId = typeof raw.userId === "string" ? raw.userId : "";
    const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
    const passwordHash = typeof raw.passwordHash === "string" ? raw.passwordHash : "";
    const credentialVersion = Number(raw.credentialVersion);
    const expiresAt = Number(raw.expiresAt);
    if (
      raw.v !== 1 ||
      !USERNAME_RE.test(usernameRaw) ||
      username !== usernameRaw ||
      !isAdminPasswordUserId(userId) ||
      displayName.length < 1 ||
      displayName.length > 40 ||
      !isStrongAdminScryptPasswordHash(passwordHash) ||
      !Number.isSafeInteger(credentialVersion) ||
      credentialVersion < 1 ||
      credentialVersion > 1_000_000_000 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      return null;
    }
    return { username, userId, displayName, passwordHash, credentialVersion, expiresAt };
  } catch {
    return null;
  }
}

export function adminPasswordAccount(): AdminPasswordAccount | null {
  return parseAccount();
}

export function adminPasswordAccountByUserId(userId: string): AdminPasswordAccount | null {
  const account = parseAccount();
  return account && constantCredentialTextEqual(userId, account.userId) ? account : null;
}

export async function verifyAdminPasswordCredentials(
  account: AdminPasswordAccount,
  username: string,
  password: string
): Promise<boolean> {
  const verified = await verifyPasswordCredential({
    expectedUsername: account.username,
    passwordHash: account.passwordHash,
    username,
    password,
  });
  // 无论长度是否合格都先跑完 scrypt，避免短密码形成明显的计时旁路。
  return password.length >= 16 && verified;
}

export function adminPasswordSessionMaxAgeSeconds(): number {
  const hours = Number(process.env.ADMIN_PASSWORD_SESSION_HOURS ?? "2");
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 8) return 2 * 3600;
  return hours * 3600;
}

export const hashAdminPassword = hashAdminPasswordCredential;
