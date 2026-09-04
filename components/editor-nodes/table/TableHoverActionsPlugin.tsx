"use client";

/*
 * Portions adapted from Lexical Playground.
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * SPDX-License-Identifier: MIT
 * Source: https://github.com/facebook/lexical
 */

// TableHoverActionsPlugin — hovering near a table's bottom edge or right edge
// shows a thin "+" bar; clicking it appends a row / column. Adapted from the
// Lexical playground's TableHoverActionsPlugin to this project's tokens.
//
// "use client" — DOM event listeners, portal, React state.

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $insertTableColumn__EXPERIMENTAL,
  $insertTableRow__EXPERIMENTAL,
  $isTableCellNode,
  $isTableNode,
  getTableElement,
  TableNode,
} from "@lexical/table";
import {
  $getNearestNodeFromDOMNode,
  type ElementNode,
  isHTMLElement,
  type NodeKey,
} from "lexical";
import { useDebounce } from "./useDebounce";

const BUTTON_WIDTH_PX = 20;

function TableHoverActionsContainer({ anchorElem }: { anchorElem: HTMLElement }) {
  const [editor] = useLexicalComposerContext();
  const [isShownRow, setShownRow] = useState(false);
  const [isShownColumn, setShownColumn] = useState(false);
  const [shouldListenMouseMove, setShouldListenMouseMove] = useState(false);
  const [position, setPosition] = useState({});
  const tableSetRef = useRef<Set<NodeKey>>(new Set());
  const tableCellDOMNodeRef = useRef<HTMLElement | null>(null);

  const debouncedOnMouseMove = useDebounce(
    (event: MouseEvent) => {
      const { isOutside, tableDOMNode } = getMouseInfo(event);
      if (isOutside) {
        setShownRow(false);
        setShownColumn(false);
        return;
      }
      if (!tableDOMNode) return;

      tableCellDOMNodeRef.current = tableDOMNode;

      let hoveredRowNode: TableCellNodeRef = null;
      let hoveredColumnNode: TableCellNodeRef = null;
      let tableDOMElement: HTMLElement | null = null;

      editor.getEditorState().read(
        () => {
          const maybeTableCell = $getNearestNodeFromDOMNode(tableDOMNode);
          if ($isTableCellNode(maybeTableCell)) {
            const table = maybeTableCell.getParents().find((n) => $isTableNode(n));
            if (!$isTableNode(table)) return;
            tableDOMElement = getTableElement(table, editor.getElementByKey(table.getKey()));
            if (tableDOMElement) {
              const rowCount = table.getChildrenSize();
              const firstRow = table.getChildAtIndex<ElementNode>(0);
              const colCount = firstRow ? firstRow.getChildrenSize() : 0;
              const rowIndex = maybeTableCell.getParentOrThrow().getIndexWithinParent();
              const colIndex = maybeTableCell.getIndexWithinParent();
              if (rowIndex === rowCount - 1) hoveredRowNode = maybeTableCell;
              if (colIndex === colCount - 1) hoveredColumnNode = maybeTableCell;
            }
          }
        },
        { editor }
      );

      if (tableDOMElement) {
        const {
          width: tableElemWidth,
          y: tableElemY,
          x: tableElemX,
          right: tableElemRight,
          bottom: tableElemBottom,
          height: tableElemHeight,
        } = (tableDOMElement as HTMLElement).getBoundingClientRect();
        const { y: editorElemY, left: editorElemLeft } = anchorElem.getBoundingClientRect();

        if (hoveredRowNode) {
          setShownColumn(false);
          setShownRow(true);
          setPosition({
            height: BUTTON_WIDTH_PX,
            left: tableElemX - editorElemLeft,
            top: tableElemBottom - editorElemY + 5,
            width: tableElemWidth,
          });
        } else if (hoveredColumnNode) {
          setShownColumn(true);
          setShownRow(false);
          setPosition({
            height: tableElemHeight,
            left: tableElemRight - editorElemLeft + 5,
            top: tableElemY - editorElemY,
            width: BUTTON_WIDTH_PX,
          });
        }
      }
    },
    50,
    250
  );

  useEffect(() => {
    if (!shouldListenMouseMove) return;
    document.addEventListener("mousemove", debouncedOnMouseMove);
    return () => {
      setShownRow(false);
      setShownColumn(false);
      debouncedOnMouseMove.cancel();
      document.removeEventListener("mousemove", debouncedOnMouseMove);
    };
  }, [shouldListenMouseMove, debouncedOnMouseMove]);

  useEffect(() => {
    return editor.registerMutationListener(
      TableNode,
      (mutations) => {
        editor.getEditorState().read(
          () => {
            let resetState = false;
            const tableSet = tableSetRef.current;
            for (const [key, type] of mutations) {
              switch (type) {
                case "created":
                  tableSet.add(key);
                  resetState = true;
                  break;
                case "destroyed":
                  tableSet.delete(key);
                  resetState = true;
                  break;
                default:
                  break;
              }
            }
            if (resetState) setShouldListenMouseMove(tableSet.size > 0);
          },
          { editor }
        );
      },
      { skipInitialization: false }
    );
  }, [editor]);

  const insertAction = useCallback(
    (insertRow: boolean) => {
      editor.update(() => {
        if (!tableCellDOMNodeRef.current) return;
        const maybeTableNode = $getNearestNodeFromDOMNode(tableCellDOMNodeRef.current);
        const cell = $getNearestCell(maybeTableNode);
        if (!cell) return;
        cell.selectEnd();
        if (insertRow) $insertTableRow__EXPERIMENTAL();
        else $insertTableColumn__EXPERIMENTAL();
      });
    },
    [editor]
  );

  if (!isShownRow && !isShownColumn) return null;

  return (
    <>
      {isShownRow && (
        <button
          type="button"
          className="lx-table-hover-button"
          style={position}
          onClick={() => insertAction(true)}
          title="在下方插入一行"
        >
          <span>＋</span>
        </button>
      )}
      {isShownColumn && (
        <button
          type="button"
          className="lx-table-hover-button"
          style={position}
          onClick={() => insertAction(false)}
          title="在右侧插入一列"
        >
          <span>＋</span>
        </button>
      )}
    </>
  );
}

