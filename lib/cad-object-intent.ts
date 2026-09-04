const GENERIC_LABELS = new Set([
  "三维", "3d", "参数化", "cad", "基础", "简单", "复杂", "实体", "数字",
  "新手", "入门", "通用", "真实", "高级", "曲面", "草图", "装配", "特征", "工程", "机械", "产品",
  "model", "part", "assembly", "component", "advanced", "surface", "sketch", "feature",
  "模型", "零件", "部件", "总成", "组件", "机构", "规格", "要求", "设计",
  "对象", "设计对象", "建模对象", "目标", "主要",
  "教学", "学习", "掌握", "了解", "熟悉", "演示", "示例", "练习", "操作", "绘图", "制图",
]);

// 通用对象正则会扫描来源全文，不只是用户的一句指令。下列措辞都是
// 教程/说明文的叙述主干，不是可建模的物理对象；在正则命中后再做语义质量门，
// 避免把“学习 AutoCAD 知识”、“练习图纸”或“进一步完善设计”当成零件名。
const TUTORIAL_PROSE_LABEL = /(?:知识点|操作步骤|练习图纸|设计师能够|进一步完善|图形命令|基础入门知识|(?:学习|掌握|了解|熟悉)[^,;。，；]{0,32}(?:AutoCAD|CAD|知识|技巧|命令|操作|设计)|(?:AutoCAD|CAD)[^,;。，；]{0,24}(?:知识|技巧|教程|课程|操作))/i;
const NON_PHYSICAL_LABEL_TAIL = /(?:知识|技巧|教程|课程|步骤|命令|图纸|设计|建模|绘图|制图|标注|快捷键|功能|操作|方法|流程|原理|内容|体系|路径|案例|经验)$/i;
const NON_OBJECT_GOAL_PREFIX = /^(?:学习|系统学习|掌握|了解|熟悉|提升|提高|成为|获得|练习|深入|更深入|学会|精通|改善|优化|加强|增强|研究|探索|理解|使用|运用|应用)/i;
const NON_OBJECT_ACTOR_PHRASE = /^(?:学生|作者|用户|申请人|读者|考生|参与者|研究者|投稿人|受试者|被试)(?:应|须|必须|需要|严格|按|按照|填写|提交|撰写|提供|遵守|生成|创建|制作|绘制|设计|建模|说明|指出|强调|检查|核对|阅读|回答|完成|使用|选择|理解|学习|掌握)/i;
const NON_OBJECT_PREDICATE_PHRASE = /^(?:注意|说明|指出|强调|讨论|分析|比较|概括|总结|遵守|按照|填写|提交|提供|确保|符合|满足|实现|达到|检查|核对|引用|阐述|解释|描述|评价|阅读|撰写|回答)/i;
const PHYSICAL_OBJECT_TAIL = /(?:外壳|壳体|机箱|箱体|盒体|支架|托架|底座|工作台|保持架|说明牌|学生桌|学生椅|阅读器|比较仪|分析仪|天平|泵体|阀体|(?:导向|夹紧|限位|定位|压紧|滑动|垫|连接|支撑|夹持|固定|锁紧|安装)块|定位销|安装板|连接板|盖板|桌板|底板|夹板|法兰|轴套|转接套|齿轮|叶轮|(?:检查|安装|定位|通|螺纹|沉头|光)孔)$/i;
const NON_OBJECT_GOAL_TAIL = /(?:能力|效率|高手|规范|工具|效果|实践|水平|帮助|支持|说明|建议)$/i;
const CAD_SOFTWARE_CONSTRUCT = /^(?:新(?:的)?(?:CAD)?文档|CAD文档|文档|文件|新(?:的)?图层|图层|新(?:的)?坐标系|坐标系|标注样式|草图|工作区|视图|布局|样板)$/i;
const BASIC_TUTORIAL_PRIMITIVE = /^(?:矩形|方形|圆|圆形|立方体|直线|线段|圆弧|多边形)$/;
const TUTORIAL_EXAMPLE_CONTEXT = /(?:示例|例题|练习|演示|课堂|步骤|实操|操作|例如|比如|譬如|如下例|下例|本章节|用户可以|可以输入|适用于|命令后|命令中|输入命令)\s*[一二三四五六七八九十\d]*\s*[：:]?/i;
const REAL_DESIGN_CONTEXT = /(?:本次|本项目|当前任务|该项目|项目需求|客户要求|设计目标|建模目标)/i;
const THIRD_PARTY_INSTRUCTION_CONTEXT = /(?:要\s*求|需要|想要)\s*(?:学生|作者|用户|申请人|读者|考生|参与者|研究者|投稿人|受试者|被试)[^。；;!！?？]{0,28}(?:填写|提交|撰写|提供|遵守|生成|创建|制作|绘制|设计|建模|说明|指出|强调|检查|核对|阅读|回答|完成|使用|选择|理解|学习|掌握)/i;
const REAL_DESIGN_RESET_CONTEXT = /(?:客户要求|项目需求|设计目标|建模目标|(?:本次|本项目|当前任务|当前|该项目|项目|任务)\s*(?:要|需要|想要|要求|设计|制作|建模))/i;

