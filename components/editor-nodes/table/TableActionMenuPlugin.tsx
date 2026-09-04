"use client";

/*
 * Portions adapted from Lexical Playground.
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/facebook/lexical
 */

// TableActionMenuPlugin — the cell-corner dropdown button → menu of table edits.
// Adapted from the Lexical playground's TableActionMenuPlugin to this project's
// Tailwind tokens (accent #6d5ae6 / bg-panel / panel2 / ink·ink2 / edge) with
// fully Chinese labels. Uses @lexical/table 0.45 utilities only; any sub-feature
// whose API is absent is simply skipped (none are absent in 0.45).
//
// "use client" — uses portals, DOM events and React state.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $deleteTableColumn__EXPERIMENTAL,
  $deleteTableRow__EXPERIMENTAL,
  $getTableCellNodeFromLexicalNode,
  $getTableColumnIndexFromTableCellNode,
  $getTableNodeFromLexicalNodeOrThrow,
  $getTableRowIndexFromTableCellNode,
  $insertTableColumn__EXPERIMENTAL,
  $insertTableRow__EXPERIMENTAL,
  $isTableCellNode,
  $isTableSelection,
  getTableElement,
  TableCellHeaderStates,
  type TableCellNode,
} from "@lexical/table";
import {
  $getSelection,
  $isRangeSelection,
  $isElementNode,
  getDOMSelection,
  type LexicalEditor,
} from "lexical";

// background-color swatches offered for a cell (same palette as the toolbar).
const CELL_SWATCHES = [
  "#ffffff", "#f3f3fd", "#fde2e4", "#ffe8cc", "#fff3bf",
  "#d3f9d8", "#c5f6fa", "#d0ebff", "#ece9fc", "#f3d9fa",
];

const V_ALIGN: [string, string][] = [
  ["top", "上"],
  ["middle", "中"],
  ["bottom", "下"],
];

type Selection =
  | { type: "range"; cellCount: number }
  | { type: "table"; rowCount: number; colCount: number };

function $computeSelectionCount(): { columns: number; rows: number } {
  const selection = $getSelection();
  if ($isTableSelection(selection)) {
    const shape = selection.getShape();
    return {
      columns: shape.toX - shape.fromX + 1,
      rows: shape.toY - shape.fromY + 1,
    };
  }
  // No multi-cell selection → treat as the one focused cell (1×1), so insert
  // counts are ≥1 (column-insert loops on this) and labels don't read "0行/0列".
  return { columns: 1, rows: 1 };
}

