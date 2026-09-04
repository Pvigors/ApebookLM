#!/usr/bin/env node

/**
 * Text2CAD V2 受控几何工人。
 *
 * 这里只解释规格层已经归一化的 JSON；不会 import 用户文件、执行用户代码、
 * 访问网络或接受任意输出文件名。每个特征和部件都必须通过 Open CASCADE
 * 的 B-Rep、正体积、单实体门禁，装配还必须通过实体干涉检查后才能发布。
 */

import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import opencascade from "replicad-opencascadejs";
import {
  Sketcher,
  exportSTEP,
  iterTopo,
  makeCompound,
  measureVolume,
  setOC,
} from "replicad";

const [inputPath, outputDir, designHash] = process.argv.slice(2);
if (!inputPath || !outputDir || !/^[a-f0-9]{64}$/.test(designHash || "")) {
  throw new Error("用法:text2cad-worker <spec.json> <output-dir> <sha256>");
}

const tmpRoot = path.resolve(process.cwd(), ".data", "cad-tmp");
const safeOutputDir = path.resolve(outputDir);
const safeInputPath = path.resolve(inputPath);
if (!safeOutputDir.startsWith(`${tmpRoot}${path.sep}`) || !safeInputPath.startsWith(`${safeOutputDir}${path.sep}`)) {
  throw new Error("Text2CAD 工人拒绝访问受控临时目录以外的路径");
}

const [realTmpRoot, realOutputDir, realInputPath, outputInfo, inputInfo] = await Promise.all([
  realpath(tmpRoot),
  realpath(safeOutputDir),
  realpath(safeInputPath),
  lstat(safeOutputDir),
  lstat(safeInputPath),
]);
if (
  outputInfo.isSymbolicLink()
  || inputInfo.isSymbolicLink()
  || !outputInfo.isDirectory()
  || !inputInfo.isFile()
  || !realOutputDir.startsWith(`${realTmpRoot}${path.sep}`)
  || !realInputPath.startsWith(`${realOutputDir}${path.sep}`)
) {
  throw new Error("Text2CAD 工人拒绝符号链接或越界目录");
}
if ((await stat(realInputPath)).size > 256 * 1024) throw new Error("Text2CAD 规格文件超过 256KB");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * 输出 2D DXF 顶视图。它是 B-Rep 边线在 XY 平面的毫米投影，不宣称承载
 * STEP 的三维实体或参数历史。LINE 实体让常见 CAD 和独立读取器都能稳定打开。
 */
