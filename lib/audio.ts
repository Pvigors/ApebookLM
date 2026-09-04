import { access, copyFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { CHAT_MODEL, getOpenAI } from "./openai";
import { buildGenerationCorpus } from "./corpus";
import { GROUNDING_RULES, PRESERVE_SPECIFICS_SPEECH } from "./grounding";
import { refineStructuredFields } from "./verify";
import { getNotebookDirective } from "./settings";
import { langKey, presetVoicePair, run, synthSegments } from "./tts";
import { ossEnabled, putObject } from "./oss";
import { uploadAndMarkOss } from "./media-store";
import { checkOutputLanguage, generationRetrievalQuery, mentionedExcludedScopeTerms, missingSupportedVerbatimPhrases, resolveOutputLanguageRequirement, studioInstructionClause } from "./generation-contract";

export const AUDIO_DIR = path.join(process.cwd(), ".data", "audio");

type Turn = { speaker: "A" | "B"; text: string };

export type AudioOpts = {
  format?: string;
  focus?: string;
  length?: string;
  language?: string;
  verify?: boolean;
  memberId?: string | null;
  /** C5 音色组合:预设 key(components/studio-shared VOICE_PRESETS);查不到/留空 = 默认对。 */
  voices?: string;
};

function dialoguePrompt(opts: AudioOpts): string {
  const fmt = opts.format || "deep_dive";
  // brief 是「约两分钟」的单主持速览,turn 数要小且基本不随 length 档位放大,
  // 否则默认 length 会算出 10-16 turn,远超两分钟预期。
  const turns =
    fmt === "brief"
      ? opts.length === "longer"
        ? "6 to 8"
        : "4 to 6"
      : opts.length === "shorter"
      ? "6 to 8"
      : opts.length === "longer"
      ? "16 to 22"
      : "10 to 16";
  let base: string;
  if (fmt === "brief") {
    base = `You are scripting a SHORT single-host audio brief (about two minutes) about the provided sources: one host gives a crisp spoken summary of the most important points. Use ONLY speaker "A" for every turn.`;
  } else if (fmt === "debate") {
    base = `You are scripting a lively two-host DEBATE about the provided sources: Host A argues one side and Host B the other, each citing the sources, ending with a balanced takeaway.`;
  } else if (fmt === "critique") {
    base = `You are scripting a two-host CRITIQUE: the hosts constructively evaluate the ideas and claims in the sources — strengths, weaknesses, and open questions.`;
  } else {
    base = `You are scripting a two-host "deep dive" audio overview about the provided sources. Host A (the curious guide) and Host B (the expert) have a natural spoken conversation covering the key points, insights, and takeaways.`;
  }
  const focusLine = studioInstructionClause(opts.focus);
  const langLine =
    opts.language && opts.language.trim()
      ? `\n- Write ALL dialogue in ${opts.language.trim()}.`
      : "\n- Use the dominant language of the sources.";
  const speakerRule =
    fmt === "brief"
      ? ' Every turn uses speaker "A".'
      : " Strictly alternate speakers, beginning with A welcoming listeners.";
  // 中文播客公认痛点:「像结构化知识点摘要朗读」「转折生硬」。下面的口语韵律/真互动/
  // 数字口语化/开场收尾规则专治这几条;JSON 结构与说话人字段保持不变。
  const interactLine =
    fmt === "brief"
      ? ""
      : `\n- REAL interaction, never turn-taking recitation: most turns must react to the PREVIOUS turn — follow-up questions, quick clarifications, building on a point, or a brief gentle disagreement that gets resolved. FORBIDDEN: the two hosts alternately reading summary bullets at each other.`;
  return `${base}
Reply with STRICT JSON only: {"language":"<zh or en>","title":"<short episode title>","turns":[{"speaker":"A"|"B","text":"..."}]}
- ${turns} turns total.${speakerRule}
- Spoken and conversational (contractions, brief reactions) — NOT a bulleted list read aloud. Each turn is 1-4 sentences.
- Natural spoken rhythm: prefer SHORT sentences; punctuate the pauses people actually make (commas, dashes); sprinkle a few light fillers where natural (in Chinese: 嗯、对、其实、你看) — at most one per turn, never stacked.${interactLine}
- The text goes straight to TTS, so write numbers/symbols the way a host would SAY them: in Chinese 「百分之七十」 not 「70%」, 「三点五倍」 not 「3.5x」; in English "seventy percent" not "70%". Expand uncommon abbreviations on first mention.
- Opening (first turn): within the first ten seconds, say what today's episode is about AND why it is worth listening. Closing (last turn): end with ONE concrete takeaway or action the listener can apply.

${GROUNDING_RULES}
${PRESERVE_SPECIFICS_SPEECH}
${langLine}${focusLine}
- No markdown, no stage directions, no citation markers.`;
}

async function generateDialogue(
  notebookId: string,
  sourceIds?: string[],
  opts: AudioOpts = {}
): Promise<{ language: string; title: string; turns: Turn[] }> {
  const corpus = await buildGenerationCorpus(
    notebookId,
    generationRetrievalQuery(opts.focus, "核心观点 关键信息 要点 论据 结论"),
    sourceIds
  );
  if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
  return dialogueFromCorpus(corpus, await getNotebookDirective(notebookId, opts.memberId), opts);
}

/** Dialogue script from an already-built corpus — eval entry point (no TTS),
 *  lets the harness feed a fixed golden corpus and A/B `verify` on/off. */
export async function dialogueFromCorpus(
  corpus: string,
  directive: string,
  opts: AudioOpts = {}
): Promise<{ language: string; title: string; turns: Turn[] }> {
  if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
  // The model occasionally returns an unusable payload; retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await getOpenAI().chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.7,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: dialoguePrompt(opts) },
        { role: "user", content: `Sources:\n\n${corpus}${directive}` },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    let parsed: { language?: string; title?: string; turns?: Turn[] } | null = null;
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
    const turns = (parsed?.turns || [])
      .filter((t) => t && typeof t.text === "string" && t.text.trim())
      .map((t) => ({ speaker: t.speaker === "B" ? "B" : "A", text: t.text.trim() } as Turn));
    if (turns.length >= 2) {
      // 生成后忠实度核验:只核对每轮台词文本,保留对话结构(说话人/轮次)。
      let finalTurns = turns;
      if (opts.verify !== false) {
        const r = await refineStructuredFields({ items: turns.map((t) => t.text), sourcesText: corpus, instruction: opts.focus });
        if (r.changed) finalTurns = turns.map((t, i) => ({ ...t, text: r.items[i].trim() }));
      }
      finalTurns = finalTurns.filter(
        (turn) => mentionedExcludedScopeTerms(turn.text, corpus, opts.focus).length === 0
      );
      const joined = finalTurns.map((turn) => turn.text).join("\n");
      const missing = missingSupportedVerbatimPhrases(joined, opts.focus, corpus);
      if (missing.length) continue;
      if (mentionedExcludedScopeTerms(joined, corpus, opts.focus).length) continue;
      const fmt = opts.format || "deep_dive";
      const expectedRange: [number, number] = fmt === "brief"
        ? opts.length === "longer" ? [6, 8] : [4, 6]
        : opts.length === "shorter" ? [6, 8] : opts.length === "longer" ? [16, 22] : [10, 16];
      if (finalTurns.length < expectedRange[0] || finalTurns.length > expectedRange[1]) continue;
      if (fmt === "brief" && finalTurns.some((turn) => turn.speaker !== "A")) continue;
      if (fmt !== "brief" && finalTurns.some((turn, index) => turn.speaker !== (index % 2 === 0 ? "A" : "B"))) continue;
      const effectiveLanguage = resolveOutputLanguageRequirement(opts.language, directive);
      const language = checkOutputLanguage(
        `${parsed?.title || ""}\n${finalTurns.map((turn) => turn.text).join("\n")}`,
        effectiveLanguage
      );
      if (!language.ok) continue;
      return {
        language: effectiveLanguage || parsed?.language || "",
        title: (parsed?.title || "Audio overview").trim(),
        turns: finalTurns,
      };
    }
  }
  throw new Error("生成播客对话失败,请重试。");
}

