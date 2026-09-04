import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  auditCadTutorialSourceDocuments,
  isStructuredCadMissingTargetControl,
  resolveCadMissingTargetTutorialContext,
  tutorialExampleContextForAudit,
} from "../../lib/cad-source-audit-core.ts";
import {
  extractGenericCadObjectLabels,
  isMeaningfulCadDesignInstruction,
} from "../../lib/cad-object-intent.ts";

test("全量来源审计只允许教程占多数且没有具体对象时使用教学示例", () => {
  const result = auditCadTutorialSourceDocuments([
    {
      id: "tutorial",
      title: "AutoCAD 基础入门教程",
      content: "介绍 CAD 界面、工具栏、坐标、图层、标注、拉伸和布尔操作。未提供具体建模对象，也没有尺寸、材料或工艺要求。",
    },
    { id: "maintenance", title: "网站维护中", content: "网站正在维护，请稍后重新访问。" },
  ]);
  assert.deepEqual(result, {
    eligible: true,
    auditedSources: 2,
    tutorialSources: 1,
    reason: "tutorial_only",
  });
});

test("非 CAD 资料只在模型二次确认无建模目标后才可给系统教学示例", () => {
  const unrelated = auditCadTutorialSourceDocuments([{
    id: "paper-format",
    title: "论文写作格式模板参考细节",
    content: "论文由标题页、摘要、目录、正文、参考文献和附录构成，需遵守 APA、MLA 等引用规范。",
  }]);
  assert.equal(unrelated.reason, "not_tutorial_majority");
  assert.equal(tutorialExampleContextForAudit(unrelated), null);
  assert.equal(tutorialExampleContextForAudit(unrelated, true), "no_cad_target");
  assert.equal(resolveCadMissingTargetTutorialContext(
    unrelated,
    { noDesignTarget: true, code: "missing_design_target" },
    true
  ), "no_cad_target");
  assert.equal(resolveCadMissingTargetTutorialContext(
    unrelated,
    { noDesignTarget: true, code: "missing_design_target" },
    false
  ), null, "明确用户目标永不允许降级");

  const concrete = auditCadTutorialSourceDocuments([{
    id: "real-design",
    title: "电子设备外壳设计规格",
    content: "本次需要设计一个电子设备外壳，整体尺寸为 120×80×35mm。",
  }]);
  assert.equal(concrete.reason, "concrete_target");
  assert.equal(tutorialExampleContextForAudit(concrete, true), null, "模型误报无目标也不得降级真实设计");
  assert.equal(resolveCadMissingTargetTutorialContext(
    concrete,
    { noDesignTarget: true, code: "missing_design_target" },
    true
  ), null);

  const empty = auditCadTutorialSourceDocuments([]);
  assert.equal(empty.reason, "empty");
  assert.equal(tutorialExampleContextForAudit(empty, true), null);
  assert.equal(tutorialExampleContextForAudit({
    eligible: false,
    auditedSources: 24,
    tutorialSources: 0,
    reason: "audit_limit",
  }, true), null);

  const tutorial = auditCadTutorialSourceDocuments([{
    id: "tutorial",
    title: "AutoCAD 基础入门教程",
    content: "介绍 CAD 界面、命令、坐标、图层、标注、草图与拉伸操作。",
  }]);
  assert.equal(tutorialExampleContextForAudit(tutorial), "cad_tutorial");
});

test("只有精确结构化 missing_design_target 能触发无目标策略", () => {
  assert.equal(isStructuredCadMissingTargetControl({
    noDesignTarget: true,
    code: "missing_design_target",
  }), true);
  assert.equal(isStructuredCadMissingTargetControl({
    unsupported: true,
    code: "missing_design_target",
  }), true, "兼容已发布的旧结构化控制对象");
  for (const value of [
    { noDesignTarget: "true", code: "missing_design_target" },
    { noDesignTarget: true, code: "capability_limit" },
    { unsupported: true, code: "capability_limit", reason: "没有建模目标" },
    { unsupported: true, reason: "来源没有建模目标" },
    { code: "missing_design_target" },
    null,
    "missing_design_target",
  ]) {
    assert.equal(isStructuredCadMissingTargetControl(value), false, JSON.stringify(value));
    assert.equal(resolveCadMissingTargetTutorialContext({
      eligible: false,
      auditedSources: 1,
      tutorialSources: 0,
      reason: "not_tutorial_majority",
    }, value, true), null, JSON.stringify(value));
  }
});

