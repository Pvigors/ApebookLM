import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DiscoveryReportMarkdown from "../../components/DiscoveryReportMarkdown.tsx";
import {
  buildDiscoveryReferences,
  discoveryReferenceIndex,
  safeDiscoveryReferenceUrl,
} from "../../lib/discovery-report.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, ROOT), "utf8");
const Report = DiscoveryReportMarkdown.default ?? DiscoveryReportMarkdown;

test("来源发现报告渲染 Markdown 标题、列表与段落", () => {
  const html = renderToStaticMarkup(
    React.createElement(Report, {
      content: "概述段落。\n\n## 核心定义\n\n- 要点一\n- 要点二",
      references: [],
    })
  );

  assert.match(html, /class="prose-chat discovery-report"/);
  assert.match(html, /<p>概述段落。<\/p>/);
  assert.match(html, /<h2>核心定义<\/h2>/);
  assert.match(html, /<ul>/);
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
  assert.doesNotMatch(html, />## 核心定义</);
});

test("报告引用按独立映射安全打开原始来源并保留无效编号", () => {
  const references = [
    { number: 1, title: "危险来源", url: "javascript:alert(1)" },
    { number: 2, title: "原始 PDF", url: "https://source.example/report.pdf" },
    // 模拟该来源未进入已重排、最多 8 条的精选 results，仍必须能从报告跳转。
    { number: 9, title: "第九个原始来源", url: "https://source.example/ninth" },
  ];
  const html = renderToStaticMarkup(
    React.createElement(Report, {
      content: "结论 [2]，复核 [2]，补充 [9]。危险 [1]，越界 [0][99]。\n\n[已有链接 [1]](https://docs.example/page)",
      references,
    })
  );

  assert.equal((html.match(/href="https:\/\/source\.example\/report\.pdf"/g) ?? []).length, 2);
  assert.match(html, /href="https:\/\/source\.example\/ninth"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /aria-label="打开来源 2：原始 PDF（新标签页）"/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /危险 \[1\]，越界 \[0\]\[99\]/);
  // 已有 Markdown 链接里的 [1] 不得再变成嵌套链接。
  assert.equal((html.match(/<a /g) ?? []).length, 4);
});

test("引用编号统一为 1-based 且危险协议不可导航", () => {
  const references = buildDiscoveryReferences([
    { title: "一", url: "https://one.example/a" },
    { title: "二", url: "https://two.example/b" },
  ]);
  assert.deepEqual(references.map((item) => item.number), [1, 2]);
  assert.equal(discoveryReferenceIndex(1, 2), 0);
  assert.equal(discoveryReferenceIndex("2", 2), 1);
  assert.equal(discoveryReferenceIndex(0, 2), null);
  assert.equal(discoveryReferenceIndex(3, 2), null);
  assert.equal(discoveryReferenceIndex("x", 2), null);
  assert.equal(safeDiscoveryReferenceUrl("javascript:alert(1)"), null);
  assert.equal(safeDiscoveryReferenceUrl("/relative"), null);
  assert.equal(safeDiscoveryReferenceUrl("https://safe.example/a"), "https://safe.example/a");
});

test("深度研究 API 透传完整引用映射且与报告编号同源", () => {
  const discover = read("lib/discover.ts");
  const route = read("app/api/discover/route.ts");
  assert.match(discover, /buildDiscoveryReferences\(bare\)/);
  assert.match(discover, /`\[\$\{i \+ 1\}\]/);
  assert.match(discover, /discoveryReferenceIndex\(v, src\.length\)/);
  assert.match(discover, /results, references/);
  assert.match(route, /"references" in discovery \? discovery\.references : \[\]/);
  assert.match(route, /summary, results, references, mode/);
});

test("放大详情只有一条正文滚动轴且不存在重复搜索触发器", () => {
  const home = read("components/HomeClient.tsx");
  const marker = home.indexOf("{/* 「查看」放大视图");
  const start = home.indexOf("createPortal(", marker);
  const end = home.indexOf("{/* 删除发现结果前确认", start);
  assert.ok(marker > 0 && start > marker && end > start);
  const detail = home.slice(start, end);
  const beforeDetail = home.slice(home.indexOf("function InlineDiscover"), start);

  assert.match(detail, /data-discovery-scroll/);
  assert.match(detail, /min-h-0 flex-1 overflow-y-auto/);
  assert.ok(detail.indexOf("data-discovery-scroll") < detail.indexOf('aria-label="本次研究主题"'));
  assert.match(detail, /DiscoveryReportMarkdown/);
  assert.match(detail, /aria-label="本次研究主题"/);
  assert.match(detail, /title=\{resultQuery\}/);
  assert.match(detail, /line-clamp-3/);
  assert.match(detail, /\{resultQuery\}/);
  assert.doesNotMatch(detail, /\{q\}/);
  assert.doesNotMatch(detail, /aria-label="搜索来源"/);
  assert.doesNotMatch(detail, /onClick=\{\(\) => search\(\)\}/);
  assert.doesNotMatch(detail, /onKeyDown[\s\S]{0,180}search\(/);
  assert.doesNotMatch(detail, /<input/);
  // 首次搜索入口仍保留在左栏，不因详情去重搜而丢失。
  assert.match(beforeDetail, /aria-label="搜索来源"/);
  assert.match(beforeDetail, /onClick=\{\(\) => search\(\)\}/);
  assert.match(beforeDetail, /setResultQuery\(typeof data\.query/);
  assert.match(beforeDetail, /onImportText\(summary, \(resultQuery \|\| "研究报告"\)/);

  const css = read("app/globals.css");
  assert.match(css, /\.discover-detail-scroll\s*\{[\s\S]*scrollbar-width:\s*thin/);
  assert.match(css, /\.cite:focus-visible/);
});
