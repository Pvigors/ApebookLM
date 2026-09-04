// Interactive Poll block (aligned 1:1 with the Lexical playground "Poll" plugin).
//
// A DecoratorNode that stores a `question` plus an ordered list of `options`,
// where every option is `{ uid, text, votes }` and `votes` is an array of stable
// per-client IDs. Voting toggles the current client's id in/out of an option's
// votes array (multi-select, exactly like the playground). The decorated React
// component renders the question, each option row (a checkbox-style toggle, the
// editable option text, the vote count, and a proportional progress bar), and an
// "add option" affordance plus per-option delete.
//
// Mutations go through dedicated Lexical commands (PollNode.addOption /
// toggleVote / setOptionText / deleteOption) wrapped in editor.update so the
// editor history + collaborative state stay correct — matching the playground.
//
// The whole node round-trips through editor-state JSON (exportJSON/importJSON
// with a stable `type` + `version`) so notes containing polls persist losslessly.
//
// NOTE: no "use client" here on purpose — this module is imported by a
// 'use client' editor component, and is also referenced from server code only
// for its types. No new dependencies.

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $insertNodeToNearestRoot } from "@lexical/utils";
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $getNodeByKey,
  $isRootOrShadowRoot,
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
import * as React from "react";

/* ========================================================================== *
 *  Types + tiny helpers
 * ========================================================================== */

export type PollOption = {
  readonly uid: string;
  readonly text: string;
  readonly votes: ReadonlyArray<string>;
};

export type PollOptions = ReadonlyArray<PollOption>;

/** Short, collision-resistant id for options (mirrors the playground's createUID). */
function createPollOptionUID(): string {
  return Math.random()
    .toString(36)
    .replace(/[^a-z]+/g, "")
    .substring(0, 5);
}

export function createPollOption(text = ""): PollOption {
  return { uid: createPollOptionUID(), text, votes: [] };
}

function cloneOption(
  option: PollOption,
  text: string,
  votes?: ReadonlyArray<string>,
): PollOption {
  return { uid: option.uid, text, votes: votes ?? option.votes };
}

/**
 * A stable id for *this browser tab/client*, persisted to localStorage so a
 * reload keeps "my vote". The playground uses a session-scoped client id for
 * the same purpose; we persist it so reloads are stable. Falls back to an
 * in-memory id when storage is unavailable (SSR / private mode).
 */
const CLIENT_ID_STORAGE_KEY = "lexical-poll-client-id";
let inMemoryClientID: string | null = null;

function getClientID(): string {
  if (inMemoryClientID !== null) {
    return inMemoryClientID;
  }
  let id: string | null = null;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      id = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
      if (!id) {
        id =
          Math.random().toString(36).slice(2) +
          Date.now().toString(36);
        window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
      }
    }
  } catch {
    // localStorage blocked — fall through to an in-memory id.
  }
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  inMemoryClientID = id;
  return id;
}

/** Total distinct votes across every option (denominator for the bars). */
function getTotalVotes(options: PollOptions): number {
  return options.reduce((sum, option) => sum + option.votes.length, 0);
}

/* ========================================================================== *
 *  Serialized shape
 * ========================================================================== */

export type SerializedPollNode = Spread<
  {
    question: string;
    options: PollOptions;
  },
  SerializedLexicalNode
>;

function $convertPollElement(domNode: HTMLElement): DOMConversionOutput | null {
  const question = domNode.getAttribute("data-lexical-poll-question");
  const optionsAttr = domNode.getAttribute("data-lexical-poll-options");
  if (question !== null && optionsAttr !== null) {
    let options: PollOptions = [];
    try {
      const parsed: unknown = JSON.parse(optionsAttr);
      if (Array.isArray(parsed)) {
        options = parsed
          .filter(
            (o): o is PollOption =>
              typeof o === "object" &&
              o !== null &&
              typeof (o as PollOption).uid === "string" &&
              typeof (o as PollOption).text === "string" &&
              Array.isArray((o as PollOption).votes),
          )
          .map((o) => ({ uid: o.uid, text: o.text, votes: [...o.votes] }));
      }
    } catch {
      options = [];
    }
    const node = $createPollNode(question, options);
    return { node };
  }
  return null;
}

