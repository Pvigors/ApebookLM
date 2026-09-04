import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { CHAT_MODEL, getOpenAI } from "./openai";
import { buildGenerationCorpus } from "./corpus";
import { GROUNDING_RULES, PRESERVE_SPECIFICS_SPEECH, multiSourcePreamble, outputLanguageClause } from "./grounding";
import { refineStructuredFields } from "./verify";
import { getNotebookDirective } from "./settings";
import { langKey, run, synthSegments } from "./tts";
import { ossEnabled, putObject } from "./oss";
import { uploadAndMarkOss } from "./media-store";
import { checkOutputLanguage, generationRetrievalQuery, mentionedExcludedScopeTerms, missingSupportedVerbatimPhrases, resolveOutputLanguageRequirement, studioInstructionClause } from "./generation-contract";

export const VIDEO_DIR = path.join(process.cwd(), ".data", "video");

const FONT = "PingFang SC, Hiragino Sans GB, Helvetica, Arial, sans-serif";

type Slide = { title: string; bullets: string[]; narration: string };

// ---- slide deck (Kimi) ----

const DECK_PROMPT = `You are creating a narrated "video overview" (a slide deck) about the provided sources.
Reply with STRICT JSON only: {"language":"<zh or en>","title":"<deck title>","slides":[{"title":"...","bullets":["...","..."],"narration":"..."}]}
- 5 to 8 slides; the first is a short intro slide and the last a brief takeaways/conclusion slide.
- Each slide: a short title (a few words), 2-4 concise bullet points (each a few words), and a "narration" of 2-4 spoken sentences a narrator reads over that slide.
- Use the dominant language of the sources.
- No markdown, no citation markers.

${GROUNDING_RULES}
${PRESERVE_SPECIFICS_SPEECH}`;

export type VideoOpts = { focus?: string; audience?: string; verify?: boolean; language?: string; watermark?: boolean; memberId?: string | null };

async function generateDeck(
  notebookId: string,
  sourceIds?: string[],
  opts: VideoOpts = {}
): Promise<{ language: string; title: string; slides: Slide[] }> {
  const corpus = await buildGenerationCorpus(
    notebookId,
    generationRetrievalQuery(opts.focus, "核心观点 关键信息 要点 论据 结论"),
    sourceIds
  );
  if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
  return deckFromCorpus(corpus, await getNotebookDirective(notebookId, opts.memberId), opts);
}

/** Slide-deck script from an already-built corpus — eval entry point (no render),
 *  lets the harness feed a fixed golden corpus and A/B `verify` on/off. */
export async function deckFromCorpus(
  corpus: string,
  directive: string,
  opts: VideoOpts = {}
): Promise<{ language: string; title: string; slides: Slide[] }> {
  if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
  const extra = studioInstructionClause(opts.focus) +
    (opts.audience?.trim() ? `\n\nTarget audience: ${opts.audience.trim()}.` : "");
  const sys = multiSourcePreamble(corpus, "slide") + DECK_PROMPT + extra;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.6,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `Sources:\n\n${corpus}${directive}${outputLanguageClause(opts.language)}` },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    let parsed: { language?: string; title?: string; slides?: Slide[] } | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* retry */
        }
      }
    }
    let slides = (parsed?.slides || [])
      .filter((s) => s && typeof s.title === "string" && typeof s.narration === "string" && s.narration.trim())
      .map((s) => ({
        title: String(s.title).trim(),
        bullets: Array.isArray(s.bullets)
          ? s.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, 5)
          : [],
        narration: String(s.narration).trim(),
      }));
    slides = slides.filter(
      (slide) => mentionedExcludedScopeTerms(JSON.stringify(slide), corpus, opts.focus).length === 0
    );
    if (slides.length >= 5 && slides.length <= 8) {
      // 生成后忠实度核验:只核对每页旁白(口播散文,编造高发处),保留页结构与要点。
      let finalSlides = slides;
      if (opts.verify !== false) {
        const r = await refineStructuredFields({ items: slides.map((s) => s.narration), sourcesText: corpus, instruction: opts.focus });
        if (r.changed) finalSlides = slides.map((s, i) => ({ ...s, narration: r.items[i].trim() }));
      }
      const missing = missingSupportedVerbatimPhrases(
        JSON.stringify(finalSlides),
        opts.focus,
        corpus
      );
      if (missing.length) continue;
      if (mentionedExcludedScopeTerms(JSON.stringify(finalSlides), corpus, opts.focus).length) continue;
      const effectiveLanguage = resolveOutputLanguageRequirement(opts.language, directive);
      const language = checkOutputLanguage(
        `${parsed?.title || ""}\n${finalSlides.flatMap((slide) => [slide.title, ...slide.bullets, slide.narration]).join("\n")}`,
        effectiveLanguage
      );
      if (!language.ok) continue;
      return { language: effectiveLanguage || parsed?.language || "", title: (parsed?.title || "Video overview").trim(), slides: finalSlides };
    }
  }
  throw new Error("生成视频脚本失败,请重试。");
}

