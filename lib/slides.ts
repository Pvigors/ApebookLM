import { CHAT_MODEL, getOpenAI } from "./openai";
import { buildGenerationCorpus } from "./corpus";
import { GROUNDING_RULES, multiSourcePreamble, outputLanguageClause } from "./grounding";
import { refineStructuredFields } from "./verify";
import { getNotebookDirective } from "./settings";
import { checkOutputLanguage, generationRetrievalQuery, mentionedExcludedScopeTerms, missingSupportedVerbatimPhrases, requestedCount, resolveOutputLanguageRequirement, studioInstructionClause } from "./generation-contract";
import { slideTone, isSlideThemeId, pickThemeForText, type SlideThemeId } from "./slide-themes";
import { DECK_ICONS, normalizeSlides, type DeckSlide } from "./deck";

export type Slide = { title: string; bullets: string[] };
// watermark:免费档生成时烤进 deck JSON(baked-at-gen);pptx 导出与在线预览/放映都读它,
// 基础权益带实例品牌水印，免水印权益不带。slidesFromCorpus 不带 tier 时默认不加。
export type Deck = { title: string; slides: DeckSlide[]; theme?: SlideThemeId; watermark?: boolean; language?: string };

function slideVisibleText(slide: DeckSlide): string[] {
  const text = [slide.title, slide.subtitle || "", ...(slide.bullets || []), slide.center || "", slide.quote || "", slide.attribution || "", slide.note || ""];
  for (const card of slide.cards || []) text.push(card.label, card.sub || "", card.text || "");
  if (slide.left) text.push(slide.left.label, ...slide.left.points);
  if (slide.right) text.push(slide.right.label, ...slide.right.points);
  for (const row of slide.rows || []) text.push(row.dim, row.left, row.right);
  for (const item of slide.items || []) text.push(item.label, item.text || "");
  for (const stat of slide.stats || []) text.push(stat.value, stat.label, stat.text || "");
  if (slide.chart) text.push(slide.chart.unit || "", ...slide.chart.data.map((point) => point.label));
  return text.filter(Boolean);
}

/** 整套修订沿用原制品契约；缺失旧字段时水印 fail-closed、语言按现有内容推断。 */
export function resolveDeckRevisionConfig(
  deck: Deck | null,
  data?: { watermark?: boolean; language?: string }
): { theme?: SlideThemeId; watermark: boolean; language?: string } {
  const visibleText = JSON.stringify(deck?.slides ?? []);
  const inferredLanguage = /[\u3400-\u9fff]/.test(visibleText)
    ? "简体中文"
    : /[A-Za-z]{3,}/.test(visibleText)
      ? "English"
      : undefined;
  return {
    theme: deck?.theme,
    watermark: deck?.watermark ?? data?.watermark ?? true,
    language: deck?.language || data?.language || inferredLanguage,
  };
}

