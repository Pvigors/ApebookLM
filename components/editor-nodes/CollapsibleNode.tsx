// Collapsible block (aligned 1:1 with the Lexical playground "Collapsible" plugin).
//
// Three cooperating ElementNodes:
//   - CollapsibleContainerNode  -> renders <details data-open> and owns the open flag
//   - CollapsibleTitleNode      -> renders <summary> (the always-visible header row)
//   - CollapsibleContentNode    -> renders <div> wrapping the collapsible body
//
// The header chevron (▸ / ▾) is drawn via CSS (see app/globals.css `.Collapsible__*`
// classes) so the title stays a plain editable ElementNode whose children are real
// text/paragraph nodes — exactly like the playground.
//
// All three nodes round-trip through Lexical editor-state JSON (export/import) so
// notes that contain collapsibles persist correctly.
//
// NOTE: no "use client" here on purpose — this module is imported by a 'use client'
// editor component, and is also referenced from server code only for its types.

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $findMatchingParent,
  $insertNodeToNearestRoot,
  mergeRegister,
} from "@lexical/utils";
import {
  $createParagraphNode,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_LOW,
  DELETE_CHARACTER_COMMAND,
  ElementNode,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  createCommand,
  isHTMLElement,
} from "lexical";
import type {
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  EditorConfig,
  LexicalCommand,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  RangeSelection,
  SerializedElementNode,
  Spread,
} from "lexical";
import { useEffect } from "react";

/* ========================================================================== *
 *  Container node — <details>, owns the `open` boolean.
 * ========================================================================== */

type SerializedCollapsibleContainerNode = Spread<
  { open: boolean },
  SerializedElementNode
>;

// Tracks each <details> element's `toggle` handler so it can be removed if a
// node-destroy hook is wired up later. A WeakMap means entries vanish with the
// element when it is detached + GC'd, so this map itself never leaks.
const collapsibleToggleHandlers = new WeakMap<HTMLElement, () => void>();

function $convertDetailsElement(
  domNode: HTMLElement,
): DOMConversionOutput | null {
  const details = domNode as HTMLDetailsElement;
  const isOpen = details.open !== undefined ? details.open : true;
  const node = $createCollapsibleContainerNode(isOpen);
  return { node };
}

export class CollapsibleContainerNode extends ElementNode {
  __open: boolean;

  constructor(open: boolean, key?: NodeKey) {
    super(key);
    this.__open = open;
  }

  static getType(): string {
    return "collapsible-container";
  }

  static clone(node: CollapsibleContainerNode): CollapsibleContainerNode {
    return new CollapsibleContainerNode(node.__open, node.__key);
  }

  createDOM(config: EditorConfig, editor: LexicalEditor): HTMLElement {
    // <details> gives us native semantics + keyboard a11y. We intercept the
    // browser's default toggle so open-state lives in the editor state, then
    // re-render via setOpen — identical to the playground approach.
    const dom = document.createElement("details");
    dom.classList.add("Collapsible__container");
    dom.open = this.__open;
    // The toggle listener lives for the lifetime of this <details> element.
    // Because updateDOM() returns false, Lexical reuses (never recreates) the
    // element, so we never stack duplicate listeners; when the node is removed
    // the element is detached from the DOM and GC'd together with its listener.
    // We capture the handler so it can be explicitly removed if a node-destroy
    // hook is ever wired up. (Lexical ElementNode exposes no per-node destroy
    // callback today, so there is nothing cleaner to attach removal to.)
    const handleToggle = () => {
      const open = editor.getEditorState().read(() => this.getOpen());
      if (open !== dom.open) {
        editor.update(() => this.toggleOpen());
      }
    };
    dom.addEventListener("toggle", handleToggle);
    collapsibleToggleHandlers.set(dom, handleToggle);
    if (config.theme.collapsibleContainer) {
      dom.classList.add(config.theme.collapsibleContainer);
    }
    return dom;
  }

  updateDOM(prevNode: CollapsibleContainerNode, dom: HTMLDetailsElement): boolean {
    if (prevNode.__open !== this.__open) {
      dom.open = this.__open;
    }
    return false;
  }

