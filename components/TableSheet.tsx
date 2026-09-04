"use client";

/**
 * Excel 式数据表格查看器 —— 基于开源 x-data-spreadsheet(MIT,Canvas 渲染:
 * A/B/C 列头、行号、选区、单元格编辑、右键菜单、底部 Sheet 标签)。
 *
 * 数据仍以 Markdown 表格存储(分享页/存为笔记/下游完全不受影响):
 * 打开时 Markdown → 工作表(每张表一个 Sheet,表名取自表格上方的标题行),
 * 编辑后工作表 → Markdown 自动回存(700ms 防抖 + 关闭时兜底)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioOutput } from "@/lib/types";
import { toast } from "@/components/Toast";
import { CloseIcon, SaveIcon, ShareIcon, SpinnerIcon, TrashIcon } from "@/components/Icons";
import { exportTablesToExcel } from "@/components/Studio";
import {
  encodeMarkdownTableName,
  escapeMarkdownTableCell,
  parseMarkdownTables,
} from "@/lib/markdown-table";
import {
  sanitizeSpreadsheetCellText,
  sanitizeSpreadsheetEditorInput,
  spreadsheetPatchFitsKeepalive,
} from "@/lib/spreadsheet-cell";
import "x-data-spreadsheet/dist/xspreadsheet.css";

const cn = (...xs: Array<string | false | null | undefined>) =>
  xs.filter(Boolean).join(" ");

// ---- 最小 API 类型(dist 产物经 window.x_spreadsheet 暴露,无官方深路径类型) ----
type CellData = { text?: string; style?: number };
type RowData = { cells?: Record<string | number, CellData> };
type SheetData = {
  name?: string;
  freeze?: string;
  styles?: unknown[];
  cols?: Record<string | number, unknown>;
  rows?: Record<string | number, RowData | number>;
};
type XSheet = {
  loadData: (d: SheetData[]) => XSheet;
  getData: () => SheetData[];
  change: (cb: () => void) => XSheet;
};
type XFactory = ((el: HTMLElement, opts: Record<string, unknown>) => XSheet) & {
  locale: (lang: string, msgs?: unknown) => void;
};

// ---- Markdown 表 ↔ 工作表数据 ----

/** 估列宽:CJK 记 2 个单位,限制在 84–340px。 */
function colWidth(rows: string[][], c: number): number {
  let units = 6;
  for (const r of rows) {
    let u = 0;
    for (const ch of r[c] ?? "") u += ch.charCodeAt(0) > 255 ? 2 : 1;
    units = Math.max(units, Math.min(u, 42));
  }
  return Math.min(340, Math.max(84, Math.round(units * 8 + 22)));
}

// A generated table sometimes carries a lazy placeholder title (the model wrote
// `**表2**` instead of a real name), so the tab reads "表2" and tells the reader
// nothing. Detect those and derive a name from the table's header cells instead.
const isPlaceholderName = (n: string) =>
  !n.trim() || /^(表格?|sheet|table|第.{0,3}张?表格?)\s*\d*$/i.test(n.trim());

function deriveSheetName(t: { name: string; rows: string[][] }, i: number): string {
  const raw = (t.name || "").trim();
  if (!isPlaceholderName(raw)) return raw.slice(0, 28);
  const header = (t.rows[0] || []).map((c) => (c || "").trim()).filter(Boolean);
  return header.slice(0, 2).join(" · ").slice(0, 28).trim() || `表${i + 1}`;
}