test("非 CAD 排版与统计尺寸不冒充工程目标", () => {
  const missingTargetControl = { noDesignTarget: true, code: "missing_design_target" };
  const actual = [
    [
      "APA 论文格式要求",
      "论文使用 A4 纸，页面尺寸为 210×297mm，页边距 2.54cm；标题、摘要与参考文献按规范排版。",
    ],
    [
      "论文排版指南",
      "正文图片宽度为 12cm，表格高度为 8cm，图题置于图片下方，参考文献按 APA 规范。",
    ],
    [
      "学术海报写作指南",
      "学术海报宽度 90cm、高度 120cm，栏目间距为 2cm，本文介绍摘要、图表与参考文献排版。",
    ],
    [
      "服装尺码研究论文",
      "研究样本平均身高为 170cm、肩宽 42cm，本文讨论问卷方法、统计结果与研究局限。",
    ],
    [
      "论文写作与排版规范（生产检查）",
      "论文由标题页、摘要、目录、正文、参考文献和附录构成。页面使用 A4 纸，页面尺寸为 210×297mm，页边距为 2.54cm。正文图片宽度为 12cm，表格高度为 8cm。研究样本平均身高为 170cm、肩宽 42cm。本文不包含任何 CAD 建模对象、机械零件、制造尺寸、材料、公差或装配要求。",
    ],
  ].map(([title, content]) => {
    const audit = auditCadTutorialSourceDocuments([{ id: title, title, content }]);
    return {
      title,
      reason: audit.reason,
      context: resolveCadMissingTargetTutorialContext(audit, missingTargetControl, true),
    };
  });
  assert.deepEqual(actual, actual.map(({ title }) => ({
    title,
    reason: "not_tutorial_majority",
    context: "no_cad_target",
  })));
});

test("无 CAD 关键词的真实设计尺寸仍保持 fail closed", () => {
  const missingTargetControl = { noDesignTarget: true, code: "missing_design_target" };
  for (const [title, content] of [
    [
      "电子设备外壳设计规格",
      "本次需要设计一个电子设备外壳，整体尺寸为 120×80×35mm，四角预留安装孔。",
    ],
    [
      "泵体制造任务书",
      "客户要求制作一个泵体，外形尺寸 160×110×85mm，用于机加工制造。",
    ],
    [
      "异形夹持块工程图纸",
      "待加工异形夹持块长 90mm、宽 40mm、高 25mm，孔径 8mm。",
    ],
    [
      "安装支架项目需求",
      "建模目标为安装支架，底板长度 140mm、宽度 70mm、厚度 6mm，验收要求孔位准确。",
    ],
    [
      "现场尺寸记录",
      "垫片长度 42mm、宽度 18mm、厚度 2mm。",
    ],
    [
      "库存尺寸记录",
      "金属片长度 120mm、宽度 60mm、厚度 1.5mm。",
    ],
    [
      "家具尺寸清单",
      "桌板长度 1400mm、宽度 700mm、厚度 25mm。",
    ],
    [
      "现场测量记录",
      "导向块长度 80mm、宽度 40mm、厚度 20mm。",
    ],
    [
      "论文附录尺寸记录",
      "论文附录记录实验装置中的导向块长度 80mm、宽度 40mm、厚度 20mm。",
    ],
    [
      "论文排版与实验附录",
      "论文页面尺寸为 210×297mm，页边距 2.54cm；附录给出待加工导向块长度 80mm、宽度 40mm、厚度 20mm。",
    ],
  ]) {
    const audit = auditCadTutorialSourceDocuments([{ id: title, title, content }]);
    assert.equal(audit.reason, "concrete_target", title);
    assert.equal(
      resolveCadMissingTargetTutorialContext(audit, missingTargetControl, true),
      null,
      `${title}：模型误报无目标也不得降级`
    );
  }
});

