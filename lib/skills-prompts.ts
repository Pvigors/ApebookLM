import "server-only";
import { checkOutputLanguage } from "./generation-contract";
// ---------------------------------------------------------------------------
// 技能提示词 / persona 指令 —— 服务端专用。
// 提示词只在服务端执行，避免把内部指令和运行上下文送入客户端 bundle。客户端只发
// skillId,由 chat 路由查此表在服务端注入(一键/工作流→作为检索+回答的实际 query;
// 对话→追加到 system directive 的 persona)。id 必须与 lib/skills.ts 的 SKILLS 一一对应。
// ---------------------------------------------------------------------------

export type SkillCitationPolicy = "required" | "forbidden";
export type SkillPromptConfig = {
  prompt?: string;
  system?: string;
  /** 成品文档不带角标;研究/对话类保留逐句引用。 */
  citationPolicy: SkillCitationPolicy;
  /** 技能本身指定的输出语言,优先于笔记本默认(如“整篇翻译→简中”)。 */
  outputLanguage?: string;
};

export const SKILL_PROMPTS: Record<string, SkillPromptConfig> = {
  // —— 内容加工(一键)——
  translate: {
    prompt:
      "请把所选来源的主要内容翻译成简体中文。保留原文的结构与分段、要点不遗漏;遇到专有名词保留英文原文并在括号内给出中文。译文是成品文本,不要添加任何形如 [1] 的引用角标或来源编号。",
    citationPolicy: "forbidden",
    outputLanguage: "简体中文",
  },
  factcheck: {
    prompt:
      "请从所选来源中提取关键的事实性陈述,逐条核查其在来源中的依据。用 Markdown 表格输出三列:陈述 | 结论(支持 / 存疑 / 来源未提及) | 引用编号。",
    citationPolicy: "required",
  },
  compare: {
    prompt:
      "请横向对比所选各来源在关键维度上的观点与数据,用 Markdown 表格输出。每张表首列为对比维度,其余列为来源。来源表头必须写成「可区分的短标题 [引用编号]」:短标题不超过 12 个汉字(英文不超过 24 个字符),禁止照抄冗长文件名。【渲染硬约束】每张表总列数不得超过 7 列(1 个对比维度列 + 最多 6 个来源列),也不得额外增加结论/备注列;超过即为格式错误。若来源超过 6 个,必须沿“来源列”拆成多张表,各表的来源列互不重复并尽量均分(7 个来源应分成 4+3,10 个来源应分成 5+5),让每个来源恰好出现于一张表;禁止仅按对比维度拆表后在多张表里重复同一批来源。每张表重复相同的核心对比维度。最后在表格外给出 3-5 条差异小结。",
    citationPolicy: "required",
  },
  timeline: {
    prompt:
      "请只从所选来源正文中抽取“明确日期/时间区间 + 与之直接对应的事件”,按正文给出的时间先后整理。日期措辞必须沿用正文,不得从文件名、来源标题、上传时间、当前时间或外部常识推断;4.2.3、GB/T 35295-2017、TC609-5-2025-04 等章节号/标准号/版本号不算事件日期。每行格式为「时间 — 事件简述 [引用编号]」。若正文没有可核对的明确日期事件,直接说明“所选来源中未找到明确日期，无法生成可靠时间线”,不要补写事件。",
    citationPolicy: "required",
  },
  // —— 写作产出(一键)——
  xhs: {
    prompt:
      "请基于所选来源,写一篇小红书风格的种草文案:一个有吸引力的标题、适量 emoji、分点正文、结尾配 5 个相关话题标签。语气轻松口语化。这是可直接发布的成品文案,不要添加任何形如 [1] 的引用角标或来源编号。",
    citationPolicy: "forbidden",
  },
  minutes: {
    prompt:
      "请把所选来源整理成一份结构清晰的纪要,包含:背景 / 关键要点 / 结论 / 待办(如有)。用简洁的分点 Markdown。这是可直接使用的成品文档,不要添加任何形如 [1] 的引用角标或来源编号。",
    citationPolicy: "forbidden",
  },
  slides: {
    prompt:
      "请基于所选来源生成一份演示文稿大纲:封面标题 + 6-10 页,每页给出页标题与 3-5 个要点。这是成品大纲,不要添加任何形如 [1] 的引用角标或来源编号。",
    citationPolicy: "forbidden",
  },
  abstract: {
    prompt:
      "请为所选来源写一段 200-300 字的规范学术摘要,涵盖研究背景、方法、主要结果与结论,客观中立、不加入来源以外的信息。摘要是一段连续的成品文字,不要添加任何形如 [1] 的引用角标或来源编号。",
    citationPolicy: "forbidden",
  },
  // —— 角色对话(persona)——
  socratic: {
    system:
      "\n\n请以苏格拉底式教学法回应:不要直接给出结论,而是通过有针对性的追问,引导用户自己一步步推理。每次只问一两个关键问题。",
    citationPolicy: "required",
  },
  interview: {
    system:
      "\n\n你现在是严谨的面试官,基于所选来源的主题对用户进行模拟面试。一次只问一道题,等用户回答后再点评并追问,逐步加深难度。",
    citationPolicy: "required",
  },
  redteam: {
    system:
      "\n\n你现在是挑剔的红队评审。针对用户提出的观点,主动寻找其逻辑漏洞、反例与风险,用犀利但有据(基于来源)的方式提出质疑,而不是附和。",
    citationPolicy: "required",
  },
  // —— 多步工作流(一键近似)——
  research: {
    prompt:
      "请对所选来源做一次深度研究:先列出研究提纲,再逐节展开论述,每个关键论点都标注来源引用编号,最后给出总体结论。",
    citationPolicy: "required",
  },
  audit: {
    prompt:
      "请对所选来源做一次「体检」:1) 指出来源之间相互矛盾或不一致之处;2) 只根据来源自身声称的范围、目录或相互对照,指出可直接观察到的覆盖缺口,不得用外部常识猜测“应该还有什么”;3) 给出补充来源或追问的建议。关键结论保留引用编号。",
    citationPolicy: "required",
  },
};