function buildTopProjectionDxf(edgeSets) {
  const round = (value) => {
    const result = Math.round(value * 1_000_000) / 1_000_000;
    return Object.is(result, -0) ? 0 : result;
  };
  const number = (value) => {
    const result = round(value);
    if (!Number.isFinite(result)) throw new Error("DXF 顶视投影包含无效坐标");
    return String(result);
  };
  const segments = [];
  const layers = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [setIndex, edgeSet] of edgeSets.entries()) {
    const layer = String(edgeSet.layer || `PART_${setIndex + 1}`)
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .slice(0, 48) || `PART_${setIndex + 1}`;
    if (!layers.includes(layer)) layers.push(layer);
    const lines = Array.from(edgeSet.edges?.lines || []);
    const groups = edgeSet.edges?.edgeGroups;
    if (lines.length % 3 !== 0 || !Array.isArray(groups)) {
      throw new Error("DXF 顶视投影的 B-Rep 边数据无效");
    }
    const seen = new Set();
    for (const group of groups) {
      const start = Number(group?.start);
      const count = Number(group?.count);
      if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 2 || start + count > lines.length / 3) {
        throw new Error("DXF 顶视投影的边分组无效");
      }
      for (let pointIndex = start + 1; pointIndex < start + count; pointIndex++) {
        const aOffset = (pointIndex - 1) * 3;
        const bOffset = pointIndex * 3;
        const ax = round(Number(lines[aOffset]));
        const ay = round(Number(lines[aOffset + 1]));
        const bx = round(Number(lines[bOffset]));
        const by = round(Number(lines[bOffset + 1]));
        if (![ax, ay, bx, by].every(Number.isFinite)) throw new Error("DXF 顶视投影包含无效坐标");
        if (Math.abs(ax - bx) <= 1e-6 && Math.abs(ay - by) <= 1e-6) continue;
        const first = `${number(ax)},${number(ay)}`;
        const second = `${number(bx)},${number(by)}`;
        const key = first < second ? `${first}|${second}` : `${second}|${first}`;
        if (seen.has(key)) continue;
        seen.add(key);
        segments.push({ layer, ax, ay, bx, by });
        minX = Math.min(minX, ax, bx);
        minY = Math.min(minY, ay, by);
        maxX = Math.max(maxX, ax, bx);
        maxY = Math.max(maxY, ay, by);
        if (segments.length > 500_000) throw new Error("DXF 顶视投影线段超过 500000 条");
      }
    }
  }
  if (!segments.length || ![minX, minY, maxX, maxY].every(Number.isFinite)) {
    throw new Error("DXF 顶视投影没有可导出的二维边线");
  }

  const rows = [];
  const pair = (code, value) => rows.push(String(code), String(value));
  pair(0, "SECTION"); pair(2, "HEADER");
  // AC1015（AutoCAD 2000）正式定义 $INSUNITS；4 表示毫米。
  pair(9, "$ACADVER"); pair(1, "AC1015");
  pair(9, "$INSUNITS"); pair(70, 4);
  pair(9, "$MEASUREMENT"); pair(70, 1);
  pair(9, "$EXTMIN"); pair(10, number(minX)); pair(20, number(minY)); pair(30, 0);
  pair(9, "$EXTMAX"); pair(10, number(maxX)); pair(20, number(maxY)); pair(30, 0);
  pair(0, "ENDSEC");
  pair(0, "SECTION"); pair(2, "TABLES");
  pair(0, "TABLE"); pair(2, "LTYPE"); pair(70, 1);
  pair(0, "LTYPE"); pair(2, "CONTINUOUS"); pair(70, 0); pair(3, "Solid line"); pair(72, 65); pair(73, 0); pair(40, 0);
  pair(0, "ENDTAB");
  pair(0, "TABLE"); pair(2, "LAYER"); pair(70, layers.length);
  for (const layer of layers) {
    pair(0, "LAYER"); pair(2, layer); pair(70, 0); pair(62, 7); pair(6, "CONTINUOUS");
  }
  pair(0, "ENDTAB"); pair(0, "ENDSEC");
  pair(0, "SECTION"); pair(2, "ENTITIES");
  for (const segment of segments) {
    pair(0, "LINE"); pair(8, segment.layer);
    pair(10, number(segment.ax)); pair(20, number(segment.ay)); pair(30, 0);
    pair(11, number(segment.bx)); pair(21, number(segment.by)); pair(31, 0);
  }
  pair(0, "ENDSEC"); pair(0, "EOF");
  const file = Buffer.from(`${rows.join("\r\n")}\r\n`, "ascii");
  if (file.length < 128 || file.length > 100 * 1024 * 1024) throw new Error("DXF 顶视投影文件大小异常");
  return {
    file,
    contract: {
      version: 1,
      view: "top",
      plane: "XY",
      unit: "mm",
      representation: "projected_brep_edges",
      entityType: "LINE",
      lineCount: segments.length,
      bounds: [[minX, minY], [maxX, maxY]],
    },
  };
}
const round = (value) => Math.round(value * 1_000) / 1_000;
const roughRoundedBounds = (shape) => shape.boundingBox.bounds.map((point) => point.map(round));
const roundedBounds = (shape) => {
  const box = new oc.Bnd_Box();
  oc.BRepBndLib.AddOptimal(shape.wrapped, box, false, false);
  const min = box.CornerMin();
  const max = box.CornerMax();
  const bounds = [
    [round(min.X()), round(min.Y()), round(min.Z())],
    [round(max.X()), round(max.Y()), round(max.Z())],
  ];
  min.delete();
  max.delete();
  box.delete();
  return bounds;
};
const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function assertOnlyKeys(value, allowed, label) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label}包含未知字段或不是对象`);
  }
}

function assertString(value, label, maxLength = 120) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label}无效`);
  }
}

