"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyledSelect, type SelectOption } from "@/components/StyledSelect";
import { toast } from "@/components/Toast";

type ModelRole = "chat" | "vision" | "research";
type ModelEntry = { id: string; role: ModelRole; model: string };

type Provider = {
  id: string;
  label: string;
  description: string;
  baseUrl: string;
  defaultChatModel: string;
  defaultVisionModel: string;
  defaultResearchModel: string;
  recommendedModels: readonly string[];
  recommendedModelsByRole: Readonly<Record<ModelRole, readonly string[]>>;
  supportsVision: boolean;
};

type Config = {
  configured: boolean;
  enabled: boolean;
  providerId: string | null;
  chatModel: string;
  visionModel: string;
  researchModel: string;
  keyHint: string | null;
  revision: number;
  testedRevision: number;
  lastTestedAt: number;
  lastTestStatus: string;
  updatedAt: number;
};

type Payload = { encryptionReady: boolean; providers: Provider[]; config: Config };

const ROLE_LABELS: Record<ModelRole, string> = {
  chat: "对话模型",
  vision: "视觉模型",
  research: "研究模型",
};

const ROLE_DESCRIPTIONS: Record<ModelRole, string> = {
  chat: "问答与引用",
  vision: "图片与扫描件",
  research: "规划与综合",
};

const PROVIDER_MARKS: Record<string, string> = {
  dashscope: "QW",
  openai: "AI",
  openrouter: "OR",
  deepseek: "DS",
  kimi: "KM",
  zhipu: "GLM",
  xai: "xAI",
  siliconflow: "SF",
};

const PROVIDER_TONES: Record<string, string> = {
  dashscope: "from-orange-100 via-amber-50 to-white text-orange-600",
  openai: "from-emerald-100 via-teal-50 to-white text-emerald-700",
  openrouter: "from-sky-100 via-blue-50 to-white text-sky-700",
  deepseek: "from-indigo-100 via-violet-50 to-white text-indigo-700",
  kimi: "from-rose-100 via-pink-50 to-white text-rose-700",
  zhipu: "from-cyan-100 via-sky-50 to-white text-cyan-700",
  xai: "from-slate-200 via-slate-50 to-white text-slate-700",
  siliconflow: "from-fuchsia-100 via-purple-50 to-white text-fuchsia-700",
};

const statusLabel: Record<string, string> = {
  ok: "已通过",
  testing: "测试中",
  untested: "待测试",
  disabled: "已停用",
  key_invalid: "密钥无效",
  model_unavailable: "模型不可用",
  rate_limited: "请求受限",
  timeout: "连接超时",
  request_failed: "连接失败",
  missing: "待测试",
};

const roleOptions = (entries: ModelEntry[], current: ModelEntry): SelectOption[] => {
  const used = new Set(entries.filter((entry) => entry.id !== current.id).map((entry) => entry.role));
  return (Object.keys(ROLE_LABELS) as ModelRole[])
    .filter((role) => role === current.role || !used.has(role))
    .map((role) => ({ value: role, label: ROLE_LABELS[role] }));
};

function modelForRole(provider: Provider, role: ModelRole) {
  if (role === "chat") return provider.defaultChatModel;
  if (role === "vision") return provider.defaultVisionModel;
  return provider.defaultResearchModel;
}

function defaultEntries(provider: Provider): ModelEntry[] {
  const secondRole: ModelRole = provider.supportsVision ? "vision" : "research";
  return [
    { id: "chat", role: "chat", model: provider.defaultChatModel },
    { id: secondRole, role: secondRole, model: modelForRole(provider, secondRole) },
  ];
}

function entriesFromConfig(provider: Provider, config: Config): ModelEntry[] {
  if (!config.configured || config.providerId !== provider.id) return defaultEntries(provider);
  const entries: ModelEntry[] = [{ id: "chat", role: "chat", model: config.chatModel || provider.defaultChatModel }];
  if (config.visionModel) entries.push({ id: "vision", role: "vision", model: config.visionModel });
  if (config.researchModel) entries.push({ id: "research", role: "research", model: config.researchModel });
  return entries;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
}