  static importDOM(): DOMConversionMap | null {
    return {
      details: () => ({
        conversion: $convertDetailsElement,
        priority: 1,
      }),
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("details");
    element.classList.add("Collapsible__container");
    // `open` is an HTML *boolean* attribute: its mere presence means "open",
    // regardless of value — `open="false"` still parses as open. So only emit it
    // when actually open; otherwise a collapsed container round-trips through
    // HTML (copy/paste, export) as expanded.
    if (this.__open) element.setAttribute("open", "");
    return { element };
  }

  static importJSON(
    serializedNode: SerializedCollapsibleContainerNode,
  ): CollapsibleContainerNode {
    return $createCollapsibleContainerNode(serializedNode.open).updateFromJSON(
      serializedNode,
    );
  }

  exportJSON(): SerializedCollapsibleContainerNode {
    return {
      ...super.exportJSON(),
      type: "collapsible-container",
      version: 1,
      open: this.__open,
    };
  }

  setOpen(open: boolean): void {
    const writable = this.getWritable();
    writable.__open = open;
  }

  getOpen(): boolean {
    return this.getLatest().__open;
  }

  toggleOpen(): void {
    this.setOpen(!this.getOpen());
  }

  /** A container must always be `title` followed by `content`. */
  canBeEmpty(): false {
    return false;
  }

  isShadowRoot(): boolean {
    return false;
  }
}

export function $createCollapsibleContainerNode(
  isOpen: boolean,
): CollapsibleContainerNode {
  return new CollapsibleContainerNode(isOpen);
}

export function $isCollapsibleContainerNode(
  node: LexicalNode | null | undefined,
): node is CollapsibleContainerNode {
  return node instanceof CollapsibleContainerNode;
}

/* ========================================================================== *
 *  Title node — <summary>, the clickable header row.
 * ========================================================================== */

type SerializedCollapsibleTitleNode = SerializedElementNode;

export class CollapsibleTitleNode extends ElementNode {
  static getType(): string {
    return "collapsible-title";
  }

  static clone(node: CollapsibleTitleNode): CollapsibleTitleNode {
    return new CollapsibleTitleNode(node.__key);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = document.createElement("summary");
    dom.classList.add("Collapsible__title");
    if (config.theme.collapsibleTitle) {
      dom.classList.add(config.theme.collapsibleTitle);
    }
    return dom;
  }

  updateDOM(): boolean {
    return false;
  }

  static importDOM(): DOMConversionMap | null {
    return {
      summary: () => ({
        conversion: $convertSummaryElement,
        priority: 1,
      }),
    };
  }

  static importJSON(
    serializedNode: SerializedCollapsibleTitleNode,
  ): CollapsibleTitleNode {
    return $createCollapsibleTitleNode().updateFromJSON(serializedNode);
  }

  exportJSON(): SerializedCollapsibleTitleNode {
    return {
      ...super.exportJSON(),
      type: "collapsible-title",
      version: 1,
    };
  }

  collapseAtStart(_selection: RangeSelection): boolean {
    // Backspace at the very start of the title dissolves the whole collapsible
    // into plain blocks (the title's blocks, then the content's blocks) in place
    // of the container — instead of the naive "rip the <summary> out of the
    // <details>", which stranded a headless, un-collapsible husk that persisted
    // into the saved JSON. No content is lost.
    const container = this.getParentOrThrow();
    if (!$isCollapsibleContainerNode(container)) {
      container.insertBefore(this);
      return true;
    }
    const content = this.getNextSibling();
    let firstLifted: LexicalNode | null = null;
    for (const child of this.getChildren()) {
      container.insertBefore(child);
      firstLifted ??= child;
    }
    if ($isCollapsibleContentNode(content)) {
      for (const child of content.getChildren()) {
        container.insertBefore(child);
        firstLifted ??= child;
      }
    }
    container.remove();
    if ($isElementNode(firstLifted)) firstLifted.selectStart();
    return true;
  }