function assertVector(value, length, label, maxAbs = 12_000) {
  if (
    !Array.isArray(value)
    || value.length !== length
    || value.some((item) => !Number.isFinite(item) || Math.abs(item) > maxAbs)
  ) {
    throw new Error(`${label}无效`);
  }
}

function assertProfile(profile, label) {
  if (!isRecord(profile)) throw new Error(`${label}不是对象`);
  if (profile.kind === "rectangle") {
    assertOnlyKeys(profile, new Set(["kind", "width", "height", "center", "cornerRadius"]), label);
    if (!Number.isFinite(profile.width) || profile.width <= 0 || profile.width > 12_000) throw new Error(`${label}宽度无效`);
    if (!Number.isFinite(profile.height) || profile.height <= 0 || profile.height > 12_000) throw new Error(`${label}高度无效`);
    assertVector(profile.center, 2, `${label}中心`);
    if (
      !Number.isFinite(profile.cornerRadius)
      || profile.cornerRadius < 0
      || profile.cornerRadius * 2 >= Math.min(profile.width, profile.height) && profile.cornerRadius !== 0
    ) {
      throw new Error(`${label}圆角半径无效`);
    }
    return;
  }
  if (profile.kind === "circle") {
    assertOnlyKeys(profile, new Set(["kind", "radius", "center"]), label);
    if (!Number.isFinite(profile.radius) || profile.radius <= 0 || profile.radius > 6_000) throw new Error(`${label}半径无效`);
    assertVector(profile.center, 2, `${label}中心`);
    return;
  }
  if (profile.kind === "polygon") {
    assertOnlyKeys(profile, new Set(["kind", "points"]), label);
    if (!Array.isArray(profile.points) || profile.points.length < 3 || profile.points.length > 128) {
      throw new Error(`${label}多边形点数无效`);
    }
    profile.points.forEach((point, index) => assertVector(point, 2, `${label}点 ${index}`));
    return;
  }
  if (profile.kind === "path") {
    assertOnlyKeys(profile, new Set(["kind", "segments"]), label);
    if (!Array.isArray(profile.segments) || profile.segments.length < 2 || profile.segments.length > 128) {
      throw new Error(`${label}路径段数无效`);
    }
    profile.segments.forEach((segment, index) => {
      if (!isRecord(segment)) throw new Error(`${label}路径段 ${index} 无效`);
      if (segment.kind === "line") {
        assertOnlyKeys(segment, new Set(["kind", "start", "end"]), `${label}路径段 ${index}`);
        assertVector(segment.start, 2, `${label}路径段 ${index} 起点`);
        assertVector(segment.end, 2, `${label}路径段 ${index} 终点`);
      } else if (segment.kind === "arc") {
        assertOnlyKeys(segment, new Set(["kind", "start", "mid", "end"]), `${label}路径段 ${index}`);
        assertVector(segment.start, 2, `${label}路径段 ${index} 起点`);
        assertVector(segment.mid, 2, `${label}路径段 ${index} 经过点`);
        assertVector(segment.end, 2, `${label}路径段 ${index} 终点`);
      } else {
        throw new Error(`${label}路径段 ${index} 类型无效`);
      }
    });
    return;
  }
  throw new Error(`${label}轮廓类型无效`);
}

