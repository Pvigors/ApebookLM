"use client";

import { useEffect, useRef, useState } from "react";

export type PromptCfg = { label: string; defaultValue?: string; placeholder?: string; resolve: (v: string | null) => void };

/** 应用内输入弹窗,替代原生 window.prompt(链接 / 表格尺寸 / 嵌入 URL 统一走它,与 playground 一致的应用内对话框)。 */
export function PromptDialog({ cfg, onClose }: { cfg: PromptCfg; onClose: () => void }) {
  const [val, setVal] = useState(cfg.defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const submit = () => {
    cfg.resolve(val.trim());
    onClose();
  };
  const cancel = () => {
    cfg.resolve(null);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[16vh]" onMouseDown={cancel}>
      <div
        className="elev-soft w-full max-w-[440px] rounded-2xl border border-edge bg-panel p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="mb-3 text-[15px] font-medium text-ink">{cfg.label}</p>
        <input
          ref={inputRef}
          name="prompt"
          autoComplete="off"
          value={val}
          placeholder={cfg.placeholder}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm text-ink outline-none transition placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={cancel} className="rounded-lg px-4 py-2 text-sm text-ink2 transition hover:bg-panel2">
            取消
          </button>
          <button onClick={submit} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110">
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** 插入表格对话框 —— Google Docs / Notion 式网格选择器:悬停选行列、点击插入,
 *  拖到边缘自动扩展可选区;支持方向键移动 + 回车确认 + Esc 关闭。
 *  上限 20 行 / 10 列,确定后由调用方 dispatch INSERT_TABLE_COMMAND。 */
const TABLE_MAX_ROWS = 20;
const TABLE_MAX_COLS = 10;
export function InsertTableDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: (rows: number, columns: number) => void;
  onClose: () => void;
}) {
  // 0-based currently-selected row / col (默认 3×3)。
  const [r, setR] = useState(2);
  const [c, setC] = useState(2);
  // 可见网格比当前选择多 1 圈,并随选择增长(上限封顶),起步 5×5。
  const gridRows = Math.min(TABLE_MAX_ROWS, Math.max(5, r + 2));
  const gridCols = Math.min(TABLE_MAX_COLS, Math.max(5, c + 2));
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    boxRef.current?.focus();
  }, []);
  const confirm = (rr: number, cc: number) => {
    onConfirm(rr + 1, cc + 1);
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[16vh]"
      onMouseDown={onClose}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-label="插入表格"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            confirm(r, c);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setC((v) => Math.min(TABLE_MAX_COLS - 1, v + 1));
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            setC((v) => Math.max(0, v - 1));
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setR((v) => Math.min(TABLE_MAX_ROWS - 1, v + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setR((v) => Math.max(0, v - 1));
          }
        }}
        className="elev-soft w-fit rounded-2xl border border-edge bg-panel p-5 outline-none"
      >
        <p className="mb-3 text-[15px] font-medium text-ink">插入表格</p>
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${gridCols}, 1.25rem)` }}
        >
          {Array.from({ length: gridRows * gridCols }).map((_, i) => {
            const cr = Math.floor(i / gridCols);
            const cc = i % gridCols;
            const on = cr <= r && cc <= c;
            return (
              <button
                key={i}
                type="button"
                aria-label={`${cr + 1} 行 ${cc + 1} 列`}
                onMouseEnter={() => {
                  setR(cr);
                  setC(cc);
                }}
                onClick={() => confirm(cr, cc)}
                className={`h-5 w-5 rounded-[3px] border transition-colors ${
                  on
                    ? "border-accent bg-[#6d5ae6]/20"
                    : "border-edge bg-panel hover:border-[#6d5ae6]/50"
                }`}
              />
            );
          })}
        </div>
        <p className="mt-3 text-center text-[13px] text-ink2">
          <b className="font-medium text-accent">{r + 1}</b> 行 ×{" "}
          <b className="font-medium text-accent">{c + 1}</b> 列
        </p>
      </div>
    </div>
  );
}
