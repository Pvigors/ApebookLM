#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CACHE_BUNDLE_KIND = "apebooklm-transformers-cache";
export const CACHE_BUNDLE_SCHEMA = 1;
export const CACHE_MANIFEST = "manifest.json";
export const CACHE_PAYLOAD = "model";
export const INSTALLED_MANIFEST = ".apebooklm-cache-manifest.json";
export const MAX_BUNDLE_ENTRIES = 128;
export const MAX_BUNDLE_DEPTH = 8;

const MIT_LICENSE = `MIT License

Copyright (c) 2022 staoxiao

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/**
 * This is a deliberately frozen, audited snapshot. A bundle generated from a
 * different model revision is rejected instead of being called "verified".
 * Update the whole spec only after an inference and licence review.
 */
export const DEFAULT_EMBED_MODEL_SPEC = Object.freeze({
  model: "Xenova/bge-small-zh-v1.5",
  revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
  sourceUrl: "https://huggingface.co/Xenova/bge-small-zh-v1.5",
  baseModelUrl: "https://huggingface.co/BAAI/bge-small-zh-v1.5",
  license: "MIT",
  licenseText: MIT_LICENSE,
  files: Object.freeze([
    Object.freeze({
      path: "config.json",
      size: 716,
      sha256: "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f",
    }),
    Object.freeze({
      path: "onnx/model.onnx",
      size: 94_851_877,
      sha256: "69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a",
    }),
    Object.freeze({
      path: "tokenizer.json",
      size: 439_125,
      sha256: "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26",
    }),
    Object.freeze({
      path: "tokenizer_config.json",
      size: 367,
      sha256: "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a",
    }),
  ]),
});

function assertSafeRelative(relative, label = "path") {
  if (
    typeof relative !== "string"
    || !relative
    || relative.includes("\\")
    || path.posix.isAbsolute(relative)
    || relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a safe relative path: ${String(relative)}`);
  }
  return relative;
}

function assertModelId(model) {
  if (
    typeof model !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)
  ) {
    throw new Error(`invalid model id: ${String(model)}`);
  }
  return model;
}

function validateSpec(spec) {
  assertModelId(spec?.model);
  if (typeof spec.revision !== "string" || !/^[a-f0-9]{7,64}$/.test(spec.revision)) {
    throw new Error(`invalid model revision: ${String(spec.revision)}`);
  }
  for (const field of ["sourceUrl", "baseModelUrl", "license", "licenseText"]) {
    if (typeof spec[field] !== "string" || !spec[field]) {
      throw new Error(`model spec ${field} must be a non-empty string`);
    }
  }
  if (Buffer.byteLength(spec.licenseText, "utf8") > 64 * 1024) {
    throw new Error("model licence exceeds 64 KiB");
  }
  if (!Array.isArray(spec.files) || spec.files.length === 0 || spec.files.length > 64) {
    throw new Error("model spec must contain 1-64 files");
  }
  const seen = new Set();
  for (const file of spec.files) {
    assertSafeRelative(file?.path, "model file path");
    if (seen.has(file.path)) throw new Error(`duplicate model file: ${file.path}`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error(`invalid size for ${file.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256 ?? "")) {
      throw new Error(`invalid sha256 for ${file.path}`);
    }
  }
}

function modelDirectory(cacheDir, model) {
  assertModelId(model);
  return path.join(path.resolve(cacheDir), ...model.split("/"));
}

function revisionDirectory(cacheDir, spec) {
  if (typeof spec?.revision !== "string" || !/^[a-f0-9]{7,64}$/.test(spec.revision)) {
    throw new Error(`invalid model revision: ${String(spec?.revision)}`);
  }
  return path.join(modelDirectory(cacheDir, spec.model), spec.revision);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertRegularFile(file, expected, label) {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size !== expected.size) {
    throw new Error(`${label} size mismatch: expected ${expected.size}, got ${stat.size}`);
  }
  const actualHash = await sha256File(file);
  if (actualHash !== expected.sha256) {
    throw new Error(`${label} sha256 mismatch: expected ${expected.sha256}, got ${actualHash}`);
  }
}

function canonicalManifest(spec) {
  validateSpec(spec);
  const licenseBytes = Buffer.from(spec.licenseText, "utf8");
  return {
    schemaVersion: CACHE_BUNDLE_SCHEMA,
    kind: CACHE_BUNDLE_KIND,
    model: spec.model,
    revision: spec.revision,
    sourceUrl: spec.sourceUrl,
    baseModelUrl: spec.baseModelUrl,
    license: spec.license,
    licenseFile: {
      path: "MODEL_LICENSE.txt",
      size: licenseBytes.length,
      sha256: createHash("sha256").update(licenseBytes).digest("hex"),
    },
    files: spec.files.map(({ path: relative, size, sha256 }) => ({
      path: relative,
      size,
      sha256,
    })),
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertManifestMatches(manifest, spec) {
  const expected = stableJson(canonicalManifest(spec));
  if (stableJson(manifest) !== expected) {
    throw new Error("bundle manifest does not match the audited model snapshot");
  }
}

async function readManifest(bundleDir, spec) {
  const manifestPath = path.join(path.resolve(bundleDir), CACHE_MANIFEST);
  const stat = await lstat(manifestPath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error("bundle manifest is missing");
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw new Error("bundle manifest must be a regular JSON file no larger than 64 KiB");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("bundle manifest is not valid JSON");
  }
  assertManifestMatches(manifest, spec);
  return manifest;
}

async function listFiles(root, current = root, depth = 0, state = { entries: 0 }) {
  if (depth > MAX_BUNDLE_DEPTH) {
    throw new Error(`bundle directory depth exceeds ${MAX_BUNDLE_DEPTH}`);
  }
  const files = [];
  const directory = await opendir(current);
  for await (const entry of directory) {
    state.entries += 1;
    if (state.entries > MAX_BUNDLE_ENTRIES) {
      throw new Error(`bundle entry count exceeds ${MAX_BUNDLE_ENTRIES}`);
    }
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`bundle contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute, depth + 1, state));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`bundle contains an unsupported entry: ${relative}`);
  }
  return files.sort();
}

