import { NextRequest, NextResponse } from "next/server";
import { claimSourceRefresh, deleteSource, failClaimedSourceIngest, getSource, releaseSourceIngestLease, renameSource, setSourceSelected } from "@/lib/db";
import { requireAccess } from "@/lib/auth";
import { recordEvent } from "@/lib/activity";
import { extractBilibili, extractYouTube } from "@/lib/extract";
import { extractUrlManaged } from "@/lib/extraction/orchestrator";
import { ingestSource } from "@/lib/rag";
import { hasSubstance } from "@/lib/corpus";
import { createHash } from "node:crypto";
import { rateLimit, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RAW_CHARS = 2_000_000;

/** 重新导入/重新抓取一个网页类来源(url / bilibili / youtube):用原链接重抓 + 重新入库。
 *  error 状态 = 修复失败来源;ready 状态 = 刷新可能已更新的网页内容(ingestSource 幂等,
 *  会先清旧 chunks)。文件/文本来源无原始字节,不可重抓。 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const source = await getSource(id);
  if (!source) return NextResponse.json({ error: "来源不存在" }, { status: 404 });
  const g = await requireAccess(req, source.notebook_id, true);
  if (g instanceof NextResponse) return g;
  const limit = rateLimit(`source-refresh:${g.id}`, 12, 60_000);
  if (!limit.ok) return tooMany(limit.retryAfter);
  if (source.status !== "error" && source.status !== "ready") {
    return NextResponse.json({ error: "该来源正在处理中,请稍后再试" }, { status: 400 });
  }
  // origin 必须是可重抓的 http(s) 链接:note:/文件/文本来源一律拒绝。
  if (
    !source.origin ||
    !/^https?:\/\//i.test(source.origin) ||
    !["url", "bilibili", "youtube"].includes(source.type)
  ) {
    return NextResponse.json(
      { error: "该来源没有可重新抓取的链接(文件/文本来源请删除后重新上传或粘贴)" },
      { status: 400 }
    );
  }
  // ready 来源刷新失败时不降级:保留原内容与状态,只把错误告诉前端(否则一次网络抖动
  // 就把健康来源打成 error,得不偿失)。error 来源维持原语义:失败原因写回行内。
  const wasReady = source.status === "ready";
  const refreshToken = await claimSourceRefresh(id);
  if (!refreshToken) {
    return NextResponse.json({ error: "该来源正在其它页面刷新，请稍后重试" }, { status: 409 });
  }
  try {
    const extracted =
      source.type === "bilibili"
        ? await extractBilibili(source.origin)
        : source.type === "youtube"
        ? await extractYouTube(source.origin)
        : await extractUrlManaged(source.origin, { userId: g.id, signal: req.signal });
    let rawText = extracted.text || "";
    const pages = "provenance" in extracted ? extracted.pages : undefined;
    let extraction = "provenance" in extracted ? extracted.provenance : undefined;
    if (rawText.length > MAX_RAW_CHARS) {
      rawText = rawText.slice(0, MAX_RAW_CHARS);
      if (extraction) {
        extraction = {
          ...extraction,
          outputSha256: createHash("sha256").update(rawText, "utf8").digest("hex"),
          outputChars: rawText.length,
          partial: true,
        };
      }
    }
    // 与首次导入(sources/route.ts)一致:重抓仍是空壳(反爬占位页/URL 回显)就别再入库,
    // 置回 error 让用户看到原因,避免「重试后变成 ready 的死源」再污染生成。
    // ready 来源再加一道与 ingestSource 质量门同口径的前置闸(过短/乱码/反爬页):
    // ingestSource 判坏会置 error 并清空 content,对健康来源是破坏性的,必须在入库前拦下。
    const plain = rawText.replace(/\s+/g, " ").trim();
    const readyGuardTripped =
      wasReady &&
      (plain.length < 50 ||
        (plain.match(/�/g) || []).length / (plain.length || 1) > 0.02 ||
        (plain.length < 400 &&
          /验证中|安全验证|人机验证|请输入验证码|滑动验证|captcha|verify you are human/i.test(plain)));
    if (!hasSubstance(rawText) || readyGuardTripped) {
      if (wasReady) {
        return NextResponse.json(
          { error: "重新抓取未提取到有效正文(可能触发了反爬),已保留原有内容", source: await getSource(id) },
          { status: 502 }
        );
      }
      await failClaimedSourceIngest(
        id,
        refreshToken,
        "未能从该链接提取到正文(可能触发了反爬,或该页是纯导航页)。请改用「粘贴文本」方式导入。"
      );
    } else {
      await ingestSource(id, source.notebook_id, rawText, {
        claimToken: refreshToken,
        pages,
        extraction,
      });
    }
  } catch (err) {
    if (wasReady) {
      return NextResponse.json(
        { error: `重新抓取失败:${(err as Error).message}(已保留原有内容)`, source: await getSource(id) },
        { status: 502 }
      );
    }
    await failClaimedSourceIngest(id, refreshToken, `重新导入失败:${(err as Error).message}`).catch(() => false);
  } finally {
    if (refreshToken) await releaseSourceIngestLease(id, refreshToken).catch(() => false);
  }
  const finalSource = await getSource(id);
  recordEvent({
    actorId: g.id,
    actorKind: "user",
    action: "source.reimport",
    targetType: "source",
    targetId: id,
    notebookId: source.notebook_id,
    meta: { type: source.type, status: finalSource?.status },
  });
  return NextResponse.json({ source: finalSource });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const source = await getSource(id);
  if (!source) return NextResponse.json({ error: "来源不存在" }, { status: 404 });
  const g = await requireAccess(req, source.notebook_id);
  if (g instanceof NextResponse) return g;
  return NextResponse.json({ source });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const source = await getSource(id);
  if (!source) return NextResponse.json({ error: "来源不存在" }, { status: 404 });
  const g = await requireAccess(req, source.notebook_id, true);
  if (g instanceof NextResponse) return g;
  const body = await req.json().catch(() => ({}));
  if (typeof body.title === "string" && body.title.trim()) {
    await renameSource(id, body.title.slice(0, 200));
  }
  if (typeof body.selected === "boolean") {
    await setSourceSelected(id, body.selected);
  }
  return NextResponse.json({ source: await getSource(id) });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const source = await getSource(id);
  if (!source) return NextResponse.json({ ok: true });
  const g = await requireAccess(req, source.notebook_id, true);
  if (g instanceof NextResponse) return g;
  await deleteSource(id);
  recordEvent({
    actorId: g.id,
    actorKind: "user",
    action: "source.delete",
    targetType: "source",
    targetId: id,
    notebookId: source.notebook_id,
    meta: { title: source.title, type: source.type },
  });
  return NextResponse.json({ ok: true });
}
