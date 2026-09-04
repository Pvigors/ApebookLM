// StickyNode — a draggable sticky-note, aligned 1:1 with the Lexical playground
// "Sticky" plugin (see playground StickyNode / StickyComponent).
//
// A sticky is a DecoratorNode that floats an absolutely-positioned note card
// next to the place it was inserted. It carries four pieces of state that all
// round-trip through editor-state JSON:
//   - x, y    : offset (px) relative to the inline anchor where the node lives
//   - color   : "yellow" | "pink" (toggled via the swatch button)
//   - content : the (plain) text written on the note
//
// Interactions implemented (all from the playground):
//   - DRAG    : grab the note (pointer events) to reposition; x/y persist to state
//   - EDIT    : type into the note (a textarea); content persists to state
//   - RECOLOR : the round swatch flips yellow <-> pink
//   - DELETE  : the × button removes the node
//
// The card uses the project's light-theme tokens for chrome (border-edge,
// text-ink, ring-accent, elev-soft) while keeping the classic warm sticky fill
// + soft shadow + slight rotation so it still reads as a "sticky".
//
// NOTE: no "use client" here on purpose — this module is imported by a
// 'use client' editor component (RichNoteEditor.tsx). The decorate() output is a
// client React component and may use hooks; the node class itself is isomorphic.

