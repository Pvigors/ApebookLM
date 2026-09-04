import { createHash } from "node:crypto";
import { doclingConfig, internalProcessorBaseUrl } from "./config";
import { abortLike, boundedJson, combinedSignal } from "./http";
import type { ExtractedSource, ExtractionFallbackCode } from "./types";

type DoclingResponse = {
  document?: {
    md_content?: unknown;
    text_content?: unknown;
    json_content?: unknown;
  };
  status?: unknown;
  processing_time?: unknown;
};

function pagesOf(value: unknown): number {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return 0; }
  }
  if (!parsed || typeof parsed !== "object") return 0;
  const record = parsed as { pages?: unknown; num_pages?: unknown };
  if (Array.isArray(record.pages)) return record.pages.length;
  if (record.pages && typeof record.pages === "object") return Object.keys(record.pages).length;
  const count = Number(record.num_pages);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function fallbackCode(error: unknown): ExtractionFallbackCode {
  const status = Number((error as { status?: number })?.status || 0);
  if (status === 401 || status === 403) return "auth";
  if (abortLike(error)) return "timeout";
  if (/too_large|oversize/i.test(String((error as Error)?.message))) return "oversize";
  if (/invalid|empty|status/i.test(String((error as Error)?.message))) return "invalid_response";
  return "unavailable";
}

export class DoclingExtractionError extends Error {
  fallbackCode: ExtractionFallbackCode;
  status?: number;
  constructor(message: string, code: ExtractionFallbackCode, status?: number) {
    super(message);
    this.name = "DoclingExtractionError";
    this.fallbackCode = code;
    this.status = status;
  }
}

export async function extractPdfWithDocling(
  bytes: ArrayBuffer,
  opts: { filename?: string; signal?: AbortSignal } = {}
): Promise<ExtractedSource> {
  const cfg = doclingConfig();
  if (cfg.mode === "off") throw new DoclingExtractionError("docling_disabled", "disabled");
  if (!cfg.url) throw new DoclingExtractionError("docling_url_missing", "unavailable");
  if (bytes.byteLength > cfg.maxBytes) throw new DoclingExtractionError("docling_input_oversize", "oversize");
  const base = internalProcessorBaseUrl(cfg.url, "Docling");
  const started = Date.now();
  const form = new FormData();
  form.append("files", new Blob([bytes], { type: "application/pdf" }), opts.filename || "document.pdf");
  form.append("from_formats", "pdf");
  form.append("to_formats", "md");
  form.append("to_formats", "json");
  form.append("target_type", "inbody");
  form.append("image_export_mode", "placeholder");
  form.append("do_ocr", "true");
  form.append("force_ocr", "false");
  form.append("do_table_structure", "true");
  form.append("table_mode", "accurate");
  form.append("do_pdf_heading_hierarchy", "true");
  form.append("include_images", "false");
  form.append("include_page_images", "false");
  form.append("document_timeout", "50");
  form.append("md_page_break_placeholder", "<!-- nblm-page-break -->");
  form.append("abort_on_error", "true");
  if (cfg.formulaEnrichment) form.append("do_formula_enrichment", "true");
  try {
    const response = await fetch(`${base}/v1/convert/file`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...(cfg.apiKey ? { "X-Api-Key": cfg.apiKey } : {}),
      },
      body: form,
      signal: combinedSignal(opts.signal, cfg.timeoutMs),
    });
    if (!response.ok) {
      throw new DoclingExtractionError(
        `docling_http_${response.status}`,
        response.status === 401 || response.status === 403 ? "auth" : "unavailable",
        response.status
      );
    }
    const payload = (await boundedJson(response, cfg.maxOutputBytes)) as DoclingResponse;
    const status = String(payload?.status || "");
    if (status !== "success" && status !== "partial_success") {
      throw new DoclingExtractionError(`docling_status_${status || "missing"}`, "invalid_response");
    }
    const markdown = typeof payload.document?.md_content === "string"
      ? payload.document.md_content.trim()
      : "";
    const text = markdown || (typeof payload.document?.text_content === "string"
      ? payload.document.text_content.trim()
      : "");
    if (!text) throw new DoclingExtractionError("docling_empty_output", "invalid_response");
    const pages = pagesOf(payload.document?.json_content);
    return {
      text,
      pages,
      provenance: {
        schemaVersion: 1,
        requestedBackend: "docling",
        effectiveBackend: "docling",
        backendVersion: cfg.version,
        inputSha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
        outputSha256: createHash("sha256").update(text, "utf8").digest("hex"),
        outputChars: text.length,
        pages,
        elapsedMs: Date.now() - started,
        partial: status === "partial_success",
      },
    };
  } catch (error) {
    if (error instanceof DoclingExtractionError) throw error;
    throw new DoclingExtractionError(
      abortLike(error) ? "docling_timeout" : "docling_unavailable",
      fallbackCode(error)
    );
  }
}
