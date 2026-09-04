// PageBreakNode — a block-level "page break" marker, 1:1 with lexical playground.
// NOTE: no "use client" here on purpose; this file is imported by a 'use client'
// component (RichNoteEditor.tsx). It renders a centered horizontal divider with a
// small "分页符" label. Purely a visual separator on screen; it indicates a forced
// page break for print/export. The decorated element is not editable but is
// selectable (so it can be deleted with Backspace/Delete) and shows a focus ring
// when it is the active node-selection target.

import type { JSX } from "react";
import { useCallback, useEffect } from "react";

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import { mergeRegister } from "@lexical/utils";
import {
  $applyNodeReplacement,
  $getNodeByKey,
  $getSelection,
  $insertNodes,
  $isNodeSelection,
  $isRootOrShadowRoot,
  CLICK_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  createCommand,
} from "lexical";
import type {
  DOMConversionMap,
  DOMConversionOutput,
  EditorConfig,
  LexicalCommand,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
} from "lexical";

export type SerializedPageBreakNode = SerializedLexicalNode;

// Command to insert a page break at the current selection.
export const INSERT_PAGE_BREAK_COMMAND: LexicalCommand<void> = createCommand(
  "INSERT_PAGE_BREAK_COMMAND",
);

function PageBreakComponent({ nodeKey }: { nodeKey: NodeKey }): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);

  const onDelete = useCallback(
    (event: KeyboardEvent) => {
      const selection = $getSelection();
      if (isSelected && $isNodeSelection(selection)) {
        event.preventDefault();
        const node = $getNodeByKey(nodeKey);
        if ($isPageBreakNode(node)) {
          node.remove();
          return true;
        }
      }
      return false;
    },
    [isSelected, nodeKey],
  );

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        CLICK_COMMAND,
        (event: MouseEvent) => {
          const pbElem = editor.getElementByKey(nodeKey);
          if (event.target === pbElem || pbElem?.contains(event.target as Node)) {
            if (!event.shiftKey) {
              clearSelection();
            }
            setSelected(!isSelected);
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(KEY_DELETE_COMMAND, onDelete, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_BACKSPACE_COMMAND, onDelete, COMMAND_PRIORITY_LOW),
    );
  }, [clearSelection, editor, isSelected, nodeKey, onDelete, setSelected]);

  return (
    <div
      data-page-break-selected={isSelected ? "true" : undefined}
      className={[
        "group relative my-3 flex select-none items-center gap-3 rounded-lg px-1 py-1.5 outline-none transition-colors",
        isSelected ? "bg-accentSoft ring-2 ring-accent" : "hover:bg-panel2",
      ].join(" ")}
    >
      <span className="h-px flex-1 border-t border-dashed border-edge" aria-hidden="true" />
      <span
        className={[
          "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide",
          isSelected
            ? "border-accent bg-panel text-accent"
            : "border-edge bg-panel text-muted group-hover:text-ink2",
        ].join(" ")}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          className="shrink-0"
        >
          {/* document / page-break glyph */}
          <path
            d="M3.5 1.5h6L13 5v3.25H3.5V1.5Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M9.25 1.5V5H13" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <path
            d="M3.5 14.5h6L13 11"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
            opacity="0.55"
          />
          <path d="M1.25 9.75h13.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.6" />
        </svg>
        分页符
      </span>
      <span className="h-px flex-1 border-t border-dashed border-edge" aria-hidden="true" />
    </div>
  );
}

export class PageBreakNode extends DecoratorNode<JSX.Element> {
  static getType(): string {
    return "page-break";
  }

  static clone(node: PageBreakNode): PageBreakNode {
    return new PageBreakNode(node.__key);
  }

  static importJSON(serializedNode: SerializedPageBreakNode): PageBreakNode {
    return $createPageBreakNode().updateFromJSON(serializedNode);
  }

  static importDOM(): DOMConversionMap | null {
    return {
      figure: (domNode: HTMLElement) => {
        const type = domNode.getAttribute("type");
        if (type !== "page-break") {
          return null;
        }
        return {
          conversion: $convertPageBreakElement,
          priority: 4 as const,
        };
      },
    };
  }

  exportJSON(): SerializedPageBreakNode {
    return {
      ...super.exportJSON(),
      type: "page-break",
      version: 1,
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const el = document.createElement("figure");
    el.style.pageBreakAfter = "always";
    el.setAttribute("type", "page-break");
    const className = config.theme.pageBreak;
    if (typeof className === "string") {
      el.className = className;
    }
    return el;
  }

  updateDOM(): false {
    return false;
  }

  // Layout-only wrapper; the React decoration carries the visible UI.
  getTextContent(): string {
    return "\n";
  }

  isInline(): false {
    return false;
  }

  decorate(): JSX.Element {
    return <PageBreakComponent nodeKey={this.__key} />;
  }
}

function $convertPageBreakElement(): DOMConversionOutput {
  return { node: $createPageBreakNode() };
}

export function $createPageBreakNode(): PageBreakNode {
  return $applyNodeReplacement(new PageBreakNode());
}

export function $isPageBreakNode(
  node: LexicalNode | null | undefined,
): node is PageBreakNode {
  return node instanceof PageBreakNode;
}

// Plugin: registers INSERT_PAGE_BREAK_COMMAND. Mount inside <LexicalComposer>.
export function PageBreakPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor.hasNodes([PageBreakNode])) {
      throw new Error("PageBreakPlugin: PageBreakNode is not registered on the editor");
    }

    return editor.registerCommand(
      INSERT_PAGE_BREAK_COMMAND,
      () => {
        const pageBreakNode = $createPageBreakNode();
        $insertNodes([pageBreakNode]);
        // If we inserted directly under the root/shadow-root the page break has
        // no following block to land the caret in, so create one by selecting
        // the next sibling (Lexical inserts a trailing paragraph as needed).
        const parent = pageBreakNode.getParentOrThrow();
        if ($isRootOrShadowRoot(parent)) {
          pageBreakNode.selectNext();
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  return null;
}

// Helper to wire a toolbar/menu button: dispatches the insert command.
export function $insertPageBreak(editor: LexicalEditor): void {
  editor.dispatchCommand(INSERT_PAGE_BREAK_COMMAND, undefined);
}
