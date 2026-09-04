import { after, NextRequest, NextResponse } from "next/server";
import {
  autoRenameNotebook,
  claimSourceEnrichment,
  claimSourceIngest,
  createSource,
  failClaimedSourceIngest,
  findSourceByContentHash,
  findSourceByOrigin,
  finishSourceEnrichment,
  getNotebook,
  getNotebookOverviewEpoch,
  getSource,
  listRecoverableSourceIngests,
  listSources,
  listSourcesNeedingEnrichment,
  releaseSourceIngestLease,
  resetSourceEnrichmentRetry,
  renewSourceEnrichmentLease,
  renewSourceIngestLease,
  setNotebookOverviewForSourceClaim,
  setSourceContentHash,
  setSourceGuideForClaim,
  setSourceOrigin,
  stageSourceForIngest,
} from "@/lib/db";
import { createHash } from "crypto";
import {
  extractBilibili,
  extractDocx,
  extractEpub,
  extractPptx,
  extractYouTube,
  isBilibiliUrl,
  isYouTubeUrl,
} from "@/lib/extract";
import { ocrImage, ocrPageLimit, ocrPdf } from "@/lib/ocr";
import { transcribeAudio } from "@/lib/asr";
import {
  generateNotebookOverview,
  generateSourceGuide,
  ingestSource,
} from "@/lib/rag";
import { hasSubstance } from "@/lib/corpus";
import { requireAccess } from "@/lib/auth";
import { parseVaultZip } from "@/lib/obsidian";
import { recordEvent, reqMeta } from "@/lib/activity";
import { normalizeUrl } from "@/lib/ingest";
import { rateLimit, tooMany } from "@/lib/ratelimit";
import { getEffectivePlanConfigForUser } from "@/lib/plans-config";
import type { SourceType } from "@/lib/types";
import { isPptxFileName, uploadLimitForFile } from "@/lib/upload-limits";
import { extractPdfManaged, extractUrlManaged } from "@/lib/extraction/orchestrator";
import type { ExtractedSource, ExtractionProvenance } from "@/lib/extraction/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// H4:来源摄入的大小硬上限,防超大负载经「整体入内存 + 分块 + 嵌入」放大成 OOM/DoS。
// 护城河 1:MAX_FILE_BYTES 按实时有效权益派生(系统管理员为虚拟不限量档),
// 顶层 REQUEST 上限按最高档(Ultra=500MB)+ 少量余量放宽，避免 Content-Length 早拒高档会员。
const MAX_REQUEST_BYTES = 520 * 1024 * 1024; // 整个请求体上限(覆盖文件与 JSON;≥Max 档 maxFileBytes + 余量)
const MAX_TEXT_CHARS = 1_000_000; // 粘贴/上传纯文本上限
const MAX_RAW_CHARS = 2_000_000; // 抽取后入库正文上限(限制 chunk 数)

const extractionFields = (value?: ExtractedSource) => value
  ? { pages: value.pages, provenance: value.provenance }
  : undefined;