import type { ChangeEvent, JSX, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import {
  $applyNodeReplacement,
  $getNodeByKey,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  DecoratorNode,
  createCommand,
} from "lexical";
import type {
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  EditorConfig,
  LexicalCommand,
  LexicalEditor,
  LexicalNode,
  LexicalUpdateJSON,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from "lexical";

/* ========================================================================== *
 *  Types
 * ========================================================================== */

export type StickyColor = "yellow" | "pink";

export type SerializedStickyNode = Spread<
  {
    x: number;
    y: number;
    color: StickyColor;
    content: string;
  },
  SerializedLexicalNode
>;

/** Payload accepted by INSERT_STICKY_COMMAND — everything is optional. */
export type InsertStickyPayload = {
  x?: number;
  y?: number;
  color?: StickyColor;
  content?: string;
};

const DEFAULT_X = 0;
const DEFAULT_Y = 0;
const DEFAULT_COLOR: StickyColor = "yellow";

function normalizeColor(value: unknown): StickyColor {
  return value === "pink" ? "pink" : "yellow";
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/* ========================================================================== *
 *  Decoration component
 * ========================================================================== */

const COLOR_STYLES: Record<
  StickyColor,
  { card: string; tab: string; nextLabel: string }
> = {
  yellow: {
    // warm sticky-yellow fill + matching hairline
    card: "bg-[#fff7c2] border-[#f3e08a]",
    tab: "bg-[#ffe9a8]",
    nextLabel: "粉色",
  },
  pink: {
    card: "bg-[#ffd8ea] border-[#f4b6d4]",
    tab: "bg-[#ffc4e0]",
    nextLabel: "黄色",
  },
};

type StickyComponentProps = {
  nodeKey: NodeKey;
  x: number;
  y: number;
  color: StickyColor;
  content: string;
};

function StickyComponent({
  nodeKey,
  x,
  y,
  color,
  content,
}: StickyComponentProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const isEditable = useEditable(editor);
  const stickyRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  // Local drag offset so the card tracks the pointer at 60fps without writing to
  // the editor state on every move; the final position is committed on release.
  const [position, setPosition] = useState<{ x: number; y: number }>({ x, y });
  const [isDragging, setIsDragging] = useState(false);

  // Keep local position in sync when the node state changes externally
  // (e.g. undo/redo, collaborative edits, JSON re-hydration).
  useEffect(() => {
    setPosition({ x, y });
  }, [x, y]);

  // Drag bookkeeping kept in a ref so the move/up listeners read fresh values
  // without re-binding on every render.
  const dragState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const state = dragState.current;
    if (!state || event.pointerId !== state.pointerId) {
      return;
    }
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    setPosition({ x: state.originX + dx, y: state.originY + dy });
  }, []);

  const commitPosition = useCallback(
    (next: { x: number; y: number }) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isStickyNode(node)) {
          node.setPosition(next.x, next.y);
        }
      });
    },
    [editor, nodeKey],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent) => {
      const state = dragState.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      const next = { x: state.originX + dx, y: state.originY + dy };
      dragState.current = null;
      setIsDragging(false);
      setPosition(next);
      commitPosition(next);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    },
    [commitPosition, handlePointerMove],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // No dragging in read-only mode.
      if (!isEditable) {
        return;
      }
      // Only start a drag from the grab handle / card chrome, never from the
      // textarea or the action buttons (those stop propagation themselves).
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      dragState.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: position.x,
        originY: position.y,
      };
      setIsDragging(true);
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [isEditable, handlePointerMove, handlePointerUp, position.x, position.y],
  );

  // Clean up window listeners if we unmount mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [handlePointerMove, handlePointerUp]);

  const handleDelete = useCallback(() => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isStickyNode(node)) {
        node.remove();
      }
    });
  }, [editor, nodeKey]);

  const handleToggleColor = useCallback(() => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isStickyNode(node)) {
        node.toggleColor();
      }
    });
  }, [editor, nodeKey]);

  const handleContentChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isStickyNode(node)) {
          node.setContent(value);
        }
      });
    },
    [editor, nodeKey],
  );

  // Auto-grow the textarea to fit its content (playground sticky behaviour).
  useLayoutEffect(() => {
    const el = textAreaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [content]);

  const colorStyle = COLOR_STYLES[color];

  return (
    // Outer wrapper occupies no layout space but anchors the absolutely-
    // positioned card; relative so the card's offsets are local to this point.
    <div className="relative inline-block select-none align-top">
      <div
        ref={stickyRef}
        data-sticky-color={color}
        className={[
          "absolute z-10 flex w-60 flex-col gap-2 rounded-2xl border p-3 text-ink shadow-[0_8px_24px_rgba(31,32,36,0.16)] elev-soft transition-shadow",
          colorStyle.card,
          !isEditable
            ? "-rotate-1 cursor-default"
            : isDragging
              ? "rotate-0 cursor-grabbing shadow-[0_16px_36px_rgba(31,32,36,0.24)]"
              : "-rotate-1 cursor-grab hover:shadow-[0_12px_30px_rgba(31,32,36,0.2)]",
        ].join(" ")}
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
          touchAction: "none",
        }}
        onPointerDown={handlePointerDown}
        role="note"
        aria-label="便签"
      >
        {/* Header row: drag affordance (left) + actions (right) */}
        <div className="flex items-center justify-between">
          <span
            aria-hidden="true"
            className={[
              "flex h-5 w-10 items-center justify-center gap-[3px] rounded-full",
              colorStyle.tab,
            ].join(" ")}
            title="拖动便签"
          >
            <span className="h-[3px] w-[3px] rounded-full bg-ink/35" />
            <span className="h-[3px] w-[3px] rounded-full bg-ink/35" />
            <span className="h-[3px] w-[3px] rounded-full bg-ink/35" />
          </span>

          {isEditable ? (
            <div className="flex items-center gap-1.5">
              {/* Recolor swatch */}
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={handleToggleColor}
                title={`换成${colorStyle.nextLabel}`}
                aria-label={`换成${colorStyle.nextLabel}`}
                className="flex h-6 w-6 items-center justify-center rounded-full border border-ink/15 bg-panel/70 text-ink2 transition-colors hover:bg-panel hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span
                  className={[
                    "h-3 w-3 rounded-full border",
                    color === "yellow"
                      ? "border-[#e9b8d2] bg-[#ffc4e0]"
                      : "border-[#e7d27a] bg-[#ffe9a8]",
                  ].join(" ")}
                />
              </button>

              {/* Delete */}
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={handleDelete}
                title="删除便签"
                aria-label="删除便签"
                className="flex h-6 w-6 items-center justify-center rounded-full border border-ink/15 bg-panel/70 text-ink2 transition-colors hover:bg-panel hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          ) : (
            <span aria-hidden />
          )}
        </div>

        {/* Editable note body */}
        <textarea
          ref={textAreaRef}
          name="sticky-content"
          autoComplete="off"
          value={content}
          onChange={handleContentChange}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="写点什么…"
          spellCheck={false}
          rows={3}
          readOnly={!isEditable}
          className={[
            "w-full resize-none bg-transparent text-sm leading-relaxed text-ink outline-none placeholder:text-ink/40",
            isEditable ? "cursor-text" : "cursor-default",
          ].join(" ")}
        />
      </div>
    </div>
  );
}

/* ========================================================================== *
 *  Node
 * ========================================================================== */

export class StickyNode extends DecoratorNode<JSX.Element> {
  __x: number;
  __y: number;
  __color: StickyColor;
  __content: string;

  static getType(): string {
    return "sticky";
  }

  static clone(node: StickyNode): StickyNode {
    return new StickyNode(node.__x, node.__y, node.__color, node.__content, node.__key);
  }

  constructor(
    x: number = DEFAULT_X,
    y: number = DEFAULT_Y,
    color: StickyColor = DEFAULT_COLOR,
    content: string = "",
    key?: NodeKey,
  ) {
    super(key);
    this.__x = x;
    this.__y = y;
    this.__color = color;
    this.__content = content;
  }

  static importJSON(serializedNode: SerializedStickyNode): StickyNode {
    const { x, y, color, content } = serializedNode;
    return $createStickyNode({
      x: toFiniteNumber(x, DEFAULT_X),
      y: toFiniteNumber(y, DEFAULT_Y),
      color: normalizeColor(color),
      content: typeof content === "string" ? content : "",
    }).updateFromJSON(serializedNode);
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedStickyNode>): this {
    return super.updateFromJSON(serializedNode);
  }

