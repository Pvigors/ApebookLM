"use client";

import { Component, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ClickableLinkPlugin } from "@lexical/react/LexicalClickableLinkPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { AutoLinkPlugin, createLinkMatcherWithRegExp } from "@lexical/react/LexicalAutoLinkPlugin";
import { DraggableBlockPlugin_EXPERIMENTAL } from "@lexical/react/LexicalDraggableBlockPlugin";
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  HeadingNode,
  QuoteNode,
} from "@lexical/rich-text";
import {
  $isListNode,
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  REMOVE_LIST_COMMAND,
} from "@lexical/list";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  HorizontalRuleNode,
  INSERT_HORIZONTAL_RULE_COMMAND,
} from "@lexical/react/LexicalHorizontalRuleNode";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import {
  INSERT_TABLE_COMMAND,
  TableCellNode,
  TableNode,
  TableRowNode,
} from "@lexical/table";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { $isLinkNode, AutoLinkNode, LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { $createCodeNode, $isCodeNode, CodeHighlightNode, CodeNode } from "@lexical/code";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
  type ElementTransformer,
} from "@lexical/markdown";

/** 分隔线 Markdown 转换器(对齐 playground 的自定义 HR):@lexical/markdown 默认
 *  TRANSFORMERS 不含 HR → 笔记里的 "---"(对话存笔记的引用来源分隔线、制品转笔记的
 *  结尾分隔线)一直渲染成字面文本段。导入/输入 ---|***|___ → 真分隔线,导出回 "---"。 */
const HR_TRANSFORMER: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: (node) => ($isHorizontalRuleNode(node) ? "---" : null),
  regExp: /^(---|\*\*\*|___)\s?$/,
  replace: (parentNode, _children, _match, isImport) => {
    const line = $createHorizontalRuleNode();
    if (isImport || parentNode.getNextSibling() != null) parentNode.replace(line);
    else parentNode.insertBefore(line);
    line.selectNext();
  },
  type: "element",
};
const NOTE_TRANSFORMERS = [HR_TRANSFORMER, ...TRANSFORMERS];
import {
  $setBlocksType,
  $patchStyleText,
  $getSelectionStyleValueForProperty,
} from "@lexical/selection";
import type {
  EditorState,
  EditorThemeClasses,
  ElementFormatType,
  ElementNode,
  LexicalEditor,
  TextFormatType,
} from "lexical";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
} from "lexical";

// ---- custom editor nodes (date, page break, collapsible, columns, media) ----
import { DateNode, $createDateNode } from "@/components/editor-nodes/DateNode";
import {
  PageBreakNode,
  PageBreakPlugin,
  INSERT_PAGE_BREAK_COMMAND,
} from "@/components/editor-nodes/PageBreakNode";
import {
  CollapsibleContainerNode,
  CollapsibleTitleNode,
  CollapsibleContentNode,
  CollapsiblePlugin,
  INSERT_COLLAPSIBLE_COMMAND,
} from "@/components/editor-nodes/CollapsibleNode";
import {
  LayoutContainerNode,
  LayoutItemNode,
  LayoutPlugin,
  INSERT_LAYOUT_COMMAND,
} from "@/components/editor-nodes/LayoutNode";
import {
  YouTubeNode,
  YouTubePlugin,
} from "@/components/editor-nodes/YouTubeNode";
import {
  FigmaNode,
  $createFigmaNode,
  $getFigmaDocumentIDFromURL,
} from "@/components/editor-nodes/FigmaNode";
import { TweetNode } from "@/components/editor-nodes/TweetNode";
import {
  EquationNode,
  EquationsPlugin,
  INSERT_EQUATION_COMMAND,
  $isEquationNode,
} from "@/components/editor-nodes/EquationNode";
import {
  PollNode,
  PollPlugin,
  INSERT_POLL_COMMAND,
} from "@/components/editor-nodes/PollNode";
import {
  StickyNode,
  StickyPlugin,
  INSERT_STICKY_COMMAND,
} from "@/components/editor-nodes/StickyNode";
import {
  ExcalidrawNode,
  $createExcalidrawNode,
  ExcalidrawPlugin,
  OPEN_EXCALIDRAW_MODAL_COMMAND,
} from "@/components/editor-nodes/ExcalidrawNode";
import TableCellResizerPlugin from "@/components/editor-nodes/table/TableCellResizerPlugin";
import TableActionMenuPlugin from "@/components/editor-nodes/table/TableActionMenuPlugin";
import TableHoverActionsPlugin from "@/components/editor-nodes/table/TableHoverActionsPlugin";
import { ImageNode, $createImageNode } from "@/components/editor-nodes/ImageNode";
import { PromptDialog, InsertTableDialog, type PromptCfg } from "@/components/editor-nodes/EditorDialogs";
import { ComponentPickerPlugin } from "@/components/editor-nodes/ComponentPickerPlugin";
import { ColorPicker } from "@/components/editor-nodes/ColorPicker";
import FloatingTextFormatToolbarPlugin from "@/components/editor-nodes/FloatingTextFormatToolbarPlugin";

const cn = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

