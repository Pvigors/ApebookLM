import { NextRequest, NextResponse } from "next/server";
import { userFromRequest } from "@/lib/auth";
import { reqMeta } from "@/lib/activity";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import { ssrfSafeFetch } from "@/lib/ssrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Check whether a URL can be shown inside an <iframe> by inspecting the
 *  response's X-Frame-Options / CSP frame-ancestors headers — the same signals
 *  the browser uses. Lets the source viewer show a clean placeholder instead of
 *  the browser's "refused to connect" page for sites that forbid embedding. */
export async function GET(req: NextRequest) {
  // M2:此前匿名可探任意 URL(含内网/云元数据)。要求登录 + 限流 + SSRF 安全 fetch。
  const user = await userFromRequest(req);
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const ip = reqMeta(req).ip || "unknown";
  const lim = rateLimit(`embed-check:${user.id}:${ip}`, 30, 60_000);
  if (!lim.ok) return tooMany(lim.retryAfter);

  const url = req.nextUrl.searchParams.get("url");
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ embeddable: false });
  }
  try {
    const res = await ssrfSafeFetch(
      url,
      {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ApebookLM/1.0)" },
      },
      { timeoutMs: 6000, maxBytes: 64 * 1024 } // 只看响应头,正文最多读 64KB
    );
    // We only need the headers — don't download the whole page.
    res.body?.cancel().catch(() => {});

    const xfo = (res.headers.get("x-frame-options") || "").toLowerCase();
    const csp = res.headers.get("content-security-policy") || "";
    const fa = csp.match(/frame-ancestors([^;]*)/i)?.[1]?.trim().toLowerCase() ?? null;

    // Blocked if X-Frame-Options forbids it, or CSP frame-ancestors restricts to
    // something other than "*" (no site lists our dev origin explicitly).
    const blockedByXfo = xfo.includes("deny") || xfo.includes("sameorigin");
    const blockedByCsp = fa !== null && !fa.includes("*");
    return NextResponse.json({ embeddable: !blockedByXfo && !blockedByCsp });
  } catch {
    // Unknown (timeout / network) — be optimistic and let the iframe try.
    return NextResponse.json({ embeddable: true });
  }
}