test("目标埋在长来源尾部仍会阻止教程降级", () => {
  const result = auditCadTutorialSourceDocuments([{
    id: "mixed",
    title: "FreeCAD 操作课程",
    content: `${"界面、坐标、图层、标注、草图与拉伸教程。".repeat(300)}\n本次需要设计一个电子设备外壳，整体尺寸为 120×80×35mm。`,
  }]);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "concrete_target");
});

test("非 CAD 教程与带具体对象的教程都不得自动生成教学板", () => {
  const unrelated = auditCadTutorialSourceDocuments([{
    id: "policy",
    title: "城市治理政策",
    content: "本文讨论公共政策的实施路径和治理结构。",
  }]);
  assert.equal(unrelated.eligible, false);
  assert.equal(unrelated.reason, "not_tutorial_majority");

  const targeted = auditCadTutorialSourceDocuments([{
    id: "plate",
    title: "四孔安装板 CAD 教程",
    content: "按照操作步骤创建安装板并完成孔阵列。",
  }]);
  assert.equal(targeted.eligible, false);
  assert.equal(targeted.reason, "concrete_target");
});

test("教程里的练习尺寸不是用户设计约束，真实六来源形态仍可进入教学示例", () => {
  const result = auditCadTutorialSourceDocuments([
    {
      id: "s1",
      title: "CAD2025基础入门教程 - 八九不离食 - 博客园",
      content: "AutoCAD 入门教程。学习界面、命令、坐标与图层。练习：绘制 100×80 与 100×100 的矩形，再画半径20的圆。",
    },
    {
      id: "s2",
      title: "中望CAD教程 - 从入门到精通完整学习路径 - 中望CAD",
      content: "CAD 入门课程，介绍界面、命令、坐标、图层、标注和快捷键。",
    },
    {
      id: "s3",
      title: "cad基础教程.docx_AutoCAD绘图命令大全资源-CSDN下载",
      content: "AutoCAD 绘图教程，汇总命令、工具栏、坐标、捕捉、正交与图层操作。",
    },
    {
      id: "s4",
      title: "CAD新手入门必备全攻略：从基础到实践-CSDN博客",
      content: "CAD 新手教程。学习命令、界面与操作。示例：输入长度为50；打印线宽可设为0.18mm。",
    },
    {
      id: "s5",
      title: "AutoCAD制图新手自学入门教程 - 免费教学视频 - Autodesk官网 - 欧特克",
      content: "AutoCAD 新手自学视频与官方学习资源。",
    },
    {
      id: "s6",
      title: "网站维护中",
      content: "网站当前维护中，请稍后访问。",
    },
  ]);
  assert.deepEqual(result, {
    eligible: true,
    auditedSources: 6,
    tutorialSources: 4,
    reason: "tutorial_only",
  });
});