/* ========================================================================== *
 *  PollNode
 * ========================================================================== */

export class PollNode extends DecoratorNode<React.JSX.Element> {
  __question: string;
  __options: PollOptions;

  static getType(): string {
    return "poll";
  }

  static clone(node: PollNode): PollNode {
    return new PollNode(node.__question, node.__options, node.__key);
  }

  static importJSON(serializedNode: SerializedPollNode): PollNode {
    return $createPollNode(
      serializedNode.question,
      serializedNode.options,
    ).updateFromJSON(serializedNode);
  }

  constructor(question: string, options: PollOptions, key?: NodeKey) {
    super(key);
    this.__question = question;
    this.__options = options;
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedPollNode>): this {
    const self = super.updateFromJSON(serializedNode);
    return self
      .setQuestion(serializedNode.question)
      .setOptions(
        serializedNode.options.map((o) => ({
          uid: o.uid,
          text: o.text,
          votes: [...o.votes],
        })),
      );
  }

  exportJSON(): SerializedPollNode {
    return {
      ...super.exportJSON(),
      type: "poll",
      version: 1,
      question: this.__question,
      options: this.__options.map((o) => ({
        uid: o.uid,
        text: o.text,
        votes: [...o.votes],
      })),
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute("data-lexical-poll-question")) {
          return null;
        }
        return {
          conversion: $convertPollElement,
          priority: 2,
        };
      },
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("div");
    element.setAttribute("data-lexical-poll-question", this.__question);
    element.setAttribute(
      "data-lexical-poll-options",
      JSON.stringify(
        this.__options.map((o) => ({
          uid: o.uid,
          text: o.text,
          votes: [...o.votes],
        })),
      ),
    );
    return { element };
  }

  /* ---- readers ---- */

  getQuestion(): string {
    return this.getLatest().__question;
  }

  getOptions(): PollOptions {
    return this.getLatest().__options;
  }

  getTextContent(): string {
    const self = this.getLatest();
    const optionsText = self.__options.map((o) => o.text).join(", ");
    return optionsText ? `${self.__question} ${optionsText}` : self.__question;
  }

  /* ---- writers (all `this`-chaining, used inside editor.update) ---- */

  setQuestion(question: string): this {
    const writable = this.getWritable();
    writable.__question = question;
    return writable;
  }

  setOptions(options: PollOptions): this {
    const writable = this.getWritable();
    writable.__options = options;
    return writable;
  }

  addOption(option: PollOption): this {
    const writable = this.getWritable();
    writable.__options = [...this.getLatest().__options, option];
    return writable;
  }

  deleteOption(uid: string): this {
    const writable = this.getWritable();
    writable.__options = this.getLatest().__options.filter(
      (o) => o.uid !== uid,
    );
    return writable;
  }

  setOptionText(uid: string, text: string): this {
    const writable = this.getWritable();
    writable.__options = this.getLatest().__options.map((o) =>
      o.uid === uid ? cloneOption(o, text) : o,
    );
    return writable;
  }

  /** Toggle `clientID`'s vote on `uid` (multi-select; matches the playground). */
  toggleVote(uid: string, clientID: string): this {
    const writable = this.getWritable();
    writable.__options = this.getLatest().__options.map((o) => {
      if (o.uid !== uid) {
        return o;
      }
      const hasVoted = o.votes.includes(clientID);
      const votes = hasVoted
        ? o.votes.filter((id) => id !== clientID)
        : [...o.votes, clientID];
      return cloneOption(o, o.text, votes);
    });
    return writable;
  }

  /* ---- rendering ---- */

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement("div");
    const className = config.theme.poll;
    if (typeof className === "string") {
      element.className = className;
    }
    return element;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): React.JSX.Element {
    return (
      <PollComponent
        nodeKey={this.getKey()}
        question={this.__question}
        options={this.__options}
      />
    );
  }

  isInline(): false {
    return false;
  }
}

export function $createPollNode(
  question: string,
  options: PollOptions,
): PollNode {
  return $applyNodeReplacement(new PollNode(question, options));
}

export function $isPollNode(
  node: LexicalNode | null | undefined,
): node is PollNode {
  return node instanceof PollNode;
}

