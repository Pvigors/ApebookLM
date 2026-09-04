import { extractGenericCadObjectLabels } from "./cad-object-intent";

export type CadSourceAuditDocument = {
  id: string;
  title: string;
  content: string;
};

export type CadTutorialSourceAudit = {
  eligible: boolean;
  auditedSources: number;
  tutorialSources: number;
  reason: "tutorial_only" | "empty" | "concrete_target" | "not_tutorial_majority" | "audit_limit";
};

export type CadTutorialExampleContext = "cad_tutorial" | "no_cad_target";

/**
 * 教学示例的安全策略：
 * - 纯 CAD 教程可在模型调用前直接降级；
 * - 非 CAD / 泛资料必须先由模型再次确认确实没有建模目标，才允许给系统教学示例；
 * - 空正文、明确设计目标和审计超限永不降级。
 */
export function tutorialExampleContextForAudit(
  audit: CadTutorialSourceAudit,
  modelConfirmedMissingTarget = false
): CadTutorialExampleContext | null {
  if (audit.reason === "tutorial_only" && audit.eligible) return "cad_tutorial";
  if (audit.reason === "not_tutorial_majority" && modelConfirmedMissingTarget) return "no_cad_target";
  return null;
}

/** 只接受精确结构化控制对象，自然语言 reason、字符串 true 或其他失败码都不能触发教学降级。 */
export function isStructuredCadMissingTargetControl(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const control = value as { noDesignTarget?: unknown; unsupported?: unknown; code?: unknown };
  return control.code === "missing_design_target"
    && (control.noDesignTarget === true || control.unsupported === true);
}

/** 模型控制对象 + 最新全量审计的组合决策；明确用户目标时 allow=false 会恒定拒绝降级。 */
export function resolveCadMissingTargetTutorialContext(
  audit: CadTutorialSourceAudit,
  modelControl: unknown,
  allow: boolean
): CadTutorialExampleContext | null {
  if (!allow || !isStructuredCadMissingTargetControl(modelControl)) return null;
  return tutorialExampleContextForAudit(audit, true);
}

const CAD_TOPIC = /(?:CAD|AutoCAD|FreeCAD|SolidWorks|制图|绘图|草图|参数化建模)/i;
const TUTORIAL_CUES = [
  /教程|入门|操作|命令|界面|工具栏|快捷键|学习|课程|章节|练习/i,
  /坐标|图层|标注|捕捉|正交|视图|拉伸|旋转|布尔|阵列/i,
  /新建文档|保存文件|撤销|重做|导出\s*(?:STEP|STL)/i,
  /示例|例题|演示|输入\s*(?:长度|宽度|高度|半径|直径|数值)|打印线宽/i,
];
const EXPLICIT_DIMENSION = /(?:整体尺寸|外形尺寸|长度|宽度|高度|深度|厚度|孔径|直径|半径|轴距|间距|公差)\s*(?:为|是|约|=|:|：)?\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:mm|毫米|cm|厘米|m|米)\b|\d+(?:\.\d+)?\s*[×xX*]\s*\d+(?:\.\d+)?/i;
const SPECIFIC_TARGET = /(?:汽车|轿车|乘用车|白车身|车辆|人形机器人|机器人|humanoid(?:\s*robot)?|robot\s*assembly|automobile|vehicle|concept\s*car|\bcar\b|电子设备外壳|设备外壳|机箱|壳体|安装平板|安装板|底板|安装支架|托架|法兰|轴径转接套|轴套|转接套|齿轮|螺纹|家具|桌子|椅子|建筑模型|房屋|夹具|模具|叶轮|飞机|船舶|PCB|电路板)/i;
const ENGINEERING_CONSTRAINT = /(?:材料|工艺|公差|验收|载荷|强度|安装接口|孔位|部件关系)\s*(?:为|是|采用|要求|=|:|：)\s*[^，。；;\n]{2,40}/i;
const TUTORIAL_SPEC_CONTEXT = /(?:练习|例题|示例|演示|例如|比如|譬如|举例|如所有|步骤|命令\s*(?:输入|参数)|输入\s*(?:长度|宽度|高度|半径|直径|数值)|绘制|画出|打印线宽|可设为|用于(?:演示|练习)|作为(?:示例|练习))/i;
const DESIGN_REQUEST_CONTEXT = /(?:客户要求|项目需求|设计要求|建模目标|本次(?:需要|要求|设计|制作|建模)|实际零件|待加工|用于制造)/i;
const GENERIC_DESIGN_REQUEST = /请\s*(?:绘制|画出|建模|制作|生成|创建|设计)/i;
// 裸尺寸默认仍按可能的 CAD 目标 fail closed；只有能精确绑定到页面/图表
// 排版或统计样本人体指标的每一个尺寸才可窄豁免。建模、制造、工程图或
// 物理特征语境用于强制阻断豁免；明确对象词另由 SPECIFIC_TARGET /
// extractGenericCadObjectLabels 独立 fail closed。
const CAD_ENGINEERING_CONTEXT = /(?:参数化建模|三维建模|3D\s*打印|B-?Rep|STEP|STL|零件|部件|组件|总成|装配|工件|结构件|工程图|图纸|机加工|机械加工|待加工|用于制造|孔径|孔位|壁厚|公差|倒角|圆角|螺纹|槽宽|板厚|轴径|法兰|泵体|阀体|夹持块)/i;
const MEASUREMENT_TOKEN = /\d+(?:\.\d+)?\s*[xX×*]\s*\d+(?:\.\d+)?(?:\s*[xX×*]\s*\d+(?:\.\d+)?)?\s*(?:mm|毫米|cm|厘米|m|米)?|\d+(?:\.\d+)?\s*(?:mm|毫米|cm|厘米|m|米)\b/gi;
const NON_CAD_LAYOUT_SUBJECT = /(?:A[0-6]\s*(?:纸|纸张)?|页面|纸张|页边距|正文图片|图片|图像|插图|图表|表格|学术海报|栏目|版心|页眉|页脚|文本框|字号|行距|段距)/i;
const NON_CAD_LAYOUT_MEASURE = /(?:尺寸|宽度|高度|边距|间距|长度|厚度|宽|高)/i;
const NON_CAD_SAMPLE_SUBJECT = /(?:研究样本|样本|受试者|参与者|被试|调查对象|患者|人群|男性|女性|学生)/i;
const NON_CAD_BODY_MEASURE = /(?:平均|中位数)?\s*(?:身高|体重|肩宽|胸围|腰围|臀围|尺码)/i;
const EXPLICIT_TUTORIAL_DIRECTIVE = /(?:练习|例题|示例|演示|步骤|课堂)/i;
const TUTORIAL_BRIDGE_CONTEXT = /(?:练习|例题|示例|演示|步骤)[^。！？!?\n]{0,16}(?:如下|为|包括|包含|：)$/i;

