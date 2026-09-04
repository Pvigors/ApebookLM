import { createHash } from "node:crypto";
import { assertSafePublicHttpUrl } from "../ssrf";
import { crawl4aiConfig, internalProcessorBaseUrl } from "./config";
import { abortLike, boundedJson, combinedSignal } from "./http";
import type { ExtractedSource, ExtractionFallbackCode } from "./types";

type Crawl4AiResponse = {
  url?: unknown;
  filter?: unknown;
  markdown?: unknown;
  success?: unknown;
};

export class Crawl4AiExtractionError extends Error {
  fallbackCode: ExtractionFallbackCode;
  status?: number;
  constructor(message: string, code: ExtractionFallbackCode, status?: number) {
    super(message);
    this.name = "Crawl4AiExtractionError";
    this.fallbackCode = code;
    this.status = status;
  }
}

function markdownOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const record = value as { fit_markdown?: unknown; raw_markdown?: unknown; markdown_with_citations?: unknown };
  for (const candidate of [record.fit_markdown, record.markdown_with_citations, record.raw_markdown]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function titleFromMarkdown(markdown: string, rawUrl: string): { title: string; source: "markdown_h1" | "url" } {
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+/g, " ").trim();
  if (h1) return { title: h1.slice(0, 200), source: "markdown_h1" };
  try {
    const url = new URL(rawUrl);
    const tail = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "").replace(/[-_]+/g, " ").trim();
    return { title: (tail || url.hostname).slice(0, 200), source: "url" };
  } catch {
    return { title: rawUrl.slice(0, 200), source: "url" };
  }
}

export async function extractUrlWithCrawl4Ai(
  rawUrl: string,
  opts: { signal?: AbortSignal } = {}
): Promise<ExtractedSource> {
  const cfg = crawl4aiConfig();
  if (cfg.mode === "off") throw new Crawl4AiExtractionError("crawl4ai_disabled", "disabled");
  if (!cfg.url) throw new Crawl4AiExtractionError("crawl4ai_url_missing", "unavailable");
  await assertSafePublicHttpUrl(rawUrl);
  const base = internalProcessorBaseUrl(cfg.url, "Crawl4AI");
  const started = Date.now();
  try {
    const response = await fetch(`${base}/md`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({ url: rawUrl, f: "fit", q: null, c: "0" }),
      signal: combinedSignal(opts.signal, cfg.timeoutMs),
    });
    if (!response.ok) {
      throw new Crawl4AiExtractionError(
        `crawl4ai_http_${response.status}`,
        response.status === 401 || response.status === 403 ? "auth" : "unavailable",
        response.status
      );
    }
    const payload = (await boundedJson(response, cfg.maxOutputBytes)) as Crawl4AiResponse;
    if (payload?.success !== true) {
      throw new Crawl4AiExtractionError("crawl4ai_unsuccessful", "invalid_response");
    }
    const text = markdownOf(payload.markdown);
    if (!text) throw new Crawl4AiExtractionError("crawl4ai_empty_output", "invalid_response");
    const title = titleFromMarkdown(text, rawUrl);
    return {
      title: title.title,
      text,
      provenance: {
        schemaVersion: 1,
        requestedBackend: "crawl4ai",
        effectiveBackend: "crawl4ai",
        backendVersion: cfg.version,
        outputSha256: createHash("sha256").update(text, "utf8").digest("hex"),
        outputChars: text.length,
        elapsedMs: Date.now() - started,
        partial: false,
        titleSource: title.source,
      },
    };
  } catch (error) {
    if (error instanceof Crawl4AiExtractionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Crawl4AiExtractionError(
      abortLike(error) ? "crawl4ai_timeout" : "crawl4ai_unavailable",
      abortLike(error)
        ? "timeout"
        : /too_large|oversize/i.test(message)
          ? "oversize"
          : /invalid_json/i.test(message)
            ? "invalid_response"
            : "unavailable"
    );
  }
}
