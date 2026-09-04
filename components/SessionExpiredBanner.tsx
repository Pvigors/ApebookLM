"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { onSessionExpired } from "@/lib/session-expiry";

/**
 * 会话过期横幅(定稿方案 S2:顶部横幅,不打断)。
 *
 * 为什么不用弹窗:用户可能正对照资料写东西,一个居中弹窗把视线和内容全夺走。横幅只占顶部
 * 一条,已加载的内容仍可继续阅读,想登录再点开面板。
 *
 * 横幅本身不可关闭 —— 会话确实过期了,关掉只会让用户在后面每个操作上继续撞墙;
 * 但展开的登录面板可以收起,收起后横幅仍在,入口不会丢。
 *
 * 铁律 21:轮询用 setInterval,卸载即停。
 */
export default function SessionExpiredBanner() {
  const [expired, setExpired] = useState(false);
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => onSessionExpired(() => setExpired(true)), []);

  // 全局兜底:逐个请求去改调用点必然有漏网的(这个项目里 fetch 调用有上百处),
  // 所以在这里包一层 window.fetch —— 任何请求收到 401 都能被认出来。
  // 只观察不干预:原样把 Response 交回调用方,不改变任何既有流程。
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await original(...args);
      try {
        // 登录相关接口本来就会返回 401(比如未登录时轮询),那是正常流程,不能当成过期。
        const url = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].href : (args[0] as Request).url;
        if (res.status === 401 && !url.includes("/api/auth/")) setExpired(true);
      } catch {
        /* 解析 url 失败不影响请求本身 */
      }
      return res;
    };
    return () => {
      window.fetch = original;
    };
  }, []);

  const stop = useCallback(() => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  // 展开面板时才取码:没人点开就不必白白向微信要二维码。
  useEffect(() => {
    if (!open) {
      stop();
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/wechat/start", { method: "POST" });
        const data = (await res.json()) as { ticket?: string; qrImage?: string | null; qrUrl?: string | null };
        if (!alive || !data.ticket) return;
        setTicket(data.ticket);
        setQr(data.qrImage ?? null);
        pollRef.current = window.setInterval(async () => {
          const p = await fetch(`/api/auth/wechat/poll?ticket=${encodeURIComponent(data.ticket!)}`);
          const r = (await p.json()) as { status?: string };
          if (!alive) return;
          if (r.status === "confirmed") {
            stop();
            // 会话已重新建立。刷新页面把数据取回来 —— 草稿在输入框里,由浏览器的
            // 表单状态恢复;真正要紧的是别让用户重走一遍找回原来的位置,
            // 所以停在当前 URL 刷新,而不是跳回首页。
            window.location.reload();
          } else if (r.status === "expired") {
            stop();
            setQr(null);
            setTicket(null);
          }
        }, 1800);
      } catch {
        /* 取码失败不影响横幅本身,用户仍可去登录页 */
      }
    })();
    return () => {
      alive = false;
      stop();
    };
  }, [open, stop]);

  // 面板展开时把焦点送进去,收起时还给触发按钮 —— 键盘用户不会掉到页面顶部。
  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => {
        panelRef.current?.querySelector<HTMLElement>("button, a")?.focus({ preventScroll: true });
      }, 80);
      return () => window.clearTimeout(t);
    }
    triggerRef.current?.focus?.({ preventScroll: true });
  }, [open]);

  // 横幅出现时把整页往下推:它是 fixed 的,不占文档流,不推的话会压住顶栏
  // (实测盖掉了左上角 logo 与搜索框的一半)。用 body 的 padding-top 让位,
  // 卸载/恢复登录时还原,避免留下一条空白。
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expired) return;
    const prev = document.body.style.paddingTop;
    const apply = () => {
      // 用实测高度而不是写死数值:横幅高度会随文案换行、字号、展开面板而变
      // (实测 52px,写死 46px 就会压住顶栏一线)。展开/收起时也要重算。
      const h = barRef.current?.firstElementChild?.getBoundingClientRect().height ?? 52;
      document.body.style.paddingTop = `${Math.ceil(h)}px`;
    };
    apply();
    const iv = window.setInterval(apply, 500); // 铁律 21:不用 rAF/ResizeObserver
    return () => {
      window.clearInterval(iv);
      document.body.style.paddingTop = prev;
    };
  }, [expired]);

  if (!expired) return null;

  return (
    <div ref={barRef} className="fixed inset-x-0 top-0 z-[60]" role="status" aria-live="polite">
      <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-50 px-4 py-2.5 shadow-sm dark:bg-amber-500/10">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 8v5M12 16.5v.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </span>
        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-amber-900 dark:text-amber-200">
          <span className="font-semibold">登录已过期</span>
          <span className="mx-1.5 text-amber-700/60 dark:text-amber-200/50">·</span>
          已打开的内容仍可查看，新的操作需要重新登录。你的内容都已保存。
        </p>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-onAccent transition hover:brightness-110"
        >
          {open ? "收起" : "重新登录"}
        </button>
      </div>

      {open && (
        <div
          ref={panelRef}
          className="mx-auto mt-2 w-[300px] rounded-2xl border border-edge bg-panel p-4 text-center shadow-[0_18px_44px_-18px_rgb(42_34_91_/_0.4)]"
        >
          <p className="text-[13px] font-semibold text-ink">扫码继续刚才的工作</p>
          <div className="mx-auto mt-3 grid h-[160px] w-[160px] place-items-center overflow-hidden rounded-lg bg-panel2">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="微信登录二维码" width={160} height={160} className="block" />
            ) : (
              <span className="text-[11.5px] text-muted">正在生成二维码…</span>
            )}
          </div>
          <p className="mt-2.5 text-[11px] text-muted">登录后自动回到当前页面</p>
          <a
            href="/login"
            className="mt-3 inline-block text-[11.5px] text-ink2 underline-offset-2 transition hover:text-accent hover:underline"
          >
            用手机号登录
          </a>
          {!ticket && <span className="sr-only">二维码加载中</span>}
        </div>
      )}
    </div>
  );
}
