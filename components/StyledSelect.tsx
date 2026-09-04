"use client";

import { useEffect, useRef, useState } from "react";

const cn = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

export type SelectOption = { value: string; label: string };

// —— 全站下拉菜单统一样式(StyledSelect 及所有 ⋮/动作/选择菜单复用,防漂移)——
// 面板:定位/宽度由调用方拼,这里只管观感(圆角/描边/底色/内距/软阴影/弹入)。
// 列表项:行内置 rounded,hover 用浅灰;危险项红字;选中项主色描边。
export const MENU_PANEL =
  "animate-popin rounded-2xl border border-edge bg-panel p-1.5 shadow-[0_16px_40px_-12px_rgba(20,22,40,0.22)]";
export const MENU_ITEM =
  "flex w-full items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-left text-sm text-ink transition hover:bg-panel2";
export const MENU_ITEM_DANGER =
  "flex w-full items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-left text-sm text-red-500 transition hover:bg-red-500/8";
export const MENU_SELECTED = "font-semibold text-accent ring-2 ring-inset ring-accent";

/**
 * 统一的下拉选择器(NotebookLM 风):胶囊触发 + 圆角浮层,选中项用主色描边框。
 * 替代原生 <select>。compact(默认)用于工具栏小下拉;传 `triggerClassName="w-full"`
 * 得到表单里的整宽下拉(浮层同宽、可滚动)。点外部 / Esc 关闭。
 */
export function StyledSelect({
  value,
  onChange,
  options,
  triggerClassName,
  menuAlign = "right",
  placeholder = "请选择",
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  triggerClassName?: string;
  menuAlign?: "left" | "right";
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
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
  }, [open]);
  const current = options.find((o) => o.value === value);
  const fullWidth = !!triggerClassName?.includes("w-full");
  return (
    <div ref={ref} className={cn("relative", fullWidth && "w-full")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-full border border-edge bg-panel2 px-3.5 text-sm font-medium text-ink2 transition hover:text-ink active:scale-[0.98]",
          fullWidth && "w-full justify-between",
          triggerClassName
        )}
      >
        <span className="truncate">{current?.label ?? placeholder}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn("shrink-0 text-muted transition-transform duration-200", open && "rotate-180")}
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={cn(
            "absolute z-30 mt-2 max-h-72 overflow-auto",
            MENU_PANEL,
            menuAlign === "right" ? "right-0" : "left-0",
            fullWidth ? "w-full" : "w-44"
          )}
        >
          {options.map((o) => {
            const sel = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={sel}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={cn(
                  "block w-full truncate rounded-xl px-3.5 py-2.5 text-left text-sm transition",
                  sel ? MENU_SELECTED : "text-ink hover:bg-panel2"
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
