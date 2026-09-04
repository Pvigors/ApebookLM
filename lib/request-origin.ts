import { NextRequest, NextResponse } from "next/server";

if (typeof window !== "undefined") throw new Error("请求来源校验只能在服务端使用");

/** Cookie 会话写接口的严格同源检查。 */
export function sameOriginError(req: NextRequest): NextResponse | null {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return null;
  const sent = (req.headers.get("origin") ?? "").replace(/\/+$/, "");
  const expected = (process.env.PUBLIC_ORIGIN || req.nextUrl.origin).replace(/\/+$/, "");
  if (!sent || sent !== expected) {
    return NextResponse.json(
      { error: "请求来源无效", code: "invalid_origin" },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }
  return null;
}