function readNormalizedSpec(value) {
  assertOnlyKeys(
    value,
    new Set(["schemaVersion", "engine", "unit", "name", "process", "requirements", "assumptions", "parts"]),
    "Text2CAD 规格"
  );
  if (value.schemaVersion !== 2 || value.engine !== "text2cad" || value.unit !== "mm") {
    throw new Error("Text2CAD 规格版本、引擎或单位无效");
  }
  assertString(value.name, "Text2CAD 规格名称", 160);
  assertString(value.process, "Text2CAD 制造工艺", 120);
  if (!Array.isArray(value.requirements) || value.requirements.length > 128) throw new Error("Text2CAD 需求列表无效");
  value.requirements.forEach((requirement, index) => {
    assertOnlyKeys(requirement, new Set(["id", "text", "sourceRefs", "acceptance"]), `需求 ${index}`);
    assertString(requirement.id, `需求 ${index} ID`, 80);
    assertString(requirement.text, `需求 ${index} 文本`, 1_000);
    if (
      !Array.isArray(requirement.sourceRefs)
      || requirement.sourceRefs.length < 1
      || requirement.sourceRefs.length > 16
      || requirement.sourceRefs.some((item) => (
        typeof item !== "string"
        || !/^(?:prompt:1|source:[1-9][0-9]{0,5}|system:design-assumption|model:input)$/.test(item)
      ))
    ) {
      throw new Error(`需求 ${index} 来源引用无效`);
    }
    if (new Set(requirement.sourceRefs).size !== requirement.sourceRefs.length) throw new Error(`需求 ${index} 来源引用重复`);
    if (
      requirement.acceptance !== undefined
      && (typeof requirement.acceptance !== "string" || !requirement.acceptance.trim() || requirement.acceptance.length > 300)
    ) {
      throw new Error(`需求 ${index} 验收条件无效`);
    }
  });
  if (!Array.isArray(value.assumptions) || value.assumptions.length > 128 || value.assumptions.some((item) => typeof item !== "string" || item.length > 1_000)) {
    throw new Error("Text2CAD 假设列表无效");
  }
  if (!Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 24) throw new Error("Text2CAD 部件列表无效");

  const partIds = new Set();
  value.parts.forEach((part, partIndex) => {
    assertOnlyKeys(part, new Set(["id", "name", "material", "color", "placement", "features"]), `部件 ${partIndex}`);
    assertString(part.id, `部件 ${partIndex} ID`, 80);
    assertString(part.name, `部件 ${partIndex} 名称`, 120);
    assertString(part.material, `部件 ${partIndex} 材料`, 120);
    assertString(part.color, `部件 ${partIndex} 颜色`, 32);
    if (partIds.has(part.id)) throw new Error(`部件 ID 重复:${part.id}`);
    partIds.add(part.id);
    assertOnlyKeys(part.placement, new Set(["translate", "rotateDeg"]), `部件 ${part.id} 放置`);
    assertVector(part.placement.translate, 3, `部件 ${part.id} 平移`);
    assertVector(part.placement.rotateDeg, 3, `部件 ${part.id} 旋转`, 360);
    if (!Array.isArray(part.features) || part.features.length < 1 || part.features.length > 32) {
      throw new Error(`部件 ${part.id} 特征列表无效`);
    }
    const featureIds = new Set();
    part.features.forEach((feature, featureIndex) => {
      assertOnlyKeys(
        feature,
        new Set(["id", "kind", "operation", "plane", "origin", "profile", "distance", "requirementRefs"]),
        `部件 ${part.id} 特征 ${featureIndex}`
      );
      assertString(feature.id, `部件 ${part.id} 特征 ${featureIndex} ID`, 80);
      if (featureIds.has(feature.id)) throw new Error(`部件 ${part.id} 特征 ID 重复:${feature.id}`);
      featureIds.add(feature.id);
      if (feature.kind !== "extrude" || !["new", "add", "cut", "intersect"].includes(feature.operation)) {
        throw new Error(`部件 ${part.id} 特征 ${feature.id} 类型或操作无效`);
      }
      if (featureIndex === 0 ? feature.operation !== "new" : feature.operation === "new") {
        throw new Error(`部件 ${part.id} 必须且只能以一个 new 特征开始`);
      }
      if (!["XY", "XZ", "YZ"].includes(feature.plane)) throw new Error(`部件 ${part.id} 特征 ${feature.id} 平面无效`);
      assertVector(feature.origin, 3, `部件 ${part.id} 特征 ${feature.id} 原点`);
      if (!Number.isFinite(feature.distance) || feature.distance <= 0 || feature.distance > 12_000) {
        throw new Error(`部件 ${part.id} 特征 ${feature.id} 拉伸距离无效`);
      }
      assertOnlyKeys(feature.profile, new Set(["outer", "holes"]), `部件 ${part.id} 特征 ${feature.id} 轮廓`);
      assertProfile(feature.profile.outer, `部件 ${part.id} 特征 ${feature.id} 外轮廓`);
      if (!Array.isArray(feature.profile.holes) || feature.profile.holes.length > 32) {
        throw new Error(`部件 ${part.id} 特征 ${feature.id} 孔列表无效`);
      }
      feature.profile.holes.forEach((hole, holeIndex) => assertProfile(hole, `部件 ${part.id} 特征 ${feature.id} 孔 ${holeIndex}`));
      if (!Array.isArray(feature.requirementRefs) || feature.requirementRefs.length > 128 || feature.requirementRefs.some((item) => typeof item !== "string")) {
        throw new Error(`部件 ${part.id} 特征 ${feature.id} 需求引用无效`);
      }
    });
  });
  return value;
}

