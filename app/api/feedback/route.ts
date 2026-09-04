import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import { createFeedback } from "@/lib/db";
import { recordEvent, reqMeta } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 反馈图片累计字节硬顶(多张相加)—— 单张 1.5MB×6 可达 ~9MB,直存 sqlite 会撑爆磁盘。
const MAX_IMAGES_BYTES = 5 * 1024 * 1024;

/** 用户提交反馈(设置内「反馈问题」)。需登录。 */
export async function POST(req: NextRequest) {
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  // 洪水:反馈直写 DB + activity_log,无限流可被单账号刷爆磁盘/后台列表。
  // 用户维度严一点、IP 维度兜底(多账号同 IP)。
  const ip = reqMeta(req).ip || "unknown";
  const uLim = rateLimit(`feedback:${user.id}`, 3, 60_000);
  if (!uLim.ok) return tooMany(uLim.retryAfter);
  const ipLim = rateLimit(`feedback:ip:${ip}`, 10, 60_000);
  if (!ipLim.ok) return tooMany(ipLim.retryAfter);
  const body = await req.json().catch(() => ({}));
  const content = String(body.content || "").trim();
  // 截图(可选):data:image/ 的 data URL 数组,最多 6 张、每张 ≤ 1.5MB。
  const rawImages = Array.isArray(body.images) ? body.images : [];
  const images: string[] = [];
  let imagesBytes = 0;
  for (const it of rawImages) {
    const s = typeof it === "string" ? it : "";
    if (!s.startsWith("data:image/")) continue;
    if (s.length > 1_500_000) return NextResponse.json({ error: "图片过大(单张上限约 1.5MB)" }, { status: 400 });
    // 累计字节硬顶(多张相加):防「6×1.5MB≈9MB 单次灌库」放大攻击。
    imagesBytes += s.length;
    if (imagesBytes > MAX_IMAGES_BYTES) return NextResponse.json({ error: "图片总大小过大(累计上限约 5MB)" }, { status: 400 });
    images.push(s);
    if (images.length >= 6) break;
  }
  if (!content && images.length === 0) return NextResponse.json({ error: "请填写反馈内容或上传图片" }, { status: 400 });
  if (content.length > 2000) return NextResponse.json({ error: "内容过长(上限 2000 字)" }, { status: 400 });
  const category = ["bug", "idea", "other"].includes(body.category) ? body.category : "other";
  const contact = body.contact ? String(body.contact).slice(0, 120) : null;
  const fb = await createFeedback({ userId: user.id, userName: user.name, category, content, contact, images });
  const m = reqMeta(req);
  recordEvent({
    actorId: user.id,
    actorKind: "user",
    action: "feedback.create",
    targetType: "feedback",
    targetId: fb.id,
    meta: { category },
    ip: m.ip,
    ua: m.ua,
  });
  return NextResponse.json({ ok: true });
}
