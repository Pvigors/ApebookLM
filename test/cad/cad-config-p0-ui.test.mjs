import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("CAD 配置使用三条明确的意图通道，教学示例只能显式选择", () => {
  const shared = read("components/studio-shared.ts");
  const studio = read("components/Studio.tsx");

  assert.match(shared, /type CadGenerationMode = "source_driven" \| "prompt_driven" \| "fixed_template"/);
  for (const label of ["按资料建模", "描述模型", "标准模板"]) {
    assert.match(studio, new RegExp(label));
  }
  assert.match(studio, /chooseCadTutorialExample/);
  assert.match(studio, /使用四孔安装板教学示例/);
  assert.match(studio, /tutorialExample: cadTutorialExample/);
  assert.doesNotMatch(studio, /normalizedParameters\.tutorialExample/);
  assert.doesNotMatch(studio, /留空会生成明确标注/);
  assert.doesNotMatch(studio, /无目标则给出明确标注的教学示例/);
});

test("CAD 生成先调用不扣分预检，拒绝时保留弹窗并内联告知", () => {
  const studio = read("components/Studio.tsx");
  const preflight = studio.indexOf("/cad/preflight");
  const admission = studio.indexOf('await onConfirm("cad"', preflight);
  assert.ok(preflight >= 0 && admission > preflight, "必须在请求入队前完成 CAD 预检");
  for (const field of ["mode", "sourceIds", "instruction", "templateId", "parameters", "allowAssumptions"]) {
    assert.match(studio.slice(preflight, admission), new RegExp(`${field}:`));
  }
  assert.match(studio, /response\.status === 404 \|\| response\.status === 405/);
  assert.match(studio, /为避免误扣积分，本次未创建任务/);
  assert.match(studio, /role="alert" aria-live="assertive"/);
  assert.match(studio, /if \(!planHash \|\| !hasPlan\)/);
  assert.match(studio, /if \(!admission \|\| admission\.accepted !== true\)/);
  assert.match(studio, /cadPlanPreview\?\.planHash !== planHash/);
  assert.match(studio, /尚未扣积分/);
  assert.match(studio, /已冻结约束/);
  assert.match(studio, /确认并生成/);
  assert.match(studio, /crypto\?\.randomUUID/);
  assert.match(studio, /cadIdempotencyKey/);
  assert.match(studio, /onClose\(\);[\s\S]{0,120}catch/);
});

test("只有按资料建模要求来源，描述和标准模板允许零来源", () => {
  const studio = read("components/Studio.tsx");
  const home = read("components/HomeClient.tsx");
  assert.match(studio, /cadMode === "source_driven" && \(!hasSources \|\| selectedSourceIds\.length === 0\)/);
  assert.match(studio, /isCad \? cadMode === "source_driven" && !hasSources : !hasSources/);
  assert.match(studio, /!hasSources && a\.kind !== "cad" && !hasChat && !hasNotes/);
  assert.match(home, /const cadNeedsSources = kind === "cad" && \(opts\?\.cadMode \?\? "source_driven"\) === "source_driven"/);
  assert.match(home, /按描述生成 · 不使用来源/);
  assert.match(home, /标准模板 · 不使用来源/);
  assert.match(studio, /只使用本次描述，不使用来源/);
  assert.match(studio, /sourceIds: cadMode === "source_driven" \? \[\.\.\.selectedSourceIds\] : \[\]/);
  assert.match(studio, /cadTargetObjectId/);
  assert.match(studio, /本次生成\{CAD_OBJECT_LABELS\[objectId\]/);
  assert.match(home, /targetObjectId: opts\?\.cadTargetObjectId/);
  assert.doesNotMatch(studio, /name="cad-fixed-instruction"/);
});

test("CAD 草稿按笔记本和模式保存，只在成功入队后清理", () => {
  const studio = read("components/Studio.tsx");
  assert.match(studio, /apebook:cad-draft:\$\{notebookId\}:\$\{mode\}/);
  assert.match(studio, /window\.localStorage\.setItem\(cadDraftStorageKey\(notebookId, cadMode\)/);
  const accepted = studio.indexOf("admission.accepted !== true");
  const removeDraft = studio.indexOf("window.localStorage.removeItem(cadDraftStorageKey", accepted);
  const close = studio.indexOf("onClose();", removeDraft);
  assert.ok(accepted >= 0 && removeDraft > accepted && close > removeDraft);
});

test("主页面只在 /studio 返回 202 + jobId 后进入排队并通知弹窗关闭", () => {
  const home = read("components/HomeClient.tsx");
  const request = home.indexOf("/studio`, {");
  const statusGate = home.indexOf("res.status !== 202", request);
  const jobId = home.indexOf("const jobId", statusGate);
  const queued = home.indexOf('status: "queued"', jobId);
  const accepted = home.indexOf("settleAdmission({ accepted: true })", queued);
  assert.ok(request >= 0 && statusGate > request && jobId > statusGate && queued > jobId && accepted > queued);
  assert.doesNotMatch(home.slice(Math.max(0, request - 1_200), request), /status: "queued"/);
  assert.match(home, /cadPreflightPlanHash: opts\?\.cadPreflightPlanHash/);
  assert.match(home, /cadIdempotencyKey: opts\?\.cadIdempotencyKey/);
  assert.match(home, /return new Promise<\{ accepted: boolean; error\?: string \}>/);
});