// ── 品牌口播尾签 ─────────────────────────────────────────────────────────────
// 正片之后追加一句品牌口播。尾签 mp3 懒生成 + 磁盘缓存(存在即复用);
// 任何一步失败都输出无尾签原片 —— 绝不能让尾签毁掉主产物。
const BRAND_OUTRO_TEXT = "本期内容由猿笔记根据你的资料智能生成。";
const BRAND_OUTRO_PROFILE = "speech-2.8-hd-wise-women-v1";

// 追溯:MP3 的 ID3 元数据(ffmpeg -metadata → TPE1/COMM/TCOP/TENC)。原来音频零 ID3 标签,
// 抱走后 ffprobe 一片空白、不可举证;现在容器层带上猿笔记指纹用于合规溯源。
const MP3_ID3_META = [
  "-metadata", "artist=猿笔记 ApebookLM",
  "-metadata", "comment=本内容由猿笔记(apebooklm)智能生成,受版权保护,禁止未授权二次分发",
  "-metadata", "copyright=© 猿笔记 ApebookLM",
  "-metadata", "encoder=apebooklm",
];

/** 尾签 mp3:走当前 TTS 链懒生成并按模型/音色版本缓存;非 minimax(edge/say 兜底
 *  音色音质差,读品牌口播反伤品牌)返回 null 跳过。 */