  /**
   * Enter inside the title moves the caret into the content area (playground
   * behaviour) instead of splitting the summary into two summaries.
   */
  insertNewAfter(_: RangeSelection, restoreSelection = true): ElementNode {
    const containerNode = this.getParentOrThrow();

    if (!$isCollapsibleContainerNode(containerNode)) {
      throw new Error(
        "CollapsibleTitleNode expects to be child of CollapsibleContainerNode",
      );
    }

    if (containerNode.getOpen()) {
      const contentNode = this.getNextSibling();
      if (!$isCollapsibleContentNode(contentNode)) {
        throw new Error(
          "CollapsibleTitleNode expects to have CollapsibleContentNode sibling",
        );
      }

      const firstChild = contentNode.getFirstChild();
      if ($isElementNode(firstChild)) {
        return firstChild;
      }
      const paragraph = $createParagraphNode();
      contentNode.append(paragraph);
      return paragraph;
    }

    // Collapsed: Enter creates a sibling paragraph after the whole container.
    const paragraph = $createParagraphNode();
    containerNode.insertAfter(paragraph, restoreSelection);
    return paragraph;
  }
}

function $convertSummaryElement(): DOMConversionOutput | null {
  const node = $createCollapsibleTitleNode();
  return { node };
}

export function $createCollapsibleTitleNode(): CollapsibleTitleNode {
  return new CollapsibleTitleNode();
}

export function $isCollapsibleTitleNode(
  node: LexicalNode | null | undefined,
): node is CollapsibleTitleNode {
  return node instanceof CollapsibleTitleNode;
}

/* ========================================================================== *
 *  Content node — <div>, the body that gets hidden when collapsed.
 * ========================================================================== */

type SerializedCollapsibleContentNode = SerializedElementNode;

export class CollapsibleContentNode extends ElementNode {
  static getType(): string {
    return "collapsible-content";
  }

  static clone(node: CollapsibleContentNode): CollapsibleContentNode {
    return new CollapsibleContentNode(node.__key);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = document.createElement("div");
    dom.classList.add("Collapsible__content");
    if (config.theme.collapsibleContent) {
      dom.classList.add(config.theme.collapsibleContent);
    }
    return dom;
  }

  updateDOM(): boolean {
    return false;
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute("data-lexical-collapsible-content")) {
          return null;
        }
        return {
          conversion: $convertCollapsibleContentElement,
          priority: 2,
        };
      },
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("div");
    element.classList.add("Collapsible__content");
    element.setAttribute("data-lexical-collapsible-content", "true");
    return { element };
  }

  static importJSON(
    serializedNode: SerializedCollapsibleContentNode,
  ): CollapsibleContentNode {
    return $createCollapsibleContentNode().updateFromJSON(serializedNode);
  }

  exportJSON(): SerializedCollapsibleContentNode {
    return {
      ...super.exportJSON(),
      type: "collapsible-content",
      version: 1,
    };
  }

  isShadowRoot(): boolean {
    return true;
  }
}

function $convertCollapsibleContentElement(): DOMConversionOutput | null {
  const node = $createCollapsibleContentNode();
  return { node };
}

export function $createCollapsibleContentNode(): CollapsibleContentNode {
  return new CollapsibleContentNode();
}

export function $isCollapsibleContentNode(
  node: LexicalNode | null | undefined,
): node is CollapsibleContentNode {
  return node instanceof CollapsibleContentNode;
}

/* ========================================================================== *
 *  Plugin + command.
 * ========================================================================== */

export const INSERT_COLLAPSIBLE_COMMAND: LexicalCommand<void> = createCommand(
  "INSERT_COLLAPSIBLE_COMMAND",
);

