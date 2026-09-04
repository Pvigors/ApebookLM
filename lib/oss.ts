import { readFile } from "node:fs/promises";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// 阿里云 OSS(对象存储)REST adapter —— 纯 crypto 手写签名,不装 ali-oss SDK。
//
// 目标:大媒体(音频/视频/卡组 PNG/信息图 PNG)生成后传 OSS,查看时 302 到预签名
// URL,把带宽从服务器卸到 OSS(根治静态资源洪水攻击)。
//
// **零回归铁律**:四个 env(KEY_ID/SECRET/BUCKET/ENDPOINT)任一缺失 → ossEnabled()
// 返回 false,调用方一切走本地(逐字节与当前一致)。本模块的任何函数只在 ossEnabled()
// 为 true 时才被调用;env 缺失时它们从不执行、也从不产生 .osskey 旁标。
//
// 签名算法出处:阿里云 OSS 官方文档「在 Header 中包含签名」(V1 / HMAC-SHA1)
//   https://help.aliyun.com/zh/oss/developer-reference/include-signatures-in-the-authorization-header
// 与「在 URL 中包含签名」(预签名 GET URL)
//   https://help.aliyun.com/zh/oss/developer-reference/add-signatures-to-urls
// ---------------------------------------------------------------------------

type OssConf = {
  keyId: string;
  secret: string;
  bucket: string;
  /** 主机名,如 oss-cn-hangzhou.aliyuncs.com(不含 bucket 前缀、不含协议)。 */
  endpointHost: string;
};

/** 读四个 OSS env;全部非空才算已配置。任一缺失 → null(=禁用,走本地)。 */
function readConf(): OssConf | null {
  const keyId = (process.env.ALIYUN_OSS_KEY_ID || "").trim();
  const secret = (process.env.ALIYUN_OSS_SECRET || "").trim();
  const bucket = (process.env.ALIYUN_OSS_BUCKET || "").trim();
  const endpointRaw = (process.env.ALIYUN_OSS_ENDPOINT || "").trim();
  if (!keyId || !secret || !bucket || !endpointRaw) return null;
  // endpoint 允许填成 https://oss-cn-x.aliyuncs.com 或裸主机名;统一剥协议与尾斜杠。
  const endpointHost = endpointRaw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!endpointHost) return null;
  return { keyId, secret, bucket, endpointHost };
}

/** OSS 是否已配置。env 四件套齐全才为 true;否则一律 false(调用方走本地,零回归)。 */
export function ossEnabled(): boolean {
  return readConf() !== null;
}

/** virtual-hosted 风格的对象 URL 主机:<bucket>.<endpointHost>。 */
function objectHost(conf: OssConf): string {
  return `${conf.bucket}.${conf.endpointHost}`;
}

/** RFC 1123 日期(GMT),用于 Date 头与 StringToSign。 */
function gmtDate(): string {
  return new Date().toUTCString();
}

/** HMAC-SHA1(secret, stringToSign) → base64,OSS V1 签名核心。 */
function hmacSha1Base64(secret: string, stringToSign: string): string {
  return crypto.createHmac("sha1", secret).update(stringToSign, "utf8").digest("base64");
}

/**
 * PUT 一个对象到 OSS。
 * @param key    对象键(不含前导斜杠),如 media/audio/<id>.mp3
 * @param body   Buffer 或本地文件路径(字符串→读盘)
 * @param contentType MIME
 *
 * V1 Header 签名(见文档):
 *   StringToSign = VERB + "\n"
 *                + Content-MD5 + "\n"          (可空)
 *                + Content-Type + "\n"
 *                + Date + "\n"
 *                + CanonicalizedOSSHeaders     (本实现无 x-oss-* 头 → 空)
 *                + CanonicalizedResource       (= /<bucket>/<key>)
 *   Signature    = base64(hmac-sha1(AccessKeySecret, StringToSign))
 *   Authorization= "OSS " + AccessKeyId + ":" + Signature
 * 用 Content-MD5 保证传输完整性(也参与签名)。
 */
export async function putObject(
  key: string,
  body: Buffer | string,
  contentType: string
): Promise<void> {
  const conf = readConf();
  if (!conf) throw new Error("OSS 未配置");
  const buf = typeof body === "string" ? await readFile(body) : body;
  const contentMd5 = crypto.createHash("md5").update(buf).digest("base64");
  const date = gmtDate();
  const canonicalizedResource = `/${conf.bucket}/${key}`;
  const stringToSign = [
    "PUT",
    contentMd5,
    contentType,
    date,
    canonicalizedResource, // CanonicalizedOSSHeaders 为空,直接接 CanonicalizedResource
  ].join("\n");
  const signature = hmacSha1Base64(conf.secret, stringToSign);
  const url = `https://${objectHost(conf)}/${encodeKey(key)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Date: date,
      "Content-Type": contentType,
      "Content-MD5": contentMd5,
      "Content-Length": String(buf.length),
      Authorization: `OSS ${conf.keyId}:${signature}`,
    },
    // Buffer → Uint8Array,满足 fetch BodyInit 类型。
    body: new Uint8Array(buf),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OSS PUT 失败 ${res.status}: ${text.slice(0, 300)}`);
  }
}

/**
 * 生成预签名 GET URL,读者可凭此直连 OSS 下载(限时)。
 *
 * URL 签名(见文档「在 URL 中包含签名」):
 *   StringToSign = "GET\n\n\n" + Expires + "\n" + CanonicalizedResource
 *     其中第 2、3 行(Content-MD5 / Content-Type)对 GET 预签名为空,
 *     Expires 为 Unix 秒(绝对过期时刻)。
 *   Signature    = base64(hmac-sha1(AccessKeySecret, StringToSign))
 *   查询串:?OSSAccessKeyId=<id>&Expires=<sec>&Signature=<urlencoded sig>
 */
export function signedGetUrl(key: string, expiresSec = 3600): string {
  const conf = readConf();
  if (!conf) throw new Error("OSS 未配置");
  const expires = Math.floor(Date.now() / 1000) + Math.max(1, expiresSec);
  const canonicalizedResource = `/${conf.bucket}/${key}`;
  const stringToSign = ["GET", "", "", String(expires), canonicalizedResource].join("\n");
  const signature = hmacSha1Base64(conf.secret, stringToSign);
  const qs =
    `OSSAccessKeyId=${encodeURIComponent(conf.keyId)}` +
    `&Expires=${expires}` +
    `&Signature=${encodeURIComponent(signature)}`;
  return `https://${objectHost(conf)}/${encodeKey(key)}?${qs}`;
}

/** 对象键做 URL 路径转义:按 "/" 分段各自 encodeURIComponent,保留斜杠层级。
 *  注意:CanonicalizedResource 用的是【原始未转义】的 key(签名侧),URL 里才转义。 */
function encodeKey(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}
