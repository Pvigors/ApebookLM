import { NextRequest, NextResponse } from "next/server";
import { access, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import path from "node:path";
import { consumeAuthRateLimit, getStudioOutput, updateStudioOutput } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { requireAccess, requireNotebookRead } from "@/lib/auth";
import { parseDeck } from "@/lib/deck";
import {
  aipptDeckHash,
  AIPPT_DIR,
  aipptVariantPath,
  ensureAipptVariantsFromStored,
  generateAippt,
  type AipptMeta,
} from "@/lib/aippt";
import { downloadRequiresWatermark } from "@/lib/download-entitlement";
import { recordEvent, reqMeta } from "@/lib/activity";
import { rateLimit, rateLimitNotebook, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bucket = (kind: string, value: string) =>
  createHash("sha256").update(`${kind}:${value}`, "utf8").digest("hex");

function outputData(raw: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function variantsReady(id: string, deckHash: string): Promise<boolean> {
  return Promise.all([
    access(aipptVariantPath(id, deckHash, false)).then(() => true, () => false),
    access(aipptVariantPath(id, deckHash, true)).then(() => true, () => false),
  ]).then((values) => values.every(Boolean));
}

type AipptRuntimeState = { active: number; migrations: Map<string, Promise<string>> };
const runtimeProcess = process as unknown as { __aipptRuntime?: AipptRuntimeState };
const aipptRuntime = (runtimeProcess.__aipptRuntime ??= { active: 0, migrations: new Map() });
const MAX_CONCURRENT_AIPPT_WORK = 2;
class AipptBusyError extends Error {}

function acquireAipptWork(): boolean {
  if (aipptRuntime.active >= MAX_CONCURRENT_AIPPT_WORK) return false;
  aipptRuntime.active++;
  return true;
}

function releaseAipptWork(): void {
  aipptRuntime.active = Math.max(0, aipptRuntime.active - 1);
}

/** POST:用 deck 大纲调文多多 AIPPT 渲染精美版,落盘并记录到 output.data。 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const out = await getStudioOutput(id);
  if (!out || out.kind !== "slides") {
    return NextResponse.json({ error: "制品不存在" }, { status: 404 });
  }
  const user = await requireAccess(req, out.notebook_id, true);
  if (user instanceof NextResponse) return user;

  const deck = parseDeck(out.content, out.title);
  if (!deck.slides.length) {
    return NextResponse.json({ error: "演示文稿内容为空" }, { status: 400 });
  }
  const deckHash = aipptDeckHash(deck);
  const existing = outputData(out.data).aippt as AipptMeta | undefined;
  if (existing?.deckHash === deckHash && await variantsReady(id, deckHash)) {
    return NextResponse.json({ ok: true, aippt: existing, reused: true });
  }
  const fast = rateLimit(`aippt-generate:${user.id}`, 20, 60_000);
  if (!fast.ok) return tooMany(fast.retryAfter);
  if (!acquireAipptWork()) {
    return NextResponse.json({ error: "精美版生成繁忙，请稍后重试" }, { status: 429, headers: { "Retry-After": "5" } });
  }
  let client: PoolClient | null = null;
  let locked = false;
  try {
    client = await getPool().connect();
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [`aippt:${id}`]
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return NextResponse.json({ error: "该精美版正在生成，请稍后重试" }, { status: 409 });

    const current = await getStudioOutput(id);
    if (!current || current.kind !== "slides") {
      return NextResponse.json({ error: "制品不存在" }, { status: 404 });
    }
    const currentDeck = parseDeck(current.content, current.title);
    const currentHash = aipptDeckHash(currentDeck);
    const currentData = outputData(current.data);
    const currentMeta = currentData.aippt as AipptMeta | undefined;
    if (currentMeta?.deckHash === currentHash && await variantsReady(id, currentHash)) {
      return NextResponse.json({ ok: true, aippt: currentMeta, reused: true });
    }

    // 只有成功拿到全局槽 + output advisory lock，且锁内复核确需新生成后才消费
    // 持久限额；409/全局繁忙/幂等复用都不能吃掉用户重试机会。
    const limits = await Promise.all([
      consumeAuthRateLimit(bucket("aippt-user", user.id), 5, 60 * 60_000),
      consumeAuthRateLimit(bucket("aippt-output", id), 2, 10 * 60_000),
    ]);
    const denied = limits.filter((limit) => !limit.ok);
    if (denied.length) {
      return NextResponse.json(
        { error: "精美版生成过于频繁，请稍后再试" },
        { status: 429, headers: { "Retry-After": String(Math.max(...denied.map((item) => item.retryAfter))) } }
      );
    }

    const meta = await generateAippt(id, currentDeck);
    const data = currentData;
    data.aippt = meta;
    await updateStudioOutput(id, { data: JSON.stringify(data) });
    await recordEvent({
      actorId: user.id,
      actorKind: "user",
      action: "studio.aippt.generate",
      targetType: "studio_output",
      targetId: id,
      notebookId: current.notebook_id,
      meta: { deckHash: meta.deckHash, templateId: meta.templateId },
      ...reqMeta(req),
    });
    return NextResponse.json({ ok: true, aippt: meta });
  } catch (e) {
    console.error("[aippt] generate failed:", e);
    const msg = e instanceof Error ? e.message : "生成失败";
    return NextResponse.json(
      { error: /[一-鿿]/.test(msg) ? msg.slice(0, 120) : "精美版生成失败,请重试" },
      { status: 502 }
    );
  } finally {
    if (locked) {
      await client?.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`aippt:${id}`]).catch(() => {});
    }
    client?.release();
    releaseAipptWork();
  }
}

/** GET:下载已生成的精美版 PPTX(读 .data/aippt 落盘文件)。 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const out = await getStudioOutput(id);
  if (!out || out.kind !== "slides") {
    return NextResponse.json({ error: "制品不存在" }, { status: 404 });
  }
  // F2:按归属鉴权(公开笔记本放行)。
  const grd = await requireNotebookRead(req, out.notebook_id);
  if (grd !== true) return grd;
  const ip = reqMeta(req).ip || "unknown";
  const ipLimit = rateLimit(`aippt-download:${ip}`, 30, 60_000);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfter);
  const outputLimit = rateLimitNotebook("aippt-download", id, 120, 60_000);
  if (!outputLimit.ok) return tooMany(outputLimit.retryAfter);
  let meta: AipptMeta | null = null;
  try {
    meta = out.data ? ((JSON.parse(out.data) as { aippt?: AipptMeta }).aippt ?? null) : null;
  } catch {
    meta = null;
  }
  if (!meta) return NextResponse.json({ error: "尚未生成精美版" }, { status: 404 });
  try {
    const watermark = await downloadRequiresWatermark(req);
    let deckHash = typeof meta.deckHash === "string" && /^[a-f0-9]{64}$/.test(meta.deckHash)
      ? meta.deckHash
      : "";
    let variant = deckHash ? aipptVariantPath(id, deckHash, watermark) : "";
    let variantStat = variant ? await stat(variant).catch(() => null) : null;
    if (!variantStat) {
      // 兼容历史仅有 <id>.pptx 的产物：每个 output 全局 singleflight、全进程最多 2 个
      // 重处理；完成后版本化落盘并更新 meta。匿名请求无法并发制造无限解压工作集。
      let migration = aipptRuntime.migrations.get(id);
      if (!migration) {
        if (!acquireAipptWork()) {
          return NextResponse.json(
            { error: "精美版文件正在迁移，请稍后重试" },
            { status: 429, headers: { "Retry-After": "5" } }
          );
        }
        migration = (async () => {
          const client = await getPool().connect();
          let locked = false;
          try {
            const lock = await client.query<{ locked: boolean }>(
              "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
              [`aippt:${id}`]
            );
            locked = lock.rows[0]?.locked === true;
            if (!locked) throw new AipptBusyError("AIPPT output busy");
            const current = await getStudioOutput(id);
            if (!current) throw new Error("AIPPT output missing");
            const data = outputData(current.data);
            const currentMeta = data.aippt as AipptMeta | undefined;
            if (
              currentMeta?.deckHash
              && /^[a-f0-9]{64}$/.test(currentMeta.deckHash)
              && await variantsReady(id, currentMeta.deckHash)
            ) return currentMeta.deckHash;
            const stored = await readFile(path.join(AIPPT_DIR, `${id}.pptx`));
            const migrationHash = deckHash || createHash("sha256").update(stored).digest("hex");
            await ensureAipptVariantsFromStored(id, migrationHash, stored);
            data.aippt = { ...(currentMeta ?? meta), deckHash: migrationHash, variantVersion: 2 };
            await updateStudioOutput(id, { data: JSON.stringify(data) });
            return migrationHash;
          } finally {
            if (locked) {
              await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`aippt:${id}`]).catch(() => {});
            }
            client.release();
          }
        })().finally(() => {
          aipptRuntime.migrations.delete(id);
          releaseAipptWork();
        });
        aipptRuntime.migrations.set(id, migration);
      }
      deckHash = await migration;
      variant = aipptVariantPath(id, deckHash, watermark);
      variantStat = await stat(variant);
    }
    const safe = (out.title || "slides").replace(/[^\w.-]+/g, "_").slice(0, 60) || "slides";
    const utf8 = encodeURIComponent(`${out.title || "slides"}-精美版.pptx`);
    const body = Readable.toWeb(createReadStream(variant)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="${safe}-aippt.pptx"; filename*=UTF-8''${utf8}`,
        "Content-Length": String(variantStat.size),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AipptBusyError) {
      return NextResponse.json(
        { error: "精美版文件正在迁移，请稍后重试" },
        { status: 429, headers: { "Retry-After": "5" } }
      );
    }
    return NextResponse.json({ error: "文件已失效,请重新生成精美版" }, { status: 410 });
  }
}
