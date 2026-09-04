import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCadDesignSpec, parseCadMeshPayload } from "../../components/CadView.tsx";

const triangle = (offset = 0) => ({
  vertices: [offset, 0, 0, offset + 10, 0, 0, offset, 10, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  triangles: [0, 1, 2],
  lines: [],
});

test("schemaVersion 2 Text2CAD 规格归一为部件树与有序特征历史", () => {
  const parsed = parseCadDesignSpec(JSON.stringify({
    schemaVersion: 2,
    engine: "text2cad",
    template: "text2cad",
    unit: "mm",
    name: "双部件支架",
    process: "CNC加工",
    requirements: [
      "底座宽 80mm",
      { id: "req-hole", text: "立板需要安装孔", sourceRefs: ["prompt:2"] },
    ],
    assumptions: ["未标注公差按普通机械加工处理"],
    parts: [
      {
        id: "base",
        name: "底座",
        material: "aluminum",
        color: "#6750a4",
        placement: { translate: [0, 0, 0], rotateDeg: [0, 0, 0] },
        features: [
          {
            id: "base-extrude",
            kind: "extrude",
            operation: "new",
            plane: "XY",
            origin: [0, 0, 0],
            profile: { outer: "rectangle", holes: [] },
            distance: 8,
            requirementRefs: ["req-1"],
          },
          {
            id: "base-hole",
            kind: "extrude",
            operation: "cut",
            plane: "XY",
            origin: [20, 20, 0],
            profile: { outer: "circle", holes: [] },
            distance: 8,
            requirementRefs: ["req-hole"],
          },
        ],
      },
      {
        id: "upright",
        name: "立板",
        material: "steel",
        color: [0.2, 0.55, 0.75],
        placement: { translate: [0, 0, 8], rotateDeg: [90, 0, 0] },
        features: [],
      },
    ],
  }));

  assert.equal(parsed.error, null);
  assert.equal(parsed.spec.schemaVersion, 2);
  assert.equal(parsed.spec.engine, "text2cad");
  assert.equal(parsed.spec.template, "text2cad");
  assert.equal(parsed.spec.material, "multi_material");
  assert.equal(parsed.spec.process, "CNC加工");
  assert.equal(parsed.spec.parts.length, 2);
  assert.equal(parsed.spec.parts[1].color, "#338cbf");
  assert.deepEqual(parsed.spec.featureGraph.nodes.map((feature) => feature.id), ["base-extrude", "base-hole"]);
  assert.deepEqual(parsed.spec.featureGraph.nodes[1].dependsOn, ["base-extrude"]);
  assert.deepEqual(parsed.spec.requirements.map((requirement) => requirement.id), ["req-1", "req-hole"]);
});

test("mesh.parts[] 按局部索引校验并保留多色部件元数据", () => {
  const mesh = parseCadMeshPayload({
    parts: [
      {
        id: "base",
        name: "底座",
        material: "aluminum",
        color: "#6750a4",
        ...triangle(0),
        bounds: { min: [0, 0, 0], max: [10, 10, 0] },
        volumeMm3: 400,
        features: [{ id: "base-extrude", kind: "extrude", operation: "new", volumeMm3: 400 }],
      },
      {
        id: "upright",
        name: "立板",
        material: "steel",
        color: 0x2f86a6,
        ...triangle(20),
        bounds: { min: [20, 0, 0], max: [30, 10, 0] },
        volumeMm3: 320,
        features: [],
      },
    ],
    manifest: {
      hash: "a".repeat(64),
      template: "text2cad",
      engine: "text2cad",
      artifactMode: "assembly",
      partCount: 2,
      validation: { brepValid: true, solidCount: 2 },
      bounds: { size: [30, 10, 8] },
    },
  });

  assert.deepEqual(mesh.vertices, []);
  assert.equal(mesh.parts.length, 2);
  assert.equal(mesh.parts[0].features[0].kind, "extrude");
  assert.equal(mesh.parts[1].color, "#2f86a6");
  assert.equal(mesh.manifest.partCount, 2);
  assert.equal(mesh.manifest.triangleCount, 2);
  assert.equal(mesh.manifest.volumeMm3, 720);
});

test("旧版单网格 payload 继续兼容且错误局部索引会被拒绝", () => {
  const legacy = parseCadMeshPayload({
    ...triangle(0),
    manifest: {
      hash: "b".repeat(64),
      template: "plate",
      engine: "occt",
      volumeMm3: 10,
      triangleCount: 1,
      validation: { brepValid: true, solidCount: 1 },
      bounds: { size: [10, 10, 1] },
    },
  });
  assert.equal(legacy.parts.length, 0);
  assert.equal(legacy.vertices.length, 9);

  assert.throws(
    () => parseCadMeshPayload({
      parts: [{ id: "bad", name: "坏部件", ...triangle(0), triangles: [0, 1, 4] }],
      manifest: { hash: "c".repeat(64), template: "text2cad", engine: "text2cad" },
    }),
    /引用了不存在的顶点/
  );
});
