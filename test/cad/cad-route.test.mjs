import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("cad_route");
const { normalizeCadDesignSpec } = await import("../../lib/cad-spec.ts");
const { createDefaultText2CadSpec } = await import("../../lib/text2cad-spec.ts");
const { renderText2CadSpec } = await import("../../lib/text2cad.ts");
const { CAD_DIR, commitCadBundle, renderCadSpec } = await import("../../lib/cad.ts");
const { deleteOutputMedia } = await import("../../lib/media.ts");
const { GET } = await import("../../app/api/studio/cad/[id]/[format]/route.ts");

test("CAD 文件路由绑定 DB 规格/冻结清单/文件 hash，公开本匿名仍拒绝", async () => {
  const user = await db.createUserByEmail("cad-route@example.com", "CAD 路由验收");
  const notebook = await db.createNotebook(user.id, "CAD 路由", "🧊");
  const token = await db.createSession(user.id);
  const spec = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "plate" });
  const rendered = await renderCadSpec(spec);
  const output = await db.createStudioOutput(
    notebook.id,
    "cad",
    spec.name,
    rendered.content,
    JSON.stringify({ cad: true, manifest: rendered.manifest, sourceReferenceMap: { "prompt:1": "本次建模要求" } })
  );
  await commitCadBundle(rendered.tmpDir, output.id);
  try {
    const request = (format, authenticated = true) => new NextRequest(
      `http://localhost/api/studio/cad/${output.id}/${format}`,
      authenticated ? { headers: { cookie: `nb_session=${token}` } } : undefined
    );
    for (const format of ["mesh", "step", "stl", "dxf", "spec"]) {
      const response = await GET(request(format), { params: Promise.resolve({ id: output.id, format }) });
      assert.equal(response.status, 200, format);
      assert.equal(response.headers.get("cache-control"), "private, no-store", format);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", format);
      if (format === "step") {
        assert.equal(response.headers.get("content-type"), "model/step");
        assert.match(response.headers.get("content-disposition") || "", /attachment;[\s\S]*\.step/);
      }
      if (format === "stl") {
        assert.equal(response.headers.get("content-type"), "model/stl");
        assert.match(response.headers.get("content-disposition") || "", /attachment;[\s\S]*\.stl/);
      }
      if (format === "dxf") {
        assert.equal(response.headers.get("content-type"), "image/vnd.dxf");
        assert.match(response.headers.get("content-disposition") || "", /attachment;[\s\S]*\.dxf/);
      }
      assert.ok((await response.arrayBuffer()).byteLength > 80, format);
    }

    await db.setNotebookPublic(notebook.id, true);
    const anonymous = await GET(request("step", false), {
      params: Promise.resolve({ id: output.id, format: "step" }),
    });
    assert.equal(anonymous.status, 401, "公开笔记本也不能匿名下载原生 CAD");

    const dxfPath = path.join(CAD_DIR, output.id, "top-view.dxf");
    const dxf = await readFile(dxfPath);
    await writeFile(dxfPath, Buffer.concat([dxf, Buffer.from("0\r\nEOF\r\n")]));
    const corruptDxf = await GET(request("dxf"), {
      params: Promise.resolve({ id: output.id, format: "dxf" }),
    });
    assert.equal(corruptDxf.status, 409, "DXF 文件字节或 hash 被篡改必须拒绝");
    await writeFile(dxfPath, dxf);

    await db.updateStudioOutput(output.id, {
      data: JSON.stringify({
        cad: true,
        manifest: {
          ...rendered.manifest,
          dxfProjection: {
            ...rendered.manifest.dxfProjection,
            lineCount: rendered.manifest.dxfProjection.lineCount + 1,
          },
        },
      }),
    });
    const mismatchedProjection = await GET(request("dxf"), {
      params: Promise.resolve({ id: output.id, format: "dxf" }),
    });
    assert.equal(mismatchedProjection.status, 409, "冻结的 DXF 投影合同与发布清单不一致必须拒绝");
    await db.updateStudioOutput(output.id, {
      data: JSON.stringify({ cad: true, manifest: rendered.manifest }),
    });

    await db.updateStudioOutput(output.id, { content: `${rendered.content} ` });
    const mismatched = await GET(request("mesh"), {
      params: Promise.resolve({ id: output.id, format: "mesh" }),
    });
    assert.equal(mismatched.status, 409, "DB 规格与文件包 hash 不同必须拒绝");
  } finally {
    await db.deleteStudioOutput(output.id);
    await deleteOutputMedia(output.id);
  }
});

