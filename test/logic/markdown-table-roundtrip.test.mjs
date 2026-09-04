import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeMarkdownTableName,
  escapeMarkdownTableCell,
  parseMarkdownTables,
} from "../../lib/markdown-table.ts";

test("Markdown 表格单元格的管道、反斜杠、反引号与引用文本可无损重开", () => {
  const cells = [
    "AT&T | x < 5",
    "`payload` [1] **原文**",
    String.raw`C:\设计\模型 | v2`,
    "  第一行\n第二行  ",
  ];
  const markdown = [
    encodeMarkdownTableName("Q1 | Q2\n**业务数据**"),
    "",
    `| ${cells.map(escapeMarkdownTableCell).join(" | ")} |`,
    `| ${cells.map(() => "---").join(" | ")} |`,
    `| ${cells.map(escapeMarkdownTableCell).join(" | ")} |`,
  ].join("\n");
  const tables = parseMarkdownTables(markdown);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].name, "Q1 | Q2\n**业务数据**");
  assert.deepEqual(tables[0].rows, [cells, cells]);
});

test("只有表头后的第二行是 separator，值为 --- 的数据行不会丢失", () => {
  const markdown = [
    encodeMarkdownTableName("分隔符业务值"),
    "| A | B |",
    "| --- | --- |",
    "| --- | :---: |",
  ].join("\n");
  assert.deepEqual(parseMarkdownTables(markdown)[0].rows, [
    ["A", "B"],
    ["---", ":---:"],
  ]);
});