async function brandOutroFile(engine: string): Promise<string | null> {
  if (engine !== "minimax") return null;
  const cached = path.join(AUDIO_DIR, `brand-outro-${engine}-${BRAND_OUTRO_PROFILE}.mp3`);
  try {
    await access(cached);
    return cached; // 存在即复用
  } catch {
    /* 未生成过,继续 */
  }
  // 复用 synthSegments:与正片分段走同一条归一化管线(32kHz/mono/128k),编码参数天然一致。
  // 尾签文案固定中文,voice 固定用 zh 的 A 主持音色;刻意不传 voicePair(C5 音色预设)——
  // 品牌口播恒用默认音色,缓存也就恒按引擎一份,不随预设数量膨胀。
  const { dir, mp3s, engine: got } = await synthSegments([{ text: BRAND_OUTRO_TEXT, voice: 0 }], "zh");
  try {
    // 生成途中黏性降级到 edge/say → 弃用本次结果(不缓存),本期不带尾签。
    if (got !== "minimax" || !mp3s.length) return null;
    await mkdir(AUDIO_DIR, { recursive: true });
    await copyFile(mp3s[0], cached);
    return cached;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 正片后拼接尾签。拼接这一步统一重编码(concat -c copy 要求各段参数完全一致,重编码
 *  彻底规避编码不一致坑);生成/拼接任一失败,原样返回无尾签正片。 */
async function appendBrandOutro(mainPath: string, engine: string, tmpDir: string): Promise<string> {
  let outPath = "";
  try {
    const outro = await brandOutroFile(engine);
    if (!outro) return mainPath;
    const listFile = path.join(tmpDir, "list-outro.txt");
    await writeFile(listFile, [mainPath, outro].map((f) => `file '${f}'`).join("\n"));
    outPath = path.join(AUDIO_DIR, `${crypto.randomUUID()}.mp3`);
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-ar", "32000", "-ac", "1", "-b:a", "128k", ...MP3_ID3_META, outPath]);
    await rm(mainPath, { force: true });
    return outPath;
  } catch (e) {
    if (outPath) await rm(outPath, { force: true }).catch(() => {});
    console.warn("[audio] 品牌尾签追加失败,输出无尾签原片:", (e as Error).message);
    return mainPath;
  }
}

/**
 * Generate a two-host audio overview. Returns the finished mp3 path plus the
 * transcript. Uses configured premium TTS or an offline system voice (see lib/tts).
 */
export async function generateAudioOverview(
  notebookId: string,
  sourceIds?: string[],
  opts: AudioOpts = {}
): Promise<{ title: string; transcript: string; mp3Path: string; engine: string; voiceDowngraded: boolean }> {
  const dialogue = await generateDialogue(notebookId, sourceIds, opts);
  const key = langKey(dialogue.language, dialogue.turns.map((t) => t.text).join(" "));
  const items = dialogue.turns.map((t) => ({
    text: t.text,
    voice: (t.speaker === "A" ? 0 : 1) as 0 | 1,
  }));
  // C5 音色组合:按预设 key 查表取「本期对话语言」的音色对;key 未知或该预设没配
  // 这个语言 → undefined,synthSegments 回落默认对。仅 minimax 生效,edge/say 兜底忽略。
  const requestedPair = presetVoicePair(opts.voices, key);
  const { dir, mp3s, engine, preferredEngine } = await synthSegments(items, key, requestedPair);
  // 默认搭档和自选预设统一判定：只要原计划走 MiniMax、实际整集改走免费兜底，
  // 就标记降级并触发折价。不能因默认预设没有显式 voicePair 而漏报。
  const voiceDowngraded = preferredEngine === "minimax" && engine !== "minimax";
  try {
    const listFile = path.join(dir, "list.txt");
    await writeFile(listFile, mp3s.map((f) => `file '${f}'`).join("\n"));
    await mkdir(AUDIO_DIR, { recursive: true });
    const mp3Path = path.join(AUDIO_DIR, `${crypto.randomUUID()}.mp3`);
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", ...MP3_ID3_META, mp3Path]);
    // 品牌尾签:正片之后追加口播;任何失败自动回退无尾签原片(见 appendBrandOutro)。
    const finalPath = await appendBrandOutro(mp3Path, engine, dir);
    const transcript = dialogue.turns
      .map((t) => `**${t.speaker === "A" ? "Host A" : "Host B"}:** ${t.text}`)
      .join("\n\n");
    return { title: dialogue.title, transcript, mp3Path: finalPath, engine, voiceDowngraded };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Move a finished mp3 to its permanent id-based path.
 *  本地落位后,若 OSS 已配置,额外尽力上传并写旁标(失败静默降级纯本地)。
 *  OSS 未配置 → ossEnabled()=false → 只写本地(与历史逐字节一致)。 */
export async function commitAudioFile(mp3Path: string, id: string): Promise<void> {
  await mkdir(AUDIO_DIR, { recursive: true });
  const dest = path.join(AUDIO_DIR, `${id}.mp3`);
  await rename(mp3Path, dest);
  if (ossEnabled()) {
    await uploadAndMarkOss(path.join(AUDIO_DIR, id), `media/audio/${id}.mp3`, dest, "audio/mpeg", putObject);
  }
}