type TableCellNodeRef = import("@lexical/table").TableCellNode | null;

function $getNearestCell(node: ReturnType<typeof $getNearestNodeFromDOMNode>) {
  let current = node;
  while (current != null) {
    if ($isTableCellNode(current)) return current;
    current = current.getParent();
  }
  return null;
}

function getMouseInfo(event: MouseEvent): {
  tableDOMNode: HTMLElement | null;
  isOutside: boolean;
} {
  const target = event.target;
  if (isHTMLElement(target)) {
    const tableDOMNode = target.closest<HTMLElement>("td.lx-table-cell, th.lx-table-cell");
    const isOutside = !(
      tableDOMNode ||
      target.closest<HTMLElement>("button.lx-table-hover-button")
    );
    return { isOutside, tableDOMNode };
  }
  return { isOutside: true, tableDOMNode: null };
}

export default function TableHoverActionsPlugin({
  anchorElem,
}: {
  anchorElem: HTMLElement;
}): ReactNode {
  const [editor] = useLexicalComposerContext();
  const isEditable = useEditableState(editor);
  return useMemo(
    () =>
      isEditable
        ? createPortal(<TableHoverActionsContainer anchorElem={anchorElem} />, anchorElem)
        : null,
    [anchorElem, isEditable]
  );
}

function useEditableState(editor: ReturnType<typeof useLexicalComposerContext>[0]): boolean {
  const [editable, setEditable] = useState(() => editor.isEditable());
  useEffect(() => editor.registerEditableListener((v) => setEditable(v)), [editor]);
  return editable;
}