const PROMPT = `You are a presentation designer creating a visually rich slide deck about the provided sources.
Reply with STRICT JSON only: {"language":"<zh or en>","title":"<deck title>","slides":[<Slide>...]}

Each <Slide> is ONE of these layouts:
1. {"layout":"cover","title":"<deck headline>","subtitle":"<one-line framing>","bullets":["<eyebrow label ≤10 chars>","<short tag ≤6 chars>","<short tag ≤6 chars>","<short tag ≤6 chars>"]}  (bullets[0] is a tiny eyebrow above the title; bullets[1-3] are short agenda chips — NEVER full sentences)
2. {"layout":"cards","title":"<section title>","cards":[{"icon":"<from icon list>","label":"<2-6 char concept>","sub":"<short colored tagline>","text":"<1-2 sentence explanation>","tone":"a|b|c|d"}],"note":"<optional one-line takeaway quote>"}
3. {"layout":"compare","title":"<section title>","left":{"label":"<side A>","points":[]},"right":{"label":"<side B>","points":[]},"rows":[{"dim":"<dimension, e.g. 成本>","left":"<A value>","right":"<B value>"}],"note":"<optional verdict line>"}
   (When both sides contrast on the SAME dimensions, fill "rows" (3-6) and leave points empty — it renders as an aligned VS table. Otherwise omit "rows" and fill "points".)
4. {"layout":"rings","title":"<section title>","center":"<core concept, 2-6 chars>","items":[{"label":"<ring item>","text":"<short note>","icon":"<from icon list>","tone":"a|b|c|d"}],"note":"<optional>"}
   (Use for layers, ecosystems, risk gradients, roles around a core — 3-6 items.)
5. {"layout":"steps","title":"<section title>","items":[{"label":"<step name>","text":"<short note>","tone":"a|b|c|d"}],"note":"<optional>"}
   (Use for processes/workflows/how-to sequences — 3-5 ordered steps.)
6. {"layout":"timeline","title":"<section title>","items":[{"label":"<time/phase>","text":"<what happens>","tone":"a|b|c|d"}],"note":"<optional>"}
   (Use for history, schedules, roadmaps, evolution over time — 3-6 milestones.)
7. {"layout":"stats","title":"<section title>","stats":[{"value":"<big number with unit, e.g. 50万+>","label":"<what it measures>","text":"<optional context>","tone":"a|b|c|d"}],"note":"<optional>"}
   (Use when the sources contain striking numbers — 2-4 stats. NEVER invent numbers.)
8. {"layout":"chart","title":"<section title>","chart":{"type":"bar|line|pie","data":[{"label":"<item>","value":<number>}],"unit":"<optional unit>"},"note":"<optional>"}
   (Use ONLY when the sources contain real comparable numbers — 3-8 data points.)
9. {"layout":"quote","title":"<small kicker, optional>","quote":"<the most striking sentence from the sources>","attribution":"<source/speaker, optional>"}
   (A full-slide pull quote — use at most once, for a truly memorable line.)
10. {"layout":"bullets","title":"<section title>","bullets":["<concise point>"],"note":"<optional>"}
11. {"layout":"takeaways","title":"<closing title>","bullets":["<3-5 key takeaways>"]}

Icon list: ${DECK_ICONS.join(", ")}.

Design rules:
- Slide count: 6 to 9 slides BY DEFAULT. But if the user's 额外要求 specifies how many slides/pages
  (e.g. 「只需要一页」/「控制在 3 页内」/「5 张」/"one page"/"3 slides"), that count OVERRIDES this default —
  produce EXACTLY that many slides, down to a SINGLE slide if asked. When the requested count is too small
  for the cover+takeaways frame (e.g. 1–2 slides), DROP that frame and just make the requested number of
  content slides (a one-slide deck = one self-contained slide summarizing everything). Only when NO count is
  requested: Slide 1 MUST be "cover" and the last MUST be "takeaways".
- VARY the layouts: aim for at least one "cards", and prefer "steps"/"timeline"/"stats"/"chart"/"compare"(with rows)/"rings" over plain bullets whenever the content fits. Plain "bullets" at most 1 slide.
- Vary tones across cards/items in one slide (a,b,c,d in order). Pick the icon that best matches each concept.
- "label" is the big card word; "sub" is a punchy colored subtitle; "text" explains it in the source language.
- Use the dominant language of the sources.

${GROUNDING_RULES}
- No markdown, no citation markers.`;

/** Generate a slide deck; content is JSON: {"title","slides":[DeckSlide...],"theme"}. */
export async function generateSlides(
  notebookId: string,
  sourceIds?: string[],
  opts?: { instruction?: string; language?: string; theme?: string; verify?: boolean; watermark?: boolean; memberId?: string | null }
): Promise<{ title: string; content: string }> {
  const directive = await getNotebookDirective(notebookId, opts?.memberId);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // 第二轮(首轮被限流/网络错误打断时)收缩语料与输出预算:moonshot 备用
    // 接口的项目 TPM 限额仅 10k tokens/min,全量语料(18k 字符 + 4k 输出)
    // 单次请求即超限 —— 小请求保证在两个接口上都能过。
    const corpus = await buildGenerationCorpus(
      notebookId,
      generationRetrievalQuery(opts?.instruction, "核心论点 关键数据 主要观点 步骤 对比 趋势"),
      sourceIds,
      { k: attempt === 0 ? 24 : 12 }
    );
    if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
    try {
      const deck = await slidesFromCorpus(corpus, directive, { ...opts, maxTokens: attempt === 0 ? 4096 : 3072 });
      // 水印按发起用户档位烤进 deck JSON(免费=true),pptx 导出与预览/放映统一读取。
      return { title: deck.title, content: JSON.stringify({ ...deck, watermark: opts?.watermark ?? false }) };
    } catch (e) {
      lastErr = e;
      console.warn(`[studio] slides attempt ${attempt + 1} failed:`, (e as Error).message);
    }
  }
  // 两轮都失败 → 抛底层错误,任务层会翻译成可读文案
  if (lastErr instanceof Error) throw lastErr;
  throw new Error("生成幻灯片失败,请重试。");
}