function ocrFallbackExtraction(previous: ExtractedSource, text: string): ExtractedSource {
  const provenance: ExtractionProvenance = {
    ...previous.provenance,
    effectiveBackend: "native",
    backendVersion: "ocrPdf",
    outputSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    outputChars: text.length,
    partial: false,
    fallbackCode: previous.provenance.fallbackCode || "thin",
  };
  return { ...previous, text, provenance };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const g = await requireAccess(req, id);
  if (g instanceof NextResponse) return g;
  const sources = await listSources(id);
  // GET 是客户端 processing 轮询与页面恢复的必经路径。每次只注册一个
  // after() 恢复器，真正单飞由 DB 租约裁决，多实例/并发轮询不会重复跑。
  scheduleSourceRecovery(id, g.id);
  return NextResponse.json({ sources });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: notebookId } = await params;
  const g = await requireAccess(req, notebookId, true);
  if (g instanceof NextResponse) return g;
  // 洪水:摄入是全站最重的放大器(PDF→OCR 视觉模型、音频→ASR 子进程、抓取→SSRF 出网、
  // 后台 enrichAfterIngest 2 次 LLM、嵌入队列)。严限:用户维度 + IP 维度。
  const ip = reqMeta(req).ip || "unknown";
  const uLim = rateLimit(`sources:${g.id}`, 30, 60_000);
  if (!uLim.ok) return tooMany(uLim.retryAfter);
  const ipLim = rateLimit(`sources:ip:${ip}`, 60, 60_000);
  if (!ipLim.ok) return tooMany(ipLim.retryAfter);
  if (!(await getNotebook(notebookId))) {
    return NextResponse.json({ error: "笔记本不存在" }, { status: 404 });
  }
  // 护城河 1:按用户档拿单文件上限。plan_tier 恒 'free' 时等价旧行为 25MB;
  // Max/Ultra 用户自然放宽到 100/500MB。
  const effectivePlan = await getEffectivePlanConfigForUser(g);
  const MAX_FILE_BYTES = effectivePlan.maxFileBytes;
  const MAX_FILE_MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

  // H4:按 Content-Length 早拒超大请求(读进内存前)。
  const declaredLen = Number(req.headers.get("content-length") || 0);
  if (declaredLen && declaredLen > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "内容过大,请压缩或拆分后再上传" }, { status: 413 });
  }

  const contentType = req.headers.get("content-type") || "";

  let title = "Untitled source";
  let type: SourceType = "text";
  let rawText = "";
  let origin = "";
  let extractedSource: ExtractedSource | undefined;
  // 用户有意提供的纯文本(粘贴 / 上传 .txt·.md):跳过「过短/乱码」质量门,只要非空就入库。
  let authored = false;

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "未提供文件" }, { status: 400 });
      }
      title = file.name || "Uploaded file";
      const name = file.name.toLowerCase();
      const effectiveLimit = uploadLimitForFile(name, MAX_FILE_BYTES);
      if (file.size > effectiveLimit) {
        if (isPptxFileName(name)) {
          return NextResponse.json(
            { error: "PPTX 文件不能超过 25MB，请压缩图片或拆分后重传" },
            { status: 413 }
          );
        }
        // 护城河 1:按当前有效权益返回真实文件限制。
        return NextResponse.json(
          { error: `单文件超过当前权益上限(${MAX_FILE_MB} MB)，如需调整请联系管理员` },
          { status: 413 }
        );
      }
      // Obsidian 库 / Markdown 合集:.zip → 批量文本来源(frontmatter/双链清洗 + 按文件夹
      // 合并)。来源以 processing 状态先行返回,嵌入入库走后台串行(大库不拖死请求),
      // 客户端已有 processing 轮询会自行刷新到 ready。
      if (name.endsWith(".zip") || file.type === "application/zip") {
        return importVaultZip(notebookId, g.id, await file.arrayBuffer());
      }
      const isPdf = file.type === "application/pdf" || name.endsWith(".pdf");
      const isMarkdown = name.endsWith(".md") || name.endsWith(".markdown");
      const isAudio =
        file.type.startsWith("audio/") ||
        /\.(mp3|m4a|wav|ogg|oga|flac|aac|webm)$/i.test(name);
      const isImage =
        file.type.startsWith("image/") ||
        /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i.test(name);
      const isDocx = name.endsWith(".docx");
      const isPptx = isPptxFileName(name);
      const isEpub = name.endsWith(".epub");
      if (isPdf) {
        type = "pdf";
        // 审查 #2:PDF 走后台化(有文本层的秒完成、扫描 PDF 走视觉 OCR 5-20 秒不等)。
        // 先按文件字节哈希判重,再落 processing 来源立即返回,后台跑抽取/OCR/ingest。
        // 客户端 processing 轮询会自然接管刷新到 ready。
        const ab = await file.arrayBuffer();
        const fileHash = createHash("sha256").update(new Uint8Array(ab)).digest("hex");
        const ocrLimit = ocrPageLimit(effectivePlan.id);
        const dup = await findSourceByContentHash(notebookId, fileHash);
        if (dup) {
          await recordEvent({ actorId: g.id, actorKind: "user", action: "source.add.duplicate", targetType: "source", targetId: dup.id, notebookId, meta: { type } });
          if (dup.status === "processing") {
            // 上次 after() 若随容器中断，同文件重传会在旧租约失效后
            // 重挂原 source id，不会再建一条永久 processing 的孤儿。
            scheduleAsyncSourceIngest(dup.id, notebookId, g.id, false, async () => {
              let extracted = await extractPdfManaged(ab, { filename: file.name, userId: g.id });
              if (extracted.text.replace(/\s+/g, "").length < 24) {
                const text = await ocrPdf(ab, { maxPages: ocrLimit });
                extracted = ocrFallbackExtraction(extracted, text);
              }
              return extracted;
            });
          } else {
            scheduleEnrichment(dup.id, notebookId, g.id, true);
          }
          return NextResponse.json({ source: dup, duplicate: true }, { status: 200 });
        }
        return startAsyncFileIngest(notebookId, g.id, title, "pdf", fileHash, async () => {
          let extracted = await extractPdfManaged(ab, { filename: file.name, userId: g.id });
          if (extracted.text.replace(/\s+/g, "").length < 24) {
            const text = await ocrPdf(ab, { maxPages: ocrLimit });
            extracted = ocrFallbackExtraction(extracted, text);
          }
          return extracted;
        });
      } else if (isAudio) {
        type = "audio";
        // 审查 #2 实锤:此前 whisper 转写(最长 5 分钟)在 POST 内同步 → 上传 30 分钟音频
        // 后左栏只有客户端占位,刷新即消失、列表空空,用户以为失败会重传 → 双倍转写。
        // 现范式同 PDF:字节哈希判重 + 立即建 processing + 后台转写。
        const ab = await file.arrayBuffer();
        const fileHash = createHash("sha256").update(new Uint8Array(ab)).digest("hex");
        const dup = await findSourceByContentHash(notebookId, fileHash);
        if (dup) {
          await recordEvent({ actorId: g.id, actorKind: "user", action: "source.add.duplicate", targetType: "source", targetId: dup.id, notebookId, meta: { type } });
          if (dup.status === "processing") {
            scheduleAsyncSourceIngest(dup.id, notebookId, g.id, false, () => transcribeAudio(ab));
          } else {
            scheduleEnrichment(dup.id, notebookId, g.id, true);
          }
          return NextResponse.json({ source: dup, duplicate: true }, { status: 200 });
        }
        return startAsyncFileIngest(notebookId, g.id, title, "audio", fileHash, () => transcribeAudio(ab));
      } else if (isImage) {
        // L6:图片更小的上限 —— OCR 在 sharp 失败时会把原图 base64 内联给视觉模型。
        if (file.size > 10 * 1024 * 1024) {
          return NextResponse.json({ error: "图片过大(上限 10MB)" }, { status: 413 });
        }
        type = "image";
        rawText = await ocrImage(await file.arrayBuffer(), file.type);
      } else if (isDocx) {
        type = "text";
        rawText = await extractDocx(await file.arrayBuffer());
      } else if (isPptx) {
        type = "text";
        rawText = await extractPptx(await file.arrayBuffer());
      } else if (isEpub) {
        type = "text";
        rawText = await extractEpub(await file.arrayBuffer());
      } else {
        // 白名单兜底:不认识的二进制(.doc/.ppt/.mp4/.rtf 等)此前被 file.text() 当纯文本
        // 读入并 authored=true 跳过乱码门 → ready 状态入库污染对话生成(审查 #1 实锤)。
        // 只放行明确可读文本扩展 + text/* MIME;其它一律 415 + 可操作文案。
        const readableExts = /\.(txt|md|markdown|csv|tsv|json|log|yaml|yml|toml|xml|html?|htm)$/i;
        const isReadable = readableExts.test(name) || file.type.startsWith("text/") ||
          file.type === "application/json" || file.type === "application/xml" || !file.type;
        if (!isReadable) {
          const hint =
            /\.doc$/i.test(name) ? "请另存为 .docx 后重传" :
            /\.ppt$/i.test(name) ? "请另存为 .pptx 后重传" :
            /\.(xls|xlsx)$/i.test(name) ? "请另存为 CSV 或复制内容用「粘贴文本」" :
            /\.(mp4|mov|mkv|avi|webm)$/i.test(name) ? "视频尚不支持,请分享 B 站/YouTube 链接" :
            /\.rtf$/i.test(name) ? "RTF 尚不支持,请另存为 .docx 或 .txt" :
            "请转换为 PDF / Word(docx)/ PPT(pptx)/ 图片 / 音频 / 纯文本后重传";
          return NextResponse.json({ error: `暂不支持该文件类型(${file.type || "未知"});${hint}` }, { status: 415 });
        }
        type = isMarkdown ? "markdown" : "text";
        rawText = await file.text();
        // 乱码率门保留:纯文本文件如是 UTF-16/GBK 等误存,ingestSource 里会走
        // replRatio 校验(此前 authored=true 会绕过)——这里改成不再无条件 authored,
        // 让质量门生效防脏数据入库。
        authored = false;
      }
    } else {
      const body = await req.json().catch(() => ({}));
      if (body.type === "bilibili" && typeof body.url === "string") {
        type = "bilibili";
        const raw = body.url.trim();
        // 审查修复:同一视频的不同分享链接(跟踪参数/不同路径)按 BV 号归一成同一
        // origin,否则重复建源;抓取仍用原始链接。
        const bv = raw.match(/BV[0-9A-Za-z]{6,}/)?.[0];
        origin = bv ? `https://www.bilibili.com/video/${bv}` : normalizeUrl(raw);
        const reused = await reuseExistingOrigin(notebookId, origin, g.id);
        if (reused) return reused;
        const extracted = await extractBilibili(raw);
        title = extracted.title || raw;
        rawText = extracted.text;
      } else if (body.type === "youtube" && typeof body.url === "string") {
        type = "youtube";
        const raw = body.url.trim();
        // 同上:watch?v= / youtu.be / shorts 归一为规范 watch 链接作判重键。
        const vid =
          raw.match(/[?&]v=([\w-]{6,})/)?.[1] ||
          raw.match(/youtu\.be\/([\w-]{6,})/)?.[1] ||
          raw.match(/\/shorts\/([\w-]{6,})/)?.[1];
        origin = vid ? `https://www.youtube.com/watch?v=${vid}` : normalizeUrl(raw);
        const reused = await reuseExistingOrigin(notebookId, origin, g.id);
        if (reused) return reused;
        const extracted = await extractYouTube(raw);
        title = extracted.title || raw;
        rawText = extracted.text;
      } else if (body.type === "url" && typeof body.url === "string") {
        const raw = body.url.trim();
        // 智能重路由(审查 #3):B站/YouTube 粘进「网页」入口此前按 SPA 壳抓,产出空壳
        // 或 og 快照,且不 BV 归一,与「Bilibili」入口重复建源。识别到就走专属抽取器。
        if (isBilibiliUrl(raw)) {
          type = "bilibili";
          const bv = raw.match(/BV[0-9A-Za-z]{6,}/)?.[0];
          origin = bv ? `https://www.bilibili.com/video/${bv}` : normalizeUrl(raw);
          const reused = await reuseExistingOrigin(notebookId, origin, g.id);
          if (reused) return reused;
          const extracted = await extractBilibili(raw);
          title = extracted.title || raw;
          rawText = extracted.text;
        } else if (isYouTubeUrl(raw)) {
          type = "youtube";
          const vid =
            raw.match(/[?&]v=([\w-]{6,})/)?.[1] ||
            raw.match(/youtu\.be\/([\w-]{6,})/)?.[1] ||
            raw.match(/\/shorts\/([\w-]{6,})/)?.[1];
          origin = vid ? `https://www.youtube.com/watch?v=${vid}` : normalizeUrl(raw);
          const reused = await reuseExistingOrigin(notebookId, origin, g.id);
          if (reused) return reused;
          const extracted = await extractYouTube(raw);
          title = extracted.title || raw;
          rawText = extracted.text;
        } else {
        type = "url";
        // 审查修复:规范化结果只作判重键/origin;抓取用原始 URL(仅补协议)。
        // 此前拿剥参重排后的 URL 去抓取:误剥功能参数(如 ?s=/from=)会抓错页面,
        // 手工重组 query 还会丢失原有编码。
        origin = normalizeUrl(raw);
        // 先按规范 origin 去重：ready 来源直接从持久化 A 版恢复导读，
        // 不会多抓一次可能已变成 B/反爬页的网页。
        const reused = await reuseExistingOrigin(notebookId, origin, g.id);
        if (reused) return reused;
        const fetchUrl = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        const extracted = await extractUrlManaged(fetchUrl, { userId: g.id, signal: req.signal });
        title = extracted.title || origin;
        rawText = extracted.text;
        extractedSource = extracted;
        // 抓取「成功」但正文无实质内容(反爬占位页 / 只拿到 URL 回显 / 极短残文)——
        // 别把空壳当正文入库。否则它会被算进「N 个来源」,还会诱导下游生成「按 URL 猜内容」
        // 编造(实测今日头条抓取失败→思维导图生造出不存在的分支)。直接报错、不入库。
        // 判据与生成语料层 hasSubstance 一致(去链接后仍近乎为空才拦),不会误伤图文贴/短标注。
        if (!hasSubstance(rawText)) {
          return NextResponse.json(
            { error: "未能从该链接提取到正文(可能触发了反爬,或该页是纯导航页)。请改用「粘贴文本」方式导入正文。" },
            { status: 422 }
          );
        }
        } // end url 子分支(与 bilibili/youtube 平级)
      } else if (typeof body.text === "string") {
        type = "text";
        // 去零宽字符后再判空:{"text":"​​​"}(零宽/不可见空白)能骗过 .trim(),被当 authored
        // 正文入库(hasSubstance 也放行,因每个零宽占 1 字),污染每次生成的「N 个来源」。
        const visible = body.text.replace(/[​-‍⁠﻿]/g, "").trim();
        if (!visible) {
          return NextResponse.json({ error: "文本内容为空,无法添加" }, { status: 400 });
        }
        title = (body.title && String(body.title).trim()) || firstLine(body.text);
        if (body.text.length > MAX_TEXT_CHARS) {
          return NextResponse.json({ error: "文本过长(上限约 100 万字符)" }, { status: 413 });
        }
        rawText = body.text;
        authored = true;
      } else {
        return NextResponse.json({ error: "来源参数无效" }, { status: 400 });
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: readableExtractError(err) },
      { status: 400 }
    );
  }

  // H4:抽取后的正文也封顶,限制分块数量(URL/PDF/音频转写都可能很长)。
  // 审查 #5:此前是静默 slice,来源仍标 ready 无告知 → 用户提问后半段内容时以为
  // 是模型/检索问题。截断事实透明化到响应中(客户端 toast 提示)。
  const originalChars = rawText.length;
  let truncated = false;
  if (rawText.length > MAX_RAW_CHARS) {
    rawText = rawText.slice(0, MAX_RAW_CHARS);
    truncated = true;
    if (extractedSource) {
      extractedSource = {
        ...extractedSource,
        text: rawText,
        provenance: {
          ...extractedSource.provenance,
          outputSha256: createHash("sha256").update(rawText, "utf8").digest("hex"),
          outputChars: rawText.length,
          partial: true,
        },
      };
    }
  }

  // 去重(重复添加根治):URL 类用规范化 origin,文件/文本用内容 SHA256。
  // 命中同一笔记本内已存在(非 error)的来源则直接返回它,不再重复入库/嵌入。
  const contentHash = !origin && rawText ? createHash("sha256").update(rawText).digest("hex") : null;
  const existing = origin
    ? await findSourceByOrigin(notebookId, origin)
    : contentHash
    ? await findSourceByContentHash(notebookId, contentHash)
    : null;
  if (existing) {
    await recordEvent({
      actorId: g.id,
      actorKind: "user",
      action: "source.add.duplicate",
      targetType: "source",
      targetId: existing.id,
      notebookId,
      meta: { type, origin: origin || undefined },
    });
    if (existing.status === "processing" && rawText) {
      // 同 URL/文本重传若命中中断的 processing 行，先把本次已抽取正文暂存到
      // 原 source id，再由 DB 租约重挂；不新建重复来源。
      await stageSourceForIngest(existing.id, rawText, authored, undefined, extractionFields(extractedSource));
      scheduleAsyncSourceIngest(existing.id, notebookId, g.id, authored);
    } else if (existing.status === "ready") {
      // 始终从旧来源持久化 content 生成导读，绝不使用本次重抓后可能已变成 B 版的 rawText。
      scheduleEnrichment(existing.id, notebookId, g.id, true);
    }
    return NextResponse.json({ source: existing, duplicate: true }, { status: 200 });
  }

  const source = await createSource(notebookId, title.slice(0, 200), type);
  if (origin) await setSourceOrigin(source.id, origin);
  if (contentHash) await setSourceContentHash(source.id, contentHash);
  // 先暂存抽取结果再嵌入。若进程死在 embedTexts/分块落库期间，GET 轮询可恢复。
  await stageSourceForIngest(source.id, rawText, authored, undefined, extractionFields(extractedSource));
  let ingestErr: Error | null = null;
  const ingestClaim = await claimSourceIngest(source.id);
  const stopIngestHeartbeat = ingestClaim
    ? keepLeaseAlive(() => renewSourceIngestLease(source.id, ingestClaim).catch(() => false))
    : () => {};
  try {
    if (!ingestClaim) throw new Error("来源摄取正在其它实例处理");
    await ingestSource(source.id, notebookId, rawText, {
      authored,
      claimToken: ingestClaim,
      pages: extractedSource?.pages,
      extraction: extractedSource?.provenance,
    });
  } catch (err) {
    ingestErr = err as Error;
    if (ingestClaim) await failClaimedSourceIngest(source.id, ingestClaim, ingestErr.message);
  } finally {
    stopIngestHeartbeat();
    if (ingestClaim) await releaseSourceIngestLease(source.id, ingestClaim).catch(() => false);
  }

  // Best-effort enrichment — never fail the upload if these calls error.
  // fire-and-forget:导读+概览是 2 次 LLM 调用(5-15 秒),不再阻塞「添加来源」响应;
  // 客户端立即拿到 ready 来源,导读/概览/自动命名稍后自行落库。
  if (!ingestErr) {
    scheduleEnrichment(source.id, notebookId, g.id);
  }

  const finalSource = await getSource(source.id);
  await recordEvent({
    actorId: g.id,
    actorKind: "user",
    action: "source.add",
    targetType: "source",
    targetId: source.id,
    notebookId,
    meta: { type, title: finalSource?.title, status: finalSource?.status, chars: finalSource?.char_count },
  });
  // 截断透明化:响应带 truncated 字段(客户端 addSource 会 toast「仅导入前 X 万字」)。
  return NextResponse.json(
    truncated
      ? {
          source: finalSource,
          truncated: true,
          truncatedChars: originalChars,
          keptChars: MAX_RAW_CHARS,
        }
      : { source: finalSource },
    { status: 201 }
  );
}

