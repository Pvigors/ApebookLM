"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { applyTheme, getThemeMode, setThemeMode, systemPrefersDark, type ThemeMode } from "@/lib/theme";
import type { User } from "@/lib/types";
import type { LegalDoc } from "@/lib/legal-content";
import { toast } from "@/components/Toast";
import { AvatarImage } from "@/components/AvatarImage";
import ModelApiSettings from "@/components/ModelApiSettings";

// —— 描边小图标(随 currentColor)——
const I = (p: { d: string; size?: number }) => (
  <svg width={p.size ?? 21} height={p.size ?? 21} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {p.d.split("|").map((d, i) => <path key={i} d={d} />)}
  </svg>
);
const GearIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const ThemeIcon = () => <I d="M12 3v1M12 20v1M5.6 5.6l.7.7M17.7 17.7l.7.7M3 12h1M20 12h1M5.6 18.4l.7-.7M17.7 6.3l.7-.7M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />;
const LangIcon = () => <I d="M4 5h10M9 3v2c0 5-2.5 8-6 9M6 9c0 3 3.5 5.5 7 6M13 21l4-9 4 9M14.5 17h5" />;
const SlidersIcon = () => <I d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5M14 4v4M6 10v4M11 16v4" />;
const PanelIcon = () => <I d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z|M14 5v14" />;
const BillIcon = () => <I d="M6 3h12v18l-3-2-3 2-3-2-3 2z|M9 8h6M9 12h6" />;
const HelpIcon = () => <I d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01|M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />;
const MailIcon = () => <I d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z|M3.5 6.5l8.5 6 8.5-6" />;
const DocIcon = () => <I d="M14 3v4a1 1 0 0 0 1 1h4M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M9 13h6M9 17h4" />;
const ShieldIcon = () => <I d="M12 3l8 3v6c0 4-3 7-8 9-5-2-8-5-8-9V6l8-3z" />;
const UserIcon = () => <I d="M20 21a8 8 0 1 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />;
const LogoutIcon = (p: { size?: number }) => <I d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" size={p.size ?? 19} />;
const CloseIcon = () => <I d="M18 6 6 18M6 6l12 12" size={20} />;
const ExtIcon = (p: { size?: number }) => <I d="M7 17 17 7M8 7h9v9" size={p.size ?? 15} />;
const ChevR = (p: { size?: number }) => <I d="M9 6l6 6-6 6" size={p.size ?? 19} />;
const ChevD = (p: { open?: boolean }) => <span className={`inline-flex transition-transform ${p.open ? "rotate-180" : ""}`}><I d="M6 9l6 6 6-6" size={17} /></span>;
const CheckIcon = (p: { size?: number }) => <I d="M20 6 9 17l-5-5" size={p.size ?? 16} />;
const InfoIcon = (p: { size?: number }) => <I d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 11v5|M12 7.6h.01" size={p.size ?? 14} />;
const MobileIcon = (p: { size?: number }) => <I d="M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z|M10.5 18h3" size={p.size ?? 19} />;
const DeregIcon = (p: { size?: number }) => <I d="M16 21a6 6 0 0 0-12 0|M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M16.5 8l5 5M21.5 8l-5 5" size={p.size ?? 18} />;
// 微信品牌绿、双气泡(填充)。
const WechatIcon = (p: { size?: number }) => (
  <svg width={p.size ?? 20} height={p.size ?? 20} viewBox="0 0 1024 1024" fill="#07c160" aria-hidden>
    <path d="M724.9 350.7c-15.8-2.1-32-3.4-48.6-3.4-181.3 0-328.5 123.3-328.1 274.3 0 17.9 2.1 35 6 51.6a397 397 0 0 1-79.8-20L156.6 704l43.1-86.6C123.3 567 74.2 489.8 74.2 402.3 74.2 250.9 221.4 128 402.8 128c160 0 293.1 96 322.1 222.7z m-197.2-96.3a41 41 0 1 0-31.3 75.7 41 41 0 0 0 31.3-75.7zM264.1 321.7a41 41 0 1 0 58-58 41 41 0 0 0-58 58zM676.3 402.3c151 0 273.5 98.1 273.5 219.3 0 70.4-41.8 131.8-105.8 171.9l51.2 102.4-147.6-63.6c-22.6 5.1-46.5 8.5-71.3 8.5-151 0-273.5-98.1-273.5-219.3s122.4-219.2 273.5-219.2z m-105.1 198.8a41 41 0 0 0 22.7 6.9 41 41 0 1 0-63.7-34 41 41 0 0 0 41 27zm158-5.2a41 41 0 1 0 58-57.9 41 41 0 0 0-58 57.9z" />
  </svg>
);

// 主题预览缩略图:对齐 Atoms 真页——抽象灰阶布局(零品牌色)。
// 配色用 Playwright 从其 CDN 原图采的「叠白底合成色」(=屏幕真实观感):
// 浅 #fff/#f0f0f0 · 深 #7a7a7a/#858585(其原图是半透明黑,故深色呈中灰而非纯黑)。
// 布局:左侧高卡(侧栏)+ 右上两枚 tab 药丸 + 中间大卡(正文)+ 底部输入药丸。viewBox 比例 320:188。
const TH_PAL = {
  light: { bg: "#ffffff", block: "#f0f0f0" },
  dark: { bg: "#7a7a7a", block: "#858585" },
} as const;
function ThemeMock({ p, id }: { p: (typeof TH_PAL)[keyof typeof TH_PAL]; id: string }) {
  const cid = `thm-${id}`;
  return (
    <svg viewBox="0 0 320 188" className="block h-full w-full" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs><clipPath id={cid}><rect x="0" y="0" width="320" height="188" /></clipPath></defs>
      <g clipPath={`url(#${cid})`}>
        <rect x="0" y="0" width="320" height="188" fill={p.bg} />
        <rect x="16" y="18" width="78" height="152" rx="11" fill={p.block} />
        <rect x="246" y="18" width="24" height="11" rx="5.5" fill={p.block} />
        <rect x="278" y="18" width="28" height="11" rx="5.5" fill={p.block} />
        <rect x="110" y="40" width="196" height="104" rx="11" fill={p.block} />
        <rect x="170" y="156" width="76" height="11" rx="5.5" fill={p.block} />
      </g>
    </svg>
  );
}
function ThemeThumb({ variant }: { variant: ThemeMode }) {
  if (variant === "system") {
    return (
      <span className="relative block h-full w-full">
        <span className="absolute inset-0" style={{ clipPath: "inset(0 45% 0 0)" }}><ThemeMock p={TH_PAL.light} id="sys-l" /></span>
        <span className="absolute inset-0" style={{ clipPath: "inset(0 0 0 55%)" }}><ThemeMock p={TH_PAL.dark} id="sys-d" /></span>
      </span>
    );
  }
  return <ThemeMock p={variant === "dark" ? TH_PAL.dark : TH_PAL.light} id={variant} />;
}

const THEME_OPTS: { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: "跟随系统" },
  { mode: "light", label: "浅色" },
  { mode: "dark", label: "深色" },
];
const LANG_OPTS = ["跟随来源", "简体中文", "English", "日本語", "한국어"];
// 「会话」区行内下拉的选项(取代「配置对话」弹窗)
const LENGTH_OPTS = [
  { value: "default", label: "默认" },
  { value: "longer", label: "更详细" },
  { value: "shorter", label: "更简短" },
];
const CHAT_LANG_OPTS = [
  { value: "", label: "跟随来源" },
  { value: "简体中文", label: "简体中文" },
  { value: "English", label: "English" },
  { value: "日本語", label: "日本語" },
  { value: "한국어", label: "한국어" },
];
const APP_VERSION = "v0.1.0";
const ENTITLEMENT_NAMES: Record<string, string> = {
  free: "基础权益",
  trial: "试用",
  test: "测试账号",
  starter: "Pro",
  pro: "Max",
  max: "Ultra",
};
// 全局默认语言 ↔ user.default_output_language(空串=跟随来源)
const langToStore = (l: string) => (l === "跟随来源" ? "" : l);
const storeToLang = (s?: string | null) => s || "跟随来源";

