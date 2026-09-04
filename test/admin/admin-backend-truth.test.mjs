import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

process.env.PUBLIC_ORIGIN = "https://notes.example.test";
process.env.ADMIN_PASSWORD_LOGIN_ENABLED = "0";
delete process.env.ADMIN_PASSWORD_ACCOUNT_B64;

const db = await freshPgDb("admin_backend_truth");
const { getPool } = await import("../../lib/pg.ts");
const auth = await import("../../lib/auth.ts");
const metrics = await import("../../lib/metrics.ts");
const analyticsRoute = await import("../../app/api/admin/analytics/route.ts");
const accountsRoute = await import("../../app/api/admin/accounts/route.ts");
const creditsRoute = await import("../../app/api/admin/credits/route.ts");
const notebookDetailRoute = await import("../../app/api/admin/notebooks/[id]/route.ts");
const opsRoute = await import("../../app/api/admin/ops/route.ts");
const overviewRoute = await import("../../app/api/admin/overview/route.ts");
const userDetailRoute = await import("../../app/api/admin/users/[id]/route.ts");
const usersRoute = await import("../../app/api/admin/users/route.ts");
const { NextRequest } = await import("next/server");

const pool = getPool();

const superUser = await db.createUserByPhone("139" + "00009601", "后台真源超管");
await db.setUserAdminRole(superUser.id, "super");
const superToken = await db.createSession(superUser.id);
const operator = await db.createUserByPhone("139" + "00009602", "后台真源运营");
await db.setUserAdminRole(operator.id, "operator");
const operatorToken = await db.createSession(operator.id);
const auditor = await db.createUserByPhone("139" + "00009603", "后台真源审计");
await db.setUserAdminRole(auditor.id, "auditor");
const auditorToken = await db.createSession(auditor.id);

function request(path, { method = "GET", token = superToken, body } = {}) {
  const headers = new Headers({ origin: "https://notes.example.test" });
  if (token) headers.set("cookie", `${auth.SESSION_COOKIE}=${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`https://notes.example.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("固定分析、数据工作台和积分对账共用净消耗口径", async () => {
  const now = Date.now();
  const ledger = [
    ["chat", 10],
    ["refund:chat", -3],
    ["settle:studio:briefing", -2],
    ["admin:grant", -100],
    ["referral:first_chat", -100],
    ["bonus:trial", -200],
    ["compensation:incident", -50],
  ];
  for (const [op, credits] of ledger) {
    await pool.query(
      "INSERT INTO credit_ledger(user_id,op,credits,bonus,plan_credits,ts) VALUES ($1,$2,$3,0,0,$4)",
      ["ledger-contract-user", op, credits, now]
    );
  }

  const direct = await db.creditConsumptionByDaySince(now - 60_000);
  assert.equal(direct.reduce((sum, row) => sum + Number(row.credits), 0), 5);

  const fixedResponse = await analyticsRoute.GET(request("/api/admin/analytics"));
  assert.equal(fixedResponse.status, 200);
  const fixed = await fixedResponse.json();
  assert.equal(fixed.credits.at(-1).credits, 5);

  const workbench = await metrics.queryMetrics(["crd"], 1);
  assert.equal(workbench.series[0].values[0], 5);

  const reconciliationResponse = await creditsRoute.GET(request("/api/admin/credits?days=1"));
  assert.equal(reconciliationResponse.status, 200);
  assert.equal((await reconciliationResponse.json()).totalCredits, 5);
});

test("积分配置整批校验、支持 cad_rebuild，并与审计同事务提交", async () => {
  const invalid = await creditsRoute.PUT(
    request("/api/admin/credits", {
      method: "PUT",
      body: {
        set: {
          "credit.cost.chat": "7",
          "credit.cost.not-real": "2",
          "credit.studio.video": "9".repeat(80),
        },
      },
    })
  );
  assert.equal(invalid.status, 400);
  assert.equal(await db.getSetting("credit.cost.chat"), null, "整批失败不得写入前面的合法项");

  const valid = await creditsRoute.PUT(
    request("/api/admin/credits", {
      method: "PUT",
      body: {
        set: {
          "credit.cost.cad_rebuild": "6",
          "credit.studio.cad": "13",
          "credit.anchor": "0.005",
        },
      },
    })
  );
  assert.equal(valid.status, 200);
  assert.equal(await db.getSetting("credit.cost.cad_rebuild"), "6");
  assert.equal(await db.getSetting("credit.studio.cad"), "13");
  assert.equal(await db.getSetting("credit.anchor"), "0.005");
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT COUNT(*) n FROM activity_log WHERE actor_id=$1 AND action='admin.credits_update'",
          [superUser.id]
        )
      ).rows[0].n
    ),
    1
  );
});