/** Isolates a non-critical editor plugin (the floating toolbar): if it ever
 *  throws while rendering, swallow it so the note editor itself never crashes. */
class PluginErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error("[note-editor] floating toolbar crashed (isolated):", error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const theme: EditorThemeClasses = {
  paragraph: "mb-3 last:mb-0",
  heading: {
    h1: "mb-3 mt-2 text-[22px] font-semibold text-ink",
    h2: "mb-2 mt-2 text-lg font-semibold text-ink",
    h3: "mb-2 mt-1.5 text-base font-semibold text-ink",
  },
  list: {
    ul: "mb-3 list-disc pl-6",
    ol: "mb-3 list-decimal pl-6",
    checklist: "mb-3 pl-1",
    listitem: "mb-1",
    listitemChecked: "lx-li lx-li-checked",
    listitemUnchecked: "lx-li lx-li-unchecked",
    nested: { listitem: "list-none" },
  },
  quote: "my-3 border-l-[3px] border-edge pl-4 text-ink2",
  code: "my-3 block overflow-x-auto rounded-lg bg-panel2 p-3 font-mono text-[13px] leading-relaxed",
  table: "lx-table",
  tableRow: "lx-table-row",
  tableCell: "lx-table-cell",
  tableCellHeader: "lx-table-cell lx-table-cell-header",
  // playground-parity table editing: selection highlight + frozen markers.
  tableSelection: "lx-table-selection",
  tableCellSelected: "lx-table-cell-selected",
  tableRowStriping: "lx-table-row-striping",
  tableFrozenRow: "lx-table-frozen-row",
  tableFrozenColumn: "lx-table-frozen-column",
  text: {
    bold: "font-semibold",
    italic: "italic",
    underline: "underline",
    strikethrough: "line-through",
    underlineStrikethrough: "[text-decoration:underline_line-through]",
    subscript: "align-sub text-[0.8em]",
    superscript: "align-super text-[0.8em]",
    uppercase: "uppercase",
    lowercase: "lowercase",
    capitalize: "capitalize",
    code: "rounded bg-panel2 px-1.5 py-0.5 font-mono text-[0.88em]",
  },
  link: "text-accent underline",
};

const EDITOR_NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode, CodeNode, CodeHighlightNode, HorizontalRuleNode, TableNode, TableCellNode, TableRowNode, ImageNode, DateNode, PageBreakNode, CollapsibleContainerNode, CollapsibleTitleNode, CollapsibleContentNode, LayoutContainerNode, LayoutItemNode, YouTubeNode, FigmaNode, TweetNode, EquationNode, PollNode, StickyNode, ExcalidrawNode];

const BLOCK_OPTIONS: [string, string][] = [
  ["paragraph", "正常"],
  ["h1", "标题 1"],
  ["h2", "标题 2"],
  ["h3", "标题 3"],
  ["ul", "无序列表"],
  ["ol", "有序列表"],
  ["check", "待办列表"],
  ["quote", "引用"],
  ["code", "代码块"],
];
const BLOCK_LABEL: Record<string, string> = Object.fromEntries(BLOCK_OPTIONS);

function applyBlock(editor: LexicalEditor, key: string, current: string) {
  if (key === "ul") return editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
  if (key === "ol") return editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
  if (key === "check") return editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
  if (key === "paragraph" && (current === "ul" || current === "ol" || current === "check")) {
    editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    return;
  }
  editor.update(() => {
    const sel = $getSelection();
    if (!$isRangeSelection(sel)) return;
    const make: () => ElementNode =
      key === "quote"
        ? () => $createQuoteNode()
        : key === "code"
        ? () => $createCodeNode()
        : key === "h1" || key === "h2" || key === "h3"
        ? () => $createHeadingNode(key)
        : () => $createParagraphNode();
    $setBlocksType(sel, make);
  });
}

// ---- toolbar bits --------------------------------------------------------

const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-edge" />;

function TBtn({
  onClick,
  title,
  active,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-8 min-w-[28px] items-center justify-center rounded-lg px-1.5 text-[15px] transition",
        active ? "bg-accentSoft text-accent" : "text-ink2 hover:bg-panel2 hover:text-ink"
      )}
    >
      {children}
    </button>
  );
}

function Dropdown({
  label,
  width = "min-w-[150px]",
  children,
}: {
  label: React.ReactNode;
  width?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      // Portal the menu to <body> at fixed coords so the toolbar's
      // `overflow-x-auto` can't clip it (overflow-x:auto forces overflow-y to
      // clip too, which was cutting these menus off). Clamp into the viewport.
      setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) });
    }
    setOpen((o) => !o);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        className="flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-ink2 transition hover:bg-panel2 hover:text-ink"
      >
        {label}
      </button>
      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[999]" onClick={() => setOpen(false)} />
            <div
              className={cn("fixed z-[1000] overflow-hidden rounded-xl border border-edge bg-panel py-1 shadow-xl", width)}
              style={{ top: pos.top, left: pos.left }}
            >
              {children(() => setOpen(false))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

function MenuItem({
  onClick,
  active,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition hover:bg-panel2",
        active ? "text-accent" : "text-ink"
      )}
    >
      {children}
    </button>
  );
}