function ModelPicker({ value, onChange, options, ariaLabel }: {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const choices = useMemo(
    () => [...new Set([value, ...options].map((item) => item.trim()).filter(Boolean))],
    [options, value]
  );

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <div className={`flex h-11 overflow-hidden rounded-xl border bg-panel transition ${open ? "border-accent ring-2 ring-accent/10" : "border-edge"}`}>
        <input
          value={value}
          onChange={(event) => { onChange(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          name={`model-${ariaLabel}`}
          aria-label={ariaLabel}
          autoComplete="off"
          maxLength={128}
          spellCheck={false}
          placeholder="输入或选择模型名称"
          className="min-w-0 flex-1 bg-transparent px-3.5 text-[13.5px] font-medium not-italic text-ink outline-none"
        />
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-label={`${ariaLabel}候选列表`}
          aria-expanded={open}
          className="grid w-11 shrink-0 place-items-center border-l border-edge text-muted transition hover:bg-panel2 hover:text-ink"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>
      </div>
      {open && choices.length > 0 && (
        <div role="listbox" aria-label={`${ariaLabel}候选模型`} className="absolute left-0 right-0 z-40 mt-2 max-h-52 overflow-auto rounded-xl border border-edge bg-panel p-1.5 shadow-[0_16px_40px_-12px_rgba(20,22,40,0.24)]">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              role="option"
              aria-selected={choice === value}
              onClick={() => { onChange(choice); setOpen(false); }}
              className={`block w-full truncate rounded-lg px-3 py-2.5 text-left text-[13px] font-medium not-italic transition ${choice === value ? "bg-accentSoft text-accent" : "text-ink hover:bg-panel2"}`}
            >
              {choice}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderPreview({ provider, selected, onSelect }: { provider: Provider; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`w-[124px] shrink-0 snap-start scroll-mx-1.5 rounded-xl border-2 bg-panel p-1 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${selected ? "border-accent" : "border-edge hover:border-accent/35"}`}
    >
      <span className={`relative flex aspect-[16/9] overflow-hidden rounded-lg bg-gradient-to-br ${PROVIDER_TONES[provider.id] ?? "from-slate-100 to-white text-slate-600"}`}>
        <span className="absolute -right-3 -top-5 h-16 w-16 rounded-full border-[12px] border-current opacity-15" />
        <span className="absolute -bottom-3 left-2 h-8 w-16 rounded-full border-[7px] border-current opacity-15" />
        <span className="m-2 grid h-7 min-w-8 place-items-center rounded-lg bg-white/85 px-1.5 text-[11px] font-bold not-italic shadow-sm">
          {PROVIDER_MARKS[provider.id] ?? provider.label.slice(0, 2)}
        </span>
        {selected && (
          <span className="absolute bottom-2 right-2 grid h-5 w-5 place-items-center rounded-full bg-accent text-white shadow-sm" aria-hidden>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
          </span>
        )}
      </span>
      <span className="block truncate px-1.5 pb-1 pt-2 text-[12px] font-semibold not-italic text-ink">{provider.label}</span>
    </button>
  );
}

export default function ModelApiSettings() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [providerId, setProviderId] = useState("dashscope");
  const [entries, setEntries] = useState<ModelEntry[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<"test" | "disable" | "delete" | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [loadError, setLoadError] = useState("");
  const operationRef = useRef(false);
  const providerStripRef = useRef<HTMLDivElement>(null);
  const [providerScroll, setProviderScroll] = useState({ left: false, right: false });

  const syncProviderScroll = useCallback(() => {
    const strip = providerStripRef.current;
    if (!strip) return;
    const next = {
      left: strip.scrollLeft > 1,
      right: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2,
    };
    setProviderScroll((current) => current.left === next.left && current.right === next.right ? current : next);
  }, []);

  const scrollProviders = (direction: -1 | 1) => {
    const strip = providerStripRef.current;
    if (!strip) return;
    strip.scrollBy({
      left: direction * Math.max(264, Math.round(strip.clientWidth * 0.75)),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  const hydrate = useCallback((data: Payload) => {
    setPayload(data);
    setLoadError("");
    const selected = data.providers.find((provider) => provider.id === data.config.providerId) ?? data.providers[0];
    if (selected) {
      setProviderId(selected.id);
      setEntries(entriesFromConfig(selected, data.config));
    }
    setApiKey("");
    setShowKey(false);
  }, []);

  const reload = useCallback(async () => {
    const response = await fetch("/api/model-config", { cache: "no-store" });
    if (!response.ok) throw new Error(await readError(response, "模型配置加载失败"));
    hydrate(await response.json() as Payload);
  }, [hydrate]);

  useEffect(() => {
    let alive = true;
    fetch("/api/model-config", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response, "模型配置加载失败"));
        return response.json() as Promise<Payload>;
      })
      .then((data) => { if (alive) hydrate(data); })
      .catch((error) => {
        if (!alive) return;
        const message = error instanceof Error ? error.message : "模型配置加载失败";
        setLoadError(message);
        toast(message, "error");
      });
    return () => { alive = false; };
  }, [hydrate]);

  useEffect(() => {
    const revealSelected = () => {
      const strip = providerStripRef.current;
      const selected = strip?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
      if (strip && selected) {
        if (selected === strip.firstElementChild) {
          strip.scrollTo({ left: 0 });
        } else {
          const gutter = 6;
          const stripRect = strip.getBoundingClientRect();
          const selectedRect = selected.getBoundingClientRect();
          if (selectedRect.left < stripRect.left + gutter) {
            strip.scrollBy({ left: selectedRect.left - stripRect.left - gutter });
          } else if (selectedRect.right > stripRect.right - gutter) {
            strip.scrollBy({ left: selectedRect.right - stripRect.right + gutter });
          }
        }
      }
      syncProviderScroll();
    };
    revealSelected();
    const timer = window.setTimeout(revealSelected, 0);
    window.addEventListener("resize", syncProviderScroll);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", syncProviderScroll);
    };
  }, [payload?.providers.length, providerId, syncProviderScroll]);

  const provider = useMemo(
    () => payload?.providers.find((item) => item.id === providerId) ?? null,
    [payload, providerId]
  );
  const providerChanged = Boolean(payload?.config.providerId && payload.config.providerId !== providerId);
  const rolesUsed = useMemo(() => new Set(entries.map((entry) => entry.role)), [entries]);
  const addableRoles = useMemo(() => {
    if (!provider) return [] as ModelRole[];
    return (["research", ...(provider.supportsVision ? ["vision"] : [])] as ModelRole[])
      .filter((role) => !rolesUsed.has(role));
  }, [provider, rolesUsed]);

  const chooseProvider = (next: Provider) => {
    if (next.id === providerId) return;
    setProviderId(next.id);
    setEntries(defaultEntries(next));
    setApiKey("");
    setShowKey(false);
  };

  const updateEntry = (id: string, patch: Partial<Pick<ModelEntry, "role" | "model">>) => {
    if (!provider) return;
    setEntries((current) => current.map((entry) => {
      if (entry.id !== id) return entry;
      if (patch.role && patch.role !== entry.role) {
        return { ...entry, role: patch.role, model: modelForRole(provider, patch.role) };
      }
      return { ...entry, ...patch };
    }));
  };

  const addModel = () => {
    if (!provider || addableRoles.length === 0) return;
    const role = addableRoles[0];
    setEntries((current) => [...current, { id: `${role}-${Date.now()}`, role, model: modelForRole(provider, role) }]);
  };

  const removeEntry = (id: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
  };

  const saveAndTest = async () => {
    if (operationRef.current) return;
    if (!payload?.encryptionReady) {
      toast("服务端尚未配置个人密钥加密能力", "error");
      return;
    }
    const uniqueRoles = new Set(entries.map((entry) => entry.role));
    const chat = entries.find((entry) => entry.role === "chat");
    if (uniqueRoles.size !== entries.length) {
      toast("每种模型用途只能配置一次", "error");
      return;
    }
    if (!chat?.model.trim()) {
      toast("请配置对话模型", "error");
      return;
    }
    if (entries.some((entry) => !entry.model.trim())) {
      toast("请填写全部已添加的模型名称", "error");
      return;
    }
    if ((!payload.config.configured || providerChanged) && !apiKey.trim()) {
      toast(providerChanged ? "切换供应商需要输入新的 API Key" : "请输入供应商 API Key", "error");
      return;
    }

    operationRef.current = true;
    setBusy("test");
    try {
      const visionModel = entries.find((entry) => entry.role === "vision")?.model.trim() ?? "";
      const researchModel = entries.find((entry) => entry.role === "research")?.model.trim() ?? "";
      const response = await fetch("/api/model-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          chatModel: chat.model.trim(),
          visionModel,
          researchModel,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "模型配置保存失败"));
      hydrate(await response.json() as Payload);
      const tested = await fetch("/api/model-config/test", { method: "POST" });
      if (!tested.ok) throw new Error(await readError(tested, "连接测试失败"));
      await reload();
      toast("全部模型连接通过，个人模型接口已启用");
    } catch (error) {
      setApiKey("");
      await reload().catch(() => {});
      toast(error instanceof Error ? error.message : "模型配置操作失败", "error");
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  const disable = async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy("disable");
    try {
      const response = await fetch("/api/model-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      if (!response.ok) throw new Error(await readError(response, "停用失败"));
      hydrate(await response.json() as Payload);
      toast("个人模型接口已停用");
    } catch (error) {
      toast(error instanceof Error ? error.message : "停用失败", "error");
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  const remove = async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy("delete");
    try {
      const response = await fetch("/api/model-config", { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response, "删除失败"));
      hydrate(await response.json() as Payload);
      setDeleteConfirm(false);
      toast("个人模型密钥已删除");
    } catch (error) {
      toast(error instanceof Error ? error.message : "删除失败", "error");
    } finally {
      operationRef.current = false;
      setBusy(null);
    }
  };

  if (loadError && !payload) {
    return (
      <div className="rounded-2xl border border-edge bg-panel2/35 px-4 py-8 text-center">
        <p className="text-[13px] text-ink2">{loadError}</p>
        <button type="button" onClick={() => { setLoadError(""); reload().catch((error) => setLoadError(error instanceof Error ? error.message : "模型配置加载失败")); }} className="mt-3 rounded-xl border border-edge bg-panel px-4 py-2 text-[12.5px] font-medium text-accent transition hover:bg-panel2">重新加载</button>
      </div>
    );
  }

  if (!payload) {
    return <div className="rounded-2xl bg-panel2/45 px-4 py-10 text-center text-[13px] text-muted">正在读取模型配置…</div>;
  }

  const configModels = { chat: payload.config.chatModel, vision: payload.config.visionModel, research: payload.config.researchModel };
  const draftMatchesConfig = payload.config.providerId === providerId && entries.every(
    (entry) => configModels[entry.role] === entry.model.trim()
  ) && (Object.keys(configModels) as ModelRole[]).every(
    (role) => !configModels[role] || entries.some((entry) => entry.role === role)
  );
  const rowStatus = draftMatchesConfig ? (payload.config.enabled ? "ok" : payload.config.lastTestStatus) : "untested";
  return (
    <div className="font-sans not-italic min-[820px]:h-full min-[820px]:overflow-y-auto min-[820px]:pr-1">
      <div className="space-y-3">
      <div>
        <div className="mb-2.5 flex items-center gap-3">
          <p className="text-[13px] font-medium text-ink2">选择供应商</p>
        </div>
        <div data-provider-carousel className="grid grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-1.5 rounded-2xl border border-edge bg-panel p-2">
          <button
            type="button"
            aria-label="向左滚动供应商"
            aria-controls="model-provider-strip"
            onClick={() => scrollProviders(-1)}
            disabled={!providerScroll.left}
            className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-panel text-ink2 transition hover:border-accent/35 hover:bg-panel2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-30"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <div
            ref={providerStripRef}
            id="model-provider-strip"
            data-provider-strip
            data-provider-scroll-viewport
            role="radiogroup"
            aria-label="模型供应商"
            onScroll={syncProviderScroll}
            className="relative flex snap-x snap-mandatory scroll-px-1.5 gap-2 overflow-x-auto scroll-smooth px-1.5 py-1 motion-reduce:scroll-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {payload.providers.map((item) => (
              <ProviderPreview key={item.id} provider={item} selected={providerId === item.id} onSelect={() => chooseProvider(item)} />
            ))}
          </div>
          <button
            type="button"
            aria-label="向右滚动供应商"
            aria-controls="model-provider-strip"
            onClick={() => scrollProviders(1)}
            disabled={!providerScroll.right}
            className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-panel text-ink2 transition hover:border-accent/35 hover:bg-panel2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-30"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </div>
      </div>

      <div data-model-config-stack className="grid grid-cols-1 items-stretch">
        <section data-model-config-card data-model-config-shell className="flex flex-col rounded-2xl border border-edge bg-panel p-4">
          <div data-model-api-key-section data-model-config-key>
          <div className="min-w-0 border-b border-edge/70 pb-3">
            <p className="text-[15px] font-semibold text-ink">{provider?.label ?? "模型供应商"}</p>
            <p className="mt-1 truncate whitespace-nowrap text-[12px] text-muted" title={provider?.description}>{provider?.description}</p>
          </div>
          <label className="mt-4 block">
            <span className="mb-1.5 flex items-center justify-between text-[12.5px] text-ink2"><span>{provider?.label ?? "供应商"} API Key</span><span className="text-[11px] text-muted">保存后不再显示</span></span>
            <span className="flex h-11 overflow-hidden rounded-xl border border-edge bg-panel transition focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10">
              <input name="model-api-key" type={showKey ? "text" : "password"} autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} maxLength={512} placeholder={providerChanged ? "切换供应商需输入新的 API Key" : payload.config.keyHint ? `${payload.config.keyHint} · 留空保留原密钥` : "输入供应商 API Key"} className="min-w-0 flex-1 bg-transparent px-3.5 text-[13.5px] not-italic text-ink outline-none" />
              <button type="button" onClick={() => setShowKey((current) => !current)} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} className="shrink-0 border-l border-edge px-3 text-[12px] font-medium text-accent transition hover:bg-panel2">{showKey ? "隐藏" : "显示"}</button>
            </span>
          </label>
          <p className="mt-3 text-[11.5px] leading-relaxed text-muted">API 地址自动匹配；Key 仅提交到猿笔记服务端，并使用认证加密保存。</p>
          </div>

          <div data-model-roles-section data-model-config-models className="mt-4 border-t border-edge/70 pt-4">
          <div className="flex items-start justify-between gap-3 border-b border-edge/70 pb-3">
            <div><p className="text-[15px] font-semibold text-ink">模型配置</p><p className="mt-1 text-[12px] text-muted">默认 2 个，一个 Key 可配置多个模型</p></div>
            <span className={`rounded-full px-2 py-1 text-[10.5px] font-medium ${rowStatus === "ok" ? "bg-green-500/10 text-green-600" : rowStatus === "untested" || rowStatus === "missing" ? "bg-orange-500/10 text-orange-600" : "bg-red-500/10 text-red-600"}`}>{statusLabel[rowStatus] ?? "待测试"}</span>
          </div>
          <div className="mt-3 space-y-2.5">
            {entries.map((entry, index) => {
              const options = roleOptions(entries, entry).filter((option) => option.value !== "vision" || provider?.supportsVision || entry.role === "vision");
              return (
                <div key={entry.id} className="grid min-w-0 grid-cols-[96px_minmax(0,1fr)_28px] items-center gap-2 max-[480px]:grid-cols-[minmax(0,1fr)_28px]">
                  <div className="w-[96px] shrink-0 max-[480px]:col-span-2 max-[480px]:w-full">
                    {entry.role === "chat" ? (
                      <div className="flex h-11 w-full items-center rounded-xl border border-edge bg-panel px-3 text-[12.5px] font-medium text-ink2">{ROLE_LABELS.chat}</div>
                    ) : (
                      <StyledSelect value={entry.role} onChange={(role) => updateEntry(entry.id, { role: role as ModelRole })} options={options} triggerClassName="h-11 w-full justify-between rounded-xl bg-panel px-3 text-[12.5px]" menuAlign="left" ariaLabel={`第 ${index + 1} 个模型用途`} />
                    )}
                  </div>
                  <ModelPicker value={entry.model} onChange={(model) => updateEntry(entry.id, { model })} options={provider?.recommendedModelsByRole?.[entry.role] ?? provider?.recommendedModels ?? []} ariaLabel={ROLE_LABELS[entry.role]} />
                  {entry.role === "chat" ? <span className="w-7 shrink-0" aria-hidden /> : <button type="button" onClick={() => removeEntry(entry.id)} aria-label={`删除${ROLE_LABELS[entry.role]}`} className="grid h-8 w-7 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-panel2 hover:text-red-500"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg></button>}
                  <span className="sr-only">{ROLE_DESCRIPTIONS[entry.role]}</span>
                </div>
              );
            })}
          </div>
          {addableRoles.length > 0 && <button type="button" onClick={addModel} className="mt-3 flex h-9 w-full items-center justify-center rounded-xl border border-dashed border-edge text-[12.5px] font-medium text-accent transition hover:border-accent/50 hover:bg-accentSoft/40">＋ 添加模型配置</button>}
          </div>
          <div data-model-config-footer className="mt-4 shrink-0 border-t border-edge/70 pt-3">
            <div className="flex w-full flex-wrap justify-end gap-2">
              {payload.config.configured && !deleteConfirm && <button type="button" onClick={() => setDeleteConfirm(true)} className="rounded-xl px-3 py-2 text-[12px] text-red-500 transition hover:bg-red-500/5 hover:text-red-600">删除配置</button>}
              {payload.config.enabled && <button type="button" onClick={disable} disabled={!!busy} className="rounded-xl border border-edge px-4 py-2 text-[13px] text-ink2 transition hover:bg-panel2 disabled:opacity-50">{busy === "disable" ? "停用中…" : "停用"}</button>}
              <button type="button" onClick={saveAndTest} disabled={!!busy} className="min-w-[116px] rounded-xl bg-accent px-5 py-2 text-[13.5px] font-medium text-onAccent shadow-[0_10px_24px_-14px_rgba(93,74,255,0.9)] transition hover:brightness-110 disabled:opacity-50">{busy === "test" ? "确认中…" : "确认"}</button>
            </div>
            {payload.config.configured && deleteConfirm && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-500/5 px-4 py-3">
                <p className="text-[12px] text-red-600">删除后，排队中的个人模型任务会停止并退回积分。</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setDeleteConfirm(false)} className="rounded-lg px-3 py-1.5 text-[12px] text-ink2">取消</button>
                  <button type="button" onClick={remove} disabled={!!busy} className="rounded-lg bg-red-500 px-3 py-1.5 text-[12px] text-white disabled:opacity-50">{busy === "delete" ? "删除中…" : "确认删除"}</button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
      </div>
    </div>
  );
}
