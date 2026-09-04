/* Pure, dependency-free converters that flatten studio-output / note content
 * into Markdown or plain text. Content reaches us in three shapes, and several
 * call sites (download, 转入来源, 笔记转来源, 批量转来源) all need to flatten it —
 * keeping every conversion here stops those call sites from drifting apart.
 *
 *   1. plain Markdown      — reports, mind maps, tables, audio transcript, video script
 *   2. Lexical state JSON  — a report / note after it was edited in the rich editor
 *   3. structured JSON     — slides, infographic, flashcards, quiz
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type LxNode = {
  type?: string;
  text?: string;
  format?: number;
  tag?: string;
  url?: string;
  src?: string;
  listType?: string;
  children?: LxNode[];
};

/** Parse `s` as a Lexical editor-state object, or null if it isn't one. */
function parseLexical(s: string): { root: LxNode } | null {
  const t = (s || "").trim();
  if (!t.startsWith("{")) return null;
  try {
    const o = JSON.parse(t);
    return o && o.root ? (o as { root: LxNode }) : null;
  } catch {
    return null;
  }
}

/** Lexical editor-state JSON → Markdown (headings, lists, quotes, code, tables,
 *  images, links, inline bold/italic/strike/code). Non-Lexical input is
 *  returned unchanged, so plain Markdown passes straight through. */
export function lexicalJsonToMarkdown(content: string): string {
  const data = parseLexical(content);
  if (!data?.root?.children) return content;

  const inline = (n: LxNode): string => {
    if (typeof n.text === "string") {
      let s = n.text;
      const f = n.format || 0;
      if (f & 16) s = "`" + s + "`";
      if (f & 1) s = "**" + s + "**";
      if (f & 2) s = "*" + s + "*";
      if (f & 4) s = "~~" + s + "~~";
      return s;
    }
    if (n.type === "link" && Array.isArray(n.children))
      return `[${n.children.map(inline).join("")}](${n.url || ""})`;
    if (Array.isArray(n.children)) return n.children.map(inline).join("");
    return "";
  };

  const list = (n: LxNode, depth = 0): string =>
    (n.children || [])
      .map((li: LxNode, i: number) => {
        const pad = "  ".repeat(depth);
        const subs = (li.children || []).filter((c) => c.type === "list");
        const txt = (li.children || [])
          .filter((c) => c.type !== "list")
          .map(inline)
          .join("");
        const marker = n.listType === "number" ? `${i + 1}. ` : "- ";
        const nested = subs.map((s) => "\n" + list(s, depth + 1)).join("");
        return pad + marker + txt + nested;
      })
      .join("\n");

  const block = (n: LxNode): string => {
    switch (n.type) {
      case "heading":
        return "#".repeat(Number(String(n.tag || "h1").slice(1)) || 1) + " " + inline(n);
      case "quote":
        return "> " + inline(n).replace(/\n/g, "\n> ");
      case "code":
        return "```\n" + inline(n) + "\n```";
      case "list":
        return list(n);
      case "horizontalrule":
        return "---";
      case "image":
        return `![](${n.src || ""})`;
      case "table": {
        const rows = (n.children || []).map(
          (row: LxNode) =>
            "| " +
            (row.children || [])
              .map((c) => inline(c).replace(/\n+/g, " ").trim() || " ")
              .join(" | ") +
            " |"
        );
        if (rows.length > 1) {
          const cols = n.children?.[0]?.children?.length || 1;
          rows.splice(1, 0, "| " + Array(cols).fill("---").join(" | ") + " |");
        }
        return rows.join("\n");
      }
      default:
        return inline(n);
    }
  };

  return data.root.children.map(block).filter(Boolean).join("\n\n").trim() || content;
}

/** Lexical editor-state JSON → plain text (block-separated). Non-Lexical input
 *  (plain Markdown / text) passes through unchanged. Used when a note becomes a
 *  source — embeddings want readable text, not editor scaffolding. */
export function lexicalJsonToText(content: string): string {
  const data = parseLexical(content);
  if (!data?.root) return content;
  const parts: string[] = [];
  const walk = (node: LxNode) => {
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
      if (["paragraph", "heading", "quote", "listitem", "list", "code"].includes(node.type ?? "")) {
        parts.push("\n");
      }
    }
  };
  (data.root.children ?? []).forEach(walk);
  // Valid editor-state → return the extracted text (may be empty); never fall
  // back to the raw JSON, which would pollute the embedding.
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/** Structured artifact JSON (slides / infographic / flashcards / quiz) → Markdown.
 *  Returns null when `content` isn't the JSON shape this kind uses. */
