"use client";

import { useEffect, useRef, useState } from "react";
import { MENU_PANEL } from "@/components/StyledSelect";
import { AvatarImage } from "@/components/AvatarImage";
import { getThemeMode, setThemeMode, type ThemeMode } from "@/lib/theme";

const Ico = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const P = {
  diamond: "M12 2 22 12 12 22 2 12z",
  crown: "M3 8l4 4 5-7 5 7 4-4-2 11H5z",
  bolt: "M13 2 3 14h7l-1 8 10-12h-7z",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M2 12h20M12 2c3 3.5 3 16.5 0 20M12 2c-3 3.5-3 16.5 0 20",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4 4.2 19.8M19.8 4.2l-1.4 1.4",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4",
  help: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  shield: "M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3zM9 12l2 2 4-4",
  chevron: "M9 6l6 6-6 6",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
};

function initialOf(name?: string | null): string {
  const s = (name ?? "").trim();
  return s ? s[0]!.toUpperCase() : "我";
}

/** 手机号只显示国家区号、前三位和后四位；无手机号时回落到邮箱或提示。 */
function subtitle(phone?: string | null, email?: string | null): string {
  const d = (phone ?? "").replace(/\D/g, "");
  if (d.length >= 11) {
    const m = d.slice(-11);
    return `+86 ${m.slice(0, 3)}****${m.slice(7)}`;
  }
  if (email) return email;
  return "已登录";
}

const PLAN_LABEL: Record<string, string> = {
  free: "基础权益",
  starter: "Pro",
  pro: "Max",
  max: "Ultra",
  test: "测试账号",
};
const THEME_SEG: { mode: ThemeMode; label: string }[] = [
  { mode: "light", label: "浅色" },
  { mode: "dark", label: "深色" },
  { mode: "system", label: "系统" },
];

type Usage = {
  today: number;
  dailyLimit: number;
  plan: string;
  capabilityPlan?: string;
  bonusCredits?: number;
  membership?: {
    status?: "active" | "none";
    active?: boolean;
    tier?: string | null;
    name?: string;
    systemAdmin?: boolean;
    expiresAt?: number;
  };
  daily?: { limit: number; spent: number; remaining: number; resetAt: number };
  bonus?: { balance: number };
  totalAvailable?: number;
  access?: { active?: boolean; systemAdmin?: boolean; reason?: string };
};

