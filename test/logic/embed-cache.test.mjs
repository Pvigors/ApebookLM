import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  CACHE_MANIFEST,
  CACHE_PAYLOAD,
  INSTALLED_MANIFEST,
  MAX_BUNDLE_DEPTH,
  MAX_BUNDLE_ENTRIES,
  exportBundle,
  importBundle,
  recoverInterruptedImport,
  verifyBundle,
  verifyCache,
} from "../../scripts/embed-cache.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const digest = (content) => createHash("sha256").update(content).digest("hex");

function fixtureSpec() {
  const content = new Map([
    ["config.json", Buffer.from('{"model_type":"bert"}\n')],
    ["onnx/model.onnx", Buffer.from("fixture-onnx-model")],
    ["tokenizer.json", Buffer.from('{"version":"1.0"}\n')],
    ["tokenizer_config.json", Buffer.from('{"do_lower_case":true}\n')],
  ]);
  return {
    spec: {
      model: "Fixture/tiny-embed",
      revision: "0123456789abcdef",
      sourceUrl: "https://example.invalid/Fixture/tiny-embed",
      baseModelUrl: "https://example.invalid/Fixture/tiny-embed-base",
      license: "MIT",
      licenseText: "fixture model licence\n",
      files: [...content].map(([relative, bytes]) => ({
        path: relative,
        size: bytes.length,
        sha256: digest(bytes),
      })),
    },
    content,
  };
}

async function createFixtureCache(root, spec, content, { revisioned = false } = {}) {
  const modelDir = path.join(root, ...spec.model.split("/"), ...(revisioned ? [spec.revision] : []));
  await writeFixtureModel(modelDir, content);
}

async function writeFixtureModel(modelDir, content) {
  for (const [relative, bytes] of content) {
    const target = path.join(modelDir, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "apebooklm-embed-cache-test-"));
  temporaryRoots.push(root);
  return root;
}

