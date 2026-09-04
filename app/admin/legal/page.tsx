"use client";

import { useEffect, useState } from "react";
import { Btn, Pill, Skeleton, Field, inputCls, PageHeader, ConfirmDialog } from "@/components/AdminUI";

type Sec = { h: string; p: string[] };
type Doc = {
  slug: string;
  kicker: string;
  title: string;
  updated: string;
  effective: string;
  intro: string[];
  principle?: { h: string; p: string };
  sections: Sec[];
};
type Item = { slug: string; doc: Doc; overridden: boolean };

const SLUGS: { k: "agreement" | "privacy"; label: string }[] = [
  { k: "agreement", label: "用户协议" },
  { k: "privacy", label: "隐私政策" },
];

export default function LegalPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [active, setActive] = useState<"agreement" | "privacy">("agreement");
  const [draft, setDraft] = useState<Doc | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const load = () => fetch("/api/admin/legal").then((r) => r.json()).then((d) => setItems(d.docs));
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    const it = items?.find((i) => i.slug === active);
    setDraft(it ? (JSON.parse(JSON.stringify(it.doc)) as Doc) : null);
  }, [items, active]);

  const current = items?.find((i) => i.slug === active);
  const up = (p: Partial<Doc>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    const clean: Partial<Doc> = {
      title: draft.title,
      updated: draft.updated,
      effective: draft.effective,
      intro: draft.intro.map((s) => s.trim()).filter(Boolean),
      principle: draft.principle?.h || draft.principle?.p ? draft.principle : undefined,
      sections: draft.sections
        .map((s) => ({ h: s.h.trim(), p: s.p.map((x) => x.trimEnd()).filter((x) => x.trim()) }))
        .filter((s) => s.h || s.p.length),
    };
    await fetch("/api/admin/legal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: active, doc: clean }),
    });
    await load();
    setBusy(false);
    setMsg("已保存,前台立即生效");
    setTimeout(() => setMsg(null), 2500);
  };

  const reset = async () => {
    setBusy(true);
    await fetch("/api/admin/legal", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: active, reset: true }),
    });
    await load();
    setBusy(false);
    setResetOpen(false);
    setMsg("已恢复默认");
    setTimeout(() => setMsg(null), 2500);
  };

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        eyebrow="合规治理"
        title="法律文档"
        desc="维护用户协议与隐私政策的现行版本，保存后前台对应页面立即更新。"
        actions={msg ? <span className="text-xs font-medium text-emerald-600">{msg}</span> : null}
      />

      <div className="flex items-center gap-3">
        <div className="inline-flex gap-1 rounded-full bg-panel2 p-1 text-[13px]">
          {SLUGS.map((s) => (
            <button
              key={s.k}
              onClick={() => setActive(s.k)}
              className={`rounded-full px-3.5 py-1.5 transition ${active === s.k ? "bg-panel text-accent shadow-sm" : "text-ink2 hover:text-ink"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {current && <Pill text={current.overridden ? "已自定义" : "内置默认"} tone={current.overridden ? "info" : "muted"} />}
        <a href={`/legal/${active}`} target="_blank" rel="noreferrer" className="text-[12px] text-accent hover:underline">
          预览前台 ↗
        </a>
      </div>

      {!draft ? (
        <Skeleton className="h-96 w-full rounded-2xl" />
      ) : (
        <div className="space-y-5 rounded-2xl border border-edge bg-panel p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Field label="标题">
                <input name="title" autoComplete="off" value={draft.title} onChange={(e) => up({ title: e.target.value })} className={inputCls} />
              </Field>
            </div>
            <Field label="最近更新">
              <input name="updated" autoComplete="off" value={draft.updated} onChange={(e) => up({ updated: e.target.value })} className={inputCls} />
            </Field>
            <Field label="生效日期">
              <input name="effective" autoComplete="off" value={draft.effective} onChange={(e) => up({ effective: e.target.value })} className={inputCls} />
            </Field>
          </div>

          <Field label="开篇语(每行一段)">
            <textarea
              name="intro"
              autoComplete="off"
              value={draft.intro.join("\n")}
              onChange={(e) => up({ intro: e.target.value.split("\n") })}
              rows={4}
              className={inputCls + " resize-y leading-relaxed"}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="一句话原则 · 标题">
              <input
                name="principle-heading"
                autoComplete="off"
                value={draft.principle?.h || ""}
                onChange={(e) => up({ principle: { h: e.target.value, p: draft.principle?.p || "" } })}
                placeholder="(可留空)"
                className={inputCls}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="一句话原则 · 正文">
                <input
                  name="principle-body"
                  autoComplete="off"
                  value={draft.principle?.p || ""}
                  onChange={(e) => up({ principle: { h: draft.principle?.h || "", p: e.target.value } })}
                  placeholder="(可留空)"
                  className={inputCls}
                />
              </Field>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink2">条款小节(正文每行一段;以「- 」开头的行渲染为要点)</span>
              <Btn onClick={() => up({ sections: [...draft.sections, { h: "", p: [""] }] })}>+ 加一节</Btn>
            </div>
            <div className="space-y-3">
              {draft.sections.map((sec, i) => (
                <div key={i} className="rounded-xl border border-edge bg-panel2/40 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <input
                      name="section-heading"
                      autoComplete="off"
                      value={sec.h}
                      onChange={(e) => {
                        const s = [...draft.sections];
                        s[i] = { ...s[i], h: e.target.value };
                        up({ sections: s });
                      }}
                      placeholder={`小节标题 ${i + 1}`}
                      className={inputCls + " flex-1 font-medium"}
                    />
                    <button
                      onClick={() => up({ sections: draft.sections.filter((_, j) => j !== i) })}
                      className="shrink-0 rounded-lg px-2 py-1 text-[12px] text-red-500 transition hover:bg-red-50"
                    >
                      删除
                    </button>
                  </div>
                  <textarea
                    name="section-body"
                    autoComplete="off"
                    value={sec.p.join("\n")}
                    onChange={(e) => {
                      const s = [...draft.sections];
                      s[i] = { ...s[i], p: e.target.value.split("\n") };
                      up({ sections: s });
                    }}
                    rows={Math.max(2, sec.p.length)}
                    className={inputCls + " resize-y leading-relaxed"}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 border-t border-edge pt-4">
            <Btn kind="primary" onClick={save} disabled={busy}>
              {busy ? "保存中…" : "保存并发布"}
            </Btn>
            {current?.overridden && (
              <Btn kind="danger" onClick={() => setResetOpen(true)} disabled={busy}>
                恢复默认
              </Btn>
            )}
          </div>
        </div>
      )}
      {resetOpen && (
        <ConfirmDialog
          title="恢复内置文案"
          danger
          busy={busy}
          confirmLabel="恢复并清除覆盖"
          onCancel={() => setResetOpen(false)}
          onConfirm={() => void reset()}
        >
          当前{active === "agreement" ? "用户协议" : "隐私政策"}的后台自定义内容将被清除，前台会立即恢复为代码内置版本。
        </ConfirmDialog>
      )}
    </div>
  );
}
