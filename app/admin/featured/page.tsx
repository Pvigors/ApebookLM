"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Section, Pill, Btn, Modal, Field, StatCard, inputCls, ago, PageHeader, Notice, ReadOnlyNotice } from "@/components/AdminUI";
import { useAdminAccess } from "@/components/AdminAccess";
import { KIND_LABEL } from "@/components/studio-shared";

// ---------------------------------------------------------------------------
// 精选管理(策展台)。对齐 NotebookLM 编辑部模型:每本精选 = 封面 + 出版方品牌 +
// 分类 + 编者按 + 预生成制品的「出版物」。此页管:上/下架、排序、门面元数据。
// ---------------------------------------------------------------------------

type FeaturedNb = {
  id: string;
  title: string;
  emoji: string;
  public: number;
  featured_order: number;
  created_at: number;
  cover: string | null;
  publisher: string | null;
  publisher_avatar: string | null;
  featured_category: string | null;
  summary: string | null;
  owner: string | null;
  sources: number;
  outputs: number;
  favorites: number;
  active_jobs: number;
};

// 策展台可统一预生成的类型(与 API 白名单一致);中文名走 KIND_LABEL 全局唯一副本。
const GEN_KINDS = [
  "audio", "video", "mindmap", "quiz", "flashcards", "infographic",
  "slides", "study_guide", "briefing", "faq", "timeline", "table", "xhs", "drawviso",
] as const;
type Candidate = {
  id: string;
  title: string;
  emoji: string;
  public: number;
  owner: string | null;
  sources: number;
  outputs: number;
};

const DEFAULT_COVER = "linear-gradient(135deg,#6d5ae6 0%,#9a7cf0 52%,#b765ec 100%)";
// 封面渐变预设(首个=品牌紫,与种子精选一致)。
const COVER_PRESETS: { label: string; value: string }[] = [
  { label: "品牌紫", value: DEFAULT_COVER },
  { label: "深紫蓝", value: "linear-gradient(135deg,#4f46e5,#7c3aed)" },
  { label: "蓝紫", value: "linear-gradient(135deg,#0ea5e9,#6366f1)" },
  { label: "青绿", value: "linear-gradient(135deg,#059669,#14b8a6)" },
  { label: "橙红", value: "linear-gradient(135deg,#f59e0b,#ef4444)" },
  { label: "粉紫", value: "linear-gradient(135deg,#ec4899,#8b5cf6)" },
  { label: "墨黑", value: "linear-gradient(135deg,#111827,#374151)" },
];

