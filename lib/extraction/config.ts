import net from "node:net";
import { isPrivateIp } from "../ssrf";
import type { ExternalExtractionMode } from "./types";

function mode(value: string | undefined): ExternalExtractionMode {
  return value === "shadow" || value === "primary" ? value : "off";
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * 文档/网页正文会被完整发送给 sidecar。默认只允许本机、Docker 单标签和私网地址，
 * 避免误把敏感来源发给公网 SaaS。确需受控公网处理器必须由运维显式放行。
 */
export function internalProcessorBaseUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} 地址无效`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} 仅支持不含凭据、查询参数和片段的 http(s) 服务地址`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ip = net.isIP(host);
  const managedDockerService = new Set(["docling", "crawl4ai", "litellm-gateway"]).has(host);
  const internal =
    host === "localhost" ||
    host === "host.docker.internal" ||
    managedDockerService ||
    (ip > 0 && isPrivateIp(host)) ||
    host.endsWith(".internal") ||
    host.endsWith(".local");
  if (!internal && process.env.NBLM_EXTERNAL_PROCESSOR_ALLOW_PUBLIC !== "1") {
    throw new Error(`${name} 默认只能使用内网地址；公网处理器需显式授权`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function doclingConfig() {
  return {
    mode: mode(process.env.NBLM_DOCLING_MODE),
    url: process.env.NBLM_DOCLING_URL?.trim() || "",
    apiKey: process.env.NBLM_DOCLING_API_KEY?.trim() || "",
    version: process.env.NBLM_DOCLING_VERSION?.trim() || "v1.31.0",
    timeoutMs: boundedInt(process.env.NBLM_DOCLING_TIMEOUT_MS, 60_000, 5_000, 120_000),
    maxBytes: boundedInt(process.env.NBLM_DOCLING_MAX_BYTES, 25 * 1024 * 1024, 1, 100 * 1024 * 1024),
    maxOutputBytes: boundedInt(process.env.NBLM_DOCLING_MAX_OUTPUT_BYTES, 8 * 1024 * 1024, 1024, 32 * 1024 * 1024),
    formulaEnrichment: process.env.NBLM_DOCLING_FORMULA_ENRICHMENT === "1",
  };
}

export function crawl4aiConfig() {
  return {
    mode: mode(process.env.NBLM_CRAWL4AI_MODE),
    url: process.env.NBLM_CRAWL4AI_URL?.trim() || "",
    token: process.env.NBLM_CRAWL4AI_API_TOKEN?.trim() || "",
    version: process.env.NBLM_CRAWL4AI_VERSION?.trim() || "v0.9.2",
    timeoutMs: boundedInt(process.env.NBLM_CRAWL4AI_TIMEOUT_MS, 25_000, 3_000, 60_000),
    maxOutputBytes: boundedInt(process.env.NBLM_CRAWL4AI_MAX_OUTPUT_BYTES, 4 * 1024 * 1024, 1024, 16 * 1024 * 1024),
  };
}
