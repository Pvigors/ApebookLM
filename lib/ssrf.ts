// ---------------------------------------------------------------------------
// SSRF 防护的出网 fetch(H2 / SSRF-1 / M2)。
//
// 在抓取「用户提供的 URL」前:仅放行 http/https;DNS 解析后拒绝任何指向
// 回环 / 私网(RFC1918)/ 链路本地(含云元数据 169.254.169.254)/ ULA / 保留段
// 的地址;以 redirect:"manual" 逐跳复检,挡住「首跳公网 200 后 30x 跳内网」。
//
// 反 DNS rebinding:实际建连走 node:http(s) + 自定义 lookup,在「连接那一刻」
// 再次校验解析出的 IP 并用该 IP 建连 —— 校验与建连用的是同一次解析结果,消除
// 「校验时返公网、建连时返内网」的时间窗。并对响应体设大小上限,防巨型远端体 OOM。
// ---------------------------------------------------------------------------

import { lookup } from "node:dns/promises";
import { lookup as dnsLookupCb } from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 远端响应体上限

/** 判断某个 IP 字面量是否属于私有 / 回环 / 链路本地 / 保留段。 */
export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true; // 本网/私网/回环
    if (p[0] === 169 && p[1] === 254) return true; // 链路本地(云元数据)
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 私网
    if (p[0] === 192 && p[1] === 168) return true; // 私网
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true; // IETF 协议保留
    if (p[0] === 192 && p[1] === 0 && p[2] === 2) return true; // TEST-NET-1
    if (p[0] === 192 && p[1] === 88 && p[2] === 99) return true; // 已废弃 6to4 relay
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // 基准测试网
    if (p[0] === 198 && p[1] === 51 && p[2] === 100) return true; // TEST-NET-2
    if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true; // TEST-NET-3
    if (p[0] >= 224) return true; // 组播/保留
    return false;
  }
  if (v === 6) {
    const lc = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const h = expandV6(lc);
    if (!h) return true; // 解析失败 → 视为不安全
    // 链路本地 fe80::/10
    if ((h[0] & 0xffc0) === 0xfe80) return true;
    // ULA fc00::/7
    if ((h[0] & 0xfe00) === 0xfc00) return true;
    // 内嵌 IPv4:mapped(::ffff:/96)、compatible(::/96)、translated(::ffff:0:/96)。
    // 关键修复:new URL 会把 ::ffff:127.0.0.1 规范化成十六进制 ::ffff:7f00:1,
    // 旧的「点分」正则匹配不到 → 回环/元数据逃逸。这里按 hextet 解码末 32 位。
    const prefixZero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0;
    const mapped = prefixZero && h[4] === 0 && h[5] === 0xffff;
    const compat = prefixZero && h[4] === 0 && h[5] === 0;
    const translated = prefixZero && h[4] === 0xffff && h[5] === 0;
    // NAT64 well-known 前缀 64:ff9b::/96(RFC 6052):把 IPv4 嵌进末 32 位,却
    // 不属于上面三种前缀,旧代码会直接放行。攻击者若让域名解析到
    // 64:ff9b::a9fe:a9fe(=169.254.169.254)即可穿透。这里提取末 32 位复检。
    const nat64WK =
      h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0;
    if (mapped || compat || translated || nat64WK) {
      const v4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
      return isPrivateIp(v4); // 含 ::(→0.0.0.0)与 ::1(→0.0.0.1)
    }
    // NAT64 SIIT 前缀 64:ff9b:1::/48(RFC 6052 §2.2):其 IPv4 嵌入布局随前缀长
    // 度变化(非连续末 32 位),不做易错的手工解码 —— 合法公网抓取目标不该解析
    // 到任何 NAT64 翻译地址,直接判为不安全拒绝。
    if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0x0001) return true;
    if (h[0] === 0x2001 && h[1] === 0x0000) return true; // Teredo 2001::/32
    if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // IPv6 文档网段
    if (h[0] === 0x2002) return true; // 6to4（已废弃，且可嵌入私网 IPv4）
    if ((h[0] & 0xffc0) === 0xfec0) return true; // 已废弃 site-local
    if ((h[0] & 0xff00) === 0xff00) return true; // 组播
    if ((h[0] & 0xfff0) === 0x3ff0) return true; // 3fff::/20 文档网段
    return false;
  }
  return true; // 非法 IP 一律视为不安全
}

