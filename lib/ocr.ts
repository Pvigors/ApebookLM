import sharp from "sharp";
import { extractImages, getDocumentProxy } from "unpdf";
import { getOpenAI, VISION_MODEL } from "./openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";

// Cap the longest image edge before sending to the vision model (cost / speed).
const MAX_DIM = 1600;
// Skip tiny embedded images (icons, logos, bullets) — not worth an OCR call.
const MIN_OCR_DIM = 200;
// Bound total work for very large PDFs. 按权益档动态放宽：
// 非会员不允许新上传；Pro / Max / Ultra 按档放宽。free=0 是服务端纵深防御。
const MAX_PAGES_BY_TIER: Record<string, number> = {
  free: 0,
  starter: 40,
  pro: 100,
  max: 300,
  test: 300,
};
export function ocrPageLimit(tier?: string | null): number {
  return MAX_PAGES_BY_TIER[String(tier ?? "free").toLowerCase()] ?? 0;
}

const OCR_PROMPT = `You are an OCR engine. Transcribe ALL text from this page image verbatim, in its original language.
- Preserve the natural reading order and structure (titles, subtitles, bullet points, tables, captions).
- For charts, diagrams, or images that contain no readable text, add a brief description in [square brackets].
- Do NOT translate, summarize, or add commentary. Output only the page's content as plain text.`;

type ExtractedImage = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
};

/** Encode a raw RGB(A)/grayscale pixel buffer into a JPEG data URL for the vision API. */
async function toJpegDataUrl(img: ExtractedImage): Promise<string | null> {
  const { width, height, channels } = img;
  if (!width || !height) return null;
  if (channels !== 1 && channels !== 3 && channels !== 4) return null;
  const input = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const jpeg = await sharp(input, { raw: { width, height, channels } })
    .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/**
 * OCR an image-based PDF (scanned docs, exported slide decks) by rendering each
 * page's embedded image(s) and transcribing them with an OpenAI vision model.
 * Returns the concatenated page text. Requires OPENAI_API_KEY.
 */
export async function ocrPdf(buf: ArrayBuffer, opts?: { maxPages?: number }): Promise<string> {
  // Copy: pdf.js detaches the buffer it parses, and the caller may have
  // already used the original for text extraction.
  const pdf = await getDocumentProxy(new Uint8Array(buf.slice(0)));
  const openai = getOpenAI();
  const limit = opts?.maxPages ?? 40;
  const totalPages = pdf.numPages;
  const pageCount = Math.min(totalPages, limit);
  const pages: string[] = [];
  // 截断透明化:超页时首行标注(会随 rawText 一起入库,来源摘要/查看器都能看到)。
  if (totalPages > pageCount) {
    pages.push(`[提示:该 PDF 共 ${totalPages} 页,当前权益仅识别前 ${pageCount} 页;如需调整页数上限，请联系管理员。]`);
  }

  for (let p = 1; p <= pageCount; p++) {
    let images: ExtractedImage[];
    try {
      images = (await extractImages(pdf, p)) as ExtractedImage[];
    } catch {
      continue;
    }

    const parts: ChatCompletionContentPart[] = [{ type: "text", text: OCR_PROMPT }];
    for (const img of images) {
      if (Math.max(img.width, img.height) < MIN_OCR_DIM) continue;
      const url = await toJpegDataUrl(img);
      if (url) parts.push({ type: "image_url", image_url: { url, detail: "high" } });
    }
    if (parts.length === 1) continue; // no usable images on this page

    const res = await openai.chat.completions.create({
      model: VISION_MODEL,
      messages: [{ role: "user", content: parts }],
      temperature: 0,
      max_tokens: 4096,
    });
    const text = res.choices[0]?.message?.content?.trim() ?? "";
    if (text) pages.push(`[Page ${p}]\n${text}`);
  }

  return pages.join("\n\n");
}

/** Transcribe/describe a single image file with the vision model. */
export async function ocrImage(buf: ArrayBuffer, mime: string): Promise<string> {
  const input = Buffer.from(buf);
  let dataUrl: string;
  try {
    const jpeg = await sharp(input)
      .resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    dataUrl = `data:${mime || "image/png"};base64,${input.toString("base64")}`;
  }
  const parts: ChatCompletionContentPart[] = [
    { type: "text", text: OCR_PROMPT },
    { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
  ];
  const res = await getOpenAI().chat.completions.create({
    model: VISION_MODEL,
    messages: [{ role: "user", content: parts }],
    temperature: 0,
    max_tokens: 4096,
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}