export async function verifyModelDirectory(directory, spec = DEFAULT_EMBED_MODEL_SPEC) {
  validateSpec(spec);
  const root = path.resolve(directory);
  const rootStat = await lstat(root).catch((error) => {
    if (error?.code === "ENOENT") throw new Error("model directory is missing");
    throw error;
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("model directory must be a regular directory");
  }
  for (const expected of spec.files) {
    await assertRegularFile(
      path.join(root, ...expected.path.split("/")),
      expected,
      `model file ${expected.path}`,
    );
  }
  return {
    ok: true,
    model: spec.model,
    revision: spec.revision,
    files: spec.files.length,
    bytes: spec.files.reduce((total, file) => total + file.size, 0),
  };
}

export async function verifyCache(cacheDir, spec = DEFAULT_EMBED_MODEL_SPEC) {
  return verifyModelDirectory(revisionDirectory(cacheDir, spec), spec);
}

export async function verifyBundle(bundleDir, spec = DEFAULT_EMBED_MODEL_SPEC) {
  validateSpec(spec);
  const root = path.resolve(bundleDir);
  await readManifest(root, spec);
  const licensePath = path.join(root, "MODEL_LICENSE.txt");
  const licenseStat = await lstat(licensePath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error("bundle model licence is missing");
    throw error;
  });
  if (!licenseStat.isFile() || licenseStat.isSymbolicLink()) {
    throw new Error("bundle model licence must be a regular file");
  }
  const expectedLicense = canonicalManifest(spec).licenseFile;
  if (licenseStat.size !== expectedLicense.size) {
    throw new Error(`bundle model licence size mismatch: expected ${expectedLicense.size}, got ${licenseStat.size}`);
  }
  if (await sha256File(licensePath) !== expectedLicense.sha256) {
    throw new Error("bundle model licence does not match the audited snapshot");
  }

  const expectedFiles = [CACHE_MANIFEST, "MODEL_LICENSE.txt", ...spec.files.map((file) => `${CACHE_PAYLOAD}/${file.path}`)].sort();
  const actualFiles = await listFiles(root);
  if (stableJson(actualFiles) !== stableJson(expectedFiles)) {
    throw new Error("bundle contains missing or unexpected files");
  }
  const result = await verifyModelDirectory(path.join(root, CACHE_PAYLOAD), spec);
  return { ...result, bundle: true };
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function copySnapshot(source, target, spec) {
  for (const file of spec.files) {
    const from = path.join(source, ...file.path.split("/"));
    const to = path.join(target, ...file.path.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

function artifactPid(name, prefix) {
  if (!name.startsWith(prefix)) return null;
  const match = name.slice(prefix.length).match(/^([1-9][0-9]*)-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means the process exists but belongs to another user. Unknown
    // errors are also treated as active: cleanup must prefer leaving debris
    // over touching a live import.
    return true;
  }
}

/**
 * Reconcile artifacts left if an import process is killed between renames.
 * A valid target is never removed. A valid backup is restored only when the
 * target is absent; artifacts owned by a live PID are left untouched.
 */
export async function recoverInterruptedImport(cacheDir, spec = DEFAULT_EMBED_MODEL_SPEC) {
  validateSpec(spec);
  const target = revisionDirectory(cacheDir, spec);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const stagePrefix = `.${path.basename(target)}.import-`;
  const backupPrefix = `.${path.basename(target)}.backup-`;
  const entries = await readdir(parent, { withFileTypes: true });
  const artifacts = [];
  for (const entry of entries) {
    const prefix = entry.name.startsWith(stagePrefix)
      ? stagePrefix
      : entry.name.startsWith(backupPrefix) ? backupPrefix : null;
    if (!prefix) continue;
    if (artifacts.length >= 64) throw new Error("too many interrupted import artifacts");
    const pid = artifactPid(entry.name, prefix);
    if (pid === null || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    artifacts.push({
      type: prefix === stagePrefix ? "stage" : "backup",
      path: path.join(parent, entry.name),
      active: processIsAlive(pid),
    });
  }

  let stagesRemoved = 0;
  for (const artifact of artifacts) {
    if (artifact.type !== "stage" || artifact.active) continue;
    await rm(artifact.path, { recursive: true, force: true });
    stagesRemoved += 1;
  }

  const inactiveBackups = artifacts.filter((artifact) => artifact.type === "backup" && !artifact.active);
  let restoredBackup = false;
  if (!(await pathExists(target))) {
    for (const backup of inactiveBackups) {
      try {
        await verifyModelDirectory(backup.path, spec);
      } catch {
        continue;
      }
      await rename(backup.path, target);
      restoredBackup = true;
      break;
    }
  }

  let targetValid = false;
  if (await pathExists(target)) {
    try {
      await verifyModelDirectory(target, spec);
      targetValid = true;
    } catch {
      // Never replace or delete an invalid target during automatic recovery.
      // The caller must explicitly choose --replace.
    }
  }

  let backupsRemoved = 0;
  if (targetValid) {
    for (const backup of inactiveBackups) {
      if (!(await pathExists(backup.path))) continue;
      await rm(backup.path, { recursive: true, force: true });
      backupsRemoved += 1;
    }
  }
  return { ok: true, targetValid, restoredBackup, stagesRemoved, backupsRemoved };
}

export async function exportBundle({ cacheDir, outputDir, spec = DEFAULT_EMBED_MODEL_SPEC }) {
  validateSpec(spec);
  const revisionedSource = revisionDirectory(cacheDir, spec);
  const legacyMainSource = modelDirectory(cacheDir, spec.model);
  let source = revisionedSource;
  try {
    await verifyModelDirectory(revisionedSource, spec);
  } catch (revisionError) {
    // Compatibility is intentionally export-only: installations and runtime
    // verification always require the frozen revision directory. This lets an
    // operator migrate an already downloaded, checksum-identical main cache.
    try {
      await verifyModelDirectory(legacyMainSource, spec);
      source = legacyMainSource;
    } catch {
      throw revisionError;
    }
  }

  const output = path.resolve(outputDir);
  if (await pathExists(output)) throw new Error("bundle output already exists");
  await mkdir(path.dirname(output), { recursive: true });
  const stage = `${output}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(path.join(stage, CACHE_PAYLOAD), { recursive: true });
    await copySnapshot(source, path.join(stage, CACHE_PAYLOAD), spec);
    await writeFile(path.join(stage, CACHE_MANIFEST), stableJson(canonicalManifest(spec)), { mode: 0o644 });
    await writeFile(path.join(stage, "MODEL_LICENSE.txt"), spec.licenseText, { mode: 0o644 });
    const result = await verifyBundle(stage, spec);
    await rename(stage, output);
    return { ...result, exported: true };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function importBundle({ bundleDir, cacheDir, replace = false, spec = DEFAULT_EMBED_MODEL_SPEC }) {
  validateSpec(spec);
  const cacheRoot = path.resolve(cacheDir);
  await recoverInterruptedImport(cacheRoot, spec);
  const bundle = path.resolve(bundleDir);
  const verified = await verifyBundle(bundle, spec);
  const target = revisionDirectory(cacheRoot, spec);
  await mkdir(path.dirname(target), { recursive: true });
  const stage = path.join(path.dirname(target), `.${path.basename(target)}.import-${process.pid}-${randomUUID()}`);
  const backup = path.join(path.dirname(target), `.${path.basename(target)}.backup-${process.pid}-${randomUUID()}`);
  let movedExisting = false;
  try {
    await mkdir(stage, { recursive: false });
    await copySnapshot(path.join(bundle, CACHE_PAYLOAD), stage, spec);
    await writeFile(path.join(stage, INSTALLED_MANIFEST), stableJson(canonicalManifest(spec)), { mode: 0o644 });
    await verifyModelDirectory(stage, spec);

    if (await pathExists(target)) {
      try {
        await verifyModelDirectory(target, spec);
        await rm(stage, { recursive: true, force: true });
        return { ...verified, imported: false, alreadyPresent: true };
      } catch (error) {
        if (!replace) {
          throw new Error(`target cache is present but invalid; rerun with --replace (${error.message})`);
        }
      }
      await rename(target, backup);
      movedExisting = true;
    }

    await rename(stage, target);
    if (movedExisting) await rm(backup, { recursive: true, force: true });
    return { ...verified, imported: true, alreadyPresent: false };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (movedExisting && !(await pathExists(target)) && await pathExists(backup)) {
      await rename(backup, target);
    }
    throw error;
  }
}

function defaultCacheDir() {
  if (process.env.TRANSFORMERS_CACHE) return path.resolve(process.env.TRANSFORMERS_CACHE);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return path.join(root, "node_modules", "@huggingface", "transformers", ".cache");
}

function usage() {
  return `Usage:
  node scripts/embed-cache.mjs verify-cache [--cache-dir DIR]
  node scripts/embed-cache.mjs export --output DIR [--cache-dir DIR]
  node scripts/embed-cache.mjs verify --bundle DIR
  node scripts/embed-cache.mjs import --bundle DIR [--cache-dir DIR] [--replace]
  node scripts/embed-cache.mjs recover [--cache-dir DIR]

The bundle contains the audited Xenova/bge-small-zh-v1.5 snapshot, checksums,
source revision and MIT licence. Run embed-health.mjs with LOCAL_EMBED_OFFLINE=1
after import to prove that inference succeeds without network access.`;
}

function parseCli(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = { replace: false };
  while (args.length) {
    const flag = args.shift();
    if (flag === "--replace") {
      options.replace = true;
      continue;
    }
    if (!["--cache-dir", "--output", "--bundle"].includes(flag)) {
      throw new Error(`unknown option: ${flag}`);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return { command, options };
}

export async function runCli(argv) {
  const { command, options } = parseCli(argv);
  if (["help", "--help", "-h"].includes(command)) return { help: usage() };
  const cacheDir = options.cacheDir ? path.resolve(options.cacheDir) : defaultCacheDir();
  if (command === "verify-cache") return verifyCache(cacheDir);
  if (command === "recover") return recoverInterruptedImport(cacheDir);
  if (command === "export") {
    if (!options.output) throw new Error("--output is required");
    return exportBundle({ cacheDir, outputDir: options.output });
  }
  if (command === "verify") {
    if (!options.bundle) throw new Error("--bundle is required");
    return verifyBundle(options.bundle);
  }
  if (command === "import") {
    if (!options.bundle) throw new Error("--bundle is required");
    return importBundle({ bundleDir: options.bundle, cacheDir, replace: options.replace });
  }
  throw new Error(usage());
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  runCli(process.argv.slice(2)).then(
    (result) => console.log(result.help ?? JSON.stringify(result)),
    (error) => {
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
    },
  );
}