function stripNegatedClaims(text: string): string {
  const subject = "(?:本文|本资料|本来源|本文件|该文|该资料|该来源|该文件|文章|报告|内容|资料|来源)";
  // “本文不包含任何 CAD 对象、零件、公差或装配要求”是一个带枚举逗号的
  // 完整否定句，不能只删到第一个逗号后又把余下名词当成设计目标。
  // 但只要句中出现转折或真实项目语境，仍交给下面的逗号级删除，保留后半句。
  const exhaustiveNegation = new RegExp(
    `(^|[。！？!?\n；;])\\s*(?:${subject}\\s*)?(?:也\\s*)?(?:不包含任何|不涉及任何|没有任何|无任何)[^。！？!?\\n]{0,240}(?=$|[。！？!?\\n])`,
    "g"
  );
  const withoutExhaustive = text.replace(exhaustiveNegation, (claim, boundary: string) => (
    /(?:但|但是|然而|不过|却|客户要求|项目需求|设计要求|建模目标|本次(?:需要|要求|设计|制作|建模)|待加工|用于制造)/.test(claim)
      ? claim
      : `${boundary} `
  ));
  return withoutExhaustive.replace(
    new RegExp(
      `(^|[，,；;。！？!?\\n])\\s*(?:${subject}\\s*)?(?:也\\s*)?(?:没有|未曾|未提供|未指定|未说明|不包含|不涉及|无任何|并无)[^，,；;。！？!?\\n]{0,140}(?=$|[，,；;。！？!?\\n])`,
      "g"
    ),
    "$1 "
  );
}

/**
 * 仅豁免“测量主体本身明确不是工程零件”的尺寸。其余裸尺寸仍默认
 * fail closed：“论文附录中的导向块 80×40×20mm”不能因为出现“论文”被放行。
 */
function allMeasurementsAreClearlyNonCad(text: string): boolean {
  const matches = [...text.matchAll(MEASUREMENT_TOKEN)];
  if (!matches.length) return false;
  return matches.every((match) => {
    const index = match.index ?? 0;
    const prefix = text.slice(Math.max(0, index - 64), index);
    const clause = prefix.split(/[\n。；;!?！？]/).at(-1) ?? prefix;
    if (NON_CAD_LAYOUT_SUBJECT.test(clause) && NON_CAD_LAYOUT_MEASURE.test(clause)) {
      return true;
    }
    return NON_CAD_SAMPLE_SUBJECT.test(clause) && NON_CAD_BODY_MEASURE.test(clause);
  });
}