function tablesToSheets(tables: { name: string; rows: string[][] }[]): SheetData[] {
  const used = new Set<string>();
  return tables.map((t, i) => {
    const colCount = Math.max(1, ...t.rows.map((r) => r.length));
    const rows: Record<string | number, RowData | number> = {
      len: Math.max(t.rows.length + 14, 32),
    };
    t.rows.forEach((r, ri) => {
      const cells: Record<number, CellData> = {};
      for (let ci = 0; ci < colCount; ci++) {
        const text = sanitizeSpreadsheetCellText(r[ci] ?? "");
        cells[ci] = ri === 0 ? { text, style: 0 } : { text };
      }
      rows[ri] = { cells };
    });
    const cols: Record<string | number, unknown> = { len: Math.max(colCount + 3, 8) };
    for (let ci = 0; ci < colCount; ci++) cols[ci] = { width: colWidth(t.rows, ci) };
    // 名称去重 + 非空兜底:重名/空名会被 x-spreadsheet 退回默认「sheetN」。
    // 占位名(表N/Table N…)改用表头派生名,避免「表2」这种无信息标签。
    let name = deriveSheetName(t, i).slice(0, 28).trim() || `表${i + 1}`;
    while (used.has(name)) name = `${name.slice(0, 24)} ${i + 1}`;
    used.add(name);
    return {
      name,
      freeze: "A2", // 表头行冻结,滚动时一直可见
      styles: [{ bgcolor: "#f3f3fd", font: { bold: true }, color: "#1f2024" }],
      rows,
      cols,
    };
  });
}

/** 工作表数据 → 二维数组(裁掉尾部空行/空列)。 */
function sheetToRows(d: SheetData): string[][] {
  const rd = (d.rows ?? {}) as Record<string, RowData | number>;
  const idx = Object.keys(rd)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b);
  let maxC = 0;
  for (const ri of idx) {
    const cells = (rd[ri] as RowData)?.cells ?? {};
    for (const ck of Object.keys(cells)) maxC = Math.max(maxC, Number(ck) + 1);
  }
  const out: string[][] = [];
  const maxR = idx.length ? idx[idx.length - 1] + 1 : 0;
  for (let ri = 0; ri < maxR; ri++) {
    const cells = (rd[ri] as RowData)?.cells ?? {};
    const row: string[] = [];
    for (let ci = 0; ci < maxC; ci++) row.push(sanitizeSpreadsheetCellText(cells[ci]?.text ?? ""));
    out.push(row);
  }
  while (out.length && out[out.length - 1].every((c) => c === "")) out.pop();
  let lastCol = 0;
  out.forEach((r) => r.forEach((c, i) => c !== "" && (lastCol = Math.max(lastCol, i + 1))));
  return out.map((r) => r.slice(0, Math.max(lastCol, 1)));
}

function sheetsToMarkdown(datas: SheetData[]): string {
  const esc = (s: string) => escapeMarkdownTableCell(s);
  const parts: string[] = [];
  datas.forEach((d, i) => {
    const rows = sheetToRows(d);
    if (!rows.length) return;
    const header = rows[0];
    parts.push(
      [
        encodeMarkdownTableName(d.name || `表${i + 1}`),
        "",
        `| ${header.map(esc).join(" | ")} |`,
        `| ${header.map(() => "---").join(" | ")} |`,
        ...rows.slice(1).map((r) => `| ${header.map((_, c) => esc(r[c] ?? "")).join(" | ")} |`),
      ].join("\n")
    );
  });
  return parts.join("\n\n");
}

// ---- 组件 ----

