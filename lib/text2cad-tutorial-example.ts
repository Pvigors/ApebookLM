import { CAD_TEMPLATE_DEFAULTS } from "./cad-spec";
import {
  normalizeText2CadSpec,
  type Text2CadSpec,
} from "./text2cad-spec";
import type { CadTutorialExampleContext } from "./cad-source-audit-core";

const TUTORIAL_REQUIREMENT_ID = "req_tutorial_example";

/**
 * 当所选来源没有可执行建模目标时，输出一个确定性的教学练习件。
 * 所有尺寸都来自系统教学默认值，绝不把它们伪装成来源约束。
 */
export function createText2CadTutorialExample(
  context: CadTutorialExampleContext = "cad_tutorial"
): Text2CadSpec {
  const defaults = CAD_TEMPLATE_DEFAULTS.plate;
  const length = defaults.length;
  const width = defaults.width;
  const thickness = defaults.thickness;
  const cornerRadius = defaults.corner_radius;
  const holeRadius = defaults.hole_diameter / 2;
  const edgeOffset = defaults.hole_edge_offset;
  const holeX = length / 2 - edgeOffset;
  const holeY = width / 2 - edgeOffset;

  if (defaults.hole_count !== 4) {
    throw new Error("CAD 教学示例要求安装平板默认包含 4 个孔");
  }

  const spec = normalizeText2CadSpec({
    schemaVersion: 2,
    engine: "text2cad",
    unit: "mm",
    name: "教学示例：四孔安装平板",
    requirements: [
      {
        id: TUTORIAL_REQUIREMENT_ID,
        text: "未从所选来源识别出具体建模对象，使用标准四孔安装平板演示基础轮廓、拉伸与孔特征",
        sourceRefs: ["system:design-assumption"],
        acceptance: "形成 1 个连通实体、4 个通孔，并通过几何完整性校验",
      },
    ],
    assumptions: [
      context === "cad_tutorial"
        ? "来源仅包含通用 CAD 操作知识，未提供具体建模对象，本模型为安装平板教学示例"
        : "未从所选来源识别出可执行的 CAD 建模对象与关键尺寸，本模型为系统安装平板教学示例",
      "全部尺寸采用系统教学默认值，不代表任何来源中的设计约束，也不用于制造",
      "材料、工艺与公差均未指定",
    ],
    parts: [
      {
        id: "part_tutorial_plate",
        name: "四孔安装平板",
        material: "unspecified",
        color: "#6D5CE7",
        placement: { translate: [0, 0, 0], rotateDeg: [0, 0, 0] },
        features: [
          {
            id: "feat_tutorial_plate",
            kind: "extrude",
            operation: "new",
            plane: "XY",
            origin: [0, 0, 0],
            profile: {
              outer: {
                kind: "rectangle",
                center: [0, 0],
                width: length,
                height: width,
                cornerRadius,
              },
              holes: [
                { kind: "circle", center: [-holeX, -holeY], radius: holeRadius },
                { kind: "circle", center: [holeX, -holeY], radius: holeRadius },
                { kind: "circle", center: [holeX, holeY], radius: holeRadius },
                { kind: "circle", center: [-holeX, holeY], radius: holeRadius },
              ],
            },
            distance: thickness,
            requirementRefs: [TUTORIAL_REQUIREMENT_ID],
          },
        ],
      },
    ],
  });

  assertText2CadTutorialExample(spec);
  return spec;
}

/** 教学降级的后置门禁：任何几何特征都只能追溯到系统教学假设。 */
export function assertText2CadTutorialExample(spec: Text2CadSpec): void {
  if (!spec.name.startsWith("教学示例：")) {
    throw new Error("CAD 教学示例标题缺少明确标识");
  }
  if (
    !spec.assumptions.some((item) => item.includes("不代表任何来源中的设计约束"))
    || !spec.assumptions.some((item) => item.includes("不用于制造"))
  ) {
    throw new Error("CAD 教学示例必须声明尺寸来源与使用边界");
  }

  const assumptionRequirements = new Set(
    spec.requirements
      .filter((requirement) => (
        requirement.sourceRefs.length === 1
        && requirement.sourceRefs[0] === "system:design-assumption"
      ))
      .map((requirement) => requirement.id)
  );
  if (!assumptionRequirements.size) {
    throw new Error("CAD 教学示例缺少系统教学假设需求");
  }

  for (const part of spec.parts) {
    if (part.material !== "unspecified") {
      throw new Error("CAD 教学示例不得推断来源未提供的材料");
    }
    for (const feature of part.features) {
      if (
        !feature.requirementRefs.length
        || feature.requirementRefs.some((ref) => !assumptionRequirements.has(ref))
      ) {
        throw new Error("CAD 教学示例的每个几何特征都必须只追溯系统教学假设");
      }
    }
  }
}