const maskPhone = (p?: string | null) => (p ? `+86 ${p.slice(0, 3)}****${p.slice(-4)}` : "");

// 法律条文加载占位骨架:贴合 LegalView 版式(日期条 + 提示框 + 若干章节)。
function LegalSkeleton() {
  const Bar = ({ w, h = "h-3.5" }: { w: string; h?: string }) => <div className={`${h} ${w} rounded-md bg-panel2`} />;
  return (
    <div className="animate-pulse" aria-hidden>
      <Bar w="w-56" h="h-3" />
      <div className="mt-3 space-y-2.5 rounded-xl border border-edge bg-panel2/40 px-4 py-3.5">
        <Bar w="w-full" /><Bar w="w-[94%]" /><Bar w="w-[80%]" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="mt-5 space-y-2.5">
          <Bar w="w-40" h="h-4" />
          <Bar w="w-full" /><Bar w="w-[96%]" /><Bar w="w-[90%]" /><Bar w="w-[72%]" />
        </div>
      ))}
    </div>
  );
}

// 法律条文的紧凑内联渲染(用于设置右栏);"- " 开头的行聚成要点,其余为段落。
function LegalView({ doc }: { doc: LegalDoc }) {
  // 最朴素文档版:黑色加粗章节标题 + 干净段落(无竖条/无底块)+ 简洁要点。舒适字号 14.5/1.75。
  const SZ = "text-[14.5px] leading-[1.75] text-ink2";
  const head = "mb-2 text-[15px] font-semibold text-ink";
  // 全篇齐左:所有行(含原「- 」要点)统一渲染为齐左段落,左边界一致,不做悬挂缩进。
  const Body = ({ lines }: { lines: string[] }) => (
    <>
      {lines.map((l, i) => <p key={i} className={`my-2 ${SZ}`}>{l.startsWith("- ") ? l.slice(2) : l}</p>)}
    </>
  );
  return (
    <div>
      {/* 顶栏已展示分区名(用户协议/隐私政策),此处改用正式文件全名,避免与顶栏同名重复。 */}
      <p className="text-[12.5px] text-muted">{doc.title} · 更新于 {doc.updated} · 生效 {doc.effective}</p>
      {doc.intro?.length ? <div className="mt-4 border-b border-edge/60 pb-4"><Body lines={doc.intro} /></div> : null}
      {doc.principle ? (
        <section className="mt-6"><h4 className={head}>{doc.principle.h}</h4><Body lines={[doc.principle.p]} /></section>
      ) : null}
      {doc.sections.map((s, i) => (
        <section key={i} className="mt-6"><h4 className={head}>{s.h}</h4><Body lines={s.p} /></section>
      ))}
    </div>
  );
}

function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onToggle(); }} aria-pressed={on} aria-label={label} className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition ${on ? "bg-accent" : "bg-edge"}`}>
      <span className={`h-5 w-5 rounded-full bg-white shadow transition ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}