test("真实教程叙述不会被抽取成虚假 CAD 对象", () => {
  for (const prose of [
    "想要学习AutoCAD 2025的基础入门知识，我会为你梳理教程。",
    "实操导向：每个知识点都配有具体操作步骤和练习图纸。",
    "CAD使设计师能够在计算机上进行工程图纸和三维模型的设计。",
    "这些工具能够帮助设计师更加精确地完成复杂图形的设计。",
    "接下来，我们将学习如何通过修改和编辑图形命令来进一步完善设计。",
    "想要掌握 AutoCAD 2025 基础知识。",
    "想要系统掌握 CAD 绘图技巧。",
    "想要学习 AutoCAD 的基础知识。",
    "想要了解 CAD 的基本知识。",
    "想要掌握 AutoCAD 的常用技巧。",
    "接下来将学习怎样通过编辑命令来完善模型设计。",
    "想要提升 AutoCAD 绘图能力。",
    "想要提高 CAD 制图效率。",
    "想要成为 CAD 制图高手。",
    "想要掌握工程制图规范。",
    "想要更深入地了解各种绘图工具。",
    "想要获得更好的设计效果。",
    "想要系统学习参数化建模实践。",
    "很多学校或期刊都会提供具体的模板，要求学生严格按照模板撰写标题页。",
    "学校要求作者按规范提交论文和参考文献。",
    "系统要求用户填写摘要后再提交。",
    "期刊要求申请人提供完整的引用信息。",
    "要素包括标题和摘要。",
    "要点如下。",
    "需要学生严格按照模板撰写标题页。",
    "需要作者按规范提交论文。",
    "需要用户填写摘要。",
    "想要学生检查引用。",
    "想要作者强调研究局限。",
    "想要用户提供完整信息。",
    "需要注意以下事项。",
    "需要说明具体格式。",
    "需要指出研究局限。",
    "想要强调引用完整性。",
    "需要分析仪器数据。",
    "需要说明牌照要求。",
    "需要分析模块。",
    "需要讨论板块。",
    "需要总结板块。",
    "需要说明模块。",
    "需要评价板块。",
    "要么使用 APA 格式。",
    "要想实现研究目标。",
    "要对结果进行讨论。",
    "要 求 学生提交论文。",
    "导师要\n求学生生成一个泵体模型。",
    "导师要求学生生成一个泵体模型。",
    "导师要求学生：生成一个泵体模型。",
    "系统要求用户，创建一个账户。",
    "导师要求\n学生：绘制一个阀体模型。",
    "系统要求用户创建一个账户。",
  ]) {
    assert.deepEqual(extractGenericCadObjectLabels(prose), [], prose);
  }
  for (const [text, expected] of [
    ["创建一个泵体模型", "泵体"],
    ["阀体设计规格", "阀体"],
    ["请画一个异形夹持块，尺寸 90×40×25mm", "夹持块"],
    ["创建一个用于学习 AutoCAD 操作的泵体模型", "泵体"],
    ["创建一个包含基础入门知识的阀体模型", "阀体"],
    ["创建一个用于检修的盖模型", "盖"],
    ["阀体模型", "阀体"],
    ["异形夹持块部件", "夹持块"],
    ["泵体 CAD 课程", "泵体"],
    ["泵体 CAD 入门教程", "泵体"],
    ["要一个泵体", "泵体"],
    ["需要泵体", "泵体"],
    ["想要阀体", "阀体"],
    ["本次需要安装支架", "安装支架"],
    ["当前任务要导向块", "导向块"],
    ["要一个学生桌", "学生桌"],
    ["需要学生桌", "学生桌"],
    ["要一个说明牌", "说明牌"],
    ["需要分析仪支架", "分析仪支架"],
    ["本次需要用户终端外壳", "用户终端外壳"],
    ["需要检查孔", "检查孔"],
    ["需要阅读器外壳", "阅读器外壳"],
    ["需要说明书支架", "说明书支架"],
    ["需要比较仪底座", "比较仪底座"],
    ["需要分析天平支架", "分析天平支架"],
  ]) {
    assert.ok(extractGenericCadObjectLabels(text).includes(expected), text);
  }
});

test("第三方写作指令不会把后续动作或人员抽成 CAD 对象", () => {
  const prose = [
    "导师要求学生生成一个泵体模型。",
    "系统要求用户创建一个账户。",
    "期刊需要作者说明具体格式。",
    "要 求 学生提交论文和附录。",
    "需要注意以下事项。",
    "想要强调引用完整性。",
    "需要分析仪器数据。",
    "需要说明牌照要求。",
    "需要分析模块。",
    "需要讨论板块。",
    "需要总结板块。",
    "需要说明模块。",
    "需要评价板块。",
    "要素包括标题和摘要。",
    "要点如下。",
    "导师要\n求学生生成一个泵体模型。",
    "导师要求学生：生成一个泵体模型。",
    "系统要求用户，创建一个账户。",
    "导师要求\n学生：绘制一个阀体模型。",
  ];
  for (const content of prose) {
    assert.deepEqual(extractGenericCadObjectLabels(content), [], content);
    const audit = auditCadTutorialSourceDocuments([{
      id: content,
      title: "论文写作规范",
      content,
    }]);
    assert.equal(audit.reason, "not_tutorial_majority", content);
  }
});

