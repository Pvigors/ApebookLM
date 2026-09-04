import {
  extractText2CadConceptMeasurements,
  normalizeText2CadSpec,
  type Text2CadPart,
  type Text2CadSpec,
} from "./text2cad-spec";

const round = (value: number) => Math.round(value * 1_000) / 1_000;

const conceptBlocked = (instruction: string) => (
  /(?:量产|投产|生产级|工程级|制造级|可制造|制造交付|可加工|下厂|加工图|工程图|动力总成|驱动|四驱|全驱|前驱|后驱|两驱|发动机|轮毂电机|变速箱|线束|内饰|悬架|悬挂|公差配合|公差标注|物料清单|\bBOM\b|有限元|碰撞仿真|运动学|逆运动学|动力学|减速器|自由曲面|有机曲面|\bBIM\b|精确齿形|齿轮传动|精确螺纹|可3D打印投入使用|production[- ]?ready|manufactur(?:able|ing)|machin(?:able|ing)|fabrication|powertrain|all[- ]?wheel drive|\bAWD\b|\bFWD\b|\bRWD\b|engine|drive|wiring|interior|suspension|kinematics|engineering drawing|bill of materials|tolerance)/i
    .test(instruction)
);

const CAR_COMPONENT_INTENT = /(?:刹车盘|制动盘|轮毂|座椅|安装支架|支架|车门|车灯|方向盘|电池包|传动轴|零部件|brake|hub|seat|bracket|door|steering wheel)/i;
const HUMANOID_COMPONENT_INTENT = /(?:手臂|关节|夹爪|末端执行器|齿轮|减速器|支架|外壳|零部件|arm|joint|gripper|actuator|gearbox|bracket|housing)/i;

function isWholeCarIntent(instruction: string): boolean {
  if (CAR_COMPONENT_INTENT.test(instruction)) return false;
  const text = instruction.trim();
  return /(?:概念汽车|整车|汽车整机|汽车模型|车辆模型|整车外形|汽车外形|一辆(?:概念)?(?:汽车|轿车|跑车|SUV)|concept car|full vehicle|vehicle model|car model)/i.test(text)
    || /^(?:汽车|车辆|轿车|跑车|SUV)$/i.test(text);
}

function isWholeHumanoidIntent(instruction: string): boolean {
  if (HUMANOID_COMPONENT_INTENT.test(instruction)) return false;
  const text = instruction.trim();
  return /(?:完整人形机器人|人形机器人(?:整机|模型|外形|概念|装配)|仿人机器人(?:整机|模型|概念|装配)|humanoid robot(?: model| assembly)?|complete humanoid)/i.test(text)
    || /^(?:人形机器人|仿人机器人|humanoid)$/i.test(text);
}

