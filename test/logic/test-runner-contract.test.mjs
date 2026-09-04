import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const runner = fs.readFileSync(new URL("../../scripts/run-tests.mjs", import.meta.url), "utf8");

test("测试运行器对单文件设硬超时并在首个失败处立即终止其余子进程", () => {
  assert.match(runner, /TEST_FILE_TIMEOUT_MS/);
  assert.match(runner, /child\.kill\("SIGTERM"\)/);
  assert.match(runner, /child\.kill\("SIGKILL"\)/);
  assert.match(runner, /if \(!result\.ok\) \{[\s\S]*stopping = true;[\s\S]*terminateActive\(\);/);
  assert.match(runner, /tests > 0 && pass === tests && fail === 0/);
  assert.doesNotMatch(runner, /await Promise\.all[\s\S]*if \(stopping[\s\S]*child\.kill/);
  assert.doesNotMatch(runner, /--test-force-exit/);
});
