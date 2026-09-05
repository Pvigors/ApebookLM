import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { createConfiguration, serializeConfiguration, validateOrigin, writeConfiguration } from "../../scripts/init-self-hosting.mjs";
import { validateSelfHostingConfig } from "../../scripts/self-hosting-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const fixture = {
  imageTag: `sha-${"a".repeat(40)}`, origin: "http://localhost:3000", username: "test-admin",
  password: "synthetic test-only password!", apiKey: "fixture-$literal-not-a-real-key",
  baseUrl: "https://models.example.com/v1", model: "fixture-model",
};

test("初始化生成独立强密钥并复用管理员 scrypt 配置与数据库预检", async () => {
  const values = createConfiguration(fixture);
  assert.equal(validateSelfHostingConfig(values).mode, "compose");
  assert.equal(values.OPENAI_VISION_MODEL, fixture.model);
  const secrets = [values.POSTGRES_PASSWORD, values.AUTH_SECRET, values.MODEL_API_CONFIG_SECRET, values.EXPORT_FP_SECRET];
  assert.equal(new Set(secrets).size, 4);
  assert.ok(secrets.every((secret) => secret.length >= 43));
  const account = JSON.parse(Buffer.from(values.ADMIN_PASSWORD_ACCOUNT_B64, "base64url").toString("utf8"));
  assert.equal(account.username, fixture.username);
  assert.match(account.userId, /^password-admin-/);
  assert.equal(account.credentialVersion, 1);
  assert.ok(account.expiresAt > Date.now());
  const [kind, n, r, p, salt, digest] = account.passwordHash.split("$");
  assert.equal(kind, "scrypt");
  assert.deepEqual([n, r, p], ["32768", "8", "3"]);
  const actual = crypto.scryptSync(fixture.password, Buffer.from(salt, "base64url"), 64,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  assert.equal(actual.toString("base64url"), digest);
  assert.equal(serializeConfiguration(values).includes(fixture.password), false);
  assert.equal(createConfiguration({ ...fixture, visionModel: "fixture-vision" }).OPENAI_VISION_MODEL, "fixture-vision");
});

test("安全创建为 0600，已有文件和符号链接均不会被覆盖，预检不泄露密钥", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "apebooklm-quickstart-"));
  try {
    const envFile = path.join(temp, ".env");
    const values = createConfiguration({ ...fixture, envFile });
    writeConfiguration(envFile, values);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    const original = fs.readFileSync(envFile, "utf8");
    assert.throws(() => writeConfiguration(envFile, values), { code: "EEXIST" });
    assert.equal(fs.readFileSync(envFile, "utf8"), original);
    const link = path.join(temp, "link.env");
    fs.symlinkSync(envFile, link);
    assert.throws(() => writeConfiguration(link, values), { code: "EEXIST" });
    assert.equal(fs.readFileSync(envFile, "utf8"), original);
    const output = execFileSync(process.execPath, [path.join(root, "scripts/self-hosting-preflight.mjs"), "--env", envFile], { encoding: "utf8" });
    assert.match(output, /预检通过/);
    for (const secret of [fixture.apiKey, fixture.password, values.POSTGRES_PASSWORD, values.MODEL_API_CONFIG_SECRET]) assert.equal(output.includes(secret), false);
    const exists = spawnSync(process.execPath, [path.join(root, "scripts/init-self-hosting.mjs"), "--env", envFile], { encoding: "utf8" });
    assert.equal(exists.status, 1);
    assert.match(exists.stderr, /不会读取或覆盖/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("初始化拒绝浮动标签、远程 HTTP、弱管理员密码与环境注入", () => {
  for (const imageTag of ["main", "latest", "0.1.0", "sha-abc", "v1.2.3\nOPENAI_API_KEY=bad"]) {
    assert.throws(() => createConfiguration({ ...fixture, imageTag }), /版本号/);
  }
  for (const origin of ["http://example.com", "https://example.com/path", "https://user:pass@example.com", "https://example.com?x=1"]) assert.throws(() => validateOrigin(origin));
  assert.equal(validateOrigin("https://notes.example.com/"), "https://notes.example.com");
  assert.throws(() => createConfiguration({ ...fixture, password: "short" }), /16–256/);
  assert.throws(() => createConfiguration({ ...fixture, apiKey: "" }), /不能为空/);
  for (const value of ["key\nADMIN_PASSWORD_LOGIN_ENABLED=0", "key'quote", "key\\escape"]) {
    assert.throws(() => serializeConfiguration({ OPENAI_API_KEY: value }), /不支持/);
  }
  assert.match(serializeConfiguration({ OPENAI_API_KEY: fixture.apiKey }), /='fixture-\$literal-not-a-real-key'/);
});

test("快速启动编排只替换构建来源，完整继承隔离、FreeCAD、数据与就绪约束", () => {
  const baseline = yaml.load(fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8"));
  const quickstart = yaml.load(fs.readFileSync(path.join(root, "docker-compose.quickstart.yml"), "utf8"));
  const targets = { web: "web", "cad-worker": "cad", "config-check": "config-validator" };
  for (const [service, config] of Object.entries(baseline.services)) {
    const expected = structuredClone(config);
    const actual = structuredClone(quickstart.services[service]);
    if (expected.build) {
      delete expected.build;
      assert.equal(actual.platform, "linux/amd64");
      assert.ok(actual.image.includes(`-${targets[service]}:`));
      assert.ok(actual.image.includes("${APEBOOKLM_IMAGE_TAG:?"));
      assert.equal(Object.hasOwn(actual, "build"), false);
      delete actual.image;
      delete actual.platform;
    }
    assert.deepEqual(actual, expected, `${service} 的安全或就绪配置发生偏移`);
  }
  assert.deepEqual(quickstart.volumes, baseline.volumes);
});

test("发布只接收标签或手动触发，并在推送前验证同一 SHA 的 CI 和实际镜像", () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, ".github/workflows/publish-images.yml"), "utf8"));
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push, { tags: ["v*"] });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.prepare.permissions, { contents: "read", actions: "read" });
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: "read", packages: "write" });
  assert.equal(workflow.jobs.publish.needs, "prepare");
  const source = workflow.jobs.prepare.steps.find((step) => step.id === "source").run;
  assert.ok(source.includes('-f head_sha="$sha"'));
  assert.ok(source.includes('-f event=push'));
  assert.ok(source.includes('test "$package_version" = "${requested#v}"'));
  const steps = workflow.jobs.publish.steps;
  const push = steps.findIndex((step) => step.run?.includes('docker push "$ref"'));
  for (const marker of ["freecad-health.py", "cad-cross-validator-health.mjs", "--wait-timeout 240"]) {
    const gate = steps.findIndex((step) => step.run?.includes(marker));
    assert.ok(gate >= 0 && gate < push, `${marker} 必须发生在发布前`);
  }
  const noOverwrite = steps.findIndex((step) => step.name === "Refuse to overwrite any existing destination tag");
  assert.ok(noOverwrite >= 0 && noOverwrite < push);
  const tagGuard = steps[noOverwrite].run;
  assert.ok(tagGuard.includes('"https://ghcr.io/v2/$repository/manifests/$IMAGE_TAG"'), "镜像存在性检查必须使用 Registry HTTP API V2 地址");
  assert.equal(tagGuard.includes('"https://ghcr.io/$repository/manifests/$IMAGE_TAG"'), false, "错误路由返回的 404 不能被视为标签未使用");
  assert.ok(tagGuard.includes('--data-urlencode "scope=repository:$repository:pull,push"'));
  assert.ok(tagGuard.includes('set -euo pipefail'));
  assert.ok(tagGuard.includes('token="$(curl --fail'), "token 端点的 403/404 必须立即失败");
  assert.match(tagGuard, /404\) ;;[\s\S]*200\)[^\n]+exit 1/);
  assert.match(tagGuard, /\*\)[^\n]+HTTP \$status[^\n]+exit 1/, "manifest 的 403 等未知状态不得放行");
  assert.equal(workflow.concurrency.group, "publish-container-images");
});
