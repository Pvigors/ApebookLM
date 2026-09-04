"use client";

// Floating text-format toolbar — appears above a non-empty text selection with
// quick formatting (bold/italic/underline/strikethrough/sub/superscript/
// upper·lower·capitalize/code/link), aligned with the Lexical playground's
// FloatingTextFormatToolbarPlugin. Rendered into <body> with fixed positioning
// + a high z-index so it floats above the note-editor Modal.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import { $isAtNodeEnd } from "@lexical/selection";
import { $isLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type ElementNode,
  type LexicalEditor,
  type RangeSelection,
  type TextFormatType,
  type TextNode,
} from "lexical";

function getSelectedNode(selection: RangeSelection): TextNode | ElementNode {
  const anchorNode = selection.anchor.getNode();
  const focusNode = selection.focus.getNode();
  if (anchorNode === focusNode) return anchorNode;
  return selection.isBackward()
    ? $isAtNodeEnd(selection.focus)
      ? anchorNode
      : focusNode
    : $isAtNodeEnd(selection.anchor)
      ? anchorNode
      : focusNode;
}

interface Formats {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  subscript: boolean;
  superscript: boolean;
  uppercase: boolean;
  lowercase: boolean;
  capitalize: boolean;
  code: boolean;
  link: boolean;
}

const Sub = (
  <span className="leading-none">
    X<sub className="text-[0.7em]">2</sub>
  </span>
);
const Sup = (
  <span className="leading-none">
    X<sup className="text-[0.7em]">2</sup>
  </span>
);

// [format key, button label, tooltip]
const BUTTONS: Array<[TextFormatType, ReactNode, string]> = [
  ["bold", <b key="b">B</b>, "粗体"],
  ["italic", <i key="i">I</i>, "斜体"],
  ["underline", <span key="u" className="underline">U</span>, "下划线"],
  ["strikethrough", <span key="s" className="line-through">S</span>, "删除线"],
  ["subscript", Sub, "下标"],
  ["superscript", Sup, "上标"],
  ["uppercase", <span key="up" className="text-[12px] font-semibold tracking-tight">ABC</span>, "大写"],
  ["lowercase", <span key="lo" className="text-[12px] font-semibold tracking-tight">abc</span>, "小写"],
  ["capitalize", <span key="ca" className="text-[13px] font-semibold">Tt</span>, "首字母大写"],
  ["code", <span key="co" className="font-mono text-[13px]">{"<>"}</span>, "行内代码"],
];

function Toolbar({
  editor,
  rect,
  formats,
}: {
  editor: LexicalEditor;
  rect: DOMRect;
  formats: Formats;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

  // Position above the selection (flip below when there's no room), centered &
  // clamped to the viewport. useLayoutEffect → no flash before placement.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    let top = rect.top - r.height - gap;
    if (top < 8) top = rect.bottom + gap;
    let left = rect.left + rect.width / 2 - r.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
    setPos({ top: Math.round(top), left: Math.round(left) });
  }, [rect]);

  const toggle = (f: TextFormatType) => editor.dispatchCommand(FORMAT_TEXT_COMMAND, f);

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="文字格式"
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 1000 }}
      className="flex items-center gap-0.5 rounded-xl border border-line bg-panel px-1.5 py-1 shadow-xl"
    >
      {BUTTONS.map(([key, label, title]) => (
        <button
          key={key}
          type="button"
          title={title}
          aria-pressed={formats[key as keyof Formats]}
          onClick={() => toggle(key)}
          className={`grid h-8 min-w-[32px] place-items-center rounded-lg px-1.5 text-[15px] transition ${
            formats[key as keyof Formats] ? "bg-[#6d5ae6]/12 text-accent" : "text-ink2 hover:bg-panel2 hover:text-ink"
          }`}
        >
          {label}
        </button>
      ))}
      <span className="mx-0.5 h-5 w-px bg-edge" />
      <button
        type="button"
        title={formats.link ? "移除链接" : "插入链接"}
        aria-pressed={formats.link}
        onClick={() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, formats.link ? null : "https://")}
        className={`grid h-8 min-w-[32px] place-items-center rounded-lg px-1.5 transition ${
          formats.link ? "bg-[#6d5ae6]/12 text-accent" : "text-ink2 hover:bg-panel2 hover:text-ink"
        }`}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 17H7A5 5 0 0 1 7 7h2" />
          <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
          <line x1="8" x2="16" y1="12" y2="12" />
        </svg>
      </button>
    </div>
  );
}

export default function FloatingTextFormatToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [show, setShow] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [formats, setFormats] = useState<Formats>({
    bold: false, italic: false, underline: false, strikethrough: false,
    subscript: false, superscript: false, uppercase: false, lowercase: false,
    capitalize: false, code: false, link: false,
  });

  const update = useCallback(() => {
    try {
    editor.getEditorState().read(() => {
      if (editor.isComposing()) {
        setShow(false);
        return;
      }
      const selection = $getSelection();
      const native = window.getSelection();
      const root = editor.getRootElement();
      if (
        !$isRangeSelection(selection) ||
        selection.isCollapsed() ||
        native === null ||
        native.isCollapsed ||
        native.rangeCount === 0 ||
        root === null ||
        !root.contains(native.anchorNode)
      ) {
        setShow(false);
        return;
      }
      if (selection.getTextContent().replace(/\n/g, "") === "") {
        setShow(false);
        return;
      }
      const node = getSelectedNode(selection);
      const parent = node.getParent();
      setFormats({
        bold: selection.hasFormat("bold"),
        italic: selection.hasFormat("italic"),
        underline: selection.hasFormat("underline"),
        strikethrough: selection.hasFormat("strikethrough"),
        subscript: selection.hasFormat("subscript"),
        superscript: selection.hasFormat("superscript"),
        uppercase: selection.hasFormat("uppercase"),
        lowercase: selection.hasFormat("lowercase"),
        capitalize: selection.hasFormat("capitalize"),
        code: selection.hasFormat("code"),
        link: $isLinkNode(parent) || $isLinkNode(node),
      });
      setRect(native.getRangeAt(0).getBoundingClientRect());
      setShow(true);
    });
    } catch {
      // Reading arbitrary selection state runs on every selectionchange/scroll —
      // never let an edge case throw and take the whole editor down; just hide.
      setShow(false);
    }
  }, [editor]);

  useEffect(() => {
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [update]);

  useEffect(() => mergeRegister(editor.registerUpdateListener(() => update())), [editor, update]);

  useEffect(() => {
    const on = () => update();
    window.addEventListener("resize", on);
    // capture: also catch the editor's inner scroll container
    document.addEventListener("scroll", on, true);
    return () => {
      window.removeEventListener("resize", on);
      document.removeEventListener("scroll", on, true);
    };
  }, [update]);

  if (!show || rect === null) return null;
  return createPortal(<Toolbar editor={editor} rect={rect} formats={formats} />, document.body);
}
