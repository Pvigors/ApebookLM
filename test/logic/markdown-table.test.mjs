import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ResponsiveMarkdownTable from "../../components/ResponsiveMarkdownTable.tsx";

const ROOT = new URL("../../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, ROOT), "utf8");
const Markdown = ReactMarkdown.default ?? ReactMarkdown;
const gfm = remarkGfm.default ?? remarkGfm;
const ResponsiveTable = ResponsiveMarkdownTable.default ?? ResponsiveMarkdownTable;

test("GFM 多列表格渲染为可聚焦的独立横向滚动区域", () => {
  const markdown = [
    "| 对比维度 | 来源一 | 来源二 | 来源三 | 来源四 | 来源五 | 来源六 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| 发布主体 | 全国数据标准化技术委员会 | 行业研究机构 | 高校实验室 | 企业联盟 | 国家部门 | 联合工作组 |",
  ].join("\n");
  const components = {
    table: ({ children }) => React.createElement(ResponsiveTable, null, children),
  };
  const html = renderToStaticMarkup(
    React.createElement(Markdown, { remarkPlugins: [gfm], components }, markdown)
  );

  assert.match(html, /class="markdown-table-scroll"/);
  assert.match(html, /role="region"/);
  assert.match(html, /aria-label="表格，可横向滚动查看全部列"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /<table class="markdown-table">/);
  assert.equal((html.match(/<th>/g) ?? []).length, 7);
});

test("登录态与公开对话共用同一自适应表格组件", () => {
  const home = read("components/HomeClient.tsx");
  const publicNotebook = read("components/PublicNotebook.tsx");
  for (const source of [home, publicNotebook]) {
    assert.match(source, /ResponsiveMarkdownTable/);
    assert.match(source, /return <ResponsiveMarkdownTable>\{children\}<\/ResponsiveMarkdownTable>/);
  }
});

test("表格 CSS 保证可读列宽、局部滚动、固定首列与移动端收敛", () => {
  const css = read("app/globals.css");
  assert.match(css, /\.markdown-table-scroll\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /\.markdown-table\s*\{[\s\S]*width:\s*100%[\s\S]*min-width:\s*100%/);
  assert.match(css, /\.markdown-table th,[\s\S]*\.markdown-table td\s*\{[\s\S]*min-width:\s*10rem/);
  assert.match(css, /\.markdown-table td:first-child\s*\{[\s\S]*position:\s*sticky[\s\S]*left:\s*0/);
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*min-width:\s*8\.5rem/);
});

test("多来源对比生成限制单表列数并缩短来源表头", () => {
  const prompts = read("lib/skills-prompts.ts");
  assert.match(prompts, /短标题不超过 12 个汉字/);
  assert.match(prompts, /每张表总列数不得超过 7 列/);
  assert.match(prompts, /最多 6 个来源列/);
  assert.match(prompts, /来源超过 6 个[\s\S]*拆成多张表/);
  assert.match(prompts, /各表的来源列互不重复并尽量均分/);
  assert.match(prompts, /让每个来源恰好出现于一张表/);
});
