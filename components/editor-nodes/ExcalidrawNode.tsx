// ExcalidrawNode — block-level Lexical DecoratorNode that embeds a hand-drawn
// Excalidraw scene. Aligned 1:1 with the lexical playground's
// ExcalidrawNode / ExcalidrawComponent / ExcalidrawModal:
//
//   - The node stores `data`: a serialized JSON string of the scene, shaped
//     `{ elements, appState, files }` (Excalidraw's own export shape).
//   - The decorate() output renders a *preview*: the scene's elements are
//     rendered to an inline SVG via @excalidraw/excalidraw's exportToSvg.
//     An empty scene shows a "double-click to edit" placeholder instead.
//   - Double-clicking (or clicking the placeholder) opens a large modal that
//     mounts the full <Excalidraw> editor seeded with the current scene.
//   - The modal's top-right "Discard" closes without saving; "Save" reads the
//     scene back from the imperative API (getSceneElements / getAppState /
//     getFiles) and writes it to the node via a Lexical update, then closes.
//   - <Excalidraw> and exportToSvg are pulled in lazily / client-only because
//     the bundle is large and SSR-incompatible.
//
// NOTE: no "use client" here on purpose — this module is imported by the
// 'use client' RichNoteEditor. decorate() runs inside that client tree, so the
// inner component may use hooks and dynamic import freely.

