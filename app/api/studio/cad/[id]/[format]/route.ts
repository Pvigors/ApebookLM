import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getStudioOutput } from "@/lib/db";
import { requireAccess } from "@/lib/auth";
import { reqMeta } from "@/lib/activity";
import { rateLimit, rateLimitNotebook, tooMany } from "@/lib/ratelimit";
import { resolveCadArtifactContract } from "@/lib/cad-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CAD_DIR = path.join(process.cwd(), ".data", "cad");

type CadManifest = {
  manifestVersion?: number;
  libraryVersion?: number;
  hash?: string;
  template?: string;
  process?: string;
  artifactMode?: string;
  partCount?: number;
  partsHash?: string;
  faceCount?: number;
  edgeCount?: number;
  volumeMm3?: number;
  dxfProjection?: {
    version?: number;
    view?: string;
    plane?: string;
    unit?: string;
    representation?: string;
    entityType?: string;
    lineCount?: number;
    bounds?: number[][];
  };
  validation?: { brepValid?: boolean; solidCount?: number };
  stepValidation?: {
    roundTripValid?: boolean;
    validator?: string;
    unit?: string;
    brepValid?: boolean;
    solidCount?: number;
    faceCount?: number;
    edgeCount?: number;
    volumeMm3?: number;
    partGeometryValid?: boolean;
    bounds?: number[][];
    externalValidation?: {
      validator?: string;
      version?: string;
      unit?: string;
      brepValid?: boolean;
      solidCount?: number;
      faceCount?: number;
      edgeCount?: number;
      volumeMm3?: number;
      partGeometryValid?: boolean;
      bounds?: number[][];
    };
  };
  files?: Record<string, { bytes?: number; sha256?: string }>;
};

type FrozenCadManifest = Pick<
  CadManifest,
  "manifestVersion" | "libraryVersion" | "hash" | "template" | "process" | "artifactMode" | "partCount" | "partsHash" | "files" | "stepValidation" | "dxfProjection"
>;

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const FORMATS = {
  mesh: { file: "mesh.json", contentType: "application/json; charset=utf-8", extension: "json", inline: true },
  step: { file: "model.step", contentType: "model/step", extension: "step", inline: false },
  stl: { file: "model.stl", contentType: "model/stl", extension: "stl", inline: false },
  dxf: { file: "top-view.dxf", contentType: "image/vnd.dxf", extension: "dxf", inline: false },
  spec: { file: "design-spec.json", contentType: "application/json; charset=utf-8", extension: "json", inline: false },
} as const;

type CadFormat = keyof typeof FORMATS;

function safeDownloadName(title: string, extension: string): { ascii: string; utf8: string } {
  const base = (title || "cad-model")
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 60) || "cad-model";
  return {
    ascii: `${base}.${extension}`,
    utf8: encodeURIComponent(`${(title || "CAD 模型").slice(0, 80)}.${extension}`),
  };
}