/** 头像下拉:把设置内容(权益/剩余积分/外观/语言/设置/帮助)折叠进来 + 退出登录。 */
export default function AccountMenu({
  user,
}: {
  user: {
    name?: string | null;
    avatar?: string | null;
    phone?: string | null;
    email?: string | null;
    adminRole?: "super" | "operator" | "auditor" | null;
  };
}) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [mode, setMode] = useState<ThemeMode>("system");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMode(getThemeMode());
  }, []);

  useEffect(() => {
    if (!open) return;
    setMode(getThemeMode());
    let alive = true;
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setUsage(d))
      .catch(() => {});
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pickTheme = (m: ThemeMode) => {
    setMode(m);
    setThemeMode(m);
  };
  const openSettings = (sec?: "account" | "general" | "model" | "feedback") => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("nb:open-settings", { detail: sec ? { sec } : {} }));
  };
  const logout = async () => {
    // 跳转不能吊死在这个 POST 上:dev / HTTP1.1 连接池被通知·任务轮询占满时,
    // 这个请求可能在浏览器端排队数秒,`await` 会把按钮冻成「点了没反应」。
    // keepalive 让会话注销即使在导航离开后也能送达服务端(deleteSession 照删);
    // 超时竞速保证 ~800ms 内无论如何离开当前页。
    try {
      await Promise.race([
        fetch("/api/auth/logout", { method: "POST", keepalive: true }),
        new Promise((r) => setTimeout(r, 800)),
      ]);
    } catch {
      /* 尽力而为,失败也照常跳登录页 */
    }
    window.location.href = "/login";
  };

  const membershipActive = usage
    ? usage.membership
      ? usage.membership.active ?? usage.membership.status === "active"
      : usage.plan !== "free"
    : false;
  const systemAdmin = Boolean(usage?.membership?.systemAdmin || usage?.access?.systemAdmin || user.adminRole === "super");
  const accessActive = usage?.access?.active ?? (membershipActive || Number(usage?.totalAvailable ?? 0) > 0);
  const creditOnly = accessActive && !membershipActive && !systemAdmin;
  const currentTier = usage?.membership?.tier ?? usage?.plan ?? "free";
  const planLabel = systemAdmin
    ? "系统管理员"
    : !membershipActive && accessActive
      ? "积分可用"
      : usage?.membership?.name || PLAN_LABEL[currentTier] || "基础权益";
  const dailyLimit = usage?.daily?.limit ?? usage?.dailyLimit ?? 0;
  const dailyUnlimited = dailyLimit < 0;
  const dailyRemaining = usage?.daily?.remaining ?? Math.max(0, dailyLimit - (usage?.today ?? 0));
  const bonusBalance = usage?.bonus?.balance ?? usage?.bonusCredits ?? 0;
  const totalAvailable = usage?.totalAvailable ?? (membershipActive ? (dailyUnlimited ? -1 : dailyRemaining + bonusBalance) : 0);
  const expiresAt = Number(usage?.membership?.expiresAt ?? 0);
  const expiresLabel = expiresAt > 0
    ? new Date(expiresAt).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    : "";

  const rowCls =
    "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-[14px] text-ink transition hover:bg-panel2";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="账号"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-9 w-9 select-none items-center justify-center overflow-hidden rounded-full bg-brand text-[15px] font-extrabold leading-none text-onAccent shadow-[0_4px_14px_-5px_rgba(143,124,240,0.6)] transition hover:brightness-110"
      >
        <AvatarImage src={user.avatar} fallback={initialOf(user.name)} />
      </button>

      {open && (
        <div role="menu" className={`absolute right-0 top-[calc(100%+8px)] z-50 w-[272px] p-2 ${MENU_PANEL}`}>
          {/* 头部:头像 + 昵称 + 当前权益 */}
          <div className="flex items-center gap-3 px-1.5 py-1.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-brand text-[15px] font-extrabold text-onAccent">
              <AvatarImage src={user.avatar} fallback={initialOf(user.name)} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold text-ink">{user.name || "我"}</p>
              <p className="truncate text-[12px] text-muted">{subtitle(user.phone, user.email)}</p>
            </div>
            <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${accessActive ? "bg-accentSoft text-accent" : "bg-panel2 text-muted"}`}>
              {planLabel}
            </span>
          </div>

          {/* 个人模型入口：替代旧的积分与权限入口。 */}
          <button
            onClick={() => openSettings("model")}
            className="mt-1 flex w-full items-center gap-2.5 rounded-xl bg-accentSoft px-2.5 py-2 text-left transition hover:brightness-[0.98]"
          >
            <span className="text-accent"><Ico d={P.crown} size={17} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-accent">模型 API 配置</span>
              <span className="mt-0.5 block truncate text-[11px] text-accent/70">加密保存个人密钥 · 测试通过后启用</span>
            </span>
            <span className="rounded-lg bg-accent px-3 py-1 text-[13px] font-semibold text-onAccent">
              配置
            </span>
          </button>

          {user.adminRole && (
            <button
              onClick={() => { window.location.href = "/admin"; }}
              className={rowCls}
            >
              <span className="text-muted"><Ico d={P.shield} /></span>
              <span className="flex-1">进入管理中心</span>
              <span className="text-[11px] text-muted">
                {user.adminRole === "super" ? "系统管理员" : user.adminRole === "operator" ? "运营员" : "安全审计员"}
              </span>
              <span className="text-muted"><Ico d={P.chevron} size={15} /></span>
            </button>
          )}

          {/* 输出语言 → 通用 */}
          <button onClick={() => openSettings("general")} className={rowCls}>
            <span className="text-muted"><Ico d={P.globe} /></span>
            <span className="flex-1">输出语言</span>
            <span className="text-muted"><Ico d={P.chevron} size={15} /></span>
          </button>

          {/* 外观(内联主题切换) */}
          <div className={`${rowCls} cursor-default hover:bg-transparent`}>
            <span className="text-muted"><Ico d={P.sun} /></span>
            <span className="flex-1">外观</span>
            <span className="flex gap-0.5 rounded-lg bg-panel2 p-0.5">
              {THEME_SEG.map((t) => (
                <button
                  key={t.mode}
                  onClick={() => pickTheme(t.mode)}
                  className={`rounded-md px-2 py-0.5 text-[12px] transition ${
                    mode === t.mode ? "bg-panel font-medium text-accent shadow-sm" : "text-ink2 hover:text-ink"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </span>
          </div>

          {/* 账户设置 → 显式直达账户分区(顶栏「设置」走通用) */}
          <button onClick={() => openSettings("account")} className={rowCls}>
            <span className="text-muted"><Ico d={P.sliders} /></span>
            <span className="flex-1">账户设置</span>
            <span className="text-muted"><Ico d={P.chevron} size={15} /></span>
          </button>

          {/* 帮助与反馈 → 设置的反馈分区 */}
          <button onClick={() => openSettings("feedback")} className={rowCls}>
            <span className="text-muted"><Ico d={P.help} /></span>
            <span className="flex-1">帮助与反馈</span>
            <span className="text-muted"><Ico d={P.chevron} size={15} /></span>
          </button>

          <div className="my-1 h-px bg-edge" />

          <button onClick={logout} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-red-500 transition hover:bg-red-500/8">
            <span className="text-red-500"><Ico d={P.logout} /></span>
            <span className="flex-1 text-[14px] font-medium">退出登录</span>
          </button>
        </div>
      )}
    </div>
  );
}