/* ========================================================================== *
 *  Decorated React component
 * ========================================================================== */

type PollComponentProps = {
  nodeKey: NodeKey;
  question: string;
  options: PollOptions;
};

function PollComponent({
  nodeKey,
  question,
  options,
}: PollComponentProps): React.JSX.Element {
  const [editor] = useLexicalComposerContext();
  const isEditable = useEditable(editor);
  const clientID = React.useMemo(() => getClientID(), []);
  const totalVotes = React.useMemo(() => getTotalVotes(options), [options]);

  const withPollNode = React.useCallback(
    (cb: (node: PollNode) => void): void => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isPollNode(node)) {
          cb(node);
        }
      });
    },
    [editor, nodeKey],
  );

  const handleToggleVote = React.useCallback(
    (uid: string) => withPollNode((node) => node.toggleVote(uid, clientID)),
    [withPollNode, clientID],
  );

  const handleSetText = React.useCallback(
    (uid: string, text: string) =>
      withPollNode((node) => node.setOptionText(uid, text)),
    [withPollNode],
  );

  const handleDelete = React.useCallback(
    (uid: string) => withPollNode((node) => node.deleteOption(uid)),
    [withPollNode],
  );

  const handleAddOption = React.useCallback(
    () => withPollNode((node) => node.addOption(createPollOption())),
    [withPollNode],
  );

  const handleSetQuestion = React.useCallback(
    (text: string) => withPollNode((node) => node.setQuestion(text)),
    [withPollNode],
  );

  return (
    <div
      className="my-2 w-full max-w-[400px] select-none rounded-lg border border-edge bg-panel p-3 elev-soft"
      data-lexical-decorator="true"
    >
      <div className="mb-2 flex items-start gap-1.5">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mt-0.5 shrink-0 text-accent"
          aria-hidden
        >
          <path d="M3 3v18h18" />
          <rect x="7" y="11" width="3" height="6" rx="1" />
          <rect x="12" y="7" width="3" height="10" rx="1" />
          <rect x="17" y="13" width="3" height="4" rx="1" />
        </svg>
        {isEditable ? (
          <AutoGrowInput
            value={question}
            placeholder="投票问题…"
            onChange={handleSetQuestion}
            className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-ink outline-none placeholder:text-muted"
            ariaLabel="投票问题"
          />
        ) : (
          <h3 className="min-w-0 flex-1 text-sm font-semibold text-ink">
            {question || "投票"}
          </h3>
        )}
      </div>

      <ul className="flex flex-col gap-1.5" role="list">
        {options.map((option, index) => (
          <PollOptionRow
            key={option.uid}
            option={option}
            index={index}
            totalVotes={totalVotes}
            checked={option.votes.includes(clientID)}
            editable={isEditable}
            canDelete={options.length > 1}
            onToggle={handleToggleVote}
            onSetText={handleSetText}
            onDelete={handleDelete}
          />
        ))}
      </ul>

      <div className="mt-2 flex items-center justify-between gap-2">
        {isEditable ? (
          <button
            type="button"
            onClick={handleAddOption}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent transition hover:bg-accentSoft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            添加选项
          </button>
        ) : (
          <span aria-hidden />
        )}
        <span className="text-xs tabular-nums text-muted">
          {totalVotes} 票
        </span>
      </div>
    </div>
  );
}

/* ---- single option row ---- */

type PollOptionRowProps = {
  option: PollOption;
  index: number;
  totalVotes: number;
  checked: boolean;
  editable: boolean;
  canDelete: boolean;
  onToggle: (uid: string) => void;
  onSetText: (uid: string, text: string) => void;
  onDelete: (uid: string) => void;
};

