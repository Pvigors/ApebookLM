import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import type { LegalDoc } from "@/lib/legal-content";

/** 渲染一段:以 "- " 开头的连续行聚成要点列表,其余为普通段落。 */
function Body({ lines }: { lines: string[] }) {
  const blocks: Array<{ type: "p" | "ul"; items: string[] }> = [];
  for (const line of lines) {
    const isBullet = line.startsWith("- ");
    if (isBullet) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === "ul") last.items.push(line.slice(2));
      else blocks.push({ type: "ul", items: [line.slice(2)] });
    } else {
      blocks.push({ type: "p", items: [line] });
    }
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.type === "ul" ? (
          <ul key={i} className="my-2 space-y-1.5 pl-1">
            {b.items.map((it, j) => (
              <li key={j} className="flex gap-2.5 text-[14.5px] leading-relaxed text-ink2">
                <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent/60" />
                <span>{it}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="my-2 text-[14.5px] leading-relaxed text-ink2">
            {b.items[0]}
          </p>
        )
      )}
    </>
  );
}

export default function LegalArticle({ doc }: { doc: LegalDoc }) {
  const other = doc.slug === "agreement" ? "privacy" : "agreement";
  const otherLabel = doc.slug === "agreement" ? "隐私政策" : "用户协议";
  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-30 border-b border-edge/60 bg-canvas/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3.5">
          <Link href="/" aria-label="返回猿笔记">
            <BrandLogo />
          </Link>
          <Link
            href="/"
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-edge bg-panel px-4 text-[13px] text-ink2 transition hover:border-accent hover:text-accent"
          >
            ← 返回
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-[12px] font-medium uppercase tracking-wide text-accent">{doc.kicker}</p>
        <h1 className="mt-2 text-[28px] font-bold leading-tight text-ink">{doc.title}</h1>
        <p className="mt-2 text-[13px] text-muted">
          最近更新:{doc.updated} · 生效日期:{doc.effective}
        </p>

        <div className="mt-6 space-y-3">
          {doc.intro.map((t, i) => (
            <p key={i} className="text-[15px] leading-relaxed text-ink2">
              {t}
            </p>
          ))}
        </div>

        {doc.principle && (
          <div className="mt-5 rounded-2xl border border-accent/25 bg-accentSoft/60 p-5">
            <p className="text-[15px] font-semibold text-ink">{doc.principle.h}</p>
            <p className="mt-1 text-[15px] leading-relaxed text-ink2">{doc.principle.p}</p>
          </div>
        )}

        <div className="mt-8 space-y-7 border-t border-edge pt-7">
          {doc.sections.map((s) => (
            <section key={s.h}>
              <h2 className="text-[17px] font-bold text-ink">{s.h}</h2>
              <div className="mt-1.5">
                <Body lines={s.p} />
              </div>
            </section>
          ))}
        </div>

        <div className="mt-10 flex items-center justify-between border-t border-edge pt-6 text-[13px]">
          <Link href={`/legal/${other}`} className="text-accent transition hover:underline">
            查看《{otherLabel}》→
          </Link>
          <span className="text-muted">猿笔记 · 本实例由部署者运营</span>
        </div>
      </main>
    </div>
  );
}
