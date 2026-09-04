"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AdminAccessProvider } from "@/components/AdminAccess";
import { BrandMark } from "@/components/BrandLogo";
import { Toaster } from "@/components/Toast";
import {
  ActivityIcon,
  BookIcon,
  GlobeIcon,
  GridIcon,
  SettingsIcon,
  ShieldIcon,
  SparkleIcon,
  ThumbUpIcon,
  UsersIcon,
  WrenchIcon,
} from "@/components/Icons";

type NavItem = {
  href: string;
  label: string;
  Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  module: string;
};

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "工作台",
    items: [
      { href: "/admin", label: "运营总览", Icon: GridIcon, module: "overview" },
      { href: "/admin/analytics", label: "经营分析", Icon: ActivityIcon, module: "analytics" },
      // 沿用 analytics 的模块授权:它和数据分析看的是同一批经营数据,
      // 只是从固定报表换成可自由组合的画布,没必要为它单开一个权限位。
      { href: "/admin/workbench", label: "指标工作台", Icon: GridIcon, module: "analytics" },
      { href: "/admin/monitor", label: "服务监控", Icon: ActivityIcon, module: "monitor" },
    ],
  },
  {
    label: "内容与用户",
    items: [
      { href: "/admin/users", label: "用户与笔记本", Icon: UsersIcon, module: "users" },
      { href: "/admin/featured", label: "精选管理", Icon: SparkleIcon, module: "featured" },
      { href: "/admin/feedback", label: "用户反馈", Icon: ThumbUpIcon, module: "feedback" },
    ],
  },
  {
    label: "权益与用量",
    items: [
      { href: "/admin/plans", label: "权益与配额", Icon: SparkleIcon, module: "plans" },
      { href: "/admin/credits", label: "积分流水", Icon: BookIcon, module: "credits" },
    ],
  },
  {
    label: "系统与安全",
    items: [
      { href: "/admin/providers", label: "模型与外部服务", Icon: SettingsIcon, module: "providers" },
      { href: "/admin/app-settings", label: "应用设置", Icon: GlobeIcon, module: "settings" },
      { href: "/admin/accounts", label: "管理账户", Icon: UsersIcon, module: "accounts" },
      { href: "/admin/activity", label: "活动审计", Icon: ShieldIcon, module: "audit" },
      { href: "/admin/legal", label: "法律文档", Icon: BookIcon, module: "legal" },
      { href: "/admin/ops", label: "系统运维", Icon: WrenchIcon, module: "ops" },
    ],
  },
];

