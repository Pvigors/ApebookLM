"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  SKILLS,
  SKILL_CATEGORIES,
  catMeta,
  commonSkills,
  type Skill,
  type SkillCategory,
} from "@/lib/skills";

// ---------------------------------------------------------------------------
// 线性图标 —— 与 @/components/Icons 同笔触(viewBox 24 / stroke 1.75 / round)
// ---------------------------------------------------------------------------
const GLYPHS: Record<string, React.ReactNode> = {
  translate: (<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18" /></>),
  check: (<><circle cx="12" cy="12" r="9" /><path d="M8.5 12l2.4 2.4 4.6-5" /></>),
  table: (<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9.5h18M9.5 4v16M15.5 4v16" /></>),
  timeline: (<><path d="M5 4v16" /><circle cx="5" cy="8" r="1.5" /><circle cx="5" cy="16" r="1.5" /><path d="M8.5 8h10M8.5 16h6.5" /></>),
  pen: (<><path d="M4 20l4.5-1L19 8.5 15.5 5 5 15.5 4 20z" /><path d="M14 6.5l3.5 3.5" /></>),
  doc: (<><rect x="5" y="3" width="14" height="18" rx="2.5" /><path d="M9 8h6M9 12h6M9 16h4" /></>),
  present: (<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M12 16v4M8.5 20h7" /></>),
  cap: (<><path d="M12 4L2.5 8.5 12 13l9.5-4.5L12 4z" /><path d="M6 10.5V15c0 1.3 2.7 2.6 6 2.6s6-1.3 6-2.6v-4.5" /></>),
  socratic: (<><path d="M20.5 12a8 8 0 0 1-11.4 7.2L3.5 20.5l1.3-5.6A8 8 0 1 1 20.5 12z" /><path d="M10 9.6a2 2 0 0 1 3.6 1.2c0 1.3-1.9 1.6-1.9 3M11.7 16h.01" /></>),
  interview: (<><circle cx="12" cy="8" r="3.6" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></>),
  redteam: (<><path d="M12 3l7 2.7v6.1c0 4.4-3 7.4-7 8.7-4-1.3-7-4.3-7-8.7V5.7L12 3z" /><path d="M12 9v3.6M12 16h.01" /></>),
  research: (<><circle cx="11" cy="11" r="6.5" /><path d="M20.5 20.5l-4.2-4.2" /></>),
  pulse: (<><path d="M3 12h4l2.5-6.5 4.5 13 2.3-6.5H21" /></>),
};

export function SkillGlyph({ icon, size = 18 }: { icon: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      {GLYPHS[icon] ?? GLYPHS.translate}
    </svg>
  );
}

function IconTile({ skill, size = 32 }: { skill: Skill; size?: number }) {
  const hex = catMeta(skill.category).hex;
  return (
    <span className="grid shrink-0 place-items-center rounded-lg" style={{ width: size, height: size, background: hex + "1a", color: hex }}>
      <SkillGlyph icon={skill.icon} size={Math.round(size * 0.58)} />
    </span>
  );
}

/** 分类标题:标签 + 细分隔线(A3) */
function CatHeader({ catKey }: { catKey: SkillCategory }) {
  return (
    <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-2">
      <span className="text-[11px] font-semibold tracking-wide text-ink2">{catMeta(catKey).label}</span>
      <span className="h-px flex-1" style={{ background: "#ececf3" }} />
    </div>
  );
}

const SkillRow = ({
  skill,
  active,
  onClick,
  rowRef,
}: {
  skill: Skill;
  active: boolean;
  onClick: () => void;
  rowRef?: React.Ref<HTMLButtonElement>;
}) => (
  <button
    ref={rowRef}
    type="button"
    onClick={onClick}
    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition hover:bg-panel2"
    style={active ? { background: "#f5f3ff", boxShadow: "inset 0 0 0 1.5px #6d5ae6" } : undefined}
  >
    <IconTile skill={skill} size={32} />
    <span className="min-w-0 flex-1">
      <span className="truncate text-[13px] font-medium text-ink">{skill.name}</span>
      <span className="block truncate text-[11px] text-muted">{skill.desc}</span>
    </span>
  </button>
);

export function filterSkills(query: string): Skill[] {
  const q = query.trim().toLowerCase();
  if (!q) return SKILLS;
  return SKILLS.filter((s) => (s.name + s.desc + s.id).toLowerCase().includes(q));
}

// ---------------------------------------------------------------------------
// B 命令面板 —— 由「技能」按钮 / 「全部技能」chip 打开。搜索 + 分类 + 点击。
// ---------------------------------------------------------------------------
export function SkillPickerModal({
  onPick,
  onClose,
  activeId,
}: {
  onPick: (s: Skill) => void;
  onClose: () => void;
  activeId?: string | null;
}) {
  const [q, setQ] = useState("");
  const list = filterSkills(q);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onClick={onClose}>
      <div
        className="w-full max-w-[540px] overflow-hidden rounded-2xl border border-edge bg-panel"
        style={{ boxShadow: "0 24px 60px -20px rgba(20,20,50,0.35)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-edge px-4 py-3.5">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9aa0b4" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
          <input
            autoFocus
            name="search"
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索技能,如「翻译」「面试」「周报」…"
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted">esc</kbd>
        </div>
        <div className="max-h-[52vh] overflow-y-auto px-2 py-2">
          {SKILL_CATEGORIES.map((c) => {
            const items = list.filter((s) => s.category === c.key);
            if (!items.length) return null;
            return (
              <div key={c.key} className="mb-1.5">
                <CatHeader catKey={c.key} />
                {items.map((s) => (
                  <SkillRow key={s.id} skill={s} active={s.id === activeId} onClick={() => onPick(s)} />
                ))}
              </div>
            );
          })}
          {!list.length && <p className="px-3 py-10 text-center text-sm text-muted">没有匹配「{q}」的技能</p>}
        </div>
        <div className="flex items-center gap-4 border-t border-edge px-4 py-2.5 text-[11px] text-muted">
          <span>点选即用</span><span>对话型技能会持续生效,可在输入框上方关闭</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// D 输入框技能条 —— 常用项 + 「全部技能」。
// ---------------------------------------------------------------------------
export function SkillChips({
  onPick,
  onOpenAll,
  activeId,
}: {
  onPick: (s: Skill) => void;
  onOpenAll: () => void;
  activeId?: string | null;
}) {
  const items = useMemo(() => commonSkills(), []);
  return (
    <div className="mb-2 flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
      {items.map((s) => {
        const on = s.id === activeId;
        const hex = catMeta(s.category).hex;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onPick(s)}
            title={s.desc}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition"
            style={on ? { borderColor: "#6d5ae6", background: "#ece9fc", color: "#6d5ae6" } : { borderColor: "#e7e7ef", background: "#fff", color: "#3f4658" }}
          >
            <span style={{ color: on ? "#6d5ae6" : hex }}><SkillGlyph icon={s.icon} size={13} /></span>
            {s.name}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onOpenAll}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-edge bg-panel px-2.5 py-1 text-[12px] font-medium text-accent transition hover:bg-accentSoft"
      >
        全部技能 ›
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 「/」斜杠唤起的内联弹层 —— 锚定在输入框上方。键盘导航由 composer 驱动。
// ---------------------------------------------------------------------------
export function SlashMenu({
  items,
  activeIndex,
  onPick,
}: {
  items: Skill[];
  activeIndex: number;
  onPick: (s: Skill) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-2xl border border-edge bg-panel"
      style={{ boxShadow: "0 18px 44px -18px rgba(20,20,50,0.32)" }}
    >
      <div className="max-h-[300px] overflow-y-auto p-1.5">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted">没有匹配的技能</p>
        ) : (
          items.map((s, i) => (
            <Fragment key={s.id}>
              {(i === 0 || items[i - 1].category !== s.category) && <CatHeader catKey={s.category} />}
              <SkillRow
                skill={s}
                active={i === activeIndex}
                onClick={() => onPick(s)}
                rowRef={i === activeIndex ? activeRef : undefined}
              />
            </Fragment>
          ))
        )}
      </div>
      <div className="border-t border-edge px-3 py-1.5 text-right text-[10.5px] text-muted">
        ↑↓ 选择 · ↵ 使用 · esc 关闭
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 当前生效的对话型技能标签(输入框上方,可关闭)
// ---------------------------------------------------------------------------
export function ActiveSkillTag({ skill, onClear }: { skill: Skill; onClear: () => void }) {
  const hex = catMeta(skill.category).hex;
  return (
    <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-edge bg-panel py-1 pl-2 pr-1.5 text-[12px]">
      <span style={{ color: hex }}><SkillGlyph icon={skill.icon} size={14} /></span>
      <span className="font-medium text-ink">{skill.name}</span>
      <span className="text-muted">进行中</span>
      <button type="button" onClick={onClear} className="grid h-5 w-5 place-items-center rounded-full text-ink2 transition hover:bg-panel2 hover:text-ink" title="结束该技能">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}