test("exports a path-independent audited bundle and imports it into an empty cache", async () => {
  const root = await makeRoot();
  const sourceCache = path.join(root, "source-cache");
  const output = path.join(root, "portable-bundle");
  const importedCache = path.join(root, "empty-cache");
  const { spec, content } = fixtureSpec();
  await createFixtureCache(sourceCache, spec, content);

  const exported = await exportBundle({ cacheDir: sourceCache, outputDir: output, spec });
  assert.equal(exported.exported, true);
  assert.equal(exported.files, 4);
  assert.equal((await verifyBundle(output, spec)).ok, true);

  const manifestText = await readFile(path.join(output, CACHE_MANIFEST), "utf8");
  assert.doesNotMatch(manifestText, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(JSON.parse(manifestText).model, spec.model);

  const imported = await importBundle({ bundleDir: output, cacheDir: importedCache, spec });
  assert.equal(imported.imported, true);
  assert.equal(imported.alreadyPresent, false);
  assert.equal((await verifyCache(importedCache, spec)).ok, true);
  assert.equal(
    JSON.parse(await readFile(path.join(importedCache, ...spec.model.split("/"), spec.revision, INSTALLED_MANIFEST), "utf8")).revision,
    spec.revision,
  );

  const repeated = await importBundle({ bundleDir: output, cacheDir: importedCache, spec });
  assert.equal(repeated.imported, false);
  assert.equal(repeated.alreadyPresent, true);
});

test("rejects tampered, extra and symbolic-link bundle content", async () => {
  const root = await makeRoot();
  const sourceCache = path.join(root, "source-cache");
  const output = path.join(root, "portable-bundle");
  const { spec, content } = fixtureSpec();
  await createFixtureCache(sourceCache, spec, content);
  await exportBundle({ cacheDir: sourceCache, outputDir: output, spec });

  const modelFile = path.join(output, CACHE_PAYLOAD, "onnx", "model.onnx");
  const tampered = Buffer.from(content.get("onnx/model.onnx"));
  tampered[0] ^= 0xff;
  await writeFile(modelFile, tampered);
  await assert.rejects(verifyBundle(output, spec), /sha256 mismatch/);
  await writeFile(modelFile, content.get("onnx/model.onnx"));

  await writeFile(path.join(output, CACHE_PAYLOAD, "unexpected.bin"), "ignored payload");
  await assert.rejects(verifyBundle(output, spec), /missing or unexpected files/);
  await unlink(path.join(output, CACHE_PAYLOAD, "unexpected.bin"));

  await unlink(modelFile);
  await symlink(path.join(sourceCache, ...spec.model.split("/"), "onnx", "model.onnx"), modelFile);
  await assert.rejects(verifyBundle(output, spec), /symbolic link|regular file/);
});

test("does not overwrite an invalid target unless replace is explicit", async () => {
  const root = await makeRoot();
  const sourceCache = path.join(root, "source-cache");
  const output = path.join(root, "portable-bundle");
  const targetCache = path.join(root, "target-cache");
  const { spec, content } = fixtureSpec();
  await createFixtureCache(sourceCache, spec, content);
  await exportBundle({ cacheDir: sourceCache, outputDir: output, spec });
  await createFixtureCache(targetCache, spec, content, { revisioned: true });
  const targetModel = path.join(targetCache, ...spec.model.split("/"), spec.revision, "onnx", "model.onnx");
  await writeFile(targetModel, "broken-existing!!");

  await assert.rejects(
    importBundle({ bundleDir: output, cacheDir: targetCache, spec }),
    /present but invalid.*--replace/,
  );
  assert.equal(await readFile(targetModel, "utf8"), "broken-existing!!");

  const imported = await importBundle({ bundleDir: output, cacheDir: targetCache, replace: true, spec });
  assert.equal(imported.imported, true);
  assert.equal((await verifyCache(targetCache, spec)).ok, true);
});

test("recovers interrupted renames without deleting a valid target or live stage", async () => {
  const root = await makeRoot();
  const cache = path.join(root, "cache");
  const { spec, content } = fixtureSpec();
  const target = path.join(cache, ...spec.model.split("/"), spec.revision);
  const parent = path.dirname(target);
  const stalePid = 999999;
  const uuid1 = "00000000-0000-4000-8000-000000000001";
  const uuid2 = "00000000-0000-4000-8000-000000000002";
  const uuid3 = "00000000-0000-4000-8000-000000000003";
  const staleStage = path.join(parent, `.${spec.revision}.import-${stalePid}-${uuid1}`);
  const validBackup = path.join(parent, `.${spec.revision}.backup-${stalePid}-${uuid2}`);
  await mkdir(staleStage, { recursive: true });
  await writeFile(path.join(staleStage, "partial"), "incomplete");
  await writeFixtureModel(validBackup, content);

  const restored = await recoverInterruptedImport(cache, spec);
  assert.equal(restored.restoredBackup, true);
  assert.equal(restored.stagesRemoved, 1);
  assert.equal((await verifyCache(cache, spec)).ok, true);
  await assert.rejects(access(staleStage), { code: "ENOENT" });

  const staleBackup = path.join(parent, `.${spec.revision}.backup-${stalePid}-${uuid3}`);
  await writeFixtureModel(staleBackup, content);
  const liveStage = path.join(parent, `.${spec.revision}.import-${process.pid}-${uuid1}`);
  await mkdir(liveStage);
  const targetBefore = await readFile(path.join(target, "onnx", "model.onnx"));
  const cleaned = await recoverInterruptedImport(cache, spec);
  assert.equal(cleaned.targetValid, true);
  assert.equal(cleaned.backupsRemoved, 1);
  assert.deepEqual(await readFile(path.join(target, "onnx", "model.onnx")), targetBefore);
  await access(liveStage);
  await assert.rejects(access(staleBackup), { code: "ENOENT" });
});

test("enforces exact licence bytes plus recursive entry and depth limits", async () => {
  const root = await makeRoot();
  const sourceCache = path.join(root, "source-cache");
  const output = path.join(root, "portable-bundle");
  const { spec, content } = fixtureSpec();
  await createFixtureCache(sourceCache, spec, content);
  await exportBundle({ cacheDir: sourceCache, outputDir: output, spec });

  const license = path.join(output, "MODEL_LICENSE.txt");
  await writeFile(license, `${spec.licenseText}x`);
  await assert.rejects(verifyBundle(output, spec), /licence size mismatch/);
  await writeFile(license, spec.licenseText);

  let deep = path.join(output, "too-deep");
  for (let index = 0; index <= MAX_BUNDLE_DEPTH; index += 1) deep = path.join(deep, `d${index}`);
  await mkdir(deep, { recursive: true });
  await writeFile(path.join(deep, "payload"), "x");
  await assert.rejects(verifyBundle(output, spec), /directory depth exceeds/);
  await rm(path.join(output, "too-deep"), { recursive: true });

  const many = path.join(output, "too-many");
  await mkdir(many);
  await Promise.all(Array.from({ length: MAX_BUNDLE_ENTRIES }, (_, index) => (
    writeFile(path.join(many, `${index}.txt`), "x")
  )));
  await assert.rejects(verifyBundle(output, spec), /entry count exceeds/);
});

test("worker pins the audited revision and validates cache before offline readiness", async () => {
  const worker = await readFile(new URL("../../lib/embed-worker.mjs", import.meta.url), "utf8");
  const ci = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(worker, /75c43b069aac4d136ba6bc1122f995fedcfd2781/);
  assert.match(worker, /revision:\s*EMBED_REVISION/);
  assert.ok(worker.indexOf("await verifyCache") < worker.indexOf("process.send({ ready: true })"));
  assert.match(ci, /hashFiles\('package-lock\.json', 'scripts\/embed-cache\.mjs'\)/);
  assert.match(ci, /r75c43b069aac4d136ba6bc1122f995fedcfd2781/);
  assert.match(ci, /node scripts\/embed-cache\.mjs verify-cache[\s\S]*LOCAL_EMBED_OFFLINE=1 node scripts\/embed-health\.mjs/);
});

test("strict offline health fails closed on an empty cache without contacting the endpoint", async () => {
  const root = await makeRoot();
  const emptyCache = path.join(root, "empty-cache");
  await mkdir(emptyCache);
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(500).end("network must not be used");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const env = {
    ...process.env,
    TRANSFORMERS_CACHE: emptyCache,
    LOCAL_EMBED_MODEL: "Xenova/bge-small-zh-v1.5",
    LOCAL_EMBED_OFFLINE: "1",
    HF_ENDPOINT: `http://127.0.0.1:${address.port}/`,
    EMBED_HEALTH_TIMEOUT_MS: "30000",
  };
  const runHealth = async (overrides = {}) => {
    const child = spawn(process.execPath, ["scripts/embed-health.mjs"], {
      cwd: repositoryRoot,
      env: { ...env, ...overrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code, signal] = await once(child, "exit");
    return { code, signal, stdout, stderr };
  };

  const missing = await runHealth();
  assert.equal(missing.signal, null);
  assert.equal(missing.code, 1, missing.stdout || missing.stderr);
  assert.match(`${missing.stdout}\n${missing.stderr}`, /model directory is missing|model file .* is missing/);

  const mismatchedRevision = await runHealth({ LOCAL_EMBED_REVISION: "deadbeef" });
  server.close();
  await once(server, "close");

  assert.equal(mismatchedRevision.signal, null);
  assert.equal(mismatchedRevision.code, 1, mismatchedRevision.stdout || mismatchedRevision.stderr);
  assert.match(`${mismatchedRevision.stdout}\n${mismatchedRevision.stderr}`, /strict offline embedding requires/);
  assert.equal(requests, 0, "strict offline mode contacted HF_ENDPOINT");
});
