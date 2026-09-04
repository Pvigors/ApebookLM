#!/usr/bin/env node

/**
 * 受控 CAD 几何工人。
 *
 * 只解释 lib/cad-spec.ts 归一化后的受控模板；不加载用户脚本、不执行模型代码，
 * 也不接受网络地址或任意输出文件名。主进程把输入放进 .data/cad-tmp/tmp-*，本工人
 * 只会在同一临时目录写固定文件，随后由 jobs.ts 的 run_attempt 栅栏决定是否发布。
 */

import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import opencascade from "replicad-opencascadejs";
import {
  makeBox,
  makeCompound,
  makeCylinder,
  iterTopo,
  measureVolume,
  setOC,
  sketchCircle,
} from "replicad";

const [inputPath, outputDir, designHash] = process.argv.slice(2);
if (!inputPath || !outputDir || !/^[a-f0-9]{64}$/.test(designHash || "")) {
  throw new Error("用法:cad-worker <spec.json> <output-dir> <sha256>");
}

const cadRoot = path.resolve(process.cwd(), ".data", "cad-tmp");
const safeOutputDir = path.resolve(outputDir);
const safeInputPath = path.resolve(inputPath);
if (!safeOutputDir.startsWith(`${cadRoot}${path.sep}`) || !safeInputPath.startsWith(`${safeOutputDir}${path.sep}`)) {
  throw new Error("CAD 工人拒绝访问受控临时目录以外的路径");
}
const [realCadRoot, realOutputDir, realInputPath, outputInfo, inputInfo] = await Promise.all([
  realpath(cadRoot),
  realpath(safeOutputDir),
  realpath(safeInputPath),
  lstat(safeOutputDir),
  lstat(safeInputPath),
]);
if (
  outputInfo.isSymbolicLink() || inputInfo.isSymbolicLink() || !outputInfo.isDirectory() || !inputInfo.isFile()
  || !realOutputDir.startsWith(`${realCadRoot}${path.sep}`)
  || !realInputPath.startsWith(`${realOutputDir}${path.sep}`)
) {
  throw new Error("CAD 工人拒绝符号链接或越界目录");
}
if ((await stat(realInputPath)).size > 64 * 1024) throw new Error("CAD 规格文件超过 64KB");

const TEMPLATE_CONTRACTS = Object.freeze({
  plate: {
    parameters: ["length", "width", "thickness", "corner_radius", "hole_diameter", "hole_count", "hole_edge_offset"],
    maxDimension: 2_000,
    expectedSolidCount: 1,
    artifactMode: "single_part",
  },
  mounting_bracket: {
    parameters: ["base_length", "base_width", "base_thickness", "upright_height", "upright_thickness", "hole_diameter", "hole_count", "hole_edge_offset", "fillet_radius"],
    maxDimension: 2_000,
    expectedSolidCount: 1,
    artifactMode: "single_part",
  },
  enclosure: {
    parameters: ["outer_length", "outer_width", "outer_height", "wall_thickness", "corner_radius", "lid_clearance", "screw_diameter", "screw_count"],
    maxDimension: 2_000,
    expectedSolidCount: 1,
    artifactMode: "single_part",
  },
  flange: {
    parameters: ["outer_diameter", "thickness", "bore_diameter", "bolt_circle_diameter", "bolt_hole_diameter", "bolt_hole_count"],
    maxDimension: 2_000,
    expectedSolidCount: 1,
    artifactMode: "single_part",
  },
  shaft_adapter: {
    parameters: ["length", "outer_diameter", "bore_diameter_a", "bore_diameter_b", "transition_length", "set_screw_diameter", "set_screw_count"],
    maxDimension: 2_000,
    expectedSolidCount: 1,
    artifactMode: "single_part",
  },
  humanoid_robot: {
    parameters: ["overall_height", "overall_width", "overall_depth", "limb_diameter", "joint_clearance"],
    maxDimension: 3_000,
    expectedSolidCount: 16,
    artifactMode: "assembly",
  },
  concept_car: {
    parameters: ["overall_length", "overall_width", "overall_height", "wheelbase", "wheel_diameter", "wheel_width", "ground_clearance"],
    maxDimension: 12_000,
    expectedSolidCount: 5,
    artifactMode: "assembly",
  },
});

function readNormalizedSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CAD 规格不是对象");
  const allowedTopLevel = new Set([
    "schemaVersion", "unit", "template", "name", "material", "process",
    "requirements", "parameters", "featureGraph",
  ]);
  if (Object.keys(value).some((key) => !allowedTopLevel.has(key))) throw new Error("CAD 规格包含未知顶层字段");
  if (value.schemaVersion !== 1 || value.unit !== "mm" || !TEMPLATE_CONTRACTS[value.template]) {
    throw new Error("CAD 规格版本、单位或模板无效");
  }
  const expected = TEMPLATE_CONTRACTS[value.template].parameters;
  const keys = Object.keys(value.parameters || {}).sort();
  if (keys.join("\0") !== [...expected].sort().join("\0")) throw new Error("CAD 参数集合不完整");
  for (const key of expected) {
    const parameter = value.parameters[key];
    if (!parameter || typeof parameter !== "object" || !Number.isFinite(parameter.value)) {
      throw new Error(`CAD 参数 ${key} 无效`);
    }
    if (Math.abs(parameter.value) > TEMPLATE_CONTRACTS[value.template].maxDimension) {
      throw new Error(`CAD 参数 ${key} 超出模板工人上限`);
    }
  }
  return value;
}

const parameter = (spec, key) => spec.parameters[key].value;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * DXF 不是 STEP 的三维替代品。这里导出经过离散化的 B-Rep 边线在 XY 平面的
 * 顶视投影，单位固定为 mm，使用所有常见 CAD 都能读取的 ASCII LINE 实体。
 * 垂直于投影面的边会退化为点并被丢弃；上下表面的重合边会去重。
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

function rectanglePerimeterPoints(count, xMin, xMax, yMin, yMax) {
  if (count <= 0) return [];
  if (count === 1) return [[(xMin + xMax) / 2, (yMin + yMax) / 2]];
  if (count === 2) return [[xMin, (yMin + yMax) / 2], [xMax, (yMin + yMax) / 2]];
  const width = Math.max(0, xMax - xMin);
  const height = Math.max(0, yMax - yMin);
  const perimeter = 2 * (width + height);
  if (perimeter <= 0) return Array.from({ length: count }, () => [xMin, yMin]);
  return Array.from({ length: count }, (_, index) => {
    let distance = (index / count) * perimeter;
    if (distance <= width) return [xMin + distance, yMin];
    distance -= width;
    if (distance <= height) return [xMax, yMin + distance];
    distance -= height;
    if (distance <= width) return [xMax - distance, yMax];
    distance -= width;
    return [xMin, yMax - distance];
  });
}

function circularPoints(count, radius) {
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    const angle = (index * Math.PI * 2) / count;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
}

function cutVerticalHoles(shape, points, diameter, height, z = -0.1) {
  let result = shape;
  for (const [x, y] of points) {
    result = result.cut(makeCylinder(diameter / 2, height + 0.2, [x, y, z], [0, 0, 1]));
  }
  return result;
}

function filletVerticalEdges(shape, radius) {
  if (radius <= 0) return shape;
  return shape.fillet(radius, (finder) => finder.inDirection([0, 0, 1]));
}

function buildPlate(spec) {
  const length = parameter(spec, "length");
  const width = parameter(spec, "width");
  const thickness = parameter(spec, "thickness");
  const radius = parameter(spec, "corner_radius");
  const edge = parameter(spec, "hole_edge_offset");
  let shape = makeBox([0, 0, 0], [length, width, thickness]);
  shape = filletVerticalEdges(shape, radius);
  const points = rectanglePerimeterPoints(
    parameter(spec, "hole_count"),
    edge,
    length - edge,
    edge,
    width - edge
  );
  return cutVerticalHoles(shape, points, parameter(spec, "hole_diameter"), thickness);
}