const ChevronDown = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

// Font families offered in the rich (note) toolbar — label → CSS stack.
const FONT_FAMILIES: [string, string][] = [
  ["默认", ""],
  ["Arial", "Arial, sans-serif"],
  ["Georgia", "Georgia, serif"],
  ["Courier New", "'Courier New', monospace"],
  ["Times New Roman", "'Times New Roman', serif"],
  ["Trebuchet MS", "'Trebuchet MS', sans-serif"],
  ["Verdana", "Verdana, sans-serif"],
  ["微软雅黑", "'Microsoft YaHei', 'PingFang SC', sans-serif"],
  ["宋体", "SimSun, 'Songti SC', serif"],
];
const ALIGN_OPTIONS: [ElementFormatType, string][] = [
  ["left", "左对齐"],
  ["center", "居中"],
  ["right", "右对齐"],
  ["justify", "两端对齐"],
];

/** Debounce a callback so dragging the color spectrum doesn't spam the editor
 *  (and the undo stack) with a patch on every pointer move. */
function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delay: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fnRef.current(...args), delay);
    },
    [delay],
  );
}

/** Color popover (text / highlight) — full picker: hex + swatches + spectrum +
 *  hue slider + preview, aligned with the Lexical playground. */
function ColorMenu({
  indicator,
  value,
  onPick,
}: {
  indicator: React.ReactNode;
  value: string;
  onPick: (c: string | null) => void;
}) {
  const applyDebounced = useDebouncedCallback((c: string) => onPick(c), 80);
  return (
    <Dropdown label={indicator} width="min-w-[232px]">
      {(close) => (
        <div className="p-3">
          <ColorPicker color={value} onChange={applyDebounced} />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onPick(null);
              close();
            }}
            className="mt-2.5 w-full rounded-md px-2 py-1.5 text-left text-xs text-ink2 transition hover:bg-panel2"
          >
            清除颜色
          </button>
        </div>
      )}
    </Dropdown>
  );
}

/** Small glyph for a block type — shown in the block-type dropdown (playground). */
function BlockGlyph({ type }: { type: string }) {
  const cls = "h-[15px] w-[15px]";
  if (type === "h1" || type === "h2" || type === "h3")
    return <span className="text-[11px] font-bold leading-none tracking-tight">{type.toUpperCase()}</span>;
  if (type === "quote") return <span className="text-[15px] leading-none">❝</span>;
  if (type === "code")
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m9 8-4 4 4 4" /><path d="m15 8 4 4-4 4" /></svg>
    );
  if (type === "ul")
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1="8" x2="21" y1="6" y2="6" /><line x1="8" x2="21" y1="12" y2="12" /><line x1="8" x2="21" y1="18" y2="18" /><line x1="3" x2="3.01" y1="6" y2="6" /><line x1="3" x2="3.01" y1="12" y2="12" /><line x1="3" x2="3.01" y1="18" y2="18" /></svg>
    );
  if (type === "ol")
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1="10" x2="21" y1="6" y2="6" /><line x1="10" x2="21" y1="12" y2="12" /><line x1="10" x2="21" y1="18" y2="18" /><path d="M4 6h1v4" /><path d="M4 10h2" /></svg>
    );
  if (type === "check")
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m3 17 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" /></svg>
    );
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M13 4v16" /><path d="M17 4v16" /><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13" /></svg>
  );
}

