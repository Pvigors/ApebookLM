// DateNode — a Lexical DecoratorNode that renders an inline date "pill" which,
// when clicked, opens a calendar popover (month/year navigation, weekday header,
// day grid with today-highlight + accent-filled selection, optional time input).
// 1:1-aligned with the lexical playground's date concept, styled with this
// project's Tailwind tokens. The date is stored as an ISO string and round-trips
// losslessly through Lexical JSON (exportJSON / importJSON).
//
// NOTE: no "use client" here — this module is imported by a 'use client' editor
// component, so the decorate() React tree (which uses hooks) runs client-side.

import {
  $getNodeByKey,
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JSX } from "react";

// ---------------------------------------------------------------------------
// Date helpers (locale-aware, no external deps)
// ---------------------------------------------------------------------------

const ZH = "zh-CN";

/** Whether a stored value is a usable date; falls back to "now" otherwise. */
function safeDate(iso: string | null | undefined): Date {
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Pill label, e.g. "2026年6月21日 周日". */
function formatPill(d: Date): string {
  try {
    return new Intl.DateTimeFormat(ZH, {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(d);
  } catch {
    return d.toDateString();
  }
}

/** Localized month + year header, e.g. "2026年6月". */
function formatMonthYear(d: Date): string {
  try {
    return new Intl.DateTimeFormat(ZH, { year: "numeric", month: "long" }).format(d);
  } catch {
    return `${d.getFullYear()}-${d.getMonth() + 1}`;
  }
}

/** Localized short weekday names, Sunday-first, e.g. ["日","一",...]. */
function weekdayLabels(): string[] {
  const fmt = new Intl.DateTimeFormat(ZH, { weekday: "narrow" });
  // 2023-01-01 was a Sunday — anchor on it to get a stable Sun..Sat order.
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(2023, 0, 1 + i)),
  );
}

/** Localized full month names for the month <select>. */
function monthLabels(): string[] {
  const fmt = new Intl.DateTimeFormat(ZH, { month: "long" });
  return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2020, i, 1)));
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "HH:mm" for the <input type="time">. */
function timeValue(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Build the 6-row (42-cell) calendar grid for the month containing `view`.
 * Cells outside the active month are flagged so they render muted.
 */
interface GridCell {
  date: Date;
  inMonth: boolean;
}
function buildGrid(view: Date): GridCell[] {
  const year = view.getFullYear();
  const month = view.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = first.getDay(); // 0 = Sunday
  const gridStart = new Date(year, month, 1 - startOffset);
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    );
    return { date, inMonth: date.getMonth() === month };
  });
}

// ---------------------------------------------------------------------------
// Calendar popover (React) used by decorate()
// ---------------------------------------------------------------------------

interface CalendarPopoverProps {
  value: Date;
  showTime: boolean;
  onSelect: (next: Date) => void;
  onClose: () => void;
  anchorRect: DOMRect;
}

