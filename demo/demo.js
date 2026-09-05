"use strict";

(() => {
  const translations = {
    zh: {
      title: "ApebookLM · 示例导览",
      skip: "跳到示例导览",
      brandSubtitle: "猿笔记 · 开源研究工作台",
      repo: "GitHub 仓库",
      demoLabel: "示例导览",
      sourceLabel: "来自真实产品界面",
      headlineFirst: "把资料放在一起，",
      headlineSecond: "让答案有迹可循。",
      intro: "从中文资料出发，选择来源、核对引用、留下笔记。跟着五个界面，看看 ApebookLM 如何串起这条工作流。",
      notice: "使用示例数据，本页不处理文件、不调用模型。",
      windowTitle: "ApebookLM / 示例工作台",
      staticLabel: "界面截图",
      citationLabel: "引用问答 · 产品帮助示例",
      citationHeadline: "一个结论，一段可回看的原文。",
      citationOutro: "在实际应用中，点击引用编号即可定位来源并核对对应文本。此处展示的是静态截图。",
      imageNote: "截图内的按钮仅作展示。",
      viewImage: "查看原图",
      newTab: "（新标签页）",
      nav0: "工作台", nav1: "添加来源", nav2: "核对引用", nav3: "模型 API", nav4: "CAD 辅助",
      stepKicker: "一起走一遍",
      previous: "上一步",
      next: "下一步",
      restart: "重新浏览",
      keyboardHint: "在导览中也可用方向键切换",
      nextKicker: "从了解，到亲手使用",
      nextTitle: "在自己的环境里，继续探索。",
      nextDescription: "社区版提供源码与 Docker 自托管。实际使用需要配置数据库、模型服务和管理员登录；模型等外部服务可能产生费用。",
      download: "下载 v0.1.0 源码",
      guide: "阅读自托管指南",
      boundaryLabel: "关于数据",
      boundary: "这份静态导览不接收资料。实际部署中，选用的模型、搜索等外部服务可能接收完成请求所需的内容；自托管不自动等于完全离线。",
      independent: "独立开源项目，与 Google / NotebookLM 无隶属或合作关系。",
      feedback: "反馈使用问题 ↗",
      tourLabel: "产品示例导览",
      navLabel: "选择导览步骤",
      stepLabel: (index, title) => `第 ${index + 1} 步，共 5 步：${title}`,
    },
    en: {
      title: "ApebookLM · Guided preview",
      skip: "Skip to the guided preview",
      brandSubtitle: "Open-source research workspace",
      repo: "GitHub",
      demoLabel: "Guided preview",
      sourceLabel: "Actual product screenshots",
      headlineFirst: "Bring your sources together.",
      headlineSecond: "Follow the evidence.",
      intro: "Collect Chinese source material, check citations, and keep what you learn. Explore the workflow through five screens. The product UI is currently Simplified Chinese.",
      notice: "Sample data only. This page does not process files or call models.",
      windowTitle: "ApebookLM / Sample workspace",
      staticLabel: "Screenshot",
      citationLabel: "Source citations · Product help example",
      citationHeadline: "A claim you can trace back to its source.",
      citationOutro: "In the actual app, a citation number opens the source so you can inspect the passage. This preview is a static screenshot.",
      imageNote: "Controls inside screenshots are for illustration.",
      viewImage: "Full image",
      newTab: " (new tab)",
      nav0: "Workspace", nav1: "Sources", nav2: "Citations", nav3: "Model API", nav4: "CAD tools",
      stepKicker: "Explore the workflow",
      previous: "Previous",
      next: "Next",
      restart: "Start again",
      keyboardHint: "Arrow keys also work inside the preview",
      nextKicker: "Ready to try it yourself?",
      nextTitle: "Continue in your own environment.",
      nextDescription: "The community edition provides source code and Docker self-hosting. Set up a database, model service, and administrator login to use it. External services may charge for their use.",
      download: "Download v0.1.0 source",
      guide: "Read the setup guide",
      boundaryLabel: "About your data",
      boundary: "This static preview does not accept documents. In a deployed instance, selected external model, search, and other services may receive content needed for a request. Self-hosting does not automatically make every operation offline.",
      independent: "Independent open-source project. No affiliation with Google or NotebookLM.",
      feedback: "Share workflow feedback ↗",
      tourLabel: "Product guided preview",
      navLabel: "Choose a preview step",
      stepLabel: (index, title) => `Step ${index + 1} of 5: ${title}`,
    },
  };

  const steps = [
    {
      image: "../docs/images/workspace.png", width: 1440, height: 900,
      zh: {
        title: "从一张工作台开始",
        description: "资料、对话、笔记各在其位。从选择证据到留下成果，在一个笔记本里完成。",
        points: ["左侧：汇集资料，并勾选本次使用的来源。", "中间：围绕已选内容提问，继续追问。", "右侧：保存笔记，管理报告、导图等内容。"],
        note: "笔记本默认私有。对外分享前，请确认资料的再分发权限。",
        alt: "ApebookLM 三栏工作台：左侧选择来源，中间问答，右侧管理笔记和生成内容。",
      },
      en: {
        title: "One workspace, a connected workflow",
        description: "Keep sources, conversations, and notes together. Move from choosing the evidence to keeping the result within one notebook.",
        points: ["Left: collect material and select the sources to use.", "Center: ask questions about the selected content.", "Right: keep notes and manage reports, mind maps, and other outputs."],
        note: "Notebooks are private by default. Check redistribution rights before sharing source material publicly.",
        alt: "ApebookLM's three-column Chinese interface: source selection on the left, conversation in the center, and notes and generated outputs on the right.",
      },
    },
    {
      image: "../docs/images/add-sources.png", width: 1440, height: 900,
      zh: {
        title: "把分散的资料，放到一起",
        description: "从你已经在读的材料开始。文档、网页和笔记，通过同一个入口进入笔记本。",
        points: ["导入 PDF、DOCX、PPTX、EPUB、图片、音频与文本。", "加入网页、公众号、Bilibili / YouTube 链接。", "粘贴一段文字，或导入 Obsidian ZIP。"],
        note: "链接提取受原站访问权限和字幕情况影响；当前不支持上传本地 MP4 等视频作为来源。",
        alt: "添加来源窗口，展示本地文件、链接、粘贴文本和 Obsidian ZIP 等入口。此处没有可操作的上传区域。",
      },
      en: {
        title: "Collect the material you already use",
        description: "Start with the documents, pages, and notes you already read. Bring them into the same notebook.",
        points: ["Import PDFs, DOCX, PPTX, EPUB, images, audio, and text.", "Add web pages, WeChat articles, and Bilibili/YouTube links.", "Paste text or import an Obsidian vault ZIP."],
        note: "Link extraction depends on site access and available subtitles. Local video files such as MP4 are not supported source uploads.",
        alt: "The source-import dialog with file, link, pasted-text, and Obsidian ZIP options. This is a screenshot, not an upload area.",
      },
    },
    {
      image: "../public/help/chat-citation.png", width: 460, height: 126,
      zh: {
        title: "答案之外，看看它的依据",
        description: "引用让核对更直接。回到原文，判断一段回答有没有超出证据。",
        points: ["回答中的编号关联相应来源片段。", "在实际应用中，可定位并高亮引用原文。", "确认有用的内容后，可以继续保存为笔记。"],
        note: "有引用不代表回答一定正确。资料解析与模型判断仍需要人工核对。",
        alt: "引用帮助示例：一段关于异步沟通的回答带有 1、2、3 三个引用编号，下方有保存为笔记等操作；编号和按钮在本页不可操作。",
      },
      en: {
        title: "See the evidence behind an answer",
        description: "A citation makes checking easier. Return to the original text to judge whether a claim goes beyond the evidence.",
        points: ["Citation numbers connect an answer to source passages.", "In the actual app, open and highlight the referenced text.", "Save useful content as a note after checking it."],
        note: "A citation is not a correctness guarantee. Source extraction and model reasoning still need your review.",
        alt: "A Chinese product-help example shows a paragraph about asynchronous communication with citation numbers 1, 2, and 3 and a save-to-notes action. The screenshot controls are not interactive.",
      },
    },
    {
      image: "../docs/images/model-api-settings.png", width: 1440, height: 900,
      zh: {
        title: "选择自己的模型 API",
        description: "部署者统一配置平台模型。个人也可以在适用范围内连接自己的供应商与 Key。",
        points: ["内置通义千问、OpenAI、DeepSeek 等供应商目录。", "按支持情况选择对话、视觉与研究模型。", "个人 Key 在服务端加密，连接测试通过后启用。"],
        note: "个人 Key 用于本人拥有、未公开且无协作者的笔记本及主动研究。共享、公开、自动解析和系统任务仍走平台模型。",
        alt: "个人模型 API 设置截图：展示供应商目录和模型选择。Key 输入框为空，导览页面不收集或保存任何 Key。",
      },
      en: {
        title: "Choose your model API",
        description: "The deployer configures the instance's models. Users can also connect a personal provider key within the supported scope.",
        points: ["A built-in catalog includes Qwen, OpenAI, DeepSeek, and others.", "Choose supported models for chat, vision, and research.", "Personal keys are encrypted on the server and tested before activation."],
        note: "Personal BYOK applies to your own private notebooks without collaborators and to explicitly initiated research. Shared/public notebooks, automatic parsing, and system tasks use the instance's models.",
        alt: "Personal model API settings with a provider catalog and model choices. The key field is empty. This preview does not accept or store API keys.",
      },
    },
    {
      image: "../docs/images/cad-viewer.png", width: 1440, height: 900,
      zh: {
        title: "再多一步：CAD 设计辅助",
        description: "当对象、尺寸和约束足够明确，可以把支持的设计要求转成受控几何。",
        points: ["在来源驱动、提示词和固定模板之间选择。", "在实际应用中旋转预览几何，查看部件。", "下载 STEP、STL 与二维 DXF 顶视边线。"],
        note: "用于教学与设计辅助，不是制造认证。DXF 不含尺寸标注、公差或图框；复杂装配、仿真等不在当前范围内。",
        alt: "CAD 查看器截图：显示受控几何预览、部件信息，以及 STEP、STL、二维 DXF 下载入口。本导览不生成或提供 CAD 文件。",
      },
      en: {
        title: "An extra tool for constrained CAD",
        description: "With a clear object, dimensions, and constraints, supported design requirements can become controlled geometry.",
        points: ["Choose selected sources, a prompt, or a fixed template.", "In the actual app, rotate the preview and inspect parts.", "Export STEP, STL, and 2D DXF top-view edges."],
        note: "For design and teaching, not manufacturing certification. DXF has no dimensions, tolerances, or title block. Complex assemblies and simulation are outside the current scope.",
        alt: "The CAD viewer displays controlled geometry, part details, and STEP, STL, and 2D DXF download options. This preview does not generate or serve CAD files.",
      },
    },
  ];

  let language = "zh";
  let currentStep = 0;
  const byId = (id) => document.getElementById(id);
  const tour = byId("tour");
  const stage = byId("screen-stage");
  const screenImage = byId("screen-image");
  const stepButtons = [...document.querySelectorAll("[data-step]")];
  const languageButtons = [...document.querySelectorAll("[data-language]")];
  const previousButton = byId("previous-step");
  const nextButton = byId("next-step");
  const citationElements = [...stage.querySelectorAll(".citation-intro, .citation-outro")];

  function renderStep(announce = true) {
    const step = steps[currentStep];
    const copy = step[language];
    const words = translations[language];
    const citation = currentStep === 2;

    stage.classList.toggle("is-citation", citation);
    citationElements.forEach((element) => { element.hidden = !citation; });
    if (screenImage.getAttribute("src") !== step.image) screenImage.src = step.image;
    screenImage.width = step.width;
    screenImage.height = step.height;
    screenImage.alt = copy.alt;
    byId("original-image").href = step.image;
    byId("step-title").textContent = copy.title;
    byId("step-description").textContent = copy.description;
    byId("step-note").textContent = copy.note;
    byId("step-points").replaceChildren(...copy.points.map((point) => {
      const item = document.createElement("li");
      item.textContent = point;
      return item;
    }));

    const total = document.createElement("span");
    total.textContent = "/ 05";
    byId("step-count").replaceChildren(document.createTextNode(`${String(currentStep + 1).padStart(2, "0")} `), total);
    stepButtons.forEach((button, index) => {
      if (index === currentStep) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
      button.setAttribute("aria-label", words.stepLabel(index, steps[index][language].title));
    });
    document.querySelectorAll(".progress-track span").forEach((segment, index) => {
      segment.classList.toggle("is-complete", index <= currentStep);
    });
    previousButton.disabled = currentStep === 0;
    byId("next-label").textContent = currentStep === steps.length - 1 ? words.restart : words.next;
    byId("next-arrow").textContent = currentStep === steps.length - 1 ? "↺" : "→";
    if (announce) byId("tour-announcement").textContent = words.stepLabel(currentStep, copy.title);
  }

  function setLanguage(nextLanguage, announce = true) {
    if (!Object.hasOwn(translations, nextLanguage)) return;
    language = nextLanguage;
    const words = translations[language];
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.title = words.title;
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const value = words[element.dataset.i18n];
      if (typeof value === "string") element.textContent = value;
    });
    languageButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.language === language));
    });
    tour.setAttribute("aria-label", words.tourLabel);
    document.querySelector(".step-nav").setAttribute("aria-label", words.navLabel);
    byId("hosting-guide").href = language === "zh"
      ? "https://github.com/Pvigors/ApebookLM/blob/main/docs/SELF_HOSTING.md"
      : "https://github.com/Pvigors/ApebookLM/blob/main/README_EN.md#quick-start-with-docker";
    renderStep(announce);
  }

  function goToStep(index) {
    if (!Number.isInteger(index) || index < 0 || index >= steps.length) return;
    currentStep = index;
    renderStep();
  }

  stepButtons.forEach((button) => button.addEventListener("click", () => {
    goToStep(Number(button.dataset.step));
  }));
  languageButtons.forEach((button) => button.addEventListener("click", () => {
    setLanguage(button.dataset.language);
  }));
  previousButton.addEventListener("click", () => goToStep(currentStep - 1));
  nextButton.addEventListener("click", () => goToStep((currentStep + 1) % steps.length));

  tour.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!(event.target instanceof Element) || event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    let index;
    if (event.key === "ArrowRight") index = Math.min(currentStep + 1, steps.length - 1);
    else if (event.key === "ArrowLeft") index = Math.max(currentStep - 1, 0);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = steps.length - 1;
    else return;
    event.preventDefault();
    goToStep(index);
    if (event.target.closest("[data-step]")) stepButtons[currentStep].focus();
  });

  document.documentElement.classList.add("js");
  setLanguage(language, false);
})();
