// Drawviso 图结构纯函数(无服务端依赖,客户端可安全 import)——从 lib/drawviso.ts 抽出,
// 避免客户端 import xmlToGraph 把 openai/corpus 等服务端代码拉进 client bundle。
// mxGraphModel XML 的确定性重建/清洗 + React Flow 图结构互转。

/** 提取一个属性值(单/双引号皆可);返回 undefined 表示缺失。 */
function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`)) || tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`));
  return m?.[1];
}

/** XML 属性转义(重建序列化用)。 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 反转义 LLM 输出里的常见实体,拿到「纯文本标签」(重建时再统一转义)。 */
function unesc(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, ""); // 标签剥掉:我们不开 html=1,纯文本标签
}

/** style 键级白名单:只认已知安全的视觉键,未知键(image/link/glass/自定义 stencil…)
 *  一律丢弃;值再过字符白名单(无冒号/括号/尖括号,javascript:/url() 字符层面不可能存活)。
 *  shape 值另有枚举白名单(拒 shape=image / shape=mxgraph.* stencil)。 */
const STYLE_KEYS = new Set([
  "rounded", "whiteSpace", "fillColor", "strokeColor", "strokeWidth", "fontSize", "fontColor",
  "fontStyle", "dashed", "opacity", "arcSize", "align", "verticalAlign", "horizontal",
  "startSize", "shape", "edgeStyle", "curved", "startArrow", "endArrow", "elbow",
  "exitX", "exitY", "entryX", "entryY", "labelBackgroundColor", "swimlaneFillColor",
]);
const SHAPE_OK = new Set(["rectangle", "ellipse", "rhombus", "swimlane", "hexagon", "cylinder", "cloud", "parallelogram", "triangle", "process", "step"]);
function cleanStyle(s: string | undefined, fallback: string): string {
  const parts: string[] = [];
  for (const seg of (s ?? "").split(";")) {
    const eq = seg.indexOf("=");
    if (eq <= 0) {
      // 无值段(如裸 "swimlane" 简写):按 shape 枚举放行。
      const bare = seg.trim();
      if (SHAPE_OK.has(bare)) parts.push(bare);
      continue;
    }
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).replace(/[^a-zA-Z0-9#.%\- ]/g, "").trim();
    if (!STYLE_KEYS.has(k) || !v) continue;
    if (k === "shape" && !SHAPE_OK.has(v)) continue;
    parts.push(`${k}=${v}`);
  }
  return parts.length ? parts.join(";") + ";" : fallback;
}

const num = (v: string | undefined, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt;
};

type Vertex = { id: string; label: string; style: string; parent: string; x: number; y: number; w: number; h: number };
type Edge = { id: string; label: string; style: string; source: string; target: string };

/** 确定性重建:LLM 原始输出 → 规范 mxGraphModel XML。
 *  逐 <mxCell> 提取(自闭合或带 mxGeometry 子节点),白名单校验后重新序列化;
 *  解析不动整段输入,截断残尾/私货标签自然脱落。 */
export function rebuildDrawioXml(raw: string): { xml: string; vertexCount: number; edgeCount: number; labels: string[] } {
  const vertices: Vertex[] = [];
  const edges: Edge[] = [];
  const vertexIds = new Set<string>();
  const edgeIds = new Set<string>();
  // 匹配完整的 mxCell(含可选的 <mxGeometry …/> 子节点)。截断的最后一个 cell
  // 缺 </mxCell> 或引号未闭合 → 不匹配 → 自动丢弃(mermaid 残尾修剪同范式)。
  const CELL_RE = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g;
  let m: RegExpExecArray | null;
  while ((m = CELL_RE.exec(raw))) {
    const attrs = m[1];
    const inner = m[2] ?? "";
    const id = (attr(attrs, "id") ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!id || id === "0" || id === "1") continue; // 根细胞由我们自己写
    const label = unesc(attr(attrs, "value") ?? "").slice(0, 60);
    if (attr(attrs, "vertex") === "1") {
      if (vertexIds.has(id)) continue; // 重复 id 会让边端点语义不确定，首个合法 cell 胜出。
      vertexIds.add(id);
      const geo = inner.match(/<mxGeometry\b[^>]*>/)?.[0] ?? "";
      vertices.push({
        id,
        label,
        style: cleanStyle(attr(attrs, "style"), "rounded=1;whiteSpace=wrap;html=0;fillColor=#dae8fc;strokeColor=#6c8ebf;"),
        parent: (attr(attrs, "parent") ?? "1").replace(/[^a-zA-Z0-9_-]/g, "") || "1",
        x: num(attr(geo, "x"), 40, -200, 4000),
        y: num(attr(geo, "y"), 40, -200, 4000),
        w: num(attr(geo, "width"), 180, 10, 1600),
        h: num(attr(geo, "height"), 60, 10, 1600),
      });
    } else if (attr(attrs, "edge") === "1") {
      if (edgeIds.has(id)) continue;
      edgeIds.add(id);
      const source = (attr(attrs, "source") ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
      const target = (attr(attrs, "target") ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
      if (!source || !target) continue;
      edges.push({
        id,
        label: label.slice(0, 20),
        style: cleanStyle(attr(attrs, "style"), "edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;"),
        source,
        target,
      });
    }
  }
  // 结构校验:cell 总量封顶;父引用必须指向已知 vertex(泳道)否则归到画布根;
  // 悬空边(端点不存在)剔除。
  const capped = vertices.slice(0, 80);
  const vids = new Set(capped.map((v) => v.id));
  for (const v of capped) if (v.parent !== "1" && !vids.has(v.parent)) v.parent = "1";
  const goodEdges = edges.filter((e) => vids.has(e.source) && vids.has(e.target)).slice(0, 120);
  // 泳道父节点排前(mxGraph 解码要求 parent 先于 child 出现)。
  const parents = capped.filter((v) => capped.some((c) => c.parent === v.id));
  const rest = capped.filter((v) => !parents.includes(v));
  const ordered = [...parents, ...rest];

  const cells: string[] = [];
  for (const v of ordered) {
    cells.push(
      `    <mxCell id="${v.id}" value="${esc(v.label)}" style="${esc(v.style)}" vertex="1" parent="${v.parent}"><mxGeometry x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" as="geometry" /></mxCell>`
    );
  }
  for (const e of goodEdges) {
    cells.push(
      `    <mxCell id="${e.id}" value="${esc(e.label)}" style="${esc(e.style)}" edge="1" parent="1" source="${e.source}" target="${e.target}"><mxGeometry relative="1" as="geometry" /></mxCell>`
    );
  }
  const xml = `<mxGraphModel dx="800" dy="600" grid="0" page="0">\n  <root>\n    <mxCell id="0" />\n    <mxCell id="1" parent="0" />\n${cells.join("\n")}\n  </root>\n</mxGraphModel>`;
  return { xml, vertexCount: capped.length, edgeCount: goodEdges.length, labels: ordered.map((v) => v.label).filter(Boolean) };
}

// ---------------------------------------------------------------------------
// React Flow 编辑器(取代 draw.io iframe)的图结构互转:规范 mxGraphModel XML ↔
// {nodes,edges}。Drawviso 渲染/编辑走自研 React Flow(节点=React 组件、100% 猿笔记
// token、规整方框),这里是打开(xml→graph)与保存(graph→xml)的桥。
// ---------------------------------------------------------------------------

export type DrawvisoShape = "box" | "ellipse" | "rhombus" | "swimlane";
export type DrawvisoNode = {
  id: string;
  shape: DrawvisoShape;
  label: string;
  x: number; y: number; w: number; h: number;
  fill: string; stroke: string;
  parent?: string; // 泳道子节点的父泳道 id(坐标相对父)
};
export type DrawvisoEdge = { id: string; source: string; target: string; label: string };
export type DrawvisoGraph = { nodes: DrawvisoNode[]; edges: DrawvisoEdge[] };
export type DrawvisoColorRequirement = { target: string | null; fill: string; stroke: string };
export type DrawvisoLayoutBounds = { minX: number; minY: number; maxX: number; maxY: number };

export const DRAWVISO_GENERATION_BOUNDS: DrawvisoLayoutBounds = {
  minX: 0,
  minY: 0,
  maxX: 1800,
  maxY: 1400,
};

const normalizedTarget = (value: string) => value
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]/gu, "")
  .replace(/(?:节点|方框|模块|部分|相关|node|nodes|box|boxes|module|modules|框|点|项)$/i, "");

/** 把用户颜色合同确定性落到节点；全局色先应用，具名节点色后覆盖。 */
export function applyDrawvisoColorRequirements(
  graph: DrawvisoGraph,
  requirements: DrawvisoColorRequirement[]
): { graph: DrawvisoGraph; unmatchedTargets: string[] } {
  if (!requirements.length) return { graph, unmatchedTargets: [] };
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const ordered = [...requirements].sort((a, b) => Number(a.target !== null) - Number(b.target !== null));
  const unmatchedTargets: string[] = [];
  for (const requirement of ordered) {
    const target = requirement.target ? normalizedTarget(requirement.target) : "";
    const matches = requirement.target == null
      ? nodes
      : nodes.filter((node) => {
          const label = normalizedTarget(node.label);
          return !!target && !!label && (label.includes(target) || target.includes(label));
        });
    if (!matches.length) {
      if (requirement.target) unmatchedTargets.push(requirement.target);
      continue;
    }
    for (const node of matches) {
      node.fill = requirement.fill.toLowerCase();
      node.stroke = requirement.stroke.toLowerCase();
    }
  }
  return { graph: { nodes, edges: graph.edges.map((edge) => ({ ...edge })) }, unmatchedTargets };
}

const overlaps = (a: DrawvisoNode, b: DrawvisoNode) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** 校验生成图的画布边界与同层节点重叠；子节点按父泳道的相对坐标校验。 */
export function drawvisoLayoutIssues(
  graph: DrawvisoGraph,
  bounds: DrawvisoLayoutBounds = DRAWVISO_GENERATION_BOUNDS
): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  for (const node of graph.nodes) {
    if (ids.has(node.id)) issues.push(`节点 id 重复:${node.id}`);
    ids.add(node.id);
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.w) || !Number.isFinite(node.h)) {
      issues.push(`节点坐标无效:${node.label || node.id}`);
      continue;
    }
    const parent = node.parent ? byId.get(node.parent) : undefined;
    const minX = parent ? 0 : bounds.minX;
    const minY = parent ? 0 : bounds.minY;
    const maxX = parent ? parent.w : bounds.maxX;
    const maxY = parent ? parent.h : bounds.maxY;
    if (node.x < minX || node.y < minY || node.w <= 0 || node.h <= 0 || node.x + node.w > maxX || node.y + node.h > maxY) {
      issues.push(`节点超出${parent ? "父容器" : "画布"}:${node.label || node.id}`);
    }
  }
  for (let i = 0; i < graph.nodes.length; i++) {
    for (let j = i + 1; j < graph.nodes.length; j++) {
      const a = graph.nodes[i], b = graph.nodes[j];
      if ((a.parent || "") !== (b.parent || "")) continue;
      if (overlaps(a, b)) issues.push(`节点重叠:${a.label || a.id}/${b.label || b.id}`);
    }
  }
  return [...new Set(issues)];
}

