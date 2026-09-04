import { NextRequest } from "next/server";
import { getNotebook } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 公开分享保持免登录只读，但不再提供匿名模型调用。这样公开链接仍能承担传播和
 * 阅读用途，同时不会成为绕过访问权限与积分计量的匿名后门。
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const nb = await getNotebook(id);
  if (!nb || !nb.public) {
    return Response.json({ error: "笔记本不存在或未公开" }, { status: 404 });
  }
  return Response.json(
    {
      error: "公开分享仅支持阅读。登录并复制到自己的工作台后，可使用积分与资料对话。",
      code: "read_only",
    },
    { status: 403 }
  );
}
