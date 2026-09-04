import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("cad_revision_route");
const { canonicalCadDesignJson, normalizeCadDesignSpec } = await import("../../lib/cad-spec.ts");
const { canonicalText2CadDesignJson } = await import("../../lib/text2cad-spec.ts");
const { createText2CadTutorialExample } = await import("../../lib/text2cad-tutorial-example.ts");
const { POST } = await import("../../app/api/studio/cad/[id]/revise/route.ts");
const { DELETE: cancelJob } = await import("../../app/api/jobs/[id]/route.ts");

function request(id, token, body, extraHeaders = {}) {
  return new NextRequest(`http://localhost/api/studio/cad/${id}/revise`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `nb_session=${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

test("CAD 全局灰度关闭后普通成员不能通过旧制品修订路由绕过", async () => {
  const user = await db.createUserByEmail("cad-revision-disabled@example.com", "CAD 灰度关闭");
  const notebook = await db.createNotebook(user.id, "CAD 灰度关闭", "📐");
  const token = await db.createSession(user.id);
  const spec = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "plate" });
  const content = canonicalCadDesignJson(spec);
  const hash = createHash("sha256").update(content).digest("hex");
  const output = await db.createStudioOutput(
    notebook.id,
    "cad",
    spec.name,
    content,
    JSON.stringify({ cad: true, manifest: { hash, template: "plate" } })
  );

  await db.setSetting("app.cad_enabled", "0", "test");
  try {
    const response = await POST(
      request(output.id, token, { baseHash: hash, patch: { parameters: { length: 130 } } }),
      { params: Promise.resolve({ id: output.id }) }
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "CAD 模型暂未开放");
    assert.equal((await db.listActiveJobs(notebook.id)).length, 0);
  } finally {
    await db.setSetting("app.cad_enabled", "1", "test");
  }
});

test("CAD 修订路由校验登录、父版本 hash 与受控 patch，再原子扣费排入确定性几何任务", async () => {
  const user = await db.createUserByEmail("cad-revision-route@example.com", "CAD 修订路由");
  const notebook = await db.createNotebook(user.id, "CAD 修订路由", "📐");
  const token = await db.createSession(user.id);
  const spec = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "enclosure" });
  const content = canonicalCadDesignJson(spec);
  const hash = createHash("sha256").update(content).digest("hex");
  const output = await db.createStudioOutput(
    notebook.id,
    "cad",
    spec.name,
    content,
    JSON.stringify({ cad: true, manifest: { hash, template: "enclosure" } })
  );

  const anonymous = await POST(
    request(output.id, null, { baseHash: hash, patch: { parameters: { outer_length: 150 } } }),
    { params: Promise.resolve({ id: output.id }) }
  );
  assert.equal(anonymous.status, 401);

  const stale = await POST(
    request(output.id, token, { baseHash: "0".repeat(64), patch: { parameters: { outer_length: 150 } } }),
    { params: Promise.resolve({ id: output.id }) }
  );
  assert.equal(stale.status, 409);

  const invalid = await POST(
    request(output.id, token, { baseHash: hash, patch: { parameters: { unknown_size: 5 } } }),
    { params: Promise.resolve({ id: output.id }) }
  );
  assert.equal(invalid.status, 400);

  const response = await POST(
    request(output.id, token, { baseHash: hash, patch: { parameters: { outer_length: 150 } } }),
    { params: Promise.resolve({ id: output.id }) }
  );
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.billing.reservedCredits, 5);
  const job = await db.getJob(payload.job.id);
  assert.equal(job.status, "queued");
  assert.equal(job.kind, "cad");
  assert.equal(job.credits_reserved, 5);
  const params = JSON.parse(job.params);
  assert.equal(params.__deterministic, true);
  assert.equal(params.__reservedCredits, 5);
  assert.ok(Number(params.__creditLedgerId) > 0);
  assert.equal(params.cadRevision.parentOutputId, output.id);
  assert.equal(params.cadRevision.baseHash, hash);
  assert.match(params.cadRevision.targetHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(params.cadRevision.patch, { parameters: { outer_length: 150 } });

  const repeated = await POST(
    request(output.id, token, { baseHash: hash, patch: { parameters: { outer_length: 150 } } }),
    { params: Promise.resolve({ id: output.id }) }
  );
  assert.equal(repeated.status, 202);
  const repeatedPayload = await repeated.json();
  assert.equal(repeatedPayload.reused, true);
  assert.equal(repeatedPayload.job.id, job.id);

  const conflict = await POST(
    request(output.id, token, { baseHash: hash, patch: { parameters: { outer_length: 160 } } }),
    { params: Promise.resolve({ id: output.id }) }
  );
  assert.equal(conflict.status, 409);

  const canceled = await cancelJob(
    new NextRequest(`http://localhost/api/jobs/${job.id}`, {
      method: "DELETE",
      headers: { cookie: `nb_session=${token}` },
    }),
    { params: Promise.resolve({ id: job.id }) }
  );
  assert.equal(canceled.status, 200);
  assert.equal((await db.getJob(job.id)).status, "canceled");
  const { getPool } = await import("../../lib/pg.ts");
  const ledger = await getPool().query(
    "SELECT op,credits,refunded FROM credit_ledger WHERE user_id=$1 AND op IN ('studio:cad','refund:studio:cad') ORDER BY id",
    [user.id]
  );
  assert.deepEqual(
    ledger.rows.map((row) => ({ op: row.op, credits: Number(row.credits), refunded: Number(row.refunded) })),
    [
      { op: "studio:cad", credits: 5, refunded: 1 },
      { op: "refund:studio:cad", credits: -5, refunded: 0 },
    ]
  );
});