export function TableSheetView({
  output,
  onClose,
  onSaveNote,
  onDelete,
  onSaved,
  onShareNotebook,
  editable = true,
}: {
  output: StudioOutput;
  onClose: () => void;
  onSaveNote?: (title: string, content: string) => void;
  onDelete?: () => void;
  onSaved?: (content: string) => void;
  onShareNotebook?: () => void;
  editable?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<XSheet | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRef = useRef(output.content);
  const desiredRef = useRef(output.content);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [full, setFull] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const tables = parseMarkdownTables(output.content || "");
  const hasTables = tables.length > 0;

  const currentMarkdown = useCallback((): string => {
    const s = sheetRef.current;
    if (!s) return output.content;
    return sheetsToMarkdown(s.getData());
  }, [output.content]);

  const persist = useCallback(
    (md: string, keepalive = false) => {
      if (md === desiredRef.current) return;
      desiredRef.current = md;
      // 所有 PATCH 严格串行。A 先发、B 后发时，B 必须等 A 终态后才落库；卸载的
      // keepalive 最新稿也排在旧请求之后，不能被慢返回的旧 PATCH 反向覆盖。
      saveQueue.current = saveQueue.current
        .catch(() => {})
        .then(async () => {
          const body = JSON.stringify({ content: md });
          const canKeepalive = spreadsheetPatchFitsKeepalive(md);
          const r = await fetch(`/api/studio/${output.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body,
            // Fetch keepalive 有约 64KiB 全局上限；小稿在页面离开时继续，大稿走普通
            // 请求并由 beforeunload 明示阻止离开，不能用 keepalive 触发 TypeError。
            keepalive: canKeepalive,
          });
          if (!r.ok) throw new Error(`save failed:${r.status}`);
          savedRef.current = md;
          onSaved?.(md);
        })
        .catch(() => {
          if (desiredRef.current === md) desiredRef.current = savedRef.current;
          if (!keepalive) toast("自动保存失败,请检查登录状态");
        });
    },
    [output.id, onSaved]
  );

  // 挂载电子表格(仅客户端;dist 为 IIFE,导入后从 window 取工厂)
  useEffect(() => {
    if (!hasTables) return;
    let disposed = false;
    let tabStrip: HTMLElement | null = null;
    let tabControls: HTMLDivElement | null = null;
    let tabResize: ResizeObserver | null = null;
    let tabMutation: MutationObserver | null = null;
    let updateTabNav: (() => void) | null = null;
    let spreadsheetHost: HTMLElement | null = null;
    const guardLiveEditorInput = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (!target.closest(".x-spreadsheet-editor")) return;
      // 安装补丁已让第三方用 Text node；捕获层只剔除控制字符，不改写 &<> 等业务数据。
      sanitizeSpreadsheetEditorInput(target);
    };
    const wheelTabs = (event: WheelEvent) => {
      if (!tabStrip || tabStrip.scrollWidth <= tabStrip.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 28
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.max(240, tabStrip.clientWidth)
        : 1;
      const before = tabStrip.scrollLeft;
      const max = Math.max(0, tabStrip.scrollWidth - tabStrip.clientWidth);
      tabStrip.scrollLeft = Math.max(0, Math.min(max, before + event.deltaY * scale));
      // Only capture the wheel while the tab strip actually consumes it. At a
      // boundary the page/modal must remain scrollable (no mouse-wheel trap).
      if (Math.abs(tabStrip.scrollLeft - before) > 0.5) event.preventDefault();
    };
    (async () => {
      // Whole load wrapped in try/catch (see catch below) so a chunk-load /
      // factory / loadData failure degrades to the raw-text fallback instead of
      // sticking the "正在加载表格…" mask forever + an uncaught rejection.
      try {
        await import("x-data-spreadsheet/dist/xspreadsheet.js");
        const factory = (window as unknown as { x_spreadsheet?: XFactory }).x_spreadsheet;
        if (!factory || disposed || !hostRef.current) return;
        try {
          // 语言包自注册到 window.x_spreadsheet.$messages,再显式激活
          await import("x-data-spreadsheet/dist/locale/zh-cn.js");
          factory.locale("zh-cn");
        } catch {
          /* 英文兜底 */
        }
        hostRef.current.innerHTML = "";
        const host = hostRef.current;
        spreadsheetHost = host;
        if (editable) host.addEventListener("input", guardLiveEditorInput, true);
        const sheet = factory(host, {
          mode: editable ? "edit" : "read",
          showToolbar: false,
          showGrid: true,
          showContextmenu: editable,
          showBottomBar: true,
          view: {
            height: () => host.clientHeight || 420,
            width: () => host.clientWidth || 800,
          },
          row: { len: 60, height: 30 },
          col: { len: 16, width: 110, indexWidth: 46, minWidth: 56 },
        });
        sheet.loadData(tablesToSheets(parseMarkdownTables(output.content || "")));
        tabStrip = host.querySelector<HTMLElement>(".x-spreadsheet-bottombar .x-spreadsheet-menu");
        if (tabStrip) {
          tabStrip.tabIndex = 0;
          tabStrip.setAttribute("aria-label", "工作表标签，可横向滚动查看全部 Sheet");
          tabStrip.addEventListener("wheel", wheelTabs, { passive: false });
          const bar = tabStrip.closest<HTMLElement>(".x-spreadsheet-bottombar");
          if (bar) {
            const makeButton = (label: string, direction: -1 | 1) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "table-sheet-scroll-button";
              button.setAttribute("aria-label", label);
              button.title = label;
              button.textContent = direction < 0 ? "‹" : "›";
              button.addEventListener("click", () => {
                tabStrip?.scrollBy({
                  left: direction * Math.max(180, (tabStrip.clientWidth || 360) * 0.7),
                  behavior: "smooth",
                });
              });
              return button;
            };
            tabControls = document.createElement("div");
            tabControls.className = "table-sheet-scroll-controls";
            const previous = makeButton("向左查看更多 Sheet", -1);
            const next = makeButton("向右查看更多 Sheet", 1);
            tabControls.append(previous, next);
            bar.appendChild(tabControls);
            updateTabNav = () => {
              if (!tabStrip) return;
              // Compute against the width the strip would have WITHOUT the
              // 72px control reserve, otherwise the reserve itself can create
              // a self-sustaining fake overflow after a long tab is renamed.
              const reserved = bar.classList.contains("has-sheet-scroll-controls") ? 72 : 0;
              const needsControls = tabStrip.scrollWidth > tabStrip.clientWidth + reserved + 1;
              bar.classList.toggle("has-sheet-scroll-controls", needsControls);
              const max = Math.max(0, tabStrip.scrollWidth - tabStrip.clientWidth);
              previous.disabled = tabStrip.scrollLeft <= 1;
              next.disabled = tabStrip.scrollLeft >= max - 1;
              tabControls?.classList.toggle("is-hidden", !needsControls);
            };
            tabStrip.addEventListener("scroll", updateTabNav, { passive: true });
            if (typeof ResizeObserver !== "undefined") {
              tabResize = new ResizeObserver(() => updateTabNav?.());
              tabResize.observe(tabStrip);
            }
            if (typeof MutationObserver !== "undefined") {
              // Adding a Sheet or renaming a tab changes scrollWidth but not
              // the strip's border box, so ResizeObserver alone never fires.
              tabMutation = new MutationObserver(() => updateTabNav?.());
              tabMutation.observe(tabStrip, { childList: true, subtree: true, characterData: true });
            }
            updateTabNav();
          }
        }
        if (editable) {
          sheet.change(() => {
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              const s = sheetRef.current;
              if (s) persist(sheetsToMarkdown(s.getData()));
            }, 700);
          });
        }
        sheetRef.current = sheet;
        setReady(true);
      } catch (err) {
        // The dynamic chunk import (ChunkLoadError after a redeploy / flaky
        // network / CDN blip) or the x-spreadsheet factory/loadData can throw.
        // Left unhandled it's an uncaught promise rejection AND setReady(true)
        // never runs, so the "正在加载表格…" mask sticks forever and the artifact
        // can never open. Degrade: drop the mask and fall back to the raw text.
        if (disposed) return;
        console.warn("[TableSheet] spreadsheet load failed, falling back to text:", err);
        setLoadError(true);
        setReady(true);
      }
    })();
    return () => {
      disposed = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // 审查修复:卸载兜底保存必须在置 null 之前、且就在本 effect 的 cleanup 里做。
      // 原来它是一个后声明的独立 effect —— React 卸载按声明顺序跑 cleanup,轮到它时
      // sheetRef 已被这里置 null,兜底保存是死代码,关闭前 700ms 内的编辑必丢。
      const s = sheetRef.current;
      if (editable && s) persist(sheetsToMarkdown(s.getData()), true);
      tabStrip?.removeEventListener("wheel", wheelTabs);
      if (updateTabNav) tabStrip?.removeEventListener("scroll", updateTabNav);
      tabResize?.disconnect();
      tabMutation?.disconnect();
      spreadsheetHost?.removeEventListener("input", guardLiveEditorInput, true);
      tabStrip?.closest(".x-spreadsheet-bottombar")?.classList.remove("has-sheet-scroll-controls");
      tabControls?.remove();
      sheetRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output.id]);

  // 放大/还原后让画布按新尺寸重排(库内部监听 window resize)
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
    return () => clearTimeout(t);
  }, [full]);

  useEffect(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (desiredRef.current === savedRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => window.removeEventListener("beforeunload", warnUnsaved);
  }, []);

  // Esc 关闭
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

  const exportExcel = useCallback(async () => {
    if (xlsxBusy) return;
    const datas = sheetRef.current?.getData();
    const sheets = datas
      ? datas.map((d, i) => ({ name: d.name || `表${i + 1}`, rows: sheetToRows(d) })).filter((s) => s.rows.length)
      : parseMarkdownTables(output.content || "");
    if (!sheets.length) {
      toast("没有可导出的表格");
      return;
    }
    setXlsxBusy(true);
    try {
      await exportTablesToExcel(output.title || "数据表格", sheets);
    } catch {
      toast("导出 Excel 失败,请重试");
    } finally {
      setXlsxBusy(false);
    }
  }, [output.content, output.title, xlsxBusy]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          "flex w-full flex-col overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl",
          full ? "h-[94vh] max-w-[97vw]" : "h-[88vh] max-w-4xl"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部:面包屑 + 标题 + 操作 */}
        <div className="flex items-center justify-between gap-2 border-b border-edge px-5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className="truncate text-lg font-semibold leading-snug text-ink" title={output.title}>
              {output.title}
            </h2>
            {editable && (
              <span className="hidden shrink-0 text-xs text-muted sm:block">
                单元格可直接编辑 · 自动保存
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onShareNotebook && (
              <button
                onClick={onShareNotebook}
                className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent"
                title="分享"
                aria-label="分享"
              >
                <ShareIcon width={17} height={17} />
              </button>
            )}
            <button
              onClick={() => setFull((v) => !v)}
              className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent"
              title={full ? "还原" : "放大"}
              aria-label={full ? "还原" : "放大"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {full ? (
                  <>
                    <path d="M4 14h6v6" />
                    <path d="M20 10h-6V4" />
                    <path d="m14 10 7-7" />
                    <path d="m3 21 7-7" />
                  </>
                ) : (
                  <>
                    <path d="M15 3h6v6" />
                    <path d="M9 21H3v-6" />
                    <path d="m21 3-7 7" />
                    <path d="m3 21 7-7" />
                  </>
                )}
              </svg>
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-ink"
              aria-label="关闭"
            >
              <CloseIcon width={18} height={18} />
            </button>
          </div>
        </div>

        {/* 表格区 */}
        {hasTables && !loadError ? (
          <div className="relative min-h-0 flex-1 bg-white">
            {!ready && (
              <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white text-sm text-ink2">
                <SpinnerIcon width={16} height={16} /> 正在加载表格…
              </div>
            )}
            <div ref={hostRef} className="table-sheet-host h-full w-full" />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <p className="mb-3 text-sm text-muted">
              {loadError ? "表格渲染失败,已以原文显示:" : "未识别到表格结构,以原文显示:"}
            </p>
            <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink2">
              {output.content}
            </pre>
          </div>
        )}

        {/* 底部操作 */}
        <div className="flex flex-wrap items-center gap-2 border-t border-edge px-5 py-3">
          {onSaveNote && (
            <button
              onClick={() => {
                onSaveNote(output.title, currentMarkdown());
                setSaved(true);
              }}
              disabled={saved}
              className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent disabled:opacity-50"
            >
              <SaveIcon width={15} height={15} /> {saved ? "已存为笔记" : "存为笔记"}
            </button>
          )}
          {onDelete && (
            <button
              // onDelete 只是打开确认弹窗;确认后 doDeleteOutput 会自动关闭本查看器
              // (setOpenDoc(d=>d?.id===id?null:d)),这里不能抢先 onClose 打断确认流。
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-red-300 hover:text-red-600"
            >
              <TrashIcon width={15} height={15} /> 删除
            </button>
          )}
          <div className="ml-auto">
            <button
              onClick={exportExcel}
              disabled={xlsxBusy}
              title="把表格下载为 Excel 文件(.xlsx)"
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110 disabled:opacity-60"
            >
              {xlsxBusy ? (
                <SpinnerIcon width={15} height={15} />
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M3 9.5h18M9.5 4v16M15.5 4v16" />
                </svg>
              )}
              {xlsxBusy ? "导出中…" : "导出 Excel"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