/** 对不可信/失控坐标做稳定网格重排。有效布局原样保留；修复时降级为普通顶层图。 */
export function autoLayoutDrawvisoGraph(
  graph: DrawvisoGraph,
  bounds: DrawvisoLayoutBounds = DRAWVISO_GENERATION_BOUNDS
): DrawvisoGraph {
  const n = graph.nodes.length;
  if (!n) return { nodes: [], edges: graph.edges.map((edge) => ({ ...edge })) };
  const cols = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(n * 1.3))));
  const rows = Math.ceil(n / cols);
  const pad = 40;
  const gap = 20;
  const usableW = Math.max(1, bounds.maxX - bounds.minX - pad * 2);
  const usableH = Math.max(1, bounds.maxY - bounds.minY - pad * 2);
  const cellW = usableW / cols;
  const cellH = usableH / rows;
  const width = Math.max(80, Math.min(220, Math.floor(cellW - gap)));
  const height = Math.max(44, Math.min(88, Math.floor(cellH - gap)));
  const nodes = graph.nodes.map((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      ...node,
      shape: node.shape === "swimlane" ? "box" as const : node.shape,
      parent: undefined,
      x: Math.round(bounds.minX + pad + col * cellW + (cellW - width) / 2),
      y: Math.round(bounds.minY + pad + row * cellH + (cellH - height) / 2),
      w: width,
      h: height,
    };
  });
  return { nodes, edges: graph.edges.map((edge) => ({ ...edge })) };
}