export function CollapsiblePlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (
      !editor.hasNodes([
        CollapsibleContainerNode,
        CollapsibleTitleNode,
        CollapsibleContentNode,
      ])
    ) {
      throw new Error(
        "CollapsiblePlugin: CollapsibleContainerNode, CollapsibleTitleNode, or CollapsibleContentNode is not registered on editor",
      );
    }

    return mergeRegister(
      // Structural guard: a container must always be exactly
      // [title, content]. If the content node loses all of its children we
      // re-seed an empty paragraph so the body stays editable.
      editor.registerNodeTransform(CollapsibleContentNode, (node) => {
        if (node.isEmpty()) {
          node.append($createParagraphNode());
        }
      }),

      // Structural guard for the container itself: it must be exactly
      // [title, content]. Some edits break that invariant — most notably
      // Backspace at the start of the title, whose collapseAtStart() moves the
      // <summary> out of the container, leaving a headless [content]-only
      // container plus an orphaned title at the root. When the shape is illegal,
      // unwrap: lift every child out in order and drop the container. This
      // dissolves the collapsible into plain blocks instead of persisting a
      // corrupt <details> with no header. Mirrors the playground's
      // $onCollapsibleContainerNodeTransform.
      editor.registerNodeTransform(CollapsibleContainerNode, (node) => {
        const children = node.getChildren();
        if (
          children.length === 2 &&
          $isCollapsibleTitleNode(children[0]) &&
          $isCollapsibleContentNode(children[1])
        ) {
          return;
        }
        // Illegal shape — dissolve to plain blocks. Lift the INNER blocks out of
        // any title/content wrappers (not the wrappers themselves) so we never
        // strand an orphan <summary>/<content> node at the root.
        for (const child of children) {
          if ($isCollapsibleTitleNode(child) || $isCollapsibleContentNode(child)) {
            for (const grand of child.getChildren()) node.insertBefore(grand);
            child.remove();
          } else {
            node.insertBefore(child);
          }
        }
        node.remove();
      }),

      // Backspace at the start of a paragraph that directly follows a COLLAPSED
      // collapsible: swallow it. Without this, the core deleteCharacter would
      // merge the paragraph's text backwards into the container's hidden content
      // node — the text silently vanishes into the collapsed body. Returning true
      // blocks that merge (matches the playground). (An OPEN container falls
      // through to normal editing.)
      editor.registerCommand(
        DELETE_CHARACTER_COMMAND,
        () => {
          const selection = $getSelection();
          if (
            !$isRangeSelection(selection) ||
            !selection.isCollapsed() ||
            selection.anchor.offset !== 0
          ) {
            return false;
          }

          const anchorNode = selection.anchor.getNode();
          const topLevelElement = anchorNode.getTopLevelElement();
          if (topLevelElement === null) {
            return false;
          }

          const container = topLevelElement.getPreviousSibling();
          if (
            !$isCollapsibleContainerNode(container) ||
            container.getOpen()
          ) {
            return false;
          }
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),

      // ArrowDown out of the last line of an OPEN collapsible's content moves
      // the caret to whatever follows the container (so you're never trapped).
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        () => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            return false;
          }

          const container = $findMatchingParent(
            selection.anchor.getNode(),
            $isCollapsibleContainerNode,
          );
          if (container === null) {
            return false;
          }

          const parent = container.getParent();
          if (
            parent !== null &&
            parent.getLastChild() === container &&
            $isRootOrShadowRoot(parent)
          ) {
            container.insertAfter($createParagraphNode());
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),

      // Enter pressed directly on the container (rare: caret between title and
      // content) inserts a paragraph after it.
      editor.registerCommand(
        INSERT_PARAGRAPH_COMMAND,
        () => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return false;
          }
          const titleNode = $findMatchingParent(
            selection.anchor.getNode(),
            (node) => $isCollapsibleTitleNode(node),
          );

          if ($isCollapsibleTitleNode(titleNode)) {
            const container = titleNode.getParent();
            if (container && $isCollapsibleContainerNode(container)) {
              if (!container.getOpen()) {
                container.toggleOpen();
              }
              titleNode.getNextSibling()?.selectStart();
              return true;
            }
          }

          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),

      // The actual insert command: container > [title(empty paragraph-ish), content(empty paragraph)].
      editor.registerCommand(
        INSERT_COLLAPSIBLE_COMMAND,
        () => {
          // registerCommand callbacks already run inside an editor.update, so no
          // inner editor.update() wrapper is needed (per the Commands doc).
          const title = $createCollapsibleTitleNode();
          const paragraph = $createParagraphNode();
          const container = $createCollapsibleContainerNode(true).append(
            title,
            $createCollapsibleContentNode().append($createParagraphNode()),
          );
          $insertNodeToNearestRoot(container);
          // Put the caret in the (empty) title so the user types the heading first.
          title.append(paragraph);
          paragraph.selectStart();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor]);

  return null;
}

/* ========================================================================== *
 *  Small helper used by importDOM type narrowing.
 * ========================================================================== */

export function $isCollapsibleDOMNode(node: Node): node is HTMLElement {
  return isHTMLElement(node);
}