const ENRICH_RETRY_DELAYS_MS = [0, 500, 1_500] as const;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryEnrichmentStage(
  stage: "guide" | "overview",
  sourceId: string,
  notebookId: string,
  actorId: string | undefined,
  run: () => Promise<void>
): Promise<boolean> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < ENRICH_RETRY_DELAYS_MS.length; attempt++) {
    if (ENRICH_RETRY_DELAYS_MS[attempt]) await delay(ENRICH_RETRY_DELAYS_MS[attempt]);
    try {
      await run();
      return true;
    } catch (error) {
      lastError = error;
      console.warn(`[sources] ${stage} 增补第 ${attempt + 1}/${ENRICH_RETRY_DELAYS_MS.length} 次失败:`, (error as Error).message);
      if (/租约已失效/.test((error as Error).message)) break;
    }
  }
  await recordEvent({
    actorId: actorId ?? null,
    actorKind: "system",
    action: "source.enrich_failed",
    targetType: "source",
    targetId: sourceId,
    notebookId,
    meta: {
      stage,
      attempts: ENRICH_RETRY_DELAYS_MS.length,
      error: lastError instanceof Error ? lastError.message.slice(0, 160) : String(lastError).slice(0, 160),
    },
  }).catch(() => {});
  return false;
}

async function runEnrichment(
  sourceId: string,
  notebookId: string,
  actorId?: string
): Promise<void> {
  const claimToken = await claimSourceEnrichment(sourceId);
  if (!claimToken) return;
  const stopHeartbeat = keepLeaseAlive(() =>
    renewSourceEnrichmentLease(sourceId, claimToken).catch(() => false)
  );
  let completed = false;
  try {
    // 真源唯一来自 sources.content。重复 URL 本次重抓到的 B 版正文绝不能
    // 传入旧 source(A) 的导读，否则 chunks=A、summary=B、公开概览也=B。
    const persisted = await getSource(sourceId);
    if (!persisted || persisted.status !== "ready" || !persisted.content.trim()) return;
    const guideReady = await retryEnrichmentStage("guide", sourceId, notebookId, actorId, async () => {
      if (!(await renewSourceEnrichmentLease(sourceId, claimToken))) throw new Error("来源导读租约已失效");
      const current = await getSource(sourceId);
      if ((current?.summary ?? "").trim() && (current?.key_topics ?? []).length >= 3) return;
      const guide = await generateSourceGuide(persisted.title, persisted.content);
      if (!(await setSourceGuideForClaim(sourceId, claimToken, guide.summary, guide.key_topics))) {
        throw new Error("来源导读租约已失效");
      }
    });
    if (!guideReady) return;

    const overviewReady = await retryEnrichmentStage("overview", sourceId, notebookId, actorId, async () => {
      if (!(await renewSourceEnrichmentLease(sourceId, claimToken))) throw new Error("来源概览租约已失效");
      const ready = (await listSources(notebookId)).filter((source) => source.status === "ready");
      // 任一来源导读未就绪就整体重试,绝不用部分来源静默覆盖全本概览。
      if (!ready.length || ready.some((source) => !(source.summary ?? "").trim())) {
        throw new Error("存在尚未生成导读的来源");
      }
      const sourceSnapshot = ready.map((source) => ({
        id: source.id,
        title: source.title,
        fetchedAt: Number(source.fetched_at ?? 0),
        summary: String(source.summary ?? ""),
      }));
      const overviewEpoch = await getNotebookOverviewEpoch(notebookId);
      const wantTitle = (await getNotebook(notebookId))?.title === "未命名笔记本";
      const overview = await generateNotebookOverview(
        ready.map((source) => ({ title: source.title, summary: source.summary })),
        "",
        { suggestTitle: wantTitle }
      );
      if (!(await setNotebookOverviewForSourceClaim(
        sourceId,
        claimToken,
        notebookId,
        overview.summary,
        overview.suggested_questions,
        sourceSnapshot,
        overviewEpoch
      ))) {
        // 生成期间若概览 epoch 已前进，说明用户手动刷新或另一个
        // 新快照已落库。把本次增补视为完成，绝不在退避后反向覆盖新概览。
        if (await getNotebookOverviewEpoch(notebookId) !== overviewEpoch) return;
        throw new Error("来源概览租约已失效");
      }
      if (wantTitle && overview.title && await autoRenameNotebook(notebookId, overview.title)) {
        await recordEvent({
          actorId: actorId ?? null,
          actorKind: "system",
          action: "notebook.autoname",
          targetType: "notebook",
          targetId: notebookId,
          notebookId,
          meta: { title: overview.title },
        });
      }
    });
    completed = overviewReady;
  } finally {
    stopHeartbeat();
    await finishSourceEnrichment(sourceId, claimToken, completed).catch(() => false);
  }
}