function Toolbar({ rich }: { rich: boolean }) {
  const [editor] = useLexicalComposerContext();
  const [blockType, setBlockType] = useState("paragraph");
  const [format, setFormat] = useState({ bold: false, italic: false, underline: false, strikethrough: false, code: false, link: false });
  const [fontFamily, setFontFamily] = useState("默认");
  const [fontSize, setFontSize] = useState("15");
  const [fontColor, setFontColor] = useState("#1f2024");
  const [bgColor, setBgColor] = useState("#ffffff");
  const [align, setAlign] = useState<ElementFormatType>("left");
  const [promptCfg, setPromptCfg] = useState<PromptCfg | null>(null);
  const [showTableDialog, setShowTableDialog] = useState(false);
  const openPrompt = (opts: Omit<PromptCfg, "resolve">) =>
    new Promise<string | null>((resolve) => setPromptCfg({ ...opts, resolve }));

  /** Patch inline CSS on the current selection (font / size / color …). */
  const applyStyle = (styles: Record<string, string | null>) =>
    editor.update(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) $patchStyleText(sel, styles);
    });

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const sel = $getSelection();
        // A selected block equation is a NodeSelection, not a RangeSelection —
        // reflect its alignment in the toolbar indicator so the align dropdown
        // shows the correct active option (and doesn't look like it had no
        // effect). Other toolbar state (block type / text format) stays as-is.
        if ($isNodeSelection(sel)) {
          const nodes = sel.getNodes();
          const eq = nodes.find($isEquationNode);
          if (eq && !eq.getInline()) {
            setAlign((eq.getFormat() || "left") as ElementFormatType);
          }
          return;
        }
        if (!$isRangeSelection(sel)) return;
        const anchor = sel.anchor.getNode();
        const el = anchor.getKey() === "root" ? anchor : anchor.getTopLevelElementOrThrow();
        let bt = "paragraph";
        if ($isListNode(el)) {
          const lt = el.getListType();
          bt = lt === "number" ? "ol" : lt === "check" ? "check" : "ul";
        } else if ($isHeadingNode(el)) bt = el.getTag();
        else if ($isQuoteNode(el)) bt = "quote";
        else if ($isCodeNode(el)) bt = "code";
        setBlockType(bt);
        const node = sel.anchor.getNode();
        const parent = node.getParent();
        setFormat({
          bold: sel.hasFormat("bold"),
          italic: sel.hasFormat("italic"),
          underline: sel.hasFormat("underline"),
          strikethrough: sel.hasFormat("strikethrough"),
          code: sel.hasFormat("code"),
          link: $isLinkNode(parent) || $isLinkNode(node),
        });
        // inline style + block alignment (rich mode)
        const fam = $getSelectionStyleValueForProperty(sel, "font-family", "");
        const match = FONT_FAMILIES.find(([, stack]) => stack && stack === fam);
        setFontFamily(match ? match[0] : "默认");
        const size = $getSelectionStyleValueForProperty(sel, "font-size", "");
        setFontSize(size ? String(parseInt(size, 10)) : "15");
        setFontColor($getSelectionStyleValueForProperty(sel, "color", "#1f2024") || "#1f2024");
        setBgColor($getSelectionStyleValueForProperty(sel, "background-color", "#ffffff") || "#ffffff");
        const fmtEl = $isElementNode(el) ? el.getFormatType() : "left";
        setAlign((fmtEl || "left") as ElementFormatType);
      });
    });
  }, [editor]);

  const insertLink = async () => {
    const url = await openPrompt({ label: "链接地址（留空可取消链接）", defaultValue: "https://", placeholder: "https://…" });
    if (url === null) return;
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, url.trim() ? url.trim() : null);
  };
  const clearFormatting = () =>
    editor.update(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      (["bold", "italic", "underline", "strikethrough", "code", "highlight", "subscript", "superscript"] as TextFormatType[]).forEach(
        (f) => {
          if (sel.hasFormat(f)) sel.toggleFormat(f);
        }
      );
      $setBlocksType(sel, () => $createParagraphNode());
    });

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-edge px-2 py-2 [&>*]:shrink-0">
      {promptCfg && <PromptDialog cfg={promptCfg} onClose={() => setPromptCfg(null)} />}
      {showTableDialog && (
        <InsertTableDialog
          onClose={() => setShowTableDialog(false)}
          onConfirm={(rows, columns) =>
            editor.dispatchCommand(INSERT_TABLE_COMMAND, {
              rows: String(rows),
              columns: String(columns),
              // Header the first ROW only (playground parity). Passing the boolean
              // `true` here would also header the first COLUMN, shading it grey.
              includeHeaders: { rows: true, columns: false },
            })
          }
        />
      )}
      <TBtn title="撤销" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
      </TBtn>
      <TBtn title="重做" onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></svg>
      </TBtn>
      <Sep />
      <Dropdown
        label={<><span className="grid w-[15px] place-items-center"><BlockGlyph type={blockType} /></span><span>{BLOCK_LABEL[blockType] ?? "正常"}</span><ChevronDown /></>}
        width="min-w-[164px]"
      >
        {(close) =>
          BLOCK_OPTIONS.map(([key, label]) => (
            <MenuItem
              key={key}
              active={key === blockType}
              onClick={() => {
                applyBlock(editor, key, blockType);
                close();
              }}
            >
              <span className="flex items-center gap-2.5">
                <span className="grid w-[15px] place-items-center text-ink2"><BlockGlyph type={key} /></span>
                {label}
              </span>
            </MenuItem>
          ))
        }
      </Dropdown>
      {rich && (
        <>
          <Sep />
          <Dropdown
            label={<><span className="font-serif text-[15px] leading-none">T</span><span className="max-w-[76px] truncate">{fontFamily}</span><ChevronDown /></>}
            width="min-w-[156px]"
          >
            {(close) =>
              FONT_FAMILIES.map(([label, stack]) => (
                <MenuItem
                  key={label}
                  active={label === fontFamily}
                  onClick={() => {
                    applyStyle({ "font-family": stack || null });
                    close();
                  }}
                >
                  <span style={{ fontFamily: stack || undefined }}>{label}</span>
                </MenuItem>
              ))
            }
          </Dropdown>
          <div className="mx-0.5 flex items-center gap-0.5">
            <button
              type="button"
              title="减小字号"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const n = Math.max(8, (parseInt(fontSize, 10) || 15) - 1);
                setFontSize(String(n));
                applyStyle({ "font-size": `${n}px` });
              }}
              className="grid h-7 w-5 place-items-center rounded text-ink2 transition hover:bg-panel2"
            >
              −
            </button>
            <input
              name="font-size"
              autoComplete="off"
              value={fontSize}
              onChange={(e) => setFontSize(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={() => {
                const n = Math.min(72, Math.max(8, parseInt(fontSize, 10) || 15));
                setFontSize(String(n));
                applyStyle({ "font-size": `${n}px` });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur();
              }}
              className="h-7 w-8 rounded border border-edge bg-panel text-center text-[13px] text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              title="增大字号"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const n = Math.min(72, (parseInt(fontSize, 10) || 15) + 1);
                setFontSize(String(n));
                applyStyle({ "font-size": `${n}px` });
              }}
              className="grid h-7 w-5 place-items-center rounded text-ink2 transition hover:bg-panel2"
            >
              +
            </button>
          </div>
        </>
      )}
      <Sep />
      <TBtn title="粗体" active={format.bold} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}>
        <b>B</b>
      </TBtn>
      <TBtn title="斜体" active={format.italic} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}>
        <i className="font-serif">I</i>
      </TBtn>
      {rich && (
        <TBtn title="下划线" active={format.underline} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}>
          <span className="underline">U</span>
        </TBtn>
      )}
      {!rich && (
        <TBtn title="删除线" active={format.strikethrough} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough")}>
          <s>S</s>
        </TBtn>
      )}
      <TBtn title="行内代码" active={format.code} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "code")}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m9 8-4 4 4 4" /><path d="m15 8 4 4-4 4" /></svg>
      </TBtn>
      <TBtn title="链接" active={format.link} onClick={insertLink}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></svg>
      </TBtn>
      {rich && (
        <>
          <ColorMenu
            indicator={
              <span className="flex flex-col items-center leading-none">
                <span className="text-[13px] font-semibold">A</span>
                <span className="mt-[3px] h-[3px] w-3.5 rounded-full" style={{ background: fontColor }} />
              </span>
            }
            value={fontColor}
            onPick={(c) => applyStyle({ color: c })}
          />
          <ColorMenu
            indicator={
              <span className="flex flex-col items-center leading-none">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l3.2 3.2a2 2 0 0 0 2.8 0z" />
                  <path d="m5 2 5 5" />
                  <path d="M2 13h15" />
                  <path d="M21.5 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4" />
                </svg>
                <span className="mt-[3px] h-[3px] w-3.5 rounded-full" style={{ background: bgColor }} />
              </span>
            }
            value={bgColor}
            onPick={(c) => applyStyle({ "background-color": c })}
          />
          {/* Aa — extra text formatting */}
          <Dropdown
            label={
              <>
                <span className="leading-none"><span className="text-[15px]">A</span><span className="text-[11px]">a</span></span>
                <ChevronDown />
              </>
            }
            width="min-w-[150px]"
          >
            {(close) => (
              <>
                <MenuItem active={format.strikethrough} onClick={() => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, "strikethrough"); close(); }}>
                  <span>删除线</span>
                  <s className="text-muted">S</s>
                </MenuItem>
                <MenuItem onClick={() => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, "subscript"); close(); }}>
                  <span>下标</span>
                  <span className="text-muted">x₂</span>
                </MenuItem>
                <MenuItem onClick={() => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, "superscript"); close(); }}>
                  <span>上标</span>
                  <span className="text-muted">x²</span>
                </MenuItem>
                <div className="my-1 h-px bg-edge" />
                <MenuItem onClick={() => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, "uppercase"); close(); }}>大写</MenuItem>
                <MenuItem onClick={() => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, "lowercase"); close(); }}>小写</MenuItem>
                <MenuItem onClick={() => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, "capitalize"); close(); }}>首字母大写</MenuItem>
                <div className="my-1 h-px bg-edge" />
                <MenuItem onClick={() => { clearFormatting(); close(); }}>清除格式</MenuItem>
              </>
            )}
          </Dropdown>
        </>
      )}
      {!rich && (
        <>
          <Sep />
          <TBtn title="无序列表" active={blockType === "ul"} onClick={() => applyBlock(editor, "ul", blockType)}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1="8" x2="21" y1="6" y2="6" /><line x1="8" x2="21" y1="12" y2="12" /><line x1="8" x2="21" y1="18" y2="18" /><line x1="3" x2="3.01" y1="6" y2="6" /><line x1="3" x2="3.01" y1="12" y2="12" /><line x1="3" x2="3.01" y1="18" y2="18" /></svg>
          </TBtn>
          <TBtn title="有序列表" active={blockType === "ol"} onClick={() => applyBlock(editor, "ol", blockType)}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><line x1="10" x2="21" y1="6" y2="6" /><line x1="10" x2="21" y1="12" y2="12" /><line x1="10" x2="21" y1="18" y2="18" /><path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" /></svg>
          </TBtn>
          <TBtn title="待办列表" active={blockType === "check"} onClick={() => applyBlock(editor, "check", blockType)}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" /></svg>
          </TBtn>
          <TBtn title="引用" active={blockType === "quote"} onClick={() => applyBlock(editor, "quote", blockType)}>
            <span className="text-lg leading-none">❝</span>
          </TBtn>
        </>
      )}
      {rich && (
        <>
          <Sep />
          {/* + 插入 */}
          <Dropdown
            label={<><span className="text-base leading-none">+</span><span>插入</span><ChevronDown /></>}
            width="min-w-[150px]"
          >
            {(close) => (
              <>
                <MenuItem onClick={() => { editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined); close(); }}>
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><line x1="3" x2="21" y1="12" y2="12" /></svg>
                    分隔线
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    setShowTableDialog(true);
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" x2="21" y1="9" y2="9" /><line x1="3" x2="21" y1="15" y2="15" /><line x1="9" x2="9" y1="3" y2="21" /><line x1="15" x2="15" y1="3" y2="21" /></svg>
                    表格
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={async () => {
                    close();
                    const url = await openPrompt({ label: "图片链接(URL)", placeholder: "https://…/image.png" });
                    if (!url || !url.trim()) return;
                    const src = url.trim();
                    editor.update(() => {
                      $insertNodes([$createImageNode(src)]);
                    });
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.5-3.5L9 20" /></svg>
                    图片
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={async () => {
                    close();
                    const url = await openPrompt({ label: "GIF 链接(URL)", placeholder: "https://…/animation.gif" });
                    if (url?.trim()) {
                      const src = url.trim();
                      editor.update(() => {
                        $insertNodes([$createImageNode(src)]);
                      });
                    }
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 8v8" /><path d="M16 8h-2.5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5H16v-3h-1.5" /></svg>
                    GIF
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    editor.update(() => {
                      $insertNodes([$createDateNode(new Date(), false)]);
                    });
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><rect x="3" y="4.5" width="18" height="17" rx="2.5" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /></svg>
                    日期
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    editor.dispatchCommand(INSERT_PAGE_BREAK_COMMAND, undefined);
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><path d="M6 3h9l3 3v3" /><path d="M6 21h9l3-3v-3" /><line x1="2" x2="22" y1="12" y2="12" strokeDasharray="2 2" /></svg>
                    分页符
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND, undefined);
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><path d="m9 6 6 6-6 6" /><line x1="3" x2="3" y1="4" y2="20" /></svg>
                    折叠容器
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    editor.dispatchCommand(INSERT_LAYOUT_COMMAND, "1fr 1fr");
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" x2="12" y1="3" y2="21" /></svg>
                    分栏
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={async () => {
                    close();
                    const input = await openPrompt({ label: "粘贴 Figma 文件链接(或文档 ID)", placeholder: "https://www.figma.com/file/…" });
                    if (input) {
                      const documentID = $getFigmaDocumentIDFromURL(input);
                      // No native window.alert (HARD RULE): re-open the dialog inline
                      // with a hint instead of an OS alert when the URL can't be parsed.
                      if (!documentID) {
                        await openPrompt({
                          label: "无法识别该 Figma 链接,请粘贴形如 figma.com/file/<ID>/… 的地址",
                          placeholder: "https://www.figma.com/file/…",
                        });
                        return;
                      }
                      editor.update(() => {
                        const node = $createFigmaNode(documentID);
                        $insertNodes([node]);
                        const parent = node.getParentOrThrow();
                        if ($isRootOrShadowRoot(parent)) {
                          const para = $createParagraphNode();
                          node.insertAfter(para);
                          para.selectStart();
                        }
                      });
                    }
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><path d="M9 3h3v6H9a3 3 0 1 1 0-6Z" /><path d="M12 3h3a3 3 0 1 1 0 6h-3V3Z" /><path d="M9 9h3v6H9a3 3 0 1 1 0-6Z" /><circle cx="15" cy="12" r="3" /><path d="M9 15h3v3a3 3 0 1 1-3-3Z" /></svg>
                    Figma
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={async () => {
                    close();
                    const latex = await openPrompt({ label: "公式 (LaTeX)", placeholder: "a^2+b^2=c^2" });
                    if (latex !== null) {
                      editor.dispatchCommand(INSERT_EQUATION_COMMAND, { equation: latex.trim() || "a^2+b^2=c^2", inline: false });
                    }
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><path d="M4 3h11l-6 9 6 9H4" /><path d="M14 3l6 18" /></svg>
                    公式
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={async () => {
                    close();
                    const question = await openPrompt({ label: "投票问题", placeholder: "你想问什么?" });
                    if (question !== null) {
                      editor.dispatchCommand(INSERT_POLL_COMMAND, { question: question.trim() });
                    }
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" rx="1" /><rect x="12" y="7" width="3" height="10" rx="1" /><rect x="17" y="13" width="3" height="4" rx="1" /></svg>
                    投票
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    editor.dispatchCommand(INSERT_STICKY_COMMAND, undefined);
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2Z" /><path d="M14 21v-5a2 2 0 0 1 2-2h5" /></svg>
                    便签
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    editor.update(() => {
                      const node = $createExcalidrawNode("");
                      $insertNodes([node]);
                      const parent = node.getParentOrThrow();
                      if ($isRootOrShadowRoot(parent)) {
                        const para = $createParagraphNode();
                        node.insertAfter(para);
                      }
                      // open the edit modal immediately on the freshly inserted (empty) node
                      editor.dispatchCommand(OPEN_EXCALIDRAW_MODAL_COMMAND, node.getKey());
                    });
                  }}
                >
                  <span className="flex items-center gap-2.5">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-ink2" aria-hidden><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>
                    Excalidraw
                  </span>
                </MenuItem>
              </>
            )}
          </Dropdown>
          <Sep />
          {/* alignment (+ indent) */}
          <Dropdown
            label={
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <line x1="3" x2="21" y1="6" y2="6" />
                  <line x1="3" x2={align === "right" ? "21" : align === "center" ? "18" : "15"} y1="12" y2="12" />
                  <line x1="3" x2="21" y1="18" y2="18" />
                </svg>
                <span>{ALIGN_OPTIONS.find(([k]) => k === align)?.[1] ?? "左对齐"}</span>
                <ChevronDown />
              </>
            }
            width="min-w-[140px]"
          >
            {(close) => (
              <>
                {ALIGN_OPTIONS.map(([key, label]) => (
                  <MenuItem
                    key={key}
                    active={key === align}
                    onClick={() => {
                      editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, key);
                      close();
                    }}
                  >
                    {label}
                  </MenuItem>
                ))}
                <div className="my-1 h-px bg-edge" />
                <MenuItem onClick={() => { editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined); close(); }}>
                  <span>减少缩进</span>
                  <span className="text-muted">⇤</span>
                </MenuItem>
                <MenuItem onClick={() => { editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined); close(); }}>
                  <span>增加缩进</span>
                  <span className="text-muted">⇥</span>
                </MenuItem>
              </>
            )}
          </Dropdown>
        </>
      )}
      {!rich && (
        <>
          <Sep />
          <Dropdown label="⋯" width="min-w-[150px]">
            {(close) => (
              <>
                <MenuItem onClick={() => { editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined); close(); }}>
                  <span>减少缩进</span>
                  <span className="text-muted">⇤</span>
                </MenuItem>
                <MenuItem onClick={() => { editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined); close(); }}>
                  <span>增加缩进</span>
                  <span className="text-muted">⇥</span>
                </MenuItem>
                <div className="my-1 h-px bg-edge" />
                <MenuItem onClick={() => { clearFormatting(); close(); }}>
                  <span>清除格式</span>
                </MenuItem>
              </>
            )}
          </Dropdown>
        </>
      )}
    </div>
  );
}