/** 一键/工作流技能:取其作为用户消息发送的提示词(检索+回答用)。 */
export function skillPrompt(id: string | undefined | null): string | undefined {
  if (!id) return undefined;
  return SKILL_PROMPTS[id]?.prompt;
}
/** 对话类技能:取其追加到 system directive 的 persona 指令。 */
export function skillSystem(id: string | undefined | null): string | undefined {
  if (!id) return undefined;
  return SKILL_PROMPTS[id]?.system;
}

export function skillConfig(id: string | undefined | null): SkillPromptConfig | undefined {
  if (!id) return undefined;
  return SKILL_PROMPTS[id];
}

export function isKnownSkillId(id: string | undefined | null): boolean {
  return !!id && Object.prototype.hasOwnProperty.call(SKILL_PROMPTS, id);
}

/** 明确的技能执行策略追加到最终 system 尾部,解决技能与笔记本默认冲突。 */
export function skillExecutionSystem(id: string | undefined | null): string {
  const config = skillConfig(id);
  if (!config) return "";
  const parts: string[] = [];
  if (config.outputLanguage) {
    parts.push(`【技能输出语言 · 最高优先级】全部输出必须使用「${config.outputLanguage}」。这条覆盖笔记本的默认输出语言。`);
  }
  parts.push(
    config.citationPolicy === "forbidden"
      ? "【技能引用策略】输出是可直接使用的成品文档,禁止 [1] 式角标、来源编号与引用附录;仍必须严格忠于来源。"
      : "【技能引用策略】所有事实性陈述必须保留逐句 [n] 引用。"
  );
  return `\n\n${parts.join("\n")}`;
}

