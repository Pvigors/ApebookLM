"use client";

import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import type { Citation, Note, Notebook, Source, StudioKind, StudioOutput } from "@/lib/types";
import { outputToMarkdown } from "@/lib/output-text";
import { CREDIT_COSTS, STUDIO_CREDIT_COSTS } from "@/lib/credits";
import { PPTX_MAX_FILE_BYTES, isPptxFileName, uploadLimitForFile } from "@/lib/upload-limits";
import dynamic from "next/dynamic";
// KIND_LABEL / sourceIdsOf are the only Studio exports the landing view needs
// eagerly; they live in a dependency-free module so pulling them does NOT drag
// the whole Studio bundle into the initial route chunk. The heavy components
// (viewers + editors + config modal + StudioPanel) are lazy-loaded below.
import {
  KIND_LABEL,
  VOICE_PRESETS,
  sourceIdsOf,
  type CadGenerationMode,
  type CadTemplateChoice,
  type GenJobState,
  type GenMap,
} from "@/components/studio-shared";
import { DynamicStatus } from "@/components/DynamicStatus";
import SettingsMenu from "@/components/SettingsMenu";
import ViewerErrorBoundary from "@/components/ViewerErrorBoundary";
import AccountMenu from "@/components/AccountMenu";
import NotificationBell from "@/components/NotificationBell";
import ReferralPill from "@/components/ReferralPill";
import ResponsiveMarkdownTable from "@/components/ResponsiveMarkdownTable";
import DiscoveryReportMarkdown from "@/components/DiscoveryReportMarkdown";
import { citationContentHash, locateCitationPassage } from "@/components/citations";
import { sanitizeStreamingProtocolText } from "@/lib/citation-protocol";
import type { DiscoveryReference } from "@/lib/discovery-report";
import { StyledSelect, MENU_PANEL, MENU_ITEM, MENU_ITEM_DANGER, MENU_SELECTED } from "@/components/StyledSelect";
import { Toaster, toast } from "@/components/Toast";
import SessionExpiredBanner from "@/components/SessionExpiredBanner";
import { isSessionExpired, notifySessionExpired } from "@/lib/session-expiry";
import {
  SkillChips,
  SkillPickerModal,
  SlashMenu,
  ActiveSkillTag,
  filterSkills,
} from "@/components/Skills";
import type { Skill } from "@/lib/skills";
import {
  BookIcon,
  CloseIcon,
  SearchIcon,
  GridIcon,
  ListIcon,
  GlobeIcon,
  DotsIcon,
  FileIcon,
  LinkIcon,
  PlusIcon,
  SaveIcon,
  ShareIcon,
  SpinnerIcon,
  TextIcon,
  TrashIcon,
  UploadIcon,
  BilibiliIcon,
  AudioIcon,
  ImageIcon,
  CopyIcon,
  RefreshIcon,
  PanelLeftIcon,
  PanelRightIcon,
  DownloadIcon,
} from "@/components/Icons";

// ---------------------------------------------------------------------------
// Lazy-loaded studio surface — keeps the ~heaviest first-party code out of the
// initial home route chunk. The landing notebook-list view needs none of these;
// they all resolve to ONE shared Studio (or TableSheet) chunk that loads once,
// the first time the user opens a notebook / artifact. Biggest first-load win.
// ---------------------------------------------------------------------------

/** Full-screen spinner shown while a lazy artifact viewer's chunk loads. */
function ViewerFallback() {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/20 backdrop-blur-[1px]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-edge border-t-accent" />
    </div>
  );
}
const viewerLoading = () => <ViewerFallback />;

const StudioPanel = dynamic(() => import("@/components/Studio").then((m) => m.StudioPanel), { ssr: false });
const GenerateConfigModal = dynamic(() => import("@/components/Studio").then((m) => m.GenerateConfigModal), { ssr: false });
const DocViewer = dynamic(() => import("@/components/Studio").then((m) => m.DocViewer), { ssr: false, loading: viewerLoading });
const MindMapView = dynamic(() => import("@/components/Studio").then((m) => m.MindMapView), { ssr: false, loading: viewerLoading });
const SlidesView = dynamic(() => import("@/components/Studio").then((m) => m.SlidesView), { ssr: false, loading: viewerLoading });
const InfographicView = dynamic(() => import("@/components/Studio").then((m) => m.InfographicView), { ssr: false, loading: viewerLoading });
const XhsCardsView = dynamic(() => import("@/components/Studio").then((m) => m.XhsCardsView), { ssr: false, loading: viewerLoading });
const QuizView = dynamic(() => import("@/components/Studio").then((m) => m.QuizView), { ssr: false, loading: viewerLoading });
const FlashcardsView = dynamic(() => import("@/components/Studio").then((m) => m.FlashcardsView), { ssr: false, loading: viewerLoading });
const VideoPlayer = dynamic(() => import("@/components/Studio").then((m) => m.VideoPlayer), { ssr: false, loading: viewerLoading });
const ExcalidrawView = dynamic(() => import("@/components/Studio").then((m) => m.ExcalidrawView), { ssr: false, loading: viewerLoading });
const DrawvisoView = dynamic(() => import("@/components/Studio").then((m) => m.DrawvisoView), { ssr: false, loading: viewerLoading });
const CadView = dynamic(() => import("@/components/CadView").then((m) => m.CadView), { ssr: false, loading: viewerLoading });
const NoteEditor = dynamic(() => import("@/components/Studio").then((m) => m.NoteEditor), { ssr: false, loading: viewerLoading });
const TableSheetView = dynamic(() => import("@/components/TableSheet").then((m) => m.TableSheetView), { ssr: false, loading: viewerLoading });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const cn = (...xs: Array<string | false | null | undefined>) =>
  xs.filter(Boolean).join(" ");

const STREAM_ID = "__streaming__";

/** 生成配置弹窗传给 generateStudio 的选项。 */
export type GenOpts = {
  sourceIds?: string[];
  instruction?: string;
  language?: string;
  theme?: string;
  format?: string;
  focus?: string;
  length?: string;
  audience?: string;
  difficulty?: string;
  count?: number;
  /** CAD 模型库选择；auto=按描述自动匹配，text2cad=自由参数化。 */
  cadTemplate?: CadTemplateChoice;
  /** CAD P0 预检冻结的用户意图和参数。旧后端可忽略附加字段，
   *  但新前端只在预检返回 planHash 后才会请求入队。 */
  cadMode?: CadGenerationMode;
  cadParameters?: Record<string, number | boolean>;
  cadTargetObjectId?: string;
  cadAllowAssumptions?: boolean;
  cadTutorialExample?: boolean;
  cadPreflightPlanHash?: string;
  cadIdempotencyKey?: string;
  /** C5:播客音色组合预设 key(components/studio-shared 的 VOICE_PRESETS),仅音频。 */
  voices?: string;
};

/** 课代表包(B站三连):学习指南 + 思维导图 + 测验,顺序生成;积分价随 lib/credits.ts 价目联动。 */
const KEBAN_PACK_KINDS: StudioKind[] = ["study_guide", "mindmap", "quiz"];
const KEBAN_PACK_COST = KEBAN_PACK_KINDS.reduce((n, k) => n + STUDIO_CREDIT_COSTS[k], 0);

/** De-duplicate sources by id (last wins) — a defensive guard so a list render
 *  never crashes on an accidental duplicate, regardless of how state was set. */
function dedupeSources(list: Source[]): Source[] {
  return Array.from(new Map(list.map((s) => [s.id, s])).values());
}

/** Move the source with `id` to the front of the list (no-op if absent/first). */
function moveSourceToFront(list: Source[], id: string): Source[] {
  const idx = list.findIndex((s) => s.id === id);
  if (idx <= 0) return list;
  const copy = list.slice();
  const [item] = copy.splice(idx, 1);
  return [item, ...copy];
}

/** A temporary "processing" source shown at the TOP of the list while a note /
 *  artifact is turned into a real source — gives instant feedback with a
 *  spinner, then gets swapped for the real source once it's ready. */
/** 宽松同源比对:客户端占位存原始 URL、服务端存规范化 URL,按「去协议/hash/尾斜杠 +
 *  小写」比对,用于在刷新合并时丢弃「服务端已入库」的残留占位(避免同源短暂双条)。 */
function originSeen(list: Source[], origin: string): boolean {
  const norm = (u: string | null | undefined) =>
    (u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/#.*$/, "").replace(/\/+$/, "");
  const k = norm(origin);
  return !!k && list.some((s) => norm(s.origin) === k);
}

function pendingSource(notebookId: string, title: string, url?: string): Source {
  return {
    id: `pending-${crypto.randomUUID()}`,
    notebook_id: notebookId,
    title: title.trim() || "新建来源",
    type: url ? "url" : "text",
    status: "processing",
    error: null,
    char_count: 0,
    chunk_count: 0,
    created_at: Date.now(),
    selected: true,
    summary: null,
    key_topics: [],
    origin: url ?? null,
  };
}

const EMOJIS = ["📓", "📚", "🔬", "🧠", "🗂️", "📝", "💡", "🧪", "🌍", "🛰️", "📈", "🎓"];
const randomEmoji = () => EMOJIS[Math.floor(Math.random() * EMOJIS.length)];

/** Emoji choices offered by the notebook cover picker. */
const EMOJI_CHOICES = [
  "📓", "📔", "📒", "📕", "📗", "📘", "📙", "📚",
  "📝", "✏️", "🖊️", "🗒️", "🗂️", "📁", "🔖", "📌",
  "💡", "🧠", "🔬", "🧪", "⚗️", "🔭", "🛰️", "🌍",
  "📈", "📊", "💹", "🧮", "💼", "🎯", "🚀", "⭐",
  "🎓", "🏫", "📖", "🔍", "🧩", "🎨", "🎬", "🎵",
  "💻", "📱", "🔧", "⚙️", "🏆", "❤️", "🔥", "✨",
];

// 相对/绝对时间统一到 lib/relative-time(此前散落 4 份、阈值不一致)。
import { fmtDate, relTime } from "@/lib/relative-time";

/** 状态标签:公开(已分享 /share,主色地球)/ 私有(锁)。列表「状态」列用。 */
function StatusTag({ pub }: { pub: boolean }) {
  return pub ? (
    <span className="inline-flex items-center gap-1 text-accent">
      <GlobeIcon width={13} height={13} /> 公开
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-ink2">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      私有
    </span>
  );
}

function childText(children: ReactNode): string {
  if (children == null || children === false) return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childText).join("");
  return "";
}

const STUDIO_PROMPTS: { label: string; prompt: string }[] = [
  { label: "概览", prompt: "概要总结一下我所有来源的核心要点。" },
  { label: "主题", prompt: "我的来源涵盖了哪些主要主题和议题?" },
  { label: "学习指南", prompt: "整理一份学习指南,包含最重要的概念、定义和复习问题。" },
  { label: "常见问答", prompt: "基于我的来源,生成一组常见问题及其答案。" },
  { label: "时间线", prompt: "按时间顺序梳理来源中提到的关键事件或里程碑。" },
  { label: "简报", prompt: "写一份简报,概述新读者需要了解的关键信息。" },
];

// Turn inline [n] citation markers into <cite> elements we can render as chips.
function rehypeCitations() {
  const walk = (node: { tagName?: string; children?: unknown[] }) => {
    if (!node || !Array.isArray(node.children)) return;
    if (node.tagName === "code" || node.tagName === "pre") return;
    const out: unknown[] = [];
    for (const raw of node.children) {
      const child = raw as { type?: string; value?: string; tagName?: string; children?: unknown[] };
      if (child.type === "text" && typeof child.value === "string" && /\[\d+\]/.test(child.value)) {
        const text = child.value;
        const re = /\[(\d+)\]/g;
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
          out.push({
            type: "element",
            tagName: "cite",
            properties: { className: ["cite"] },
            children: [{ type: "text", value: m[1] }],
          });
          last = re.lastIndex;
        }
        if (last < text.length) out.push({ type: "text", value: text.slice(last) });
      } else {
        walk(child);
        out.push(child);
      }
    }
    node.children = out;
  };
  return (tree: unknown) => walk(tree as { children?: unknown[] });
}

type StreamHandlers = {
  onToken: (t: string) => void;
  onDone: (
    id: string,
    content: string | undefined,
    citations: Citation[],
    followups: string[],
    research: { query: string; label: string } | null
  ) => void;
  /** 追问建议改为 done 之后的尾随事件(第二次 LLM 调用不再阻塞输入解锁)。 */
  onFollowups?: (
    id: string,
    followups: string[],
    research: { query: string; label: string } | null
  ) => void;
  onError: (msg: string, isQuota?: boolean, code?: string) => void;
};

async function streamChat(
  notebookId: string,
  message: string,
  sourceIds: string[],
  h: StreamHandlers,
  regenerate = false,
  skillId = "",
  clientUserMessageId?: string,
  regenerateTarget?: { userMessageId: string; assistantIds: string[] },
  abortSignal?: AbortSignal
) {
  const res = await fetch(`/api/notebooks/${notebookId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 只发 skillId —— 提示词/persona 由服务端按 id 查表注入(不再从前端下发文本)。
    body: JSON.stringify({
      message,
      sourceIds,
      regenerate,
      skillId,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(regenerateTarget ? {
        targetUserMessageId: regenerateTarget.userMessageId,
        expectedAssistantIds: regenerateTarget.assistantIds,
      } : {}),
    }),
    signal: abortSignal, // 「停止生成」按钮通过 controller.abort() 打断流式(审查修复:此前无法中止)
  });
  if (!res.ok || !res.body) {
    let msg = res.status === 500 ? "服务暂时不可用,请稍后重试" : res.status === 404 ? "找不到该笔记本或已被删除" : `请求失败(状态码 ${res.status})`;
    // 审查修复:只认 code==='quota' 为「当日额度用尽」(持久横幅)。
    // 对话限流(30 次/分)同样返回 429,误判会把聊天永久锁死在配额横幅后面。
    let isQuota = false;
    let code = "";
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
      if (j?.code === "quota") isQuota = true;
      if (typeof j?.code === "string") code = j.code;
    } catch {
      /* ignore */
    }
    h.onError(msg, isQuota, code);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt: {
        type?: string;
        value?: string;
        id?: string;
        content?: string;
        citations?: Citation[];
        followups?: string[];
        research?: { query: string; label: string } | null;
        message?: string;
        code?: string;
      };
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type === "token" && evt.value) h.onToken(evt.value);
      else if (evt.type === "done")
        h.onDone(evt.id || STREAM_ID, evt.content, evt.citations || [], evt.followups || [], evt.research ?? null);
      else if (evt.type === "followups")
        h.onFollowups?.(evt.id || STREAM_ID, evt.followups || [], evt.research ?? null);
      else if (evt.type === "error") h.onError(evt.message || "Unknown error", false, evt.code);
    }
  }
}

/** Locate a raw-markdown snippet inside RENDERED markdown DOM and return a
 *  Range over it. Both sides are normalized the same way (markdown syntax +
 *  all whitespace dropped) so `**bold**` in the snippet matches the rendered
 *  text. Returns null when the passage can't be found. */
function findRangeByText(root: HTMLElement, rawSnippet: string): Range | null {
  const drop = /[\s*`#>_~[\]()]/;
  // Citation snippets are chunk text with newlines flattened to spaces, so
  // list markers ("1. ", "- ") appear mid-string; rendered lists draw their
  // markers via CSS counters (not text nodes), so strip them on the snippet
  // side. The space-after-dot requirement keeps decimals like "3.5" intact.
  const normalize = (s: string) =>
    s
      // 剥掉「站名 · 分类 · N天前」这类前导元信息行(只作用于待匹配的 snippet 侧,
      // 不动渲染 DOM 的 hay)——让锚点落到正文,绕开高亮被困在元信息行的问题。
      .replace(/^[^·\n]{0,14}·[^·\n]+·[^·\n]*\d+\s*(?:天|小时|分钟|秒|周|月|年)前\s*/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → label
      .replace(/(^|\s)(?:[-+*]|\d{1,2}\.)\s+/g, "$1") // list markers
      .replace(/[….]{3,}\s*$/, "") // trailing ellipsis
      .split("")
      .filter((ch) => !drop.test(ch))
      .join("");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let hay = "";
  const map: { node: Text; offset: number }[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n as Text).data;
    for (let i = 0; i < text.length; i++) {
      if (!drop.test(text[i])) {
        hay += text[i];
        map.push({ node: n as Text, offset: i });
      }
    }
  }
  const norm = normalize(rawSnippet);
  // The viewer may strip a leading heading that repeats the source title, and
  // a chunk may start mid-structure — after the exact attempt, retry while
  // skipping a growing prefix so a mismatched head doesn't sink the whole match.
  const tryMatch = (target: string, minLen: number): Range | null => {
    if (target.length < minLen) return null;
    const idx = hay.indexOf(target);
    if (idx < 0) return null;
    const start = map[idx];
    const end = map[idx + target.length - 1];
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    return range;
  };
  for (let skip = 0; skip <= 64 && skip < norm.length; skip += 8) {
    const r = tryMatch(norm.slice(skip), skip === 0 ? 8 : 24);
    if (r) return r;
  }
  return null;
}

/** 把命中的高亮 Range 收拢成「干净的句子/段落」:① 终点不跨出起始块(段落/标题/
 *  单元格)——被引 chunk 常跨章节,否则高亮会从一段越过标题蔓延到下一节,看着错位;
 *  ② 起点回退到句首、③ 终点延到句末(同一文本节点内),避免从句中"…文档、"开头。
 *  纯视觉对齐——不改判定命中的位置,只把边界对齐到句子。失败则原样返回。 */
function refineCitationRange(range: Range): Range {
  try {
    const BLOCK = "p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,pre,figcaption";
    const startEl =
      range.startContainer.nodeType === 1
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    const startBlock = startEl?.closest(BLOCK) ?? startEl ?? null;
    // 起始块若本身是元信息/极短分隔行(站名·分类·N天前),不要把终点收回到它里面
    // ——否则高亮会被困在这行噪声上(正是 ByteNote 那类列表来源的症状)。
    const sbText = (startBlock?.textContent || "").trim();
    const startIsMeta =
      !!startBlock &&
      (sbText.length < 24 || /·[^·]+·[^·]*\d+\s*(?:天|小时|分钟|周|月|年)前/.test(sbText));
    // ① 终点收回到起始块内(若它跨出了);元信息起始块跳过,避免高亮困在噪声行。
    if (
      startBlock &&
      !startIsMeta &&
      range.endContainer !== range.startContainer &&
      !startBlock.contains(range.endContainer)
    ) {
      const w = document.createTreeWalker(startBlock, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      for (let n = w.nextNode(); n; n = w.nextNode()) last = n as Text;
      if (last) range.setEnd(last, last.data.length);
    }
    // ② 起点回退到句/子句首(同一文本节点内)。
    if (range.startContainer.nodeType === 3) {
      const t = (range.startContainer as Text).data;
      let i = range.startOffset;
      while (i > 0 && !/[。！？；;.!?\n]/.test(t[i - 1])) i--;
      range.setStart(range.startContainer, i);
    }
    // ③ 终点延到句末(含终止符;同一文本节点内)。
    if (range.endContainer.nodeType === 3) {
      const t = (range.endContainer as Text).data;
      let i = range.endOffset;
      while (i < t.length && !/[。！？.!?]/.test(t[i - 1])) i++;
      range.setEnd(range.endContainer, Math.min(t.length, i));
    }
  } catch {
    /* 任何 DOM 操作失败都退回原 range */
  }
  return range;
}

// ---------------------------------------------------------------------------
// types local to the UI
// ---------------------------------------------------------------------------

type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  followups?: string[];
  /** 无来源向导回答里的「快速研究」动作:点击后聚焦左栏快速研究并预填 query。 */
  research?: { query: string; label: string };
  streaming?: boolean;
  error?: boolean;
  /** 独立错误文案:失败时不再覆盖 content(#8 双写与吞文案审查修复),错误态与正文解耦。 */
  errorText?: string;
  feedback?: "up" | "down" | null;
  /** 服务端持久化的技能 id;只用于精确重生成,不包含 prompt。 */
  skill_id?: string | null;
};

// What the source-viewer drawer is currently showing.
type ViewerTarget = {
  sourceId: string;
  title: string;
  snippet?: string;
  chunkIndex?: number;
  sourceStart?: number;
  sourceEnd?: number;
  sourceContentHash?: string;
};

type HomeUser = {
  id: string;
  name: string;
  avatar: string | null;
  phone?: string | null;
  email?: string | null;
  plan_tier?: string;
  adminRole?: "super" | "operator" | "auditor" | null;
};

// ---------------------------------------------------------------------------
// root component
// ---------------------------------------------------------------------------

export default function HomeClient({
  user: initialUser,
  initialNotebooks,
  hiddenArtifacts = [],
  userHiddenTiles = [],
}: {
  user?: HomeUser;
  // 服务端已查好的笔记本列表:随首屏 HTML 直出,列表瞬间可见、免掉客户端二次请求
  // + 骨架屏闪烁(此前进首页要先转骨架再 fetch)。仍在挂载后后台刷新一次保时效。
  initialNotebooks?: Notebook[];
  // 管理员在后台隐藏的智能输出类型(kind 列表)。前端据此过滤生成入口(服务端另有二次拦截)。
  hiddenArtifacts?: string[];
  // 用户自定义隐藏的生成磁贴(tile id 列表,个人偏好;SSR 直出免闪烁)。
  userHiddenTiles?: string[];
}) {
  // user 由服务端注入,但设置弹窗里改名/换头像后要让右上角头像即时更新 ——
  // 持成本地状态,并监听设置弹窗保存后派发的 nb:user-updated 事件。
  const [user, setUser] = useState(initialUser);
  useEffect(() => {
    const onUser = (e: Event) => {
      const u = (e as CustomEvent).detail;
      if (u) setUser((prev) => (prev ? { ...prev, ...u } : u));
    };
    window.addEventListener("nb:user-updated", onUser);
    return () => window.removeEventListener("nb:user-updated", onUser);
  }, []);
  const [notebooks, setNotebooks] = useState<Notebook[]>(initialNotebooks ?? []);
  // 用户自定义隐藏的磁贴:乐观更新本地态 + 后台持久化(PATCH /api/auth/me)。
  // PATCH 走 promise 队列串行发送:快速连续 toggle 产生多次保存时,请求按序落库,
  // 不会因网络乱序让「旧值后到」覆盖新值(实测并发两枚 PATCH 会竞态)。
  const [userHidden, setUserHidden] = useState<string[]>(userHiddenTiles);
  const hiddenSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveUserHidden = useCallback((next: string[]) => {
    setUserHidden(next);
    hiddenSaveQueue.current = hiddenSaveQueue.current.then(() =>
      fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden_tiles: next }),
      }).catch(() => {})
    );
  }, []);
  // 有服务端直出列表就不显骨架(哪怕是空列表——直接给空状态,不再空转)。
  const [loadingList, setLoadingList] = useState(!initialNotebooks);
  const [activeId, setActiveId] = useState<string | null>(null);
  // 新建笔记本后,自动弹出「添加来源」对话框(只对这个刚建的笔记本触发一次)。
  const [autoAddForId, setAutoAddForId] = useState<string | null>(null);
  const consumeAutoAdd = useCallback(() => setAutoAddForId(null), []);

  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadingNotebook, setLoadingNotebook] = useState(false);

  const loadNotebooks = useCallback(async (opts?: { background?: boolean }) => {
    // background=true:静默刷新,不显骨架(已有 SSR 直出/现有列表时用)。
    if (!opts?.background) setLoadingList(true);
    try {
      const res = await fetch("/api/notebooks");
      const data = await res.json();
      setNotebooks(data.notebooks ?? []);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    // 有服务端直出列表就后台静默刷新(不闪骨架);否则正常带骨架首加载。
    loadNotebooks({ background: !!initialNotebooks });
    // 仅挂载执行一次(loadNotebooks 稳定;initialNotebooks 为挂载常量)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadNotebooks]);

  // 进入页面 / 浏览器前进后退时,从 URL(?nb=<id>)恢复当前笔记本;无 nb 即首页。
  // 这样硬刷新会停在原笔记本(对话历史一并回来),而不是掉回首页让人以为「历史没了」。
  useEffect(() => {
    const syncFromUrl = () => {
      const id = new URLSearchParams(window.location.search).get("nb");
      if (id) {
        void openNotebook(id, { syncUrl: false });
      } else {
        setActiveId(null);
        setNotebook(null);
      }
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
    // openNotebook is stable (useCallback []); run once on mount + on history nav.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNotebook = useCallback(async (id: string, opts?: { syncUrl?: boolean }) => {
    // 把当前笔记本写进 URL(?nb=<id>):刷新 / 浏览器前进后退都能回到这里,
    // 对话历史随之恢复(此前 activeId 只在 React state 里,刷新就掉回首页)。
    if (opts?.syncUrl !== false && typeof window !== "undefined") {
      window.history.pushState(null, "", `/?nb=${id}`);
    }
    setActiveId(id);
    setLoadingNotebook(true);
    setNotebook(null);
    setSources([]);
    setMessages([]);
    try {
      const res = await fetch(`/api/notebooks/${id}`);
      // 会话过期与「笔记本被删/无权访问」必须分开:两者原来共用下面那个 catch,
      // 都被当成「这本不存在」退回首页 —— 用户看到的就是「点一下闪一下什么都没发生」。
      // 过期时广播给全局横幅,并保持当前视图不动,别把人踢回首页。
      if (isSessionExpired(res)) {
        notifySessionExpired();
        setLoadingNotebook(false);
        return;
      }
      if (!res.ok) throw new Error("Failed to load notebook");
      const data = await res.json();
      setNotebook(data.notebook);
      setSources(data.sources ?? []);
      setMessages(
        (data.messages ?? []).map((m: UiMessage) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          citations: m.citations ?? [],
          feedback: m.feedback ?? null,
          skill_id: m.skill_id ?? null,
        }))
      );
    } catch {
      // URL 里的 id 已删 / 无权访问 → 退回首页并清掉地址栏,别卡在空白笔记本视图。
      setActiveId(null);
      setNotebook(null);
      if (typeof window !== "undefined") window.history.replaceState(null, "", "/");
      toast("笔记本不存在或无权访问", "error");
    } finally {
      setLoadingNotebook(false);
    }
  }, []);

  const backToHome = useCallback(() => {
    if (typeof window !== "undefined") window.history.pushState(null, "", "/");
    setActiveId(null);
    setNotebook(null);
    loadNotebooks();
  }, [loadNotebooks]);

  const createNotebook = useCallback(async () => {
    try {
      const res = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "未命名笔记本", emoji: randomEmoji() }),
      });
      const data = await res.json().catch(() => ({}));
      // 达套餐上限(403)等失败:提示而非静默,避免「按钮坏了」误解。
      if (!res.ok) {
        toast(data?.error || "创建失败,请重试", "error");
        return;
      }
      if (data.notebook) {
        setNotebooks((prev) => [data.notebook, ...prev]);
        setAutoAddForId(data.notebook.id); // 进去后自动弹「添加来源」
        openNotebook(data.notebook.id);
      }
    } catch {
      toast("创建失败,请检查网络后重试", "error");
    }
  }, [openNotebook]);

  const removeNotebook = useCallback(
    async (id: string) => {
      const prev = notebooks;
      setNotebooks((p) => p.filter((n) => n.id !== id)); // 乐观移除
      try {
        const r = await fetch(`/api/notebooks/${id}`, { method: "DELETE" });
        if (!r.ok) throw new Error();
        toast("已删除笔记本");
      } catch {
        setNotebooks(prev); // 失败回滚
        toast("删除失败,请重试", "error");
      }
    },
    [notebooks]
  );

  const togglePin = useCallback(
    async (id: string, pinned: boolean) => {
      // 乐观更新 + 单一置顶:置顶时取消其它,取消时只改自己。
      setNotebooks((prev) =>
        prev.map((n) => ({ ...n, pinned: n.id === id ? pinned : pinned ? false : n.pinned }))
      );
      try {
        const r = await fetch(`/api/notebooks/${id}/pin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pinned }),
        });
        if (!r.ok) throw new Error();
        toast(pinned ? "已置顶" : "已取消置顶");
      } catch {
        toast("操作失败,请重试", "error");
        loadNotebooks();
      }
    },
    [loadNotebooks]
  );

  const renameNotebook = useCallback(
    async (title: string) => {
      if (!notebook) return;
      const clean = title.trim() || "未命名笔记本";
      const previous = notebook.title;
      setNotebook((nb) => (nb ? { ...nb, title: clean } : nb));
      const response = await fetch(`/api/notebooks/${notebook.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: clean }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setNotebook((nb) => (nb ? { ...nb, title: previous } : nb));
        toast(data?.error || "重命名失败", "error");
      }
    },
    [notebook]
  );

  if (!activeId) {
    return (
      <>
        {/* 会话过期横幅:任何请求撞上 401 都会让它出现。两个视图是并列的早返回分支,
            所以各包一次 —— 只挂一处的话,另一半页面上过期了照样没提示。 */}
        <SessionExpiredBanner />
      <HomeView
        user={user}
        notebooks={notebooks}
        loading={loadingList}
        onOpen={openNotebook}
        onCreate={createNotebook}
        onDelete={removeNotebook}
        onPin={togglePin}
      />
      </>
    );
  }

  return (
    <>
      <SessionExpiredBanner />
    <NotebookView
      user={user}
      notebook={notebook}
      setNotebook={setNotebook}
      loading={loadingNotebook}
      sources={sources}
      setSources={setSources}
      messages={messages}
      setMessages={setMessages}
      onBack={backToHome}
      onRename={renameNotebook}
      onCreate={createNotebook}
      onSwitchNotebook={openNotebook}
      autoAddForId={autoAddForId}
      onAutoAddConsumed={consumeAutoAdd}
      hiddenArtifacts={hiddenArtifacts}
      userHiddenTiles={userHidden}
      onSaveUserHiddenTiles={saveUserHidden}
    />
    </>
  );
}

// ---------------------------------------------------------------------------
// home / grid view
// ---------------------------------------------------------------------------

/** Soft pastel hues for two-tone cards — one stable hue per notebook id. */
const CARD_HUES = ["#8ca0ff", "#f08bb4", "#7fd8b4", "#ffb38a", "#c3a6f5", "#f0918a", "#8fd6e8", "#f9d38a"];
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function hueFor(id: string): string {
  return CARD_HUES[hashStr(id) % CARD_HUES.length];
}

/** Time-of-day greeting for the home header. */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

// Procedural abstract cover art. Each id maps to one of several motif variants that use
// DIFFERENT shape languages (bubbles / confetti / waves / geo / bars / rings / dot-grid /
// triangles / mixed / squares), so cards look genuinely varied — not just repositioned.
// A deterministic dot-scatter adds density. No images / network. viewBox is 16:9 (160×90).
type Shape = {
  t: "circle" | "ring" | "tri" | "rect" | "line" | "arc";
  a: string;
  white?: boolean;
  cx?: number; cy?: number; r?: number; sw?: number; rot?: number;
  x?: number; y?: number; w?: number; h?: number; rx?: number;
  x1?: number; y1?: number; x2?: number; y2?: number;
  a0?: number; a1?: number;
};
const DEG = Math.PI / 180;
function triPoints(cx: number, cy: number, r: number, rot = 0): string {
  return [0, 120, 240]
    .map((d) => {
      const ang = (rot + d - 90) * DEG;
      return `${(cx + r * Math.cos(ang)).toFixed(1)},${(cy + r * Math.sin(ang)).toFixed(1)}`;
    })
    .join(" ");
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const pt = (deg: number) => `${(cx + r * Math.cos(deg * DEG)).toFixed(1)} ${(cy + r * Math.sin(deg * DEG)).toFixed(1)}`;
  return `M ${pt(a0)} A ${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${pt(a1)}`;
}
const COVER_VARIANTS: Shape[][] = [
  // bubbles
  [
    { t: "circle", cx: 140, cy: 16, r: 40, a: "26" },
    { t: "ring", cx: 146, cy: 66, r: 28, a: "38", sw: 7 },
    { t: "circle", cx: 150, cy: 44, r: 12, a: "30" },
    { t: "circle", cx: 100, cy: 24, r: 6, a: "73", white: true },
    { t: "ring", cx: 118, cy: 40, r: 14, a: "30", sw: 4 },
    { t: "circle", cx: 128, cy: 72, r: 8, a: "40" },
  ],
  // confetti — triangles + squares
  [
    { t: "tri", cx: 140, cy: 20, r: 16, rot: 10, a: "33" },
    { t: "tri", cx: 118, cy: 56, r: 11, rot: -20, a: "40" },
    { t: "rect", x: 132, y: 58, w: 12, h: 12, rot: 20, rx: 2, a: "33" },
    { t: "circle", cx: 150, cy: 40, r: 5, a: "73", white: true },
    { t: "circle", cx: 100, cy: 26, r: 4, a: "66" },
    { t: "tri", cx: 152, cy: 74, r: 9, rot: 40, a: "2b" },
    { t: "rect", x: 96, y: 14, w: 8, h: 8, rot: 15, rx: 1, a: "40" },
  ],
  // waves — concentric arcs
  [
    { t: "arc", cx: 150, cy: 80, r: 46, a0: 180, a1: 300, sw: 6, a: "38" },
    { t: "arc", cx: 150, cy: 80, r: 34, a0: 175, a1: 305, sw: 5, a: "30" },
    { t: "arc", cx: 150, cy: 80, r: 22, a0: 170, a1: 310, sw: 4, a: "40" },
    { t: "circle", cx: 112, cy: 24, r: 6, a: "66", white: true },
    { t: "circle", cx: 128, cy: 40, r: 4, a: "4d" },
  ],
  // geo — big triangle + ring + line
  [
    { t: "tri", cx: 138, cy: 34, r: 38, rot: 8, a: "26" },
    { t: "ring", cx: 112, cy: 58, r: 20, a: "38", sw: 6 },
    { t: "line", x1: 96, y1: 14, x2: 150, y2: 30, sw: 3, a: "40" },
    { t: "circle", cx: 150, cy: 72, r: 8, a: "4d" },
    { t: "circle", cx: 100, cy: 24, r: 5, a: "73", white: true },
  ],
  // bars — diagonal stripes
  [
    { t: "rect", x: 110, y: -10, w: 12, h: 110, rot: 22, rx: 6, a: "26" },
    { t: "rect", x: 128, y: -10, w: 8, h: 110, rot: 22, rx: 4, a: "33" },
    { t: "rect", x: 146, y: -10, w: 14, h: 110, rot: 22, rx: 6, a: "22" },
    { t: "circle", cx: 96, cy: 26, r: 6, a: "66", white: true },
    { t: "circle", cx: 112, cy: 64, r: 5, a: "4d" },
  ],
  // rings cluster
  [
    { t: "ring", cx: 140, cy: 30, r: 32, a: "33", sw: 7 },
    { t: "ring", cx: 116, cy: 58, r: 22, a: "38", sw: 6 },
    { t: "ring", cx: 150, cy: 70, r: 16, a: "40", sw: 5 },
    { t: "circle", cx: 150, cy: 30, r: 6, a: "66", white: true },
    { t: "circle", cx: 100, cy: 22, r: 5, a: "4d" },
    { t: "circle", cx: 128, cy: 46, r: 4, a: "73" },
  ],
  // dot grid + accent
  [
    { t: "circle", cx: 112, cy: 18, r: 3, a: "40" },
    { t: "circle", cx: 132, cy: 18, r: 3, a: "40" },
    { t: "circle", cx: 152, cy: 18, r: 3, a: "40" },
    { t: "circle", cx: 112, cy: 38, r: 3, a: "40" },
    { t: "circle", cx: 132, cy: 38, r: 3, a: "40" },
    { t: "circle", cx: 152, cy: 38, r: 3, a: "40" },
    { t: "circle", cx: 140, cy: 70, r: 16, a: "2b" },
    { t: "ring", cx: 100, cy: 32, r: 10, a: "38", sw: 4 },
  ],
  // triangles trio
  [
    { t: "tri", cx: 142, cy: 24, r: 22, rot: 0, a: "2b" },
    { t: "tri", cx: 116, cy: 54, r: 16, rot: 180, a: "33" },
    { t: "tri", cx: 150, cy: 70, r: 12, rot: 30, a: "40" },
    { t: "circle", cx: 98, cy: 24, r: 5, a: "66", white: true },
    { t: "circle", cx: 128, cy: 44, r: 4, a: "4d" },
  ],
  // mixed
  [
    { t: "circle", cx: 146, cy: 20, r: 30, a: "26" },
    { t: "arc", cx: 110, cy: 66, r: 26, a0: 200, a1: 340, sw: 5, a: "38" },
    { t: "tri", cx: 140, cy: 58, r: 12, rot: 20, a: "40" },
    { t: "line", x1: 90, y1: 18, x2: 130, y2: 12, sw: 3, a: "40" },
    { t: "circle", cx: 150, cy: 76, r: 6, a: "66", white: true },
  ],
  // squares scatter
  [
    { t: "rect", x: 130, y: 10, w: 20, h: 20, rot: 12, rx: 4, a: "2b" },
    { t: "rect", x: 108, y: 50, w: 16, h: 16, rot: -15, rx: 3, a: "33" },
    { t: "rect", x: 148, y: 56, w: 14, h: 14, rot: 25, rx: 3, a: "40" },
    { t: "circle", cx: 100, cy: 24, r: 5, a: "66", white: true },
    { t: "circle", cx: 124, cy: 36, r: 4, a: "4d" },
    { t: "circle", cx: 150, cy: 34, r: 6, a: "30" },
  ],
];
function CoverArt({ tone, seed }: { tone: string; seed: string }) {
  const shapes = COVER_VARIANTS[hashStr(seed + "·art") % COVER_VARIANTS.length];
  const col = (s: Shape) => `${s.white ? "#ffffff" : tone}${s.a}`;
  let st = hashStr(seed + "·dots");
  const rnd = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
  const dots = Array.from({ length: 16 }, () => {
    const cx = rnd() * 168 - 4;
    const cy = rnd() * 94 - 2;
    const r = 1.2 + rnd() * 3.6;
    const white = rnd() > 0.82;
    const a = Math.round((0.1 + rnd() * 0.26) * 255).toString(16).padStart(2, "0");
    return { cx, cy, r, fill: `${white ? "#ffffff" : tone}${a}` };
  });
  const draw = (s: Shape, key: string) => {
    const c = col(s);
    switch (s.t) {
      case "ring":
        return <circle key={key} cx={s.cx} cy={s.cy} r={s.r} fill="none" stroke={c} strokeWidth={s.sw} />;
      case "tri":
        return <polygon key={key} points={triPoints(s.cx!, s.cy!, s.r!, s.rot)} fill={c} />;
      case "rect":
        return (
          <rect
            key={key}
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            rx={s.rx}
            fill={c}
            transform={s.rot ? `rotate(${s.rot} ${s.x! + s.w! / 2} ${s.y! + s.h! / 2})` : undefined}
          />
        );
      case "line":
        return <line key={key} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={c} strokeWidth={s.sw} strokeLinecap="round" />;
      case "arc":
        return <path key={key} d={arcPath(s.cx!, s.cy!, s.r!, s.a0!, s.a1!)} fill="none" stroke={c} strokeWidth={s.sw} strokeLinecap="round" />;
      default:
        return <circle key={key} cx={s.cx} cy={s.cy} r={s.r} fill={c} />;
    }
  };
  return (
    <svg
      viewBox="0 0 160 90"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {shapes.map((s, i) => draw(s, `s${i}`))}
      {dots.map((d, i) => (
        <circle key={`d${i}`} cx={d.cx} cy={d.cy} r={d.r} fill={d.fill} />
      ))}
    </svg>
  );
}

