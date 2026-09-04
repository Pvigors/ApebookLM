import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function lastJsonObjectLine(stdout: string): string {
  return stdout.trim().split(/\r?\n/).reverse().find((line) => /^\s*\{.*\}\s*$/.test(line)) ?? "";
}

let freeCadHealthCache: { until: number; result: { ok: boolean; version?: string; error?: string } } | null = null;

/** 独立 CAD worker 健康门：原生 FreeCAD 实际导出再导入一个 box，不只是 which 二进制。 */
export async function freeCadStepValidatorHealth(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const now = Date.now();
  if (freeCadHealthCache && freeCadHealthCache.until > now) return freeCadHealthCache.result;
  const binary = process.env.CAD_EXTERNAL_STEP_VALIDATOR_BIN?.trim() ?? "";
  if (!binary || !path.isAbsolute(binary)) {
    const result = { ok: false, error: "FreeCAD STEP 复读器未配置" };
    freeCadHealthCache = { until: now + 5_000, result };
    return result;
  }
  try {
    const script = path.join(process.cwd(), "scripts", "freecad-health.py");
    const { stdout } = await execFileAsync(binary, [script], {
      cwd: process.cwd(),
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 128 * 1024,
      windowsHide: true,
      env: {
        PATH: process.env.PATH || "",
        HOME: "/tmp",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        QT_QPA_PLATFORM: "offscreen",
        PYTHONPATH: process.env.PYTHONPATH || "",
        NODE_ENV: process.env.NODE_ENV || "production",
        TZ: "UTC",
      },
    });
    const value = JSON.parse(lastJsonObjectLine(stdout)) as {
      ok?: unknown;
      validator?: unknown;
      version?: unknown;
      solidCount?: unknown;
      volumeMm3?: unknown;
    };
    if (
      value.ok !== true
      || value.validator !== "freecad-native"
      || Number(value.solidCount) !== 1
      || Math.abs(Number(value.volumeMm3) - 1_000) > 0.1
    ) {
      throw new Error("FreeCAD 健康几何不一致");
    }
    const result = {
      ok: true,
      version: typeof value.version === "string" ? value.version.slice(0, 40) : "unknown",
    };
    freeCadHealthCache = { until: now + 60_000, result };
    return result;
  } catch (error) {
    const result = {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 160) : "FreeCAD 健康检查失败",
    };
    freeCadHealthCache = { until: now + 5_000, result };
    return result;
  }
}

export type CadStepValidation = Readonly<{
  roundTripValid: true;
  validator: "replicad-isolated";
  schema: string;
  unit: "mm";
  brepValid: true;
  solidCount: number;
  faceCount: number;
  edgeCount: number;
  bounds: number[][];
  volumeMm3: number;
  partGeometryValid?: true;
  externalValidation?: Readonly<{
    validator: "freecad-native";
    version: string;
    schema: string;
    unit: "mm";
    brepValid: true;
    solidCount: number;
    faceCount: number;
    edgeCount: number;
    bounds: number[][];
    volumeMm3: number;
    partGeometryValid?: true;
  }>;
}>;

function isFiniteBounds(value: unknown): value is number[][] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((point) => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite));
}

const toleranceFor = (expected: number) => Math.max(0.05, Math.abs(expected) * 0.0005);

function boundsMatch(actual: number[][], expected: number[][]): boolean {
  return isFiniteBounds(actual) && isFiniteBounds(expected) && expected.every((point, side) => (
    point.every((value, axis) => Math.abs(actual[side][axis] - value) <= toleranceFor(value))
  ));
}

type ExternalFreeCadResult = {
  ok?: unknown;
  validator?: unknown;
  version?: unknown;
  schema?: unknown;
  unit?: unknown;
  brepValid?: unknown;
  solidCount?: unknown;
  faceCount?: unknown;
  edgeCount?: unknown;
  bounds?: unknown;
  volumeMm3?: unknown;
  parts?: unknown;
};

