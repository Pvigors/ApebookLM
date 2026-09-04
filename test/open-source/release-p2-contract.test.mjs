import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateSelfHostingConfig } from "../../scripts/self-hosting-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const strongPassword = ["F9x", "_2mQ7", "vL4c", "R8pT6", "zN3kW5h"].join("");

function composeConfig(overrides = {}) {
  return {
    SELF_HOSTING_DATABASE_MODE: "compose",
    POSTGRES_USER: "apebooklm",
    POSTGRES_PASSWORD: strongPassword,
    POSTGRES_DB: "apebooklm",
    DATABASE_URL: `postgres://apebooklm:${strongPassword}@db:5432/apebooklm`,
    ...overrides,
  };
}

test("自托管数据库预检拒绝弱口令和两处配置不一致", () => {
  assert.equal(validateSelfHostingConfig(composeConfig()).mode, "compose");
  assert.deepEqual(
    validateSelfHostingConfig({
      SELF_HOSTING_DATABASE_MODE: "external",
      DATABASE_URL: `postgresql://managed:${strongPassword}@postgres.internal:5432/research`,
    }),
    { mode: "external", host: "postgres.internal", database: "research" }
  );
  assert.throws(
    () => validateSelfHostingConfig(composeConfig({
      POSTGRES_PASSWORD: "postgres",
      DATABASE_URL: "postgres://apebooklm:postgres@db:5432/apebooklm",
    })),
    /长度必须不少于 24/
  );
  assert.throws(
    () => validateSelfHostingConfig(composeConfig({ POSTGRES_PASSWORD: `${strongPassword}X` })),
    /密码与 POSTGRES_PASSWORD 不一致/
  );
  assert.throws(
    () => validateSelfHostingConfig(composeConfig({ POSTGRES_DB: "other" })),
    /数据库名与 POSTGRES_DB 不一致/
  );
});

test("自托管预检命令可执行且不输出数据库密码", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "apebooklm-self-hosting-preflight-"));
  try {
    const envFile = path.join(temp, ".env");
    writeFileSync(
      envFile,
      Object.entries(composeConfig()).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
      { mode: 0o600 }
    );
    chmodSync(envFile, 0o600);
    const output = execFileSync(process.execPath, ["scripts/self-hosting-preflight.mjs", "--env", envFile], {
      cwd: root,
      encoding: "utf8",
    });
    assert.match(output, /自托管配置预检通过/);
    assert.equal(output.includes(strongPassword), false);

    chmodSync(envFile, 0o644);
    const insecure = spawnSync(
      process.execPath,
      ["scripts/self-hosting-preflight.mjs", "--env", envFile],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(insecure.status, 1);
    assert.match(insecure.stderr, /权限必须为 0600/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Compose 在数据库前执行隔离的配置预检", () => {
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  assert.match(compose, /config-check:[\s\S]*target: config-validator[\s\S]*network_mode: none/);
  assert.match(compose, /db:[\s\S]*depends_on:[\s\S]*config-check:[\s\S]*service_completed_successfully/);
  assert.match(compose, /postgres:16-alpine@sha256:[a-f0-9]{64}/);
  assert.match(compose, /127\.0\.0\.1:\$\{HOST_PORT:-3000\}:3000/);
  assert.match(compose, /web:[\s\S]*environment:[\s\S]*PORT:\s*"3000"/);
  assert.match(compose, /cad-worker:[\s\S]*environment:[\s\S]*PORT:\s*"3000"/);
  assert.match(compose, /web:[\s\S]*healthcheck:[\s\S]*\/api\/ready/);
  assert.match(compose, /cad-worker:[\s\S]*depends_on:[\s\S]*web:[\s\S]*service_healthy/);
  assert.match(compose, /web:[\s\S]*NBLM_CAD_ENABLED:\s*\$\{NBLM_CAD_ENABLED:-1\}/);
});

test("Docker frontend 与基础镜像固定摘要，runtime 系统包层先于应用文件", () => {
  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /node:20-bookworm-slim@sha256:[a-f0-9]{64}/);
  for (const [dependencyStage, runtimeStage] of [
    ["app-runtime-deps", "app-runtime"],
    ["cad-runtime-deps", "cad-runner"],
  ]) {
    const dependencyMarker = `FROM runtime-base AS ${dependencyStage}`;
    const runtimeMarker = `FROM ${dependencyStage} AS ${runtimeStage}`;
    const dependencyIndex = dockerfile.indexOf(dependencyMarker);
    const runtimeIndex = dockerfile.indexOf(runtimeMarker);
    assert.ok(dependencyIndex >= 0, `${dependencyStage} 必须存在`);
    assert.ok(runtimeIndex > dependencyIndex, `${runtimeStage} 必须继承稳定依赖层`);
    assert.match(dockerfile.slice(dependencyIndex, runtimeIndex), /apt-get install/);
    assert.match(dockerfile.slice(runtimeIndex), /COPY --from=runtime-files \/app \/app/);
  }
  assert.match(dockerfile, /COPY --from=builder \/app\/scripts\/embed-cache\.mjs \.\/scripts\/embed-cache\.mjs/);
});

test("Web SBOM 使用 Web 文档名并保留 eSpeak NG 文件级许可边界", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "apebooklm-sbom-"));
  try {
    const fakeDocker = path.join(temp, "docker");
    writeFileSync(fakeDocker, `#!/bin/sh
if [ "$1" = "image" ]; then
  printf '%s\\n' 'sha256:${"a".repeat(64)}'
elif [ "$1" = "run" ] && [ "$4" = "sh" ]; then
  printf '%s\\n' 'espeak-ng\t1.51+dfsg-10+deb12u2\tarm64'
elif [ "$1" = "run" ] && [ "$4" = "node" ]; then
  printf '%s\\n' '[]'
else
  exit 9
fi
`, { mode: 0o755 });
    chmodSync(fakeDocker, 0o755);
    const output = execFileSync(
      process.execPath,
      ["scripts/generate-container-sbom.mjs", "apebooklm-public-web:test"],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${temp}:${process.env.PATH}` } }
    );
    const sbom = JSON.parse(output);
    assert.match(sbom.name, /^apebooklm-web-/);
    assert.match(sbom.documentNamespace, /\/web\//);
    const espeak = sbom.packages.find((item) => item.name === "espeak-ng");
    assert.equal(espeak.licenseConcluded, "NOASSERTION");
    assert.match(espeak.licenseComments, /file-level notices/);
    assert.match(espeak.copyrightText, /\/usr\/share\/doc\/espeak-ng\/copyright/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
