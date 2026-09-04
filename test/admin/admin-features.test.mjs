// 后台新功能逻辑测试:用户反馈 CRUD、法律文档覆盖/回落、应用全局设置。
// PG 测试库(freshPgDb),不污染真实数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshPgDb } from "../helpers/pgdb.mjs";

const db = await freshPgDb("admin");
const legal = await import("../../lib/legal.ts");
const appcfg = await import("../../lib/app-config.ts");

// ---------- 反馈 ----------
test("反馈:创建 → 列表/筛选 → 计数 → 处理状态流转", async () => {
  const a = await db.createFeedback({ userId: "u1", userName: "小满", category: "bug", content: "崩了" });
  await db.createFeedback({ userId: "u2", userName: "阿强", category: "idea", content: "加个夜间模式" });
  assert.equal(a.status, "open");
  assert.ok(a.id.startsWith("fb_"));

  assert.equal((await db.listFeedback({})).total, 2);
  assert.equal((await db.listFeedback({ status: "open" })).total, 2);
  assert.equal((await db.listFeedback({ status: "resolved" })).total, 0);
  assert.equal(await db.countOpenFeedback(), 2);

  // 标记已处理 → 计数/筛选随之变化,handled_at/by 落库
  assert.equal(await db.setFeedbackStatus(a.id, "resolved", "admin1"), true);
  assert.equal(await db.countOpenFeedback(), 1);
  assert.equal((await db.listFeedback({ status: "resolved" })).total, 1);
  const resolved = (await db.listFeedback({ status: "resolved" })).rows[0];
  assert.equal(resolved.handled_by, "admin1");
  assert.ok(resolved.handled_at > 0);

  // 重开 → 清空 handled 字段
  await db.setFeedbackStatus(a.id, "open", "admin1");
  assert.equal(await db.countOpenFeedback(), 2);
  const reopened = (await db.listFeedback({ status: "open" })).rows.find((r) => r.id === a.id);
  assert.equal(reopened.handled_at, null);

  // 不存在的 id → false
  assert.equal(await db.setFeedbackStatus("fb_nope", "resolved", "admin1"), false);
});

// ---------- 法律文档覆盖/回落 ----------
test("法律:无覆盖回落默认,覆盖后生效且保留 slug/kicker,reset 还原", async () => {
  const def = legal.getDefaultLegalDoc("agreement");
  // 初始:无覆盖 → 等于默认
  assert.equal(await legal.isLegalOverridden("agreement"), false);
  assert.equal((await legal.getLegalDoc("agreement")).title, def.title);

  // 写覆盖
  await legal.setLegalDoc(
    "agreement",
    { title: "我的协议", updated: "2030 年", effective: "2030 年", intro: ["新开篇"], sections: [{ h: "总则", p: ["第一条"] }] },
    "admin1"
  );
  assert.equal(await legal.isLegalOverridden("agreement"), true);
  const ov = await legal.getLegalDoc("agreement");
  assert.equal(ov.title, "我的协议");
  assert.equal(ov.sections[0].h, "总则");
  assert.equal(ov.slug, "agreement", "slug 始终以默认为准");
  assert.equal(ov.kicker, def.kicker, "kicker 始终以默认为准");
  // 另一篇不受影响
  assert.equal(await legal.isLegalOverridden("privacy"), false);

  // 回落
  await legal.resetLegalDoc("agreement");
  assert.equal(await legal.isLegalOverridden("agreement"), false);
  assert.equal((await legal.getLegalDoc("agreement")).title, def.title);
});

// ---------- 应用全局设置 ----------
test("应用设置:默认值 + 部分更新 + 布尔/字符串往返", async () => {
  const d = await appcfg.getAppConfig();
  assert.equal(d.signup_enabled, true);
  assert.equal(d.autoexpand_sources, true);
  assert.equal(d.default_theme, "system");
  assert.equal(d.default_lang, "");
  assert.equal(d.announcement, "");
  assert.equal(d.cad_enabled, true, "非生产测试环境默认开放 CAD 灰度入口");
  assert.deepEqual(
    d.hidden_artifacts,
    ["quiz", "flashcards", "excalidraw", "slides", "xhs", "video", "infographic"],
    "新安装默认只开放五类核心制品"
  );

  await appcfg.setAppConfig({ signup_enabled: false, cad_enabled: false, announcement: "维护中", default_lang: "English" }, "admin1");
  const c = await appcfg.getAppConfig();
  assert.equal(c.signup_enabled, false);
  assert.equal(c.announcement, "维护中");
  assert.equal(c.default_lang, "English");
  assert.equal(c.cad_enabled, false);
  // 未触及的项保持默认
  assert.equal(c.autoexpand_sources, true);
  assert.equal(c.default_theme, "system");

  // 再开回来
  await appcfg.setAppConfig({ signup_enabled: true, cad_enabled: true, hidden_artifacts: [] }, "admin1");
  const reopened = await appcfg.getAppConfig();
  assert.equal(reopened.signup_enabled, true);
  assert.equal(reopened.cad_enabled, true);
  assert.deepEqual(reopened.hidden_artifacts, [], "管理员可显式重新开放全部制品");
});

test("应用设置:非法主题、语言、公告和制品类型在写入前整体拒绝", async () => {
  const before = await appcfg.getAppConfig();
  assert.throws(
    () => appcfg.validateAppConfigPatch({ default_theme: "neon", announcement: "不应写入" }),
    /默认主题无效/
  );
  assert.throws(
    () => appcfg.validateAppConfigPatch({ default_lang: "Klingon" }),
    /默认输出语言无效/
  );
  assert.throws(
    () => appcfg.validateAppConfigPatch({ announcement: "长".repeat(201) }),
    /最多 200/
  );
  assert.throws(
    () => appcfg.validateAppConfigPatch({ hidden_artifacts: ["slides", "unknown_kind"] }),
    /未知智能输出类型/
  );
  assert.deepEqual(await appcfg.getAppConfig(), before, "纯校验失败不得改变现有配置");
});