test("运维接口只把无心跳 running 当孤儿，queued 不会被误杀", async () => {
  const notebook = await db.createNotebook(superUser.id, "运维任务合同", "🛠️");
  const old = Date.now() - db.JOB_STALE_MS - 10_000;
  const queued = await db.createJob(notebook.id, superUser.id, "briefing", "排队任务", { __sponsored: true });
  const running = await db.createJob(notebook.id, superUser.id, "briefing", "孤儿任务", { __sponsored: true });
  await pool.query("UPDATE jobs SET updated_at=$1 WHERE id=$2", [old, queued.id]);
  await pool.query("UPDATE jobs SET status='running',run_attempt=1,updated_at=$1 WHERE id=$2", [old, running.id]);

  const denied = await opsRoute.POST(
    request("/api/admin/ops", { method: "POST", token: operatorToken, body: { action: "clear_stuck" } })
  );
  assert.equal(denied.status, 403);

  const recovered = await opsRoute.POST(
    request("/api/admin/ops", { method: "POST", body: { action: "clear_stuck" } })
  );
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).recovered, 1);
  const states = (
    await pool.query("SELECT id,status,error FROM jobs WHERE id=ANY($1::text[]) ORDER BY id", [
      [queued.id, running.id],
    ])
  ).rows;
  assert.equal(states.find((row) => row.id === queued.id).status, "queued");
  assert.equal(states.find((row) => row.id === queued.id).error, null);
  assert.equal(states.find((row) => row.id === running.id).status, "queued", "孤儿首选重排而非直接失败");

  const infoResponse = await opsRoute.GET(request("/api/admin/ops"));
  assert.equal(infoResponse.status, 200);
  const info = await infoResponse.json();
  assert.equal(info.database.engine, "PostgreSQL");
  assert.ok(info.database.sizeBytes > 0);
  assert.deepEqual(info.backup.mode, "external");
  assert.equal(info.backup.inApp, false);
  assert.equal(info.backups, undefined, "不得再返回 SQLite 备份文件假状态");
});

