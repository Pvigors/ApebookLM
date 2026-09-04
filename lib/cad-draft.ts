import type { CadTemplate } from "./cad-library";

/**
 * 模型草稿兼容层：模型经常把需求 ID 写成 req_1 / 中文 / 大写，严格规格层应
 * 继续 fail closed，但这些“内部名字”不应让一个语义正确的草稿整体失败。
 * 这里仅做确定性重编号并同步参数引用；所有字段、数值和安全校验仍由 cad-spec 执行。
 */
export function normalizeCadDraftRequirementIds(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const draft = { ...(input as Record<string, unknown>) };
  if (!Array.isArray(draft.requirements)) return draft;

  const idMap = new Map<string, string>();
  const requirements = draft.requirements.map((requirement, index) => {
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) return requirement;
    const item = { ...(requirement as Record<string, unknown>) };
    const nextId = `req_r${index + 1}`;
    if (typeof item.id === "string") {
      if (idMap.has(item.id)) throw new Error(`模型草稿需求 ID 重复:${item.id}`);
      idMap.set(item.id, nextId);
    }
    item.id = nextId;
    return item;
  });

  const rawParameters = draft.parameters;
  let parameters = rawParameters;
  if (rawParameters && typeof rawParameters === "object" && !Array.isArray(rawParameters)) {
    parameters = Object.fromEntries(
      Object.entries(rawParameters as Record<string, unknown>).map(([key, raw]) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [key, raw];
        const parameter = { ...(raw as Record<string, unknown>) };
        if (Array.isArray(parameter.requirementRefs)) {
          parameter.requirementRefs = parameter.requirementRefs.map((ref) =>
            typeof ref === "string" ? idMap.get(ref) ?? ref : ref
          );
        }
        return [key, parameter];
      })
    );
  }

  return { ...draft, requirements, parameters };
}

const COUNT_WORDS: Record<number, string[]> = {
  0: ["无", "零", "不打孔", "无需孔", "没有孔"],
  1: ["一", "单个", "一个"],
  2: ["二", "两", "两个"],
  3: ["三", "三个"],
  4: ["四", "四角", "四个"],
  5: ["五", "五个"],
  6: ["六", "六个"],
  7: ["七", "七个"],
  8: ["八", "八个"],
  9: ["九", "九个"],
  10: ["十", "十个"],
};

/** 非默认精密值必须真的出现在用户/来源证据中，不能只存在于模型自写的需求。 */
export function cadValueIsExplicitlyMentioned(
  value: number,
  unit: "mm" | "count",
  evidence: string
): boolean {
  const text = String(evidence || "").normalize("NFKC").toLowerCase();
  const valueText = String(Object.is(value, -0) ? 0 : value);
  const escaped = valueText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|[^\\d.])${escaped}(?![\\d.])`).test(text)) return true;
  if (unit === "count" && Number.isInteger(value)) {
    return (COUNT_WORDS[value] ?? []).some((word) => text.includes(word));
  }
  return false;
}

/** 明确超出七模板模型库的核心对象在规格解析前就拒绝，不能靠默认参数冒充完成。 */
export function unsupportedCadIntentReason(
  instruction: string,
  preferredTemplate?: CadTemplate
): string | null {
  const text = String(instruction || "").normalize("NFKC");
  const supportedObject = /安装板|平板|安装支架|支架|设备外壳|齿轮箱外壳|法兰|轴径转接套|转接套|轴套|人形机器人|机器人|汽车|车辆|humanoid|robot|\bcar\b|vehicle/i.test(text);
  // 支持对象也不能夹带当前内核不能表达的强特征，例如“带 M6 螺纹的安装板”。
  // “齿轮箱外壳”是外壳用途，先替换后再检查真正的齿轮建模需求。
  const featureText = text.replace(/齿轮箱(?:外壳)?/g, "设备外壳");
  const unsupportedFeature = featureText.match(
    /自由曲面|\bBIM\b|建筑(?:模型)?|(?:带有?|包含)[^，。；;\n]{0,10}齿轮|蜗轮|叶轮|螺纹|\bthread(?:ed|s)?\b|PCB|电路板|飞机|船舶|人体|\baircraft\b|\bship\b/i
  );
  if (unsupportedFeature) {
    return `“${unsupportedFeature[0]}”超出当前七模板模型库范围`;
  }
  if (supportedObject) return null;

  const chinese = /(?:生成|设计|建模|创建|制作|做)(?:一个|一套|一组)?[^，。；;\n]{0,14}(装配体|整机|自由曲面|BIM|建筑(?:模型)?|齿轮(?!箱外壳)|蜗轮|叶轮|螺纹|PCB|电路板|飞机|船舶|人体)/i;
  const english = /\b(?:generate|design|model|create)\b[^.\n]{0,24}\b(?:assembly|freeform|bim|building|gear|thread|impeller|pcb|aircraft|ship|human)\b/i;
  const match = text.match(chinese) || text.match(english);
  const assemblyTemplate = preferredTemplate === "humanoid_robot" || preferredTemplate === "concept_car";
  if (match && assemblyTemplate && /^(?:装配体|整机)$/i.test(match[1] || "")) return null;
  if (match && assemblyTemplate && /\bassembly\b/i.test(match[0])) return null;
  return match ? `“${match[1] || match[0]}”超出当前七模板模型库范围` : null;
}