test("较早第三方指令不得吞掉后续明确建模目标", () => {
  for (const [prose, expected] of [
    ["学校要求学生提交论文，设计目标：导向块模型。", "导向块"],
    ["学校要求学生提交论文，当前需要导向块。", "导向块"],
    ["学校要求学生提交论文，项目需要夹紧块。", "夹紧块"],
    ["学校要求学生提交论文，任务要定位销。", "定位销"],
    ["学校要求学生提交论文，当前想要限位块。", "限位块"],
  ]) {
    assert.ok(extractGenericCadObjectLabels(prose).includes(expected), prose);
  }

  const tutorial = auditCadTutorialSourceDocuments([{
    id: "reset-after-third-party",
    title: "CAD 入门课程",
    content: "AutoCAD 入门教程，讲解图层和标注，学校要求学生提交论文，本次需要导向块。",
  }]);
  assert.equal(tutorial.eligible, false);
  assert.equal(tutorial.reason, "concrete_target");
});

test("软件品牌和教程练习不是来源设计对象", () => {
  for (const prose of [
    "AutoCAD 入门教程",
    "FreeCAD 课程",
    "来源站点名\nAutoCAD 入门教程",
    "示例：创建一个矩形",
    "练习：绘制一个圆形",
    "本课演示制作一个立方体",
    "操作步骤：画一个圆",
    "示例：创建一个简单矩形",
    "练习：绘制一个二维圆形",
    "本课演示制作一个基础立方体",
    "操作步骤：画一个标准圆",
    "步骤一：创建一个新的图层",
    "练习：建立一个坐标系",
    "操作：生成一个标注样式",
    "创建一个新的CAD文档",
  ]) {
    assert.deepEqual(extractGenericCadObjectLabels(prose), [], prose);
    const result = auditCadTutorialSourceDocuments([{
      id: prose,
      title: "AutoCAD 入门教程",
      content: `学习 CAD 界面、命令、图层和标注。${prose}。`,
    }]);
    assert.equal(result.eligible, true, prose);
    assert.equal(result.reason, "tutorial_only", prose);
  }
});

test("明确动作、项目目标和对象型标题不得降级成四孔板", () => {
  for (const [title, target] of [
    ["AutoCAD 入门教程", "本次需要泵体。"],
    ["AutoCAD 入门教程", "本项目需要泵体模型。"],
    ["AutoCAD 入门教程", "想要阀体。"],
    ["AutoCAD 入门教程", "需要泵体，材料待定。"],
    ["AutoCAD 入门教程", "设计目标是泵体。"],
    ["AutoCAD 入门教程", "建模目标为泵体。"],
    ["AutoCAD 入门教程", "项目需求：泵体。"],
    ["AutoCAD 入门教程", "本次需要一个标准圆。"],
    ["阀体模型", "学习 CAD 界面、图层、标注和拉伸。"],
    ["泵体 CAD 入门教程", "学习 CAD 界面、图层、标注和拉伸。"],
  ]) {
    const result = auditCadTutorialSourceDocuments([{
      id: `${title}-${target}`,
      title,
      content: `学习 CAD 界面、命令、图层和标注。${target}`,
    }]);
    assert.equal(result.eligible, false, `${title} / ${target}`);
    assert.equal(result.reason, "concrete_target", `${title} / ${target}`);
  }
});

test("接近线上全文的六来源不再被教程措辞误拦", () => {
  const result = auditCadTutorialSourceDocuments([
    {
      id: "s1",
      title: "CAD2025基础入门教程 - 八九不离食 - 博客园",
      content: "想要学习AutoCAD 2025的基础入门知识。介绍界面、命令、坐标、图层与标注。实操示例：画一个100×80的矩形。",
    },
    {
      id: "s2",
      title: "中望CAD教程 - 从入门到精通完整学习路径",
      content: "介绍 CAD 界面、命令、快捷键和图层。每个知识点都配有具体操作步骤和练习图纸。",
    },
    {
      id: "s3",
      title: "cad基础教程.docx_AutoCAD绘图命令大全",
      content: "AutoCAD 绘图教程，汇总命令、工具栏、坐标、捕捉、正交与图层操作。",
    },
    {
      id: "s4",
      title: "CAD新手入门必备全攻略：从基础到实践",
      content: "CAD 是辅助设计软件，使设计师能够进行工程图纸和三维模型的设计。学习如何通过修改图形命令进一步完善设计。介绍界面、图层、标注和快捷键。",
    },
    {
      id: "s5",
      title: "AutoCAD制图新手自学入门教程 - Autodesk官网",
      content: "AutoCAD 新手课程，包含绘图命令、坐标、图层、标注和练习。",
    },
    { id: "s6", title: "网站维护中", content: "网站当前维护中，请稍后访问。" },
  ]);
  assert.deepEqual(result, {
    eligible: true,
    auditedSources: 6,
    tutorialSources: 5,
    reason: "tutorial_only",
  });
});

