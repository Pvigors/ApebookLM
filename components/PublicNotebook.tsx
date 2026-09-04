"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Citation, Note, StudioOutput } from "@/lib/types";
import { relTime } from "@/lib/relative-time";
import { TRIAL_CREDITS } from "@/lib/plans";
import { childText, citationContentHash, locateCitationPassage, rehypeCitations } from "@/components/citations";
import {
  AudioDockPlayer,
  DocViewer,
  DrawvisoView,
  EqualizerIcon,
  FlashcardsView,
  InfographicView,
  MindMapView,
  outputSubtitle,
  outputVisual,
  QuizView,
  SlidesView,
  StudioRow,
  VideoPlayer,
  XhsCardsView,
} from "@/components/Studio";
import { BrandMark } from "@/components/HomeClient";
import ResponsiveMarkdownTable from "@/components/ResponsiveMarkdownTable";
import { KIND_LABEL } from "@/components/studio-shared";
import { TableSheetView } from "@/components/TableSheet";
import { DynamicStatus } from "@/components/DynamicStatus";
import { toast, Toaster } from "@/components/Toast";
import {
  ArrowUpIcon,
  AudioIcon,
  BilibiliIcon,
  CloseIcon,
  FileIcon,
  ImageIcon,
  LinkIcon,
  SpinnerIcon,
  CopyIcon,
  StarIcon,
  TextIcon,
  YoutubeIcon,
} from "@/components/Icons";

type PublicSource = {
  id: string;
  title: string;
  type: string;
  status: string;
  summary: string | null;
  key_topics: string[];
  /** 原始 URL:按扩展名判文件类型图标(PDF/Word/Excel…)。 */
  origin?: string | null;
  /** PDF 页数(0=非 PDF/未知):副标题「日期 · N 页」。 */
  pages?: number;
  /** 频道条目发布时间(自动更新频道才有):左栏按此分组时间轴 + 副标题日期。 */
  published_at?: number | null;
  /** 本期新增(非回填 · 7 天内入库):打「新」标。回填的历史文章永不为 true。 */
  is_new?: boolean;
};
type PublicData = {
  notebook: {
    id: string;
    title: string;
    emoji: string;
    summary: string | null;
    suggested_questions: string[];
    created_at: number;
    source_count: number;
    featured: boolean;
    cover: string | null;
    publisher: string | null;
    publisher_avatar: string | null;
    favorited: boolean;
    /** R1:订阅频道态 —— has=有启用的自动更新频道(铃只挂在这);status=broken 时
     *  断更对用户可见(诚实性⑤⑥);last_content_at=最近真的抓到新内容;
     *  subscriber_count/fresh_28d=右栏订阅动态条的真实数字(回填不计入更新节奏)。 */
    feed?: { has: boolean; status: string | null; last_content_at: number; subscriber_count?: number; fresh_28d?: number };
  };
  sources: PublicSource[];
  notes: Note[];
  outputs: StudioOutput[];
};

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });

const cn = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

type Msg = { role: "user" | "assistant"; content: string; citations: Citation[]; streaming?: boolean };


async function streamPublicChat(
  notebookId: string,
  message: string,
  history: { role: string; content: string }[],
  h: { onToken: (t: string) => void; onDone: (c: Citation[]) => void; onError: (m: string) => void }
) {
  const res = await fetch(`/api/public/${notebookId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok || !res.body) {
    let msg = `请求失败 (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    h.onError(msg);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt: { type?: string; value?: string; citations?: Citation[]; message?: string };
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type === "token" && evt.value) h.onToken(evt.value);
      else if (evt.type === "done") h.onDone(evt.citations || []);
      else if (evt.type === "error") h.onError(evt.message || "未知错误");
    }
  }
}

