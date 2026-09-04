"use client";

// Drawviso 专业图表编辑器 —— 自研 React Flow(@xyflow/react)画布,取代 draw.io iframe。
// 节点 = 我们自己写的 React 组件,100% 用猿笔记设计 token 渲染(圆角卡片/紫色/字体),
// 工具栏/检查器全自建 → 与主界面完全统一,无任何第三方外壳/水印。规整方框是 RF 原生强项。
// 由 DrawvisoView 以 dynamic(ssr:false) 加载(RF 触碰 window)。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls,
  useNodesState, useEdgesState, addEdge, Handle, Position, MarkerType,
  useReactFlow, getNodesBounds, getViewportForBounds,
  type Node, type Edge, type Connection, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { DrawvisoGraph, DrawvisoShape } from "@/lib/drawviso-graph";

type NData = { label: string; fill: string; stroke: string; w: number; h: number };

// 预设色板(猿笔记调性 + Drawviso 语义色):点检查器 swatch 改节点色。
export const SWATCHES: { fill: string; stroke: string }[] = [
  { fill: "#e8e8ff", stroke: "#6c6cd0" }, // 紫(主)
  { fill: "#dae8fc", stroke: "#6c8ebf" }, // 蓝
  { fill: "#d5e8d4", stroke: "#82b366" }, // 绿
  { fill: "#ffe6cc", stroke: "#d79b00" }, // 橙
  { fill: "#fff2cc", stroke: "#d6b656" }, // 黄
  { fill: "#f8cecc", stroke: "#b85450" }, // 红
  { fill: "#f5f5f5", stroke: "#999999" }, // 灰
];

/** 节点外观:内联色(数据驱动)+ 统一圆角/字体/阴影(猿笔记质感);选中态紫描边。 */
function nodeBox(data: NData, selected: boolean, radius: number, extra?: React.CSSProperties): React.CSSProperties {
  return {
    width: data.w, height: data.h,
    background: data.fill,
    border: `1.5px solid ${selected ? "#6d5ae6" : data.stroke}`,
    borderRadius: radius,
    boxShadow: selected ? "0 0 0 3px rgba(109,90,230,.18)" : "0 1px 2px rgba(0,0,0,.04)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: "6px 10px", boxSizing: "border-box",
    fontSize: 13, lineHeight: 1.3, color: "#2c2c33", textAlign: "center",
    fontFamily: "var(--font-sans, -apple-system, sans-serif)",
    wordBreak: "break-word", overflow: "hidden", cursor: "pointer",
    ...extra,
  };
}
const HANDLE_STYLE: React.CSSProperties = { width: 7, height: 7, background: "#8d7ee6", border: "1.5px solid #fff" };
function handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle type="target" position={Position.Top} id="t" style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} id="b" style={HANDLE_STYLE} />
    </>
  );
}

function BoxNode({ data, selected }: NodeProps<Node<NData>>) {
  return <div style={nodeBox(data, !!selected, 10)}>{handles()}<span>{data.label}</span></div>;
}
function EllipseNode({ data, selected }: NodeProps<Node<NData>>) {
  return <div style={nodeBox(data, !!selected, 999)}>{handles()}<span>{data.label}</span></div>;
}
function RhombusNode({ data, selected }: NodeProps<Node<NData>>) {
  // 菱形:外层 clip-path,文字水平放(不随裁剪变形)。
  return (
    <div style={{ position: "relative", width: data.w, height: data.h }}>
      <div style={nodeBox({ ...data, w: data.w, h: data.h }, !!selected, 0, { clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)", position: "absolute", inset: 0 })} />
      {handles()}
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#2c2c33", textAlign: "center", padding: "0 14px", pointerEvents: "none" }}>{data.label}</div>
    </div>
  );
}
function SwimlaneNode({ data, selected }: NodeProps<Node<NData>>) {
  // 泳道容器:标题头 + 透明主体(子节点浮其上)。
  return (
    <div style={{ width: data.w, height: data.h, border: `1.5px solid ${selected ? "#6d5ae6" : data.stroke}`, borderRadius: 10, background: "rgba(255,255,255,.35)", boxSizing: "border-box" }}>
      {handles()}
      <div style={{ height: 26, lineHeight: "26px", textAlign: "center", fontSize: 12.5, fontWeight: 500, color: "#3a3a45", background: data.fill, borderRadius: "8px 8px 0 0", borderBottom: `1px solid ${data.stroke}` }}>{data.label}</div>
    </div>
  );
}

const nodeTypes = { box: BoxNode, ellipse: EllipseNode, rhombus: RhombusNode, swimlane: SwimlaneNode };

const EDGE_COLOR = "#7c72c8";
const defaultEdgeOptions = {
  type: "smoothstep" as const,
  markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR, width: 18, height: 18 },
  style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
};

/** DrawvisoGraph → RF nodes/edges。泳道排前(父先于子);子节点 parentId+extent。 */
function toRF(graph: DrawvisoGraph): { nodes: Node<NData>[]; edges: Edge[] } {
  const laneIds = new Set(graph.nodes.filter((n) => n.shape === "swimlane").map((n) => n.id));
  const order = [...graph.nodes.filter((n) => laneIds.has(n.id)), ...graph.nodes.filter((n) => !laneIds.has(n.id))];
  const nodes: Node<NData>[] = order.map((n) => ({
    id: n.id,
    type: n.shape,
    position: { x: n.x, y: n.y },
    data: { label: n.label, fill: n.fill, stroke: n.stroke, w: n.w, h: n.h },
    ...(n.parent && laneIds.has(n.parent) ? { parentId: n.parent, extent: "parent" as const } : {}),
    ...(n.shape === "swimlane" ? { style: { zIndex: -1 } } : {}),
  }));
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target,
    ...(e.label ? { label: e.label } : {}),
    labelStyle: { fontSize: 11, fill: "#5a5570" },
    labelBgStyle: { fill: "#ffffff", fillOpacity: 0.85 },
  }));
  return { nodes, edges };
}

