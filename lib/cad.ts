import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  CAD_TEMPLATES,
  CAD_LIBRARY_VERSION,
  CAD_MANIFEST_VERSION,
  CAD_TEMPLATE_ARTIFACT_MODE,
  CAD_TEMPLATE_EXPECTED_SOLID_COUNT,
  canonicalCadDesignHash,
  canonicalCadDesignJson,
  type CadArtifactMode,
  type CadDesignSpec,
  type CadTemplate,
} from "./cad-spec";
import { validateCadStepRoundTrip, type CadStepValidation } from "./cad-step-validation";
import { CadContractError } from "./cad-errors";

export const CAD_DIR = path.join(process.cwd(), ".data", "cad");
export const CAD_TMP_DIR = path.join(process.cwd(), ".data", "cad-tmp");
const CAD_WORKER_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);
type CadHealthResult = { ok: true } | { ok: false; error: string };
type CadHealthState = {
  cache: { at: number; result: CadHealthResult } | null;
  inFlight: Promise<CadHealthResult> | null;
};

export type CadDxfProjection = {
  version: 1;
  view: "top";
  plane: "XY";
  unit: "mm";
  representation: "projected_brep_edges";
  entityType: "LINE";
  lineCount: number;
  bounds: [[number, number], [number, number]];
};
const runtimeProcess = process as unknown as { __nbCadHealth?: CadHealthState };
const healthState = (runtimeProcess.__nbCadHealth ??= { cache: null, inFlight: null });