// 文件类型 → 扩展名(优先看 origin URL 的后缀,PDF 直链/上传文件都能判)。
function fileExt(origin?: string | null): string {
  const m = (origin || "").split(/[?#]/)[0].match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1].toLowerCase() : "";
}

/** 分享页来源副标题的类型名。普通笔记本没有频道发布时间时也不能整行空着。 */
function sourceTypeLabel(type: string, origin?: string | null): string {
  const ext = fileExt(origin);
  if (ext === "pdf" || type === "pdf") return "PDF";
  if (/^docx?$/.test(ext)) return "Word";
  if (/^pptx?$/.test(ext)) return "PPT";
  if (/^xlsx?$/.test(ext) || ext === "csv") return "表格";
  if (type === "youtube") return "YouTube";
  if (type === "bilibili") return "Bilibili";
  if (type === "audio") return "音频";
  if (type === "image") return "图片";
  if (type === "url") return "网页";
  return "文本";
}

// 类型化文件图标:PDF/Word/Excel/PPT 各自形状 + 品牌色,一眼可辨;非文件类
// (网页/视频/音频/图片)退回原有类型图标。
function SourceIcon({ type, origin }: { type: string; origin?: string | null }) {
  const ext = fileExt(origin);
  const doc = (tint: string, inner: React.ReactNode) => (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={tint} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      {inner}
    </svg>
  );
  if (ext === "pdf") return doc("#e0524f", <><path d="M8.5 13h1a1 1 0 0 0 0-2h-1v4" /><path d="M13 11v4h.6a1.4 1.4 0 0 0 0-4z" /></>); // 红
  if (/^docx?$/.test(ext)) return doc("#2b6bd4", <><path d="M8 12h8" /><path d="M8 15h5" /></>); // 蓝
  if (/^xlsx?$/.test(ext) || ext === "csv") return doc("#1f9d55", <><path d="M9 12v5M13 12v5M9 14.5h4" /></>); // 绿
  if (/^pptx?$/.test(ext)) return doc("#e08a2f", <rect x="8.5" y="12" width="6" height="4" rx="1" />); // 橙
  const Fallback =
    type === "youtube" ? YoutubeIcon
    : type === "bilibili" ? BilibiliIcon
    : type === "audio" ? AudioIcon
    : type === "image" ? ImageIcon
    : type === "url" ? LinkIcon
    : type === "pdf" ? FileIcon
    : TextIcon;
  return <Fallback width={14} height={14} className="shrink-0 text-ink2" />;
}

// Static, always-checked checkbox — read-only chat always uses every source.
function ReadonlyCheck() {
  return (
    <span
      title="只读 · 全部来源参与作答"
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-accent bg-accent text-onAccent"
    >
      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}

// 与登录态 ChatMarkdown 同款:[n] → 可点角标(共享 rehypeCitations),点击打开只读来源抽屉。
function PublicChatMarkdown({
  content,
  citations,
  onCite,
}: {
  content: string;
  citations: Citation[];
  onCite: (c: Citation) => void;
}) {
  const components: Components = {
    cite({ children }) {
      const n = Number(childText(children));
      const c = citations.find((x) => x.number === n);
      // 无匹配来源的编号(模型偶发越界瞎标)退回字面文本,不做假角标。
      if (!c) return <>[{n}]</>;
      return (
        <button
          type="button"
          className="cite"
          title={c.snippet ? `${c.source_title}：${c.snippet}` : c.source_title}
          onClick={() => onCite(c)}
        >
          {n}
        </button>
      );
    },
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    table({ children }) {
      return <ResponsiveMarkdownTable>{children}</ResponsiveMarkdownTable>;
    },
  };
  return (
    <div className="prose-chat">
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

// Build a {before, match, after} split that locates a citation snippet inside
// the source's full text, tolerating whitespace differences. Returns null if
// the passage can't be found.(与登录态 SourceViewer 的 locatePassage 同款)
function locateFirstPassage(
  content: string,
  snippet: string
): { before: string; match: string; after: string } | null {
  const needle = snippet.trim();
  if (!needle) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Each run of whitespace in the snippet may correspond to any whitespace in
  // the original; non-space characters match literally.
  const pattern = needle
    .split(/\s+/)
    .map(esc)
    .join("\\s+");
  try {
    const re = new RegExp(pattern);
    const m = re.exec(content);
    if (!m) return null;
    return {
      before: content.slice(0, m.index),
      match: m[0],
      after: content.slice(m.index + m[0].length),
    };
  } catch {
    return null;
  }
}

// 正文段落化(标准阅读格式的前提):HTML 源常带真实换行 → 直接按行切;PDF 直链
// 是无换行长文(unpdf 合并页面丢了段落结构)→ 按句末标点累积成 ~180 字的段。
// 各段渲染时加首行缩进(text-indent),得到标准文档版式。
function toParagraphs(text: string): string[] {
  const byLine = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (byLine.length > 1) return byLine;
  // 句子边界:句末标点后须跟空白 + 大写字母/中文/开引号才算真断 —— 避免在 URL
  // (visit www. rand.org)、缩写(U.S.)、小数点处误断。累积到 ~200 字成一段。
  const sentences = text.split(/(?<=[.。!?！？]["'』」）)]?)\s+(?=[A-Z一-鿿“"(])/);
  const paras: string[] = [];
  let buf = "";
  for (const s of sentences) {
    buf += (buf ? " " : "") + s.trim();
    if (buf.length >= 200) {
      paras.push(buf);
      buf = "";
    }
  }
  if (buf.trim()) paras.push(buf.trim());
  return paras.length ? paras : [text.trim()];
}

// What the read-only source drawer is currently showing.
type PublicViewerTarget = {
  sourceId: string;
  title: string;
  snippet?: string;
  chunkIndex?: number;
  sourceStart?: number;
  sourceEnd?: number;
  sourceContentHash?: string;
};

/** 只读来源抽屉:分享页点引用角标 / 底部引用 chip 时打开。参考登录态 SourceViewer
 *  的定位思路,简化为「纯文本 + locatePassage 命中段 <mark> + 滚动居中」。 */
function PublicSourceViewer({
  notebookId,
  target,
  onClose,
}: {
  notebookId: string;
  target: PublicViewerTarget;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<{ title: string; content: string; type: string; origin?: string | null; is_pdf?: boolean; sections?: { title: string; anchor: string }[] } | null>(null);
  const [sourceVersionChanged, setSourceVersionChanged] = useState(false);
  const markRef = useRef<HTMLElement>(null);
  // 方案 E 双栏:当前节(滚动联动高亮)与各节 DOM 引用。
  const [activeSec, setActiveSec] = useState(0);
  const secRefs = useRef<(HTMLElement | null)[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 顶栏控件(对齐制品查看器 EditorShell):放大/还原。
  const [full, setFull] = useState(false);
  // PDF 源:默认内嵌原版(排版/图表无损);可切「提取文本」看双栏阅读器。
  // 引用定位(target.snippet)强制文本视图 —— 内嵌 PDF 无法程序化高亮命中句。
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setSource(null);
    setSourceVersionChanged(false);
    fetch(`/api/public/${notebookId}/sources/${target.sourceId}`)
      .then(async (r) => {
        const data = await r.json();
        if (!alive) return;
        if (r.ok) setSource(data);
        else setError(data.error || "无法加载来源");
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [notebookId, target.sourceId]);

  useEffect(() => {
    let alive = true;
    if (!source || !target.sourceContentHash) {
      setSourceVersionChanged(false);
      return () => { alive = false; };
    }
    void citationContentHash(source.content).then((currentHash) => {
      if (alive) setSourceVersionChanged(!!currentHash && currentHash !== target.sourceContentHash);
    });
    return () => { alive = false; };
  }, [source, target.sourceContentHash]);

  // 引用命中段滚动居中(渲染完成后)。
  useEffect(() => {
    if (!loading && source && target.snippet && markRef.current) {
      markRef.current.scrollIntoView({ block: "center" });
    }
  }, [loading, source, target.snippet]);

  // Esc 关闭抽屉(capture,避免被页面其它监听截走)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const passage =
    source && target.snippet
      ? locateCitationPassage(source.content, target.snippet, target.sourceStart, target.sourceEnd)
      : null;

  // 方案 E:用章节锚点把全文切成分节(锚点=各节第一个 chunk 的开头,依序 indexOf,
  // 失配的节并入前节容错)。≥2 节才启用双栏;引用定位(passage)场景保持硬高亮整文。
  const parts = (() => {
    if (!source || passage || !source.sections || source.sections.length < 2) return null;
    const text = source.content;
    const cuts: { title: string; at: number }[] = [];
    let searchFrom = 0;
    for (const s of source.sections) {
      const needle = s.anchor.trim().slice(0, 60);
      if (!needle) continue;
      let at = text.indexOf(needle, searchFrom);
      if (at < 0) {
        // 空白差异(清洗/normalize 不同步)时退宽松匹配:词序列 + \s+ 容忍
        const loose = locateFirstPassage(text.slice(searchFrom), needle);
        if (loose) at = searchFrom + loose.before.length;
      }
      if (at >= 0) {
        cuts.push({ title: s.title, at });
        searchFrom = at + 1;
      }
    }
    if (cuts.length < 2) return null;
    if (cuts[0].at > 0) cuts[0].at = 0; // 首节覆盖开头(锚点前的散头并入首节)
    return cuts.map((c, i) => ({
      title: c.title,
      text: text.slice(c.at, i + 1 < cuts.length ? cuts[i + 1].at : undefined).trim(),
    }));
  })();

  // 滚动联动当前节:预览环境 rAF/IntersectionObserver 会被暂停(项目实锤),用 scroll 事件手算;
  // 坐标用 getBoundingClientRect 差值 —— offsetTop 的 offsetParent 未必是滚动容器。
  const onBodyScroll = () => {
    const box = bodyRef.current;
    if (!box || !parts) return;
    const boxTop = box.getBoundingClientRect().top;
    let cur = 0;
    secRefs.current.forEach((el, i) => {
      if (el && el.getBoundingClientRect().top - boxTop <= 80) cur = i;
    });
    setActiveSec(cur);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          "flex w-full flex-col overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl transition-[max-width,height]",
          full ? "h-[94vh] max-w-[96vw]" : "h-[88vh] max-w-4xl"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏对齐制品查看器 EditorShell:标题 + 分享 / 放大 / 关闭 */}
        <div className="flex items-center justify-between gap-3 border-b border-edge px-6 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className="truncate text-[18px] font-semibold leading-snug text-ink" title={target.title}>
              {target.title}
            </h2>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-panel2 px-2.5 py-0.5 text-[11px] font-medium text-ink2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
              来源 · 只读
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* PDF 源:原版 / 提取文本 切换(引用定位场景不显示,强制文本高亮) */}
            {source?.is_pdf && !passage && (
              <div className="mr-1 hidden items-center rounded-lg bg-panel2 p-0.5 text-[12px] font-medium sm:flex">
                <button onClick={() => setShowText(false)} className={cn("rounded-md px-2.5 py-1 transition", !showText ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")}>原版</button>
                <button onClick={() => setShowText(true)} className={cn("rounded-md px-2.5 py-1 transition", showText ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink")}>文本</button>
              </div>
            )}
            {source?.is_pdf && source.origin && (
              <a href={source.origin} target="_blank" rel="noopener noreferrer" title="在新标签打开原版 PDF" aria-label="在新标签打开原版 PDF" className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
              </a>
            )}
            <button onClick={() => setFull((v) => !v)} title={full ? "还原" : "放大"} aria-label={full ? "还原" : "放大"} className="hidden rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent lg:block">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {full ? (
                  <><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="m14 10 7-7" /><path d="m3 21 7-7" /></>
                ) : (
                  <><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /></>
                )}
              </svg>
            </button>
            <button onClick={onClose} title="关闭" aria-label="关闭" className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-ink">
              <CloseIcon width={19} height={19} />
            </button>
          </div>
        </div>
        {sourceVersionChanged && (
          <div className="shrink-0 border-b border-amber-200 bg-amber-50/70 px-6 py-2 text-[12px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            来源内容已更新；当前页面按新版本重新定位，角标仍保留生成回答时核验过的原文摘录。
          </div>
        )}
        {loading ? (
          <div className="flex items-center gap-2 px-6 py-10 text-sm text-ink2">
            <SpinnerIcon width={16} height={16} /> 正在加载来源…
          </div>
        ) : error ? (
          <p className="px-6 py-10 text-center text-sm text-red-600">{error}</p>
        ) : source ? (
          source.is_pdf && source.origin && !passage && !showText ? (
            // PDF 源:内嵌原版(排版/图表/公式无损)—— 提取文本重排是舍近求远。
            // 走 /pdf 代理端点:源站(RAND)带 Content-Disposition: attachment 会强制
            // 下载致 iframe 黑屏,代理改写为 inline 让浏览器内联渲染;失败时顶栏
            // 「在新标签打开原版 PDF」与「文本」切换兜底。
            <iframe
              src={`/api/public/${notebookId}/sources/${target.sourceId}/pdf`}
              title={source.title}
              className="min-h-0 w-full flex-1 border-0 bg-panel2"
            />
          ) : passage ? (
            // 命中引用段:纯文本 + <mark> 硬高亮,保证定位可见。
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-4">
              <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.9] text-ink">
                {passage.before}
                <mark ref={markRef} className="rounded bg-accent/30 px-0.5 text-ink">
                  {passage.match}
                </mark>
                {passage.after}
              </p>
            </div>
          ) : parts ? (
            // 方案 E 双栏阅读器:左粘性目录(点击跳转+滚动联动高亮)+ 右分节正文。
            // 窄屏(<sm)目录整栏隐藏,塌缩为单栏阅读视图。
            <div className="flex min-h-0 flex-1">
              <nav className="hidden w-[210px] shrink-0 overflow-y-auto border-r border-edge px-2.5 py-4 sm:block">
                <p className="px-2 pb-2 text-[10.5px] font-bold uppercase tracking-wider text-muted">目录</p>
                {parts.map((p, i) => (
                  <button
                    key={i}
                    // behavior 恒 auto:smooth 靠 rAF 驱动,后台/预览标签 rAF 被暂停会永远不滚(项目实锤坑)。
                    // 点击即置高亮,不等 scroll 事件回算(某些滚动路径不触发合成事件)。
                    onClick={() => { setActiveSec(i); secRefs.current[i]?.scrollIntoView({ block: "start" }); }}
                    className={cn(
                      "block w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] leading-snug transition",
                      i === activeSec ? "bg-accentSoft font-semibold text-accent" : "text-ink2 hover:bg-panel2"
                    )}
                  >
                    {p.title}
                  </button>
                ))}
              </nav>
              <div ref={bodyRef} onScroll={onBodyScroll} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
                {/* 自适应:放大态放宽阅读栏宽度并微增字号,不再固定 640 留大片白 */}
                <div className={cn("mx-auto", full ? "max-w-[860px]" : "max-w-[640px]")}>
                  {parts.map((p, i) => (
                    <section key={i} ref={(el) => { secRefs.current[i] = el; }} className="mb-7 scroll-mt-4">
                      <h3 className={cn("mb-2.5 font-bold leading-snug text-ink", full ? "text-[18px]" : "text-[16px]")}>{p.title}</h3>
                      {/* 标准文档版式:段落化 + 首行缩进 2em(段间不额外空行,靠缩进区隔) */}
                      {toParagraphs(p.text).map((para, j) => (
                        <p key={j} className={cn("break-words leading-[1.9] text-ink2", full ? "text-[15.5px]" : "text-[14.5px]")} style={{ textIndent: "2em" }}>{para}</p>
                      ))}
                    </section>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            // 无章节的普通来源:同款段落化 + 首行缩进(纯文本 content);含 markdown 标记的
            // 走 ReactMarkdown(链接/列表),否则按标准文档版式排。
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-4">
              <div className={cn("mx-auto", full ? "max-w-[860px]" : "max-w-[640px]")}>
                {/^\s*(#{1,6}\s|[-*]\s|\d+\.\s|\|)/m.test(source.content) ? (
                  <div className="prose-chat">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{source.content}</ReactMarkdown>
                  </div>
                ) : (
                  toParagraphs(source.content).map((para, j) => (
                    <p key={j} className={cn("break-words leading-[1.9] text-ink2", full ? "text-[15.5px]" : "text-[14.5px]")} style={{ textIndent: "2em" }}>{para}</p>
                  ))
                )}
              </div>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

/** 公开页手工笔记只读查看器。不能复用 DocViewer：后者是编辑器，会自动 PATCH 保存。 */
function PublicNoteViewer({ note, onClose }: { note: Note; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-0 lg:p-4" onClick={onClose}>
      <div
        className="flex h-dvh w-full max-w-3xl flex-col overflow-hidden bg-panel shadow-2xl lg:h-[82vh] lg:rounded-2xl lg:border lg:border-edge"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-edge px-5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[17px] font-semibold text-ink">{note.title}</h2>
            <p className="mt-0.5 text-[11px] text-muted">笔记 · {fmtDate(note.created_at)} · 只读</p>
          </div>
          <button onClick={onClose} aria-label="关闭" className="grid h-8 w-8 place-items-center rounded-full text-ink2 transition hover:bg-panel2 hover:text-ink">
            <CloseIcon width={17} height={17} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 [scrollbar-gutter:stable] lg:px-9">
          <div className="prose-chat text-[15px] leading-[1.9] text-ink2">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content || "(空笔记)"}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PublicNotebook({ id }: { id: string }) {
  const [data, setData] = useState<PublicData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openOutput, setOpenOutput] = useState<StudioOutput | null>(null);
  const [playingAudio, setPlayingAudio] = useState<StudioOutput | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [notesView, setNotesView] = useState<"smart" | "mine">("smart");
  const [openNote, setOpenNote] = useState<Note | null>(null);
  // 只读来源抽屉(点引用角标 / 底部引用 chip 打开)。
  const [viewer, setViewer] = useState<PublicViewerTarget | null>(null);
  // 手机端(<1024px)三栏改为底部 tab 驱动;桌面端布局不变。
  const [mobileTab, setMobileTab] = useState<"chat" | "sources" | "studio">("chat");

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [copying, setCopying] = useState(false);
  const [fav, setFav] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNotesView("smart");
    setOpenNote(null);
  }, [id]);

  // 收藏此精选笔记本(顶栏按钮):乐观翻转,失败回滚;未登录跳登录。
  const toggleFav = useCallback(async () => {
    if (favBusy) return;
    const next = !fav;
    setFav(next);
    setFavBusy(true);
    try {
      const r = await fetch("/api/favorites", {
        method: next ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notebookId: id }),
      });
      if (r.status === 401) {
        setFav(!next);
        window.location.href = "/login";
        return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || "操作失败");
      }
    } catch (e) {
      setFav(!next);
      toast((e as Error).message || "操作失败,请重试");
    } finally {
      setFavBusy(false);
    }
  }, [fav, favBusy, id]);

  const copyToMine = useCallback(async () => {
    setCopying(true);
    try {
      const r = await fetch(`/api/notebooks/${id}/copy`, { method: "POST" });
      if (r.status === 401) {
        window.location.href = "/login";
        return;
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "复制失败");
      window.location.href = "/";
    } catch (e) {
      toast((e as Error).message);
      setCopying(false);
    }
  }, [id]);

  const openCitation = useCallback((c: Citation) => {
    if (c.source_kind === "web" && c.source_url && /^https?:\/\//i.test(c.source_url)) {
      const opened = window.open(c.source_url, "_blank", "noopener,noreferrer");
      if (opened) opened.opener = null;
      return;
    }
    setViewer({
      sourceId: c.source_id,
      title: c.source_title,
      snippet: c.quote || c.snippet,
      chunkIndex: c.chunk_index,
      sourceStart: c.source_start,
      sourceEnd: c.source_end,
      sourceContentHash: c.source_content_hash,
    });
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`/api/public/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "该笔记本未公开或不存在。" : `加载失败 (${r.status})`);
        return r.json();
      })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setFav(!!d?.notebook?.favorited);
        // 订阅已读游标:打开智库工作台=看到了 —— 前台可见时【显式】上报(绝非 GET 副作用,
        // 防后台标签自动 refetch 误标已读)。仅订阅者需要;失败静默,徽章下次再清。
        // 审查修复:后台标签打开的场景要在真正切前台时补报一次(一次性 listener)。
        if (d?.notebook?.favorited) {
          const report = () => fetch("/api/favorites", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notebookId: id, seen: true }),
          }).catch(() => {});
          if (document.visibilityState === "visible") report();
          else {
            const onVis = () => {
              if (document.visibilityState === "visible") {
                document.removeEventListener("visibilitychange", onVis);
                report();
              }
            };
            document.addEventListener("visibilitychange", onVis);
          }
        }
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 分享直达:URL 带 ?doc=<outputId> 时,数据就绪后自动打开对应制品(音频进播放坞,其余进查看器)。
  // 只触发一次(ref 守卫),用户关闭后不再重新弹;未命中/无参数则无任何行为变化。
  const deepLinkedRef = useRef(false);
  const smartListRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!data || deepLinkedRef.current) return;
    deepLinkedRef.current = true;
    try {
      const docId = new URLSearchParams(window.location.search).get("doc");
      if (!docId) return;
      const target = data.outputs.find((o) => o.id === docId);
      if (!target) return;
      if (target.kind === "audio") setPlayingAudio(target);
      else setOpenOutput(target);
      // 列表可能很长:命中项滚到视野中间,关闭查看器后也能看到它。
      // 列表 DOM 由另一个 effect 切到「智能笔记」视图后才渲染,延后一拍再滚。
      setTimeout(() => {
        try {
          // 与渲染处 sortedOutputs 同一排序规则(音频置顶、组内稳定)。
          const sorted = [...data.outputs].sort(
            (a, b) => (a.kind === "audio" ? 0 : 1) - (b.kind === "audio" ? 0 : 1)
          );
          const idx = sorted.findIndex((o) => o.id === docId);
          if (idx >= 0) smartListRef.current?.children[idx]?.scrollIntoView({ block: "center" });
        } catch {
          /* 滚动只是锦上添花,失败无碍 */
        }
      }, 100);
    } catch {
      /* 解析失败视同无参数 */
    }
  }, [data]);

  const send = useCallback(
    async (text: string) => {
      const msg = text.trim();
      if (!msg || sending) return;
      setSending(true);
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      setMessages((prev) => [
        ...prev,
        { role: "user", content: msg, citations: [] },
        { role: "assistant", content: "", citations: [], streaming: true },
      ]);
      const patch = (fn: (m: Msg) => Msg) =>
        setMessages((prev) => prev.map((m, i) => (i === prev.length - 1 ? fn(m) : m)));
      try {
        await streamPublicChat(id, msg, history, {
          onToken: (t) => patch((m) => ({ ...m, content: m.content + t })),
          onDone: (citations) => patch((m) => ({ ...m, citations, streaming: false })),
          onError: (err) =>
            patch((m) => ({ ...m, content: m.content || `⚠️ ${err}`, streaming: false })),
        });
      } finally {
        setSending(false);
      }
    },
    [id, messages, sending]
  );

  const submit = () => {
    if (input.trim()) {
      send(input);
      setInput("");
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-ink2">
        <SpinnerIcon /> 加载中…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accentSoft text-accent">
          <FileIcon width={22} height={22} />
        </div>
        <p className="text-ink">{error || "无法加载笔记本"}</p>
        <Link href="/" className="text-sm text-accent transition hover:underline">
          ← 返回首页
        </Link>
      </div>
    );
  }

  const { notebook, sources, outputs, notes } = data;
  // 分享页把音频概览(播客)置顶展示 —— 只调展示排序不动数据;sort 稳定,组内保持原序。
  const sortedOutputs = [...outputs].sort(
    (a, b) => (a.kind === "audio" ? 0 : 1) - (b.kind === "audio" ? 0 : 1)
  );
  // 自动更新频道:右栏语义从「智能笔记」换成「更新简报」—— 期刊流(每期简报 note)
  // 才是频道访客关心的内容;订阅动态条数字全部真实。
  const isFeed = !!notebook.feed?.has;
  const briefs = isFeed
    ? notes.filter((n) => n.id.startsWith("feedbrief-")).sort((a, b) => b.created_at - a.created_at)
    : [];
  // 公开 API 已按法律/帮助中心口径返回手工笔记；feedbrief 仍只进「智能笔记」期刊流。
  const publicNotes = notes.filter((n) => !n.id.startsWith("feedbrief-"));
  const smartCount = outputs.length + briefs.length;
  // 老笔记本没有预生成推荐问题时，用不带事实预设的通用问题补入口；没有来源则不显示。
  const chips = notebook.suggested_questions?.length
    ? notebook.suggested_questions
    : sources.length > 0
    ? ["这本笔记本的核心结论是什么？", "不同来源有哪些共同点？", "有哪些信息需要进一步核对？"]
    : [];
  // 编者按默认收起为一行(用户定稿:详细介绍保留但不占版面),点「展开」看全文。

  // Cover hero + 编者按 — pinned atop the conversation. Same card structure as
  // the editable notebook's NotebookOverviewCard so the two pages feel like one.
  const coverBlock = (
    <>
      <div
        className="relative overflow-hidden rounded-2xl px-6 pb-6 pt-5"
        style={{ background: notebook.cover ?? "linear-gradient(135deg,#6d5ae6,#b765ec)" }}
      >
        {/* readability scrim — keeps emoji + title legible on any cover */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, rgba(0,0,0,0.30), rgba(0,0,0,0.04) 42%, rgba(0,0,0,0.55))",
          }}
        />
        {/* oversized emoji watermark */}
        <span className="pointer-events-none absolute -right-2 -top-3 select-none text-[120px] leading-none opacity-20">
          {notebook.emoji}
        </span>
        {/* top row: emoji + publisher chip */}
        <div className="relative flex items-start justify-between gap-3">
          <span
            className="select-none px-1 text-[44px] leading-none"
            style={{ filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.5))" }}
          >
            {notebook.emoji}
          </span>
          {notebook.publisher && (
            <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-white/20 px-3 py-1.5 text-[13px] font-medium text-white backdrop-blur">
              <BrandMark size={15} /> {notebook.publisher}
            </span>
          )}
        </div>
        {/* title + meta */}
        <div className="relative mt-8">
          <h2
            className="text-[24px] font-bold leading-tight text-white"
            style={{ textShadow: "0 1px 10px rgba(0,0,0,0.55)" }}
          >
            {notebook.title}
          </h2>
          <p className="mt-1.5 text-sm text-white" style={{ textShadow: "0 1px 8px rgba(0,0,0,0.55)" }}>
            {notebook.source_count} 个来源 · {fmtDate(notebook.created_at)}
          </p>
        </div>
      </div>
      {notebook.summary && (
        <div className="mt-4">
          {/* 不加「编者按」悬浮标签 —— NotebookLM 同款:简介正文直接展示,
              编辑口吻(如「编者按:」开头)由后台编者按文本自己写,行内更自然。 */}
          {/* 编者按支持 Markdown(链接/粗斜体/列表)—— 对齐 NotebookLM 精选页(编者按里带出版方推广链接)。
              链接一律新窗口打开,不打断访客当前的阅读/对话。
              列表样式必须在此显式补回:Tailwind preflight 清了 ol/ul 的 marker 与缩进,
              而 .prose-chat 的列表样式不作用于这里,不补则「1. / - 」整体消失。 */}
          {/* 编者按直接全显,不做展开/收起(用户定稿:会话里的展开不需要了)。 */}
          <div className="min-w-0 text-[15px] leading-relaxed text-ink2 [&_a]:font-medium [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_em]:italic [&_li+li]:mt-1 [&_ol]:mt-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // 解构丢弃 node(hast 对象),防其被 spread 成 DOM 垃圾属性 node="[object Object]"。
                a: ({ node: _node, ...props }) => (
                  <a {...props} target="_blank" rel="noopener noreferrer" />
                ),
              }}
            >
              {notebook.summary}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-screen flex-col">
      {/* top bar — matches the real notebook view */}
      <header className="flex h-14 items-center gap-3 px-4">
        <Link
          href="/"
          title="返回首页"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-accent text-onAccent shadow-[0_6px_18px_-5px_rgba(109,90,230,0.55)] transition hover:brightness-110"
        >
          <BrandMark size={28} />
        </Link>
        {/* 定稿:方案 C 的极简形态(锁 + 灰字,无底无边)放进方案 F 的布局(标题副行)——
            状态说明退出横向排布,永不和标题/操作按钮抢顶栏宽度。 */}
        <div className="flex min-w-0 flex-col justify-center">
          <h1 className="max-w-[42vw] truncate text-[15px] font-bold leading-tight text-ink">{notebook.title}</h1>
          <span className="hidden items-center gap-1 text-[11px] leading-4 text-muted sm:flex">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            公开 · 只读
          </span>
        </div>
        {/* R1 诚实性⑥「断更可见」:自动更新频道的健康状态直接亮在顶栏 ——
            broken(源站访问异常)与安静的频道在用户眼里绝不能一模一样。 */}
        {notebook.feed?.has && (
          <span
            className={cn(
              "hidden h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-semibold md:inline-flex",
              notebook.feed.status === "broken"
                ? "bg-red-500/10 text-red-600"
                : "bg-green-500/10 text-green-600"
            )}
          >
            {notebook.feed.status === "broken"
              ? "源站访问异常,更新暂停"
              : notebook.feed.last_content_at > 0
              ? `自动更新 · 最近更新 ${relTime(notebook.feed.last_content_at)}`
              : "自动更新 · 等待首批内容"}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* R1 诚实性⑤「铃=真的会响」:有启用频道的智库才是「订阅」(会收到更新提醒);
              静态策展笔记本保持「收藏」——上轮把两者压进同一个比特是 critical 教训。 */}
          {notebook.featured && (
            // 样式对齐笔记本工作区顶栏「分享」按钮:h-9 · rounded-[13px] · 描边 pill,已收藏=accentSoft 高亮。
            <button
              onClick={toggleFav}
              disabled={favBusy}
              aria-pressed={fav}
              title={
                notebook.feed?.has
                  ? fav ? "取消订阅(更新将不再提醒)" : "订阅:该智库有更新时通过站内消息提醒你"
                  : fav ? "取消收藏" : "收藏到「精选笔记本」"
              }
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[13px] border px-3 text-[13px] font-semibold transition disabled:opacity-50 sm:px-3.5",
                fav
                  ? "border-accent/60 bg-accentSoft text-accent"
                  : "border-edge bg-panel text-ink2 hover:border-accent/50 hover:text-ink"
              )}
            >
              <StarIcon width={15} height={15} fill={fav ? "currentColor" : "none"} />
              {/* 窄屏只留图标:顶栏固定宽度项过多会把标题挤没(审查实锤 ≲345px 溢出) */}
              <span className="hidden sm:inline">
                {notebook.feed?.has ? (fav ? "已订阅" : "订阅") : fav ? "已收藏" : "收藏"}
              </span>
            </button>
          )}
          <button
            onClick={copyToMine}
            disabled={copying}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-onAccent transition hover:brightness-110 disabled:opacity-50"
            title="拷贝一份到你自己的账号,即可自由编辑"
          >
            {copying ? <SpinnerIcon width={14} height={14} /> : <CopyIcon width={14} height={14} />}
            复制到我的笔记本
          </button>
        </div>
      </header>

      {/* 3 floating panels — same chrome as the editable notebook view.
          手机端(<1024px)由底部 tab 决定显示哪一栏;桌面端三栏并排不变。 */}
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3 pt-1">
        {/* 来源 */}
        <aside
          className={cn(
            mobileTab === "sources" ? "flex" : "hidden",
            "w-full shrink-0 flex-col overflow-hidden rounded-[22px] bg-panel elev-soft lg:flex lg:w-[300px]"
          )}
        >
          <div className="flex items-center gap-2 px-3 py-3">
            <h2 className="text-sm font-semibold text-ink">来源</h2>
          </div>

          {sources.length > 0 && (
            <div className="mx-2 mb-1 flex items-center gap-2 rounded-lg px-2 py-2 text-xs text-ink2">
              <span>全部来源</span>
              <span className="ml-auto tabular-nums text-muted">{sources.length}</span>
              <ReadonlyCheck />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {sources.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <FileIcon className="mx-auto mb-3 text-muted" width={30} height={30} />
                <p className="text-sm font-medium text-ink">此笔记本暂无来源</p>
              </div>
            ) : (
              // 自动更新频道:按发布时间轴分组(月粒度,新→旧),本期新增打「新」标;
              // 普通公开笔记本无时间数据 → 单组平铺,渲染路径不变。
              (() => {
                const hasTimeline = !!notebook.feed?.has && sources.some((s) => s.published_at);
                const groups = new Map<string, PublicSource[]>();
                if (hasTimeline) {
                  const sorted = [...sources].sort((a, b) => (b.published_at ?? 0) - (a.published_at ?? 0));
                  for (const s of sorted) {
                    const d = s.published_at ? new Date(s.published_at) : null;
                    const k = d ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月` : "日期未注明";
                    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
                  }
                } else {
                  groups.set("", sources);
                }
                return (
                  <div className="space-y-2">
                    {[...groups.entries()].map(([label, items]) => (
                      <div key={label || "all"}>
                        {label && (
                          <div className="flex items-center gap-2 px-2 pb-1 pt-2">
                            <span className="text-[11px] font-semibold tracking-wide text-muted">{label}</span>
                            <span className="h-px flex-1 bg-edge" />
                            {/* 方案 A:组内有本期新增时点亮计数(is_new 只给非回填近 7 天条目) */}
                            {items.some((i) => i.is_new) && (
                              <span className="rounded-full bg-accentSoft px-1.5 text-[10px] font-bold leading-4 text-accent">
                                +{items.filter((i) => i.is_new).length} 新
                              </span>
                            )}
                            <span className="text-[11px] tabular-nums text-muted">{items.length}</span>
                          </div>
                        )}
                        <ul className="space-y-1">
                          {items.map((s) => {
                            // 普通公开本没有发布时间时也展示类型；频道来源再追加日期，PDF 再追加页数。
                            const typeStr = sourceTypeLabel(s.type, s.origin);
                            const dateStr = s.published_at ? fmtDate(s.published_at) : "";
                            const pagesStr = (s.pages ?? 0) > 0 ? `${s.pages} 页` : "";
                            const sub = [typeStr, dateStr, pagesStr].filter(Boolean).join(" · ");
                            return (
                              <li
                                key={s.id}
                                // 点击打开只读全文预览(复用引用角标的 PublicSourceViewer 抽屉)。
                                onClick={() => setViewer({ sourceId: s.id, title: s.title })}
                                className="group flex cursor-pointer items-center gap-1.5 rounded-xl px-2 py-1.5 transition hover:bg-panel2"
                                title={s.summary || undefined}
                              >
                                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-panel2 transition group-hover:bg-panel">
                                  <SourceIcon type={s.type} origin={s.origin} />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-1.5">
                                    <span className="min-w-0 truncate text-sm text-ink">{s.title}</span>
                                    {/* 新标定稿方案2:红点(微信未读范式)—— 红色在紫色系界面里跳脱,零文字一眼可扫 */}
                                    {s.is_new && (
                                      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-red-500" title="本期新增" aria-label="本期新增" />
                                    )}
                                  </span>
                                  {sub && <span className="mt-0.5 block truncate text-xs text-muted">{sub}</span>}
                                </span>
                                <span className="flex shrink-0 items-center">
                                  <ReadonlyCheck />
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                );
              })()
            )}
          </div>
        </aside>

        {/* 公开分享只读导览：保留系统原三栏外壳，不开放匿名 AI 调用。 */}
        <section
          className={cn(
            mobileTab === "chat" ? "flex" : "hidden",
            "min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-panel elev-soft lg:flex"
          )}
        >
          <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
            <h2 className="text-sm font-semibold text-ink">内容导览</h2>
          </div>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
            {messages.length === 0 ? (
              <div className="mx-auto max-w-3xl px-4 pb-6 pt-3">
                {coverBlock}

                {/* 原建议问题保留为只读内容提要，增强公开页信息密度。 */}
                {chips.length > 0 && (
                  <div className="pt-6">
                    <p className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                      你可以重点关注
                    </p>
                    <div className="flex flex-col items-start gap-2">
                      {chips.map((qq) => (
                        <div
                          key={qq}
                          title={qq}
                          className="max-w-[85%] truncate rounded-2xl rounded-bl-sm bg-panel2 px-4 py-2.5 text-left text-sm leading-relaxed text-ink"
                        >
                          {qq}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="mx-auto max-w-3xl px-4 pb-6 pt-3">
                {coverBlock}
                <div className="mt-6 space-y-6">
                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accentSoft px-4 py-2.5 text-sm text-ink">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div key={i}>
                      <div className="min-w-0">
                        {m.content ? (
                          <PublicChatMarkdown content={m.content} citations={m.citations} onCite={openCitation} />
                        ) : (
                          <DynamicStatus
                            steps={[
                              "正在理解你的问题…",
                              "正在浏览本笔记本来源…",
                              "正在定位相关段落…",
                              "正在交叉比对信息…",
                              "正在综合组织答案…",
                              "正在标注引用出处…",
                            ]}
                            className="py-1 text-sm text-ink2"
                          />
                        )}
                        {m.citations.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-edge pt-2.5">
                            {m.citations.map((c) => (
                              <button
                                key={c.number}
                                type="button"
                                title={c.snippet}
                                onClick={() => openCitation(c)}
                                className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-lg border border-edge bg-panel px-2 py-1 text-xs text-ink2 transition hover:border-accent/50 hover:text-accent"
                              >
                                <span className="mono flex h-4 w-4 shrink-0 items-center justify-center rounded bg-accentSoft text-[10px] font-semibold text-accent">
                                  {c.number}
                                </span>
                                <span className="truncate">{c.source_title}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                )}
                </div>
              </div>
            )}
          </div>
          <div className="px-4 pb-4 pt-2">
            <div className="mx-auto max-w-3xl">
              <div className="flex items-center gap-3 rounded-[22px] border border-edge bg-panel2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">公开分享仅支持阅读</p>
                  <p className="mt-0.5 text-xs text-muted">复制到自己的工作台后，注册即得 {TRIAL_CREDITS} 积分，可继续提问、编辑和生成。</p>
                </div>
                <Link href="/login?next=/" className="shrink-0 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-onAccent transition hover:brightness-110">
                  登录 / 注册
                </Link>
              </div>
              <p className="mt-1.5 px-1 text-center text-[11px] text-muted">
                可直接查看左侧来源与右侧公开笔记、制品。
              </p>
            </div>
          </div>
        </section>

        {/* 笔记 (read-only) — same chrome as the editable StudioPanel。
            生成器磁贴不进访客视图(磁贴=所有者编辑视图专属,NotebookLM 同构):
            访客只看编辑部预生成的现成内容,要生成需先「复制到我的笔记本」。 */}
        <aside
          className={cn(
            mobileTab === "studio" ? "flex" : "hidden",
            "w-full shrink-0 flex-col overflow-hidden rounded-[22px] bg-panel elev-soft lg:flex lg:w-[360px] xl:w-[384px]"
          )}
        >
          {/* 与登录态系统同一套切换；只增加公开内容入口，不改变右栏外壳。 */}
          <div className="px-4 pb-2 pt-3.5">
            <div className="flex items-center">
              <span className="text-[15px] font-semibold text-ink">笔记</span>
              <span className="ml-auto text-[11px] tabular-nums text-muted">{smartCount + publicNotes.length} 项</span>
            </div>
            <div className="mt-2 flex rounded-xl bg-panel2 p-1">
              <button
                onClick={() => setNotesView("smart")}
                className={cn(
                  "flex-1 rounded-lg py-1.5 text-[12px] font-medium transition",
                  notesView === "smart" ? "bg-panel text-accent shadow-sm" : "text-ink2 hover:text-ink"
                )}
              >
                智能笔记 {smartCount}
              </button>
              <button
                onClick={() => setNotesView("mine")}
                className={cn(
                  "flex-1 rounded-lg py-1.5 text-[12px] font-medium transition",
                  notesView === "mine" ? "bg-panel text-accent shadow-sm" : "text-ink2 hover:text-ink"
                )}
              >
                我的笔记 {publicNotes.length}
              </button>
            </div>
            {notesView === "smart" && outputs.length > 0 && (
              <p className="mt-1.5 text-[11px] text-muted">点开即看即听 · 猿笔记出品</p>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-1">
            {notesView === "smart" ? (
              <>
            {/* 订阅动态条:全部真实数字。更新频率只计非回填条目 —— 回填的历史文章
                不冒充更新节奏;回填期显示「—」而不是一个漂亮的假数。
                全零(新频道)整条不显示:一排 0 和 — 比没有更寒碜。 */}
            {isFeed &&
              ((notebook.feed?.subscriber_count ?? 0) > 0 ||
                (notebook.feed?.last_content_at ?? 0) > 0 ||
                (notebook.feed?.fresh_28d ?? 0) > 0) && (
              <div className="mb-2 flex rounded-xl border border-edge bg-panel2/60 px-4 py-2.5 text-center">
                <div className="flex-1">
                  <div className="text-[14.5px] font-bold tabular-nums text-ink">{notebook.feed?.subscriber_count ?? 0}</div>
                  <div className="mt-px text-[10.5px] text-muted">订阅者</div>
                </div>
                <div className="flex-1 border-x border-edge">
                  <div className="text-[14.5px] font-bold text-ink">
                    {notebook.feed && notebook.feed.last_content_at > 0 ? relTime(notebook.feed.last_content_at) : "—"}
                  </div>
                  <div className="mt-px text-[10.5px] text-muted">最近更新</div>
                </div>
                <div className="flex-1">
                  <div className="text-[14.5px] font-bold tabular-nums text-ink">
                    {(notebook.feed?.fresh_28d ?? 0) > 0 ? `${Math.max(1, Math.round((notebook.feed!.fresh_28d ?? 0) / 4))} 篇/周` : "—"}
                  </div>
                  <div className="mt-px text-[10.5px] text-muted">更新频率</div>
                </div>
              </div>
            )}

            {outputs.length > 0 ? (
              <ul ref={smartListRef} className="space-y-0.5">
                {sortedOutputs.map((o) => {
                  const v = outputVisual(o.kind);
                  return (
                    <StudioRow
                      key={o.id}
                      icon={
                        <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl", v.tint)}>
                          {o.kind === "audio" ? (
                            <EqualizerIcon size={19} className={v.iconText} animated={audioPlaying && playingAudio?.id === o.id} />
                          ) : (
                            <v.Icon width={20} height={20} className={v.iconText} />
                          )}
                        </span>
                      }
                      title={o.title}
                      // 类型标签前置(NotebookLM 富元数据行:「详细说明 · 71 个来源 · 93 天前」);
                      // outputSubtitle 兜底态本身就是类型名时不重复拼接。
                      subtitle={(() => {
                        const label = KIND_LABEL[o.kind] ?? "";
                        const sub = outputSubtitle(o);
                        return label && sub !== label ? `${label} · ${sub}` : sub;
                      })()}
                      playable={o.kind === "audio"}
                      active={o.kind === "audio" && playingAudio?.id === o.id}
                      onOpen={() => (o.kind === "audio" ? setPlayingAudio(o) : setOpenOutput(o))}
                    />
                  );
                })}
              </ul>
            ) : null}

            {/* 期刊流:每期简报按期排列(最新在上),卡内直接读全文(简报本就短)。 */}
            {briefs.length > 0 && (
              <ul className={cn("space-y-2", outputs.length > 0 && "mt-3")}>
                {briefs.map((b) => (
                  <li key={b.id} className="rounded-xl border border-edge bg-panel px-3.5 py-3">
                    <div className="text-[10.5px] font-semibold tracking-wide text-accent">{fmtDate(b.created_at)}</div>
                    <div className="mt-0.5 text-[13.5px] font-semibold leading-snug text-ink">{b.title}</div>
                    <div className="mt-1.5 text-[12.5px] leading-relaxed text-ink2 [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_li+li]:mt-1 [&_ol]:mt-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_p+p]:mt-1.5 [&_ul]:mt-1 [&_ul]:list-disc [&_ul]:pl-4">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          a: ({ node: _node, ...props }) => (
                            <a {...props} target="_blank" rel="noopener noreferrer" />
                          ),
                        }}
                      >
                        {b.content}
                      </ReactMarkdown>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {outputs.length === 0 && briefs.length === 0 && (
              // 自动更新频道:空态做预期管理(诚实性⑦)—— 说清这里将来会出现什么、
              // 以及为什么现在是空的(首批历史内容有意不生成简报,不是坏了)。
              isFeed ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-sm font-medium text-ink">每期更新简报会出现在这里</p>
                  <p className="mx-auto mt-1.5 max-w-[230px] text-xs leading-5 text-muted">
                    该频道有新文章入库时,自动生成一期「本期新增」简报;首批收录的历史文章不生成简报。订阅后更新会通过站内消息提醒你。
                  </p>
                </div>
              ) : (
                <p className="px-1 py-10 text-center text-sm text-muted">本笔记本暂无智能笔记</p>
              )
            )}
              </>
            ) : publicNotes.length > 0 ? (
              <ul className="space-y-0.5">
                {publicNotes.map((n) => (
                  <StudioRow
                    key={n.id}
                    icon={
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accentSoft text-accent">
                        <TextIcon width={19} height={19} />
                      </span>
                    }
                    title={n.title}
                    subtitle={`笔记 · ${relTime(n.created_at)}`}
                    onOpen={() => setOpenNote(n)}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-1 py-10 text-center text-sm text-muted">本笔记本暂无公开笔记</p>
            )}
          </div>
          {playingAudio && (
            <AudioDockPlayer
              key={playingAudio.id}
              output={playingAudio}
              onClose={() => {
                setPlayingAudio(null);
                setAudioPlaying(false);
              }}
              onPlayingChange={setAudioPlaying}
            />
          )}
        </aside>
      </div>

      {/* 手机端底部三段 tab(导览 / 来源 / 亮点)—— 桌面端隐藏 */}
      <nav
        className="flex shrink-0 border-t border-edge bg-panel lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {(
          [
            ["chat", "导览"],
            ["sources", "来源"],
            ["studio", "亮点"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMobileTab(key)}
            className={cn(
              "flex-1 py-3 text-sm font-medium transition",
              mobileTab === key ? "text-accent" : "text-ink2 hover:text-ink"
            )}
            aria-current={mobileTab === key ? "page" : undefined}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* artifact viewers (read-only: no save/delete handlers) */}
      {openOutput &&
        (openOutput.kind === "drawviso" ? (
          <DrawvisoView output={openOutput} onClose={() => setOpenOutput(null)} />
        ) : openOutput.kind === "mindmap" ? (
          <MindMapView output={openOutput} onClose={() => setOpenOutput(null)} editable={false} />
        ) : openOutput.kind === "video" ? (
          <VideoPlayer output={openOutput} onClose={() => setOpenOutput(null)} />
        ) : openOutput.kind === "flashcards" ? (
          <FlashcardsView output={openOutput} onClose={() => setOpenOutput(null)} />
        ) : openOutput.kind === "quiz" ? (
          <QuizView output={openOutput} onClose={() => setOpenOutput(null)} />
        ) : openOutput.kind === "infographic" ? (
          <InfographicView output={openOutput} onClose={() => setOpenOutput(null)} />
        ) : openOutput.kind === "xhs" ? (
          <XhsCardsView output={openOutput} onClose={() => setOpenOutput(null)} />
        ) : openOutput.kind === "slides" ? (
          <SlidesView output={openOutput} onClose={() => setOpenOutput(null)} />
        ) : openOutput.kind === "table" ? (
          <TableSheetView output={openOutput} onClose={() => setOpenOutput(null)} editable={false} />
        ) : (
          <DocViewer output={openOutput} onClose={() => setOpenOutput(null)} />
        ))}

      {openNote && <PublicNoteViewer note={openNote} onClose={() => setOpenNote(null)} />}

      {/* 只读来源抽屉(引用定位) */}
      {viewer && (
        <PublicSourceViewer
          key={`${viewer.sourceId}:${viewer.chunkIndex ?? "legacy"}:${viewer.sourceStart ?? viewer.snippet ?? ""}`}
          notebookId={id}
          target={viewer}
          onClose={() => setViewer(null)}
        />
      )}
      <Toaster />
    </div>
  );
}
