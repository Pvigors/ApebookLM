import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  analyzeMermaidTree,
  assertReadableMermaidTree,
  beautifyGeneratedExcalidrawElements,
} from "../../lib/excalidraw-graph.ts";

test("单根分层树通过画板可读性门禁", () => {
  const mermaid = `flowchart TD
N1[核心主题]
N2[规划阶段]
N3[建设阶段]
N4[监测阶段]
N5[知识索引]
N6[分类体系]
N7[质量评估]
N8[动态机制]
N1 --> N2
N1 --> N3
N1 --> N4
N2 --> N5
N3 --> N6
N4 --> N7
N4 --> N8`;
  const result = assertReadableMermaidTree(mermaid);
  assert.equal(result.nodes.length, 8);
  assert.equal(result.edges.length, 7);
  assert.equal(result.root, "N1");
  assert.equal(result.maxDepth, 2);
});

test("重复边、多父节点、环路和链式边会被拒绝", () => {
  const dense = `flowchart TD
N1[根]
N2[甲]
N3[乙]
N4[丙]
N1 --> N2
N1 --> N2
N1 --> N3
N2 --> N4
N3 --> N4
N4 --> N1`;
  const issues = analyzeMermaidTree(dense).issues.join("；");
  assert.match(issues, /重复边/);
  assert.match(issues, /只有一个父节点|主干边数|根节点/);
  assert.throws(() => assertReadableMermaidTree(dense), /生成画板失败/);

  const chained = `flowchart TD
N1[根]
N2[甲]
N3[乙]
N1 --> N2 --> N3`;
  assert.match(analyzeMermaidTree(chained).issues.join("；"), /每行只能有一条边/);
});

test("合法线性流程、二叉树和大节点数不会被排版偏好误杀", () => {
  const chain = `flowchart TD
N1[第一步]
N2[第二步]
N3[第三步]
N4[第四步]
N5[第五步]
N1 --> N2
N2 --> N3
N3 --> N4
N4 --> N5`;
  assert.equal(assertReadableMermaidTree(chain).maxDepth, 4);

  const binary = `flowchart TD
N1[根]
N2[甲]
N3[乙]
N4[甲一]
N5[甲二]
N6[乙一]
N7[乙二]
N8[叶]
N1 --> N2
N1 --> N3
N2 --> N4
N2 --> N5
N3 --> N6
N3 --> N7
N4 --> N8`;
  assert.equal(assertReadableMermaidTree(binary).nodes.length, 8);

  const manyNodes = ["flowchart TD"];
  for (let i = 1; i <= 25; i++) manyNodes.push(`N${i}[节点${i}]`);
  for (let i = 2; i <= 25; i++) manyNodes.push(`N1 --> N${i}`);
  assert.equal(assertReadableMermaidTree(manyNodes.join("\n")).nodes.length, 25);
});

test("新生成画板保留手写节点并采用细直低对比主干", () => {
  const styled = beautifyGeneratedExcalidrawElements([
    { id: "r", type: "rectangle", y: 0, strokeWidth: 2 },
    { id: "n", type: "rectangle", y: 120, strokeWidth: 2 },
    { id: "a", type: "arrow", strokeWidth: 2, roughness: 1, roundness: { type: 2 } },
  ]);
  assert.equal(styled[0].roughness, 1);
  assert.equal(styled[0].backgroundColor, "#eeeafd");
  assert.equal(styled[2].strokeWidth, 1);
  assert.equal(styled[2].roughness, 0);
  assert.equal(styled[2].roundness, null);
});

test("生成提示与客户端持久化遵守树优先和布局版本合同", () => {
  const server = fs.readFileSync(new URL("../../lib/excalidraw.ts", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../../components/Studio.tsx", import.meta.url), "utf8");
  assert.match(server, /strict, single-root, top-down TREE/);
  assert.match(server, /NO cross-branch edges/);
  assert.match(server, /assertReadableMermaidTree/);
  assert.doesNotMatch(server, /cross-links make it a graph/);
  assert.match(client, /beautifyGeneratedExcalidrawElements/);
  assert.match(client, /sourceMermaid/);
  assert.match(client, /layoutVersion: 2/);
  assert.doesNotMatch(client, /migrateVisuals/);
});
