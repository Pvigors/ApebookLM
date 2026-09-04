"use client";

import { useEffect, useState } from "react";
import type { RelatedItem, CrossRelatedItem } from "@/lib/related";

const NoteIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);
const SourceIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h4" />
  </svg>
);

/** 一张相关项卡片;crossNb 非空时额外显示「来自哪个笔记本」的归属 chip。 */
function Card({
  it,
  crossNb,
  onClick,
}: {
  it: RelatedItem;
  crossNb?: { title: string; emoji: string };
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="block w-full rounded-xl border border-edge bg-panel px-3 py-2.5 text-left transition hover:-translate-y-0.5 hover:border-accent/40"
    >
      <span className="flex items-center gap-2">
        <span
          className={
            "grid h-6 w-6 shrink-0 place-items-center rounded-lg " +
            (it.kind === "note" ? "bg-accentSoft text-accent" : "bg-panel2 text-ink2")
          }
        >
          {it.kind === "note" ? <NoteIcon /> : <SourceIcon />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-ink">{it.title}</span>
            {crossNb ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-panel2 px-1.5 py-0.5 text-[10px] text-muted">
                <span aria-hidden>{crossNb.emoji}</span>
                <span className="max-w-[84px] truncate">{crossNb.title}</span>
              </span>
            ) : (
              <span className="shrink-0 rounded-full bg-panel2 px-1.5 py-0.5 text-[10px] text-muted">
                {it.kind === "note" ? "我的笔记" : "来源"}
              </span>
            )}
          </span>
          <span className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-ink2">{it.snippet}</span>
        </span>
      </span>
    </button>
  );
}

/**
 * 「上下文内被动重新发现」面板:读某条来源 / 写某条笔记时,自动浮现
 * ① 同一笔记本里相关的其它来源/笔记;② (crossEnabled 时)你**其它笔记本**里相关的项。
 * 无需手动搜索;无结果则不占位。两段独立请求,本笔记本那段先到先渲染,跨本那段稍后补上。
 */
export function RelatedPanel({
  notebookId,
  sourceId,
  noteId,
  crossEnabled = false,
  onOpenSource,
  onOpenNote,
  onOpenCross,
}: {
  notebookId: string;
  sourceId?: string;
  noteId?: string;
  crossEnabled?: boolean;
  onOpenSource?: (id: string, title: string) => void;
  onOpenNote?: (id: string) => void;
  onOpenCross?: (notebookId: string, item: { kind: "source" | "note"; id: string; title: string }) => void;
}) {
  const [items, setItems] = useState<RelatedItem[] | null>(null);
  const [cross, setCross] = useState<CrossRelatedItem[] | null>(null);

  useEffect(() => {
    if (!notebookId || (!sourceId && !noteId)) return;
    let alive = true;
    setItems(null);
    setCross(null);
    const q = sourceId ? `sourceId=${encodeURIComponent(sourceId)}` : `noteId=${encodeURIComponent(noteId!)}`;
    // ① 本笔记本(快):先到先渲染。
    fetch(`/api/notebooks/${notebookId}/related?${q}`)
      .then((r) => r.json())
      .then((d) => alive && setItems(d.related ?? []))
      .catch(() => alive && setItems([]));
    // ② 跨笔记本(慢,需要时才请求):后到补上,不拖累 ①。
    if (crossEnabled) {
      fetch(`/api/notebooks/${notebookId}/related?${q}&cross=1`)
        .then((r) => r.json())
        .then((d) => alive && setCross(d.crossRelated ?? []))
        .catch(() => alive && setCross([]));
    }
    return () => {
      alive = false;
    };
  }, [notebookId, sourceId, noteId, crossEnabled]);

  const hasIn = !!items && items.length > 0;
  const hasCross = !!cross && cross.length > 0;
  // 加载中 / 两段都无结果都不占位(被动、克制,不打扰)。
  if (!hasIn && !hasCross) return null;

  return (
    <div className="mt-5 space-y-4 border-t border-edge pt-4">
      {hasIn && (
        <div>
          <p className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-ink2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3M11 8v6M8 11h6" />
            </svg>
            你的笔记本里相关的
          </p>
          <div className="space-y-1.5">
            {items!.map((it) => (
              <Card
                key={`${it.kind}:${it.id}`}
                it={it}
                onClick={() => (it.kind === "source" ? onOpenSource?.(it.id, it.title) : onOpenNote?.(it.id))}
              />
            ))}
          </div>
        </div>
      )}
      {hasCross && (
        <div>
          <p className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-ink2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            你其它笔记本里相关的
          </p>
          <div className="space-y-1.5">
            {cross!.map((it) => (
              <Card
                key={`${it.notebookId}:${it.kind}:${it.id}`}
                it={it}
                crossNb={{ title: it.notebookTitle, emoji: it.notebookEmoji }}
                onClick={() => onOpenCross?.(it.notebookId, { kind: it.kind, id: it.id, title: it.title })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
