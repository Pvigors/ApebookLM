import React, { type ReactNode } from "react";

/**
 * Markdown 表格的统一自适应外壳。
 *
 * 多来源对比天然可能有 6–10 列；强行把所有列压进消息宽度只会让中文逐字换行。
 * 这里让表格按内容获得可读列宽，仅在自己的区域横向滚动，并固定首列方便对照。
 */
export default function ResponsiveMarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div
      className="markdown-table-scroll"
      role="region"
      aria-label="表格，可横向滚动查看全部列"
      tabIndex={0}
    >
      <table className="markdown-table">{children}</table>
    </div>
  );
}
