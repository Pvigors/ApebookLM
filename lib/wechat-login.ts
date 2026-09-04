import "server-only";

// 微信开放平台「网站应用」扫码登录(snsapi_login)。
//
// 使用开放平台网站应用的 WECHAT_APP_ID/WECHAT_APP_SECRET。
//
// 未配置密钥时 isEnabled() 返回 false,调用方回退到开发环境的模拟扫码闭环,
// 生产则整个隐藏微信入口 —— 绝不让用户面对一个扫不动的二维码。
//
// 出网范式与 lib/sms.ts 一致:固定可信域名的 API 调用走裸 fetch + 超时,
// 不走 ssrfSafeFetch(那是给用户可控 URL 的抓取用的,会拒私网并逐跳复检)。

const AUTH_ENDPOINT = "https://open.weixin.qq.com/connect/qrconnect";
const TOKEN_ENDPOINT = "https://api.weixin.qq.com/sns/oauth2/access_token";
const USERINFO_ENDPOINT = "https://api.weixin.qq.com/sns/userinfo";
const TIMEOUT_MS = 8000;

export function wechatLoginConfig(): { appId: string; appSecret: string } | null {
  const appId = (process.env.WECHAT_APP_ID || "").trim();
  const appSecret = (process.env.WECHAT_APP_SECRET || "").trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

export function isWeChatLoginEnabled(): boolean {
  return wechatLoginConfig() !== null;
}

/**
 * 回调地址必须与开放平台后台登记的「授权回调域」同域,否则微信直接报 redirect_uri 错误。
 * 优先用显式配置的站点地址,其次由请求头推导。
 */
export function callbackUrl(origin: string): string {
  const base = (process.env.PUBLIC_ORIGIN || origin || "").replace(/\/+$/, "");
  return `${base}/api/auth/wechat/callback`;
}

/**
 * 内嵌二维码用的授权页地址。self_redirect=true 让扫码确认后在 iframe 内部跳转,
 * 外层页面不动,继续靠 poll 轮询拿会话。
 */
export function buildQrUrl(opts: { state: string; origin: string; embedded?: boolean }): string | null {
  const cfg = wechatLoginConfig();
  if (!cfg) return null;
  const params = new URLSearchParams({
    appid: cfg.appId,
    redirect_uri: callbackUrl(opts.origin),
    response_type: "code",
    scope: "snsapi_login",
    state: opts.state,
  });
  if (opts.embedded) {
    params.set("self_redirect", "true");
    // 内嵌时给微信授权页套一份我们自己托管的 CSS(官方 href 参数,必须 https 可公开访问)。
    // 不套的话它默认带「微信登录」标题栏和说明文字,整体比卡片里那个 146×146 的槽位高,
    // 二维码会被裁掉一角。样式见 public/wechat-qr.css。
    const base = (process.env.PUBLIC_ORIGIN || opts.origin || "").replace(/\/+$/, "");
    if (base.startsWith("https://")) params.set("href", `${base}/wechat-qr.css`);
  }
  return `${AUTH_ENDPOINT}?${params.toString()}#wechat_redirect`;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    // 微信即使出错也返回 200 + {errcode,errmsg},所以不能只看 resp.ok。
    return (await resp.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export type WeChatIdentity = {
  openid: string;
  unionid?: string;
  nickname?: string;
  avatar?: string;
};

/**
 * code → openid(+unionid) → 昵称头像。
 * 拉用户信息失败不算致命:openid 已经能唯一标识用户,昵称头像可后补,
 * 所以这一步单独 try,不让它把整条登录链路带崩。
 */
export async function exchangeCodeForIdentity(code: string): Promise<WeChatIdentity | null> {
  const cfg = wechatLoginConfig();
  if (!cfg || !code) return null;

  const tokenUrl =
    `${TOKEN_ENDPOINT}?appid=${encodeURIComponent(cfg.appId)}` +
    `&secret=${encodeURIComponent(cfg.appSecret)}` +
    `&code=${encodeURIComponent(code)}&grant_type=authorization_code`;

  let token: Record<string, unknown>;
  try {
    token = await getJson(tokenUrl);
  } catch {
    return null;
  }
  const openid = typeof token.openid === "string" ? token.openid : "";
  const accessToken = typeof token.access_token === "string" ? token.access_token : "";
  if (!openid || !accessToken) return null;

  const identity: WeChatIdentity = {
    openid,
    unionid: typeof token.unionid === "string" ? token.unionid : undefined,
  };

  try {
    const info = await getJson(
      `${USERINFO_ENDPOINT}?access_token=${encodeURIComponent(accessToken)}&openid=${encodeURIComponent(openid)}&lang=zh_CN`
    );
    if (typeof info.nickname === "string" && info.nickname.trim()) identity.nickname = info.nickname.trim().slice(0, 24);
    // 微信返回的头像是 thirdwx.qlogo.cn,历史上一直是 http:// 开头(无 s)。
    // 原来只认 https:// 前缀,等于把绝大多数头像整个丢掉 —— 表现就是「昵称有、头像没有」。
    // qlogo 两种协议都支持,这里统一升级成 https,避免在 https 页面里触发混合内容拦截。
    if (typeof info.headimgurl === "string") {
      const raw = info.headimgurl.trim();
      if (/^https?:\/\//.test(raw)) identity.avatar = raw.replace(/^http:\/\//, "https://");
    }
  } catch {
    // 忽略:昵称头像缺失时由 createUserByWechat 兜底成「微信用户」
  }

  return identity;
}
