import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { freshPgDb, withoutTrial } from "../helpers/pgdb.mjs";

const db = await freshPgDb("cad_preflight_route_v3");
const { getPool } = await import("../../lib/pg.ts");
const preflightRoute = await import("../../app/api/notebooks/[id]/cad/preflight/route.ts");
const studioRoute = await import("../../app/api/notebooks/[id]/studio/route.ts");
const { resolveCadPreflight } = await import("../../lib/cad-preflight-server.ts");
const { assertCadRequestPlanStillCurrent } = await import("../../lib/jobs.ts");
const { buildFrozenGenerationCorpusBundle } = await import("../../lib/corpus.ts");

const request = (path, token, body) => new NextRequest(`http://localhost${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    cookie: `nb_session=${token}`,
  },
  body: JSON.stringify(body),
});

async function fixture() {
  const user = await db.createUserByEmail(`cad-preflight-${Date.now()}@example.com`, "CAD 预检");
  const notebook = await db.createNotebook(user.id, "CAD v3 预检", "📐");
  const token = await db.createSession(user.id);
  return { user, notebook, token };
}

async function postPreflight(notebookId, token, body) {
  return preflightRoute.POST(
    request(`/api/notebooks/${notebookId}/cad/preflight`, token, body),
    { params: Promise.resolve({ id: notebookId }) }
  );
}

test("描述建模和固定模板可以无来源免费预检", async () => {
  const { notebook, token } = await fixture();
  const prompt = await postPreflight(notebook.id, token, {
    mode: "prompt_driven",
    sourceIds: [],
    instruction: "生成一个机器人手臂，高度 600mm",
    templateId: "text2cad",
    allowAssumptions: true,
  });
  assert.equal(prompt.status, 200);
  const promptBody = await prompt.json();
  assert.equal(promptBody.status, "ready");
  assert.equal(promptBody.plan.mode, "prompt_driven");
  assert.equal(promptBody.plan.target.objectId, "robotic_arm");
  assert.deepEqual(promptBody.plan.sourceSnapshots, []);
  assert.match(promptBody.planHash, /^[a-f0-9]{64}$/);

  const fixed = await postPreflight(notebook.id, token, {
    mode: "fixed_template",
    sourceIds: [],
    templateId: "plate",
    parameters: { length: 120, width: 80, thickness: 5, hole_count: 4 },
    allowAssumptions: false,
  });
  assert.equal(fixed.status, 200);
  const fixedBody = await fixed.json();
  assert.equal(fixedBody.plan.mode, "fixed_template");
  assert.equal(fixedBody.plan.templateId, "plate");
});

test("描述驱动不把左栏勾选的无关来源纳入计划或几何证据", async () => {
  const { notebook, token } = await fixture();
  const sourceText = "建模目标为机械臂，整体高度 600mm。";
  const source = await db.createSource(notebook.id, "无关机械臂规格", "pdf");
  await db.finalizeSource(source.id, {
    status: "ready",
    content: sourceText,
    char_count: sourceText.length,
    chunk_count: 0,
  });
  const response = await postPreflight(notebook.id, token, {
    mode: "prompt_driven",
    sourceIds: [source.id],
    instruction: "生成 120×80×5mm 的安装板",
    templateId: "text2cad",
    allowAssumptions: false,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan.target.objectId, "plate");
  assert.deepEqual(body.plan.sourceSnapshots, []);
  assert.deepEqual(body.plan.target.sourceIds, []);
});

test("零积分用户仍可做免费预检，只在确认入队时进入积分闸", async () => {
  const { user, notebook, token } = await fixture();
  await withoutTrial(user.id);
  const response = await postPreflight(notebook.id, token, {
    mode: "fixed_template",
    sourceIds: [],
    templateId: "plate",
    parameters: { length: 120, width: 80, thickness: 5, hole_count: 4 },
    allowAssumptions: false,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ready");
});

test("省略 allowAssumptions 不等于同意假设，概念装配必须显式勾选", async () => {
  const { notebook, token } = await fixture();
  const response = await postPreflight(notebook.id, token, {
    mode: "prompt_driven",
    sourceIds: [],
    templateId: "text2cad",
    instruction: "生成整体高度 600mm 的机械臂",
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, "cad_invalid_explicit_constraint");
  assert.equal(body.issues[0].field, "allowAssumptions");
});

test("来源驱动在入队和扣分前拒绝泛资料，但接受唯一设计目标", async () => {
  const { user, notebook, token } = await fixture();
  const paperText = "论文包含摘要、正文和参考文献，页面使用 A4 纸。";
  const paper = await db.createSource(notebook.id, "论文格式规范", "pdf");
  await db.finalizeSource(paper.id, {
    status: "ready",
    content: paperText,
    char_count: paperText.length,
    chunk_count: 0,
  });
  const rejected = await postPreflight(notebook.id, token, {
    mode: "source_driven",
    sourceIds: [paper.id],
  });
  assert.equal(rejected.status, 422);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.status, "needs_input");
  assert.equal(rejectedBody.code, "cad_target_required");

  const before = await getPool().query("SELECT COUNT(*)::int AS n FROM jobs WHERE user_id=$1", [user.id]);
  assert.equal(before.rows[0].n, 0);

  const designText = "建模目标为机械臂，整体高度 600mm，包含底座、肩部、上臂、前臂和腕部。";
  const design = await db.createSource(notebook.id, "机械臂设计任务书", "pdf");
  await db.finalizeSource(design.id, {
    status: "ready",
    content: designText,
    char_count: designText.length,
    chunk_count: 0,
  });
  const accepted = await postPreflight(notebook.id, token, {
    mode: "source_driven",
    sourceIds: [design.id],
    allowAssumptions: true,
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.plan.target.objectId, "robotic_arm");
  assert.equal(acceptedBody.plan.evidencePolicy.requireSourceBackedGeometry, true);
});

test("固定模板业务规则在预检阶段拒绝，不创建任务", async () => {
  const { user, notebook, token } = await fixture();
  const response = await postPreflight(notebook.id, token, {
    mode: "fixed_template",
    sourceIds: [],
    templateId: "plate",
    parameters: { thickness: 0.1 },
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, "cad_invalid_explicit_constraint");
  const jobs = await getPool().query("SELECT COUNT(*)::int AS n FROM jobs WHERE user_id=$1", [user.id]);
  assert.equal(jobs.rows[0].n, 0);
});

test("固定模板不使用来源，也不静默忽略未结构化补充要求", async () => {
  const { notebook, token } = await fixture();
  const text = "这是一份与安装板无关的资料。";
  const source = await db.createSource(notebook.id, "无关来源", "pdf");
  await db.finalizeSource(source.id, { status: "ready", content: text, char_count: text.length, chunk_count: 0 });
  const accepted = await postPreflight(notebook.id, token, {
    mode: "fixed_template",
    sourceIds: [source.id],
    templateId: "plate",
    parameters: { length: 120, width: 80, thickness: 5 },
    allowAssumptions: false,
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).plan.sourceSnapshots, []);

  const rejected = await postPreflight(notebook.id, token, {
    mode: "fixed_template",
    sourceIds: [],
    templateId: "plate",
    parameters: { length: 120, width: 80, thickness: 5 },
    instruction: "材料为 ABS，工艺为注塑",
    allowAssumptions: false,
  });
  assert.equal(rejected.status, 422);
  const body = await rejected.json();
  assert.equal(body.code, "cad_request_invalid");
  assert.equal(body.issues[0].field, "instruction");
});

test("入队时服务端重算预检哈希，篡改或过期快照不扣分", async () => {
  const { user, notebook, token } = await fixture();
  const response = await studioRoute.POST(
    request(`/api/notebooks/${notebook.id}/studio`, token, {
      kind: "cad",
      cadMode: "prompt_driven",
      sourceIds: [],
      instruction: "生成 120×80×5mm 的四孔安装板",
      cadTemplate: "text2cad",
      cadAllowAssumptions: false,
      cadPreflightPlanHash: "0".repeat(64),
    }),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "cad_preflight_stale");
  const jobs = await getPool().query("SELECT COUNT(*)::int AS n FROM jobs WHERE user_id=$1", [user.id]);
  const charges = await getPool().query(
    "SELECT COUNT(*)::int AS n FROM credit_ledger WHERE user_id=$1 AND op='studio:cad'",
    [user.id]
  );
  assert.equal(jobs.rows[0].n, 0);
  assert.equal(charges.rows[0].n, 0);
});

test("同一 CAD 幂等键的网络重发只创建一个任务并扣一次积分", async () => {
  const { user, notebook, token } = await fixture();
  const preflightBody = {
    mode: "fixed_template",
    sourceIds: [],
    templateId: "plate",
    parameters: { length: 120, width: 80, thickness: 5, hole_count: 4 },
    allowAssumptions: false,
  };
  const preflight = await postPreflight(notebook.id, token, preflightBody);
  assert.equal(preflight.status, 200);
  const { planHash } = await preflight.json();
  const body = {
    kind: "cad",
    cadMode: "fixed_template",
    sourceIds: [],
    cadTemplate: "plate",
    cadParameters: preflightBody.parameters,
    cadAllowAssumptions: false,
    cadPreflightPlanHash: planHash,
    cadIdempotencyKey: "11111111-1111-4111-8111-111111111111",
  };
  const send = () => studioRoute.POST(
    request(`/api/notebooks/${notebook.id}/studio`, token, body),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  const first = await send();
  await withoutTrial(user.id);
  const second = await send();
  assert.equal(first.status, 202);
  assert.equal(second.status, 202, "原响应丢失后即使余额为 0 也必须返回原 job");
  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.equal(firstBody.job.id, secondBody.job.id);
  await db.createJob(notebook.id, user.id, "quiz", "占用在途1", {}, 0);
  await db.createJob(notebook.id, user.id, "mindmap", "占用在途2", {}, 0);
  await db.setSetting("credit.studio.cad", "99", "test");
  const afterLimitAndPriceChange = await send();
  assert.equal(afterLimitAndPriceChange.status, 202, "复用必须早于在途上限和新价格");
  const reusedBody = await afterLimitAndPriceChange.json();
  assert.equal(reusedBody.job.id, firstBody.job.id);
  assert.equal(reusedBody.billing.reservedCredits, firstBody.billing.reservedCredits);

  const jobs = await getPool().query(
    "SELECT COUNT(*)::int AS n FROM jobs WHERE user_id=$1 AND idempotency_key=$2",
    [user.id, body.cadIdempotencyKey]
  );
  const charges = await getPool().query(
    "SELECT COUNT(*)::int AS n FROM credit_ledger WHERE user_id=$1 AND op='studio:cad'",
    [user.id]
  );
  assert.equal(jobs.rows[0].n, 1);
  assert.equal(charges.rows[0].n, 1);
});

test("同一幂等键并发到达仍只产生一个 job 和一笔扣费", async () => {
  const { user, notebook, token } = await fixture();
  const parameters = { length: 100, width: 60, thickness: 5, hole_count: 4 };
  const preflight = await postPreflight(notebook.id, token, {
    mode: "fixed_template", sourceIds: [], templateId: "plate", parameters, allowAssumptions: false,
  });
  const { planHash } = await preflight.json();
  const body = {
    kind: "cad",
    cadMode: "fixed_template",
    sourceIds: [],
    cadTemplate: "plate",
    cadParameters: parameters,
    cadAllowAssumptions: false,
    cadPreflightPlanHash: planHash,
    cadIdempotencyKey: "22222222-2222-4222-8222-222222222222",
  };
  const send = () => studioRoute.POST(
    request(`/api/notebooks/${notebook.id}/studio`, token, body),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  const responses = await Promise.all([send(), send()]);
  assert.deepEqual(responses.map((response) => response.status), [202, 202]);
  const payloads = await Promise.all(responses.map((response) => response.json()));
  assert.equal(payloads[0].job.id, payloads[1].job.id);
  const jobs = await getPool().query("SELECT COUNT(*)::int AS n FROM jobs WHERE user_id=$1 AND idempotency_key=$2", [user.id, body.cadIdempotencyKey]);
  const charges = await getPool().query("SELECT COUNT(*)::int AS n FROM credit_ledger WHERE user_id=$1 AND op='studio:cad'", [user.id]);
  assert.equal(jobs.rows[0].n, 1);
  assert.equal(charges.rows[0].n, 1);
});

test("已扣费请求的幂等恢复早于当前来源重算，来源变化仍返回原 job", async () => {
  const { user, notebook, token } = await fixture();
  const original = "建模目标为安装板，长度 120mm，宽度 80mm，厚度 5mm。";
  const source = await db.createSource(notebook.id, "安装板规格", "pdf");
  await db.finalizeSource(source.id, { status: "ready", content: original, char_count: original.length, chunk_count: 0 });
  const preflight = await postPreflight(notebook.id, token, {
    mode: "source_driven", sourceIds: [source.id], allowAssumptions: false,
  });
  const { planHash } = await preflight.json();
  const body = {
    kind: "cad", cadMode: "source_driven", sourceIds: [source.id], cadTemplate: "auto",
    cadAllowAssumptions: false, cadPreflightPlanHash: planHash,
    cadIdempotencyKey: "33333333-3333-4333-8333-333333333333",
  };
  const send = () => studioRoute.POST(request(`/api/notebooks/${notebook.id}/studio`, token, body), {
    params: Promise.resolve({ id: notebook.id }),
  });
  const first = await send();
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  const changed = `${original}孔径 8mm。`;
  await db.finalizeSource(source.id, { status: "ready", content: changed, char_count: changed.length, chunk_count: 0 });
  const replay = await send();
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).job.id, firstBody.job.id);
  const counts = await getPool().query(
    `SELECT (SELECT COUNT(*) FROM jobs WHERE user_id=$1 AND idempotency_key=$2)::int AS jobs,
            (SELECT COUNT(*) FROM credit_ledger WHERE user_id=$1 AND op='studio:cad')::int AS charges`,
    [user.id, body.cadIdempotencyKey]
  );
  assert.deepEqual(counts.rows[0], { jobs: 1, charges: 1 });
});

test("排队期间来源变化会改变服务端重算 planHash，worker 必须在调模型前终止", async () => {
  const { notebook } = await fixture();
  const original = "建模目标为安装板，长度 120mm，宽度 80mm，厚度 5mm。";
  const source = await db.createSource(notebook.id, "安装板规格", "pdf");
  await db.finalizeSource(source.id, { status: "ready", content: original, char_count: original.length, chunk_count: 0 });
  const body = { mode: "source_driven", sourceIds: [source.id], allowAssumptions: false };
  const admitted = await resolveCadPreflight(notebook.id, body);
  assert.equal(admitted.result.ok, true);
  if (!admitted.result.ok) return;

  const changed = `${original}孔径 8mm。`;
  await db.finalizeSource(source.id, { status: "ready", content: changed, char_count: changed.length, chunk_count: 0 });
  const current = await resolveCadPreflight(notebook.id, body);
  assert.equal(current.result.ok, true);
  if (!current.result.ok) return;
  assert.notEqual(current.result.plan.planHash, admitted.result.plan.planHash);

  await assert.rejects(
    () => assertCadRequestPlanStillCurrent({
      notebookId: notebook.id,
      sourceIds: [source.id],
      cadAllowAssumptions: false,
      plan: admitted.result.plan,
    }),
    (error) => error?.code === "cad_source_conflict"
  );

  const jobsSource = await import("node:fs").then((fs) => fs.readFileSync(new URL("../../lib/jobs.ts", import.meta.url), "utf8"));
  assert.ok(jobsSource.indexOf("assertCadRequestPlanStillCurrent({") < jobsSource.indexOf("generateCadModel(nb"));
});

test("首次 plan 复核返回的正文是生成唯一语料，DB 正文和 chunks 变 B 也不会污染已冻结 A", async () => {
  const { notebook } = await fixture();
  const sourceA = "建模目标为安装板，长度 120mm，宽度 80mm，厚度 5mm。";
  const sourceB = "建模目标为安装板，长度 999mm，宽度 999mm，厚度 99mm。";
  const source = await db.createSource(notebook.id, "安装板规格书", "pdf");
  await db.finalizeSource(source.id, { status: "ready", content: sourceA, char_count: sourceA.length, chunk_count: 0 });
  const requestBody = { mode: "source_driven", sourceIds: [source.id], allowAssumptions: false };
  const admitted = await resolveCadPreflight(notebook.id, requestBody);
  assert.equal(admitted.result.ok, true);
  if (!admitted.result.ok) return;
  const frozen = await assertCadRequestPlanStillCurrent({
    notebookId: notebook.id,
    sourceIds: [source.id],
    cadAllowAssumptions: false,
    plan: admitted.result.plan,
  });
  assert.deepEqual(frozen.map((item) => item.id), admitted.result.plan.target.sourceIds);

  await db.finalizeSource(source.id, { status: "ready", content: sourceB, char_count: sourceB.length, chunk_count: 1 });
  await getPool().query(
    "INSERT INTO chunks (id,source_id,notebook_id,chunk_index,content,embedding,section) VALUES ($1,$2,$3,0,$4,$5,NULL)",
    [`chunk-${Date.now()}`, source.id, notebook.id, sourceB, Buffer.alloc(0)]
  );
  const bundle = buildFrozenGenerationCorpusBundle(frozen, "安装板 长度 宽度 厚度", { k: 8, maxTotal: 8_000 });
  assert.match(bundle.blocks[0]?.body ?? "", /120mm/);
  assert.doesNotMatch(bundle.blocks[0]?.body ?? "", /999mm/);
  await assert.rejects(
    () => assertCadRequestPlanStillCurrent({
      notebookId: notebook.id,
      sourceIds: [source.id],
      cadAllowAssumptions: false,
      plan: admitted.result.plan,
    }),
    (error) => error?.code === "cad_source_conflict"
  );
});

test("CAD 免费预检有用户级限流，缓存命中也不允许无界刷请求", async () => {
  const { notebook, token } = await fixture();
  const body = {
    mode: "fixed_template",
    sourceIds: [],
    templateId: "plate",
    parameters: { length: 120, width: 80, thickness: 5, hole_count: 4 },
    allowAssumptions: false,
  };
  const responses = [];
  for (let index = 0; index < 11; index++) responses.push(await postPreflight(notebook.id, token, body));
  assert.equal(responses.slice(0, 10).every((response) => response.status === 200), true);
  assert.equal(responses[10].status, 429);
  assert.equal(responses[10].headers.get("retry-after") !== null, true);
  assert.equal((await responses[10].json()).code, "cad_preflight_rate_limited");
});

test("CAD JSON 接口同时限制 Content-Length 和 chunked 实际字节", async () => {
  const { notebook, token } = await fixture();
  const oversized = "x".repeat(70 * 1024);
  const studio = await studioRoute.POST(
    request(`/api/notebooks/${notebook.id}/studio`, token, { kind: "cad", cadMode: "prompt_driven", instruction: oversized }),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  assert.equal(studio.status, 413);
  assert.match((await studio.json()).error, /请求体过大/);

  const preflight = await preflightRoute.POST(
    request(`/api/notebooks/${notebook.id}/cad/preflight`, token, {
      mode: "prompt_driven",
      instruction: "生成安装板",
      padding: "x".repeat(40 * 1024),
    }),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  assert.equal(preflight.status, 413);
});

test("同一幂等键并发绑定不同 plan 时稳定返回 202 + 409，不冒充 500", async () => {
  const { notebook, token } = await fixture();
  const make = async (length, key) => {
    const parameters = { length, width: 80, thickness: 5, hole_count: 4 };
    const preflight = await postPreflight(notebook.id, token, {
      mode: "fixed_template", sourceIds: [], templateId: "plate", parameters, allowAssumptions: false,
    });
    assert.equal(preflight.status, 200);
    const { planHash } = await preflight.json();
    return {
      kind: "cad", cadMode: "fixed_template", sourceIds: [], cadTemplate: "plate",
      cadParameters: parameters, cadAllowAssumptions: false, cadPreflightPlanHash: planHash,
      cadIdempotencyKey: key,
    };
  };
  const key = "44444444-4444-4444-8444-444444444444";
  const [left, right] = await Promise.all([make(120, key), make(140, key)]);
  const send = (body) => studioRoute.POST(request(`/api/notebooks/${notebook.id}/studio`, token, body), {
    params: Promise.resolve({ id: notebook.id }),
  });
  const responses = await Promise.all([send(left), send(right)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  const conflict = responses.find((response) => response.status === 409);
  assert.equal((await conflict.json()).code, "cad_idempotency_conflict");
});
