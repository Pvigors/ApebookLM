"use client";

// TableCellResizerPlugin — drag handles on column/row borders to resize cells.
// Adapted (this project's tokens + @lexical/table 0.45 API, Chinese is irrelevant
// here as it shows no text) from the Lexical playground's TableCellResizer.
// Renders two thin draggable zones (right edge → column width, bottom edge → row
// height) that follow the hovered cell; width is stored on TableNode.colWidths,
// height on TableRowNode.height.
//
// This plugin file carries "use client" (browser APIs + portal + state). The
// table *node* files intentionally do not.

import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
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
  $getTableColumnIndexFromTableCellNode,
  $getTableNodeFromLexicalNodeOrThrow,
  $getTableRowIndexFromTableCellNode,
  $isTableCellNode,
  $isTableRowNode,
  getDOMCellFromTarget,
  getTableElement,
  type TableDOMCell,
} from "@lexical/table";
import { $getNearestNodeFromDOMNode, type LexicalEditor, isHTMLElement } from "lexical";

type MousePosition = { x: number; y: number };
type MouseDraggingDirection = "right" | "bottom";

const MIN_ROW_HEIGHT = 33;
const MIN_COLUMN_WIDTH = 92;

function TableCellResizer({ editor }: { editor: LexicalEditor }) {
  const targetRef = useRef<HTMLElement | null>(null);
  const resizerRef = useRef<HTMLDivElement | null>(null);
  const tableRectRef = useRef<DOMRect | null>(null);

  const mouseStartPosRef = useRef<MousePosition | null>(null);
  const [mouseCurrentPos, updateMouseCurrentPos] = useState<MousePosition | null>(null);

  const [activeCell, updateActiveCell] = useState<TableDOMCell | null>(null);
  const [isMouseDown, updateIsMouseDown] = useState(false);
  const [draggingDirection, updateDraggingDirection] = useState<MouseDraggingDirection | null>(null);

  const resetState = useCallback(() => {
    updateActiveCell(null);
    targetRef.current = null;
    updateDraggingDirection(null);
    mouseStartPosRef.current = null;
    tableRectRef.current = null;
  }, []);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const target = event.target;
      if (!isHTMLElement(target)) return;

      if (draggingDirection) {
        updateMouseCurrentPos({ x: event.clientX, y: event.clientY });
        return;
      }
      if (resizerRef.current && resizerRef.current.contains(target)) return;

      if (targetRef.current !== target) {
        targetRef.current = target;
        const cell = getDOMCellFromTarget(target);
        if (cell && activeCell !== cell) {
          editor.read(() => {
            const tableCellNode = $getNearestNodeFromDOMNode(cell.elem);
            if (!tableCellNode) throw new Error("TableCellResizer: cell node not found.");
            const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
            const tableElement = getTableElement(
              tableNode,
              editor.getElementByKey(tableNode.getKey())
            );
            if (!tableElement) throw new Error("TableCellResizer: table element not found.");
            tableRectRef.current = tableElement.getBoundingClientRect();
            updateActiveCell(cell);
          });
        } else if (cell == null) {
          resetState();
        }
      }
    };

    const onMouseDown = () => updateIsMouseDown(true);
    const onMouseUp = () => updateIsMouseDown(false);

    return editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener("mousemove", onMouseMove);
      prevRootElement?.removeEventListener("mousedown", onMouseDown);
      prevRootElement?.removeEventListener("mouseup", onMouseUp);
      rootElement?.addEventListener("mousemove", onMouseMove);
      rootElement?.addEventListener("mousedown", onMouseDown);
      rootElement?.addEventListener("mouseup", onMouseUp);
    });
  }, [activeCell, draggingDirection, editor, resetState]);

  const isHeightChanging = (direction: MouseDraggingDirection) => direction === "bottom";

  const updateRowHeight = useCallback(
    (heightChange: number) => {
      if (!activeCell) return;
      const liveHeight = activeCell.elem.getBoundingClientRect().height;
      editor.update(
        () => {
          const tableCellNode = $getNearestNodeFromDOMNode(activeCell.elem);
          if (!$isTableCellNode(tableCellNode)) return;
          const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
          const baseRowIndex = $getTableRowIndexFromTableCellNode(tableCellNode);
          const rows = tableNode.getChildren();
          const rowIndex = baseRowIndex + (tableCellNode.getRowSpan() || 1) - 1;
          const tableRow = rows[rowIndex];
          if (!$isTableRowNode(tableRow)) return;
          const height = tableRow.getHeight() ?? liveHeight;
          tableRow.setHeight(Math.max(height + heightChange, MIN_ROW_HEIGHT));
        },
        { tag: "skip-scroll-into-view" }
      );
    },
    [activeCell, editor]
  );

  const updateColumnWidth = useCallback(
    (widthChange: number) => {
      if (!activeCell) return;
      // Measure live widths up front (DOM access outside editor.update).
      const rowEl = activeCell.elem.closest("tr");
      const liveWidths = rowEl
        ? (Array.from(rowEl.children) as HTMLElement[]).map((c) =>
            Math.max(MIN_COLUMN_WIDTH, Math.round(c.getBoundingClientRect().width))
          )
        : null;
      editor.update(
        () => {
          const tableCellNode = $getNearestNodeFromDOMNode(activeCell.elem);
          if (!$isTableCellNode(tableCellNode)) return;
          const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
          const colIndex = $getTableColumnIndexFromTableCellNode(tableCellNode);
          const target = colIndex + (tableCellNode.getColSpan() || 1) - 1;
          const existing = tableNode.getColWidths();
          const widths =
            existing && existing.length > 0 ? [...existing] : liveWidths ? [...liveWidths] : null;
          if (!widths) return;
          const current = widths[target] ?? MIN_COLUMN_WIDTH;
          widths[target] = Math.max(current + widthChange, MIN_COLUMN_WIDTH);
          tableNode.setColWidths(widths);
        },
        { tag: "skip-scroll-into-view" }
      );
    },
    [activeCell, editor]
  );

  const mouseUpHandler = useCallback(
    (direction: MouseDraggingDirection) => {
      const handler = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (!activeCell || !mouseStartPosRef.current) return;
        const { x, y } = mouseStartPosRef.current;
        if (isHeightChanging(direction)) updateRowHeight(event.clientY - y);
        else updateColumnWidth(event.clientX - x);
        resetState();
        document.removeEventListener("mouseup", handler);
      };
      return handler;
    },
    [activeCell, resetState, updateColumnWidth, updateRowHeight]
  );

  const toggleResize = useCallback(
    (direction: MouseDraggingDirection) => (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!activeCell) return;
      mouseStartPosRef.current = { x: event.clientX, y: event.clientY };
      updateMouseCurrentPos(mouseStartPosRef.current);
      updateDraggingDirection(direction);
      document.addEventListener("mouseup", mouseUpHandler(direction));
    },
    [activeCell, mouseUpHandler]
  );

  const getResizers = useCallback((): Record<MouseDraggingDirection, CSSProperties | undefined> => {
    if (!activeCell) return { bottom: undefined, right: undefined };
    const { height, width, top, left } = activeCell.elem.getBoundingClientRect();
    const zone = 12;
    const styles: Record<MouseDraggingDirection, CSSProperties> = {
      bottom: {
        cursor: "row-resize",
        height: `${zone}px`,
        left: `${window.scrollX + left}px`,
        top: `${window.scrollY + top + height - zone / 2}px`,
        width: `${width}px`,
      },
      right: {
        cursor: "col-resize",
        height: `${height}px`,
        left: `${window.scrollX + left + width - zone / 2}px`,
        top: `${window.scrollY + top}px`,
        width: `${zone}px`,
      },
    };
    const tableRect = tableRectRef.current;
    if (draggingDirection && mouseCurrentPos && tableRect) {
      if (isHeightChanging(draggingDirection)) {
        styles.bottom.left = `${window.scrollX + tableRect.left}px`;
        styles.bottom.top = `${window.scrollY + mouseCurrentPos.y}px`;
        styles.bottom.height = "3px";
        styles.bottom.width = `${tableRect.width}px`;
        styles.bottom.backgroundColor = "#6d5ae6";
      } else {
        styles.right.top = `${window.scrollY + tableRect.top}px`;
        styles.right.left = `${window.scrollX + mouseCurrentPos.x}px`;
        styles.right.width = "3px";
        styles.right.height = `${tableRect.height}px`;
        styles.right.backgroundColor = "#6d5ae6";
      }
    }
    return styles;
  }, [activeCell, draggingDirection, mouseCurrentPos]);

  const resizerStyles = getResizers();

  return (
    <div ref={resizerRef}>
      {activeCell != null && !isMouseDown && (
        <>
          <div
            className="lx-table-cell-resizer lx-table-cell-resizer-right"
            data-dragging={draggingDirection === "right" ? "true" : undefined}
            style={resizerStyles.right}
            onMouseDown={toggleResize("right")}
          />
          <div
            className="lx-table-cell-resizer lx-table-cell-resizer-bottom"
            data-dragging={draggingDirection === "bottom" ? "true" : undefined}
            style={resizerStyles.bottom}
            onMouseDown={toggleResize("bottom")}
          />
        </>
      )}
    </div>
  );
}

export default function TableCellResizerPlugin(): ReactNode {
  const [editor] = useLexicalComposerContext();
  const isEditable = useEditableState(editor);
  // SSR-safe: document.body only exists on the client — portal after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return useMemo(
    () => (isEditable && mounted ? createPortal(<TableCellResizer editor={editor} />, document.body) : null),
    [editor, isEditable, mounted]
  );
}

function useEditableState(editor: LexicalEditor): boolean {
  const [editable, setEditable] = useState(() => editor.isEditable());
  useEffect(() => editor.registerEditableListener((v) => setEditable(v)), [editor]);
  return editable;
}