import {
  $getNodeByKey,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  createCommand,
  DecoratorNode,
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
  SerializedLexicalNode,
  Spread,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "@lexical/utils";
import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import "@excalidraw/excalidraw/index.css";

const cn = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ");

// ---------------------------------------------------------------------------
// Excalidraw types (kept loose-but-named so we don't import the heavy module
// just for types at the top level; the runtime import is lazy/client-only).
// ---------------------------------------------------------------------------

/** Minimal slice of Excalidraw's element type — opaque to us, persisted as-is. */
type ExcalidrawElement = Readonly<Record<string, unknown>> & { type?: string };

/** Minimal slice of Excalidraw's AppState we touch + carry through. */
interface ExcalidrawAppState {
  viewBackgroundColor?: string;
  exportBackground?: boolean;
  exportWithDarkMode?: boolean;
  theme?: "light" | "dark";
  [k: string]: unknown;
}

/** Excalidraw's BinaryFiles map (image data keyed by fileId). */
type ExcalidrawBinaryFiles = Record<string, unknown>;

/** The persisted scene shape — exactly what we (de)serialize into `data`. */
interface ExcalidrawScene {
  elements: ReadonlyArray<ExcalidrawElement>;
  appState: ExcalidrawAppState;
  files: ExcalidrawBinaryFiles;
}

/** The subset of ExcalidrawImperativeAPI we read on Save. */
interface ExcalidrawAPI {
  getSceneElements: () => ReadonlyArray<ExcalidrawElement>;
  getAppState: () => ExcalidrawAppState;
  getFiles: () => ExcalidrawBinaryFiles;
}

// ---------------------------------------------------------------------------
// Lazy, client-only handles to the heavy Excalidraw module.
// ---------------------------------------------------------------------------

// 经由 ExcalidrawCanvas 包装(自定义 MainMenu 去掉第三方推广区 + zh-CN);
// 仍 ssr:false,因为 Excalidraw 在加载期会触碰 window。
const ExcalidrawCanvas = dynamic(() => import("./ExcalidrawCanvas"), { ssr: false });

/** exportToSvg, imported lazily and only on the client. Excalidraw ≥0.17 takes
 *  a SINGLE options object (elements/appState/files/exportPadding) — passing
 *  positional args silently exports a blank background only. */
type ExportToSvg = (opts: {
  elements: ReadonlyArray<ExcalidrawElement>;
  appState?: {
    exportBackground?: boolean;
    viewBackgroundColor?: string;
    exportWithDarkMode?: boolean;
  };
  files: ExcalidrawBinaryFiles | null;
  exportPadding?: number;
  skipInliningFonts?: boolean;
}) => Promise<SVGSVGElement>;

async function loadExportToSvg(): Promise<ExportToSvg> {
  const mod = await import("@excalidraw/excalidraw");
  return mod.exportToSvg as unknown as ExportToSvg;
}

// ---------------------------------------------------------------------------
// scene (de)serialization helpers
// ---------------------------------------------------------------------------

const EMPTY_SCENE: ExcalidrawScene = { elements: [], appState: {}, files: {} };

/** Parse a persisted `data` string into a scene; tolerant of empty/garbage. */
function parseScene(data: string): ExcalidrawScene {
  if (!data) return EMPTY_SCENE;
  try {
    const parsed = JSON.parse(data) as Partial<ExcalidrawScene> | null;
    if (!parsed || typeof parsed !== "object") return EMPTY_SCENE;
    return {
      elements: Array.isArray(parsed.elements) ? parsed.elements : [],
      appState: (parsed.appState && typeof parsed.appState === "object" ? parsed.appState : {}) as ExcalidrawAppState,
      files: (parsed.files && typeof parsed.files === "object" ? parsed.files : {}) as ExcalidrawBinaryFiles,
    };
  } catch {
    return EMPTY_SCENE;
  }
}

/** Serialize a scene back to a stable `data` string. AppState is trimmed of
 * volatile/transient fields the way the playground does, so re-opening the
 * editor doesn't carry over ephemeral UI state. */
function serializeScene(
  elements: ReadonlyArray<ExcalidrawElement>,
  appState: ExcalidrawAppState,
  files: ExcalidrawBinaryFiles,
): string {
  // Strip live-collaborators (a Map) and other non-serializable transients.
  const { collaborators: _collab, ...rest } = appState as ExcalidrawAppState & { collaborators?: unknown };
  return JSON.stringify({ elements, appState: rest, files });
}

// ---------------------------------------------------------------------------
// command + serialization shape
// ---------------------------------------------------------------------------

/** Dispatch with the NodeKey of an ExcalidrawNode to pop its editor modal. */
export const OPEN_EXCALIDRAW_MODAL_COMMAND: LexicalCommand<NodeKey> =
  createCommand("OPEN_EXCALIDRAW_MODAL_COMMAND");

// Keys of boards inserted THIS session that should auto-open into the editor
// on mount, in "create" mode (discard deletes the empty node). Populated only
// by the OPEN command (dispatched at insert time), so a board that was merely
// *deserialized* with an empty scene — e.g. saved blank in a past session — is
// NOT in the set and therefore never auto-opens. Without this gate, loading a
// note that contains a blank board popped the editor and an unwitting Esc
// silently deleted the board (with autosave making the loss permanent).
const pendingInsertOpen = new Set<NodeKey>();

export type SerializedExcalidrawNode = Spread<
  {
    data: string;
  },
  SerializedLexicalNode
>;

// ---------------------------------------------------------------------------
// Modal — full-screen overlay hosting the live Excalidraw editor.
// ---------------------------------------------------------------------------

interface ExcalidrawModalProps {
  initialScene: ExcalidrawScene;
  isShown: boolean;
  onSave: (elements: ReadonlyArray<ExcalidrawElement>, appState: ExcalidrawAppState, files: ExcalidrawBinaryFiles) => void;
  onClose: () => void;
  /** True when the node was just inserted empty — Discard should delete it. */
  closeOnDiscard: boolean;
  onDiscard: () => void;
}

function ExcalidrawModal({ initialScene, isShown, onSave, onClose, closeOnDiscard, onDiscard }: ExcalidrawModalProps): ReactNode {
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const [mounted, setMounted] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => setMounted(true), []);

  // Close on Escape.
  useEffect(() => {
    if (!isShown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleDiscardRequest();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isShown]);

  const handleSave = useCallback(() => {
    const api = apiRef.current;
    if (!api) {
      onClose();
      return;
    }
    const elements = api.getSceneElements();
    const appState = api.getAppState();
    const files = api.getFiles();
    onSave(elements, appState, files);
  }, [onSave, onClose]);

  const handleDiscardRequest = useCallback(() => {
    const api = apiRef.current;
    const hasContent = closeOnDiscard ? false : (api?.getSceneElements().length ?? 0) > 0;
    // For a brand-new node, or an empty scene, discard immediately.
    if (closeOnDiscard || !hasContent) {
      if (closeOnDiscard) onDiscard();
      else onClose();
      return;
    }
    setConfirmDiscard(true);
  }, [closeOnDiscard, onClose, onDiscard]);

  const confirmAndDiscard = useCallback(() => {
    setConfirmDiscard(false);
    if (closeOnDiscard) onDiscard();
    else onClose();
  }, [closeOnDiscard, onClose, onDiscard]);

  if (!isShown || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex flex-col bg-black/40 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Excalidraw 画板编辑器"
    >
      <div className="m-3 flex flex-1 flex-col overflow-hidden rounded-2xl bg-panel elev-soft sm:m-6">
        {/* header / toolbar */}
        <div className="flex items-center justify-between gap-3 border-b border-edge px-5 py-3">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden>
              <rect x="3" y="11" width="9" height="9" rx="1.5" />
              <circle cx="16.5" cy="7.5" r="4.5" />
            </svg>
            画板
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDiscardRequest}
              className="rounded-full border border-edge px-4 py-2 text-sm text-ink2 transition hover:border-accent hover:bg-accentSoft hover:text-accent"
            >
              丢弃
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-onAccent transition hover:brightness-110"
            >
              保存
            </button>
          </div>
        </div>

        {/* live editor */}
        <div className="relative min-h-0 flex-1">
          <ExcalidrawCanvas
            // Remount per-open so initialData is honored fresh each time.
            initialData={{ elements: initialScene.elements, appState: initialScene.appState, files: initialScene.files }}
            excalidrawAPI={(api: unknown) => {
              apiRef.current = api as ExcalidrawAPI;
            }}
          />
        </div>
      </div>

      {/* discard confirmation */}
      {confirmDiscard && (
        <div className="absolute inset-0 z-[1001] flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-edge bg-panel p-5 elev-soft">
            <p className="text-[14px] font-medium text-ink">丢弃当前修改?</p>
            <p className="mt-1.5 text-[13px] text-muted">你对这张画板所做的更改将不会被保存。</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDiscard(false)}
                className="rounded-full border border-edge bg-panel px-3.5 py-1.5 text-[13px] font-medium text-ink2 transition-colors hover:bg-panel2"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmAndDiscard}
                className="rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-onAccent transition-opacity hover:opacity-90"
              >
                丢弃
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Preview — renders the persisted elements to an inline SVG, or a placeholder.
// ---------------------------------------------------------------------------

interface ExcalidrawImageProps {
  scene: ExcalidrawScene;
}

function ExcalidrawImage({ scene }: ExcalidrawImageProps): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState(false);

  useLayoutEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    void (async () => {
      try {
        const exportToSvg = await loadExportToSvg();
        if (cancelled) return;
        const appState = scene.appState ?? {};
        const svg = await exportToSvg({
          elements: scene.elements,
          appState: {
            exportBackground: appState.exportBackground ?? true,
            viewBackgroundColor: appState.viewBackgroundColor ?? "#ffffff",
            exportWithDarkMode: appState.exportWithDarkMode ?? false,
          },
          files: scene.files ?? {},
          exportPadding: 10,
          // Skip font inlining — it spins up a font-subset Web Worker that, under
          // Next dev, resolves to a file:// URL and throws a Worker SecurityError.
          // Shapes don't need it; text falls back to the page font. Avoids the crash.
          skipInliningFonts: true,
        });
        if (cancelled) return;
        // exportToSvg sizes the SVG to ~2× the drawing (retina scale), e.g.
        // width=680 for a viewBox of 340 — which renders twice too big. Pin the
        // width/height to the logical viewBox size so it shows at its natural
        // 1× size (matching the playground); max-width then caps it to the
        // column so a small sketch stays small and a big one never overflows.
        const vb = svg.viewBox?.baseVal;
        if (vb && vb.width > 0 && vb.height > 0) {
          svg.setAttribute("width", String(Math.round(vb.width)));
          svg.setAttribute("height", String(Math.round(vb.height)));
        }
        svg.style.maxWidth = "100%";
        svg.style.height = "auto";
        svg.style.display = "block";
        host.replaceChildren(svg);
      } catch {
        if (!cancelled) setError(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [scene]);

  if (error) {
    return <div className="px-4 py-6 text-center text-[13px] text-muted">画板预览渲染失败</div>;
  }
  return <div ref={hostRef} className="flex max-h-[520px] max-w-full items-center justify-center overflow-hidden p-2" aria-label="Excalidraw 画板预览" />;
}

// ---------------------------------------------------------------------------
// Decorator component — preview + double-click to open the modal.
// ---------------------------------------------------------------------------

interface ExcalidrawComponentInnerProps {
  nodeKey: NodeKey;
  data: string;
}

function ExcalidrawComponentInner({ nodeKey, data }: ExcalidrawComponentInnerProps): ReactNode {
  const [editor] = useLexicalComposerContext();
  const isEditable = useEditable(editor);
  const [isModalOpen, setModalOpen] = useState(false);
  // A node inserted empty is in "create" mode: discarding deletes it.
  const [closeOnDiscard, setCloseOnDiscard] = useState(false);
  const [selected, setSelected] = useState(false);

  const scene = parseScene(data);
  const isEmpty = scene.elements.length === 0;

  const open = useCallback(
    (opts?: { fromInsert?: boolean }) => {
      // Read-only: never open the editor modal (preview only).
      if (!editor.isEditable()) return;
      setCloseOnDiscard(opts?.fromInsert ?? false);
      setModalOpen(true);
    },
    [editor],
  );

  // Listen for the global open command targeting this node (re-entrant
  // double-clicks dispatched elsewhere; a no-op right after insert because this
  // component hasn't mounted its listener yet when the insert dispatches it).
  useEffect(() => {
    return editor.registerCommand<NodeKey>(
      OPEN_EXCALIDRAW_MODAL_COMMAND,
      (targetKey) => {
        if (targetKey !== nodeKey) return false;
        pendingInsertOpen.delete(nodeKey);
        open({ fromInsert: true });
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, nodeKey, open]);

  // Playground parity: a board just inserted THIS session opens its editor
  // immediately rather than waiting for a double-click. The insert-time OPEN
  // command races this component's mount and is missed, so we auto-open here —
  // but ONLY when this key was registered by that insert-time OPEN (see
  // pendingInsertOpen). A board that merely *deserialized* empty (saved blank in
  // a past session) is NOT in the set, so it renders its placeholder instead of
  // auto-popping the editor — otherwise a reflexive Esc would delete it. Runs
  // once on mount; fromInsert=true so discarding the still-empty board removes
  // the node.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    if (pendingInsertOpen.has(nodeKey) && editor.isEditable()) {
      pendingInsertOpen.delete(nodeKey);
      open({ fromInsert: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = useCallback(
    (elements: ReadonlyArray<ExcalidrawElement>, appState: ExcalidrawAppState, files: ExcalidrawBinaryFiles) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isExcalidrawNode(node)) {
          node.setData(serializeScene(elements, appState, files));
        }
      });
      setModalOpen(false);
      setCloseOnDiscard(false);
    },
    [editor, nodeKey],
  );

  const handleClose = useCallback(() => {
    setModalOpen(false);
    setCloseOnDiscard(false);
  }, []);

  const handleDiscard = useCallback(() => {
    // Created-then-discarded: remove the empty node entirely.
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isExcalidrawNode(node)) node.remove();
    });
    setModalOpen(false);
    setCloseOnDiscard(false);
  }, [editor, nodeKey]);

  const onDoubleClick = useCallback(() => open(), [open]);

  return (
    <>
      <div
        className={cn(
          "group relative my-3 w-fit max-w-full select-none rounded-xl transition",
          // framed box only for the empty placeholder (a clickable affordance);
          // a real drawing renders borderless — just a ring on hover/select.
          isEmpty
            ? cn(
                "border bg-panel2 elev-soft",
                selected ? "border-accent ring-1 ring-accent" : "border-edge hover:border-accent/40"
              )
            : selected
              ? "ring-2 ring-accent"
              : "hover:ring-1 hover:ring-edge",
          isEditable ? "cursor-pointer" : "cursor-default",
        )}
        role={isEditable ? "button" : undefined}
        tabIndex={isEditable ? 0 : undefined}
        aria-label={isEditable ? "Excalidraw 画板（双击编辑）" : "Excalidraw 画板"}
        onDoubleClick={isEditable ? onDoubleClick : undefined}
        onClick={() => setSelected(true)}
        onBlur={() => setSelected(false)}
        onKeyDown={
          isEditable
            ? (e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  open();
                } else if (
                  (e.key === "Backspace" || e.key === "Delete") &&
                  !isModalOpen
                ) {
                  // The board div is focusable and shows a selected ring, so the
                  // user expects Delete to remove it. But keystrokes here never
                  // reach the editor root, and core rich-text's KEY_BACKSPACE/
                  // KEY_DELETE bail on any event target inside a decorator — so
                  // the command path can't delete it. Handle the keydown directly
                  // on the focused element instead.
                  e.preventDefault();
                  editor.update(() => {
                    const node = $getNodeByKey(nodeKey);
                    if ($isExcalidrawNode(node)) node.remove();
                  });
                }
              }
            : undefined
        }
        data-lexical-excalidraw=""
      >
        {/* hover "edit" affordance — editable only */}
        {isEditable && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            className="absolute right-2 top-2 z-[1] hidden items-center gap-1 rounded-lg border border-edge bg-white/90 px-2.5 py-1 text-[12px] font-medium text-ink2 shadow-sm backdrop-blur-sm transition hover:border-accent hover:bg-accentSoft hover:text-accent group-hover:inline-flex"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            编辑
          </button>
        )}

        {isEmpty ? (
          <div className="flex min-h-[160px] min-w-[280px] flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="text-accent" aria-hidden>
              <path d="M12 19l7-7 3 3-7 7-3-3z" />
              <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
              <path d="M2 2l7.586 7.586" />
              <circle cx="11" cy="11" r="2" />
            </svg>
            <span className="text-[13px] font-medium text-ink2">
              {isEditable ? "双击编辑画板" : "空白画板"}
            </span>
            <span className="text-[12px] text-muted">用 Excalidraw 手绘图形、流程与草图</span>
          </div>
        ) : (
          <ExcalidrawImage scene={scene} />
        )}
      </div>

      <ExcalidrawModal
        // key forces a clean remount (fresh initialData) per open.
        key={isModalOpen ? `open-${nodeKey}` : `closed-${nodeKey}`}
        isShown={isModalOpen}
        initialScene={scene}
        onSave={handleSave}
        onClose={handleClose}
        onDiscard={handleDiscard}
        closeOnDiscard={closeOnDiscard}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export class ExcalidrawNode extends DecoratorNode<ReactNode> {
  __data: string;

  static getType(): string {
    return "excalidraw";
  }

  static clone(node: ExcalidrawNode): ExcalidrawNode {
    return new ExcalidrawNode(node.__data, node.__key);
  }

  static importJSON(serializedNode: SerializedExcalidrawNode): ExcalidrawNode {
    return $createExcalidrawNode(serializedNode.data ?? "").updateFromJSON(
      serializedNode,
    );
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute("data-lexical-excalidraw-json")) return null;
        return { conversion: $convertExcalidrawElement, priority: 1 };
      },
    };
  }

  constructor(data = "", key?: NodeKey) {
    super(key);
    this.__data = data;
  }

  exportJSON(): SerializedExcalidrawNode {
    return {
      ...super.exportJSON(),
      type: "excalidraw",
      version: 1,
      data: this.__data,
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("span");
    element.setAttribute("data-lexical-excalidraw-json", this.__data);
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = document.createElement("div");
    const theme = config.theme as { excalidraw?: string } | undefined;
    const className = theme?.excalidraw;
    if (className !== undefined) div.className = className;
    return div;
  }

  updateDOM(): false {
    return false;
  }

  setData(data: string): void {
    const writable = this.getWritable();
    writable.__data = data;
  }

  getData(): string {
    return this.__data;
  }

  getTextContent(): string {
    return "";
  }

  isInline(): false {
    return false;
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): ReactNode {
    return <ExcalidrawComponentInner nodeKey={this.getKey()} data={this.__data} />;
  }
}

