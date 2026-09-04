import type { ReactNode } from "react";

// 引用角标共享工具:登录态对话与公开分享页都要把回答里的 [n] 标记渲染成可点角标。
// 本文件从 HomeClient 的实现提取而来(HomeClient 原实现按纪律原样保留不动),
// 新页面(如 PublicNotebook)一律引用这里的共享版,别再各自复制一份。

/** 拍平 ReactMarkdown children 里的纯文本(取引用编号用)。 */
export function childText(children: ReactNode): string {
  if (children == null || children === false) return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childText).join("");
  return "";
}

// Turn inline [n] citation markers into <cite> elements we can render as chips.
export function rehypeCitations() {
  const walk = (node: { tagName?: string; children?: unknown[] }) => {
    if (!node || !Array.isArray(node.children)) return;
    // Existing Markdown links may legitimately contain text like "[1]". Turning
    // that text into another anchor would create invalid nested interactive UI.
    if (node.tagName === "code" || node.tagName === "pre" || node.tagName === "a") return;
    const out: unknown[] = [];
    for (const raw of node.children) {
      const child = raw as { type?: string; value?: string; tagName?: string; children?: unknown[] };
      if (child.type === "text" && typeof child.value === "string" && /\[\d+\]/.test(child.value)) {
        const text = child.value;
        const re = /\[(\d+)\]/g;
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
          out.push({
            type: "element",
            tagName: "cite",
            properties: { className: ["cite"] },
            children: [{ type: "text", value: m[1] }],
          });
          last = re.lastIndex;
        }
        if (last < text.length) out.push({ type: "text", value: text.slice(last) });
      } else {
        walk(child);
        out.push(child);
      }
    }
    node.children = out;
  };
  return (tree: unknown) => walk(tree as { children?: unknown[] });
}

/**
 * 精确引用定位：新引用优先验证原文偏移；历史引用只在摘录唯一出现时定位。
 * 重复文本不再静默选择第一处，避免不同角标看起来都指向同一段。
 */
export function locateCitationPassage(
  content: string,
  snippet: string,
  sourceStart?: number,
  sourceEnd?: number
): { before: string; match: string; after: string } | null {
  const needle = snippet.trim();
  if (!needle) return null;
  const compact = (text: string) => text.replace(/\s+/g, "");
  if (
    Number.isInteger(sourceStart) &&
    Number.isInteger(sourceEnd) &&
    sourceStart! >= 0 &&
    sourceEnd! > sourceStart! &&
    sourceEnd! <= content.length
  ) {
    const exact = content.slice(sourceStart, sourceEnd);
    if (compact(exact) === compact(needle)) {
      return {
        before: content.slice(0, sourceStart),
        match: exact,
        after: content.slice(sourceEnd),
      };
    }
  }
  const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = needle
    .split(/\s+/)
    .map(esc)
    .join("\\s+");
  try {
    const re = new RegExp(pattern, "g");
    const first = re.exec(content);
    if (!first) return null;
    // 历史 citation 没有偏移；重复摘录无法证明应选哪一处，诚实降级。
    if (re.exec(content)) return null;
    return {
      before: content.slice(0, first.index),
      match: first[0],
      after: content.slice(first.index + first[0].length),
    };
  } catch {
    return null;
  }
}

/** 与服务端 Citation 使用同一 SHA-256 前 24 位，用于识别历史引用对应的来源是否已更新。 */
export async function citationContentHash(content: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(content));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 24);
  } catch {
    return null;
  }
}
