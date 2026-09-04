"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Section, Pill, Btn, StatCard, Modal, EmptyState, ago, fmtTime, PageHeader } from "@/components/AdminUI";
import { useAdminAccess } from "@/components/AdminAccess";

type Detail = {
  notebook: {
    id: string;
    title: string;
    emoji: string;
    public: boolean;
    featured: boolean;
    created_at: number;
    owner: string | null;
  };
  sources: { id: string; title: string; type: string; status: string; error: string | null; char_count: number; chunk_count: number }[];
  notes: { id: string; title: string; kind: string; created_at: number }[];
  outputs: { id: string; title: string; kind: string; status: string; created_at: number }[];
  collaborators: { id: string; name: string; role: string }[];
  messages: { id: string; role: string; content?: string; created_at: number }[];
};

type Confirm = { title: string; body: string; run: () => void };

export default function NotebookDetailPage() {
  const { canWrite } = useAdminAccess("users");
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/admin/notebooks/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "加载失败");
        return r.json();
      })
      .then(setD)
      .catch((e) => setErr((e as Error).message));
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const del = async (action: string, itemId: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/notebooks/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, itemId }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        alert(e.error || "删除失败");
        return;
      }
      await load();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  if (err) {
    return (
      <div className="space-y-4">
        <Link href="/admin/users" className="text-sm text-accent hover:underline">
          ← 返回用户与内容
        </Link>
        <p className="text-sm text-ink2">{err}</p>
      </div>
    );
  }
  if (!d) return <p className="text-sm text-ink2">加载中…</p>;

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link href="/admin/users" className="text-xs text-accent hover:underline">
          ← 返回用户与内容
        </Link>
        <PageHeader
          eyebrow="内容详情"
          title={`${d.notebook.emoji} ${d.notebook.title}`}
          desc={`所有者 ${d.notebook.owner ?? "—"} · 创建于 ${fmtTime(d.notebook.created_at)}`}
          actions={<>{d.notebook.featured && <Pill text="精选" tone="ok" />}{d.notebook.public && <Pill text="公开" tone="muted" />}</>}
        />
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-4">
        <StatCard label="来源" value={d.sources.length} />
        <StatCard label="笔记" value={d.notes.length} />
        <StatCard label="制品" value={d.outputs.length} />
        <StatCard label="协作者" value={d.collaborators.length} />
      </div>

      <Section title={`来源(${d.sources.length})`}>
        {d.sources.length === 0 ? (
          <EmptyState title="暂无来源" />
        ) : (
          <table className="w-full text-left text-[13px]">
            <tbody>
              {d.sources.map((s) => (
                <tr key={s.id} className="border-t border-edge first:border-t-0 text-ink2 transition hover:bg-panel2/50">
                  <td className="w-full max-w-0 py-2 pr-3 font-medium text-ink"><span className="block truncate">{s.title}</span></td>
                  <td className="whitespace-nowrap py-2 pr-3"><Pill text={s.type} tone="muted" /></td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    {s.status === "ready" ? (
                      <span className="tabular-nums text-muted">{s.chunk_count} 块 · {s.char_count.toLocaleString()} 字</span>
                    ) : s.status === "error" ? (
                      <span title={s.error ?? ""}><Pill text="失败" tone="err" /></span>
                    ) : (
                      <Pill text="处理中" tone="warn" />
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {canWrite && (
                    <Btn kind="danger" onClick={() => setConfirm({ title: "删除来源", body: `删除来源「${s.title}」?其分块将一并移除。`, run: () => del("delete_source", s.id) })}>
                      删除
                    </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={`智能笔记 / 制品(${d.outputs.length})`}>
        {d.outputs.length === 0 ? (
          <EmptyState title="暂无制品" />
        ) : (
          <table className="w-full text-left text-[13px]">
            <tbody>
              {d.outputs.map((o) => (
                <tr key={o.id} className="border-t border-edge first:border-t-0 text-ink2 transition hover:bg-panel2/50">
                  <td className="w-full max-w-0 py-2 pr-3 font-medium text-ink"><span className="block truncate">{o.title}</span></td>
                  <td className="whitespace-nowrap py-2 pr-3"><Pill text={o.kind} tone="muted" /></td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{ago(o.created_at)}</td>
                  <td className="py-2 text-right">
                    {canWrite && (
                    <Btn kind="danger" onClick={() => setConfirm({ title: "删除制品", body: `删除「${o.title}」?`, run: () => del("delete_output", o.id) })}>
                      删除
                    </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={`笔记(${d.notes.length})`}>
        {d.notes.length === 0 ? (
          <EmptyState title="暂无笔记" />
        ) : (
          <table className="w-full text-left text-[13px]">
            <tbody>
              {d.notes.map((n) => (
                <tr key={n.id} className="border-t border-edge first:border-t-0 text-ink2 transition hover:bg-panel2/50">
                  <td className="w-full max-w-0 py-2 pr-3 font-medium text-ink"><span className="block truncate">{n.title}</span></td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{ago(n.created_at)}</td>
                  <td className="py-2 text-right">
                    {canWrite && (
                    <Btn kind="danger" onClick={() => setConfirm({ title: "删除笔记", body: `删除笔记「${n.title}」?`, run: () => del("delete_note", n.id) })}>
                      删除
                    </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {d.collaborators.length > 0 && (
        <Section title={`协作者(${d.collaborators.length})`}>
          <div className="flex flex-wrap gap-2">
            {d.collaborators.map((c) => (
              <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full bg-panel2 px-3 py-1 text-[13px] text-ink2">
                {c.name}
                <Pill text={c.role === "editor" ? "可编辑" : "只读"} tone="muted" />
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section title="最近对话" desc="最近 30 条消息(只读)">
        {d.messages.length === 0 ? (
          <EmptyState title="暂无对话" />
        ) : (
          <ul className="space-y-2">
            {d.messages.map((m) => (
              <li key={m.id} className="flex gap-2 text-[13px]">
                <Pill text={m.role === "user" ? "问" : "答"} tone={m.role === "user" ? "muted" : "ok"} />
                <span className="min-w-0 flex-1 truncate text-ink2" title={m.content}>
                  {m.content ?? "正文已按审计权限隐藏"}
                </span>
                <span className="shrink-0 text-muted">{ago(m.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canWrite && confirm && (
        <Modal
          title={confirm.title}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Btn onClick={() => setConfirm(null)}>取消</Btn>
              <Btn kind="danger" disabled={busy} onClick={confirm.run}>
                确认删除
              </Btn>
            </>
          }
        >
          {confirm.body}
        </Modal>
      )}
    </div>
  );
}
