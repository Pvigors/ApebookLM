"use client";

// 双轨 PPT 的「在线演示」渲染器 —— 吃与 pptxgenjs 导出同一份 deck JSON,但用
// reveal.js 渲染:全屏、转场、逐项 fragment 动画。下载仍走 lib/pptx.ts(可编辑)。
// 由父组件以 dynamic(ssr:false) 懒加载(reveal 是浏览器专用 + 包较大)。
import { useEffect, useRef } from "react";
import "reveal.js/dist/reveal.css";
import type { DeckSlide, DeckCard, SlideTone } from "@/lib/deck";
import type { SlideTheme } from "@/lib/slide-themes";

type RevealApi = { initialize: () => Promise<void>; destroy: () => void; layout: () => void };

const toneVar = (t?: SlideTone) => `var(--rd-${t ?? "a"})`;
const toneSoft = (t?: SlideTone) => `var(--rd-${t ?? "a"}-soft)`;

/** 一张幻灯片 → reveal <section> 的内容(按 layout 分派)。多项版式逐项 .fragment。 */
function SlideBody({ s }: { s: DeckSlide }) {
  switch (s.layout) {
    case "cover":
      return (
        <div className="rd-cover">
          {s.bullets?.[0] && <div className="rd-eyebrow">{s.bullets[0]}</div>}
          <h1 className="rd-cover-title">{s.title}</h1>
          {s.subtitle && <p className="rd-cover-sub">{s.subtitle}</p>}
          {s.bullets && s.bullets.length > 1 && (
            <div className="rd-chips">
              {s.bullets.slice(1).map((b, i) => (
                <span key={i} className="rd-chip fragment fade-in">{b}</span>
              ))}
            </div>
          )}
        </div>
      );

    case "cards":
      return (
        <>
          <h2 className="rd-title">{s.title}</h2>
          <div className="rd-cards">
            {(s.cards ?? []).map((c: DeckCard, i) => (
              <div key={i} className="rd-card fragment fade-in-then-out-none" style={{ borderTopColor: toneVar(c.tone) }}>
                {c.sub && <div className="rd-card-sub" style={{ color: toneVar(c.tone) }}>{c.sub}</div>}
                <div className="rd-card-label">{c.label}</div>
                {c.text && <div className="rd-card-text">{c.text}</div>}
              </div>
            ))}
          </div>
          {s.note && <div className="rd-note">{s.note}</div>}
        </>
      );

    case "compare":
      return (
        <>
          <h2 className="rd-title">{s.title}</h2>
          {s.rows && s.rows.length ? (
            <table className="rd-table fragment fade-in">
              <thead>
                <tr><th /><th>{s.left?.label ?? "A"}</th><th>{s.right?.label ?? "B"}</th></tr>
              </thead>
              <tbody>
                {s.rows.map((r, i) => (
                  <tr key={i}><th>{r.dim}</th><td>{r.left}</td><td>{r.right}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="rd-compare">
              {[s.left, s.right].map((side, idx) =>
                side ? (
                  <div key={idx} className="rd-compare-col fragment fade-in" style={{ borderTopColor: idx ? "var(--rd-b)" : "var(--rd-a)" }}>
                    <div className="rd-compare-label" style={{ color: idx ? "var(--rd-b)" : "var(--rd-a)" }}>{side.label}</div>
                    <ul>{side.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
                  </div>
                ) : null,
              )}
            </div>
          )}
          {s.note && <div className="rd-note">{s.note}</div>}
        </>
      );

    case "rings":
      return (
        <>
          <h2 className="rd-title">{s.title}</h2>
          <div className="rd-rings">
            {s.center && <div className="rd-ring-center">{s.center}</div>}
            <div className="rd-ring-items">
              {(s.items ?? []).map((it, i) => (
                <div key={i} className="rd-ring-item fragment fade-in" style={{ background: toneSoft(it.tone) }}>
                  <span className="rd-ring-dot" style={{ background: toneVar(it.tone) }} />
                  <b>{it.label}</b>{it.text && <span> · {it.text}</span>}
                </div>
              ))}
            </div>
          </div>
          {s.note && <div className="rd-note">{s.note}</div>}
        </>
      );

    case "timeline":
      return (
        <>
          <h2 className="rd-title">{s.title}</h2>
          <div className="rd-timeline">
            {(s.items ?? []).map((it, i) => (
              <div key={i} className="rd-tl-item fragment fade-in">
                <span className="rd-tl-dot" style={{ background: toneVar(it.tone) }} />
                <div className="rd-tl-label" style={{ color: toneVar(it.tone) }}>{it.label}</div>
                {it.text && <div className="rd-tl-text">{it.text}</div>}
              </div>
            ))}
          </div>
          {s.note && <div className="rd-note">{s.note}</div>}
        </>
      );

    case "steps":
      return (
        <>
          <h2 className="rd-title">{s.title}</h2>
          <div className="rd-steps">
            {(s.items ?? []).map((it, i) => (
              <div key={i} className="rd-step fragment fade-in">
                <span className="rd-step-n" style={{ background: toneVar(it.tone), color: "var(--rd-onaccent)" }}>{i + 1}</span>
                <div><div className="rd-step-label">{it.label}</div>{it.text && <div className="rd-step-text">{it.text}</div>}</div>
              </div>
            ))}
          </div>
          {s.note && <div className="rd-note">{s.note}</div>}
        </>
      );

    case "stats":
      return (
        <>
          <h2 className="rd-title">{s.title}</h2>
          <div className="rd-stats">
            {(s.stats ?? []).map((st, i) => (
              <div key={i} className="rd-stat fragment fade-in">
                <div className="rd-stat-value" style={{ color: toneVar(st.tone) }}>{st.value}</div>
                <div className="rd-stat-label">{st.label}</div>
                {st.text && <div className="rd-stat-text">{st.text}</div>}
              </div>
            ))}
          </div>
          {s.note && <div className="rd-note">{s.note}</div>}
        </>
      );

    case "chart": {
      const data = s.chart?.data ?? [];
      const max = Math.max(1, ...data.map((d) => d.value));
      return (
        <>
          <h2 className="rd-title">{s.title}</h2>
          <div className="rd-chart">
            {data.map((d, i) => (
              <div key={i} className="rd-bar-row fragment fade-in">
                <span className="rd-bar-label">{d.label}</span>
                <span className="rd-bar-track">
                  <span className="rd-bar-fill" style={{ width: `${(d.value / max) * 100}%`, background: toneVar((["a", "b", "c", "d"] as SlideTone[])[i % 4]) }} />
                </span>
                <span className="rd-bar-val">{d.value}{s.chart?.unit ?? ""}</span>
              </div>
            ))}
          </div>
          {s.note && <div className="rd-note">{s.note}</div>}
        </>
      );
    }

    case "quote":
      return (
        <div className="rd-quote-wrap">
          {s.title && <div className="rd-eyebrow">{s.title}</div>}
          <blockquote className="rd-quote">{s.quote}</blockquote>
          {s.attribution && <div className="rd-attr">— {s.attribution}</div>}
        </div>
      );

    case "takeaways":
      return (
        <>
          <h2 className="rd-title rd-title-center">{s.title}</h2>
          <ul className="rd-takeaways">
            {(s.bullets ?? []).map((b, i) => <li key={i} className="fragment fade-in">{b}</li>)}
          </ul>
        </>
      );

    case "bullets":
    default:
      return (
        <>
          <h2 className="rd-title">{s.title}</h2>
          <ul className="rd-bullets">
            {(s.bullets ?? []).map((b, i) => <li key={i} className="fragment fade-in">{b}</li>)}
          </ul>
          {s.note && <div className="rd-note">{s.note}</div>}
        </>
      );
  }
}

export default function RevealDeck({
  deck,
  theme,
  onClose,
}: {
  deck: { slides: DeckSlide[]; watermark?: boolean };
  theme: SlideTheme;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<RevealApi | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      const mod = await import("reveal.js");
      if (dead || !rootRef.current) return;
      const Reveal = (mod.default ?? mod) as unknown as new (el: HTMLElement, opts?: Record<string, unknown>) => RevealApi;
      const r = new Reveal(rootRef.current, {
        embedded: false,
        controls: true,
        progress: true,
        hash: false,
        slideNumber: "c/t",
        transition: "slide",
        backgroundTransition: "fade",
        width: 1280,
        height: 720,
        margin: 0.06,
        // 解绑 reveal 自带的 Esc(打开缩略图总览)—— 交给本组件用作「退出演示」。
        keyboard: { 27: null },
      });
      await r.initialize();
      deckRef.current = r;
    })();
    return () => {
      dead = true;
      try {
        deckRef.current?.destroy();
      } catch {
        /* reveal teardown is best-effort */
      }
      deckRef.current = null;
    };
  }, []);

  // Esc 退出演示(reveal 的 Esc 已解绑)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // 主题色 → reveal 与本组件的 CSS 变量(把现有 5 套 SlideTheme 桥接进 reveal)。
  const vars = {
    "--r-main-color": theme.textColor,
    "--r-heading-color": theme.titleColor,
    "--r-link-color": theme.accent,
    "--r-background-color": "transparent",
    "--rd-title": theme.titleColor,
    "--rd-text": theme.textColor,
    "--rd-accent": theme.accent,
    "--rd-meta": theme.metaColor,
    "--rd-onaccent": theme.onAccent,
    "--rd-card-bg": theme.cardBg,
    "--rd-card-border": theme.cardBorder,
    "--rd-a": theme.tones.a.fg,
    "--rd-a-soft": theme.tones.a.soft,
    "--rd-b": theme.tones.b.fg,
    "--rd-b-soft": theme.tones.b.soft,
    "--rd-c": theme.tones.c.fg,
    "--rd-c-soft": theme.tones.c.soft,
    "--rd-d": theme.tones.d.fg,
    "--rd-d-soft": theme.tones.d.soft,
    background: theme.bg,
  } as React.CSSProperties;

  return (
    <div className="fixed inset-0 z-[200] bg-black">
      <button
        type="button"
        onClick={onClose}
        aria-label="退出演示"
        className="absolute right-4 top-4 z-[210] rounded-full bg-white/15 px-3 py-1.5 text-sm text-white backdrop-blur transition hover:bg-white/30"
      >
        退出 ✕
      </button>
      <style>{RD_CSS}</style>
      <div className="reveal rd-deck" ref={rootRef} style={vars}>
        <div className="slides">
          {deck.slides.map((s, i) => (
            <section key={i} data-auto-animate>
              {deck.watermark && (
                <div className="rd-wm" aria-hidden>
                  {Array.from({ length: 48 }).map((_, wi) => (
                    <span key={wi}>猿笔记</span>
                  ))}
                </div>
              )}
              <SlideBody s={s} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// 版式 CSS —— 全部 scoped 在 .rd-deck 下,用上面注入的 CSS 变量取主题色。
const RD_CSS = `
.rd-deck { font-family: "PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
.rd-deck .slides section { text-align: left; }
.rd-disclaimer { position:absolute; left:3%; right:3%; bottom:1.2%; z-index:5; color:var(--rd-meta); font-size:.27em; line-height:1.35; text-align:center; opacity:.9; }
/* 免费档水印:对角平铺「猿笔记」,压在正文之下(DOM 首子 + z-index:0)。 */
.rd-wm { position: absolute; top: -40%; left: -25%; width: 150%; height: 180%; transform: rotate(-26deg); display: flex; flex-wrap: wrap; align-content: center; justify-content: center; gap: 70px 96px; pointer-events: none; opacity: .14; z-index: 0; }
.rd-wm span { color: var(--rd-meta); font-size: 46px; font-weight: 800; letter-spacing: 10px; white-space: nowrap; }
.rd-title { color: var(--rd-title); font-size: 1.55em; font-weight: 700; margin: 0 0 .6em; letter-spacing: .01em; }
.rd-title-center { text-align: center; }
.rd-note { margin-top: .9em; padding: .5em .8em; border-left: 3px solid var(--rd-accent); color: var(--rd-meta); font-size: .62em; font-style: italic; background: var(--rd-card-bg); border-radius: 0 8px 8px 0; }
.rd-eyebrow { color: var(--rd-accent); font-size: .5em; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; margin-bottom: .6em; }

/* cover */
.rd-cover { text-align: center; padding-top: .4em; }
.rd-cover-title { color: var(--rd-title); font-size: 2.4em; font-weight: 800; line-height: 1.12; margin: 0; }
.rd-cover-sub { color: var(--rd-text); font-size: .82em; margin-top: .55em; opacity: .9; }
.rd-chips { display: flex; gap: .5em; justify-content: center; flex-wrap: wrap; margin-top: 1.1em; }
.rd-chip { border: 1px solid var(--rd-card-border); color: var(--rd-text); padding: .3em .8em; border-radius: 999px; font-size: .5em; background: var(--rd-card-bg); }

/* cards */
.rd-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: .7em; }
.rd-cards:has(.rd-card:nth-child(4):last-child), .rd-cards:has(.rd-card:nth-child(2):last-child) { grid-template-columns: repeat(2, 1fr); }
.rd-card { background: var(--rd-card-bg); border: 1px solid var(--rd-card-border); border-top: 4px solid var(--rd-a); border-radius: 14px; padding: .7em .8em; }
.rd-card-sub { font-size: .5em; font-weight: 700; letter-spacing: .05em; margin-bottom: .25em; }
.rd-card-label { color: var(--rd-title); font-size: .82em; font-weight: 700; margin-bottom: .3em; }
.rd-card-text { color: var(--rd-text); font-size: .6em; line-height: 1.5; opacity: .92; }

/* compare */
.rd-compare { display: grid; grid-template-columns: 1fr 1fr; gap: .9em; }
.rd-compare-col { background: var(--rd-card-bg); border: 1px solid var(--rd-card-border); border-top: 4px solid var(--rd-a); border-radius: 14px; padding: .7em .9em; }
.rd-compare-label { font-size: .8em; font-weight: 700; margin-bottom: .4em; }
.rd-compare-col ul { margin: 0; padding-left: 1.1em; }
.rd-compare-col li { color: var(--rd-text); font-size: .62em; line-height: 1.6; }
.rd-table { width: 100%; border-collapse: collapse; font-size: .62em; }
.rd-table th, .rd-table td { border: 1px solid var(--rd-card-border); padding: .45em .6em; text-align: left; color: var(--rd-text); }
.rd-table thead th { color: var(--rd-title); background: var(--rd-card-bg); }
.rd-table tbody th { color: var(--rd-meta); font-weight: 600; }

/* rings */
.rd-rings { display: flex; flex-direction: column; align-items: center; gap: .7em; }
.rd-ring-center { color: var(--rd-onaccent); background: var(--rd-accent); border-radius: 999px; width: 2.6em; height: 2.6em; display: grid; place-items: center; font-weight: 800; font-size: .85em; text-align: center; }
.rd-ring-items { display: flex; flex-wrap: wrap; gap: .5em; justify-content: center; }
.rd-ring-item { display: flex; align-items: center; gap: .4em; padding: .35em .8em; border-radius: 999px; color: var(--rd-text); font-size: .58em; }
.rd-ring-dot { width: .6em; height: .6em; border-radius: 999px; }

/* timeline */
.rd-timeline { border-left: 2px solid var(--rd-card-border); padding-left: 1em; display: flex; flex-direction: column; gap: .7em; }
.rd-tl-item { position: relative; }
.rd-tl-dot { position: absolute; left: -1.35em; top: .25em; width: .6em; height: .6em; border-radius: 999px; }
.rd-tl-label { color: var(--rd-title); font-weight: 700; font-size: .68em; }
.rd-tl-text { color: var(--rd-text); font-size: .58em; opacity: .9; }

/* steps */
.rd-steps { display: flex; flex-direction: column; gap: .55em; }
.rd-step { display: flex; gap: .6em; align-items: flex-start; }
.rd-step-n { flex: none; width: 1.5em; height: 1.5em; border-radius: 999px; display: grid; place-items: center; font-weight: 800; font-size: .6em; }
.rd-step-label { color: var(--rd-title); font-weight: 700; font-size: .68em; }
.rd-step-text { color: var(--rd-text); font-size: .58em; opacity: .9; }

/* stats */
.rd-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .8em; }
.rd-stat { text-align: center; background: var(--rd-card-bg); border: 1px solid var(--rd-card-border); border-radius: 14px; padding: .7em .5em; }
.rd-stat-value { font-size: 1.6em; font-weight: 800; line-height: 1; }
.rd-stat-label { color: var(--rd-title); font-size: .6em; font-weight: 600; margin-top: .35em; }
.rd-stat-text { color: var(--rd-meta); font-size: .5em; margin-top: .2em; }

/* chart */
.rd-chart { display: flex; flex-direction: column; gap: .5em; }
.rd-bar-row { display: grid; grid-template-columns: 7em 1fr 3em; align-items: center; gap: .6em; font-size: .62em; }
.rd-bar-label { color: var(--rd-text); text-align: right; }
.rd-bar-track { background: var(--rd-card-bg); border-radius: 999px; height: 1.1em; overflow: hidden; }
.rd-bar-fill { display: block; height: 100%; border-radius: 999px; transition: width .6s ease; }
.rd-bar-val { color: var(--rd-meta); }

/* quote */
.rd-quote-wrap { text-align: center; padding: 0 1.2em; }
.rd-quote { color: var(--rd-title); font-size: 1.5em; font-weight: 700; line-height: 1.4; border: 0; margin: .2em 0; box-shadow: none; }
.rd-quote::before { content: "\\201C"; color: var(--rd-accent); }
.rd-quote::after { content: "\\201D"; color: var(--rd-accent); }
.rd-attr { color: var(--rd-meta); font-size: .7em; margin-top: .6em; }

/* lists */
.rd-bullets, .rd-takeaways { color: var(--rd-text); font-size: .72em; line-height: 1.7; }
.rd-takeaways { list-style: none; padding: 0; max-width: 80%; margin: 0 auto; }
.rd-takeaways li { padding: .3em 0 .3em 1.4em; position: relative; }
.rd-takeaways li::before { content: "✓"; color: var(--rd-accent); position: absolute; left: 0; font-weight: 800; }
`;