async function validateWithFreeCad(args: {
  stepPath: string;
  solidCount: number;
  bounds: number[][];
  volumeMm3: number;
  faceCount: number;
  edgeCount: number;
  parts: ReadonlyArray<{ name: string; bounds: number[][]; volumeMm3: number }>;
  signal?: AbortSignal;
}): Promise<CadStepValidation["externalValidation"] | undefined> {
  const required = process.env.CAD_REQUIRE_EXTERNAL_STEP_VALIDATOR === "1";
  const binary = process.env.CAD_EXTERNAL_STEP_VALIDATOR_BIN?.trim() ?? "";
  if (!binary) {
    if (required) throw new Error("生产 CAD 未配置独立 FreeCAD STEP 复读器");
    return undefined;
  }
  if (!path.isAbsolute(binary)) throw new Error("FreeCAD STEP 复读器必须使用绝对路径");
  const script = path.join(process.cwd(), "scripts", "freecad-step-validator.py");
  const { stdout } = await execFileAsync(binary, [script, args.stepPath], {
    cwd: process.cwd(),
    timeout: 90_000,
    killSignal: "SIGKILL",
    maxBuffer: 512 * 1024,
    windowsHide: true,
    signal: args.signal,
    env: {
      PATH: process.env.PATH || "",
      HOME: "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      QT_QPA_PLATFORM: "offscreen",
      PYTHONPATH: process.env.PYTHONPATH || "",
      NODE_ENV: process.env.NODE_ENV || "production",
      TZ: "UTC",
    },
  });
  const line = lastJsonObjectLine(stdout);
  const result = JSON.parse(line) as ExternalFreeCadResult;
  const volume = Number(result.volumeMm3);
  const volumeTolerance = Math.max(0.1, Math.abs(args.volumeMm3) * 0.001);
  if (
    result.ok !== true
    || result.validator !== "freecad-native"
    || result.unit !== "mm"
    || result.brepValid !== true
    || Number(result.solidCount) !== args.solidCount
    || Number(result.faceCount) !== args.faceCount
    || Number(result.edgeCount) !== args.edgeCount
    || !isFiniteBounds(result.bounds)
    || !boundsMatch(result.bounds, args.bounds)
    || !Number.isFinite(volume)
    || Math.abs(volume - args.volumeMm3) > volumeTolerance
  ) {
    throw new Error("FreeCAD 独立 STEP 复读与冻结几何摘要不一致");
  }
  const actualParts = Array.isArray(result.parts)
    ? result.parts.flatMap((part) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return [];
        const value = part as { bounds?: unknown; volumeMm3?: unknown };
        return isFiniteBounds(value.bounds) && Number.isFinite(Number(value.volumeMm3))
          ? [{ bounds: value.bounds, volumeMm3: Number(value.volumeMm3) }]
          : [];
      })
    : [];
  if (args.parts.length) {
    if (actualParts.length !== args.parts.length) throw new Error("FreeCAD 独立 STEP 零件数不一致");
    const unused = new Set(actualParts.map((_, index) => index));
    for (const expected of args.parts) {
      const match = [...unused].find((index) => {
        const actual = actualParts[index];
        const partVolumeTolerance = Math.max(0.1, Math.abs(expected.volumeMm3) * 0.001);
        return boundsMatch(actual.bounds, expected.bounds)
          && Math.abs(actual.volumeMm3 - expected.volumeMm3) <= partVolumeTolerance;
      });
      if (match === undefined) throw new Error(`FreeCAD 独立 STEP 零件几何不一致:${expected.name.slice(0, 80)}`);
      unused.delete(match);
    }
  }
  return {
    validator: "freecad-native",
    version: typeof result.version === "string" ? result.version.slice(0, 40) : "unknown",
    schema: typeof result.schema === "string" ? result.schema.slice(0, 40) : "STEP",
    unit: "mm",
    brepValid: true,
    solidCount: args.solidCount,
    faceCount: args.faceCount,
    edgeCount: args.edgeCount,
    bounds: result.bounds,
    volumeMm3: volume,
    ...(args.parts.length ? { partGeometryValid: true as const } : {}),
  };
}

export async function validateCadStepRoundTrip(args: {
  tmpDir: string;
  solidCount: number;
  bounds: number[][];
  volumeMm3: number;
  faceCount: number;
  edgeCount: number;
  parts?: ReadonlyArray<{ name: string; bounds: number[][]; volumeMm3: number }>;
  signal?: AbortSignal;
}): Promise<CadStepValidation> {
  const stepPath = path.join(args.tmpDir, "model.step");
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--max-old-space-size=768",
      path.join(process.cwd(), "scripts", "cad-step-validator.mjs"),
      stepPath,
      JSON.stringify({
        solidCount: args.solidCount,
        bounds: args.bounds,
        volumeMm3: args.volumeMm3,
        faceCount: args.faceCount,
        edgeCount: args.edgeCount,
        parts: args.parts ?? [],
      }),
    ],
    {
      cwd: process.cwd(),
      timeout: 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 512 * 1024,
      windowsHide: true,
      signal: args.signal,
      env: { PATH: process.env.PATH || "", NODE_ENV: process.env.NODE_ENV || "production", TZ: "UTC" },
    }
  );
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("STEP 独立回读返回无效");
  const result = value as Partial<CadStepValidation> & { ok?: unknown };
  if (
    result.ok !== true
    || result.validator !== "replicad-isolated"
    || result.unit !== "mm"
    || result.brepValid !== true
    || result.solidCount !== args.solidCount
    || result.faceCount !== args.faceCount
    || result.edgeCount !== args.edgeCount
    || !isFiniteBounds(result.bounds)
    || !Number.isFinite(result.volumeMm3)
    || Number(result.volumeMm3) <= 0
  ) {
    throw new Error("STEP 独立回读校验失败");
  }
  const externalValidation = await validateWithFreeCad({
    stepPath,
    solidCount: args.solidCount,
    bounds: args.bounds,
    volumeMm3: args.volumeMm3,
    faceCount: args.faceCount,
    edgeCount: args.edgeCount,
    parts: args.parts ?? [],
    signal: args.signal,
  });
  return {
    roundTripValid: true,
    validator: "replicad-isolated",
    schema: typeof result.schema === "string" ? result.schema.slice(0, 40) : "STEP",
    unit: "mm",
    brepValid: true,
    solidCount: result.solidCount,
    faceCount: result.faceCount,
    edgeCount: result.edgeCount,
    bounds: result.bounds,
    volumeMm3: Number(result.volumeMm3),
    ...(args.parts?.length ? { partGeometryValid: true as const } : {}),
    ...(externalValidation ? { externalValidation } : {}),
  };
}
