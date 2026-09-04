"use client";

import { useEffect, useState } from "react";

/** 全站公告横幅(后台「应用设置」配置)。可关闭;公告内容变化后重新出现。 */
export default function AnnouncementBanner({ text }: { text: string }) {
  const [show, setShow] = useState(false);

  // 用内容做 key:同一条公告关闭后不再弹,改了内容则重新出现。
  const key = "nb_ann_" + hash(text);
  useEffect(() => {
    try {
      setShow(localStorage.getItem(key) !== "1");
    } catch {
      setShow(true);
    }
  }, [key]);

  if (!text.trim() || !show) return null;
  return (
    <div className="flex items-center gap-3 border-b border-accent/20 bg-accentSoft px-5 py-2.5 text-[13px] text-accent">
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
        <path d="M3 11l18-5v12L3 14v-3zM11.6 16.8a3 3 0 0 1-5.8-1.6" />
      </svg>
      <span className="flex-1 leading-relaxed">{text}</span>
      <button
        onClick={() => {
          try {
            localStorage.setItem(key, "1");
          } catch {}
          setShow(false);
        }}
        aria-label="关闭公告"
        className="shrink-0 rounded-md p-1 text-accent/70 transition hover:bg-accent/10 hover:text-accent"
      >
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
