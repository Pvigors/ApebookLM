"use client";

import { useEffect, useState } from "react";
import { Section, Field, inputCls, Btn, Skeleton, PageHeader, ConfirmDialog, InlineError } from "@/components/AdminUI";

type ProviderView = {
  baseUrl: string;
  chatModel: string;
  visionModel: string;
  keyMasked: string;
  keySource: string;
};
type GatewayView = {
  enabled: boolean;
  baseUrl: string;
  chatModel: string;
  visionModel: string;
  timeoutMs: string;
  emergencyDirect: boolean;
  keyMasked: string;
  keySource: string;
};
type Data = {
  primary: ProviderView;
  fallback: ProviderView | null;
  gateway: GatewayView;
  ext: Record<string, string>;
  extSource: Record<string, "db" | "env" | "none">;
  quota: { primary: string; fallback: string; gateway: string };
};

const sourceLabel = (source?: "db" | "env" | "none") =>
  source === "db" ? "后台配置" : source === "env" ? "环境变量" : "无";

const PRESETS: Record<string, { baseUrl: string; chatModel: string; visionModel: string }> = {
  阿里云百炼: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    chatModel: "qwen-plus",
    visionModel: "qwen-vl-plus",
  },
  DeepSeek: {
    baseUrl: "https://api.deepseek.com",
    chatModel: "deepseek-chat",
    visionModel: "deepseek-chat",
  },
  Moonshot: {
    baseUrl: "https://api.moonshot.cn/v1",
    chatModel: "moonshot-v1-32k",
    visionModel: "moonshot-v1-32k-vision-preview",
  },
};

