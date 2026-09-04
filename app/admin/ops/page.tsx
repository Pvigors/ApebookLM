"use client";

import { useCallback, useEffect, useState } from "react";
import { Section, Btn, StatCard, Skeleton, fmtBytes, PageHeader, Notice, ConfirmDialog } from "@/components/AdminUI";

type OpsInfo = {
  database: { engine: "PostgreSQL"; sizeBytes: number };
  backup: { mode: "external"; inApp: false; database: string; media: string };
  stuck: number;
  staleMs: number;
  logRows: number;
};

export default function OpsPage() {
  const [info, setInfo] = useState<OpsInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" | "muted" } | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: string; title: string; body: string; danger?: boolean } | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/ops");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "运维状态加载失败");
      setInfo(data as OpsInfo);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "运维状态加载失败");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: string) => {
    setMsg({ text: "执行中…", tone: "muted" });
    try {
      const response = await fetch("/api/admin/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const r = await response.json().catch(() => ({}));
      if (!response.ok || r.ok !== true) throw new Error(typeof r.error === "string" ? r.error : "操作失败");
      if (action === "export_settings") {
        setExported(JSON.stringify(r.settings, null, 2));
        setMsg({ text: "已导出(敏感值已脱敏)", tone: "ok" });
      } else {
        setMsg({ text: `完成${typeof r.recovered === "number" ? ` · 回收 ${r.recovered} 个失联任务` : ""}${typeof r.deleted === "number" ? ` · 调用日志 ${r.deleted} 行` : ""}${typeof r.audit === "number" ? ` · 活动记录 ${r.audit} 行` : ""}`, tone: "ok" });
      }
    } catch (error) {
      setMsg({ text: error instanceof Error ? error.message : "操作失败", tone: "err" });
    }
    void load();
    setPending(null);
  };

  if (!info && loadError)
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="系统维护" title="系统运维" desc="暂时无法读取运维状态。" />
        <Notice tone="err">
          <div className="flex flex-wrap items-center gap-3">
            <span>{loadError}</span>
            <Btn onClick={() => void load()}>重新加载</Btn>
          </div>
        </Notice>
      </div>
    );

  if (!info)
    return (
      <div className="space-y-8">
        <Skeleton className="h-7 w-40" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-40 w-full rounded-[22px]" />
      </div>
    );

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="系统维护" title="系统运维" desc="处理失联任务、日志和 PostgreSQL 维护；备份由部署侧 pg_dump 与媒体同步脚本执行，后台不伪装成备份控制台。" />
      {msg && <Notice tone={msg.tone === "muted" ? "info" : msg.tone}>{msg.text}</Notice>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="失联运行任务" value={info.stuck} tone={info.stuck > 0 ? "warn" : "ok"} sub={`运行中超过 ${Math.round(info.staleMs / 1000)} 秒无心跳`} />
        <StatCard label="调用日志行数" value={info.logRows.toLocaleString()} sub="模型调用日志保留 7 天" />
        <StatCard label="PostgreSQL 数据量" value={fmtBytes(info.database.sizeBytes)} sub="由 pg_database_size 实时读取" />
      </div>

      <Section title="任务与日志">
        <div className="flex flex-wrap gap-2">
          <Btn kind="primary" onClick={() => setPending({ action: "clear_stuck", title: "回收失联任务", body: `仅处理运行中且超过 ${Math.round(info.staleMs / 1000)} 秒无心跳的任务，沿用任务代次与积分退回保护；正常排队任务不会被清理。` })}>
            回收失联任务
          </Btn>
          <Btn onClick={() => setPending({ action: "purge_logs", title: "清理过期日志", body: "将永久删除 7 天前的模型调用日志和 90 天前的用户活动记录；管理操作会长期保留。", danger: true })}>清理过期日志</Btn>
        </div>
      </Section>

      <Section title="PostgreSQL 与备份" desc="应用后台只提供安全维护入口；数据库和媒体备份由部署环境统一调度并在外部存储中留存">
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-edge bg-panel2/60 p-4">
            <p className="text-sm font-medium text-ink">数据库备份</p>
            <p className="mt-1 text-xs leading-5 text-muted">{info.backup.database}</p>
          </div>
          <div className="rounded-2xl border border-edge bg-panel2/60 p-4">
            <p className="text-sm font-medium text-ink">媒体备份</p>
            <p className="mt-1 text-xs leading-5 text-muted">{info.backup.media}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => setPending({ action: "vacuum", title: "执行 PostgreSQL VACUUM", body: "VACUUM 可在线回收可复用空间，但会增加磁盘 I/O；请避开业务高峰。它不等同于备份，也不会缩小所有物理文件。" })}>执行 VACUUM</Btn>
          <Btn onClick={() => run("export_settings")}>导出脱敏配置</Btn>
        </div>
      </Section>

      {exported && (
        <Section title="后台配置导出" desc="密钥与敏感字段已脱敏，可安全用于排查问题">
          <pre className="max-h-[280px] overflow-auto rounded-xl bg-panel2 p-4 font-mono text-[11.5px] leading-relaxed text-ink2">{exported}</pre>
        </Section>
      )}
      {pending && (
        <ConfirmDialog
          title={pending.title}
          danger={pending.danger}
          busy={msg?.tone === "muted"}
          onCancel={() => setPending(null)}
          onConfirm={() => void run(pending.action)}
        >
          {pending.body}
        </ConfirmDialog>
      )}
    </div>
  );
}