test("CAD 修订路由对相同参数直接返回 unchanged，不制造任务", async () => {
  const user = await db.createUserByEmail("cad-revision-unchanged@example.com", "CAD 修订无变化");
  const notebook = await db.createNotebook(user.id, "CAD 修订无变化", "📐");
  const token = await db.createSession(user.id);
  const spec = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "plate" });
  const content = canonicalCadDesignJson(spec);
  const hash = createHash("sha256").update(content).digest("hex");
  const output = await db.createStudioOutput(
    notebook.id,
    "cad",
    spec.name,
    content,
    JSON.stringify({ cad: true, manifest: { hash, template: "plate" } })
  );
  const response = await POST(
    request(output.id, token, { baseHash: hash, patch: { parameters: { length: spec.parameters.length.value } } }),
    { params: Promise.resolve({ id: output.id }) }
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.unchanged, true);
  assert.equal(payload.output.id, output.id);
});

test("教学示例禁止沿用系统默认尺寸修订为正式模型", async () => {
  const user = await db.createUserByEmail("cad-tutorial-revision@example.com", "CAD 教学示例修订");
  const notebook = await db.createNotebook(user.id, "CAD 教学示例修订", "📐");
  const token = await db.createSession(user.id);
  const content = canonicalText2CadDesignJson(createText2CadTutorialExample());
  const hash = createHash("sha256").update(content).digest("hex");
  const output = await db.createStudioOutput(
    notebook.id,
    "cad",
    "教学示例：四孔安装平板",
    content,
    JSON.stringify({
      cad: true,
      manifest: { hash, template: "text2cad" },
      modelSelection: { tutorialExample: true, exampleTemplate: "plate", reason: "no_design_target" },
    })
  );
  const response = await POST(
    request(output.id, token, {
      baseHash: hash,
      patch: { parts: [{ id: "part_tutorial_plate", features: [{ id: "feat_tutorial_plate", distance: 8 }] }] },
    }),
    { params: Promise.resolve({ id: output.id }) }
  );
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /重新生成正式模型/);
});

test("CAD 修订并发在数据库事务内锁父版本，不能绕过在途上限或生成多个同名分支", async () => {
  const user = await db.createUserByEmail("cad-revision-race@example.com", "CAD 修订并发");
  const notebook = await db.createNotebook(user.id, "CAD 修订并发", "📐");
  const token = await db.createSession(user.id);
  const spec = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "enclosure" });
  const content = canonicalCadDesignJson(spec);
  const hash = createHash("sha256").update(content).digest("hex");
  const output = await db.createStudioOutput(
    notebook.id,
    "cad",
    spec.name,
    content,
    JSON.stringify({ cad: true, manifest: { hash, template: "enclosure" } })
  );

  const responses = await Promise.all(
    [130, 140, 150, 160, 170].map((outerLength) => POST(
      request(output.id, token, { baseHash: hash, patch: { parameters: { outer_length: outerLength } } }),
      { params: Promise.resolve({ id: output.id }) }
    ))
  );
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [202, 409, 409, 409, 409]
  );
  const active = (await db.listActiveJobs(notebook.id)).filter((job) => job.kind === "cad");
  assert.equal(active.length, 1);
  const { getPool } = await import("../../lib/pg.ts");
  const ledger = await getPool().query(
    "SELECT op,credits FROM credit_ledger WHERE user_id=$1 AND op='studio:cad' ORDER BY id",
    [user.id]
  );
  assert.equal(ledger.rowCount, 1, "并发输家不得重复扣积分");
  assert.equal(Number(ledger.rows[0].credits), 5);
});

test("不同协作者同时修订同一父版本时仍只有一个数据库赢家", async () => {
  const owner = await db.createUserByEmail("cad-revision-owner@example.com", "CAD 修订所有者");
  const editor = await db.createUserByEmail("cad-revision-editor@example.com", "CAD 修订协作者");
  const notebook = await db.createNotebook(owner.id, "CAD 协作者并发", "📐");
  await db.addCollaborator(notebook.id, editor.id, "editor");
  const ownerToken = await db.createSession(owner.id);
  const editorToken = await db.createSession(editor.id);
  const spec = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "enclosure" });
  const content = canonicalCadDesignJson(spec);
  const hash = createHash("sha256").update(content).digest("hex");
  const output = await db.createStudioOutput(
    notebook.id,
    "cad",
    spec.name,
    content,
    JSON.stringify({ cad: true, manifest: { hash, template: "enclosure" } })
  );

  const [left, right] = await Promise.all([
    POST(
      request(output.id, ownerToken, { baseHash: hash, patch: { parameters: { outer_length: 145 } } }),
      { params: Promise.resolve({ id: output.id }) }
    ),
    POST(
      request(output.id, editorToken, { baseHash: hash, patch: { parameters: { outer_length: 155 } } }),
      { params: Promise.resolve({ id: output.id }) }
    ),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [202, 409]);
  assert.equal((await db.listActiveJobs(notebook.id)).length, 1);
});