export function ensureDrawvisoLayout(
  graph: DrawvisoGraph,
  bounds: DrawvisoLayoutBounds = DRAWVISO_GENERATION_BOUNDS
): { graph: DrawvisoGraph; repaired: boolean; issues: string[] } {
  const before = drawvisoLayoutIssues(graph, bounds);
  if (!before.length) return { graph, repaired: false, issues: [] };
  const repairedGraph = autoLayoutDrawvisoGraph(graph, bounds);
  return { graph: repairedGraph, repaired: true, issues: drawvisoLayoutIssues(repairedGraph, bounds) };
}

const styleColor = (style: string, key: string, dflt: string) =>
  style.match(new RegExp(`${key}=(#[0-9a-fA-F]{3,6})`))?.[1] ?? dflt;
const shapeOf = (style: string): DrawvisoShape => {
  if (/(^|;)\s*swimlane(\s|;|=|$)/.test(style)) return "swimlane";
  const s = style.match(/shape=(\w+)/)?.[1];
  if (s === "ellipse" || s === "cylinder") return "ellipse";
  if (s === "rhombus") return "rhombus";
  return "box";
};

/** 打开:mxGraphModel XML → {nodes,edges}(React Flow 消费)。用宽松 CELL_RE+attr 解析
 *  (同 rebuildDrawioXml),不依赖属性顺序 —— 既吃我们的规范 XML,也吃 draw.io 存量
 *  制品编辑后 autosave 的原生 XML(属性顺序任意、可能 mxfile 包裹)。 */
