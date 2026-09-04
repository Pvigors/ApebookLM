export function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function boundedJson(
  response: Response,
  maxBytes: number
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error("sidecar_response_too_large");
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel("sidecar_response_too_large").catch(() => {});
          throw new Error("sidecar_response_too_large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("sidecar_invalid_json");
  }
}

export function abortLike(error: unknown): boolean {
  const name = (error as { name?: string })?.name || "";
  const msg = error instanceof Error ? error.message : String(error);
  return name === "AbortError" || name === "TimeoutError" || /aborted|cancel(?:l)?ed|timeout|取消|超时/i.test(msg);
}

export function safeSidecarError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg
    .replace(/(?:sk|tvly)-[A-Za-z0-9_-]+/g, "key-***")
    .replace(/https?:\/\/[^\s/]+/g, "sidecar")
    .slice(0, 120);
}