  exportJSON(): SerializedStickyNode {
    return {
      ...super.exportJSON(),
      type: "sticky",
      version: 1,
      x: this.__x,
      y: this.__y,
      color: this.__color,
      content: this.__content,
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute("data-lexical-sticky")) {
          return null;
        }
        return {
          conversion: $convertStickyElement,
          priority: 2,
        };
      },
    };
  }

  // Export the full sticky state to HTML so copy/paste round-trips. The
  // attribute names here MUST match what $convertStickyElement reads back
  // (data-x / data-y / data-color / data-content), and the element MUST be a
  // <div data-lexical-sticky> so importDOM's `div` matcher picks it up.
  exportDOM(): DOMExportOutput {
    const element = document.createElement("div");
    element.setAttribute("data-lexical-sticky", "true");
    element.setAttribute("data-x", String(this.__x));
    element.setAttribute("data-y", String(this.__y));
    element.setAttribute("data-color", this.__color);
    element.setAttribute("data-content", this.__content);
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.setAttribute("data-lexical-sticky", "true");
    span.style.display = "inline-block";
    const className = config.theme.sticky;
    if (typeof className === "string") {
      span.className = className;
    }
    return span;
  }

  updateDOM(): false {
    return false;
  }

  // Sticky lives at an inline anchor so it can float beside flowing text without
  // reserving a block of its own — mirrors the playground's inline placement.
  isInline(): true {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return false;
  }

  getTextContent(): string {
    return this.__content;
  }

  // ---- mutators -----------------------------------------------------------

  setPosition(x: number, y: number): void {
    const self = this.getWritable();
    self.__x = x;
    self.__y = y;
  }

  getPosition(): { x: number; y: number } {
    const self = this.getLatest();
    return { x: self.__x, y: self.__y };
  }

  setColor(color: StickyColor): void {
    const self = this.getWritable();
    self.__color = color;
  }

  toggleColor(): void {
    const self = this.getWritable();
    self.__color = self.__color === "yellow" ? "pink" : "yellow";
  }

  getColor(): StickyColor {
    return this.getLatest().__color;
  }

  setContent(content: string): void {
    const self = this.getWritable();
    self.__content = content;
  }

  getContent(): string {
    return this.getLatest().__content;
  }

  // ---- decoration ---------------------------------------------------------

  decorate(): JSX.Element {
    return (
      <StickyComponent
        nodeKey={this.__key}
        x={this.__x}
        y={this.__y}
        color={this.__color}
        content={this.__content}
      />
    );
  }
}

function $convertStickyElement(domNode: HTMLElement): DOMConversionOutput | null {
  const x = Number(domNode.getAttribute("data-x"));
  const y = Number(domNode.getAttribute("data-y"));
  const color = normalizeColor(domNode.getAttribute("data-color"));
  const content = domNode.getAttribute("data-content") ?? domNode.textContent ?? "";
  return {
    node: $createStickyNode({
      x: Number.isFinite(x) ? x : DEFAULT_X,
      y: Number.isFinite(y) ? y : DEFAULT_Y,
      color,
      content,
    }),
  };
}

export function $createStickyNode(payload: InsertStickyPayload = {}): StickyNode {
  return $applyNodeReplacement(
    new StickyNode(
      toFiniteNumber(payload.x, DEFAULT_X),
      toFiniteNumber(payload.y, DEFAULT_Y),
      normalizeColor(payload.color ?? DEFAULT_COLOR),
      typeof payload.content === "string" ? payload.content : "",
    ),
  );
}

export function $isStickyNode(
  node: LexicalNode | null | undefined,
): node is StickyNode {
  return node instanceof StickyNode;
}

/* ---- track editor.isEditable() reactively (mirrors PollNode) ---- */

function useEditable(editor: LexicalEditor): boolean {
  const [editable, setEditable] = useState(() => editor.isEditable());
  useEffect(() => {
    setEditable(editor.isEditable());
    return editor.registerEditableListener((value) => setEditable(value));
  }, [editor]);
  return editable;
}

/* ========================================================================== *
 *  Command + plugin
 * ========================================================================== */

export const INSERT_STICKY_COMMAND: LexicalCommand<InsertStickyPayload | void> =
  createCommand("INSERT_STICKY_COMMAND");

export function StickyPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor.hasNodes([StickyNode])) {
      throw new Error("StickyPlugin: StickyNode is not registered on the editor");
    }

    return mergeRegister(
      editor.registerCommand<InsertStickyPayload | void>(
        INSERT_STICKY_COMMAND,
        (payload) => {
          const stickyNode = $createStickyNode(payload ?? {});
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertNodes([stickyNode]);
          } else {
            $insertNodes([stickyNode]);
          }
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  }, [editor]);

  return null;
}

/** Helper to wire a toolbar/menu button: inserts a default sticky note. */
export function $insertSticky(
  editor: LexicalEditor,
  payload: InsertStickyPayload = {},
): void {
  editor.dispatchCommand(INSERT_STICKY_COMMAND, payload);
}
