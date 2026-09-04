"use client";

import Link from "next/link";
import { HELP_CATEGORIES } from "@/lib/help-content";
import HelpSearch from "@/components/HelpSearch";
import BrandLogo from "@/components/BrandLogo";

const Chevron = ({ open }: { open: boolean }) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
    aria-hidden
  >
    <path d="M6 4l4 4-4 4" />
  </svg>
);

// 帮助中心文档外壳(对齐 Kimi):顶栏(品牌 + 返回)+ 左侧搜索/分类树 + 内容区 + 可选右侧 TOC。
export default function HelpShell({
  activeCat,
  activeArticle,
  rightRail,
  children,
}: {
  activeCat: string;
  activeArticle?: string;
  rightRail?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen text-ink">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-4 bg-canvas/70 px-5 backdrop-blur-xl">
        <Link href="/" aria-label="返回猿笔记" className="shrink-0">
          <BrandLogo />
        </Link>
        <div className="flex min-w-0 flex-1 justify-center">
          <HelpSearch size="sm" />
        </div>
        <Link
          href="/"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[13px] border border-edge bg-panel pl-3 pr-3.5 text-[13px] font-semibold text-ink2 transition hover:border-accent/50 hover:text-ink"
        >
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          返回笔记本
        </Link>
      </header>

      <div className="mx-auto flex w-full max-w-[1240px] gap-8 px-5 pb-16">
        {/* 左侧:分类树(搜索在顶栏) */}
        <aside className="hidden w-[240px] shrink-0 min-[960px]:block">
          <div className="sticky top-[72px] max-h-[calc(100vh-5rem)] overflow-y-auto py-6">
            <nav>
              <ul className="space-y-0.5 text-sm">
                {HELP_CATEGORIES.map((cat) => {
                  const on = cat.slug === activeCat;
                  return (
                    <li key={cat.slug}>
                      <Link
                        href={`/help/${cat.slug}`}
                        className={`flex items-center justify-between rounded-[12px] px-2.5 py-2 transition ${
                          on ? "font-medium text-ink" : "text-ink2 hover:bg-panel2 hover:text-ink"
                        }`}
                      >
                        <span>{cat.title}</span>
                        <Chevron open={on} />
                      </Link>
                      {on && (
                        <ul className="mb-1 mt-0.5 space-y-0.5">
                          {cat.articles.map((a) => {
                            const cur = a.slug === activeArticle;
                            return (
                              <li key={a.slug}>
                                <Link
                                  href={`/help/${cat.slug}/${a.slug}`}
                                  className={`block rounded-[12px] px-6 py-2 text-[13px] leading-snug transition ${
                                    cur
                                      ? "bg-accentSoft font-medium text-accent"
                                      : "text-ink2 hover:bg-panel2 hover:text-ink"
                                  }`}
                                >
                                  {a.title}
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>
        </aside>

        {/* 中间:内容 */}
        <main className="min-w-0 flex-1 py-8">{children}</main>

        {/* 右侧:目录(仅文章页 + 宽屏) */}
        {rightRail && <aside className="hidden w-[200px] shrink-0 xl:block">{rightRail}</aside>}
      </div>
    </div>
  );
}
