export type TimelineEvidence = {
  date: string;
  sortKey: number;
  excerpt: string;
  event: string;
};

export type SourcedTimelineEvidence = TimelineEvidence & {
  evidenceId: string;
  sourceId: string;
  sourceTitle: string;
};

type DateMatch = {
  date: string;
  start: number;
  end: number;
  sortKey: number;
};

const FILE_TOKEN_RE = /(?:https?:\/\/\S+|\S+\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|md|html?|rtf)(?:\?\S*)?)/gi;
const STANDARD_TOKEN_RE =
  /\b(?:ISO(?:\/IEC)?|IEC|GB(?:\/T)?|GB|Q\/[A-Z0-9-]+|YY\/T|T\/[A-Z0-9-]+|DB\d*\/[A-Z0-9-]+|TC\d*)[\s:：A-Z0-9./_-]{2,48}/gi;
const VERSION_TOKEN_RE = /\b(?:Office|Windows|macOS|iOS|Android|ECMAScript|Java)\s+\d{4}\b/gi;
const META_PREFIX_RE =
  /^\s*(?:copyright|last\s+(?:updated|modified|accessed)|updated|modified|published|publication\s+date|created|accessed|版权所有|版权|上传时间|抓取时间|访问时间|更新时间|修改时间|创建时间|文件日期|发布日期|发布于|页码|isbn|备案号|许可证编号|©)\s*[:：-]?/i;
const META_DATE_CONTEXT_RE =
  /(?:(?:this|the)?\s*(?:page|document|file|source)\s+(?:was\s+)?(?:last\s+)?(?:created|modified|updated|published|accessed)|(?:本文|本页|页面|网页|文档|文件)(?:创建|修改|更新|发布|访问|抓取)(?:于|时间|日期)?|文件名|文件编号|文号|编号|标准号|版本号|文件版本|页面编号|批次号|合同号|订单号|档案号|document\s*(?:id|no\.?|number)|file\s*(?:name|number)|reference|serial|record|version|batch|contract|order|last\s+updated|本页更新|本文更新|网页发布|数据抓取|抓取于|更新于|上传于|访问于|发布日期|发布时间|创建时间|修改时间|文件日期)/i;
const IDENTIFIER_CONTEXT_RE =
  /(?:编号|文号|标准号|版本|批次|合同|订单|档案|(?:^|\s)(?:id|batch|contract|order|version|number)(?:\s|$))/i;
const EVENT_SIGNAL_RE =
  /(?:发布|出台|颁布|施行|实施|修订|通过|批准|宣布|提出|制定|启动|开始|结束|完成|上线|成立|建立|建设|召开|签署|立项|验收|开放|推出|进入|形成|开展|迁移|投产|停止|达到|增长|下降|发生|获批|决定|启用|废止|生效|launch(?:ed)?|publish(?:ed)?|release(?:d)?|announce(?:d)?|begin|began|start(?:ed)?|complete(?:d)?|establish(?:ed)?|adopt(?:ed)?|approve(?:d)?|enact(?:ed)?|implement(?:ed)?|sign(?:ed)?|open(?:ed)?|close(?:d)?|introduce(?:d)?|form(?:ed)?|occur(?:red)?|reach(?:ed)?|increase(?:d)?|decrease(?:d)?)/i;

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1800 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function cleanForDateScan(text: string): string {
  return (text || "")
    .replace(FILE_TOKEN_RE, " ")
    .replace(STANDARD_TOKEN_RE, " ")
    .replace(VERSION_TOKEN_RE, " ");
}

function collectDateMatches(text: string): DateMatch[] {
  const matches: DateMatch[] = [];
  const add = (date: string, start: number, end: number, year: number, month = 1, day = 1) => {
    if (!validCalendarDate(year, month, day)) return;
    matches.push({ date, start, end, sortKey: year * 10000 + month * 100 + day });
  };

  // “年” provides temporal semantics, so a standalone Chinese year is valid;
  // plain four-digit numbers are deliberately not accepted (sample counts,
  // product versions and standard suffixes otherwise look like years).
  const cnRange = /(?<!\d)((?:18|19|20|21)\d{2})\s*年?\s*(?:至|到|[-–—~])\s*((?:18|19|20|21)\d{2})\s*年/g;
  for (const m of text.matchAll(cnRange)) {
    add(m[0], m.index ?? 0, (m.index ?? 0) + m[0].length, Number(m[1]));
  }
  const cn = /(?<!\d)((?:18|19|20|21)\d{2})\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?)?/g;
  for (const m of text.matchAll(cn)) {
    const year = Number(m[1]);
    const month = m[2] ? Number(m[2]) : 1;
    const day = m[3] ? Number(m[3]) : 1;
    add(m[0], m.index ?? 0, (m.index ?? 0) + m[0].length, year, month, day);
  }

  // Numeric dates need hard token boundaries. This rejects dates embedded in
  // “report-2025-04.pdf”, paths, identifiers and version strings.
  const numeric = /(?<![\p{L}\p{N}_./:-])((?:18|19|20|21)\d{2})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?![\p{L}\p{N}_/-])/gu;
  for (const m of text.matchAll(numeric)) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = m[3] ? Number(m[3]) : 1;
    add(m[0], m.index ?? 0, (m.index ?? 0) + m[0].length, year, month, day);
  }

  // English bare years are accepted only with an explicit temporal preposition.
  const contextualYear = /\b(?:in|during|since|from|by|until)\s+((?:18|19|20|21)\d{2})\b/gi;
  for (const m of text.matchAll(contextualYear)) {
    const date = m[1];
    const offset = m[0].toLowerCase().lastIndexOf(date);
    const start = (m.index ?? 0) + offset;
    add(date, start, start + date.length, Number(date));
  }

  // Prefer the longest match at an overlapping location and keep source order.
  matches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  return matches.filter(
    (candidate, index, all) =>
      !all.some((other, otherIndex) => otherIndex < index && candidate.start < other.end && candidate.end > other.start)
  );
}