/** 行内右对齐紧凑下拉(与「输出语言」同款),用于「会话」区各配置项。 */
function MenuSelect({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const cur = options.find((o) => o.value === value);
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} aria-haspopup="listbox" aria-expanded={open} className="flex items-center gap-1.5 rounded-lg border border-edge bg-panel2/40 px-3 py-1.5 text-[13.5px] text-ink transition hover:border-accent/45 hover:bg-panel2/70">
        {cur?.label ?? "请选择"}<ChevD open={open} />
      </button>
      {open && (
        <div onClick={(e) => e.stopPropagation()} className="absolute right-0 top-full z-30 mt-1.5 min-w-[160px] animate-popin rounded-xl border border-edge bg-panel p-1 shadow-[0_16px_40px_-12px_rgba(20,22,40,0.22)]">
          {options.map((o) => (
            <button key={o.value} onClick={() => { onChange(o.value); setOpen(false); }} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-left text-[13.5px] text-ink transition hover:bg-panel2">
              {o.label}{value === o.value && <span className="text-accent"><CheckIcon size={16} /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type Sec = "account" | "general" | "chat" | "model" | "feedback" | "agreement" | "privacy";

type UsageContract = {
  today: number;
  month: number;
  dailyLimit: number;
  notebooks: number;
  maxNotebooks: number;
  bonusCredits?: number;
  maxFileBytes?: number;
  plan?: string;
  capabilityPlan?: string;
  membership?: {
    status?: "active" | "none";
    active?: boolean;
    tier?: string | null;
    trial?: boolean;
    test?: boolean;
    systemAdmin?: boolean;
    name?: string;
    expiresAt?: number;
  };
  daily?: { limit: number; spent: number; remaining: number; resetAt: number };
  bonus?: { balance: number };
  totalAvailable?: number;
  access?: { active?: boolean; systemAdmin?: boolean; reason?: "system_admin" | "membership" | "credits" | "none" };
};

export default function SettingsMenu({
  triggerClassName,
  systemAdmin = false,
  chatConfig,
  onSaveChatConfig,
}: {
  triggerClassName: string;
  /** SSR 已确认的系统管理员身份，防慢网首开时短暂显示有限额度。 */
  systemAdmin?: boolean;
  /** 已弃用:原用于「配置对话」弹窗入口;现「会话」内联,门控改用 chatConfig。保留仅为兼容 HomeClient 传参。 */
  onOpenChatConfig?: () => void;
  /** 当前笔记本的会话配置:「会话」区用行内下拉/文本框直接编辑,取代弹窗。 */
  chatConfig?: { chat_style: string; chat_instructions: string; response_length: string; output_language: string };
  onSaveChatConfig?: (s: { chat_style: string; chat_instructions: string; response_length: string; output_language: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [desktop, setDesktop] = useState(true);
  const [mode, setMode] = useState<ThemeMode>("system");
  const [lang, setLang] = useState("跟随来源");
  const [autoExpand, setAutoExpand] = useState(true);
  // 会话配置(内联下拉/文本框,取代「配置对话」弹窗);改动即存
  const [cfgLen, setCfgLen] = useState("default");
  const [cfgLang, setCfgLang] = useState("");
  const [cfgInstr, setCfgInstr] = useState("");
  const [user, setUser] = useState<User | null>(null);
  // 改名/换头像/改语言/解绑后:更新本地 user,并广播给外层(右上角头像即时刷新)。
  const syncUser = (u: User) => {
    setUser(u);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("nb:user-updated", { detail: u }));
    }
  };
  const [fb, setFb] = useState("");
  const [fbBusy, setFbBusy] = useState(false);
  const [fbImages, setFbImages] = useState<string[]>([]);
  // 账户:改昵称 + 头像
  const [editName, setEditName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  // 账户:微信解绑 / 删除账号
  const [wxBusy, setWxBusy] = useState(false);
  const [delConfirm, setDelConfirm] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  // 法律条文(用户协议/隐私政策)右栏内联:按需拉取并缓存
  const [legalDocs, setLegalDocs] = useState<Record<string, LegalDoc>>({});
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fbFileRef = useRef<HTMLInputElement>(null);
  // 单栏:浮层(主题/语言)与内联展开(反馈/关于)
  const [pop, setPop] = useState<null | "theme" | "lang">(null);
  const [expand, setExpand] = useState<null | "feedback" | "about" | "model">(null);
  // 两栏:当前分区 + 语言内联展开
  const [sec, setSec] = useState<Sec>("account");
  const [secLang, setSecLang] = useState(false);
  // 积分与权限的真实用量。
  const [usage, setUsage] = useState<UsageContract | null>(null);
  const [infoOpen, setInfoOpen] = useState(false); // 额度说明 tooltip 开合(hover/点按/聚焦驱动)
  // 积分用量明细(credit_ledger):弹层打开时拉首页,「加载更多」游标翻页。
  type LedgerRow = { id: number; detail: string; type: "acquired" | "consumed"; change: number; ts: number; balance: number | null };
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [ledMore, setLedMore] = useState(false);
  const [ledLoading, setLedLoading] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false); // 「积分用量」弹层开合(点剩余积分卡触发)
  useEffect(() => {
    if (!ledgerOpen) return;
    let cancelled = false;
    setLedLoading(true);
    fetch(`/api/usage/ledger?type=all`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d) { setLedger(d.entries); setLedMore(d.hasMore); }
        else { setLedger([]); setLedMore(false); } // 失败清空,避免旧数据残留
      })
      .catch(() => { if (!cancelled) { setLedger([]); setLedMore(false); } })
      .finally(() => { if (!cancelled) setLedLoading(false); });
    return () => { cancelled = true; };
  }, [ledgerOpen]);
  useEffect(() => { if (!open) setLedgerOpen(false); }, [open]); // 关设置弹窗时一并收起用量弹层
  // 首次打开设置要一次性挂载这棵很大的子树,首挂(JIT + 首次渲染)有一次性成本 ——
  // dev 下尤其明显(实测首点 ~500ms 卡顿,之后每次 <2ms)。页面空闲时预挂载一份隐藏副本,
  // 把这次成本挪出用户点击的关键路径,让「第一次点设置」也秒开。预热一帧后即撤下,不常驻 DOM。
  const [prewarm, setPrewarm] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 820px)");
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (open) return; // 已经真的打开就无需预热
    type IdleWin = Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    const w = window as IdleWin;
    const req = w.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const cancel = w.cancelIdleCallback ?? window.clearTimeout;
    const id = req(() => setPrewarm(true), { timeout: 3000 });
    return () => cancel(id as number);
  }, [open]);

  // 预热渲染挂载后一帧即撤下(此时 JIT/首挂已完成,真正打开就快了)。
  useEffect(() => {
    if (!prewarm) return;
    const t = window.setTimeout(() => setPrewarm(false), 120);
    return () => window.clearTimeout(t);
  }, [prewarm]);

  // 头像下拉的「全部设置 / 模型 API 配置 / 输出语言 / 帮助」等入口派发此事件来打开本弹窗;
  // detail.sec 指定要直达的分区(账户/通用/套餐/反馈…),经 pendingSecRef 传给开窗 effect。
  const pendingSecRef = useRef<Sec | null>(null);
  useEffect(() => {
    const openIt = (e: Event) => {
      const sec = (e as CustomEvent).detail?.sec as Sec | undefined;
      if (sec) pendingSecRef.current = sec;
      setOpen(true);
    };
    window.addEventListener("nb:open-settings", openIt);
    return () => window.removeEventListener("nb:open-settings", openIt);
  }, []);

  useEffect(() => {
    if (!open) return;
    setMode(getThemeMode());
    try {
      setLang(localStorage.getItem("nb_reply_lang") || "跟随来源"); // 即时回显;拿到 user 后以服务端为准
      setAutoExpand(localStorage.getItem("nb_sources_collapsed") !== "1");
    } catch {}
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setUsage(d))
      .catch(() => {});
    setPop(null);
    const requestedSec = pendingSecRef.current ?? "account";
    const narrow = !window.matchMedia("(min-width: 820px)").matches;
    setExpand(
      narrow && (requestedSec === "model" || requestedSec === "feedback")
        ? requestedSec
        : null
    );
    setSec(requestedSec); // 头像下拉指定的直达分区,否则默认账户
    pendingSecRef.current = null;
    setEditName(false);
    setAvatarPreview(null);
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.user) return;
        setUser(d.user);
        setNameDraft(d.user.name || "");
        const l = storeToLang(d.user.default_output_language);
        setLang(l);
        try { localStorage.setItem("nb_reply_lang", l); } catch {}
      })
      .catch(() => {});
  }, [open]);

  // 跟随系统时实时跟随
  useEffect(() => {
    if (mode !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden"; // 锁背景滚动,避免滚动链回弹露白/抖动
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 进入「用户协议/隐私政策」分区时按需拉取条文(缓存,只取一次)
  useEffect(() => {
    if (sec !== "agreement" && sec !== "privacy") return;
    if (legalDocs[sec]) return;
    fetch(`/api/legal/${sec}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.doc) setLegalDocs((m) => ({ ...m, [sec]: d.doc })); })
      .catch(() => {});
  }, [sec, legalDocs]);

  const pickTheme = (m: ThemeMode) => { setMode(m); setThemeMode(m); };
  const themeCards = (
    <div className="grid max-w-[460px] grid-cols-3 gap-2.5">
      {THEME_OPTS.map((o) => {
        const on = mode === o.mode;
        return (
          <button key={o.mode} type="button" onClick={() => pickTheme(o.mode)} aria-pressed={on} className="group flex flex-col gap-2 text-left">
            <span className={`relative block aspect-[320/188] w-full overflow-hidden rounded-xl border-2 bg-panel transition-colors ${on ? "border-accent" : "border-edge group-hover:border-accent/55"}`}>
              <ThemeThumb variant={o.mode} />
            </span>
            <span className={`text-[12.5px] transition-colors ${on ? "font-medium text-ink" : "text-muted group-hover:text-ink2"}`}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
  const pickLang = (l: string) => {
    setLang(l);
    try { localStorage.setItem("nb_reply_lang", l); } catch {}
    setPop(null);
    setSecLang(false);
    // 持久化为账户级默认输出语言(被每本笔记的「配置对话」覆盖)
    fetch("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_output_language: langToStore(l) }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.user && syncUser(d.user))
      .catch(() => {});
  };
  const saveName = async () => {
    const name = nameDraft.trim();
    if (!name || name === user?.name || nameBusy) { setEditName(false); return; }
    setNameBusy(true);
    try {
      const r = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error();
      const d = await r.json();
      if (d?.user) syncUser(d.user);
      setEditName(false);
      toast("昵称已更新");
    } catch {
      toast("更新失败,请稍后再试");
    } finally {
      setNameBusy(false);
    }
  };
  const toggleAutoExpand = () => {
    setAutoExpand((v) => {
      const next = !v;
      try { localStorage.setItem("nb_sources_collapsed", next ? "0" : "1"); } catch {}
      return next;
    });
  };
  // 会话配置:从当前笔记本同步到本地表单态
  useEffect(() => {
    setCfgLen(chatConfig?.response_length || "default");
    setCfgLang(chatConfig?.output_language || "");
    setCfgInstr(chatConfig?.chat_instructions || "");
  }, [chatConfig?.response_length, chatConfig?.output_language, chatConfig?.chat_instructions]);
  // 改动即存:发当前三项(合并本次改动)给外层持久化。回答风格已移除,chat_style 恒为 default(不再影响生成)。
  const saveChat = (patch: Partial<{ chat_style: string; chat_instructions: string; response_length: string; output_language: string }>) => {
    onSaveChatConfig?.({ chat_style: "default", chat_instructions: cfgInstr, response_length: cfgLen, output_language: cfgLang, ...patch });
  };
  const soon = (name: string) => toast(`${name} · 功能开发中,敬请期待`);

  // 积分用量:游标翻页 + 时间格式化(YYYY-MM-DD HH:mm,本地时区)。
  const loadMoreLedger = async () => {
    const last = ledger[ledger.length - 1];
    if (!last || ledLoading) return;
    setLedLoading(true);
    try {
      const d = await fetch(`/api/usage/ledger?type=all&before=${last.id}`).then((r) => (r.ok ? r.json() : null));
      if (d) { setLedger((prev) => [...prev, ...d.entries]); setLedMore(d.hasMore); }
    } catch { /* ignore */ } finally { setLedLoading(false); }
  };
  const fmtLedTs = (ts: number) => {
    const d = new Date(ts), p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const submitFeedback = async () => {
    if ((!fb.trim() && fbImages.length === 0) || fbBusy) return;
    setFbBusy(true);
    try {
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: fb.trim(), images: fbImages }),
      });
      // 审查修复:400 服务端有具体校验文案(内容过长/图片超限等),不能丢弃。
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error || "提交失败,请稍后再试");
      }
      setFb("");
      setFbImages([]);
      setExpand((e) => (e === "feedback" ? null : e));
      toast("感谢反馈,我们已收到 🙌");
    } catch (e) {
      toast((e as Error).message || "提交失败,请稍后再试");
    } finally {
      setFbBusy(false);
    }
  };
  // 反馈截图:压缩到 ≤1600px JPEG,最多 6 张;支持选择与粘贴。
  const addFbImages = (files: FileList | File[]) => {
    Array.from(files).filter((f) => f.type.startsWith("image/")).forEach((f) => {
      const r = new FileReader();
      r.onload = () => {
        const img = new Image();
        img.onload = () => {
          const S = 1600;
          const scale = Math.min(1, S / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          c.getContext("2d")?.drawImage(img, 0, 0, w, h);
          const dataUrl = c.toDataURL("image/jpeg", 0.82);
          setFbImages((prev) => (prev.length >= 6 ? prev : [...prev, dataUrl]));
        };
        img.src = String(r.result);
      };
      r.readAsDataURL(f);
    });
  };
  const onFbPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.items)
      .filter((it) => it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (imgs.length) { e.preventDefault(); addFbImages(imgs); }
  };
  const onFbPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFbImages(e.target.files);
    e.target.value = "";
  };
  // 反馈表单(内联):想法输入 + 图片上传/粘贴 + 提交。两栏当 sec、单栏当 expand 复用。
  const feedbackForm = (
    <div onPaste={onFbPaste}>
      <textarea name="feedback" autoComplete="off" value={fb} onChange={(e) => setFb(e.target.value)} rows={5} maxLength={2000} placeholder="欢迎说说你的想法" className="w-full resize-none rounded-2xl bg-panel2/60 px-4 py-3.5 text-[14px] text-ink outline-none transition focus:ring-2 focus:ring-accent/30" />
      <p className="mb-2 mt-4 text-[13px] text-muted">你还可以上传或粘贴图片进行反馈。</p>
      <div className="flex flex-wrap gap-2.5">
        {fbImages.map((src, i) => (
          <div key={i} className="group relative h-20 w-20 overflow-hidden rounded-xl border border-edge">
            <img src={src} alt="" className="h-full w-full object-cover" />
            <button onClick={() => setFbImages((p) => p.filter((_, j) => j !== i))} className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/55 text-white opacity-0 transition group-hover:opacity-100" aria-label="移除图片"><I d="M18 6 6 18M6 6l12 12" size={12} /></button>
          </div>
        ))}
        {fbImages.length < 6 && (
          <button onClick={() => fbFileRef.current?.click()} className="grid h-20 w-20 place-items-center rounded-xl bg-panel2/60 text-muted transition hover:bg-panel2 hover:text-ink2" aria-label="添加图片"><span className="text-[30px] font-light leading-none">+</span></button>
        )}
      </div>
      <button onClick={submitFeedback} disabled={fbBusy || (!fb.trim() && fbImages.length === 0)} className="mt-5 rounded-xl bg-accent px-5 py-2.5 text-[14px] font-medium text-onAccent transition hover:brightness-110 disabled:opacity-50">{fbBusy ? "提交中…" : "提交反馈"}</button>
      <input name="feedback-images" ref={fbFileRef} type="file" accept="image/*" multiple className="hidden" onChange={onFbPickFiles} />
    </div>
  );
  const logout = async () => {
    // 见 AccountMenu:跳转不能吊死在这个 POST 上(连接池饱和时会排队数秒,
    // `await` 把按钮冻成「点了没反应」)。keepalive 保证会话注销送达,超时竞速兜底跳转。
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
  const unbindWechat = async () => {
    if (wxBusy) return;
    if (!user?.phone) { toast("解绑前请先绑定手机号,否则将无法登录"); return; }
    setWxBusy(true);
    try {
      const r = await fetch("/api/auth/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unbind_wechat: true }) });
      if (!r.ok) throw new Error();
      const d = await r.json();
      if (d?.user) syncUser(d.user);
      toast("已解绑微信");
    } catch {
      toast("解绑失败,请稍后再试");
    } finally {
      setWxBusy(false);
    }
  };
  const delAccount = async () => {
    if (delBusy) return;
    setDelBusy(true);
    try {
      const r = await fetch("/api/auth/me", { method: "DELETE" });
      if (!r.ok) throw new Error();
      window.location.href = "/login";
    } catch {
      toast("删除失败,请稍后再试");
      setDelBusy(false);
    }
  };
  const close = () => setOpen(false);
  const onPickAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!f.type.startsWith("image/")) { toast("请选择图片文件"); return; }
    if (f.size > 8 * 1024 * 1024) { toast("图片需小于 8MB"); return; }
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = async () => {
        // 压缩到 ≤256px 方图 JPEG,控制落库体积
        const S = 256;
        const scale = Math.min(1, S / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d")?.drawImage(img, 0, 0, w, h);
        const dataUrl = c.toDataURL("image/jpeg", 0.85);
        setAvatarPreview(dataUrl); // 即时预览
        try {
          const resp = await fetch("/api/auth/me", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ avatar: dataUrl }),
          });
          if (!resp.ok) throw new Error();
          const d = await resp.json();
          if (d?.user) syncUser(d.user);
          toast("头像已更新");
        } catch {
          setAvatarPreview(null);
          toast("头像更新失败,请重试");
        }
      };
      img.src = String(r.result);
    };
    r.readAsDataURL(f);
  };

  const avatarUrl = avatarPreview || user?.avatar;
  const displayName = user?.name || "我的账户";
  const displayPhone = user?.phone || user?.email || "已登录";
  const initial = (user?.name || "我").slice(0, 1);
  const startEditName = () => { setNameDraft(user?.name || ""); setEditName(true); };

  const membershipActive = usage
    ? usage.membership
      ? usage.membership.active ?? usage.membership.status === "active"
      : (usage.plan ?? user?.plan_tier ?? "free") !== "free"
    : (user?.plan_tier ?? "free") !== "free";
  const isSystemAdmin = Boolean(
    systemAdmin ||
    usage?.membership?.systemAdmin ||
    usage?.access?.systemAdmin ||
    (Number(user?.is_admin) === 1 && user?.admin_role === "super")
  );
  const accessActive = usage?.access?.active ?? (membershipActive || Number(usage?.totalAvailable ?? 0) > 0);
  const currentTier = isSystemAdmin
    ? "test"
    : membershipActive
      ? usage?.membership?.tier ?? usage?.plan ?? user?.plan_tier ?? "free"
      : usage?.plan ?? "free";
  const isTrial = Boolean(usage?.membership?.trial || (membershipActive && currentTier === "trial"));
  const isTestAccount = currentTier === "test" && !isSystemAdmin;
  const creditOnly = accessActive && !membershipActive && !isSystemAdmin;
  const entitlementName = ENTITLEMENT_NAMES[currentTier] || "基础权益";
  const entitlementLabel = isSystemAdmin ? "系统管理员" : creditOnly ? "积分可用" : entitlementName;
  const planBadgeCls = accessActive ? "bg-accentSoft text-accent" : "bg-panel2 text-muted";
  const creditPanel = (
    <div>
      {/* 积分总览:套餐日额度与长期奖励分桶展示；整卡可点查看流水。 */}
      <div
        className="mb-5 w-full cursor-pointer rounded-2xl bg-panel2/40 p-4 text-left transition hover:bg-panel2/70"
        role="button"
        tabIndex={0}
        aria-label="查看积分用量明细"
        onClick={() => setLedgerOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLedgerOpen(true); } }}
      >
        {usage ? (() => {
          const dailyLimit = usage.daily?.limit ?? usage.dailyLimit;
          const dailyRemaining = usage.daily?.remaining ?? Math.max(0, dailyLimit - usage.today);
          const unlimited = dailyLimit < 0;
          const remainPct = unlimited ? 100 : dailyLimit > 0 ? (dailyRemaining / dailyLimit) * 100 : 0;
          const bonus = usage.bonus?.balance ?? usage.bonusCredits ?? 0;
          const totalAvailable = usage.totalAvailable ?? (accessActive ? dailyRemaining + bonus : 0);
          const resetAt = Number(usage.daily?.resetAt ?? 0);
          const resetLabel = resetAt > 0
            ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(resetAt)
            : "明日";
          const expiresAt = Number(usage.membership?.expiresAt ?? user?.plan_expires_at ?? 0);
          const expiresLabel = expiresAt > 0
            ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(expiresAt)
            : "长期有效";
          const nbUnlimited = usage.maxNotebooks < 0;
          const Bullet = () => <span className="inline-block h-[3px] w-[3px] shrink-0 rounded-full bg-muted" />;
          return (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-[14px] font-semibold text-ink">{isSystemAdmin ? "系统管理员权益" : accessActive ? "当前可用积分" : "积分不足"}</span>
                  <span
                    className="relative inline-flex"
                    onMouseEnter={() => setInfoOpen(true)}
                    onMouseLeave={() => setInfoOpen(false)}
                  >
                    <button
                      type="button"
                      aria-label="额度说明"
                      aria-expanded={infoOpen}
                      onClick={(e) => { e.stopPropagation(); setInfoOpen((v) => !v); }}
                      onFocus={() => setInfoOpen(true)}
                      onBlur={() => setInfoOpen(false)}
                      className="flex text-muted transition hover:text-ink2 focus:outline-none focus-visible:text-ink2"
                    >
                      <InfoIcon />
                    </button>
                    <div
                      role="tooltip"
                      className={`pointer-events-none absolute left-0 top-full z-50 mt-2 w-[268px] max-w-[78vw] origin-top-left rounded-xl bg-solid p-3 text-left shadow-[0_16px_40px_-12px_rgba(20,22,40,0.5)] transition duration-150 ${infoOpen ? "scale-100 opacity-100" : "scale-95 opacity-0"}`}
                    >
                      <p className="mb-1.5 text-[12.5px] font-semibold text-onSolid">关于积分</p>
                      <ul className="space-y-1.5 text-[11.5px] leading-relaxed text-onSolid/75">
                        <li className="flex gap-1.5"><span className="select-none text-onSolid/40">–</span><span>各操作按完整处理链成本差异扣分:对话 3 分 · 概览 2 分 · 报告/导图/表格等 5 分 · 演示 8 分 · 信息图 10 分 · 音频 20 分 · 视频 30 分 · 快速搜索 5 分 · 深度研究 20 分。</span></li>
                        <li className="flex gap-1.5"><span className="select-none text-onSolid/40">–</span><span>{isSystemAdmin ? "系统管理员默认开放全部能力，积分不限量。" : membershipActive ? (isTrial ? `试用期提供一次性 ${bonus} 积分，不设每日权益积分。` : unlimited ? "当前权益每日不限量。" : `${entitlementName} 权益每日 ${dailyLimit} 积分，北京时间零点重置（下次 ${resetLabel}）。`) : creditOnly ? `当前可直接使用 ${bonus} 奖励积分。` : "积分不足时，可通过邀请活动获取，或联系管理员补充。"}</span></li>
                        {accessActive && <li className="flex gap-1.5"><span className="select-none text-onSolid/40">–</span><span>{nbUnlimited ? "笔记本不限量创建。" : `最多可创建 ${usage.maxNotebooks} 个笔记本。`}</span></li>}
                        <li className="flex gap-1.5"><span className="select-none text-onSolid/40">–</span><span>{isSystemAdmin ? "系统管理员不受积分限制，也不参与邀请返利。" : isTestAccount ? "测试账号不参与邀请返利，积分已按测试用途设为不限量。" : `邀请好友可赚奖励积分；奖励长期保留并可直接抵扣${bonus > 0 ? `（当前 ${bonus} 分）` : ""}。`}</span></li>
                      </ul>
                    </div>
                  </span>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  {bonus > 0 && (
                    <span className="rounded-full bg-accentSoft px-2 py-0.5 text-[11px] font-semibold text-accent">奖励 {bonus}</span>
                  )}
                  <span className="text-[13px] font-semibold tabular-nums text-ink2">
                    {isSystemAdmin || unlimited ? "不限量" : `${Math.max(0, totalAvailable)} 分`}
                  </span>
                  <span className="-mr-0.5 text-[16px] leading-none text-muted" aria-hidden>›</span>
                </span>
              </div>
              {membershipActive && !unlimited && !isTrial && (
                <div className="mt-2.5 flex items-center gap-2.5">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-panel2">
                    <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, remainPct)}%` }} />
                  </div>
                  <span className="shrink-0 text-[12px] font-medium tabular-nums text-ink2">今日 {dailyRemaining} / {dailyLimit}</span>
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[12px] text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Bullet />
                  {isSystemAdmin ? "系统管理员 · 随管理员身份有效" : membershipActive ? `${isTrial ? "试用期" : `${entitlementName} 权益`} · ${expiresLabel}${expiresAt > 0 ? "到期" : ""}` : bonus > 0 ? `${bonus} 奖励积分可直接使用` : "当前没有可用积分"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Bullet />
                  {accessActive ? (nbUnlimited ? "笔记本不限量" : `笔记本 ${usage.notebooks} / ${usage.maxNotebooks}`) : "可通过邀请活动或联系管理员获取积分"}
                </span>
              </div>
            </>
          );
        })() : (
          <p className="text-[13px] text-muted">正在加载积分与权益…</p>
        )}
      </div>
      {/* 邀请返利入口已移到顶栏常驻(components/ReferralPill.tsx,E1 方案)—— 设置里不再重复。
          积分用量明细已移到弹层(点剩余积分卡触发,见文件底部 ledgerOpen portal)。 */}
      <div className="rounded-2xl border border-edge bg-panel px-4 py-4">
        <p className="text-[14px] font-semibold text-ink">获取积分</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          可通过邀请活动获取奖励积分；如需补充积分、调整权限或查询存量权益，请联系管理员。
        </p>
      </div>
    </div>
  );

  /* ---------------- 单栏(窄屏 / 移动) ---------------- */
  const Tile = ({ children }: { children: React.ReactNode }) => <span className="shrink-0 text-ink2">{children}</span>;
  const GroupS = ({ label, children }: { label?: string; children: React.ReactNode }) => (
    <div className="mt-6 first:mt-0">
      {label && <p className="mb-2 px-1.5 text-[13px] font-medium text-muted">{label}</p>}
      <div className="rounded-2xl bg-panel2/50 [&>*]:first:rounded-t-2xl [&>*]:last:rounded-b-2xl [&>*+*]:border-t [&>*+*]:border-edge/45">{children}</div>
    </div>
  );
  const rowS = "flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition";
  const Pop = ({ items, value, pick }: { items: string[]; value: string; pick: (v: string) => void }) => (
    <div className="absolute right-2 top-full z-30 mt-1 w-44 animate-popin overflow-hidden rounded-2xl border border-edge bg-panel p-1.5 shadow-[0_16px_40px_-12px_rgba(20,22,40,0.22)]">
      {items.map((it) => (
        <button key={it} onClick={(e) => { e.stopPropagation(); pick(it); }} className="flex w-full items-center justify-between rounded-xl px-3.5 py-2.5 text-left text-[15px] text-ink transition hover:bg-panel2">
          {it}{value === it && <span className="text-accent"><CheckIcon size={17} /></span>}
        </button>
      ))}
    </div>
  );

  const single = (
    <div
      className="max-h-[90vh] w-full max-w-[600px] overflow-y-auto overscroll-contain rounded-3xl border border-edge bg-panel p-5 shadow-2xl"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => setPop(null)}
    >
      <div className="mb-5 flex items-center justify-between">
        <h2 className="px-1 text-[24px] font-bold text-ink">设置</h2>
        <button onClick={close} className="rounded-lg p-1.5 text-ink2 transition hover:bg-panel2 hover:text-ink" aria-label="关闭"><CloseIcon /></button>
      </div>

      {/* 账户卡 */}
      <div className="flex items-center gap-4 rounded-2xl bg-panel2/50 px-4 py-4" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => user && fileRef.current?.click()} disabled={!user} className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-full" aria-label="更换头像">
          <AvatarImage
            src={avatarUrl}
            fallback={<span className="grid h-full w-full place-items-center bg-gradient-to-br from-[#8a7cf0] to-[#6d5ae6] text-[20px] font-bold text-white">{initial}</span>}
          />
          {user && <span className="absolute inset-0 hidden place-items-center bg-black/45 text-[10px] font-medium text-white group-hover:grid">更换</span>}
        </button>
        <div className="min-w-0 flex-1">
          {editName ? (
            <div className="flex items-center gap-2">
              <input name="name" autoComplete="off" autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && saveName()} maxLength={40} className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-[16px] text-ink outline-none focus:border-accent" />
              <button onClick={saveName} disabled={nameBusy} className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-onAccent transition hover:brightness-110 disabled:opacity-50">{nameBusy ? "…" : "保存"}</button>
              <button onClick={() => setEditName(false)} className="shrink-0 rounded-lg px-2 py-1.5 text-[13px] text-muted transition hover:text-ink">取消</button>
            </div>
          ) : (
            <>
              <p className="truncate text-[18px] font-semibold text-ink">{displayName}</p>
              <p className="mt-0.5 truncate text-[14px] text-muted">{displayPhone}</p>
            </>
          )}
        </div>
        {!editName && user && (
          <button onClick={startEditName} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition hover:bg-panel2 hover:text-ink">编辑</button>
        )}
      </div>

      <GroupS label="通用">
        <div className="px-4 py-3.5">
          <div className="mb-3 flex items-center gap-3.5">
            <Tile><ThemeIcon /></Tile>
            <span className="flex-1 text-[16px] text-ink">界面主题</span>
          </div>
          {themeCards}
        </div>
        <div className="relative">
          <button className={`${rowS} hover:bg-panel2`} onClick={(e) => { e.stopPropagation(); setPop((p) => (p === "lang" ? null : "lang")); }}>
            <Tile><LangIcon /></Tile>
            <span className="flex-1 text-[16px] text-ink">输出语言</span>
            <span className="flex items-center gap-1 text-[15px] text-muted">{lang}<ChevD open={pop === "lang"} /></span>
          </button>
          {pop === "lang" && <Pop items={LANG_OPTS} value={lang} pick={pickLang} />}
        </div>
      </GroupS>

      <GroupS label="会话">
        {!chatConfig && (
          <div className="px-4 py-2.5 text-[13px] leading-relaxed text-muted">对话配置(回答长度 / 输出语言 / 自定义指令)是每本笔记本各自独立的;进入任意笔记本后即可在此修改。</div>
        )}
        <div className={`${rowS}${!chatConfig ? " pointer-events-none opacity-50" : ""}`}>
          <Tile><SlidersIcon /></Tile>
          <span className="flex-1 text-[16px] text-ink">回答长度</span>
          <MenuSelect value={cfgLen} options={LENGTH_OPTS} onChange={(v) => { setCfgLen(v); saveChat({ response_length: v }); }} />
        </div>
        <div className={`${rowS}${!chatConfig ? " pointer-events-none opacity-50" : ""}`}>
          <Tile><LangIcon /></Tile>
          <span className="flex-1 text-[16px] text-ink">输出语言</span>
          <MenuSelect value={cfgLang} options={CHAT_LANG_OPTS} onChange={(v) => { setCfgLang(v); saveChat({ output_language: v }); }} />
        </div>
        <div className={`px-4 py-3${!chatConfig ? " pointer-events-none opacity-50" : ""}`}>
          <span className="mb-2 block text-[16px] text-ink">自定义指令</span>
          <textarea name="instruction" autoComplete="off" value={cfgInstr} disabled={!chatConfig} onChange={(e) => setCfgInstr(e.target.value)} onBlur={() => saveChat({ chat_instructions: cfgInstr })} rows={3} placeholder="例如:以资深行业分析师的口吻回答,多引用具体数据。" className="w-full resize-none rounded-lg border border-edge bg-panel2/40 px-3 py-2 text-[15px] text-ink outline-none transition focus:border-accent" />
        </div>
        <div className={rowS}>
          <Tile><PanelIcon /></Tile>
          <span className="flex-1 text-[16px] text-ink">自动展开来源面板</span>
          <Toggle on={autoExpand} onToggle={toggleAutoExpand} label="自动展开来源面板" />
        </div>
      </GroupS>

      <GroupS label="管理">
        <div>
          <button className={`${rowS} hover:bg-panel2`} onClick={() => setExpand((e) => (e === "model" ? null : "model"))}>
            <Tile><BillIcon /></Tile>
            <span className="flex-1 text-[16px] text-ink">模型 API 配置</span>
            <span className="text-muted"><ChevD open={expand === "model"} /></span>
          </button>
          {expand === "model" && <div className="px-3 pb-3"><ModelApiSettings /></div>}
        </div>
      </GroupS>

      <GroupS label="帮助">
        {/* 新标签页打开:此前整页跳转要卸载首页并现场编译 /help 路由,点击后约 1 秒
            无反馈;新开标签点击即时响应,首页与本弹窗状态也得以保留。 */}
        <Link href="/help" target="_blank" rel="noopener" className={`${rowS} hover:bg-panel2`}>
          <Tile><HelpIcon /></Tile>
          <span className="flex-1 text-[16px] text-ink">帮助中心</span>
          <span className="text-muted"><ExtIcon /></span>
        </Link>
        <div>
          <button className={`${rowS} hover:bg-panel2`} onClick={() => setExpand((e) => (e === "feedback" ? null : "feedback"))}>
            <Tile><MailIcon /></Tile>
            <span className="flex-1 text-[16px] text-ink">反馈问题</span>
            <span className="text-muted"><ChevD open={expand === "feedback"} /></span>
          </button>
          {expand === "feedback" && <div className="px-3 pb-3">{feedbackForm}</div>}
        </div>
      </GroupS>

      <GroupS label="关于我们">
        <Link href="/legal/agreement" className={`${rowS} hover:bg-panel2`}>
          <Tile><DocIcon /></Tile>
          <span className="flex-1 text-[16px] text-ink">用户协议</span>
          <span className="text-muted"><ChevR /></span>
        </Link>
        <Link href="/legal/privacy" className={`${rowS} hover:bg-panel2`}>
          <Tile><ShieldIcon /></Tile>
          <span className="flex-1 text-[16px] text-ink">隐私政策</span>
          <span className="text-muted"><ChevR /></span>
        </Link>
      </GroupS>

      <button onClick={logout} className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-panel2/50 py-3.5 text-[16px] font-medium text-red-500 transition hover:bg-red-500/8"><LogoutIcon /> 退出登录</button>
      <p className="mt-4 text-center text-[12px] text-muted">猿笔记 · {APP_VERSION}</p>
    </div>
  );

  /* ---------------- 两栏(宽屏) ---------------- */
  const NAV: { group: string; items: { k: Sec | "help"; label: string; icon: React.ReactNode; ext?: boolean }[] }[] = [
    { group: "偏好", items: [{ k: "general", label: "通用", icon: <ThemeIcon /> }, { k: "chat" as const, label: "会话", icon: <SlidersIcon /> }] },
    { group: "账户", items: [{ k: "account", label: "账户", icon: <UserIcon /> }, { k: "model", label: "模型 API 配置", icon: <BillIcon /> }] },
    { group: "帮助", items: [{ k: "help", label: "帮助中心", icon: <HelpIcon />, ext: true }, { k: "feedback", label: "反馈问题", icon: <MailIcon /> }] },
    { group: "关于我们", items: [{ k: "agreement", label: "用户协议", icon: <DocIcon /> }, { k: "privacy", label: "隐私政策", icon: <ShieldIcon /> }] },
  ];
  const META: Record<Sec, { title: string }> = {
    account: { title: "账户" }, general: { title: "通用" }, chat: { title: "会话" },
    model: { title: "模型 API 配置" }, feedback: { title: "反馈问题" }, agreement: { title: "用户协议" }, privacy: { title: "隐私政策" },
  };
  const cardRow = "flex items-center gap-4 px-4 py-3.5";
  // 顶栏已展示分区名(META[sec].title),内容区不再重复同名标题,只留描述副标题。
  const SecHead = ({ title, desc }: { title?: string; desc?: string }) => (
    <div className="mb-5 -mt-1">{title && <h3 className="mb-1 text-[16px] font-semibold text-ink">{title}</h3>}{desc && <p className="text-[13.5px] leading-relaxed text-muted">{desc}</p>}</div>
  );

  const twoPane = (
    <div className="flex h-[min(86vh,720px)] w-[min(94vw,1040px)] overflow-hidden rounded-3xl border border-edge bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()} onClick={() => setSecLang(false)}>
      <aside className="flex w-[280px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-edge bg-panel2/30 px-3 py-5">
        <p className="px-3 pb-3 text-[19px] font-bold text-ink">设置</p>
        {NAV.map((g) => (
          <div key={g.group} className="mt-3">
            <p className="px-3 pb-1.5 text-[12px] font-medium text-muted">{g.group}</p>
            {g.items.map((it) => {
              const on = sec === it.k;
              if (it.k === "help") {
                // 新标签页打开(原整页跳转卸载首页 + dev 编译 ≈1 秒无反馈)
                return (
                  <Link key="help" href="/help" target="_blank" rel="noopener" className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[14px] text-ink2 transition hover:bg-panel2/60">
                    <span className="text-muted">{it.icon}</span><span className="flex-1">{it.label}</span><span className="text-muted"><ExtIcon size={14} /></span>
                  </Link>
                );
              }
              return (
                <button key={it.k} onClick={() => { setSec(it.k as Sec); setSecLang(false); }} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[14px] transition ${on ? "bg-panel2 font-medium text-ink shadow-sm" : "text-ink2 hover:bg-panel2/60"}`}>
                  <span className={on ? "text-ink" : "text-muted"}>{it.icon}</span><span className="flex-1">{it.label}</span>
                </button>
              );
            })}
          </div>
        ))}
        <p className="mt-auto px-3 pt-5 text-[12px] text-muted">猿笔记 · {APP_VERSION}</p>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className={`flex items-center justify-between pt-7 pb-5 ${sec === "model" ? "px-6" : "px-9"}`}>
          <div className="flex items-center gap-3">
            <h2 className="text-[22px] font-bold text-ink">{META[sec].title}</h2>
            {sec === "account" && <span className={`rounded-md px-2 py-0.5 text-[12px] font-medium ${planBadgeCls}`}>{entitlementLabel}</span>}
          </div>
          <button onClick={close} className="rounded-lg p-1 text-ink2 transition hover:bg-panel2" aria-label="关闭"><CloseIcon /></button>
        </header>

        <div className={`min-h-0 flex-1 ${sec === "model" ? "overflow-hidden px-6 pb-6" : "overflow-y-auto px-9 pb-9"}`}>
          {sec === "account" && user && (
            <div className="mx-auto max-w-[460px]">
              {/* 头像 */}
              <div className="mb-6 mt-2 flex justify-center">
                <button onClick={() => fileRef.current?.click()} className="group relative h-20 w-20 overflow-hidden rounded-full" aria-label="更换头像">
                  <AvatarImage
                    src={avatarUrl}
                    fallback={<span className="grid h-full w-full place-items-center bg-brand text-[26px] font-bold text-onAccent">{initial}</span>}
                  />
                  <span className="absolute inset-0 hidden place-items-center bg-black/45 text-[13px] font-medium text-white group-hover:grid">更换</span>
                </button>
              </div>

              {/* 编辑昵称 */}
              <p className="mb-2 text-[13px] text-muted">编辑昵称</p>
              <input name="name" autoComplete="off" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()} maxLength={40} placeholder="昵称" className="mb-6 w-full rounded-xl bg-panel2/60 px-4 py-3 text-[15px] text-ink outline-none transition focus:ring-2 focus:ring-accent/30" />

              {/* 本机号码 */}
              <p className="mb-2 text-[13px] text-muted">本机号码</p>
              <div className="mb-6 flex items-center gap-3 rounded-xl bg-panel2/60 px-4 py-3.5">
                <span className="shrink-0 text-ink2"><MobileIcon /></span>
                <span className="flex-1 text-[15px] text-ink">手机号</span>
                <span className="text-[14px] text-muted">{user.phone ? maskPhone(user.phone) : "未绑定"}</span>
                <button onClick={() => soon("更换手机号")} className="text-[14px] font-medium text-accent transition hover:opacity-80">{user.phone ? "更换" : "绑定"}</button>
              </div>

              {/* 第三方登陆 */}
              <p className="mb-2 text-[13px] text-muted">第三方登陆</p>
              <div className="mb-7 flex items-center gap-3 rounded-xl bg-panel2/60 px-4 py-3.5">
                <WechatIcon />
                <span className="flex-1 text-[15px] text-ink">微信</span>
                {user.wechat_openid ? (
                  <>
                    <span className="text-[14px] text-muted">已绑定</span>
                    <button onClick={unbindWechat} disabled={wxBusy} className="text-[14px] font-medium text-accent transition hover:opacity-80 disabled:opacity-50">{wxBusy ? "解绑中…" : "解绑"}</button>
                  </>
                ) : (
                  <>
                    <span className="text-[14px] text-muted">未绑定</span>
                    <button onClick={() => soon("微信绑定")} className="text-[14px] font-medium text-accent transition hover:opacity-80">绑定</button>
                  </>
                )}
              </div>

              {/* 退出登录 */}
              <button onClick={logout} className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-panel2/60 py-3.5 text-[15px] font-medium text-ink2 transition hover:bg-panel2"><LogoutIcon size={18} /> 退出登录</button>

              {/* 删除账号 */}
              {delConfirm ? (
                <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3.5">
                  <p className="text-[13.5px] leading-relaxed text-ink">确认删除账号?你的全部笔记本与数据将<span className="font-medium text-red-500">永久删除、无法恢复</span>。</p>
                  <div className="mt-3 flex justify-end gap-2">
                    <button onClick={() => setDelConfirm(false)} className="rounded-lg px-3.5 py-1.5 text-[13.5px] text-ink2 transition hover:bg-panel2">取消</button>
                    <button onClick={delAccount} disabled={delBusy} className="rounded-lg bg-red-500 px-3.5 py-1.5 text-[13.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50">{delBusy ? "删除中…" : "确认删除"}</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setDelConfirm(true)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-panel2/60 py-3.5 text-[15px] font-medium text-red-500 transition hover:bg-red-500/10"><DeregIcon size={18} /> 删除账号</button>
              )}
            </div>
          )}

          {sec === "general" && (
            <>
              <SecHead desc="界面外观与内容输出的默认偏好。" />
              <div className="rounded-2xl border border-edge bg-panel [&>*+*]:border-t [&>*+*]:border-edge/55">
                <div className="px-4 py-4">
                  <span className="block text-[14px] text-ink">界面主题</span>
                  <span className="mb-3 mt-0.5 block text-[12px] text-muted">选择浅色、深色,或跟随系统设置</span>
                  {themeCards}
                </div>
                <div className="flex items-center gap-4 px-4 py-4">
                  <span className="flex-1"><span className="block text-[14px] text-ink">输出语言</span><span className="mt-0.5 block text-[12px] text-muted">默认输出语言,可被每本笔记的「配置对话」覆盖</span></span>
                  <div className="relative shrink-0">
                    <button onClick={(e) => { e.stopPropagation(); setSecLang((v) => !v); }} aria-haspopup="listbox" aria-expanded={secLang} className="flex items-center gap-1.5 rounded-lg border border-edge bg-panel2/40 px-3 py-1.5 text-[13.5px] text-ink transition hover:border-accent/45 hover:bg-panel2/70">{lang}<ChevD open={secLang} /></button>
                    {secLang && (
                      <div onClick={(e) => e.stopPropagation()} className="absolute right-0 top-full z-30 mt-1.5 min-w-[176px] animate-popin rounded-xl border border-edge bg-panel p-1 shadow-[0_16px_40px_-12px_rgba(20,22,40,0.22)]">
                        {LANG_OPTS.map((l) => (
                          <button key={l} onClick={() => pickLang(l)} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-left text-[13.5px] text-ink transition hover:bg-panel2">{l}{lang === l && <span className="text-accent"><CheckIcon size={16} /></span>}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {sec === "chat" && (
            <>
              <SecHead desc="自定义指令 · 回答长度 · 输出语言,以及来源面板默认行为。" />
              <div className="overflow-hidden rounded-2xl border border-edge bg-panel [&>*+*]:border-t [&>*+*]:border-edge/55">
                {!chatConfig && (
                  <div className="px-4 py-3 text-[12.5px] leading-relaxed text-muted">对话配置(回答长度 / 输出语言 / 自定义指令)是每本笔记本各自独立的;进入任意笔记本后即可在此修改。</div>
                )}
                <div className={`${cardRow}${!chatConfig ? " pointer-events-none opacity-50" : ""}`}>
                  <span className="flex-1"><span className="block text-[14px] text-ink">回答长度</span></span>
                  <MenuSelect value={cfgLen} options={LENGTH_OPTS} onChange={(v) => { setCfgLen(v); saveChat({ response_length: v }); }} />
                </div>
                <div className={`${cardRow}${!chatConfig ? " pointer-events-none opacity-50" : ""}`}>
                  <span className="flex-1"><span className="block text-[14px] text-ink">输出语言</span><span className="mt-0.5 block text-[12px] text-muted">仅本笔记本;留空则跟随来源</span></span>
                  <MenuSelect value={cfgLang} options={CHAT_LANG_OPTS} onChange={(v) => { setCfgLang(v); saveChat({ output_language: v }); }} />
                </div>
                <div className={`px-4 py-3.5${!chatConfig ? " pointer-events-none opacity-50" : ""}`}>
                  <span className="mb-2 block text-[14px] text-ink">自定义指令</span>
                  <textarea name="instruction" autoComplete="off" value={cfgInstr} disabled={!chatConfig} onChange={(e) => setCfgInstr(e.target.value)} onBlur={() => saveChat({ chat_instructions: cfgInstr })} rows={3} placeholder="例如:以资深行业分析师的口吻回答,多引用具体数据。" className="w-full resize-none rounded-lg border border-edge bg-panel2/40 px-3 py-2 text-[13.5px] text-ink outline-none transition focus:border-accent" />
                </div>
                <div className={cardRow}>
                  <span className="flex-1"><span className="block text-[14px] text-ink">自动展开来源面板</span><span className="mt-0.5 block text-[12px] text-muted">打开笔记本时默认展开左侧来源列表</span></span>
                  <Toggle on={autoExpand} onToggle={toggleAutoExpand} label="自动展开来源面板" />
                </div>
              </div>
            </>
          )}

          {sec === "model" && (
            <div className="flex h-full min-h-0 flex-col">
              <SecHead desc="连接你自己的模型供应商；密钥由服务端加密保存。" />
              <div className="min-h-0 flex-1"><ModelApiSettings /></div>
            </div>
          )}

          {sec === "feedback" && (
            <>
              <SecHead desc="使用过程中遇到了什么问题?欢迎告诉我们。" />
              {feedbackForm}
            </>
          )}

          {(sec === "agreement" || sec === "privacy") && (
            legalDocs[sec]
              ? <LegalView doc={legalDocs[sec]} />
              : <LegalSkeleton />
          )}
        </div>
      </section>
    </div>
  );

  return (
    <>
      <button
        onClick={() => {
          // 顶栏「设置」是通用入口 → 默认进「通用」分区(账户相关走头像下拉的「账户设置」)。
          pendingSecRef.current = "general";
          setOpen(true);
        }}
        className={triggerClassName}
        title="设置"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {/* B8:窄屏顶栏挤压会把「设置」二字压成竖排,移动端只留齿轮图标 */}
        <GearIcon /> <span className="hidden sm:inline">设置</span>
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4" onMouseDown={close}>
          <input name="avatar" ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickAvatar} />
          {desktop ? twoPane : single}
        </div>,
        document.body
      )}

      {/* 积分用量弹层:点剩余积分卡触发。明细 | 类型(可筛)| 日期 | 积分变动 + 加载更多。 */}
      {ledgerOpen && createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4" onMouseDown={() => setLedgerOpen(false)}>
          <div className="flex max-h-[78vh] w-full max-w-[480px] flex-col overflow-hidden rounded-2xl bg-panel shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-edge px-5 py-4">
              <div className="text-[16px] font-semibold text-ink">积分用量</div>
              <button onClick={() => setLedgerOpen(false)} className="rounded-lg p-1.5 text-ink2 transition hover:bg-panel2 hover:text-ink" aria-label="关闭"><CloseIcon /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
              <div className="flex items-center border-b border-edge py-2.5 text-[12px] font-medium text-muted">
                <span className="flex-1">明细</span>
                <span className="w-[124px] whitespace-nowrap pl-2">日期</span>
                <span className="w-[46px] pl-2 text-right">变动</span>
              </div>
              {ledger.length === 0 ? (
                <p className="py-12 text-center text-[13px] text-muted">{ledLoading ? "加载中…" : "暂无积分记录"}</p>
              ) : (
                ledger.map((e) => (
                  <div key={e.id} className="flex items-center border-b border-edge/55 py-3 text-[14px]">
                    <span className="min-w-0 flex-1 truncate pr-3 text-ink">{e.detail}</span>
                    <span className="w-[124px] whitespace-nowrap pl-2 text-[12px] tabular-nums text-muted">{fmtLedTs(e.ts)}</span>
                    <span className={`w-[46px] pl-2 text-right font-semibold tabular-nums ${e.change > 0 ? "text-green-600" : "text-ink"}`}>
                      {e.change > 0 ? `+${e.change}` : e.change}
                    </span>
                  </div>
                ))
              )}
              {ledMore && (
                <button
                  onClick={loadMoreLedger}
                  disabled={ledLoading}
                  className="mt-3 w-full rounded-xl bg-panel2/60 py-2.5 text-[13px] font-medium text-ink2 transition hover:bg-panel2 disabled:opacity-50"
                >
                  {ledLoading ? "加载中…" : "加载更多"}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 空闲预热:离屏挂载一次,把大子树首挂成本挪出用户点击路径。隐藏、不可交互、
          无副作用(fetch 均门控在 open)。挂载一帧后由上面的 effect 撤下。 */}
      {prewarm && !open && createPortal(
        <div aria-hidden style={{ position: "fixed", left: -99999, top: 0, width: 1, height: 1, overflow: "hidden", visibility: "hidden", pointerEvents: "none" }}>
          {desktop ? twoPane : single}
        </div>,
        document.body
      )}
    </>
  );
}