function buildMountingBracket(spec) {
  const length = parameter(spec, "base_length");
  const width = parameter(spec, "base_width");
  const baseThickness = parameter(spec, "base_thickness");
  const uprightHeight = parameter(spec, "upright_height");
  const uprightThickness = parameter(spec, "upright_thickness");
  const holeDiameter = parameter(spec, "hole_diameter");
  const holeCount = parameter(spec, "hole_count");
  const edge = parameter(spec, "hole_edge_offset");
  const base = makeBox([0, 0, 0], [length, width, baseThickness]);
  const upright = makeBox([0, 0, 0], [length, uprightThickness, uprightHeight]);
  let shape = base.fuse(upright);

  const bendRadius = parameter(spec, "fillet_radius");
  if (bendRadius > 0) {
    // 用受控四分之一圆柱形成内弯过渡，参数真实影响几何，同时避免对孔边做
    // 全局 fillet（Open CASCADE 对布尔后的混合边容易选不中或失败）。
    const overlap = Math.min(0.2, bendRadius / 4);
    const cylinder = makeCylinder(
      bendRadius,
      length,
      [0, uprightThickness + bendRadius - overlap, baseThickness + bendRadius - overlap],
      [1, 0, 0]
    );
    const quadrant = makeBox(
      [0, uprightThickness - overlap, baseThickness - overlap],
      [length, uprightThickness + bendRadius, baseThickness + bendRadius]
    );
    shape = shape.fuse(cylinder.intersect(quadrant));
  }

  const baseCount = Math.ceil(holeCount / 2);
  const uprightCount = Math.floor(holeCount / 2);
  const basePoints = rectanglePerimeterPoints(baseCount, edge, length - edge, edge, width - edge);
  shape = cutVerticalHoles(shape, basePoints, holeDiameter, baseThickness);

  const uprightPoints = rectanglePerimeterPoints(
    uprightCount,
    edge,
    length - edge,
    edge,
    uprightHeight - edge
  );
  for (const [x, z] of uprightPoints) {
    shape = shape.cut(makeCylinder(holeDiameter / 2, uprightThickness + 0.2, [x, -0.1, z], [0, 1, 0]));
  }

  return shape;
}

function buildEnclosure(spec) {
  const length = parameter(spec, "outer_length");
  const width = parameter(spec, "outer_width");
  const height = parameter(spec, "outer_height");
  const wall = parameter(spec, "wall_thickness");
  const radius = parameter(spec, "corner_radius");
  const clearance = parameter(spec, "lid_clearance");
  const screwDiameter = parameter(spec, "screw_diameter");
  const screwCount = parameter(spec, "screw_count");

  let outer = makeBox([0, 0, 0], [length, width, height]);
  outer = filletVerticalEdges(outer, radius);
  const inset = wall;
  let cavity = makeBox([inset, inset, wall], [length - inset, width - inset, height + 0.2]);
  const innerRadius = Math.max(0, radius - wall);
  cavity = filletVerticalEdges(cavity, innerRadius);
  let shape = outer.cut(cavity);

  // 在开口内侧形成受 lid_clearance 控制的盖板定位台阶，仍保持单一零件。
  const ledgeHeight = Math.max(0.8, Math.min(wall, height / 6));
  const ledgeOuter = makeBox(
    [wall, wall, height - ledgeHeight],
    [length - wall, width - wall, height]
  );
  const ledgeInset = wall + Math.max(0.2, clearance);
  const ledgeInner = makeBox(
    [ledgeInset, ledgeInset, height - ledgeHeight - 0.1],
    [length - ledgeInset, width - ledgeInset, height + 0.1]
  );
  shape = shape.fuse(ledgeOuter.cut(ledgeInner));

  if (screwCount > 0) {
    const postRadius = screwDiameter / 2 + Math.max(1, wall * 0.65);
    const postOffset = wall + postRadius + clearance;
    const postPoints = rectanglePerimeterPoints(
      screwCount,
      postOffset,
      length - postOffset,
      postOffset,
      width - postOffset
    );
    for (const [x, y] of postPoints) {
      const post = makeCylinder(postRadius, height - wall, [x, y, wall]);
      shape = shape.fuse(post);
      shape = shape.cut(makeCylinder(screwDiameter / 2, height + 0.2, [x, y, -0.1]));
    }
  }
  return shape;
}

