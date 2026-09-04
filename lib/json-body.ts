export class JsonBodyError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(message: string, status: 400 | 413 | 415) {
    super(message);
    this.name = "JsonBodyError";
    this.status = status;
  }
}

/** 对 JSON API 做真实流式字节上限，同时覆盖 Content-Length 与 chunked body。 */
export async function readJsonObjectLimited(
  request: Request,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new JsonBodyError("请求格式无效", 415);
  const declared = request.headers.get("content-length")?.trim() ?? "";
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new JsonBodyError("请求体过大", 413);
  }
  if (!request.body) throw new JsonBodyError("请求内容为空", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("json body too large").catch(() => {});
        throw new JsonBodyError("请求体过大", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(merged));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof JsonBodyError) throw error;
    throw new JsonBodyError("请求内容不是合法 JSON", 400);
  }
}
