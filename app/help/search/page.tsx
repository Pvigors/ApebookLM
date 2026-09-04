"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { HELP_CATEGORIES } from "@/lib/help-content";
import BrandLogo from "@/components/BrandLogo";

const INDEX = HELP_CATEGORIES.flatMap((c) =>
  c.articles.map((a) => ({
    cat: c.slug,
    catTitle: c.title,
    slug: a.slug,
    title: a.title,
    body: a.body,
    hay: (a.title + "\n" + a.body + "\n" + c.title).toLowerCase(),
  }))
);

function snippet(body: string, q: string, len = 140): string {
  const flat = body.replace(/\s+/g, " ");
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return flat.slice(0, len);
  const start = Math.max(0, i - 30);
  return (start > 0 ? "…" : "") + flat.slice(start, start + len) + (start + len < flat.length ? "…" : "");
}

// 把命中的关键词高亮(大小写不敏感)。
function Highlighted({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const out: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let from = 0;
  let idx = lower.indexOf(ql, from);
  let k = 0;
  while (idx >= 0) {
    if (idx > from) out.push(text.slice(from, idx));
    out.push(
      <mark key={k++} className="rounded bg-accentSoft px-0.5 font-medium text-accent">
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    from = idx + q.length;
    idx = lower.indexOf(ql, from);
  }
  out.push(text.slice(from));
  return <>{out}</>;
}

const SearchIcon = () => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

function SearchInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState("");

  useEffect(() => {
    setQ(params.get("q") ?? "");
  }, [params]);

  const update = (v: string) => {
    setQ(v);
    const qs = v.trim() ? `?q=${encodeURIComponent(v.trim())}` : "";
    router.replace(`/help/search${qs}`);
  };

  const term = q.trim();
  const results = term ? INDEX.filter((it) => it.hay.includes(term.toLowerCase())) : [];

  return (
    <div className="min-h-screen text-ink">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between bg-canvas/70 px-5 backdrop-blur-xl">
        <Link href="/" aria-label="返回猿笔记">
          <BrandLogo />
        </Link>
        <Link
          href="/help"
          className="inline-flex h-9 items-center rounded-[13px] border border-edge bg-panel px-3.5 text-[13px] font-semibold text-ink2 transition hover:border-accent/50 hover:text-ink"
        >
          帮助中心
        </Link>
      </header>

      <main className="mx-auto w-full max-w-3xl px-5 pb-24 pt-6">
        <div className="flex items-center gap-3 rounded-full border border-edge bg-panel2 px-5 py-3.5 transition focus-within:border-accent focus-within:bg-panel">
          <span className="text-muted">
            <SearchIcon />
          </span>
          <input
            autoFocus
            name="search"
            autoComplete="off"
            value={q}
            onChange={(e) => update(e.target.value)}
            placeholder="请输入你想搜索的问题"
            className="flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
          {q && (
            <button onClick={() => update("")} className="text-muted transition hover:text-ink" aria-label="清空">
              <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="m15 9-6 6M9 9l6 6" />
              </svg>
            </button>
          )}
        </div>

        {term && (
          <p className="mt-6 text-sm text-ink2">
            找到 {results.length} 条相关结果
          </p>
        )}

        {term && results.length === 0 && (
          <p className="mt-10 text-center text-sm text-muted">没有找到与「{term}」相关的内容,换个关键词试试。</p>
        )}

        <ul className="mt-4 space-y-4">
          {results.map((it) => (
            <li key={`${it.cat}/${it.slug}`} className="rounded-2xl bg-panel2/60 p-4">
              <Link
                href={`/help/${it.cat}/${it.slug}`}
                className="text-[15px] font-medium text-ink transition hover:text-accent"
              >
                <Highlighted text={it.title} q={term} />
              </Link>
              <p className="mt-1 text-[12px] text-muted">{it.catTitle}</p>
              <Link
                href={`/help/${it.cat}/${it.slug}`}
                className="mt-3 block rounded-xl border border-edge bg-panel p-4 text-[13px] leading-6 text-ink2 transition hover:border-accent/50"
              >
                <Highlighted text={snippet(it.body, term)} q={term} />
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}

export default function HelpSearchPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-canvas" />}>
      <SearchInner />
    </Suspense>
  );
}