function isValidDxfProjection(value: CadManifest["dxfProjection"]): boolean {
  return value?.version === 1
    && value.view === "top"
    && value.plane === "XY"
    && value.unit === "mm"
    && value.representation === "projected_brep_edges"
    && value.entityType === "LINE"
    && Number.isInteger(value.lineCount)
    && Number(value.lineCount) > 0
    && Array.isArray(value.bounds)
    && value.bounds.length === 2
    && value.bounds.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; format: string }> }
) {
  const { id, format: rawFormat } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) return new Response("Bad id", { status: 400 });
  if (!Object.prototype.hasOwnProperty.call(FORMATS, rawFormat)) {
    return NextResponse.json({ error: "CAD 文件格式无效" }, { status: 400 });
  }
  const format = rawFormat as CadFormat;
  const out = await getStudioOutput(id);
  if (!out || out.kind !== "cad") {
    return NextResponse.json({ error: "CAD 制品不存在" }, { status: 404 });
  }
  // 首版 CAD 原生文件不随公开分享放行：必须登录且确有笔记本访问角色。
  const access = await requireAccess(req, out.notebook_id);
  if (access instanceof NextResponse) return access;

  const ip = reqMeta(req).ip || "unknown";
  const perIp = rateLimit(`studio-cad:${id}:${ip}`, 20, 60_000);
  if (!perIp.ok) return tooMany(perIp.retryAfter);
  const notebookLimit = rateLimitNotebook("studio-asset", out.notebook_id, 120, 60_000);
  if (!notebookLimit.ok) return tooMany(notebookLimit.retryAfter);

  const config = FORMATS[format];
  const bundleDir = path.join(CAD_DIR, id);
  const filePath = path.join(bundleDir, config.file);
  let manifest: CadManifest;
  try {
    manifest = JSON.parse(await readFile(path.join(bundleDir, "manifest.json"), "utf8")) as CadManifest;
  } catch {
    return NextResponse.json({ error: "CAD 发布清单无效" }, { status: 409 });
  }
  let frozen: FrozenCadManifest = {};
  let cadPipelineVersion = 0;
  try {
    const outputData = JSON.parse(out.data || "{}") as {
      manifest?: FrozenCadManifest;
      cadPipelineVersion?: unknown;
    };
    frozen = outputData.manifest ?? {};
    cadPipelineVersion = Number(outputData.cadPipelineVersion ?? 0);
  } catch {
    return NextResponse.json({ error: "CAD 数据快照无效" }, { status: 409 });
  }
  // 已发布旧制品没有 DXF 条目时保持 STEP/STL 可用；DXF 本身明确返回不存在，
  // 不把正常的向后兼容状态误报为文件包篡改。
  if (format === "dxf" && (!manifest.files?.dxf || !frozen.files?.dxf)) {
    return NextResponse.json({ error: "该历史 CAD 制品没有 DXF 顶视图" }, { status: 404 });
  }
  const contentHash = createHash("sha256").update(out.content || "", "utf8").digest("hex");
  const requireExternalStep = process.env.CAD_REQUIRE_EXTERNAL_STEP_VALIDATOR === "1";
  const externalStep = manifest.stepValidation?.externalValidation;
  const frozenExternalStep = frozen.stepValidation?.externalValidation;
  if (
    !/^[a-f0-9]{64}$/.test(String(manifest.hash || ""))
    || manifest.hash !== contentHash
    || frozen.hash !== manifest.hash
    || frozen.template !== manifest.template
    || frozen.process !== manifest.process
    || manifest.validation?.brepValid !== true
    || (
      format === "dxf"
      && (
        !isValidDxfProjection(manifest.dxfProjection)
        || !isValidDxfProjection(frozen.dxfProjection)
        || JSON.stringify(frozen.dxfProjection) !== JSON.stringify(manifest.dxfProjection)
      )
    )
    || !resolveCadArtifactContract(manifest.template, manifest, frozen)
    || (
      cadPipelineVersion >= 3
      && (
        manifest.stepValidation?.roundTripValid !== true
        || manifest.stepValidation?.brepValid !== true
        || manifest.stepValidation?.unit !== "mm"
        || manifest.stepValidation?.solidCount !== manifest.validation?.solidCount
        || manifest.stepValidation?.faceCount !== Number(manifest.faceCount)
        || manifest.stepValidation?.edgeCount !== Number(manifest.edgeCount)
        || Math.abs(Number(manifest.stepValidation?.volumeMm3) - Number(manifest.volumeMm3)) > Math.max(0.1, Math.abs(Number(manifest.volumeMm3)) * 0.001)
        || frozen.stepValidation?.roundTripValid !== true
        || frozen.stepValidation?.validator !== manifest.stepValidation?.validator
        || frozen.stepValidation?.solidCount !== manifest.stepValidation?.solidCount
        || frozen.stepValidation?.faceCount !== manifest.stepValidation?.faceCount
        || frozen.stepValidation?.edgeCount !== manifest.stepValidation?.edgeCount
        || frozen.stepValidation?.volumeMm3 !== manifest.stepValidation?.volumeMm3
        || (manifest.template === "text2cad" && manifest.stepValidation?.partGeometryValid !== true)
        || (manifest.template === "text2cad" && frozen.stepValidation?.partGeometryValid !== true)
        || (
          requireExternalStep
          && (
            externalStep?.validator !== "freecad-native"
            || externalStep?.unit !== "mm"
            || externalStep?.brepValid !== true
            || externalStep?.solidCount !== manifest.validation?.solidCount
            || externalStep?.faceCount !== Number(manifest.faceCount)
            || externalStep?.edgeCount !== Number(manifest.edgeCount)
            || Math.abs(Number(externalStep?.volumeMm3) - Number(manifest.volumeMm3)) > Math.max(0.1, Math.abs(Number(manifest.volumeMm3)) * 0.001)
            || frozenExternalStep?.validator !== externalStep?.validator
            || frozenExternalStep?.version !== externalStep?.version
            || frozenExternalStep?.solidCount !== externalStep?.solidCount
            || frozenExternalStep?.faceCount !== externalStep?.faceCount
            || frozenExternalStep?.edgeCount !== externalStep?.edgeCount
            || frozenExternalStep?.volumeMm3 !== externalStep?.volumeMm3
            || (manifest.template === "text2cad" && externalStep?.partGeometryValid !== true)
            || (manifest.template === "text2cad" && frozenExternalStep?.partGeometryValid !== true)
          )
        )
      )
    )
  ) {
    return NextResponse.json({ error: "CAD 规格与文件包不一致" }, { status: 409 });
  }
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
  } catch {
    return NextResponse.json({ error: "CAD 文件不存在或尚未完成" }, { status: 404 });
  }

  // 所有格式都按发布时 manifest 的字节数和 SHA-256 复核；DB 冻结快照、
  // canonical 规格与文件包三方必须同 hash/template，整包 A/B 错放也会拒绝。
  const expected = Number(manifest.files?.[format]?.bytes ?? 0);
  const expectedHash = String(manifest.files?.[format]?.sha256 ?? "");
  const frozenExpected = Number(frozen.files?.[format]?.bytes ?? 0);
  const frozenExpectedHash = String(frozen.files?.[format]?.sha256 ?? "");
  const actualHash = await sha256File(filePath);
  if (
    expected <= 0
    || expected !== fileStat.size
    || !/^[a-f0-9]{64}$/.test(expectedHash)
    || actualHash !== expectedHash
    || frozenExpected !== expected
    || frozenExpectedHash !== expectedHash
  ) {
    return NextResponse.json({ error: "CAD 文件完整性校验失败" }, { status: 409 });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as WebReadableStream<Uint8Array>;
  const headers: Record<string, string> = {
    "Content-Type": config.contentType,
    "Content-Length": String(fileStat.size),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (!config.inline) {
    const name = safeDownloadName(out.title, config.extension);
    headers["Content-Disposition"] = `attachment; filename="${name.ascii}"; filename*=UTF-8''${name.utf8}`;
  }
  return new Response(stream as unknown as BodyInit, { headers });
}