function buildFlange(spec) {
  const outerDiameter = parameter(spec, "outer_diameter");
  const thickness = parameter(spec, "thickness");
  let shape = makeCylinder(outerDiameter / 2, thickness);
  shape = shape.cut(makeCylinder(parameter(spec, "bore_diameter") / 2, thickness + 0.2, [0, 0, -0.1]));
  const points = circularPoints(
    parameter(spec, "bolt_hole_count"),
    parameter(spec, "bolt_circle_diameter") / 2
  );
  return cutVerticalHoles(shape, points, parameter(spec, "bolt_hole_diameter"), thickness);
}

function buildShaftAdapter(spec) {
  const length = parameter(spec, "length");
  const outerRadius = parameter(spec, "outer_diameter") / 2;
  const boreA = parameter(spec, "bore_diameter_a") / 2;
  const boreB = parameter(spec, "bore_diameter_b") / 2;
  const transition = parameter(spec, "transition_length");
  const straightLength = (length - transition) / 2;
  let shape = makeCylinder(outerRadius, length);
  shape = shape.cut(makeCylinder(boreA, straightLength + 0.1, [0, 0, -0.1]));
  const transitionStart = sketchCircle(boreA, { plane: "XY", origin: straightLength });
  const transitionEnd = sketchCircle(boreB, { plane: "XY", origin: straightLength + transition });
  shape = shape.cut(transitionStart.loftWith(transitionEnd));
  shape = shape.cut(
    makeCylinder(boreB, length - straightLength - transition + 0.1, [0, 0, straightLength + transition])
  );

  const screwCount = parameter(spec, "set_screw_count");
  const screwRadius = parameter(spec, "set_screw_diameter") / 2;
  // 过渡段中部的实际孔半径介于 A/B 端之间。切到较小端半径以内并留
  // 0.5mm overcut，保证紧定螺钉孔真正贯通内孔，不留下不可见隔膜。
  const innerRadius = Math.min(boreA, boreB);
  const radialDepth = outerRadius - innerRadius + 0.5;
  for (let index = 0; index < screwCount; index++) {
    const angle = (index * Math.PI * 2) / Math.max(1, screwCount);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    shape = shape.cut(
      makeCylinder(
        screwRadius,
        radialDepth,
        [dx * (outerRadius + 0.1), dy * (outerRadius + 0.1), length / 2],
        [-dx, -dy, 0]
      )
    );
  }
  return shape;
}

function centeredBox(xCenter, yCenter, zMin, xSize, ySize, zSize) {
  return makeBox(
    [xCenter - xSize / 2, yCenter - ySize / 2, zMin],
    [xCenter + xSize / 2, yCenter + ySize / 2, zMin + zSize]
  );
}