function profileSketch(profile, plane, origin) {
  const sketcher = new Sketcher(plane, origin);
  if (profile.kind === "rectangle") {
    const [cx, cy] = profile.center;
    const x0 = cx - profile.width / 2;
    const x1 = cx + profile.width / 2;
    const y0 = cy - profile.height / 2;
    const y1 = cy + profile.height / 2;
    const radius = profile.cornerRadius;
    if (!radius) {
      return sketcher.movePointerTo([x0, y0]).lineTo([x1, y0]).lineTo([x1, y1]).lineTo([x0, y1]).close();
    }
    const diagonal = radius / Math.sqrt(2);
    return sketcher
      .movePointerTo([x0 + radius, y0])
      .lineTo([x1 - radius, y0])
      .threePointsArcTo([x1, y0 + radius], [x1 - radius + diagonal, y0 + radius - diagonal])
      .lineTo([x1, y1 - radius])
      .threePointsArcTo([x1 - radius, y1], [x1 - radius + diagonal, y1 - radius + diagonal])
      .lineTo([x0 + radius, y1])
      .threePointsArcTo([x0, y1 - radius], [x0 + radius - diagonal, y1 - radius + diagonal])
      .lineTo([x0, y0 + radius])
      .threePointsArcTo([x0 + radius, y0], [x0 + radius - diagonal, y0 + radius - diagonal])
      .close();
  }
  if (profile.kind === "circle") {
    const [cx, cy] = profile.center;
    const radius = profile.radius;
    return sketcher
      .movePointerTo([cx + radius, cy])
      .threePointsArcTo([cx - radius, cy], [cx, cy + radius])
      .threePointsArcTo([cx + radius, cy], [cx, cy - radius])
      .close();
  }
  if (profile.kind === "polygon") {
    const [start, ...rest] = profile.points;
    let current = sketcher.movePointerTo(start);
    for (const point of rest) current = current.lineTo(point);
    return current.close();
  }
  let current = sketcher.movePointerTo(profile.segments[0].start);
  for (const segment of profile.segments) {
    current = segment.kind === "line"
      ? current.lineTo(segment.end)
      : current.threePointsArcTo(segment.end, segment.mid);
  }
  return current.close();
}

function buildFeatureShape(feature, label) {
  let shape = profileSketch(feature.profile.outer, feature.plane, feature.origin).extrude(feature.distance);
  let volumeMm3 = validateSingleSolid(shape, `${label}外轮廓`);
  for (let index = 0; index < feature.profile.holes.length; index++) {
    const hole = feature.profile.holes[index];
    const cutter = profileSketch(hole, feature.plane, feature.origin).extrude(feature.distance);
    const cutterVolume = validateSingleSolid(cutter, `${label}孔 ${index} 刀具体`);
    shape = shape.cut(cutter);
    const nextVolume = validateSingleSolid(shape, `${label}孔 ${index} 切除结果`);
    const epsilon = Math.max(1e-6, volumeMm3 * 1e-9);
    if (nextVolume >= volumeMm3 - epsilon) throw new Error(`${label}孔 ${index} 未实质降低特征体积`);
    const removedVolume = volumeMm3 - nextVolume;
    const containmentTolerance = Math.max(1e-5, cutterVolume * 1e-7);
    if (Math.abs(removedVolume - cutterVolume) > containmentTolerance) {
      throw new Error(`${label}孔 ${index} 未完整位于外轮廓内或与其它孔重叠`);
    }
    volumeMm3 = nextVolume;
  }
  return shape;
}

