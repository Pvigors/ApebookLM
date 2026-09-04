// Columns Layout — 1:1 with the Lexical playground (Columns Layout).
//
// Two ElementNodes:
//   - LayoutContainerNode: renders as `display:grid`; `__templateColumns`
//     (e.g. "1fr 1fr") is stored on the node and applied to the DOM.
//   - LayoutItemNode: one column; a plain block container.
//
// Plus a `LayoutPlugin` React component and `INSERT_LAYOUT_COMMAND` /
// `UPDATE_LAYOUT_COMMAND` commands, mirroring the playground's plugin: it
// inserts a container with N empty columns, keeps the container's column count
// in sync with its template, removes orphaned/empty containers, and lets the
// arrow keys move the selection across column boundaries.
//
// NOTE: no "use client" here — this file is imported by a 'use client' tree.

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $findMatchingParent,
  $insertNodeToNearestRoot,
  mergeRegister,
} from "@lexical/utils";
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  createCommand,
  ElementNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
} from "lexical";
import type {
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  EditorConfig,
  LexicalCommand,
  LexicalNode,
  NodeKey,
  SerializedElementNode,
  Spread,
} from "lexical";

// ---------------------------------------------------------------------------
// LayoutContainerNode
// ---------------------------------------------------------------------------

export type SerializedLayoutContainerNode = Spread<
  { templateColumns: string },
  SerializedElementNode
>;

export class LayoutContainerNode extends ElementNode {
  __templateColumns: string;

  constructor(templateColumns: string, key?: NodeKey) {
    super(key);
    this.__templateColumns = templateColumns;
  }

  static getType(): string {
    return "layout-container";
  }

  static clone(node: LayoutContainerNode): LayoutContainerNode {
    return new LayoutContainerNode(node.__templateColumns, node.__key);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = document.createElement("div");
    dom.style.gridTemplateColumns = this.__templateColumns;
    dom.style.display = "grid";
    dom.style.gap = "0.75rem";
    dom.style.margin = "0.75rem 0";
    if (typeof config.theme.layoutContainer === "string") {
      dom.className = config.theme.layoutContainer;
    } else {
      dom.className = "my-3 grid gap-3";
    }
    return dom;
  }

  updateDOM(prevNode: LayoutContainerNode, dom: HTMLElement): boolean {
    if (prevNode.__templateColumns !== this.__templateColumns) {
      dom.style.gridTemplateColumns = this.__templateColumns;
    }
    return false;
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute("data-lexical-layout-container")) {
          return null;
        }
        return {
          conversion: $convertLayoutContainerElement,
          priority: 2,
        };
      },
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("div");
    element.setAttribute("data-lexical-layout-container", "true");
    element.style.display = "grid";
    element.style.gridTemplateColumns = this.__templateColumns;
    element.style.gap = "0.75rem";
    return { element };
  }

  static importJSON(json: SerializedLayoutContainerNode): LayoutContainerNode {
    return $createLayoutContainerNode(json.templateColumns).updateFromJSON(json);
  }

  updateFromJSON(json: SerializedLayoutContainerNode): this {
    return super.updateFromJSON(json).setTemplateColumns(json.templateColumns);
  }

  exportJSON(): SerializedLayoutContainerNode {
    return {
      ...super.exportJSON(),
      type: "layout-container",
      version: 1,
      templateColumns: this.__templateColumns,
    };
  }

  getTemplateColumns(): string {
    return this.getLatest().__templateColumns;
  }

  setTemplateColumns(templateColumns: string): this {
    const self = this.getWritable();
    self.__templateColumns = templateColumns;
    return self;
  }

  isShadowRoot(): boolean {
    return true;
  }

  canBeEmpty(): false {
    return false;
  }

  canIndent(): false {
    return false;
  }
}

function $convertLayoutContainerElement(domNode: HTMLElement): DOMConversionOutput {
  const styleColumns = domNode.style.gridTemplateColumns;
  const templateColumns = styleColumns && styleColumns.length > 0 ? styleColumns : "1fr 1fr";
  const node = $createLayoutContainerNode(templateColumns);
  return { node };
}

