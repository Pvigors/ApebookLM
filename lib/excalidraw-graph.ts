export type MermaidTreeAnalysis = {
  nodes: string[];
  edges: Array<{ from: string; to: string; label: string }>;
  root: string | null;
  maxDepth: number;
  issues: string[];
};

const NODE_ID = "[A-Za-z][A-Za-z0-9_-]*";
const SHAPE = String.raw`(?:\[[^\]\n]+\]|\([^\)\n]+\)|\{[^\}\n]+\})`;
const NODE_RE = new RegExp(String.raw`\b(${NODE_ID})\s*(${SHAPE})`, "g");
const EDGE_RE = new RegExp(
  String.raw`^\s*(${NODE_ID})(?:\s*${SHAPE})?\s*(-->)\s*(?:\|([^|\n]{0,24})\|\s*)?(${NODE_ID})(?:\s*${SHAPE})?\s*$`
);

/** 解析本产品允许的 Mermaid 子集，并验证“单根分层树”可读性合同。 */
export function analyzeMermaidTree(mermaid: string): MermaidTreeAnalysis {
  const nodes = new Set<string>();
  const edges: Array<{ from: string; to: string; label: string }> = [];
  const issues: string[] = [];
  const lines = (mermaid || "").split(/\r?\n/);
  const head = lines.find((line) => line.trim())?.trim() ?? "";
  if (!/^flowchart\s+TD$/i.test(head)) issues.push("图方向必须是 flowchart TD");

  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    NODE_RE.lastIndex = 0;
    for (const match of trimmed.matchAll(NODE_RE)) nodes.add(match[1]);
    const arrowCount = (trimmed.match(/-->|---|-\.->|==>|--x|--o/g) ?? []).length;
    if (arrowCount > 1) {
      issues.push("每行只能有一条边");
      continue;
    }
    if (arrowCount === 1) {
      const edge = trimmed.match(EDGE_RE);
      if (!edge) {
        issues.push("存在不受支持的边语法");
        continue;
      }
      nodes.add(edge[1]);
      nodes.add(edge[4]);
      edges.push({ from: edge[1], to: edge[4], label: (edge[3] || "").trim() });
    }
  }

  const nodeList = [...nodes];
  if (nodeList.length < 3) issues.push("节点少于 3 个");
  const seenEdges = new Set<string>();
  const indegree = new Map(nodeList.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.from === edge.to) issues.push("存在自环");
    const key = `${edge.from}\u0000${edge.to}`;
    if (seenEdges.has(key)) issues.push("存在重复边");
    seenEdges.add(key);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const children = adjacency.get(edge.from) ?? [];
    children.push(edge.to);
    adjacency.set(edge.from, children);
  }
  const roots = nodeList.filter((id) => (indegree.get(id) ?? 0) === 0);
  if (roots.length !== 1) issues.push("必须且只能有一个根节点");
  for (const id of nodeList) {
    const degree = indegree.get(id) ?? 0;
    if (!roots.includes(id) && degree !== 1) issues.push(`节点 ${id} 必须只有一个父节点`);
  }
  if (edges.length !== Math.max(0, nodeList.length - 1)) issues.push("主干边数必须等于节点数减一");

  const root = roots.length === 1 ? roots[0] : null;
  let maxDepth = 0;
  if (root) {
    const queue: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }];
    const visited = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current.id)) {
        issues.push("存在环路");
        continue;
      }
      visited.add(current.id);
      maxDepth = Math.max(maxDepth, current.depth);
      for (const child of adjacency.get(current.id) ?? []) {
        queue.push({ id: child, depth: current.depth + 1 });
      }
    }
    if (visited.size !== nodeList.length) issues.push("图中存在未连接节点");
    // 深度、分支数和总节点数是默认排版偏好，不是结构正确性的硬门。
    // 用户明确要求线性流程、深层体系或精确节点数时，仍应允许合法严格树通过。
  }
  return { nodes: nodeList, edges, root, maxDepth, issues: [...new Set(issues)] };
}

export function assertReadableMermaidTree(mermaid: string): MermaidTreeAnalysis {
  const analysis = analyzeMermaidTree(mermaid);
  if (analysis.issues.length) {
    throw new Error(`生成画板失败：${analysis.issues.join("；")}`);
  }
  return analysis;
}

/** 模型超出用户精确节点数时，按根节点 BFS 保留前 N 个节点并重建严格树。 */
export function pruneMermaidTreeToCount(mermaid: string, count: number): string {
  const analysis = assertReadableMermaidTree(mermaid);
  if (count < 3 || analysis.nodes.length <= count || !analysis.root) return mermaid;
  const children = new Map<string, string[]>();
  for (const edge of analysis.edges) {
    const list = children.get(edge.from) ?? [];
    list.push(edge.to);
    children.set(edge.from, list);
  }
  const selected: string[] = [];
  const queue = [analysis.root];
  while (queue.length && selected.length < count) {
    const id = queue.shift()!;
    if (selected.includes(id)) continue;
    selected.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  const keep = new Set(selected);
  const definitions = new Map<string, string>();
  NODE_RE.lastIndex = 0;
  for (const match of mermaid.matchAll(NODE_RE)) {
    if (keep.has(match[1]) && !definitions.has(match[1])) definitions.set(match[1], `${match[1]}${match[2]}`);
  }
  const lines = ["flowchart TD"];
  for (const id of selected) lines.push(`  ${definitions.get(id) ?? `${id}[${id}]`}`);
  for (const edge of analysis.edges) {
    if (!keep.has(edge.from) || !keep.has(edge.to)) continue;
    lines.push(`  ${edge.from} -->${edge.label ? `|${edge.label}| ` : " "}${edge.to}`);
  }
  const result = lines.join("\n");
  assertReadableMermaidTree(result);
  return result;
}

/** 新生成场景的轻量视觉分层：保留手写节点，主干改成细、低对比、无大圆角折线。 */
export function beautifyGeneratedExcalidrawElements(elements: unknown[]): unknown[] {
  const rows = [...new Set(
    (elements as Array<Record<string, unknown>>)
      .filter((element) => ["rectangle", "ellipse", "diamond"].includes(String(element.type)))
      .map((element) => Math.round(Number(element.y) / 80) * 80)
  )].sort((a, b) => a - b);
  return (elements as Array<Record<string, unknown>>).map((raw) => {
    const element = { ...raw };
    if (element.type === "arrow" || element.type === "line") {
      element.strokeColor = "#77728f";
      element.strokeWidth = 1;
      element.roughness = 0;
      element.roundness = null;
      return element;
    }
    if (["rectangle", "ellipse", "diamond"].includes(String(element.type))) {
      const row = rows.indexOf(Math.round(Number(element.y) / 80) * 80);
      element.fillStyle = "solid";
      element.roughness = 1;
      element.strokeWidth = row === 0 ? 2 : 1;
      element.strokeColor = row === 0 ? "#6558d9" : row === 1 ? "#8377c8" : "#aaa4bd";
      element.backgroundColor = row === 0 ? "#eeeafd" : row === 1 ? "#f6f3ff" : "#ffffff";
      return element;
    }
    if (element.type === "text") element.strokeColor = "#29263a";
    return element;
  });
}