function hasUnsupportedExplicitMeasurements(instruction: string, kind: "car" | "humanoid"): boolean {
  const unit = "(?:毫米|厘米|mm|cm|米|m)";
  const overallKeyword = kind === "car"
    ? "(?:整体长度|总体长度|总长|车长|整体宽度|总体宽度|总宽|车宽|整体深度|总深|整体高度|总体高度|总高|车高)"
    : "(?:整体长度|总体长度|总长|整体宽度|总体宽度|总宽|整体深度|总深|整体高度|总体高度|总高|身高)";
  let rest = instruction
    .replace(new RegExp(`(?:整体尺寸|总体尺寸|外形尺寸)\\s*(?:为|是|=|:|：)?\\s*\\d+(?:\\.\\d+)?\\s*(?:x|X|×|\\*)\\s*\\d+(?:\\.\\d+)?\\s*(?:x|X|×|\\*)\\s*\\d+(?:\\.\\d+)?\\s*${unit}?`, "gi"), " ")
    .replace(new RegExp(`${overallKeyword}\\s*(?:为|是|约|=|:|：)?\\s*\\d+(?:\\.\\d+)?\\s*${unit}?`, "gi"), " ")
    .replace(new RegExp(`\\d+(?:\\.\\d+)?\\s*${unit}?\\s*${overallKeyword}`, "gi"), " ");
  if (kind === "car") {
    rest = rest
      .replace(new RegExp(`轴距\\s*(?:为|是|约|=|:|：)?\\s*\\d+(?:\\.\\d+)?\\s*${unit}?`, "gi"), " ")
      .replace(new RegExp(`\\d+(?:\\.\\d+)?\\s*${unit}?\\s*轴距`, "gi"), " ");
    const wheelCount = rest.match(/(?:^|[^\d.])(\d{1,2})\s*(?:个|只)?\s*(?:车轮|轮子|轮)(?:布局)?/);
    if (wheelCount && Number(wheelCount[1]) !== 4) return true;
    rest = rest.replace(/(?:^|[^\d.])4\s*(?:个|只)?\s*(?:车轮|轮子|轮)(?:布局)?/g, " ");
  }
  return new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:${unit}|度|°|寸|kg|公斤)`, "i").test(rest)
    || /(?:长度?|宽度?|高度?|深度?|直径|半径|间距|间隙|角度|臂长|腿长|轮宽|车轮宽度|车轮直径|离地间隙)\s*(?:为|是|约|=|:|：)?\s*\d+(?:\.\d+)?/i.test(rest);
}

/** 兜底不做自由语义猜测：除唯一整机、支持的尺寸与少量概念布局词外，任何用途/交付描述都禁用兜底。 */
function hasOnlySupportedConceptLanguage(instruction: string, kind: "car" | "humanoid"): boolean {
  const unit = "(?:毫米|厘米|mm|cm|米|m)";
  const overallKeyword = kind === "car"
    ? "(?:整体长度|总体长度|总长|车长|整体宽度|总体宽度|总宽|车宽|整体深度|总深|整体高度|总体高度|总高|车高)"
    : "(?:整体长度|总体长度|总长|整体宽度|总体宽度|总宽|整体深度|总深|整体高度|总体高度|总高|身高)";
  let rest = instruction
    .replace(new RegExp(`(?:整体尺寸|总体尺寸|外形尺寸)\\s*(?:为|是|=|:|：)?\\s*\\d+(?:\\.\\d+)?\\s*(?:x|X|×|\\*)\\s*\\d+(?:\\.\\d+)?\\s*(?:x|X|×|\\*)\\s*\\d+(?:\\.\\d+)?\\s*${unit}?`, "gi"), " ")
    .replace(new RegExp(`${overallKeyword}\\s*(?:为|是|约|=|:|：)?\\s*\\d+(?:\\.\\d+)?\\s*${unit}?`, "gi"), " ")
    .replace(new RegExp(`\\d+(?:\\.\\d+)?\\s*${unit}?\\s*${overallKeyword}`, "gi"), " ");
  if (kind === "car") {
    rest = rest
      .replace(new RegExp(`轴距\\s*(?:为|是|约|=|:|：)?\\s*\\d+(?:\\.\\d+)?\\s*${unit}?`, "gi"), " ")
      .replace(new RegExp(`\\d+(?:\\.\\d+)?\\s*${unit}?\\s*轴距`, "gi"), " ")
      .replace(/(?:四|4)\s*(?:个|只)?\s*(?:车轮|轮子|轮)(?:布局)?/gi, " ")
      .replace(/(?:一辆|一台)?(?:概念)?(?:汽车|车辆|轿车|跑车|SUV)(?:整机|整车|模型|外形|概念|装配)?/gi, " ")
      .replace(/(?:concept car|full vehicle|vehicle model|car model)/gi, " ")
      .replace(/(?:车身)?(?:用|采用|使用)?分段棱面(?:车身|表达|造型)?/g, " ");
  } else {
    rest = rest
      .replace(/(?:完整)?(?:人形机器人|仿人机器人)(?:整机|模型|外形|概念|装配|概念装配)?/g, " ")
      .replace(/(?:humanoid robot(?: model| assembly)?|complete humanoid|humanoid)/gi, " ")
      .replace(/(?:左右对称|头部|躯干|骨盆|双臂|双腿|清晰可辨|清晰)/g, " ");
  }
  rest = rest
    .replace(/(?:生成|创建|设计|做|制作|建立|建模|请|帮我|要求|需要|突出|表达|使用|采用|用|一个|一套|完整|概念|参数化|占位|比例|外形方案|草模|演示|示意|模型|装配|整体|的|为|并|且|和|与|及|and|with|please|create|generate|design|model)/gi, " ")
    .replace(/[\s,，.。；;:：、()（）/\-]+/g, " ");
  return !/[\p{L}\p{N}]/u.test(rest);
}

function requirements(instruction: string) {
  return [
    {
      id: "req_user",
      text: instruction.replace(/\s+/g, " ").trim().slice(0, 500),
      sourceRefs: ["prompt:1"],
      acceptance: "明确尺寸、整体包围盒与部件布局通过受控几何校验",
    },
    {
      id: "req_concept",
      text: "首版为概念参数化占位，不含生产级驱动、线束、悬架或运动学",
      sourceRefs: ["system:design-assumption"],
    },
  ];
}

function carFallback(instruction: string): Text2CadSpec | null {
  const measured = extractText2CadConceptMeasurements(instruction);
  const length = round(measured.lengthMm ?? 4_500);
  const width = round(measured.widthMm ?? 1_800);
  const height = round(measured.heightMm ?? 1_500);
  const wheelbase = round(measured.wheelbaseMm ?? length * 0.62);
  const wheelRadius = round(Math.max(50, Math.min(height * 0.2, width * 0.17, length * 0.075)));
  const wheelWidth = round(Math.max(40, Math.min(width * 0.11, width * 0.18)));
  const bodyHalfWidth = round(width / 2 - wheelWidth);
  const bodyFloor = round(wheelRadius * 2);
  if (
    length <= 0 || width <= 0 || height <= 0 || wheelbase <= 0
    || bodyHalfWidth <= wheelWidth || bodyFloor >= height - 10
    || wheelbase / 2 + wheelRadius > length / 2
  ) return null;

  const shoulderZ = round(bodyFloor + (height - bodyFloor) * 0.28);
  const bodyPoints = [
    [-length / 2, bodyFloor],
    [-length * 0.42, shoulderZ],
    [-length * 0.2, height],
    [length * 0.2, height],
    [length * 0.42, shoulderZ],
    [length / 2, bodyFloor],
  ].map(([x, z]) => [round(x), round(z)] as [number, number]);
  const refs = ["req_user", "req_concept"];
  const parts: Text2CadPart[] = [
    {
      id: "part_body",
      name: "分段棱面车身",
      material: "aluminum",
      color: "#5B6FE8",
      placement: { translate: [0, 0, 0], rotateDeg: [0, 0, 0] },
      features: [{
        id: "feat_body",
        kind: "extrude",
        operation: "new",
        plane: "XZ",
        origin: [0, bodyHalfWidth, 0],
        profile: { outer: { kind: "polygon", points: bodyPoints }, holes: [] },
        distance: round(bodyHalfWidth * 2),
        requirementRefs: refs,
      }],
    },
  ];
  const wheelPositions = [
    ["front_left", "左前轮", wheelbase / 2, -bodyHalfWidth],
    ["front_right", "右前轮", wheelbase / 2, width / 2],
    ["rear_left", "左后轮", -wheelbase / 2, -bodyHalfWidth],
    ["rear_right", "右后轮", -wheelbase / 2, width / 2],
  ] as const;
  for (const [id, name, x, y] of wheelPositions) {
    parts.push({
      id: `part_wheel_${id}`,
      name,
      material: "rubber",
      color: "#30343B",
      placement: { translate: [round(x), 0, 0], rotateDeg: [0, 0, 0] },
      features: [{
        id: `feat_wheel_${id}`,
        kind: "extrude",
        operation: "new",
        plane: "XZ",
        origin: [0, round(y), 0],
        profile: { outer: { kind: "circle", center: [0, wheelRadius], radius: wheelRadius }, holes: [] },
        distance: wheelWidth,
        requirementRefs: ["req_user"],
      }],
    });
  }
  return normalizeText2CadSpec({
    schemaVersion: 2,
    engine: "text2cad",
    unit: "mm",
    name: "Text2CAD 概念汽车",
    requirements: requirements(instruction),
    assumptions: ["用分段棱面车身和四个圆柱车轮表达整车比例，不含生产级悬架、驱动和内饰"],
    parts,
  });
}

function xyRectanglePart(args: {
  id: string;
  name: string;
  center: [number, number];
  width: number;
  depth: number;
  z: number;
  height: number;
  color: string;
  refs?: string[];
}): Text2CadPart {
  return {
    id: args.id,
    name: args.name,
    material: "aluminum",
    color: args.color,
    placement: { translate: [0, 0, 0], rotateDeg: [0, 0, 0] },
    features: [{
      id: `feat_${args.id.replace(/^part_/, "")}`,
      kind: "extrude",
      operation: "new",
      plane: "XY",
      origin: [0, 0, round(args.z)],
      profile: {
        outer: {
          kind: "rectangle",
          center: [round(args.center[0]), round(args.center[1])],
          width: round(args.width),
          height: round(args.depth),
          cornerRadius: 0,
        },
        holes: [],
      },
      distance: round(args.height),
      requirementRefs: args.refs ?? ["req_user"],
    }],
  };
}

function xyCylinderPart(args: {
  id: string;
  name: string;
  center: [number, number];
  radius: number;
  z: number;
  height: number;
  color: string;
}): Text2CadPart {
  return {
    id: args.id,
    name: args.name,
    material: "aluminum",
    color: args.color,
    placement: { translate: [0, 0, 0], rotateDeg: [0, 0, 0] },
    features: [{
      id: `feat_${args.id.replace(/^part_/, "")}`,
      kind: "extrude",
      operation: "new",
      plane: "XY",
      origin: [0, 0, round(args.z)],
      profile: {
        outer: { kind: "circle", center: [round(args.center[0]), round(args.center[1])], radius: round(args.radius) },
        holes: [],
      },
      distance: round(args.height),
      requirementRefs: ["req_user"],
    }],
  };
}

function humanoidFallback(instruction: string): Text2CadSpec | null {
  const measured = extractText2CadConceptMeasurements(instruction);
  const overallWidth = round(measured.lengthMm ?? 600);
  const overallDepth = round(measured.widthMm ?? 300);
  const overallHeight = round(measured.heightMm ?? 1_700);
  const armRadius = round(Math.max(15, Math.min(overallWidth / 12, overallDepth / 6)));
  const torsoWidth = round(overallWidth - armRadius * 4);
  if (torsoWidth <= armRadius * 4 || overallDepth <= armRadius * 2 || overallHeight < 300) return null;
  const headHeight = round(overallHeight * 0.15);
  const torsoHeight = round(overallHeight * 0.3);
  const pelvisHeight = round(overallHeight * 0.1);
  const legHeight = round(overallHeight - headHeight - torsoHeight - pelvisHeight);
  const torsoZ = round(legHeight + pelvisHeight);
  const headZ = round(torsoZ + torsoHeight);
  const headWidth = round(Math.min(torsoWidth * 0.55, overallWidth * 0.36));
  const headDepth = round(overallDepth * 0.72);
  const legRadius = round(Math.max(12, Math.min(torsoWidth * 0.12, overallDepth * 0.16)));
  const legX = round(torsoWidth * 0.22);
  const armX = round(overallWidth / 2 - armRadius);
  const parts: Text2CadPart[] = [
    xyRectanglePart({
      id: "part_torso", name: "躯干", center: [0, 0], width: torsoWidth, depth: overallDepth,
      z: torsoZ, height: torsoHeight, color: "#5B6FE8", refs: ["req_user", "req_concept"],
    }),
    xyRectanglePart({
      id: "part_pelvis", name: "骨盆", center: [0, 0], width: torsoWidth, depth: overallDepth * 0.85,
      z: legHeight, height: pelvisHeight, color: "#7E8AF0",
    }),
    xyRectanglePart({
      id: "part_head", name: "头部", center: [0, 0], width: headWidth, depth: headDepth,
      z: headZ, height: headHeight, color: "#D6DAF9",
    }),
    xyCylinderPart({ id: "part_arm_left", name: "左臂", center: [-armX, 0], radius: armRadius, z: torsoZ, height: torsoHeight, color: "#8792F2" }),
    xyCylinderPart({ id: "part_arm_right", name: "右臂", center: [armX, 0], radius: armRadius, z: torsoZ, height: torsoHeight, color: "#8792F2" }),
    xyCylinderPart({ id: "part_leg_left", name: "左腿", center: [-legX, 0], radius: legRadius, z: 0, height: legHeight, color: "#454F85" }),
    xyCylinderPart({ id: "part_leg_right", name: "右腿", center: [legX, 0], radius: legRadius, z: 0, height: legHeight, color: "#454F85" }),
  ];
  return normalizeText2CadSpec({
    schemaVersion: 2,
    engine: "text2cad",
    unit: "mm",
    name: "Text2CAD 人形机器人",
    requirements: requirements(instruction),
    assumptions: ["用头部、躯干、骨盆、左右臂和左右腿表达可量测人形占位，不含驱动器、减速器、线束和运动学"],
    parts,
  });
}

/** 真模型多轮仍无法收敛时的受控概念装配；仍输出 Text2CAD V2 命令序列。 */
export function createText2CadConceptFallback(instruction: string): Text2CadSpec | null {
  if (conceptBlocked(instruction)) return null;
  if (/(?:不要|排除|不是|非|not|without)\s*(?:概念)?(?:汽车|车辆|整车|人形机器人|仿人机器人|SUV|car|vehicle|humanoid)/i.test(instruction)) {
    return null;
  }
  const mentionsCar = /(?:汽车|车辆|整车|轿车|跑车|SUV|\bcar\b|\bvehicle\b)/i.test(instruction);
  const mentionsHumanoid = /(?:人形机器人|仿人机器人|humanoid)/i.test(instruction);
  if (mentionsCar && mentionsHumanoid) return null;
  const wholeHumanoid = isWholeHumanoidIntent(instruction);
  const wholeCar = isWholeCarIntent(instruction);
  if (wholeHumanoid === wholeCar) return null;
  if (wholeHumanoid) {
    if (/(?:四臂|四手|多臂|无头|双头|多头|三腿|四腿|多腿|轮式|履带式|four[- ]?arm|headless|dual[- ]?head|multi[- ]?leg)/i.test(instruction)) return null;
    return hasUnsupportedExplicitMeasurements(instruction, "humanoid")
      || !hasOnlySupportedConceptLanguage(instruction, "humanoid")
      ? null
      : humanoidFallback(instruction);
  }
  if (wholeCar) {
    if (/(?:双|两|三|五|六|七|八|九|十|[0-35-9]|\d{2,})\s*(?:轮|个车轮|只车轮)/.test(instruction)) return null;
    return hasUnsupportedExplicitMeasurements(instruction, "car")
      || !hasOnlySupportedConceptLanguage(instruction, "car")
      ? null
      : carFallback(instruction);
  }
  return null;
}
