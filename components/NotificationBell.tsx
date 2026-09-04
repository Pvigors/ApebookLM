"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type ComponentType } from "react";
import { MENU_PANEL } from "@/components/StyledSelect";
import { AudioIcon, VideoIcon, MindMapIcon, CardsIcon, QuizIcon, PresentIcon, TableIcon, BoardIcon, CadIcon, FileIcon } from "@/components/Icons";
import { KIND_LABEL } from "@/components/studio-shared";
import type { Notification } from "@/lib/types";

// 通知图标外壳:统一 24 视图 + 线性描边(currentColor 由瓷贴的 text-* 驱动)。
const Ico = ({ size = 15, children }: { size?: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
// Tabler「经典铃铛」字形:顶部小钮 + 钟体 + 摆锤(双路径)。
const BellIcon = ({ size = 19 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6" />
    <path d="M9 17v1a3 3 0 0 0 6 0v-1" />
  </svg>
);
// 消息类型图标 —— N06「几何极简」同族:单一线性语言,统一主色(currentColor=accent),
// 中性淡紫瓷贴。六类各具明确语义,互不撞车:
//   generation 文档+星火 / collab 人像+加号 / referral 礼盒丝带 /
//   quota 见底沙漏 / feedback 气泡+勾 / system 喇叭公告。
const GLYPH: Record<string, ReactNode> = {
  generation: (
    <>
      <path d="M6 3.2h7l5 5v9.6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5.2a2 2 0 0 1 2-2Z" />
      <path d="M12.6 3.4v5h5" />
      <path d="M9.4 14.2l.85 1.9 1.95.25-1.45 1.35.36 1.95-1.71-1-1.71 1 .36-1.95-1.45-1.35 1.95-.25Z" />
    </>
  ),
  collab: (
    <>
      <circle cx="9.2" cy="8.4" r="3.3" />
      <path d="M3.6 19.4a5.6 5.6 0 0 1 11.2 0" />
      <path d="M18.6 8v5.2" />
      <path d="M16 10.6h5.2" />
    </>
  ),
  referral: (
    <>
      <path d="M4.6 11h14.8v7.6a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4Z" />
      <path d="M3.4 8.2h17.2v2.8H3.4Z" />
      <path d="M12 8.2v11.8" />
      <path d="M12 8.2C10.7 8.2 8.4 8 8.4 6.1S10.1 3.8 12 8.2Z" />
      <path d="M12 8.2C13.3 8.2 15.6 8 15.6 6.1S13.9 3.8 12 8.2Z" />
    </>
  ),
  quota: (
    <>
      <path d="M6.5 3.6h11" />
      <path d="M6.5 20.4h11" />
      <path d="M7 3.6c0 4 4.6 5.2 5 8.4.4-3.2 5-4.4 5-8.4" />
      <path d="M7 20.4c0-4 4.6-5.2 5-8.4.4 3.2 5 4.4 5 8.4" />
      <path d="M9 18.4h6" />
    </>
  ),
  feedback: (
    <>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4.4 3.4a.5.5 0 0 1-.8-.4V16H6a2 2 0 0 1-2-2Z" />
      <path d="M8.6 10 11 12.4l4.4-4.6" />
    </>
  ),
  system: (
    <>
      <path d="M4 10v4a1 1 0 0 0 1 1h2.4L14 19V5L7.4 9H5a1 1 0 0 0-1 1Z" />
      <path d="M14 5l4.4-1.4v16.8L14 19" />
      <path d="M7.6 15.2 8.8 20" />
    </>
  ),
};

// 小红书卡组图标(Icons.tsx 无此款,与 Studio 磁贴同款竖版叠卡,本地定义避免拖 Studio 包)。
const XhsIcon = ({ width = 16, height = 16 }: { width?: number; height?: number }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="4" y="6" width="11.5" height="15" rx="2" />
    <path d="M8.5 3h9.5a2 2 0 0 1 2 2v11.5" />
    <path d="M7.5 12.5h4.5M7.5 16h3" />
  </svg>
);
type IconC = ComponentType<{ width?: number; height?: number }>;
// 制品 kind → 图标 + 主界面同款 art-* 配色瓷贴(与 Studio.tsx outputVisual 口径一致),
// 让「XX 已生成」通知按类型各具其形,不再一水儿的文档图标。报告类/未知回落到文档瓷贴。
const KIND_VIS: Record<string, { tint: string; fg: string; Icon: IconC }> = {
  audio: { tint: "bg-art-audio/10", fg: "text-art-audio", Icon: AudioIcon },
  video: { tint: "bg-art-video/10", fg: "text-art-video", Icon: VideoIcon },
  mindmap: { tint: "bg-art-mindmap/10", fg: "text-art-mindmap", Icon: MindMapIcon },
  flashcards: { tint: "bg-art-cards/10", fg: "text-art-cards", Icon: CardsIcon },
  quiz: { tint: "bg-art-quiz/10", fg: "text-art-quiz", Icon: QuizIcon },
  slides: { tint: "bg-art-slides/10", fg: "text-art-slides", Icon: PresentIcon },
  table: { tint: "bg-art-table/10", fg: "text-art-table", Icon: TableIcon },
  excalidraw: { tint: "bg-art-board/10", fg: "text-art-board", Icon: BoardIcon },
  drawviso: { tint: "bg-art-table/10", fg: "text-art-table", Icon: BoardIcon },
  xhs: { tint: "bg-art-info/10", fg: "text-art-info", Icon: XhsIcon },
  cad: { tint: "bg-accentSoft", fg: "text-accent", Icon: CadIcon },
};
const REPORT_VIS = { tint: "bg-art-report/10", fg: "text-art-report", Icon: FileIcon as IconC };
// 生成类通知没有独立 kind 字段,从标题里匹配 KIND_LABEL 反推(job.title = 制品显示名)。
const matchKind = (title: string): string | null => {
  for (const [k, label] of Object.entries(KIND_LABEL)) if (title.includes(label)) return k;
  return null;
};

// 相对时间统一到 lib/relative-time(此前 NotificationBell 用 7 天阈值 + zh-CN 日期,
// 与其它组件不一致 —— 同一时间戳在铃铛下拉里和列表里显示不同)。
import { relTime } from "@/lib/relative-time";

/** 消息中心:铃铛 + 未读红点 + 下拉(类型着色 + 摘要双行)。 */
export default function NotificationBell({ onOpen }: { onOpen?: (notebookId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    fetch("/api/notifications")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setItems(d.notifications || []);
        setUnread(d.unread || 0);
      })
      .catch(() => {});
  }, []);

  // 进场拉一次 + 每 90s 轮询未读(单进程内存通知,够用)。
  useEffect(() => {
    load();
    const t = setInterval(load, 90_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    load();
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, load]);

  const markAllRead = async () => {
    if (unread === 0) return;
    setItems((p) => p.map((n) => ({ ...n, read: 1 })));
    setUnread(0);
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => {});
  };

  const clickItem = (n: Notification) => {
    if (!n.read) {
      setItems((p) => p.map((x) => (x.id === n.id ? { ...x, read: 1 } : x)));
      setUnread((u) => Math.max(0, u - 1));
      fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [n.id] }),
      }).catch(() => {});
    }
    setOpen(false);
    if (n.link && onOpen) onOpen(n.link);
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="消息"
        aria-label={unread > 0 ? `消息(${unread} 条未读)` : "消息"}
        className="relative grid h-9 w-9 place-items-center rounded-[11px] border border-edge bg-panel text-ink2 transition hover:border-accent/50 hover:text-accent"
      >
        <BellIcon size={19} />
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-canvas bg-red-500 px-1 text-[11px] font-medium leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div role="menu" className={`absolute right-0 top-[calc(100%+8px)] z-50 w-[340px] overflow-hidden ${MENU_PANEL}`}>
          <div className="flex items-center gap-2 px-4 pb-2.5 pt-3">
            <span className="text-ink2"><BellIcon size={17} /></span>
            <span className="text-[15px] font-medium text-ink">消息中心</span>
            <button
              onClick={markAllRead}
              className={`ml-auto text-[12px] transition ${unread > 0 ? "text-accent hover:underline" : "cursor-default text-muted"}`}
            >
              全部已读
            </button>
          </div>

          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-muted">
              <span className="mb-2 inline-block text-ink2/60"><BellIcon size={28} /></span>
              <p>暂无消息</p>
              <p className="mt-1 text-[12px]">生成完成、协作邀请会在这里提醒你</p>
            </div>
          ) : (
            <div className="max-h-[min(60vh,420px)] overflow-y-auto">
              {items.map((n) => {
                // 生成类:按制品 kind 取图标 + art-* 配色;其余按通知类型用几何 glyph + 中性瓷贴。
                const kind = n.type === "generation" ? matchKind(n.title) : null;
                const kv = n.type === "generation" ? KIND_VIS[kind ?? ""] ?? REPORT_VIS : null;
                return (
                  <button
                    key={n.id}
                    onClick={() => clickItem(n)}
                    className="flex w-full items-start gap-2.5 border-b border-edge/50 px-3.5 py-2.5 text-left transition last:border-b-0 hover:bg-panel2/50"
                  >
                    {kv ? (
                      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ring-1 ring-inset ring-black/5 ${kv.tint} ${kv.fg}`}>
                        <kv.Icon width={16} height={16} />
                      </span>
                    ) : (
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-panel2 text-accent ring-1 ring-inset ring-accent/15">
                        <Ico size={15}>{GLYPH[n.type] ?? GLYPH.system}</Ico>
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      {/* 时间靠右与标题首行对齐(方案3:省一行、更矮好扫) */}
                      <span className="flex items-baseline gap-2">
                        <span className={`min-w-0 flex-1 text-[13px] leading-snug text-ink ${n.read ? "" : "font-medium"}`}>{n.title}</span>
                        <span className="shrink-0 text-[11px] text-muted">{relTime(n.created_at)}</span>
                      </span>
                      {n.summary && <span className="mt-0.5 block truncate text-[12px] text-muted">{n.summary}</span>}
                    </span>
                    {/* 未读:右侧小紫点(去掉整块淡紫底,更清爽) */}
                    {!n.read && <span className="mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full bg-accent" aria-hidden />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
