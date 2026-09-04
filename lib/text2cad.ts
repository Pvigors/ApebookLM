import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  canonicalText2CadDesignHash,
  canonicalText2CadDesignJson,
  type Text2CadDesignSpec,
} from "./text2cad-spec";
import { validateCadStepRoundTrip, type CadStepValidation } from "./cad-step-validation";
import type { CadDxfProjection } from "./cad";

export const TEXT2CAD_DIR = path.join(process.cwd(), ".data", "cad");
export const TEXT2CAD_TMP_DIR = path.join(process.cwd(), ".data", "cad-tmp");
const TEXT2CAD_WORKER_TIMEOUT_MS = 180_000;
const execFileAsync = promisify(execFile);
type Text2CadHealthResult = { ok: true } | { ok: false; error: string };
type Text2CadHealthState = {
  cache: { at: number; result: Text2CadHealthResult } | null;
  inFlight: Promise<Text2CadHealthResult> | null;
};
const runtimeProcess = process as unknown as { __nbText2CadHealth?: Text2CadHealthState };
const healthState = (runtimeProcess.__nbText2CadHealth ??= { cache: null, inFlight: null });

/**
 * message 可安全展示给用户；repairHint 只供服务端受控修复循环读取，不能下发客户端。
 */
export class Text2CadRenderError extends Error {
  declare readonly repairHint: string;

  constructor(message: string, repairHint: string) {
    super(message);
    this.name = "Text2CadRenderError";
    Object.defineProperty(this, "repairHint", {
      value: repairHint.slice(0, 1_000),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

export type Text2CadManifestPart = {
  id: string;
  name: string;
  material: string;
  color: string;
  featureCount: number;
  volumeMm3: number;
  bounds: number[][];
  faceCount: number;
  edgeCount: number;
  triangleCount: number;
};

export type Text2CadFeatureHistoryItem = {
  partId: string;
  featureId: string;
  kind: "extrude";
  operation: "new" | "add" | "cut" | "intersect";
  requirementRefs: string[];
  volumeMm3: number;
  bounds: number[][];
};

export type Text2CadManifest = {
  manifestVersion: 2;
  libraryVersion: 2;
  schemaVersion: 2;
  hash: string;
  template: "text2cad";
  engine: string;
  engineVersion: string;
  kernel: string;
  unit: "mm";
  process: string;
  artifactMode: "single_part" | "assembly";
  partCount: number;
  parts: Text2CadManifestPart[];
  partsHash: string;
  featureHistory: Text2CadFeatureHistoryItem[];
  validation: {
    brepValid: boolean;
    solidCount: number;
    volumePositive: boolean;
    filesPresent: boolean;
    partsSingleSolid: boolean;
    interferenceFree: boolean;
  };
  bounds: number[][];
  volumeMm3: number;
  faceCount: number;
  edgeCount: number;
  triangleCount: number;
  dxfProjection: CadDxfProjection;
  renderMs: number;
  files: Record<string, { name: string; bytes?: number; sha256?: string }>;
  stepValidation: CadStepValidation;
};

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function isCadDxfProjection(value: unknown): value is CadDxfProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const projection = value as Partial<CadDxfProjection>;
  return projection.version === 1
    && projection.view === "top"
    && projection.plane === "XY"
    && projection.unit === "mm"
    && projection.representation === "projected_brep_edges"
    && projection.entityType === "LINE"
    && Number.isInteger(projection.lineCount)
    && Number(projection.lineCount) > 0
    && Array.isArray(projection.bounds)
    && projection.bounds.length === 2
    && projection.bounds.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
}

function workerErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const stderr = typeof (error as Error & { stderr?: unknown }).stderr === "string"
      ? (error as Error & { stderr: string }).stderr.trim().slice(-800)
      : "";
    return [error.message, stderr].filter(Boolean).join("；").slice(0, 1_000);
  }
  return String(error).slice(0, 1_000);
}

function assertCadTempPath(value: string): void {
  const resolved = path.resolve(value);
  const root = path.resolve(TEXT2CAD_TMP_DIR);
  if (!resolved.startsWith(`${root}${path.sep}tmp-`)) throw new Error("Text2CAD 临时目录越界");
}

function isFiniteBounds(value: unknown): value is number[][] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((point) => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite));
}

function isManifestPart(value: unknown): value is Text2CadManifestPart {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as Partial<Text2CadManifestPart>;
  return typeof part.id === "string"
    && typeof part.name === "string"
    && typeof part.material === "string"
    && typeof part.color === "string"
    && Number.isInteger(part.featureCount) && Number(part.featureCount) > 0
    && Number.isFinite(part.volumeMm3) && Number(part.volumeMm3) > 0
    && isFiniteBounds(part.bounds)
    && Number.isInteger(part.faceCount) && Number(part.faceCount) > 0
    && Number.isInteger(part.edgeCount) && Number(part.edgeCount) > 0
    && Number.isInteger(part.triangleCount) && Number(part.triangleCount) > 0;
}

