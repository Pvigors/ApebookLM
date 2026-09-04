"use client";

import { useState } from "react";
import ReferralModal from "@/components/ReferralModal";

/** 顶栏邀请返利入口(E1 方案):淡紫胶囊「🎁 送 200 积分」,置于「+ 创建笔记本」左侧。
 *  首页与笔记本视图共用;≤900px 视口折叠为纯礼盒图标。点击弹出 ReferralModal。 */
export default function ReferralPill() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="邀请好友,赚取积分"
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-accentSoft px-3.5 text-[13px] font-semibold text-accent transition hover:brightness-[0.965] active:scale-[0.97] max-[900px]:px-2.5"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9z" />
          <path d="M3 7h18v4H3z" />
          <path d="M12 7v14" />
          <path d="M12 7S10.5 3 8.5 3a2.5 2.5 0 0 0 0 5H12z" />
          <path d="M12 7s1.5-4 3.5-4a2.5 2.5 0 0 1 0 5H12z" />
        </svg>
        <span className="max-[900px]:hidden">送 200 积分</span>
      </button>
      <ReferralModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