export function xmlToGraph(xml: string): DrawvisoGraph {
  const nodes: DrawvisoNode[] = [];
  const rawEdges: DrawvisoEdge[] = [];
  const CELL_RE = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g;
  let m: RegExpExecArray | null;
  while ((m = CELL_RE.exec(xml))) {
    const attrs = m[1], inner = m[2] ?? "";
    const id = (attr(attrs, "id") ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!id || id === "0" || id === "1") continue;
    const label = unesc(attr(attrs, "value") ?? "");
    if (attr(attrs, "vertex") === "1") {
      const geo = inner.match(/<mxGeometry\b[^>]*>/)?.[0] ?? "";
      const style = attr(attrs, "style") ?? "";
      const parent = (attr(attrs, "parent") ?? "1").replace(/[^a-zA-Z0-9_-]/g, "");
      nodes.push({
        id,
        shape: shapeOf(style),
        label,
        x: num(attr(geo, "x"), 40, -4000, 12000),
        y: num(attr(geo, "y"), 40, -4000, 12000),
        w: num(attr(geo, "width"), 180, 10, 3000),
        h: num(attr(geo, "height"), 60, 10, 3000),
        fill: styleColor(style, "fillColor", "#e8e8ff"),
        stroke: styleColor(style, "strokeColor", "#6c6cd0"),
        parent: parent && parent !== "1" ? parent : undefined,
      });
    } else if (attr(attrs, "edge") === "1") {
      const source = (attr(attrs, "source") ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
      const target = (attr(attrs, "target") ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
      if (source && target) rawEdges.push({ id, source, target, label });
    }
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) if (n.parent && !ids.has(n.parent)) n.parent = undefined;
  const edges = rawEdges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges };
}

/** 保存:{nodes,edges} → 规范 mxGraphModel XML(编辑器唯一序列化权威,过 cleanStyle)。 */
export function graphToXml(graph: DrawvisoGraph): string {
  const cells: string[] = [];
  // 泳道父节点排前(解码/渲染要求 parent 先于 child)。
  const parents = graph.nodes.filter((n) => graph.nodes.some((c) => c.parent === n.id));
  const rest = graph.nodes.filter((n) => !parents.includes(n));
  for (const n of [...parents, ...rest]) {
    const base = n.shape === "swimlane"
      ? "swimlane;html=0;"
      : n.shape === "ellipse"
      ? "ellipse;whiteSpace=wrap;html=0;"
      : n.shape === "rhombus"
      ? "rhombus;whiteSpace=wrap;html=0;"
      : "rounded=1;whiteSpace=wrap;html=0;";
    const style = cleanStyle(`${base}fillColor=${n.fill};strokeColor=${n.stroke};`, base);
    cells.push(
      `    <mxCell id="${n.id}" value="${esc(n.label)}" style="${esc(style)}" vertex="1" parent="${n.parent && graph.nodes.some((x) => x.id === n.parent) ? n.parent : "1"}"><mxGeometry x="${Math.round(n.x)}" y="${Math.round(n.y)}" width="${Math.round(n.w)}" height="${Math.round(n.h)}" as="geometry" /></mxCell>`
    );
  }
  const vids = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) {
    if (!vids.has(e.source) || !vids.has(e.target)) continue;
    cells.push(
      `    <mxCell id="${e.id}" value="${esc(e.label || "")}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;" edge="1" parent="1" source="${e.source}" target="${e.target}"><mxGeometry relative="1" as="geometry" /></mxCell>`
    );
  }
  return `<mxGraphModel dx="800" dy="600" grid="0" page="0">\n  <root>\n    <mxCell id="0" />\n    <mxCell id="1" parent="0" />\n${cells.join("\n")}\n  </root>\n</mxGraphModel>`;
}