function ProviderCard({
  name,
  prefix,
  view,
  onSaved,
}: {
  name: string;
  prefix: "provider.primary" | "provider.fallback";
  view: ProviderView | null;
  onSaved: () => void;
}) {
  const [f, setF] = useState({ baseUrl: "", chatModel: "", visionModel: "", key: "" });
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  useEffect(() => {
    if (view) setF({ baseUrl: view.baseUrl, chatModel: view.chatModel, visionModel: view.visionModel, key: "" });
  }, [view]);

  const save = async () => {
    setBusy(true);
    try {
      const set: Record<string, string> = {
        [`${prefix}.baseUrl`]: f.baseUrl,
        [`${prefix}.chatModel`]: f.chatModel,
        [`${prefix}.visionModel`]: f.visionModel,
      };
      if (f.key.trim()) set[`${prefix}.key`] = f.key.trim();
      const response = await fetch("/api/admin/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ set }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "保存模型配置失败");
      setF((v) => ({ ...v, key: "" }));
      onSaved();
      setTest("已保存,下一次调用即生效(无需重启)");
    } catch (error) {
      setTest(error instanceof Error ? error.message : "保存模型配置失败");
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTest("测试中…");
    const r = await fetch("/api/admin/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: prefix.endsWith("primary") ? "primary" : "fallback" }),
    }).then((x) => x.json());
    setTest(
      r.ok
        ? `连通正常 · ${r.ms}ms · ${r.model}`
        : `失败${r.status ? ` (${r.status})` : ""}:${r.error ?? "未知错误"}`
    );
  };

  return (
    <Section
      title={name}
      desc={
        view
          ? `当前 Key:${view.keyMasked || "未配置"} · 来源:${view.keySource === "db" ? "后台配置" : view.keySource === "env" ? ".env 文件" : "无"}`
          : "未配置(填写后启用)"
      }
      actions={
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(PRESETS).map(([n, p]) => (
            <button
              key={n}
              onClick={() => setF((v) => ({ ...v, ...p }))}
              className="rounded-full border border-edge px-2.5 py-1 text-[11px] text-ink2 transition hover:border-accent hover:text-accent"
            >
              {n}
            </button>
          ))}
        </div>
      }
    >
      <div className="grid max-w-[680px] grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Field label="Base URL">
          <input className={inputCls} name="base-url" autoComplete="off" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder="https://…/v1" />
        </Field>
        <Field label={`API Key(留空保持不变)`}>
          <input className={inputCls} name="api-key" autoComplete="off" type="password" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder={view?.keyMasked || "sk-…"} />
        </Field>
        <Field label="对话模型">
          <input className={inputCls} name="chat-model" autoComplete="off" value={f.chatModel} onChange={(e) => setF({ ...f, chatModel: e.target.value })} />
        </Field>
        <Field label="视觉模型(图片 OCR)">
          <input className={inputCls} name="vision-model" autoComplete="off" value={f.visionModel} onChange={(e) => setF({ ...f, visionModel: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Btn kind="primary" onClick={save} disabled={busy}>保存并热生效</Btn>
        <Btn onClick={runTest}>连通性测试</Btn>
        {test && <span className="min-w-0 truncate text-xs text-ink2">{test}</span>}
      </div>
    </Section>
  );
}

function GatewayCard({ view, onSaved }: { view: GatewayView; onSaved: () => void }) {
  const [form, setForm] = useState({
    baseUrl: "",
    chatModel: "apebook-chat",
    visionModel: "apebook-vision",
    timeoutMs: "240000",
    key: "",
    emergencyDirect: false,
  });
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setForm({
      baseUrl: view.baseUrl,
      chatModel: view.chatModel,
      visionModel: view.visionModel,
      timeoutMs: view.timeoutMs,
      key: "",
      emergencyDirect: view.emergencyDirect,
    });
    setTested(false);
  }, [view]);

  const write = async (set: Record<string, string>) => {
    const response = await fetch("/api/admin/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ set }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "保存网关配置失败");
  };

  const saveDisabled = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const set: Record<string, string> = {
        "provider.gateway.enabled": "0",
        "provider.gateway.baseUrl": form.baseUrl,
        "provider.gateway.chatModel": form.chatModel,
        "provider.gateway.visionModel": form.visionModel,
        "provider.gateway.timeoutMs": form.timeoutMs,
        "provider.gateway.emergencyDirect": form.emergencyDirect ? "1" : "0",
      };
      if (form.key.trim()) set["provider.gateway.key"] = form.key.trim();
      await write(set);
      setForm((current) => ({ ...current, key: "" }));
      setTested(false);
      onSaved();
      setMessage("配置已保存但未启用；请先完成连通性测试");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const testGateway = async () => {
    setMessage("测试中…");
    setTested(false);
    const response = await fetch("/api/admin/providers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "gateway" }),
    });
    const result = await response.json().catch(() => ({}));
    const ok = response.ok && result.ok;
    setTested(ok);
    setMessage(ok
      ? `连通正常 · ${result.ms}ms · ${result.model}`
      : `测试失败:${result.error || result.status || response.status}`);
  };

  const setEnabled = async (enabled: boolean) => {
    if (enabled && !tested) {
      setMessage("启用前必须先通过本页连通性测试");
      return;
    }
    setBusy(true);
    try {
      await write({ "provider.gateway.enabled": enabled ? "1" : "0" });
      onSaved();
      setMessage(enabled ? "网关已启用，下一次模型调用生效" : "网关已停用，已回到现有主备直连链路");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="内网模型网关"
      desc={`状态:${view.enabled ? "已启用" : "未启用"} · Virtual Key:${view.keyMasked || "未配置"} · 来源:${view.keySource === "db" ? "后台配置" : view.keySource === "env" ? ".env 文件" : "无"}`}
    >
      <div className="grid max-w-[680px] grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Field label="Base URL">
          <input className={inputCls} name="gateway-base-url" autoComplete="off" value={form.baseUrl} onChange={(e) => { setForm({ ...form, baseUrl: e.target.value }); setTested(false); }} placeholder="http://litellm-gateway:4000" />
        </Field>
        <Field label="Virtual Key（留空保持不变）">
          <input className={inputCls} name="gateway-key" autoComplete="off" type="password" value={form.key} onChange={(e) => { setForm({ ...form, key: e.target.value }); setTested(false); }} placeholder={view.keyMasked || "sk-…"} />
        </Field>
        <Field label="对话模型别名">
          <input className={inputCls} name="gateway-chat-model" autoComplete="off" value={form.chatModel} onChange={(e) => { setForm({ ...form, chatModel: e.target.value }); setTested(false); }} />
        </Field>
        <Field label="视觉模型别名">
          <input className={inputCls} name="gateway-vision-model" autoComplete="off" value={form.visionModel} onChange={(e) => { setForm({ ...form, visionModel: e.target.value }); setTested(false); }} />
        </Field>
        <Field label="请求超时（毫秒）">
          <input className={inputCls} name="gateway-timeout" autoComplete="off" inputMode="numeric" value={form.timeoutMs} onChange={(e) => { setForm({ ...form, timeoutMs: e.target.value.replace(/\D/g, "") }); setTested(false); }} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink2">
          <input name="gateway-emergency-direct" type="checkbox" checked={form.emergencyDirect} onChange={(e) => setForm({ ...form, emergencyDirect: e.target.checked })} />
          网关进程不可达时允许紧急直连
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Btn kind="primary" onClick={saveDisabled} disabled={busy}>保存配置（不启用）</Btn>
        <Btn onClick={testGateway} disabled={busy}>连通性测试</Btn>
        {!view.enabled ? <Btn onClick={() => setEnabled(true)} disabled={busy || !tested}>启用网关</Btn> : <Btn onClick={() => setEnabled(false)} disabled={busy}>停用网关</Btn>}
        {message && <span className="text-xs text-ink2">{message}</span>}
      </div>
    </Section>
  );
}

export default function ProvidersPage() {
  const [d, setD] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ext, setExt] = useState<Record<string, string>>({});
  const [extMsg, setExtMsg] = useState<string | null>(null);
  const [quota, setQuota] = useState<Record<string, string>>({});
  const [quotaMsg, setQuotaMsg] = useState<string | null>(null);
  const [clearTavily, setClearTavily] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const load = async () => {
    try {
      const response = await fetch("/api/admin/providers");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "外部服务配置加载失败");
      setD(payload as Data);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "外部服务配置加载失败");
    }
  };
  useEffect(() => {
    load();
  }, []);

  const writeSettings = async (payload: { set?: Record<string, string>; del?: string[] }) => {
    const response = await fetch("/api/admin/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({})) as { error?: string; applied?: string[] };
    if (!response.ok) throw new Error(result.error || "保存配置失败");
    return result;
  };

  const saveQuota = async () => {
    const set: Record<string, string> = {};
    const del: string[] = [];
    for (const p of ["primary", "fallback", "gateway"] as const) {
      const v = (quota[p] ?? d?.quota[p] ?? "").trim();
      if (v && /^\d+$/.test(v) && Number(v) > 0) set[`quota.${p}.tokens`] = v;
      else del.push(`quota.${p}.tokens`); // 留空 / 0 = 删除预算(不限额)
    }
    try {
      await writeSettings({ set, del });
      setQuota({});
      await load();
      setQuotaMsg("已保存");
    } catch (error) {
      setQuotaMsg(error instanceof Error ? error.message : "保存预算失败");
    }
  };

  const saveExt = async () => {
    const set: Record<string, string> = {};
    for (const [k, v] of Object.entries(ext)) if (v.trim()) set[k] = v.trim();
    try {
      const response = await fetch("/api/admin/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ set }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setExtMsg(typeof body.error === "string" ? body.error : "保存扩展配置失败");
        return;
      }
      setExt({});
      load();
      setExtMsg("已保存");
    } catch {
      setExtMsg("保存扩展配置失败:网络异常");
    }
  };

  const clearTavilyOverride = async () => {
    setClearBusy(true);
    try {
      const response = await fetch("/api/admin/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ del: ["search.tavily.key"] }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setExtMsg(typeof body.error === "string" ? body.error : "清除 Tavily 后台覆盖失败");
        return;
      }
      setExt((current) => {
        const next = { ...current };
        delete next["search.tavily.key"];
        return next;
      });
      setClearTavily(false);
      load();
      setExtMsg("已清除 Tavily 后台覆盖；如已配置环境变量，将自动回退环境变量");
    } catch {
      setExtMsg("清除 Tavily 后台覆盖失败:网络异常");
    } finally {
      setClearBusy(false);
    }
  };

  const testExt = async (target: string) => {
    setExtMsg(`${target} 测试中…`);
    try {
      const response = await fetch("/api/admin/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const r = await response.json().catch(() => ({}));
      setExtMsg(
        response.ok && r.ok
          ? `${target} 连通正常 · ${r.ms}ms${r.detail ? ` · ${r.detail}` : ""}`
          : `${target} 失败:${r.error ?? r.status ?? response.status}`
      );
    } catch {
      setExtMsg(`${target} 测试失败:网络异常`);
    }
  };

  if (!d && loadError)
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="系统配置" title="模型与外部服务" desc="暂时无法读取外部服务配置。" />
        <InlineError message={loadError} onRetry={() => void load()} />
      </div>
    );
  if (!d)
    return (
      <div className="space-y-8">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-44 w-full rounded-[22px]" />
        <Skeleton className="h-44 w-full rounded-[22px]" />
      </div>
    );

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="系统配置"
        title="模型与外部服务"
        desc="配置主备模型、搜索、语音与演示文稿服务。后台值优先于部署环境，密钥仅显示就绪状态或掩码。"
      />

      <ProviderCard name="主模型(对话 + Studio 生成 + 视觉)" prefix="provider.primary" view={d.primary} onSaved={load} />
      <ProviderCard name="备用模型(主接口限流/故障时自动降级)" prefix="provider.fallback" view={d.fallback} onSaved={load} />
      <GatewayCard view={d.gateway} onSaved={load} />

      <Section
        title="月度 Token 预算 / 用量预警"
        desc="给每个接口设月度 token 上限;近 30 天用量达 80% 在总览置顶预警、100% 标红,以免额度用尽中断服务。留空 / 0 = 不限额。"
      >
        <div className="grid max-w-[680px] grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-3">
          <Field label="主接口月度预算(tokens)">
            <input
              className={inputCls}
              name="monthly-token-budget"
              autoComplete="off"
              inputMode="numeric"
              placeholder="如 5000000,留空不限额"
              value={quota.primary ?? d.quota.primary}
              onChange={(e) => setQuota({ ...quota, primary: e.target.value.replace(/[^0-9]/g, "") })}
            />
          </Field>
          <Field label="备用接口月度预算(tokens)">
            <input
              className={inputCls}
              name="monthly-token-budget"
              autoComplete="off"
              inputMode="numeric"
              placeholder="留空不限额"
              value={quota.fallback ?? d.quota.fallback}
              onChange={(e) => setQuota({ ...quota, fallback: e.target.value.replace(/[^0-9]/g, "") })}
            />
          </Field>
          <Field label="内网网关月度预算(tokens)">
            <input
              className={inputCls}
              name="gateway-monthly-token-budget"
              autoComplete="off"
              inputMode="numeric"
              placeholder="留空不限额"
              value={quota.gateway ?? d.quota.gateway}
              onChange={(e) => setQuota({ ...quota, gateway: e.target.value.replace(/[^0-9]/g, "") })}
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Btn kind="primary" onClick={saveQuota}>保存预算</Btn>
          {quotaMsg && <span className="text-xs text-muted">{quotaMsg}</span>}
        </div>
      </Section>

      <Section title="扩展服务" desc="TTS / 幻灯片模板渲染 / 联网搜索 —— Tavily 为主搜索，少于 3 条或故障时由其余搜索池补充">
        <div className="grid max-w-[680px] grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
          <Field label="TTS 引擎">
            <select
              className={inputCls}
              name="tts-engine"
              autoComplete="off"
              value={ext["tts.engine"] ?? d.ext["tts.engine"] ?? "auto"}
              onChange={(e) => setExt({ ...ext, "tts.engine": e.target.value })}
            >
              <option value="auto">auto(高级音色已配置时优先，否则使用系统语音)</option>
              <option value="system">system(本地离线语音)</option>
              <option value="minimax">minimax(播客级音色)</option>
            </select>
          </Field>
          <Field label={`MiniMax API Key(当前:${d.ext["tts.minimax.key"] || "未配置"})`}>
            <input className={inputCls} name="minimax-key" autoComplete="off" type="password" value={ext["tts.minimax.key"] ?? ""} onChange={(e) => setExt({ ...ext, "tts.minimax.key": e.target.value })} placeholder="填写以覆盖" />
          </Field>
          <Field label={`MiniMax GroupId(当前:${d.ext["tts.minimax.groupId"] || "未配置"})`}>
            <input className={inputCls} name="minimax-group-id" autoComplete="off" value={ext["tts.minimax.groupId"] ?? ""} onChange={(e) => setExt({ ...ext, "tts.minimax.groupId": e.target.value })} placeholder="填写以覆盖" />
          </Field>
          <Field label={`文多多演示文稿密钥（当前：${d.ext["aippt.key"] || "未配置"}）`}>
            <input className={inputCls} name="aippt-key" autoComplete="off" type="password" value={ext["aippt.key"] ?? ""} onChange={(e) => setExt({ ...ext, "aippt.key": e.target.value })} placeholder="填写以覆盖" />
          </Field>
          <Field label={`Tavily 主搜索 Key(当前:${d.ext["search.tavily.key"] || "未配置"} · 来源:${sourceLabel(d.extSource["search.tavily.key"])})`}>
            <input className={inputCls} name="tavily-key" autoComplete="off" type="password" value={ext["search.tavily.key"] ?? ""} onChange={(e) => setExt({ ...ext, "search.tavily.key": e.target.value })} placeholder="tvly-…；配置后作为主搜索" />
          </Field>
          <Field label={`博查搜索 Key(当前:${d.ext["search.bocha.key"] || "未配置"})`}>
            <input className={inputCls} name="bocha-key" autoComplete="off" type="password" value={ext["search.bocha.key"] ?? ""} onChange={(e) => setExt({ ...ext, "search.bocha.key": e.target.value })} placeholder="填写以覆盖" />
          </Field>
          <Field label={`智谱搜索 Key(当前:${d.ext["search.zhipu.key"] || "未配置"})`}>
            <input className={inputCls} name="zhipu-search-key" autoComplete="off" type="password" value={ext["search.zhipu.key"] ?? ""} onChange={(e) => setExt({ ...ext, "search.zhipu.key": e.target.value })} placeholder="填写即加入补充池(bigmodel.cn)" />
          </Field>
          <Field label={`Serper Key(当前:${d.ext["search.serper.key"] || "未配置"})`}>
            <input className={inputCls} name="serper-key" autoComplete="off" type="password" value={ext["search.serper.key"] ?? ""} onChange={(e) => setExt({ ...ext, "search.serper.key": e.target.value })} placeholder="填写即加入补充池(serper.dev,Google 池)" />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Btn kind="primary" onClick={saveExt}>保存扩展配置</Btn>
          <Btn onClick={() => testExt("minimax")}>测 MiniMax</Btn>
          <Btn onClick={() => testExt("tavily")}>测 Tavily</Btn>
          <Btn onClick={() => testExt("bocha")}>测 博查</Btn>
          {d.extSource["search.tavily.key"] === "db" && (
            <Btn onClick={() => setClearTavily(true)}>清除 Tavily 后台覆盖</Btn>
          )}
          {extMsg && <span className="text-xs text-ink2">{extMsg}</span>}
        </div>
      </Section>

      {clearTavily && (
        <ConfirmDialog
          title="清除 Tavily 后台覆盖"
          confirmLabel="确认清除"
          busy={clearBusy}
          onCancel={() => setClearTavily(false)}
          onConfirm={() => void clearTavilyOverride()}
        >
          清除后将不再使用数据库中的 Tavily Key；若部署环境配置了 TAVILY_API_KEY，系统会自动回退该环境变量，否则继续使用现有补充搜索池。
        </ConfirmDialog>
      )}
    </div>
  );
}
