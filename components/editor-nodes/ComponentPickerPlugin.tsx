"use client";

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { type MenuRenderFn } from "@lexical/react/LexicalNodeMenuPlugin";
import {
  $createHeadingNode,
  $createQuoteNode,
} from "@lexical/rich-text";
import { $createCodeNode } from "@lexical/code";
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from "@lexical/list";
import { $setBlocksType } from "@lexical/selection";
import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";
import { INSERT_TABLE_COMMAND } from "@lexical/table";
import {
  $createParagraphNode,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  $isRootOrShadowRoot,
  type ElementNode,
  type LexicalEditor,
  type TextNode,
} from "lexical";

import { $createDateNode } from "@/components/editor-nodes/DateNode";
import { INSERT_PAGE_BREAK_COMMAND } from "@/components/editor-nodes/PageBreakNode";
import { INSERT_COLLAPSIBLE_COMMAND } from "@/components/editor-nodes/CollapsibleNode";
import { INSERT_LAYOUT_COMMAND } from "@/components/editor-nodes/LayoutNode";
import { $createFigmaNode, $getFigmaDocumentIDFromURL } from "@/components/editor-nodes/FigmaNode";
import { INSERT_EQUATION_COMMAND } from "@/components/editor-nodes/EquationNode";
import { INSERT_POLL_COMMAND } from "@/components/editor-nodes/PollNode";
import { INSERT_STICKY_COMMAND } from "@/components/editor-nodes/StickyNode";
import { $createExcalidrawNode, OPEN_EXCALIDRAW_MODAL_COMMAND } from "@/components/editor-nodes/ExcalidrawNode";
import { $createImageNode } from "@/components/editor-nodes/ImageNode";
import { PromptDialog, InsertTableDialog, type PromptCfg } from "@/components/editor-nodes/EditorDialogs";

const cn = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

// Small inline glyphs (no ✦/✨ — flat lavender-friendly line icons).
const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className="shrink-0"
  >
    {children}
  </svg>
);

const ICONS: Record<string, JSX.Element> = {
  paragraph: <Icon><path d="M13 4v16" /><path d="M17 4v16" /><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13" /></Icon>,
  h1: <Icon><path d="M4 12h8" /><path d="M4 18V6" /><path d="M12 18V6" /><path d="M17 12l3-2v8" /></Icon>,
  h2: <Icon><path d="M4 12h8" /><path d="M4 18V6" /><path d="M12 18V6" /><path d="M17 10a2 2 0 1 1 4 0c0 .6-.4 1.2-1 1.8L17 15h4" /></Icon>,
  h3: <Icon><path d="M4 12h8" /><path d="M4 18V6" /><path d="M12 18V6" /><path d="M17 9.5a1.8 1.8 0 1 1 2 2.5 1.8 1.8 0 1 1-2 2.5" /></Icon>,
  table: <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" x2="21" y1="9" y2="9" /><line x1="3" x2="21" y1="15" y2="15" /><line x1="9" x2="9" y1="3" y2="21" /><line x1="15" x2="15" y1="3" y2="21" /></Icon>,
  ol: <Icon><line x1="10" x2="21" y1="6" y2="6" /><line x1="10" x2="21" y1="12" y2="12" /><line x1="10" x2="21" y1="18" y2="18" /><path d="M4 6h1v4" /><path d="M4 10h2" /></Icon>,
  ul: <Icon><line x1="8" x2="21" y1="6" y2="6" /><line x1="8" x2="21" y1="12" y2="12" /><line x1="8" x2="21" y1="18" y2="18" /><line x1="3" x2="3.01" y1="6" y2="6" /><line x1="3" x2="3.01" y1="12" y2="12" /><line x1="3" x2="3.01" y1="18" y2="18" /></Icon>,
  check: <Icon><path d="m3 17 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" /></Icon>,
  quote: <Icon><path d="M3 21c3 0 7-1 7-8V5H4v6h4" /><path d="M14 21c3 0 7-1 7-8V5h-6v6h4" /></Icon>,
  code: <Icon><path d="m9 8-4 4 4 4" /><path d="m15 8 4 4-4 4" /></Icon>,
  hr: <Icon><line x1="3" x2="21" y1="12" y2="12" /></Icon>,
  image: <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.5-3.5L9 20" /></Icon>,
  gif: <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 8v8" /><path d="M16 8h-2.5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5H16v-3h-1.5" /></Icon>,
  equation: <Icon><path d="M4 3h11l-6 9 6 9H4" /><path d="M14 3l6 18" /></Icon>,
  collapsible: <Icon><path d="m9 6 6 6-6 6" /><line x1="3" x2="3" y1="4" y2="20" /></Icon>,
  columns: <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" x2="12" y1="3" y2="21" /></Icon>,
  date: <Icon><rect x="3" y="4.5" width="18" height="17" rx="2.5" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /></Icon>,
  "page-break": <Icon><path d="M6 3h9l3 3v3" /><path d="M6 21h9l3-3v-3" /><line x1="2" x2="22" y1="12" y2="12" strokeDasharray="2 2" /></Icon>,
  poll: <Icon><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" rx="1" /><rect x="12" y="7" width="3" height="10" rx="1" /><rect x="17" y="13" width="3" height="4" rx="1" /></Icon>,
  sticky: <Icon><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2Z" /><path d="M14 21v-5a2 2 0 0 1 2-2h5" /></Icon>,
  figma: <Icon><path d="M9 3h3v6H9a3 3 0 1 1 0-6Z" /><path d="M12 3h3a3 3 0 1 1 0 6h-3V3Z" /><path d="M9 9h3v6H9a3 3 0 1 1 0-6Z" /><circle cx="15" cy="12" r="3" /><path d="M9 15h3v3a3 3 0 1 1-3-3Z" /></Icon>,
  excalidraw: <Icon><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></Icon>,
};