function isText2CadManifest(value: unknown): value is Text2CadManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<Text2CadManifest>;
  if (!Array.isArray(manifest.parts) || manifest.parts.length < 1 || manifest.parts.length > 24) return false;
  if (!manifest.parts.every(isManifestPart)) return false;
  const partIds = new Set(manifest.parts.map((part) => part.id));
  if (partIds.size !== manifest.parts.length) return false;
  if (!Array.isArray(manifest.featureHistory) || manifest.featureHistory.length < manifest.parts.length) return false;
  const historyValid = manifest.featureHistory.every((item) => (
    item
    && typeof item === "object"
    && typeof item.partId === "string"
    && partIds.has(item.partId)
    && typeof item.featureId === "string"
    && item.kind === "extrude"
    && ["new", "add", "cut", "intersect"].includes(item.operation)
    && Array.isArray(item.requirementRefs)
    && item.requirementRefs.every((ref) => typeof ref === "string")
    && Number.isFinite(item.volumeMm3)
    && item.volumeMm3 > 0
    && isFiniteBounds(item.bounds)
  ));
  if (!historyValid) return false;
  const expectedMode = manifest.parts.length === 1 ? "single_part" : "assembly";
  return manifest.manifestVersion === 2
    && manifest.libraryVersion === 2
    && manifest.schemaVersion === 2
    && manifest.template === "text2cad"
    && manifest.unit === "mm"
    && typeof manifest.process === "string" && manifest.process.length > 0 && manifest.process.length <= 120
    && typeof manifest.hash === "string" && /^[a-f0-9]{64}$/.test(manifest.hash)
    && manifest.artifactMode === expectedMode
    && manifest.partCount === manifest.parts.length
    && typeof manifest.partsHash === "string"
    && manifest.partsHash === sha256(JSON.stringify(manifest.parts))
    && manifest.validation?.brepValid === true
    && manifest.validation?.solidCount === manifest.parts.length
    && manifest.validation?.volumePositive === true
    && manifest.validation?.filesPresent === true
    && manifest.validation?.partsSingleSolid === true
    && manifest.validation?.interferenceFree === true
    && isCadDxfProjection(manifest.dxfProjection)
    && isFiniteBounds(manifest.bounds)
    && Number.isFinite(manifest.volumeMm3) && Number(manifest.volumeMm3) > 0
    && Number.isInteger(manifest.faceCount) && Number(manifest.faceCount) > 0
    && Number.isInteger(manifest.edgeCount) && Number(manifest.edgeCount) > 0
    && Number.isInteger(manifest.triangleCount) && Number(manifest.triangleCount) > 0
    && Number.isFinite(manifest.renderMs) && Number(manifest.renderMs) >= 0;
}

async function verifyBundleFiles(tmpDir: string, manifest: Text2CadManifest, designHash: string): Promise<void> {
  const expected = {
    step: "model.step",
    stl: "model.stl",
    dxf: "top-view.dxf",
    mesh: "mesh.json",
    spec: "design-spec.json",
  } as const;
  for (const [key, name] of Object.entries(expected)) {
    const entry = manifest.files[key];
    if (!entry || entry.name !== name || !Number.isInteger(entry.bytes) || Number(entry.bytes) <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) {
      throw new Error(`Text2CAD 清单中的 ${key} 文件信息无效`);
    }
    const content = await readFile(path.join(tmpDir, name));
    if (content.length !== entry.bytes || sha256(content) !== entry.sha256) {
      throw new Error(`Text2CAD ${key} 文件与清单不一致`);
    }
  }
  if (manifest.files.spec.sha256 !== designHash) throw new Error("Text2CAD 规格文件 hash 不一致");
}

async function probeText2CadRuntimeHealth(): Promise<Text2CadHealthResult> {
  const files = [
    path.join(process.cwd(), "scripts", "text2cad-worker.mjs"),
    path.join(process.cwd(), "scripts", "cad-health.mjs"),
    path.join(process.cwd(), "scripts", "cad-step-validator.mjs"),
    path.join(process.cwd(), "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm"),
  ];
  try {
    await Promise.all(files.map((file) => access(file)));
    const major = Number(process.versions.node.split(".")[0] || 0);
    if (major < 20) {
      return { ok: false as const, error: "Text2CAD 几何内核需要 Node.js 20 或更高版本" };
    }
    await execFileAsync(process.execPath, [path.join(process.cwd(), "scripts", "cad-health.mjs")], {
      cwd: process.cwd(),
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
      env: { PATH: process.env.PATH || "", NODE_ENV: process.env.NODE_ENV || "production", TZ: "UTC" },
    });
    return { ok: true as const };
  } catch {
    return { ok: false as const, error: "Text2CAD 几何内核尚未就绪，请联系管理员完成运行时部署" };
  }
}

