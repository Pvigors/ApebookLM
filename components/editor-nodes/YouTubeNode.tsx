import { BlockWithAlignableContents } from "@lexical/react/LexicalBlockWithAlignableContents";
import {
  DecoratorBlockNode,
  type SerializedDecoratorBlockNode,
} from "@lexical/react/LexicalDecoratorBlockNode";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $applyNodeReplacement,
  $insertNodes,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type ElementFormatType,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type Spread,
} from "lexical";
import { useEffect, type JSX } from "react";

// ---------------------------------------------------------------------------
// YouTubeNode — 1:1 aligned with the lexical playground YouTubeNode.
//
// A block-level DecoratorBlockNode that stores a YouTube videoID and renders a
// 16:9 responsive privacy-enhanced iframe. Round-trips through the editor-state
// JSON (notes persist as Lexical JSON) and through HTML import/export (so that
// copy/paste of a rendered iframe re-creates the node).
// ---------------------------------------------------------------------------

export type SerializedYouTubeNode = Spread<
  {
    videoID: string;
  },
  SerializedDecoratorBlockNode
>;

const YOUTUBE_ID_RE =
  /^(?:(?:https?:)?\/\/)?(?:www\.|m\.)?(?:youtube(?:-nocookie)?\.com|youtu\.be)\/(?:(?:watch\?(?:.*&)?v=)|(?:embed\/)|(?:shorts\/)|(?:live\/)|(?:v\/)|(?:\/))?([\w-]{11})(?:[?&#].*)?$/;

/**
 * Parse a YouTube video id from a wide range of URL shapes (watch, youtu.be,
 * embed, shorts, live, /v/) or from a bare 11-char id. Returns null when the
 * input does not look like a YouTube reference, so callers can fall back.
 */
export function parseYouTubeId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  // Bare 11-character video id.
  if (/^[\w-]{11}$/.test(value)) return value;
  const match = value.match(YOUTUBE_ID_RE);
  return match ? match[1] : null;
}

type YouTubeComponentProps = Readonly<{
  className: Readonly<{ base: string; focus: string }>;
  format: ElementFormatType | null;
  nodeKey: NodeKey;
  videoID: string;
}>;

function YouTubeComponent({
  className,
  format,
  nodeKey,
  videoID,
}: YouTubeComponentProps): JSX.Element {
  return (
    <BlockWithAlignableContents
      className={className}
      format={format}
      nodeKey={nodeKey}
    >
      <div className="relative w-full overflow-hidden rounded-xl border border-edge bg-panel2 elev-soft [aspect-ratio:16/9]">
        <iframe
          className="absolute inset-0 h-full w-full rounded-xl"
          src={`https://www.youtube-nocookie.com/embed/${videoID}`}
          title="YouTube video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          frameBorder="0"
          loading="lazy"
        />
      </div>
    </BlockWithAlignableContents>
  );
}

function $convertYoutubeElement(
  domNode: HTMLElement,
): null | DOMConversionOutput {
  const videoID = domNode.getAttribute("data-lexical-youtube");
  if (videoID) {
    const node = $createYouTubeNode(videoID);
    return { node };
  }
  return null;
}

export class YouTubeNode extends DecoratorBlockNode {
  __id: string;

  static getType(): string {
    return "youtube";
  }

  static clone(node: YouTubeNode): YouTubeNode {
    return new YouTubeNode(node.__id, node.__format, node.__key);
  }

  static importJSON(serializedNode: SerializedYouTubeNode): YouTubeNode {
    return $createYouTubeNode(serializedNode.videoID).updateFromJSON(
      serializedNode,
    );
  }

  exportJSON(): SerializedYouTubeNode {
    return {
      ...super.exportJSON(),
      type: "youtube",
      version: 1,
      videoID: this.__id,
    };
  }

  constructor(id: string, format?: ElementFormatType, key?: NodeKey) {
    super(format, key);
    this.__id = id;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("iframe");
    element.setAttribute("data-lexical-youtube", this.__id);
    element.setAttribute("width", "560");
    element.setAttribute("height", "315");
    element.setAttribute(
      "src",
      `https://www.youtube-nocookie.com/embed/${this.__id}`,
    );
    element.setAttribute("frameborder", "0");
    element.setAttribute(
      "allow",
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
    );
    element.setAttribute("allowfullscreen", "true");
    element.setAttribute("title", "YouTube video");
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      iframe: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute("data-lexical-youtube")) {
          return null;
        }
        return {
          conversion: $convertYoutubeElement,
          priority: 1,
        };
      },
    };
  }

  updateDOM(): false {
    return false;
  }

  getId(): string {
    return this.__id;
  }

  getTextContent(): string {
    return `https://www.youtube.com/watch?v=${this.__id}`;
  }

  decorate(_editor: LexicalEditor, config: EditorConfig): JSX.Element {
    const embedBlockTheme = config.theme.embedBlock || {};
    const className = {
      base: embedBlockTheme.base || "",
      focus: embedBlockTheme.focus || "",
    };
    return (
      <YouTubeComponent
        className={className}
        format={this.__format}
        nodeKey={this.getKey()}
        videoID={this.__id}
      />
    );
  }
}

export function $createYouTubeNode(videoID: string): YouTubeNode {
  return $applyNodeReplacement(new YouTubeNode(videoID));
}

export function $isYouTubeNode(
  node: YouTubeNode | LexicalNode | null | undefined,
): node is YouTubeNode {
  return node instanceof YouTubeNode;
}

// ---- command + plugin -----------------------------------------------------

export const INSERT_YOUTUBE_COMMAND: LexicalCommand<string> = createCommand(
  "INSERT_YOUTUBE_COMMAND",
);

/**
 * Registers INSERT_YOUTUBE_COMMAND. The payload may be a full YouTube URL or a
 * bare video id; the URL is parsed to an id before the node is inserted. An
 * unparseable payload is ignored (command returns false so other handlers may
 * run).
 */
export function YouTubePlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor.hasNodes([YouTubeNode])) {
      throw new Error("YouTubePlugin: YouTubeNode not registered on editor");
    }

    return editor.registerCommand<string>(
      INSERT_YOUTUBE_COMMAND,
      (payload) => {
        const videoID = parseYouTubeId(payload);
        if (!videoID) {
          return false;
        }
        const youTubeNode = $createYouTubeNode(videoID);
        $insertNodes([youTubeNode]);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  return null;
}