// Auto-link matchers — turn typed URLs / emails into links as you type.
const URL_MATCHER =
  /((https?:\/\/(www\.)?)|(www\.))[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,12}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/;
const EMAIL_MATCHER =
  /(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/;
const AUTO_LINK_MATCHERS = [
  createLinkMatcherWithRegExp(URL_MATCHER, (t) => (t.startsWith("http") ? t : `https://${t}`)),
  createLinkMatcherWithRegExp(EMAIL_MATCHER, (t) => `mailto:${t}`),
];

/** Drag handle (⠿) that appears in the left margin on block hover — grab it to
 *  reorder paragraphs / headings / list items by dragging, like the Lexical
 *  playground. The plugin positions/shows the handle + drop-line itself. */
function DraggableBlock({ anchorElem }: { anchorElem: HTMLElement }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const targetLineRef = useRef<HTMLDivElement>(null);
  return (
    <DraggableBlockPlugin_EXPERIMENTAL
      anchorElem={anchorElem}
      menuRef={menuRef as RefObject<HTMLElement | null>}
      targetLineRef={targetLineRef as RefObject<HTMLElement | null>}
      menuComponent={
        <div ref={menuRef} className="draggable-block-menu" title="拖动以移动整段">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-muted" aria-hidden>
            <circle cx="9" cy="5" r="1.5" /><circle cx="15" cy="5" r="1.5" />
            <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
            <circle cx="9" cy="19" r="1.5" /><circle cx="15" cy="19" r="1.5" />
          </svg>
        </div>
      }
      targetLineComponent={<div ref={targetLineRef} className="draggable-block-target-line" />}
      isOnMenu={(el) => !!el.closest(".draggable-block-menu")}
    />
  );
}

// ---- editor --------------------------------------------------------------

function lexNodeText(node: any): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.children)) return node.children.map(lexNodeText).join("");
  return "";
}