/** Deck from an already-built corpus — eval entry point, lets the harness feed a
 *  fixed golden corpus and A/B `verify` on/off. One LLM attempt (caller retries). */
export async function slidesFromCorpus(
  corpus: string,
  directive: string,
  opts?: { instruction?: string; language?: string; theme?: string; verify?: boolean; maxTokens?: number }
): Promise<Deck> {
  if (!corpus) throw new Error("勾选的内容暂无可用文本,请换选来源/会话/笔记。");
  // 手选了具体模版 → 尊重并注入其文风基调;「自动」→ 文风不强加(交给视觉风格表达),
  // 模版留到生成后按「标题 + 各页标题」(最纯的主题信号)来挑,避免被语料里的
  // 枝节关键词(如番茄笔记里大量的软件/工具词)带偏。
  const manual: SlideThemeId | null = isSlideThemeId(opts?.theme) ? opts.theme : null;
  const tone = manual ? slideTone(manual) : "";
  // 文风基调来自所选模版(默认遵循),用户的「额外要求」放在后面,优先级更高。
  const hint =
    // 弱尾行升级为 outputLanguageClause 强子句(覆盖「用来源语言」默认,与其它制品统一)。
    outputLanguageClause(opts?.language) +
    (tone ? `\n\n文风基调(默认遵循):${tone}` : "") +
    studioInstructionClause(opts?.instruction);
  // ≥2 个来源块时前置一条最高优先级指令,确保整套 deck 覆盖全部来源,而不是
  // 围着一个最好讲的来源做、忽略其余。语料块以 "\n\n---\n\n" 分隔。
  const multiSrc = multiSourcePreamble(corpus, "slide");
  const res = await getOpenAI().chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.5,
    max_tokens: opts?.maxTokens ?? 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${multiSrc}${PROMPT}${studioInstructionClause(opts?.instruction)}` },
      { role: "user", content: `Sources:\n\n${corpus}${directive}${hint}` },
    ],
  });
  const raw = res.choices[0]?.message?.content ?? "";
  let parsed: { title?: string; slides?: unknown; language?: string } | null = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
  }
  let slides = normalizeSlides(parsed?.slides);
  slides = slides.filter(
    (slide) => mentionedExcludedScopeTerms(JSON.stringify(slide), corpus, opts?.instruction).length === 0
  );
  const expectedSlides = requestedCount(opts?.instruction, ["页", "张", "slides", "slide", "pages", "page"]);
  if (expectedSlides !== null && slides.length > expectedSlides) {
    const contentSlides = slides.filter((slide) => slide.layout !== "cover" && slide.layout !== "takeaways");
    slides = (contentSlides.length >= expectedSlides ? contentSlides : slides).slice(0, expectedSlides);
  } else if (expectedSlides === null && slides.length > 9) {
    slides = slides.slice(0, 9);
  }
  // 允许单页 deck:用户可以要求「只需要一页」,此前 <2 硬拒会把合法的单页当失败重试/报错。
  // 只拒真正空的(0 页 = 生成失败)。
  if (
    slides.length < 1 ||
    (expectedSlides !== null && slides.length !== expectedSlides) ||
    (expectedSlides === null && (slides.length < 6 || slides.length > 9))
  ) {
    console.error("[studio] slides JSON unusable:", JSON.stringify(raw.slice(0, 300)));
    throw new Error("生成幻灯片失败,请重试。");
  }
  const title = (String(parsed?.title ?? "").trim() || slides[0]?.title || "Slide deck").trim();
  // 生成后忠实度核验:收集所有页的要点文本统一核对,再按序写回,保留页与版式结构。
  let finalSlides = slides;
  if (opts?.verify !== false) {
    const idx: { s: number; b: number }[] = [];
    const texts: string[] = [];
    slides.forEach((sl, s) => (sl.bullets ?? []).forEach((b, bi) => { idx.push({ s, b: bi }); texts.push(b); }));
    if (texts.length) {
      const r = await refineStructuredFields({ items: texts, sourcesText: corpus, instruction: opts?.instruction });
      if (r.changed) {
        finalSlides = slides.map((sl) => ({ ...sl, bullets: sl.bullets ? [...sl.bullets] : sl.bullets }));
        idx.forEach((p, k) => { finalSlides[p.s].bullets![p.b] = r.items[k].trim(); });
      }
    }
  }
  // 用「标题 + 封面副标」挑风格:最稳的主题信号,同一主题→同一风格(可复现),
  // 不被各页标题里的枝节词带偏。
  const cover = slides.find((s) => s.layout === "cover") ?? slides[0];
  const theme: SlideThemeId = manual ?? pickThemeForText(`${title} ${cover?.subtitle ?? ""} ${cover?.title ?? ""}`);
  const missing = missingSupportedVerbatimPhrases(JSON.stringify(finalSlides), opts?.instruction, corpus);
  if (missing.length) throw new Error(`生成结果未执行“原样包含”要求:${missing[0]}`);
  const excluded = mentionedExcludedScopeTerms(JSON.stringify(finalSlides), corpus, opts?.instruction);
  if (excluded.length) throw new Error(`生成结果包含已排除范围:${excluded[0]}`);
  const visibleText = [title, ...finalSlides.flatMap(slideVisibleText)];
  const effectiveLanguage = resolveOutputLanguageRequirement(opts?.language, directive);
  const languageCheck = checkOutputLanguage(visibleText.join("\n"), effectiveLanguage);
  if (!languageCheck.ok) throw new Error(`生成幻灯片未执行输出语言要求:${languageCheck.reason}`);
  return { title, slides: finalSlides, theme, language: effectiveLanguage || String(parsed?.language ?? "").trim() || undefined };
}

/** 单页改写:保留其余幻灯片,仅按要求重写第 index 页(NotebookLM「更改幻灯片 N」)。 */
export async function reviseSlide(
  notebookId: string,
  sourceIds: string[] | undefined,
  deck: Deck,
  index: number,
  instruction: string,
  language?: string
): Promise<{ title: string; content: string }> {
  const current = deck.slides[index];
  if (!current) throw new Error("幻灯片不存在");
  const corpus =
    (await buildGenerationCorpus(notebookId, `${current.title} ${instruction}`, sourceIds, { k: 10 })) ?? "";
  const sys =
    PROMPT +
    `\n\n———\n本次为「单页改写」:忽略上面关于整套 deck 与「6~9 页」的规则。只返回 STRICT JSON 的**单个** <Slide> 对象(上述任一 layout)。除非指令明确要求,否则保持原 "layout" 不变,并贴合原页的信息密度。`;
  const user =
    `Deck 标题:${deck.title}\n这是第 ${index + 1}/${deck.slides.length} 页。\n\n` +
    `当前这页的 JSON:\n${JSON.stringify(current)}\n\n` +
    (corpus ? `可参考的来源(仅供取材,勿编造):\n${corpus}\n\n` : "") +
    `请按以下要求改写这一页:${instruction}${outputLanguageClause(language || deck.language)}\n\n只返回改写后的「单页」JSON 对象。`;
  const res = await getOpenAI().chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.4,
    max_tokens: 1400,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });
  const raw = res.choices[0]?.message?.content ?? "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        /* unusable */
      }
    }
  }
  const p = parsed as { slides?: unknown[]; slide?: unknown } | null;
  const cand: unknown = (p?.slides && p.slides[0]) ?? p?.slide ?? parsed;
  const [normalized] = normalizeSlides(cand == null ? [] : [cand]);
  // normalizeSlides 对无法解析的形状会**退化成空白 bullets 片**(truthy 但无内容),
  // 直接 splice = 把用户要「改进」的片替换成空白,还扣了 5 积分。校验非空,空则抛错保留原片。
  const hasContent = (s: unknown): boolean => {
    const x = s as Record<string, any>;
    if (!x) return false;
    if (x.title?.trim?.() || x.subtitle?.trim?.() || x.quote?.trim?.() || x.center?.trim?.()) return true;
    if (x.bullets?.length || x.cards?.length || x.items?.length || x.stats?.length || x.rows?.length) return true;
    if (x.left?.points?.length || x.right?.points?.length) return true;
    if (x.chart?.data?.length) return true;
    return false;
  };
  if (!normalized || !hasContent(normalized)) {
    throw new Error("修改结果为空或无法解析,请重试(原片已保留)。");
  }
  const revisedVisible = slideVisibleText(normalized);
  const revisedLanguage = resolveOutputLanguageRequirement(language || deck.language);
  const languageCheck = checkOutputLanguage(revisedVisible.join("\n"), revisedLanguage);
  if (!languageCheck.ok) throw new Error(`修改结果未执行输出语言要求:${languageCheck.reason}`);
  const slides = deck.slides.slice();
  slides[index] = normalized;
  return {
    title: deck.title,
    // 保留原 deck 的水印位:免费档改单页后仍带水印,不因改写而漏。
    content: JSON.stringify({
      title: deck.title,
      slides,
      theme: deck.theme,
      watermark: deck.watermark,
      language: language || deck.language,
    } satisfies Deck),
  };
}