const ROLE_LABEL: Record<string, string> = {
  super: "系统管理员",
  operator: "运营员",
  auditor: "安全审计员",
};

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      {open ? <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></> : <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>}
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 19-7-7 7-7M5 12h14" />
    </svg>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<"checking" | "ok" | "denied">("checking");
  const [role, setRole] = useState("");
  const [name, setName] = useState("");
  const [modules, setModules] = useState<string[]>([]);
  const [writableModules, setWritableModules] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    fetch("/api/admin/me")
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: { role: string; modules: string[]; writableModules?: string[]; name?: string }) => {
        setRole(data.role);
        setName(data.name ?? "");
        setModules(data.modules);
        setWritableModules(data.writableModules ?? []);
        setState("ok");
      })
      .catch(() => setState("denied"));
  }, []);

  useEffect(() => setDrawerOpen(false), [pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = before;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [drawerOpen]);

  const visibleGroups = useMemo(
    () => NAV_GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => modules.includes(item.module)) })).filter((group) => group.items.length),
    [modules]
  );
  const allVisible = visibleGroups.flatMap((group) => group.items);
  const current = allVisible.find((item) => pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href + "/")));

  if (state === "checking") {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas text-sm text-ink2">
        <div className="flex items-center gap-3 rounded-2xl border border-edge bg-panel px-5 py-3 elev-soft">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/25 border-t-accent" aria-hidden />
          正在进入管理中心…
        </div>
      </div>
    );
  }

  if (state === "denied") {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas p-5">
        <div className="animate-popin w-full max-w-sm rounded-[24px] border border-edge bg-panel px-7 py-8 text-center elev-soft">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[15px] bg-accent text-onAccent">
            <BrandMark size={32} />
          </div>
          <h1 className="text-xl font-semibold text-ink">无法进入管理中心</h1>
          <p className="mt-2 text-sm leading-6 text-ink2">当前账号没有后台权限，请切换为已授权的管理账号。</p>
          <div className="mt-6 grid grid-cols-2 gap-2">
            <Link href="/" className="rounded-xl border border-edge px-4 py-2.5 text-sm font-medium text-ink2 transition hover:border-accent/50 hover:text-accent">返回应用</Link>
            <Link href="/admin-login" className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-onAccent">管理员登录</Link>
          </div>
        </div>
      </div>
    );
  }

  const navigation = (
    <>
      <Link href="/admin" className="flex items-center gap-3 px-1 pb-5 pt-1">
        <span className="flex h-10 w-10 items-center justify-center rounded-[13px] bg-accent text-onAccent shadow-[0_7px_20px_-7px_rgba(109,90,230,0.7)]">
          <BrandMark size={27} />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold leading-5 text-ink">猿笔记管理中心</span>
          <span className="block truncate text-[11px] text-muted">{ROLE_LABEL[role] ?? "后台账户"}</span>
        </span>
      </Link>

      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1 lg:space-y-4" aria-label="后台功能导航">
        {visibleGroups.map((group) => (
          <div key={group.label}>
            <p className="mb-1.5 px-3 text-[10px] font-semibold tracking-[0.14em] text-muted/80">{group.label}</p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href + "/"));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`group relative flex min-h-10 items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] transition lg:min-h-9 lg:py-1.5 ${
                      active ? "bg-accentSoft font-semibold text-accent" : "text-ink2 hover:bg-panel2 hover:text-ink"
                    }`}
                  >
                    {active && <span className="absolute left-0 h-5 w-[3px] rounded-r-full bg-accent" aria-hidden />}
                    <item.Icon width={17} height={17} className={active ? "text-accent" : "text-muted transition group-hover:text-ink2"} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-5 border-t border-edge pt-4">
        <div className="mb-2 flex items-center gap-2.5 rounded-xl bg-panel2/80 px-3 py-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accentSoft text-xs font-semibold text-accent">
            {(name || ROLE_LABEL[role] || "管").slice(0, 1)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium text-ink">{name || ROLE_LABEL[role] || "管理账号"}</span>
            <span className="block text-[10px] text-muted">{ROLE_LABEL[role] ?? "管理角色"} · 已验证</span>
          </span>
        </div>
        <Link href="/" className="flex min-h-10 items-center gap-2 rounded-xl px-3 py-2 text-[13px] text-ink2 transition hover:bg-panel2 hover:text-ink">
          <ArrowLeftIcon />
          返回应用
        </Link>
        <Link href="/admin-login" className="flex min-h-10 items-center gap-2 rounded-xl px-3 py-2 text-[13px] text-ink2 transition hover:bg-panel2 hover:text-ink">
          <ShieldIcon width={16} height={16} />
          切换管理员
        </Link>
      </div>
    </>
  );

  return (
    <AdminAccessProvider value={{ role, name, modules, writableModules }}>
    <div className="admin-shell min-h-dvh bg-canvas">
      <Toaster />
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-edge bg-panel/90 px-4 py-4 backdrop-blur-xl lg:flex">
        {navigation}
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]" onClick={() => setDrawerOpen(false)} aria-label="关闭导航" />
          <aside className="relative flex h-dvh w-[286px] max-w-[84vw] animate-[adminDrawer_.2s_ease-out] flex-col border-r border-edge bg-panel px-4 py-4 shadow-2xl">
            <button onClick={() => setDrawerOpen(false)} className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-xl text-muted transition hover:bg-panel2 hover:text-ink" aria-label="关闭导航">
              <MenuIcon open />
            </button>
            {navigation}
          </aside>
        </div>
      )}

      <div className="min-w-0 lg:pl-[248px]">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-edge/80 bg-panel/80 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button onClick={() => setDrawerOpen(true)} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-edge bg-panel text-ink2 lg:hidden" aria-label="打开导航">
              <MenuIcon open={false} />
            </button>
            <div className="min-w-0">
              <p className="truncate text-[11px] text-muted">管理中心 / {current?.label ?? "内容详情"}</p>
              <p className="truncate text-sm font-semibold text-ink">{current?.label ?? "详情"}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-2 rounded-full border border-edge bg-panel px-3 py-1.5 text-[11px] text-ink2 sm:flex">
              <ShieldIcon width={14} height={14} className="text-muted" />
              已验证管理会话
            </span>
            <Link href="/" className="hidden rounded-xl border border-edge bg-panel px-3 py-2 text-xs font-medium text-ink2 transition hover:border-accent/40 hover:text-accent sm:block">查看前台</Link>
          </div>
        </header>

        <main className="admin-content min-w-0 px-4 py-5 text-ink sm:px-6 sm:py-7 lg:px-8 lg:py-8">
          <div className="admin-page mx-auto max-w-[1360px] animate-fadeup">{children}</div>
        </main>
      </div>
    </div>
    </AdminAccessProvider>
  );
}