function buildHumanoidRobot(spec) {
  const height = parameter(spec, "overall_height");
  const width = parameter(spec, "overall_width");
  const depth = parameter(spec, "overall_depth");
  const limb = parameter(spec, "limb_diameter");
  const clearance = parameter(spec, "joint_clearance");
  const centerX = width / 2;
  const centerY = depth / 2;

  const headHeight = height * 0.12;
  const neckHeight = height * 0.04;
  const torsoHeight = height * 0.24;
  const pelvisHeight = height * 0.10;
  const footHeight = height * 0.055;
  const legSegmentHeight = (
    height - headHeight - neckHeight - torsoHeight - pelvisHeight - footHeight - 6 * clearance
  ) / 2;

  const footBottom = 0;
  const shinBottom = footHeight + clearance;
  const thighBottom = shinBottom + legSegmentHeight + clearance;
  const pelvisBottom = thighBottom + legSegmentHeight + clearance;
  const torsoBottom = pelvisBottom + pelvisHeight + clearance;
  const neckBottom = torsoBottom + torsoHeight + clearance;
  const headBottom = neckBottom + neckHeight + clearance;

  const leftLegX = centerX - (limb + clearance) / 2;
  const rightLegX = centerX + (limb + clearance) / 2;
  const torsoWidth = width * 0.28;
  const torsoDepth = Math.max(limb, depth * 0.48);
  const pelvisWidth = Math.max(2 * limb + clearance, width * 0.32);
  const pelvisDepth = Math.max(limb, depth * 0.42);
  const neckSize = Math.min(limb * 0.55, torsoWidth * 0.4, depth * 0.35);
  const headWidth = Math.min(torsoWidth * 0.9, Math.max(limb * 1.1, width * 0.18));
  const headDepth = Math.min(depth - 2 * clearance, Math.max(limb * 1.1, depth * 0.45));

  const parts = [
    // 头、颈、躯干、骨盆。
    centeredBox(centerX, centerY, headBottom, headWidth, headDepth, height - headBottom),
    centeredBox(centerX, centerY, neckBottom, neckSize, neckSize, neckHeight),
    centeredBox(centerX, centerY, torsoBottom, torsoWidth, torsoDepth, torsoHeight),
    centeredBox(centerX, centerY, pelvisBottom, pelvisWidth, pelvisDepth, pelvisHeight),
  ];

  const torsoXMin = centerX - torsoWidth / 2;
  const armUsable = torsoXMin - 3 * clearance;
  const handLength = armUsable * 0.20;
  const forearmLength = armUsable * 0.35;
  const armBottom = torsoBottom + (torsoHeight - limb) / 2;
  const leftArmRanges = [
    [0, handLength],
    [handLength + clearance, handLength + clearance + forearmLength],
    [handLength + forearmLength + 2 * clearance, torsoXMin - clearance],
  ];
  for (const [xMin, xMax] of leftArmRanges) {
    parts.push(centeredBox((xMin + xMax) / 2, centerY, armBottom, xMax - xMin, limb, limb));
  }
  for (const [xMin, xMax] of leftArmRanges.toReversed()) {
    const mirroredMin = width - xMax;
    const mirroredMax = width - xMin;
    parts.push(centeredBox((mirroredMin + mirroredMax) / 2, centerY, armBottom, mirroredMax - mirroredMin, limb, limb));
  }

  // 双大腿、双小腿、双脚；左右脚共同定义总深度边界。
  parts.push(
    centeredBox(leftLegX, centerY, thighBottom, limb, limb, legSegmentHeight),
    centeredBox(rightLegX, centerY, thighBottom, limb, limb, legSegmentHeight),
    centeredBox(leftLegX, centerY, shinBottom, limb, limb, legSegmentHeight),
    centeredBox(rightLegX, centerY, shinBottom, limb, limb, legSegmentHeight),
    makeBox([leftLegX - limb / 2, 0, footBottom], [leftLegX + limb / 2, depth, footHeight]),
    makeBox([rightLegX - limb / 2, 0, footBottom], [rightLegX + limb / 2, depth, footHeight])
  );

  return makeCompound(parts);
}

