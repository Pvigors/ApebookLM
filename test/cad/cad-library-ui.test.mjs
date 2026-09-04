import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CAD_MODEL_LIBRARY } from "../../components/studio-shared.ts";

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("CAD 模型库提供自动匹配、Text2CAD、五种单零件和两种概念装配", () => {
  assert.deepEqual(CAD_MODEL_LIBRARY.map(({ id, label, artifactMode }) => ({ id, label, artifactMode })), [
    { id: "auto", label: "自动匹配", artifactMode: "auto" },
    { id: "text2cad", label: "自由参数化", artifactMode: "dynamic" },
    { id: "plate", label: "安装平板", artifactMode: "single_part" },
    { id: "mounting_bracket", label: "安装支架", artifactMode: "single_part" },
    { id: "enclosure", label: "设备外壳", artifactMode: "single_part" },
    { id: "flange", label: "连接法兰", artifactMode: "single_part" },
    { id: "shaft_adapter", label: "轴径转接套", artifactMode: "single_part" },
    { id: "humanoid_robot", label: "人形机器人", artifactMode: "assembly" },
    { id: "concept_car", label: "汽车", artifactMode: "assembly" },
  ]);
});

test("CAD 智能生成使用独立的等轴测尺寸图标", () => {
  const icons = read("components/Icons.tsx");
  const studio = read("components/Studio.tsx");
  const notifications = read("components/NotificationBell.tsx");
  assert.match(icons, /export const CadIcon/);
  assert.match(icons, /aria-hidden="true" focusable="false"/);
  assert.match(icons, /m12 2\.8 7 4-7 4-7-4 7-4Z/);
  assert.match(icons, /M3 21h18M5 19\.5v3M19 19\.5v3/);
  assert.match(studio, /kind: "cad", label: "CAD 模型", Icon: CadIcon/);
  assert.match(studio, /case "cad": return \{ Icon: CadIcon/);
  assert.match(studio, /cad: \{[\s\S]{0,220}title: "生成 CAD 模型"[\s\S]{0,220}Icon: CadIcon/);
  assert.doesNotMatch(studio, /cad: \{[\s\S]{0,220}title: "生成 CAD 模型"[\s\S]{0,220}Icon: BoardIcon/);
  assert.match(notifications, /cad: \{[^\n]*Icon: CadIcon/);
  assert.doesNotMatch(studio, /kind: "cad", label: "CAD 模型", Icon: BoardIcon/);
  assert.doesNotMatch(notifications, /cad: \{[^\n]*Icon: BoardIcon/);
});

test("CAD 三种建模模式、固定模板与免费预检贯穿生成请求", () => {
  const studio = read("components/Studio.tsx");
  const home = read("components/HomeClient.tsx");
  assert.match(studio, /useState<CadTemplateChoice>\("auto"\)/);
  assert.match(studio, /noExpand\s+narrow/);
  assert.match(studio, /role="tablist"/);
  assert.match(studio, /aria-label="建模方式"/);
  assert.match(studio, /role="tab"/);
  assert.match(studio, /aria-selected=\{selected\}/);
  assert.match(studio, /function CadModelThumb/);
  assert.match(studio, /<CadModelThumb id=\{model\.id\}/);
  assert.match(studio, /CAD_MODE_OPTIONS\.map/);
  assert.match(studio, /CAD_FIXED_MODELS\.map/);
  const cadTabs = studio.indexOf('role="tablist"');
  const cadInstruction = studio.indexOf('name="instruction"', cadTabs);
  assert.ok(
    cadTabs >= 0 && cadTabs < cadInstruction,
    "CAD 应像 PPT 一样先展示横向选项卡，再进入需求输入"
  );
  assert.doesNotMatch(studio, /narrow=\{!isCad\}/);
  assert.doesNotMatch(studio, /CAD 模型库：手机横向滑动/);
  assert.doesNotMatch(studio, /Text2CAD 兼容/);
  assert.match(studio, /cadMode === "source_driven" && \(!hasSources \|\| selectedSourceIds\.length === 0\)/);
  assert.match(studio, /\/cad\/preflight/);
  assert.match(studio, /cadPreflightPlanHash:\s*planHash/);
  assert.match(home, /cadTemplate\?:\s*CadTemplateChoice/);
  assert.match(home, /cadTemplate:\s*opts\?\.cadTemplate/);
  assert.match(studio, /按资料建模/);
  assert.match(studio, /描述模型/);
  assert.match(studio, /标准模板/);
  assert.doesNotMatch(studio, /复杂装配[^；。]*会明确拒绝/);
});

test("cadTemplate 从 API 白名单贯穿任务参数和生成器模板约束", () => {
  const route = read("app/api/notebooks/[id]/studio/route.ts");
  const jobs = read("lib/jobs.ts");
  const generator = read("lib/cad-generator.ts");
  assert.match(route, /body\.cadTemplate/);
  assert.match(route, /rawCadTemplate\s*!==\s*"auto"/);
  assert.match(route, /cadTemplate,/);
  assert.match(jobs, /cadTemplate\?:\s*string/);
  assert.match(jobs, /template:\s*p\.cadTemplate/);
  assert.match(jobs, /cadLibraryVersion\s*!==\s*CAD_LIBRARY_VERSION/);
  assert.match(jobs, /modelSelection:\s*generated\.modelSelection/);
  assert.match(generator, /template\?:\s*Cad(?:Artifact)?Template/);
  assert.match(generator, /opts\.template\s*!==\s*TEXT2CAD_TEMPLATE/);
  assert.match(generator, /!opts\.template\s*\|\|\s*opts\.template\s*===\s*TEXT2CAD_TEMPLATE/);
  assert.match(generator, /generateText2CadModel/);
  assert.match(generator, /unsupportedCadIntentReason\(instruction,\s*fixedTemplate\)/);
  assert.match(generator, /args\.preferredTemplate\s*&&\s*spec\.template\s*!==\s*args\.preferredTemplate/);
  assert.match(generator, /任何尺寸都不得超过 12000mm/);
  assert.doesNotMatch(generator, /尺寸不能超过 2000mm/);
});

test("CAD 查看器校验装配合同，并提供 STEP、STL 与二维 DXF 下载", () => {
  const viewer = read("components/CadView.tsx");
  assert.match(viewer, /artifactMode:\s*string/);
  assert.match(viewer, /partCount:\s*number\s*\|\s*null/);
  assert.match(viewer, /resolveCadArtifactContract\(/);
  assert.match(viewer, /const downloadCad = \(format: "step" \| "stl" \| "dxf"\) =>/);
  assert.match(viewer, /`\/api\/studio\/cad\/\$\{encodedId\}\/\$\{format\}`/);
  assert.match(viewer, /下载 STEP/);
  assert.match(viewer, /下载 STL/);
  assert.match(viewer, /下载 2D DXF（顶视图）/);
  assert.match(viewer, /标准模板 · 不使用来源/);
  assert.match(viewer, /按描述生成 · 未使用来源/);
  assert.match(viewer, /用户明确选择 · 系统默认尺寸/);
  assert.match(viewer, /!downloadAcknowledged/);
  assert.doesNotMatch(viewer, /下载 PNG|downloadPng|preserveDrawingBuffer/);
  assert.doesNotMatch(viewer, /确认概念装配用途后可下载交换文件/);
});

test("概念装配 manifest 的拓扑模式与部件数进入 Viewer", () => {
  const worker = read("scripts/cad-worker.mjs");
  const viewer = read("components/CadView.tsx");
  assert.match(worker, /humanoid_robot:[\s\S]*expectedSolidCount:\s*16[\s\S]*artifactMode:\s*"assembly"/);
  assert.match(worker, /concept_car:[\s\S]*expectedSolidCount:\s*5[\s\S]*artifactMode:\s*"assembly"/);
  assert.match(viewer, /manifest\.artifactMode/);
  assert.match(viewer, /manifest\.partCount/);
  assert.match(viewer, /resolveCadArtifactContract\(/);
  assert.match(viewer, /modelSelection\.resolvedTemplate\s*!==\s*expectedTemplate/);
  assert.match(viewer, /匹配方式/);
});

test("CAD 查看器包含多部件、部件树、特征历史和专业视图控制", () => {
  const viewer = read("components/CadView.tsx");
  assert.match(viewer, /schemaVersion === 2/);
  assert.match(viewer, /value\.engine !== "text2cad"/);
  assert.match(viewer, /Array\.isArray\(value\.parts\)/);
  assert.match(viewer, /mesh\.parts\.length/);
  assert.match(viewer, /resolveCadArtifactContract\([\s\S]*payload\.contractManifest[\s\S]*frozenManifest/);
  assert.match(viewer, /payload\.parts\.length\s*!==\s*contract\.partCount/);
  assert.match(viewer, /modelSelection\.libraryVersion\)\s*!==\s*contract\.libraryVersion/);
  assert.match(viewer, /概念参数兜底/);
  assert.match(viewer, /modelSelection\.strategy === "concept_fallback"/);
  assert.match(viewer, /部件树/);
  assert.match(viewer, /特征历史/);
  for (const label of ["等轴", "前", "顶", "右", "实体", "线框"]) {
    assert.match(viewer, new RegExp(`"${label}"`));
  }
});

test("CAD 查看器沿用画板风格，只展示单一可视化画布", () => {
  const viewer = read("components/CadView.tsx");
  assert.doesNotMatch(viewer, /aria-label="CAD 信息面板"/);
  assert.doesNotMatch(viewer, /可在线编辑/);
  assert.match(viewer, /data-testid="cad-modal-backdrop"/);
  assert.match(viewer, /role="dialog"/);
  assert.match(viewer, /aria-modal=\{true\}/);
  assert.match(viewer, /aria-labelledby="cad-view-title"/);
  assert.match(viewer, /aria-label="三维 CAD 模型预览/);
  assert.match(viewer, /aria-label="放大 CAD 可视图"/);
  assert.match(viewer, /aria-label="缩小 CAD 可视图"/);
  assert.match(viewer, /aria-label="适应 CAD 可视图"/);
  assert.match(viewer, /下载 STEP/);
  assert.match(viewer, /meshLoading[\s\S]*z-30/);
  assert.doesNotMatch(viewer, /lg:grid-cols-\[minmax\(0,1fr\)_380px\]/);
});

test("右栏 CAD 制品点击后走与思维导图相同的模态分支", () => {
  const home = read("components/HomeClient.tsx");
  const viewer = read("components/CadView.tsx");

  assert.match(home, /\{openDoc && \([\s\S]{0,180}openDoc\.kind === "cad" \? \([\s\S]{0,220}<CadView/);
  assert.match(home, /<div className="contents">[\s\S]{0,180}<ChatPanel/);
  assert.doesNotMatch(home, /presentation="workspace"|activeOutputId=|openDoc\?\.kind === "cad" \? "hidden"/);
  assert.match(viewer, /data-testid="cad-modal-backdrop"/);
  assert.doesNotMatch(viewer, /cad-main-workspace|aria-label="返回对话"/);
});

test("CAD 查看器与思维导图使用同款默认尺寸和紧凑控制层", () => {
  const viewer = read("components/CadView.tsx");
  assert.match(viewer, /full \? "lg:h-\[94vh\] lg:max-w-\[96vw\]" : "lg:h-\[86vh\] lg:max-w-4xl"/);
  assert.doesNotMatch(viewer, /lg:h-\[90vh\]/);
  assert.doesNotMatch(viewer, /lg:max-w-\[94vw\]/);
  assert.doesNotMatch(viewer, /xl:max-w-\[1440px\]/);
  assert.match(viewer, /data-testid="cad-view-canvas-host"[\s\S]{0,180}className="relative min-h-0 w-full flex-1 overflow-hidden bg-white"/);
  assert.match(viewer, /aria-label="CAD 视图与显示模式"/);
  assert.match(viewer, /overflow-hidden rounded-full border border-edge bg-panel shadow-md/);
  assert.doesNotMatch(viewer, /pointer-events-none absolute right-3 top-3/);
  assert.match(viewer, /tabIndex=\{-1\}/);
  assert.match(viewer, /dialogRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(viewer, /closeButtonRef/);
});