test("任务重试授权下沉到 monitor write，审计员与其它运维动作仍拒绝", async () => {
  const anonymous = request("/api/admin/ops", { method: "POST", token: null });
  let bodyRead = false;
  anonymous.json = async () => {
    bodyRead = true;
    return { action: "vacuum" };
  };
  const anonymousResponse = await opsRoute.POST(anonymous);
  assert.equal(anonymousResponse.status, 401);
  assert.equal(bodyRead, false, "未认证管理请求不得先解析请求体");

  const notebook = await db.createNotebook(superUser.id, "任务重试授权", "↻");
  const failed = await db.createJob(notebook.id, superUser.id, "briefing", "失败简报", { __sponsored: true });
  await pool.query("UPDATE jobs SET status='error',error='测试失败' WHERE id=$1", [failed.id]);

  const retried = await opsRoute.POST(
    request("/api/admin/ops", {
      method: "POST",
      token: operatorToken,
      body: { action: "retry_job", jobId: failed.id },
    })
  );
  assert.equal(retried.status, 200);
  const retriedData = await retried.json();
  assert.equal(retriedData.newJobId, failed.id, "人工重试应复用原任务，避免重复生成赞助任务");
  assert.equal(retriedData.reused, true);
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM jobs WHERE id=$1", [failed.id])).rows[0].n), 1);

  const duplicateRetry = await opsRoute.POST(
    request("/api/admin/ops", {
      method: "POST",
      token: operatorToken,
      body: { action: "retry_job", jobId: failed.id },
    })
  );
  assert.equal(duplicateRetry.status, 409, "重复点击不能再生成一条赞助任务");

  const failedCad = await db.createJob(notebook.id, superUser.id, "cad", "失败 CAD", { __sponsored: true });
  await pool.query(
    "UPDATE jobs SET status='error',error='建模失败',started_at=$2,finished_at=$3,stage='failed',stage_started_at=$3 WHERE id=$1",
    [failedCad.id, Date.now() - 5_000, Date.now() - 1_000]
  );
  const retriedCad = await opsRoute.POST(
    request("/api/admin/ops", {
      method: "POST",
      token: operatorToken,
      body: { action: "retry_job", jobId: failedCad.id },
    })
  );
  assert.equal(retriedCad.status, 200);
  const cadState = (
    await pool.query("SELECT status,finished_at,stage,stage_started_at FROM jobs WHERE id=$1", [failedCad.id])
  ).rows[0];
  assert.equal(cadState.status, "queued");
  assert.equal(Number(cadState.finished_at), 0, "CAD 重试排队期不得继续冒充终态时延样本");
  assert.equal(cadState.stage, "queued");
  assert.ok(Number(cadState.stage_started_at) > 0);

  const canceled = await db.createJob(notebook.id, superUser.id, "briefing", "已取消简报", { __sponsored: true });
  await pool.query("UPDATE jobs SET status='canceled' WHERE id=$1", [canceled.id]);
  const reviveCanceled = await opsRoute.POST(
    request("/api/admin/ops", {
      method: "POST",
      token: operatorToken,
      body: { action: "retry_job", jobId: canceled.id },
    })
  );
  assert.equal(reviveCanceled.status, 409, "人工取消意图不能被运营重试复活");

  const denied = await opsRoute.POST(
    request("/api/admin/ops", {
      method: "POST",
      token: auditorToken,
      body: { action: "retry_job", jobId: failed.id },
    })
  );
  assert.equal(denied.status, 403);

  const stillSuperOnly = await opsRoute.POST(
    request("/api/admin/ops", {
      method: "POST",
      token: operatorToken,
      body: { action: "export_settings" },
    })
  );
  assert.equal(stillSuperOnly.status, 403);
});

test("撤精选与转私有原子停频道并取消在途 feed，旧新增/排序入口拒绝旁路", async () => {
  const notebook = await db.createNotebook(superUser.id, "精选停订阅合同", "📰");
  await pool.query("UPDATE notebooks SET featured=1,public=1 WHERE id=$1", [notebook.id]);
  const channelId = await db.createFeedChannel({
    notebookId: notebook.id,
    kind: "rss",
    url: "https://example.com/feed.xml",
    createdBy: superUser.id,
  });
  const queued = await db.createJob(notebook.id, null, "feed_enum", "订阅源轮询", { channelId }, -10, channelId);
  const running = await db.createJob(notebook.id, null, "feed_ingest", "订阅源入库", { channelId }, -10, channelId);
  await pool.query("UPDATE jobs SET status='running',run_attempt=1 WHERE id=$1", [running.id]);

  const removed = await usersRoute.POST(
    request("/api/admin/users", {
      method: "POST",
      token: operatorToken,
      body: { action: "unfeature", notebookId: notebook.id },
    })
  );
  assert.equal(removed.status, 200);
  const nb = (await pool.query("SELECT featured,public FROM notebooks WHERE id=$1", [notebook.id])).rows[0];
  assert.deepEqual({ featured: Number(nb.featured), public: Number(nb.public) }, { featured: 0, public: 1 });
  assert.equal(Number((await pool.query("SELECT enabled FROM feed_channels WHERE id=$1", [channelId])).rows[0].enabled), 0);
  const jobStates = (
    await pool.query("SELECT id,status FROM jobs WHERE id=ANY($1::text[])", [[queued.id, running.id]])
  ).rows;
  assert.ok(jobStates.every((row) => row.status === "canceled"));

  const rejected = await usersRoute.POST(
    request("/api/admin/users", {
      method: "POST",
      token: operatorToken,
      body: { action: "feature", notebookId: notebook.id },
    })
  );
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, "use_featured_api");

  const privateNotebook = await db.createNotebook(superUser.id, "转私有停订阅", "🔒");
  await pool.query("UPDATE notebooks SET featured=1,public=1 WHERE id=$1", [privateNotebook.id]);
  await db.createFeedChannel({
    notebookId: privateNotebook.id,
    kind: "rss",
    url: "https://example.com/private.xml",
    createdBy: superUser.id,
  });
  const privatized = await usersRoute.POST(
    request("/api/admin/users", {
      method: "POST",
      token: operatorToken,
      body: { action: "set_private", notebookId: privateNotebook.id },
    })
  );
  assert.equal(privatized.status, 200);
  const privateState = (
    await pool.query("SELECT featured,public FROM notebooks WHERE id=$1", [privateNotebook.id])
  ).rows[0];
  assert.deepEqual(
    { featured: Number(privateState.featured), public: Number(privateState.public) },
    { featured: 0, public: 0 }
  );
});

