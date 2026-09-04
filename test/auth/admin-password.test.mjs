import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { freshPgDb } from "../helpers/pgdb.mjs";

process.env.ADMIN_PASSWORD_LOGIN_ENABLED = "1";
process.env.ADMIN_PASSWORD_SESSION_HOURS = "2";
process.env.PUBLIC_ORIGIN = "https://notes.example.test";

const credential = await import("../../lib/password-credential.ts");
const access = await import("../../lib/admin-password-access.ts");

const password = "Ape!Admin-q8V$k2Lm9R";
const account = {
  username: "system.root",
  userId: "password-admin-01234567-89ab-cdef-0123-456789abcdef",
  displayName: "系统管理员",
  passwordHash: access.hashAdminPassword(password, Buffer.alloc(18, 23)),
  credentialVersion: 7,
  expiresAt: Date.now() + 365 * 86400_000,
};
const encodeAccount = (value) =>
  Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
const validConfig = encodeAccount(account);
process.env.ADMIN_PASSWORD_ACCOUNT_B64 = validConfig;

const db = await freshPgDb("admin_password");
const { getPool } = await import("../../lib/pg.ts");
const auth = await import("../../lib/auth.ts");
const admin = await import("../../lib/admin.ts");
const loginRoute = await import("../../app/api/auth/admin-password/route.ts");
const adminMeRoute = await import("../../app/api/admin/me/route.ts");
const usersRoute = await import("../../app/api/admin/users/route.ts");
const accountsRoute = await import("../../app/api/admin/accounts/route.ts");
const meRoute = await import("../../app/api/auth/me/route.ts");
const logoutRoute = await import("../../app/api/auth/logout/route.ts");
const featuredSeedRoute = await import("../../app/api/featured/seed/route.ts");
const { NextRequest } = await import("next/server");

