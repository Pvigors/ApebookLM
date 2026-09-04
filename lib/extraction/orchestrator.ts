import { createHash } from "node:crypto";
import { hasSubstance, looksBoilerplate } from "../corpus";
import { extractPdf, extractUrl } from "../extract";
import { getFeatureFlag } from "../flags";
import { crawl4aiConfig, doclingConfig } from "./config";
import { Crawl4AiExtractionError, extractUrlWithCrawl4Ai } from "./crawl4ai";
import { DoclingExtractionError, extractPdfWithDocling } from "./docling";
import { safeSidecarError } from "./http";
import type { ExtractedSource, ExtractionBackend, ExtractionFallbackCode } from "./types";

function nativeResult(
  requestedBackend: ExtractionBackend,
  value: { title?: string; text: string; pages?: number },
  started: number,
  extra: { fallbackCode?: ExtractionFallbackCode; shadow?: boolean; inputSha256?: string } = {}
): ExtractedSource {
  return {
    ...value,
    provenance: {
      schemaVersion: 1,
      requestedBackend,
      effectiveBackend: "native",
      outputSha256: createHash("sha256").update(value.text, "utf8").digest("hex"),
      outputChars: value.text.length,
      pages: value.pages,
      elapsedMs: Date.now() - started,
      partial: false,
      fallbackCode: extra.fallbackCode,
      shadow: extra.shadow,
      inputSha256: extra.inputSha256,
      titleSource: value.title ? "metadata" : undefined,
    },
  };
}

function usableExternal(value: ExtractedSource): ExtractionFallbackCode | null {
  if (!hasSubstance(value.text)) return "thin";
  if (looksBoilerplate(value.text)) return "boilerplate";
  return null;
}

function externalEnabled(userId: string | null | undefined, key: string): boolean {
  return getFeatureFlag(userId, key);
}

function mustUseNativeUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    return (
      host === "mp.weixin.qq.com" ||
      host === "b23.tv" ||
      host === "youtu.be" ||
      host === "bilibili.com" ||
      host.endsWith(".bilibili.com") ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      /\.pdf$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export async function extractPdfManaged(
  bytes: ArrayBuffer,
  opts: { filename?: string; userId?: string | null; signal?: AbortSignal } = {}
): Promise<ExtractedSource> {
  const cfg = doclingConfig();
  const started = Date.now();
  const inputSha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  const shadowId = inputSha256.slice(0, 16);
  if (cfg.mode === "off") {
    return nativeResult("native", await extractPdf(bytes), started, { fallbackCode: "disabled", inputSha256 });
  }
  if (!externalEnabled(opts.userId, "docling_extract")) {
    return nativeResult("docling", await extractPdf(bytes), started, { fallbackCode: "rollout_miss", inputSha256 });
  }
  if (cfg.mode === "shadow") {
    const external = extractPdfWithDocling(bytes, { filename: opts.filename, signal: opts.signal });
    void external.then((value) => {
      const rejected = usableExternal(value);
      console.info("[extract] Docling shadow:", JSON.stringify({
        event: "docling_shadow",
        shadowId,
        doclingChars: value.text.length,
        doclingPages: value.pages || 0,
        elapsedMs: value.provenance.elapsedMs,
        rejected,
      }));
    }).catch((error) => {
        console.warn("[extract] Docling shadow 失败(忽略):", JSON.stringify({
          event: "docling_shadow",
          shadowId,
          error: safeSidecarError(error),
        }));
    });
    const native = await extractPdf(bytes);
    opts.signal?.throwIfAborted();
    return nativeResult("docling", native, started, { shadow: true, inputSha256 });
  }
  try {
    const external = await extractPdfWithDocling(bytes, { filename: opts.filename, signal: opts.signal });
    const rejected = usableExternal(external);
    if (!rejected) return external;
    const native = await extractPdf(bytes);
    return nativeResult("docling", native, started, { fallbackCode: rejected, inputSha256 });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    console.warn("[extract] Docling 主路径失败，回退 native:", safeSidecarError(error));
    const native = await extractPdf(bytes);
    return nativeResult("docling", native, started, {
      fallbackCode: error instanceof DoclingExtractionError ? error.fallbackCode : "unavailable",
      inputSha256,
    });
  }
}

export async function extractUrlManaged(
  url: string,
  opts: { userId?: string | null; signal?: AbortSignal } = {}
): Promise<ExtractedSource> {
  const cfg = crawl4aiConfig();
  const started = Date.now();
  const shadowId = createHash("sha256").update(url, "utf8").digest("hex").slice(0, 16);
  // PDF 直链仍交给 ApebookLM 自己先安全抓字节，再走现有 PDF/OCR 语义；
  // 首期不让浏览器 sidecar 处理文件下载，避免扩大响应体和凭据面。
  if (mustUseNativeUrl(url)) {
    return nativeResult("native", await extractUrl(url), started, { fallbackCode: "disabled" });
  }
  if (cfg.mode === "off") {
    return nativeResult("native", await extractUrl(url), started, { fallbackCode: "disabled" });
  }
  if (!externalEnabled(opts.userId, "crawl4ai_extract")) {
    return nativeResult("crawl4ai", await extractUrl(url), started, { fallbackCode: "rollout_miss" });
  }
  if (cfg.mode === "shadow") {
    const external = extractUrlWithCrawl4Ai(url, { signal: opts.signal });
    void external.then((value) => {
      const rejected = usableExternal(value);
      console.info("[extract] Crawl4AI shadow:", JSON.stringify({
        event: "crawl4ai_shadow",
        shadowId,
        crawl4aiChars: value.text.length,
        elapsedMs: value.provenance.elapsedMs,
        rejected,
      }));
    }).catch((error) => {
        console.warn("[extract] Crawl4AI shadow 失败(忽略):", JSON.stringify({
          event: "crawl4ai_shadow",
          shadowId,
          error: safeSidecarError(error),
        }));
    });
    const native = await extractUrl(url);
    opts.signal?.throwIfAborted();
    return nativeResult("crawl4ai", native, started, { shadow: true });
  }
  try {
    const external = await extractUrlWithCrawl4Ai(url, { signal: opts.signal });
    const rejected = usableExternal(external);
    if (!rejected) return external;
    return nativeResult("crawl4ai", await extractUrl(url), started, { fallbackCode: rejected });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    console.warn("[extract] Crawl4AI 主路径失败，回退 native:", safeSidecarError(error));
    return nativeResult("crawl4ai", await extractUrl(url), started, {
      fallbackCode: error instanceof Crawl4AiExtractionError ? error.fallbackCode : "unavailable",
    });
  }
}
