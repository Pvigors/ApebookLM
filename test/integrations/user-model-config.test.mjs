import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("用户模型配置通过服务端条件执行完整安全矩阵", () => {
  const worker = fileURLToPath(new URL("../fixtures/user-model-config.server.mjs", import.meta.url));
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...childEnv } = process.env;
  const result = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--import",
    "tsx",
    "--no-warnings",
    "--test",
    "--test-reporter=tap",
    worker,
  ], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(
    result.status,
    0,
    `服务端用户模型配置矩阵失败\n${result.stdout || ""}\n${result.stderr || ""}`
  );
  assert.match(result.stdout, /# pass 6/);
  assert.match(result.stdout, /# fail 0/);
});
