import {
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import * as React from 'react';

const WIDGET_SCRIPT_URL = 'https://platform.twitter.com/widgets.js';

// Module-level cache so the script is only injected once across all Tweet nodes,
// and concurrently-mounting tweets all await the same load promise.
let scriptLoadPromise: Promise<void> | null = null;

type TwitterWidgets = {
  createTweet: (
    tweetId: string,
    container: HTMLElement,
    options?: Record<string, unknown>,
  ) => Promise<HTMLElement | undefined>;
};

declare global {
  interface Window {
    twttr?: {
      widgets?: TwitterWidgets;
    };
  }
}

function loadTwitterWidgetScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }
  if (window.twttr?.widgets) {
    return Promise.resolve();
  }
  if (scriptLoadPromise) {
    return scriptLoadPromise;
  }

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${WIDGET_SCRIPT_URL}"]`,
    );

    const handleReady = (): void => {
      if (window.twttr?.widgets) {
        resolve();
      } else {
        // Script tag present/loaded but global not ready yet — poll briefly.
        let attempts = 0;
        const timer = window.setInterval(() => {
          attempts += 1;
          if (window.twttr?.widgets) {
            window.clearInterval(timer);
            resolve();
          } else if (attempts > 100) {
            window.clearInterval(timer);
            reject(new Error('Twitter widgets failed to initialize.'));
          }
        }, 50);
      }
    };

    if (existing) {
      if (window.twttr?.widgets) {
        resolve();
      } else {
        existing.addEventListener('load', handleReady, { once: true });
        existing.addEventListener(
          'error',
          () => {
            // Drop the dead tag so the retry re-injects a fresh <script>. A
            // failed script never re-fires load/error, so reusing it would leave
            // the next promise pending forever — one transient network blip would
            // otherwise brick every tweet embed until a full page reload.
            existing.remove();
            reject(new Error('Failed to load Twitter widgets script.'));
          },
          { once: true },
        );
      }
      return;
    }

    const script = document.createElement('script');
    script.src = WIDGET_SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', handleReady, { once: true });
    script.addEventListener(
      'error',
      () => {
        script.remove();
        reject(new Error('Failed to load Twitter widgets script.'));
      },
      { once: true },
    );
    document.body.appendChild(script);
  });

  scriptLoadPromise = promise;
  // On ANY failure (network error, or widgets never initializing) clear the
  // cached promise so a later mount/retry starts fresh instead of re-awaiting a
  // permanently-rejected/-pending promise. Guarded by identity so we never null
  // out a newer in-flight promise a retry may have already installed.
  promise.catch(() => {
    if (scriptLoadPromise === promise) scriptLoadPromise = null;
  });

  return promise;
}

function TweetSkeleton(): React.JSX.Element {
  return (
    <div className="w-full max-w-[550px] animate-pulse rounded-xl border border-edge bg-panel2 p-4">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-full bg-edge" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-1/3 rounded-full bg-edge" />
          <div className="h-3 w-1/4 rounded-full bg-edge" />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <div className="h-3 w-full rounded-full bg-edge" />
        <div className="h-3 w-11/12 rounded-full bg-edge" />
        <div className="h-3 w-3/4 rounded-full bg-edge" />
      </div>
      <div className="mt-4 h-40 w-full rounded-lg bg-edge" />
    </div>
  );
}

type TweetComponentProps = {
  tweetID: string;
  nodeKey: NodeKey;
};

function TweetComponent({ tweetID, nodeKey }: TweetComponentProps): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>(
    'loading',
  );

  React.useEffect(() => {
    let isCancelled = false;
    const container = containerRef.current;

    if (!container) {
      return;
    }

    // Clear any prior render (e.g. when tweetID changes).
    container.innerHTML = '';
    setStatus('loading');

    loadTwitterWidgetScript()
      .then(() => {
        if (isCancelled || !containerRef.current) {
          return undefined;
        }
        const widgets = window.twttr?.widgets;
        if (!widgets) {
          throw new Error('Twitter widgets unavailable.');
        }
        return widgets.createTweet(tweetID, containerRef.current, {
          align: 'center',
          dnt: true,
        });
      })
      .then((rendered) => {
        if (isCancelled) {
          return;
        }
        // createTweet resolves with undefined when the tweet cannot be embedded.
        setStatus(rendered ? 'ready' : 'error');
      })
      .catch(() => {
        if (!isCancelled) {
          setStatus('error');
        }
      });

    return () => {
      isCancelled = true;
      if (container) {
        container.innerHTML = '';
      }
    };
  }, [tweetID]);

  return (
    <div
      className="my-3 flex w-full justify-center"
      data-lexical-tweet-id={tweetID}
      data-lexical-node-key={nodeKey}
    >
      {status === 'loading' ? <TweetSkeleton /> : null}
      {status === 'error' ? (
        <div className="w-full max-w-[550px] rounded-xl border border-edge bg-panel2 p-4 text-sm text-muted">
          无法加载该推文（ID: {tweetID}）。
        </div>
      ) : null}
      <div
        ref={containerRef}
        className={status === 'ready' ? 'w-full' : 'hidden'}
      />
    </div>
  );
}

export type SerializedTweetNode = Spread<
  {
    id: string;
  },
  SerializedLexicalNode
>;

function $convertTweetElement(
  domNode: HTMLElement,
): null | DOMConversionOutput {
  const id = domNode.getAttribute('data-lexical-tweet-id');
  if (id) {
    const node = $createTweetNode(id);
    return { node };
  }
  return null;
}

export class TweetNode extends DecoratorNode<React.JSX.Element> {
  __id: string;

  static getType(): string {
    return 'tweet';
  }

  static clone(node: TweetNode): TweetNode {
    return new TweetNode(node.__id, node.__key);
  }

  static importJSON(serializedNode: SerializedTweetNode): TweetNode {
    return $createTweetNode(serializedNode.id).updateFromJSON(serializedNode);
  }

  exportJSON(): SerializedTweetNode {
    return {
      ...super.exportJSON(),
      type: 'tweet',
      version: 1,
      id: this.__id,
    };
  }

  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedTweetNode>,
  ): this {
    return super.updateFromJSON(serializedNode);
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-lexical-tweet-id')) {
          return null;
        }
        return {
          conversion: $convertTweetElement,
          priority: 2,
        };
      },
    };
  }

  constructor(id: string, key?: NodeKey) {
    super(key);
    this.__id = id;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div');
    element.setAttribute('data-lexical-tweet-id', this.__id);
    const text = document.createTextNode(this.getTextContent());
    element.append(text);
    return { element };
  }

  getId(): string {
    return this.__id;
  }

  getTextContent(): string {
    return `https://x.com/i/web/status/${this.__id}`;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement('div');
    const theme = config.theme;
    const className = theme.tweet;
    if (typeof className === 'string') {
      element.className = className;
    }
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <TweetComponent tweetID={this.__id} nodeKey={this.getKey()} />;
  }

  isInline(): false {
    return false;
  }
}

export function $createTweetNode(tweetID: string): TweetNode {
  return new TweetNode(tweetID);
}

export function $isTweetNode(
  node: TweetNode | LexicalNode | null | undefined,
): node is TweetNode {
  return node instanceof TweetNode;
}