export function $createLayoutContainerNode(templateColumns: string): LayoutContainerNode {
  return $applyNodeReplacement(new LayoutContainerNode(templateColumns));
}

export function $isLayoutContainerNode(
  node: LexicalNode | null | undefined
): node is LayoutContainerNode {
  return node instanceof LayoutContainerNode;
}

// ---------------------------------------------------------------------------
// LayoutItemNode
// ---------------------------------------------------------------------------

export type SerializedLayoutItemNode = SerializedElementNode;

export class LayoutItemNode extends ElementNode {
  static getType(): string {
    return "layout-item";
  }

  static clone(node: LayoutItemNode): LayoutItemNode {
    return new LayoutItemNode(node.__key);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = document.createElement("div");
    if (typeof config.theme.layoutItem === "string") {
      dom.className = config.theme.layoutItem;
    } else {
      dom.className =
        "min-w-0 rounded-lg border border-edge bg-panel p-3 [&>*:last-child]:mb-0";
    }
    return dom;
  }

  updateDOM(): boolean {
    return false;
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute("data-lexical-layout-item")) {
          return null;
        }
        return {
          conversion: $convertLayoutItemElement,
          priority: 2,
        };
      },
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("div");
    element.setAttribute("data-lexical-layout-item", "true");
    return { element };
  }

  static importJSON(json: SerializedLayoutItemNode): LayoutItemNode {
    return $createLayoutItemNode().updateFromJSON(json);
  }

  exportJSON(): SerializedLayoutItemNode {
    return {
      ...super.exportJSON(),
      type: "layout-item",
      version: 1,
    };
  }

  isShadowRoot(): boolean {
    return true;
  }
}

function $convertLayoutItemElement(): DOMConversionOutput {
  return { node: $createLayoutItemNode() };
}

export function $createLayoutItemNode(): LayoutItemNode {
  return $applyNodeReplacement(new LayoutItemNode());
}

export function $isLayoutItemNode(
  node: LexicalNode | null | undefined
): node is LayoutItemNode {
  return node instanceof LayoutItemNode;
}

// ---------------------------------------------------------------------------
// Commands + Plugin
// ---------------------------------------------------------------------------

export const INSERT_LAYOUT_COMMAND: LexicalCommand<string> =
  createCommand<string>("INSERT_LAYOUT_COMMAND");

export const UPDATE_LAYOUT_COMMAND: LexicalCommand<{
  template: string;
  nodeKey: NodeKey;
}> = createCommand<{ template: string; nodeKey: NodeKey }>("UPDATE_LAYOUT_COMMAND");