function PollOptionRow({
  option,
  index,
  totalVotes,
  checked,
  editable,
  canDelete,
  onToggle,
  onSetText,
  onDelete,
}: PollOptionRowProps): React.JSX.Element {
  const count = option.votes.length;
  const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;

  return (
    <li
      className={`group relative flex items-center gap-2 overflow-hidden rounded-lg border px-2 py-1 transition ${
        checked
          ? "border-accent bg-accentSoft"
          : "border-edge bg-panel2 hover:border-accent/40"
      }`}
    >
      {/* proportional fill behind the row content */}
      <span
        className="pointer-events-none absolute inset-y-0 left-0 bg-accent/10 transition-[width] duration-300 ease-out"
        style={{ width: `${pct}%` }}
        aria-hidden
      />

      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={`为「${option.text || `选项 ${index + 1}`}」投票`}
        onClick={() => onToggle(option.uid)}
        className={`relative z-[1] flex h-4 w-4 shrink-0 items-center justify-center rounded border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          checked
            ? "border-accent bg-accent text-onAccent"
            : "border-edge bg-panel text-transparent hover:border-accent"
        }`}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </button>

      {editable ? (
        <AutoGrowInput
          value={option.text}
          placeholder={`选项 ${index + 1}`}
          onChange={(text) => onSetText(option.uid, text)}
          className="relative z-[1] min-w-0 flex-1 bg-transparent py-1 text-sm text-ink outline-none placeholder:text-muted"
          ariaLabel={`选项 ${index + 1} 文案`}
        />
      ) : (
        <span className="relative z-[1] min-w-0 flex-1 truncate py-1 text-sm text-ink">
          {option.text || `选项 ${index + 1}`}
        </span>
      )}

      <span className="relative z-[1] shrink-0 text-[11px] tabular-nums text-ink2">
        {pct}% · {count}
      </span>

      {editable && canDelete ? (
        <button
          type="button"
          aria-label={`删除选项 ${index + 1}`}
          onClick={() => onDelete(option.uid)}
          className="relative z-[1] flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted opacity-0 transition hover:bg-edge hover:text-ink focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      ) : null}
    </li>
  );
}

/* ---- auto-growing single-line text input (commits on change) ---- */

type AutoGrowInputProps = {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  className: string;
  ariaLabel: string;
};

function AutoGrowInput({
  value,
  placeholder,
  onChange,
  className,
  ariaLabel,
}: AutoGrowInputProps): React.JSX.Element {
  // Local mirror so typing stays smooth even while the editor re-decorates.
  const [local, setLocal] = React.useState(value);
  const isFocused = React.useRef(false);

  React.useEffect(() => {
    if (!isFocused.current) {
      setLocal(value);
    }
  }, [value]);

  return (
    <input
      type="text"
      name="poll-text"
      autoComplete="off"
      value={local}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className}
      onFocus={() => {
        isFocused.current = true;
      }}
      onBlur={() => {
        isFocused.current = false;
        if (local !== value) {
          onChange(local);
        }
      }}
      onChange={(e) => {
        setLocal(e.target.value);
        onChange(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/* ---- track editor.isEditable() reactively ---- */

function useEditable(editor: LexicalEditor): boolean {
  const [editable, setEditable] = React.useState(() => editor.isEditable());
  React.useEffect(() => {
    setEditable(editor.isEditable());
    return editor.registerEditableListener((value) => setEditable(value));
  }, [editor]);
  return editable;
}

/* ========================================================================== *
 *  Command + plugin
 * ========================================================================== */

export type InsertPollPayload = {
  question: string;
  options?: PollOptions;
};

export const INSERT_POLL_COMMAND: LexicalCommand<InsertPollPayload> =
  createCommand("INSERT_POLL_COMMAND");

export function PollPlugin(): null {
  const [editor] = useLexicalComposerContext();

  React.useEffect(() => {
    if (!editor.hasNodes([PollNode])) {
      throw new Error("PollPlugin: PollNode is not registered on editor");
    }

    return editor.registerCommand<InsertPollPayload>(
      INSERT_POLL_COMMAND,
      (payload) => {
        const options =
          payload.options && payload.options.length > 0
            ? payload.options
            : [createPollOption(), createPollOption()];
        const pollNode = $createPollNode(payload.question, options);
        $insertNodeToNearestRoot(pollNode);

        // Keep an editable paragraph after a poll inserted at the document end,
        // so the caret is never trapped — matches the playground's insert UX.
        const parent = pollNode.getParentOrThrow();
        if ($isRootOrShadowRoot(parent) && pollNode.getNextSibling() === null) {
          pollNode.insertAfter($createParagraphNode());
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  return null;
}
