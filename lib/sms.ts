import crypto from "node:crypto";

// ---------------------------------------------------------------------------

/** 仅在四项部署变量齐全时公开短信登录入口；不会返回任何凭据值。 */
export function isSmsLoginEnabled(): boolean {
  return Boolean(
    process.env.ALIYUN_SMS_KEY_ID?.trim() &&
    process.env.ALIYUN_SMS_SECRET?.trim() &&
    process.env.ALIYUN_SMS_SIGN?.trim() &&
    process.env.ALIYUN_SMS_TEMPLATE?.trim()
  );
}
// 阿里云短信(dysmsapi)adapter —— 纯 Node crypto 实现 RPC 风格签名,不引入
// @alicloud SDK(避免依赖膨胀 + 沙箱装不上原生依赖)。
//
// 签名算法出处:阿里云《RPC API 签名机制》(V1,2017-05-25 版 SendSms 接口)
//   https://help.aliyun.com/document_detail/315526.html
//   https://help.aliyun.com/zh/sms/developer-reference/sendsms
// 步骤:
//   1. 公共参数 + 业务参数 合并到一个字典(含 SignatureNonce/Timestamp);
//   2. 按参数名字典序排序,逐个 percentEncode(key)=percentEncode(value) 用 & 连接,
//      得到 canonicalizedQuery;
//   3. StringToSign = "POST" + "&" + encode("/") + "&" + encode(canonicalizedQuery);
//   4. HMAC-SHA1(key = AccessKeySecret + "&", StringToSign) → base64 得 Signature;
//   5. Signature 也 percentEncode 后作为 query 发 POST 到 https://dysmsapi.aliyuncs.com/。
//
// dev 行为:NODE_ENV !== 'production' 时直接 return,不发任何网络请求,
//   由 send 路由的 console.log 兜底显示验证码,保证本地零回归、不真发短信。
// ---------------------------------------------------------------------------

/**
 * 阿里云规范 percentEncode:先 encodeURIComponent,再把 RFC3986 与阿里云要求
 * 不一致的三处修正——加号 + → %20、星号 * → %2A、波浪号 %7E → ~。
 */
function percentEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

/** 计算 RPC 签名并返回 canonicalizedQuery(不含 Signature)。 */
function sign(params: Record<string, string>, secret: string): { query: string; signature: string } {
  const keys = Object.keys(params).sort();
  const canonicalized = keys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const stringToSign = `POST&${percentEncode("/")}&${percentEncode(canonicalized)}`;
  const signature = crypto
    .createHmac("sha1", secret + "&")
    .update(stringToSign)
    .digest("base64");
  return { query: canonicalized, signature };
}

/**
 * 发送短信验证码。dev 直接 return(不发);生产走阿里云 dysmsapi。
 * 缺 env 抛「短信未配置」;返回体 Code !== 'OK' 抛带 Message 的 Error。
 */
export async function sendSms(phone: string, code: string): Promise<void> {
  // dev:不发,由 send 路由 console 兜底
  if (process.env.NODE_ENV !== "production") return;

  // 登录供应商凭据只允许由部署环境注入，不进入数据库、后台接口或页面。
  const keyId = process.env.ALIYUN_SMS_KEY_ID?.trim();
  const secret = process.env.ALIYUN_SMS_SECRET?.trim();
  const signName = process.env.ALIYUN_SMS_SIGN?.trim();
  const template = process.env.ALIYUN_SMS_TEMPLATE?.trim();
  if (!keyId || !secret || !signName || !template) {
    throw new Error("短信未配置");
  }

  const params: Record<string, string> = {
    // 公共参数
    AccessKeyId: keyId,
    Action: "SendSms",
    Format: "JSON",
    RegionId: "cn-hangzhou",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    Version: "2017-05-25",
    // 业务参数
    PhoneNumbers: phone,
    SignName: signName,
    TemplateCode: template,
    TemplateParam: JSON.stringify({ code }),
  };

  const { query, signature } = sign(params, secret);
  const body = `Signature=${percentEncode(signature)}&${query}`;

  const resp = await fetch("https://dysmsapi.aliyuncs.com/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await resp.json().catch(() => ({}))) as { Code?: string; Message?: string };
  if (data.Code !== "OK") {
    throw new Error(data.Message || `短信发送失败(Code=${data.Code || resp.status})`);
  }
}
