"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
} from "lexical";
import type {
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import { mergeRegister } from "@lexical/utils";

// ---- image node (minimal, URL-based) -------------------------------------
// The Lexical playground's ImageNode is large; this is a slim block image that
// round-trips through the editor-state JSON (notes persist images).
type SerializedImageNode = Spread<{ src: string; altText: string }, SerializedLexicalNode>;

/** Click-to-select + Delete/Backspace-to-remove, matching PageBreakNode /
 *  EquationNode. Without a NodeSelection + delete-key handler, a selected image
 *  ignored Delete entirely (core rich-text bails on NodeSelection), so the image
 *  felt un-deletable and gave no selection feedback — inconsistent with every
 *  other block. */
function ImageComponent({
  nodeKey,
  src,
  alt,
}: {
  nodeKey: NodeKey;
  src: string;
  alt: string;
}): ReactNode {
  const [editor] = useLexicalComposerContext();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const onDelete = useCallback(
    (event: KeyboardEvent) => {
      const selection = $getSelection();
      if (isSelected && $isNodeSelection(selection) && selection.has(nodeKey)) {
        event.preventDefault();
        const node = $getNodeByKey(nodeKey);
        if ($isImageNode(node)) {
          node.remove();
          return true;
        }
      }
      return false;
    },
    [isSelected, nodeKey],
  );

  useEffect(() => {
    if (!editor.isEditable()) return;
    return mergeRegister(
      editor.registerCommand<MouseEvent>(
        CLICK_COMMAND,
        (event) => {
          if (event.target === imgRef.current) {
            if (!event.shiftKey) clearSelection();
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
  }, [editor, isSelected, setSelected, clearSelection, onDelete]);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={src}
      alt={alt}
      draggable={false}
      className={`max-h-[460px] max-w-full rounded-lg transition ${
        isSelected ? "ring-2 ring-accent" : "ring-1 ring-transparent hover:ring-edge"
      }`}
    />
  );
}

export class ImageNode extends DecoratorNode<ReactNode> {
  __src: string;
  __alt: string;
  static getType() {
    return "image";
  }
  static clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__src, node.__alt, node.__key);
  }
  static importJSON(json: SerializedImageNode): ImageNode {
    return $createImageNode(json.src, json.altText).updateFromJSON(json);
  }
  static importDOM(): DOMConversionMap | null {
    return {
      img: () => ({
        conversion: (el: HTMLElement): DOMConversionOutput => ({
          node: $createImageNode((el as HTMLImageElement).src, (el as HTMLImageElement).alt || ""),
        }),
        priority: 0,
      }),
    };
  }
  exportDOM(): DOMExportOutput {
    const element = document.createElement("img");
    element.setAttribute("src", this.__src);
    element.setAttribute("alt", this.__alt);
    return { element };
  }
  constructor(src: string, alt: string, key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__alt = alt;
  }
  exportJSON(): SerializedImageNode {
    return { ...super.exportJSON(), type: "image", version: 1, src: this.__src, altText: this.__alt };
  }
  createDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "my-2";
    return div;
  }
  updateDOM(): false {
    return false;
  }
  // Block-level: it renders in its own <div>, so treat it as a block decorator
  // (proper NodeSelection + arrow/enter routing), not an inline one (the
  // DecoratorNode default).
  isInline(): false {
    return false;
  }
  decorate(): ReactNode {
    return <ImageComponent nodeKey={this.getKey()} src={this.__src} alt={this.__alt} />;
  }
}
export function $createImageNode(src: string, alt = ""): ImageNode {
  return new ImageNode(src, alt);
}
export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode;
}
