"use client";

import { FormEvent, useRef, useState } from "react";
import Link from "next/link";
import { Toaster, toast } from "@/components/Toast";

export default function AdminPasswordLogin({ nextPath = "/admin" }: { nextPath?: "/" | "/admin" }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    if (!username.trim() || !password) {
      toast("请输入管理员用户名和密码", "error");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/auth/admin-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(typeof data.error === "string" ? data.error : "登录失败，请稍后再试", "error");
        return;
      }
      window.location.replace(nextPath);
    } catch {
      toast("网络异常，请稍后再试", "error");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <main
      className="relative flex min-h-dvh items-center justify-center overflow-hidden px-5 py-8"
      style={{
        background:
          "radial-gradient(58vmax 34vmax at 50% -12%, rgb(var(--c-accent) / .12), transparent 62%), rgb(var(--c-canvas))",
      }}
    >
      <Toaster />
      <section className="w-full max-w-[420px] rounded-[24px] bg-panel px-6 py-8 shadow-[0_24px_64px_-28px_rgb(42_34_91_/_0.48)] sm:px-8 sm:py-9">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] bg-[linear-gradient(135deg,#a08fff,#6d5ae6)] text-onAccent shadow-[0_10px_24px_-12px_rgba(71,55,163,.8)]">
            <span
              aria-hidden
              className="inline-block h-[31px] w-[31px] bg-current"
              style={{
                WebkitMask: "url(/brand/yuanbiji-head.png) center / contain no-repeat",
                mask: "url(/brand/yuanbiji-head.png) center / contain no-repeat",
              }}
            />
          </span>
          <div>
            <p className="text-[17px] font-bold tracking-[.01em] text-ink">猿笔记管理中心</p>
            <p className="mt-0.5 text-[12px] text-muted">独立管理员入口</p>
          </div>
        </div>

        <div className="mt-8">
          <h1 className="cjk-display text-[24px] font-bold text-ink">系统管理员登录</h1>
          <p className="mt-2 text-[13px] leading-6 text-ink2">使用管理员用户名和密码登录，无需短信验证码。</p>
        </div>

        <form className="mt-6 space-y-4" onSubmit={submit}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-ink2">管理员用户名</span>
            <input
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={32}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="h-12 w-full rounded-xl border border-edge bg-canvas/50 px-3.5 text-[16px] text-ink outline-none transition placeholder:text-muted focus:border-accent focus:bg-panel focus:ring-2 focus:ring-accent/15"
              placeholder="请输入管理员用户名"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium text-ink2">密码</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              minLength={16}
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-12 w-full rounded-xl border border-edge bg-canvas/50 px-3.5 text-[16px] text-ink outline-none transition placeholder:text-muted focus:border-accent focus:bg-panel focus:ring-2 focus:ring-accent/15"
              placeholder="请输入密码"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="mt-1 h-12 w-full rounded-xl bg-accent text-[14px] font-semibold text-onAccent shadow-[0_10px_22px_-12px_rgb(var(--c-accent)/.8)] transition hover:brightness-105 disabled:cursor-wait disabled:opacity-65"
          >
            {busy ? "登录中…" : "进入管理中心"}
          </button>
        </form>

        <p className="mt-6 text-center text-[12px] text-muted">
          <Link href="/" className="transition hover:text-accent">返回前台</Link>
        </p>
      </section>
    </main>
  );
}