/** Remove identifiers whose numeric suffix is not an event date. */
export function stripNonEventNumbering(text: string): string {
  return cleanForDateScan(text).replace(/(?:第\s*)?\d+(?:\.\d+){1,5}(?:\s*(?:节|条|款|项))?/g, " ");
}

export function timelineDateTokens(text: string): string[] {
  return [...new Set(collectDateMatches(cleanForDateScan(text)).map((item) => item.date))];
}

/**
 * Extract date-bound event clauses from source BODY only. The extractor is
 * intentionally conservative: false negatives produce an honest “no timeline”
 * error, while a false positive would turn metadata into a fabricated event.
 */
export function extractTimelineEvidence(content: string, maxItems = 200): TimelineEvidence[] {
  const clauses = (content || "")
    .replace(/\r/g, "")
    .split(/\n+|(?<=[。！？!?；;])\s*/)
    // Commas are semantic binding boundaries: a metadata date before a comma
    // must never borrow an event verb from the following clause.
    .flatMap((line) => line.split(/[,，]\s*/))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: TimelineEvidence[] = [];
  const seen = new Set<string>();

  const eventWithoutDate = (segment: string, current: DateMatch, segmentStart = 0) => {
    const localOffset = current.start - segmentStart;
    return `${segment.slice(0, localOffset)} ${segment.slice(localOffset + current.date.length)}`
      .replace(/^[\s,，:：;；|｜()（）—–-]+|[\s,，:：;；|｜—–-]+$/g, "")
      .replace(/\s+/g, " ")
      .replace(/(?:于|在|截至|自|从)\s+(?=[\p{Script=Han}])/gu, "")
      .replace(/(?:并)?(?:于|在|截至|自|从)\s*(?=[。.!?！？]\s*$)/u, "")
      .replace(/(?:并)?(?:于|在|截至|自|从)\s*$/u, "")
      .replace(/^\s*(?:in|during|since|from|by|until)\s+/i, "")
      .replace(/\s+(?:in|during|since|from|by|until)\s*(?=[.!?]\s*$)/i, "")
      .replace(/\s+(?:in|during|since|from|by|until)\s*$/i, "")
      .replace(/\s+([。.!?！？])/g, "$1")
      .trim();
  };
  const addEvidence = (date: DateMatch, excerpt: string, event: string) => {
    if (!event || !EVENT_SIGNAL_RE.test(event)) return;
    const key = `${date.date}\u0000${event}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      date: date.date,
      sortKey: date.sortKey,
      excerpt: excerpt.slice(0, 700),
      event: event.slice(0, 620),
    });
  };
  const hasTemporalContext = (clause: string, date: DateMatch) => {
    const before = clause.slice(0, date.start).trim();
    if (!before) return true;
    if (/(?:于|在|截至|自|从|到|至|on|in|by|during|since|from)\s*[:：-]?$/i.test(before)) return true;
    const after = clause.slice(date.end);
    return (
      !/[:：]\s*$/.test(before) &&
      !IDENTIFIER_CONTEXT_RE.test(before) &&
      !EVENT_SIGNAL_RE.test(before) &&
      EVENT_SIGNAL_RE.test(after)
    );
  };
  const isDocumentLabelDate = (clause: string, date: DateMatch) => {
    const before = clause.slice(0, date.start);
    const after = clause.slice(date.end);
    const bookOpen = before.lastIndexOf("《");
    if (bookOpen > before.lastIndexOf("》") && after.includes("》")) return true;
    const parenOpen = Math.max(before.lastIndexOf("（"), before.lastIndexOf("("));
    const parenClose = Math.max(before.lastIndexOf("）"), before.lastIndexOf(")"));
    if (
      parenOpen > parenClose &&
      /[）)]/.test(after) &&
      /(?:方案|规划|计划|报告|要点|标准|指南|办法|意见|通知|纲要|白皮书)\s*$/.test(
        before.slice(Math.max(0, parenOpen - 32), parenOpen)
      )
    ) return true;
    return /^\s*(?:版|版本|度(?:报告)?|年度(?:报告)?|工作要点|行动计划|行动方案|规划|方案|计划)/.test(after);
  };

  for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex++) {
    if (out.length >= maxItems) break;
    const rawClause = clauses[clauseIndex];
    const clause = cleanForDateScan(rawClause);
    const dates = collectDateMatches(clause).filter(
      (date) => hasTemporalContext(clause, date) && !isDocumentLabelDate(clause, date)
    );
    if (!dates.length) continue;
    if (META_PREFIX_RE.test(clause) || META_DATE_CONTEXT_RE.test(clause)) continue;

    // A pure date prefix may bind only to the immediately following event
    // clause: “2025年4月，项目启动”. Any metadata/identifier text beside the
    // date makes it non-pure and therefore ineligible for cross-comma binding.
    if (dates.length === 1) {
      const residual = eventWithoutDate(clause, dates[0])
        .replace(/^(?:(?:于|在|截至|自|从|到|至|期间|当年|年内|on|in|during|since|from|by|until)\s*)+$/i, "")
        .trim();
      if (!residual) {
        const next = cleanForDateScan(clauses[clauseIndex + 1] ?? "");
        if (
          next &&
          !collectDateMatches(next).length &&
          !META_PREFIX_RE.test(next) &&
          !META_DATE_CONTEXT_RE.test(next) &&
          EVENT_SIGNAL_RE.test(next)
        ) {
          addEvidence(dates[0], `${clause}，${next}`, next);
          clauseIndex += 1;
        }
        continue;
      }
    }

    for (let index = 0; index < dates.length && out.length < maxItems; index++) {
      const current = dates[index];
      // A sentence may contain several independent events (“2024年提出，2025年实施”).
      // Bind each date only to its local span instead of reusing the whole sentence.
      const segmentStart = index === 0 ? 0 : current.start;
      const segmentEnd = dates[index + 1]?.start ?? clause.length;
      const segment = clause.slice(segmentStart, segmentEnd).trim();
      if (!segment || META_PREFIX_RE.test(segment) || META_DATE_CONTEXT_RE.test(segment)) continue;
      addEvidence(current, segment, eventWithoutDate(segment, current, segmentStart));
    }
  }
  return out;
}

/** Corpus headings are attribution only; extraction must inspect bodies. */
export function timelineSourceBody(corpus: string): string {
  return corpus
    .split(/\n\n---\n\n/)
    .map((block) => block.replace(/^# [^\n]*\n?/, ""))
    .join("\n\n");
}

export function timelineEvidenceFromCorpus(corpus: string): SourcedTimelineEvidence[] {
  const gathered: SourcedTimelineEvidence[] = [];
  for (const [sourceIndex, block] of corpus.split(/\n\n---\n\n/).entries()) {
    const lines = block.split(/\r?\n/);
    const sourceTitle = (lines.shift()?.replace(/^#\s*/, "").trim() || `来源${sourceIndex + 1}`).replace(/[\r\n]+/g, " ");
    const evidence = extractTimelineEvidence(lines.join("\n").replace(/^\[证据:[^\]]+\]\s*/gm, ""));
    for (const [index, item] of evidence.entries()) {
      gathered.push({
        ...item,
        evidenceId: `corpus-${sourceIndex + 1}-${index + 1}`,
        sourceId: `corpus-${sourceIndex + 1}`,
        sourceTitle,
      });
    }
  }
  return gathered.sort((a, b) => a.sortKey - b.sortKey || a.evidenceId.localeCompare(b.evidenceId));
}

export function renderTimelineEvidence(
  items: SourcedTimelineEvidence[],
  options?: { includeCitationMarkers?: boolean }
): { title: string; content: string } {
  const sorted = [...items].sort((a, b) => a.sortKey - b.sortKey || a.evidenceId.localeCompare(b.evidenceId));
  if (!sorted.length) {
    return {
      title: "时间线（来源无明确日期）",
      content:
        "## 未发现可核对的时间节点\n\n所选来源正文没有明确给出可排序的事件日期、时间区间或年份，因此无法据此生成可靠时间线。为避免把文件名、上传时间、版本号、数量或外部常识误当成来源事实，本次不补写任何事件。",
    };
  }
  const lines = sorted.map((item, index) => {
    const title = item.sourceTitle.replace(/[《》\r\n]/g, " ").trim() || "未命名来源";
    const marker = options?.includeCitationMarkers ? `[${index + 1}]` : "";
    // 对话中的角标紧跟事实陈述，来源名只是展示性归属，不能被 claim parser
    // 误当成原文也必须包含的证据内容。Studio 制品默认不加角标。
    return `- **${item.date}**｜${item.event}${marker}（来源：《${title}》）`;
  });
  return {
    title: "来源事件时间线",
    content: `## 可核对时间节点\n\n${lines.join("\n")}`,
  };
}
