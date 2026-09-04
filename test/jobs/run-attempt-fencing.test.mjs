// 异步制品任务 run-attempt 栅栏回归。
//
// 硬超时是 Promise.race，不会终止底层生成：旧跑超时被重排后仍可在后台
// 继续执行。因此 status=running 不是身份证明（新跑也是 running），必须同时
// 校验 claim 时的 run_attempt。本文件同时锁纯状态机与 jobs.ts 的写路径，
// 防止日后又退化成「先 getJob 再无条件 UPDATE/INSERT」。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../lib/jobs.ts", import.meta.url), "utf8");

test("纯状态机：只有 running 且代次相同才是当前跑", async () => {
  const { abortCadWhenRunLost, isCurrentJobRun } = await import("../../lib/jobs.ts");

  assert.equal(isCurrentJobRun({ status: "running", run_attempt: 2 }, 2), true);
  assert.equal(isCurrentJobRun({ status: "running", run_attempt: 3 }, 2), false, "新跑不属于旧跑");
  assert.equal(isCurrentJobRun({ status: "queued", run_attempt: 2 }, 2), false, "重排后旧跑失权");
  assert.equal(isCurrentJobRun({ status: "canceled", run_attempt: 2 }, 2), false, "取消后失权");
  assert.equal(isCurrentJobRun({ status: "done", run_attempt: 2 }, 2), false, "终态后失权");
  assert.equal(isCurrentJobRun({ status: "running", run_attempt: 0 }, 0), false, "缺少有效认领代次时 fail closed");
  assert.equal(isCurrentJobRun(undefined, 2), false);

  const active = new AbortController();
  assert.equal(abortCadWhenRunLost(active, { status: "running", run_attempt: 2 }, 2), false);
  assert.equal(active.signal.aborted, false);
  assert.equal(abortCadWhenRunLost(active, { status: "canceled", run_attempt: 2 }, 2), true);
  assert.equal(active.signal.aborted, true, "用户取消后必须终止 CAD 模型请求和几何子进程");
});

test("源码契约：所有用户制品发现取消或失权时立即中止个人模型调用", () => {
  assert.match(src, /const generationAbort = job\.user_id \? new AbortController\(\) : undefined/);
  assert.match(src, /if \(abortGenerationWhenRunLost\(generationAbort, j, expectedAttempt\)\) return;/);
  assert.match(src, /runArtifactJob\(job, expectedAttempt, generationAbort\?\.signal, updateCadStage\)/);
  assert.match(src, /jobModelRuntime[\s\S]{0,120}signal: generationAbort\?\.signal/);
  assert.match(src, /generateQuiz\(nb, sourceIds, quizOptions\)/);
  assert.match(src, /signal,\s*\n\s*directive,/);
});

test("源码契约：CAD 阶段写与心跳分离，不恢复定时伪进度", () => {
  assert.match(src, /const updateCadStage:[\s\S]*?updateJobForRun\(job\.id, expectedAttempt/);
  assert.match(src, /job\.kind === "cad"\s*\? \{\}\s*:\s*\{ progress: j\.progress < 90/);
  assert.match(src, /runArtifactJob\(job, expectedAttempt, generationAbort\?\.signal, updateCadStage\)/);
  assert.match(src, /if \(outputId\) await discardStudioOutput\(outputId\);\s*throw error;/);
});

test("源码契约：产物、进度、重排、成功收尾都携带不变 attempt", () => {
  assert.match(src, /const expectedAttempt = claimedRunAttempt\(job\)/);
  assert.match(src, /createStudioOutputForRun\(\s*job\.id,\s*expectedAttempt,/s);
  assert.match(src, /updateJobForRun\(job\.id, expectedAttempt, \{\s*progress:/s);
  assert.match(src, /requeueJobForRetry\(job\.id, expectedAttempt\)/);
  assert.match(src, /finalizeJobDone\(job\.id, outputId, billing, expectedAttempt\)/);
  assert.doesNotMatch(src, /\bupdateJob\(job\.id,/,
    "worker 不得使用无 attempt 的通用更新覆盖新跑");
});

test("源码契约：产物 INSERT 后、函数返回前必须二次校验并清理失权产物", () => {
  assert.match(
    src,
    /const finishOutput =[\s\S]*?updateJobForRun\(job\.id, expectedAttempt, \{\}\)[\s\S]*?discardStudioOutput\(out\.id\)[\s\S]*?throw new JobRunLostError/,
    "finishOutput 必须以 attempt CAS 做返回前二次栅栏"
  );
  assert.ok(
    (src.match(/return await finishOutput\(/g) ?? []).length >= 11,
    "audio/video/infographic/xhs 与全部文本制品分支都必须经 finishOutput"
  );
  for (const commit of ["commitAudioFile", "commitVideoFile", "commitInfographicPng", "commitXhsCards"]) {
    assert.match(
      src,
      new RegExp(`${commit}\\([\\s\\S]{0,180}?return await finishOutput\\(out\\)`),
      `${commit} 后必须立即做返回前二次栅栏`
    );
  }
  assert.match(src, /if \(!won\) \{\s*if \(outputId\) await discardStudioOutput\(outputId\)/s);
  assert.match(src, /deleteOutputMedia\(outputId\)/, "失权清理不能只删 DB 行而留下媒体");
});

test("源码契约：旧跑输家不得终判或退分", () => {
  assert.match(
    src,
    /const failed = await failJobAndQueueRefund\([\s\S]*?expectedAttempt[\s\S]*?if \(!failed\) return;[\s\S]*?processCreditRefundOutbox\(/,
    "只有本 attempt 原子写终态+退款 outbox 后才能处理退款"
  );
  assert.match(
    src,
    /const currentRun = await getJob\(job\.id\);[\s\S]{0,120}if \(!isCurrentJobRun\(currentRun, expectedAttempt\)\) return;/,
    "catch 不得把新 attempt 的 running 误当成自己"
  );
});

test("供应商单请求超时不重排整个任务，避免长等待与重复 Token", () => {
  assert.match(src, /APIConnectionTimeoutError\|APITimeoutError/);
  assert.match(src, /const transient\s*=\s*\n\s*!hardTimeout && !providerRequestTimeout/);
});

test("水印权益在扣费入队时快照，不随排队期间会员到期漂移", () => {
  const route = readFileSync(
    new URL("../../app/api/notebooks/[id]/studio/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(route, /const watermarkAtCharge = .*getEffectivePlanConfigForUser\(user\)/);
  assert.match(route, /__watermark:\s*watermarkAtCharge/);
  assert.match(src, /typeof p\.__watermark === "boolean"[\s\S]*?p\.__watermark/);
});

test("用户制品只能走原子扣费入队，平台任务必须显式 sponsored", () => {
  const route = readFileSync(
    new URL("../../app/api/notebooks/[id]/studio/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(route, /enqueueChargedArtifact\(/);
  assert.doesNotMatch(route, /consumeDailyQuota\(|enqueueArtifact\(/);
  assert.match(src, /if \(userId && params\.__sponsored !== true\)[\s\S]*?throw new Error/);
});