function isConcreteDesignTarget(text: string): boolean {
  const positive = stripNegatedClaims(text.normalize("NFKC"));
  const tutorial = isCadTutorial(positive);
  const genericObjectLabels = extractGenericCadObjectLabels(positive);
  const hasCadDesignContext = CAD_TOPIC.test(positive)
    || SPECIFIC_TARGET.test(positive)
    || genericObjectLabels.length > 0
    || DESIGN_REQUEST_CONTEXT.test(positive)
    || GENERIC_DESIGN_REQUEST.test(positive)
    || CAD_ENGINEERING_CONTEXT.test(positive);
  // CAD 教程会用尺寸、材料和工艺讲解命令；这些“练习/示例”不是用户的制造约束。
  // 逐句评估而不是全篇放过：客户/项目语境恒拦，未标为教学步骤的规格也拦。
  for (const pattern of [EXPLICIT_DIMENSION, ENGINEERING_CONSTRAINT]) {
    if (!pattern.test(positive)) continue;
    if (!tutorial) {
      if (hasCadDesignContext) return true;
      if (pattern === EXPLICIT_DIMENSION && allMeasurementsAreClearlyNonCad(positive)) continue;
      return true;
    }
    const segments = positive
      .split(/[。！？!?\n]+/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    const isConcrete = segments.some((segment, index) => {
      if (!pattern.test(segment)) return false;
      const previous = segments[index - 1] ?? "";
      const localContext = TUTORIAL_BRIDGE_CONTEXT.test(previous)
        ? `${previous}。${segment}`
        : segment;
      if (DESIGN_REQUEST_CONTEXT.test(segment)) return true;
      if (GENERIC_DESIGN_REQUEST.test(segment) && !EXPLICIT_TUTORIAL_DIRECTIVE.test(localContext)) return true;
      return !TUTORIAL_SPEC_CONTEXT.test(localContext);
    });
    if (isConcrete) return true;
  }
  if (genericObjectLabels.length) return true;
  // 教学示例的前提是“没有具体对象”；明确对象无论出现在全文何处、是否带动作词，
  // 都应 fail closed，不能靠有限中文词序把轿车/机器人/白车身降级成四孔板。
  const compact = positive.replace(/[\s\u200B-\u200D\uFEFF·•_-]+/g, "");
  return SPECIFIC_TARGET.test(positive) || SPECIFIC_TARGET.test(compact);
}

function isCadTutorial(text: string): boolean {
  if (!CAD_TOPIC.test(text)) return false;
  return TUTORIAL_CUES.filter((pattern) => pattern.test(text)).length >= 2;
}

/**
 * 只在“多数有效来源确为 CAD 教程，且全量正文中没有任何具体设计对象/工程约束”时
 * 允许教学示例。宁可 false negative 让用户补充目标，也不能把真实设计误降级成示例。
 */
export function auditCadTutorialSourceDocuments(
  documents: CadSourceAuditDocument[]
): CadTutorialSourceAudit {
  const audited = documents
    .map((document) => ({
      ...document,
      // 保留 title/content 和原段落边界；如果把换行压成空格，“博客园\nAutoCAD
      // 入门教程”会被跨域拼成“博客园 AutoCAD 教程”并误抽为设计对象。
      text: `${document.title}\n${document.content}`
        .replace(/[^\S\r\n]+/g, " ")
        .replace(/\r\n?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    }))
    .filter((document) => document.text.length >= 10);
  if (!audited.length) {
    return { eligible: false, auditedSources: 0, tutorialSources: 0, reason: "empty" };
  }
  if (audited.some((document) => isConcreteDesignTarget(document.text))) {
    return {
      eligible: false,
      auditedSources: audited.length,
      tutorialSources: audited.filter((document) => isCadTutorial(document.text)).length,
      reason: "concrete_target",
    };
  }
  const tutorialSources = audited.filter((document) => isCadTutorial(document.text)).length;
  const eligible = tutorialSources >= 1 && tutorialSources >= Math.ceil(audited.length / 2);
  return {
    eligible,
    auditedSources: audited.length,
    tutorialSources,
    reason: eligible ? "tutorial_only" : "not_tutorial_majority",
  };
}
