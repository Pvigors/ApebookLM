"use client";

import { useCallback, useEffect, useRef } from "react";
import { LoginCard } from "@/components/LoginClient";
import { Toaster } from "@/components/Toast";

/**
 * 官网首页的登录弹窗：点顶栏账户图标 / 各处 CTA 即浮出，不跳页。
 * 卡片直接复用 LoginCard —— 与 `/login` 整页是同一份，不存在两边漂移。
 *
 * 可见性刻意不依赖 CSS 过渡完成：只要 open 为真，遮罩与卡片就已经是最终态，
 * 动画只负责「从哪儿来」。标签页被节流时过渡会冻在起始值，若把可见性挂在过渡上，
 * 用户点了登录会什么都看不到、而页面滚动已经被锁住 —— 那是硬卡死。
 */
export default function LoginModal({
  open,
  onClose,
  wechatLive = false,
  phoneLive = false,
  adminLive = false,
  previewLive = false,
}: {
  open: boolean;
  onClose: () => void;
  wechatLive?: boolean;
  phoneLive?: boolean;
  adminLive?: boolean;
  previewLive?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // 记录唤起弹窗的那个按钮，关闭后把焦点还回去（键盘用户不会掉到页面顶部）。
  const openerRef = useRef<Element | null>(null);
  // 按下与抬起都落在遮罩上才算「点了空白处」：从卡片里划选文字、松手甩到遮罩上不该关窗。
  const downOnBackdrop = useRef(false);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey);

    // 锁背景滚动，同时补上滚动条宽度，避免整页横向跳一格。
    const { body } = document;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;

    const focusTimer = window.setTimeout(() => {
      cardRef.current?.querySelector<HTMLElement>("input, button, a[href]")?.focus({ preventScroll: true });
    }, 60);

    return () => {
      document.removeEventListener("keydown", onKey);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPad;
      window.clearTimeout(focusTimer);
      (openerRef.current as HTMLElement | null)?.focus?.({ preventScroll: true });
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className="login-modal fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto overscroll-contain bg-[rgba(10,9,20,.58)] px-4 py-6 backdrop-blur-[6px]"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) close();
        downOnBackdrop.current = false;
      }}
    >
      <Toaster />
      <div ref={cardRef} className="login-modal-card relative m-auto w-full max-w-[900px]" role="dialog" aria-modal="true" aria-label="登录">
        <LoginCard
          wechatLive={wechatLive}
          phoneLive={phoneLive}
          adminLive={adminLive}
          previewLive={previewLive}
        />
        <button
          type="button"
          onClick={close}
          aria-label="关闭"
          className="absolute -top-11 right-0 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20 hover:text-white"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
