"use client";

import { useCallback, useEffect, useState } from "react";
import { IGroup, IRow, IToggle, Btn, Skeleton, inputCls, selectCls, PageHeader, InlineError } from "@/components/AdminUI";
import { ARTIFACT_TILES } from "@/components/studio-shared";

type Cfg = {
  default_lang: string;
  default_theme: string;
  autoexpand_sources: boolean;
  announcement: string;
  signup_enabled: boolean;
  cad_enabled: boolean;
  hidden_artifacts: string[];
};

export default function AppSettingsPage() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/settings");
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.config) throw new Error(typeof data.error === "string" ? data.error : "应用设置加载失败");
      setCfg(data.config);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "应用设置加载失败");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const up = (p: Partial<Cfg>) => setCfg((c) => (c ? { ...c, ...p } : c));
  // 智能输出可见性:按【磁贴】开关,底层落到该磁贴的全部 kinds。
  // 磁贴「可见」= 它的 kinds 未全部被隐藏;切换 = 整块 隐藏/恢复。
  const hidden = cfg?.hidden_artifacts ?? [];
  const tileOn = (kinds: string[]) => !kinds.every((k) => hidden.includes(k));
  const toggleTile = (kinds: string[]) => {
    const rest = hidden.filter((k) => !kinds.includes(k));
    up({ hidden_artifacts: tileOn(kinds) ? [...rest, ...kinds] : rest });
  };
  const save = async () => {
    if (!cfg) return;
    setBusy(true);
    setMsg(null);
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: cfg }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.config) throw new Error(typeof data.error === "string" ? data.error : "应用设置保存失败");
      setCfg(data.config);
      setMsg({ tone: "ok", text: "已保存" });
      setTimeout(() => setMsg(null), 2000);
    } catch (error) {
      setMsg({ tone: "err", text: error instanceof Error ? error.message : "应用设置保存失败" });
    } finally {
      setBusy(false);
    }
  };

  if (!cfg && loadError)
    return (
      <div className="max-w-2xl space-y-6">
        <PageHeader eyebrow="全站配置" title="应用设置" desc="暂时无法读取应用配置。" />
        <InlineError message={loadError} onRetry={() => void load()} />
      </div>
    );

  if (!cfg)
    return (
      <div className="max-w-2xl space-y-6">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        eyebrow="全站配置"
        title="应用设置"
        desc="管理新用户默认值、功能入口、公告和注册开关，保存后立即对前台生效。"
        actions={msg ? <span className={`text-xs font-medium ${msg.tone === "ok" ? "text-emerald-600" : "text-red-500"}`}>{msg.text}</span> : null}
      />

      <IGroup label="新用户默认" desc="影响新注册用户的初始体验,不改动已有用户的个人设置">
        <IRow
          label="默认主题"
          right={
            <select name="default-theme" value={cfg.default_theme} onChange={(e) => up({ default_theme: e.target.value })} className={selectCls}>
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          }
        />
        <IRow
          label="默认输出语言"
          sub="新会话默认;留空 = 跟随来源语言"
          right={
            <input
              name="default-lang"
              autoComplete="off"
              value={cfg.default_lang}
              onChange={(e) => up({ default_lang: e.target.value })}
              placeholder="跟随来源"
              className="w-40 rounded-xl border border-edge bg-panel2/60 px-3 py-1.5 text-sm text-ink outline-none transition placeholder:text-muted focus:border-accent"
            />
          }
        />
        <IRow
          label="默认展开来源面板"
          right={<IToggle on={cfg.autoexpand_sources} onChange={() => up({ autoexpand_sources: !cfg.autoexpand_sources })} />}
        />
      </IGroup>

      <IGroup label="注册" desc="关闭后,未注册的手机号将无法创建新账号(老用户仍可正常登录)">
        <IRow label="允许新用户注册" right={<IToggle on={cfg.signup_enabled} onChange={() => up({ signup_enabled: !cfg.signup_enabled })} />} />
      </IGroup>

      <IGroup label="CAD 灰度" desc="CAD 使用独立几何内核与 Text2CAD 参数化链路。生产首次部署默认关闭，完成运行时、STEP 回读和下载验收后再开启；关闭时普通用户入口和接口都会被拦截。">
        <IRow
          label="启用 CAD 模型"
          sub="支持受控单零件、多部件概念装配与 Text2CAD；始终不执行用户或模型提供的代码"
          right={<IToggle on={cfg.cad_enabled} onChange={() => up({ cad_enabled: !cfg.cad_enabled })} />}
        />
      </IGroup>

      <IGroup
        label="智能输出可见性"
        desc="控制用户在「生成」里能看到哪些智能输出。关闭后该类型的生成入口对所有用户隐藏,且服务端拦截其生成请求(已生成的历史制品不受影响)。适合某能力临时故障时一键止血。"
      >
        {ARTIFACT_TILES.map((t) => (
          <IRow
            key={t.tile}
            label={t.label}
            right={<IToggle on={tileOn(t.kinds)} onChange={() => toggleTile(t.kinds)} />}
          />
        ))}
      </IGroup>

      <IGroup label="全站公告" desc="填写后在所有用户首页顶部显示一条横幅;留空则不显示">
        <div className="px-4 py-3">
          <textarea
            name="announcement"
            autoComplete="off"
            value={cfg.announcement}
            onChange={(e) => up({ announcement: e.target.value })}
            rows={2}
            maxLength={200}
            placeholder="例如:今晚 22:00 系统维护,可能短暂不可用"
            className={inputCls + " resize-none"}
          />
        </div>
      </IGroup>

      <Btn kind="primary" onClick={save} disabled={busy}>
        {busy ? "保存中…" : "保存设置"}
      </Btn>
    </div>
  );
}