test("汽车与人形机器人多实体包可下载，清单缺失或篡改必须拒绝", async () => {
  const user = await db.createUserByEmail("cad-route-assemblies@example.com", "CAD 装配路由验收");
  const notebook = await db.createNotebook(user.id, "CAD 装配路由", "🤖");
  const token = await db.createSession(user.id);
  const created = [];
  try {
    for (const template of ["humanoid_robot", "concept_car"]) {
      const spec = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template });
      const rendered = await renderCadSpec(spec);
      const output = await db.createStudioOutput(
        notebook.id,
        "cad",
        spec.name,
        rendered.content,
        JSON.stringify({ cad: true, manifest: rendered.manifest })
      );
      created.push(output.id);
      await commitCadBundle(rendered.tmpDir, output.id);
      assert.equal(rendered.manifest.manifestVersion, 2);
      assert.equal(rendered.manifest.libraryVersion, 2);
      assert.equal(rendered.manifest.artifactMode, "assembly");
      assert.equal(rendered.manifest.partCount, template === "humanoid_robot" ? 16 : 5);

      for (const format of ["mesh", "step", "stl", "dxf", "spec"]) {
        const response = await GET(
          new NextRequest(`http://localhost/api/studio/cad/${output.id}/${format}`, {
            headers: { cookie: `nb_session=${token}` },
          }),
          { params: Promise.resolve({ id: output.id, format }) }
        );
        assert.equal(response.status, 200, `${template}:${format}`);
        assert.ok((await response.arrayBuffer()).byteLength > 80, `${template}:${format}`);
      }

      const manifestPath = path.join(CAD_DIR, output.id, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      await writeFile(manifestPath, JSON.stringify({ ...manifest, partCount: manifest.partCount - 1 }));
      const tampered = await GET(
        new NextRequest(`http://localhost/api/studio/cad/${output.id}/mesh`, {
          headers: { cookie: `nb_session=${token}` },
        }),
        { params: Promise.resolve({ id: output.id, format: "mesh" }) }
      );
      assert.equal(tampered.status, 409, `${template} 部件数篡改必须拒绝`);
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
  } finally {
    for (const id of created) {
      await db.deleteStudioOutput(id);
      await deleteOutputMedia(id);
    }
  }
});

test("Text2CAD 动态包复用五格式下载与冻结 partsHash 门禁", async () => {
  const user = await db.createUserByEmail("text2cad-route@example.com", "Text2CAD 路由验收");
  const notebook = await db.createNotebook(user.id, "Text2CAD 路由", "📐");
  const token = await db.createSession(user.id);
  const spec = createDefaultText2CadSpec();
  const rendered = await renderText2CadSpec(spec);
  const output = await db.createStudioOutput(
    notebook.id,
    "cad",
    spec.name,
    rendered.content,
    JSON.stringify({ cad: true, manifest: rendered.manifest })
  );
  await commitCadBundle(rendered.tmpDir, output.id);
  const request = (format) => new NextRequest(`http://localhost/api/studio/cad/${output.id}/${format}`, {
    headers: { cookie: `nb_session=${token}` },
  });
  try {
    for (const format of ["mesh", "step", "stl", "dxf", "spec"]) {
      const response = await GET(request(format), { params: Promise.resolve({ id: output.id, format }) });
      assert.equal(response.status, 200, format);
      assert.ok((await response.arrayBuffer()).byteLength > 80, format);
    }

    await db.updateStudioOutput(output.id, {
      data: JSON.stringify({
        cad: true,
        manifest: { ...rendered.manifest, partsHash: "0".repeat(64) },
      }),
    });
    const tampered = await GET(request("mesh"), { params: Promise.resolve({ id: output.id, format: "mesh" }) });
    assert.equal(tampered.status, 409, "DB 冻结 partsHash 被篡改必须拒绝");
  } finally {
    await db.deleteStudioOutput(output.id);
    await deleteOutputMedia(output.id);
  }
});