type FeaturedItem = {
  id: string;
  title: string;
  emoji: string;
  summary: string | null;
  created_at: number;
  source_count: number;
  cover: string | null;
  publisher: string | null;
  publisher_avatar: string | null;
  category: string | null;
  favorited: boolean;
  /** 订阅态(P0-6):最近真的抓到新内容的时刻(0=非自动更新频道)/ 我的未读篇数。 */
  last_content_at?: number;
  unread?: number;
  /** R1 诚实性⑤:有启用的自动更新频道才是「订阅」;静态策展保持「收藏」文案(铃=真的会响)。 */
  has_feed?: boolean;
};

// 精选笔记本暂时从用户首页下线：保留策展、收藏与公开分享能力，
// 便于后续恢复；关闭时也不请求 /api/featured。
const HOME_FEATURED_NOTEBOOKS_ENABLED: boolean = false;

/**
 * A curated featured notebook cover card — opens the read-only /share view.
 * hover 时封面浮出「收藏」浮层(绝对定位覆盖,标题/来源原地不动)。onToggleFav 缺省则不显收藏。
 */
function FeaturedCard({
  item,
  onToggleFav,
}: {
  item: FeaturedItem;
  onToggleFav?: (item: FeaturedItem) => void;
}) {
  const fav = item.favorited;
  return (
    <a href={`/share/${item.id}`} className="group relative block animate-fadeup">
      {/* single cover tile — publisher + emoji on top, title + meta inside (NotebookLM style) */}
      <div
        className="relative flex aspect-[16/9] flex-col overflow-hidden rounded-2xl p-4 transition duration-150 group-hover:ring-2 group-hover:ring-accent/40"
        style={{ background: item.cover ?? "linear-gradient(135deg,#6d5ae6,#b765ec)" }}
      >
        <CoverArt tone="#ffffff" seed={item.id} />
        <div className="relative flex items-start justify-between gap-2">
          {item.publisher && (
            // hover 时淡出,给收藏浮层让位(窄卡避免重叠);标题/来源不动。
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium text-white backdrop-blur transition group-hover:opacity-0">
              <span>{item.publisher_avatar ?? "✨"}</span> {item.publisher}
            </span>
          )}
          {/* 未读徽(订阅态):只数「入库成功且晚于我的已读游标」的篇数,打开工作台即清。 */}
          {(item.unread ?? 0) > 0 && (
            <span className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold leading-none text-white shadow">
              +{item.unread}
            </span>
          )}
        </div>
        <div className="relative mt-auto min-w-0">
          <h3 className="line-clamp-2 text-[15px] font-bold leading-snug text-white [text-shadow:0_1px_8px_rgba(0,0,0,0.25)]">{item.title}</h3>
          <p className="mt-1 flex items-center gap-1 text-xs text-white/80">
            <GlobeIcon width={11} height={11} className="shrink-0" />
            <span className="truncate">
              {item.source_count} 个来源 ·{" "}
              {(item.last_content_at ?? 0) > 0 ? `最近更新 ${relTime(item.last_content_at!)}` : fmtDate(item.created_at)}
            </span>
          </p>
        </div>
        {/* 收藏浮层:平时隐藏,hover(或已收藏)时浮现;绝对定位,不参与布局故文字不联动。 */}
        {onToggleFav && (
          <div
            className={cn(
              "pointer-events-none absolute inset-0 rounded-2xl transition duration-150",
              fav ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            )}
            style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.42), rgba(0,0,0,0) 54%)" }}
          >
            {/* R1 诚实性⑤:铃=真的会响。只有挂着启用自动更新频道的智库才说「订阅」
                (会收到站内更新提醒);静态策展笔记本保持「收藏」语义 —— 两者是同一张
                notebook_favorites 表,差别只在承诺的措辞必须与事实一致。 */}
            <button
              type="button"
              aria-pressed={fav}
              title={
                item.has_feed
                  ? fav ? "取消订阅(更新将不再提醒)" : "订阅:该智库有更新时通过站内消息提醒你"
                  : fav ? "取消收藏" : "收藏到「精选笔记本」"
              }
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleFav(item);
              }}
              className={cn(
                "pointer-events-auto absolute right-3 top-3 inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold backdrop-blur transition active:scale-95",
                fav
                  ? "bg-white text-accent shadow-sm"
                  : "bg-white/20 text-white hover:bg-white/30"
              )}
            >
              <span>{item.has_feed ? "🔔" : fav ? "★" : "☆"}</span>
              {item.has_feed ? (fav ? "已订阅" : "订阅") : fav ? "已收藏" : "收藏"}
            </button>
          </div>
        )}
      </div>
    </a>
  );
}

/** 精选笔记本的列表行(表格风,对齐自有笔记本列表;只读,点开 /share)。 */
function FeaturedRow({
  item,
  onToggleFav,
}: {
  item: FeaturedItem;
  onToggleFav?: (item: FeaturedItem) => void;
}) {
  const fav = item.favorited;
  return (
    <a
      href={`/share/${item.id}`}
      className="group flex items-center gap-4 border-b border-edge px-4 py-2.5 transition hover:bg-panel2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base text-white"
          style={{ background: item.cover ?? "linear-gradient(135deg,#6d5ae6,#b765ec)" }}
        >
          {item.publisher_avatar ?? item.emoji}
        </span>
        <h3 className="truncate font-medium text-ink">{item.title}</h3>
        {item.publisher && (
          <span className="hidden shrink-0 truncate text-xs text-muted lg:inline">· {item.publisher}</span>
        )}
      </div>
      <span className="hidden w-32 shrink-0 text-sm text-ink2 sm:block">{item.source_count} 个来源</span>
      <span className="hidden w-36 shrink-0 text-sm text-ink2 md:block">{fmtDate(item.created_at)}</span>
      <span className="hidden w-32 shrink-0 text-sm text-ink2 sm:block">{relTime(item.created_at)}</span>
      <span className="hidden w-20 shrink-0 text-sm sm:block">
        <StatusTag pub={true} />
      </span>
      {onToggleFav ? (
        <button
          type="button"
          aria-pressed={fav}
          title={fav ? "取消收藏" : "收藏到「精选笔记本」"}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleFav(item);
          }}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base transition active:scale-90",
            fav ? "text-accent" : "text-muted hover:bg-panel2 hover:text-ink2"
          )}
        >
          {fav ? "★" : "☆"}
        </button>
      ) : (
        <span className="w-9 shrink-0" />
      )}
    </a>
  );
}

