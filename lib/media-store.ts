import { readFile, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// OSS 旁标(sidecar)读写 —— 媒体 commit / serve 两侧共享的一点点胶水。
//
// 设计动机(见路 B 方案):不碰 db.ts/jobs.ts(禁区),又要把「本产物已上传 OSS、
// key=?」这个事实持久化。做法:commit 成功上传后,在媒体目录写一个与产物同名的
// <id>.osskey 文本文件存 OSS key;serve 路由读它判断是否 302 到预签名 URL。
//
// **零回归**:这些函数只在 ossEnabled() 为 true 时被调用;OSS 未配置 → 从不写
// 旁标,serve 侧 readOssKeySidecar 找不到文件返回 null → 一律走本地(现状)。
// 本地媒体文件始终保留,OSS 上传失败静默降级纯本地。
// ---------------------------------------------------------------------------

/** 旁标文件路径:<baseNoExt>.osskey(与产物同名)。 */
function sidecarPath(baseNoExt: string): string {
  return `${baseNoExt}.osskey`;
}

/**
 * 尽力上传 buffer/文件到 OSS,成功则写 <baseNoExt>.osskey 存 key。
 * **绝不抛错**:任何失败(网络/签名/写盘)都静默吞掉 → 本次纯本地,零影响。
 * 调用前应已确认 ossEnabled();这里再兜一层 try/catch 保证不污染主流程。
 *
 * @param baseNoExt 产物本地路径去扩展名,如 .data/audio/<id>(旁标写成 <id>.osskey)
 * @param key       OSS 对象键,如 media/audio/<id>.mp3
 * @param body      Buffer 或本地文件路径
 * @param contentType MIME
 */
export async function uploadAndMarkOss(
  baseNoExt: string,
  key: string,
  body: Buffer | string,
  contentType: string,
  putObject: (key: string, body: Buffer | string, contentType: string) => Promise<void>
): Promise<void> {
  try {
    await putObject(key, body, contentType);
    await writeFile(sidecarPath(baseNoExt), key, "utf8");
  } catch (e) {
    // 上传/标注失败 → 无旁标 → serve 走本地。绝不能让 OSS 拖垮已成功的本地产物。
    console.warn("[media-store] OSS 上传失败,降级纯本地:", (e as Error).message);
  }
}

/** 直接写旁标(已在外部完成上传时用)。同样绝不抛错。 */
export async function writeOssKeySidecar(baseNoExt: string, key: string): Promise<void> {
  try {
    await writeFile(sidecarPath(baseNoExt), key, "utf8");
  } catch (e) {
    console.warn("[media-store] 写 OSS 旁标失败,降级纯本地:", (e as Error).message);
  }
}

/**
 * 读旁标里的 OSS key;不存在/读失败 → null(=走本地)。serve 路由用。
 * @param baseNoExt 产物本地路径去扩展名(与 write 侧同参)
 */
export async function readOssKeySidecar(baseNoExt: string): Promise<string | null> {
  try {
    const key = (await readFile(sidecarPath(baseNoExt), "utf8")).trim();
    return key || null;
  } catch {
    return null;
  }
}