test("空白、无效单字和查看器操作不会假装成建模目标", () => {
  for (const value of ["", " ", "分", "放大", "线框", "测试", "放大。", "放大！", "线框。", "分，", "测试。", "【放大】", "“放大”"]) {
    assert.equal(isMeaningfulCadDesignInstruction(value), false, value);
  }
  for (const value of ["轴", "泵", "阀", "盖", "管", "轮", "壳", "门", "生成 120×80×5mm 四孔安装板", "生成一个电子设备外壳", "微表情为主"]) {
    assert.equal(isMeaningfulCadDesignInstruction(value), true, value);
  }
});

test("教程修饰语不能吞掉后缀中的真实建模对象", () => {
  for (const content of [
    "学习 CAD 界面、图层、草图和拉伸。创建一个用于学习 AutoCAD 操作的泵体模型。",
    "学习 CAD 界面、图层、草图和拉伸。创建一个包含基础入门知识的阀体模型。",
  ]) {
    const result = auditCadTutorialSourceDocuments([{ id: content, title: "AutoCAD 入门教程", content }]);
    assert.equal(result.eligible, false, content);
    assert.equal(result.reason, "concrete_target", content);
  }
});

test("教程来源中的单字物体仍是明确建模目标", () => {
  for (const object of ["轴", "泵", "阀", "盖", "管", "轮", "壳", "门", "板", "块", "梁", "柱", "杆", "套", "圈", "环", "槽", "钩", "筒", "架", "座", "盘", "盒", "箱", "桶", "球"]) {
    const content = `学习 CAD 界面、命令、图层和标注。本次需要创建一个${object}模型。`;
    const result = auditCadTutorialSourceDocuments([{ id: object, title: "AutoCAD 入门教程", content }]);
    assert.equal(result.eligible, false, object);
    assert.equal(result.reason, "concrete_target", object);
  }
});

test("非教程设计资料中的裸尺寸仍会阻止错误降级", () => {
  const result = auditCadTutorialSourceDocuments([
    {
      id: "tutorial",
      title: "AutoCAD 基础教程",
      content: "介绍 CAD 界面、坐标、图层、标注、拉伸与布尔操作。",
    },
    {
      id: "spec",
      title: "零件规格",
      content: "整体尺寸 120×80×35mm，孔径为 4mm，厚度为 3mm。",
    },
  ]);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "concrete_target");
});

test("教程中的未知对象只要带真实项目尺寸也不得误降级", () => {
  for (const [title, content] of [
    ["FreeCAD 入门教程：泵体案例", "本课程介绍界面、草图、拉伸与布尔操作。客户要求制作一个泵体，外形尺寸 120×80×50mm。"],
    ["参数化 CAD 课程", "学习界面、命令、坐标、图层和标注。本次需要设计异形夹持块，整体尺寸 90×40×25mm。"],
  ]) {
    const result = auditCadTutorialSourceDocuments([{ id: title, title, content }]);
    assert.equal(result.eligible, false, title);
    assert.equal(result.reason, "concrete_target", title);
  }
});

test("教程中的分步尺寸与材料工艺示例不会被误判为客户规格", () => {
  for (const [title, content] of [
    ["AutoCAD 基础教程", "学习界面、命令、坐标、图层和标注。步骤一启动矩形命令。步骤二：绘制 100×80 矩形。"],
    ["FreeCAD 材料与工艺教程", "学习界面、草图、拉伸与布尔。示例中材料为 ABS，工艺采用 FDM。"],
    ["FreeCAD 参数教程", "学习界面、草图、拉伸与布尔。示例参数如下。材料为 ABS，工艺采用 FDM。"],
    ["AutoCAD 直线教程", "学习界面、命令、坐标、图层和标注。练习如下。长度为 50。"],
    ["CAD新手入门必备全攻略", "学习 CAD 界面、命令、坐标、图层和标注。调整线型和线宽，例如使用虚线表示边界线。图层过滤器可以根据图层属性进行筛选，如所有线宽为0.18mm的图层。"],
  ]) {
    const result = auditCadTutorialSourceDocuments([{ id: title, title, content }]);
    assert.equal(result.eligible, true, title);
    assert.equal(result.reason, "tutorial_only", title);
  }
});

