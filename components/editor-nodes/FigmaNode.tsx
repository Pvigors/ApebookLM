// FigmaNode — block-level Lexical DecoratorNode that embeds a Figma file/prototype
// via Figma's official embed iframe. Aligned 1:1 with the lexical playground's
// FigmaNode: it stores a `documentID` (the bare Figma file/board id) and renders
// an <iframe> pointing at https://www.figma.com/embed?embed_host=share&url=...
//
// NOTE: no "use client" here on purpose — this module is imported by a
// 'use client' component (RichNoteEditor). The decorate() output is rendered
// inside the client editor tree, so hooks are safe to use in the inner component.

import { DecoratorNode } from "lexical";
import type {
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from "lexical";
import { useCallback, useState, type ReactNode } from "react";

const cn = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

// ---- serialization shape --------------------------------------------------
export type SerializedFigmaNode = Spread<
  {
    documentID: string;
  },
  SerializedLexicalNode
>;

// ---- url helpers ----------------------------------------------------------
// The playground accepts a pasted Figma URL and reduces it to the file/board id.
// Figma URLs look like:
//   https://www.figma.com/file/<ID>/<slug>?...
//   https://www.figma.com/proto/<ID>/<slug>?...
//   https://www.figma.com/design/<ID>/<slug>?...
//   https://www.figma.com/board/<ID>/<slug>?...
// We also accept a bare id directly.
const FIGMA_ID_RE = /(?:file|proto|design|board)\/([0-9a-zA-Z]+)/;

/** Extract the bare Figma document id from a pasted URL, or return the input
 * unchanged if it already looks like a bare id. Returns null when nothing usable. */
export function $getFigmaDocumentIDFromURL(input: string): string | null {
  const value = input.trim();
  if (value.length === 0) return null;
  const match = value.match(FIGMA_ID_RE);
  if (match && match[1]) return match[1];
  // Bare id (the playground also stores raw ids): letters/digits only, no slashes.
  if (/^[0-9a-zA-Z]+$/.test(value)) return value;
  return null;
}

/** Build the canonical Figma embed iframe src for a given document id. */
function buildFigmaEmbedSrc(documentID: string): string {
  const figmaUrl = `https://www.figma.com/file/${documentID}`;
  return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(figmaUrl)}`;
}

// ---- inner React component (rendered via decorate) ------------------------
function FigmaComponent({ documentID }: { documentID: string }): ReactNode {
  const [loaded, setLoaded] = useState(false);
  const onLoad = useCallback(() => setLoaded(true), []);
  const src = buildFigmaEmbedSrc(documentID);

  return (
    <div
      className={cn(
        "relative my-3 w-full overflow-hidden rounded-xl border border-edge bg-panel2",
        "elev-soft ring-1 ring-transparent transition-shadow focus-within:ring-accent"
      )}
      data-lexical-figma={documentID}
    >
      {!loaded && (
        <div className="absolute inset-0 z-[1] flex items-center justify-center bg-panel2 text-[13px] text-muted">
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
            正在加载 Figma…
          </span>
        </div>
      )}
      <iframe
        className="block h-[480px] w-full border-0 bg-panel"
        src={src}
        title={`Figma 嵌入 ${documentID}`}
        loading="lazy"
        allowFullScreen
        onLoad={onLoad}
        // Figma's embed iframe needs scripting + same-origin for the file id,
        // and popups for the "open in Figma" affordance.
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}

// ---- node -----------------------------------------------------------------
export class FigmaNode extends DecoratorNode<ReactNode> {
  __id: string;

  static getType(): string {
    return "figma";
  }

  static clone(node: FigmaNode): FigmaNode {
    return new FigmaNode(node.__id, node.__key);
  }

  static importJSON(serializedNode: SerializedFigmaNode): FigmaNode {
    return $createFigmaNode(serializedNode.documentID).updateFromJSON(
      serializedNode,
    );
  }

  static importDOM(): DOMConversionMap | null {
    return {
      iframe: (domNode: HTMLElement) => {
        if (!(domNode instanceof HTMLIFrameElement)) return null;
        if (!domNode.src.includes("figma.com")) return null;
        return {
          conversion: $convertFigmaElement,
          priority: 1,
        };
      },
    };
  }

  constructor(id: string, key?: NodeKey) {
    super(key);
    this.__id = id;
  }

  exportJSON(): SerializedFigmaNode {
    return {
      ...super.exportJSON(),
      type: "figma",
      version: 1,
      documentID: this.__id,
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("iframe");
    element.setAttribute("src", buildFigmaEmbedSrc(this.__id));
    element.setAttribute("width", "100%");
    element.setAttribute("height", "480");
    element.setAttribute("frameborder", "0");
    element.setAttribute("allowfullscreen", "true");
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = document.createElement("div");
    const theme = config.theme as { figma?: string } | undefined;
    const className = theme?.figma;
    if (className !== undefined) div.className = className;
    return div;
  }

  updateDOM(): false {
    return false;
  }

  getId(): string {
    return this.__id;
  }

  getTextContent(): string {
    return buildFigmaEmbedSrc(this.__id);
  }

  // Block-level: render on its own line.
  isInline(): false {
    return false;
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
    return <FigmaComponent documentID={this.__id} />;
  }
}

function $convertFigmaElement(domNode: HTMLElement): DOMConversionOutput | null {
  if (!(domNode instanceof HTMLIFrameElement)) return null;
  const src = domNode.getAttribute("src") ?? "";
  // The embed src wraps the real url inside the `url` query param.
  let candidate = src;
  try {
    const parsed = new URL(src);
    const wrapped = parsed.searchParams.get("url");
    if (wrapped) candidate = wrapped;
  } catch {
    // not a parseable absolute url; fall through to regex on the raw string
  }
  const id = $getFigmaDocumentIDFromURL(candidate);
  if (id === null) return null;
  return { node: $createFigmaNode(id) };
}

// ---- helpers --------------------------------------------------------------
export function $createFigmaNode(documentID: string): FigmaNode {
  return new FigmaNode(documentID);
}

export function $isFigmaNode(node: LexicalNode | null | undefined): node is FigmaNode {
  return node instanceof FigmaNode;
}