function isThirdPartyInstructionContext(text: string, matchIndex: number, matchLength: number): boolean {
  const prefix = text.slice(Math.max(0, matchIndex - 320), matchIndex + matchLength);
  // PDF/OCR 常在“要\n求”中插入单换行；单换行属于词内空白，只有终止
  // 标点或双换行才能结束语义句。
  const clause = (prefix.split(/[。！？!?；;]|\n\s*\n/).at(-1) ?? prefix).replace(/\s+/g, " ");
  const instructionMatches = [...clause.matchAll(new RegExp(THIRD_PARTY_INSTRUCTION_CONTEXT.source, "ig"))];
  const lastInstruction = instructionMatches.at(-1)?.index ?? -1;
  if (lastInstruction < 0) return false;
  const resetMatches = [...clause.matchAll(new RegExp(REAL_DESIGN_RESET_CONTEXT.source, "ig"))];
  const lastReset = resetMatches.at(-1)?.index ?? -1;
  return lastInstruction > lastReset;
}

function isPlausibleCadObjectLabel(label: string, rejectGoalPhrase = false): boolean {
  const value = label.trim();
  if (!value || /(?:的|地|得)$/.test(value)) return false;
  if (TUTORIAL_PROSE_LABEL.test(value)) return false;
  if (NON_PHYSICAL_LABEL_TAIL.test(value)) return false;
  if (CAD_SOFTWARE_CONSTRUCT.test(value)) return false;
  if (/(?:模块|板块)$/.test(value)) return false;
  if (
    rejectGoalPhrase
    && (
      !PHYSICAL_OBJECT_TAIL.test(value)
      && (
        NON_OBJECT_GOAL_PREFIX.test(value)
        || NON_OBJECT_GOAL_TAIL.test(value)
        || NON_OBJECT_ACTOR_PHRASE.test(value)
        || NON_OBJECT_PREDICATE_PHRASE.test(value)
      )
    )
  ) return false;
  return true;
}

function isTutorialPrimitiveExample(text: string, matchIndex: number, matchLength: number, label: string): boolean {
  const primitive = label.replace(
    /^(?:(?:简单|基础|二维|三维|标准|普通|新的|新|一个|一块)+|\d+(?:\.\d+)?(?:mm|cm|毫米|厘米)?)+/i,
    ""
  );
  if (!BASIC_TUTORIAL_PRIMITIVE.test(primitive)) return false;
  const local = text.slice(Math.max(0, matchIndex - 36), Math.min(text.length, matchIndex + matchLength));
  return TUTORIAL_EXAMPLE_CONTEXT.test(local) && !REAL_DESIGN_CONTEXT.test(local);
}

const NON_DESIGN_INSTRUCTION = /^(?:CAD|分|放大|缩小|适应|适配|等轴|前|顶|右|实体|线框|默认|随便|示例|教程|试试|测试|生成|创建|制作|绘制|建模|模型)$/i;

/**
 * 区分真正的用户建模要求和误输入/查看器操作残留。只有前者才能关闭
 * “纯教程来源→明确标注的教学示例”降级路径。
 */
export function isMeaningfulCadDesignInstruction(value: string | undefined): boolean {
  const compact = normalizeCadIntentText(value ?? "").compact
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  if (!compact) return false;
  return !NON_DESIGN_INSTRUCTION.test(compact);
}