function topologyCount(shape, kind) {
  const items = [...iterTopo(shape.wrapped, kind)];
  const count = items.length;
  for (const item of items) item.delete();
  return count;
}

function validateSingleSolid(shape, label) {
  if (!shape || shape.isNull) throw new Error(`${label}生成了空形体`);
  const solidCount = topologyCount(shape, "solid");
  if (solidCount !== 1) throw new Error(`${label}必须保持单一连通实体，实际得到 ${solidCount} 个实体`);
  const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
  const brepValid = analyzer.IsValid();
  analyzer.delete();
  const volumeMm3 = measureVolume(shape);
  if (!brepValid || !Number.isFinite(volumeMm3) || volumeMm3 <= 1e-7) {
    throw new Error(`${label}未通过 B-Rep 或正体积校验`);
  }
  return volumeMm3;
}

function applyPlacement(shape, placement) {
  let placed = shape;
  const [rx, ry, rz] = placement.rotateDeg;
  if (rx) placed = placed.rotate(rx, [0, 0, 0], [1, 0, 0]);
  if (ry) placed = placed.rotate(ry, [0, 0, 0], [0, 1, 0]);
  if (rz) placed = placed.rotate(rz, [0, 0, 0], [0, 0, 1]);
  if (placement.translate.some(Boolean)) placed = placed.translate(placement.translate);
  return placed;
}

function boxesHavePositiveOverlap(first, second, tolerance = 1e-6) {
  return [0, 1, 2].every((axis) => (
    Math.min(first[1][axis], second[1][axis]) - Math.max(first[0][axis], second[0][axis]) > tolerance
  ));
}

function assertPartsDoNotInterfere(parts) {
  for (let left = 0; left < parts.length; left++) {
    for (let right = left + 1; right < parts.length; right++) {
      if (!boxesHavePositiveOverlap(parts[left].shape.boundingBox.bounds, parts[right].shape.boundingBox.bounds)) continue;
      const overlap = parts[left].shape.clone().intersect(parts[right].shape.clone());
      const overlapVolume = overlap.isNull ? 0 : measureVolume(overlap);
      overlap.delete();
      const tolerance = Math.max(1e-6, Math.min(parts[left].volumeMm3, parts[right].volumeMm3) * 1e-9);
      if (!Number.isFinite(overlapVolume) || overlapVolume > tolerance) {
        throw new Error(
          `部件 ${parts[left].id} 与 ${parts[right].id} 存在实体干涉；`
          + `${parts[left].id}包围盒=${JSON.stringify(roughRoundedBounds(parts[left].shape))}；`
          + `${parts[right].id}包围盒=${JSON.stringify(roughRoundedBounds(parts[right].shape))}；`
          + `相交体积=${round(overlapVolume)}mm3。请调整 placement 或尺寸，只允许接触不允许正体积重叠`
        );
      }
    }
  }
}

function appendPartMesh(combined, part, features) {
  const mesh = part.shape.mesh({ tolerance: 0.15, angularTolerance: 0.25 });
  const edges = part.shape.meshEdges({ tolerance: 0.15, angularTolerance: 0.25 });
  const vertexOffset = combined.vertices.length / 3;
  combined.vertices.push(...mesh.vertices);
  combined.normals.push(...mesh.normals);
  combined.triangles.push(...mesh.triangles.map((index) => index + vertexOffset));
  combined.lines.push(...edges.lines);
  const triangleCount = mesh.triangles.length / 3;
  combined.parts.push({
    id: part.id,
    name: part.name,
    material: part.material,
    color: part.color,
    vertices: mesh.vertices,
    normals: mesh.normals,
    triangles: mesh.triangles,
    lines: edges.lines,
    bounds: roundedBounds(part.shape),
    volumeMm3: round(part.volumeMm3),
    features,
  });
  return triangleCount;
}