const REFUSAL_RE = /^(?:抱歉|对不起|无法|不能|很遗憾|sorry|i\s+(?:can'?t|cannot|am unable))/i;
const citationFree = (text: string) => text.replace(/\[(?:\d+(?:[,，、\s]*\d+)*)\]/g, "").trim();
const stableTerms = (sourceText: string) => [
  ...new Set([
    ...(sourceText.match(/[\p{L}]{1,20}[-_]‑?\d[\dA-Za-z._-]*/gu) || []),
    ...(sourceText.match(/\b[A-Z][A-Z0-9._-]{2,}\b/g) || []),
  ]),
].slice(0, 6);

const meaningfulAbstractChars = (text: string) =>
  (text.match(/[\p{Script=Han}\p{N}，。；：！？、（）《》“”]/gu) || []).length;

/** 仅做不新增事实的确定性规范化；目前用于把轻微超长摘要收敛到300字内。 */
export function normalizeSkillOutput(id: string | undefined | null, output: string): string {
  let text = String(output || "").trim();
  if (id !== "abstract") return text;
  text = text.replace(/\s+/g, " ").trim();
  if (meaningfulAbstractChars(text) <= 300) return text;
  let count = 0;
  let end = 0;
  for (const [index, char] of Array.from(text).entries()) {
    if (/[\p{Script=Han}\p{N}，。；：！？、（）《》“”]/u.test(char)) count++;
    end = index + 1;
    if (count >= 298) break;
  }
  const chars = Array.from(text).slice(0, end).join("").replace(/[，；：、\s]+$/g, "").trim();
  return /[。！？]$/.test(chars) ? chars : `${chars}。`;
}

/** 可确定性验收的技能行为合同。返回空数组才允许落库。 */
export function validateSkillOutput(
  id: string | undefined | null,
  output: string,
  sourceText = ""
): string[] {
  const config = skillConfig(id);
  if (!config) return id ? ["未知技能"] : [];
  const text = citationFree(output);
  const issues: string[] = [];
  if (!text || REFUSAL_RE.test(text)) issues.push("输出为空或拒答");
  const anchors = stableTerms(sourceText);
  const requireAnchors = ["translate", "xhs", "minutes", "slides", "abstract"].includes(String(id));
  if (requireAnchors) {
    const missing = anchors.filter((term) => !text.includes(term));
    if (id !== "translate") {
      if (anchors.length && missing.length === anchors.length) issues.push(`未原样保留任一来源稳定标识:${anchors.join("、")}`);
    } else if (missing.length) {
      issues.push(`未原样保留来源稳定标识:${missing.join("、")}`);
    }
  }

  if (id === "translate") {
    const language = checkOutputLanguage(text, config.outputLanguage);
    if (!language.ok) issues.push(language.reason || "译文主体不是简体中文");
  } else if (id === "factcheck") {
    if (!/\|[^\n]+\|[^\n]+\|[^\n]+\|/.test(text) || !/\|\s*:?-{2,}/.test(text)) issues.push("未输出三列 Markdown 核查表");
  } else if (id === "compare") {
    const tables = text.split(/\n\s*\n/).filter((block) => /\|\s*:?-{2,}/.test(block));
    if (!tables.length) issues.push("未输出 Markdown 对比表");
    if (tables.some((table) => {
      const row = table.split(/\r?\n/).find((line) => line.includes("|")) || "";
      return row.split("|").slice(1, -1).length > 7;
    })) issues.push("对比表超过 7 列");
  } else if (id === "xhs") {
    const tags = text.match(/#[\p{L}\p{N}_-]+/gu) || [];
    if (tags.length !== 5) issues.push("小红书文案必须恰好包含 5 个话题标签");
    if (!/\p{Extended_Pictographic}/u.test(text)) issues.push("小红书文案缺少 emoji");
    const markdownPoints = (text.match(/(?:^|\n)\s*(?:[-*+]\s+|\d+[.)、]\s*)/g) || []).length;
    const emojiPoints = (text.match(/(?:^|\n|\s)[✅☑🔸▪•](?=\s|\*)/gu) || []).length;
    if (markdownPoints + emojiPoints < 2) issues.push("小红书正文缺少分点结构");
  } else if (id === "minutes") {
    for (const heading of ["背景", "关键要点", "结论"]) if (!text.includes(heading)) issues.push(`纪要缺少「${heading}」`);
  } else if (id === "slides") {
    const headingCount = (text.match(/^#{1,6}\s+.+$/gm) || []).length;
    const markdownPageHeadings = (text.match(/^#{1,6}\s+(?:第\s*\d+\s*页|(?:slide|幻灯片)\s*\d+)/gim) || []).length;
    const numberedPages = (text.match(/^(?:第\s*\d+\s*页|(?:slide|幻灯片)\s*\d+|\d+[.)、]\s*[^\n]+)/gim) || []).length;
    const boldPages = (text.match(/\*\*\s*(?:第\s*\d+\s*页|(?:slide|幻灯片)\s*\d+)[^*\n]*\*\*/gim) || []).length;
    const pageCount = Math.max(markdownPageHeadings, headingCount > 1 ? headingCount - 1 : headingCount, numberedPages, boldPages);
    const bulletCount = (text.match(/^\s*[-*+]\s+\S+/gm) || []).length;
    if (pageCount < 6 || pageCount > 10) issues.push("演示大纲页数不是 6-10 页");
    if (bulletCount < pageCount * 3 || bulletCount > pageCount * 5) issues.push("每页未保持 3-5 个要点");
  } else if (id === "abstract") {
    const cjkChars = (text.match(/[\p{Script=Han}]/gu) || []).length;
    const meaningfulChars = meaningfulAbstractChars(text);
    const chars = cjkChars >= 20 ? meaningfulChars : Array.from(text.replace(/\s+/g, "")).length;
    if (chars < 200 || chars > 300) issues.push(`学术摘要长度为 ${chars} 字,必须在 200-300 字`);
    if (/\n\s*\n|^\s*(?:#|[-*+]\s)/m.test(text)) issues.push("学术摘要必须是单段连续文字");
    for (const [label, pattern] of [["背景", /背景|目的/], ["方法", /方法|设计/], ["结果", /结果|发现/], ["结论", /结论|表明/]] as const) {
      if (!pattern.test(text)) issues.push(`学术摘要缺少${label}`);
    }
  } else if (id === "socratic") {
    const questions = (text.match(/[？?]/g) || []).length;
    if (questions < 1 || questions > 2) issues.push("苏格拉底回应必须只有 1-2 个关键问题");
    if (/(?:答案|结论)(?:就是|是|:|：)|直接来说/.test(text)) issues.push("苏格拉底回应直接给出了结论");
  } else if (id === "interview") {
    if ((text.match(/[？?]/g) || []).length !== 1) issues.push("面试官每轮必须恰好只问一题");
  } else if (id === "research") {
    const sections = (text.match(/^#{1,6}\s+/gm) || []).length
      + (text.match(/\*\*[^*\n]{0,16}(?:研究提纲|逐节论述|总体结论|结论|\d+[.、]\s*[^*\n]+)[^*\n]{0,40}\*\*/g) || []).length;
    if (sections < 2) issues.push("深度研究缺少提纲/分节");
    if (!/研究提纲|研究框架|提纲/.test(text)) issues.push("深度研究缺少提纲");
    if (!/总体结论|最终结论|结论/.test(text)) issues.push("深度研究缺少总体结论");
    if (!/\[\d+\]/.test(output)) issues.push("深度研究缺少引用编号");
  } else if (id === "audit") {
    for (const term of ["矛盾", "缺口", "建议"]) if (!text.includes(term)) issues.push(`来源体检缺少「${term}」`);
  }
  return [...new Set(issues)];
}

export function skillRepairInstruction(id: string, issues: string[]): string {
  const config = skillConfig(id);
  if (!config || !issues.length) return "";
  const specific = id === "slides"
    ? "使用严格 Markdown：一个封面标题，随后 ## 第1页 至 ## 第6-10页；每页恰好3-5条以 - 开头的要点。"
    : id === "abstract"
      ? "摘要目标长度220-250个汉字，绝不能超过300字；必须单段，并按顺序原样使用‘研究背景、研究方法、研究结果、研究结论’四个短语。"
      : id === "xhs"
        ? "至少原样保留一个来源稳定名称；正文至少3个以 - 或 ✅ 开头的分点，结尾恰好5个#话题标签，不得补写来源没有的渠道、数字或场景。"
        : id === "interview"
          ? "最终只输出一道基于来源的面试问题，以一个问号结尾；不要先回答、点评或追加第二问。"
          : id === "socratic"
            ? "最终只输出1-2个引导问题，不直接给结论。"
            : "";
  return `上一版未通过技能输出合同:\n- ${issues.join("\n- ")}\n请在不新增来源外事实的前提下,重写整份结果。${specific}\n必须继续遵守原 system、来源范围与本技能的语言/引用策略。只输出重写后的最终成品,不要解释修改过程。`;
}
