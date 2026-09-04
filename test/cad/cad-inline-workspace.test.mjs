import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

test("CAD 从右栏进入与其它制品相同的统一模态链", () => {
  const home = read("components/HomeClient.tsx");
  const modal = home.indexOf("{openDoc && (");
  const cad = home.indexOf('openDoc.kind === "cad" ? (', modal);
  const mindmap = home.indexOf('openDoc.kind === "mindmap" ? (', cad);

  assert.ok(modal >= 0 && cad > modal && mindmap > cad, "CAD 应位于统一模态链首分支");
  assert.match(home, /<CadView[\s\S]{0,220}onClose=\{\(\) => setOpenDoc\(null\)\}/);
  assert.doesNotMatch(home, /openDoc\?\.kind === "cad" && \(/);
  assert.doesNotMatch(home, /openDoc\?\.kind === "cad" \? "hidden"/);
  assert.doesNotMatch(home, /presentation="workspace"/);
  assert.match(home, /artifactId=\{openDoc && openDoc\.kind !== "cad" \? openDoc\.id : undefined\}/);
});

test("CAD 手动打开和生成完成只打开模态，不强制切换移动端 tab", () => {
  const home = read("components/HomeClient.tsx");

  assert.match(home, /setOpenDoc\(o\)/);
  assert.match(home, /setOpenDoc\(out\)/);
  assert.doesNotMatch(home, /if \(o\.kind === "cad"\) setMobileTab\("chat"\)/);
  assert.doesNotMatch(home, /if \(out\.kind === "cad"\) setMobileTab\("chat"\)/);
  assert.doesNotMatch(home, /mobileTab !== "chat" && openDoc\?\.kind === "cad"/);
  assert.match(home, /if \(o\.kind === "audio"\) \{[\s\S]{0,120}setOpenDoc\(null\)/);
  assert.match(home, /else if \(o\.kind === "quiz"\) \{[\s\S]{0,180}setOpenDoc\(null\)/);
  assert.match(home, /useEffect\(\(\) => \{[\s\S]{0,260}clearNotebookOverlays\(\);[\s\S]{0,100}\}, \[notebook\?\.id, clearNotebookOverlays\]\)/);
  assert.match(home, /const clearNotebookOverlays = useCallback\([\s\S]{0,260}setOpenDoc\(null\)/);
});

test("CAD 只保留真模态语义、焦点环和背景关闭", () => {
  const home = read("components/HomeClient.tsx");
  const viewer = read("components/CadView.tsx");
  const boundary = read("components/ViewerErrorBoundary.tsx");

  assert.match(home, /<ViewerErrorBoundary resetKey=\{openDoc\.id\}[\s\S]{0,180}openDoc\.kind === "cad"/);
  assert.match(viewer, /data-testid="cad-modal-backdrop"/);
  assert.match(viewer, /role="dialog"/);
  assert.match(viewer, /aria-modal=\{true\}/);
  assert.doesNotMatch(viewer, /presentation\?:|cad-main-workspace|\bworkspace\b/);
  assert.match(viewer, /dialogRef\.current\?\.focus/);
  assert.match(viewer, /event\.key === "Escape"[\s\S]{0,100}onClose\(\)/);
  assert.match(viewer, /event\.key !== "Tab"/);

  assert.match(boundary, /presentation\?:\s*"dialog"\s*\|\s*"workspace"/);
  assert.match(boundary, /role="alert"/);
  assert.match(boundary, /: "fixed inset-0 z-\[60\]/);
});

test("右栏 CAD 不使用主窗口选中态", () => {
  const home = read("components/HomeClient.tsx");
  assert.doesNotMatch(home, /activeOutputId=/);
});

test("CAD 模态不隐藏或暂停对话，关闭后草稿仍在", () => {
  const home = read("components/HomeClient.tsx");

  assert.match(home, /<div className="contents">[\s\S]{0,180}<ChatPanel/);
  assert.match(home, /suspended=\{false\}/);
  assert.doesNotMatch(home, /openDoc\?\.kind === "cad" \? "hidden"/);
  assert.match(home, /const suspendedRef = useRef\(suspended\)/);
  assert.match(home, /setInput\(""\);[\s\S]{0,80}setSlashIdx\(0\);[\s\S]{0,80}\}, \[notebook\?\.id\]\)/);
});

test("切本原子收口浮层和对话流，旧本 token 不得写入新本", () => {
  const home = read("components/HomeClient.tsx");

  for (const setter of [
    "setAddOpen(false)",
    "setImportReport(null)",
    "setGenConfig(null)",
    "setShareOpen(false)",
    "setSettingsOpen(false)",
    "setConfirmClearChat(false)",
    "setPendingDel(null)",
    "setSkillPickerOpen(false)",
  ]) {
    assert.match(home, new RegExp(setter.replace(/[()]/g, "\\$&")));
  }
  assert.match(home, /streamAbortRef\.current\?\.abort\(\);[\s\S]{0,160}streamSeqRef\.current \+= 1;[\s\S]{0,120}clearNotebookOverlays\(\)/);
  assert.match(home, /const streamNotebookId = notebook\.id/);
  assert.match(home, /const isCurrentStream = \(\) =>[\s\S]{0,120}notebookIdRef\.current === streamNotebookId && streamSeqRef\.current === seq/);
  assert.match(home, /const patch = \(fn:[\s\S]{0,120}if \(!isCurrentStream\(\)\) return/);
  assert.match(home, /onFollowups:[\s\S]{0,120}if \(!isCurrentStream\(\)\) return/);
  assert.match(home, /setNotes\(\[\]\);[\s\S]{0,100}setOutputs\(\[\]\);[\s\S]{0,100}setGenerating\(\{\}\)/);
  const nullClear = home.indexOf("setStudioLoading(true);", home.indexOf("const notebookId = notebook?.id"));
  const nullReturn = home.indexOf("if (!notebookId) return;", nullClear);
  assert.ok(nullClear >= 0 && nullReturn > nullClear, "notebook=null 加载窗口必须先清旧本状态再返回");
  assert.match(home, /<StudioPanel[\s\S]{0,360}loading=\{loading \|\| studioLoading\}/);
  assert.match(home, /await new Promise\(\(r\) => setTimeout\(r, 1200\)\);[\s\S]{0,220}if \(notebookIdRef\.current !== nbId\) break/);
  assert.match(home, /genInflight\.current\.delete\(kind\);[\s\S]{0,100}if \(notebookIdRef\.current === nbId\) clearGenKind\(kind\)/);

  const clearEffect = home.indexOf("clearNotebookOverlays();");
  const autoAddEffect = home.indexOf("if (autoAddForId && notebook && notebook.id === autoAddForId)");
  assert.ok(clearEffect >= 0 && autoAddEffect > clearEffect, "新本自动添加来源必须在旧本收口之后弹出");
});