/** 封面缩略预览:渐变 + emoji,和首页精选卡同构的迷你版。 */
function CoverThumb({ cover, emoji, size = "lg" }: { cover: string | null; emoji: string; size?: "lg" | "sm" }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-xl text-white ${
        size === "lg" ? "h-14 w-24 text-xl" : "h-8 w-8 rounded-lg text-sm"
      }`}
      style={{ background: cover || DEFAULT_COVER }}
    >
      {emoji}
    </span>
  );
}

type EditState = {
  id: string;
  title: string;
  cover: string;
  publisher: string;
  publisherAvatar: string;
  category: string;
  note: string;
};

export default function AdminFeaturedPage() {
  const { canWrite } = useAdminAccess("featured");
  const [featured, setFeatured] = useState<FeaturedNb[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [removing, setRemoving] = useState<FeaturedNb | null>(null);
  // 统一生成:目标笔记本 + 勾选的类型
  const [genFor, setGenFor] = useState<FeaturedNb | null>(null);
  const [genKinds, setGenKinds] = useState<Set<string>>(new Set());
  // 添加精选:搜索候选
  const [addQ, setAddQ] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<Candidate | null>(null); // 私有候选的公开警示确认

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/featured");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "加载失败,请重试");
      setFeatured(payload.featured ?? []);
    } catch (error) {
      setMsg({ text: error instanceof Error ? error.message : "加载失败,请重试", tone: "err" });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // 有在途生成任务时每 5s 轮询刷新(任务完成 outputs/active_jobs 联动),清零自动停。
  useEffect(() => {
    if (!featured.some((f) => Number(f.active_jobs) > 0)) return;
    const t = setInterval(() => load(), 5000);
    return () => clearInterval(t);
  }, [featured, load]);

  // 候选搜索(防抖 300ms)。
  useEffect(() => {
    const q = addQ.trim();
    if (!q) {
      setCandidates([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/admin/featured?q=${encodeURIComponent(q)}`);
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || "候选搜索失败");
          setCandidates(payload.candidates ?? []);
        } catch (error) {
          setCandidates([]);
          setMsg({ text: error instanceof Error ? error.message : "候选搜索失败", tone: "err" });
        } finally {
          setSearching(false);
        }
      })();
    }, 300);
    return () => clearTimeout(t);
  }, [addQ]);

  const act = async (body: Record<string, unknown>, okText?: string) => {
    if (!canWrite) return false;
    setBusy(true);
    try {
      const r = await fetch("/api/admin/featured", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ text: d.error || "操作失败", tone: "err" });
        return false;
      }
      if (okText) setMsg({ text: okText, tone: "ok" });
      await load();
      return true;
    } catch (error) {
      setMsg({ text: error instanceof Error ? error.message : "操作失败:网络异常", tone: "err" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // 既有分类(编辑弹窗 datalist 建议)。
  const knownCats = useMemo(
    () => Array.from(new Set(featured.map((f) => f.featured_category).filter(Boolean))) as string[],
    [featured]
  );
  const favTotal = featured.reduce((s, f) => s + Number(f.favorites || 0), 0);

  const openEdit = (n: FeaturedNb) =>
    setEditing({
      id: n.id,
      title: n.title,
      cover: n.cover || DEFAULT_COVER,
      publisher: n.publisher || "",
      publisherAvatar: n.publisher_avatar || "",
      category: n.featured_category || "",
      note: n.summary || "",
    });

  const saveEdit = async () => {
    if (!editing) return;
    const ok = await act(
      {
        action: "meta",
        notebookId: editing.id,
        cover: editing.cover.trim() || null,
        publisher: editing.publisher.trim() || null,
        publisherAvatar: editing.publisherAvatar.trim() || null,
        category: editing.category.trim() || null,
        note: editing.note.trim() || null,
      },
      "已保存门面信息"
    );
    if (ok) setEditing(null);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="内容运营"
        title="精选管理"
        desc="策展首页精选画廊，统一管理封面、出版方、分类、编者按、展示顺序与预生成内容。"
      />

      {!canWrite && (
        <ReadOnlyNotice>当前角色可查看精选画廊与门面状态，排序、生成、编辑和上下架操作已隐藏。</ReadOnlyNotice>
      )}

      {msg && (
        <Notice tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Notice>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="精选笔记本" value={featured.length} />
        <StatCard label="累计收藏" value={favTotal} sub="所有用户对精选的收藏总数" />
        <StatCard label="分类数" value={knownCats.length} />
        <StatCard
          label="预生成制品"
          value={featured.reduce((s, f) => s + Number(f.outputs || 0), 0)}
          sub="访客零成本即得的内容"
        />
      </div>

      {/* ---- 画廊 ---- */}
      <Section
        title={`精选画廊(${featured.length})`}
        desc="排序即首页展示顺序;「预览」以访客视角打开分享页;撤精选不撤公开(在外流通的分享链接不断)"
      >
        {loading ? (
          <p className="py-8 text-center text-sm text-muted">加载中…</p>
        ) : featured.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            {canWrite ? "还没有精选笔记本 —— 在下方「添加精选」里搜索一本开始策展。" : "当前还没有精选笔记本。"}
          </p>
        ) : (
          <ul className="divide-y divide-edge">
            {featured.map((n, i) => (
              <li key={n.id} className="flex flex-wrap items-center gap-3 py-3">
                <CoverThumb cover={n.cover} emoji={n.emoji} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-ink">{n.title}</span>
                    {n.featured_category ? (
                      <Pill text={n.featured_category} tone="info" />
                    ) : (
                      <Pill text="未分类" tone="muted" />
                    )}
                    {!n.public && <Pill text="⚠ 未公开" tone="warn" />}
                    {Number(n.active_jobs) > 0 && <Pill text={`生成中 ${n.active_jobs}`} tone="warn" />}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {n.publisher_avatar || "✨"} {n.publisher || "未设出版方"} · {n.sources} 来源 ·{" "}
                    {n.outputs} 制品 · ★ {n.favorites} 收藏 · {ago(n.created_at)}
                    {n.owner ? ` · 属主 ${n.owner}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {canWrite && <Btn disabled={i === 0 || busy} onClick={() => act({ action: "move", notebookId: n.id, dir: "up" })}>↑</Btn>}
                  {canWrite && <Btn disabled={i === featured.length - 1 || busy} onClick={() => act({ action: "move", notebookId: n.id, dir: "down" })}>↓</Btn>}
                  <a
                    href={`/share/${n.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center whitespace-nowrap rounded-xl border border-edge bg-panel px-3.5 py-1.5 text-[13px] font-medium text-ink2 transition hover:border-accent/50 hover:text-accent"
                  >
                    预览
                  </a>
                  {canWrite && <Btn
                    disabled={busy}
                    onClick={() => {
                      setGenKinds(new Set());
                      setGenFor(n);
                    }}
                  >
                    生成
                  </Btn>}
                  {canWrite && <Btn disabled={busy} onClick={() => openEdit(n)}>编辑</Btn>}
                  {canWrite && <Btn kind="danger" disabled={busy} onClick={() => setRemoving(n)}>撤精选</Btn>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ---- 添加精选 ---- */}
      {canWrite && <Section
        title="添加精选"
        desc="按标题或笔记本 ID 搜索;设为精选会同时公开该笔记本(私有笔记本会先确认)"
      >
        <input
          className={inputCls}
          placeholder="搜索笔记本标题 / 粘贴笔记本 ID…"
          value={addQ}
          onChange={(e) => setAddQ(e.target.value)}
          name="featured-add-q"
          autoComplete="off"
        />
        {addQ.trim() &&
          (searching ? (
            <p className="py-4 text-center text-xs text-muted">搜索中…</p>
          ) : candidates.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted">没有匹配的未精选笔记本。</p>
          ) : (
            <ul className="mt-3 divide-y divide-edge">
              {candidates.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-panel2 text-sm">{c.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{c.title}</span>
                      {c.public ? <Pill text="公开" tone="ok" /> : <Pill text="私有" tone="warn" />}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {c.sources} 来源 · {c.outputs} 制品{c.owner ? ` · 属主 ${c.owner}` : ""}
                    </p>
                  </div>
                  <Btn
                    kind="primary"
                    disabled={busy}
                    onClick={() =>
                      c.public
                        ? act({ action: "add", notebookId: c.id }, "已设为精选").then((ok) => ok && setAddQ(""))
                        : setAdding(c)
                    }
                  >
                    设为精选
                  </Btn>
                </li>
              ))}
            </ul>
          ))}
      </Section>}

      {/* ---- 统一生成弹窗(平台策展预生成,NotebookLM 编辑部模式) ---- */}
      {canWrite && genFor && (
        <Modal
          title={`生成内容 · ${genFor.title}`}
          onClose={() => setGenFor(null)}
          width={520}
          footer={
            <>
              <Btn onClick={() => setGenFor(null)}>取消</Btn>
              <Btn
                kind="primary"
                disabled={busy || genKinds.size === 0}
                onClick={() =>
                  act(
                    { action: "generate", notebookId: genFor.id, kinds: Array.from(genKinds) },
                    `已加入生成队列(${genKinds.size} 个),完成后自动出现在分享页`
                  ).then((ok) => ok && setGenFor(null))
                }
              >
                生成 {genKinds.size > 0 ? `(${genKinds.size})` : ""}
              </Btn>
            </>
          }
        >
          <div className="space-y-3">
            <p className="text-xs text-muted">
              以平台名义为这本精选统一预生成智能输出,不计用户积分;单次最多 6 种,音频/视频较慢请耐心。
              访客在分享页「笔记」栏即点即看。
            </p>
            <div className="grid grid-cols-3 gap-2">
              {GEN_KINDS.map((k) => {
                const on = genKinds.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      const next = new Set(genKinds);
                      if (on) next.delete(k);
                      else if (next.size < 6) next.add(k);
                      setGenKinds(next);
                    }}
                    className={`rounded-xl border px-3 py-2 text-[13px] font-medium transition ${
                      on
                        ? "border-accent bg-accentSoft text-accent"
                        : "border-edge bg-panel text-ink2 hover:border-accent/40 hover:text-ink"
                    }`}
                  >
                    {KIND_LABEL[k] ?? k}
                  </button>
                );
              })}
            </div>
          </div>
        </Modal>
      )}

      {/* ---- 编辑门面弹窗 ---- */}
      {canWrite && editing && (
        <Modal
          title={`编辑门面 · ${editing.title}`}
          onClose={() => setEditing(null)}
          width={520}
          footer={
            <>
              <Btn onClick={() => setEditing(null)}>取消</Btn>
              <Btn kind="primary" disabled={busy} onClick={saveEdit}>保存</Btn>
            </>
          }
        >
          <div className="space-y-4">
            {/* 实时预览:迷你精选卡 */}
            <div
              className="relative flex aspect-[16/6] flex-col justify-between overflow-hidden rounded-2xl p-3 text-white"
              style={{ background: editing.cover || DEFAULT_COVER }}
            >
              <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium backdrop-blur">
                <span>{editing.publisherAvatar || "✨"}</span> {editing.publisher || "出版方"}
              </span>
              <div>
                <p className="text-[15px] font-bold leading-snug [text-shadow:0_1px_8px_rgba(0,0,0,0.3)]">{editing.title}</p>
              </div>
            </div>
            <Field label="封面渐变">
              <div className="mb-2 flex flex-wrap gap-2">
                {COVER_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    title={p.label}
                    onClick={() => setEditing({ ...editing, cover: p.value })}
                    className={`h-8 w-12 rounded-lg transition ${
                      editing.cover === p.value ? "ring-2 ring-accent ring-offset-2" : "hover:scale-105"
                    }`}
                    style={{ background: p.value }}
                  />
                ))}
              </div>
              <input
                className={inputCls}
                value={editing.cover}
                onChange={(e) => setEditing({ ...editing, cover: e.target.value })}
                placeholder="CSS 渐变,如 linear-gradient(135deg,#6d5ae6,#b765ec)"
                name="featured-cover"
                autoComplete="off"
              />
            </Field>
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <Field label="出版方">
                <input
                  className={inputCls}
                  value={editing.publisher}
                  onChange={(e) => setEditing({ ...editing, publisher: e.target.value })}
                  placeholder="社区示例"
                  name="featured-publisher"
                  autoComplete="off"
                />
              </Field>
              <Field label="头像(emoji)">
                <input
                  className={inputCls}
                  value={editing.publisherAvatar}
                  onChange={(e) => setEditing({ ...editing, publisherAvatar: e.target.value })}
                  placeholder="✨"
                  name="featured-avatar"
                  autoComplete="off"
                />
              </Field>
            </div>
            <Field label="分类(首页收藏夹与运营归组用)">
              <input
                className={inputCls}
                value={editing.category}
                onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                placeholder="如:新手入门 / 官方推荐 / 高效学习"
                list="featured-cats"
                name="featured-category"
                autoComplete="off"
              />
              <datalist id="featured-cats">
                {knownCats.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="编者按(分享页封面下方正文,无标签;支持 Markdown:[链接](url)、**粗体**、*斜体*)">
              <textarea
                className={`${inputCls} min-h-[96px] resize-y`}
                value={editing.note}
                onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                placeholder="想要编辑口吻可直接以「**编者按:**」开头。&#10;支持 [订阅出版方](https://…) 这样的推广链接。"
                name="featured-note"
              />
            </Field>
          </div>
        </Modal>
      )}

      {/* ---- 撤精选确认 ---- */}
      {canWrite && removing && (
        <Modal
          title="撤下精选"
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Btn onClick={() => setRemoving(null)}>取消</Btn>
              <Btn
                kind="danger"
                disabled={busy}
                onClick={() =>
                  act({ action: "remove", notebookId: removing.id }, "已撤下精选").then(
                    (ok) => ok && setRemoving(null)
                  )
                }
              >
                确认撤下
              </Btn>
            </>
          }
        >
          「{removing.title}」将从首页精选画廊撤下(已收藏用户的收藏夹会同步少这一本)。
          笔记本保持公开,外部分享链接不受影响。
        </Modal>
      )}

      {/* ---- 私有候选设精选:公开警示 ---- */}
      {canWrite && adding && (
        <Modal
          title="设为精选并公开"
          onClose={() => setAdding(null)}
          footer={
            <>
              <Btn onClick={() => setAdding(null)}>取消</Btn>
              <Btn
                kind="primary"
                disabled={busy}
                onClick={() =>
                  act({ action: "add", notebookId: adding.id }, "已设为精选并公开").then((ok) => {
                    if (ok) {
                      setAdding(null);
                      setAddQ("");
                    }
                  })
                }
              >
                公开并设精选
              </Btn>
            </>
          }
        >
          「{adding.title}」目前是<b className="text-ink">私有</b>笔记本
          {adding.owner ? `(属主 ${adding.owner})` : ""}。设为精选会
          <b className="text-ink">同时把它公开</b>,所有访客都能查看其来源与制品。确认继续?
        </Modal>
      )}
    </div>
  );
}