function scheduleEnrichment(
  sourceId: string,
  notebookId: string,
  actorId?: string,
  manualRetry = false
): void {
  // Next after() 把响应后任务绑定到请求生命周期,比裸 void Promise 更可靠;
  // 进程 SIGKILL 后租约到期，GET 轮询/重复添加会从持久化 content 重触发。
  after(async () => {
    if (manualRetry) await resetSourceEnrichmentRetry(sourceId).catch(() => false);
    await runEnrichment(sourceId, notebookId, actorId);
  });
}

/**
 * URL/视频规范 origin 在出网前去重。ready 来源不再抓当前网页，因而不存在
 * “旧 chunks=A，新抓正文=B，导读却写回旧 source”的通道。processing 若已有
 * 暂存正文也可直接重挂；抽取前就中断的空 stub 返回 null，让本次继续抓取。
 */
async function reuseExistingOrigin(
  notebookId: string,
  origin: string,
  actorId: string
): Promise<NextResponse | null> {
  const existing = await findSourceByOrigin(notebookId, origin);
  if (!existing) return null;
  if (existing.status === "processing") {
    const persisted = await getSource(existing.id);
    if (!persisted?.content.trim()) return null;
    scheduleAsyncSourceIngest(existing.id, notebookId, actorId, false);
  } else {
    scheduleEnrichment(existing.id, notebookId, actorId, true);
  }
  await recordEvent({
    actorId,
    actorKind: "user",
    action: "source.add.duplicate",
    targetType: "source",
    targetId: existing.id,
    notebookId,
    meta: { type: existing.type, origin },
  });
  return NextResponse.json({ source: existing, duplicate: true }, { status: 200 });
}

