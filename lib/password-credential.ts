import crypto from "node:crypto";

type ParsedPasswordHash = {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  digest: Buffer;
};

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const ADMIN_SCRYPT_N = 32_768;
const ADMIN_SCRYPT_P = 3;
const SCRYPT_BYTES = 64;
const DUMMY_PASSWORD_HASH = `scrypt$16384$8$1$${Buffer.alloc(18, 7).toString("base64url")}$${Buffer.alloc(
  SCRYPT_BYTES,
  11
).toString("base64url")}`;

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

function parsePasswordHash(value: string): ParsedPasswordHash | null {
  const parts = value.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const supported =
    (n === SCRYPT_N && r === SCRYPT_R && p === SCRYPT_P) ||
    (n === ADMIN_SCRYPT_N && r === SCRYPT_R && p === ADMIN_SCRYPT_P);
  if (!supported) return null;
  const salt = decodeBase64Url(parts[4]);
  const digest = decodeBase64Url(parts[5]);
  if (!salt || !digest) return null;
  if (salt.length < 16 || salt.length > 64 || digest.length !== SCRYPT_BYTES) return null;
  return { n, r, p, salt, digest };
}

export function normalizeCredentialUsername(value: string): string {
  return value.trim().toLowerCase();
}

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

export function constantCredentialTextEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

export function isValidScryptPasswordHash(value: string): boolean {
  return parsePasswordHash(value) !== null;
}

/** 管理员入口使用更高 CPU/内存成本，拒绝体验账号的较轻历史参数。 */
export function isStrongAdminScryptPasswordHash(value: string): boolean {
  const parsed = parsePasswordHash(value);
  return !!parsed && parsed.n === ADMIN_SCRYPT_N && parsed.r === SCRYPT_R && parsed.p === ADMIN_SCRYPT_P;
}

function scrypt(password: string, parsed: ParsedPasswordHash): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      parsed.salt,
      SCRYPT_BYTES,
      { N: parsed.n, r: parsed.r, p: parsed.p, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key as Buffer))
    );
  });
}

/** 用户名不匹配时仍完整执行一次目标账号的 scrypt，避免用响应时间枚举账号。 */
export async function verifyPasswordCredential(args: {
  expectedUsername: string;
  passwordHash: string;
  username: string;
  password: string;
}): Promise<boolean> {
  if (args.password.length < 1 || args.password.length > 256) return false;
  const parsed = parsePasswordHash(args.passwordHash) ?? parsePasswordHash(DUMMY_PASSWORD_HASH);
  if (!parsed) return false;
  const actual = await scrypt(args.password, parsed);
  const passwordOk = crypto.timingSafeEqual(actual, parsed.digest);
  const usernameOk = constantCredentialTextEqual(
    normalizeCredentialUsername(args.username),
    args.expectedUsername
  );
  return usernameOk && passwordOk;
}

/** 只供运维与测试生成环境配置；明文密码不能写入仓库或生产 env。 */
export function hashPasswordCredential(password: string, salt = crypto.randomBytes(18)): string {
  const derived = crypto.scryptSync(password, salt, SCRYPT_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function hashAdminPasswordCredential(password: string, salt = crypto.randomBytes(18)): string {
  if (password.length < 16 || password.length > 256) {
    throw new Error("管理员密码长度必须为 16–256 个字符");
  }
  const derived = crypto.scryptSync(password, salt, SCRYPT_BYTES, {
    N: ADMIN_SCRYPT_N,
    r: SCRYPT_R,
    p: ADMIN_SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${ADMIN_SCRYPT_N}$${SCRYPT_R}$${ADMIN_SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}
