import crypto from "node:crypto";

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const username = (option("username") ?? "").trim();
const displayName = (option("display-name") ?? "系统管理员").trim();
const password = process.env.ADMIN_CONFIG_PASSWORD ?? "";
const credentialVersion = Number(option("credential-version") ?? "1");
const validDays = Number(option("valid-days") ?? "365");
const suppliedUserId = option("user-id")?.trim();

if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
  fail("--username 必须是 3–32 位小写字母、数字、点、下划线或连字符");
}
if (!displayName || displayName.length > 40) fail("--display-name 必须是 1–40 个字符");
if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1) {
  fail("--credential-version 必须是正整数");
}
if (!Number.isSafeInteger(validDays) || validDays < 1 || validDays > 3650) {
  fail("--valid-days 必须是 1–3650 的整数");
}
if (password.length < 16 || password.length > 256) {
  fail("请通过 ADMIN_CONFIG_PASSWORD 提供 16–256 位密码，禁止把明文写进命令参数");
}

const userId = suppliedUserId ?? `password-admin-${crypto.randomUUID()}`;
if (!/^password-admin-[a-f0-9-]{16,80}$/.test(userId)) {
  fail("--user-id 必须符合 password-admin- + 16–80 位十六进制/连字符");
}

const salt = crypto.randomBytes(18);
const derived = crypto.scryptSync(password, salt, 64, {
  N: 32_768,
  r: 8,
  p: 3,
  maxmem: 64 * 1024 * 1024,
});
const passwordHash = `scrypt$32768$8$3$${salt.toString("base64url")}$${derived.toString("base64url")}`;
const account = {
  v: 1,
  username,
  userId,
  displayName,
  passwordHash,
  credentialVersion,
  expiresAt: Date.now() + validDays * 86400_000,
};
const encoded = Buffer.from(JSON.stringify(account), "utf8").toString("base64url");

console.log("# 将以下三行写入部署环境；不要提交到 Git");
console.log("ADMIN_PASSWORD_LOGIN_ENABLED=1");
console.log("ADMIN_PASSWORD_SESSION_HOURS=2");
console.log(`ADMIN_PASSWORD_ACCOUNT_B64=${encoded}`);
console.log(`# 管理员用户名: ${username}；userId: ${userId}；credentialVersion: ${credentialVersion}`);
