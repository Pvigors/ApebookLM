"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type Data = {
  code: string;
  rewardPerMilestone: number;
  inviteCap: number;
  earnCap: number;
  invitedThisMonth: number;
  totalInvited: number;
  earnedThisMonth: number;
  totalEarned: number;
  bonusCredits: number;
};

const Ico = (p: { d: string; size?: number; sw?: number }) => (
  <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={p.sw ?? 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {p.d.split("|").map((d, i) => <path key={i} d={d} />)}
  </svg>
);
const CloseIcon = () => <Ico d="M18 6 6 18M6 6l12 12" size={20} />;
const LinkIcon = () => <Ico d="M9 15l6-6M10.5 6.5l1.8-1.8a4 4 0 0 1 5.7 5.7L15.5 13M13.5 17.5l-1.8 1.8a4 4 0 0 1-5.7-5.7L8.5 11" />;
const UsersIcon = () => <Ico d="M16 20a5 5 0 0 0-10 0M11 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M18 8v4M20 10h-4" />;
const GiftIcon = () => <Ico d="M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9zM3 7h18v4H3zM12 7v14M12 7S10.5 3 8.5 3a2.5 2.5 0 0 0 0 5H12zM12 7s1.5-4 3.5-4a2.5 2.5 0 0 1 0 5H12z" />;

/** 右上角礼盒 + 金币 插画(柔光底,品牌紫)。 */
function GiftArt() {
  return (
    <svg width="96" height="88" viewBox="0 0 96 88" fill="none" aria-hidden className="absolute right-3 top-1">
      <circle cx="58" cy="42" r="34" className="fill-accent" opacity="0.12" />
      <rect x="34" y="42" width="42" height="30" rx="5" className="fill-panel stroke-accent" strokeWidth="2.4" />
      <rect x="30" y="34" width="50" height="12" rx="4" className="fill-panel stroke-accent" strokeWidth="2.4" />
      <path d="M55 34v38" className="stroke-accent" strokeWidth="2.4" />
      <path d="M55 34s-3-9-8-9a4 4 0 0 0 0 8h8zM55 34s3-9 8-9a4 4 0 0 1 0 8h-8z" className="fill-accentSoft stroke-accent" strokeWidth="2.4" strokeLinejoin="round" />
      <circle cx="20" cy="20" r="5.5" className="fill-accent" opacity="0.9" />
      <circle cx="82" cy="22" r="3.5" className="fill-accent" opacity="0.5" />
      <circle cx="30" cy="70" r="3" className="fill-accent" opacity="0.4" />
    </svg>
  );
}

function Step({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accentSoft text-accent">{icon}</span>
      <span className="pt-0.5 text-[13px] leading-relaxed text-ink2">{children}</span>
    </li>
  );
}

/** 条款条目(T2 图标步骤流):竖向时间线 + 图标节点,奖励类条目实心紫突出,
 *  关键数字用淡紫 pill 内联。body 为分段数组(字符串 | {pill})。 */
type TermSeg = string | { pill: string };
const TSvg = ({ children }: { children: React.ReactNode }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
const TERMS: { title: string; reward?: boolean; icon: React.ReactNode; body: TermSeg[] }[] = [
  {
    title: "仅限新用户",
    icon: <TSvg><circle cx="9.5" cy="8" r="3.2" /><path d="M4 19.5c0-3.1 2.4-5 5.5-5s5.5 1.9 5.5 5" /><path d="M18 8.5v6M15 11.5h6" /></TSvg>,
    body: ["邀请仅对通过你的链接完成新注册的账号生效;已有账号点击链接不会产生归因,也不会重复计算。"],
  },
  {
    title: "每月邀请上限(前 10 位)",
    reward: true,
    icon: <TSvg><circle cx="9" cy="8.5" r="3" /><path d="M3.8 19c0-2.9 2.3-4.6 5.2-4.6s5.2 1.7 5.2 4.6" /><path d="M15.5 6a3 3 0 0 1 0 5" /><path d="M17.2 14.7c1.9.7 3 2.1 3 4.3" /></TSvg>,
    body: ["每个自然月最多 ", { pill: "10 位" }, " 新用户可为你锁定返利资格。超出后好友仍可正常注册使用,但该次邀请不再产生归因与返利;次月自动重新计数。"],
  },
  {
    title: "双里程碑返利",
    reward: true,
    icon: <TSvg><path d="M6 21V4" /><path d="M6 5h10.5l-2.6 3.5 2.6 3.5H6" /></TSvg>,
    body: ["好友完成首次对话后,你获得 ", { pill: "100 积分" }, ";当好友生成第一个制品时,你再获得 ", { pill: "100 积分" }, "。每位好友的每个里程碑仅计一次,合计最多 ", { pill: "200 积分" }, "。"],
  },
  {
    title: "每月赚取上限",
    reward: true,
    icon: <TSvg><path d="M4.5 17.5a7.5 7.5 0 1 1 15 0" /><path d="M12 14.5l3.2-4.2" /><circle cx="12" cy="15" r="1" fill="currentColor" stroke="none" /></TSvg>,
    body: ["每个自然月通过邀请最多赚取 ", { pill: "1000 积分" }, ",超出部分不入账;次月自动重新计算。"],
  },
  {
    title: "奖励积分如何使用",
    reward: true,
    icon: <TSvg><rect x="3.5" y="6" width="17" height="13.5" rx="3.2" /><path d="M3.5 10.5h17" /><path d="M7 15.5h4" /></TSvg>,
    body: ["奖励积分可直接按操作价目抵扣，无需手动切换；余额长期保留，不可提现、不可转让。"],
  },
  {
    title: "公平使用",
    icon: <TSvg><path d="M12 3.5l7 2.7v5.3c0 4.3-2.9 7.5-7 9-4.1-1.5-7-4.7-7-9V6.2l7-2.7Z" /><path d="M9.2 12.1l2 2 3.6-3.9" /></TSvg>,
    body: ["同一用户仅可被归因一次;自我邀请无效。使用多个账号、脚本注册等方式制造虚假邀请属于作弊,相关返利不予计入。"],
  },
  {
    title: "违规处理",
    icon: <TSvg><path d="M10.4 5.2 3.2 17.5c-.7 1.2.2 2.7 1.6 2.7h14.4c1.4 0 2.3-1.5 1.6-2.7L13.6 5.2c-.7-1.2-2.5-1.2-3.2 0Z" /><path d="M12 10v4.2" /><path d="M12 17.3h.01" /></TSvg>,
    body: ["对涉嫌作弊或滥用的账号,我们保留撤销已发放奖励、暂停或取消其邀请资格的权利。"],
  },
  {
    title: "活动变更",
    icon: <TSvg><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 3.8v4h-4" /></TSvg>,
    body: ["本活动规则可能随时调整、暂停或终止,恕不另行通知;一切以本页面的最新说明为准。"],
  },
];

export default function ReferralModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"main" | "terms">("main");

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setView("main");
    fetch("/api/referral")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && !d.error && setData(d))
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  const reward = data?.rewardPerMilestone ?? 100;
  const link = data ? `${window.location.origin}/login?invite=${data.code}` : "生成中…";

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      /* 剪贴板不可用时降级:选中输入框 */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4 animate-fadein"
      onMouseDown={onClose}
    >
      <div
        className={`relative overflow-hidden rounded-3xl border border-edge bg-panel shadow-[0_30px_80px_-24px_rgba(20,22,40,0.5)] animate-popin transition-[width] duration-200 ${
          view === "terms" ? "w-[min(94vw,600px)]" : "w-[min(94vw,440px)]"
        }`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="关闭"
          className="absolute right-4 top-4 z-10 rounded-lg p-1 text-muted transition hover:bg-panel2 hover:text-ink"
        >
          <CloseIcon />
        </button>

        {/* 条款和条件 · 弹窗内第二页(T2 图标步骤流:竖向时间线 + 图标节点 + 数字 pill) */}
        {view === "terms" && (
          <div className="flex max-h-[min(86vh,760px)] flex-col">
            <div className="relative flex h-[52px] shrink-0 items-center border-b border-edge px-3">
              <button
                onClick={() => setView("main")}
                className="inline-flex items-center gap-0.5 rounded-full py-1.5 pl-2 pr-3 text-[13.5px] font-medium text-ink2 transition hover:bg-panel2 hover:text-ink"
              >
                <Ico d="M15 6l-6 6 6 6" size={15} /> 返回
              </button>
              <h2 className="absolute left-1/2 -translate-x-1/2 text-[15px] font-semibold text-ink">条款和条件</h2>
            </div>
            <div className="min-h-0 overflow-y-auto px-9 pb-2 pt-6 [scrollbar-gutter:stable]">
              <p className="mb-6 ml-0.5 text-[12.5px] text-muted">「邀请好友,赚取积分」活动规则 · 共 {TERMS.length} 条</p>
              <ol>
                {TERMS.map((t, i) => (
                  <li key={t.title} className="relative pb-7 pl-[58px] last:pb-3">
                    {i < TERMS.length - 1 && (
                      <span aria-hidden className="absolute bottom-1.5 left-[19px] top-[46px] w-[2px] rounded bg-accentSoft" />
                    )}
                    <span
                      aria-hidden
                      className={`absolute left-0 top-0 grid h-10 w-10 place-items-center rounded-full ${
                        t.reward
                          ? "bg-accent text-onAccent shadow-[0_8px_18px_-6px_rgb(var(--c-accent)/0.4)]"
                          : "bg-accentSoft text-accent"
                      }`}
                    >
                      {t.icon}
                    </span>
                    <div className="pt-1">
                      <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted tabular-nums">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <h3 className="text-[14.5px] font-semibold leading-snug text-ink">{t.title}</h3>
                      <p className="mt-1.5 text-[13px] leading-[1.78] text-ink2">
                        {t.body.map((seg, j) =>
                          typeof seg === "string" ? (
                            seg
                          ) : (
                            <span
                              key={j}
                              className="mx-0.5 inline-block whitespace-nowrap rounded-full bg-accentSoft px-2 text-[12px] font-semibold leading-5 text-accent tabular-nums"
                            >
                              {seg.pill}
                            </span>
                          )
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="pb-6 pt-1 text-center text-[12px] text-muted">一切以本页面的最新说明为准</p>
            </div>
          </div>
        )}

        {view === "main" && (
          <>
        {/* 横幅 */}
        <div className="relative overflow-hidden bg-accentSoft px-6 pb-6 pt-7">
          <h2 className="text-[19px] font-bold text-ink">分享并赚取积分</h2>
          <span className="mt-2.5 inline-block rounded-full bg-panel/80 px-3 py-1 text-[12px] font-semibold text-accent">
            每月最多可赚取 {data?.earnCap ?? 1000} 积分
          </span>
          <GiftArt />
        </div>

        <div className="px-6 py-5">
          <p className="mb-3.5 text-[13px] font-medium text-ink2">它是如何工作的:</p>
          <ul className="space-y-3.5">
            <Step icon={<LinkIcon />}>分享你的专属邀请链接。</Step>
            <Step icon={<UsersIcon />}>
              好友通过链接注册并完成首次对话后,你将获得 <b className="font-semibold text-ink">{reward} 积分</b>。
            </Step>
            <Step icon={<GiftIcon />}>
              当好友生成第一个制品时,你再获得 <b className="font-semibold text-ink">{reward} 积分</b>。
            </Step>
          </ul>

          <p className="mt-5 text-[12px] text-muted">
            本月已邀请 {data?.invitedThisMonth ?? 0} / {data?.inviteCap ?? 10} 位 · 已赚 {data?.earnedThisMonth ?? 0} / {data?.earnCap ?? 1000} 积分
            {data && data.bonusCredits > 0 ? ` · 奖励积分余额 ${data.bonusCredits}` : ""}
          </p>

          <div className="mt-2 flex items-stretch gap-2">
            <input
              readOnly
              name="url"
              autoComplete="off"
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 truncate rounded-xl border border-edge bg-panel2/50 px-3 text-[12.5px] text-ink2 outline-none"
            />
            <button
              onClick={copy}
              disabled={!data}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-solid px-4 py-2.5 text-[13px] font-semibold text-onSolid transition hover:brightness-110 disabled:opacity-50"
            >
              {copied ? (
                <>
                  <Ico d="M20 6 9 17l-5-5" size={15} sw={2.4} /> 已复制
                </>
              ) : (
                <>
                  <Ico d="M9 15l6-6M10.5 6.5l1.8-1.8a4 4 0 0 1 5.7 5.7L15.5 13M13.5 17.5l-1.8 1.8a4 4 0 0 1-5.7-5.7L8.5 11" size={15} /> 复制链接
                </>
              )}
            </button>
          </div>

          <button
            onClick={() => setView("terms")}
            className="mt-4 block w-full text-center text-[12px] text-muted underline-offset-2 transition hover:text-ink2 hover:underline"
          >
            查看条款和条件
          </button>
        </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
