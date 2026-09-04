export type ExtractionBackend = "native" | "docling" | "crawl4ai";

export type ExtractionFallbackCode =
  | "disabled"
  | "rollout_miss"
  | "oversize"
  | "timeout"
  | "unavailable"
  | "auth"
  | "invalid_response"
  | "thin"
  | "boilerplate";

export type ExtractionProvenance = {
  schemaVersion: 1;
  requestedBackend: ExtractionBackend;
  effectiveBackend: ExtractionBackend;
  backendVersion?: string;
  inputSha256?: string;
  outputSha256: string;
  outputChars: number;
  pages?: number;
  elapsedMs: number;
  partial: boolean;
  shadow?: boolean;
  fallbackCode?: ExtractionFallbackCode;
  titleSource?: "metadata" | "markdown_h1" | "url";
};

export type ExtractedSource = {
  title?: string;
  text: string;
  pages?: number;
  provenance: ExtractionProvenance;
};

export type ExternalExtractionMode = "off" | "shadow" | "primary";