/** 把 IPv6 地址(含 :: 压缩与内嵌点分 IPv4 尾巴)展开为 8 个 hextet;失败返回 null。 */
function expandV6(addr: string): number[] | null {
  let s = addr;
  // 内嵌点分 IPv4 尾巴(如 ::ffff:127.0.0.1)→ 转成两个 hextet。
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    if (lastColon < 0) return null;
    const m = s.slice(lastColon + 1).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    const b = m.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    const hi = ((b[0] << 8) | b[1]).toString(16);
    const lo = ((b[2] << 8) | b[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hi + ":" + lo;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (fill < 0) return null;
  const parts = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (parts.length !== 8) return null;
  const h = parts.map((p) => parseInt(p || "0", 16));
  if (h.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff)) return null;
  return h;
}

/** 校验主机名:IP 字面量直接判;域名走 DNS 解析,所有解析结果都必须是公网地址。 */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  // 测试逃生门:诚实性 e2e(test/feeds/honesty.e2e.test.mjs)用本地 HTTP fixture
  // 驱动真实抓取链路,需放行回环地址。默认关;生产/开发不设此变量,防线原样。
  if (process.env.NBLM_SSRF_ALLOW_LOCAL === "1" && (host === "127.0.0.1" || /^localhost$/i.test(host))) {
    return;
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("链接指向内网地址,已拒绝");
    return;
  }
  if (
    /^localhost$/i.test(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error("链接指向内部主机,已拒绝");
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length) throw new Error("无法解析该链接的主机");
  for (const a of addrs) {
    if (isPrivateIp(a.address) && !allowLocalForTest(a.address)) throw new Error("链接解析到内网地址,已拒绝");
  }
}

/**
 * 只做公网 URL 预检，不发请求。供具备自身逐跳/DNS pinning 的受控抓取 sidecar
 * 使用；它不能替代 ssrfSafeFetch 的连接期校验，调用方必须同时保证 sidecar
 * egress fail-closed。拒绝 URL 内嵌账号密码，避免凭据被转交给外部处理器。
 */
export async function assertSafePublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("无效的链接");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅支持 http / https 链接");
  }
  if (url.username || url.password) throw new Error("链接不能包含账号或密码");
  await assertPublicHost(url.hostname);
  return url;
}

/** 测试逃生门(见 assertPublicHost 头注):仅回环地址、仅显式设 NBLM_SSRF_ALLOW_LOCAL=1 时。 */
const allowLocalForTest = (ip: string) =>
  process.env.NBLM_SSRF_ALLOW_LOCAL === "1" && (ip === "127.0.0.1" || ip === "::1");

// 连接期 DNS 校验 lookup:解析全部地址,任一为私网即拒;否则用校验过的地址建连。
// 传给 net.connect 的 lookup,与建连同源,故消除 rebinding 时间窗。
type NetLookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family: number
) => void;
function validatingLookup(
  hostname: string,
  options: { all?: boolean; verbatim?: boolean },
  cb: NetLookupCb
): void {
  dnsLookupCb(hostname, { all: true, verbatim: options?.verbatim !== false }, (err, addresses) => {
    if (err) return cb(err, "", 0);
    const list = Array.isArray(addresses) ? addresses : [];
    for (const a of list) {
      if (isPrivateIp(a.address) && !allowLocalForTest(a.address)) {
        return cb(new Error("SSRF blocked: 主机解析到内网地址") as NodeJS.ErrnoException, "", 0);
      }
    }
    if (!list.length) return cb(new Error("SSRF blocked: 无法解析主机") as NodeJS.ErrnoException, "", 0);
    if (options?.all) return cb(null, list, 0);
    cb(null, list[0].address, list[0].family);
  });
}