test("教程背景中的明确用户绘制请求不得被单个绘制词误放", () => {
  const result = auditCadTutorialSourceDocuments([{
    id: "pump",
    title: "FreeCAD 入门教程",
    content: "学习界面、草图、拉伸与布尔操作。请绘制一个泵体，外形尺寸 120×80×50mm。",
  }]);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "concrete_target");
});

test("对象词典之外的建模对象和前句泛化示例都不能误放教学板", () => {
  for (const [title, content] of [
    ["FreeCAD 泵体参数化建模教程", "介绍草图、拉伸、布尔与孔特征，逐步完成泵体模型。"],
    ["FreeCAD 教程", "学习界面、草图、拉伸与布尔。示例演示完成。泵体外形尺寸 120×80×50mm。"],
  ]) {
    const result = auditCadTutorialSourceDocuments([{ id: title, title, content }]);
    assert.equal(result.eligible, false, title);
    assert.equal(result.reason, "concrete_target", title);
  }
});

test("否定前半句不能吞掉同句后半段真实设计要求", () => {
  for (const content of [
    "学习 CAD 界面、草图、拉伸和布尔；未提供材料要求，但本次需要设计泵体，外形尺寸 120×80×50mm。",
    "学习 CAD 命令、坐标、图层和标注；没有现成图纸，本次需要设计阀体，整体尺寸 90×60×40mm。",
    "本文不包含任何现成 CAD 零件、图纸或公差，但本次需要设计导向块，整体尺寸 80×40×20mm。",
  ]) {
    const result = auditCadTutorialSourceDocuments([{ id: content, title: "FreeCAD 入门教程", content }]);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "concrete_target");
  }
});

test("轿车、乘用车白车身和英文 humanoid robot 都属于具体对象", () => {
  for (const content of [
    "学习 CAD 界面、图层、草图和拉伸。项目需求：建立一台轿车数字样机。",
    "学习 CAD 界面、图层、草图和拉伸。design humanoid robot assembly。",
    "学习 CAD 界面、图层、草图和拉伸。建模目标为乘用车白车身。",
    "学习 CAD 界面、图层、草图和拉伸。项目需求是一辆汽 车。",
    "学习 CAD 界面、图层、草图和拉伸。人 形 机 器 人数字样机。",
    "学习 CAD 界面、图层、草图和拉伸。human\noid robot assembly。",
  ]) {
    const result = auditCadTutorialSourceDocuments([{ id: content, title: "AutoCAD 入门教程", content }]);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "concrete_target");
  }
});

test("教程全量审计限制来源数与总字节并顺序读取，超限不得抽样放行", () => {
  const loader = fs.readFileSync(new URL("../../lib/cad-source-audit.ts", import.meta.url), "utf8");
  const generator = fs.readFileSync(new URL("../../lib/text2cad-generator.ts", import.meta.url), "utf8");
  assert.match(loader, /MAX_AUDIT_SOURCES = MAX_CAD_SOURCE_COUNT/);
  assert.match(loader, /MAX_AUDIT_BYTES = MAX_CAD_SOURCE_BYTES/);
  assert.doesNotMatch(loader, /await\s+Promise\.all/);
  assert.match(loader, /for \(const source of ready\)/);
  assert.match(loader, /reason: "audit_limit"/);
  assert.match(generator, /tutorialAudit\.reason === "audit_limit"/);
  assert.match(generator, /请缩小 CAD 取材范围后重试/);
});

test("高级建模和曲面建模是教程技术词，不冒充具体设计对象", () => {
  for (const title of ["AutoCAD 高级建模教程", "FreeCAD 曲面建模教程"]) {
    const result = auditCadTutorialSourceDocuments([{
      id: title,
      title,
      content: "学习 CAD 界面、命令、草图、拉伸、布尔与图层标注操作。",
    }]);
    assert.equal(result.eligible, true, title);
    assert.equal(result.reason, "tutorial_only", title);
  }
});
