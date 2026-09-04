// 逻辑测试(纯函数,无 DB):语言覆盖、幻灯片设计语言字段、模版路由。
import { test } from "node:test";
import assert from "node:assert/strict";
import { genHintText } from "../../lib/studio.ts";
import { buildDirective } from "../../lib/settings.ts";
import { slideStyle, isSlideThemeId, pickThemeForText } from "../../lib/slide-themes.ts";

// ---- genHintText:语言选择必须「覆盖来源语言默认」----
test("genHintText: 无参数 → 空串", () => {
  assert.equal(genHintText(), "");
  assert.equal(genHintText({}), "");
});
test("genHintText: 指定语言 → 强制覆盖来源语言的硬性指令", () => {
  const s = genHintText({ language: "English" });
  assert.match(s, /English/);
  assert.match(s, /覆盖/); // 明确覆盖「用来源语言」默认 —— 修了「选语言都出中文」的 bug
});
test("genHintText: 额外指令被追加", () => {
  assert.match(genHintText({ instruction: "只画研究目标" }), /只画研究目标/);
});

// ---- buildDirective:笔记本级输出语言必须「最高优先级 + 覆盖来源语言」----
test("buildDirective: 无设置 → 空串", () => {
  assert.equal(buildDirective({}), "");
});
test("buildDirective: 输出语言 → 权威覆盖指令(影响对话/报告/概览/音视频)", () => {
  const s = buildDirective({ language: "English" });
  assert.match(s, /English/);
  assert.match(s, /HIGHEST PRIORITY|OVERRIDES/); // 显式压过「dominant source language」
});
test("buildDirective: 更简短 进指令(回答风格已移除)", () => {
  const s = buildDirective({ length: "shorter" });
  assert.match(s, /concise|brief/i);
});

// ---- slideStyle:扩展后的设计语言字段,且现有模版像素不变 ----
test("slideStyle: editorial = 浅底/无封面母题/airy/衬线", () => {
  const st = slideStyle("editorial");
  assert.equal(st.light, true);
  assert.equal(st.coverDecor, "none");
  assert.equal(st.coverCorners, false);
  assert.equal(st.density, "airy");
  assert.ok(st.fontHead, "衬线字体");
});
test("slideStyle: neon=glow, brutal=sharp", () => {
  assert.equal(slideStyle("neon").glow, true);
  assert.equal(slideStyle("brutal").sharp, true);
  assert.equal(slideStyle("brutal").coverCorners, false);
});
test("slideStyle: 既有 midnight 未被新字段污染(回归保护)", () => {
  const st = slideStyle("midnight");
  for (const k of ["light", "sharp", "glow", "titleScale", "coverDecor", "density"])
    assert.equal(st[k], undefined, `midnight.${k} 应为 undefined`);
});
test("slideStyle: 未知 id 回退 midnight", () => {
  assert.deepEqual(slideStyle("nope"), slideStyle("midnight"));
});

// ---- isSlideThemeId:10 套模版 ----
test("isSlideThemeId: 识别全部 10 套模版", () => {
  for (const id of ["midnight", "paper", "aurora", "sunrise", "forest", "editorial", "neon", "crimson", "graphite", "brutal"])
    assert.equal(isSlideThemeId(id), true, id);
  assert.equal(isSlideThemeId("xyz"), false);
  assert.equal(isSlideThemeId(null), false);
});

// ---- pickThemeForText:关键词路由 + 无命中稳定可复现 ----
test("pickThemeForText: 关键词命中对应气质", () => {
  assert.equal(pickThemeForText("赛博 元宇宙 区块链 霓虹"), "neon");
  assert.equal(pickThemeForText("极简 留白 排版 杂志"), "editorial");
});
test("pickThemeForText: 无命中 → 同输入稳定同结果", () => {
  const a = pickThemeForText("zzz unrelated 98765 qwerty");
  const b = pickThemeForText("zzz unrelated 98765 qwerty");
  assert.equal(a, b);
  assert.ok(isSlideThemeId(a));
});
