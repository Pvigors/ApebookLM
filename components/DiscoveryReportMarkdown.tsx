import React from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ResponsiveMarkdownTable from "@/components/ResponsiveMarkdownTable";
import { childText, rehypeCitations } from "@/components/citations";
import {
  safeDiscoveryReferenceUrl,
  type DiscoveryReference,
} from "@/lib/discovery-report";

export default function DiscoveryReportMarkdown({
  content,
  references,
  className = "",
}: {
  content: string;
  references: DiscoveryReference[];
  className?: string;
}) {
  // First valid mapping wins. Duplicate/malformed entries must never redirect a
  // citation away from the source that originally received that number.
  const byNumber = new Map<number, DiscoveryReference & { href: string }>();
  for (const reference of references) {
    const href = safeDiscoveryReferenceUrl(reference.url);
    if (
      !href ||
      !Number.isInteger(reference.number) ||
      reference.number < 1 ||
      byNumber.has(reference.number)
    ) {
      continue;
    }
    byNumber.set(reference.number, { ...reference, href });
  }

  const components: Components = {
    cite({ children }) {
      const number = Number(childText(children));
      const reference = byNumber.get(number);
      // Never present an invented/out-of-range citation as an interactive link.
      if (!reference) return <>[{number}]</>;
      const label = `打开来源 ${number}：${reference.title}（新标签页）`;
      return (
        <a
          href={reference.href}
          target="_blank"
          rel="noopener noreferrer"
          className="cite"
          title={label}
          aria-label={label}
        >
          {number}
        </a>
      );
    },
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    table({ children }) {
      return <ResponsiveMarkdownTable>{children}</ResponsiveMarkdownTable>;
    },
  };

  return (
    <div className={`prose-chat discovery-report ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeCitations] as never}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
