import {
  constantCredentialTextEqual,
  hashPasswordCredential,
  isValidScryptPasswordHash,
  normalizeCredentialUsername,
  verifyPasswordCredential,
} from "./password-credential";

/**
 * 生产体验账号只从环境变量读取。用户名、访问密钥与密码哈希都不落数据库，
 * 更不会进入客户端 bundle；数据库仅保存不可登录的固定 userId 与业务数据。
 *
 * EXPERIENCE_ACCOUNTS_B64 解码后格式：
 * {"v":1,"accounts":[{"accessKey":"...","username":"...","userId":"...",
 *   "displayName":"测试账号 1","passwordHash":"scrypt$16384$8$1$<salt>$<digest>",
 *   "expiresAt":1893455999000}]}
 */

export type ExperienceAccount = {
  accessKey: string;
  username: string;
  userId: string;
  displayName: string;
  passwordHash: string;
  expiresAt: number;
};

const ACCESS_KEY_RE = /^[A-Za-z0-9_-]{22,128}$/;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const USER_ID_RE = /^experience-[a-f0-9-]{16,80}$/;
const MAX_ACCOUNTS_B64_BYTES = 24_000;

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

function parseAccounts(): ExperienceAccount[] {
  if (process.env.EXPERIENCE_ACCESS_ENABLED !== "1") return [];
  const encoded = (process.env.EXPERIENCE_ACCOUNTS_B64 ?? "").trim();
  if (!encoded || encoded.length > MAX_ACCOUNTS_B64_BYTES) return [];
  const decoded = decodeBase64Url(encoded);
  if (!decoded || decoded.length > MAX_ACCOUNTS_B64_BYTES) return [];
  try {
    const root = JSON.parse(decoded.toString("utf8")) as { v?: unknown; accounts?: unknown };
    if (root.v !== 1 || !Array.isArray(root.accounts) || root.accounts.length !== 3) return [];
    const now = Date.now();
    const accounts: ExperienceAccount[] = [];
    const keys = new Set<string>();
    const usernames = new Set<string>();
    const ids = new Set<string>();
    for (const raw of root.accounts) {
      if (!raw || typeof raw !== "object") return [];
      const item = raw as Record<string, unknown>;
      const accessKey = typeof item.accessKey === "string" ? item.accessKey : "";
      const usernameRaw = typeof item.username === "string" ? item.username.trim() : "";
      const username = normalizeCredentialUsername(usernameRaw);
      const userId = typeof item.userId === "string" ? item.userId : "";
      const displayName = typeof item.displayName === "string" ? item.displayName.trim() : "";
      const passwordHash = typeof item.passwordHash === "string" ? item.passwordHash : "";
      const expiresAt = Number(item.expiresAt);
      if (
        !ACCESS_KEY_RE.test(accessKey) ||
        !USERNAME_RE.test(usernameRaw) ||
        username !== usernameRaw.toLowerCase() ||
        !USER_ID_RE.test(userId) ||
        displayName.length < 1 ||
        displayName.length > 40 ||
        !isValidScryptPasswordHash(passwordHash) ||
        !Number.isSafeInteger(expiresAt)
      ) {
        return [];
      }
      if (keys.has(accessKey) || usernames.has(username) || ids.has(userId)) return [];
      keys.add(accessKey);
      usernames.add(username);
      ids.add(userId);
      accounts.push({ accessKey, username, userId, displayName, passwordHash, expiresAt });
    }
    // 结构/签名任一畸形仍整体 fail closed；单个账号自然到期只关闭自己的链接与会话，
    // 不连坐其余两个仍有效账号。
    return accounts.filter((account) => account.expiresAt > now);
  } catch {
    return [];
  }
}

/** 访问密钥只用于选择账号，真正认证仍必须输入该账号的用户名与密码。 */
export function experienceAccountByAccessKey(accessKey: string): ExperienceAccount | null {
  if (!ACCESS_KEY_RE.test(accessKey)) return null;
  let match: ExperienceAccount | null = null;
  for (const account of parseAccounts()) {
    if (constantCredentialTextEqual(accessKey, account.accessKey)) match = account;
  }
  return match;
}

/** 环境配置是体验账号会话的撤销源：删除配置或关闭开关后，现有会话立即失效。 */
export function isConfiguredExperienceUser(userId: string): boolean {
  return experienceAccountByUserId(userId) !== null;
}

/** 按固定随机 userId 找当前仍有效的环境配置，供会话层同步到期时间与即时撤销。 */
export function experienceAccountByUserId(userId: string): ExperienceAccount | null {
  let match: ExperienceAccount | null = null;
  for (const account of parseAccounts()) {
    if (constantCredentialTextEqual(userId, account.userId)) match = account;
  }
  return match;
}

export function experienceSessionMaxAgeSeconds(): number {
  const hours = Number(process.env.EXPERIENCE_SESSION_HOURS ?? "12");
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24) return 12 * 3600;
  return hours * 3600;
}

/**
 * 用户名错误仍使用目标链接对应的真实 scrypt 参数完整计算一次，避免凭响应时间枚举用户名。
 * 密码长度先做硬上限，防攻击者用超大请求放大 CPU/内存。
 */
export async function verifyExperienceCredentials(
  account: ExperienceAccount,
  username: string,
  password: string
): Promise<boolean> {
  return verifyPasswordCredential({
    expectedUsername: account.username,
    passwordHash: account.passwordHash,
    username,
    password,
  });
}

/** 只供运维/测试生成与线上校验同格式的 scrypt 哈希。不会被登录页调用。 */
export const hashExperiencePassword = hashPasswordCredential;
