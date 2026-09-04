import { NextRequest, NextResponse } from "next/server";
import { checkNotebookQuota, copyNotebook, NotebookLimitError, getNotebook, getNotebookAccess } from "@/lib/db";
import { requireMember } from "@/lib/auth";
import { recordEvent } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Copy a public/featured (or accessible) notebook into the current user's account.
// 【已知权衡,刻意保留】/api/public 的查看态只给来源摘要不给原文,但「复制到我的
// 笔记本」是公开页上的正式功能(PublicNotebook 的复制按钮),副本必须携带来源原文
// 与 chunks 才能继续对话/生成。即:把笔记本设为公开 = 接受他人可通过复制获得来源
// 全文。如未来要收紧,应在 setNotebookPublic 处向所有者明示,而非静默阉割副本。
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireMember(req);
  if (user instanceof NextResponse) return user;
  // 洪水:复制拷贝全量 sources+chunks+embeddings,分钟级刷建烧盘。补速率闸。
  const lim = rateLimit(`nb-copy:${user.id}`, 5, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);
  const src = await getNotebook(id);
  if (!src) return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  if (!src.public && !(await getNotebookAccess(id, user.id))) {
    return NextResponse.json({ error: "无权复制此笔记本" }, { status: 403 });
  }
  // 配额:复制此前绕过 checkNotebookQuota(只在 POST /api/notebooks 校验),免费用户可循环
  // 「复制」无限囤本(每份还带全量来源+chunks+embeddings)。这里补上同款校验。
  const nbQuota = await checkNotebookQuota(user); // 快速 UI 预检
  if (nbQuota.over) {
    return NextResponse.json(
      { error: `已达当前权益的笔记本上限(${nbQuota.limit} 个)，如需调整请联系管理员` },
      { status: 403 }
    );
  }
  // 真正裁决:把上限校验放进 copyNotebook 的事务(锁用户行+计数),堵死并发「复制」绕过。
  let nb;
  try {
    nb = await copyNotebook(id, user.id, nbQuota.limit);
  } catch (e) {
    if (e instanceof NotebookLimitError) {
      return NextResponse.json(
        { error: `已达当前权益的笔记本上限(${e.limit} 个)，如需调整请联系管理员` },
        { status: 403 }
      );
    }
    throw e;
  }
  if (!nb) return NextResponse.json({ error: "复制失败" }, { status: 500 });
  await recordEvent({
    actorId: user.id,
    actorKind: "user",
    action: "notebook.copy",
    targetType: "notebook",
    targetId: nb.id,
    notebookId: nb.id,
    meta: { from: id, title: src.title },
  });
  return NextResponse.json({ notebook: nb });
}