test("审计员不能揭示用户明文，详情与私有内容接口只返回脱敏元数据", async () => {
  await pool.query(
    "UPDATE users SET email='super@example.test',wechat_nickname='WECHAT-PRIVATE-SENTINEL',invite_code='INVITE-SECRET' WHERE id=$1",
    [superUser.id]
  );
  await pool.query("UPDATE users SET email='operator@example.test' WHERE id=$1", [operator.id]);

  const reveal = await usersRoute.GET(
    request("/api/admin/users?reveal=1", { token: auditorToken })
  );
  assert.equal(reveal.status, 403);

  const auditorList = await usersRoute.GET(
    request("/api/admin/users", { token: auditorToken })
  );
  assert.equal(auditorList.status, 200);
  const auditorUsers = (await auditorList.json()).users;
  const auditorSuper = auditorUsers.find((user) => user.id === superUser.id);
  assert.equal(auditorSuper.phone, "139****01");
  assert.equal(auditorSuper.email, "s***@example.test");
  assert.equal(auditorSuper.wechat_nickname, null);
  assert.equal(JSON.stringify(auditorUsers).includes("WECHAT-PRIVATE-SENTINEL"), false);

  const auditorPiiSearch = await usersRoute.GET(
    request(`/api/admin/users?q=${encodeURIComponent(superUser.phone ?? "")}`, { token: auditorToken })
  );
  assert.equal(auditorPiiSearch.status, 200);
  assert.deepEqual((await auditorPiiSearch.json()).users, [], "审计员不能用手机号枚举用户存在性");

  const auditorAccounts = await accountsRoute.GET(
    request("/api/admin/accounts", { token: auditorToken })
  );
  assert.equal(auditorAccounts.status, 200);
  const accountRows = (await auditorAccounts.json()).accounts;
  const auditedSuperAccount = accountRows.find((account) => account.id === superUser.id);
  assert.equal(auditedSuperAccount.phone, "139****01");
  assert.equal(auditedSuperAccount.email, "s***@example.test");
  const auditorAccountLookup = await accountsRoute.GET(
    request(`/api/admin/accounts?q=${encodeURIComponent(superUser.phone ?? "")}`, { token: auditorToken })
  );
  assert.equal(auditorAccountLookup.status, 403, "审计员不得调用待授权用户查找旁路");

  const searched = await usersRoute.GET(
    request(`/api/admin/users?q=${encodeURIComponent(superUser.phone ?? "")}`, { token: operatorToken })
  );
  assert.equal(searched.status, 200);
  const searchedData = await searched.json();
  assert.deepEqual(searchedData.users.map((user) => user.id), [superUser.id]);
  assert.equal(searchedData.users[0].phone, "139****01", "搜索用明文匹配，返回仍保持脱敏");

  const detail = await userDetailRoute.GET(
    request(`/api/admin/users/${superUser.id}`, { token: auditorToken }),
    { params: Promise.resolve({ id: superUser.id }) }
  );
  assert.equal(detail.status, 200);
  const detailData = await detail.json();
  assert.equal(detailData.user.phone, "139****01");
  assert.equal(detailData.user.email, "s***@example.test");
  assert.equal(detailData.user.invite_code, null);

  const notebook = await db.createNotebook(superUser.id, "审计内容脱敏", "🔐");
  await pool.query(
    "UPDATE notebooks SET summary='NOTEBOOK-SUMMARY-SENTINEL',chat_instructions='CHAT-INSTRUCTION-SENTINEL' WHERE id=$1",
    [notebook.id]
  );
  await db.createNote(notebook.id, "私有笔记标题", "不可下发的私有笔记正文");
  await db.addMessage(notebook.id, "user", "不可下发的私有对话正文");
  const source = await db.createSource(notebook.id, "私有来源标题", "text");
  await pool.query(
    "UPDATE sources SET status='ready',content='SOURCE-CONTENT-SENTINEL',origin='https://private.example/secret',summary='SOURCE-SUMMARY-SENTINEL' WHERE id=$1",
    [source.id]
  );
  await db.createStudioOutput(
    notebook.id,
    "briefing",
    "私有制品标题",
    "OUTPUT-CONTENT-SENTINEL",
    JSON.stringify({ private: "OUTPUT-DATA-SENTINEL" })
  );
  await db.addCollaborator(notebook.id, operator.id, "viewer");
  const notebookDetail = await notebookDetailRoute.GET(
    request(`/api/admin/notebooks/${notebook.id}`, { token: auditorToken }),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  assert.equal(notebookDetail.status, 200);
  const notebookData = await notebookDetail.json();
  assert.equal(notebookData.notes[0].title, "私有笔记标题");
  assert.equal(notebookData.notes[0].content, undefined);
  assert.equal(notebookData.messages[0].content, undefined);
  assert.equal(notebookData.notebook.summary, undefined);
  assert.equal(notebookData.notebook.chat_instructions, undefined);
  assert.equal(notebookData.sources[0].origin, undefined);
  assert.equal(notebookData.sources[0].summary, undefined);
  assert.equal(notebookData.outputs[0].content, undefined);
  assert.equal(notebookData.outputs[0].data, undefined);
  assert.equal(notebookData.collaborators[0].phone, "139****02");
  assert.equal(notebookData.collaborators[0].email, "o***@example.test");
  const serialized = JSON.stringify(notebookData);
  for (const sentinel of [
    "NOTEBOOK-SUMMARY-SENTINEL",
    "CHAT-INSTRUCTION-SENTINEL",
    "SOURCE-CONTENT-SENTINEL",
    "SOURCE-SUMMARY-SENTINEL",
    "OUTPUT-CONTENT-SENTINEL",
    "OUTPUT-DATA-SENTINEL",
    "不可下发的私有笔记正文",
    "不可下发的私有对话正文",
  ]) {
    assert.equal(serialized.includes(sentinel), false, `审计员响应泄露：${sentinel}`);
  }

  const operatorDetail = await notebookDetailRoute.GET(
    request(`/api/admin/notebooks/${notebook.id}`, { token: operatorToken }),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  assert.equal(operatorDetail.status, 200);
  assert.equal((await operatorDetail.json()).notes[0].content, "不可下发的私有笔记正文");
});

test("运营总览的数据库大小来自 PostgreSQL 当前库", async () => {
  const feedbackNotebook = await db.createNotebook(superUser.id, "反馈脱敏合同", "👎");
  const down = await db.addMessage(
    feedbackNotebook.id,
    "assistant",
    "DOWNVOTED-PRIVATE-CONTENT-SENTINEL"
  );
  await pool.query("UPDATE messages SET feedback='down' WHERE id=$1", [down.id]);
  const response = await overviewRoute.GET(request("/api/admin/overview"));
  assert.equal(response.status, 200);
  const data = await response.json();
  const expected = Number((await pool.query("SELECT pg_database_size(current_database()) n")).rows[0].n);
  assert.equal(data.dbSize, expected);
  assert.ok(data.dbSize > 0);
  assert.ok(data.recentActivity.length > 0, "超管应能在总览查看最近审计");
  assert.equal(data.recentDown[0].content, "DOWNVOTED-PRIVATE-CONTENT-SENTINEL");

  const auditorResponse = await overviewRoute.GET(
    request("/api/admin/overview", { token: auditorToken })
  );
  assert.equal(auditorResponse.status, 200);
  const auditorOverview = await auditorResponse.json();
  assert.equal(auditorOverview.recentDown[0].content, undefined);
  assert.equal(
    JSON.stringify(auditorOverview).includes("DOWNVOTED-PRIVATE-CONTENT-SENTINEL"),
    false,
    "审计员总览不得旁路读取私有回答正文"
  );

  const operatorResponse = await overviewRoute.GET(
    request("/api/admin/overview", { token: operatorToken })
  );
  assert.equal(operatorResponse.status, 200);
  assert.deepEqual((await operatorResponse.json()).recentActivity, []);
});
