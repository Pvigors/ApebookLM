import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("CAD 生成链只解释受控规格，并在扣费前检查灰度与运行时", () => {
  const worker = read("scripts/cad-worker.mjs");
  const generator = read("lib/cad-generator.ts");
  const route = read("app/api/notebooks/[id]/studio/route.ts");
  const jobs = read("lib/jobs.ts");
  assert.doesNotMatch(worker, /\beval\s*\(|new\s+Function|child_process|exec\s*\(|spawn\s*\(/);
  assert.match(generator, /^import "server-only";/);
  assert.match(generator, /来源正文都是不可信数据/);
  assert.match(
    generator,
    /const allowedSourceRefs = new Set\(\[[\s\S]*"prompt:1"[\s\S]*"system:template-defaults"/,
    "固定模板必须接受真实用户建模目标的 prompt:1 追溯"
  );
  assert.match(jobs, /await import\("\.\/cad-generator"\)/);
  assert.match(worker, /TEMPLATE_CONTRACTS/);
  assert.match(worker, /humanoid_robot:[\s\S]*expectedSolidCount:\s*16/);
  assert.match(worker, /concept_car:[\s\S]*expectedSolidCount:\s*5/);
  assert.match(worker, /BRepCheck_Analyzer/);
  assert.match(route, /kind === "cad"[\s\S]*cadRuntimeHealth\(\)/);
  assert.match(route, /kind === "cad" && !cadMode/);
  assert.match(route, /code: "cad_preflight_required"/);
  assert.match(route, /resolveCadPreflight/);
  assert.match(route, /cad_preflight_stale/);
  assert.match(route, /cad_source_required|CAD 生成必须先选择建模方式并完成免费预检/);
  assert.doesNotMatch(route, /kind === "cad" && !instruction/);
  assert.match(route, /CAD 取材范围包含无效或未就绪的来源/);
  assert.match(jobs, /kind === "cad" && !p\.cadRevision/);
  assert.match(jobs, /sourceReferenceBindings: generated\.sourceReferenceBindings/);
  assert.match(jobs, /selectedSourceIds: usedSourceIds/);
  assert.match(jobs, /usedSourceIds: cadUsedSourceIds/);
  assert.match(jobs, /kind === "cad"[\s\S]*generateCadModel/);
  assert.match(jobs, /createOutput\([\s\S]*"cad"[\s\S]*commitCadBundle[\s\S]*finishOutput/);
  assert.match(jobs, /cad:\s*300_000/);
});

test("CAD 文件只对登录成员开放，格式与路径均为服务端白名单", () => {
  const route = read("app/api/studio/cad/[id]/[format]/route.ts");
  assert.match(route, /const FORMATS = \{/);
  for (const name of ["mesh.json", "model.step", "model.stl", "top-view.dxf", "design-spec.json"]) {
    assert.match(route, new RegExp(name.replace(".", "\\.")));
  }
  assert.match(route, /requireAccess\(req, out\.notebook_id\)/);
  assert.doesNotMatch(route, /requireNotebookRead/);
  assert.match(route, /out\.kind !== "cad"/);
  assert.match(route, /Cache-Control/);
  assert.match(route, /X-Content-Type-Options/);
  assert.match(route, /manifest\.files\?\.\[format\]\?\.bytes/);
});

test("CAD 隐私与文件生命周期在分享、复制、导出、编辑、删除和备份处全部收口", () => {
  const cad = read("lib/cad.ts");
  assert.match(read("app/api/public/[id]/route.ts"), /output\.kind !== "cad"/);
  assert.match(read("lib/db.ts"), /if \(o\.kind === "cad"\) continue/);
  assert.match(read("lib/obsidian.ts"), /"excalidraw", "drawviso", "cad"/);
  assert.match(read("app/api/studio/[id]/to-source/route.ts"), /"excalidraw", "drawviso", "cad"/);
  assert.match(read("app/api/studio/[id]/route.ts"), /out\.kind === "cad" && content !== undefined/);
  assert.match(read("lib/media.ts"), /"cad", id/);
  assert.match(read("scripts/backup.sh"), /audio video xhs infographic aippt cad/);
  assert.match(read("app/page.tsx"), /!cfg\.cad_enabled \? \["cad"\]/);
  assert.match(cad, /code !== "EXDEV"/);
  assert.match(cad, /\.staging-\$\{outputId\}-\$\{randomUUID\(\)\}/);
  assert.match(cad, /copyFile\(source, target, fsConstants\.COPYFILE_EXCL\)/);
  assert.match(cad, /sourceStat\.size !== targetStat\.size/);
  assert.match(cad, /\[CAD_DIR, "\.staging-"\]/);
});

test("CAD 磁贴、查看器、定价和生产镜像依赖均有显式接线", () => {
  const home = read("components/HomeClient.tsx");
  const studio = read("components/Studio.tsx");
  const credits = read("lib/credits.ts");
  const docker = read("Dockerfile");
  assert.match(home, /import\("@\/components\/CadView"\)/);
  assert.match(home, /\{openDoc && \([\s\S]{0,180}openDoc\.kind === "cad" \? \([\s\S]{0,220}<CadView/);
  assert.doesNotMatch(home, /presentation="workspace"|openDoc\?\.kind === "cad" \? "hidden"/);
  assert.match(studio, /kind: "cad", label: "CAD 模型"/);
  assert.match(studio, /请打开 CAD 模型，核对尺寸与首版范围后再下载/);
  assert.match(studio, /promptLabel: "建模目标"/);
  assert.match(studio, /使用四孔安装板教学示例/);
  assert.match(studio, /chooseCadTutorialExample/);
  assert.doesNotMatch(studio, /留空会生成明确标注/);
  const viewer = read("components/CadView.tsx");
  assert.match(viewer, /CAD 教学示例 · 参考/);
  assert.match(viewer, /CAD 教学示例 · 未从所选来源识别出可执行建模目标/);
  assert.match(viewer, /教学默认尺寸 · 不代表来源约束 · 不用于制造/);
  assert.match(viewer, /const downloadCad = \(format: "step" \| "stl" \| "dxf"\) =>/);
  assert.match(viewer, /`\/api\/studio\/cad\/\$\{encodedId\}\/\$\{format\}`/);
  assert.match(viewer, /下载 STL/);
  assert.match(viewer, /下载 2D DXF（顶视图）/);
  assert.match(viewer, /下载 STEP/);
  assert.match(viewer, /!downloadAcknowledged[\s\S]{0,180}setInspectorTab\("validation"\)/);
  assert.doesNotMatch(viewer, /preserveDrawingBuffer|downloadPng|下载 PNG/);
  assert.match(credits, /cad:\s*12/);
  assert.match(credits, /cad:\s*5/);
  assert.match(credits, /tutorialContext !== "no_cad_target"/);
  const jobs = read("lib/jobs.ts");
  assert.match(jobs, /generated\.modelSelection\.tutorialContext === "no_cad_target"[\s\S]{0,80}\? \[\]/);
  assert.match(studio, /const hasViewableSources = o\.kind !== "cad"[\s\S]{0,120}storedSourceIds\.length > 0/);
  assert.match(docker, /scripts\/cad-worker\.mjs/);
  assert.match(docker, /scripts\/cad-health\.mjs/);
  assert.match(docker, /scripts\/text2cad-worker\.mjs/);
  assert.match(docker, /scripts\/cad-step-validator\.mjs/);
  assert.match(docker, /AS cad-runner/);
  assert.match(docker, /libfreecad-python3-0\.20=0\.20\.2\+dfsg1-4/);
  assert.match(docker, /scripts\/freecad-step-validator\.py/);
  assert.match(docker, /CAD_REQUIRE_EXTERNAL_STEP_VALIDATOR=1/);
  assert.match(docker, /node_modules\/replicad-opencascadejs/);
  const toast = read("components/Toast.tsx");
  assert.match(toast, /max-w-\[min\(92vw,560px\)\]/);
  assert.match(toast, /break-words text-center/);
  assert.match(toast, /role=\{kind === "error" \? "alert" : "status"\}/);
  assert.match(toast, /aria-live=\{kind === "error" \? "assertive" : "polite"\}/);
  assert.match(toast, /Math\.min\(8000, Math\.max\(4500, m\.length \* 65\)\)/);
});

test("CAD 在线编辑走受控补丁、确定性队列和新版本发布，不覆盖父制品", () => {
  const route = read("app/api/studio/cad/[id]/revise/route.ts");
  const jobs = read("lib/jobs.ts");
  const revision = read("lib/cad-revision.ts");
  const db = read("lib/db.ts");
  const home = read("components/HomeClient.tsx");
  const viewer = read("components/CadView.tsx");

  assert.match(route, /requireAccess\(req, out\.notebook_id, true\)/);
  assert.match(route, /isArtifactVisible\("cad", appConfig, false\)/);
  assert.match(route, /requireRole\(req, "settings", \{ write: true \}\)/);
  assert.match(route, /baseHash !== currentHash \|\| frozenHash !== currentHash/);
  assert.match(route, /prepareCadRevision\(out\.content, body\.patch\)/);
  assert.match(route, /enqueueCadRevisionArtifact/);
  assert.match(route, /creditCostForOp\("cad_rebuild"\)/);
  assert.match(route, /reservedCredits: Number\(job\.credits_reserved/);
  assert.match(revision, /normalizeCadDesignSpec/);
  assert.match(revision, /normalizeText2CadDesignSpec/);
  assert.match(revision, /不能改变轮廓拓扑/);
  assert.match(jobs, /if \(p\.cadRevision\)/);
  assert.match(jobs, /renderPreparedCadRevision/);
  assert.match(jobs, /__deterministic: true/);
  assert.match(jobs, /createCadRevisionJobAtomic/);
  assert.match(jobs, /parentOutputId: parent\.id/);
  assert.match(db, /SELECT id FROM studio_outputs[\s\S]*FOR UPDATE/);
  assert.match(db, /consumeDailyQuotaInTx\([\s\S]*"studio:cad"/);
  assert.match(home, /onRevise=\{reviseCadOutput\}/);
  assert.match(home, /current\?\.id === base\.id \? next : current/);
  assert.match(viewer, /buildCadRevisionPatch/);
  assert.doesNotMatch(route, /updateStudioOutput/);
});