export function LayoutPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor.hasNodes([LayoutContainerNode, LayoutItemNode])) {
      throw new Error(
        "LayoutPlugin: LayoutContainerNode, or LayoutItemNode not registered on editor"
      );
    }

    const $onEscape = (before: boolean): boolean => {
      const selection = $getSelection();
      if (
        $isRangeSelection(selection) &&
        selection.isCollapsed() &&
        selection.anchor.offset === 0
      ) {
        const container = $findMatchingParent(
          selection.anchor.getNode(),
          $isLayoutContainerNode
        );

        if ($isLayoutContainerNode(container)) {
          const parent = container.getParent();
          const child =
            parent &&
            (before ? parent.getFirstChild() : parent.getLastChild());
          const descendant = before
            ? container.getFirstDescendant()?.getKey()
            : container.getLastDescendant()?.getKey();

          if (
            parent !== null &&
            child === container &&
            selection.anchor.key === descendant
          ) {
            if (before) {
              container.insertBefore($createParagraphNode());
            } else {
              container.insertAfter($createParagraphNode());
            }
          }
        }
      }

      return false;
    };

    const $fillLayoutItemIfEmpty = (node: LayoutItemNode): void => {
      if (node.isEmpty()) {
        node.append($createParagraphNode());
      }
    };

    const $removeIsolatedLayoutItem = (node: LayoutItemNode): boolean => {
      const parent = node.getParent<ElementNode>();
      if (!$isLayoutContainerNode(parent)) {
        const children = node.getChildren<LexicalNode>();
        for (const child of children) {
          node.insertBefore(child);
        }
        node.remove();
        return true;
      }
      return false;
    };

    return mergeRegister(
      // Adjust the column count to match the template when a layout is
      // inserted or its template changes, and keep at least one paragraph
      // inside every column.
      editor.registerCommand(
        INSERT_LAYOUT_COMMAND,
        (template) => {
          // registerCommand callbacks already run inside an editor.update, so no
          // inner editor.update() wrapper is needed (per the Commands doc).
          const container = $createLayoutContainerNode(template);
          const itemsCount = getItemsCountFromTemplate(template);

          for (let i = 0; i < itemsCount; i++) {
            container.append(
              $createLayoutItemNode().append($createParagraphNode())
            );
          }

          const selection = $getSelection();
          $insertNodeToNearestRoot(container);
          if ($isRangeSelection(selection)) {
            container.selectStart();
          }
          return true;
        },
        COMMAND_PRIORITY_EDITOR
      ),
      editor.registerCommand(
        UPDATE_LAYOUT_COMMAND,
        ({ template, nodeKey }) => {
          // registerCommand callbacks already run inside an editor.update, so no
          // inner editor.update() wrapper is needed (per the Commands doc).
          const container = $getNodeByKey<LexicalNode>(nodeKey);
          if (!$isLayoutContainerNode(container)) {
            return true;
          }

          const itemsCount = getItemsCountFromTemplate(template);
          const prevItemsCount = getItemsCountFromTemplate(
            container.getTemplateColumns()
          );

          if (itemsCount > prevItemsCount) {
            for (let i = prevItemsCount; i < itemsCount; i++) {
              container.append(
                $createLayoutItemNode().append($createParagraphNode())
              );
            }
          } else if (itemsCount < prevItemsCount) {
            for (let i = prevItemsCount - 1; i >= itemsCount; i--) {
              const layoutItem = container.getChildAtIndex<LexicalNode>(i);
              if ($isLayoutItemNode(layoutItem)) {
                layoutItem.remove();
              }
            }
          }

          container.setTemplateColumns(template);
          return true;
        },
        COMMAND_PRIORITY_EDITOR
      ),
      // Arrow-key escape across the layout boundary, mirroring the playground.
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        () => $onEscape(false),
        COMMAND_PRIORITY_LOW
      ),
      editor.registerCommand(
        KEY_ARROW_RIGHT_COMMAND,
        () => $onEscape(false),
        COMMAND_PRIORITY_LOW
      ),
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        () => $onEscape(true),
        COMMAND_PRIORITY_LOW
      ),
      editor.registerCommand(
        KEY_ARROW_LEFT_COMMAND,
        () => $onEscape(true),
        COMMAND_PRIORITY_LOW
      ),
      // Structural invariants: every column keeps a paragraph; orphaned
      // items get unwrapped; empty containers get removed.
      editor.registerNodeTransform(LayoutItemNode, (node) => {
        const isRemoved = $removeIsolatedLayoutItem(node);
        if (!isRemoved) {
          $fillLayoutItemIfEmpty(node);
        }
      }),
      editor.registerNodeTransform(LayoutContainerNode, (node) => {
        const children = node.getChildren<LexicalNode>();
        if (!children.every($isLayoutItemNode)) {
          const container = $createLayoutContainerNode(node.getTemplateColumns());
          children.forEach((child) =>
            container.append(
              $isLayoutItemNode(child)
                ? child
                : $createLayoutItemNode().append(child)
            )
          );
          node.replace(container);
        }
      })
    );
  }, [editor]);

  return null;
}

// ---------------------------------------------------------------------------
// Local helpers (avoid pulling extra deps; lexical re-exports these)
// ---------------------------------------------------------------------------

function getItemsCountFromTemplate(template: string): number {
  const count = template.trim().split(/\s+/g).filter(Boolean).length;
  return count > 0 ? count : 1;
}