let requestCounter = 20;
function request(path, {
  method = "GET",
  body,
  cookie,
  origin = "https://notes.example.test",
  contentType = "application/json",
  headers: extraHeaders = {},
} = {}) {
  const headers = new Headers({
    "x-forwarded-for": `198.51.100.${requestCounter++}`,
    ...extraHeaders,
  });
  if (origin !== null) headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined && contentType) headers.set("content-type", contentType);
  return new NextRequest(`https://notes.example.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const loginRequest = (body, options = {}) =>
  request("/api/auth/admin-password", { method: "POST", body, ...options });

test("管理员配置严格解析，并使用独立强 scrypt 参数", async () => {
  assert.match(account.passwordHash, /^scrypt\$32768\$8\$3\$/);
  assert.equal(credential.isStrongAdminScryptPasswordHash(account.passwordHash), true);
  assert.equal(
    credential.isStrongAdminScryptPasswordHash(
      credential.hashPasswordCredential(password, Buffer.alloc(18, 17))
    ),
    false,
    "体验账号的较轻历史参数不得用于系统管理员"
  );

  const parsed = access.adminPasswordAccount();
  assert.deepEqual(parsed, account);
  assert.equal(access.adminPasswordAccountByUserId(account.userId)?.username, account.username);
  assert.equal(access.adminPasswordAccountByUserId("password-admin-ffffffffffffffff"), null);
  assert.equal(access.isAdminPasswordUserId(account.userId), true);
  assert.equal(await access.verifyAdminPasswordCredentials(parsed, " SYSTEM.ROOT ", password), true);
  assert.equal(await access.verifyAdminPasswordCredentials(parsed, account.username, "wrong-password"), false);
  assert.equal(await access.verifyAdminPasswordCredentials(parsed, "wrong-user", password), false);
  assert.equal(access.adminPasswordSessionMaxAgeSeconds(), 2 * 3600);

  process.env.ADMIN_PASSWORD_SESSION_HOURS = "9";
  assert.equal(access.adminPasswordSessionMaxAgeSeconds(), 2 * 3600, "超出 8 小时必须回落安全默认值");
  process.env.ADMIN_PASSWORD_SESSION_HOURS = "2";
});

test("关闭、畸形、弱哈希、旧版本或过期配置一律 fail closed", () => {
  const weakHash = credential.hashPasswordCredential(password, Buffer.alloc(18, 31));
  const invalidConfigs = [
    "not-base64url!",
    Buffer.from("{}", "utf8").toString("base64url"),
    encodeAccount({ ...account, username: "System.Root" }),
    encodeAccount({ ...account, userId: "ordinary-user-id" }),
    encodeAccount({ ...account, passwordHash: weakHash }),
    encodeAccount({ ...account, credentialVersion: 0 }),
    encodeAccount({ ...account, expiresAt: Date.now() - 1 }),
  ];

  try {
    for (const config of invalidConfigs) {
      process.env.ADMIN_PASSWORD_ACCOUNT_B64 = config;
      assert.equal(access.adminPasswordAccount(), null);
      assert.equal(
        access.isAdminPasswordLoginEnforced(),
        true,
        "开关已开时配置损坏也不得回退到短信超管"
      );
    }
    process.env.ADMIN_PASSWORD_LOGIN_ENABLED = "0";
    process.env.ADMIN_PASSWORD_ACCOUNT_B64 = validConfig;
    assert.equal(access.isAdminPasswordLoginEnforced(), false);
    assert.equal(access.adminPasswordAccount(), null);
    for (const malformedFlag of ["true", "01", "1 ", "2"]) {
      process.env.ADMIN_PASSWORD_LOGIN_ENABLED = malformedFlag;
      assert.equal(access.isAdminPasswordLoginEnforced(), true);
      assert.equal(access.adminPasswordAccount(), null);
    }
  } finally {
    process.env.ADMIN_PASSWORD_LOGIN_ENABLED = "1";
    process.env.ADMIN_PASSWORD_ACCOUNT_B64 = validConfig;
  }
});

test("密码管理员 provision 仅接管可证明来源的专用账号", async () => {
  const first = await db.ensureAdminPasswordAccount(account);
  assert.equal(first.id, account.userId);
  assert.equal(first.admin_role, "super");
  assert.equal(Number(first.is_admin), 1);
  assert.equal(first.phone, null);
  assert.equal(first.email, null);
  assert.equal(first.wechat_openid, null);
  assert.notEqual(first.plan_tier, "test");

  const principal = (
    await getPool().query(
      `SELECT credential_version,credential_fingerprint,enabled
         FROM admin_password_principals WHERE user_id=$1`,
      [account.userId]
    )
  ).rows[0];
  assert.equal(Number(principal.credential_version), account.credentialVersion);
  assert.match(principal.credential_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Number(principal.enabled), 1);

  const renamed = await db.ensureAdminPasswordAccount({ ...account, displayName: "值班系统管理员" });
  assert.equal(renamed.name, "值班系统管理员");
  await assert.rejects(
    () => db.ensureAdminPasswordAccount({ ...account, credentialVersion: account.credentialVersion - 1 }),
    /版本已过期/
  );

  const collision = {
    ...account,
    userId: "password-admin-feedface-feed-face-feed-facefeedface",
    credentialVersion: 1,
  };
  await getPool().query(
    "INSERT INTO users(id,name,phone,created_at,last_seen) VALUES($1,$2,$3,$4,$4)",
    [collision.userId, "普通手机用户", "139" + "00009991", Date.now()]
  );
  await assert.rejects(() => db.ensureAdminPasswordAccount(collision), /冲突|撤销/);

  const untrusted = {
    ...account,
    userId: "password-admin-deadbeef-dead-beef-dead-beefdeadbeef",
    credentialVersion: 1,
  };
  await getPool().query(
    `INSERT INTO users(id,name,created_at,last_seen,is_admin,admin_role)
     VALUES($1,$2,$3,$3,1,'super')`,
    [untrusted.userId, "伪造密码超管", Date.now()]
  );
  await assert.rejects(() => db.ensureAdminPasswordAccount(untrusted), /缺少可信来源/);
});

test("登录路由校验 Origin/请求体/统一错误，成功时仅签发两枚独立短会话 Cookie", async () => {
  let response = await loginRoute.POST(
    loginRequest({ username: account.username, password }, { origin: null })
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "请求来源无效" });

  response = await loginRoute.POST(
    loginRequest({ username: account.username, password }, { origin: "https://evil.example" })
  );
  assert.equal(response.status, 403);

  response = await loginRoute.POST(
    loginRequest("username=system.root", { contentType: "application/x-www-form-urlencoded" })
  );
  assert.equal(response.status, 415);

  const oversizedStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8192));
      controller.enqueue(new Uint8Array([123]));
      controller.close();
    },
  });
  const oversizedRequest = new NextRequest("https://notes.example.test/api/auth/admin-password", {
    method: "POST",
    headers: {
      origin: "https://notes.example.test",
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.199",
    },
    body: oversizedStream,
    duplex: "half",
  });
  assert.equal(oversizedRequest.headers.get("content-length"), null);
  response = await loginRoute.POST(oversizedRequest);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "请求体过大" });

  response = await loginRoute.POST(loginRequest({ username: "wrong-user", password }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "用户名或密码错误" });
  assert.equal(response.headers.get("set-cookie"), null);

  response = await loginRoute.POST(
    loginRequest({ username: account.username, password: "wrong-password" })
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "用户名或密码错误" });

  response = await loginRoute.POST(loginRequest({ username: account.username, password }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");

  const normalCookie = response.cookies.get(auth.SESSION_COOKIE);
  const adminCookie = response.cookies.get(auth.ADMIN_SESSION_COOKIE);
  assert.ok(normalCookie?.value, "必须签发前台会话");
  assert.ok(adminCookie?.value, "必须另行签发管理员会话");
  assert.notEqual(normalCookie.value, adminCookie.value);

  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.length, 2);
  const normalLine = setCookies.find((line) => line.startsWith(`${auth.SESSION_COOKIE}=`));
  const adminLine = setCookies.find((line) => line.startsWith(`${auth.ADMIN_SESSION_COOKIE}=`));
  assert.match(normalLine ?? "", /HttpOnly/i);
  assert.match(normalLine ?? "", /SameSite=lax/i);
  assert.match(normalLine ?? "", /Max-Age=7200/i);
  assert.match(adminLine ?? "", /HttpOnly/i);
  assert.match(adminLine ?? "", /SameSite=strict/i);
  assert.match(adminLine ?? "", /Max-Age=7200/i);

  const normalUser = await db.getSessionUser(normalCookie.value);
  const adminUser = await db.getAdminSessionUser(adminCookie.value);
  assert.equal(normalUser?.id, account.userId);
  assert.equal(adminUser?.id, account.userId);
  assert.equal(Number((await db.getUserById(account.userId))?.login_count), 1);

  const storedAdminSession = (
    await getPool().query(
      "SELECT token_hash,credential_version FROM admin_sessions WHERE user_id=$1",
      [account.userId]
    )
  ).rows[0];
  assert.equal(
    storedAdminSession.token_hash,
    crypto.createHash("sha256").update(adminCookie.value, "utf8").digest("hex")
  );
  assert.notEqual(storedAdminSession.token_hash, adminCookie.value, "数据库不得保存管理员 token 明文");
  assert.equal(Number(storedAdminSession.credential_version), account.credentialVersion);
  assert.equal(
    Number(
      (
        await getPool().query(
          "SELECT COUNT(*) n FROM activity_log WHERE actor_id=$1 AND action='auth.admin_login'",
          [account.userId]
        )
      ).rows[0].n
    ),
    1
  );

  const normalOnly = `${auth.SESSION_COOKIE}=${normalCookie.value}`;
  const both = `${normalOnly}; ${auth.ADMIN_SESSION_COOKIE}=${adminCookie.value}`;
  response = await adminMeRoute.GET(request("/api/admin/me", { cookie: normalOnly, origin: null }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "admin_session_required");

  response = await adminMeRoute.GET(request("/api/admin/me", { cookie: both, origin: null }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).role, "super");

  const missingOrigin = await usersRoute.POST(
    request("/api/admin/users", {
      method: "POST",
      cookie: both,
      origin: null,
      body: { action: "user_set_admin", userId: "nobody" },
    })
  );
  assert.equal(missingOrigin.status, 403);
  assert.deepEqual(await missingOrigin.json(), { error: "管理请求来源无效" });

  const wrongOrigin = await usersRoute.POST(
    request("/api/admin/users", {
      method: "POST",
      cookie: both,
      origin: "https://evil.example",
      body: { action: "user_set_admin", userId: "nobody" },
    })
  );
  assert.equal(wrongOrigin.status, 403);

  const selfDelete = await meRoute.DELETE(
    request("/api/auth/me", { method: "DELETE", cookie: normalOnly, origin: null })
  );
  assert.equal(selfDelete.status, 403);
  assert.match((await selfDelete.json()).error, /管理账号不能/);

  const managedRoleChange = await accountsRoute.POST(
    request("/api/admin/accounts", {
      method: "POST",
      cookie: both,
      body: { userId: account.userId, role: null },
    })
  );
  assert.equal(managedRoleChange.status, 403);
  assert.match((await managedRoleChange.json()).error, /环境配置管理/);
});

test("运营员无法经用户管理旧动作把普通账号提权", async () => {
  const operator = await db.createUserByPhone("139" + "00009881", "运营员");
  const target = await db.createUserByPhone("139" + "00009882", "普通用户");
  await db.setUserAdminRole(operator.id, "operator");
  const operatorToken = await db.createSession(operator.id);

  for (const action of ["user_set_admin", "user_unset_admin"]) {
    const response = await usersRoute.POST(
      request("/api/admin/users", {
        method: "POST",
        cookie: `${auth.SESSION_COOKIE}=${operatorToken}`,
        body: { action, userId: target.id },
      })
    );
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /管理账户/);
  }

  const unchanged = await db.getUserById(target.id);
  assert.equal(Number(unchanged?.is_admin), 0);
  assert.equal(unchanged?.admin_role, null);
});

test("高成本密码校验限制为最多 3 个并发，突发请求不会放大到近 1GiB 工作集", async () => {
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      loginRoute.POST(
        loginRequest({ username: account.username, password: `wrong-password-${index}-long` })
      )
    )
  );
  const statuses = responses.map((response) => response.status);
  assert.ok(statuses.includes(429), `应有并发请求被快速拒绝，实际状态: ${statuses.join(",")}`);
  assert.ok(statuses.filter((status) => status === 401).length <= 3);
  for (const response of responses.filter((item) => item.status === 429)) {
    assert.equal(response.headers.get("retry-after"), "1");
  }
});

test("管理员登录的 chunked 请求体有绝对读取截止，不会永久占满 KDF 槽", () => {
  const route = fs.readFileSync(
    new URL("../../app/api/auth/admin-password/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(route, /BODY_READ_TIMEOUT_MS = 5_000/);
  assert.match(route, /Promise\.race\(\[reader\.read\(\), deadline\]\)/);
  assert.match(route, /reader\.cancel\("admin login body timeout"\)/);
  assert.match(route, /BodyReadTimeoutError/);
});

test("确定性管理员状态失败与错误密码使用同一 401，不能形成正确密码 oracle", async () => {
  const original = (
    await getPool().query(
      `SELECT credential_version,credential_fingerprint,enabled
         FROM admin_password_principals WHERE user_id=$1`,
      [account.userId]
    )
  ).rows[0];

  const assertGenericPair = async () => {
    const [correct, wrong] = await Promise.all([
      loginRoute.POST(loginRequest({ username: account.username, password })),
      loginRoute.POST(loginRequest({ username: account.username, password: "wrong-password-long-enough" })),
    ]);
    for (const response of [correct, wrong]) {
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "用户名或密码错误" });
      assert.equal(response.headers.get("set-cookie"), null);
    }
  };

  try {
    await getPool().query(
      "UPDATE admin_password_principals SET enabled=0 WHERE user_id=$1",
      [account.userId]
    );
    await assertGenericPair();

    await getPool().query(
      `UPDATE admin_password_principals
          SET enabled=1,credential_version=$1,credential_fingerprint=$2
        WHERE user_id=$3`,
      [account.credentialVersion + 1, original.credential_fingerprint, account.userId]
    );
    await assertGenericPair();

    await getPool().query(
      `UPDATE admin_password_principals
          SET credential_version=$1,credential_fingerprint=$2
        WHERE user_id=$3`,
      [account.credentialVersion, "0".repeat(64), account.userId]
    );
    await assertGenericPair();
  } finally {
    await getPool().query(
      `UPDATE admin_password_principals
          SET credential_version=$1,credential_fingerprint=$2,enabled=$3
        WHERE user_id=$4`,
      [
        Number(original.credential_version),
        original.credential_fingerprint,
        Number(original.enabled),
        account.userId,
      ]
    );
  }
});

test("审计员不能重建精选种子；登出管理员链路严格校验 Origin", async () => {
  const auditor = await db.createUserByPhone("139" + "00009884", "安全审计员");
  await db.setUserAdminRole(auditor.id, "auditor");
  const auditorToken = await db.createSession(auditor.id);
  const cookie = `${auth.SESSION_COOKIE}=${auditorToken}`;

  const seedResponse = await featuredSeedRoute.POST(
    request("/api/featured/seed?force=1", { method: "POST", cookie })
  );
  assert.equal(seedResponse.status, 403);
  assert.match((await seedResponse.json()).error, /无此操作权限/);

  let logoutResponse = await logoutRoute.POST(
    request("/api/auth/logout", { method: "POST", cookie, origin: null })
  );
  assert.equal(logoutResponse.status, 403);
  assert.equal((await db.getSessionUser(auditorToken))?.id, auditor.id);

  logoutResponse = await logoutRoute.POST(
    request("/api/auth/logout", { method: "POST", cookie })
  );
  assert.equal(logoutResponse.status, 200);
  assert.equal(await db.getSessionUser(auditorToken), undefined);
});

test("开启独立入口后，传统短信超管不再拥有有效后台角色", async () => {
  const legacy = await db.createUserByPhone("139" + "00009883", "传统短信超管");
  await db.setUserAdminRole(legacy.id, "super");
  const token = await db.createSession(legacy.id);
  const response = await adminMeRoute.GET(
    request("/api/admin/me", {
      cookie: `${auth.SESSION_COOKIE}=${token}`,
      origin: null,
    })
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "无管理员权限" });

  process.env.ADMIN_PASSWORD_ACCOUNT_B64 = "malformed-config!";
  try {
    assert.equal(access.isAdminPasswordLoginEnforced(), true);
    assert.equal(access.adminPasswordAccount(), null);
    const malformedResponse = await adminMeRoute.GET(
      request("/api/admin/me", {
        cookie: `${auth.SESSION_COOKIE}=${token}`,
        origin: null,
      })
    );
    assert.equal(malformedResponse.status, 403);
    assert.deepEqual(await malformedResponse.json(), { error: "无管理员权限" });
  } finally {
    process.env.ADMIN_PASSWORD_ACCOUNT_B64 = validConfig;
  }
});

test("版本轮换、配置移除与 DB 停用均会让管理员会话立即失效", async () => {
  const currentAdminSession = (
    await getPool().query("SELECT token_hash FROM admin_sessions WHERE user_id=$1", [account.userId])
  ).rows[0];
  assert.ok(currentAdminSession?.token_hash);

  const preRotationToken = await db.createAdminSession(
    account.userId,
    account.credentialVersion,
    2 * 3600
  );
  assert.equal((await db.getAdminSessionUser(preRotationToken))?.id, account.userId);
  const idleMarker = Date.now() - 1_000;
  await getPool().query(
    "UPDATE admin_sessions SET last_seen=$1 WHERE user_id=$2",
    [idleMarker, account.userId]
  );
  assert.equal(
    (await db.getAdminSessionUser(preRotationToken, { touch: false }))?.id,
    account.userId
  );
  assert.equal(
    Number(
      (
        await getPool().query(
          "SELECT last_seen FROM admin_sessions WHERE user_id=$1",
          [account.userId]
        )
      ).rows[0].last_seen
    ),
    idleMarker,
    "前台 SSR 只读校验不能续期后台 idle"
  );
  assert.equal((await db.getAdminSessionUser(preRotationToken))?.id, account.userId);
  assert.ok(
    Number(
      (
        await getPool().query(
          "SELECT last_seen FROM admin_sessions WHERE user_id=$1",
          [account.userId]
        )
      ).rows[0].last_seen
    ) > idleMarker
  );

  const rotated = { ...account, credentialVersion: account.credentialVersion + 1 };
  process.env.ADMIN_PASSWORD_ACCOUNT_B64 = encodeAccount(rotated);
  await db.ensureAdminPasswordAccount(rotated);
  assert.equal(await db.getAdminSessionUser(preRotationToken), undefined);
  assert.equal(
    Number(
      (
        await getPool().query("SELECT COUNT(*) n FROM admin_sessions WHERE user_id=$1", [account.userId])
      ).rows[0].n
    ),
    0
  );
  assert.equal(
    Number(
      (
        await getPool().query(
          "SELECT credential_version FROM admin_password_principals WHERE user_id=$1",
          [account.userId]
        )
      ).rows[0].credential_version
    ),
    rotated.credentialVersion
  );
  await assert.rejects(() => db.ensureAdminPasswordAccount(account), /版本已过期/);

  const currentToken = await db.createAdminSession(
    account.userId,
    rotated.credentialVersion,
    2 * 3600
  );
  assert.equal((await db.getAdminSessionUser(currentToken))?.id, account.userId);

  delete process.env.ADMIN_PASSWORD_ACCOUNT_B64;
  assert.equal(await db.getAdminSessionUser(currentToken), undefined, "移除权威配置应立即撤销会话");
  process.env.ADMIN_PASSWORD_ACCOUNT_B64 = encodeAccount(rotated);
  assert.equal(await db.getAdminSessionUser(currentToken), undefined, "恢复旧配置也不能让已出示的会话复活");

  const afterRestoreToken = await db.createAdminSession(
    account.userId,
    rotated.credentialVersion,
    2 * 3600
  );
  await getPool().query("UPDATE users SET disabled=1 WHERE id=$1", [account.userId]);
  assert.equal(await db.getAdminSessionUser(afterRestoreToken), undefined, "DB disabled 应在下一请求生效");
  await getPool().query("UPDATE users SET disabled=0 WHERE id=$1", [account.userId]);
  assert.equal(await db.getAdminSessionUser(afterRestoreToken), undefined, "重新启用也不能复活已撤销会话");

  const changedHash = access.hashAdminPassword("Ape!Admin-rotated-93$LmQ");
  await assert.rejects(
    () => db.ensureAdminPasswordAccount({ ...rotated, passwordHash: changedHash }),
    /递增 credentialVersion/
  );

  const startupRotated = {
    ...rotated,
    passwordHash: changedHash,
    credentialVersion: rotated.credentialVersion + 1,
  };
  const beforeStartupSync = await db.createAdminLoginSessions(
    account.userId,
    rotated.credentialVersion,
    2 * 3600
  );
  process.env.ADMIN_PASSWORD_ACCOUNT_B64 = encodeAccount(startupRotated);
  await db.initSchema();
  assert.equal(
    await db.getAdminSessionUser(beforeStartupSync.adminToken),
    undefined,
    "启动期应在首次新密码登录前提升版本并撤销旧会话"
  );
  assert.equal(
    await db.getSessionUser(beforeStartupSync.userToken),
    undefined,
    "凭据轮换也必须撤销配套的普通前台会话"
  );
  assert.equal(
    Number(
      (
        await getPool().query(
          "SELECT credential_version FROM admin_password_principals WHERE user_id=$1",
          [account.userId]
        )
      ).rows[0].credential_version
    ),
    startupRotated.credentialVersion
  );
  await assert.rejects(() => db.ensureAdminPasswordAccount(rotated), /版本已过期/);

  const replacement = {
    ...startupRotated,
    userId: "password-admin-abcdefab-cdef-abcd-efab-cdefabcdefab",
    credentialVersion: startupRotated.credentialVersion + 1,
  };
  process.env.ADMIN_PASSWORD_ACCOUNT_B64 = encodeAccount(replacement);
  await db.initSchema();
  const oldPrincipal = (
    await getPool().query(
      "SELECT enabled FROM admin_password_principals WHERE user_id=$1",
      [account.userId]
    )
  ).rows[0];
  const oldUser = await db.getUserById(account.userId);
  assert.equal(Number(oldPrincipal.enabled), 0);
  assert.equal(Number(oldUser?.is_admin), 0);
  assert.equal(oldUser?.admin_role, null);
  assert.equal((await db.getUserById(replacement.userId))?.admin_role, "super");
  assert.equal(await db.countSuperAdmins(), 1);

  await assert.rejects(
    () => db.ensureAdminPasswordAccount({
      ...replacement,
      expiresAt: replacement.expiresAt + 86400_000,
    }),
    /有效期已变化|递增 credentialVersion/
  );

  const invalidConfigSessions = await db.createAdminLoginSessions(
    replacement.userId,
    replacement.credentialVersion,
    2 * 3600
  );
  process.env.ADMIN_PASSWORD_ACCOUNT_B64 = "malformed-config!";
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await db.initSchema();
  } finally {
    console.error = originalConsoleError;
    process.env.ADMIN_PASSWORD_ACCOUNT_B64 = encodeAccount(replacement);
  }
  assert.equal(await db.getAdminSessionUser(invalidConfigSessions.adminToken), undefined);
  assert.equal(await db.getSessionUser(invalidConfigSessions.userToken), undefined);

  const blue = {
    ...replacement,
    userId: "password-admin-11111111-2222-3333-4444-555555555555",
    credentialVersion: replacement.credentialVersion + 1,
  };
  const green = {
    ...replacement,
    userId: "password-admin-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    credentialVersion: replacement.credentialVersion + 1,
  };
  await Promise.all([
    db.ensureAdminPasswordAccount(blue),
    db.ensureAdminPasswordAccount(green),
  ]);
  const concurrentRows = (
    await getPool().query(
      `SELECT p.user_id,p.enabled,u.is_admin,u.admin_role
         FROM admin_password_principals p JOIN users u ON u.id=p.user_id
        WHERE p.user_id=ANY($1::text[]) ORDER BY p.user_id`,
      [[blue.userId, green.userId]]
    )
  ).rows;
  const enabledRows = concurrentRows.filter((row) => Number(row.enabled) === 1);
  assert.equal(enabledRows.length, 1, "不同 userId 并发 provision 后只能有一个可信密码超管");
  assert.equal(Number(enabledRows[0].is_admin), 1);
  assert.equal(enabledRows[0].admin_role, "super");
  for (const loser of concurrentRows.filter((row) => Number(row.enabled) === 0)) {
    assert.equal(Number(loser.is_admin), 0);
    assert.equal(loser.admin_role, null);
  }
  const winningConfig = enabledRows[0].user_id === blue.userId ? blue : green;
  process.env.ADMIN_PASSWORD_ACCOUNT_B64 = encodeAccount(winningConfig);
});

test("末位超管守卫与运行时使用同一身份口径，并发降级最多成功一个", async () => {
  const restoreFlag = process.env.ADMIN_PASSWORD_LOGIN_ENABLED;
  const restoreNodeEnv = process.env.NODE_ENV;
  try {
    process.env.ADMIN_PASSWORD_LOGIN_ENABLED = "0";
    process.env.NODE_ENV = "production";
    await getPool().query(
      "UPDATE users SET is_admin=0,admin_role=NULL WHERE id !~ '^password-admin-[a-f0-9-]{16,80}$'"
    );
    const prefixId = "password-admin-human-readable-prefix";
    await getPool().query(
      `INSERT INTO users(id,name,phone,created_at,last_seen,is_admin,admin_role)
       VALUES($1,$2,$3,$4,$4,1,'super')`,
      [prefixId, "前缀碰撞超管", "139" + "00009885", Date.now()]
    );
    const second = await db.createUserByPhone("139" + "00009886", "并发超管");
    await db.setUserAdminRole(second.id, "super");
    await getPool().query(
      `INSERT INTO users(id,name,phone,created_at,last_seen,is_admin,admin_role)
       VALUES($1,$2,'',$3,$3,1,'super')`,
      ["empty-identity-super", "空身份假超管", Date.now()]
    );

    assert.equal(access.isAdminPasswordUserId(prefixId), false);
    assert.equal(admin.adminRoleOf(await db.getUserById(prefixId)), "super");
    assert.equal(admin.adminRoleOf(await db.getUserById("empty-identity-super")), null);
    const effectiveRows = (
      await getPool().query(
        `SELECT id FROM users
          WHERE disabled=0 AND plan_tier<>'test'
            AND id !~ '^password-admin-[a-f0-9-]{16,80}$'
            AND (NULLIF(BTRIM(phone),'') IS NOT NULL OR NULLIF(BTRIM(wechat_openid),'') IS NOT NULL)
            AND (admin_role='super' OR ((admin_role IS NULL OR admin_role NOT IN ('super','operator','auditor')) AND is_admin=1))
          ORDER BY id`
      )
    ).rows.map((row) => row.id);
    assert.deepEqual(effectiveRows, [prefixId, second.id].sort());
    assert.equal(await db.countSuperAdmins(), 2);

    const results = await Promise.all([
      db.setUserAdminRoleGuarded(prefixId, null),
      db.setUserAdminRoleGuarded(second.id, null),
    ]);
    assert.deepEqual(results.sort(), ["last_super", "ok"]);
    assert.equal(await db.countSuperAdmins(), 1);
  } finally {
    process.env.ADMIN_PASSWORD_LOGIN_ENABLED = restoreFlag ?? "1";
    if (restoreNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = restoreNodeEnv;
  }
});

test("独立登录页只有用户名/密码，前后台均有明确切换入口且禁止索引", () => {
  const page = fs.readFileSync(new URL("../../app/admin-login/page.tsx", import.meta.url), "utf8");
  const component = fs.readFileSync(
    new URL("../../components/AdminPasswordLogin.tsx", import.meta.url),
    "utf8"
  );
  const accountMenu = fs.readFileSync(new URL("../../components/AccountMenu.tsx", import.meta.url), "utf8");
  const adminLayout = fs.readFileSync(new URL("../../app/admin/layout.tsx", import.meta.url), "utf8");
  const homePage = fs.readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
  const studioRoute = fs.readFileSync(
    new URL("../../app/api/notebooks/[id]/studio/route.ts", import.meta.url),
    "utf8"
  );
  const nextConfig = fs.readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  const robots = fs.readFileSync(new URL("../../public/robots.txt", import.meta.url), "utf8");
  const envExample = fs.readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

  assert.match(page, /adminPasswordAccount\(\)/);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /index:\s*false/);
  assert.match(page, /noarchive:\s*true/);
  assert.match(page, /query\.next === "\/" \? "\/" : "\/admin"/);

  assert.equal((component.match(/<input\b/g) ?? []).length, 2);
  assert.match(component, /name="username"[\s\S]*autoComplete="username"/);
  assert.match(component, /name="password"[\s\S]*autoComplete="current-password"/);
  assert.doesNotMatch(component, /name="phone"|type="tel"|\/api\/auth\/(?:otp|request-code|send-code)/i);
  assert.match(component, /busyRef\.current/);
  assert.match(component, /fetch\("\/api\/auth\/admin-password"/);
  assert.match(component, /nextPath\?: "\/" \| "\/admin"/);
  assert.match(component, /window\.location\.replace\(nextPath\)/);

  assert.match(homePage, /adminRoleOf\(user\)/);
  assert.match(accountMenu, /user\.adminRole\s*&&/);
  assert.match(accountMenu, /window\.location\.href\s*=\s*"\/admin"/);
  assert.match(accountMenu, />进入管理中心</);
  assert.match(adminLayout, /href="\/"[\s\S]*返回应用/);
  assert.match(adminLayout, /href="\/admin-login"[\s\S]*切换管理员/);
  assert.match(studioRoute, /requireRole\(req,\s*"settings",\s*\{ write: true \}\)/);
  assert.doesNotMatch(studioRoute, /adminRoleOf\(user\)/);

  assert.match(nextConfig, /source:\s*"\/admin-login"/);
  assert.match(nextConfig, /private, no-store, max-age=0/);
  assert.match(nextConfig, /noindex, nofollow, noarchive/);
  assert.match(nextConfig, /Referrer-Policy[\s\S]*no-referrer/);
  assert.match(robots, /Disallow:\s*\/admin-login/);
  assert.match(envExample, /ADMIN_PASSWORD_LOGIN_ENABLED=0/);
  assert.match(envExample, /ADMIN_PASSWORD_SESSION_HOURS=2/);
  assert.match(envExample, /scrypt\$32768\$8\$3/);
});