test("旧五种单零件可完整缺失新合同字段，半新半旧包拒绝", async () => {
  const user = await db.createUserByEmail("cad-route-legacy@example.com", "CAD 旧包验收");
  const notebook = await db.createNotebook(user.id, "CAD 旧包", "📦");
  const token = await db.createSession(user.id);
  const spec = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "plate" });
  const rendered = await renderCadSpec(spec);
  const manifest = structuredClone(rendered.manifest);
  for (const key of ["manifestVersion", "libraryVersion", "artifactMode", "partCount"]) delete manifest[key];
  const output = await db.createStudioOutput(
    notebook.id,
    "cad",
    spec.name,
    rendered.content,
    JSON.stringify({ cad: true, manifest })
  );
  await commitCadBundle(rendered.tmpDir, output.id);
  const manifestPath = path.join(CAD_DIR, output.id, "manifest.json");
  const meshPath = path.join(CAD_DIR, output.id, "mesh.json");
  const mesh = JSON.parse(await readFile(meshPath, "utf8"));
  for (const key of ["manifestVersion", "libraryVersion", "artifactMode", "partCount"]) delete mesh.manifest[key];
  const meshRaw = JSON.stringify(mesh);
  await writeFile(meshPath, meshRaw);
  manifest.files.mesh.bytes = Buffer.byteLength(meshRaw);
  manifest.files.mesh.sha256 = createHash("sha256").update(meshRaw).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await db.updateStudioOutput(output.id, { data: JSON.stringify({ cad: true, manifest }) });
  const request = () => new NextRequest(`http://localhost/api/studio/cad/${output.id}/mesh`, {
    headers: { cookie: `nb_session=${token}` },
  });
  try {
    const legacy = await GET(request(), { params: Promise.resolve({ id: output.id, format: "mesh" }) });
    assert.equal(legacy.status, 200);
    await legacy.arrayBuffer();

    await db.updateStudioOutput(output.id, {
      data: JSON.stringify({ cad: true, manifest: { ...manifest, artifactMode: "single_part" } }),
    });
    const partial = await GET(request(), { params: Promise.resolve({ id: output.id, format: "mesh" }) });
    assert.equal(partial.status, 409);
  } finally {
    await db.deleteStudioOutput(output.id);
    await deleteOutputMedia(output.id);
  }
});

test("历史 CAD 制品没有 DXF 时继续提供 STEP/STL，DXF 明确返回 404", async () => {
  const user = await db.createUserByEmail("cad-route-pre-dxf@example.com", "CAD 历史格式验收");
  const notebook = await db.createNotebook(user.id, "CAD 历史格式", "📐");
  const token = await db.createSession(user.id);
  const spec = normalizeCadDesignSpec({ schemaVersion: 1, unit: "mm", template: "plate" });
  const rendered = await renderCadSpec(spec);
  const legacyManifest = structuredClone(rendered.manifest);
  delete legacyManifest.dxfProjection;
  delete legacyManifest.files.dxf;
  const output = await db.createStudioOutput(
    notebook.id,
    "cad",
    spec.name,
    rendered.content,
    JSON.stringify({ cad: true, manifest: legacyManifest })
  );
  await commitCadBundle(rendered.tmpDir, output.id);
  const manifestPath = path.join(CAD_DIR, output.id, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(legacyManifest));
  const request = (format) => new NextRequest(`http://localhost/api/studio/cad/${output.id}/${format}`, {
    headers: { cookie: `nb_session=${token}` },
  });
  try {
    for (const format of ["step", "stl"]) {
      const response = await GET(request(format), { params: Promise.resolve({ id: output.id, format }) });
      assert.equal(response.status, 200, format);
      assert.ok((await response.arrayBuffer()).byteLength > 80, format);
    }
    const dxf = await GET(request("dxf"), { params: Promise.resolve({ id: output.id, format: "dxf" }) });
    assert.equal(dxf.status, 404);
    assert.deepEqual(await dxf.json(), { error: "该历史 CAD 制品没有 DXF 顶视图" });
  } finally {
    await db.deleteStudioOutput(output.id);
    await deleteOutputMedia(output.id);
  }
});
