"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { HELP_CATEGORIES } from "@/lib/help-content";

// 把全部文章拍平成检索索引(标题 + 正文 + 分类名)。
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

function snippet(body: string, q: string): string {
  const flat = body.replace(/\s+/g, " ");
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return flat.slice(0, 56);
  const start = Math.max(0, i - 18);
  return (start > 0 ? "…" : "") + flat.slice(start, start + 60);
}

const SearchIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export default function HelpSearch({ size = "lg" }: { size?: "lg" | "sm" }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return INDEX.filter((it) => it.hay.includes(s)).slice(0, 8);
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const go = (cat: string, slug: string) => {
    setOpen(false);
    setQ("");
    router.push(`/help/${cat}/${slug}`);
  };

  const big = size === "lg";

  return (
    <div ref={ref} className={`relative ${big ? "mx-auto w-full max-w-xl" : "w-full max-w-lg"}`}>
      <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted">
        <SearchIcon />
      </div>
      <input
        name="search"
        autoComplete="off"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing && q.trim()) {
            setOpen(false);
            router.push(`/help/search?q=${encodeURIComponent(q.trim())}`);
          }
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder="搜索帮助"
        className={`w-full rounded-full border border-edge bg-panel2 pl-11 pr-4 text-ink outline-none transition placeholder:text-muted focus:border-accent focus:bg-panel ${
          big ? "h-12 text-[15px]" : "h-9 text-sm"
        }`}
      />

      {open && q.trim() && (
        <div className="animate-popin absolute left-0 right-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-2xl border border-edge bg-panel shadow-[0_16px_40px_-12px_rgba(20,22,40,0.22)]">
          {results.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-muted">没有找到相关内容</p>
          ) : (
            <>
              <ul className="max-h-[56vh] overflow-y-auto py-1">
                {results.map((it) => (
                  <li key={`${it.cat}/${it.slug}`}>
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault();
                        go(it.cat, it.slug);
                      }}
                      className="block w-full px-4 py-2.5 text-left transition hover:bg-panel2"
                    >
                      <span className="block text-sm font-medium text-ink">{it.title}</span>
                      <span className="mt-0.5 block truncate text-[12px] text-muted">
                        {it.catTitle} · {snippet(it.body, q.trim())}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  router.push(`/help/search?q=${encodeURIComponent(q.trim())}`);
                }}
                className="block w-full border-t border-edge px-4 py-2.5 text-center text-[13px] font-medium text-accent transition hover:bg-panel2"
              >
                查看全部结果
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
