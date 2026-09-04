import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDrawvisoColorRequirements,
  drawvisoLayoutIssues,
  ensureDrawvisoLayout,
  graphToXml,
  rebuildDrawioXml,
  xmlToGraph,
} from "../../lib/drawviso-graph.ts";

const cell = (id, label, x, y, style = "rounded=1;fillColor=#dae8fc;strokeColor=#6c8ebf;") =>
  `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="180" height="60" as="geometry"/></mxCell>`;
const edge = (id, source, target) =>
  `<mxCell id="${id}" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
const xml = (body) => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${body}</root></mxGraphModel>`;

test("Drawviso 重建继续剥离危险 XML/style，并拒绝重复 id 与悬空边", () => {
  const raw = xml(
    cell("n1", "风险节点", 40, 40, "shape=image;image=https://evil/x;fillColor=#f8cecc;strokeColor=#b85450;evil=url(javascript:alert(1));") +
    cell("n1", "重复节点", 260, 40) +
    cell("n2", "处置", 260, 160) +
    cell("n3", "结果", 480, 160) +
    edge("e1", "n1", "n2") +
    edge("e2", "n1", "missing")
  );
  const rebuilt = rebuildDrawioXml(raw);
  assert.equal(rebuilt.vertexCount, 3);
  assert.equal(rebuilt.edgeCount, 1);
  assert.doesNotMatch(rebuilt.xml, /shape=image|image=|javascript:|url\s*\(/i);
  assert.match(rebuilt.xml, /fillColor=#f8cecc/);
  assert.match(rebuilt.xml, /strokeColor=#b85450/);
  assert.doesNotMatch(rebuilt.xml, /重复节点/);
});
test("Drawviso 颜色合同先铺全局色，再由具名节点色覆盖", () => {
  const graph = {
    nodes: [
      { id: "n1", shape: "box", label: "核心模块", x: 40, y: 40, w: 180, h: 60, fill: "#fff", stroke: "#000" },
      { id: "n2", shape: "box", label: "风险节点", x: 260, y: 40, w: 180, h: 60, fill: "#fff", stroke: "#000" },
    ],
    edges: [],
  };
  const result = applyDrawvisoColorRequirements(graph, [
    { target: "风险点", fill: "#f8cecc", stroke: "#b85450" },
    { target: null, fill: "#d5e8d4", stroke: "#82b366" },
  ]);
  assert.deepEqual(result.unmatchedTargets, []);
  assert.equal(result.graph.nodes[0].fill, "#d5e8d4");
  assert.equal(result.graph.nodes[1].fill, "#f8cecc");
  assert.equal(result.graph.nodes[1].stroke, "#b85450");
  const missing = applyDrawvisoColorRequirements(graph, [
    { target: "不存在节点", fill: "#f8cecc", stroke: "#b85450" },
  ]);
  assert.deepEqual(missing.unmatchedTargets, ["不存在节点"]);
});

test("Drawviso 对越界重叠节点做稳定自动布局，有效布局保持不动", () => {
  const bad = {
    nodes: ["甲", "乙", "丙"].map((label, index) => ({
      id: `n${index + 1}`, shape: "box", label, x: 3000, y: 3000, w: 180, h: 60,
      fill: "#dae8fc", stroke: "#6c8ebf",
    })),
    edges: [
      { id: "e1", source: "n1", target: "n2", label: "" },
      { id: "e2", source: "n1", target: "n3", label: "" },
    ],
  };
  assert.match(drawvisoLayoutIssues(bad).join("；"), /超出画布|重叠/);
  const fixed = ensureDrawvisoLayout(bad);
  assert.equal(fixed.repaired, true);
  assert.deepEqual(fixed.issues, []);
  assert.deepEqual(drawvisoLayoutIssues(xmlToGraph(graphToXml(fixed.graph))), []);

  const valid = {
    ...bad,
    nodes: bad.nodes.map((node, index) => ({ ...node, x: 40 + index * 220, y: 40 })),
  };
  const kept = ensureDrawvisoLayout(valid);
  assert.equal(kept.repaired, false);
  assert.deepEqual(kept.graph, valid);
});
