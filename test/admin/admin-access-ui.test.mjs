import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

test("后台可写模块由服务端三员权限矩阵统一导出", async () => {
  const { writableModules } = await import("../../lib/admin.ts");
  const operator = new Set(writableModules("operator"));
  const auditor = writableModules("auditor");
  const superModules = new Set(writableModules("super"));

  assert.deepEqual(
    operator,
    new Set(["overview", "analytics", "users", "featured", "settings", "feedback", "monitor"])
  );
  assert.deepEqual(auditor, [], "安全审计员必须保持全后台只读");
  for (const module of ["credits", "plans", "providers", "accounts", "ops", "legal"]) {
    assert.equal(superModules.has(module), true, `系统管理员应可写 ${module}`);
  }

  const meRoute = read("../../app/api/admin/me/route.ts");
  assert.match(meRoute, /writableModules:\s*writableModules\(role\)/);
});

test("后台外壳提供权限上下文、统一提示与主体主题", () => {
  const access = read("../../components/AdminAccess.tsx");
  const layout = read("../../app/admin/layout.tsx");
  const ui = read("../../components/AdminUI.tsx");

  assert.match(access, /createContext<AdminAccessValue>/);
  assert.match(access, /useAdminAccess/);
  assert.match(layout, /<AdminAccessProvider value=\{\{ role, name, modules, writableModules \}\}>/);
  assert.match(layout, /<Toaster \/>/);
  assert.match(layout, /bg-canvas/);
  assert.match(layout, /@\/components\/BrandLogo/);
  assert.doesNotMatch(layout, /@\/components\/HomeClient/);
  assert.doesNotMatch(layout, /backgroundColor:\s*"#f7f8fc"/);
  assert.doesNotMatch(layout, /管理服务在线/);
  assert.match(layout, /已验证管理会话/);
  assert.match(layout, /event\.key === "Escape"/);
  assert.match(ui, /export function ReadOnlyNotice/);
  assert.match(ui, /export function InlineError/);
});

test("只读角色不显示积分、监控、用户和精选的写入口", () => {
  const credits = read("../../app/admin/credits/page.tsx");
  const monitor = read("../../app/admin/monitor/page.tsx");
  const users = read("../../app/admin/users/page.tsx");
  const featured = read("../../app/admin/featured/page.tsx");
  const notebookDetail = read("../../app/admin/notebooks/[id]/page.tsx");
  const accounts = read("../../app/admin/accounts/page.tsx");

  assert.match(credits, /useAdminAccess\("credits"\)/);
  assert.match(credits, /if \(!canWrite \|\| !Object\.keys\(edits\)\.length\) return/);
  assert.match(credits, /!response\.ok \|\| payload\.ok !== true/);
  assert.match(credits, /当前积分权重（只读）/);

  assert.match(monitor, /useAdminAccess\("monitor"\)/);
  assert.match(monitor, /actions=\{canWrite \? \(/);
  assert.match(monitor, /canWrite && j\.status === "error"/);
  assert.match(monitor, /KIND_LABEL\[j\.kind\]/);

  assert.match(users, /useAdminAccess\("users"\)/);
  assert.match(users, /actions=\{canWrite \? <Btn/);
  assert.match(users, /actions=\{canWrite \? \(/);
  assert.match(users, /if \(!response\.ok\) throw new Error/);
  assert.match(users, /\{canWrite && <RowMenu/);
  assert.match(users, /\{canWrite && confirm && \(/);
  assert.match(users, /href="\/admin\/featured"/);
  assert.doesNotMatch(users, /action:\s*"featured_move"/);
  assert.doesNotMatch(users, /action:\s*n\.featured \? "unfeature" : "feature"/);

  assert.match(featured, /useAdminAccess\("featured"\)/);
  assert.match(featured, /\{canWrite && <Section/);
  assert.match(featured, /\{canWrite && editing && \(/);
  assert.match(featured, /\{canWrite && removing && \(/);

  assert.match(notebookDetail, /useAdminAccess\("users"\)/);
  assert.match(notebookDetail, /\{canWrite && \(/);
  assert.match(notebookDetail, /\{canWrite && confirm && \(/);

  assert.match(accounts, /useAdminAccess\("accounts"\)/);
  assert.match(accounts, /const readOnly = !canWrite/);
  assert.doesNotMatch(accounts, /fetch\("\/api\/admin\/me"\)/);
});
