// EquationNode — a Lexical DecoratorNode that renders a KaTeX math equation,
// 1:1-aligned with the lexical playground's EquationNode / EquationComponent.
//
// Stores a LaTeX string (`equation`) plus an `inline` flag. The decorate() tree
// renders KaTeX via `katex.renderToString` (displayMode = !inline). Double-click
// switches the node into an inline editor (a <span contentEditable> for inline
// equations, a <textarea> for block equations); blur or Enter commits to
// node.setEquation, Escape cancels. A single click selects the node (Lexical's
// NodeSelection), matching the playground's behavior.
//
// Round-trips losslessly through Lexical JSON (notes persist as Lexical JSON with
// format="json") and through HTML import/export.
//
// NOTE: no "use client" here — this module is imported by a 'use client' editor
// component, so the decorate() React tree (which uses hooks) runs client-side.

import "katex/dist/katex.min.css";
import katex from "katex";
import {
  $applyNodeReplacement,
  $createNodeSelection,
  $getNodeByKey,
  $getSelection,
  $insertNodes,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  createCommand,
  DecoratorNode,
  FORMAT_ELEMENT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ESCAPE_COMMAND,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type ElementFormatType,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import {
  $getNearestBlockElementAncestorOrThrow,
  mergeRegister,
} from "@lexical/utils";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { JSX } from "react";

// ---------------------------------------------------------------------------
// KaTeX renderer (shared markup for the static view)
// ---------------------------------------------------------------------------

/**
 * Render LaTeX to an HTML string with KaTeX. `throwOnError:false` makes KaTeX
 * emit a styled error node instead of throwing on malformed input, matching the
 * playground (the user keeps editing rather than crashing the editor).
 */
function renderEquation(equation: string, inline: boolean): string {
  return katex.renderToString(equation, {
    displayMode: !inline,
    throwOnError: false,
    errorColor: "#cc0000",
    output: "html",
    strict: "ignore", // 中文标点等 unicode 在生成的公式里常见,warn 只会刷控制台
    trust: false,
  });
}

// ---------------------------------------------------------------------------
// KaTeX read-only renderer component
// ---------------------------------------------------------------------------

interface KatexRendererProps {
  equation: string;
  inline: boolean;
  onDoubleClick: () => void;
}

function KatexRenderer({
  equation,
  inline,
  onDoubleClick,
}: KatexRendererProps): JSX.Element {
  const ref = useRef<HTMLSpanElement | null>(null);

  // An empty equation renders to nothing. We must NOT hand it to katex.render:
  // KaTeX emits an empty wrapper that clobbers the DOM node, leaving a
  // zero-width, un-clickable target (double-click had nowhere to land → the
  // equation looked un-editable). Instead, for the empty case render a real
  // placeholder as a React child, and only mount the katex-owned inner <span>
  // (ref target) when there's actually an equation. Keeping KaTeX's innerHTML
  // and React's children on SEPARATE nodes stops the two from fighting.
  const isEmpty = equation.trim().length === 0;

  useEffect(() => {
    const el = ref.current;
    if (el == null) return; // empty equation → no inner span; placeholder is React-managed
    katex.render(equation, el, {
      displayMode: !inline,
      throwOnError: false,
      errorColor: "#cc0000",
      output: "html",
      strict: "ignore", // 中文标点等 unicode 在生成的公式里常见,warn 只会刷控制台
      trust: false,
    });
  }, [equation, inline]);

  return (
    <span
      role="button"
      tabIndex={-1}
      onDoubleClick={onDoubleClick}
      className={isEmpty ? "text-muted italic select-none" : undefined}
    >
      {isEmpty ? (inline ? "公式 — 双击编辑" : "空公式 — 双击编辑") : <span ref={ref} />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline LaTeX editor (used while editing)
// ---------------------------------------------------------------------------

interface EquationEditorProps {
  equation: string;
  inline: boolean;
  setEquation: (next: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The editable LaTeX surface. Block equations get a multi-line <textarea>
 * wrapped in `$$ … $$`; inline equations get a single-line input wrapped in
 * `$ … $`, mirroring the playground. Enter commits (Shift+Enter inserts a
 * newline in the block editor), Escape cancels.
 */
function EquationEditor({
  equation,
  inline,
  setEquation,
  onConfirm,
  onCancel,
}: EquationEditorProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // A real double-click hands focus back to the Lexical editor ROOT a tick AFTER
  // we focus the field here (the mount-focus race), firing a spurious `blur`.
  // With onBlur=commit that instantly committed + closed the editor, so a
  // just-opened equation "快速收回" and looked un-editable. Keep a short window
  // after opening during which a blur RE-FOCUSES (stays in edit mode) instead of
  // committing; genuine click-away after the window still commits as before.
  const justOpenedRef = useRef(true);

  // Focus + select all on mount so the user can immediately retype.
  useLayoutEffect(() => {
    const el = inline ? inputRef.current : textareaRef.current;
    if (el) {
      el.focus();
      el.select();
    }
    justOpenedRef.current = true;
    // Short window: the mount-focus steal (if any survives the dblclick
    // preventDefault above) fires within a frame or two; keep it brief so a real
    // click-away to save is never swallowed.
    const t = setTimeout(() => {
      justOpenedRef.current = false;
    }, 150);
    return () => clearTimeout(t);
  }, [inline]);

  const handleBlur = useCallback(() => {
    if (justOpenedRef.current) {
      (inline ? inputRef.current : textareaRef.current)?.focus();
      return;
    }
    onConfirm();
  }, [inline, onConfirm]);

  // Keep the block <textarea> auto-sized to its content.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    }
  }, [equation, inline]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        if (inline || !e.shiftKey) {
          e.preventDefault();
          onConfirm();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [inline, onConfirm, onCancel],
  );

  if (inline) {
    return (
      <span className="inline-flex items-baseline rounded-lg bg-accentSoft px-1 align-baseline ring-1 ring-accent">
        <span className="select-none font-mono text-[13px] text-accent">$</span>
        <input
          ref={inputRef}
          name="equation"
          autoComplete="off"
          value={equation}
          onChange={(e) => setEquation(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={onKeyDown}
          aria-label="编辑行内公式 (LaTeX)"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="min-w-[2ch] bg-transparent px-0.5 font-mono text-[13px] text-ink outline-none"
          style={{ width: `${Math.max(equation.length, 2) + 1}ch` }}
        />
        <span className="select-none font-mono text-[13px] text-accent">$</span>
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded-xl bg-accentSoft p-2 ring-1 ring-accent">
      <div className="flex items-start gap-1">
        <span className="select-none pt-0.5 font-mono text-[13px] text-accent">
          $$
        </span>
        <textarea
          ref={textareaRef}
          name="equation"
          autoComplete="off"
          value={equation}
          onChange={(e) => setEquation(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={onKeyDown}
          aria-label="编辑块级公式 (LaTeX)"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={1}
          className="min-h-[1.5rem] w-full resize-none bg-transparent font-mono text-[13px] leading-snug text-ink outline-none"
        />
        <span className="select-none pt-0.5 font-mono text-[13px] text-accent">
          $$
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The decorate() component: wires read-only <-> edit, selection, and commands
// ---------------------------------------------------------------------------

interface EquationComponentProps {
  equation: string;
  inline: boolean;
  /**
   * Element alignment for the block path (left/center/right/justify). `null`/""
   * means "no explicit format" → default left. Ignored for inline equations,
   * which flow in the paragraph and inherit its alignment.
   */
  format: ElementFormatType | null;
  nodeKey: NodeKey;
}

/** Map an ElementFormatType to a CSS `justify-content` value for the flex host. */
function justifyForFormat(
  format: ElementFormatType | null,
): "flex-start" | "center" | "flex-end" | "space-between" {
  switch (format) {
    case "center":
      return "center";
    case "right":
      return "flex-end";
    case "justify":
      return "space-between";
    case "left":
    default:
      // Default-align block equations to the left, not center, unless the user
      // explicitly chose another alignment via the toolbar.
      return "flex-start";
  }
}

function EquationComponent({
  equation,
  inline,
  format,
  nodeKey,
}: EquationComponentProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [isSelected, setSelected, clearSelection] =
    useLexicalNodeSelection(nodeKey);
  const [editing, setEditing] = useState(false);
  // Draft LaTeX held while editing; committed to the node on confirm.
  const [draft, setDraft] = useState(equation);
  // Mirror the latest draft in a ref so commit()/blur read the CURRENT value, not
  // a value captured in a stale closure. A blur fired from clicking outside can
  // run against an event handler bound a render or two ago; reading the closure's
  // `draft` there would commit an OLD value → the edit "点外面就回退了". The ref
  // is always up to date, so click-away always saves what's on screen.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editable = editor.isEditable();
  // A single ref of the broad element type lets the same handler back both the
  // inline <span> host and the block <div> host.
  const containerRef = useRef<HTMLElement | null>(null);
  const setContainer = useCallback((el: HTMLElement | null) => {
    containerRef.current = el;
  }, []);

  // If the underlying node changes externally while not editing, sync the draft.
  useEffect(() => {
    if (!editing) setDraft(equation);
  }, [equation, editing]);

  const enterEdit = useCallback(() => {
    if (!editable) return;
    setDraft(equation);
    setEditing(true);
  }, [editable, equation]);

  // Enter edit on double-click, and preventDefault the native dblclick so the
  // browser's word-select / caret-placement doesn't yank focus back to the
  // Lexical root right after we focus the editor's textarea (that focus-steal is
  // what made the freshly-opened editor "快速收回" / close on itself).
  const enterEditOnDouble = useCallback(
    (e: React.MouseEvent) => {
      if (!editable) return;
      e.preventDefault();
      enterEdit();
    },
    [editable, enterEdit],
  );

  const commit = useCallback(() => {
    const d = draftRef.current; // latest on-screen value, never a stale closure
    setEditing(false);
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isEquationNode(node)) return;
      // Committing an emptied equation removes the node rather than leaving an
      // orphan "空公式" placeholder behind — this is what littered the doc in the
      // repro (double-click → select-all → backspace emptied it → an un-editable,
      // un-deletable husk stayed). No content is lost (draft is blank here).
      if (d.trim().length === 0) {
        node.remove();
        return;
      }
      if (node.getEquation() !== d) node.setEquation(d);
    });
  }, [editor, nodeKey]);

  const cancel = useCallback(() => {
    setEditing(false);
    setDraft(equation);
    // Keep the node selected after cancelling so the user has a clear target.
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isEquationNode(node)) node.selectEnd();
    });
  }, [editor, nodeKey, equation]);

  // Delete/Backspace on a selected equation removes the node. Lexical's core
  // rich-text KEY_BACKSPACE/KEY_DELETE handlers bail out on a NodeSelection
  // (they only handle RangeSelection), so a selected DecoratorNode would be
  // impossible to delete from the keyboard without this — the equation just sat
  // there ignoring Delete. Mirrors PageBreakNode. (While editing, the caret is
  // inside the decorator's own textarea/input, whose keystrokes never reach the
  // editor root, so this can't fire mid-edit — but guard anyway for safety.)
  const onDelete = useCallback(
    (event: KeyboardEvent) => {
      if (editing) return false;
      const selection = $getSelection();
      if (isSelected && $isNodeSelection(selection) && selection.has(nodeKey)) {
        event.preventDefault();
        const node = $getNodeByKey(nodeKey);
        if ($isEquationNode(node)) {
          node.remove();
          return true;
        }
      }
      return false;
    },
    [editing, isSelected, nodeKey],
  );

  // Single-click selects the node (NodeSelection); the playground does the same.
  useEffect(() => {
    if (!editor.isEditable()) return;
    return mergeRegister(
      editor.registerCommand<MouseEvent>(
        CLICK_COMMAND,
        (event) => {
          const target = event.target as Node;
          if (containerRef.current && containerRef.current.contains(target)) {
            if (event.shiftKey) {
              setSelected(!isSelected);
            } else {
              clearSelection();
              setSelected(true);
            }
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(KEY_DELETE_COMMAND, onDelete, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_BACKSPACE_COMMAND, onDelete, COMMAND_PRIORITY_LOW),
      // While editing, swallow Escape at high priority so it cancels the editor
      // rather than bubbling out to the editor-level handlers.
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        () => {
          if (editing) {
            cancel();
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor, isSelected, setSelected, clearSelection, editing, cancel, onDelete]);

  // Block equations carry an ElementFormatType and respond to the alignment
  // toolbar (FORMAT_ELEMENT_COMMAND). This mirrors @lexical/react's
  // BlockWithAlignableContents — the helper DecoratorBlockNode uses — so a
  // selected block equation (NodeSelection) or one inside a RangeSelection picks
  // up 左对齐/居中/右对齐/两端对齐. Inline equations skip this: they flow inside
  // the paragraph and inherit its alignment, so applying an element format here
  // would be meaningless (and is handled by the surrounding paragraph instead).
  useEffect(() => {
    if (inline || !editor.isEditable()) return;
    return editor.registerCommand<ElementFormatType>(
      FORMAT_ELEMENT_COMMAND,
      (formatType) => {
        // Determine, from the LIVE selection, whether this equation is the
        // target — never trust a captured `isSelected`, which can be stale on
        // the render right after a previous setFormat. We must run at
        // COMMAND_PRIORITY_HIGH (above the core rich-text handler at
        // COMMAND_PRIORITY_EDITOR): for a NodeSelection of a DecoratorNode, the
        // core handler's $findMatchingParent walks past the equation to the
        // root, sets NOTHING useful, yet still returns true — which would
        // otherwise swallow the command before this LOW handler ever ran. So
        // alignment on a selected equation silently did nothing.
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          // Only handle if THIS node is the one selected; otherwise let it pass.
          if (!selection.has(nodeKey)) return false;
          const node = $getNodeByKey(nodeKey);
          if ($isEquationNode(node)) {
            node.setFormat(formatType);
            return true;
          }
          return false;
        }
        if ($isRangeSelection(selection)) {
          // Only consume the command if the range actually contains this
          // equation; otherwise defer to the core handler (paragraphs etc.).
          const nodes = selection.getNodes();
          if (!nodes.some((n) => $isEquationNode(n) && n.getKey() === nodeKey)) {
            return false;
          }
          for (const node of nodes) {
            if ($isEquationNode(node)) {
              node.setFormat(formatType);
            } else {
              $getNearestBlockElementAncestorOrThrow(node).setFormat(formatType);
            }
          }
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, inline, nodeKey]);

  // Enter edit mode automatically when a freshly-inserted empty node is selected.
  // (Mirrors the playground, where inserting an empty equation drops you into
  //  the editor.) Only auto-opens once, for an empty equation.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (
      !autoOpenedRef.current &&
      isSelected &&
      editable &&
      equation.trim().length === 0 &&
      !editing
    ) {
      autoOpenedRef.current = true;
      setEditing(true);
      setDraft("");
    }
  }, [isSelected, editable, equation, editing]);

  if (editing) {
    const editorEl = (
      <EquationEditor
        equation={draft}
        inline={inline}
        setEquation={setDraft}
        onConfirm={commit}
        onCancel={cancel}
      />
    );
    return inline ? (
      <span ref={setContainer} className="inline-flex align-baseline">
        {editorEl}
      </span>
    ) : (
      <div
        ref={setContainer}
        className="flex w-full"
        style={{ justifyContent: justifyForFormat(format) }}
      >
        {editorEl}
      </div>
    );
  }

  const selectedRing = isSelected
    ? "ring-1 ring-accent bg-accentSoft"
    : "ring-1 ring-transparent hover:bg-panel2";

  if (inline) {
    return (
      <span
        ref={setContainer}
        title={editable ? "双击编辑公式" : equation}
        onDoubleClick={editable ? enterEditOnDouble : undefined}
        className={[
          "mx-0.5 inline-flex cursor-text items-baseline rounded-lg px-1 align-baseline transition",
          editable ? selectedRing : "",
        ].join(" ")}
      >
        <KatexRenderer
          equation={equation}
          inline
          onDoubleClick={enterEdit}
        />
      </span>
    );
  }

  // Block equation: an outer flex host applies the element alignment
  // (left/center/right/justify) chosen via the toolbar, and an inner box holds
  // the KaTeX render + selection ring so the ring hugs the equation rather than
  // spanning the full line width.
  return (
    <div
      className="my-1 flex w-full"
      style={{ justifyContent: justifyForFormat(format) }}
    >
      <div
        ref={setContainer}
        title={editable ? "双击编辑公式" : equation}
        onDoubleClick={editable ? enterEditOnDouble : undefined}
        className={[
          "cursor-text rounded-xl px-3 py-2 transition",
          editable ? selectedRing : "",
        ].join(" ")}
      >
        <KatexRenderer equation={equation} inline={false} onDoubleClick={enterEdit} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Serialized shape
// ---------------------------------------------------------------------------

export type SerializedEquationNode = Spread<
  {
    equation: string;
    inline: boolean;
    // Element alignment for block equations (matches DecoratorBlockNode's
    // serialization). Persisted so alignment survives a JSON round-trip.
    // Empty string for inline equations / unset alignment.
    format: ElementFormatType;
  },
  SerializedLexicalNode
>;

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

export class EquationNode extends DecoratorNode<JSX.Element> {
  /** The LaTeX source string. */
  __equation: string;
  /** Whether the equation renders inline (true) or as a block (false). */
  __inline: boolean;
  /**
   * Element alignment for the block path (left/center/right/justify), mirroring
   * DecoratorBlockNode's `__format`. Empty string = unset (defaults to left).
   * Unused for inline equations (they inherit the paragraph's alignment).
   */
  __format: ElementFormatType;

  static getType(): string {
    return "equation";
  }

  static clone(node: EquationNode): EquationNode {
    return new EquationNode(
      node.__equation,
      node.__inline,
      node.__format,
      node.__key,
    );
  }

  static importJSON(serialized: SerializedEquationNode): EquationNode {
    return $createEquationNode(
      serialized.equation,
      serialized.inline,
    ).updateFromJSON(serialized);
  }

  static importDOM(): DOMConversionMap | null {
    return {
      img: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute("data-lexical-equation")) return null;
        return { conversion: convertEquationElement, priority: 2 };
      },
      span: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute("data-lexical-equation")) return null;
        return { conversion: convertEquationElement, priority: 1 };
      },
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute("data-lexical-equation")) return null;
        return { conversion: convertEquationElement, priority: 1 };
      },
    };
  }

  constructor(
    equation = "",
    inline = false,
    format: ElementFormatType = "",
    key?: NodeKey,
  ) {
    super(key);
    this.__equation = equation;
    this.__inline = inline;
    this.__format = format;
  }

  // Carry __format across writable clones (matches DecoratorBlockNode).
  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__format = prevNode.__format;
  }

  exportJSON(): SerializedEquationNode {
    return {
      ...super.exportJSON(),
      type: "equation",
      version: 1,
      equation: this.__equation,
      inline: this.__inline,
      // Persist alignment so it survives a JSON round-trip, like
      // DecoratorBlockNode. Inline equations keep "" (no element format).
      format: this.__inline ? "" : this.__format || "",
    };
  }

  updateFromJSON(
    serialized: LexicalUpdateJSON<SerializedEquationNode>,
  ): this {
    return super
      .updateFromJSON(serialized)
      .setFormat(serialized.format || "");
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement(this.__inline ? "span" : "div");
    // KaTeX-rendered markup so pasted-out content displays without the editor.
    element.innerHTML = renderEquation(this.__equation, this.__inline);
    element.setAttribute("data-lexical-equation", encodeURIComponent(this.__equation));
    element.setAttribute("data-lexical-inline", this.__inline ? "true" : "false");
    // Carry block alignment through the HTML path too, else a centered/right
    // equation reverts to left after an HTML copy/paste round-trip (JSON already
    // round-trips it via exportJSON). Inline equations have no element format.
    if (!this.__inline && this.__format) {
      element.setAttribute("data-lexical-format", this.__format);
    }
    return { element };
  }

  // ---- DOM lifecycle ------------------------------------------------------

  createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement(this.__inline ? "span" : "div");
    el.style.display = this.__inline ? "inline-flex" : "block";
    el.className = "lexical-equation";
    return el;
  }

  updateDOM(prevNode: EquationNode): boolean {
    // Inline <-> block toggle changes the host element type; recreate the DOM.
    return this.__inline !== prevNode.__inline;
  }

  isInline(): boolean {
    return this.__inline;
  }

  // ---- mutators -----------------------------------------------------------

  getEquation(): string {
    return this.getLatest().__equation;
  }

  setEquation(equation: string): this {
    const self = this.getWritable();
    self.__equation = equation;
    return self;
  }

  getInline(): boolean {
    return this.getLatest().__inline;
  }

  setInline(inline: boolean): this {
    const self = this.getWritable();
    self.__inline = inline;
    return self;
  }

  // ---- element format (block alignment, mirrors DecoratorBlockNode) --------

  getFormat(): ElementFormatType {
    return this.getLatest().__format;
  }

  setFormat(format: ElementFormatType): this {
    const self = this.getWritable();
    self.__format = format;
    return self;
  }

  // Block equations are not indentable (matches DecoratorBlockNode).
  canIndent(): false {
    return false;
  }

  /** LaTeX wrapped in delimiters, for plain-text copy & markdown export. */
  getTextContent(): string {
    const { __equation, __inline } = this.getLatest();
    return __inline ? `$${__equation}$` : `$$${__equation}$$`;
  }

  // ---- render -------------------------------------------------------------

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return (
      <EquationComponent
        equation={this.__equation}
        inline={this.__inline}
        format={this.__inline ? null : this.__format || null}
        nodeKey={this.getKey()}
      />
    );
  }
}

// ---------------------------------------------------------------------------
// DOM import conversion (paste of an exported equation element)
// ---------------------------------------------------------------------------

function convertEquationElement(
  domNode: HTMLElement,
): DOMConversionOutput | null {
  const raw = domNode.getAttribute("data-lexical-equation");
  if (raw == null) return null;
  let equation = "";
  try {
    equation = decodeURIComponent(raw);
  } catch {
    equation = raw;
  }
  const inline =
    domNode.getAttribute("data-lexical-inline") === "true" ||
    domNode.tagName.toLowerCase() === "span";
  const node = $createEquationNode(equation, inline);
  // Restore block alignment written by exportDOM (only a known set of values).
  const fmt = domNode.getAttribute("data-lexical-format");
  if (!inline && fmt && ["left", "center", "right", "justify", "start", "end"].includes(fmt)) {
    node.setFormat(fmt as ElementFormatType);
  }
  return { node };
}

// ---------------------------------------------------------------------------
// Helpers (exported)
// ---------------------------------------------------------------------------

export function $createEquationNode(
  equation = "",
  inline = false,
): EquationNode {
  return $applyNodeReplacement(new EquationNode(equation, inline));
}

export function $isEquationNode(
  node: LexicalNode | null | undefined,
): node is EquationNode {
  return node instanceof EquationNode;
}

// ---------------------------------------------------------------------------
// Command + plugin
// ---------------------------------------------------------------------------

export interface InsertEquationPayload {
  equation: string;
  inline: boolean;
}

export const INSERT_EQUATION_COMMAND: LexicalCommand<InsertEquationPayload> =
  createCommand("INSERT_EQUATION_COMMAND");

/**
 * Registers INSERT_EQUATION_COMMAND. Inserts a new EquationNode and selects it
 * as a NodeSelection, so the auto-open-editor effect can drop the user straight
 * into editing when the equation is empty — matching the playground.
 */
export function EquationsPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor.hasNodes([EquationNode])) {
      throw new Error("EquationsPlugin: EquationNode not registered on editor");
    }

    return editor.registerCommand<InsertEquationPayload>(
      INSERT_EQUATION_COMMAND,
      (payload) => {
        const { equation, inline } = payload;
        const node = $createEquationNode(equation, inline);
        $insertNodes([node]);
        // Select the freshly-inserted node so the editor can auto-open when empty.
        const selection = $createNodeSelection();
        selection.add(node.getKey());
        $setSelection(selection);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  return null;
}
