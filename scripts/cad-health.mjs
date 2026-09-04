#!/usr/bin/env node

/** 实际加载完整依赖闭包并生成最小多实体；供扣费前/后台体检复用。 */
import opencascade from "replicad-opencascadejs";
import { iterTopo, makeBox, makeCompound, measureVolume, setOC } from "replicad";

const oc = await opencascade({ print: () => {}, printErr: () => {} });
setOC(oc);
const shape = makeCompound([
  makeBox([0, 0, 0], [10, 8, 2]),
  makeBox([12, 0, 0], [16, 4, 2]),
]);
const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
const valid = analyzer.IsValid();
analyzer.delete();
const solidShapes = [...iterTopo(shape.wrapped, "solid")];
const solids = solidShapes.length;
for (const solid of solidShapes) solid.delete();
const volume = measureVolume(shape);
const triangles = shape.mesh({ tolerance: 0.2, angularTolerance: 0.3 }).triangles.length / 3;
if (!valid || solids !== 2 || !Number.isFinite(volume) || volume <= 0 || triangles <= 0) {
  throw new Error("CAD runtime smoke failed");
}
console.log(JSON.stringify({ ok: true, solids, volume, triangles }));
