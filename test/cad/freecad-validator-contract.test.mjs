import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("社区版 CAD 镜像有独立 FreeCAD 复读、跨工具 CI 和下载门", () => {
  const docker = read("Dockerfile");
  const compose = read("docker-compose.yml");
  const validation = read("lib/cad-step-validation.ts");
  const download = read("app/api/studio/cad/[id]/[format]/route.ts");
  const ci = read(".github/workflows/ci.yml");
  const cross = read("scripts/cad-cross-validator-health.mjs");
  const sbom = read("scripts/generate-container-sbom.mjs");

  assert.match(docker, /node:20-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(docker, /libfreecad-python3-0\.20=0\.20\.2\+dfsg1-4/);
  assert.match(docker, /CAD_EXTERNAL_STEP_VALIDATOR_BIN=\/usr\/bin\/python3/);
  assert.match(docker, /PYTHONPATH=\/usr\/lib\/freecad-python3\/lib/);
  assert.match(docker, /FROM cad-runtime-deps AS cad-runner[\s\S]*USER node/);
  assert.match(docker, /FROM app-runtime-deps AS app-runtime[\s\S]*FROM app-runtime AS runner/);
  assert.match(compose, /cad-worker:[\s\S]*mem_limit:\s*3g[\s\S]*cpus:\s*2\.0[\s\S]*pids_limit:\s*256/);
  assert.match(compose, /cad-worker:[\s\S]*user:\s*"\$\{NBLM_CAD_RUNTIME_UID:-1000\}:\$\{NBLM_CAD_RUNTIME_GID:-1000\}"/);
  assert.match(compose, /cad-worker:[\s\S]*HOME:\s*\/tmp/);
  assert.match(compose, /cad-worker:[\s\S]*read_only:\s*true/);
  assert.match(compose, /cad-data:\/app\/\.data\/cad/);
  assert.match(compose, /\/app\/\.data\/cad-tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777/);
  assert.match(validation, /validator:\s*"freecad-native"/);
  assert.match(validation, /CAD_REQUIRE_EXTERNAL_STEP_VALIDATOR/);
  assert.match(download, /requireExternalStep[\s\S]*externalStep\?\.validator !== "freecad-native"/);
  assert.match(ci, /Build isolated CAD worker image[\s\S]*Replicad to FreeCAD cross-tool STEP gate/);
  assert.match(ci, /Standalone CAD worker readiness as non-root[\s\S]*--read-only[\s\S]*process\.getuid\(\) === 0[\s\S]*body\.eligible===true/);
  assert.match(ci, /Generate CAD image SPDX SBOM and digest[\s\S]*generate-container-sbom\.mjs[\s\S]*upload-artifact@v4/);
  assert.match(sbom, /spdxVersion:\s*"SPDX-2\.3"/);
  assert.match(sbom, /dpkg-query/);
  assert.match(sbom, /pkg:npm/);
  for (const sample of ["single", "multi", "corrupt", "wrong-unit", "no-solid"]) {
    assert.match(cross, new RegExp(sample));
  }
  assert.match(cross, /FreeCAD returned an empty STEP shape/);
  assert.match(cross, /STEP does not declare millimeter units/);
  assert.match(cross, /FreeCAD STEP contains no solids/);
});