// ---- slide rendering (SVG -> PNG) ----

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function charUnits(ch: string): number {
  return /[一-鿿぀-ヿ가-힯！-｠]/.test(ch) ? 2 : 1;
}

/** Greedy line-wrap by display units (CJK counts double), breaking on spaces when possible. */
function wrap(text: string, maxUnits: number): string[] {
  const lines: string[] = [];
  let line = "";
  let u = 0;
  let lastSpace = -1;
  for (const ch of text) {
    line += ch;
    u += charUnits(ch);
    if (ch === " ") lastSpace = line.length - 1;
    if (u >= maxUnits) {
      if (lastSpace > 0) {
        lines.push(line.slice(0, lastSpace));
        line = line.slice(lastSpace + 1);
      } else {
        lines.push(line);
        line = "";
      }
      u = [...line].reduce((a, c) => a + charUnits(c), 0);
      lastSpace = -1;
    }
  }
  if (line.trim()) lines.push(line);
  return lines.length ? lines : [text];
}

/** 基础权益视频水印：低透明度铺满 1280×720（免水印权益不注入）。
 *  SVG 不能像 xhs/信息图那样用 flex-wrap,改为显式生成一组 <text>,整块套一个绕画面
 *  中心(640,360)旋转 -26° 的 <g>;起点铺到画布外并按奇偶行错位,旋转后仍盖满四角。
 *  opacity 挂在 <g> 上统一控制;文档顺序在背景之后、正文之前 → 压在深色底上、被标题/要点盖住。 */
function videoWatermark(): string {
  const cells: string[] = [];
  const stepX = 330, stepY = 160;
  let row = 0;
  for (let y = -120; y < 900; y += stepY, row++) {
    const off = row % 2 ? stepX / 2 : 0;
    for (let x = -420 + off; x < 1680; x += stepX) {
      cells.push(
        `<text x="${x}" y="${y}" font-family="${FONT}" font-size="54" font-weight="800" fill="#ffffff" letter-spacing="12">${esc("猿笔记")}</text>`
      );
    }
  }
  return `<g aria-hidden="true" opacity="0.08" transform="rotate(-26 640 360)">${cells.join("")}</g>`;
}

