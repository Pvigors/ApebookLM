import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("cad_generation_source_route");
const { POST } = await import("../../app/api/notebooks/[id]/studio/route.ts");

const request = (notebookId, token, body) => new NextRequest(
  `http://localhost/api/notebooks/${notebookId}/studio`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `nb_session=${token}`,
    },
    body: JSON.stringify(body),
  }
);

test("CAD 在运行时体检和扣费前强制 v3 预检模式并拒绝无效来源", async () => {
  const user = await db.createUserByEmail("cad-source-gate@example.com", "CAD 来源门禁");
  const notebook = await db.createNotebook(user.id, "CAD 来源门禁", "📐");
  const token = await db.createSession(user.id);

  for (const body of [
    { kind: "cad" },
    { kind: "cad", sourceIds: [] },
    { kind: "cad", sourceIds: ["", "__legacy"] },
  ]) {
    const response = await POST(request(notebook.id, token, body), {
      params: Promise.resolve({ id: notebook.id }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "cad_preflight_required");
  }

  const missing = await POST(
    request(notebook.id, token, { kind: "cad", cadMode: "source_driven", sourceIds: [] }),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  assert.equal(missing.status, 422);
  assert.equal((await missing.json()).code, "cad_source_required");

  const invalid = await POST(
    request(notebook.id, token, { kind: "cad", cadMode: "source_driven", sourceIds: ["not-in-this-notebook"] }),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /无效或未就绪/);

  const tooMany = await POST(
    request(notebook.id, token, {
      kind: "cad",
      cadMode: "source_driven",
      sourceIds: Array.from({ length: 25 }, (_, index) => `source-${index}`),
    }),
    { params: Promise.resolve({ id: notebook.id }) }
  );
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /最多选择 24 个来源/);
});
