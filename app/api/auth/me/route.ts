import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, userFromRequest } from "@/lib/auth";
import { deleteUser, listOnlineUsers, setWechatOpenid, updateUserProfile } from "@/lib/db";
import { ARTIFACT_TILES } from "@/components/studio-shared";
import { adminRoleOf } from "@/lib/admin";
import { isAdminPasswordUserId } from "@/lib/admin-password-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await userFromRequest(req);
  // 审查修复:在线用户列表(id/昵称/头像)只对登录用户返回,未登录访客不泄露全站在线名单。
  const online = user
    ? (await listOnlineUsers()).map((u) => ({ id: u.id, name: u.name, avatar: u.avatar }))
    : [];
  return NextResponse.json({ user, online });
}

// 默认输出语言白名单(空串 = 跟随来源,不强制)。与 SettingsMenu 的 LANG_OPTS 对齐。
const LANGS = new Set(["", "简体中文", "English", "日本語", "한국어"]);

/** 用户自助更新个人资料:昵称 / 默认输出语言。 */
export async function PATCH(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  // 解绑微信:需保证仍有其它登录方式(手机号),否则会把自己锁在门外。
  if (body.unbind_wechat === true) {
    if (!user.wechat_openid) return NextResponse.json({ error: "当前未绑定微信" }, { status: 400 });
    if (!user.phone) return NextResponse.json({ error: "解绑前请先绑定手机号,否则将无法登录" }, { status: 400 });
    const updated = await setWechatOpenid(user.id, null);
    return NextResponse.json({ user: updated });
  }

  const patch: { name?: string; default_output_language?: string; avatar?: string; hidden_tiles?: string } = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 1 || name.length > 40) {
      return NextResponse.json({ error: "昵称需为 1–40 个字符" }, { status: 400 });
    }
    patch.name = name;
  }
  if (body.default_output_language !== undefined) {
    const lang = String(body.default_output_language || "").trim();
    if (!LANGS.has(lang)) {
      return NextResponse.json({ error: "不支持的语言" }, { status: 400 });
    }
    patch.default_output_language = lang;
  }
  if (body.avatar !== undefined) {
    const av = body.avatar === null ? "" : String(body.avatar);
    if (av && !av.startsWith("data:image/")) {
      return NextResponse.json({ error: "头像格式不支持" }, { status: 400 });
    }
    if (av.length > 400_000) {
      return NextResponse.json({ error: "头像图片过大" }, { status: 400 });
    }
    patch.avatar = av;
  }
  // 用户自定义隐藏的生成磁贴:数组 → 白名单过滤(ARTIFACT_TILES 的 tile id)→ 逗号串落库。
  // 至少保留一个磁贴可见,防「全隐藏后再也找不到生成入口」。
  if (body.hidden_tiles !== undefined) {
    if (!Array.isArray(body.hidden_tiles)) {
      return NextResponse.json({ error: "hidden_tiles 需为数组" }, { status: 400 });
    }
    const valid = new Set(ARTIFACT_TILES.map((t) => t.tile));
    const hidden = [...new Set((body.hidden_tiles as unknown[]).map(String).filter((t) => valid.has(t)))];
    if (hidden.length >= valid.size) {
      return NextResponse.json({ error: "至少保留一个生成磁贴" }, { status: 400 });
    }
    patch.hidden_tiles = hidden.join(",");
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "无可更新字段" }, { status: 400 });
  }

  const updated = await updateUserProfile(user.id, patch);
  return NextResponse.json({ user: updated });
}

/** 用户自助注销账号:硬删除账号 + 名下笔记本,清空会话 cookie。不可恢复。 */
export async function DELETE(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (user.plan_tier === "test") {
    return NextResponse.json({ error: "测试账号不能自助注销，请联系管理员" }, { status: 403 });
  }
  if (adminRoleOf(user) !== null || isAdminPasswordUserId(user.id)) {
    return NextResponse.json(
      { error: "管理账号不能从前台自助注销，请先由另一名系统管理员撤销权限" },
      { status: 403 }
    );
  }

  await deleteUser(user.id); // 级联清理会话 / 协作者 / 名下笔记本
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