async function renderSlide(
  slide: Slide,
  idx: number,
  total: number,
  deckTitle: string,
  watermark: boolean
): Promise<Buffer> {
  const parts: string[] = [
    `<rect width="1280" height="720" fill="#0b0b16"/>`,
    `<rect x="0" y="0" width="12" height="720" fill="#8b5cf6"/>`,
  ];
  if (watermark) parts.push(videoWatermark());
  let y = 150;
  for (const line of wrap(slide.title, 40)) {
    parts.push(
      `<text x="92" y="${y}" font-family="${FONT}" font-size="52" font-weight="700" fill="#f3f4f8">${esc(line)}</text>`
    );
    y += 66;
  }
  y += 34;
  for (const b of slide.bullets) {
    const lines = wrap(b, 54);
    lines.forEach((line, i) => {
      const x = i === 0 ? 100 : 132;
      parts.push(
        `<text x="${x}" y="${y}" font-family="${FONT}" font-size="32" fill="#aeb2c6">${esc(
          (i === 0 ? "•  " : "") + line
        )}</text>`
      );
      y += 48;
    });
    y += 14;
  }
  parts.push(
    `<text x="92" y="684" font-family="${FONT}" font-size="22" fill="#7a7e96">${esc(
      `${idx + 1} / ${total}  ·  ${deckTitle}`
    )}</text>`
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">${parts.join("")}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ---- assembly ----

/**
 * Generate a narrated slide-deck video. Returns the finished mp4 path plus a
 * markdown transcript. Narration uses the shared TTS (premium provider → offline system voice).
 */
export async function generateVideoOverview(
  notebookId: string,
  sourceIds?: string[],
  opts: VideoOpts = {}
): Promise<{ title: string; transcript: string; mp4Path: string; engine: string }> {
  const deck = await generateDeck(notebookId, sourceIds, opts);
  const key = langKey(deck.language, deck.slides.map((s) => s.narration).join(" "));
  const items = deck.slides.map((s) => ({
    text: s.narration,
    voice: 0 as const,
  }));
  const { dir, mp3s, engine } = await synthSegments(items, key);

  try {
    const segMp4s: string[] = [];
    for (let i = 0; i < deck.slides.length; i++) {
      const png = path.join(dir, `slide${i}.png`);
      await writeFile(png, await renderSlide(deck.slides[i], i, deck.slides.length, deck.title, opts.watermark ?? false));
      const seg = path.join(dir, `v${i}.mp4`);
      // One slide image held for the length of its narration. A still image
      // needs very few frames, and "veryfast" keeps encoding snappy.
      await run("ffmpeg", [
        "-y", "-loop", "1", "-i", png, "-i", mp3s[i],
        "-c:v", "libx264", "-tune", "stillimage", "-preset", "veryfast",
        "-pix_fmt", "yuv420p", "-r", "10",
        "-c:a", "aac", "-b:a", "96k", "-shortest", seg,
      ]);
      segMp4s.push(seg);
    }

    const listFile = path.join(dir, "list.txt");
    await writeFile(listFile, segMp4s.map((f) => `file '${f}'`).join("\n"));
    await mkdir(VIDEO_DIR, { recursive: true });
    const mp4Path = path.join(VIDEO_DIR, `${crypto.randomUUID()}.mp4`);
    await run("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      // 追溯:嵌入品牌元数据(ffprobe/播放器可读)—— 原来 MP4 零 metadata,抱走后无痕不可举证;
      // 现在容器里带上猿笔记指纹,合规溯源用。
      "-metadata", "artist=猿笔记 ApebookLM",
      "-metadata", "comment=本内容由猿笔记(apebooklm)智能生成,受版权保护,禁止未授权二次分发",
      "-metadata", "copyright=© 猿笔记 ApebookLM",
      "-metadata", "encoder=apebooklm",
      // Put the moov atom up front so browsers can stream/play before full download.
      "-movflags", "+faststart", mp4Path,
    ]);

    const transcript = deck.slides
      .map(
        (s, i) =>
          `### ${i + 1}. ${s.title}\n\n${s.bullets.map((b) => `- ${b}`).join("\n")}\n\n${s.narration}`
      )
      .join("\n\n");
    return { title: deck.title, transcript, mp4Path, engine };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Move a finished mp4 to its permanent id-based path.
 *  本地落位后,若 OSS 已配置,额外尽力上传并写旁标(失败静默降级纯本地)。
 *  OSS 未配置 → ossEnabled()=false → 只写本地(与历史逐字节一致)。 */
export async function commitVideoFile(mp4Path: string, id: string): Promise<void> {
  await mkdir(VIDEO_DIR, { recursive: true });
  const dest = path.join(VIDEO_DIR, `${id}.mp4`);
  await rename(mp4Path, dest);
  if (ossEnabled()) {
    await uploadAndMarkOss(path.join(VIDEO_DIR, id), `media/video/${id}.mp4`, dest, "video/mp4", putObject);
  }
}
