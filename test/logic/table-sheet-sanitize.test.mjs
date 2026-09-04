import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeSpreadsheetCellText,
  sanitizeSpreadsheetEditorInput,
  spreadsheetPatchFitsKeepalive,
} from "../../lib/spreadsheet-cell.ts";
import fs from "node:fs";

test("电子表格保留业务字符，只移除 C0 控制字符", () => {
  const input = "<img src=x onerror=\"alert('x')\"> & `payload`\u0000";
  const output = sanitizeSpreadsheetCellText(input);
  assert.equal(output, "<img src=x onerror=\"alert('x')\"> & `payload`");
  assert.equal(sanitizeSpreadsheetCellText("AT&T | x < 5 | ?x=1&y=2"), "AT&T | x < 5 | ?x=1&y=2");
});

test("超过 60KiB 的表格 PATCH 不使用 keepalive，小稿允许页面离开后继续", () => {
  assert.equal(spreadsheetPatchFitsKeepalive("小表格"), true);
  assert.equal(spreadsheetPatchFitsKeepalive("甲".repeat(70 * 1024)), false);
});

test("表格尾部纯空格和清空结果不会被 trim/fallback 静默改回旧数据", () => {
  const table = fs.readFileSync(new URL("../../components/TableSheet.tsx", import.meta.url), "utf8");
  assert.match(table, /every\(\(c\) => c === ""\)/);
  assert.match(table, /c !== "" && \(lastCol = Math\.max/);
  assert.doesNotMatch(table, /sheetsToMarkdown\(s\.getData\(\)\) \|\| savedRef\.current/);
  assert.doesNotMatch(table, /return md \|\| output\.content/);
  assert.match(table, /saveQueue\.current = saveQueue\.current/);
  assert.match(table, /\.catch\(\(\) => \{\}\)[\s\S]*\.then\(async \(\) =>/);
  assert.match(table, /spreadsheetPatchFitsKeepalive\(md\)/);
  assert.match(table, /keepalive: canKeepalive/);
  assert.match(table, /addEventListener\("beforeunload", warnUnsaved\)/);
  const home = fs.readFileSync(new URL("../../components/HomeClient.tsx", import.meta.url), "utf8");
  assert.match(home, /d\?\.id === openDoc\.id \? \{ \.\.\.d, content \} : d/);
  assert.doesNotMatch(home, /setOpenDoc\(\(d\) => \(d \? \{ \.\.\.d, content \} : d\)\)/);
});

test("实时编辑捕获守卫在第三方 input 监听器前原地清洗并保持光标", () => {
  let range = [];
  const target = {
    value: "正常\u0000文本",
    selectionStart: 8,
    selectionEnd: 12,
    setSelectionRange(start, end) { range = [start, end]; },
  };
  assert.equal(sanitizeSpreadsheetEditorInput(target), true);
  assert.equal(target.value, "正常文本");
  assert.deepEqual(range, [4, 4]);
  assert.equal(sanitizeSpreadsheetEditorInput(target), false);
});
