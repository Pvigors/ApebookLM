import Link from "next/link";
import { HELP_CATEGORIES } from "@/lib/help-content";
import HelpSearch from "@/components/HelpSearch";
import BrandLogo from "@/components/BrandLogo";

export const metadata = { title: "帮助中心 · 猿笔记" };

// 分类图标(描边随 currentColor)。
const ICONS: Record<string, string> = {
  rocket:
    "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z",
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  stack: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  note: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  share: "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  help: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
};

function Ico({ name }: { name: string }) {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name] ?? ICONS.help} />
    </svg>
  );
}

export default function HelpHome() {
  return (
    <div className="min-h-screen text-ink">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between bg-canvas/70 px-5 backdrop-blur-xl">
        <Link href="/" aria-label="返回猿笔记">
          <BrandLogo />
        </Link>
        <Link
          href="/"
          className="inline-flex h-9 items-center gap-1.5 rounded-[13px] border border-edge bg-panel pl-3 pr-3.5 text-[13px] font-semibold text-ink2 transition hover:border-accent/50 hover:text-ink"
        >
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          返回笔记本
        </Link>
      </header>

      <main className="mx-auto max-w-4xl px-5 pb-20">
        <div className="py-12 text-center">
          <h1 className="text-3xl font-bold tracking-tight">你好,有什么可以帮你?</h1>
          <p className="mt-3 text-[15px] text-ink2">搜索问题,或选择一个主题,了解如何用猿笔记把资料变成答案与制品。</p>
          <div className="mt-6">
            <HelpSearch size="lg" />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {HELP_CATEGORIES.map((c) => (
            <Link
              key={c.slug}
              href={`/help/${c.slug}`}
              className="group rounded-2xl border border-edge bg-panel p-5 transition hover:border-accent/50 hover:shadow-lg"
            >
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accentSoft text-accent">
                <Ico name={c.icon} />
              </div>
              <p className="text-[15px] font-semibold text-ink group-hover:text-accent">{c.title}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink2">{c.desc}</p>
              <p className="mt-3 text-[12px] text-muted">{c.articles.length} 篇</p>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
