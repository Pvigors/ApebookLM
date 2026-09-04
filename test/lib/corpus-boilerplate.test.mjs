// looksBoilerplate 垃圾闸:站点导航壳(Readability 在存根页失败退回全页时漏进的
// 框架短语)必须被识别为「无正文」,而真实正文(哪怕偶提「menu」)不误伤。
// 实锤案例:RAND external_publications(期刊存根)抓下整套站点导航当正文。
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksBoilerplate, hasSubstance } from "../../lib/corpus.ts";

test("导航壳标记 → 判垃圾(RAND external_publications 实锤形态)", () => {
  const nav = "Skip to page content Toggle Menu Site-wide navigation Topics Trending Global Security Middle East China Adolescent Health Artificial Intelligence".repeat(20);
  assert.equal(looksBoilerplate(nav), true, "含 Skip to page content / Site-wide navigation 应判垃圾");
  // 关键:密度骗不过(存根含摘要句子,密度反而偏高),但硬标记稳。
  assert.equal(hasSubstance(nav), true, "字数足够,hasSubstance 挡不住 —— 正是需要 looksBoilerplate 的原因");
});

test("SPA 反爬占位页(请开启 JavaScript)→ 判垃圾", () => {
  assert.equal(looksBoilerplate("请开启 JavaScript 后重试。"), true);
});

test("中文高校导航壳即使数百字也判垃圾，带真实正文时不误伤", () => {
  const navigation = `English 北京大学 首页 新闻动态 通知公告 学术交流 科研成果 学院概况 院长致辞
学院简介 组织结构 委员会 师资队伍 专职教师 博士后 行政教辅 荣休教师 学科建设
人才培养 研究生招生 研究生培养 继续教育 招贤纳士 学生工作 党团建设 党建动态
工会风采 校友动态 校友捐赠 办公服务 行政办公 规章制度 常用下载 办事流程
会议室预定 当前位置 首页 > 办公服务 > 常用下载 > 教育教学 地址：北京市海淀区
Copyright 版权所有 北京大学智能学院 All Rights Reserved`;
  assert.equal(hasSubstance(navigation), true, "纯导航字数足够，不能依赖长度门");
  assert.equal(looksBoilerplate(navigation), true);

  const article = `${navigation}。
本指南要求学位论文摘要明确说明研究目的、方法、结果与结论。
参考文献应按正文引用顺序核对，确保每个条目都能回溯到实际引文。`;
  assert.equal(looksBoilerplate(article), false, "导航页眉后存在真实长句正文时必须保留");

  const englishArticle = `${navigation}.
This guide requires each abstract to state the research objective, method, result, and conclusion.
References must be checked against actual in-text citations before submission.`;
  assert.equal(looksBoilerplate(englishArticle), false, "英文正文使用句点时也不能被中文导航页眉误伤");

  assert.equal(
    looksBoilerplate(`${navigation}\n摘要须说明目的、方法与结论。`),
    false,
    "导航后只有一条短而真实的规则也必须保留"
  );
  assert.equal(
    looksBoilerplate(`${navigation}\n摘要应说明研究目的。\n正文结构应保持层次清晰。\n参考文献必须与正文引文对应。`),
    false,
    "多条短规则不能因每句不足28字被误删"
  );
  for (const fact of [
    "会议定于2026年8月30日举行。",
    "招生报名截止日期为2026年9月1日。",
    "海盐-47是核验流程的北极星锚点。",
    "摘要要素：目的、方法、结果、结论。",
    "中文摘要在前，英文摘要在后。关键词三至五个。",
    "摘要分中文摘要和英文摘要。参考文献置于正文之后。",
  ]) {
    assert.equal(looksBoilerplate(`${navigation}\n${fact}`), false, `应保留导航后的单行事实:${fact}`);
  }

  const governmentNav = "网站首页 政务公开 政务服务 互动交流 组织机构 政策法规 统计数据 专题专栏 领导信息 部门动态 信息公开 办事指南 在线服务 当前位置 Copyright";
  assert.equal(looksBoilerplate(governmentNav), true, "政务站替代导航词也应识别为空壳");
});

test("真实论文正文 → 不误伤", () => {
  const real = "The Royal British Legion commissioned RAND Europe to produce forecasts of the support needs of the veteran community over the next two decades. This research provides an evidence-based picture of how those needs are likely to shift, helping policy makers plan ahead.";
  assert.equal(looksBoilerplate(real), false);
});

test("正文里偶然出现 menu/content 词 → 不误伤(需精确框架短语)", () => {
  const real = "The restaurant menu was extensive. Users can skip content they find irrelevant by using the table of contents. This paragraph is normal prose with real sentences and no navigation shell markers.";
  assert.equal(looksBoilerplate(real), false, "menu/skip content 单独出现不算,须命中 Skip to page content / Site-wide navigation / Toggle Menu 整短语");
});