export function normalizeCadIntentText(value: string): { normalized: string; compact: string } {
  const normalized = value.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "");
  return { normalized, compact: normalized.replace(/[\s·•_-]+/g, "") };
}

export function canonicalCadObjectLabel(value: string): string {
  const withoutArticle = normalizeCadIntentText(value).normalized.trim().replace(/^(?:a|an|the)\s+/i, "");
  const normalized = normalizeCadIntentText(withoutArticle).compact
    .replace(/^(?:AutoCAD|FreeCAD|SolidWorks|CAD)+/i, "")
    .replace(/^(?:一个|一套|一台|一块|一件|该|此|通用|异形|小型|大型)+/, "")
    .replace(/^(?:(?:(?:本次|本项目|当前|该项目|项目|任务))?(?:需要|想要)|(?:本次|本项目|当前任务|当前|该项目|项目|任务)要)/, "")
    .replace(/^.*(?:完成|创建|绘制|设计|制作|建立|生成|建模)(?:一个|一套|一台|一块|一件|该|此)?/, "")
    .replace(/(?:参数化)?(?:模型|零件|部件|总成|组件|机构|model|part|assembly|component)$/i, "");
  // “用于学习 CAD 操作的泵体”中，真正对象是最后的“泵体”。先收敛
  // 语法修饰语，再执行教程叙述过滤，避免过滤器吞掉明确的物体名。
  const modifierTail = normalized.match(/的([\p{L}\p{N}]{1,24})$/u)?.[1];
  return (modifierTail || normalized).replace(/(?:时|后)$/, "");
}

type CadObjectPattern = { regex: RegExp; allowSingle?: boolean; rejectGoalPhrase?: boolean };