function $convertExcalidrawElement(domNode: HTMLElement): DOMConversionOutput | null {
  const data = domNode.getAttribute("data-lexical-excalidraw-json");
  if (data === null) return null;
  return { node: $createExcalidrawNode(data) };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function $createExcalidrawNode(data = ""): ExcalidrawNode {
  return new ExcalidrawNode(data);
}

export function $isExcalidrawNode(node: LexicalNode | null | undefined): node is ExcalidrawNode {
  return node instanceof ExcalidrawNode;
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

// ---------------------------------------------------------------------------
// Plugin — registers the open command so insertion can pop the modal.
// ---------------------------------------------------------------------------

export function ExcalidrawPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor.hasNodes([ExcalidrawNode])) {
      throw new Error("ExcalidrawPlugin: ExcalidrawNode not registered on editor");
    }
    // The command is also handled per-node in the decorator (to target a
    // specific key); this registration keeps the command live even before any
    // node has mounted, so a freshly-inserted node's "open on insert" works.
    return mergeRegister(
      editor.registerCommand<NodeKey>(
        OPEN_EXCALIDRAW_MODAL_COMMAND,
        (targetKey) => {
          // Record the insert intent so the node auto-opens (in create mode) as
          // soon as it mounts — the node's own listener isn't registered yet at
          // insert time. Then let the targeted node component handle it too.
          pendingInsertOpen.add(targetKey);
          return false;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  }, [editor]);

  return null;
}