function buildConceptCar(spec) {
  const length = parameter(spec, "overall_length");
  const width = parameter(spec, "overall_width");
  const height = parameter(spec, "overall_height");
  const wheelbase = parameter(spec, "wheelbase");
  const wheelDiameter = parameter(spec, "wheel_diameter");
  const wheelWidth = parameter(spec, "wheel_width");
  const groundClearance = parameter(spec, "ground_clearance");
  const sideGap = Math.max(10, width * 0.01);
  const radius = wheelDiameter / 2;
  const rearX = (length - wheelbase) / 2;
  const frontX = rearX + wheelbase;

  const body = makeBox(
    [0, wheelWidth + sideGap, groundClearance],
    [length, width - wheelWidth - sideGap, height]
  );
  const wheels = [rearX, frontX].flatMap((x) => [
    makeCylinder(radius, wheelWidth, [x, 0, radius], [0, 1, 0]),
    makeCylinder(radius, wheelWidth, [x, width, radius], [0, -1, 0]),
  ]);
  return makeCompound([body, ...wheels]);
}

const BUILDERS = Object.freeze({
  plate: buildPlate,
  mounting_bracket: buildMountingBracket,
  enclosure: buildEnclosure,
  flange: buildFlange,
  shaft_adapter: buildShaftAdapter,
  humanoid_robot: buildHumanoidRobot,
  concept_car: buildConceptCar,
});

const raw = await readFile(realInputPath, "utf8");
if (sha256(raw) !== designHash) throw new Error("CAD 规格 hash 与工人输入不一致");
const spec = readNormalizedSpec(JSON.parse(raw));
const oc = await opencascade({ print: () => {}, printErr: () => {} });
setOC(oc);
const roundMillimeter = (value) => Math.round(value * 1_000) / 1_000;
const preciseBounds = (value) => {
  // shape.boundingBox 会复用 mesh() 产生的离散公差，圆柱和布尔体可被
  // 放大约 0.07mm。这里直接让 OCCT 从 B-Rep 计算精确包围盒，且明确
  // 禁用三角网格与形状容差，与 Text2CAD 工人保持同一语义。
  const box = new oc.Bnd_Box();
  let min;
  let max;
  try {
    oc.BRepBndLib.AddOptimal(value.wrapped, box, false, false);
    if (box.IsVoid() || box.IsOpen()) throw new Error("CAD 精确包围盒为空或无界");
    min = box.CornerMin();
    max = box.CornerMax();
    const bounds = [
      [roundMillimeter(min.X()), roundMillimeter(min.Y()), roundMillimeter(min.Z())],
      [roundMillimeter(max.X()), roundMillimeter(max.Y()), roundMillimeter(max.Z())],
    ];
    if (bounds.flat().some((coordinate) => !Number.isFinite(coordinate))) {
      throw new Error("CAD 精确包围盒包含非有限坐标");
    }
    return bounds;
  } finally {
    min?.delete();
    max?.delete();
    box.delete();
  }
};

const startedAt = Date.now();
const shape = BUILDERS[spec.template](spec).simplify();
if (shape.isNull) throw new Error("CAD 内核生成了空形体");
const solidShapes = [...iterTopo(shape.wrapped, "solid")];
const solidCount = solidShapes.length;
for (const solid of solidShapes) solid.delete();
const templateContract = TEMPLATE_CONTRACTS[spec.template];
if (solidCount !== templateContract.expectedSolidCount) {
  if (templateContract.expectedSolidCount === 1) {
    throw new Error(`CAD 必须是单一连通实体，实际得到 ${solidCount} 个实体`);
  }
  throw new Error(
    `CAD 模板 ${spec.template} 必须包含 ${templateContract.expectedSolidCount} 个实体，实际得到 ${solidCount} 个实体`
  );
}
const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
const brepValid = analyzer.IsValid();
analyzer.delete();
const volumeMm3 = measureVolume(shape);
if (!brepValid || !Number.isFinite(volumeMm3) || volumeMm3 <= 0) {
  throw new Error("CAD 内核几何校验失败");
}