/** 抽取不在七模板闭集里的明确对象标签，如泵体、阀体、异形夹持块。 */
export function extractGenericCadObjectLabels(value: string): string[] {
  const { normalized } = normalizeCadIntentText(value);
  const labels: string[] = [];
  const patterns: CadObjectPattern[] = [
    // 来源标题常直接以“阀体模型 / 异形夹持块部件”命名，没有动词也必须守住对象。
    { regex: /(?:^|[\s：:，,。；;])([\p{L}\p{N}_\-·•]{1,16}?)(?:参数化)?(?:模型|零件|部件|总成|组件|机构)(?=[，,。.；;：:!！?？\s]|$)/giu, allowSingle: true },
    { regex: /(?:^|[\s：:，,。；;])([\p{L}\p{N}_\-·•]{1,16}?)[ \t]+(?:AutoCAD|CAD)[ \t]*(?:入门|建模|参数化)?[ \t]*(?:教程|课程)(?=[，,。.；;：:!！?？\s]|$)/giu, allowSingle: true },
    // 明确创建动作 + 模型/零件等实体后缀，语境足够强，允许单字物体名。
    { regex: /(?:完成|创建|绘制|设计|制作|建立|生成|建模)\s*(?:一个|一套|一台|一块|一件|该|此)?\s*([\p{L}\p{N}_\-\s·•]{1,30}?)(?:参数化)?(?:模型|零件|部件|总成|组件|机构)(?=[，,。.；;：:!！?？\s]|$)/giu, allowSingle: true },
    // “创建一个泵体”本身已是强设计语境，不强制用户再补“模型”后缀。
    { regex: /(?:完成|创建|绘制|设计|制作|建立|生成|建模)\s*(?:一个|一套|一台|一块|一件)\s*([\p{L}\p{N}_\-\s·•]{1,30}?)(?=[，,。.；;：:!！?？]|尺寸|长度|宽度|高度|厚度|材料|工艺|用途|场景|$)/giu, allowSingle: true },
    { regex: /(?:^|[\s：:，,。；;])([\p{L}\p{N}_\-\s·•]{2,30}?)(?:参数化建模教程|建模教程|设计规格|设计要求|设计方案|设计)(?=[，。；;：:!！?？\s]|$)/giu },
    // 请画/做…是强目标语境；不把宽泛的“想要提升 CAD 能力”纳入这条。
    { regex: /(?:^|[\s，,。；;：:!！?？])(?:帮我(?:做|画)|请(?:做|画)|做|画)\s*(?:一个|个|一套|套|一台|台|一块|块|一件|件)?\s*([\p{L}\p{N}_\-\s·•]{1,24}?)(?=[，,。.；;：:!！?？]|尺寸|长度|宽度|高度|厚度|$)/giu, allowSingle: true },
    // 裸“要”只在紧跟量词时开放；无量词时必须是“需要/想要”或
    // “本次/项目/任务要”，避免把“要求、要素、要点”从首字拆成建模谓语。
    { regex: /(?:^|[\s，,。；;：:!！?？])(?:(?:本次|本项目|当前|该项目|项目|任务)\s*)?(?:需要|想要|要)\s*(?:一个|个|一套|套|一台|台|一块|块|一件|件)\s*([\p{L}\p{N}_\-\s·•]{1,24}?)(?=[，,。.；;：:!！?？]|尺寸|长度|宽度|高度|厚度|$)/giu, allowSingle: true },
    { regex: /(?:^|[\s，,。；;：:!！?？])(?:(?:(?:本次|本项目|当前|该项目|项目|任务)\s*)?(?:需要|想要)|(?:本次|本项目|当前任务|当前|该项目|项目|任务)\s*要)\s*([\p{L}\p{N}_\-\s·•]{1,24}?)(?=\s*(?:，|,)?\s*(?:尺寸|长度|宽度|高度|厚度))/giu, allowSingle: true, rejectGoalPhrase: true },
    { regex: /(?:^|[\s，,。；;：:!！?？])(?:(?:(?:本次|本项目|当前|该项目|项目|任务)\s*)?(?:需要|想要)|(?:本次|本项目|当前任务|当前|该项目|项目|任务)\s*要)\s*([\p{L}\p{N}_\-\s·•]{1,24}?)(?:参数化)?(?:模型|零件|部件|总成|组件|机构)(?=[，,。.；;：:!！?？\s]|$)/giu, allowSingle: true, rejectGoalPhrase: true },
    // 无量词、无尺寸的“需要/想要泵体”仍可以是真目标，但必须经过
    // 施事者和抽象谓语质量门；裸“要泵体”建议改为“要一个泵体”。
    { regex: /(?:^|[\s，,。；;：:!！?？])(?:(?:(?:本次|本项目|当前|该项目|项目|任务)\s*)?(?:需要|想要)|(?:本次|本项目|当前任务|当前|该项目|项目|任务)\s*要)\s*([\p{L}\p{N}_\-\s·•]{1,24}?)(?=[，,。.；;：:!！?？]|材料|工艺|用途|场景|$)/giu, allowSingle: true, rejectGoalPhrase: true },
    { regex: /(?:设计目标|建模目标|项目需求)\s*(?:是|为|=|：|:)?\s*([\p{L}\p{N}_\-\s·•]{1,24}?)(?:参数化)?(?:模型|零件|部件|总成|组件|机构)?(?=[，,。.；;：:!！?？]|材料|工艺|用途|场景|$)/giu, allowSingle: true, rejectGoalPhrase: true },
    { regex: /(?:^|[\s：:，,。；;])([\p{L}\p{N}_\-\s·•]{2,30}?)(?:规格书|技术要求|图纸|参数表|工程规格|设计任务书)(?=[，,。；;：:!！?？\s]|$)/giu },
    { regex: /(?:create|generate|design|build)\s+(?:an?\s+|the\s+)?([a-z][a-z0-9_\-\s]{1,32}?)(?:\s+(?:model|part|assembly|component))(?=[,.;:!?\s]|$)/giu },
    { regex: /(?:^|[\s:;,])([a-z][a-z0-9_\-\s]{1,32}?)(?:\s+(?:design\s+spec|design\s+requirements?|modeling\s+tutorial))(?=[,.;:!?\s]|$)/giu },
  ];
  for (const { regex, allowSingle = false, rejectGoalPhrase = false } of patterns) {
    for (const match of normalized.matchAll(regex)) {
      if (isThirdPartyInstructionContext(normalized, match.index ?? 0, match[0].length)) continue;
      const label = canonicalCadObjectLabel(match[1]);
      if (isTutorialPrimitiveExample(normalized, match.index ?? 0, match[0].length, label)) continue;
      if (
        label.length >= (allowSingle ? 1 : 2)
        && !GENERIC_LABELS.has(label.toLowerCase())
        && isPlausibleCadObjectLabel(label, rejectGoalPhrase)
      ) labels.push(label);
    }
  }
  return [...new Set(labels)];
}