function CalendarPopover({
  value,
  showTime,
  onSelect,
  onClose,
  anchorRect,
}: CalendarPopoverProps): JSX.Element {
  const popRef = useRef<HTMLDivElement | null>(null);
  // The month currently shown in the grid (independent of the selected value).
  const [view, setView] = useState<Date>(() => new Date(value.getFullYear(), value.getMonth(), 1));
  const [time, setTime] = useState<string>(() => timeValue(value));

  const today = useMemo(() => startOfDay(new Date()), []);
  const weekdays = useMemo(() => weekdayLabels(), []);
  const months = useMemo(() => monthLabels(), []);
  const cells = useMemo(() => buildGrid(view), [view]);

  // Year range for the year <select>: ±10 around the viewed year.
  const years = useMemo(() => {
    const base = view.getFullYear();
    return Array.from({ length: 21 }, (_, i) => base - 10 + i);
  }, [view]);

  // Close on outside click / Escape.
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // Position the fixed popover under the pill, clamped to the viewport.
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: anchorRect.bottom + 6,
    left: anchorRect.left,
  });
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    let left = anchorRect.left;
    let top = anchorRect.bottom + 6;
    if (left + w > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - margin - w);
    }
    if (top + h > window.innerHeight - margin) {
      // Flip above the pill if there isn't room below.
      top = Math.max(margin, anchorRect.top - 6 - h);
    }
    setPos({ top, left });
  }, [anchorRect, view, showTime]);

  const applyTime = useCallback(
    (base: Date): Date => {
      if (!showTime) return base;
      const [hh, mm] = time.split(":");
      const next = new Date(base);
      next.setHours(Number(hh) || 0, Number(mm) || 0, 0, 0);
      return next;
    },
    [showTime, time],
  );

  const stepMonth = useCallback((delta: number) => {
    setView((v) => new Date(v.getFullYear(), v.getMonth() + delta, 1));
  }, []);

  const selectDay = useCallback(
    (cell: GridCell) => {
      onSelect(applyTime(cell.date));
      onClose();
    },
    [applyTime, onSelect, onClose],
  );

  const selectToday = useCallback(() => {
    onSelect(applyTime(new Date()));
    onClose();
  }, [applyTime, onSelect, onClose]);

  return (
    <div
      ref={popRef}
      role="dialog"
      aria-label="选择日期"
      className="elev-soft fixed z-50 w-[272px] select-none rounded-xl border border-edge bg-panel p-3 text-ink"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header: prev arrow · month select · year select · next arrow */}
      <div className="mb-2 flex items-center gap-1">
        <button
          type="button"
          aria-label="上个月"
          onClick={() => stepMonth(-1)}
          className="grid h-7 w-7 place-items-center rounded-lg text-ink2 transition hover:bg-panel2 hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="flex flex-1 items-center justify-center gap-1.5">
          <select
            name="month"
            autoComplete="off"
            aria-label="月份"
            value={view.getMonth()}
            onChange={(e) =>
              setView((v) => new Date(v.getFullYear(), Number(e.target.value), 1))
            }
            className="cursor-pointer rounded-lg border border-edge bg-panel px-1.5 py-1 text-[13px] font-medium text-ink outline-none transition hover:bg-panel2 focus:border-accent focus:ring-1 focus:ring-accent"
          >
            {months.map((m, i) => (
              <option key={m} value={i}>
                {m}
              </option>
            ))}
          </select>
          <select
            name="year"
            autoComplete="off"
            aria-label="年份"
            value={view.getFullYear()}
            onChange={(e) =>
              setView((v) => new Date(Number(e.target.value), v.getMonth(), 1))
            }
            className="cursor-pointer rounded-lg border border-edge bg-panel px-1.5 py-1 text-[13px] font-medium text-ink outline-none transition hover:bg-panel2 focus:border-accent focus:ring-1 focus:ring-accent"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          aria-label="下个月"
          onClick={() => stepMonth(1)}
          className="grid h-7 w-7 place-items-center rounded-lg text-ink2 transition hover:bg-panel2 hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Weekday header */}
      <div className="mb-1 grid grid-cols-7 gap-0.5">
        {weekdays.map((w, i) => (
          <div
            key={`${w}-${i}`}
            className="grid h-7 place-items-center text-[11px] font-medium text-muted"
          >
            {w}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((cell) => {
          const isSelected = sameDay(cell.date, value);
          const isToday = sameDay(cell.date, today);
          return (
            <button
              key={cell.date.toISOString()}
              type="button"
              onClick={() => selectDay(cell)}
              aria-pressed={isSelected}
              aria-current={isToday ? "date" : undefined}
              className={[
                "grid h-8 w-8 place-items-center rounded-lg text-[13px] transition",
                isSelected
                  ? "bg-accent font-semibold text-onAccent hover:bg-accent"
                  : isToday
                    ? "bg-accentSoft font-semibold text-accent hover:bg-accentSoft"
                    : cell.inMonth
                      ? "text-ink hover:bg-panel2"
                      : "text-muted hover:bg-panel2",
              ].join(" ")}
            >
              {cell.date.getDate()}
            </button>
          );
        })}
      </div>

      {/* Optional time input */}
      {showTime ? (
        <div className="mt-2.5 flex items-center gap-2 border-t border-edge pt-2.5">
          <span className="text-[12px] text-ink2">时间</span>
          <input
            name="time"
            autoComplete="off"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="flex-1 rounded-lg border border-edge bg-panel px-2 py-1 text-[13px] text-ink outline-none transition focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
      ) : null}

      {/* Footer: quick "today" */}
      <div className="mt-2.5 flex items-center justify-between border-t border-edge pt-2.5">
        <button
          type="button"
          onClick={selectToday}
          className="rounded-lg px-2 py-1 text-[12px] font-medium text-accent transition hover:bg-accentSoft"
        >
          今天
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-[12px] text-ink2 transition hover:bg-panel2 hover:text-ink"
        >
          取消
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline pill component rendered by decorate()
// ---------------------------------------------------------------------------

interface DatePillProps {
  nodeKey: NodeKey;
  iso: string;
  showTime: boolean;
}

function DateComponent({ nodeKey, iso, showTime }: DatePillProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const editable = editor.isEditable();

  const value = useMemo(() => safeDate(iso), [iso]);
  const label = useMemo(() => {
    const base = formatPill(value);
    return showTime ? `${base} ${timeValue(value)}` : base;
  }, [value, showTime]);

  const togglePopover = useCallback(() => {
    if (!editable) return;
    if (pillRef.current) setAnchorRect(pillRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  }, [editable]);

  const handleSelect = useCallback(
    (next: Date) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isDateNode(node)) node.setDate(next.toISOString());
      });
    },
    [editor, nodeKey],
  );

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        onClick={togglePopover}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={editable ? "点击修改日期" : label}
        className={[
          "mx-0.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 align-baseline text-[13px] font-medium transition",
          open
            ? "bg-accentSoft text-accent ring-1 ring-accent"
            : "bg-panel2 text-ink2 hover:bg-accentSoft hover:text-accent",
          editable ? "cursor-pointer" : "cursor-default",
        ].join(" ")}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
          <rect x="3" y="4.5" width="18" height="17" rx="2.5" />
          <path d="M3 9h18M8 2.5v4M16 2.5v4" strokeLinecap="round" />
        </svg>
        <span>{label}</span>
      </button>
      {open && anchorRect ? (
        <CalendarPopover
          value={value}
          showTime={showTime}
          anchorRect={anchorRect}
          onSelect={handleSelect}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Serialized shape
// ---------------------------------------------------------------------------

export type SerializedDateNode = Spread<
  {
    date: string;
    showTime: boolean;
  },
  SerializedLexicalNode
>;

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

export class DateNode extends DecoratorNode<JSX.Element> {
  /** ISO 8601 string (e.g. "2026-06-21T00:00:00.000Z"). */
  __date: string;
  /** Whether the time portion is shown / editable. */
  __showTime: boolean;

  static getType(): string {
    return "date";
  }

  static clone(node: DateNode): DateNode {
    return new DateNode(node.__date, node.__showTime, node.__key);
  }

  static importJSON(serialized: SerializedDateNode): DateNode {
    return $createDateNode(
      serialized.date,
      serialized.showTime ?? false,
    ).updateFromJSON(serialized);
  }

  static importDOM(): DOMConversionMap | null {
    return {
      time: () => ({
        conversion: convertTimeElement,
        priority: 1,
      }),
    };
  }

  constructor(date?: string, showTime = false, key?: NodeKey) {
    super(key);
    this.__date = date ?? new Date().toISOString();
    this.__showTime = showTime;
  }

  exportJSON(): SerializedDateNode {
    return {
      ...super.exportJSON(),
      type: "date",
      version: 1,
      date: this.__date,
      showTime: this.__showTime,
    };
  }

  exportDOM(): DOMExportOutput {
    const el = document.createElement("time");
    el.setAttribute("datetime", this.__date);
    el.setAttribute("data-lexical-date", "true");
    if (this.__showTime) el.setAttribute("data-show-time", "true");
    el.textContent = formatPill(safeDate(this.__date));
    return { element: el };
  }

  // ---- DOM lifecycle (inline host element) --------------------------------

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    const cls = config.theme?.date;
    if (typeof cls === "string") span.className = cls;
    span.style.display = "inline";
    span.setAttribute("data-lexical-date", "true");
    return span;
  }

  updateDOM(): false {
    return false;
  }

  // Inline node: it lives within a paragraph alongside text.
  isInline(): true {
    return true;
  }

  // ---- mutators -----------------------------------------------------------

  setDate(iso: string): void {
    const self = this.getWritable();
    self.__date = iso;
  }

  getDate(): string {
    return this.getLatest().__date;
  }

  setShowTime(show: boolean): void {
    const self = this.getWritable();
    self.__showTime = show;
  }

  getShowTime(): boolean {
    return this.getLatest().__showTime;
  }

  /** Plain-text representation, e.g. for copy/paste & markdown export. */
  getTextContent(): string {
    return formatPill(safeDate(this.__date));
  }

  // ---- render -------------------------------------------------------------

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return (
      <DateComponent
        nodeKey={this.getKey()}
        iso={this.__date}
        showTime={this.__showTime}
      />
    );
  }
}

// ---------------------------------------------------------------------------
// DOM import conversion (paste of a <time datetime="..."> element)
// ---------------------------------------------------------------------------

function convertTimeElement(domNode: HTMLElement): DOMConversionOutput | null {
  if (!domNode.hasAttribute("data-lexical-date")) return null;
  const iso = domNode.getAttribute("datetime");
  if (!iso) return null;
  const showTime = domNode.getAttribute("data-show-time") === "true";
  return { node: $createDateNode(iso, showTime) };
}

// ---------------------------------------------------------------------------
// Helpers (exported)
// ---------------------------------------------------------------------------

/** Create a DateNode. `date` accepts an ISO string or Date; defaults to now. */
export function $createDateNode(
  date?: string | Date,
  showTime = false,
): DateNode {
  const iso =
    date instanceof Date
      ? date.toISOString()
      : (date ?? new Date().toISOString());
  return new DateNode(iso, showTime);
}

export function $isDateNode(
  node: LexicalNode | null | undefined,
): node is DateNode {
  return node instanceof DateNode;
}