/** RF nodes/edges → DrawvisoGraph(保存路径,回 graphToXml)。 */
function fromRF(nodes: Node<NData>[], edges: Edge[]): DrawvisoGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      shape: (n.type as DrawvisoShape) || "box",
      label: n.data.label,
      x: Math.round(n.position.x), y: Math.round(n.position.y),
      w: n.data.w, h: n.data.h,
      fill: n.data.fill, stroke: n.data.stroke,
      parent: n.parentId,
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: typeof e.label === "string" ? e.label : "" })),
  };
}

type Props = {
  graph: DrawvisoGraph;
  readOnly?: boolean;
  onChange?: (graph: DrawvisoGraph) => void;
  onOpenNode?: (label: string) => void;
  registerExport?: (fn: () => Promise<Blob | null>) => void;
};

function Inner({ graph, readOnly, onChange, onOpenNode, registerExport }: Props) {
  const init = useMemo(() => toRF(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState(init.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(init.edges);
  const [selId, setSelId] = useState<string | null>(null);
  const rf = useReactFlow();
  const idSeq = useRef(1);

  // 变更 → 防抖回写父级(保存)。readOnly 不回写。
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emit = useCallback((ns: Node<NData>[], es: Edge[]) => {
    if (readOnly) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => changeRef.current?.(fromRF(ns, es)), 600);
  }, [readOnly]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => { const ne = addEdge({ ...c, id: `e${Date.now()}${idSeq.current++}` }, es); emit(nodes, ne); return ne; });
  }, [setEdges, emit, nodes]);

  const patchNode = useCallback((id: string, patch: Partial<NData>) => {
    setNodes((ns) => { const nn = ns.map((n) => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n); emit(nn, edges); return nn; });
  }, [setNodes, emit, edges]);

  const addBox = useCallback(() => {
    const { x, y } = rf.screenToFlowPosition({ x: 320, y: 220 });
    const id = `n${Date.now()}${idSeq.current++}`;
    setNodes((ns) => {
      const nn = [...ns, { id, type: "box", position: { x: Math.round(x), y: Math.round(y) }, data: { label: "新节点", fill: SWATCHES[0].fill, stroke: SWATCHES[0].stroke, w: 160, h: 56 } } as Node<NData>];
      emit(nn, edges); return nn;
    });
    setSelId(id);
  }, [rf, setNodes, emit, edges]);

  const delSel = useCallback(() => {
    if (!selId) return;
    setNodes((ns) => { const nn = ns.filter((n) => n.id !== selId); const ne = edges.filter((e) => e.source !== selId && e.target !== selId); setEdges(ne); emit(nn, ne); return nn; });
    setSelId(null);
  }, [selId, setNodes, setEdges, edges, emit]);

  // 双击节点 → 改文字(轻量 prompt,避免自建内联编辑器的复杂度)。
  const onNodeDoubleClick = useCallback((_: React.MouseEvent, n: Node) => {
    if (readOnly) return;
    const cur = (n.data as NData).label;
    const next = window.prompt("修改文字", cur);
    if (next != null && next !== cur) patchNode(n.id, { label: next.slice(0, 60) });
  }, [readOnly, patchNode]);

  // 单击节点 → grounded 回溯(交给父级查 nodeSources)。
  const onNodeClick = useCallback((_: React.MouseEvent, n: Node) => {
    setSelId(n.id);
    onOpenNode?.((n.data as NData).label);
  }, [onOpenNode]);

  // 导出:离屏 fit-all 截 viewport → PNG blob(父级叠水印/下载)。
  useEffect(() => {
    if (!registerExport) return;
    registerExport(async () => {
      try {
        const { toBlob } = await import("html-to-image");
        const vp = document.querySelector(".drawviso-rf .react-flow__viewport") as HTMLElement | null;
        if (!vp || !nodes.length) return null;
        const bounds = getNodesBounds(nodes);
        const pad = 40, W = Math.ceil(bounds.width + pad * 2), H = Math.ceil(bounds.height + pad * 2);
        const t = getViewportForBounds(bounds, W, H, 0.2, 2, pad);
        return await toBlob(vp, {
          backgroundColor: "#ffffff", width: W, height: H, pixelRatio: 2,
          style: { width: `${W}px`, height: `${H}px`, transform: `translate(${t.x}px,${t.y}px) scale(${t.zoom})` },
        });
      } catch { return null; }
    });
  }, [registerExport, nodes]);

  const sel = nodes.find((n) => n.id === selId);

  return (
    <div className="drawviso-rf absolute inset-0">
      <ReactFlow
        nodes={nodes} edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(c) => { onNodesChange(c); emit(nodes, edges); }}
        onEdgesChange={(c) => { onEdgesChange(c); emit(nodes, edges); }}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => setSelId(null)}
        defaultEdgeOptions={defaultEdgeOptions}
        nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable
        fitView fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        minZoom={0.1} maxZoom={2.5}
      >
        <Background color="#e7e6ee" gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* 顶部悬浮工具栏(猿笔记风,仅编辑态) */}
      {!readOnly && (
        <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-edge bg-panel/95 px-1.5 py-1 shadow-lg backdrop-blur">
          <ToolBtn onClick={addBox} title="添加节点">＋ 节点</ToolBtn>
          <ToolBtn onClick={() => rf.fitView({ padding: 0.15, maxZoom: 1.2 })} title="适应画布">适应</ToolBtn>
          <ToolBtn onClick={delSel} disabled={!selId} title="删除选中(Delete)">删除</ToolBtn>
        </div>
      )}

      {/* 右侧检查器(选中节点时):改色/形状 */}
      {!readOnly && sel && (
        <div className="absolute right-3 top-3 z-10 w-[188px] rounded-xl border border-edge bg-panel/97 p-3 shadow-lg backdrop-blur">
          <p className="mb-2 text-[12px] font-medium text-ink2">节点样式</p>
          <p className="mb-1 text-[11px] text-muted">颜色</p>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {SWATCHES.map((s) => (
              <button key={s.fill} onClick={() => patchNode(sel.id, { fill: s.fill, stroke: s.stroke })}
                title="改色" style={{ background: s.fill, borderColor: s.stroke }}
                className={"h-6 w-6 rounded-md border-2 transition hover:scale-110 " + (sel.data.fill === s.fill ? "ring-2 ring-accent ring-offset-1" : "")} />
            ))}
          </div>
          <p className="mb-1 text-[11px] text-muted">形状</p>
          <div className="flex gap-1">
            {(["box", "ellipse", "rhombus"] as const).map((sh) => (
              <button key={sh} onClick={() => setNodes((ns) => { const nn = ns.map((n) => n.id === sel.id ? { ...n, type: sh } : n); emit(nn, edges); return nn; })}
                className={"flex-1 rounded-md border px-1 py-1 text-[11px] transition " + (sel.type === sh ? "border-accent bg-accentSoft text-accent" : "border-edge text-ink2 hover:border-accent/50")}>
                {sh === "box" ? "方" : sh === "ellipse" ? "圆" : "菱"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolBtn({ children, onClick, title, disabled }: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean }) {
  return (
    <button onClick={onClick} title={title} disabled={disabled}
      className="rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-ink2 transition hover:bg-panel2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">
      {children}
    </button>
  );
}

export default function DrawvisoCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