function HomeView({
  user,
  notebooks,
  loading,
  onOpen,
  onCreate,
  onDelete,
  onPin,
}: {
  user?: HomeUser;
  notebooks: Notebook[];
  loading: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
}) {
  const [sort, setSort] = useState<"recent" | "title" | "sources">("recent");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [tab, setTab] = useState<"all" | "mine" | "featured">("all");
  // 审查修复:问候语/日期挂载后按本地时钟计算。SSR 首屏用的是服务器时区,
  // 东八区用户大半天看到错的问候(且有水合不一致隐患)。
  const [clock, setClock] = useState<{ greet: string; date: string } | null>(null);
  useEffect(() => {
    setClock({
      greet: greeting(),
      date: new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }),
    });
  }, []);
  const [q, setQ] = useState("");
  const [featured, setFeatured] = useState<FeaturedItem[]>([]);

  // 记住网格/列表视图:首屏先用默认(避免 SSR 水合不一致),挂载后读上次选择沿用。
  useEffect(() => {
    const v = localStorage.getItem("nb_view");
    if (v === "grid" || v === "list") setView(v);
  }, []);

  useEffect(() => {
    if (!HOME_FEATURED_NOTEBOOKS_ENABLED) return;
    let alive = true;
    fetch("/api/featured")
      .then((r) => (r.ok ? r.json() : { notebooks: [] }))
      .then((d) => alive && setFeatured(d.notebooks ?? []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 收藏/取消收藏精选笔记本:乐观翻转,失败回滚。收藏的会进「精选笔记本」tab(我的收藏夹)。
  const toggleFav = useCallback(async (item: FeaturedItem) => {
    const next = !item.favorited;
    setFeatured((fs) => fs.map((f) => (f.id === item.id ? { ...f, favorited: next } : f)));
    try {
      const r = await fetch("/api/favorites", {
        method: next ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notebookId: item.id }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || "");
      }
    } catch (e) {
      setFeatured((fs) => fs.map((f) => (f.id === item.id ? { ...f, favorited: !next } : f)));
      toast((e as Error)?.message || "操作失败,请重试");
    }
  }, []);

  const ql = q.trim().toLowerCase();
  const filtered = notebooks
    .filter((n) => n.title.toLowerCase().includes(ql))
    .sort((a, b) => {
      // 置顶优先,其次按所选排序。
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return sort === "title"
        ? a.title.localeCompare(b.title)
        : sort === "sources"
        ? (b.source_count ?? 0) - (a.source_count ?? 0)
        : // 审查修复:「最近」按最近活动排(同一行展示的就是 last_activity),
          // 此前按 created_at 排 —— 同屏两套时间口径,刚编辑过的本子不上浮。
          (b.last_activity ?? b.created_at) - (a.last_activity ?? a.created_at);
    });
  const featuredFiltered = featured.filter((f) => f.title.toLowerCase().includes(ql));
  // 「精选笔记本」tab = 我收藏/订阅的精选(个人订阅夹);首页顶部精选区仍是全部精选(发现)。
  // 有更新的订阅排最前(诚实性:徽章驱动注意力)。
  const favoriteFeatured = featuredFiltered
    .filter((f) => f.favorited)
    .sort((a, b) => (b.unread ?? 0) - (a.unread ?? 0));
  // 方案 D 目录:领域 chips = category 去重(少于 3 家的领域并入「全部」不单列)+ 未读优先。
  const [featCat, setFeatCat] = useState("全部");
  const catCount = new Map<string, number>();
  for (const f of featured) if (f.category) catCount.set(f.category, (catCount.get(f.category) ?? 0) + 1);
  const featCats = [...catCount.entries()].filter(([, n]) => n >= 3).map(([c]) => c);
  const featuredDiscover = featured
    .filter((f) => featCat === "全部" || f.category === featCat)
    .sort((a, b) => (b.unread ?? 0) - (a.unread ?? 0));
  // 删除笔记本前确认:与工作区删除统一走 ConfirmDialog(替换原生 window.confirm),
  // 说明会连带删除笔记本下的全部内容,并展示笔记本标题。
  const [pendingDelNb, setPendingDelNb] = useState<Notebook | null>(null);
  const del = (nb: Notebook) => setPendingDelNb(nb);

  return (
    <div className="min-h-screen">
      <Toaster />
      <header className="sticky top-0 z-20 bg-canvas/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-3 py-3 sm:gap-4 sm:px-6">
          <div className="flex shrink-0 items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-[13px] bg-accent text-onAccent shadow-[0_6px_18px_-5px_rgba(109,90,230,0.55)]">
              <BrandMark size={28} />
            </div>
            <span className="hidden text-[17px] font-bold tracking-tight text-ink sm:block">猿笔记</span>
          </div>
          {/* prominent search (Mobbin-style) */}
          <div className="relative mx-auto min-w-0 w-full max-w-2xl">
            <SearchIcon
              width={17}
              height={17}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              name="search"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索你的笔记本……"
              className="h-11 w-full rounded-full border border-edge bg-panel2 pl-11 pr-4 text-sm outline-none transition focus:border-accent focus:bg-panel"
            />
          </div>
          {/* 邀请返利入口(E1):常驻顶栏、「创建笔记本」左侧 */}
          {user?.plan_tier !== "test" && user?.adminRole !== "super" && <ReferralPill />}
          <button
            onClick={onCreate}
            title="创建笔记本"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 text-sm font-semibold text-onAccent transition hover:brightness-110 sm:px-4"
          >
            <PlusIcon width={16} height={16} />
            <span className="hidden sm:inline">创建笔记本</span>
          </button>
          <SettingsMenu
            systemAdmin={user?.adminRole === "super"}
            triggerClassName="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-edge bg-panel px-3.5 text-[13px] font-semibold text-ink2 transition hover:border-accent/50 hover:text-ink"
          />
          {user && <NotificationBell onOpen={onOpen} />}
          {user && <AccountMenu user={user} />}
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-7">
        {/* greeting — quiet, time-aware welcome line above the shelves */}
        {!q && (
          <section className="mb-7 animate-fadeup">
            <h1 className="text-[26px] font-bold leading-tight tracking-tight">
              <span className="brand-text">{clock?.greet ?? "你好"}</span>
              {user?.name ? <span className="text-ink">,{user.name}</span> : null}
            </h1>
            <p className="mt-1 text-sm text-ink2">
              {clock?.date ?? ""}
              {notebooks.length > 0 && (
                <> · 你有 {notebooks.length} 个笔记本</>
              )}
            </p>
          </section>
        )}
        {/* 精选展示区(发现)— 仅「全部 + 网格」显示,平铺全部精选;每张卡 hover 可收藏/订阅。
            方案 D(领域智库目录):领域 chips = featured_category 前端过滤,少于 3 家的领域
            chip 隐藏(防点进空网格);有未读的智库排最前。 */}
        {HOME_FEATURED_NOTEBOOKS_ENABLED && tab === "all" && !q && view === "grid" && featured.length > 0 && (
          <section className="mb-9 space-y-4">
            <h2 className="text-base font-bold text-ink">精选笔记本</h2>
            {featCats.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {["全部", ...featCats].map((c) => (
                  <button
                    key={c}
                    onClick={() => setFeatCat(c)}
                    className={cn(
                      "shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] transition active:scale-[0.97]",
                      featCat === c
                        ? "border-accent bg-accent font-semibold text-onAccent"
                        : "border-edge bg-panel text-ink2 hover:text-ink"
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
              {featuredDiscover.map((f) => (
                <FeaturedCard key={f.id} item={f} onToggleFav={toggleFav} />
              ))}
            </div>
          </section>
        )}
        {/* filter row — tabs + count + view toggle + sort */}
        <div className="mb-7 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-full border border-edge bg-panel2 p-1">
            {([
              ["all", "全部"],
              ["mine", "我的笔记本"],
              ["featured", "精选笔记本"],
            ] as const)
              .filter(([k]) => HOME_FEATURED_NOTEBOOKS_ENABLED || k !== "featured")
              .map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={cn(
                    "rounded-full px-4 py-1.5 text-sm font-medium transition active:scale-[0.97]",
                    tab === k ? "bg-accent text-onAccent shadow-sm" : "text-ink2 hover:text-ink"
                  )}
                >
                  {label}
                </button>
              ))}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-ink2 sm:block">
              共显示{" "}
              <b className="font-semibold text-ink">
                {tab === "featured"
                  ? favoriteFeatured.length
                  : tab === "all"
                  ? filtered.length + featuredFiltered.length
                  : filtered.length}
              </b>{" "}
              个笔记本
            </span>
            {/* 视图切换:全部 / 我的 / 精选 都可在网格、列表间切 */}
            <div className="flex items-center gap-0.5 rounded-full border border-edge bg-panel2 p-1">
              {([
                ["grid", GridIcon],
                ["list", ListIcon],
              ] as const).map(([k, Icon]) => (
                <button
                  key={k}
                  onClick={() => {
                    setView(k);
                    localStorage.setItem("nb_view", k);
                  }}
                  title={k === "grid" ? "网格视图" : "列表视图"}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full transition active:scale-90",
                    view === k ? "bg-accent text-onAccent shadow-sm" : "text-ink2 hover:text-ink"
                  )}
                >
                  <Icon width={15} height={15} />
                </button>
              ))}
            </div>
            {/* 排序:精选暂不支持自定义排序,仅自有/全部显示 */}
            {tab !== "featured" && (
              <StyledSelect
                value={sort}
                onChange={(v) => setSort(v as "recent" | "title" | "sources")}
                options={[
                  { value: "recent", label: "最近" },
                  { value: "title", label: "标题" },
                  { value: "sources", label: "来源数" },
                ]}
              />
            )}
          </div>
        </div>

        {loading ? (
          <NotebookListSkeleton view={view} />
        ) : tab === "featured" ? (
          // 「精选笔记本」= 我收藏的精选(个人收藏夹)
          favoriteFeatured.length === 0 ? (
            q ? (
              <p className="rounded-2xl border border-edge bg-panel2 px-4 py-14 text-center text-sm text-ink2">
                没有匹配的收藏。
              </p>
            ) : (
              <div className="flex w-full flex-col items-center justify-center gap-5 rounded-[20px] border border-dashed border-edge py-12 text-center">
                {/* 幽灵占位卡:直接画出「收进来会长这样」,替代图标块 */}
                <div className="grid w-full max-w-[480px] grid-cols-2 gap-3.5 px-6 sm:grid-cols-3">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className={`flex-col gap-2 rounded-2xl border border-dashed border-edge p-2.5 opacity-80 ${
                        i === 2 ? "hidden sm:flex" : "flex"
                      }`}
                    >
                      <div
                        className="relative h-[58px] rounded-[9px]"
                        style={{
                          background:
                            "repeating-linear-gradient(135deg, rgb(var(--c-accent) / 0.07) 0 8px, transparent 8px 16px)",
                        }}
                      >
                        {i === 0 && (
                          <span className="absolute inset-0 grid place-items-center text-edge">
                            <svg
                              viewBox="0 0 24 24"
                              width="20"
                              height="20"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={1.6}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden
                            >
                              <path d="M12 3.4l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
                            </svg>
                          </span>
                        )}
                      </div>
                      <div className="h-[7px] w-4/5 rounded bg-edge" />
                      <div className="h-1.5 w-1/2 rounded bg-edge/60" />
                    </div>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <p className="text-[15px] font-semibold text-ink">还没有订阅精选笔记本</p>
                  <p className="mx-auto max-w-[300px] text-[13px] leading-relaxed text-ink2">
                    在精选笔记本上点 <span className="font-semibold text-accent">☆ 订阅</span>
                    ,它们就会排进这里;有更新会亮红色徽章并进消息中心。
                  </p>
                </div>
                <button
                  onClick={() => setTab("all")}
                  className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-onAccent transition hover:brightness-110 active:scale-95"
                >
                  去逛精选笔记本
                </button>
              </div>
            )
          ) : view === "grid" ? (
            <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3">
              {favoriteFeatured.map((f) => (
                <FeaturedCard key={f.id} item={f} onToggleFav={toggleFav} />
              ))}
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-4 border-b border-edge px-4 pb-2.5 text-xs font-medium text-muted">
                <span className="min-w-0 flex-1">标题</span>
                <span className="hidden w-32 shrink-0 sm:block">来源</span>
                <span className="hidden w-36 shrink-0 md:block">创建日期</span>
                <span className="hidden w-32 shrink-0 sm:block">最近更新</span>
                <span className="hidden w-20 shrink-0 sm:block">状态</span>
                <span className="w-9 shrink-0" />
              </div>
              {favoriteFeatured.map((f) => (
                <FeaturedRow key={f.id} item={f} onToggleFav={toggleFav} />
              ))}
            </div>
          )
        ) : notebooks.length === 0 && !(tab === "all" && featuredFiltered.length > 0) ? (
          <button
            onClick={onCreate}
            className="flex w-full flex-col items-center justify-center gap-3 rounded-[20px] border border-dashed border-edge py-20 text-center text-ink2 transition hover:border-accent hover:text-ink"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-panel2">
              <PlusIcon />
            </div>
            <div>
              <p className="font-medium text-ink">创建你的第一个笔记本</p>
              <p className="text-sm">上传 PDF、文本或链接,开始向它们提问。</p>
            </div>
          </button>
        ) : filtered.length === 0 && !(tab === "all" && featuredFiltered.length > 0) ? (
          <p className="rounded-2xl border border-edge bg-panel2 px-4 py-14 text-center text-sm text-ink2">
            没有匹配的笔记本。
          </p>
        ) : view === "grid" ? (
          <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3">
            {!q && <NewCard onCreate={onCreate} />}
            {filtered.map((nb) => (
              <NotebookCard key={nb.id} notebook={nb} onOpen={onOpen} onDelete={() => del(nb)} onPin={onPin} />
            ))}
            {/* 搜索态:精选墙(仅 !q 显示)此时隐藏 → 命中的精选并入网格,避免整页空白 */}
            {tab === "all" && q && featuredFiltered.map((f) => <FeaturedCard key={f.id} item={f} onToggleFav={toggleFav} />)}
          </div>
        ) : (
          <div>
            {/* 表头(列宽与下方各行一致) */}
            <div className="flex items-center gap-4 border-b border-edge px-4 pb-2.5 text-xs font-medium text-muted">
              <span className="min-w-0 flex-1">标题</span>
              <span className="hidden w-32 shrink-0 sm:block">来源</span>
              <span className="hidden w-36 shrink-0 md:block">创建日期</span>
              <span className="hidden w-32 shrink-0 sm:block">最近更新</span>
              <span className="hidden w-20 shrink-0 sm:block">状态</span>
              <span className="w-9 shrink-0" />
            </div>
            {filtered.map((nb) => (
              <NotebookRow key={nb.id} notebook={nb} onOpen={onOpen} onDelete={() => del(nb)} onPin={onPin} />
            ))}
            {/* 全部:我的笔记本之后接精选(只读) */}
            {tab === "all" && featuredFiltered.map((f) => <FeaturedRow key={f.id} item={f} onToggleFav={toggleFav} />)}
          </div>
        )}
      </main>
      {pendingDelNb && (
        <ConfirmDialog
          title="要删除这个笔记本吗?"
          subject={pendingDelNb.title}
          message="笔记本及其全部来源、笔记、智能笔记都将被永久删除,且无法恢复。"
          confirmLabel="删除"
          onConfirm={() => {
            setPendingDelNb(null);
            onDelete(pendingDelNb.id);
          }}
          onCancel={() => setPendingDelNb(null)}
        />
      )}
    </div>
  );
}

function NewCard({ onCreate }: { onCreate: () => void }) {
  return (
    <button onClick={onCreate} className="group w-full text-left">
      <div className="flex aspect-[16/9] flex-col items-center justify-center gap-3 rounded-2xl bg-panel2/70 transition duration-150 group-hover:bg-accentSoft/50">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accentSoft text-accent">
          <PlusIcon width={20} height={20} />
        </div>
        <span className="text-sm font-semibold text-ink">新建笔记本</span>
      </div>
    </button>
  );
}

/** Kebab 菜单(卡片色带 / 列表行通用)。Portal 到 body 避免被卡片 overflow/transform 裁剪;
 *  按 ⋮ 的视口坐标定位;mousedown 外部 / Esc / 滚动 关闭。 */
function CardMenu({
  variant,
  onOpen,
  onDelete,
  onPin,
  pinned,
}: {
  variant: "band" | "plain";
  onOpen: () => void;
  onDelete: () => void;
  onPin: () => void;
  pinned: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        aria-label="更多操作"
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg transition",
          variant === "band"
            ? "text-ink/70 hover:bg-black/15 hover:text-ink"
            : "text-ink2 hover:bg-black/5 hover:text-ink"
        )}
      >
        <DotsIcon width={16} height={16} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ position: "fixed", top: pos.top, right: pos.right }}
            onClick={(e) => e.stopPropagation()}
            className={`z-[80] w-40 overflow-hidden ${MENU_PANEL}`}
          >
            <button onClick={() => { setOpen(false); onOpen(); }} className={MENU_ITEM}>
              <BookIcon width={15} height={15} /> 打开
            </button>
            <button onClick={() => { setOpen(false); onPin(); }} className={MENU_ITEM}>
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6z" />
                <path d="M12 15v5" />
              </svg>
              {pinned ? "取消置顶" : "置顶"}
            </button>
            <button onClick={() => { setOpen(false); onDelete(); }} className={MENU_ITEM_DANGER}>
              <TrashIcon width={15} height={15} /> 删除
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

function NotebookCard({
  notebook,
  onOpen,
  onDelete,
  onPin,
}: {
  notebook: Notebook;
  onOpen: (id: string) => void;
  onDelete: () => void;
  onPin: (id: string, pinned: boolean) => void;
}) {
  const hue = hueFor(notebook.id);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(notebook.id)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(notebook.id)}
      className="group cursor-pointer animate-fadeup"
    >
      {/* single tile — emoji top-left, kebab top-right, title + meta inside (NotebookLM style) */}
      <div
        className="relative flex aspect-[16/9] flex-col overflow-hidden rounded-2xl p-4 transition duration-150 group-hover:ring-2 group-hover:ring-accent/40"
        style={{ background: `linear-gradient(135deg, ${hue}45 0%, ${hue}26 50%, ${hue}1a 100%)` }}
      >
        <CoverArt tone={hue} seed={notebook.id} />
        <div className="relative flex items-start justify-between">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/55 text-[19px] shadow-sm backdrop-blur-sm transition duration-150 group-hover:scale-105"
            aria-hidden
          >
            {notebook.emoji}
          </span>
          <div className="-mr-1.5 -mt-1.5">
            <CardMenu variant="plain" onOpen={() => onOpen(notebook.id)} onDelete={onDelete} onPin={() => onPin(notebook.id, !notebook.pinned)} pinned={!!notebook.pinned} />
          </div>
        </div>
        <div className="relative mt-auto min-w-0">
          <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug text-ink">
            {notebook.title}
          </h3>
          <p className="mt-1 flex items-center gap-1 truncate text-xs text-ink2">
            {notebook.pinned && (
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent" aria-hidden>
                <path d="M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6z" />
                <path d="M12 15v5" />
              </svg>
            )}
            {notebook.public && <GlobeIcon width={11} height={11} className="shrink-0" />}
            <span className="truncate">
              {fmtDate(notebook.created_at)} · {notebook.source_count ?? 0} 个来源
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

function NotebookRow({
  notebook,
  onOpen,
  onDelete,
  onPin,
}: {
  notebook: Notebook;
  onOpen: (id: string) => void;
  onDelete: () => void;
  onPin: (id: string, pinned: boolean) => void;
}) {
  const hue = hueFor(notebook.id);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(notebook.id)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(notebook.id)}
      className="group flex cursor-pointer items-center gap-4 border-b border-edge px-4 py-2.5 transition hover:bg-panel2"
    >
      {/* 标题列(图标 + 标题) */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {notebook.cover_image ? (
          <img src={notebook.cover_image} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
        ) : (
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
            style={{ background: `${hue}24` }}
          >
            {notebook.emoji}
          </span>
        )}
        {notebook.pinned && (
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent" aria-hidden>
            <path d="M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6z" />
            <path d="M12 15v5" />
          </svg>
        )}
        <h3 className="truncate font-medium text-ink">{notebook.title}</h3>
        {notebook.public && <GlobeIcon width={13} height={13} className="shrink-0 text-muted" />}
      </div>
      {/* 来源 / 创建日期 / 角色 列(窄屏渐次隐藏,与表头列宽一致) */}
      <span className="hidden w-32 shrink-0 text-sm text-ink2 sm:block">
        {notebook.source_count ?? 0} 个来源
      </span>
      <span className="hidden w-36 shrink-0 text-sm text-ink2 md:block">{fmtDate(notebook.created_at)}</span>
      <span className="hidden w-32 shrink-0 text-sm text-ink2 sm:block">{relTime(notebook.last_activity ?? notebook.created_at)}</span>
      <span className="hidden w-20 shrink-0 text-sm sm:block">
        <StatusTag pub={!!notebook.public} />
      </span>
      <span className="flex w-9 shrink-0 justify-end">
        <CardMenu variant="plain" onOpen={() => onOpen(notebook.id)} onDelete={onDelete} onPin={() => onPin(notebook.id, !notebook.pinned)} pinned={!!notebook.pinned} />
      </span>
    </div>
  );
}

/** 笔记本列表加载占位:随当前视图自适应——网格→卡片骨架,列表→行骨架(含表头,
 *  避免数据到位后布局跳动)。纯展示、薰衣草系无图标,呼吸式 animate-pulse。 */
export function NotebookListSkeleton({ view }: { view: "grid" | "list" }) {
  if (view === "grid") {
    return (
      <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3" aria-hidden aria-busy>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="flex aspect-[16/9] animate-pulse flex-col rounded-2xl bg-panel2 p-4"
            style={{ animationDelay: `${(i % 3) * 120}ms` }}
          >
            <div className="flex items-start justify-between">
              <span className="h-9 w-9 rounded-xl bg-panel/80" />
              <span className="h-4 w-4 rounded bg-panel/60" />
            </div>
            <div className="mt-auto space-y-2">
              <span className="block h-3.5 rounded bg-panel/80" style={{ width: `${80 - (i % 3) * 14}%` }} />
              <span className="block h-2.5 w-2/5 rounded bg-panel/60" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden aria-busy>
      <div className="flex items-center gap-4 border-b border-edge px-4 pb-2.5 text-xs font-medium text-muted">
        <span className="min-w-0 flex-1">标题</span>
        <span className="hidden w-32 shrink-0 sm:block">来源</span>
        <span className="hidden w-36 shrink-0 md:block">创建日期</span>
        <span className="hidden w-32 shrink-0 sm:block">最近更新</span>
        <span className="hidden w-20 shrink-0 sm:block">状态</span>
        <span className="w-9 shrink-0" />
      </div>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="flex animate-pulse items-center gap-4 border-b border-edge px-4 py-2.5"
          style={{ animationDelay: `${(i % 3) * 120}ms` }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="h-9 w-9 shrink-0 rounded-lg bg-panel2" />
            <span className="h-3.5 rounded bg-panel2" style={{ width: `${46 - (i % 3) * 9}%` }} />
          </div>
          <span className="hidden h-3 w-32 shrink-0 rounded bg-panel2 sm:block" />
          <span className="hidden h-3 w-36 shrink-0 rounded bg-panel2 md:block" />
          <span className="hidden h-3 w-32 shrink-0 rounded bg-panel2 sm:block" />
          <span className="hidden h-5 w-14 shrink-0 rounded-full bg-panel2 sm:block" />
          <span className="w-9 shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// notebook view (sources + chat)
// ---------------------------------------------------------------------------

function NotebookView({
  user,
  notebook,
  setNotebook,
  loading,
  sources,
  setSources,
  messages,
  setMessages,
  onBack,
  onRename,
  onCreate,
  onSwitchNotebook,
  autoAddForId,
  onAutoAddConsumed,
  hiddenArtifacts,
  userHiddenTiles,
  onSaveUserHiddenTiles,
}: {
  user?: HomeUser;
  notebook: Notebook | null;
  setNotebook: React.Dispatch<React.SetStateAction<Notebook | null>>;
  loading: boolean;
  sources: Source[];
  setSources: React.Dispatch<React.SetStateAction<Source[]>>;
  messages: UiMessage[];
  setMessages: React.Dispatch<React.SetStateAction<UiMessage[]>>;
  onBack: () => void;
  onRename: (title: string) => void;
  // 顶栏「创建笔记本」:复用 HomeClient 的 createNotebook(建好即切到新本)。
  onCreate: () => void;
  // 切到另一个笔记本(跨本被动再发现点开他本的项时用);切本由 HomeClient 统一管。
  onSwitchNotebook: (id: string) => void;
  // 刚新建的笔记本 id:本视图加载到它后自动弹「添加来源」,弹一次即 onAutoAddConsumed。
  autoAddForId: string | null;
  onAutoAddConsumed: () => void;
  /** 管理员在后台隐藏的智能输出 kind 列表;透传给 StudioPanel 过滤生成磁贴。 */
  hiddenArtifacts?: string[];
  /** 用户自定义隐藏的生成磁贴(tile id 列表)+ 保存回调(乐观更新 + 持久化)。 */
  userHiddenTiles?: string[];
  onSaveUserHiddenTiles?: (next: string[]) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  // 配额用尽时贴在对话顶部的横幅文案(来自 429 的 quota 错误);null = 不显示。
  const [quotaMsg, setQuotaMsg] = useState<string | null>(null);
  // 护城河 1:当前用户的单文件上传字节上限(从 /api/usage 拿,与服务端 sources/route.ts 同源)。
  // 未拉到之前 fallback 25MB,避免开弹窗竞态时预检读到 undefined 放行超大文件。
  const [maxFileBytes, setMaxFileBytes] = useState<number>(25 * 1024 * 1024);
  // 当前后台生效的积分消耗 + 下载水印权益；拉取前按基础权益保守处理。
  const [studioCreditCosts, setStudioCreditCosts] = useState<Record<string, number>>({
    ...STUDIO_CREDIT_COSTS,
  });
  const [chatCreditCost, setChatCreditCost] = useState<number>(CREDIT_COSTS.chat);
  const [downloadWatermark, setDownloadWatermark] = useState(true);
  // 审查修复:在途异步回写的切本守卫。addSource/importUrls 等的收尾刷新是晚到的
  // 异步响应,用户中途切换笔记本后,旧本数据会被写进新本视图。写回前核对此 ref。
  const notebookIdRef = useRef<string | null>(null);
  notebookIdRef.current = notebook?.id ?? null;
  const applyUsage = useCallback((d: Record<string, any>) => {
    const dailyLimit = Number(d.daily?.limit ?? d.dailyLimit ?? 0);
    const dailyRemaining = Number(
      d.daily?.remaining ?? Math.max(0, dailyLimit - Number(d.today ?? 0))
    );
    const bonusBalance = Number(d.bonus?.balance ?? d.bonusCredits ?? 0);
    const totalAvailable = Number(d.totalAvailable ?? dailyRemaining + bonusBalance);
    const accessActive = d.access?.active ?? totalAvailable !== 0;
    setQuotaMsg(
      !accessActive || (dailyLimit >= 0 && totalAvailable <= 0)
        ? dailyLimit > 0
          ? `今日积分已用完（每日 ${dailyLimit} 积分），明日自动恢复`
          : "积分已用完，可通过邀请活动获取积分或联系管理员补充"
        : null
    );
    if (typeof d.maxFileBytes === "number" && d.maxFileBytes >= 0) setMaxFileBytes(d.maxFileBytes);
    if (d.studioCreditCosts && typeof d.studioCreditCosts === "object") {
      setStudioCreditCosts((prev) => ({ ...prev, ...d.studioCreditCosts }));
    }
    if (Number.isFinite(Number(d.creditCosts?.chat))) {
      setChatCreditCost(Math.max(0, Math.round(Number(d.creditCosts.chat))));
    }
    if (typeof d.downloadWatermark === "boolean") setDownloadWatermark(d.downloadWatermark);
  }, []);

  // 打开笔记本时只按当前可用积分或不限量权益裁决，不设置额外入口墙。
  useEffect(() => {
    let alive = true;
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) applyUsage(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [notebook?.id, applyUsage]);

  // 管理员补发或活动积分到账后无需刷新整页，立即解除旧 quotaMsg 并同步能力。
  useEffect(() => {
    const onUsage = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail && typeof detail === "object") applyUsage(detail);
    };
    window.addEventListener("nb:usage-updated", onUsage);
    return () => window.removeEventListener("nb:usage-updated", onUsage);
  }, [applyUsage]);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [sending, setSending] = useState(false);
  // 回答序号:done 一到就解锁输入(不等追问建议),旧流迟到的 finally 收尾不许把
  // 新一轮回答的 sending 关掉(解锁后用户可能已发出下一问)。
  const streamSeqRef = useRef(0);
  // 「停止生成」按钮:sending 期间发送按钮变停止,点击触发 abort → streamChat 的 fetch 中止 →
  // catch 分支识别 aborted 显示「已停止生成」,当前已流出的正文保留。
  const streamAbortRef = useRef<AbortController | null>(null);
  // regenerate 若直接依赖 messages,流式每个 token 都会换新函数,击穿 MessageBubble
  // 的 memo(全部历史消息重渲染)——改读同步 ref,依赖里去掉 messages。
  const messagesRef = useRef<UiMessage[]>(messages);
  messagesRef.current = messages;
  // 反馈请求可快速连点；用每条消息的序号防止较早的失败回包
  // 把较新的用户选择回滚掉。
  const feedbackMutationSeq = useRef(new Map<string, number>());
  // 最近一轮技能身份与可见用户文本成对保存;刷新后可恢复,且重生成前
  // 必须再比对 message,防把 A 本/上一轮的 skillId 套到 B 本或普通问题上。
  const [notes, setNotes] = useState<Note[]>([]);
  const [outputs, setOutputs] = useState<StudioOutput[]>([]);
  // 笔记/智能笔记单独拉取(与来源不同步),需独立的加载态驱动右栏骨架占位。
  const [studioLoading, setStudioLoading] = useState(true);
  // 并行生成:kind → 在途任务(jobId/排队|运行/假进度/取材文案)。服务端允许每用户
  // 3 个在途,前端不再全局锁 —— 只挡「同一 kind 重复点」;进度/文案全部按 kind 记。
  const [generating, setGenerating] = useState<GenMap>({});
  // 轮询循环/取消回调里需要同步读最新值(闭包里的 state 会陈旧),与 notebookIdRef 同款。
  const generatingRef = useRef<GenMap>({});
  generatingRef.current = generating;
  // 双击竞态守卫:setState 异步,连点同一磁贴会两次通过 state 检查 → 用同步 Set 兜住。
  const genInflight = useRef<Set<StudioKind>>(new Set());
  // CAD 在线参数编辑单独按父制品锁定；它与普通 CAD 生成共用同一几何 worker，
  // 任一侧在途时阻止另一侧再次提交，避免同 kind 状态互相覆盖。
  const cadRevisionInflight = useRef<Set<string>>(new Set());
  /** 更新某 kind 的在途状态(仅当它仍在途 —— 收尾后迟到的轮询不会复活状态)。 */
  const patchGenKind = useCallback((kind: StudioKind, patch: Partial<GenJobState>) => {
    setGenerating((prev) => (prev[kind] ? { ...prev, [kind]: { ...prev[kind]!, ...patch } } : prev));
  }, []);
  /** 该 kind 生成收尾(done/error/canceled)→ 从在途表移除。 */
  const clearGenKind = useCallback((kind: StudioKind) => {
    setGenerating((prev) => {
      if (!(kind in prev)) return prev;
      const next = { ...prev };
      delete next[kind];
      return next;
    });
  }, []);
  const [openDoc, setOpenDoc] = useState<StudioOutput | null>(null);
  // 测验在右栏内联作答(NotebookLM 式),与中栏对话并存;不走 openDoc 中栏弹窗。
  const [quizPanel, setQuizPanel] = useState<StudioOutput | null>(null);
  // 课代表包(B站三连):armed = 已就绪待触发三连的来源 id(addSource 声明在
  // runKebanPack 之前,用状态 + effect 解耦声明顺序);banner = 三件套全部完成后的
  // 一次性横幅(guideId 指向刚生成的学习指南,复制总结取它;刷新即消失,MVP)。
  const [kebanArmed, setKebanArmed] = useState<string | null>(null);
  const [kebanBanner, setKebanBanner] = useState<{ guideId: string } | null>(null);
  const [viewSourcesFor, setViewSourcesFor] = useState<StudioOutput | null>(null);
  const [playingAudio, setPlayingAudio] = useState<StudioOutput | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [openNote, setOpenNote] = useState<Note | null>(null);
  const [selOverview, setSelOverview] = useState<
    { summary: string; suggested_questions: string[] } | null
  >(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClearChat, setConfirmClearChat] = useState(false);
  // Active "skill". chat-mode skills steer the persona of subsequent answers;
  // one-shot / workflow skills fire a prompt immediately (not held in state).
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  useEffect(() => {
    // persona 是当前笔记本对话态,切本不继承；一键技能身份由 messages.skill_id 持久化。
    setActiveSkill(null);
  }, [notebook?.id]);
  const [shareOpen, setShareOpen] = useState(false);
  // Which artifact (if any) the share dialog was opened from — drives the
  // "…和音频概览" / "复制指向音频概览的链接" wording. undefined = whole notebook.
  const [shareKind, setShareKind] = useState<string | undefined>(undefined);
  // 生成配置弹窗:点击磁贴(音频概览/思维导图/PDF报告/演示文稿/数据表格/图片概述)时打开。
  const [genConfig, setGenConfig] = useState<
    "mindmap" | "reports" | "table" | "slides" | "audio" | "video" | "infographic" | "quiz" | "flashcards" | "excalidraw" | "xhs" | "drawviso" | "cad" | null
  >(null);
  // C5:音频「声音」选择 —— 配置弹窗本体在 Studio.tsx(GenerateConfigModal,本次不改它),
  // 音频确认后先暂存 (kind, opts) 弹这一步挑音色预设,选完把 voices key 并进生成请求体。
  const [voicePick, setVoicePick] = useState<{ kind: StudioKind; opts: GenOpts } | null>(null);
  // B8:手机端(<1024px)三栏改为底部 tab 驱动单视图;桌面端(lg+)三栏并排与
  // 折叠逻辑不变,二者互不干扰(与 PublicNotebook 同款范式)。
  const [mobileTab, setMobileTab] = useState<"chat" | "sources" | "studio">("chat");
  // 切本/深链进来默认回到「对话」tab,不残留上一本的 tab 位置。
  useEffect(() => {
    setMobileTab("chat");
  }, [notebook?.id]);
  // B8:是否处于 <lg 单视图布局(与 max-lg 断点同源)。桌面折叠位(studioCollapsed)
  // 只在 lg+ 三栏并排时有意义;单视图下右栏必须整块铺满,不能走折叠窄条分支,
  // 否则移动端「studio」tab 只显示一列磁贴且一点就把桌面折叠态改回 0。
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const sync = () => setIsNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  // Collapsible side panels (persisted), so the chat can take the full width.
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false);
  const [studioCollapsed, setStudioCollapsed] = useState(false);
  useEffect(() => {
    setSourcesCollapsed(localStorage.getItem("nb_sources_collapsed") === "1");
    setStudioCollapsed(localStorage.getItem("nb_studio_collapsed") === "1");
  }, []);
  const toggleSources = useCallback(() => {
    setSourcesCollapsed((v) => {
      localStorage.setItem("nb_sources_collapsed", v ? "0" : "1");
      return !v;
    });
  }, []);
  const toggleStudio = useCallback(() => {
    setStudioCollapsed((v) => {
      localStorage.setItem("nb_studio_collapsed", v ? "0" : "1");
      return !v;
    });
  }, []);
  // 「快速研究」联动:聊天里点无来源向导给的研究建议 → 展开左栏 + 预填并运行快速研究。
  // n 每次自增,InlineDiscover 据此重跑(同一话题再点也能触发)。
  const [autoResearch, setAutoResearch] = useState<{ q: string; n: number; mode: "fast" | "deep" } | null>(null);
  const onQuickResearch = useCallback((query: string, mode: "fast" | "deep" = "fast") => {
    setSourcesCollapsed(false);
    localStorage.setItem("nb_sources_collapsed", "0");
    setAutoResearch((r) => ({ q: query, n: (r?.n ?? 0) + 1, mode }));
  }, []);

  const readyCount = useMemo(() => sources.filter((s) => s.status === "ready").length, [sources]);
  const selectedIds = useMemo(
    () => sources.filter((s) => s.status === "ready" && s.selected).map((s) => s.id),
    [sources]
  );
  const notebookId = notebook?.id;
  useEffect(() => {
    // openNotebook 会先把 notebook 置 null 再拉 B 本；null 窗口就必须清掉 A 本列表，
    // 不能等 B 本到达后才清，否则右栏仍可误操作 A 本制品。
    setStudioLoading(true);
    setNotes([]);
    setOutputs([]);
    setGenerating({});
    // 课代表包状态只属于原笔记本,切本一并清零。
    setKebanArmed(null);
    setKebanBanner(null);
    if (!notebookId) return;
    let alive = true;
    Promise.all([
      fetch(`/api/notebooks/${notebookId}/notes`).then((r) => r.json()),
      fetch(`/api/notebooks/${notebookId}/studio`).then((r) => r.json()),
    ])
      .then(([n, s]) => {
        if (!alive) return;
        setNotes(n.notes ?? []);
        setOutputs(s.outputs ?? []);
        // 审查修复:此前 GET /studio 返回的 jobs 字段无人消费,刷新/切本时会
        // 「看不到在途任务」→ 用户重复提交,把在途上限占满。这里恢复 UI 生成态,
        // 让「生成中」磁贴+进度条与 worker 真实进度对齐。并行生成:恢复全部在途任务。
        const jobs = (s.jobs ?? []) as { id: string; kind: StudioKind; progress: number; status: string }[];
        for (const active of jobs.filter((j) => j.status === "queued" || j.status === "running")) {
          const kind = active.kind;
          // 该 kind 已有同一任务在轮询(generateStudio 循环还活着)→ 别再起重复循环。
          if (generatingRef.current[kind]?.jobId === active.id) continue;
          setGenerating((prev) => ({
            ...prev,
            [kind]: {
              jobId: active.id,
              status: active.status === "running" ? "running" : "queued",
              progress: active.progress ?? 0,
            } satisfies GenJobState,
          }));
          // 轮询该任务直到结束(与 generateStudio 里 for(;;) 同款,但独立循环)。
          (async () => {
            const jobId = active.id;
            for (;;) {
              await new Promise((r) => setTimeout(r, 1200));
              if (!alive) return;
              try {
                const jr = await fetch(`/api/jobs/${jobId}`);
                if (!jr.ok) break;
                const jd = await jr.json();
                const job = jd.job as { status: string; progress: number; error?: string | null };
                if (!alive) return;
                if (job.status === "queued" || job.status === "running") {
                  patchGenKind(kind, { status: job.status, progress: job.progress ?? 0 });
                  continue;
                }
                if (job.status === "done") {
                  const sr = await fetch(`/api/notebooks/${notebookId}/studio`);
                  const sd = await sr.json();
                  if (alive) {
                    setOutputs(sd.outputs ?? []);
                  }
                } else if (job.status === "error" && alive) {
                  toast(job.error || "生成失败，请重试", "error");
                }
                break; // done / error / canceled 都收尾
              } catch {
                break;
              }
            }
            if (alive) clearGenKind(kind);
          })();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setStudioLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [notebookId]);

  // 刷新后「处理中」的来源永远转圈:解析在服务端后台继续,但客户端此前没有任何状态
  // 轮询。存在真实(非 pending- 占位,占位由 addSource 的在途 POST 自行收尾)processing
  // 来源时,每 4 秒拉一次来源列表回写状态,全部就绪/失败即停;切本/卸载清定时器。
  const hasProcessing = sources.some(
    (s) => s.status === "processing" && !s.id.startsWith("pending-")
  );
  useEffect(() => {
    if (!notebookId || !hasProcessing) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/notebooks/${notebookId}/sources`);
        if (!r.ok || !alive || notebookIdRef.current !== notebookId) return;
        const d = await r.json();
        const map = new Map(((d.sources ?? []) as Source[]).map((s) => [s.id, s] as const));
        setSources((prev) =>
          prev.map((s) => {
            const nx = map.get(s.id);
            // 服务端为准回写状态;selected 保留本地值,避免与勾选 PATCH 竞态闪跳。
            return nx ? { ...nx, selected: s.selected } : s;
          })
        );
      } catch {
        /* 单次失败静默,下个周期重试 */
      }
    }, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [notebookId, hasProcessing, setSources]);

  // Keep the empty-state overview + suggested questions consistent with the
  // selected sources: all sources selected → cached notebook-wide overview;
  // a subset → regenerate scoped to that subset (debounced).
  const selKey = selectedIds.join(",");
  useEffect(() => {
    if (!notebookId || messages.length > 0) return;
    if (selectedIds.length === 0 || selectedIds.length === readyCount) {
      setSelOverview(null);
      setOverviewLoading(false);
      return;
    }
    let alive = true;
    setOverviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/notebooks/${notebookId}/overview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceIds: selectedIds }),
        });
        if (r.ok && alive) {
          const d = await r.json();
          setSelOverview({
            summary: d.summary || "",
            suggested_questions: d.suggested_questions || [],
          });
        }
      } catch {
        /* keep previous overview */
      } finally {
        if (alive) setOverviewLoading(false);
      }
    }, 600);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, messages.length, notebookId, readyCount]);

  const openCitation = useCallback((c: Citation) => {
    if (c.source_kind === "web" && c.source_url && /^https?:\/\//i.test(c.source_url)) {
      const opened = window.open(c.source_url, "_blank", "noopener,noreferrer");
      if (opened) opened.opener = null;
      return;
    }
    setViewer({
      sourceId: c.source_id,
      title: c.source_title,
      snippet: c.quote || c.snippet,
      chunkIndex: c.chunk_index,
      sourceStart: c.source_start,
      sourceEnd: c.source_end,
      sourceContentHash: c.source_content_hash,
    });
  }, []);

  const openSource = useCallback((s: Source) => {
    if (s.status !== "ready") return;
    setViewer({ sourceId: s.id, title: s.title });
  }, []);

  const addSource = useCallback(
    // D3:返回逐项结果供批量导入结果面板汇总;opts.silent=批量模式(不逐项 toast,
    // 由面板统一呈现)。单项调用忽略返回值即可,行为与之前一致。
    async (payload: AddPayload, opts?: { silent?: boolean }): Promise<ImportOutcome> => {
      // 乐观占位:立即在列表顶部显示「处理中」(带标题/图标),后台解析后替换为真实来源,
      // 失败则移除占位并提示。让「添加来源」点完即关窗、来源即时进列表(与发现导入一致)。
      const phTitle =
        payload.kind === "file"
          ? payload.file.name
          : payload.kind === "text"
          ? payload.title || "新建文本"
          : payload.url;
      if (!notebook) return { name: phTitle, outcome: "fail", reason: "笔记本不存在" };
      const phUrl =
        payload.kind === "url" || payload.kind === "bilibili" ? payload.url : undefined;
      const ph = pendingSource(notebook.id, phTitle, phUrl);
      // 课代表包:勾选后占位行副文案改为提示解析完成后的自动动作(SourceItem 的
      // 「处理中」分支只对 pending- 占位读 summary,不影响重新导入等真实来源)。
      const keban = payload.kind === "bilibili" && !!payload.keban;
      if (keban) ph.summary = "解析后将自动生成课代表包";
      setSources((prev) => [ph, ...prev]);
      try {
        let res: Response;
        if (payload.kind === "file") {
          const fd = new FormData();
          fd.append("file", payload.file);
          res = await fetch(`/api/notebooks/${notebook.id}/sources`, { method: "POST", body: fd });
        } else {
          res = await fetch(`/api/notebooks/${notebook.id}/sources`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              payload.kind === "url"
                ? { type: "url", url: payload.url }
                : payload.kind === "bilibili"
                ? { type: "bilibili", url: payload.url }
                : { text: payload.text, title: payload.title }
            ),
          });
        }
        const data = await res.json();
        // Obsidian 库(zip)导入:返回批量来源(processing 先行,后台解析,已有轮询会刷新)。
        if (res.ok && Array.isArray(data.sources)) {
          const batch = data.sources as Source[];
          if (notebookIdRef.current !== notebook.id) return { name: phTitle, outcome: "ok" as const };
          setSources((prev) => [
            ...batch,
            ...prev.filter((s) => s.id !== ph.id && !batch.some((b) => b.id === s.id)),
          ]);
          const parts = [`已导入 ${batch.length} 个来源`];
          if (data.duplicates) parts.push(`${data.duplicates} 组与已有内容重复已跳过`);
          if (data.skipped) parts.push(`${data.skipped} 个文件不支持已跳过`);
          if (!opts?.silent) toast(`${parts.join(",")},正在后台解析…`);
          return { name: phTitle, outcome: "ok" as const };
        }
        if (!res.ok || !data.source) throw new Error(data?.error || "添加来源失败");
        const added = data.source as Source;
        // 逐项结论:服务端查重命中返回 duplicate:true;入库但解析失败(ingest 抛错)
        // 返回 201 + status:"error"(此时来源已在左栏,行内自带「重新导入」,不给面板重试)。
        const outcome: ImportOutcome = data.duplicate
          ? { name: phTitle, outcome: "dup", reason: "与已有来源重复,已跳过" }
          : added.status === "error"
          ? { name: phTitle, outcome: "fail", reason: added.error || "解析失败" }
          : { name: phTitle, outcome: "ok" };
        if (notebookIdRef.current !== notebook.id) return outcome; // 已切本,别把旧本数据写进新视图
        setSources((prev) => [added, ...prev.filter((s) => s.id !== ph.id && s.id !== added.id)]);
        if (data.duplicate && !opts?.silent) toast("该来源已在此笔记本中");
        // 审查 #5:服务端截断透明化,弹诚实提示(此前静默 slice,用户以为全导入了)。
        if (data.truncated && !opts?.silent) {
          const keptK = Math.round((data.keptChars ?? 0) / 10000);
          const totalK = Math.round((data.truncatedChars ?? 0) / 10000);
          toast(`内容过长,仅导入前 ${keptK} 万字符(原文约 ${totalK} 万字)`);
        }
        // 课代表包:来源就绪即触发三连生成(effect 里消费 armed 调 runKebanPack);
        // 解析失败(status=error)则放弃并提示。来源接口是同步解析,此处状态已是终态。
        if (keban) {
          if (added.status === "ready") setKebanArmed(added.id);
          else toast("视频解析失败,课代表包已取消", "error");
        }
        // 添加来源会刷新概览 + 来源指南。
        try {
          const r = await fetch(`/api/notebooks/${notebook.id}`);
          if (r.ok && notebookIdRef.current === notebook.id) {
            const fresh = await r.json();
            if (fresh.notebook) setNotebook(fresh.notebook);
            // 函数式合并:保留仍在处理的其它占位,避免抹掉并发添加。
            // 审查修复:同源占位若已出现在服务端列表(并发项已入库),要丢弃占位,
            // 否则同一来源短暂显示两条。
            if (Array.isArray(fresh.sources))
              setSources((prev) => [
                ...prev.filter(
                  (s) => s.id.startsWith("pending-") && !(s.origin && originSeen(fresh.sources, s.origin))
                ),
                ...moveSourceToFront(fresh.sources, added.id),
              ]);
          }
        } catch {
          /* 保留乐观状态 */
        }
        return outcome;
      } catch (e) {
        setSources((prev) => prev.filter((s) => s.id !== ph.id));
        const msg = (e as Error).message || "添加来源失败,请重试";
        if (!opts?.silent) toast(msg, "error");
        // 请求本身失败(400/413/422/网络)未建源,原样重投是安全的 —— 面板「重试」用。
        return { name: phTitle, outcome: "fail", reason: msg, retry: payload };
      }
    },
    [notebook, setSources, setNotebook]
  );

  // ---- D3:批量导入结果面板(成功/跳过/失败逐项透明化) ----
  const [importReport, setImportReport] = useState<ImportOutcome[] | null>(null);

  /** 批量导入(≥2 项)统一入口:逐项静默提交,全部落定后弹结果面板;单项维持 toast 现状。 */
  const addSourceBatch = useCallback(
    (payloads: AddPayload[]) => {
      if (!notebook || payloads.length === 0) return;
      if (payloads.length < 2) {
        void addSource(payloads[0]);
        return;
      }
      const nbId = notebook.id;
      // 审查 #4 修复:此前全部 Promise.all 并发,服务端 30 次/分/用户,>30 全部 429。
      // 分批并发(6 并发)+ 批间小间隔,尊重限流窗口;25 条内基本一分钟内跑完。
      const CONCURRENCY = 6;
      const GAP_MS = 1500;
      (async () => {
        const results: ImportOutcome[] = [];
        for (let i = 0; i < payloads.length; i += CONCURRENCY) {
          const slice = payloads.slice(i, i + CONCURRENCY);
          const batch = await Promise.all(slice.map((p) => addSource(p, { silent: true })));
          results.push(...batch);
          if (i + CONCURRENCY < payloads.length) await new Promise((r) => setTimeout(r, GAP_MS));
        }
        if (notebookIdRef.current !== nbId) return;
        setImportReport(results);
      })();
    },
    [notebook, addSource]
  );

  /** 结果面板「失败」项重试:重新走单项提交(静默),用新结果原位更新该行。 */
  const retryImportItem = useCallback(
    (item: ImportOutcome, idx: number) => {
      if (!item.retry || item.retrying) return;
      setImportReport((prev) =>
        prev ? prev.map((it, i) => (i === idx ? { ...it, retrying: true } : it)) : prev
      );
      const tries = (item.tries ?? 0) + 1;
      void addSource(item.retry, { silent: true }).then((r) => {
        // 再失败时 addSource 会带回新的 retry payload,该行仍可继续重试。
        // 成功则打上 retried 标记:面板据此把它渲染成「已导入」留痕行,而不是让它消失。
        setImportReport((prev) =>
          prev ? prev.map((it, i) => (i === idx ? { ...r, tries, retried: r.outcome === "ok" } : it)) : prev
        );
      });
    },
    [addSource]
  );

  /** 乐观批量导入网页:每条先插「处理中」占位(置顶),后台并行解析后替换为真实来源。
   *  发现来源(左栏 Fast Research + 添加弹窗「发现」标签)共用此入口。 */
  const importUrls = useCallback(
    async (items: { url: string; title?: string }[]): Promise<number> => {
      if (!notebook) return 0;
      // 批内按归一化 URL 去重,避免同批同链接生成多条(服务端也会二次查重兜底)。
      // 审查修复:此前整串 toLowerCase 会把「仅路径大小写不同」的两个不同 URL 误判
      // 同键而静默丢一条 —— 服务端只小写主机名。这里对齐口径:只小写 host。
      const seen = new Set<string>();
      const unique = items.filter(({ url }) => {
        let k = url.trim();
        try {
          const u = new URL(/^https?:\/\//i.test(k) ? k : `https://${k}`);
          u.hostname = u.hostname.toLowerCase();
          u.hash = "";
          if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
          k = u.toString();
        } catch {
          /* 非法 URL 保留原串作键 */
        }
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const entries = unique.map(({ url, title }) => ({ url, name: title || url, ph: pendingSource(notebook.id, title || url, url) }));
      setSources((prev) => [...entries.map((e) => e.ph), ...prev]);
      let n = 0;
      let dup = 0;
      let failed = 0;
      // D3:逐项记录结论(名字+原因),批量时供结果面板展示。
      const outcomes = await Promise.all(
        entries.map(async ({ url, name, ph }): Promise<ImportOutcome> => {
          try {
            const res = await fetch(`/api/notebooks/${notebook.id}/sources`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "url", url }),
            });
            const data = await res.json();
            if (!res.ok || !data.source) throw new Error(data?.error || "导入失败");
            const added = data.source as Source;
            setSources((prev) => [added, ...prev.filter((s) => s.id !== ph.id && s.id !== added.id)]);
            // 审查修复:服务端判重命中(duplicate:true)不计入「已导入 N 个来源」。
            if (data.duplicate) {
              dup++;
              return { name, outcome: "dup", reason: "与已有来源重复,已跳过" };
            }
            // 入库但解析失败(201 + status:"error"):不算导入成功;来源行自带「重新导入」。
            if (added.status === "error") {
              failed++;
              return { name, outcome: "fail", reason: added.error || "解析失败" };
            }
            n++;
            return { name, outcome: "ok" };
          } catch (e) {
            // 审查修复:批量导入此前静默吞掉失败(含抓不到正文的 422)—— 占位消失却无任何
            // 提示,用户以为「发现能用但导入没反应」。累计失败数,循环后汇总告知。
            failed++;
            setSources((prev) => prev.filter((s) => s.id !== ph.id));
            return { name, outcome: "fail", reason: (e as Error).message || "导入失败", retry: { kind: "url", url } };
          }
        })
      );
      try {
        const r = await fetch(`/api/notebooks/${notebook.id}`);
        if (r.ok && notebookIdRef.current === notebook.id) {
          const fresh = await r.json();
          if (fresh.notebook) setNotebook(fresh.notebook);
          // 函数式合并:保留仍在处理的其它占位(pending-*),避免抹掉并发添加;
          // 已入库的同源占位丢弃,避免同一来源短暂双条。
          if (Array.isArray(fresh.sources))
            setSources((prev) => [
              ...prev.filter(
                (s) => s.id.startsWith("pending-") && !(s.origin && originSeen(fresh.sources, s.origin))
              ),
              ...fresh.sources,
            ]);
        }
      } catch {
        /* 保留乐观状态 */
      }
      // D3:批量(≥2 项)弹结果面板逐项透明化(取代两条汇总 toast);单项维持 toast 现状。
      if (entries.length >= 2) {
        if (notebookIdRef.current === notebook.id) setImportReport(outcomes);
      } else {
        if (dup > 0) toast(`${dup} 个链接已在笔记本中,已跳过`);
        if (failed > 0) toast(`${failed} 个链接未能提取到正文(可能触发反爬或为纯导航页),已跳过`, "error");
      }
      return n;
    },
    [notebook, setSources, setNotebook]
  );

  const removeSource = useCallback(
    async (id: string) => {
      setSources((prev) => prev.filter((s) => s.id !== id));
      setViewer((v) => (v?.sourceId === id ? null : v));
      await fetch(`/api/sources/${id}`, { method: "DELETE" });
    },
    [setSources]
  );

  const retrySource = useCallback(
    async (id: string) => {
      // 重新导入失败的来源 / 刷新网页来源:乐观置「处理中」,用原链接重抓 + 重新入库。
      setSources((prev) => prev.map((s) => (s.id === id ? { ...s, status: "processing", error: null } : s)));
      try {
        const r = await fetch(`/api/sources/${id}`, { method: "POST" });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.source) {
          // 服务端刷新失败但保留了原内容(ready 来源重抓失败不降级)时会带回原行,
          // 按服务端真实状态回填,别把健康来源误标成 error。
          setSources((prev) =>
            prev.map((s) =>
              s.id === id
                ? data?.source
                  ? { ...s, ...data.source }
                  : { ...s, status: "error", error: data?.error || "重新导入失败" }
                : s
            )
          );
          toast(data?.error || "重新导入失败,请稍后再试", "error");
          return;
        }
        setSources((prev) => prev.map((s) => (s.id === id ? { ...s, ...data.source } : s)));
        toast(
          data.source.status === "ready" ? "已重新导入" : "仍未能提取到可读内容",
          data.source.status === "ready" ? "success" : "error"
        );
      } catch {
        setSources((prev) => prev.map((s) => (s.id === id ? { ...s, status: "error", error: "重新导入失败" } : s)));
        toast("重新导入失败,请检查网络后重试", "error");
      }
    },
    [setSources]
  );

  const renameSource = useCallback(
    async (id: string, title: string) => {
      const t = title.trim();
      if (!t) return;
      setSources((prev) => prev.map((s) => (s.id === id ? { ...s, title: t } : s)));
      await fetch(`/api/sources/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t }),
      });
    },
    [setSources]
  );

  const toggleSource = useCallback(
    async (id: string, selected: boolean) => {
      setSources((prev) => prev.map((s) => (s.id === id ? { ...s, selected } : s)));
      await fetch(`/api/sources/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected }),
      });
    },
    [setSources]
  );

  const toggleAll = useCallback(
    (selected: boolean) => {
      const ready = sources.filter((s) => s.status === "ready");
      setSources((prev) => prev.map((s) => (s.status === "ready" ? { ...s, selected } : s)));
      for (const s of ready) {
        fetch(`/api/sources/${s.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected }),
        }).catch(() => {});
      }
    },
    [sources, setSources]
  );

  const reloadMessagesFromServer = useCallback(async () => {
    if (!notebook) return;
    try {
      const response = await fetch(`/api/notebooks/${notebook.id}`);
      if (!response.ok) return;
      const data = await response.json();
      setMessages((data.messages ?? []).map((message: UiMessage) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        citations: message.citations ?? [],
        feedback: message.feedback ?? null,
        skill_id: message.skill_id ?? null,
      })));
    } catch {
      /* 快照回滚已先保住旧答案，单次刷新失败可由下次打开恢复 */
    }
  }, [notebook, setMessages]);

  const streamAnswer = useCallback(
    async (
      query: string,
      regenerate = false,
      oneshotSkillId?: string,
      regenerateTarget?: { userMessageId: string; assistantIds: string[] },
      clientUserMessageId?: string,
      onRegenerateConflict?: () => void
    ) => {
      if (!notebook) return;
      const streamNotebookId = notebook.id;
      // 一键技能本轮 id 优先;否则跟随对话 persona。记进 ref 供 regenerate 复用(见其注释)。
      const effectiveSkillId = oneshotSkillId || (activeSkill?.mode === "chat" ? activeSkill.id : "");
      const seq = ++streamSeqRef.current;
      // 上一轮如仍未落定,先中止其网络流(safeguard;正常路径 done 已把 abort 释放)。
      streamAbortRef.current?.abort();
      const ac = new AbortController();
      streamAbortRef.current = ac;
      const isCurrentStream = () =>
        notebookIdRef.current === streamNotebookId && streamSeqRef.current === seq;
      setSending(true);
      setMessages((prev) => [
        ...prev,
        { id: STREAM_ID, role: "assistant", content: "", citations: [], streaming: true },
      ]);
      const patch = (fn: (m: UiMessage) => UiMessage) => {
        if (!isCurrentStream()) return;
        setMessages((prev) => prev.map((m) => (m.id === STREAM_ID ? fn(m) : m)));
      };
      let rawStreamContent = "";
      try {
        await streamChat(
          notebook.id,
          query,
          selectedIds,
          {
            onToken: (t) => {
              rawStreamContent += t;
              const visible = sanitizeStreamingProtocolText(rawStreamContent);
              patch((m) => ({ ...m, content: visible }));
            },
            onDone: (id, canonicalContent, citations, followups, research) => {
              patch((m) => ({
                ...m,
                id,
                content: canonicalContent ?? m.content,
                citations,
                followups,
                research: research ?? undefined,
                streaming: false,
              }));
              // 正文流完(done 已带 citations)立即解锁输入框与引用点击,
              // 不再等「追问建议」的第二次 LLM 调用。
              if (isCurrentStream()) setSending(false);
            },
            // 追问建议尾随到达再补渲染(此时消息 id 已是落库的真实 id)。
            onFollowups: (id, followups, research) => {
              if (!isCurrentStream()) return;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === id ? { ...m, followups, research: research ?? undefined } : m
                )
              );
            },
            onError: (err, isQuota, code) => {
              if (!isCurrentStream()) return;
              if (code === "regenerate_conflict") {
                if (onRegenerateConflict) onRegenerateConflict();
                else setMessages((prev) => prev.filter((message) => message.id !== STREAM_ID));
                void reloadMessagesFromServer();
                toast(err, "error");
                return;
              }
              if (isQuota) {
                // 配额用尽:不留行内错误气泡,移除流式占位,改在对话顶部显示横幅。
                setMessages((prev) => prev.filter((m) => m.id !== STREAM_ID));
                setQuotaMsg(err);
                return;
              }
              // 错气泡换一次性 id + 独立 errorText:①防下一轮流式占位同 id 双写
              // (审查实锤);②有部分内容时不覆盖正文,失败提示与正文解耦(#8)。
              const errId = `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === STREAM_ID ? { ...m, id: errId, streaming: false, error: true, errorText: err } : m
                )
              );
            },
          },
          regenerate,
          effectiveSkillId, // 服务端按 id 查表注入提示词/persona
          clientUserMessageId,
          regenerateTarget,
          ac.signal
        );
      } catch (e) {
        // 旧流在 done 解锁后的迟到异常(如断网时读尾随事件失败)不许写占位 ——
        // 此时 STREAM_ID 可能已是新一轮回答的占位,误写会把新回答标成错误。
        if (isCurrentStream()) {
          const errId = `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const raw = (e as Error).message || "";
          // 网络类异常映射成可读中文(浏览器原生 Failed to fetch 直露给用户不友好)。
          const isNet = /Failed to fetch|NetworkError|net::|ECONN|The user aborted/i.test(raw);
          const errText = raw.includes("aborted") ? "已停止生成" : isNet ? "网络连接失败,请检查网络后重试" : raw || "回答生成失败,请重试";
          setMessages((prev) =>
            prev.map((m) =>
              m.id === STREAM_ID ? { ...m, id: errId, streaming: false, error: true, errorText: errText } : m
            )
          );
        }
      } finally {
        // 兜底解锁:仅当没有更新一轮的回答在途(done 提前解锁后用户可能已再发问)。
        if (isCurrentStream()) setSending(false);
      }
    },
    [notebook, selectedIds, setMessages, activeSkill, setQuotaMsg, reloadMessagesFromServer]
  );

  const sendMessage = useCallback(
    async (text: string, opts?: { skillId?: string }) => {
      const msg = text.trim();
      if (!msg || !notebook) return;
      // 额度用完后别再堆没人回的消息:拦下所有发送入口(输入框 / 追问 / 技能 / 测验解释)。
      if (quotaMsg) {
        // 「拦下不发」属告知/限流,不是成功;Toast 仅 success/error 两档,用 error
        // 避免绿勾把「没发出去」错渲成「已发送」(info 档另行统一,不在本文件加)。
        toast(quotaMsg, "error");
        return;
      }
      // 会话串行:当前回答未结束时,任何来源(对话输入 / 测验「解释」/ 笔记追问 / 技能)
      // 触发的新提问都拦下并提示,而不是静默忽略。
      if (sending) {
        toast("当前回答还在生成中,请等它结束再继续", "error");
        return;
      }
      const clientUserMessageId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev.map((m) =>
          m.followups || m.research ? { ...m, followups: undefined, research: undefined } : m
        ),
        { id: clientUserMessageId, role: "user", content: msg, citations: [], skill_id: opts?.skillId ?? null },
      ]);
      await streamAnswer(msg, false, opts?.skillId, undefined, clientUserMessageId);
    },
    [notebook, sending, quotaMsg, setMessages, streamAnswer]
  );

  // Run a skill. chat-mode → toggle the active persona (no message sent).
  // one-shot / workflow → fire its prompt as a normal grounded question.
  const runSkill = useCallback(
    (skill: Skill) => {
      setSkillPickerOpen(false);
      if (skill.mode === "chat") {
        const turningOff = activeSkill?.id === skill.id;
        setActiveSkill(turningOff ? null : skill);
        toast(turningOff ? `已结束「${skill.name}」` : `已开启「${skill.name}」`);
        return;
      }
      // 一键/工作流:气泡显示技能名(短标签),真正的提示词由服务端按 skillId 查表注入。
      sendMessage(skill.name, { skillId: skill.id });
    },
    [sendMessage, activeSkill]
  );

  const regenerate = useCallback(async () => {
    if (!notebook) return;
    if (sending) {
      toast("当前回答还在生成中,请稍候", "error");
      return;
    }
    // 读同步 ref 而非依赖 messages —— 依赖 messages 会让本函数在流式每个 token 都换
    // 新引用,击穿 MessageBubble 的 memo(见 messagesRef 声明处)。
    const msgs = messagesRef.current;
    let q = "";
    let cut = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        q = msgs[i].content;
        cut = i;
        break;
      }
    }
    if (!q) return;
    setMessages((prev) => prev.slice(0, cut + 1));
    // 数据库最后一条 user message 的 skill_id 是唯一真源；服务端还会再次校验。
    const skillId = msgs[cut]?.skill_id || undefined;
    await streamAnswer(q, true, skillId, {
      userMessageId: msgs[cut].id,
      assistantIds: msgs.slice(cut + 1)
        .filter((message) => message.role === "assistant" && !message.streaming && !message.error && message.id !== STREAM_ID)
        .map((message) => message.id),
    }, undefined, () => setMessages(msgs));
  }, [sending, notebook, setMessages, streamAnswer]);

  const clearChat = useCallback(async () => {
    if (!notebook) return;
    setMessages([]);
    try {
      await fetch(`/api/notebooks/${notebook.id}/chat`, { method: "DELETE" });
    } catch (e) {
      console.warn("清空对话失败(网络):", e);
      toast("清空对话失败,请重试", "error");
    }
  }, [notebook, setMessages]);

  const setFeedback = useCallback(
    async (id: string, value: "up" | "down") => {
      // React state updater 可能延后执行，不能在 updater 里赋值后立即拿去发请求。
      const previous = messagesRef.current.find((message) => message.id === id)?.feedback ?? null;
      const next: "up" | "down" | null = previous === value ? null : value;
      const seq = (feedbackMutationSeq.current.get(id) ?? 0) + 1;
      feedbackMutationSeq.current.set(id, seq);
      setMessages((prev) => prev.map((message) => (
        message.id === id ? { ...message, feedback: next } : message
      )));
      try {
        const response = await fetch(`/api/messages/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feedback: next }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        console.warn("保存反馈失败:", error);
        if (feedbackMutationSeq.current.get(id) === seq) {
          setMessages((prev) => prev.map((message) => (
            message.id === id ? { ...message, feedback: previous } : message
          )));
          toast("反馈保存失败,请重试", "error");
        }
      }
    },
    [setMessages]
  );

  const generateStudio = useCallback(
    // 返回值给编排方(课代表包等):成功 = 新制品 id;取消/失败/限流/额度用尽 = null。
    async (
      kind: StudioKind,
      prompt?: string,
      opts?: GenOpts,
      onAdmission?: (result: { accepted: boolean; error?: string }) => void
    ): Promise<string | null> => {
      let admissionSettled = false;
      let admitted = false;
      const settleAdmission = (result: { accepted: boolean; error?: string }) => {
        if (admissionSettled) return;
        admissionSettled = true;
        onAdmission?.(result);
      };
      if (!notebook) {
        settleAdmission({ accepted: false, error: "当前笔记本已关闭，请重新打开后再试" });
        return null;
      }
      const usedIds = opts?.sourceIds ?? selectedIds;
      const realCount = usedIds.filter((id) => id && !id.startsWith("__")).length;
      const cadNeedsSources = kind === "cad" && (opts?.cadMode ?? "source_driven") === "source_driven";
      if (cadNeedsSources && realCount === 0) {
        const error = "CAD 模型必须至少基于一个已就绪来源";
        settleAdmission({ accepted: false, error });
        if (!onAdmission) toast(error, "error");
        return null;
      }
      // 并行生成:只挡「同一 kind 已在生成」,不同 kind 互不阻塞(服务端每用户 3 个在途,
      // 超限由 POST 429 兜住)。Set 是同步锁,防连点在 setState 生效前二次通过。
      if (genInflight.current.has(kind) || generatingRef.current[kind]) {
        settleAdmission({ accepted: false, error: `已有${KIND_LABEL[kind] || "同类"}任务在处理，请等待完成` });
        return null;
      }
      if (kind === "cad" && cadRevisionInflight.current.size > 0) {
        const error = "已有 CAD 参数修订任务，请等待完成后再生成";
        settleAdmission({ accepted: false, error });
        if (!onAdmission) toast(error, "error");
        return null;
      }
      genInflight.current.add(kind);
      const nbId = notebook.id;
      let doneId: string | null = null; // 成功生成的制品 id(done 分支写入)
      try {
        // Enqueue a generation job; the in-process worker does the heavy lifting.
        const res = await fetch(`/api/notebooks/${nbId}/studio`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            prompt,
            sourceIds: opts?.sourceIds ?? selectedIds,
            instruction: opts?.instruction,
            language: opts?.language,
            theme: opts?.theme,
            format: opts?.format,
            focus: opts?.focus,
            length: opts?.length,
            audience: opts?.audience,
            difficulty: opts?.difficulty,
            count: opts?.count,
            voices: opts?.voices,
            cadTemplate: opts?.cadTemplate,
            cadMode: opts?.cadMode,
            cadParameters: opts?.cadParameters,
            targetObjectId: opts?.cadTargetObjectId,
            cadAllowAssumptions: opts?.cadAllowAssumptions,
            cadTutorialExample: opts?.cadTutorialExample,
            cadPreflightPlanHash: opts?.cadPreflightPlanHash,
            cadIdempotencyKey: opts?.cadIdempotencyKey,
          }),
        });
        const data = await res.json();
        if (notebookIdRef.current !== nbId) {
          settleAdmission({ accepted: false, error: "已切换笔记本，本次入队结果未写入当前页面" });
          return null;
        }
        // 审查修复:只有 code==='quota' 才是「当日额度用尽」,才亮持久横幅。
        // 其它 429(在途任务排队上限/限流)是暂时态,误亮横幅会把聊天永久锁死。
        if (data?.code === "quota") {
          const error = data?.error || "今日积分已用完,明日自动恢复";
          settleAdmission({ accepted: false, error });
          setQuotaMsg(error);
          return null;
        }
        if (res.status === 429) {
          const error = data?.error || "操作过于频繁,请稍后再试";
          settleAdmission({ accepted: false, error });
          if (!onAdmission) toast(error, "error");
          return null;
        }
        if (!res.ok) throw new Error(data?.error || "生成失败");
        if (res.status !== 202) {
          throw new Error("服务端未返回标准入队确认（期望 HTTP 202），请确认后端已更新");
        }
        const jobId = typeof data?.job?.id === "string" ? data.job.id : "";
        if (!jobId) throw new Error("服务端已接收请求，但没有返回任务编号");
        // 只有服务端真正返回 202 + jobId 后，右栏才进入「排队中」。
        // 预检/HTTP 拒绝不得短暂冒充已入队任务。
        setGenerating((prev) => ({
          ...prev,
          [kind]: {
            status: "queued",
            progress: 0,
            sourceLabel: kind === "cad" && opts?.cadMode === "prompt_driven"
              ? "按描述生成 · 不使用来源"
              : kind === "cad" && opts?.cadMode === "fixed_template"
                ? "标准模板 · 不使用来源"
                : `基于 ${realCount} 个来源`,
          } satisfies GenJobState,
        }));
        admitted = true;
        settleAdmission({ accepted: true });
        const reservedCredits = Number(data?.billing?.reservedCredits ?? data?.job?.credits_reserved ?? 0);
        if (reservedCredits > 0) {
          toast(`已预留 ${reservedCredits} 积分，完成后按实际 Token 结算，多退不补`);
        }
        patchGenKind(kind, { jobId }); // 有 jobId 才能「取消」
        // Poll the job until it finishes. 单次网络抖动/合盖休眠/dev 重编译都会让一次
        // 查询失败,而任务其实还在跑 —— 连续失败 ≥3 次(约 4 秒)才放弃,单次静默重试。
        let pollFails = 0;
        for (;;) {
          await new Promise((r) => setTimeout(r, 1200));
          // 任务在服务端继续，但旧本轮询不再写当前 UI；返回旧本时会由 GET /studio 恢复。
          if (notebookIdRef.current !== nbId) break;
          let job: {
            status: string;
            progress: number;
            output_id: string | null;
            error: string | null;
            credits_final?: number;
            credits_reserved?: number;
            tokens_in?: number;
            tokens_out?: number;
          };
          try {
            const jr = await fetch(`/api/jobs/${jobId}`);
            const jd = await jr.json();
            if (!jr.ok) throw new Error(jd?.error || "任务查询失败");
            job = jd.job as typeof job;
            pollFails = 0;
          } catch {
            pollFails += 1;
            if (pollFails >= 3) {
              throw new Error("任务查询失败,生成可能仍在后台进行,稍后可在列表查看");
            }
            continue; // 单次失败:静默重试,别误报「生成失败」
          }
          if (job.status === "queued" || job.status === "running") {
            patchGenKind(kind, { status: job.status, progress: job.progress ?? 0 });
            continue;
          }
          if (job.status === "canceled") break; // 用户已取消(取消侧已提示+退积分)
          if (job.status === "done") {
            doneId = job.output_id;
            const finalCredits = Number(job.credits_final ?? job.credits_reserved ?? 0);
            const actualTokens = Number(job.tokens_in ?? 0) + Number(job.tokens_out ?? 0);
            if (finalCredits > 0) {
              toast(
                actualTokens > 0
                  ? `本次消耗 ${finalCredits} 积分 · 实际 ${actualTokens.toLocaleString("zh-CN")} Token`
                  : `本次消耗 ${finalCredits} 积分 · 模型未返回 Token 明细，按预留价结算`
              );
            }
            const sr = await fetch(`/api/notebooks/${nbId}/studio`);
            const sd = await sr.json();
            const list = (sd.outputs ?? []) as StudioOutput[];
            // 已切到别的笔记本 → 别把旧本的制品列表/查看器写进新视图。
            if (notebookIdRef.current === nbId) {
              setOutputs(list);
              const out = list.find((o) => o.id === job.output_id);
              // Audio plays in the bottom dock player on demand — don't pop a
              // document viewer for it (its transcript belongs in the player, not
              // a text editor). Everything else opens its viewer as before.
              if (out?.kind === "audio") {
                setOpenDoc(null);
                setQuizPanel(null);
                setPlayingAudio(out);
              } else if (out?.kind === "quiz") {
                setPlayingAudio(null);
                setAudioPlaying(false);
                setOpenDoc(null);
                setQuizPanel(out);
              } else if (out) {
                setPlayingAudio(null);
                setAudioPlaying(false);
                setQuizPanel(null);
                setOpenDoc(out);
              }
            }
            break;
          }
          if (job.status === "error") {
            throw new Error(job.error || "生成失败");
          }
        }
      } catch (e) {
        const error = (e as Error).message || "生成失败,请重试";
        settleAdmission({ accepted: false, error });
        if (notebookIdRef.current === nbId) {
          // CAD 在入队前的错误已回传配置弹窗内联展示；入队后
          // 或其他制品仍用全局 Toast 通知。
          if (!onAdmission || admitted) toast(error, "error");
        }
      } finally {
        genInflight.current.delete(kind);
        if (notebookIdRef.current === nbId) clearGenKind(kind);
      }
      return doneId;
    },
    [notebook, selectedIds, setQuotaMsg, patchGenKind, clearGenKind]
  );

  const reviseCadOutput = useCallback(async (
    base: StudioOutput,
    patch: unknown,
    onProgress?: (progress: number) => void
  ): Promise<StudioOutput | null> => {
    if (base.kind !== "cad") throw new Error("当前制品不是 CAD 模型");
    if (cadRevisionInflight.current.size > 0) throw new Error("已有 CAD 参数修订任务，请等待完成");
    if (generatingRef.current.cad || genInflight.current.has("cad")) {
      throw new Error("已有 CAD 生成任务，请等待完成后再编辑");
    }
    let baseHash = "";
    try {
      const data = JSON.parse(base.data || "{}") as { manifest?: { hash?: unknown } };
      baseHash = typeof data.manifest?.hash === "string" ? data.manifest.hash : "";
    } catch {
      throw new Error("当前 CAD 数据快照无效，请刷新后重试");
    }
    if (!/^[a-f0-9]{64}$/.test(baseHash)) {
      throw new Error("当前 CAD 缺少完整版本校验值，请重新生成后再编辑");
    }
    cadRevisionInflight.current.add(base.id);
    const baseNotebookId = base.notebook_id;
    try {
      const response = await fetch(`/api/studio/cad/${encodeURIComponent(base.id)}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseHash, patch }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        unchanged?: boolean;
        reused?: boolean;
        job?: { id?: string };
        billing?: { reservedCredits?: number };
      };
      if (!response.ok) throw new Error(payload.error || "CAD 新版本任务创建失败");
      if (payload.unchanged) {
        toast("参数没有变化");
        return null;
      }
      const jobId = typeof payload.job?.id === "string" ? payload.job.id : "";
      if (!jobId) throw new Error("CAD 新版本任务缺少任务编号");
      const reservedCredits = Math.max(0, Number(payload.billing?.reservedCredits ?? 0));
      if (reservedCredits > 0 && !payload.reused) {
        toast(`已预留 ${reservedCredits} 积分，用于 CAD 几何重建与文件校验`);
      }
      onProgress?.(0);
      let pollFails = 0;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        let job: {
          status: string;
          progress: number;
          output_id: string | null;
          error: string | null;
          credits_reserved?: number;
          credits_final?: number;
        };
        try {
          const result = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
          const data = await result.json().catch(() => ({}));
          if (!result.ok || !data.job) throw new Error();
          job = data.job as typeof job;
          pollFails = 0;
        } catch {
          pollFails += 1;
          if (pollFails >= 3) {
            throw new Error("任务查询失败，新版本可能仍在后台生成，请稍后查看列表");
          }
          continue;
        }
        onProgress?.(Math.max(0, Math.min(100, Number(job.progress) || 0)));
        if (job.status === "queued" || job.status === "running") continue;
        if (job.status === "canceled") throw new Error("CAD 参数修订已取消");
        if (job.status === "error") throw new Error(job.error || "CAD 新版本生成失败");
        if (job.status !== "done" || !job.output_id) throw new Error("CAD 新版本任务状态异常");

        const studioResponse = await fetch(`/api/notebooks/${encodeURIComponent(baseNotebookId)}/studio`);
        const studioData = await studioResponse.json().catch(() => ({}));
        if (!studioResponse.ok) throw new Error(studioData?.error || "新版本列表刷新失败");
        const list = (studioData.outputs ?? []) as StudioOutput[];
        const next = list.find((item) => item.id === job.output_id);
        if (!next) throw new Error("新版本已生成，但暂未出现在列表中，请刷新查看");
        if (notebookIdRef.current === baseNotebookId) {
          setOutputs(list);
          setOpenDoc((current) => current?.id === base.id ? next : current);
        }
        const finalCredits = Math.max(0, Number(job.credits_final ?? job.credits_reserved ?? reservedCredits));
        toast(
          finalCredits > 0
            ? `CAD 新版本已生成 · 本次消耗 ${finalCredits} 积分，原版本已保留`
            : "CAD 新版本已生成，原版本已保留"
        );
        return next;
      }
    } finally {
      cadRevisionInflight.current.delete(base.id);
    }
  }, []);

  // 取消生成:DELETE /api/jobs/{jobId}(属主取消,服务端置 canceled 并退积分);
  // 409=任务已终态。成功后不直接清 UI —— 轮询 1.2s 内看到 canceled 自行收尾,避免竞态。
  const cancelGenerate = useCallback(async (kind: StudioKind) => {
    const jobId = generatingRef.current[kind]?.jobId;
    if (!jobId) return; // POST 还没返回 jobId,先不响应
    try {
      const r = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (r.ok) {
        toast("已取消,积分已退回");
      } else if (r.status === 409) {
        toast("任务已结束", "error");
      } else {
        const d = await r.json().catch(() => ({}));
        toast(d?.error || "取消失败,请重试", "error");
      }
    } catch {
      toast("取消失败,请检查网络后重试", "error");
    }
  }, []);

  // 课代表包编排:B站来源就绪后依次生成 学习指南 → 思维导图 → 测验(顺序 await,
  // 同一时刻只占 1 个在途位,不会顶满服务端 3 个的上限)。任一环节失败/限流/取消
  // 即停止后续(失败侧已各自提示 + 退积分);三件全部完成后在右栏亮一次性横幅。
  const runKebanPack = useCallback(
    async (sourceId: string) => {
      const nbId = notebookIdRef.current;
      let guideId: string | null = null;
      for (const kind of KEBAN_PACK_KINDS) {
        const outId = await generateStudio(kind, undefined, { sourceIds: [sourceId] });
        if (!outId) {
          toast("课代表包未完成,已停止后续生成", "error");
          return;
        }
        if (kind === "study_guide") guideId = outId;
      }
      // 切本守卫:完成时已在别的笔记本 → 不把横幅亮到新本视图。
      if (guideId && notebookIdRef.current === nbId) {
        // 测验完成会自动占满右栏(QuizView 替换整个面板),先收起让横幅可见。
        setQuizPanel(null);
        setKebanBanner({ guideId });
      }
    },
    [generateStudio]
  );

  // 消费 armed(addSource 声明在 runKebanPack 之前,拿不到它,靠状态解耦)。
  useEffect(() => {
    if (!kebanArmed) return;
    const sid = kebanArmed;
    setKebanArmed(null);
    void runKebanPack(sid);
  }, [kebanArmed, runKebanPack]);

  // 复制课代表总结:学习指南 markdown → 纯文本,截 ~600 字 + 落款,写入剪贴板(可贴 B站评论区)。
  const copyKebanSummary = useCallback(() => {
    const guide = kebanBanner ? outputs.find((o) => o.id === kebanBanner.guideId) : null;
    if (!guide) {
      toast("学习指南已不在列表中,无法复制", "error");
      return;
    }
    const plain = outputToMarkdown(guide.kind, guide.content)
      .replace(/```[\s\S]*?```/g, "") // 代码块整段去掉
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接只留文字
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/(\*\*|__|\*|`)/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const body = plain.length > 600 ? `${plain.slice(0, 600).trimEnd()}…` : plain;
    const text = `${body}\n—— 由猿笔记整理,智能生成内容请注意甄别`;
    navigator.clipboard.writeText(text).then(
      () => toast("已复制,可直接粘贴到评论区"),
      () => toast("复制失败,请重试", "error")
    );
  }, [kebanBanner, outputs]);

  // 删除前统一确认:所有「用户点删除」都先弹 ConfirmDialog(此前制品/笔记/清空笔记
  // 是无确认直接删,误删无法撤销)。pendingDel 记录待删目标,渲染处弹确认,确认后才真删。
  // 「转入笔记=移动」等程序化删除走 do* 版本,不弹确认。
  const [pendingDel, setPendingDel] = useState<
    null | { kind: "output" | "note" | "allNotes"; id?: string }
  >(null);

  const doDeleteOutput = useCallback(async (id: string, options?: { silent?: boolean }): Promise<boolean> => {
    const removedIndex = outputs.findIndex((output) => output.id === id);
    const removed = removedIndex >= 0 ? outputs[removedIndex] : null;
    const previousOpen = openDoc?.id === id ? openDoc : null;
    setOutputs((prev) => prev.filter((o) => o.id !== id));
    setOpenDoc((d) => (d?.id === id ? null : d));
    try {
      const response = await fetch(`/api/studio/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (e) {
      console.warn("删除制品失败:", e);
      if (removed) {
        setOutputs((prev) => {
          if (prev.some((output) => output.id === id)) return prev;
          const restored = [...prev];
          restored.splice(Math.min(removedIndex, restored.length), 0, removed);
          return restored;
        });
      }
      if (previousOpen) setOpenDoc((current) => current ?? previousOpen);
      if (!options?.silent) toast("删除失败,请重试", "error");
      return false;
    }
  }, [openDoc, outputs]);
  const deleteOutput = useCallback((id: string) => setPendingDel({ kind: "output", id }), []);

  const renameOutput = useCallback(async (id: string, title: string) => {
    const t = title.trim();
    if (!t) return;
    setOutputs((prev) => prev.map((o) => (o.id === id ? { ...o, title: t } : o)));
    setOpenDoc((d) => (d?.id === id ? { ...d, title: t } : d));
    try {
      await fetch(`/api/studio/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t }),
      });
    } catch (e) {
      console.warn("重命名制品失败(网络):", e);
      toast("重命名失败,请重试", "error");
    }
  }, []);

  const addNote = useCallback(
    async (title: string, content: string, kind: Note["kind"] = "manual"): Promise<Note | null> => {
      if (!notebook) return null;
      try {
        const res = await fetch(`/api/notebooks/${notebook.id}/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content, kind }),
        });
        const data = await res.json();
        if (data.note) {
          setNotes((prev) => [data.note as Note, ...prev]);
          return data.note as Note;
        }
        return null;
      } catch (e) {
        console.warn("保存笔记失败(网络):", e);
        toast("保存失败,请重试", "error");
        return null;
      }
    },
    [notebook]
  );

  // 「转入我的笔记」=移动:把智能输出变成可编辑的 report 笔记,并消费掉
  // 原输出(不双存)。绝不伪装 manual 自动进 RAG,需用户核对后明确转为来源。
  // deleteOutput 会在该制品的查看器开着时自动关掉它(故不在此处盲关 openDoc)。
  const moveOutputToNote = useCallback(
    async (id: string, title: string, content: string) => {
      const note = await addNote(title, content, "report");
      if (!note) return; // 建笔记失败已提示,保留原输出不删
      const deleted = await doDeleteOutput(id, { silent: true }); // 移动是程序化删除,不弹确认
      if (!deleted) {
        // 删原制品失败时撤回刚创建的笔记，避免 UI 报“已移动”却
        // 在 DB 中双存。撤回也必须检查 HTTP 状态，不再伪成功。
        try {
          const rollback = await fetch(`/api/notes/${note.id}`, { method: "DELETE" });
          if (!rollback.ok) throw new Error(`HTTP ${rollback.status}`);
          setNotes((prev) => prev.filter((item) => item.id !== note.id));
          setOpenNote((current) => (current?.id === note.id ? null : current));
          toast("转入未完成,原智能笔记已保留,请重试", "error");
        } catch (rollbackError) {
          console.warn("转入笔记回滚失败:", rollbackError);
          toast("转入未完成,两份内容均已保留,请手动核对", "error");
        }
        return;
      }
      toast("已转入我的笔记,原智能笔记已移走");
    },
    [addNote, doDeleteOutput]
  );

  const saveAnswerToNote = useCallback(
    async (content: string, citations?: Citation[]): Promise<boolean> => {
      const title = content.replace(/\s+/g, " ").trim().slice(0, 60) || "已保存的回答";
      let body = content;
      if (citations && citations.length) {
        // 按展示编号保留 claim 映射；同一 chunk 支持两句话时不能折叠掉后一条编号。
        const seen = new Set<string>();
        const lines = citations
          .filter((c) => {
            const k = String(c.number);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .map((c) => {
            const label = c.source_title.replace(/[\[\]]/g, " ").trim() || "来源";
            const safeUrl = c.source_url && /^https?:\/\/\S+$/i.test(c.source_url)
              ? c.source_url.replace(/\)/g, "%29")
              : "";
            const sourceLabel = safeUrl ? `[${label}](${safeUrl})` : label;
            return `${c.number}. ${sourceLabel}${
              c.snippet ? ` —— ${c.snippet.replace(/\s+/g, " ").trim().slice(0, 120)}` : ""
            }`;
          });
        if (lines.length) body += `\n\n---\n**引用来源**\n${lines.join("\n")}`;
      }
      // await addNote 才能拿到真实成功/失败,MessageBubble 据此显示真反馈(#9 修复)。
      return !!(await addNote(title, body, "chat"));
    },
    [addNote]
  );

  const newNote = useCallback(async () => {
    const note = await addNote("未命名笔记", "", "manual");
    if (note) setOpenNote(note);
  }, [addNote]);

  // 按 id 打开笔记;不在已加载列表里(例如 related 从最新 DB 反查出新笔记)则先拉一遍,避免静默无反应。
  const openNoteById = useCallback(
    async (id: string) => {
      let n = notes.find((x) => x.id === id);
      if (!n && notebook) {
        const d = await fetch(`/api/notebooks/${notebook.id}/notes`).then((r) => r.json()).catch(() => ({}));
        const list = (d.notes ?? []) as Note[];
        if (list.length) setNotes(list);
        n = list.find((x) => x.id === id);
      }
      if (n) setOpenNote(n);
    },
    [notes, notebook]
  );

  // 跨笔记本被动再发现:点开「其它笔记本里相关的」项 → 切到那个本,待其加载完再打开目标项。
  // 用 pending + effect(而非 await 后直接开)以避开切本时的 stale-closure。
  const [pendingOpen, setPendingOpen] = useState<
    { nbId: string; kind: "source" | "note"; id: string; title: string } | null
  >(null);
  // 切本前清掉**所有**笔记本级浮层,否则 NotebookView 不重挂会把 A 的浮层(打开的制品/
  // 正在播的音频/来源抽屉)残留压在 B 上,其回调(存为笔记/删除)会误写到 B。
  const clearNotebookOverlays = useCallback(() => {
    setViewer(null);
    setOpenNote(null);
    setOpenDoc(null);
    setQuizPanel(null);
    setViewSourcesFor(null);
    setPlayingAudio(null);
    setAudioPlaying(false);
    setAddOpen(false);
    setImportReport(null);
    setGenConfig(null);
    setVoicePick(null); // 暂存的是 A 本的生成参数,残留到 B 会把音频生进错的本
    setShareOpen(false);
    setShareKind(undefined);
    setSettingsOpen(false);
    setConfirmClearChat(false);
    setPendingDel(null);
    setSkillPickerOpen(false);
    setAutoResearch(null);
    setKebanArmed(null);
    setKebanBanner(null);
  }, []);
  useEffect(() => {
    // NotebookView 本身不会因切本重挂载；所有主窗口/浮层态必须跟随笔记本 id 收口。
    // 否则 A 本在主窗口打开的 CAD 会被原样带到 B 本。
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    streamSeqRef.current += 1;
    setSending(false);
    clearNotebookOverlays();
  }, [notebook?.id, clearNotebookOverlays]);
  // 新建笔记本进来:先让上面的切本 effect 收口旧本状态，再弹「添加来源」。
  // 顺序不能反，否则信号已消费但弹窗又被 clearNotebookOverlays 关掉。
  useEffect(() => {
    if (autoAddForId && notebook && notebook.id === autoAddForId) {
      setAddOpen(true);
      onAutoAddConsumed();
    }
  }, [autoAddForId, notebook, onAutoAddConsumed]);
  const openCross = useCallback(
    (nbId: string, item: { kind: "source" | "note"; id: string; title: string }) => {
      clearNotebookOverlays();
      if (notebook?.id === nbId) {
        // 已经在该本(理论上跨本 id 不会相同,兜底):直接打开
        if (item.kind === "source") setViewer({ sourceId: item.id, title: item.title });
        else openNoteById(item.id);
        return;
      }
      setPendingOpen({ nbId, ...item });
      onSwitchNotebook(nbId);
    },
    [notebook, onSwitchNotebook, openNoteById, clearNotebookOverlays]
  );
  useEffect(() => {
    if (!pendingOpen || !notebook) return;
    // 切到了**别的**本(被后续操作顶替)→ 作废这个 pending,绝不在无关本上自动打开。
    if (notebook.id !== pendingOpen.nbId) {
      setPendingOpen(null);
      return;
    }
    const it = pendingOpen;
    setPendingOpen(null);
    if (it.kind === "source") setViewer({ sourceId: it.id, title: it.title });
    else openNoteById(it.id);
  }, [notebook, pendingOpen, openNoteById]);

  // 本地已乐观更新;网络失败要如实上报(false)让 NoteEditor 保持 dirty 下次继续尝试
  // (审查修复:此前静默失败 + 无脑写回 savedTitle/savedContent → 用户看似已保存实则丢失)。
  const saveNote = useCallback(async (id: string, title: string, content: string): Promise<boolean> => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, title, content } : n)));
    try {
      const r = await fetch(`/api/notes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return true;
    } catch (e) {
      console.warn("保存笔记失败:", e);
      return false;
    }
  }, []);

  const renameNote = useCallback(async (id: string, title: string) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, title } : n)));
    try {
      await fetch(`/api/notes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
    } catch (e) {
      console.warn("重命名笔记失败(网络):", e);
    }
  }, []);

  const doDeleteNote = useCallback(async (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    setOpenNote((n) => (n?.id === id ? null : n));
    try {
      await fetch(`/api/notes/${id}`, { method: "DELETE" });
    } catch (e) {
      console.warn("删除笔记失败(网络):", e);
    }
  }, []);
  const deleteNote = useCallback((id: string) => setPendingDel({ kind: "note", id }), []);

  const convertAllNotes = useCallback(async () => {
    if (!notebook) return;
    let res: Response;
    try {
      res = await fetch(`/api/notebooks/${notebook.id}/notes/convert-all`, { method: "POST" });
    } catch (e) {
      console.warn("转换笔记失败(网络):", e);
      toast("转换失败,请重试", "error");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data?.error || "转换失败", "error");
      return;
    }
    try {
      const r = await fetch(`/api/notebooks/${notebook.id}`);
      if (r.ok) {
        const f = await r.json();
        if (f.notebook) setNotebook(f.notebook);
        if (Array.isArray(f.sources)) setSources(f.sources);
      }
    } catch {
      /* keep state */
    }
  }, [notebook, setSources, setNotebook]);

  const doClearAllNotes = useCallback(async () => {
    if (!notebook) return;
    setNotes([]);
    try {
      await fetch(`/api/notebooks/${notebook.id}/notes`, { method: "DELETE" });
    } catch (e) {
      console.warn("清空笔记失败(网络):", e);
      toast("清空失败,请重试", "error");
    }
  }, [notebook]);
  const clearAllNotes = useCallback(() => setPendingDel({ kind: "allNotes" }), []);

  const saveSettings = useCallback(
    async (s: {
      chat_style: string;
      chat_instructions: string;
      response_length: string;
      output_language: string;
    }) => {
      if (!notebook) return;
      const prev = notebook;
      setNotebook((nb) => (nb ? { ...nb, ...s } : nb));
      try {
        const r = await fetch(`/api/notebooks/${notebook.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(s),
        });
        if (!r.ok) throw new Error();
      } catch {
        setNotebook(prev); // 失败回滚乐观更新
        toast("配置保存失败,请重试", "error");
      }
    },
    [notebook, setNotebook]
  );

  const setPublic = useCallback(
    async (isPublic: boolean) => {
      if (!notebook) return;
      setNotebook((nb) => (nb ? { ...nb, public: isPublic } : nb));
      await fetch(`/api/notebooks/${notebook.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public: isPublic }),
      });
    },
    [notebook, setNotebook]
  );

  const noteToSource = useCallback(
    async (id: string) => {
      // Show a processing placeholder at the top of the list immediately, so the
      // new source appears (with a spinner) the moment the user clicks convert.
      const placeholder = pendingSource(
        notebook?.id ?? "",
        notes.find((n) => n.id === id)?.title ?? "新建来源"
      );
      setSources((prev) => [placeholder, ...prev]);
      let done = false;
      try {
        const res = await fetch(`/api/notes/${id}/to-source`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          // e.g. empty note — surface the message and keep the editor open
          toast(data?.error || "转为来源失败", "error");
          throw new Error(data?.error || "转为来源失败");
        }
        if (data.source) {
          done = true;
          const added = data.source as Source;
          // swap the placeholder for the real source, keeping it first
          setSources((prev) => [
            added,
            ...prev.filter((s) => s.id !== placeholder.id && s.id !== added.id),
          ]);
          setNotes((prev) =>
            prev.map((n) => (n.id === id ? { ...n, converted_to_source: 1 } : n))
          );
          if (notebook) {
            try {
              const r = await fetch(`/api/notebooks/${notebook.id}`);
              if (r.ok && notebookIdRef.current === notebook.id) {
                const fresh = await r.json();
                if (fresh.notebook) setNotebook(fresh.notebook);
                // 审查修复:与 addSource/importUrls 同口径 —— 保留仍在处理的其它
                // pending-* 占位,避免并发添加/转来源被这次刷新抹掉。
                if (Array.isArray(fresh.sources))
                  setSources((prev) => [
                    ...prev.filter(
                      (s) => s.id.startsWith("pending-") && !(s.origin && originSeen(fresh.sources, s.origin))
                    ),
                    ...moveSourceToFront(fresh.sources, added.id),
                  ]);
              }
            } catch {
              /* keep optimistic state */
            }
          }
        }
      } finally {
        if (!done) setSources((prev) => prev.filter((s) => s.id !== placeholder.id));
      }
    },
    [notes, notebook, setSources, setNotebook, setNotes]
  );

  /** "转入来源" — turn a generated artifact (report, mind map, …) directly
   *  into a citable source. The artifact-side twin of noteToSource. */
  const convertOutputToSource = useCallback(
    async (o: StudioOutput) => {
      const placeholder = pendingSource(notebook?.id ?? "", o.title || "新建来源");
      setSources((prev) => [placeholder, ...prev]);
      let done = false;
      try {
        const res = await fetch(`/api/studio/${o.id}/to-source`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast(data?.error || "转入来源失败", "error");
          return;
        }
        if (data.source) {
          done = true;
          const added = data.source as Source;
          setSources((prev) => [
            added,
            ...prev.filter((s) => s.id !== placeholder.id && s.id !== added.id),
          ]);
          setOutputs((prev) =>
            prev.map((x) => (x.id === o.id ? { ...x, converted_to_source: 1 } : x))
          );
          toast("已转入来源");
          if (notebook) {
            try {
              const r = await fetch(`/api/notebooks/${notebook.id}`);
              if (r.ok && notebookIdRef.current === notebook.id) {
                const fresh = await r.json();
                if (fresh.notebook) setNotebook(fresh.notebook);
                // 审查修复:同 noteToSource,保留其它 pending-* 占位。
                if (Array.isArray(fresh.sources))
                  setSources((prev) => [
                    ...prev.filter(
                      (s) => s.id.startsWith("pending-") && !(s.origin && originSeen(fresh.sources, s.origin))
                    ),
                    ...moveSourceToFront(fresh.sources, added.id),
                  ]);
              }
            } catch {
              /* keep optimistic state */
            }
          }
        }
      } finally {
        if (!done) setSources((prev) => prev.filter((s) => s.id !== placeholder.id));
      }
    },
    [notebook, setSources, setNotebook, setOutputs]
  );

  const overviewSummary = selOverview?.summary ?? notebook?.summary ?? null;
  const overviewQuestions =
    selOverview?.suggested_questions ?? notebook?.suggested_questions ?? [];

  return (
    <div className="flex h-screen flex-col">
      <TopBar
        user={user}
        notebook={notebook}
        onBack={onBack}
        onRename={onRename}
        onCreate={onCreate}
        onOpenSettings={() => setSettingsOpen(true)}
        onSaveChatConfig={saveSettings}
        onOpenNotebook={onSwitchNotebook}
        onOpenShare={() => {
          setShareKind(undefined);
          setShareOpen(true);
        }}
      />
      {/* B8:移动端 padding/gap 收窄,桌面端保持原尺寸 */}
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2 pt-1 lg:gap-3 lg:px-3 lg:pb-3">
        <SourcesPanel
          sources={sources}
          loading={loading}
          selectedCount={selectedIds.length}
          mobileActive={mobileTab === "sources"}
          collapsed={sourcesCollapsed}
          onToggleCollapse={toggleSources}
          onAdd={() => setAddOpen(true)}
          onDelete={removeSource}
          onRetry={retrySource}
          onRename={renameSource}
          onToggle={toggleSource}
          onToggleAll={toggleAll}
          onOpen={openSource}
          onImportUrls={importUrls}
          onImportText={(text, title) => void addSource({ kind: "text", text, title })}
          autoResearch={autoResearch}
        />
        {/* 查看器统一使用模态层；对话始终保持挂载，关闭后草稿与滚动位置不变。 */}
        <div className="contents">
          <ChatPanel
            notebook={notebook}
            mobileActive={mobileTab === "chat"}
            suspended={false}
            messages={messages}
            loading={loading}
            sending={sending}
            quotaMsg={quotaMsg}
            chatCreditCost={chatCreditCost}
            readyCount={readyCount}
            totalSources={sources.length}
            selectedCount={selectedIds.length}
            summary={overviewSummary}
            suggestedQuestions={overviewQuestions}
            overviewLoading={overviewLoading}
            onSend={sendMessage}
            onQuickResearch={onQuickResearch}
            onCite={openCitation}
            onAddSource={() => setAddOpen(true)}
            onSaveNote={saveAnswerToNote}
            onRegenerate={regenerate}
            onClearChat={() => setConfirmClearChat(true)}
            onFeedback={setFeedback}
            activeSkill={activeSkill}
            onRunSkill={runSkill}
            onClearSkill={() => setActiveSkill(null)}
            onOpenSkillPicker={() => setSkillPickerOpen(true)}
            onStop={() => streamAbortRef.current?.abort()}
          />
        </div>
        {/* B8:右栏本体在 Studio.tsx(另行维护),其根 aside 是 hidden lg:flex(含折叠
            窄条 / 测验面板等所有形态)。移动端由这层包裹用后代选择器强制显示并铺满
            (`.x > aside` 特异性 0-1-1 盖过 .hidden 的 0-1-0);桌面端 lg:contents 让
            包裹层退出布局,右栏行为与改前完全一致。 */}
        <div
          className={cn(
            mobileTab === "studio" ? "flex" : "hidden",
            "w-full min-w-0 lg:contents",
            "max-lg:[&>aside]:flex max-lg:[&>aside]:w-full"
          )}
        >
        <StudioPanel
          outputs={outputs}
          notes={notes}
          onQuizSaveNote={async (t, c) => !!(await addNote(t, c, "report"))}
          loading={loading || studioLoading}
          generating={generating}
          hiddenArtifacts={hiddenArtifacts}
          userHiddenTiles={userHiddenTiles}
          onSaveUserHiddenTiles={onSaveUserHiddenTiles}
          onCancelGenerate={cancelGenerate}
          banner={
            kebanBanner ? (
              // 课代表包完成横幅(一次性,局部 state,刷新即消失)
              <div className="mb-2 rounded-xl border border-accent/30 bg-accentSoft/50 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <BookIcon width={16} height={16} className="shrink-0 text-accent" />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">课代表包已就绪</p>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  学习指南、思维导图、测验已生成,可一键复制总结贴到评论区。
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={copyKebanSummary}
                    className="rounded-full bg-accent px-3.5 py-1.5 text-xs font-medium text-onAccent transition hover:brightness-110"
                  >
                    复制课代表总结
                  </button>
                  <button
                    onClick={() => setKebanBanner(null)}
                    className="rounded-full border border-edge bg-panel px-3.5 py-1.5 text-xs font-medium text-ink2 transition hover:bg-panel2 hover:text-ink"
                  >
                    关闭
                  </button>
                </div>
              </div>
            ) : null
          }
          sourceCount={selectedIds.length}
          readySourceCount={sources.filter((source) => source.status === "ready").length}
          hasSources={selectedIds.length > 0}
          hasChat={messages.some((m) => m.content?.trim())}
          hasNotes={notes.length > 0}
          collapsed={studioCollapsed && !isNarrow}
          onToggleCollapse={toggleStudio}
          overQuota={!!quotaMsg}
          onOpenConfig={(tile) => {
            // 额度用完时点智能选项:不开生成弹窗,直接给明确提示(磁贴同时置灰,见 StudioPanel)。
            if (quotaMsg) {
              toast(
                quotaMsg,
                "error"
              );
              return;
            }
            setGenConfig(tile);
          }}
          onAddSource={() => setAddOpen(true)}
          onRequireSources={() => {
            setMobileTab("sources");
            setSourcesCollapsed(false);
            localStorage.setItem("nb_sources_collapsed", "0");
          }}
          onOpenOutput={(o) => {
            if (o.kind === "audio") {
              setOpenDoc(null);
              setQuizPanel(null);
              setPlayingAudio(o);
            } else if (o.kind === "quiz") {
              // 测验在右栏内联作答(不走中栏弹窗),与对话并存
              setPlayingAudio(null);
              setAudioPlaying(false);
              setOpenDoc(null);
              setQuizPanel(o);
            } else {
              // opening another item stops the audio dock — don't keep playing
              // in the background (or alongside a video's own player)
              setPlayingAudio(null);
              setAudioPlaying(false);
              setQuizPanel(null);
              setOpenDoc(o);
            }
          }}
          onDeleteOutput={deleteOutput}
          onShareOutput={(o) => {
            // D7:已公开 → 直接复制指向该制品的直达链接(/share/<nb>?doc=<制品id>,
            // 分享页会定位到这份内容,音频还会自动播放);未公开 → 先开分享弹窗引导开启。
            if (notebook?.public) {
              navigator.clipboard
                .writeText(`${window.location.origin}/share/${notebook.id}?doc=${o.id}`)
                .then(() => toast("链接已复制,任何人打开即可直达这份内容"))
                .catch(() => toast("复制失败", "error"));
              return;
            }
            setShareKind(KIND_LABEL[o.kind] ?? "制品");
            setShareOpen(true);
            // D7:前置条件未满足(还没公开),属提醒而非成功,用 error 免绿勾误导。
            toast("先开启公开分享,链接才能被访问", "error");
          }}
          onRenameOutput={renameOutput}
          onConvertOutput={(o) =>
            moveOutputToNote(o.id, o.title, outputToMarkdown(o.kind, o.content))
          }
          onConvertOutputToSource={convertOutputToSource}
          onViewSources={setViewSourcesFor}
          onNewNote={newNote}
          onOpenNote={(n) => {
            // opening a note stops the audio dock
            setPlayingAudio(null);
            setAudioPlaying(false);
            setOpenNote(n);
          }}
          onDeleteNote={deleteNote}
          onRenameNote={renameNote}
          onConvertNoteToSource={(id) =>
            noteToSource(id)
              .then(() => toast("已转为来源"))
              .catch(() => {})
          }
          onConvertAllNotes={convertAllNotes}
          onDeleteAllNotes={clearAllNotes}
          playingAudio={playingAudio}
          onClosePlayer={() => {
            setPlayingAudio(null);
            setAudioPlaying(false);
          }}
          playingId={audioPlaying && playingAudio ? playingAudio.id : null}
          onPlayerPlayingChange={setAudioPlaying}
          onShareNotebook={() => {
            setShareKind("音频概览");
            setShareOpen(true);
          }}
          activeQuiz={quizPanel}
          onCloseQuiz={() => setQuizPanel(null)}
          onQuizOpenSource={(title) => {
            const s = sources.find((x) => x.title === title && x.status === "ready");
            if (s) {
              openSource(s);
              return true;
            }
            return false;
          }}
        />
        </div>
        {viewer && (
          <SourceViewer
            key={`${viewer.sourceId}:${viewer.chunkIndex ?? "legacy"}:${viewer.sourceStart ?? viewer.snippet ?? ""}`}
            target={viewer}
            onClose={() => setViewer(null)}
            onOpenSource={(id, title) => setViewer({ sourceId: id, title })}
            onOpenNote={(id) => {
              setViewer(null);
              openNoteById(id);
            }}
            onOpenCross={openCross}
          />
        )}
      </div>

      {/* B8:手机端底部三段 tab(对话 / 来源 / 笔记)—— 桌面端隐藏(与 PublicNotebook 同款) */}
      <nav
        className="flex shrink-0 border-t border-edge bg-panel lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {(
          [
            ["chat", "对话"],
            ["sources", "来源"],
            ["studio", "笔记"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMobileTab(key)}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition",
              mobileTab === key ? "text-accent" : "text-ink2 hover:text-ink"
            )}
            aria-current={mobileTab === key ? "page" : undefined}
          >
            <span className="relative">
              {key === "chat" ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              ) : key === "sources" ? (
                <FileIcon width={18} height={18} />
              ) : (
                <BookIcon width={18} height={18} />
              )}
              {/* 有来源仍在处理中 → 「来源」tab 角标小圆点提示 */}
              {key === "sources" && sources.some((s) => s.status === "processing") && (
                <span className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
              )}
            </span>
            {label}
          </button>
        ))}
      </nav>

      {addOpen && (
        <AddSourceModal
          onClose={() => setAddOpen(false)}
          onSubmit={addSource}
          onSubmitBatch={addSourceBatch}
          onQuickResearch={onQuickResearch}
          maxFileBytes={maxFileBytes}
        />
      )}
      {/* D3:批量导入结果面板 —— 成功/跳过(已存在)/失败逐项透明化,失败项可重试 */}
      {importReport && (
        <ImportReportModal
          items={importReport}
          onRetry={retryImportItem}
          onClose={() => setImportReport(null)}
        />
      )}
      <Toaster />
      {settingsOpen && notebook && (
        <NotebookSettingsModal
          notebook={notebook}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
        />
      )}
      {confirmClearChat && (
        <ConfirmDialog
          title="清除此笔记本的对话记录?"
          message="您即将清除本笔记本的完整对话记录,此操作无法撤销。"
          confirmLabel="清除"
          onConfirm={() => {
            setConfirmClearChat(false);
            clearChat();
          }}
          onCancel={() => setConfirmClearChat(false)}
        />
      )}
      {pendingDel && (() => {
        const p = pendingDel;
        const cfg =
          p.kind === "output"
            ? {
                title: "要删除这个智能笔记吗?",
                subject: outputs.find((o) => o.id === p.id)?.title,
                message: "此制品将被永久删除,且无法恢复。",
                confirmLabel: "删除",
              }
            : p.kind === "note"
            ? {
                title: "要删除这条笔记吗?",
                subject: notes.find((n) => n.id === p.id)?.title,
                message: "此笔记将被永久删除,且无法恢复。",
                confirmLabel: "删除",
              }
            : {
                title: "要清空全部笔记吗?",
                subject: undefined,
                message: "本笔记本的所有笔记将被永久删除,且无法恢复。",
                confirmLabel: "清空",
              };
        return (
          <ConfirmDialog
            title={cfg.title}
            subject={cfg.subject}
            message={cfg.message}
            confirmLabel={cfg.confirmLabel}
            onConfirm={() => {
              setPendingDel(null);
              if (p.kind === "output" && p.id) doDeleteOutput(p.id);
              else if (p.kind === "note" && p.id) doDeleteNote(p.id);
              else if (p.kind === "allNotes") doClearAllNotes();
            }}
            onCancel={() => setPendingDel(null)}
          />
        );
      })()}
      {skillPickerOpen && (
        <SkillPickerModal
          activeId={activeSkill?.id}
          onPick={runSkill}
          onClose={() => setSkillPickerOpen(false)}
        />
      )}
      {shareOpen && notebook && (
        <ShareModal
          notebook={notebook}
          user={user}
          artifactLabel={shareKind}
          artifactId={openDoc && openDoc.kind !== "cad" ? openDoc.id : undefined}
          onClose={() => setShareOpen(false)}
          onSetPublic={setPublic}
          onLeft={() => {
            // 自助退出成功:关掉分享弹窗并退出该笔记本(onBack 会顺带刷新首页列表)。
            setShareOpen(false);
            onBack();
          }}
        />
      )}
      {genConfig && notebook && (
        <GenerateConfigModal
          key={genConfig}
          tile={genConfig}
          notebookId={notebook.id}
          selectedSourceIds={selectedIds}
          hasSources={selectedIds.length > 0}
          creditCosts={studioCreditCosts}
          onClose={() => setGenConfig(null)}
          onConfirm={(kind, opts) => {
            // C5:音频先经「声音」选择(VoicePickerModal),其余类型照旧直接生成。
            if (kind === "audio") {
              setVoicePick({ kind, opts });
              return;
            }
            if (kind === "cad") {
              // CAD 配置弹窗只等待「入队」，不等待整个几何任务。
              return new Promise<{ accepted: boolean; error?: string }>((resolve) => {
                void generateStudio(kind, opts.instruction, opts, resolve);
              });
            }
            void generateStudio(kind, opts.instruction, opts);
          }}
        />
      )}
      {voicePick && (
        <VoicePickerModal
          onCancel={() => setVoicePick(null)}
          onConfirm={(voices) => {
            const { kind, opts } = voicePick;
            setVoicePick(null);
            void generateStudio(kind, opts.instruction, { ...opts, voices });
          }}
        />
      )}
      {openDoc && (
        <ViewerErrorBoundary resetKey={openDoc.id} onClose={() => setOpenDoc(null)}>
          {openDoc.kind === "cad" ? (
            <CadView
              key={openDoc.id}
              output={openDoc}
              onClose={() => setOpenDoc(null)}
              onDelete={() => deleteOutput(openDoc.id)}
              onRevise={reviseCadOutput}
            />
          ) : openDoc.kind === "mindmap" ? (
          <MindMapView
            key={openDoc.id}
            output={openDoc}
            onClose={() => setOpenDoc(null)}
            onSaveNote={async (t, c) => !!(await addNote(t, c, "report"))}
            onDelete={() => deleteOutput(openDoc.id)}
            watermark={downloadWatermark}
            onAsk={(text) => {
              // 与 QuizView 同款:关掉查看器,把问题直接发进当前笔记本对话。
              setOpenDoc(null);
              sendMessage(text);
            }}
            onSaved={(content) => {
              setOutputs((prev) =>
                prev.map((o) => (o.id === openDoc.id ? { ...o, content } : o))
              );
              setOpenDoc((d) => (d?.id === openDoc.id ? { ...d, content } : d));
            }}
            onShareNotebook={() => {
              // Keep the mind map open behind the share dialog (the share modal
              // sits above it via a higher z-index) — closing it was jarring.
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
        ) : openDoc.kind === "video" ? (
          <VideoPlayer
            key={openDoc.id}
            output={openDoc}
            onClose={() => setOpenDoc(null)}
            onSaveNote={async (t, c) => !!(await addNote(t, c, "report"))}
            onDelete={() => deleteOutput(openDoc.id)}
            onShareNotebook={() => {
              // 与导图一致:分享弹窗 z-index 高于查看器,保持查看器打开(关掉很突兀)。
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
        ) : openDoc.kind === "flashcards" ? (
          <FlashcardsView
            key={openDoc.id}
            output={openDoc}
            onClose={() => setOpenDoc(null)}
            onSaveNote={async (t, c) => !!(await addNote(t, c, "report"))}
            onDelete={() => deleteOutput(openDoc.id)}
            onShareNotebook={() => {
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
        ) : openDoc.kind === "quiz" ? (
          <QuizView
            key={openDoc.id}
            output={openDoc}
            onClose={() => setOpenDoc(null)}
            onSaveNote={async (t, c) => !!(await addNote(t, c, "report"))}
            onDelete={() => deleteOutput(openDoc.id)}
            onOpenSource={(title) => {
              const s = sources.find((x) => x.title === title && x.status === "ready");
              if (s) {
                openSource(s); // 来源查看器 z-80 叠在测验 z-50 之上,关掉即回到测验
                return true;
              }
              return false;
            }}
            onShareNotebook={() => {
              // 与导图一致:分享弹窗 z-index 高于查看器,保持查看器打开(关掉很突兀)。
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
        ) : openDoc.kind === "infographic" ? (
          <InfographicView
            key={openDoc.id}
            output={openDoc}
            onClose={() => setOpenDoc(null)}
            onDelete={() => deleteOutput(openDoc.id)}
            onShareNotebook={() => {
              // 与导图一致:分享弹窗 z-index 高于查看器,保持查看器打开(关掉很突兀)。
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
        ) : openDoc.kind === "xhs" ? (
          <XhsCardsView
            key={openDoc.id}
            output={openDoc}
            onClose={() => setOpenDoc(null)}
            onDelete={() => deleteOutput(openDoc.id)}
            onShareNotebook={() => {
              // 与导图一致:分享弹窗 z-index 高于查看器,保持查看器打开(关掉很突兀)。
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
        ) : openDoc.kind === "slides" ? (
          <SlidesView
            key={openDoc.id}
            output={openDoc}
            onClose={() => setOpenDoc(null)}
            onDelete={() => deleteOutput(openDoc.id)}
            watermark={downloadWatermark}
            onSaved={(content) => {
              setOutputs((prev) =>
                prev.map((o) => (o.id === openDoc.id ? { ...o, content } : o))
              );
              setOpenDoc((d) => (d?.id === openDoc.id ? { ...d, content } : d));
            }}
            onShareNotebook={() => {
              // 与导图一致:分享弹窗 z-index 高于查看器,保持查看器打开(关掉很突兀)。
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
        ) : openDoc.kind === "table" ? (
          <TableSheetView
            key={openDoc.id}
            output={openDoc}
            onClose={() => setOpenDoc(null)}
            onSaveNote={async (t, c) => !!(await addNote(t, c, "report"))}
            onDelete={() => deleteOutput(openDoc.id)}
            onSaved={(content) => {
              setOutputs((prev) =>
                prev.map((o) => (o.id === openDoc.id ? { ...o, content } : o))
              );
              setOpenDoc((d) => (d?.id === openDoc.id ? { ...d, content } : d));
            }}
            onShareNotebook={() => {
              // 与导图一致:分享弹窗 z-index 高于查看器,保持查看器打开(关掉很突兀)。
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
        ) : openDoc.kind === "drawviso" ? (
          <DrawvisoView
            key={openDoc.id}
            output={openDoc}
            sources={sources}
            onOpenSource={openSource}
            onClose={() => setOpenDoc(null)}
            onDelete={() => deleteOutput(openDoc.id)}
            watermark={downloadWatermark}
            onSaved={(content) => {
              setOutputs((prev) => prev.map((o) => (o.id === openDoc.id ? { ...o, content } : o)));
              setOpenDoc((d) => (d?.id === openDoc.id ? { ...d, content } : d));
            }}
            onShareNotebook={() => {
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
        ) : openDoc.kind === "excalidraw" ? (
          <ExcalidrawView
            key={openDoc.id}
            output={openDoc}
            sources={sources}
            onOpenSource={openSource}
            onClose={() => setOpenDoc(null)}
            onDelete={() => deleteOutput(openDoc.id)}
            watermark={downloadWatermark}
            onSaved={(content) => {
              setOutputs((prev) =>
                prev.map((o) => (o.id === openDoc.id ? { ...o, content } : o))
              );
              setOpenDoc((d) => (d?.id === openDoc.id ? { ...d, content } : d));
            }}
            onShareNotebook={() => {
              // 与导图一致:分享弹窗 z-index 高于查看器,保持查看器打开(关掉很突兀)。
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
        ) : (
          <DocViewer
            key={openDoc.id}
            output={openDoc}
            onClose={() => setOpenDoc(null)}
            onSaveNote={async (t, c) => !!(await addNote(t, c, "report"))}
            onDelete={() => deleteOutput(openDoc.id)}
            watermark={downloadWatermark}
            onSaved={(content) => {
              setOutputs((prev) =>
                prev.map((o) => (o.id === openDoc.id ? { ...o, content } : o))
              );
              setOpenDoc((d) => (d?.id === openDoc.id ? { ...d, content } : d));
            }}
            onShareNotebook={() => {
              // 与导图一致:分享弹窗 z-index 高于查看器,保持查看器打开(关掉很突兀)。
              setShareKind(openDoc ? KIND_LABEL[openDoc.kind] ?? "制品" : "制品");
              setShareOpen(true);
            }}
          />
          )}
        </ViewerErrorBoundary>
      )}
      {openNote && (
        <ViewerErrorBoundary resetKey={openNote.id} onClose={() => setOpenNote(null)}>
        <NoteEditor
          key={openNote.id}
          note={openNote}
          onClose={() => setOpenNote(null)}
          onSave={saveNote}
          onToSource={noteToSource}
          onShareNotebook={() => {
            // Keep the note open behind the share dialog (it sits above via a
            // higher z-index) — consistent with the other viewers.
            setShareKind("笔记");
            setShareOpen(true);
          }}
        />
        </ViewerErrorBoundary>
      )}
      {viewSourcesFor &&
        (() => {
          // Resolve the artifact's stored source ids against the notebook's
          // current sources; legacy artifacts without stored ids fall back to
          // every ready source (the pool they were generated from).
          const ids = sourceIdsOf(viewSourcesFor);
          const list = ids
            ? ids
                .map((id) => sources.find((s) => s.id === id))
                .filter((s): s is Source => !!s)
            : sources.filter((s) => s.status === "ready");
          return (
            <SourceListModal
              sources={list}
              onClose={() => setViewSourcesFor(null)}
              // Drill into a source on top of the grid — keep the list open
              // underneath so closing the viewer returns to “来源”, not the chat.
              onOpenSource={openSource}
            />
          );
        })()}
    </div>
  );
}

/** Brand mark — 猿头线标(透明 PNG 走 CSS mask + currentColor:白方块里变白,独立处随上下文取墨/紫)。 */
export function BrandMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        backgroundColor: "currentColor",
        WebkitMaskImage: "url(/brand/yuanbiji-head.png)",
        maskImage: "url(/brand/yuanbiji-head.png)",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}

/** First character of a display name, used as a Google-style avatar letter. */
function initialOf(name?: string | null): string {
  const s = (name ?? "").trim();
  if (!s) return "我";
  const first = Array.from(s)[0] ?? "我";
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/** Round initial avatar — one consistent treatment everywhere a user shows up. */
function Avatar({
  name,
  size = 36,
}: {
  name?: string | null;
  size?: number;
}) {
  return (
    <span
      title={name ?? "我"}
      className="flex shrink-0 select-none items-center justify-center rounded-full bg-brand font-extrabold leading-none text-onAccent shadow-[0_4px_14px_-5px_rgba(143,124,240,0.6)]"
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)) }}
    >
      {initialOf(name)}
    </span>
  );
}

function TopBar({
  user,
  notebook,
  onBack,
  onRename,
  onCreate,
  onOpenSettings,
  onSaveChatConfig,
  onOpenShare,
  onOpenNotebook,
}: {
  user?: HomeUser;
  notebook: Notebook | null;
  onBack: () => void;
  onRename: (title: string) => void;
  onCreate: () => void;
  onOpenSettings: () => void;
  onSaveChatConfig: (s: { chat_style: string; chat_instructions: string; response_length: string; output_language: string }) => void;
  onOpenShare: () => void;
  onOpenNotebook: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const pill =
    "inline-flex h-9 items-center gap-1.5 rounded-[13px] border border-edge bg-panel px-3.5 text-[13px] font-semibold text-ink2 transition hover:border-accent/50 hover:text-ink";

  return (
    // B8:移动端顶栏收敛 —— 间距收窄、次要按钮(邀请/创建)隐藏、分享只留图标
    <header className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4">
      <button
        onClick={onBack}
        title="返回全部笔记本"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-accent text-onAccent shadow-[0_6px_18px_-5px_rgba(109,90,230,0.55)] transition hover:brightness-110"
      >
        <BrandMark size={28} />
      </button>
      {editing ? (
        <input
          name="title"
          autoComplete="off"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            onRename(draft);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              onRename(draft);
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
          className="rounded-md border border-edge bg-panel px-2 py-1 text-[18px] font-bold outline-none focus:border-accent"
        />
      ) : (
        <button
          onClick={() => {
            setDraft(notebook?.title ?? "");
            setEditing(true);
          }}
          className="max-w-[42vw] truncate rounded-md px-1 py-1 text-[18px] font-bold text-ink transition hover:bg-panel2"
          title="点击重命名"
        >
          {notebook?.title ?? "加载中…"}
        </button>
      )}
      {notebook?.public && (
        <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-accentSoft px-3 text-xs font-semibold text-accent">
          <LinkIcon width={13} height={13} /> 已分享
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {/* 邀请返利入口(E1):常驻顶栏、「创建笔记本」左侧;移动端隐藏(次要入口) */}
        {user?.plan_tier !== "test" && user?.adminRole !== "super" && (
          <span className="hidden sm:block">
            <ReferralPill />
          </span>
        )}
        <button
          onClick={onCreate}
          title="创建笔记本"
          className="hidden h-9 items-center gap-1.5 rounded-[13px] bg-accent px-3.5 text-[13px] font-semibold text-onAccent transition hover:brightness-110 sm:inline-flex"
        >
          <PlusIcon width={15} height={15} /> 创建笔记本
        </button>
        <button
          onClick={onOpenShare}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-[13px] border px-3 text-[13px] font-semibold transition sm:px-3.5",
            notebook?.public
              ? "border-accent/60 bg-accentSoft text-accent"
              : "border-edge bg-panel text-ink2 hover:border-accent/50 hover:text-ink"
          )}
          title="分享为只读链接"
        >
          <ShareIcon width={15} height={15} />
          <span className="hidden sm:inline">{notebook?.public ? "已公开" : "分享"}</span>
        </button>
        <SettingsMenu
          systemAdmin={user?.adminRole === "super"}
          triggerClassName={pill}
          onOpenChatConfig={onOpenSettings}
          chatConfig={
            notebook
              ? {
                  chat_style: notebook.chat_style || "default",
                  chat_instructions: notebook.chat_instructions || "",
                  response_length: notebook.response_length || "default",
                  output_language: notebook.output_language || "",
                }
              : undefined
          }
          onSaveChatConfig={onSaveChatConfig}
        />
        {user && <NotificationBell onOpen={onOpenNotebook} />}
        {user && <AccountMenu user={user} />}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// sources panel
// ---------------------------------------------------------------------------

/** NotebookLM 式面板内嵌「发现来源」:搜索 → 摘要卡(前 3 条 + 计数)→ 一键导入。 */
function InlineDiscover({
  onImportUrls,
  onImportText,
  autoResearch,
}: {
  onImportUrls: (items: { url: string; title?: string }[]) => Promise<number>;
  onImportText?: (text: string, title: string) => void;
  autoResearch?: { q: string; n: number; mode?: "fast" | "deep" } | null;
}) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"fast" | "deep">("fast"); // 搜索档:快速 / 深度
  const [modeOpen, setModeOpen] = useState(false); // 档位下拉开合
  const modeRef = useRef<HTMLDivElement>(null); // 档位下拉容器,点击外部时关闭
  const [reportOpen, setReportOpen] = useState(false); // 研究报告全文:展开 / 收起
  const [reportSaved, setReportSaved] = useState(false); // 研究报告是否已存为来源(防重复入库)
  const importingRef = useRef(false); // 导入 in-flight 锁,防连点双发
  const [busyDeep, setBusyDeep] = useState(false); // 深度搜索进行中(用于更长的加载提示)
  const [wasDeep, setWasDeep] = useState(false); // 当前结果是否来自深度搜索(有研究报告)
  const [phase, setPhase] = useState<"idle" | "searching" | "done">("idle");
  // reason:精排顺带产出的一句「为什么值得看」注释(可选,缺失不占位)
  // type:服务端按 URL 特征打的类型标(pdf/video/article),缺省按 article 看待
  const [results, setResults] = useState<{ title: string; url: string; snippet: string; date?: string; reason?: string; type?: "pdf" | "video" | "article" }[]>([]);
  // C6:类型筛选 chip(纯前端过滤展示,不重新请求);新一轮搜索/清空时重置回「全部」
  const [typeFilter, setTypeFilter] = useState<"all" | "article" | "pdf" | "video">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState("");
  const [references, setReferences] = useState<DiscoveryReference[]>([]);
  const [resultQuery, setResultQuery] = useState("");
  const [zoomed, setZoomed] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false); // 删除发现结果前的确认
  const taRef = useRef<HTMLTextAreaElement>(null);

  const clearResults = () => {
    setPhase("idle");
    setResults([]);
    setSummary("");
    setReferences([]);
    setResultQuery("");
    setPicked(new Set());
    setTypeFilter("all");
    setConfirmClear(false);
  };

  // 搜索框随内容自动增高,封顶 ~4 行后内部滚动(长查询不再被单行截断,但有上限)
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 84)}px`;
  }, [q]);

  const togglePick = (url: string, c: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (c) next.add(url);
      else next.delete(url);
      return next;
    });

  const search = async (override?: string, modeArg?: "fast" | "deep") => {
    const query = (override ?? q).trim();
    const useMode = modeArg ?? mode;
    if (!query || phase === "searching") return;
    setPhase("searching");
    setBusyDeep(useMode === "deep");
    setReportOpen(false);
    setReportSaved(false);
    setReferences([]);
    setResultQuery("");
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, mode: useMode }),
      });
      const data = await res.json();
      const list = (data.results || []) as { title: string; url: string; snippet: string; date?: string; reason?: string; type?: "pdf" | "video" | "article" }[];
      if (!res.ok || !list.length) throw new Error(data?.error || "没有找到结果");
      setResults(list);
      setSummary(typeof data.summary === "string" ? data.summary : "");
      setReferences(Array.isArray(data.references) ? data.references : []);
      setResultQuery(typeof data.query === "string" && data.query.trim() ? data.query.trim() : query);
      setWasDeep((data.mode || useMode) === "deep");
      setPicked(new Set(list.map((r) => r.url)));
      setTypeFilter("all"); // 新一轮结果:筛选归位,避免指向已消失的类别
      setPhase("done");
    } catch (e) {
      toast((e as Error).message || "搜索失败,请重试", "error");
      setPhase("idle");
    } finally {
      setBusyDeep(false);
    }
  };

  // 弹窗/聊天里点搜索(带档位)→ 预填检索词、切档并立刻搜索(n 变化即重跑)。
  useEffect(() => {
    if (!autoResearch?.q) return;
    const m = autoResearch.mode ?? "fast";
    setQ(autoResearch.q);
    setMode(m);
    void search(autoResearch.q, m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResearch?.n]);

  // 点击档位下拉之外 → 自动收起菜单
  useEffect(() => {
    if (!modeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) setModeOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modeOpen]);

  const doImport = () => {
    if (importingRef.current) return; // 连点/双击守卫,防同一批 URL 被双发
    // 未勾选时默认导入全部;在「查看」大视图里勾选了则只导入勾选的
    const chosen = picked.size ? results.filter((r) => picked.has(r.url)) : results;
    const items = chosen.map((r) => ({ url: r.url, title: r.title }));
    if (!items.length) return;
    importingRef.current = true;
    // 乐观关闭:立即收起发现界面 + 清空,来源带标题/图标以「处理中」即时出现在左栏列表,后台解析。
    setZoomed(false);
    setPhase("idle");
    setResults([]);
    setSummary("");
    setReferences([]);
    setResultQuery("");
    setPicked(new Set());
    setQ("");
    void onImportUrls(items)
      // 审查修复:n=0 也可能是「全部都是已存在的重复来源」(importUrls 内部会
      // 单独 toast「N 个链接已在笔记本中,已跳过」),此时别再报「导入失败」误导。
      .then((n) => { if (n > 0) toast(`已导入 ${n} 个来源`); })
      .finally(() => {
        importingRef.current = false;
      });
  };

  const favicon = (u: string) => {
    try {
      return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(u).hostname}`;
    } catch {
      return "";
    }
  };

  // C6:类型筛选 —— 数量按全量结果统计;为 0 的类别不出 chip,只剩「全部」时整行不显示。
  // 勾选集(picked)与展示解耦:过滤只影响「看到什么」,被隐藏但已勾选的项照常参与导入。
  const typeOf = (r: { type?: "pdf" | "video" | "article" }) => r.type ?? "article";
  const typeCounts: Record<"article" | "pdf" | "video", number> = { article: 0, pdf: 0, video: 0 };
  for (const r of results) typeCounts[typeOf(r)] += 1;
  const typeChoices = ([
    ["article", "文章"],
    ["pdf", "PDF"],
    ["video", "视频"],
  ] as const).filter(([k]) => typeCounts[k] > 0);
  const shown = typeFilter === "all" ? results : results.filter((r) => typeOf(r) === typeFilter);
  const typeChipCls = (active: boolean) =>
    cn(
      "shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition",
      active
        ? "border-transparent bg-accentSoft text-accent"
        : "border-edge bg-panel text-ink2 hover:border-accent/50 hover:text-ink"
    );
  const typeChipRow =
    typeChoices.length >= 2 ? (
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => setTypeFilter("all")} className={typeChipCls(typeFilter === "all")}>
          全部 {results.length}
        </button>
        {typeChoices.map(([k, label]) => (
          <button key={k} onClick={() => setTypeFilter(k)} className={typeChipCls(typeFilter === k)}>
            {label} {typeCounts[k]}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <div className="px-3 pb-2">
      {/* 发现网络来源 —— 与「添加来源」弹窗同款布局,此处外框用静态边框(不要流光) + 档位下拉,按左栏尺寸缩小 */}
      <div className="rounded-[14px] border border-edge bg-panel px-3 py-3 transition focus-within:border-accent/60">
          <textarea
            name="search"
            autoComplete="off"
            ref={taRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                search();
              }
            }}
            placeholder="在网络中搜索新来源…"
            rows={1}
            className="block max-h-[84px] w-full resize-none overflow-y-auto bg-transparent text-[13px] leading-relaxed text-ink outline-none placeholder:text-muted"
          />
          <div className="mt-2.5 flex items-center gap-2">
            {/* 搜索档位:快速 / 深度(与弹窗同款下拉,带说明) */}
            <div ref={modeRef} className="relative">
              <button
                onClick={() => setModeOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-panel px-2.5 py-1 text-[11.5px] font-medium text-ink transition hover:border-accent/50"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden>
                  <path d="M4 7h9M17 7h3" />
                  <circle cx="15" cy="7" r="2" />
                  <path d="M4 17h3M11 17h9" />
                  <circle cx="9" cy="17" r="2" />
                </svg>
                {mode === "deep" ? "深度搜索" : "快速搜索"}
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="text-muted" aria-hidden>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              {modeOpen && (
                <div className="absolute left-0 top-[calc(100%+6px)] z-20 w-56 overflow-hidden rounded-xl border border-edge bg-panel p-1 shadow-xl">
                  {([
                    { k: "fast", t: "快速搜索", d: "非常适合快速获得结果" },
                    { k: "deep", t: "深度搜索", d: "多轮检索+阅读,给出报告和精选来源" },
                  ] as const).map((o) => (
                    <button
                      key={o.k}
                      onClick={() => { setMode(o.k); setModeOpen(false); }}
                      className={cn(
                        "flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition hover:bg-panel2",
                        mode === o.k && "bg-accentSoft/50"
                      )}
                    >
                      <span className={cn("text-[12.5px] font-medium", mode === o.k ? "text-accent" : "text-ink")}>{o.t}</span>
                      <span className="text-[11px] text-muted">{o.d}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => search()}
              disabled={!q.trim() || phase === "searching"}
              aria-label="搜索来源"
              className={cn(
                "ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-full transition disabled:cursor-not-allowed",
                q.trim() && phase !== "searching" ? "bg-accent text-onAccent hover:brightness-110" : "bg-panel2 text-ink2"
              )}
            >
              {phase === "searching" ? <SpinnerIcon width={14} height={14} /> : <SearchIcon width={15} height={15} />}
            </button>
          </div>
      </div>
      {busyDeep && phase === "searching" && (
        <div className="mt-2 flex items-center gap-2 overflow-hidden whitespace-nowrap px-1 text-[11.5px] text-muted">
          <SpinnerIcon width={13} height={13} className="shrink-0 text-accent" />
          <span className="font-semibold text-accent">正在深度研究…</span>
          <span>约 30–60 秒</span>
        </div>
      )}

      {/* 结果摘要卡(小预览;详情 / 全选 / 勾选在「查看」大视图) */}
      {phase === "done" && results.length > 0 && (
        <div className="mt-2 animate-popin rounded-2xl bg-accentSoft/60 p-2.5">
          <div className="mb-2 flex items-center justify-between px-1">
            <p className="flex items-center gap-2 text-[13px] font-bold text-ink">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
                <SearchIcon width={14} height={14} />
              </span>
              已找到 {results.length} 个来源
            </p>
            <button
              onClick={() => setConfirmClear(true)}
              className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-ink2 transition hover:text-ink"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4h6v3" />
              </svg>
              删除
            </button>
          </div>
          {/* 深度搜索:研究报告(可一键存为来源) */}
          {wasDeep && summary && (
            <div className="mb-2 rounded-xl border border-edge bg-panel p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[13px] font-bold leading-none text-ink">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent" aria-hidden>
                    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
                    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
                    <path d="M9 9h1M9 13h6M9 17h6" />
                  </svg>
                  研究报告
                </span>
                {onImportText && (
                  <button
                    onClick={() => {
                      if (reportSaved) return; // 防连点重复入库
                      onImportText(summary, (resultQuery || "研究报告").trim().slice(0, 40) || "研究报告");
                      setReportSaved(true);
                    }}
                    disabled={reportSaved}
                    className="group -mr-1.5 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-semibold text-accent transition hover:bg-accentSoft disabled:opacity-70"
                  >
                    {reportSaved ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                        <path d="M5 12l5 5 9-11" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 transition-transform group-hover:rotate-90" aria-hidden>
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    )}
                    {reportSaved ? "已存为来源" : "存为来源"}
                  </button>
                )}
              </div>
              <div className="my-2.5 h-px bg-edge" />
              <div className="relative">
                <DiscoveryReportMarkdown
                  content={summary}
                  references={references}
                  className={cn("pr-1 text-[12px] leading-relaxed", !reportOpen && "max-h-40 overflow-hidden")}
                />
                {!reportOpen && summary.trim().length > 140 && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t from-panel to-transparent" />
                )}
              </div>
              {summary.trim().length > 140 && (
                <button
                  onClick={() => setReportOpen((v) => !v)}
                  className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent transition hover:opacity-80"
                >
                  {reportOpen ? "收起" : "展开全文"}
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={cn("transition-transform", reportOpen && "rotate-180")} aria-hidden>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              )}
            </div>
          )}
          {/* C6:类型筛选 chip 行(小卡与「查看」大视图共用同一份筛选状态) */}
          {typeChipRow && <div className="mb-2 px-1">{typeChipRow}</div>}
          <div className="rounded-xl bg-panel p-1.5">
            {shown.slice(0, 3).map((r) => (
              <div key={r.url} className="flex items-start gap-2.5 rounded-lg px-2 py-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={favicon(r.url)} alt="" className="mt-0.5 h-5 w-5 shrink-0 rounded" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold leading-snug text-ink">{r.title}</span>
                  <span className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-ink2">{r.snippet || r.url}</span>
                  {r.reason && (
                    <span className="mt-0.5 flex items-start gap-1 text-[11px] leading-relaxed text-accent">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="mt-[2px] shrink-0" aria-hidden>
                        <path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2Z" />
                      </svg>
                      <span className="min-w-0 flex-1">{r.reason}</span>
                    </span>
                  )}
                </span>
              </div>
            ))}
            {shown.length > 3 && (
              <button
                onClick={() => setZoomed(true)}
                className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-accent transition hover:bg-accentSoft/60"
              >
                <LinkIcon width={13} height={13} /> 另外 {shown.length - 3} 个来源
              </button>
            )}
          </div>
          <div className="mt-2 flex items-center justify-end gap-2 px-0.5">
            <button
              onClick={doImport}
              className="inline-flex items-center gap-1 rounded-full bg-accent px-4 py-1.5 text-[12.5px] font-semibold text-onAccent transition hover:brightness-110 disabled:opacity-60"
            >
              <PlusIcon width={14} height={14} />
              {picked.size ? `导入 (${picked.size})` : "全部导入"}
            </button>
          </div>
        </div>
      )}

      {/* 「查看」放大视图:面包屑 + 大搜索框 + 一句话总结 + 全选 / 勾选 / 外链 + 导入 */}
      {zoomed &&
        createPortal(
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-2 sm:p-4"
            onClick={() => setZoomed(false)}
          >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="discover-detail-title"
            className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-edge px-5 py-3.5">
              <p id="discover-detail-title" className="flex items-center gap-1.5 text-[14px] text-ink2">
                来源
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
                <span className="font-semibold text-ink">来源发现</span>
              </p>
              <button
                onClick={() => setZoomed(false)}
                aria-label="关闭"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-panel2 hover:text-ink"
              >
                <CloseIcon width={18} height={18} />
              </button>
            </div>
            <div
              data-discovery-scroll
              className="discover-detail-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-gutter:stable]"
            >
              {/* 查询、报告和来源共用滚动轴；超长查询也不能挤掉报告正文。 */}
              <div className="mb-3 flex items-start gap-2.5 rounded-2xl border border-edge bg-panel2/50 px-4 py-3">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accentSoft text-accent">
                  <SearchIcon width={15} height={15} />
                </span>
                <p
                  aria-label="本次研究主题"
                  title={resultQuery}
                  className="line-clamp-3 min-w-0 flex-1 break-words text-[15px] leading-7 text-ink"
                >
                  {resultQuery}
                </p>
              </div>
              {summary && (
                <section aria-label="研究总结" className="mb-3 rounded-2xl border border-edge bg-panel2/30 px-4 py-3.5">
                  <DiscoveryReportMarkdown
                    content={summary}
                    references={references}
                    className="text-[14px] leading-[1.8] text-ink2"
                  />
                </section>
              )}
              <div className="rounded-2xl border border-edge p-2">
                <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                  {/* C6:类型筛选(左)+ 全选(右)。全选/勾选集始终作用于全量结果,
                      与展示过滤解耦 —— 被隐藏但已勾选的项照常参与「导入」。 */}
                  <div className="min-w-0">{typeChipRow}</div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[13px] text-ink2">全选</span>
                    <Checkbox
                      checked={results.length > 0 && results.every((r) => picked.has(r.url))}
                      onChange={(c) => setPicked(c ? new Set(results.map((r) => r.url)) : new Set())}
                    />
                  </div>
                </div>
                {shown.map((r) => (
                  <label key={r.url} className="flex cursor-pointer items-start gap-3 rounded-xl px-2 py-2.5 transition hover:bg-panel2/60">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={favicon(r.url)} alt="" className="mt-0.5 h-6 w-6 shrink-0 rounded" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
                    <span className="min-w-0 flex-1">
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="group flex items-center gap-1 text-[14px] font-semibold leading-snug text-ink hover:text-accent"
                      >
                        <span className="truncate">{r.title}</span>
                        <svg width="13" height="13" className="shrink-0 text-muted transition group-hover:text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M7 7h10v10" /></svg>
                        {r.date && <span className="shrink-0 text-[11px] font-normal text-muted">{r.date}</span>}
                      </a>
                      <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink2">{r.snippet || r.url}</span>
                      {r.reason && (
                        <span className="mt-0.5 flex items-start gap-1 text-[11.5px] leading-relaxed text-accent">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="mt-[2px] shrink-0" aria-hidden>
                            <path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2Z" />
                          </svg>
                          <span className="min-w-0 flex-1">{r.reason}</span>
                        </span>
                      )}
                    </span>
                    <Checkbox checked={picked.has(r.url)} onChange={(c) => togglePick(r.url, c)} />
                  </label>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-between border-t border-edge px-5 py-3">
              <span className="text-[13px] text-ink2">已选择 {picked.size} 个来源</span>
              <button
                onClick={doImport}
                disabled={!picked.size}
                className="inline-flex items-center gap-1.5 rounded-full bg-accent px-5 py-2 text-[13.5px] font-semibold text-onAccent transition hover:brightness-110 disabled:opacity-60"
              >
                <PlusIcon width={15} height={15} />
                {`导入${picked.size ? ` (${picked.size})` : ""}`}
              </button>
            </div>
          </div>
          </div>,
          document.body
        )}

      {/* 删除发现结果前确认(与删除笔记本/来源同款 ConfirmDialog);删掉后已发现的
          来源不可恢复,需再次搜索,故先确认(对齐 NotebookLM)。 */}
      {confirmClear && (
        <ConfirmDialog
          title="不导入笔记本就删除吗?"
          message="删除后将无法再检索这些已发现的来源,需要重新搜索。"
          confirmLabel="删除"
          onConfirm={clearResults}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}

function SourcesPanel({
  sources,
  loading,
  selectedCount,
  mobileActive,
  collapsed,
  onToggleCollapse,
  onAdd,
  onDelete,
  onRetry,
  onRename,
  onToggle,
  onToggleAll,
  onOpen,
  onImportUrls,
  onImportText,
  autoResearch,
}: {
  sources: Source[];
  loading: boolean;
  selectedCount: number;
  /** B8:手机端底部 tab 选中「来源」→ 显示完整面板;桌面端(lg+)恒显示,不受此影响。 */
  mobileActive: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onToggle: (id: string, selected: boolean) => void;
  onToggleAll: (selected: boolean) => void;
  onOpen: (s: Source) => void;
  onImportUrls: (items: { url: string; title?: string }[]) => Promise<number>;
  /** 深度搜索的研究报告「存为来源」→ 走 addSource 的 text 导入。 */
  onImportText?: (text: string, title: string) => void;
  /** 外部触发的快速研究(来自聊天/弹窗的搜索):预填 query、切档并自动运行。 */
  autoResearch?: { q: string; n: number; mode?: "fast" | "deep" } | null;
}) {
  const readyCount = sources.filter((s) => s.status === "ready").length;
  const allSelected = readyCount > 0 && selectedCount === readyCount;

  // B8:桌面折叠只出窄条(hidden lg:flex 本就桌面 only);移动端不受折叠影响,由底部
  // tab(mobileActive)决定完整面板显隐 → 折叠时窄条与完整面板并存,各管一端。
  const rail = collapsed && (
      <aside className="hidden w-14 shrink-0 flex-col items-center gap-1.5 rounded-[22px] bg-panel elev-soft py-3 lg:flex">
        <button
          onClick={onToggleCollapse}
          title="展开来源"
          aria-label="展开来源"
          className="grid h-9 w-9 place-items-center rounded-xl text-ink2 transition hover:bg-panel2 hover:text-accent"
        >
          <PanelLeftIcon width={18} height={18} />
        </button>
        <button
          onClick={onAdd}
          title="添加来源"
          aria-label="添加来源"
          className="grid h-9 w-9 place-items-center rounded-xl border border-dashed border-edge text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent"
        >
          <PlusIcon width={17} height={17} />
        </button>
        {sources.length > 0 && <div className="my-0.5 h-px w-7 bg-edge" />}
        {/* one tile per source — its type icon; a tap opens the source viewer */}
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {sources.map((s) => {
            return (
              <button
                key={s.id}
                onClick={() => onOpen(s)}
                title={s.title}
                aria-label={s.title}
                className={cn(
                  "grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-panel2/60 transition hover:bg-accentSoft",
                  s.status !== "ready" && "opacity-40"
                )}
              >
                <SourceGlyph source={s} size={17} />
              </button>
            );
          })}
        </div>
      </aside>
  );

  return (
    <>
    {rail}
    <aside
      className={cn(
        mobileActive ? "flex" : "hidden",
        "w-full shrink-0 flex-col overflow-hidden rounded-[22px] bg-panel elev-soft",
        collapsed ? "lg:hidden" : "lg:flex lg:w-[300px]"
      )}
    >
      <div className="flex items-center gap-2 px-3 py-3">
        <h2 className="text-sm font-semibold text-ink">来源</h2>
        {/* 折叠按钮只在桌面有意义(移动端显隐由底部 tab 管) */}
        <button
          onClick={onToggleCollapse}
          title="收起来源"
          className="ml-auto hidden rounded-lg p-1.5 text-ink2 transition hover:bg-panel2 hover:text-accent lg:block"
        >
          <PanelLeftIcon width={17} height={17} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={onAdd}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-edge bg-panel2/60 py-2.5 text-sm font-medium text-ink transition hover:-translate-y-0.5 hover:border-accent hover:bg-accentSoft hover:text-accent"
        >
          <PlusIcon width={16} height={16} /> 添加来源
        </button>
      </div>
      {/* 发现结果 + 全部来源 + 来源列表共享一个滚动区,避免发现结果过高时底部(导入等)被裁切且滚不到 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
      <InlineDiscover onImportUrls={onImportUrls} onImportText={onImportText} autoResearch={autoResearch} />

      {readyCount > 0 && (
        // 吸顶:滚动时「全部来源」行固定在滚动区顶部,搜索框照常滚走、列表从下面穿过(bg-panel 全宽盖住穿过的条目)
        <div className="sticky top-0 z-10 bg-panel px-2 pt-1">
          <label className="mb-1 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-xs text-ink2 transition hover:bg-panel2">
            <span>全部来源</span>
            <span className="ml-auto tabular-nums text-muted">
              {selectedCount}/{readyCount}
            </span>
            <Checkbox checked={allSelected} onChange={(c) => onToggleAll(c)} />
          </label>
        </div>
      )}

      <div className="px-2 pb-4">
        {loading ? (
          <SourcesSkeleton />
        ) : sources.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <FileIcon className="mx-auto mb-3 text-muted" width={30} height={30} />
            <p className="text-sm font-medium text-ink">已保存的来源将显示在此处</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              点击上方「添加来源」即可添加 PDF、网站、文本、Bilibili 视频或音频文件。
            </p>
          </div>
        ) : (
          <ul className="space-y-1">
            {dedupeSources(sources).map((s) => (
              <SourceItem
                key={s.id}
                source={s}
                onDelete={onDelete}
                onRetry={onRetry}
                onRename={onRename}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )}
      </div>
      </div>
    </aside>
    </>
  );
}

function Checkbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      className={cn(
        // 审查 #20:视觉仍 16x16,but 用透明 hit box 扩到 ≥40x40 达到触控标准
        // (移动端「切换来源是否参与回答」的唯一入口,原命中区太小)。
        "relative flex h-4 w-4 shrink-0 items-center justify-center rounded border transition",
        "before:absolute before:-inset-3 before:content-['']",
        checked ? "border-accent bg-accent text-onAccent" : "border-edge bg-panel hover:border-accent",
        disabled && "cursor-not-allowed opacity-40"
      )}
    >
      {checked && (
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </button>
  );
}

/** NotebookLM-style destructive-action confirmation dialog. */
function ConfirmDialog({
  title,
  subject,
  message,
  confirmLabel = "删除",
  onConfirm,
  onCancel,
}: {
  title: string;
  /** 被操作对象的名称(长 URL/长标题单独一行截断展示,避免撑乱标题) */
  subject?: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Esc=取消,与全站其它浮层(SourceViewer/SourceListModal 等)一致。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  // 删除/清空类确认按钮用红色(危险信号,与设置页删除账号一致),普通确认保持主题色。
  const danger = /删|清/.test(confirmLabel);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-edge bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[17px] font-semibold leading-snug text-ink">{title}</h3>
        {subject && (
          <p
            className="mt-2.5 truncate rounded-lg bg-panel2 px-3 py-2 text-[13px] text-ink2"
            title={subject}
          >
            {subject}
          </p>
        )}
        <p className="mt-2.5 text-sm leading-relaxed text-ink2">{message}</p>
        <div className="mt-6 flex items-center justify-end gap-2">
          {/* 默认焦点在「取消」:防误删对话框里回车不再直接删(方向反了才要命)。 */}
          <button
            autoFocus
            onClick={onCancel}
            className="rounded-full px-5 py-2 text-sm font-medium text-ink2 transition hover:bg-panel2"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className={cn(
              "rounded-full px-5 py-2 text-sm font-medium transition hover:brightness-110",
              danger ? "bg-red-500 text-white" : "bg-accent text-onAccent"
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** C5:播客「声音」选择弹窗。音频的生成配置弹窗本体在 Studio.tsx(GenerateConfigModal,
 *  此处不动它),音频确认后先经这一步挑音色组合,再把 voices key 并进生成请求体。
 *  预设表与服务端 lib/tts.ts 共用 components/studio-shared 的 VOICE_PRESETS(纯数据)。 */
function VoicePickerModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (voices: string) => void;
}) {
  const [key, setKey] = useState("default"); // 默认选 default 预设
  // Esc=取消,与 ConfirmDialog 等浮层一致。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-edge bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[17px] font-semibold leading-snug text-ink">选择声音</h3>
        <p className="mt-1 text-[12.5px] text-muted">两位主持人的音色组合,只影响声线,不影响内容。</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {VOICE_PRESETS.map((p) => {
            const on = key === p.key;
            return (
              <button
                key={p.key}
                onClick={() => setKey(p.key)}
                title={p.desc}
                className={cn(
                  "relative rounded-xl border-2 px-3 py-2.5 text-left transition",
                  on ? "border-accent bg-accentSoft/70" : "border-transparent bg-panel2 hover:border-accent/30"
                )}
              >
                <span className={cn("block text-[13.5px] font-medium", on ? "text-accent" : "text-ink")}>
                  {p.label}
                </span>
                <span className="mt-1 block text-[11.5px] leading-relaxed text-muted">{p.desc}</span>
                {on && (
                  <svg className="absolute right-2.5 top-2.5 text-accent" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-full px-5 py-2 text-sm font-medium text-ink2 transition hover:bg-panel2"
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(key)}
            className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-onAccent transition hover:brightness-110"
          >
            生成
          </button>
        </div>
      </div>
    </div>
  );
}

/** Icon for a source row, by source type. */
function sourceTypeIcon(type: Source["type"]) {
  return type === "url"
    ? LinkIcon
    : type === "pdf"
    ? FileIcon
    : type === "bilibili"
    ? BilibiliIcon
    : type === "audio"
    ? AudioIcon
    : type === "image"
    ? ImageIcon
    : TextIcon;
}

function sourceTypeColor(type: Source["type"]) {
  return type === "pdf"
    ? "text-red-500"
    : type === "url"
    ? "text-blue-500"
    : type === "bilibili"
    ? "text-pink-500"
    : type === "audio"
    ? "text-art-audio"
    : type === "image"
    ? "text-art-info"
    : "text-accent";
}

/** Source icon: a web source shows the site's favicon (NotebookLM-style),
 *  falling back to the generic type icon if it fails to load; every other type
 *  shows its type icon in the accent colour. */
function SourceGlyph({ source, size = 16 }: { source: Source; size?: number }) {
  const [failed, setFailed] = useState(false);
  let host: string | null = null;
  if (source.type === "url" && source.origin) {
    try {
      host = new URL(source.origin).hostname;
    } catch {
      host = null;
    }
  }
  if (host && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`https://www.google.com/s2/favicons?sz=64&domain=${host}`}
        alt=""
        width={size}
        height={size}
        className="rounded-[3px] object-contain"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  const Icon = sourceTypeIcon(source.type);
  return <Icon width={size} height={size} className={cn("shrink-0", sourceTypeColor(source.type))} />;
}

/** Red info (ⓘ) badge shown on a failed source — hovering/clicking reveals the
 *  reason in a tooltip. Rendered via a portal so it isn't clipped by the
 *  scrolling source panel. */
function SourceErrorTip({ message }: { message: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        onMouseEnter={show}
        onMouseLeave={() => setPos(null)}
        onClick={(e) => {
          e.stopPropagation();
          pos ? setPos(null) : show();
        }}
        aria-label={message}
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-red-500 transition hover:bg-red-500/15"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="11" x2="12" y2="16" />
          <circle cx="12" cy="8" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {pos &&
        createPortal(
          <div
            role="tooltip"
            style={{ top: pos.top, right: pos.right }}
            className="fixed z-[90] max-w-[260px] rounded-lg bg-solid px-3 py-2 text-xs leading-relaxed text-onSolid shadow-xl"
          >
            {message}
          </div>,
          document.body
        )}
    </>
  );
}

/** "查看来源" — the read-only list of sources a generated artifact was made from
 *  (NotebookLM-style). Non-text artifacts (audio, video, slides, …) can't be
 *  turned into a source, so this shows what they were built on instead. */
function SourceListModal({
  sources,
  onClose,
  onOpenSource,
}: {
  sources: Source[];
  onClose: () => void;
  onOpenSource: (s: Source) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-edge px-6 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accentSoft text-accent">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11.5v4.5" strokeLinecap="round" />
                <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <h3 className="text-base font-semibold text-ink">来源</h3>
            {sources.length > 0 && (
              <span className="rounded-full bg-panel2 px-2 py-0.5 text-xs font-medium text-ink2">
                {sources.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-panel2 hover:text-ink"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]">
          {sources.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">未找到该制品的来源信息。</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {sources.map((s) => {
                return (
                  <button
                    key={s.id}
                    onClick={() => onOpenSource(s)}
                    title={s.title}
                    className="group flex w-full items-center gap-2.5 rounded-xl border border-edge bg-panel px-3 py-2.5 text-left transition hover:border-accent/40 hover:bg-accentSoft/40 hover:shadow-[0_4px_14px_-10px_rgba(28,30,60,0.5)]"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-panel2 transition group-hover:bg-panel">
                      <SourceGlyph source={s} size={16} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{s.title}</span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="shrink-0 text-muted opacity-0 transition group-hover:opacity-100"
                      aria-hidden
                    >
                      <path d="M7 17 17 7M9 7h8v8" />
                    </svg>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 来源列表加载占位:模拟 SourceItem 行(图标方块 + 标题条 + 勾选方块),
 *  宽度逐行错落 + 呼吸式 animate-pulse,比纯 spinner 更稳。 */
export function SourcesSkeleton() {
  return (
    <ul className="space-y-1" aria-hidden aria-busy>
      {[0, 1, 2, 3, 4].map((i) => (
        <li
          key={i}
          className="flex animate-pulse items-center gap-2 rounded-xl px-2 py-1.5"
          style={{ animationDelay: `${(i % 3) * 120}ms` }}
        >
          <span className="h-3.5 w-3.5 shrink-0 rounded bg-panel2" />
          <span className="h-3 rounded bg-panel2" style={{ width: `${64 - (i % 3) * 12}%` }} />
          <span className="ml-auto h-3.5 w-3.5 shrink-0 rounded-[5px] bg-panel2" />
        </li>
      ))}
    </ul>
  );
}

/** 对话加载占位:两条 AI 气泡(左,多行)+ 一条用户气泡(右),薰衣草系呼吸骨架。 */
export function ChatSkeleton() {
  return (
    <div className="space-y-6" aria-hidden aria-busy>
      <div className="animate-pulse space-y-2">
        <span className="block h-3 w-2/3 rounded bg-panel2" />
        <span className="block h-3 w-11/12 rounded bg-panel2" />
        <span className="block h-3 w-4/5 rounded bg-panel2" />
      </div>
      <div className="flex animate-pulse justify-end" style={{ animationDelay: "150ms" }}>
        <span className="block h-9 w-2/5 rounded-2xl bg-panel2" />
      </div>
      <div className="animate-pulse space-y-2" style={{ animationDelay: "300ms" }}>
        <span className="block h-3 w-3/4 rounded bg-panel2" />
        <span className="block h-3 w-full rounded bg-panel2" />
        <span className="block h-3 w-2/3 rounded bg-panel2" />
      </div>
    </div>
  );
}

function SourceItem({
  source,
  onDelete,
  onRetry,
  onRename,
  onToggle,
  onOpen,
}: {
  source: Source;
  onDelete: (id: string) => void;
  onRetry: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onToggle: (id: string, selected: boolean) => void;
  onOpen: (s: Source) => void;
}) {
  // 失败 + 有原始链接的网络来源(url/bilibili/youtube)可「重新导入」(重抓);
  // 文件/文本来源无原始字节,只能删除后重新添加。
  const canRetry =
    source.status === "error" &&
    !!source.origin &&
    ["url", "bilibili", "youtube"].includes(source.type);
  // C4:网页类来源(origin 为 http 链接)可随时「重新抓取」刷新内容;抓取时间距今
  // >30 天再给行内过期小标。fetched_at 缺失(存量行)用 created_at 兜底。
  const isWebSource =
    !!source.origin &&
    /^https?:\/\//i.test(source.origin) &&
    ["url", "bilibili", "youtube"].includes(source.type);
  const canRefresh = source.status === "ready" && isWebSource;
  const fetchedDaysAgo = Math.floor(
    (Date.now() - (source.fetched_at ?? source.created_at)) / 86_400_000
  );
  const staleHint = canRefresh && fetchedDaysAgo > 30;
  const Icon =
    source.type === "url"
      ? LinkIcon
      : source.type === "pdf"
      ? FileIcon
      : source.type === "bilibili"
      ? BilibiliIcon
      : source.type === "audio"
      ? AudioIcon
      : source.type === "image"
      ? ImageIcon
      : TextIcon;
  const ready = source.status === "ready";
  const errorMessage =
    source.error?.trim() ||
    (source.type === "bilibili"
      ? "无法导入此视频,也无法获取转写内容。"
      : "无法加载此来源,请检查链接或稍后重试。");
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(source.title);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const startRename = () => {
    setMenuOpen(false);
    setDraft(source.title);
    setRenaming(true);
  };
  const commitRename = () => {
    setRenaming(false);
    const t = draft.trim();
    if (t && t !== source.title) onRename(source.id, t);
  };

  return (
    <li
      className={cn(
        // flex-wrap:过期提示行用 w-full 独占第二行,不动主行结构
        "group flex flex-wrap items-center gap-1.5 rounded-xl px-2 py-1.5 transition",
        // 透明度色深浅两模式都成立(裸 red-50 在深色模式不翻转,近白字压近白粉底不可读)
        source.status === "error" ? "bg-red-500/10 hover:bg-red-500/15" : "hover:bg-panel2"
      )}
    >
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Icon width={14} height={14} className="shrink-0 text-ink2" />
          <input
            name="title"
            autoComplete="off"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                setRenaming(false);
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-accent bg-panel px-1.5 py-0.5 text-sm text-ink outline-none ring-2 ring-accentSoft"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(source)}
          disabled={!ready}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          <span
            className={cn(
              "grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-md transition",
              source.status === "error" ? "bg-red-500/10" : "bg-panel2 group-hover:bg-panel"
            )}
          >
            {source.status === "processing" && !source.origin ? (
              <SpinnerIcon width={14} height={14} className="text-accent" />
            ) : (
              <SourceGlyph source={source} size={16} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-ink" title={source.title}>
              {source.title}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted">
              {source.status === "error" ? (
                <span className="text-red-500" title={source.error || undefined}>
                  {source.error || "无法加载此来源"}
                </span>
              ) : source.status === "processing" ? (
                // 占位行(pending-)可带定制副文案(如课代表包「解析后将自动生成…」);
                // 真实来源(重新导入等)照旧显示「处理中…」。
                <span className="inline-flex items-center gap-1 text-accent">
                  <SpinnerIcon width={11} height={11} />{" "}
                  {(source.id.startsWith("pending-") && source.summary) || "处理中…"}
                </span>
              ) : source.summary ? (
                source.summary
              ) : (
                `${source.chunk_count} 块 · ${source.char_count.toLocaleString()} 字`
              )}
            </span>
          </span>
        </button>
      )}
      {/* ⋮ menu (移除 / 重命名) + status/checkbox on the right (NotebookLM style) */}
      {!renaming && (
        <div className="flex shrink-0 items-center gap-1">
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="更多操作"
              className={cn(
                // 审查 #19:此前纯 group-hover 显示 → 触屏无 hover 时永远看不见「更多操作」;
                // 移动端(<lg)恒显,桌面保持 hover 行为;focus-visible 兼顾键盘导航。
                "rounded p-1 text-muted transition hover:text-ink",
                "max-lg:opacity-100 lg:opacity-0 lg:group-hover:opacity-100 focus-visible:opacity-100",
                menuOpen && "opacity-100 text-ink"
              )}
            >
              <DotsIcon width={15} height={15} />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div className={`absolute right-0 top-7 z-40 w-36 overflow-hidden ${MENU_PANEL}`}>
                  {canRetry && (
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        onRetry(source.id);
                      }}
                      className={MENU_ITEM}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
                        <path d="M21 3v5h-5" />
                      </svg>
                      重新导入
                    </button>
                  )}
                  {/* ready 的网页来源随时可重抓最新内容(不止过期才可刷) */}
                  {canRefresh && (
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        onRetry(source.id);
                      }}
                      className={MENU_ITEM}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
                        <path d="M21 3v5h-5" />
                      </svg>
                      重新抓取
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmOpen(true);
                    }}
                    className={MENU_ITEM}
                  >
                    <TrashIcon width={14} height={14} /> 移除来源
                  </button>
                  <button
                    onClick={startRename}
                    className={MENU_ITEM}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                    重命名来源
                  </button>
                </div>
              </>
            )}
          </div>
          {ready ? (
            <Checkbox checked={source.selected} onChange={(c) => onToggle(source.id, c)} />
          ) : source.status === "error" ? (
            <SourceErrorTip message={errorMessage} />
          ) : null}
        </div>
      )}
      {/* 网页来源过期小标:抓取时间距今 >30 天,提示可能已更新 + 一键刷新(复用重新导入链路) */}
      {staleHint && !renaming && (
        <div className="flex w-full items-center gap-1 pl-9 text-[11px] leading-snug text-muted">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <span className="min-w-0 flex-1 truncate">内容抓取于 {fetchedDaysAgo} 天前,可能已更新</span>
          <button
            type="button"
            onClick={() => onRetry(source.id)}
            className="shrink-0 rounded-md px-1.5 py-0.5 font-semibold text-accent transition hover:bg-accentSoft"
          >
            刷新
          </button>
        </div>
      )}
      {confirmOpen && (
        <ConfirmDialog
          title="要删除这个来源吗?"
          subject={source.title}
          message="此来源将从您的笔记本中永久移除,并且将无法恢复。"
          onConfirm={() => {
            setConfirmOpen(false);
            onDelete(source.id);
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// chat panel
// ---------------------------------------------------------------------------

function ChatHeaderMenu({ onClear, canClear }: { onClear: () => void; canClear: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="更多"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-ink2 transition hover:bg-panel2 hover:text-ink"
      >
        <DotsIcon width={18} height={18} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className={`absolute right-0 top-9 z-20 w-36 overflow-hidden ${MENU_PANEL}`}>
            <button
              onClick={() => {
                setOpen(false);
                if (canClear) onClear();
              }}
              disabled={!canClear}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-ink2 transition hover:bg-panel2 hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink2"
            >
              <TrashIcon width={14} height={14} /> 清空对话
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ChatPanel({
  notebook,
  mobileActive,
  suspended,
  messages,
  loading,
  sending,
  readyCount,
  totalSources,
  selectedCount,
  summary,
  suggestedQuestions,
  overviewLoading,
  quotaMsg,
  chatCreditCost,
  onSend,
  onQuickResearch,
  onCite,
  onAddSource,
  onSaveNote,
  onRegenerate,
  onClearChat,
  onFeedback,
  activeSkill,
  onRunSkill,
  onClearSkill,
  onOpenSkillPicker,
  onStop,
}: {
  notebook: Notebook | null;
  /** B8:手机端底部 tab 选中「对话」→ 显示;桌面端(lg+)恒显示,不受此影响。 */
  mobileActive: boolean;
  /** CAD 占用主窗口期间保持对话挂载，但暂停自动滚动写入。 */
  suspended: boolean;
  messages: UiMessage[];
  loading: boolean;
  sending: boolean;
  quotaMsg: string | null;
  chatCreditCost: number;
  readyCount: number;
  totalSources: number;
  selectedCount: number;
  summary: string | null;
  suggestedQuestions: string[];
  overviewLoading: boolean;
  onSend: (text: string) => void;
  onQuickResearch: (query: string) => void;
  onCite: (c: Citation) => void;
  onAddSource: () => void;
  onSaveNote: (content: string, citations?: Citation[]) => boolean | void | Promise<boolean | void>;
  onRegenerate: () => void;
  onClearChat: () => void;
  onFeedback: (id: string, value: "up" | "down") => void;
  activeSkill: Skill | null;
  onRunSkill: (skill: Skill) => void;
  onClearSkill: () => void;
  /** 停止当前流式生成:sending 期间发送按钮切换为「停止」,点击 abort。 */
  onStop: () => void;
  onOpenSkillPicker: () => void;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const lastVisibleScrollTopRef = useRef(0);
  const wasSuspendedRef = useRef(suspended);
  // "/" slash command: when the input starts with "/", show the skill menu and
  // drive it with the keyboard. The query is whatever follows the slash.
  const slashOpen = input.startsWith("/");
  const slashItems = useMemo(() => (slashOpen ? filterSkills(input.slice(1)) : []), [slashOpen, input]);
  const [slashIdx, setSlashIdx] = useState(0);
  useEffect(() => {
    // 草稿只属于当前笔记本；CAD 往返保留，但切到另一本必须清空。
    setInput("");
    setSlashIdx(0);
  }, [notebook?.id]);
  useEffect(() => {
    setSlashIdx(0);
  }, [input]);

  const pickSlash = (skill: Skill) => {
    setInput("");
    onRunSkill(skill);
  };

  // 进入对话要停在「最新一条」(最底部)而不是最上。三管齐下(缺一不可,均实测校准):
  //  1) 进入时同步 scrollTop=scrollHeight —— 立即到底;
  //  2) MutationObserver 盯 DOM 变化(消息/概览/表格逐步渲染)持续贴底;
  //  3) 几档 setTimeout 兜住「纯布局回流」(字体/表格列宽/图片)——无 DOM 变化、MO 抓不到。
  // 「粘底」态只被用户上翻手势(wheel/touch)松开。**踩过的大坑**:rAF 与 ResizeObserver
  // 都绑动画帧生命周期,后台/不可见标签会暂停帧循环 → 一帧都跑不成(卡顶端/半路);故全程
  // 不依赖它们,只用同步 + MO(微任务) + setTimeout(定时器),前台后台都可靠。
  const stickBottomRef = useRef(true);
  const chatContentRef = useRef<HTMLDivElement>(null);
  // 进入/切换会话:重新粘底并立即到底(同步),再用几档 setTimeout 兜底——覆盖「纯布局
  // 回流(字体加载 / 表格列宽 / 图片尺寸)」这类不产生 DOM 变化、MO 抓不到的晚定高。
  // 定时器在后台标签也会 fire(被钳到 ~1s),前台按时,不像 rAF/RO 被帧节流暂停。
  useEffect(() => {
    if (!notebook?.id) return;
    stickBottomRef.current = true;
    const toBottom = () => {
      const e = scrollRef.current;
      if (e && stickBottomRef.current && !suspendedRef.current) {
        e.scrollTop = e.scrollHeight;
        lastVisibleScrollTopRef.current = e.scrollTop;
      }
    };
    toBottom();
    const timers = [120, 400, 900, 1800].map((ms) => setTimeout(toBottom, ms));
    return () => timers.forEach(clearTimeout);
  }, [notebook?.id]);
  // 追上「分批 / 晚定高」的加载(消息、异步概览摘要、大表格 markdown 逐步渲染):用
  // MutationObserver 盯对话内容的 DOM 变化,每次变化(粘底期间)就同步贴底。
  // **为什么不用 rAF / ResizeObserver**:它们绑定动画帧生命周期,浏览器对后台/不可见标签
  // 会暂停帧循环 → 实测预览里 rAF、RO 完全不 fire、贴底一帧都跑不成(卡顶端/半路);
  // MutationObserver 是微任务、不受帧节流影响,预览与真实用户都可靠。用户上翻即止(stick=false)。
  useEffect(() => {
    const content = chatContentRef.current;
    if (!content || typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => {
      if (suspendedRef.current) return;
      const e = scrollRef.current;
      if (e && stickBottomRef.current) {
        e.scrollTop = e.scrollHeight;
        lastVisibleScrollTopRef.current = e.scrollTop;
      }
    });
    mo.observe(content, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);
  // 松开粘底只认「用户主动上翻」的手势(wheel 上滚 / 触摸下拉),**不看 scroll 事件**——
  // 因为程序化贴底、以及浏览器 scroll anchoring(内容变化时自动微调 scrollTop 保持视觉
  // 稳定)都会触发 scroll 事件并可能让 scrollTop 反向微退,若据此判「用户上翻」就会在到底
  // 前被误松开、卡在半路(实测差 190px 的元凶)。scroll 事件只用来「回到底部时重新粘上」。
  const releaseIfUp = (dy: number) => {
    if (dy < 0) stickBottomRef.current = false;
  };
  const onChatWheel = (e: React.WheelEvent) => releaseIfUp(e.deltaY);
  const touchYRef = useRef(0);
  const onChatTouchStart = (e: React.TouchEvent) => {
    touchYRef.current = e.touches[0]?.clientY ?? 0;
  };
  const onChatTouchMove = (e: React.TouchEvent) => {
    const y = e.touches[0]?.clientY ?? 0;
    releaseIfUp(touchYRef.current - y); // 手指下滑=内容上移(看上文)→ 松开
    touchYRef.current = y;
  };
  const onChatScroll = () => {
    const el = scrollRef.current;
    if (!el || suspendedRef.current) return;
    lastVisibleScrollTopRef.current = el.scrollTop;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) stickBottomRef.current = true;
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (suspended) {
      wasSuspendedRef.current = true;
      return;
    }
    if (!wasSuspendedRef.current) return;
    // 粘底用户返回时看最新 token；主动上翻的用户恢复进 CAD 前的位置。
    el.scrollTop = stickBottomRef.current
      ? el.scrollHeight
      : Math.min(lastVisibleScrollTopRef.current, Math.max(0, el.scrollHeight - el.clientHeight));
    lastVisibleScrollTopRef.current = el.scrollTop;
    wasSuspendedRef.current = false;
  }, [suspended]);

  // 置顶概览块:summary 不变时不随流式 token 重渲染(remark 解析不便宜)。
  const pinnedOverview = useMemo(
    () =>
      summary ? (
        <div>
          <NotebookOverviewCard notebook={notebook} totalSources={totalSources} />
          <div className="prose-chat mt-4">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.replace(/\*\*/g, "")}</ReactMarkdown>
          </div>
          {/* 统一操作行:与空对话概览/对话气泡同款(存入笔记 + 复制) */}
          <OverviewActions summary={summary} onSaveNote={onSaveNote} />
        </div>
      ) : null,
    [summary, notebook, totalSources, onSaveNote]
  );

  const overQuota = !!quotaMsg;
  const submit = () => {
    const v = input.trim();
    if (!v || v.startsWith("/")) return; // leading "/" is a skill command, not a message
    if (overQuota) {
      // 额度用完:输入框保持正常外观,真去发送时才轻轻提示一句,不发送、也不清空已输入文本。
      toast(quotaMsg || "积分不足", "error");
      return;
    }
    // 会话串行:回答未结束时回车不发送、也不清空已输入文本,只提示。
    if (sending) {
      toast("当前回答还在生成中,请等它结束再发送", "error");
      return;
    }
    onSend(input);
    setInput("");
  };

  const hasSources = readyCount > 0;
  const placeholder = !hasSources
    ? "开始输入…(没有来源也能聊,或先在左侧加来源)"
    : selectedCount === 0
    ? "请至少选择一个来源…"
    : "提问或创作内容";

  return (
    <section
      className={cn(
        mobileActive ? "flex" : "hidden",
        "min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] bg-panel elev-soft lg:flex"
      )}
    >
        <div className="tech-beam" aria-hidden />
      <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
        <h2 className="text-sm font-semibold text-ink">对话</h2>
        <ChatHeaderMenu onClear={onClearChat} canClear={messages.length > 0} />
      </div>
      {quotaMsg && (
        <div className="flex items-center gap-2.5 border-b border-onAccent/15 bg-accent px-4 py-1.5 text-onAccent">
          {/* 去掉行首 info 图标:让提示文字左缘落在 px-4,与「对话」标题及下方正文对齐 */}
          <span className="flex-1 text-[13.5px] font-medium">{quotaMsg}</span>
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onChatScroll}
        onWheel={onChatWheel}
        onTouchStart={onChatTouchStart}
        onTouchMove={onChatTouchMove}
        className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable]"
      >
        <div ref={chatContentRef} className="mx-auto max-w-3xl px-4 pb-6 pt-3">
          {loading ? (
            <ChatSkeleton />
          ) : messages.length === 0 ? (
            <EmptyChat
              notebook={notebook}
              hasSources={hasSources}
              totalSources={totalSources}
              summary={summary}
              questions={suggestedQuestions}
              overviewLoading={overviewLoading}
              onSend={onSend}
              onAddSource={onAddSource}
              onSaveNote={onSaveNote}
            />
          ) : (
            <div className="space-y-6">
              {/* pinned overview — stays at the top of the conversation
                  (useMemo:与 MessageBubble 的 memo 同理,别让流式每个 token 重跑这段
                  ReactMarkdown 解析) */}
              {pinnedOverview}
              {messages.map((m, i) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  isLast={i === messages.length - 1}
                  sending={sending}
                  onCite={onCite}
                  onFollowup={onSend}
                  onQuickResearch={onQuickResearch}
                  onSaveNote={onSaveNote}
                  onRegenerate={onRegenerate}
                  onFeedback={onFeedback}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="px-4 pb-4 pt-2">
        <div className="mx-auto max-w-3xl">
          {activeSkill && activeSkill.mode === "chat" && (
            <ActiveSkillTag skill={activeSkill} onClear={onClearSkill} />
          )}
          <SkillChips onPick={onRunSkill} onOpenAll={onOpenSkillPicker} activeId={activeSkill?.id} />
          <div className="relative">
            {slashOpen && <SlashMenu items={slashItems} activeIndex={slashIdx} onPick={pickSlash} />}
            <div className="flex items-center gap-3 rounded-[26px] border border-edge bg-panel py-2.5 pl-5 pr-2.5 shadow-[0_2px_10px_-6px_rgba(28,30,60,0.18)] transition focus-neon">
            <textarea
              name="message"
              autoComplete="off"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (slashOpen && slashItems.length) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIdx((i) => (i + 1) % slashItems.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIdx((i) => (i - 1 + slashItems.length) % slashItems.length);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    pickSlash(slashItems[slashIdx]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setInput("");
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={slashOpen ? "输入技能名,↑↓ 选择 · ↵ 使用" : placeholder}
              className="max-h-40 flex-1 resize-none self-center bg-transparent py-2 text-[15px] leading-relaxed outline-none placeholder:text-muted"
            />
            {(selectedCount || readyCount) > 0 && (
              <span className="shrink-0 whitespace-nowrap text-[13px] text-muted">
                {selectedCount || readyCount} 个来源
              </span>
            )}
            <span className="hidden shrink-0 whitespace-nowrap text-[12px] text-muted sm:inline">
              本次 {chatCreditCost} 积分
            </span>
            <button
              onClick={sending ? onStop : submit}
              disabled={!sending && !input.trim()}
              className={cn(
                "inline-flex h-10 w-10 shrink-0 items-center justify-center self-center rounded-full transition disabled:cursor-not-allowed",
                sending
                  ? "bg-ink text-panel hover:brightness-110"
                  : input.trim()
                  ? "bg-accent text-onAccent hover:brightness-110"
                  : "bg-panel2 text-ink2"
              )}
              aria-label={sending ? "停止生成" : "发送"}
              title={sending ? "停止生成" : undefined}
            >
              {sending ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
              ) : (
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
                </svg>
              )}
            </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Shrink an image file to a small JPEG data URL — keeps the original aspect
 *  ratio (downscaled so the longest side ≤ `max`) so it works as a card cover
 *  while staying tiny enough to store inline. */
function resizeImageToDataUrl(file: File, max = 640): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no canvas"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/** Notebook identity card shown at the top of the conversation — cover (emoji or
 *  custom image) + 替换图片 on top, title + source/date meta below, with a subtle
 *  decorative wave (matches NotebookLM). The auto-summary renders BELOW. */
function NotebookOverviewCard({
  notebook,
  totalSources,
}: {
  notebook: Notebook | null;
  totalSources: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [coverImage, setCoverImage] = useState<string | null>(null);
  const displayCover = coverImage ?? notebook?.cover_image ?? null;
  const [emoji, setEmoji] = useState<string | null>(null);
  const displayEmoji = emoji ?? notebook?.emoji ?? "📓";
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number } | null>(null);

  const openPicker = () => {
    const r = emojiBtnRef.current?.getBoundingClientRect();
    if (r) setPickerPos({ top: r.bottom + 8, left: r.left });
  };
  const selectEmoji = (e: string) => {
    setEmoji(e);
    setPickerPos(null);
    if (!notebook) return;
    fetch(`/api/notebooks/${notebook.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji: e }),
    }).catch(() => {});
  };

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file || !notebook) return;
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      setCoverImage(dataUrl); // optimistic
      await fetch(`/api/notebooks/${notebook.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cover_image: dataUrl }),
      });
      toast("已替换封面图片");
    } catch {
      toast("图片处理失败,请换一张试试", "error");
    }
  };

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl px-6 pb-6 pt-5",
        // hover 同色系加深:淡紫底 → 更深的淡紫(accent 同色相),不蒙黑不发灰
        !displayCover && "bg-panel2 transition-colors duration-200 hover:bg-accent/15"
      )}
    >
      {displayCover ? (
        <>
          {/* 底图: custom cover image fills the card;hover 用亮度压暗(保色相,不蒙灰) */}
          <img
            src={displayCover}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover transition-[filter] duration-200 group-hover:brightness-[0.85]"
          />
          {/* readability scrim so emoji + title stay legible on any photo */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(to bottom, rgba(0,0,0,0.34), rgba(0,0,0,0.04) 42%, rgba(0,0,0,0.62))",
            }}
          />
        </>
      ) : (
        /* decorative wave line-art (only without a cover image) */
        <svg
          className="pointer-events-none absolute bottom-0 right-0 h-28 w-3/5 text-[#d7d9f3]"
          viewBox="0 0 260 110"
          fill="none"
          preserveAspectRatio="xMaxYMax meet"
          aria-hidden
        >
          <path
            d="M2 94 Q48 94 76 66 Q100 42 124 64 Q142 80 170 50 Q198 20 222 46 Q240 66 258 58"
            stroke="currentColor"
            strokeWidth="9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {/* top row: emoji (click to change) + 替换图片 button */}
      <div className="relative flex items-start justify-between gap-3">
        <button
          ref={emojiBtnRef}
          onClick={openPicker}
          title="点击更换 emoji"
          className="select-none rounded-2xl px-1 text-[44px] leading-none transition hover:scale-[1.08]"
          style={displayCover ? { filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.5))" } : undefined}
        >
          {displayEmoji}
        </button>
        <input name="cover-image" ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickImage} />
        <button
          onClick={() => fileRef.current?.click()}
          title="替换封面图片"
          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-edge bg-panel px-4 py-2 text-[13px] font-medium text-ink2 shadow-sm transition hover:border-accent hover:text-accent"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2.5" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="m21 15-4.5-4.5L6 21" />
          </svg>
          替换图片
        </button>
      </div>
      {/* title + meta */}
      <div className="relative mt-8">
        <h2
          className={cn(
            "text-[24px] font-bold leading-tight",
            displayCover ? "text-white" : "text-ink"
          )}
          style={displayCover ? { textShadow: "0 1px 10px rgba(0,0,0,0.55)" } : undefined}
        >
          {notebook?.title || "你的笔记本"}
        </h2>
        <p
          className={cn("mt-1.5 text-sm", displayCover ? "text-white" : "text-ink2")}
          style={displayCover ? { textShadow: "0 1px 8px rgba(0,0,0,0.55)" } : undefined}
        >
          {totalSources} 个来源{notebook ? ` · ${fmtDate(notebook.created_at)}` : ""}
        </p>
      </div>

      {/* emoji picker — rendered via portal so it isn't clipped by the card */}
      {pickerPos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[88]" onClick={() => setPickerPos(null)} />
            <div
              style={{ top: pickerPos.top, left: pickerPos.left }}
              className="fixed z-[89] w-[284px] rounded-2xl border border-edge bg-panel p-2.5 shadow-2xl"
            >
              <p className="mb-1.5 px-1 text-xs font-medium text-ink2">选择一个 emoji</p>
              <div className="grid grid-cols-8 gap-0.5">
                {EMOJI_CHOICES.map((e) => (
                  <button
                    key={e}
                    onClick={() => selectEmoji(e)}
                    className={cn(
                      "grid h-8 w-8 place-items-center rounded-lg text-xl transition hover:bg-panel2",
                      e === displayEmoji && "bg-accentSoft"
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}

/** 概览块的统一操作行(添加到我的笔记 + 复制)—— 与对话气泡的操作行同款样式与
 *  防连点守卫。空对话概览与置顶概览共用,保证「有存入笔记、复制」的样式统一。 */
function OverviewActions({
  summary,
  onSaveNote,
}: {
  summary: string;
  onSaveNote: (content: string, citations?: Citation[]) => boolean | void | Promise<boolean | void>;
}) {
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedRef = useRef(false);
  return (
    <div className="mt-2.5 flex items-center gap-1.5 text-ink2">
      <button
        onClick={async () => {
          if (savedRef.current) return; // 防连点:一份概览只存一次
          savedRef.current = true;
          setSaving(true);
          try {
            const ok = await onSaveNote(summary);
            if (ok === false) throw new Error("save failed");
            setSaved(true);
            toast("已添加到我的笔记");
          } catch {
            savedRef.current = false;
            toast("添加到笔记失败,请重试", "error");
          } finally {
            setSaving(false);
          }
        }}
        disabled={saved || saving}
        className="inline-flex items-center gap-1.5 rounded-full bg-accentSoft px-3.5 py-1.5 text-xs font-medium text-accent transition hover:bg-accent hover:text-white disabled:cursor-default disabled:opacity-70 disabled:hover:bg-accentSoft disabled:hover:text-accent"
      >
        {saved ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-11" /></svg>
        ) : (
          <SaveIcon width={13} height={13} />
        )}
        {saved ? "已添加到笔记" : saving ? "正在保存…" : "添加到我的笔记"}
      </button>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(summary);
          toast("已复制到剪贴板");
        }}
        className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-panel px-3 py-1.5 text-xs font-medium text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent"
      >
        <CopyIcon width={14} height={14} /> 复制
      </button>
    </div>
  );
}

function EmptyChat({
  notebook,
  hasSources,
  totalSources,
  summary,
  questions,
  overviewLoading,
  onSend,
  onAddSource,
  onSaveNote,
}: {
  notebook: Notebook | null;
  hasSources: boolean;
  totalSources: number;
  summary: string | null;
  questions: string[];
  overviewLoading: boolean;
  onSend: (text: string) => void;
  onAddSource: () => void;
  onSaveNote: (content: string, citations?: Citation[]) => boolean | void | Promise<boolean | void>;
}) {
  if (!hasSources) {
    return (
      <div className="py-10">
        <div className="text-5xl">👋</div>
        <h2 className="mt-4 text-[28px] font-bold leading-tight text-ink">
          让我们开始制作笔记本…
        </h2>
        {/* 限宽从 max-w-xl 放宽:576px 在宽屏下只占对话区一半多,右侧空出一大块,
            看着像内容没加载完。text-pretty 让末行不至于孤零零吊一小截。 */}
        <p className="mt-3 max-w-3xl text-pretty text-[15px] leading-relaxed text-ink2">
          三步用起来:①添加来源(PDF、网页、B站视频、音频都行)→ ②向资料提问,回答只基于你的来源、带原文引用 → ③一键生成思维导图、播客、测验等制品。
          {totalSources > 0
            ? "来源仍在处理中,就绪后即可基于它提问。"
            : "我可以引导你开始,你也可以直接添加自己的来源。"}
        </p>
        <button
          onClick={onAddSource}
          className="mt-7 inline-flex items-center gap-2 rounded-full border border-edge bg-panel px-4 py-2 text-sm font-medium text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent"
        >
          <PlusIcon width={15} height={15} /> 添加来源
        </button>
      </div>
    );
  }

  const hasQuestions = questions.length > 0;
  const chips = (hasQuestions ? questions : STUDIO_PROMPTS.map((p) => p.prompt)).slice(0, 3);

  return (
    <div className="mx-auto max-w-2xl pb-8 pt-1">
      <NotebookOverviewCard
        notebook={notebook}
        totalSources={totalSources}
      />

      {/* overview (auto summary) + actions */}
      {overviewLoading ? (
        <p className="mt-6 flex items-center gap-2 text-sm text-ink2">
          <SpinnerIcon width={14} height={14} /> 正在按所选来源生成概览…
        </p>
      ) : summary ? (
        <div className="mt-6">
          <div className="prose-chat">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.replace(/\*\*/g, "")}</ReactMarkdown>
          </div>
          {/* 统一操作行:与对话气泡/置顶概览同款(存入笔记 + 复制) */}
          <OverviewActions summary={summary} onSaveNote={onSaveNote} />
        </div>
      ) : (
        <p className="mt-6 text-[15px] leading-relaxed text-ink2">
          向你的资料提问 —— 回答只基于所选来源,并标注引用,有据可循。
        </p>
      )}

      {/* suggested questions */}
      {chips.length > 0 && (
        <div className="mt-8">
          <div className="flex flex-col items-start gap-1.5">
            {chips.map((q) => (
              <SuggestionChip key={q} q={q} onClick={() => onSend(q)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 建议问题 chip —— 空状态「起始问题」与回答后的「追问」共用同一款(纯文字胶囊,无图标),样式只此一处。 */
function SuggestionChip({ q, onClick }: { q: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={q}
      className="inline-flex max-w-full items-center rounded-full border border-edge bg-panel px-3.5 py-1.5 text-left text-[13px] leading-snug text-ink2 transition hover:border-accent/40 hover:bg-accentSoft/60 hover:text-accent"
    >
      {/* 单行约束:超长问题截断为省略号(hover/title 看全文),避免胶囊换行撑高破坏布局 */}
      <span className="block min-w-0 truncate">{q}</span>
    </button>
  );
}

// memo:流式期间每个 token 都 setMessages,若不 memo,全部历史消息的 ReactMarkdown
// 会整列表重跑(长对话越聊越卡)。除流式占位那条外,其余消息对象引用稳定(patch 只
// 换匹配 id 的那条),回调均为 useCallback —— 浅比较即可跳过重渲染。
const MessageBubble = memo(function MessageBubble({
  message,
  isLast,
  sending,
  onCite,
  onFollowup,
  onQuickResearch,
  onSaveNote,
  onRegenerate,
  onFeedback,
}: {
  message: UiMessage;
  isLast: boolean;
  sending: boolean;
  onCite: (c: Citation) => void;
  onFollowup: (text: string) => void;
  onQuickResearch: (query: string) => void;
  onSaveNote: (content: string, citations?: Citation[]) => boolean | void | Promise<boolean | void>;
  onRegenerate: () => void;
  onFeedback: (id: string, value: "up" | "down") => void;
}) {
  const [noteSaved, setNoteSaved] = useState(false); // 本条回答是否已存为笔记(防连点重复添加)
  const noteSavedRef = useRef(false); // 同步锁,挡同一 tick 的连点
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accentSoft px-4 py-2.5 text-sm text-ink">
          {message.content}
        </div>
      </div>
    );
  }

  const showActions =
    isLast &&
    !message.streaming &&
    !message.error &&
    ((message.followups?.length ?? 0) > 0 || !!message.research);

  return (
    <div className="flex gap-3">
      <div className="min-w-0 flex-1">
        {message.content ? (
          <ChatMarkdown content={message.content} citations={message.citations} onCite={onCite} />
        ) : message.streaming ? (
          <DynamicStatus
            steps={[
              "正在理解你的问题…",
              "正在浏览所选来源…",
              "正在定位相关段落…",
              "正在交叉比对信息…",
              "正在综合组织答案…",
              "正在标注引用出处…",
            ]}
            className="py-1 text-sm text-ink2"
          />
        ) : null}
        {message.streaming && message.content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-text-bottom" />}
        {/* 独立错误行(#8 修:错误态与正文解耦,有部分内容时保留正文可读);带重试(#7)/复制 */}
        {message.error && (
          <div className="mt-2 flex flex-wrap items-start gap-2 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2 text-[13px] text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0"><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>
            <span className="min-w-0 flex-1 break-words">{message.errorText || (message.content ? "回答已中断" : "回答生成失败,请重试")}</span>
            {isLast && (
              <button onClick={onRegenerate} disabled={sending} className="shrink-0 rounded-full border border-red-300 bg-white/70 px-3 py-1 text-xs font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50 dark:border-red-700 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/50">
                重新生成
              </button>
            )}
            {message.content && (
              <button onClick={() => { navigator.clipboard?.writeText(message.content).then(() => toast("已复制到剪贴板")).catch(() => toast("复制失败", "error")); }} className="shrink-0 rounded-full border border-red-300 bg-white/70 px-3 py-1 text-xs font-medium text-red-700 transition hover:bg-red-100 dark:border-red-700 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/50">
                复制已生成部分
              </button>
            )}
          </div>
        )}
        {!message.streaming && !message.error && message.content && (
          <div className="mt-2.5 flex items-center gap-1.5 text-ink2">
            <button
              onClick={async () => {
                if (noteSavedRef.current) return; // 防连点(tick 级)
                noteSavedRef.current = true;
                try {
                  const ok = await onSaveNote(message.content, message.citations);
                  if (ok === false) {
                    noteSavedRef.current = false; // 失败允许重试
                    toast("添加到笔记失败,请重试", "error");
                    return;
                  }
                  setNoteSaved(true);
                  toast("已添加到我的笔记");
                } catch {
                  noteSavedRef.current = false;
                  toast("添加到笔记失败,请重试", "error");
                }
              }}
              disabled={noteSaved}
              className="inline-flex items-center gap-1.5 rounded-full bg-accentSoft px-3.5 py-1.5 text-xs font-medium text-accent transition hover:bg-accent hover:text-white disabled:cursor-default disabled:opacity-70 disabled:hover:bg-accentSoft disabled:hover:text-accent"
            >
              {noteSaved ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-11" /></svg>
              ) : (
                <SaveIcon width={13} height={13} />
              )}
              {noteSaved ? "已添加到笔记" : "添加到我的笔记"}
            </button>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(message.content);
                toast("已复制到剪贴板");
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-panel px-3 py-1.5 text-xs font-medium text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent"
            >
              <CopyIcon width={14} height={14} /> 复制
            </button>
            {isLast && (
              <button
                onClick={onRegenerate}
                disabled={sending}
                title="重新生成"
                className="flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-panel2 hover:text-accent disabled:opacity-50"
              >
                <RefreshIcon width={15} height={15} />
              </button>
            )}
            <button
              onClick={() => onFeedback(message.id, "up")}
              title="有帮助"
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-panel2 hover:text-accent",
                message.feedback === "up" && "text-accent"
              )}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill={message.feedback === "up" ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 10v12" /><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
              </svg>
            </button>
            <button
              onClick={() => onFeedback(message.id, "down")}
              title="没帮助"
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-panel2 hover:text-red-500",
                message.feedback === "down" && "text-red-500"
              )}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill={message.feedback === "down" ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 14V2" /><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
              </svg>
            </button>
          </div>
        )}
        {showActions && (
          <div className="mt-3 flex flex-col items-start gap-1.5">
            {message.research && (
              <button
                onClick={() => onQuickResearch(message.research!.query)}
                title={message.research.label}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accentSoft/60 px-3.5 py-1.5 text-left text-[13px] font-medium leading-snug text-accent transition hover:bg-accentSoft hover:brightness-105"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <span className="block min-w-0 truncate">{message.research.label}</span>
              </button>
            )}
            {message.followups?.map((q) => (
              <SuggestionChip key={q} q={q} onClick={() => onFollowup(q)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 animate-bounce rounded-full bg-muted"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

function ChatMarkdown({
  content,
  citations,
  onCite,
}: {
  content: string;
  citations: Citation[];
  onCite: (c: Citation) => void;
}) {
  const components: Components = {
    cite({ children }) {
      const n = Number(childText(children));
      const c = citations.find((x) => x.number === n);
      // 无匹配来源的编号(模型偶发越界瞎标,如创作文案里的 [488])不渲染成可点角标,
      // 退回字面文本,免得出现点了没反应的假徽章。
      if (!c) return <>[{n}]</>;
      return (
        <button
          type="button"
          className="cite"
          title={c.snippet ? `${c.source_title}：${c.snippet}` : c.source_title}
          onClick={() => onCite(c)}
        >
          {n}
        </button>
      );
    },
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    // 审查 #22:回答里的宽 markdown 表格此前裸渲染,窄屏撑破消息列并让整个
    // 对话区变成横向滚动。用独立 overflow-x 容器承载,只有表格自己滚。
    table({ children }) {
      return <ResponsiveMarkdownTable>{children}</ResponsiveMarkdownTable>;
    },
  };
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeCitations] as never}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** PDF-extracted source text often arrives as one giant blob with no line
 *  breaks. Split it into readable paragraphs (honour real breaks first, then
 *  group ~3 sentences each) so the viewer isn't a wall of text. */
/** Drop a leading Markdown heading from source content when it just repeats the
 *  title — the viewer header already shows it, so the body shouldn't too. */
function stripLeadingHeading(content: string, title: string): string {
  const lines = (content || "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const m = lines[i]?.match(/^#{1,6}\s+(.*)$/);
  if (m) {
    const norm = (s: string) => s.replace(/[#*`>\s]/g, "");
    const h = norm(m[1]);
    const t = norm(title);
    if (h && (h === t || t.includes(h) || h.includes(t))) {
      return lines.slice(i + 1).join("\n").replace(/^\s+/, "");
    }
  }
  return content;
}

function SourceViewer({
  target,
  onClose,
  onOpenSource,
  onOpenNote,
  onOpenCross,
}: {
  target: ViewerTarget;
  onClose: () => void;
  onOpenSource?: (id: string, title: string) => void;
  onOpenNote?: (id: string) => void;
  onOpenCross?: (notebookId: string, item: { kind: "source" | "note"; id: string; title: string }) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<
    (Source & { content: string }) | null
  >(null);
  const [sourceVersionChanged, setSourceVersionChanged] = useState(false);
  const [full, setFull] = useState(false);
  const [mode, setMode] = useState<"web" | "text">("text");
  const [embedState, setEmbedState] = useState<"checking" | "ok" | "blocked">("ok");
  const markRef = useRef<HTMLElement>(null);
  // Citation passages highlight on top of the RENDERED markdown via the CSS
  // Custom Highlight API; null = match pending, false = fall back to the
  // plain-text <mark> path (old behaviour, guaranteed hit on raw content).
  const [domMatched, setDomMatched] = useState<boolean | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Web pages embed their URL; Bilibili videos embed the official player so the
  // viewer shows a real video player below the summary.
  const bvid =
    source?.type === "bilibili" ? source.origin?.match(/BV[0-9A-Za-z]+/)?.[0] ?? null : null;
  const externalUrl =
    source?.type === "bilibili"
      ? bvid
        ? `https://www.bilibili.com/video/${bvid}`
        : null
      : source?.origin ?? null;
  const embedUrl =
    source?.type === "bilibili"
      ? bvid
        ? `https://player.bilibili.com/player.html?bvid=${bvid}&autoplay=0&danmaku=0`
        : null
      : source?.type === "url"
      ? source?.origin ?? null
      : null;
  const isEmbeddable = !!embedUrl;
  const isVideo = source?.type === "bilibili";
  const embedHost = (() => {
    try {
      return externalUrl ? new URL(externalUrl).hostname.replace(/^www\./, "") : "";
    } catch {
      return "";
    }
  })();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setSource(null);
    setSourceVersionChanged(false);
    fetch(`/api/sources/${target.sourceId}`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        if (data.source) setSource(data.source);
        else setError(data.error || "无法加载来源");
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [target.sourceId]);

  useEffect(() => {
    let alive = true;
    if (!source || !target.sourceContentHash) {
      setSourceVersionChanged(false);
      return () => { alive = false; };
    }
    void citationContentHash(source.content).then((currentHash) => {
      if (alive) setSourceVersionChanged(!!currentHash && currentHash !== target.sourceContentHash);
    });
    return () => { alive = false; };
  }, [source, target.sourceContentHash]);

  useEffect(() => {
    if (!loading && source && target.snippet && markRef.current) {
      markRef.current.scrollIntoView({ block: "center" });
    }
  }, [loading, source, target.snippet, domMatched]);

  useEffect(() => {
    setDomMatched(null);
  }, [target.sourceId, target.snippet, target.sourceStart, target.sourceEnd]);

  // Try to highlight the cited passage inside the rendered markdown. Runs
  // after commit, so the markdown DOM is in place.
  useEffect(() => {
    if (loading || !source || !target.snippet || domMatched !== null) return;
    // 新引用带原文偏移，走下方纯文本 <mark> 精确路径；渲染 Markdown 的
    // DOM 文本已丢失原始偏移，继续做“首个相同文本”匹配反而会重新串段。
    if (Number.isInteger(target.sourceStart) && Number.isInteger(target.sourceEnd)) {
      setDomMatched(false);
      return;
    }
    // 历史引用没有偏移：只有摘录在原文中唯一出现时才允许进入 DOM 高亮。
    // 重复文本若继续 hay.indexOf 会永远命中第一处，正是“所有引用显示一样”的旧故障。
    if (!locateCitationPassage(source.content, target.snippet)) {
      setDomMatched(false);
      return;
    }
    const root = bodyRef.current;
    const registry = (CSS as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (
      window as unknown as { Highlight?: new (...r: Range[]) => unknown }
    ).Highlight;
    if (!root || !registry || !HighlightCtor) {
      setDomMatched(false);
      return;
    }
    const range = findRangeByText(root, target.snippet);
    if (!range) {
      setDomMatched(false);
      return;
    }
    refineCitationRange(range); // 收拢到干净句子/段落,避免从句中开头、跨节蔓延
    registry.set("cite-passage", new HighlightCtor(range));
    (range.startContainer.parentElement ?? root).scrollIntoView({ block: "center" });
    setDomMatched(true);
  }, [loading, source, target.snippet, target.sourceStart, target.sourceEnd, domMatched]);

  // Clear the registered highlight when the viewer goes away.
  useEffect(() => {
    return () => {
      (CSS as { highlights?: Map<string, unknown> }).highlights?.delete("cite-passage");
    };
  }, []);

  // A web page / video opened from the source list defaults to embed mode;
  // opened from a citation (has a snippet) it defaults to text so the passage
  // can be highlighted.
  useEffect(() => {
    if (embedUrl && !target.snippet) setMode("web");
    else setMode("text");
  }, [embedUrl, target.snippet]);

  // Before showing the iframe, check whether the page allows embedding so a
  // clean placeholder can replace the browser's "refused to connect" error.
  // Video players (Bilibili) always embed, so they skip the check.
  useEffect(() => {
    if (mode !== "web" || !embedUrl) return;
    if (isVideo) {
      setEmbedState("ok");
      return;
    }
    let alive = true;
    setEmbedState("checking");
    fetch(`/api/embed-check?url=${encodeURIComponent(embedUrl)}`)
      .then((r) => r.json())
      .then((d) => alive && setEmbedState(d.embeddable ? "ok" : "blocked"))
      .catch(() => alive && setEmbedState("ok"));
    return () => {
      alive = false;
    };
  }, [mode, embedUrl, isVideo]);

  // Esc closes the viewer only. Capture-phase + stopImmediatePropagation so it
  // intercepts before the “来源” grid's window listener, which would otherwise
  // close the list underneath and leave the viewer floating over the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const passage =
    source && target.snippet
      ? locateCitationPassage(source.content, target.snippet, target.sourceStart, target.sourceEnd)
      : null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          "flex w-full flex-col overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl",
          full ? "h-[94vh] max-w-[96vw]" : "h-[88vh] max-w-4xl"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header — title + inline source pill (left) and actions (right), one
            row so it doesn't eat vertical space */}
        <div className="flex items-center justify-between gap-3 border-b border-edge px-6 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className="truncate text-[18px] font-semibold leading-snug text-ink" title={target.title}>
              {target.title}
            </h2>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-panel2 px-2.5 py-0.5 text-[11px] font-medium text-ink2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
              来源
              {externalUrl && (
                <>
                  <span className="text-edge">·</span>
                  <a
                    href={externalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent transition hover:underline"
                  >
                    查看原文 ↗
                  </a>
                </>
              )}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => {
                if (source?.content) {
                  navigator.clipboard?.writeText(source.content);
                  toast("已复制到剪贴板");
                }
              }}
              className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent"
              title="复制原文"
              aria-label="复制原文"
            >
              <CopyIcon width={18} height={18} />
            </button>
            <button
              onClick={() => setFull((v) => !v)}
              className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-accent"
              title={full ? "还原" : "放大"}
              aria-label={full ? "还原" : "放大"}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {full ? (
                  <>
                    <path d="M4 14h6v6" />
                    <path d="M20 10h-6V4" />
                    <path d="m14 10 7-7" />
                    <path d="m3 21 7-7" />
                  </>
                ) : (
                  <>
                    <path d="M15 3h6v6" />
                    <path d="M9 21H3v-6" />
                    <path d="m21 3-7 7" />
                    <path d="m3 21 7-7" />
                  </>
                )}
              </svg>
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-ink2 transition hover:bg-panel2 hover:text-ink"
              aria-label="关闭"
            >
              <CloseIcon width={19} height={19} />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {sourceVersionChanged && (
            <div className="shrink-0 border-b border-amber-200 bg-amber-50/70 px-6 py-2 text-[12px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
              来源内容已更新；当前页面按新版本重新定位，角标仍保留生成回答时核验过的原文摘录。
            </div>
          )}
          {loading ? (
            <div className="flex items-center gap-2 px-6 py-10 text-sm text-ink2">
              <SpinnerIcon width={16} height={16} /> 正在加载来源…
            </div>
          ) : error ? (
            <p className="px-6 py-10 text-center text-sm text-red-600">{error}</p>
          ) : source && mode === "web" && isEmbeddable ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* 上面是摘要 */}
              {source.summary && (
                <div className="shrink-0 border-b border-edge px-6 py-3">
                  <div className="prose-chat">
                    <p>{source.summary}</p>
                  </div>
                </div>
              )}
              {/* 下面是网页 / 视频播放器 —— 禁止内嵌的站点显示占位图 */}
              {embedState === "checking" ? (
                <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-ink2">
                  <SpinnerIcon width={16} height={16} /> 正在加载预览…
                </div>
              ) : embedState === "blocked" ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
                  {/* mini browser window mockup */}
                  <div className="overflow-hidden rounded-xl border border-edge bg-panel shadow-sm" style={{ width: 280 }}>
                    <div className="flex items-center gap-1.5 border-b border-edge bg-panel2 px-3 py-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#f87171" }} />
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#fbbf24" }} />
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#34d399" }} />
                      <span className="ml-1.5 flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md bg-panel px-2 py-1 text-[11px] text-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`https://www.google.com/s2/favicons?sz=64&domain=${embedHost}`}
                          alt=""
                          className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        />
                        <span className="truncate">{embedHost || "该网站"}</span>
                      </span>
                    </div>
                    <div className="grid place-items-center text-muted" style={{ height: 96 }}>
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <rect x="5" y="11" width="14" height="9" rx="2" />
                        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                      </svg>
                    </div>
                  </div>
                  <p className="text-sm font-medium text-ink">该网站不支持内嵌预览</p>
                  <a
                    href={externalUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110"
                  >
                    在新标签打开 ↗
                  </a>
                </div>
              ) : (
                <iframe
                  key={embedUrl}
                  src={embedUrl ?? undefined}
                  title={target.title}
                  className={cn("min-h-0 w-full flex-1 border-0", isVideo ? "bg-black" : "bg-white")}
                  sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
                  allowFullScreen
                  referrerPolicy="no-referrer"
                />
              )}
              {isVideo && embedState === "ok" && (
                <p className="flex shrink-0 items-center justify-center gap-1.5 border-t border-edge bg-panel px-6 py-2 text-[11px] text-muted">
                  若无法播放,可
                  <a
                    href={externalUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-accent transition hover:underline"
                  >
                    在新标签打开 ↗
                  </a>
                </p>
              )}
            </div>
          ) : source ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-4">
              {/* 引用定位失败提示(#11 修:双匹配都失败此前静默,用户不知道是没高亮功能还是段落找不到)。
                  有 snippet 但既没在原文匹配到、渲染 DOM 也没匹配到 → 顶部诚实提示 + 显示原引用摘录。 */}
              {target.snippet && !passage && domMatched === false && (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/60 px-3.5 py-2.5 text-[13px] leading-snug text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                  <div className="mb-1 font-medium">未能在原文中精确定位该引用</div>
                  <div className="text-amber-800 dark:text-amber-300">引用摘录:「{target.snippet.slice(0, 200)}{target.snippet.length > 200 ? "…" : ""}」<span className="ml-1 opacity-70">— 可在下方原文里 Ctrl+F / ⌘F 搜索</span></div>
                </div>
              )}
              {/* summary (no tags) — the title already lives in the header */}
              {source.summary && (
                <>
                  <div className="prose-chat">
                    <p>{source.summary}</p>
                  </div>
                  <div className="my-5 border-t border-edge" />
                </>
              )}
              {/* full text — read-only rendered (not raw markdown), leading
                  duplicate-title heading stripped */}
              {passage && domMatched === false ? (
                // Fallback (no Highlight API / passage not found in rendered
                // DOM): plain text with a hard <mark> — always hits.
                <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.9] text-ink">
                  {passage.before}
                  <mark ref={markRef} className="rounded bg-accent/30 px-0.5 text-ink">
                    {passage.match}
                  </mark>
                  {passage.after}
                </p>
              ) : (
                <div ref={bodyRef} className="prose-chat">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {stripLeadingHeading(source.content, target.title)}
                  </ReactMarkdown>
                </div>
              )}
              {/* 「相关的」被动重新发现区(你的/其它笔记本里相关的)按用户要求整体去掉。 */}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// add source modal
// ---------------------------------------------------------------------------

type AddPayload =
  | { kind: "file"; file: File }
  | { kind: "url"; url: string }
  // keban:勾选「同时生成课代表包」→ 来源就绪后自动三连生成(学习指南/思维导图/测验)。
  | { kind: "bilibili"; url: string; keban?: boolean }
  | { kind: "text"; text: string; title?: string };

/** D3:批量导入的逐项结论,供结果面板展示。retry=可安全重投的原始载荷(仅「请求失败
 *  未建源」的项才有;入库但解析失败的项走来源行内「重新导入」,面板不重投防重复建源)。 */
type ImportOutcome = {
  name: string;
  outcome: "ok" | "dup" | "fail";
  reason?: string;
  retry?: AddPayload;
  retrying?: boolean; // 面板「重试」in-flight 态
  // 重试成功后不把该行从列表里抹掉,而是留一条绿色「已导入」痕迹沉到底部 —— 之前直接过滤
  // 掉成功项,用户点完重试只看到行凭空消失,反而以为没生效。
  retried?: boolean;
  tries?: number; // 已重试次数,失败时显示「已重试 N 次」
};

// 批量上传的前端限额:数量上限防一把拖入整个文件夹;单文件大小按档,从 /api/usage 拿 maxFileBytes
// 与服务端 sources/route.ts 的 MAX_FILE_BYTES 同源(getPlan().maxFileBytes),超限先跳过少跑一趟。
const MAX_UPLOAD_FILES = 10;

/** Obsidian 品牌图标(多切面宝石/黑曜石线稿)—— currentColor 描边,由外层控制紫色。
 *  不引第三方 logo 资源,自绘一个可辨识的宝石传达「这是 Obsidian 专属入口」。 */
function ObsidianGlyph({ width = 20, height = 20 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden>
      <path d="M6 3.2h12l3.4 6L12 21 2.6 9.2 6 3.2Z" />
      <path d="M2.6 9.2h18.8" />
      <path d="M12 21 8 9.2l4-6" />
      <path d="M12 21l4-11.8-4-6" />
    </svg>
  );
}

/** 小对勾(Obsidian 导入面板的规则列表)。 */
function CheckMiniIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-[#6d5dd3]" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function AddSourceModal({
  onClose,
  onSubmit,
  onSubmitBatch,
  onQuickResearch,
  maxFileBytes,
}: {
  onClose: () => void;
  // 返回逐项结论(D3);弹窗内单项提交只 fire-and-forget,不消费返回值。
  onSubmit: (p: AddPayload) => Promise<ImportOutcome>;
  // D3:多文件(≥2)交给父级统一提交,完成后弹批量结果面板;单项仍走 onSubmit。
  onSubmitBatch: (payloads: AddPayload[]) => void;
  onQuickResearch: (query: string, mode: "fast" | "deep") => void;
  // 护城河 1:当前用户档单文件上限(bytes)。父级从 /api/usage 读并透传。
  maxFileBytes: number;
}) {
  const maxFileMb = Math.round(maxFileBytes / (1024 * 1024));
  // NotebookLM 式:主视图 = 快速研究搜索条 + 拖放区 + 四个来源按钮;点网页/Bilibili/文本
  // 进入聚焦子视图(带「← 返回」);上传直接走文件选择器 / 拖放。
  const [view, setView] = useState<"home" | "url" | "bilibili" | "text" | "obsidian">("home");
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"fast" | "deep">("fast"); // 搜索档:快速 / 深度
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useRef<HTMLDivElement>(null); // 档位下拉容器,点击外部时关闭
  const [url, setUrl] = useState("");
  const [yt, setYt] = useState("");
  const [keban, setKeban] = useState(false); // B站视图:同时生成课代表包(默认不勾)
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [dragging, setDragging] = useState(false);
  // 走查发现:此弹窗无 Esc 关闭(与其它 Modal 一致性缺口)。豁免输入控件。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const fileRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false); // 一次性提交锁:防连点/回车重复 onClose+onSubmit
  // 蒙层守卫:mousedown+mouseup 都落在蒙层才关(与 Studio 的 Modal 同款),
  // 防止从弹窗内拖选文本、松手落在蒙层时误关。
  const downOnBackdrop = useRef(false);

  // 乐观关闭:选定/提交后立即关窗,来源以「处理中」进入左栏,后台解析。
  // 多文件批量上传:服务端仍是单文件接口,前端遍历逐个提交;全部入队后再关窗。
  const addFiles = (list: FileList | File[] | null | undefined) => {
    if (!list || submittedRef.current) return;
    let files = Array.from(list);
    if (files.length === 0) return;
    if (files.length > MAX_UPLOAD_FILES) {
      toast(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件,已跳过多余的 ${files.length - MAX_UPLOAD_FILES} 个`, "error");
      files = files.slice(0, MAX_UPLOAD_FILES);
    }
    // 拖放白名单预检(审查 #1):file picker 的 accept 只约束点击选择,拖放完全绕过 →
    // 用户直接把 .doc/.mp4/.rtf 拖进来会以「假成功」入库垃圾。同款白名单在服务端二拒。
    const OK_EXT = /\.(pdf|docx|pptx|epub|txt|md|markdown|csv|tsv|json|yaml|yml|xml|html?|zip|png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|mp3|m4a|wav|ogg|oga|flac|aac|webm)$/i;
    const bad = files.filter((f) => !OK_EXT.test(f.name) && !f.type.startsWith("text/") && !f.type.startsWith("image/") && !f.type.startsWith("audio/") && f.type !== "application/pdf" && f.type !== "application/zip");
    if (bad.length) {
      const first = bad[0].name;
      const hint = /\.doc$/i.test(first) ? "请另存为 .docx" : /\.ppt$/i.test(first) ? "请另存为 .pptx" : /\.(mp4|mov|mkv|avi)$/i.test(first) ? "视频尚不支持,请分享 B 站 / YouTube 链接" : "支持 PDF / Word(docx)/ PPT(pptx)/ 音频 / 图片 / txt / md";
      toast(`已跳过 ${bad.length} 个不支持的文件(${first}):${hint}`, "error");
      files = files.filter((f) => !bad.includes(f));
      if (files.length === 0) return;
    }
    // PPTX 无论套餐统一硬限 25MB（解析时会整体展开，超限容易放大内存）。
    const pptOversize = files.filter(
      (f) => isPptxFileName(f.name) && f.size > PPTX_MAX_FILE_BYTES
    );
    if (pptOversize.length > 0) {
      toast(`${pptOversize.length} 个 PPTX 超过 25MB，已跳过；请压缩图片或拆分后重传`, "error");
      files = files.filter((f) => !pptOversize.includes(f));
    }
    const oversize = files.filter((f) => f.size > uploadLimitForFile(f.name, maxFileBytes));
    if (oversize.length > 0) {
      toast(`${oversize.length} 个文件超过单文件 ${maxFileMb}MB 上限,已跳过`, "error");
      files = files.filter((f) => f.size <= maxFileBytes);
    }
    if (files.length === 0) return;
    submittedRef.current = true;
    // 每个文件独立占位;批量(≥2)由父级静默提交并在全部落定后弹结果面板,单文件维持 toast。
    if (files.length >= 2) onSubmitBatch(files.map((f) => ({ kind: "file" as const, file: f })));
    else void onSubmit({ kind: "file", file: files[0] });
    onClose();
  };
  const runSearch = () => {
    const query = q.trim();
    if (!query || submittedRef.current) return;
    submittedRef.current = true;
    onClose();
    onQuickResearch(query, mode); // 交给左栏「快速研究」:展开 + 预填 + 按档位联网检索
  };
  // Obsidian 库导入:只收 .zip(vault 整包);复用 addFiles(白名单已含 zip,服务端按
  // multipart .zip 分支走 parseVaultZip 清洗+批量建源)。非 zip 给专属中文提示。
  const zipRef = useRef<HTMLInputElement>(null);
  const addObsidianZip = (list: FileList | File[] | null | undefined) => {
    const f = Array.from(list || [])[0];
    if (!f) return;
    if (!/\.zip$/i.test(f.name) && f.type !== "application/zip") {
      toast("请上传 Obsidian 库导出的 .zip 压缩包", "error");
      return;
    }
    addFiles([f]);
  };

  // 点击档位下拉之外 → 自动收起菜单
  useEffect(() => {
    if (!modeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) setModeOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modeOpen]);

  const btnCls =
    "flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-edge py-2.5 text-[13px] font-medium text-ink2 transition hover:border-accent/50 hover:text-accent";
  const backBtn = (
    <button onClick={() => setView("home")} aria-label="返回" className="rounded-md p-1.5 text-ink2 transition hover:bg-panel2 hover:text-ink">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M15 6l-6 6 6 6" />
      </svg>
    </button>
  );
  const closeBtn = (
    <button onClick={onClose} aria-label="关闭" className="rounded-md p-1.5 text-ink2 transition hover:bg-panel2 hover:text-ink">
      <CloseIcon width={18} height={18} />
    </button>
  );

  let body: React.ReactNode;
  if (view === "home") {
    body = (
      <>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">添加来源</h2>
          {closeBtn}
        </div>

        {/* 快速研究搜索条 —— 联网找新来源(流光旋转边框 + 呼吸,见 globals.css .flow-border) */}
        <div className="flow-border">
          <div className="rounded-[14.5px] bg-panel px-4 py-3.5">
            <input
              name="search"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && runSearch()}
              placeholder="在网络中搜索新来源…"
              className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
            />
            <div className="mt-3.5 flex items-center gap-2">
              {/* 搜索档位 skill 选择:快速 / 深度(去掉了 Web chip,只留一个搜索图标) */}
              <div ref={modeRef} className="relative">
                <button
                  onClick={() => setModeOpen((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-panel px-3 py-1.5 text-[12px] font-medium text-ink2 transition hover:border-accent/50"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden>
                    <path d="M4 7h9M17 7h3" />
                    <circle cx="15" cy="7" r="2" />
                    <path d="M4 17h3M11 17h9" />
                    <circle cx="9" cy="17" r="2" />
                  </svg>
                  {mode === "deep" ? "深度搜索" : "快速搜索"}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="text-muted" aria-hidden>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {modeOpen && (
                  <div className="absolute left-0 top-[calc(100%+6px)] z-10 w-60 overflow-hidden rounded-xl border border-edge bg-panel p-1 shadow-xl">
                    {([
                      { k: "fast", t: "快速搜索", d: "非常适合快速获得结果" },
                      { k: "deep", t: "深度搜索", d: "多轮检索+阅读,给出报告和精选来源" },
                    ] as const).map((o) => (
                      <button
                        key={o.k}
                        onClick={() => { setMode(o.k); setModeOpen(false); }}
                        className={cn(
                          "flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition hover:bg-panel2",
                          mode === o.k && "bg-accentSoft/50"
                        )}
                      >
                        <span className={cn("text-[13px] font-medium", mode === o.k ? "text-accent" : "text-ink")}>{o.t}</span>
                        <span className="text-[11px] text-muted">{o.d}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={runSearch} aria-label="搜索来源" className="ml-auto grid h-9 w-9 place-items-center rounded-full bg-accent text-onAccent transition hover:brightness-110">
                <SearchIcon width={16} height={16} />
              </button>
            </div>
          </div>
        </div>

        {/* 或拖放文件 */}
        <div className="my-3 flex items-center gap-2.5 text-[12px] text-muted">
          <span className="h-px flex-1 bg-edge" />或拖放文件<span className="h-px flex-1 bg-edge" />
        </div>

        <div
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
          className={cn(
            "cursor-pointer rounded-xl border border-dashed py-11 text-center transition",
            dragging ? "border-accent bg-accentSoft/40" : "border-edge hover:border-accent"
          )}
        >
          <UploadIcon className="mx-auto text-ink2" width={26} height={26} />
          <p className="mt-2.5 text-xs text-muted">PDF · Word · PPT · 图片 · 音频 · txt · md · csv · epub · Obsidian 库(.zip)</p>
        </div>

        <div className="mt-3 flex gap-2">
          <button onClick={() => fileRef.current?.click()} className={btnCls}><UploadIcon width={15} height={15} />上传文件</button>
          <button onClick={() => setView("url")} className={btnCls}><LinkIcon width={15} height={15} />网页</button>
          <button onClick={() => setView("bilibili")} className={btnCls}><BilibiliIcon width={15} height={15} />Bilibili</button>
          <button onClick={() => setView("text")} className={btnCls}><TextIcon width={15} height={15} />粘贴文本</button>
          <button onClick={() => setView("obsidian")} className={btnCls}><ObsidianGlyph width={15} height={15} />Obsidian</button>
        </div>

        <input
          name="source-file"
          ref={fileRef}
          type="file"
          multiple
          accept=".pdf,.txt,.md,.markdown,.csv,.docx,.pptx,.epub,.zip,text/plain,application/pdf,application/zip,audio/*,image/*,.mp3,.m4a,.wav,.ogg,.flac,.aac,.png,.jpg,.jpeg,.gif,.webp"
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <input
          name="obsidian-zip"
          ref={zipRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => addObsidianZip(e.target.files)}
        />
      </>
    );
  } else if (view === "url") {
    // 收藏夹倒库场景:一次粘贴多个链接(空格/换行分隔)按批量导入,结果面板逐条给结论;
    // 单条维持原路。拆分后仍校验 http(s) 形状,避免把说明文字混进 URL 建出畸形来源。
    const go = () => {
      if (!url.trim() || submittedRef.current) return;
      const urls = url.trim().split(/\s+/).filter((u) => /^https?:\/\/\S+$/i.test(u));
      if (urls.length === 0) { toast("请输入以 http(s):// 开头的网页链接", "error"); return; }
      submittedRef.current = true;
      onClose();
      if (urls.length >= 2) onSubmitBatch(urls.map((u) => ({ kind: "url" as const, url: u })));
      else void onSubmit({ kind: "url", url: urls[0] });
    };
    body = (
      <>
        <div className="mb-3 flex items-center gap-2">{backBtn}<h2 className="text-base font-semibold text-ink">添加网页</h2><span className="ml-auto">{closeBtn}</span></div>
        <textarea
          name="url"
          autoComplete="off"
          rows={3}
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), go())}
          placeholder="https://example.com/article"
          className="w-full resize-none rounded-xl border border-edge bg-panel2 px-3.5 py-3 text-sm text-ink outline-none focus:border-accent"
        />
        <p className="mt-2 px-1 text-xs text-muted">粘贴网页链接,自动抓取正文作为来源;可一次粘贴多个链接(换行或空格分隔),批量导入。支持微信公众号文章。</p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => setView("home")} className="rounded-lg px-4 py-2 text-sm text-ink2 transition hover:bg-panel2">取消</button>
          <button onClick={go} disabled={!url.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">添加</button>
        </div>
      </>
    );
  } else if (view === "bilibili") {
    const go = () => { if (yt.trim() && !submittedRef.current) { submittedRef.current = true; onClose(); void onSubmit({ kind: "bilibili", url: yt.trim(), keban }); } };
    body = (
      <>
        <div className="mb-3 flex items-center gap-2">{backBtn}<h2 className="text-base font-semibold text-ink">添加 Bilibili 视频</h2><span className="ml-auto">{closeBtn}</span></div>
        <input
          name="url"
          autoComplete="off"
          type="url"
          autoFocus
          value={yt}
          onChange={(e) => setYt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && go()}
          placeholder="https://www.bilibili.com/video/BV… 或 BV 号"
          className="w-full rounded-xl border border-edge bg-panel2 px-3.5 py-3 text-sm text-ink outline-none focus:border-accent"
        />
        <p className="mt-2 px-1 text-xs text-muted">有字幕则导入字幕,否则导入标题+简介。字幕通常需登录(可在 .env 配 BILIBILI_SESSDATA)。</p>
        {/* 课代表包:勾选即积分确认态 —— 来源就绪后自动三连生成(价目随 lib/credits.ts 联动) */}
        <label className="mt-3 flex cursor-pointer items-center gap-2 px-1 text-xs text-ink2">
          <Checkbox checked={keban} onChange={setKeban} />
          <span>同时生成课代表包(学习指南 + 思维导图 + 测验,约 {KEBAN_PACK_COST} 积分)</span>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => setView("home")} className="rounded-lg px-4 py-2 text-sm text-ink2 transition hover:bg-panel2">取消</button>
          <button onClick={go} disabled={!yt.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">添加</button>
        </div>
      </>
    );
  } else if (view === "obsidian") {
    body = (
      <>
        <div className="mb-3 flex items-center gap-2">
          {backBtn}
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#7c6ce0]/15 text-[#6d5dd3]"><ObsidianGlyph width={16} height={16} /></span>
          <h2 className="text-base font-semibold text-ink">从 Obsidian 库导入</h2>
          <span className="ml-auto">{closeBtn}</span>
        </div>
        {/* 大拖放/选择区:接受 vault zip;点击/拖放都走 addObsidianZip(校验 .zip)。 */}
        <div
          onClick={() => zipRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addObsidianZip(e.dataTransfer.files); }}
          className={cn(
            "cursor-pointer rounded-xl border border-dashed py-10 text-center transition",
            dragging ? "border-[#7c6ce0] bg-[#7c6ce0]/10" : "border-edge hover:border-[#7c6ce0]"
          )}
        >
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-[#7c6ce0]/12 text-[#6d5dd3]"><ObsidianGlyph width={26} height={26} /></span>
          <p className="mt-3 text-sm font-medium text-ink">选择或拖入 Obsidian 库压缩包(.zip)</p>
          <p className="mt-1 text-xs text-muted">在 Obsidian 里把 vault 文件夹压缩成 zip 即可</p>
        </div>
        {/* 处理规则透明化:让用户知道导入后会发生什么(清洗/合并策略),建立信任。 */}
        <ul className="mt-4 space-y-1.5 text-xs text-ink2">
          <li className="flex gap-2"><CheckMiniIcon /> 自动清洗 frontmatter、<code className="rounded bg-panel2 px-1">[[双链]]</code>、<code className="rounded bg-panel2 px-1">![[嵌入]]</code>,跳过 .obsidian / 模板目录</li>
          <li className="flex gap-2"><CheckMiniIcon /> 20 篇以内每篇笔记独立成一条来源;更多则按顶层文件夹合并</li>
          <li className="flex gap-2"><CheckMiniIcon /> 反向导出:在笔记本「分享」里可将整本导出为 Obsidian Markdown</li>
        </ul>
      </>
    );
  } else {
    const go = () => { if (text.trim() && !submittedRef.current) { submittedRef.current = true; onClose(); void onSubmit({ kind: "text", text, title: title.trim() || undefined }); } };
    body = (
      <>
        <div className="mb-3 flex items-center gap-2">{backBtn}<h2 className="text-base font-semibold text-ink">粘贴文本</h2><span className="ml-auto">{closeBtn}</span></div>
        <input
          name="title"
          autoComplete="off"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题(可选)"
          className="mb-2 w-full rounded-xl border border-edge bg-panel2 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent"
        />
        <textarea
          name="text"
          autoComplete="off"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="在下方粘贴或输入文本…"
          rows={7}
          className="w-full resize-none rounded-xl border border-edge bg-panel2 px-3.5 py-3 text-sm text-ink outline-none focus:border-accent"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={() => setView("home")} className="rounded-lg px-4 py-2 text-sm text-ink2 transition hover:bg-panel2">取消</button>
          <button onClick={go} disabled={!text.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">插入</button>
        </div>
      </>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (!(downOnBackdrop.current && e.target === e.currentTarget)) return;
        // 「粘贴文本」视图里已有未提交内容 → 点蒙层直接忽略,防误关丢稿。
        if (view === "text" && text.trim()) return;
        onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-2xl border border-edge bg-panel p-6 shadow-2xl">
        {body}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// batch import report(D3:批量导入结果面板)
// ---------------------------------------------------------------------------

/** 批量导入(≥2 项)全部落定后的轻量结果卡:汇总成功/跳过/失败计数,非成功项逐行
 *  「名字 — 原因」;失败且未建源的项带「重试」(重新走单项提交,结果原位刷新)。 */
/** 汇总数字的滚动过渡:数值变化时逐帧逼近,不瞬间跳数。
 *  铁律 21:用 setInterval 而非 rAF —— 后台/预览标签页会节流 rAF,数字会卡在中途。 */
function RollingNumber({ value, className }: { value: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    const steps = Math.min(12, Math.max(4, Math.abs(value - from) * 4));
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      const next = i >= steps ? value : Math.round(from + (value - from) * (i / steps));
      shownRef.current = next;
      setShown(next);
      if (i >= steps) window.clearInterval(id);
    }, 40);
    return () => window.clearInterval(id);
  }, [value]);
  return <span className={className}>{shown}</span>;
}

/** 重试进行中的环形进度。同样用 setInterval 驱动(铁律 21),卸载即停。 */
function RetryRing() {
  const C = 50.27; // 2πr, r=8
  const [off, setOff] = useState(C);
  useEffect(() => {
    let t = 0;
    const id = window.setInterval(() => {
      t = (t + 1) % 30;
      setOff(C * (1 - t / 30));
    }, 40);
    return () => window.clearInterval(id);
  }, []);
  return (
    <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden>
      <circle cx="11" cy="11" r="8" fill="none" stroke="rgb(var(--c-edge))" strokeWidth="2.4" />
      <circle
        cx="11" cy="11" r="8" fill="none" stroke="rgb(var(--c-accent))" strokeWidth="2.4" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={off}
        style={{ transform: "rotate(-90deg)", transformOrigin: "11px 11px" }}
      />
    </svg>
  );
}

/**
 * 批量导入结果面板(方案 R2:进度环 + 就地留痕)。
 *
 * 两个曾经的缺陷:
 *  1. 重试成功的行被 outcome==="ok" 直接过滤掉 —— 用户点完只看到行凭空消失,以为没生效。
 *     现在成功行留在列表里变成绿色「已导入」痕迹并沉到底部,处理过什么一目了然。
 *  2. 重试时按钮文案在「重试 / 重试中…」之间变宽变窄、行被抽走导致列表高度突变,整个面板在跳。
 *     现在右侧是固定 76px 的槽位,四种状态(可重试 / 进行中 / 已导入 / 失败)在同一格里叠放交叉淡入,
 *     行高与槽宽全程恒定;列表重排走 FLIP,位移是平滑过渡而不是瞬移。
 */
function ImportReportModal({
  items,
  onRetry,
  onClose,
}: {
  items: ImportOutcome[];
  onRetry: (item: ImportOutcome, idx: number) => void;
  onClose: () => void;
}) {
  const ok = items.filter((i) => i.outcome === "ok").length;
  const dup = items.filter((i) => i.outcome === "dup").length;
  const fail = items.length - ok - dup;
  // 蒙层守卫:mousedown+mouseup 都落在蒙层才关(与其它弹窗同款),防拖选原因文本误关。
  const downOnBackdrop = useRef(false);

  // 列出「待处理」(跳过/失败)与「已重试成功」的留痕行;批量里本来就成功的项不单独列。
  const listed = items
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => it.outcome !== "ok" || it.retried);
  const pending = listed.filter(({ it }) => !(it.outcome === "ok" && it.retried));
  const done = listed.filter(({ it }) => it.outcome === "ok" && it.retried);
  const ordered = [...pending, ...done];

  // FLIP:重排前记住每行位置,重排后先用 transform 抵消位移再过渡到 0,得到平滑移动。
  const rowRefs = useRef(new Map<number, HTMLLIElement>());
  const prevTops = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    rowRefs.current.forEach((el, key) => {
      // 用 offsetTop 而非 getBoundingClientRect():后者含正在跑的 transform,
      // 两行同时移动时会互相污染读数,算出的位移是错的。
      const top = el.offsetTop;
      const prev = prevTops.current.get(key);
      if (prev !== undefined && Math.abs(prev - top) > 1) {
        el.style.transition = "none";
        el.style.transform = `translateY(${prev - top}px)`;
        // 强制同步重排,让上面的初始位移真正落地,再切回 0 才会走过渡。
        // 刻意不用 requestAnimationFrame:铁律 21 —— 标签页被节流时 rAF 回调不执行,
        // 行会永久停在偏移位置上,比不做动画还糟。
        void el.offsetHeight;
        el.style.transition = "transform .34s cubic-bezier(.2,.8,.3,1)";
        el.style.transform = "";
        // 位移结束后必须把内联 transition 清掉,否则它会一直压住行自己的
        // transition-colors,成功行的绿底就再也过渡不出来了。
        const clear = () => {
          el.style.transition = "";
          el.removeEventListener("transitionend", clear);
        };
        el.addEventListener("transitionend", clear);
      }
      prevTops.current.set(key, top);
    });
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-edge bg-panel p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">批量导入结果</h2>
          <button onClick={onClose} aria-label="关闭" className="rounded-md p-1.5 text-ink2 transition hover:bg-panel2 hover:text-ink">
            <CloseIcon width={18} height={18} />
          </button>
        </div>
        <p className="text-[13px] text-ink2">
          成功 <RollingNumber value={ok} className="font-semibold text-ink" /> 项
          {dup > 0 && (
            <> · 跳过 <span className="font-semibold text-ink">{dup}</span> 项(已存在)</>
          )}
          {fail > 0 && (
            <> · 失败 <RollingNumber value={fail} className="font-semibold text-red-500" /> 项</>
          )}
        </p>
        {ordered.length > 0 && (
          <ul className="mt-3 max-h-64 space-y-1.5 overflow-y-auto" aria-live="polite">
            {ordered.map(({ it, idx }) => {
              const isDone = it.outcome === "ok" && it.retried;
              return (
                <li
                  key={idx}
                  ref={(el) => {
                    if (el) rowRefs.current.set(idx, el);
                    else rowRefs.current.delete(idx);
                  }}
                  className={cn(
                    "flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] transition-colors duration-300",
                    isDone ? "bg-emerald-500/10 ring-1 ring-emerald-500/25" : "bg-panel2"
                  )}
                >
                  {/* 状态点:绿=重试已成功、琥珀=跳过(已存在)、红=失败;裸色点在深浅两模式都可辨 */}
                  <span
                    className={cn(
                      "mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300",
                      isDone ? "bg-emerald-500" : it.outcome === "dup" ? "bg-amber-500" : "bg-red-500"
                    )}
                  />
                  <span className="min-w-0 flex-1 break-words leading-relaxed text-ink2">
                    <span className="font-medium text-ink">{it.name}</span>
                    {" — "}
                    {isDone ? (
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">已成功导入</span>
                    ) : it.retrying ? (
                      "正在重试,请稍候…"
                    ) : (
                      <>
                        {(it.tries ?? 0) > 0 && <>已重试 {it.tries} 次 · </>}
                        {it.reason || (it.outcome === "dup" ? "与已有来源重复,已跳过" : "导入失败")}
                      </>
                    )}
                  </span>
                  {/* 固定宽度槽位:四种状态叠在同一格交叉淡入,槽宽与行高全程恒定 —— 这是「不跳」的关键 */}
                  {(it.outcome === "fail" || isDone) && (
                    <span className="grid h-[22px] w-[76px] shrink-0 place-items-end">
                      <span
                        aria-hidden={!isDone}
                        className={cn(
                          "col-start-1 row-start-1 flex items-center gap-1.5 transition-opacity duration-200",
                          isDone ? "opacity-100" : "pointer-events-none opacity-0"
                        )}
                      >
                        <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-emerald-500">
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
                            <path d="M3.4 8.5l3 3 6.2-7" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <span className="text-[11.5px] font-semibold text-emerald-600 dark:text-emerald-400">已导入</span>
                      </span>
                      <span
                        aria-hidden={!(it.retrying && !isDone)}
                        className={cn(
                          "col-start-1 row-start-1 transition-opacity duration-200",
                          it.retrying && !isDone ? "opacity-100" : "pointer-events-none opacity-0"
                        )}
                      >
                        <RetryRing />
                      </span>
                      {it.retry && (
                        <button
                          onClick={() => onRetry(it, idx)}
                          disabled={it.retrying || isDone}
                          tabIndex={it.retrying || isDone ? -1 : undefined}
                          aria-hidden={it.retrying || isDone}
                          aria-label={`重试导入 ${it.name}`}
                          className={cn(
                            "col-start-1 row-start-1 rounded-md border border-edge px-2 py-0.5 text-[12px] font-medium text-accent transition-opacity duration-200 hover:border-accent/50",
                            !it.retrying && !isDone ? "opacity-100" : "pointer-events-none opacity-0"
                          )}
                        >
                          重试
                        </button>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110">
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// notebook settings (configure chat + output language)
// ---------------------------------------------------------------------------

const OUTPUT_LANGUAGES = [
  "简体中文",
  "English",
  "繁體中文",
  "日本語",
  "한국어",
  "Español",
  "Français",
  "Deutsch",
  "Русский",
];

function NotebookSettingsModal({
  notebook,
  onClose,
  onSave,
}: {
  notebook: Notebook;
  onClose: () => void;
  onSave: (s: {
    chat_style: string;
    chat_instructions: string;
    response_length: string;
    output_language: string;
  }) => void;
}) {
  const [style, setStyle] = useState(notebook.chat_style || "default");
  const [instructions, setInstructions] = useState(notebook.chat_instructions || "");
  const [length, setLength] = useState(notebook.response_length || "default");
  const [language, setLanguage] = useState(notebook.output_language || "");
  // 蒙层守卫:mousedown+mouseup 都落在蒙层才关(防拖选指令文本划出弹窗误关)。
  const downOnBackdrop = useRef(false);

  const seg = (active: boolean) =>
    cn(
      "flex-1 rounded-lg border px-3 py-2 text-sm transition",
      active
        ? "border-accent bg-accentSoft text-accent"
        : "border-edge text-ink2 hover:border-accent/50 hover:text-ink"
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl rounded-2xl border border-edge bg-panel p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">配置对话</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-ink2 transition hover:bg-panel2 hover:text-ink"
            aria-label="关闭"
          >
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        <p className="mb-1.5 text-xs font-medium text-ink2">回答风格</p>
        <div className="mb-4 flex gap-1.5">
          {[
            { k: "default", label: "默认" },
            { k: "learning", label: "学习指南" },
            { k: "custom", label: "自定义" },
          ].map((o) => (
            <button key={o.k} onClick={() => setStyle(o.k)} className={seg(style === o.k)}>
              {o.label}
            </button>
          ))}
        </div>

        <p className="mb-1.5 text-xs font-medium text-ink2">自定义指令(可选)</p>
        <textarea
          name="instruction"
          autoComplete="off"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={3}
          placeholder="例如:以资深行业分析师的口吻回答,多引用具体数据。"
          className="mb-4 w-full resize-none rounded-lg border border-edge bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <div className="mb-4 flex items-center gap-4">
          <p className="flex-1 text-[13px] text-ink">回答长度</p>
          <StyledSelect
            value={length}
            onChange={setLength}
            menuAlign="right"
            options={[
              { value: "default", label: "默认" },
              { value: "longer", label: "更详细" },
              { value: "shorter", label: "更简短" },
            ]}
          />
        </div>

        <p className="mb-1.5 text-xs font-medium text-ink2">输出语言</p>
        <StyledSelect
          value={language}
          onChange={setLanguage}
          triggerClassName="w-full"
          menuAlign="left"
          placeholder="跟随来源 / 提问语言"
          options={[
            { value: "", label: "跟随来源 / 提问语言" },
            ...OUTPUT_LANGUAGES.map((l) => ({ value: l, label: l })),
          ]}
        />
        <p className="mb-4 mt-1 text-[11px] text-muted">
          影响对话、报告、概览、音频/视频等所有生成内容的语言。
        </p>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-ink2 transition hover:bg-panel2"
          >
            取消
          </button>
          <button
            onClick={() => {
              onSave({
                chat_style: style,
                chat_instructions: instructions,
                response_length: length,
                output_language: language,
              });
              onClose();
            }}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// share (public read-only link)
// ---------------------------------------------------------------------------

const ACCESS_META = {
  restricted: { label: "受限", desc: "只有拥有访问权限的用户可以通过链接打开" },
  link: { label: "知道链接的任何人", desc: "网上知道链接的任何人都可以查看此笔记本" },
  public: { label: "公开", desc: "公开发布,任何人都能在「精选笔记本」中发现并查看" },
} as const;
type AccessLevel = keyof typeof ACCESS_META;

function ShareModal({
  notebook,
  user,
  artifactLabel,
  artifactId,
  onClose,
  onSetPublic,
  onLeft,
}: {
  notebook: Notebook;
  user?: { id?: string; name: string; avatar: string | null };
  /** When the dialog is opened from a specific artifact (e.g. 音频概览), its
   *  label personalises the title / banner / copy-link wording. */
  artifactLabel?: string;
  /** 审查 #15:从查看器打开分享时传入制品 id,复制链接拼上 ?doc=<id> 直达该制品
   *  (对齐 D7 行菜单直达链接语义)。 */
  artifactId?: string;
  onClose: () => void;
  onSetPublic: (isPublic: boolean) => void | Promise<void>;
  /** 协作者自助退出成功后的收尾(关弹窗 + 退出该笔记本)。 */
  onLeft?: () => void;
}) {
  const initialLevel: AccessLevel = !notebook.public
    ? "restricted"
    : notebook.featured
    ? "public"
    : "link";
  const [level, setLevel] = useState<AccessLevel>(initialLevel);
  const [levelMenu, setLevelMenu] = useState(false);
  const [link, setLink] = useState("");
  useEffect(() => {
    const suffix = artifactId ? `?doc=${artifactId}` : "";
    setLink(`${window.location.origin}/share/${notebook.id}${suffix}`);
  }, [notebook.id, artifactId]);
  // 审查 #16(一致性余项):ShareModal 此前无 Esc 关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [collabs, setCollabs] = useState<
    { id: string; name: string; avatar: string | null; role: string; email?: string | null; phone?: string | null }[]
  >([]);
  const [invite, setInvite] = useState("");
  const [inviteFocus, setInviteFocus] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);
  const [roleMenuFor, setRoleMenuFor] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/notebooks/${notebook.id}/collaborators`)
      .then((r) => (r.ok ? r.json() : { collaborators: [] }))
      .then((d) => setCollabs(d.collaborators ?? []))
      .catch(() => {});
  }, [notebook.id]);

  const removeCollab = async (userId: string) => {
    const r = await fetch(`/api/notebooks/${notebook.id}/collaborators`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const d = await r.json().catch(() => ({}));
    // 审查修复:失败不能静默吞掉(此前 UI 显示仍在,用户以为已移除)。
    if (r.ok) setCollabs(d.collaborators ?? []);
    else toast(d?.error || "移除失败,请重试", "error");
  };

  // 协作者自助退出:调 DELETE 的 self 分支(请求者==被删者且非所有者),不必求所有者移除。
  const leaveNotebook = async () => {
    if (!user?.id) return;
    const r = await fetch(`/api/notebooks/${notebook.id}/collaborators`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: user.id }),
    });
    if (r.ok) {
      toast("已退出该笔记本");
      onLeft?.();
    } else {
      const d = await r.json().catch(() => ({}));
      toast(d?.error || "退出失败,请重试", "error");
    }
  };

  const setRole = async (userId: string, role: "viewer" | "editor") => {
    setRoleMenuFor(null);
    const r = await fetch(`/api/notebooks/${notebook.id}/collaborators`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, role }),
    });
    const d = await r.json().catch(() => ({}));
    // 审查修复:失败要复原本地菜单选择并告知用户,不能让本地状态与服务端漂移。
    if (r.ok) setCollabs(d.collaborators ?? []);
    else toast(d?.error || "更新角色失败,请重试", "error");
  };

  // Access level applies immediately on selection (no save button).
  const applyLevel = async (lv: AccessLevel) => {
    const prev = level;
    setLevel(lv);
    setLevelMenu(false);
    try {
      await onSetPublic(lv !== "restricted");
      // 审查修复①:featured 只有管理员能改,普通用户切「公开」时服务端会静默忽略
      // featured 字段却仍返回 200。所以只在选到「公开」时才 PATCH,且真正核对结果。
      if (lv === "public") {
        const r = await fetch(`/api/notebooks/${notebook.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ featured: true }),
        });
        // 审查修复②:非 2xx 时回滚本地选择并真实提示。
        if (!r.ok) {
          setLevel(prev);
          const d = await r.json().catch(() => ({}));
          toast(d?.error || "无权公开发布,已回退", "error");
          return;
        }
      }
      toast("已更新访问权限");
    } catch {
      setLevel(prev);
      toast("更新访问权限失败,请重试", "error");
    }
  };

  const addInvite = async () => {
    if (!inviteValid) return;
    setCErr(null);
    const r = await fetch(`/api/notebooks/${notebook.id}/collaborators`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: invite.trim(), role: "viewer" }),
    });
    const d = await r.json();
    if (!r.ok) {
      setCErr(d.error || "添加失败,请确认对方账号");
      return;
    }
    setCollabs(d.collaborators ?? []);
    setInvite("");
    toast("已添加协作者");
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast("已复制链接");
    } catch {
      toast("复制失败", "error");
    }
  };

  const inviteValid =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invite.trim()) || /^\d{11}$/.test(invite.trim());
  const floated = inviteFocus || invite.length > 0;
  const cur = ACCESS_META[level];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center gap-3 border-b border-edge px-5 py-3.5">
          <ShareIcon width={18} height={18} className="shrink-0 text-ink2" />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-ink">
            分享“{notebook.title}”{artifactLabel ? `和${artifactLabel}` : ""}
          </h2>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-ink2 transition hover:bg-panel2 hover:text-ink"
            aria-label="关闭"
          >
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* info banner */}
          <div className="flex items-start gap-3 rounded-xl bg-panel2 px-4 py-3">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-ink2">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
            <p className="text-sm leading-relaxed text-ink2">
              只有可以查看笔记本的用户才能查看分享的{artifactLabel ?? "内容"}。
            </p>
          </div>

          {/* add users / groups — floating-label field */}
          <div
            className={cn(
              "relative mt-4 rounded-xl border transition",
              cErr ? "border-red-400" : inviteFocus ? "border-accent ring-2 ring-accentSoft" : "border-edge"
            )}
          >
            <label
              className={cn(
                "pointer-events-none absolute left-3.5 bg-panel px-1 transition-all",
                floated ? "-top-2 text-[11px]" : "top-1/2 -translate-y-1/2 text-sm",
                cErr ? "text-red-500" : floated ? "text-accent" : "text-muted"
              )}
            >
              添加用户和群组 *
            </label>
            <input
              name="invite"
              value={invite}
              onChange={(e) => {
                setInvite(e.target.value.slice(0, 120));
                setCErr(null);
              }}
              onFocus={() => setInviteFocus(true)}
              onBlur={() => setInviteFocus(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  addInvite();
                }
              }}
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-transparent px-4 py-3.5 text-sm text-ink outline-none"
            />
          </div>
          {cErr ? (
            <p className="mt-1.5 px-1 text-xs text-red-500">{cErr}</p>
          ) : invite.length > 0 ? (
            <p className="mt-1.5 px-1 text-xs text-muted">
              {inviteValid ? "按回车或点“发送”邀请。" : "输入邮箱地址或 11 位手机号。"}
            </p>
          ) : null}

          {/* users with access */}
          <div className="mt-5">
            <p className="text-sm font-semibold text-ink">拥有访问权限的用户</p>
          </div>
          {/* owner row */}
          <div className="mt-3 flex items-center gap-3">
            <Avatar name={user?.name || "我"} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{user?.name || "我"}</p>
              <p className="truncate text-xs text-muted">你</p>
            </div>
            <span className="shrink-0 text-sm text-muted">所有者</span>
          </div>
          {/* collaborators */}
          {collabs.map((c) => (
            <div key={c.id} className="mt-3 flex items-center gap-3">
              <Avatar name={c.name} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{c.name}</p>
                {(c.email || c.phone) && (
                  <p className="truncate text-xs text-muted">{c.email || c.phone}</p>
                )}
              </div>
              {user?.id === c.id ? (
                // 我自己(非所有者,所有者不在协作表里)的行:自助退出,不再等所有者移除。
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm text-muted">{c.role === "editor" ? "编辑者" : "查看者"}</span>
                  <button
                    onClick={leaveNotebook}
                    className="rounded-full border border-edge px-3.5 py-1 text-sm text-red-500 transition hover:border-red-500/40 hover:bg-red-500/10"
                  >
                    退出
                  </button>
                </div>
              ) : (
              <div className="relative shrink-0">
                <button
                  onClick={() => setRoleMenuFor((v) => (v === c.id ? null : c.id))}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-ink2 transition hover:bg-panel2"
                >
                  {c.role === "editor" ? "编辑者" : "查看者"}
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
                {roleMenuFor === c.id && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setRoleMenuFor(null)} />
                    <div className={`absolute right-0 top-full z-40 mt-1 w-44 overflow-hidden ${MENU_PANEL}`}>
                      {(["viewer", "editor"] as const).map((rl) => (
                        <button
                          key={rl}
                          onClick={() => setRole(c.id, rl)}
                          className={cn(
                            "flex w-full items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-left text-sm transition",
                            c.role === rl ? MENU_SELECTED : "text-ink hover:bg-panel2"
                          )}
                        >
                          {rl === "editor" ? "编辑者" : "查看者"}
                          {c.role === rl && (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                              <path d="m5 12 5 5L20 7" />
                            </svg>
                          )}
                        </button>
                      ))}
                      <div className="my-1 h-px bg-edge" />
                      <button
                        onClick={() => {
                          setRoleMenuFor(null);
                          removeCollab(c.id);
                        }}
                        className={MENU_ITEM_DANGER}
                      >
                        <TrashIcon width={14} height={14} /> 移除访问权限
                      </button>
                    </div>
                  </>
                )}
              </div>
              )}
            </div>
          ))}

          {/* notebook access level */}
          <div className="mt-6">
            <p className="text-sm font-semibold text-ink">笔记本访问权限</p>
            <div className="mt-3 flex items-start gap-3">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-panel2 text-ink2">
                {level === "restricted" ? (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="11" width="14" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                ) : level === "link" ? (
                  <LinkIcon width={17} height={17} />
                ) : (
                  <GlobeIcon width={17} height={17} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="relative inline-block">
                  <button
                    onClick={() => setLevelMenu((v) => !v)}
                    className="flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-sm font-medium text-ink transition hover:bg-panel2"
                  >
                    {cur.label}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="text-ink2">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  {levelMenu && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setLevelMenu(false)} />
                      <div className={`absolute bottom-full left-0 z-40 mb-1.5 w-60 overflow-hidden ${MENU_PANEL}`}>
                        {(Object.keys(ACCESS_META) as AccessLevel[]).map((lv) => (
                          <button
                            key={lv}
                            onClick={() => applyLevel(lv)}
                            className={cn(
                              "flex w-full items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-left text-sm transition",
                              level === lv ? MENU_SELECTED : "text-ink hover:bg-panel2"
                            )}
                          >
                            {ACCESS_META[lv].label}
                            {level === lv && (
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                                <path d="m5 12 5 5L20 7" />
                              </svg>
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{cur.desc}</p>
              </div>
            </div>
          </div>
        </div>

        {/* footer(审查 #21:加 flex-wrap,窄屏三按钮不再横向溢出;artifactLabel 只在 sm+ 显) */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-5 py-3.5">
          {/* 方案4:左侧留一句轻标签(有待发送邀请时让位给「发送」),分享动作靠右成一组。 */}
          {inviteValid ? (
            <button
              onClick={addInvite}
              className="rounded-full bg-accent px-6 py-2 text-sm font-medium text-onAccent shadow-sm transition hover:brightness-105"
            >
              发送
            </button>
          ) : (
            <span className="text-[13px] text-muted">分享这本笔记本</span>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {/* Obsidian 双向互通(出):整本打包 Markdown(笔记+智能笔记+来源清单,带 frontmatter)。
                导出到外部 App 图标(方框+外飞箭头),与导入侧呼应,让「双向互通」被用户看见。 */}
            <button
              onClick={() => window.open(`/api/notebooks/${notebook.id}/export`, "_blank")}
              title="导出整本为 Markdown 压缩包,可直接放进 Obsidian 库"
              className="inline-flex items-center gap-2 rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-[#7c6ce0]/60 hover:bg-[#7c6ce0]/10 hover:text-[#6d5dd3]"
            >
              <span className="text-[#6d5dd3]">
                <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
                  <path d="M14 4h6v6" />
                  <path d="M11 13 20 4" />
                </svg>
              </span>
              导出到 Obsidian
            </button>
            {/* 复制链接:分享的主操作 → 实心主按钮。 */}
            <button
              onClick={copyLink}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-onAccent shadow-sm transition hover:brightness-105"
            >
              <LinkIcon width={15} height={15} /> 复制{artifactLabel ? <span className="hidden sm:inline">指向{artifactLabel}的</span> : ""}链接
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