function TableActionMenu({
  editor,
  tableCellNode,
  onClose,
  setIsMenuOutside,
  contextRef,
}: {
  editor: LexicalEditor;
  tableCellNode: TableCellNode;
  onClose: () => void;
  setIsMenuOutside: (b: boolean) => void;
  contextRef: { current: HTMLDivElement | null };
}) {
  const dropDownRef = useRef<HTMLDivElement | null>(null);
  const [selectionCounts, updateSelectionCounts] = useState({ rows: 1, columns: 1 });

  useEffect(() => {
    editor.getEditorState().read(() => {
      updateSelectionCounts($computeSelectionCount());
    });
  }, [editor]);

  useEffect(() => {
    const menu = dropDownRef.current;
    const button = contextRef.current;
    if (menu != null && button != null) {
      const buttonRect = button.getBoundingClientRect();
      // position:fixed → viewport coords (no scroll offset). Cap height so a tall
      // menu never exceeds the viewport (then it scrolls).
      menu.style.maxHeight = `${window.innerHeight - 16}px`;
      const menuRect = menu.getBoundingClientRect();
      let top = buttonRect.bottom + 4;
      let left = buttonRect.left;
      if (left + menuRect.width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - menuRect.width - 8);
        setIsMenuOutside(true);
      }
      // clamp vertically so the bottom (垂直对齐/冻结…) isn't cut off — shift up if needed.
      if (top + menuRect.height > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - menuRect.height - 8);
      }
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
    }
  }, [contextRef, dropDownRef, setIsMenuOutside]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        dropDownRef.current != null &&
        contextRef.current != null &&
        !dropDownRef.current.contains(target) &&
        !contextRef.current.contains(target)
      ) {
        onClose();
      }
    };
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [contextRef, onClose]);

  const clearTableSelection = useCallback(() => {
    editor.update(() => {
      if (tableCellNode.isAttached()) {
        const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
        const tableElement = getTableElement(tableNode, editor.getElementByKey(tableNode.getKey()));
        if (!tableElement) return;
        const sel = getDOMSelection(editor.getRootElement()?.ownerDocument.defaultView ?? null);
        sel?.removeAllRanges();
      }
    });
  }, [editor, tableCellNode]);

  const insertTableRowAtSelection = useCallback(
    (shouldInsertAfter: boolean) => {
      editor.update(() => {
        $insertTableRow__EXPERIMENTAL(shouldInsertAfter);
        onClose();
      });
    },
    [editor, onClose]
  );

  const insertTableColumnAtSelection = useCallback(
    (shouldInsertAfter: boolean) => {
      editor.update(() => {
        for (let i = 0; i < selectionCounts.columns; i++) {
          $insertTableColumn__EXPERIMENTAL(shouldInsertAfter);
        }
        onClose();
      });
    },
    [editor, onClose, selectionCounts.columns]
  );

  const deleteTableRowAtSelection = useCallback(() => {
    editor.update(() => {
      $deleteTableRow__EXPERIMENTAL();
      onClose();
    });
  }, [editor, onClose]);

  const deleteTableColumnAtSelection = useCallback(() => {
    editor.update(() => {
      $deleteTableColumn__EXPERIMENTAL();
      onClose();
    });
  }, [editor, onClose]);

  const deleteTable = useCallback(() => {
    editor.update(() => {
      const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
      tableNode.remove();
      clearTableSelection();
      onClose();
    });
  }, [editor, tableCellNode, clearTableSelection, onClose]);

  const toggleTableRowIsHeader = useCallback(() => {
    editor.update(() => {
      const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
      const tableRowIndex = $getTableRowIndexFromTableCellNode(tableCellNode);
      const tableRows = tableNode.getChildren();
      if (tableRowIndex >= tableRows.length || tableRowIndex < 0) return;
      const tableRow = tableRows[tableRowIndex];
      if (!$isElementNode(tableRow)) return;
      const willBeHeader = !(tableCellNode.__headerState & TableCellHeaderStates.ROW);
      tableRow.getChildren().forEach((cell) => {
        if ($isTableCellNode(cell)) {
          if (willBeHeader) {
            if (!(cell.__headerState & TableCellHeaderStates.ROW))
              cell.toggleHeaderStyle(TableCellHeaderStates.ROW);
          } else if (cell.__headerState & TableCellHeaderStates.ROW) {
            cell.toggleHeaderStyle(TableCellHeaderStates.ROW);
          }
        }
      });
      clearTableSelection();
      onClose();
    });
  }, [editor, tableCellNode, clearTableSelection, onClose]);

  const toggleTableColumnIsHeader = useCallback(() => {
    editor.update(() => {
      const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
      const columnIndex = $getTableColumnIndexFromTableCellNode(tableCellNode);
      const tableRows = tableNode.getChildren();
      const willBeHeader = !(tableCellNode.__headerState & TableCellHeaderStates.COLUMN);
      for (let r = 0; r < tableRows.length; r++) {
        const tableRow = tableRows[r];
        if (!$isElementNode(tableRow)) continue;
        const cell = tableRow.getChildren()[columnIndex];
        if ($isTableCellNode(cell)) {
          if (willBeHeader) {
            if (!(cell.__headerState & TableCellHeaderStates.COLUMN))
              cell.toggleHeaderStyle(TableCellHeaderStates.COLUMN);
          } else if (cell.__headerState & TableCellHeaderStates.COLUMN) {
            cell.toggleHeaderStyle(TableCellHeaderStates.COLUMN);
          }
        }
      }
      clearTableSelection();
      onClose();
    });
  }, [editor, tableCellNode, clearTableSelection, onClose]);

  const setCellBackground = useCallback(
    (color: string | null) => {
      editor.update(() => {
        const selection = $getSelection();
        const cells: TableCellNode[] = [];
        if ($isTableSelection(selection)) {
          selection.getNodes().forEach((n) => {
            const cell = $getTableCellNodeFromLexicalNode(n);
            if (cell && !cells.includes(cell)) cells.push(cell);
          });
        }
        if (cells.length === 0) cells.push(tableCellNode);
        cells.forEach((c) => c.setBackgroundColor(color));
        onClose();
      });
    },
    [editor, tableCellNode, onClose]
  );

  const setVerticalAlign = useCallback(
    (value: string) => {
      editor.update(() => {
        tableCellNode.setVerticalAlign(value);
        onClose();
      });
    },
    [editor, tableCellNode, onClose]
  );

  const toggleRowStriping = useCallback(() => {
    editor.update(() => {
      const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
      tableNode.setRowStriping(!tableNode.getRowStriping());
      clearTableSelection();
      onClose();
    });
  }, [editor, tableCellNode, clearTableSelection, onClose]);

  const toggleFirstRowFreeze = useCallback(() => {
    editor.update(() => {
      const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
      tableNode.setFrozenRows(tableNode.getFrozenRows() === 0 ? 1 : 0);
      clearTableSelection();
      onClose();
    });
  }, [editor, tableCellNode, clearTableSelection, onClose]);

  const toggleFirstColumnFreeze = useCallback(() => {
    editor.update(() => {
      const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
      tableNode.setFrozenColumns(tableNode.getFrozenColumns() === 0 ? 1 : 0);
      clearTableSelection();
      onClose();
    });
  }, [editor, tableCellNode, clearTableSelection, onClose]);

  const Item = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
    <button
      type="button"
      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] text-ink transition hover:bg-panel2"
      onClick={onClick}
    >
      {children}
    </button>
  );
  const Divider = () => <div className="my-1 h-px bg-edge" />;

  return createPortal(
    <div
      className="elev-soft fixed z-[70] min-w-[184px] overflow-y-auto overscroll-contain rounded-xl border border-edge bg-panel py-1 text-ink"
      ref={dropDownRef}
      onClick={(e) => e.stopPropagation()}
    >
      <Item onClick={() => insertTableRowAtSelection(false)}>
        <span>上方插入{selectionCounts.rows === 1 ? "" : ` ${selectionCounts.rows}`}行</span>
      </Item>
      <Item onClick={() => insertTableRowAtSelection(true)}>
        <span>下方插入{selectionCounts.rows === 1 ? "" : ` ${selectionCounts.rows}`}行</span>
      </Item>
      <Item onClick={() => insertTableColumnAtSelection(false)}>
        <span>左侧插入{selectionCounts.columns === 1 ? "" : ` ${selectionCounts.columns}`}列</span>
      </Item>
      <Item onClick={() => insertTableColumnAtSelection(true)}>
        <span>右侧插入{selectionCounts.columns === 1 ? "" : ` ${selectionCounts.columns}`}列</span>
      </Item>
      <Divider />
      <Item onClick={deleteTableRowAtSelection}>
        <span>删除行</span>
      </Item>
      <Item onClick={deleteTableColumnAtSelection}>
        <span>删除列</span>
      </Item>
      <Item onClick={deleteTable}>
        <span className="text-[#e11d48]">删除表格</span>
      </Item>
      <Divider />
      <Item onClick={toggleTableRowIsHeader}>
        <span>
          {(tableCellNode.__headerState & TableCellHeaderStates.ROW) === TableCellHeaderStates.ROW
            ? "取消行表头"
            : "切换行表头"}
        </span>
      </Item>
      <Item onClick={toggleTableColumnIsHeader}>
        <span>
          {(tableCellNode.__headerState & TableCellHeaderStates.COLUMN) ===
          TableCellHeaderStates.COLUMN
            ? "取消列表头"
            : "切换列表头"}
        </span>
      </Item>
      <Item onClick={toggleRowStriping}>
        <span>切换行条纹</span>
      </Item>
      <Divider />
      {/* cell background color */}
      <div className="px-3 py-1.5">
        <div className="mb-1.5 text-[12px] text-ink2">单元格背景色</div>
        <div className="flex flex-wrap gap-1.5">
          {CELL_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => setCellBackground(c)}
              className="h-5 w-5 rounded-md border border-edge transition hover:scale-110"
              style={{ background: c }}
            />
          ))}
          <button
            type="button"
            title="清除背景"
            onClick={() => setCellBackground(null)}
            className="grid h-5 w-5 place-items-center rounded-md border border-edge text-[11px] text-ink2 transition hover:bg-panel2"
          >
            ⌀
          </button>
        </div>
      </div>
      {/* vertical align */}
      <div className="px-3 py-1.5">
        <div className="mb-1.5 text-[12px] text-ink2">垂直对齐</div>
        <div className="flex gap-1">
          {V_ALIGN.map(([val, label]) => {
            // node method → must run inside editor.read() (render has no active editor state)
            const active = (editor.read(() => tableCellNode.getVerticalAlign()) ?? "top") === val;
            return (
              <button
                key={val}
                type="button"
                onClick={() => setVerticalAlign(val)}
                className={
                  "flex-1 rounded-md border px-2 py-1 text-[12px] transition " +
                  (active
                    ? "border-accent bg-accentSoft text-accent"
                    : "border-edge text-ink2 hover:bg-panel2")
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <Divider />
      <Item onClick={toggleFirstRowFreeze}>
        <span>冻结首行</span>
      </Item>
      <Item onClick={toggleFirstColumnFreeze}>
        <span>冻结首列</span>
      </Item>
    </div>,
    document.body
  );
}

function TableCellActionMenuContainer({
  anchorElem,
}: {
  anchorElem: HTMLElement;
}): ReactNode {
  const [editor] = useLexicalComposerContext();
  const menuButtonRef = useRef<HTMLDivElement | null>(null);
  const menuRootRef = useRef<HTMLDivElement | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [, setIsMenuOutside] = useState(false);
  const [tableCellNode, setTableMenuCellNode] = useState<TableCellNode | null>(null);

  const $moveMenu = useCallback(() => {
    const menu = menuButtonRef.current;
    const selection = $getSelection();
    const nativeSelection = getDOMSelection(
      editor.getRootElement()?.ownerDocument.defaultView ?? null
    );
    const activeElement = document.activeElement;
    function disable() {
      if (menu) menu.classList.remove("lx-table-action-show");
      setTableMenuCellNode(null);
    }
    if (selection == null || menu == null) return disable();

    const rootElement = editor.getRootElement();
    let tableObserverCellNode: TableCellNode | null = null;
    if ($isRangeSelection(selection)) {
      tableObserverCellNode = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
    } else if ($isTableSelection(selection)) {
      tableObserverCellNode = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
    }

    if (
      tableObserverCellNode != null &&
      rootElement !== null &&
      nativeSelection !== null &&
      rootElement.contains(nativeSelection.anchorNode)
    ) {
      setTableMenuCellNode(tableObserverCellNode);
      return;
    }
    if (!activeElement) return disable();
    disable();
  }, [editor]);

  useEffect(() => {
    return editor.registerUpdateListener(() => {
      editor.getEditorState().read(() => {
        $moveMenu();
      });
    });
  });

  useEffect(() => {
    const menuButtonDOM = menuButtonRef.current;
    if (menuButtonDOM != null && tableCellNode != null) {
      const tableCellNodeDOM = editor.getElementByKey(tableCellNode.getKey());
      if (tableCellNodeDOM != null) {
        const tableCellRect = tableCellNodeDOM.getBoundingClientRect();
        const anchorRect = anchorElem.getBoundingClientRect();
        const top = tableCellRect.top - anchorRect.top + 4;
        const left = tableCellRect.right - anchorRect.left - 22;
        menuButtonDOM.style.top = `${top}px`;
        menuButtonDOM.style.left = `${left}px`;
        menuButtonDOM.classList.add("lx-table-action-show");
      } else {
        menuButtonDOM.classList.remove("lx-table-action-show");
      }
    } else if (menuButtonDOM != null) {
      menuButtonDOM.classList.remove("lx-table-action-show");
    }
  }, [tableCellNode, editor, anchorElem]);

  const prevTableCellDOM = useRef(tableCellNode);
  useEffect(() => {
    if (prevTableCellDOM.current !== tableCellNode) setIsMenuOpen(false);
    prevTableCellDOM.current = tableCellNode;
  }, [tableCellNode]);

  return (
    <div className="lx-table-action-button-container" ref={menuButtonRef}>
      {tableCellNode != null && (
        <>
          <div
            ref={menuRootRef}
            className="lx-table-action-button"
            onClick={(e) => {
              e.stopPropagation();
              setIsMenuOpen((o) => !o);
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          {isMenuOpen && (
            <TableActionMenu
              contextRef={menuRootRef}
              setIsMenuOutside={setIsMenuOutside}
              onClose={() => setIsMenuOpen(false)}
              tableCellNode={tableCellNode}
              editor={editor}
            />
          )}
        </>
      )}
    </div>
  );
}

export default function TableActionMenuPlugin({
  anchorElem,
}: {
  anchorElem: HTMLElement;
}): ReactNode {
  const [editor] = useLexicalComposerContext();
  const isEditable = useEditableState(editor);
  return useMemo(
    () =>
      isEditable
        ? createPortal(<TableCellActionMenuContainer anchorElem={anchorElem} />, anchorElem)
        : null,
    [anchorElem, isEditable]
  );
}

function useEditableState(editor: LexicalEditor): boolean {
  const [editable, setEditable] = useState(() => editor.isEditable());
  useEffect(() => editor.registerEditableListener((v) => setEditable(v)), [editor]);
  return editable;
}
