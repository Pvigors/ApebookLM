import { NextRequest, NextResponse } from "next/server";
import { adminRoleOf, accessibleModules, requireAdmin, writableModules } from "@/lib/admin";

/** 后台侧栏用:返回当前用户的三员角色 + 可访问模块清单(用于导航过滤 + 只读态)。 */
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req);
  if (user instanceof NextResponse) return user;
  const role = adminRoleOf(user);
  if (!role) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
  return NextResponse.json({
    role,
    modules: accessibleModules(role),
    writableModules: writableModules(role),
    name: user?.name ?? "",
  });
}
