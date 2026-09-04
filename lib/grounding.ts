/**
 * 共享「忠于来源」契约 —— 注入到每个生成器的 system 提示。
 *
 * 深度测试发现:report/mindmap/表格类会编造来源里没有的具体数字、出版信息、引语、
 * KPI、理论术语,并伪装成「来源依据」。根因是旧提示里只有一句很弱的
 * "never invent facts",却被 "be thorough / information-dense / 4-7 branches /
 * any notable figures or quotes" 等「求全求密」的指令盖过 —— 模型为凑数/凑密度
 * 就调用了自带世界知识。
 *
 * 这段契约用强约束显式压过那些「求全」指令:宁可少而有据,绝不补全编造。
 * 放在 system 提示靠前位置,并声明其优先级高于后文任何「要全/要密」的要求。
 */
export const GROUNDING_RULES = `STRICT GROUNDING (this OVERRIDES any later instruction to be thorough, dense, complete, or to hit a count):
- Use ONLY facts explicitly stated in the provided sources. Add NOTHING from your own prior knowledge — not even about familiar/common topics. If a fact is not in the sources, treat it as nonexistent.
- NEVER invent specifics the sources do not state: numbers, durations, dates, percentages, statistics, prices, publishers, ISBNs, page counts, author names, product features, KPIs, or technical/theory terms.
- IGNORE non-content boilerplate — it is NOT knowledge and must never become a node/section/item/question/branch: site navigation & menus, ICP 备案号 / 许可证编码/编号 / filing numbers, copyright lines, contact info & addresses, social-media handles/accounts (微信号/微博/抖音号/快手 ID), app-download matrices, 友情链接/related-links lists, cookie/login prompts, share/print controls. Extract ONLY the substantive subject matter. If a "source" is essentially just such boilerplate (e.g. a scraped homepage or nav page), give it little or no space — do NOT manufacture structure from a navigation dump.
- A source may provide NO real body text (only a URL, a bare title, or a fetch/anti-crawl failure notice). Do NOT infer, guess, or "imply from the URL/title" what it is about — omit that source entirely rather than fabricate a plausible-sounding branch for it.
- NEVER fabricate quotes. Use quotation marks ONLY around text that appears verbatim in the sources; otherwise paraphrase WITHOUT quotation marks.
- NEVER present invented or inferred content as if it were sourced (no fake "依据/来源/evidence" values, no claiming "multiple sources agree" unless they verifiably do).
- Do NOT bridge unrelated sources into a combined/causal claim that no single source makes.
- COVER EVERY PROVIDED SOURCE: the corpus may hold several distinct sources, each under its own \`# <标题>\` heading (blocks separated by \`---\`). Draw on ALL of them — never develop one source in depth while silently dropping the others. When sources share a topic, synthesize across them; when they are unrelated, give EACH its own top-level branch / section / grouping so every source is represented. This is breadth ACROSS sources (which sources to include), NOT padding any single source's item count, and it does NOT license inventing cross-source links. If the user's 额外要求 narrows the scope to one source/aspect, honor that instead and cover only that.
- Prefer FEWER, fully-grounded items over more padded ones. Do NOT pad to reach a target count — if the sources support only N items, output exactly N.
- When sources conflict, reflect the disagreement instead of silently asserting one side as fact.
- Do NOT write meta-commentary about sourcing or these rules INTO the output itself — no "(来源明确)", "据来源", "本文严格依据所给文本", "不涉及外部知识/推断", "per the sources" notes. Just present the grounded content directly.`;

/**
 * 多来源覆盖前缀(count-aware,比 GROUNDING_RULES 里那条通用「覆盖全部来源」更硬)。
 * 当语料含 ≥2 个来源块(以 `\n\n---\n\n` 分隔、各有 `# <标题>`)时返回一段最高优先级
 * 指令,逼模型把每个来源都写到,避免「围着一个最好讲的来源做、其余丢掉」的塌方。
 * unit = 制品的自然单位:slides→"slide"、音视频→"section"、信息图→"block"、报告→"section"。
 * 单来源返回空串(不打扰)。
 */
export function multiSourcePreamble(corpus: string, unit = "section"): string {
  const srcCount = corpus.split(/\n\n---\n\n/).length;
  if (srcCount < 2) return "";
  return `MULTI-SOURCE (highest priority): the corpus has ${srcCount} DISTINCT sources, each under its own "# <title>" block. You MUST cover EVERY source — never build the whole output around one source and drop the rest. If they share a topic, weave them into one narrative; if they are UNRELATED, give EACH source its own ${unit} (or small group) so all ${srcCount} are represented. (If 额外要求 names a specific source/aspect, cover only that.)\n\n`;
}

// 保留具体性 —— 文档/报告版(详尽:枚举集合逐项、保留度量/年份/示例)。
export const PRESERVE_SPECIFICS =
  "Keep the CONCRETE specifics the sources give — durations, ranges, measurements (page-layout cm), counts, named people and years, color codes, worked examples. When the sources enumerate a set (symbols, steps, scenarios, tools), reproduce EVERY item with its meaning (X = Y), not a sample. Never compress a multi-step 'how' into a one-line gloss, never end a list with vague fillers (等 / 相关 / 一些). A concrete detail beats a benefit-word ('25 分钟内被打断则该番茄作废' beats '提高专注力').";

// 保留具体性 —— 口播/旁白版(音频/视频):口语化不等于丢事实。
export const PRESERVE_SPECIFICS_SPEECH =
  "PRESERVE SPECIFICS: when the sources give concrete numbers, durations, dates, named examples, or people, SAY them out loud — don't flatten them into vague generalities. Conversational/spoken style does NOT mean dropping the facts; a specific number or example is more memorable than a benefit-word.";

/**
 * 逐次生成的「输出语言」覆盖子句(配置弹窗里为这次生成选的语言)。最高优先级,
 * 覆盖来源主语言/笔记本默认语言。空 → 空串(不强制)。各生成器把它追加到 prompt 末尾。
 */
export function outputLanguageClause(language?: string): string {
  const lang = language?.trim();
  if (!lang) return "";
  return `\n\n【输出语言 · 最高优先级】必须用「${lang}」撰写输出里的全部文字(标题、节点标签、正文、选项、旁白、解析等),逐字翻译成该语言。这条**覆盖**前文任何"用来源的主要语言 / in the dominant language of the sources"之类的默认要求——来源是什么语言都不影响,一律输出「${lang}」。内容仍严格忠于来源,只是改用「${lang}」表达。`;
}
