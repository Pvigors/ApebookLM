#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(absolute));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(absolute);
  }
  return files;
}

const root = process.cwd();
const tests = (await collectTests(path.join(root, "test")))
  .map((file) => path.relative(root, file))
  .sort((a, b) => a.localeCompare(b));

if (!tests.length) {
  console.error("没有发现任何 *.test.mjs 测试文件");
  process.exit(1);
}

console.log(`发现 ${tests.length} 个测试文件`);
const requestedConcurrency = Number(process.env.TEST_FILE_CONCURRENCY ?? 2);
const requestedFileTimeout = Number(process.env.TEST_FILE_TIMEOUT_MS ?? 300_000);
const quiet = process.env.TEST_QUIET === "1";
const concurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
  ? Math.min(requestedConcurrency, 8)
  : 2;
const fileTimeoutMs = Number.isInteger(requestedFileTimeout) && requestedFileTimeout >= 30_000
  ? Math.min(requestedFileTimeout, 1_200_000)
  : 300_000;
const active = new Set();
const results = [];
let nextIndex = 0;
let stopping = false;

function terminateActive(signal = "SIGTERM") {
  for (const child of active) child.kill(signal);
  if (signal === "SIGTERM" && active.size) {
    const force = setTimeout(() => {
      for (const child of active) child.kill("SIGKILL");
    }, 5_000);
    force.unref();
  }
}

function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--no-warnings",
      "--test",
      "--test-reporter=tap",
      file,
    ], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    active.add(child);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`测试文件超时 ${file}: ${fileTimeoutMs}ms`);
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      force.unref();
    }, fileTimeoutMs);
    timeout.unref();
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      if (!quiet) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      if (!quiet) process.stderr.write(text);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      console.error(`测试文件启动失败 ${file}:`, error.message);
      active.delete(child);
      resolve({ file, ok: false, tests: 0, pass: 0, fail: 1 });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      active.delete(child);
      const readCount = (label) => {
        const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, "gm"))];
        return matches.length ? Number(matches[matches.length - 1][1]) : 0;
      };
      const tests = readCount("tests");
      const pass = readCount("pass");
      const fail = readCount("fail") + (signal || timedOut ? 1 : 0);
      const result = {
        file,
        ok: code === 0 && !signal && !timedOut && tests > 0 && pass === tests && fail === 0,
        tests,
        pass,
        fail,
      };
      if (quiet && !result.ok) process.stderr.write(output);
      resolve(result);
    });
  });
}

async function worker() {
  while (!stopping) {
    const index = nextIndex++;
    if (index >= tests.length) return;
    const result = await runFile(tests[index]);
    results.push(result);
    if (!result.ok) {
      stopping = true;
      // 必须在失败 worker 当场终止其它测试；不能等 Promise.all，否则另一个挂住的
      // worker 会让 CI 永远到不了后置清理。
      terminateActive();
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    terminateActive(signal);
  });
}

await Promise.all(Array.from({ length: Math.min(concurrency, tests.length) }, () => worker()));

const totals = results.reduce(
  (sum, result) => ({
    tests: sum.tests + result.tests,
    pass: sum.pass + result.pass,
    fail: sum.fail + result.fail,
  }),
  { tests: 0, pass: 0, fail: 0 }
);
const failedFiles = results.filter((result) => !result.ok).map((result) => result.file);
console.log(`测试文件 ${results.length}/${tests.length}，测试 ${totals.tests}，通过 ${totals.pass}，失败 ${totals.fail}`);
if (failedFiles.length) {
  console.error(`失败文件: ${failedFiles.join(", ")}`);
  process.exit(1);
}
if (results.length !== tests.length || totals.tests === 0 || totals.pass !== totals.tests) {
  console.error("测试汇总不完整，拒绝把空运行或漏文件视为成功");
  process.exit(1);
}