const mesh = shape.mesh({ tolerance: 0.15, angularTolerance: 0.25 });
const edges = shape.meshEdges({ tolerance: 0.15, angularTolerance: 0.25 });
const triangleCount = Math.floor(mesh.triangles.length / 3);
if (triangleCount <= 0 || triangleCount > 500_000) {
  throw new Error(`CAD 网格三角面数量异常:${triangleCount}`);
}

const step = Buffer.from(await (await shape.blobSTEP()).arrayBuffer());
const stl = Buffer.from(await (await shape.blobSTL({ tolerance: 0.15, angularTolerance: 0.25, binary: true })).arrayBuffer());
const dxfProjection = buildTopProjectionDxf([{ layer: "MODEL", edges }]);
const dxf = dxfProjection.file;
if (step.length < 128 || stl.length < 84 || step.length > 100 * 1024 * 1024 || stl.length > 100 * 1024 * 1024) {
  throw new Error("CAD 导出文件大小异常");
}

const measuredBounds = preciseBounds(shape);
const actualSize = measuredBounds[1].map((value, index) => value - measuredBounds[0][index]);
const expectedSize = spec.template === "plate"
  ? [parameter(spec, "length"), parameter(spec, "width"), parameter(spec, "thickness")]
  : spec.template === "mounting_bracket"
    ? [parameter(spec, "base_length"), parameter(spec, "base_width"), parameter(spec, "upright_height")]
    : spec.template === "enclosure"
      ? [parameter(spec, "outer_length"), parameter(spec, "outer_width"), parameter(spec, "outer_height")]
      : spec.template === "flange"
        ? [parameter(spec, "outer_diameter"), parameter(spec, "outer_diameter"), parameter(spec, "thickness")]
        : spec.template === "shaft_adapter"
          ? [parameter(spec, "outer_diameter"), parameter(spec, "outer_diameter"), parameter(spec, "length")]
          : spec.template === "humanoid_robot"
            ? [parameter(spec, "overall_width"), parameter(spec, "overall_depth"), parameter(spec, "overall_height")]
            : [parameter(spec, "overall_length"), parameter(spec, "overall_width"), parameter(spec, "overall_height")];
if (actualSize.some((value, index) => Math.abs(value - expectedSize[index]) > 0.25)) {
  throw new Error(`CAD 实际包围盒超出规格:${actualSize.map((value) => value.toFixed(3)).join("×")}`);
}
if (
  templateContract.artifactMode === "assembly"
  && measuredBounds.some((point, pointIndex) => point.some((value, axis) => (
    Math.abs(value - (pointIndex === 0 ? 0 : expectedSize[axis])) > 0.25
  )))
) {
  throw new Error("CAD 总成包围盒原点或最大边界偏离规格");
}
// 曲面包围盒查询会包含 OCCT 的数值容差；通过真实测量门后，总成清单发布
// 参数合同中的严格边界，避免把内核公差误写成产品尺寸。
const bounds = templateContract.artifactMode === "assembly"
  ? [[0, 0, 0], expectedSize]
  : measuredBounds;
const manifestBase = {
  manifestVersion: 2,
  libraryVersion: 2,
  schemaVersion: 1,
  hash: designHash,
  template: spec.template,
  engine: "replicad-opencascadejs",
  engineVersion: "1.0.0",
  kernel: "Open CASCADE/WASM",
  unit: "mm",
  artifactMode: templateContract.artifactMode,
  partCount: solidCount,
  validation: {
    brepValid,
    solidCount,
    volumePositive: true,
    filesPresent: true,
  },
  bounds,
  volumeMm3: Math.round(volumeMm3 * 1_000) / 1_000,
  faceCount: shape.faces.length,
  edgeCount: shape.edges.length,
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
const meshFile = Buffer.from(JSON.stringify({
  vertices: mesh.vertices,
  normals: mesh.normals,
  triangles: mesh.triangles,
  lines: edges.lines,
  manifest: manifestBase,
}));
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
