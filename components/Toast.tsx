"use client";

import { useEffect, useState } from "react";

const cn = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

export type ToastKind = "success" | "error";

let emit: ((msg: string, kind: ToastKind) => void) | null = null;

/** Show a brief center toast, NotebookLM-style. 默认 success(✓);error 红 ✗ 且展示更久。 */
export function toast(msg: string, kind: ToastKind = "success") {
  emit?.(msg, kind);
}

export function Toaster() {
  const [msg, setMsg] = useState<string | null>(null);
  const [kind, setKind] = useState<ToastKind>("success");
  const [shown, setShown] = useState(false);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    emit = (m: string, k: ToastKind) => {
      setMsg(m);
      setKind(k);
      setShown(true);
      if (hideTimer) clearTimeout(hideTimer);
      if (clearTimer) clearTimeout(clearTimer);
      // 长错误必须有足够阅读时间；成功提示仍保持轻快。
      const dur = k === "error"
        ? Math.min(8000, Math.max(4500, m.length * 65))
        : 1800;
      hideTimer = setTimeout(() => setShown(false), dur);
      clearTimer = setTimeout(() => setMsg(null), dur + 300);
    };
    return () => {
      emit = null;
      if (hideTimer) clearTimeout(hideTimer);
      if (clearTimer) clearTimeout(clearTimer);
    };
  }, []);

  if (!msg) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center">
      <div
        role={kind === "error" ? "alert" : "status"}
        aria-live={kind === "error" ? "assertive" : "polite"}
        aria-atomic="true"
        className={cn(
          "flex max-h-[min(70vh,360px)] max-w-[min(92vw,560px)] flex-col items-center gap-2 overflow-y-auto rounded-2xl bg-solid/90 px-7 py-5 text-onSolid shadow-2xl backdrop-blur-sm transition-all duration-200",
          shown ? "scale-100 opacity-100" : "scale-95 opacity-0"
        )}
      >
        <svg
          className={kind === "error" ? "text-red-400" : undefined}
          width="30"
          height="30"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {kind === "error" ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M20 6 9 17l-5-5" />}
        </svg>
        <span className="break-words text-center text-sm leading-relaxed">{msg}</span>
      </div>
    </div>
  );
}