const raw = await readFile(realInputPath, "utf8");
if (sha256(raw) !== designHash) throw new Error("Text2CAD 规格 hash 与工人输入不一致");
const spec = readNormalizedSpec(JSON.parse(raw));
const oc = await opencascade({ print: () => {}, printErr: () => {} });
setOC(oc);

const startedAt = Date.now();
const featureHistory = [];
const parts = [];
for (const partSpec of spec.parts) {
  let partShape = null;
  let partVolumeMm3 = 0;
  for (const feature of partSpec.features) {
    const label = `部件 ${partSpec.id} 特征 ${feature.id}`;
    const featureShape = buildFeatureShape(feature, label);
    const featureVolumeMm3 = validateSingleSolid(featureShape, `${label}的独立几何`);
    const previousVolumeMm3 = partVolumeMm3;
    if (feature.operation === "new") partShape = featureShape;
    else if (feature.operation === "add") partShape = partShape.fuse(featureShape);
    else if (feature.operation === "cut") partShape = partShape.cut(featureShape);
    else partShape = partShape.intersect(featureShape);
    const volumeMm3 = validateSingleSolid(partShape, `${label}的运算结果`);
    const epsilon = Math.max(1e-6, Math.max(previousVolumeMm3, featureVolumeMm3, volumeMm3) * 1e-9);
    if (feature.operation === "add" && volumeMm3 <= previousVolumeMm3 + epsilon) {
      throw new Error(`${label} add 未实质增加部件体积`);
    }
    if (feature.operation === "cut" && volumeMm3 >= previousVolumeMm3 - epsilon) {
      throw new Error(`${label} cut 未实质降低部件体积`);
    }
    if (feature.operation === "intersect" && volumeMm3 >= previousVolumeMm3 - epsilon) {
      throw new Error(`${label} intersect 未实质改变部件体积`);
    }
    partVolumeMm3 = volumeMm3;
    featureHistory.push({
      partId: partSpec.id,
      featureId: feature.id,
      kind: feature.kind,
      operation: feature.operation,
      requirementRefs: feature.requirementRefs,
      volumeMm3: round(volumeMm3),
      bounds: roughRoundedBounds(partShape),
    });
  }
  const shape = applyPlacement(partShape, partSpec.placement);
  const volumeMm3 = validateSingleSolid(shape, `部件 ${partSpec.id} 放置结果`);
  parts.push({
    id: partSpec.id,
    name: partSpec.name,
    material: partSpec.material,
    color: partSpec.color,
    featureCount: partSpec.features.length,
    shape,
    volumeMm3,
  });
}

assertPartsDoNotInterfere(parts);
// makeCompound 会接管并删除传入形体；传 clone 保留每个命名部件，供语义网格和
// STEP 装配导出继续使用。
const combinedShape = makeCompound(parts.map((part) => part.shape.clone()));
const combinedSolidCount = topologyCount(combinedShape, "solid");
if (combinedSolidCount !== parts.length) {
  throw new Error(`Text2CAD 装配实体数异常，预期 ${parts.length}，实际 ${combinedSolidCount}`);
}
const combinedAnalyzer = new oc.BRepCheck_Analyzer(combinedShape.wrapped, true, false, false);
const combinedBrepValid = combinedAnalyzer.IsValid();
combinedAnalyzer.delete();
if (!combinedBrepValid) throw new Error("Text2CAD 装配未通过 B-Rep 校验");

const combinedMesh = { vertices: [], normals: [], triangles: [], lines: [], parts: [] };
let triangleCount = 0;
const partManifest = parts.map((part) => {
  const partTriangles = appendPartMesh(
    combinedMesh,
    part,
    featureHistory.filter((feature) => feature.partId === part.id)
  );
  triangleCount += partTriangles;
  return {
    id: part.id,
    name: part.name,
    material: part.material,
    color: part.color,
    featureCount: part.featureCount,
    volumeMm3: round(part.volumeMm3),
    bounds: roundedBounds(part.shape),
    faceCount: part.shape.faces.length,
    edgeCount: part.shape.edges.length,
    triangleCount: partTriangles,
  };
});
const partsHash = sha256(JSON.stringify(partManifest));
if (!Number.isInteger(triangleCount) || triangleCount <= 0 || triangleCount > 1_000_000) {
  throw new Error(`Text2CAD 网格三角面数量异常:${triangleCount}`);
}