/** 用 node:http(s) 发一次请求(不自动跟随重定向),连接期校验 IP,响应体限大小。 */
function safeRequest(
  u: URL,
  init: RequestInit,
  maxBytes: number,
  timeoutMs: number
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((v, k) => {
      headers[k] = v;
    });
    const signal = init.signal;
    let request: http.ClientRequest | undefined;
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const fail = (e: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(e);
      }
    };
    const abort = () => request?.destroy(
      signal?.reason instanceof Error ? signal.reason : new Error("请求已取消")
    );
    if (signal?.aborted) {
      fail(signal.reason instanceof Error ? signal.reason : new Error("请求已取消"));
      return;
    }
    request = mod.request(
      u,
      {
        method: (init.method || "GET").toUpperCase(),
        headers,
        lookup: validatingLookup as unknown as http.RequestOptions["lookup"],
      },
      (res) => {
        const status = res.statusCode || 0;
        const resHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const vv of v) resHeaders.append(k, vv);
          else if (v != null) resHeaders.set(k, String(v));
        }
        // 30x:不读 body,交回上层循环复检 Location。
        if (status >= 300 && status < 400 && resHeaders.get("location")) {
          res.destroy();
          if (!settled) {
            settled = true;
            cleanup();
            resolve(new Response(null, { status, headers: resHeaders }));
          }
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          if (truncated) resHeaders.set("x-nblm-truncated", "1");
          const body = chunks.length ? Buffer.concat(chunks) : null;
          // status 兜底到合法区间,避免 Response 构造抛错。
          // 超限不是“成功但 body 碰巧较短”：用 413 + 显式头让所有只检查 res.ok 的
          // 调用方也 fail closed，避免 PDF/抓取结果把截断内容当完整 200。
          const s = truncated ? 413 : status >= 200 && status <= 599 ? status : 502;
          resolve(new Response(body, { status: s, headers: resHeaders }));
        };
        res.on("end", finish);
        res.on("close", () => {
          if (truncated) finish();
        });
        res.on("error", fail);
      }
    );
    signal?.addEventListener("abort", abort, { once: true });
    request.setTimeout(timeoutMs, () => request?.destroy(new Error("请求超时")));
    request.on("error", fail);
    if (typeof init.body === "string") request.end(init.body);
    else request.end();
  });
}

/**
 * SSRF 安全版 fetch:校验目标主机 + 逐跳手动复检重定向 + 连接期 IP 校验 + 超时 + 响应体上限。
 * 返回 web Response;用法同 fetch,但始终 manual 重定向(内部已处理跳转)。
 */
export async function ssrfSafeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<Response> {
  let url = rawUrl;
  const totalTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  // timeoutMs 同时是每次 socket 空闲上限和整条重定向链的绝对截止；调用方即使
  // 忘记传 signal，滴灌响应也不能靠持续小包无限续命。
  const deadline = AbortSignal.timeout(totalTimeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  let boundedInit: RequestInit = { ...init, signal };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("无效的链接");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("仅支持 http / https 链接");
    }
    // 快速前置校验:字面 IP / 内部主机名直接拒(连接期 lookup 是权威校验)。
    await assertPublicHost(u.hostname);

    const res = await safeRequest(
      u,
      boundedInit,
      opts.maxBytes ?? DEFAULT_MAX_BYTES,
      totalTimeoutMs
    );

    // 30x:解析为绝对地址,回到循环顶端重新校验主机。
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) {
        const next = new URL(loc, u);
        if (next.origin !== u.origin) {
          const headers = new Headers(boundedInit.headers);
          for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
          boundedInit = { ...boundedInit, headers };
        }
        url = next.toString();
        continue;
      }
    }
    // 对齐原生 fetch 的 res.url 语义(构造出的 Response 默认 url 为空):
    // 暴露最终经复检的地址,供 b23.tv 短链等按结果 URL 提取信息的调用方使用。
    try {
      Object.defineProperty(res, "url", { value: u.toString(), configurable: true });
    } catch {
      /* 只读环境忽略,不影响主流程 */
    }
    return res;
  }
  throw new Error("重定向次数过多");
}
