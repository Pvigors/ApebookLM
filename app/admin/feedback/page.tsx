"use client";

import { useEffect, useState } from "react";
import { Btn, Pill, Skeleton, EmptyState, fmtTime, PageHeader } from "@/components/AdminUI";

type FB = {
  id: string;
  user_name: string | null;
  category: string;
  content: string;
  contact: string | null;
  images: string | null;
  status: string;
  created_at: number;
  handled_at: number | null;
};

const CAT: Record<string, { label: string; tone: "ok" | "warn" | "err" | "muted" | "info" }> = {
  bug: { label: "问题", tone: "err" },
  idea: { label: "建议", tone: "info" },
  other: { label: "其它", tone: "muted" },
};

export default function FeedbackPage() {
  const [status, setStatus] = useState("all");
  const [data, setData] = useState<{ rows: FB[]; total: number } | null>(null);

  const load = (s = status) => {
    setData(null);
    fetch(`/api/admin/feedback?status=${s}&limit=100`).then((r) => r.json()).then(setData);
  };
  useEffect(() => {
    load(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const setStat = async (id: string, st: string) => {
    await fetch("/api/admin/feedback", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: st }),
    });
    load();
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="用户声音" title="用户反馈" desc="集中处理用户从“设置 · 反馈问题”提交的建议、故障和使用疑问。" />

      <div className="inline-flex gap-1 rounded-full bg-panel2 p-1 text-[13px]">
        {[
          ["all", "全部"],
          ["open", "待处理"],
          ["resolved", "已处理"],
        ].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setStatus(k)}
            className={`rounded-full px-3.5 py-1.5 transition ${status === k ? "bg-panel text-accent shadow-sm" : "text-ink2 hover:text-ink"}`}
          >
            {l}
          </button>
        ))}
      </div>

      {!data ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : data.rows.length === 0 ? (
        <EmptyState title="暂无反馈" hint="用户提交的反馈会出现在这里" />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-edge bg-panel [&>*+*]:border-t [&>*+*]:border-edge/55">
          {data.rows.map((f) => (
            <div key={f.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill text={CAT[f.category]?.label || f.category} tone={CAT[f.category]?.tone || "muted"} />
                  <span className="text-[13px] text-ink2">{f.user_name || "匿名"}</span>
                  <span className="text-[11px] text-muted">{fmtTime(f.created_at)}</span>
                  {f.status === "resolved" && <Pill text="已处理" tone="ok" />}
                </div>
                <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{f.content}</p>
                {f.contact && <p className="mt-1 text-[12px] text-muted">联系方式:{f.contact}</p>}
                {(() => {
                  let imgs: string[] = [];
                  try { imgs = f.images ? JSON.parse(f.images) : []; } catch {}
                  return imgs.length ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {imgs.map((src, i) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <a key={i} href={src} target="_blank" rel="noreferrer" className="block h-16 w-16 overflow-hidden rounded-lg border border-edge" title="点击查看大图"><img src={src} alt="反馈截图" className="h-full w-full object-cover" /></a>
                      ))}
                    </div>
                  ) : null;
                })()}
              </div>
              <div className="shrink-0 self-end sm:self-auto">
                {f.status === "open" ? (
                  <Btn kind="primary" onClick={() => setStat(f.id, "resolved")}>标记已处理</Btn>
                ) : (
                  <Btn onClick={() => setStat(f.id, "open")}>重开</Btn>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
