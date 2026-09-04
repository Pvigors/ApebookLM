import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CAD_JOB_STAGE_LABEL,
  CAD_JOB_STAGE_PROGRESS,
  cadJobDisplayStage,
  cadJobProgressForStage,
  cadJobStageFromProgress,
} from "../../lib/job-types.ts";

const jobs = readFileSync(new URL("../../lib/jobs.ts", import.meta.url), "utf8");
const cadGenerator = readFileSync(new URL("../../lib/cad-generator.ts", import.meta.url), "utf8");
const text2cadGenerator = readFileSync(new URL("../../lib/text2cad-generator.ts", import.meta.url), "utf8");
const cadPipeline = `${jobs}\n${cadGenerator}\n${text2cadGenerator}`;

test("CAD 阶段枚举、中文显示与持久化进度边界稳定且单调", () => {
  assert.deepEqual(CAD_JOB_STAGE_PROGRESS, {
    queued: 0,
    starting: 5,
    validating_input: 10,
    reading_sources: 18,
    extracting_constraints: 28,
    planning_geometry: 38,
    validating_spec: 50,
    building_geometry: 62,
    checking_geometry: 75,
    validating_step: 84,
    preparing_output: 90,
    publishing_output: 94,
    finalizing: 98,
    completed: 100,
  });
  const progresses = Object.values(CAD_JOB_STAGE_PROGRESS);
  assert.deepEqual(progresses, [...progresses].sort((a, b) => a - b));
  assert.equal(new Set(progresses).size, progresses.length);
  for (const stage of Object.keys(CAD_JOB_STAGE_PROGRESS)) {
    assert.ok(CAD_JOB_STAGE_LABEL[stage]?.trim(), `${stage} 必须有中文显示`);
    assert.equal(cadJobProgressForStage(stage), CAD_JOB_STAGE_PROGRESS[stage]);
  }
});

test("旧 CAD 任务的任意 progress 可向下收敛，终态始终以 status 为准", () => {
  assert.equal(cadJobStageFromProgress(Number.NaN), "queued");
  assert.equal(cadJobStageFromProgress(-10), "queued");
  assert.equal(cadJobStageFromProgress(4), "queued");
  assert.equal(cadJobStageFromProgress(5), "starting");
  assert.equal(cadJobStageFromProgress(37), "extracting_constraints");
  assert.equal(cadJobStageFromProgress(38), "planning_geometry");
  assert.equal(cadJobStageFromProgress(89), "validating_step");
  assert.equal(cadJobStageFromProgress(99), "finalizing");
  assert.equal(cadJobStageFromProgress(101), "completed");

  assert.equal(cadJobDisplayStage("draft", 90), "queued");
  assert.equal(cadJobDisplayStage("queued", 90), "queued");
  assert.equal(cadJobDisplayStage("running", 90), "preparing_output");
  assert.equal(cadJobDisplayStage("running", 94), "publishing_output");
  assert.equal(cadJobDisplayStage("done", 0), "completed");
  assert.equal(cadJobDisplayStage("error", 100), "failed");
  assert.equal(cadJobDisplayStage("canceled", 100), "canceled");
});

test("CAD 心跳只刷新 updated_at，阶段只在真实边界通过 attempt CAS 更新", () => {
  assert.match(
    jobs,
    /job\.kind === "cad"\s*\? \{\}\s*:\s*\{ progress: j\.progress < 90 \? j\.progress \+ 7 : 90 \}/,
    "CAD 不得使用通用定时器伪增进度"
  );
  assert.match(
    jobs,
    /const updateCadStage:[\s\S]*?cadJobProgressForStage\(stage\)[\s\S]*?const advances = nextProgress > lastCadProgress[\s\S]*?updateJobForRun\(job\.id, expectedAttempt[\s\S]*?progress: nextProgress, stage, stage_started_at: Date\.now\(\)[\s\S]*?generationAbort\?\.abort\(\)[\s\S]*?throw new JobRunLostError/,
    "阶段写必须带 run_attempt，失权后中止底层 CAD"
  );

  const orderedBoundaries = [
    'updateCadStage("starting")',
    'onCadStage?.("validating_input")',
    'opts.onStage?.("reading_sources")',
    'opts.onStage?.("extracting_constraints")',
    'opts.onStage?.("planning_geometry")',
    'opts.onStage?.("validating_spec")',
    'opts.onStage?.("building_geometry")',
    'opts.onStage?.("checking_geometry")',
    'opts.onStage?.("validating_step")',
    'onCadStage?.("preparing_output")',
    'onCadStage?.("publishing_output")',
    'updateCadStage("finalizing")',
  ];
  for (const boundary of orderedBoundaries) {
    assert.ok(cadPipeline.includes(boundary), `缺少真实阶段边界:${boundary}`);
  }
});

test("非 CAD 任务保留原初始进度与定时推进行为", () => {
  assert.match(jobs, /else if \(!\(await updateJobForRun\(job\.id, expectedAttempt, \{ progress: 12 \}\)\)\) return;/);
  assert.match(jobs, /\{ progress: j\.progress < 90 \? j\.progress \+ 7 : 90 \}/);
});