class ComponentPickerOption extends MenuOption {
  title: string;
  keywords: string[];
  icon?: JSX.Element;
  onSelect: () => void;

  constructor(
    key: string,
    options: { title: string; keywords?: string[]; icon?: JSX.Element; onSelect: () => void }
  ) {
    super(key);
    this.title = options.title;
    this.keywords = options.keywords ?? [];
    this.icon = options.icon;
    this.onSelect = options.onSelect;
  }
}

/** Convert the current selection's block to a different element type. */
function setBlock(editor: LexicalEditor, make: () => ElementNode) {
  editor.update(() => {
    const sel = $getSelection();
    if ($isRangeSelection(sel)) $setBlocksType(sel, make);
  });
}

export function ComponentPickerPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [promptCfg, setPromptCfg] = useState<PromptCfg | null>(null);
  const [showTableDialog, setShowTableDialog] = useState(false);

  useEffect(() => setMounted(true), []);

  const openPrompt = useCallback(
    (opts: Omit<PromptCfg, "resolve">) =>
      new Promise<string | null>((resolve) => setPromptCfg({ ...opts, resolve })),
    []
  );

  const triggerFn = useBasicTypeaheadTriggerMatch("/", { minLength: 0 });

  const ALL_OPTIONS = useMemo<ComponentPickerOption[]>(() => {
    return [
      new ComponentPickerOption("paragraph", {
        title: "正常文本",
        icon: ICONS.paragraph,
        keywords: ["paragraph", "normal", "p", "text", "正文", "段落", "zhengwen", "duanluo"],
        onSelect: () => setBlock(editor, () => $createParagraphNode()),
      }),
      new ComponentPickerOption("h1", {
        title: "标题 1",
        icon: ICONS.h1,
        keywords: ["heading", "header", "h1", "title", "标题", "biaoti", "yiji"],
        onSelect: () => setBlock(editor, () => $createHeadingNode("h1")),
      }),
      new ComponentPickerOption("h2", {
        title: "标题 2",
        icon: ICONS.h2,
        keywords: ["heading", "header", "h2", "subtitle", "标题", "biaoti", "erji"],
        onSelect: () => setBlock(editor, () => $createHeadingNode("h2")),
      }),
      new ComponentPickerOption("h3", {
        title: "标题 3",
        icon: ICONS.h3,
        keywords: ["heading", "header", "h3", "标题", "biaoti", "sanji"],
        onSelect: () => setBlock(editor, () => $createHeadingNode("h3")),
      }),
      new ComponentPickerOption("table", {
        title: "表格",
        icon: ICONS.table,
        keywords: ["table", "grid", "spreadsheet", "rows", "columns", "biaoge", "表"],
        // open the in-app dialog (no window.prompt) — it dispatches the command.
        onSelect: () => setShowTableDialog(true),
      }),
      new ComponentPickerOption("ol", {
        title: "有序列表",
        icon: ICONS.ol,
        keywords: ["numbered list", "ordered list", "ol", "number", "有序列表", "youxu", "shuzi", "liebiao"],
        onSelect: () => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined),
      }),
      new ComponentPickerOption("ul", {
        title: "无序列表",
        icon: ICONS.ul,
        keywords: ["bulleted list", "unordered list", "ul", "bullet", "无序列表", "wuxu", "yuandian", "liebiao"],
        onSelect: () => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined),
      }),
      new ComponentPickerOption("check", {
        title: "待办列表",
        icon: ICONS.check,
        keywords: ["check list", "todo list", "todo", "checkbox", "待办", "daiban", "renwu", "qingdan"],
        onSelect: () => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined),
      }),
      new ComponentPickerOption("quote", {
        title: "引用",
        icon: ICONS.quote,
        keywords: ["quote", "block quote", "blockquote", "引用", "yinyong"],
        onSelect: () => setBlock(editor, () => $createQuoteNode()),
      }),
      new ComponentPickerOption("code", {
        title: "代码块",
        icon: ICONS.code,
        keywords: ["code", "codeblock", "javascript", "python", "js", "代码", "daima", "daimakuai"],
        onSelect: () => setBlock(editor, () => $createCodeNode()),
      }),
      new ComponentPickerOption("hr", {
        title: "分隔线",
        icon: ICONS.hr,
        keywords: ["horizontal rule", "divider", "hr", "rule", "line", "分隔线", "fengexian", "fenge"],
        onSelect: () => editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined),
      }),
      new ComponentPickerOption("image", {
        title: "图片",
        icon: ICONS.image,
        keywords: ["image", "photo", "picture", "file", "img", "图片", "tupian", "tu"],
        onSelect: async () => {
          const url = await openPrompt({ label: "图片链接(URL)", placeholder: "https://…/image.png" });
          if (!url || !url.trim()) return;
          const src = url.trim();
          editor.update(() => {
            $insertNodes([$createImageNode(src)]);
          });
        },
      }),
      new ComponentPickerOption("gif", {
        title: "GIF",
        icon: ICONS.gif,
        keywords: ["gif", "animate", "animation", "image", "file", "动图", "dongtu"],
        onSelect: async () => {
          const url = await openPrompt({ label: "GIF 链接(URL)", placeholder: "https://…/animation.gif" });
          if (url?.trim()) {
            const src = url.trim();
            editor.update(() => {
              $insertNodes([$createImageNode(src)]);
            });
          }
        },
      }),
      new ComponentPickerOption("equation", {
        title: "公式",
        icon: ICONS.equation,
        keywords: ["equation", "latex", "math", "formula", "公式", "gongshi", "shuxue"],
        onSelect: async () => {
          const latex = await openPrompt({ label: "公式 (LaTeX)", placeholder: "a^2+b^2=c^2" });
          if (latex !== null) {
            editor.dispatchCommand(INSERT_EQUATION_COMMAND, { equation: latex.trim() || "a^2+b^2=c^2", inline: false });
          }
        },
      }),
      new ComponentPickerOption("collapsible", {
        title: "折叠容器",
        icon: ICONS.collapsible,
        keywords: ["collapse", "collapsible", "toggle", "accordion", "details", "折叠", "zhedie", "zhedierongqi"],
        onSelect: () => editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND, undefined),
      }),
      new ComponentPickerOption("columns", {
        title: "分栏",
        icon: ICONS.columns,
        keywords: ["columns", "layout", "grid", "分栏", "fenlan", "buju"],
        onSelect: () => editor.dispatchCommand(INSERT_LAYOUT_COMMAND, "1fr 1fr"),
      }),
      new ComponentPickerOption("date", {
        title: "日期",
        icon: ICONS.date,
        keywords: ["date", "calendar", "time", "日期", "riqi", "shijian"],
        onSelect: () =>
          editor.update(() => {
            $insertNodes([$createDateNode(new Date(), false)]);
          }),
      }),
      new ComponentPickerOption("page-break", {
        title: "分页符",
        icon: ICONS["page-break"],
        keywords: ["page break", "divider", "pagebreak", "分页符", "fenye", "fenyefu"],
        onSelect: () => editor.dispatchCommand(INSERT_PAGE_BREAK_COMMAND, undefined),
      }),
      new ComponentPickerOption("poll", {
        title: "投票",
        icon: ICONS.poll,
        keywords: ["poll", "vote", "survey", "投票", "toupiao", "diaocha"],
        onSelect: async () => {
          const question = await openPrompt({ label: "投票问题", placeholder: "你想问什么?" });
          if (question !== null) {
            editor.dispatchCommand(INSERT_POLL_COMMAND, { question: question.trim() });
          }
        },
      }),
      new ComponentPickerOption("sticky", {
        title: "便签",
        icon: ICONS.sticky,
        keywords: ["sticky", "note", "stickynote", "便签", "bianqian", "biaoji"],
        onSelect: () => editor.dispatchCommand(INSERT_STICKY_COMMAND, undefined),
      }),
      new ComponentPickerOption("figma", {
        title: "Figma",
        icon: ICONS.figma,
        keywords: ["figma", "embed", "design", "嵌入", "qianru", "sheji"],
        onSelect: async () => {
          const input = await openPrompt({ label: "粘贴 Figma 文件链接(或文档 ID)", placeholder: "https://www.figma.com/file/…" });
          if (!input) return;
          const documentID = $getFigmaDocumentIDFromURL(input);
          // No native window.alert (HARD RULE): re-open the dialog inline with a
          // hint instead of an OS alert when the URL can't be parsed.
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
        },
      }),
      new ComponentPickerOption("excalidraw", {
        title: "Excalidraw",
        icon: ICONS.excalidraw,
        keywords: ["excalidraw", "diagram", "drawing", "draw", "sketch", "画图", "huatu", "tujie"],
        onSelect: () =>
          editor.update(() => {
            const node = $createExcalidrawNode("");
            $insertNodes([node]);
            const parent = node.getParentOrThrow();
            if ($isRootOrShadowRoot(parent)) {
              const para = $createParagraphNode();
              node.insertAfter(para);
            }
            editor.dispatchCommand(OPEN_EXCALIDRAW_MODAL_COMMAND, node.getKey());
          }),
      }),
    ];
  }, [editor, openPrompt]);

  const options = useMemo(() => {
    if (!query) return ALL_OPTIONS;
    let rx: RegExp;
    try {
      rx = new RegExp(query, "i");
    } catch {
      // Query may be a partial / invalid regex while typing — fall back to a
      // case-insensitive substring test.
      const q = query.toLowerCase();
      return ALL_OPTIONS.filter(
        (o) => o.title.toLowerCase().includes(q) || o.keywords.some((k) => k.toLowerCase().includes(q))
      );
    }
    return ALL_OPTIONS.filter((o) => rx.test(o.title) || o.keywords.some((k) => rx.test(k)));
  }, [ALL_OPTIONS, query]);

  const onSelectOption = useCallback(
    (
      option: ComponentPickerOption,
      nodeToRemove: TextNode | null,
      closeMenu: () => void,
      _matchingString: string
    ) => {
      editor.update(() => {
        // remove the "/query" trigger text node before running the action.
        if (nodeToRemove) nodeToRemove.remove();
      });
      closeMenu();
      option.onSelect();
    },
    [editor]
  );

  // Dropdown UI for the "/" typeahead block picker.
  const renderMenu = useCallback<MenuRenderFn<ComponentPickerOption>>(
    (anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex, options: opts }) =>
      anchorRef.current
        ? createPortal(
            <div className="max-h-[320px] w-[238px] overflow-y-auto rounded-xl border border-line bg-panel py-1 shadow-xl">
              {opts.length === 0 ? (
                <div className="px-3 py-2 text-[13px] text-muted">没有匹配的块</div>
              ) : (
                opts.map((opt, i) => (
                  <button
                    key={opt.key}
                    ref={(el) => opt.setRefElement(el)}
                    role="option"
                    type="button"
                    aria-selected={selectedIndex === i}
                    tabIndex={-1}
                    onMouseEnter={() => setHighlightedIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setHighlightedIndex(i);
                      selectOptionAndCleanUp(opt);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] transition",
                      selectedIndex === i
                        ? "bg-[#6d5ae6]/10 text-accent"
                        : "text-ink hover:bg-[#6d5ae6]/10"
                    )}
                  >
                    <span className={cn(selectedIndex === i ? "text-accent" : "text-ink2")}>{opt.icon}</span>
                    <span>{opt.title}</span>
                  </button>
                ))
              )}
            </div>,
            anchorRef.current
          )
        : null,
    []
  );

  if (!mounted) return null;

  return (
    <>
      {promptCfg && <PromptDialog cfg={promptCfg} onClose={() => setPromptCfg(null)} />}
      {showTableDialog && (
        <InsertTableDialog
          onClose={() => setShowTableDialog(false)}
          onConfirm={(rows, columns) =>
            editor.dispatchCommand(INSERT_TABLE_COMMAND, {
              rows: String(rows),
              columns: String(columns),
              includeHeaders: { rows: true, columns: false },
            })
          }
        />
      )}
      {/* "/" typed anywhere → filterable block picker */}
      <LexicalTypeaheadMenuPlugin<ComponentPickerOption>
        onQueryChange={setQuery}
        onSelectOption={onSelectOption}
        triggerFn={triggerFn}
        options={options}
        menuRenderFn={renderMenu}
      />
    </>
  );
}