/** 扣积分前的轻量健康门：验证固定工人、内核资源和实际 WASM 几何执行。冷启动并发只允许一次探测。 */
export function text2cadRuntimeHealth(): Promise<Text2CadHealthResult> {
  if (healthState.cache && Date.now() - healthState.cache.at < 60_000) {
    return Promise.resolve(healthState.cache.result);
  }
  if (healthState.inFlight) return healthState.inFlight;
  const run = probeText2CadRuntimeHealth()
    .then((result) => {
      healthState.cache = { at: Date.now(), result };
      return result;
    })
    .finally(() => {
      if (healthState.inFlight === run) healthState.inFlight = null;
    });
  healthState.inFlight = run;
  return run;
}

export async function renderText2CadSpec(
  spec: Text2CadDesignSpec,
  signal?: AbortSignal,
  hooks?: { onGeometryBuilt?: () => Promise<void>; onStepValidation?: () => Promise<void> }
): Promise<{
  content: string;
  tmpDir: string;
  manifest: Text2CadManifest;
}> {
  const content = canonicalText2CadDesignJson(spec);
  const hash = canonicalText2CadDesignHash(spec);
  await Promise.all([mkdir(TEXT2CAD_DIR, { recursive: true }), mkdir(TEXT2CAD_TMP_DIR, { recursive: true })]);
  const tmpDir = await mkdtemp(path.join(TEXT2CAD_TMP_DIR, "tmp-text2cad-"));
  assertCadTempPath(tmpDir);
  const inputPath = path.join(tmpDir, `input-${randomUUID()}.json`);
  await writeFile(inputPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await execFileAsync(
      process.execPath,
      ["--max-old-space-size=1024", path.join(process.cwd(), "scripts", "text2cad-worker.mjs"), inputPath, tmpDir, hash],
      {
        cwd: process.cwd(),
        timeout: TEXT2CAD_WORKER_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        signal,
        // 几何工人不需要模型、数据库或对象存储凭据。
        env: { PATH: process.env.PATH || "", NODE_ENV: process.env.NODE_ENV || "production", TZ: "UTC" },
      }
    );
    await rm(inputPath, { force: true });
    const manifestValue: unknown = JSON.parse(await readFile(path.join(tmpDir, "manifest.json"), "utf8"));
    if (!isText2CadManifest(manifestValue) || manifestValue.hash !== hash) {
      throw new Error("Text2CAD 几何工人返回的清单无效");
    }
    await verifyBundleFiles(tmpDir, manifestValue, hash);
    await hooks?.onGeometryBuilt?.();
    await hooks?.onStepValidation?.();
    manifestValue.stepValidation = await validateCadStepRoundTrip({
      tmpDir,
      solidCount: manifestValue.validation.solidCount,
      bounds: manifestValue.bounds,
      volumeMm3: manifestValue.volumeMm3,
      faceCount: manifestValue.faceCount,
      edgeCount: manifestValue.edgeCount,
      parts: manifestValue.parts.map((part) => ({
        name: part.name,
        bounds: part.bounds,
        volumeMm3: part.volumeMm3,
      })),
      signal,
    });
    await writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifestValue), { encoding: "utf8" });
    return { content, tmpDir, manifest: manifestValue };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const repairHint = workerErrorSummary(error);
    console.warn("[text2cad] 几何工人失败:", repairHint);
    const timeout = signal?.aborted || (error instanceof Error && /timed out|SIGKILL|AbortError/i.test(error.message));
    throw new Text2CadRenderError(
      timeout
        ? "Text2CAD 几何计算超时，请减少部件或特征数量后重试"
        : "Text2CAD 几何计算失败，请检查轮廓、布尔关系、放置位置和部件干涉后重试",
      repairHint
    );
  }
}

/** 正式包仍进入既有 cad 目录，以复用下载、删除、备份与回滚链路。 */
export async function commitText2CadBundle(tmpDir: string, outputId: string): Promise<void> {
  assertCadTempPath(tmpDir);
  if (!/^[a-f0-9-]{36}$/i.test(outputId)) throw new Error("Text2CAD 制品 ID 无效");
  await rename(tmpDir, path.join(TEXT2CAD_DIR, outputId));
}

export async function discardText2CadTemp(tmpDir: string): Promise<void> {
  assertCadTempPath(tmpDir);
  await rm(tmpDir, { recursive: true, force: true });
}

/** 只清理 tmp-text2cad-*，保留 24 小时安全窗，不碰其他 CAD 工人的临时包。 */
export async function cleanupStaleText2CadTemps(maxAgeMs = 24 * 60 * 60 * 1_000): Promise<number> {
  const entries = await readdir(TEXT2CAD_TMP_DIR, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("tmp-text2cad-")) continue;
    const fullPath = path.join(TEXT2CAD_TMP_DIR, entry.name);
    const info = await stat(fullPath).catch(() => null);
    if (!info || now - info.mtimeMs < maxAgeMs) continue;
    await rm(fullPath, { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}