/** Drop a leading heading that merely repeats `title` — the title is shown in
 *  the editor header already, so echoing it as the first line of the body is
 *  redundant. Handles both Lexical-JSON and Markdown note content. */
function stripLeadingTitle(value: string, title: string): string {
  const t = title.trim();
  if (!value || !t) return value;
  if (value.trimStart().startsWith("{")) {
    try {
      const state = JSON.parse(value);
      const kids = state?.root?.children;
      if (Array.isArray(kids) && kids[0]?.type === "heading" && lexNodeText(kids[0]).trim() === t) {
        kids.shift();
        return JSON.stringify(state);
      }
    } catch {
      /* not valid JSON — fall through, treat as Markdown */
    }
    return value;
  }
  const lines = value.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const m = lines[i]?.match(/^#{1,6}\s+(.+?)\s*$/);
  if (m && m[1].trim() === t) {
    lines.splice(i, 1);
    if (lines[i]?.trim() === "") lines.splice(i, 1); // tidy the blank line after
    return lines.join("\n").trimStart();
  }
  return value;
}

/**
 * NotebookLM-style rich-text editor (Lexical).
 * - format="markdown" (reports): reads/writes Markdown (styling that Markdown
 *   can't represent is dropped — fine for documents).
 * - format="json" (notes): reads/writes the full Lexical editor-state JSON, so
 *   fonts, sizes, colors, highlight, underline and alignment all persist — and
 *   the toolbar exposes those rich controls.
 * - stripTitle: when set, a leading heading equal to it is removed before the
 *   body is seeded (the title already shows above the editor).
 */
export default function RichNoteEditor({
  value,
  onChange,
  placeholder = "开始记录…",
  format = "markdown",
  stripTitle,
}: {
  value: string;
  onChange: (content: string) => void;
  placeholder?: string;
  format?: "markdown" | "json";
  stripTitle?: string;
}) {
  // Optionally drop a leading heading that just repeats the title before seeding.
  const src = stripTitle ? stripLeadingTitle(value, stripTitle) : value;
  // In json mode, load the serialized editor state directly when it's valid;
  // otherwise (legacy Markdown note, or empty) fall back to Markdown parsing.
  const jsonState = (() => {
    if (format !== "json") return null;
    try {
      const o = JSON.parse(src);
      return o && o.root ? src : null;
    } catch {
      return null;
    }
  })();
  // Corrupt Lexical state: content that clearly WANTS to be an editor state
  // (starts with `{"root":`) but fails to parse — e.g. a truncated write. The
  // old code fed this straight to the Markdown parser, which happily rendered
  // the raw `{"root":…}` braces as body text; the next keystroke then
  // re-serialized that text and PATCHed it over the original, destroying any
  // chance of recovery. Instead we detect it, show the raw bytes read-only, and
  // suppress onChange so autosave can never overwrite the salvageable original.
  const corruptJson =
    format === "json" && !jsonState && /^\s*\{\s*"root"\s*:/.test(src);
  const initialConfig = {
    namespace: "note-editor",
    theme,
    editable: !corruptJson,
    nodes: EDITOR_NODES,
    onError: (e: Error) => console.error("[lexical]", e),
    editorState:
      jsonState ??
      (() => {
        const root = $getRoot();
        if (corruptJson) {
          root.append(
            $createParagraphNode().append(
              $createTextNode("⚠️ 此笔记内容已损坏,暂以只读方式显示原始数据以便恢复。"),
            ),
          );
          root.append($createCodeNode().append($createTextNode(src)));
          return;
        }
        $convertFromMarkdownString(src || "", NOTE_TRANSFORMERS);
        if (root.getChildrenSize() === 0) root.append($createParagraphNode());
      }),
  };

  const handleChange = useCallback(
    (editorState: EditorState) => {
      // A corrupt-JSON note is read-only; never emit changes, or we'd overwrite
      // the (recoverable) original with the placeholder we rendered.
      if (corruptJson) return;
      if (format === "json") {
        onChange(JSON.stringify(editorState.toJSON()));
      } else {
        editorState.read(() => onChange($convertToMarkdownString(NOTE_TRANSFORMERS)));
      }
    },
    [onChange, format, corruptJson]
  );

  // Anchor for the draggable block handle (positioned within this scroll area).
  const [dragAnchor, setDragAnchor] = useState<HTMLDivElement | null>(null);
  const onDragAnchor = useCallback((el: HTMLDivElement | null) => {
    if (el) setDragAnchor(el);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LexicalComposer initialConfig={initialConfig}>
        <Toolbar rich={format === "json"} />
        <div ref={onDragAnchor} className="relative min-h-0 flex-1 overflow-y-auto">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="min-h-full py-5 pl-9 pr-6 text-[15px] leading-7 text-ink outline-none" />
            }
            placeholder={
              <div className="pointer-events-none absolute left-9 top-5 select-none text-[15px] text-muted">
                {placeholder}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <ListPlugin />
          <CheckListPlugin />
          <HorizontalRulePlugin />
          <PageBreakPlugin />
          <CollapsiblePlugin />
          <LayoutPlugin />
          <YouTubePlugin />
          <EquationsPlugin />
          <PollPlugin />
          <StickyPlugin />
          <ExcalidrawPlugin />
          <TablePlugin />
          <TableCellResizerPlugin />
          {dragAnchor && <TableActionMenuPlugin anchorElem={dragAnchor} />}
          {dragAnchor && <TableHoverActionsPlugin anchorElem={dragAnchor} />}
          <LinkPlugin />
          <ClickableLinkPlugin />
          <AutoLinkPlugin matchers={AUTO_LINK_MATCHERS} />
          <TabIndentationPlugin />
          <MarkdownShortcutPlugin transformers={NOTE_TRANSFORMERS} />
          <OnChangePlugin onChange={handleChange} />
          <ComponentPickerPlugin />
          <PluginErrorBoundary>
            <FloatingTextFormatToolbarPlugin />
          </PluginErrorBoundary>
          {dragAnchor && <DraggableBlock anchorElem={dragAnchor} />}
        </div>
      </LexicalComposer>
    </div>
  );
}
