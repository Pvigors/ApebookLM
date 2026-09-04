"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import HelpShell from "@/components/HelpShell";
import { getHelpCategory } from "@/lib/help-content";

export default function HelpCategoryPage() {
  const params = useParams();
  const slug = Array.isArray(params.slug) ? params.slug[0] : String(params.slug ?? "");
  const cat = getHelpCategory(slug);

  if (!cat) {
    return (
      <HelpShell activeCat={slug}>
        <div className="py-24 text-center">
          <p className="text-lg font-semibold">没有找到该帮助分类</p>
          <Link href="/help" className="mt-3 inline-block text-sm text-accent">
            返回帮助中心
          </Link>
        </div>
      </HelpShell>
    );
  }

  return (
    <HelpShell activeCat={slug}>
      <nav className="mb-4 flex items-center gap-1.5 text-[13px] text-muted">
        <Link href="/help" className="transition hover:text-accent">
          帮助中心
        </Link>
        <span>›</span>
        <span className="text-ink2">{cat.title}</span>
      </nav>

      <h1 className="text-2xl font-bold tracking-tight">{cat.title}</h1>
      <p className="mt-2 text-[15px] text-ink2">{cat.desc}</p>

      <ul className="mt-6 divide-y divide-edge overflow-hidden rounded-2xl border border-edge bg-panel">
        {cat.articles.map((a) => {
          const firstLine = a.body.split("\n").find((l) => l.trim() && !l.startsWith("-")) ?? "";
          return (
            <li key={a.slug}>
              <Link
                href={`/help/${cat.slug}/${a.slug}`}
                className="group flex items-center gap-3 px-5 py-4 transition hover:bg-panel2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium text-ink group-hover:text-accent">{a.title}</span>
                  <span className="mt-0.5 block truncate text-[13px] text-ink2">{firstLine}</span>
                </span>
                <span className="text-muted transition group-hover:text-accent">›</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </HelpShell>
  );
}