// 抽取失败消息中文化(会直接展示在批量导入结果面板/来源行):
// extract/ssrf 层已是中文的直接加「导入失败:」透出,不重复堆前缀;
// 网络层英文报错(超时/DNS/连接失败等 Node 底层消息)映射成可操作中文。
function readableExtractError(err: unknown): string {
  const msg = (err as Error)?.message || "";
  if (/[一-鿿]/.test(msg)) return `导入失败:${msg}`;
  if (/abort|timeout|timed out/i.test(msg)) return "导入失败:抓取超时,请稍后重试或换个链接。";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return "导入失败:无法解析该链接的域名,请检查链接是否正确。";
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket|network|fetch failed/i.test(msg)) return "导入失败:连接目标站点失败,请稍后重试。";
  return `导入失败:读取来源内容失败${msg ? `(${msg})` : ""},请稍后重试。`;
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] || "Pasted text";
  return line.slice(0, 80);
}

// normalizeUrl 已抽至 lib/ingest.ts(与订阅轮询共用同一去重键实现),此处 import。

const SOURCE_LEASE_HEARTBEAT_MS = 30_000;

/** 租约心跳不延长请求，仅防长 OCR/ASR/LLM 时被并发轮询误判成孤儿。 */
function keepLeaseAlive(renew: () => Promise<unknown>): () => void {
  const timer = setInterval(() => {
    void renew().catch(() => {});
  }, SOURCE_LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * 执行一条可恢复摄取。若 source.content 已暂存就优先用它；只有进程在
 * OCR/ASR 完成前中断时，同文件重传才需再执行 extract。
 */
async function runRecoverableSourceIngest(
  sourceId: string,
  notebookId: string,
  actorId: string | undefined,
  authored: boolean,
  extract?: () => Promise<string | ExtractedSource>
): Promise<void> {
  const claimToken = await claimSourceIngest(sourceId);
  if (!claimToken) return;
  const stopHeartbeat = keepLeaseAlive(() =>
    renewSourceIngestLease(sourceId, claimToken).catch(() => false)
  );
  try {
    const current = await getSource(sourceId);
    if (!current || current.status !== "processing") return;
    let extracted: ExtractedSource | undefined;
    let text = current.content;
    if (text.trim()) {
      let provenance: ExtractionProvenance | undefined;
      try {
        const parsed = JSON.parse(current.extraction_meta || "{}");
        if (parsed?.schemaVersion === 1) provenance = parsed as ExtractionProvenance;
      } catch {
        provenance = undefined;
      }
      if (provenance) extracted = { text, pages: current.pages, provenance };
    } else {
      if (!extract) return; // 抽取前被 SIGKILL：等用户同文件重传提供字节。
      const value = await extract();
      if (typeof value === "string") text = value;
      else {
        extracted = value;
        text = value.text;
      }
    }
    if (text.length > MAX_RAW_CHARS) {
      text = text.slice(0, MAX_RAW_CHARS);
      if (extracted) {
        extracted = {
          ...extracted,
          text,
          provenance: {
            ...extracted.provenance,
            outputSha256: createHash("sha256").update(text, "utf8").digest("hex"),
            outputChars: text.length,
            partial: true,
          },
        };
      }
    }
    await stageSourceForIngest(sourceId, text, authored, claimToken, extractionFields(extracted));
    await ingestSource(sourceId, notebookId, text, {
      authored,
      claimToken,
      pages: extracted?.pages,
      extraction: extracted?.provenance,
    });
  } catch (error) {
    await failClaimedSourceIngest(
      sourceId,
      claimToken,
      readableExtractError(error)
    ).catch(() => false);
    return;
  } finally {
    stopHeartbeat();
    await releaseSourceIngestLease(sourceId, claimToken).catch(() => false);
  }
  await runEnrichment(sourceId, notebookId, actorId);
}

function scheduleAsyncSourceIngest(
  sourceId: string,
  notebookId: string,
  actorId: string | undefined,
  authored: boolean,
  extract?: () => Promise<string | ExtractedSource>
): void {
  after(() => runRecoverableSourceIngest(sourceId, notebookId, actorId, authored, extract));
}

async function recoverInterruptedSources(notebookId: string, actorId?: string): Promise<void> {
  // 先恢复已暂存原文的 processing，成功后 runRecoverableSourceIngest 会立即接导读。
  const staged = await listRecoverableSourceIngests(notebookId);
  const attempted = new Set(staged.map((source) => source.id));
  for (const source of staged) {
    await runRecoverableSourceIngest(
      source.id,
      source.notebook_id,
      actorId,
      source.authored,
      async () => ({
        text: source.content,
        pages: source.pages,
        provenance: source.extraction || {
          schemaVersion: 1,
          requestedBackend: "native",
          effectiveBackend: "native",
          outputSha256: createHash("sha256").update(source.content, "utf8").digest("hex"),
          outputChars: source.content.length,
          pages: source.pages,
          elapsedMs: 0,
          partial: false,
        },
      })
    );
  }
  // 再恢复“已 ready 但 after() 死在导读/概览阶段”的来源。DB 租约单飞。
  const pending = await listSourcesNeedingEnrichment(notebookId);
  for (const source of pending) {
    // 刚恢复摄取的来源已在上面尝试过一轮导读，本次 GET 不立即双倍重试。
    if (!attempted.has(source.id)) await runEnrichment(source.id, source.notebook_id, actorId);
  }
}

function scheduleSourceRecovery(notebookId: string, actorId?: string): void {
  after(() => recoverInterruptedSources(notebookId, actorId));
}


/** 音频/PDF 异步入库(审查 #2):先建 processing 来源+文件字节哈希+ origin 立即返回,
 *  后台跑 extract(转写 whisper / PDF OCR)→ ingestSource → enrich。失败置 error。
 *  与 zip 导入同款范式,客户端 4s processing 轮询会自然刷新到 ready/error。 */
async function startAsyncFileIngest(
  notebookId: string,
  actorId: string,
  title: string,
  type: SourceType,
  fileHash: string,
  extract: () => Promise<string | ExtractedSource>
): Promise<NextResponse> {
  const src = await createSource(notebookId, title.slice(0, 200), type);
  await setSourceContentHash(src.id, fileHash);
  scheduleAsyncSourceIngest(src.id, notebookId, actorId, false, extract);
  await recordEvent({
    actorId,
    actorKind: "user",
    action: "source.add",
    targetType: "source",
    targetId: src.id,
    notebookId,
    meta: { type, title: src.title, status: "processing", async: true },
  });
  return NextResponse.json({ source: src }, { status: 201 });
}

/** Obsidian 库(zip)导入:解析分组 → 判重 → 建 processing 来源即刻返回,
 *  嵌入/导读走后台串行(单组失败置 error 不影响其余)。 */
async function importVaultZip(
  notebookId: string,
  actorId: string,
  buf: ArrayBuffer
): Promise<NextResponse> {
  let parsed: Awaited<ReturnType<typeof parseVaultZip>>;
  try {
    parsed = await parseVaultZip(buf);
  } catch {
    return NextResponse.json({ error: "压缩包无法解析,请确认是有效的 .zip 文件" }, { status: 400 });
  }
  const { groups, totalFiles, skippedFiles } = parsed;
  if (!groups.length) {
    return NextResponse.json(
      { error: "压缩包里没有可导入的 Markdown / 文本笔记(支持 .md/.markdown/.txt)" },
      { status: 400 }
    );
  }
  const stubs = [];
  const jobs: { id: string }[] = [];
  let duplicates = 0;
  for (const gp of groups) {
    const content = gp.content.length > MAX_RAW_CHARS ? gp.content.slice(0, MAX_RAW_CHARS) : gp.content;
    const hash = createHash("sha256").update(content).digest("hex");
    const existing = await findSourceByContentHash(notebookId, hash);
    if (existing) {
      duplicates += 1;
      if (existing.status === "processing") {
        // ZIP 重传不再跳过中断的 stub：把同组正文重新暂存到原 id 并重挂。
        await stageSourceForIngest(existing.id, content, true);
        jobs.push({ id: existing.id });
      } else {
        scheduleEnrichment(existing.id, notebookId, actorId, true);
      }
      continue;
    }
    const src = await createSource(notebookId, gp.title.slice(0, 200), "markdown");
    await setSourceContentHash(src.id, hash);
    // 请求返回 201 前持久化分组正文，确保 after() 尚未执行就被终止也可恢复。
    await stageSourceForIngest(src.id, content, true);
    stubs.push(src);
    jobs.push({ id: src.id });
  }
  // 后台串行入库 + 导读增补:请求即刻返回 processing 来源,前端轮询刷到 ready。
  after(async () => {
    for (const j of jobs) {
      await runRecoverableSourceIngest(j.id, notebookId, actorId, true);
    }
  });
  await recordEvent({
    actorId,
    actorKind: "user",
    action: "source.add.vault",
    targetType: "notebook",
    targetId: notebookId,
    notebookId,
    meta: { files: totalFiles, groups: stubs.length, duplicates, skipped: skippedFiles },
  });
  return NextResponse.json(
    { sources: stubs, imported: stubs.length, duplicates, files: totalFiles, skipped: skippedFiles },
    { status: 201 }
  );
}