function quizTypeLabel(type: unknown): string {
  return ({ recall: "记忆", application: "应用", comparison: "对比", rationale: "原理" } as Record<string, string>)[String(type || "")] || "";
}

function structuredToMarkdown(kind: string, content: string): string | null {
  const t = (content || "").trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  let data: any;
  try {
    data = JSON.parse(t);
  } catch {
    return null;
  }

  const lines: string[] = [];
  const title = typeof data?.title === "string" ? data.title : "";

  const str = (v: unknown) => (v == null ? "" : String(v));

  // 幻灯片:内容按 layout 存(cards/compare/rings/steps/timeline/stats/chart/quote),
  // 极少是纯 bullets。此前只导出 bullets → 除 bullets 外所有版式的内容全丢(转笔记/转来源
  // /下载都只剩标题)。逐版式提取真实内容(镜像 aippt.deckToOutlineMarkdown,内联以免把
  // 服务端 aippt 依赖拉进客户端 bundle)。
  if (kind === "slides" && Array.isArray(data?.slides)) {
    if (title) lines.push(`# ${title}`, "");
    for (const s of data.slides as any[]) {
      if (s?.layout === "cover") {
        if (s.title) lines.push(`## ${str(s.title)}`);
        if (s.subtitle) lines.push(str(s.subtitle));
        lines.push("");
        continue;
      }
      if (s?.title) lines.push(`## ${str(s.title)}`);
      if (s?.subtitle) lines.push(`*${str(s.subtitle)}*`);
      const L = s?.layout;
      if (L === "cards" && Array.isArray(s.cards)) {
        for (const c of s.cards) lines.push(`- **${str(c?.label)}** ${[c?.sub, c?.text].map(str).filter(Boolean).join(" · ")}`.trim());
      } else if (L === "compare" && s.left && s.right) {
        if (Array.isArray(s.rows) && s.rows.length) {
          for (const r of s.rows) lines.push(`- ${str(r?.dim)}:${str(s.left.label)} ${str(r?.left)} / ${str(s.right.label)} ${str(r?.right)}`);
        } else {
          lines.push(`- ${str(s.left.label)}: ${(s.left.points || []).map(str).join("; ")}`);
          lines.push(`- ${str(s.right.label)}: ${(s.right.points || []).map(str).join("; ")}`);
        }
      } else if ((L === "rings" || L === "steps" || L === "timeline" || L === "points") && Array.isArray(s.items)) {
        if (L === "rings" && s.center) lines.push(`- 核心:${str(s.center)}`);
        s.items.forEach((it: any, i: number) => lines.push(`- ${L === "steps" ? `第${i + 1}步 ` : ""}${str(it?.label)}${it?.text ? `:${str(it.text)}` : ""}`));
      } else if (L === "stats" && Array.isArray(s.stats)) {
        for (const st of s.stats) lines.push(`- ${str(st?.label)}:${str(st?.value)}${st?.text ? `(${str(st.text)})` : ""}`);
      } else if (L === "chart" && s.chart) {
        for (const p of s.chart.data || []) lines.push(`- ${str(p?.label)}:${str(p?.value)}${str(s.chart.unit)}`);
      } else if (L === "quote" && s.quote) {
        lines.push(`> ${str(s.quote)}${s.attribution ? ` — ${str(s.attribution)}` : ""}`);
      } else if (Array.isArray(s?.bullets)) {
        for (const b of s.bullets) if (b) lines.push(`- ${str(b)}`);
      }
      if (s?.note) lines.push(`- ${str(s.note)}`);
      lines.push("");
    }
    return lines.join("\n").trim();
  }

  // 信息图:内容存在 `blocks`(不是 sections),每块按 type 有不同载荷(items/tiers/
  // left-right.points/stats)。此前查 `data.sections`(恒 undefined)→ 返回 null → 上层把
  // 整段**原始 JSON** 当正文导出/入库,污染 RAG。逐块提取真实文字。
  if (kind === "infographic" && Array.isArray(data?.blocks)) {
    if (title) lines.push(`# ${title}`);
    if (typeof data?.subtitle === "string" && data.subtitle) lines.push(`*${data.subtitle}*`);
    lines.push("");
    for (const b of data.blocks as any[]) {
      if (b?.title) lines.push(`## ${str(b.title)}`);
      const items = Array.isArray(b?.items) ? b.items : Array.isArray(b?.tiers) ? b.tiers : [];
      for (const it of items) {
        // stats 块的 item 是 {value,label};其余是 {label,text}
        if (it?.value != null && it?.text == null) lines.push(`- ${str(it?.label)}:${str(it.value)}`);
        else lines.push(`- ${str(it?.label)}${it?.text ? `:${str(it.text)}` : ""}`);
      }
      if (b?.left && b?.right) {
        lines.push(`- ${str(b.left.label)}: ${(b.left.points || []).map(str).join("; ")}`);
        lines.push(`- ${str(b.right.label)}: ${(b.right.points || []).map(str).join("; ")}`);
      }
      lines.push("");
    }
    if (typeof data?.takeaway === "string" && data.takeaway) lines.push(`**${data.takeaway}**`);
    return lines.join("\n").trim();
  }

  // 小红书卡组:content 是 XhsDeck JSON({title,cover{hook,title,sub},cards[{heading,
  // points[],tip}],outro{summary,cta}})。此前无此分支 → 转笔记/下载把整段原始 JSON
  // 当正文(用户截图实锤),补齐为可读 Markdown。注意要在 flashcards 之前判:
  // 两者都有 cards 数组,xhs 的卡是 {heading,points},闪卡是 {front,back}。
  if (kind === "xhs" && Array.isArray(data?.cards)) {
    if (title) lines.push(`# ${title}`, "");
    const cover = data?.cover;
    if (cover && (cover.hook || cover.sub)) {
      // hook 引用块后必须空一行,否则 sub 会被 Markdown 的 lazy continuation 吸进引用块
      if (cover.hook) lines.push(`> ${str(cover.hook)}`, "");
      if (cover.sub) lines.push(str(cover.sub));
      lines.push("");
    }
    for (const c of data.cards as any[]) {
      if (c?.heading) lines.push(`## ${str(c.heading)}`);
      for (const p of Array.isArray(c?.points) ? c.points : []) if (p) lines.push(`- ${str(p)}`);
      if (c?.tip) lines.push(`> 💡 ${str(c.tip)}`);
      lines.push("");
    }
    const outro = data?.outro;
    if (outro && (outro.summary || outro.cta)) {
      // 分隔线前后都要空行,否则解析器把 "---" 连进相邻段落(实测渲染成 "---2026不止…")
      lines.push("---", "");
      if (outro.summary) lines.push(`**${str(outro.summary)}**`);
      if (outro.cta) lines.push(str(outro.cta));
    }
    return lines.join("\n").trim();
  }

  if (kind === "flashcards" && Array.isArray(data?.cards)) {
    if (title) lines.push(`# ${title}`, "");
    data.cards.forEach((c: any, i: number) => {
      if (c?.front) lines.push(`**${i + 1}. ${c.front}**`);
      if (c?.back) lines.push(String(c.back));
      lines.push("");
    });
    return lines.join("\n").trim();
  }

  if (kind === "quiz" && Array.isArray(data?.questions)) {
    if (title) lines.push(`# ${title}`, "");
    data.questions.forEach((q: any, i: number) => {
      if (q?.q) lines.push(`**${i + 1}. ${q.q}**`);
      if (quizTypeLabel(q?.type)) lines.push(`题型:${quizTypeLabel(q.type)}`);
      if (Array.isArray(q?.options)) {
        q.options.forEach((opt: string, oi: number) => {
          lines.push(`- ${opt}${q.answer === oi ? " ✓" : ""}`);
        });
      }
      // 解析:新格式是 explanations 复数数组(逐选项),兼容旧的 explanation 单数。
      if (Array.isArray(q?.explanations)) {
        q.explanations.forEach((e: string, ei: number) => { if (e) lines.push(`> ${q.options?.[ei] ?? ""}: ${e}`); });
      } else if (q?.explanation) lines.push(`> ${q.explanation}`);
      if (q?.hint) lines.push(`💡 提示:${str(q.hint)}`);
      const quizSources = Array.isArray(q?.sources)
        ? q.sources.map((source: unknown) => str(source)).filter(Boolean)
        : q?.source ? [str(q.source)] : [];
      if (quizSources.length) lines.push(`来源:${quizSources.join("、")}`);
      lines.push("");
    });
    return lines.join("\n").trim();
  }

  return null;
}

/** Any studio output → Markdown-ready, source-ready text, regardless of which
 *  of the three content shapes it stores. Empty in → empty out. */
export function outputToMarkdown(kind: string, content: string): string {
  const raw = (content || "").trim();
  if (!raw) return "";
  // A report/table edited in the rich viewer is stored as Lexical state JSON.
  if (parseLexical(raw)) return lexicalJsonToMarkdown(raw);
  // Slides / infographic / flashcards / quiz are structured JSON.
  const structured = structuredToMarkdown(kind, raw);
  if (structured !== null) return structured;
  // Everything else (reports, mind maps, tables, transcripts) is already text.
  return raw;
}