const stepBlob = exportSTEP(
  parts.map((part) => ({ shape: part.shape, name: part.name, color: part.color })),
  { unit: "MM", modelUnit: "MM" }
);
const step = Buffer.from(await stepBlob.arrayBuffer());
const stl = Buffer.from(await (await combinedShape.blobSTL({ tolerance: 0.15, angularTolerance: 0.25, binary: true })).arrayBuffer());
const dxfProjection = buildTopProjectionDxf(parts.map((part, index) => ({
  layer: `PART_${String(index + 1).padStart(3, "0")}`,
  edges: part.shape.meshEdges({ tolerance: 0.15, angularTolerance: 0.25 }),
})));
const dxf = dxfProjection.file;
if (step.length < 128 || stl.length < 84 || step.length > 100 * 1024 * 1024 || stl.length > 100 * 1024 * 1024) {
  throw new Error("Text2CAD 导出文件大小异常");
}

const volumeMm3 = parts.reduce((sum, part) => sum + part.volumeMm3, 0);
const manifestBase = {
  manifestVersion: 2,
  libraryVersion: 2,
  schemaVersion: 2,
  hash: designHash,
  template: "text2cad",
  engine: "replicad-opencascadejs",
  engineVersion: "1.0.0",
  kernel: "Open CASCADE/WASM",
  unit: "mm",
  process: spec.process,
  artifactMode: parts.length === 1 ? "single_part" : "assembly",
  partCount: parts.length,
  parts: partManifest,
  partsHash,
  featureHistory,
  validation: {
    brepValid: true,
    solidCount: combinedSolidCount,
    volumePositive: true,
    filesPresent: true,
    partsSingleSolid: true,
    interferenceFree: true,
  },
  bounds: roundedBounds(combinedShape),
  volumeMm3: round(volumeMm3),
  faceCount: parts.reduce((sum, part) => sum + part.shape.faces.length, 0),
  edgeCount: parts.reduce((sum, part) => sum + part.shape.edges.length, 0),
  triangleCount,
  dxfProjection: dxfProjection.contract,
  renderMs: Date.now() - startedAt,
  files: {
    step: { name: "model.step", bytes: step.length, sha256: sha256(step) },
    stl: { name: "model.stl", bytes: stl.length, sha256: sha256(stl) },
    dxf: { name: "top-view.dxf", bytes: dxf.length, sha256: sha256(dxf) },
    mesh: { name: "mesh.json" },
    spec: { name: "design-spec.json", bytes: Buffer.byteLength(raw), sha256: designHash },
  },
};
const meshFile = Buffer.from(JSON.stringify({ ...combinedMesh, manifest: manifestBase }));
if (meshFile.length > 80 * 1024 * 1024) throw new Error("Text2CAD 语义网格文件超过 80MB");
const manifest = {
  ...manifestBase,
  files: {
    ...manifestBase.files,
    mesh: { name: "mesh.json", bytes: meshFile.length, sha256: sha256(meshFile) },
  },
};

await Promise.all([
  writeFile(path.join(safeOutputDir, "model.step"), step, { flag: "wx" }),
  writeFile(path.join(safeOutputDir, "model.stl"), stl, { flag: "wx" }),
  writeFile(path.join(safeOutputDir, "top-view.dxf"), dxf, { flag: "wx" }),
  writeFile(path.join(safeOutputDir, "design-spec.json"), raw, { flag: "wx" }),
  writeFile(path.join(safeOutputDir, "mesh.json"), meshFile, { flag: "wx" }),
  writeFile(path.join(safeOutputDir, "manifest.json"), JSON.stringify(manifest), { flag: "wx" }),
]);

console.log(JSON.stringify({ ok: true, manifest }));