export type CadManifest = {
  manifestVersion: typeof CAD_MANIFEST_VERSION;
  libraryVersion: typeof CAD_LIBRARY_VERSION;
  schemaVersion: 1;
  hash: string;
  template: CadTemplate;
  engine: string;
  engineVersion: string;
  kernel: string;
  unit: "mm";
  artifactMode: CadArtifactMode;
  partCount: number;
  validation: {
    brepValid: boolean;
    solidCount: number;
    volumePositive: boolean;
    filesPresent: boolean;
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

async function probeCadRuntimeHealth(): Promise<CadHealthResult> {
  const files = [
    path.join(process.cwd(), "scripts", "cad-worker.mjs"),
    path.join(process.cwd(), "scripts", "cad-health.mjs"),
    path.join(process.cwd(), "scripts", "cad-step-validator.mjs"),
    path.join(process.cwd(), "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm"),
  ];
  try {
    await Promise.all(files.map((file) => access(file)));
    const major = Number(process.versions.node.split(".")[0] || 0);
    if (major < 20) {
      return { ok: false as const, error: "CAD 几何内核需要 Node.js 20 或更高版本" };
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
    return { ok: false as const, error: "CAD 几何内核尚未就绪，请联系管理员完成运行时部署" };
  }
}

/** 扣积分前的轻量健康门；只验证固定工人与 WASM 资源实际随部署产物存在。冷启动并发只允许一次探测。 */
export function cadRuntimeHealth(): Promise<CadHealthResult> {
  if (healthState.cache && Date.now() - healthState.cache.at < 60_000) {
    return Promise.resolve(healthState.cache.result);
  }
  if (healthState.inFlight) return healthState.inFlight;
  const run = probeCadRuntimeHealth()
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

function workerErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const stderr = typeof (error as Error & { stderr?: unknown }).stderr === "string"
      ? (error as Error & { stderr: string }).stderr.trim().slice(-600)
      : "";
    return [error.message, stderr].filter(Boolean).join("；").slice(0, 800);
  }
  return String(error).slice(0, 800);
}

function assertCadTempPath(value: string): void {
  const resolved = path.resolve(value);
  const root = path.resolve(CAD_TMP_DIR);
  if (!resolved.startsWith(`${root}${path.sep}tmp-`)) {
    throw new Error("CAD 临时目录越界");
  }
}

function isCadManifest(value: unknown): value is CadManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<CadManifest>;
  if (typeof manifest.template !== "string" || !(CAD_TEMPLATES as readonly string[]).includes(manifest.template)) {
    return false;
  }
  const template = manifest.template as CadTemplate;
  const expectedSolidCount = CAD_TEMPLATE_EXPECTED_SOLID_COUNT[template];
  return manifest.manifestVersion === CAD_MANIFEST_VERSION
    && manifest.libraryVersion === CAD_LIBRARY_VERSION
    && manifest.schemaVersion === 1
    && typeof manifest.hash === "string"
    && /^[a-f0-9]{64}$/.test(manifest.hash)
    && manifest.unit === "mm"
    && manifest.artifactMode === CAD_TEMPLATE_ARTIFACT_MODE[template]
    && manifest.partCount === expectedSolidCount
    && manifest.validation?.brepValid === true
    && manifest.validation?.solidCount === expectedSolidCount
    && isCadDxfProjection(manifest.dxfProjection)
    && manifest.files?.dxf?.name === "top-view.dxf"
    && Number.isInteger(manifest.files?.dxf?.bytes)
    && Number(manifest.files?.dxf?.bytes) > 0
    && /^[a-f0-9]{64}$/.test(manifest.files?.dxf?.sha256 || "")
    && Number.isFinite(manifest.volumeMm3)
    && Number.isInteger(manifest.triangleCount)
    && Number(manifest.triangleCount) > 0;
}

export async function renderCadSpec(
  spec: CadDesignSpec,
  signal?: AbortSignal,
  hooks?: { onGeometryBuilt?: () => Promise<void>; onStepValidation?: () => Promise<void> }
): Promise<{
  content: string;
  tmpDir: string;
  manifest: CadManifest;
}> {
  const content = canonicalCadDesignJson(spec);
  const hash = canonicalCadDesignHash(spec);
  await Promise.all([mkdir(CAD_DIR, { recursive: true }), mkdir(CAD_TMP_DIR, { recursive: true })]);
  const tmpDir = await mkdtemp(path.join(CAD_TMP_DIR, "tmp-"));
  assertCadTempPath(tmpDir);
  const inputPath = path.join(tmpDir, `input-${randomUUID()}.json`);
  await writeFile(inputPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const workerPath = path.join(process.cwd(), "scripts", "cad-worker.mjs");
  try {
    await execFileAsync(
      process.execPath,
      ["--max-old-space-size=768", workerPath, inputPath, tmpDir, hash],
      {
        cwd: process.cwd(),
        timeout: CAD_WORKER_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        signal,
        // 不把模型、数据库或其它服务密钥传给几何工人。它只需要 Node 模块和时区。
        env: {
          PATH: process.env.PATH || "",
          NODE_ENV: process.env.NODE_ENV || "production",
          TZ: "UTC",
        },
      }
    );
    await rm(inputPath, { force: true });
    const manifestRaw = await readFile(path.join(tmpDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as unknown;
    if (!isCadManifest(manifest) || manifest.hash !== hash) {
      throw new Error("CAD 几何工人返回的清单无效");
    }
    const dxf = await readFile(path.join(tmpDir, "top-view.dxf"));
    if (
      dxf.length !== manifest.files.dxf.bytes
      || createHash("sha256").update(dxf).digest("hex") !== manifest.files.dxf.sha256
    ) {
      throw new Error("CAD DXF 顶视图与清单不一致");
    }
    await hooks?.onGeometryBuilt?.();
    await hooks?.onStepValidation?.();
    manifest.stepValidation = await validateCadStepRoundTrip({
      tmpDir,
      solidCount: manifest.validation.solidCount,
      bounds: manifest.bounds,
      volumeMm3: manifest.volumeMm3,
      faceCount: manifest.faceCount,
      edgeCount: manifest.edgeCount,
      signal,
    });
    await writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest), { encoding: "utf8" });
    return { content, tmpDir, manifest };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const summary = workerErrorSummary(error);
    console.warn("[cad] 几何工人失败:", summary);
    if (/STEP|round.?trip|回读/i.test(summary)) {
      throw new CadContractError({
        code: "cad_step_roundtrip_failed",
        message: "CAD 几何已生成，但 STEP 独立回读校验未通过",
        details: { validator: "replicad-isolated" },
      });
    }
    const message = signal?.aborted || (error instanceof Error && /timed out|SIGKILL|AbortError/i.test(error.message))
      ? "CAD 几何计算超时，请缩小尺寸或减少孔数量后重试"
      : "CAD 几何计算失败，请检查尺寸、壁厚和孔位后重试";
    throw new Error(message);
  }
}

export async function commitCadBundle(tmpDir: string, outputId: string): Promise<void> {
  assertCadTempPath(tmpDir);
  if (!/^[a-f0-9-]{36}$/i.test(outputId)) throw new Error("CAD 制品 ID 无效");
  const destination = path.join(CAD_DIR, outputId);
  await mkdir(CAD_DIR, { recursive: true });
  try {
    await rename(tmpDir, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
  }

  // 生产把 cad-tmp 挂为 tmpfs，正式 cad 目录是数据盘 bind mount；两者
  // 跨文件系统时 rename 必然 EXDEV。先复制到【目标盘】的隐藏随机目录，
  // 逐文件校验字节数后再做同盘 rename，保证 ready 制品从不暴露半包。
  const staging = path.join(CAD_DIR, `.staging-${outputId}-${randomUUID()}`);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    const entries = await readdir(tmpDir, { withFileTypes: true });
    if (!entries.length || entries.some((entry) => (
      !entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)
    ))) {
      throw new Error("CAD 临时文件包结构无效");
    }
    for (const entry of entries) {
      const source = path.join(tmpDir, entry.name);
      const target = path.join(staging, entry.name);
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
      const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);
      if (!sourceStat.isFile() || !targetStat.isFile() || sourceStat.size !== targetStat.size) {
        throw new Error(`CAD 文件跨盘复制校验失败:${entry.name}`);
      }
    }
    await rename(staging, destination);
    // 正式目录已原子可见，清理 tmpfs 失败不得反向把已发布制品判失败。
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function discardCadTemp(tmpDir: string): Promise<void> {
  assertCadTempPath(tmpDir);
  await rm(tmpDir, { recursive: true, force: true });
}

/** 进程崩溃/SIGKILL 留下的临时包清理；只碰 tmp-* 且保留 24 小时安全窗。 */
export async function cleanupStaleCadTemps(maxAgeMs = 24 * 60 * 60 * 1_000): Promise<number> {
  let removed = 0;
  const now = Date.now();
  for (const [root, prefix] of [[CAD_TMP_DIR, "tmp-"], [CAD_DIR, ".staging-"]] as const) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const fullPath = path.join(root, entry.name);
      const info = await stat(fullPath).catch(() => null);
      if (!info || now - info.mtimeMs < maxAgeMs) continue;
      await rm(fullPath, { recursive: true, force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}
