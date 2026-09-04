"use client";

import { useEffect, useState } from "react";
import { Section, Field, inputCls, Btn, Skeleton, PageHeader, Notice } from "@/components/AdminUI";
import { MANAGED_ENTITLEMENT_TIERS, validPlanOverrideValue } from "@/lib/plans";

type Plan = {
  id: string;
  name: string;
  dailyLimit: number;
  maxNotebooks: number;
  collaboratorLimit: number;
  queuePriority?: number;
  maxFileBytes: number;
};

const MANAGED_TIERS = new Set<string>(MANAGED_ENTITLEMENT_TIERS);

const FIELD_META: { key: string; label: string; hint?: string }[] = [
  { key: "dailyLimit", label: "每日积分", hint: "-1 = 不限量" },
  { key: "maxNotebooks", label: "笔记本数", hint: "-1 = 不限量" },
  { key: "collaboratorLimit", label: "协作席位", hint: "-1 不限 / 0 不支持" },
  { key: "queuePriority", label: "队列优先级", hint: "越大越先生成" },
  { key: "maxFileMB", label: "单文件上限(MB)" },
];

// 从合并后的 plan 取某字段的当前展示值(maxFileMB 由 maxFileBytes 换算)。
const curVal = (p: Plan, key: string): string =>
  key === "maxFileMB"
    ? String(Math.round(p.maxFileBytes / (1024 * 1024)))
    : String((p as unknown as Record<string, number>)[key] ?? 0);

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const response = await fetch("/api/admin/plans");
      const data = await response.json().catch(() => ({})) as { error?: string; plans?: Plan[] };
      if (!response.ok || !Array.isArray(data.plans)) {
        throw new Error(data.error || "权益配置加载失败");
      }
      setPlans(data.plans);
      setEdits({});
    } catch (error) {
      setMsg({ tone: "err", text: error instanceof Error ? error.message : "权益配置加载失败" });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!Object.keys(edits).length) return;
    const invalidKey = Object.entries(edits).find(([key, raw]) => {
      const value = raw.trim();
      if (value === "") return false;
      const field = key.split(".").at(-1) || "";
      return !/^-?\d+$/.test(value) || !validPlanOverrideValue(field, Number(value));
    })?.[0];
    if (invalidKey) {
      setMsg({ tone: "err", text: `请检查无效数值：${invalidKey}` });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const response = await fetch("/api/admin/plans", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ set: edits }),
      });
      const data = await response.json().catch(() => ({})) as {
        ok?: boolean;
        error?: string;
        applied?: string[];
        plans?: Plan[];
      };
      const expectedApplied = Object.entries(edits).map(([key, raw]) => raw.trim() === "" ? `-${key}` : key);
      const applied = new Set(data.applied ?? []);
      if (
        !response.ok ||
        data.ok !== true ||
        !Array.isArray(data.plans) ||
        expectedApplied.some((key) => !applied.has(key))
      ) {
        throw new Error(data.error || "权益配置未完整保存，请检查输入");
      }
      setPlans(data.plans);
      setEdits({});
      setMsg({ tone: "ok", text: "已保存，下一次权益与配额判定即生效（无需重启）" });
      setTimeout(() => setMsg((current) => current?.tone === "ok" ? null : current), 2500);
    } catch (error) {
      setMsg({ tone: "err", text: error instanceof Error ? error.message : "权益配置保存失败" });
    } finally {
      setBusy(false);
    }
  };

  if (loading && !plans)
    return (
      <div className="max-w-3xl space-y-6">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-56 w-full rounded-2xl" />
        <Skeleton className="h-56 w-full rounded-2xl" />
      </div>
    );

  if (!plans) {
    return (
      <div className="max-w-3xl space-y-6">
        <PageHeader eyebrow="权益管理" title="权益与配额" desc="权益配置未能加载。" />
        <Notice tone="err">{msg?.text || "权益配置加载失败"}</Notice>
        <Btn onClick={() => void load()}>重新加载</Btn>
      </div>
    );
  }

  const dirty = Object.keys(edits).length > 0;

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        eyebrow="权益管理"
        title="权益与配额"
        desc="调整每日积分、笔记本、协作、队列与文件限制。清空字段将恢复默认值，-1 表示不限量。"
      />

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {plans.map((p) => {
        const locked = !MANAGED_TIERS.has(p.id);
        return (
          <Section key={p.id} title={p.name} desc={locked ? "内部固定档 · 不可运营覆盖" : `plan_tier = ${p.id}`}>
          <div className="grid max-w-[720px] grid-cols-2 gap-x-4 gap-y-3.5 sm:grid-cols-3">
            {FIELD_META.map((f) => {
              const key = `plan.${p.id}.${f.key}`;
              const displayedValue = edits[key] ?? curVal(p, f.key);
              return (
                <Field key={f.key} label={f.label}>
                  <input
                    className={inputCls}
                    disabled={locked}
                    name={key}
                    autoComplete="off"
                    inputMode="numeric"
                    value={displayedValue}
                    onChange={(e) => {
                      if (!locked) {
                        setEdits({ ...edits, [key]: e.target.value.replace(/[^0-9-]/g, "") });
                      }
                    }}
                  />
                  {f.hint ? <p className="mt-1 text-[11px] text-muted">{f.hint}</p> : null}
                </Field>
              );
            })}
          </div>
          </Section>
        );
      })}

      <div className="flex items-center gap-3">
        <Btn kind="primary" onClick={save} disabled={busy || !dirty}>
          {busy ? "保存中…" : "保存权益配置"}
        </Btn>
        {dirty && <span className="text-xs text-muted">有未保存改动</span>}
      </div>
    </div>
  );
}
