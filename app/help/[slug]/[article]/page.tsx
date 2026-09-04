"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import HelpShell from "@/components/HelpShell";
import HelpFigure from "@/components/HelpFigures";
import { getArticleNav } from "@/lib/help-content";

// 从正文里抽出 ## 小节(供右侧目录),id 由顺序得出。
function extractToc(body: string): { id: string; text: string }[] {
  return body
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l, i) => ({ id: `sec-${i}`, text: l.replace(/^##\s+/, "").trim() }));
}

// 把 React 子节点拍平成纯文本(用来从标题文本确定性查 id,避免计数器导致的 hydration 不一致)。
function nodeText(n: React.ReactNode): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join("");
  if (n && typeof n === "object" && "props" in n)
    return nodeText((n as { props?: { children?: React.ReactNode } }).props?.children);
  return "";
}

const ArrowLeft = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 4 5 8l4 4M5 8h7" />
  </svg>
);
const ArrowRight = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 4l4 4-4 4M11 8H4" />
  </svg>
);

export default function HelpArticlePage() {
  const params = useParams();
  const slug = Array.isArray(params.slug) ? params.slug[0] : String(params.slug ?? "");
  const articleSlug = Array.isArray(params.article) ? params.article[0] : String(params.article ?? "");
  const nav = getArticleNav(slug, articleSlug);
  const [activeId, setActiveId] = useState("");

  // 滚动高亮:观察各 H2,把最靠上的可见小节设为当前。
  useEffect(() => {
    const hs = Array.from(document.querySelectorAll<HTMLElement>("main h2[id]"));
    if (!hs.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActiveId(vis[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 }
    );
    hs.forEach((h) => obs.observe(h));
    return () => obs.disconnect();
  }, [articleSlug]);

  if (!nav) {
    return (
      <HelpShell activeCat={slug}>
        <div className="py-24 text-center">
          <p className="text-lg font-semibold">没有找到该帮助文章</p>
          <Link href={`/help/${slug}`} className="mt-3 inline-block text-sm text-accent">
            返回分类
          </Link>
        </div>
      </HelpShell>
    );
  }

  const { category, article, prev, next } = nav;
  const toc = extractToc(article.body);
  const tocMap = new Map(toc.map((t) => [t.text, t.id]));

  const components = {
    h2: ({ children }: { children?: React.ReactNode }) => (
      <h2
        id={tocMap.get(nodeText(children).trim())}
        className="mt-9 scroll-mt-24 text-[20px] font-semibold leading-8 tracking-tight text-ink"
      >
        {children}
      </h2>
    ),
    p: ({ children }: { children?: React.ReactNode }) => (
      <p className="mt-4 text-[16px] leading-[28px] text-ink2">{children}</p>
    ),
    ul: ({ children }: { children?: React.ReactNode }) => (
      <ul className="mt-3 space-y-2 pl-5 [&>li]:list-disc text-ink2 marker:text-muted">{children}</ul>
    ),
    ol: ({ children }: { children?: React.ReactNode }) => (
      <ol className="mt-3 list-decimal space-y-2 pl-6 text-ink2 marker:font-medium marker:text-ink2">{children}</ol>
    ),
    li: ({ children }: { children?: React.ReactNode }) => (
      <li className="text-[16px] leading-[27px] text-ink2">{children}</li>
    ),
    strong: ({ children }: { children?: React.ReactNode }) => (
      <strong className="font-semibold text-ink">{children}</strong>
    ),
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <a href={href} className="text-accent underline-offset-2 transition hover:underline">
        {children}
      </a>
    ),
  };

  const rightRail =
    toc.length > 0 ? (
      <nav className="sticky top-[80px] py-8" aria-label="本页目录">
        <p className="mb-3 px-3 text-[12px] font-medium uppercase tracking-wide text-muted">目录</p>
        <ul>
          {toc.map((t) => {
            const on = activeId === t.id;
            return (
              <li key={t.id}>
                <a
                  href={`#${t.id}`}
                  className={`relative block py-1.5 pl-3 pr-2 text-[13px] leading-snug transition ${
                    on ? "font-medium text-ink" : "text-ink2 hover:text-ink"
                  }`}
                >
                  <span
                    className={`absolute left-0 top-0 h-full w-[2px] rounded ${on ? "bg-accent" : "bg-edge"}`}
                  />
                  {t.text}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    ) : undefined;

  return (
    <HelpShell activeCat={slug} activeArticle={articleSlug} rightRail={rightRail}>
      <nav className="mb-5 flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
        <Link href="/help" className="transition hover:text-accent">
          帮助中心
        </Link>
        <span>›</span>
        <Link href={`/help/${category.slug}`} className="transition hover:text-accent">
          {category.title}
        </Link>
        <span>›</span>
        <span className="text-ink2">{article.title}</span>
      </nav>

      <article className="max-w-2xl">
        <h1 className="text-[30px] font-semibold leading-[42px] tracking-tight text-ink">{article.title}</h1>
        <HelpFigure name={article.figure} />
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {article.body}
        </ReactMarkdown>

        <nav className="mt-12 flex justify-between gap-4 border-t border-edge pt-6" aria-label="文档导航">
          {prev ? (
            <Link href={`/help/${category.slug}/${prev.slug}`} className="group flex flex-col items-start text-left">
              <span className="mb-1.5 flex items-center gap-1.5 text-[13px] text-muted group-hover:text-ink2">
                <ArrowLeft /> 上一篇
              </span>
              <span className="text-[15px] font-medium text-ink2 group-hover:text-accent">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={`/help/${category.slug}/${next.slug}`} className="group flex flex-col items-end text-right">
              <span className="mb-1.5 flex items-center gap-1.5 text-[13px] text-muted group-hover:text-ink2">
                下一篇 <ArrowRight />
              </span>
              <span className="text-[15px] font-medium text-ink2 group-hover:text-accent">{next.title}</span>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>
    </HelpShell>
  );
}
