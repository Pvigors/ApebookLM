const INTERNAL_PROTOCOL_RE = /<\/?\s*(?:source_excerpts?|web_search_results?)\b[^>]*>|&lt;\/?\s*(?:source_excerpts?|web_search_results?)\b.*?&gt;|\[(?:source_excerpts?|web_search_results?)\]/gi;

/** 模型偶发复述内部上下文边界；落库/展示前转成用户可读文本。 */
export function sanitizeInternalProtocolTokens(answer: string): { content: string; leaked: boolean } {
  const leaked = INTERNAL_PROTOCOL_RE.test(answer) || /\bsource[_ ]excerpts?\b/i.test(answer);
  INTERNAL_PROTOCOL_RE.lastIndex = 0;
  const content = answer
    .replace(/<\s*source_excerpts?\b[^>]*>|&lt;\s*source_excerpts?\b.*?&gt;/gi, "来源资料")
    .replace(/<\s*\/\s*source_excerpts?\b[^>]*>|&lt;\s*\/\s*source_excerpts?\b.*?&gt;/gi, "")
    .replace(/<\s*web_search_results?\b[^>]*>|&lt;\s*web_search_results?\b.*?&gt;/gi, "联网搜索结果")
    .replace(/<\s*\/\s*web_search_results?\b[^>]*>|&lt;\s*\/\s*web_search_results?\b.*?&gt;/gi, "")
    .replace(/\[web_search_results?\]/gi, "（联网搜索结果）")
    .replace(/\[source_excerpts?\]/gi, "（来源资料）")
    .replace(/\bsource[_ ]excerpts?\b/gi, "来源资料");
  return { content, leaked };
}

const PROTOCOL_PREFIXES = [
  "<source_excerpts>", "</source_excerpts>", "<source_excerpt>", "</source_excerpt>",
  "<web_search_results>", "</web_search_results>", "<web_search_result>", "</web_search_result>",
  "&lt;source_excerpts&gt;", "&lt;/source_excerpts&gt;",
  "&lt;web_search_results&gt;", "&lt;/web_search_results&gt;",
  "[source_excerpts]", "[web_search_results]",
];

/** 流式 delta 可能把标签拆开；尾部未闭合片段先隐藏，等完整后再净化显示。 */
export function sanitizeStreamingProtocolText(raw: string): string {
  const lower = raw.toLowerCase();
  const starts = [lower.lastIndexOf("<"), lower.lastIndexOf("&lt;"), lower.lastIndexOf("[")]
    .filter((index) => index >= 0);
  let cut = raw.length;
  for (const start of starts) {
    const suffix = lower.slice(start);
    const isKnownPrefix = PROTOCOL_PREFIXES.some((token) => token.startsWith(suffix));
    const isOpenRawTag = /^<\/?\s*(?:source_excerpts?|web_search_results?)\b[^>]*$/.test(suffix);
    const isOpenEscapedTag = /^&lt;\/?\s*(?:source_excerpts?|web_search_results?)\b(?:(?!&gt;).)*$/.test(suffix);
    if (isKnownPrefix || isOpenRawTag || isOpenEscapedTag) cut = Math.min(cut, start);
  }
  return sanitizeInternalProtocolTokens(raw.slice(0, cut)).content;
}
