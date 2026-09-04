import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("管理后台网关标签、筛选与预算三端一致", () => {
  const overview = read("app/admin/page.tsx");
  const monitor = read("app/admin/monitor/page.tsx");
  const providers = read("app/admin/providers/page.tsx");
  const api = read("app/api/admin/providers/route.ts");
  assert.match(overview, /provider === "gateway"[\s\S]{0,80}"内网网关"/);
  assert.match(monitor, /\["gateway", "网关"\]/);
  assert.match(monitor, /provider === "gateway"[\s\S]{0,80}tone: "info"/);
  assert.match(providers, /quota: \{ primary: string; fallback: string; gateway: string \}/);
  assert.match(providers, /gateway-monthly-token-budget/);
  assert.match(providers, /quota\.gateway/);
  assert.match(api, /key === "quota\.gateway\.tokens"/);
  assert.match(api, /gateway: db\["quota\.gateway\.tokens"\]/);
});

test("独立服务 Compose 不公开端口、不横向注入密钥、保留内网", () => {
  const extractors = read("deploy/extractors/docker-compose.yml");
  const litellm = read("deploy/litellm/docker-compose.yml");
  for (const value of [extractors, litellm]) {
    assert.doesNotMatch(value, /^\s*ports:/m);
    assert.doesNotMatch(value, /^\s*env_file:/m);
  }
  assert.match(extractors, /DOCLING_SERVE_API_KEY: \$\{DOCLING_SERVE_API_KEY:\?/);
  assert.match(extractors, /CRAWL4AI_API_TOKEN: \$\{CRAWL4AI_API_TOKEN:\?/);
  assert.match(extractors, /Authorization: Bearer \$\$\{CRAWL4AI_API_TOKEN\}/);
  assert.match(extractors, /external: true[\s\S]{0,80}apebooklm_default/);
  assert.match(litellm, /litellm-non_root:v1\.98\.0@sha256:[a-f0-9]{64}/);
  assert.match(litellm, /LITELLM_SALT_KEY: \$\{LITELLM_SALT_KEY:\?/);
  assert.match(litellm, /LITELLM_MODE: PRODUCTION/);
  const dbBlock = litellm.slice(litellm.indexOf("litellm-db:"), litellm.indexOf("litellm-gateway:"));
  assert.doesNotMatch(dbBlock, /LITELLM_MASTER_KEY|DASHSCOPE|MOONSHOT/);
});

test("真实 env 被 Git 忽略，启动前必须通过密钥预检", () => {
  const ignore = read(".gitignore");
  const preflight = read("scripts/open-source-services-preflight.mjs");
  const liteEnv = read("deploy/litellm/litellm.env.example");
  assert.match(ignore, /\/deploy\/extractors\/extractors\.env/);
  assert.match(ignore, /\/deploy\/litellm\/litellm\.env/);
  assert.match(preflight, /stat\.mode & 0o077/);
  assert.match(preflight, /CHANGE_TO\|CHANGEME\|REPLACE_ME/);
  assert.match(preflight, /master\.startsWith\("sk-"\)/);
  assert.match(preflight, /URL-safe/);
  assert.match(liteEnv, /^LITELLM_MASTER_KEY=sk-/m);
  assert.match(liteEnv, /^LITELLM_SALT_KEY=/m);
});

test("生产边界诚实：未冻结 digest 与跨主机网络不得宣称已就绪", () => {
  const docs = read("docs/open-source-integrations.md");
  assert.match(docs, /不是跨主机网络合同/);
  assert.match(docs, /TLS\/mTLS/);
  assert.match(docs, /当前只有 LiteLLM 固定 digest/);
  assert.match(docs, /保持 `MODE=off`/);
});

test("构建门禁按真实墙钟区分超时与提前 OOM SIGKILL", () => {
  const build = read("scripts/build-ci.sh");
  assert.match(build, /started_at=\$\(date \+%s\)/);
  assert.match(build, /elapsed=\$\(\( \$\(date \+%s\) - started_at \)\)/);
  assert.match(build, /timeout_floor=\$\(\( TIMEOUT > 2 \? TIMEOUT - 2 : TIMEOUT \)\)/);
  assert.match(build, /\[ "\$rc" -eq 137 \] && \[ "\$elapsed" -ge "\$timeout_floor" \]/);
  assert.match(build, /优先查 OOM\/cgroup\/人工 kill/);
});
