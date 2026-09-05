# ApebookLM 首轮开源发布文案与 14 天执行日历

状态：准备稿，未发送、未发帖、未创建平台产品页。事实基线为社区仓库 `667e877`；发布当天必须再次核对版本与可用入口。

当前可交付物是公开源码、自托管说明、仓库截图和本地演示。没有在本文中承诺公共体验站、免注册试用、桌面安装包、部署耗时、使用效果数字或已有用户成绩。

新增静态示例导览：`demo/index.html`，支持中文 / 英文、五步截图切换、键盘操作与手机浏览。**待发布地址为 <https://pvigors.github.io/ApebookLM/>，尚未由本文确认上线；必须经主代理发布并验证页面、全部截图和切换操作后，才能加入对外正文。** 此地址是零后端截图导览，不是可以上传文件或调用模型的在线工作台；完整功能仍需自托管。

发布验证通过后，可在下列各平台正文的仓库链接旁加入这一段（未通过前保留在草稿中）：

> 中文：先看示例导览：https://pvigors.github.io/ApebookLM/ 。它使用示例数据，本页不处理文件、不调用模型；可以切换五个真实界面了解流程，完整使用需在自己的环境中部署。
>
> English: Explore the guided preview: https://pvigors.github.io/ApebookLM/ . It uses sample data and actual screenshots; it does not process files or call models. Self-host the project to use the full workflow.

## 使用方法与统一口径

- 以下正文以作者第一人称书写，实际发布者须为作者或获授权的维护者；若由维护者发布，将“作者 / maker”准确改为对应身份。
- 每个平台的“发布前复核”是给发布者的操作提示，正文可单独复制。所有外部平台文案都须按发布当天该社区的现行规则复核；本文件不表示已获得平台许可。
- 仓库入口统一为 <https://github.com/Pvigors/ApebookLM>；静态导览地址仅在发布验证后使用，并保留“静态导览”说明。没有可处理用户资料的公共体验站。视频文案须等录像与内容一致后使用。
- 主要价值按“中文资料 → 可回到原文的引用 → 笔记与产出 → 自托管和 BYOK”表达。CAD 只作辅助特色，必须同时说明受控几何和非制造认证边界。
- 现役 UI 为简体中文。部署需要配置数据库、平台模型和管理员登录；BYOK 不覆盖共享、公开、自动解析和系统任务。模型等外部服务可能接收必要资料并产生供应商费用。
- 演示仅使用自有、获授权或可再分发的资料；截图、录像、Issue 均不包含真实 Key、私人笔记、用户身份或内部访问地址。

中文一句话：**ApebookLM 是面向中文资料的开源研究工作台：汇集来源、追溯引用、沉淀笔记，并支持自托管与个人模型 API。**

English one-liner: **ApebookLM is an open-source research workspace for Chinese source material, with traceable citations, reusable notes, self-hosting, and BYOK.**

## 1. V2EX：作者分享长帖

发布前复核：按 V2EX 当前规则核对合适节点、自荐与链接要求；以作者身份发布，不重复跨节点投递，不邀请顶帖或投票。

### 标题

做了一个面向中文资料的开源研究工作台：ApebookLM，带引用、自托管、可用自己的模型 API

### 正文

大家好，我是 ApebookLM（猿笔记）的作者，这次把可自托管的社区版开源了。

我想解决的是一个很具体的问题：资料分散在 PDF、网页、公众号、B 站链接和本地笔记里。把它们放进一个对话框还不够，我希望读完后能知道结论对应哪段原文，也能把整理过的内容继续留下来用。

所以 ApebookLM 的主流程是：导入资料，勾选这次要使用的来源，做带引用的问答，再把结果沉淀成笔记或生成报告、图表、导图等内容。三栏工作台左侧放来源，中间问答，右侧管理笔记和生成物。

我目前更在意这几件事：

- **引用能回到原文。** 回答可附来源引用，点击后定位相应文本，方便自己核对结论有没有超出资料。
- **照顾中文资料的入口。** 除了 PDF、DOCX、PPTX、EPUB、Markdown，也支持公众号网页、Bilibili / YouTube 链接、图片、音频和 Obsidian ZIP。链接能提取到什么，仍受原站权限、字幕和页面情况影响。
- **资料与模型配置可由部署者掌握。** 使用 Docker Compose 和 PostgreSQL 自托管，部署者配置平台模型；个人也能在自己拥有、未公开且没有协作者的笔记本中使用受支持供应商的 Key。
- **整理结果能继续使用。** 笔记和部分文本生成物可以重新成为来源，也可以按类型导出 Markdown、PDF、表格等文件。

仓库里还有一个 CAD 辅助入口，可以从明确的对象、尺寸和约束生成受控几何，预览并导出 STEP、STL、二维 DXF。这个功能适合教学和设计辅助，不是制造认证；复杂装配、自由曲面、仿真和完整工程图不在当前承诺范围内。

也把限制放在这里：界面目前是简体中文；这是源码和自托管版本，没有桌面安装包，也没有可直接打开的公共体验站。首次启动需要配置模型和管理员登录，首次使用嵌入、音频转写时要准备模型下载。自托管不等于所有请求都留在本机，启用外部模型或搜索等服务时，会按请求发送必要内容，费用也由相应供应商计收。个人 BYOK 不接管共享笔记本、自动解析或系统任务。

源码、截图和部署说明：
https://github.com/Pvigors/ApebookLM

代码采用 AGPL-3.0-only。项目与 Google / NotebookLM 没有隶属或合作关系。

这轮希望找经常整理中文资料、能自行部署，或愿意看本地演示的朋友帮我验证主流程。最想听的是：你在哪一步停下来了？引用是否足够让你回去核对？生成的内容最后有没有进入你原本的工作流程？

如果愿意反馈，可以在仓库提 Issue，描述资料类型、操作步骤和预期结果即可；请不要贴私人文档或 API Key。也欢迎直接指出这套流程对你而言不成立的地方。

## 2. 掘金：技术与产品长帖

发布前复核：按掘金当前规则复核原创、自荐、外链和标签要求；以作者身份发布，配图须与真实界面一致。代码与运行事实更新后再发，不把本稿当性能测试报告。

### 标题

我开源了 ApebookLM：把中文资料、引用问答和笔记整理放进一个自托管工作台

### 摘要

一个 Next.js + PostgreSQL 的开源项目：从中文文档和链接导入，到可回到原文的引用问答，再到笔记与内容导出。本文介绍已经实现的链路、模型配置边界，以及第一次自托管需要准备什么。

### 正文

我是 ApebookLM（猿笔记）的作者。做这个项目时，我把问题收得比较具体：当资料来自 PDF、公众号文章、B 站视频链接和本地 Markdown 时，能不能在同一个笔记本里整理，并把结论重新连回原文？

现在社区版已经开源。仓库提供源码、Docker Compose 配置、界面截图和部署文档，界面目前是简体中文：

https://github.com/Pvigors/ApebookLM

#### 一条主流程：导入、选择、核对、沉淀

工作台分成三栏。左侧是来源，中间是对话，右侧是生成物和笔记。导入完资料后，可以先勾选本次问答的取材范围，回答生成后再点开引用，检查对应的文本。

这一步我希望保留人的判断：有引用只是让核对更方便，并不代表模型的推理自动正确。资料缺失、解析失真、结论超出原文，都仍然可能发生。

确认过的内容可以保存为笔记，部分文本生成物也可以转为来源。这样整理过程可以继续迭代，报告或笔记不会生成一次就被留在对话记录里。

#### 为什么给引用保存文本位置

引用链路会保存来源文本片段、字符位置与内容哈希。这些信息用于定位证据和识别来源变化。对于使用者，最直接的价值是可以跳回原文，检查“这句话究竟依据哪一段”。

中文嵌入在本地运行。PDF 优先读取文本层，扫描件等情况需要视觉 OCR；音频有本地转写路径。公众号和视频链接的导入仍依赖可访问的页面或字幕，不能承诺任意链接都能完整提取，本地 MP4 等视频文件目前也不是支持的来源上传方式。

#### 自托管与 BYOK 分别解决什么

默认部署使用 PostgreSQL 保存业务数据，使用持久卷保存媒体与 CAD 文件。平台模型由部署者统一配置，也支持个人选择内置供应商目录中的模型 API。

这里有一个容易误解的边界：个人 Key 只用于本人拥有、未公开且没有协作者的私有笔记本，以及本人主动发起的联网研究。共享、公开、自动解析和系统任务仍使用平台模型。个人 API Key 在服务端加密保存，个人设置不开放任意 Base URL。

因此，“支持自己的 Key”不等于省去平台配置；“自托管”也不等于天然完全离线。若选择外部模型、搜索、语音或解析服务，完成请求所需内容仍可能发送到对应供应商。

#### 从笔记到输出，以及一个 CAD 辅助入口

新实例默认展示报告、专业图表、导图、表格、音频概览和 CAD 六个核心入口，其他类型由管理员按需启用。导出格式随内容类型而定，例如 PDF、XLSX、Markdown、PPTX 等。

CAD 是一个附加的设计辅助能力：输入明确对象、尺寸和约束后，生成受控几何，在浏览器里预览，再下载 STEP、STL 或二维 DXF 顶视边线。它使用独立 worker，STEP 会经过 Replicad 和 FreeCAD 回读。几何回读不是制造认证；当前不覆盖任意复杂装配、自由曲面、仿真或完整制造工程图。

#### 第一次运行要准备什么

技术栈是 Next.js 15、React 19、TypeScript 和 PostgreSQL 16。推荐从仓库自托管指南开始：复制环境变量模板，配置数据库与模型，生成管理员配置，运行预检，再启动容器并检查嵌入模型是否就绪。

一个小细节：代码里的 `OPENAI_` 环境变量表示兼容接口配置，当前默认端点和模型是 Qwen；换供应商时需要一起核对 Key、Base URL、对话模型和视觉模型，不能只替换 Key。

这里没有承诺“几分钟部署好”。镜像构建、首次模型下载、网络和设备差异都会影响启动过程。公开服务还需要 TLS、备份和运维配置。当前没有桌面安装包和公共体验站。

#### 这轮想验证的事

我更想请读者带一个真实、可分享或可脱敏的任务试一下：选几份你原本就要读的资料，提出一个需要回到原文核对的问题，再生成一份你之后会继续编辑的内容。

如果遇到问题，欢迎通过 GitHub Issue 告诉我：来源类型、操作步骤、预期与实际结果、使用的供应商和模型名。不要提交 Key 或私人原文。不能部署但愿意看本地演示的朋友，也可以反馈最想验证的场景。

代码采用 AGPL-3.0-only；项目独立于 Google / NotebookLM。后续我会优先根据可复现的导入、引用和首次使用问题调整，而不是先堆一张更长的功能表。

## 3. Bilibili：标题与简介

发布前复核：按 Bilibili 当前规则核对分区、自荐、简介外链和素材权利；以作者身份出镜或署名。以下简介仅在完成所述真实本地演示录像后使用；不得把剪辑等待过程描述为实际生成耗时。先完成录制，再补真实章节时间，不预填假时间戳。

### 首选标题

我开源了一个中文资料研究工作台：点开引用回到原文｜ApebookLM

### 备用标题

PDF、公众号、B站资料放一起：ApebookLM 本地演示与自托管说明

### 简介

我是 ApebookLM（猿笔记）的作者。这期用本地运行的社区版，演示从导入中文资料、勾选来源、带引用问答，到保存笔记和生成报告的完整流程，并说明自托管与个人模型 API 的配置边界。

视频会展示：

- 资料如何进入同一个笔记本；
- 如何点开引用，核对回答对应的原文；
- 如何保存笔记、生成和导出内容；
- 个人模型 API 在什么情况下生效；
- CAD 受控几何预览与文件导出，以及它当前做不到什么。

源码与部署文档：https://github.com/Pvigors/ApebookLM

目前提供源码和 Docker 自托管，界面是简体中文；没有公共体验站或桌面安装包。启动需要配置模型与管理员登录，外部模型等服务可能产生费用、接收必要资料；自托管不自动等于完全离线。

CAD 用于设计和教学辅助，不是制造认证；DXF 仅为二维顶视边线，不包含完整尺寸标注、公差和工程图框。

你平时最难整理的资料是什么？欢迎留一个具体场景；可复现问题也可以提交到 GitHub Issues。请不要公开私人原文、账号或 Key。

项目采用 AGPL-3.0-only，与 Google / NotebookLM 无隶属或合作关系。

### 录像顺序提纲（供录制，不作为已完成事实）

1. 展示一个可公开的中文资料问题与三栏工作台。
2. 导入自有 / 授权资料，等待解析完成，选择取材范围。
3. 提问并点击引用，展示对应原文；保留一次人工核对过程。
4. 保存笔记，生成一种报告，展示可下载结果。
5. 展示个人模型设置界面；隐藏所有密钥，解释其私有笔记本边界。
6. 可选展示 CAD 教学件或明确尺寸的受控模型，现场说清非制造认证。
7. 展示仓库和自托管要求，说明当前只有源码与本地演示。

## 4. Show HN：标题与 maker 首评

Pre-publication review: Check the current Hacker News and Show HN rules, submission eligibility, and title requirements. Submit as the maker, link to the actual repository, and disclose the local setup requirement. Do not solicit votes or coordinated comments. This draft does not assume that a source-only submission is eligible under future rules.

### Title

Show HN: ApebookLM – A self-hosted research workspace for Chinese sources

### Submission URL

https://github.com/Pvigors/ApebookLM

### Maker's first comment

Hi HN, I'm the maker of ApebookLM, an open-source research workspace for Chinese source material.

The workflow is: collect documents and links, select the sources for a question, inspect the cited passages, and turn the result into notes or exported outputs. Supported inputs include PDFs, office documents, web pages, WeChat articles, Bilibili/YouTube links, audio, images, and Obsidian ZIPs. Link extraction depends on what the source site makes accessible.

I focused on making the evidence inspectable: citations retain source text, character positions, and a content hash, and the UI lets you return to the relevant passage. This helps with checking an answer; it is not a correctness guarantee.

The stack is Next.js, TypeScript, and PostgreSQL. Chinese embeddings run locally. Deployers configure an OpenAI-compatible model service. Personal BYOK is available for a user's own private notebooks without collaborators and for explicitly initiated research; shared/public notebooks, automatic parsing, and system tasks use the instance configuration. External providers may receive the material needed for a request.

There is also a constrained CAD feature, with STEP/STL and a 2D DXF top-view export. It is a secondary design/teaching tool, not manufacturing certification.

The current UI is Simplified Chinese. You can clone and self-host it with Docker Compose; there is no public hosted demo or desktop installer. Setup requires database/model configuration and an administrator login, and initial embedding/ASR use requires model downloads. The repository includes screenshots, an English README, and setup instructions. It is AGPL-3.0-only and independent of Google/NotebookLM.

I'd appreciate feedback on the source-to-citation workflow, what blocks a first self-hosted run, and whether the resulting notes fit into a workflow you already use. A reproducible failure is especially useful; please keep private documents and credentials out of public issues.

## 5. Reddit：自荐帖

Pre-publication review: Read the selected subreddit's current rules for self-promotion, title tags, megathreads, link posts, and author disclosure. Use this once in a relevant community where it is permitted; ask moderators if the rules require it. Do not mass cross-post or request upvotes. No specific subreddit approval is assumed.

### Title

I built ApebookLM, a self-hosted research notebook for Chinese documents with source citations

### Body

Disclosure: I'm the maker of ApebookLM.

I'm sharing an open-source project for people who work with Chinese-language PDFs, web pages, WeChat articles, Bilibili links, and local notes. You can collect sources in a notebook, choose which ones a question uses, follow citations back to the imported text, and save or export what you learn.

Repository and screenshots: https://github.com/Pvigors/ApebookLM

For anyone considering a self-hosted setup:

- The community edition uses Docker Compose and PostgreSQL; data is stored in your database and persistent volumes.
- Chinese embeddings run locally. Generation uses the model service configured by the deployer.
- Personal BYOK supports the built-in provider catalog in your own private notebooks without collaborators. Shared/public notebooks, automatic parsing, and system tasks use the instance's model settings.
- The UI is currently Simplified Chinese. There is no public hosted demo or desktop installer; setup includes model configuration and an administrator login.
- Self-hosting does not automatically make requests offline. External models and optional services may receive the content needed for a request and charge for their use.

There is an additional constrained CAD feature for design/teaching, but my main interest here is the document → citation → note workflow. CAD outputs are not certified for manufacturing.

If this is relevant to your work, what would you test first: importing your existing material, checking a citation, or getting notes back out? I'd also like to hear where the deployment instructions are unclear. No need to share private documents—an anonymized reproduction or a description of the file type is enough.

Code is AGPL-3.0-only. The project has no affiliation with Google or NotebookLM.

## 6. Product Hunt：产品资料与作者首评

Pre-publication review: Check Product Hunt's current launch eligibility, product availability, listing fields, media specifications, and promotional rules. Publish as the maker, accurately describe the source/self-hosted availability, and use actual screenshots. This is a prepared listing, not a created product page. Keep it in draft if the platform requires an access path the project does not yet provide. Do not coordinate votes.

### Name

ApebookLM

### Tagline

Self-hosted research for Chinese sources, with citations

### Description

Bring Chinese documents and links into one research notebook. Ask questions with source citations, keep notes, and export reports. Self-host with Docker and connect model APIs. Simplified Chinese UI; setup and login required. Open-source, AGPL-3.0-only.

### Website / repository

https://github.com/Pvigors/ApebookLM

### Maker's first comment

Hi everyone, I'm the maker of ApebookLM.

I built it around a research habit: collect material, ask a question, check the original passage, and keep something useful from the answer. ApebookLM brings those steps into a single notebook, with inputs such as Chinese PDFs, web pages, WeChat articles, Bilibili links, and local documents.

You can select the sources for a question, inspect citations, save notes, and generate outputs such as reports, charts, mind maps, and tables. It also includes a constrained CAD tool for design and teaching; geometry checks are not manufacturing certification.

The community edition is available as source code with Docker Compose instructions. The interface is currently Simplified Chinese. There is no public hosted demo or desktop installer, and getting started requires a model configuration and administrator login.

Self-hosting gives you control of the database and stored files. Model and other external services may still receive content needed for requests and charge for their use. Personal BYOK works within private notebooks owned by the user without collaborators; it does not replace the instance's model configuration for shared/public notebooks, automatic parsing, or system tasks.

I'd love feedback from people who regularly work with Chinese source material: can you find the evidence you need, and does the output fit the way you already take notes or write reports? The repository includes screenshots and an English README. Bug reports and specific workflow feedback are welcome.

The code is AGPL-3.0-only, and ApebookLM is independent of Google/NotebookLM.

## 7. 20 位种子用户邀约草稿

这是一份 **20 个招募席位** 的清单，不代表已经找到了 20 位真实用户或发送了邀请。联系对象应来自已有联系、主动报名或允许项目招募的社区；不抓取私人联系方式，不群发。实际使用前补充真实称呼与一条经核实的共同背景，不写虚假的“看过你的文章”。

发布 / 发送前复核：每条都须按所用社区、邮件或私信渠道的现行规则复核，署明作者身份。当前状态全部为“草稿、未发送”；发送须另行获得明确授权。默认一次邀请，无回复不追发；只有对方答应后才约演示或收集进一步资料。不要求 Star、投票、正面评价或公开背书。

以下邀请提供两条真实可用路径：自行从仓库部署，或与作者约本地演示。后者是邀约提议，尚未约定时间，也不虚构共享公网链接。每人只验证一个核心问题，CAD 相关席位保持为少数。

### 01｜中文论文阅读者｜引用是否支持核对

你好，我是 ApebookLM 的作者，正在邀请首轮试用反馈。它可以把论文等资料放进一个笔记本，问答后点开引用核对原文。想请你用一份有权使用的中文论文，试一个需要核对证据的问题。目前只有源码自托管和可约的本地演示：https://github.com/Pvigors/ApebookLM 。如果愿意，我最想听你在哪条引用上仍然不放心；不方便也没关系。

### 02｜研究生读书小组组织者｜多个来源的区分

你好，我是 ApebookLM 的作者。项目支持为每次提问勾选资料范围，我想请读书小组的组织者看看：几份资料一起讨论时，是否容易分清一个观点来自哪份原文。仓库：https://github.com/Pvigors/ApebookLM 。目前需要自托管配置，也可以约看本地演示；如果你愿意参与，只需要反馈一次资料选择和引用核对体验，不需要提供组内私人材料。

### 03｜教师或课程助教｜笔记与导图是否有用

你好，我是 ApebookLM 的作者，做了一个面向中文资料的开源研究工作台。想邀请你用一份可公开的课程资料，看看从引用问答到笔记、导图的流程是否适合备课。现在只有源码和本地演示，可自行部署或约演示：https://github.com/Pvigors/ApebookLM 。希望听到你实际还需要补哪一步，无须提供学生资料或为项目宣传。

### 04｜中文长文作者｜从取材到初稿

你好，我是 ApebookLM 的作者。它把资料、带引用问答和笔记放在同一个工作台，我想请经常写长文的人试试：从几份公开材料得到可继续编辑的笔记，是否顺手。源码：https://github.com/Pvigors/ApebookLM 。目前没有公共体验站，可以自行部署或约本地演示。若你愿意，只需告诉我哪些内容会保留、哪些仍要重写。

### 05｜技术文档维护者｜更新后能否核对来源

你好，我是 ApebookLM 的作者，想邀请你帮忙看文档整理场景：把几份技术文档导入后，提问、点开引用，再整理成笔记。重点想了解引用上下文够不够，而不是请你替模型结论背书。仓库：https://github.com/Pvigors/ApebookLM 。目前可源码自托管，也可约本地演示；只用公开或脱敏材料即可。

### 06｜独立产品经理｜资料是否真的进入产出

你好，我是 ApebookLM 的作者，正在找首轮产品调研场景的反馈。你可以把公开竞品资料放进同一个笔记本，核对引用，再生成表格或报告草稿。我想知道产出能否接到你原本的文档流程。仓库：https://github.com/Pvigors/ApebookLM 。目前需要自托管，或可以约看本地演示；不需要上传用户访谈原始隐私数据。

### 07｜用户研究从业者｜来源选择是否清楚

你好，我是 ApebookLM 的作者。项目允许逐条选择本次问答使用的资料，想请你用模拟或已脱敏的研究材料看看：这个取材范围是否容易理解，引用是否足够支持回看。仓库：https://github.com/Pvigors/ApebookLM 。只有源码和本地演示，没有在线体验站。若愿意，可自行部署或约演示；不会要求你分享真实受访者信息。

### 08｜咨询或行业研究者｜报告草稿的可用性

你好，我是 ApebookLM 的作者，想邀请你验证一个小流程：导入几份公开中文行业资料，问一个需要证据的问题，再生成一份报告草稿。最希望听你指出它漏了哪些原文依据、哪些部分无法使用。源码：https://github.com/Pvigors/ApebookLM 。目前支持自行部署或约本地演示，请只使用有权分享的材料。

### 09｜B 站课程学习者｜字幕导入是否满足任务

你好，我是 ApebookLM 的作者。项目支持 B 站链接的字幕或页面提取，但会受字幕、登录态和原站访问限制影响。我想邀请你验证一个已获授权的学习资料场景，看看提取到的内容是否足够做引用问答。仓库：https://github.com/Pvigors/ApebookLM 。目前是源码自托管或本地演示；如果愿意，提取失败的具体表现同样很有帮助。

### 10｜公众号资料整理者｜网页解析是否完整

你好，我是 ApebookLM 的作者，想请你看看公众号资料整理这条流程。它支持导入可访问的文章网页，再围绕原文问答；遇到原站限制时仍可能不完整。仓库：https://github.com/Pvigors/ApebookLM 。目前没有公共体验站，可以自托管或约本地演示。如果愿意，只需要用有权使用的文章指出缺失段落、图表或引用问题。

### 11｜Obsidian 使用者｜导入导出是否顺手

你好，我是 ApebookLM 的作者。项目支持 Obsidian ZIP 导入，也能导出包含笔记和可文本化内容的 Markdown ZIP。想请你用一个没有私人内容的小型资料库，看看这条往返流程哪里不顺。仓库：https://github.com/Pvigors/ApebookLM 。目前可自托管或约看本地演示；我更想收集具体格式问题，不需要迁移你的完整库。

### 12｜播客或会议记录整理者｜转写后的可用性

你好，我是 ApebookLM 的作者，想请你试一次“授权音频 → 转写 → 引用问答 → 笔记”的流程。音频转写需要本地模型，首次运行要准备下载；也可先看本地演示。源码：https://github.com/Pvigors/ApebookLM 。如果愿意参与，希望你指出转写错误如何影响后续整理；请不要提供未获同意的会议录音。

### 13｜自托管爱好者｜首次部署的阻碍

你好，我是 ApebookLM 的作者，想请你按仓库说明独立部署一次，反馈第一个让你停下来的地方。它使用 Docker Compose 和 PostgreSQL，需要配置平台模型和管理员登录，CAD 场景建议至少 4 核 / 8 GB。源码：https://github.com/Pvigors/ApebookLM 。不承诺部署耗时；若愿意帮忙，只需记录系统环境、步骤和脱敏错误，不发任何凭据。

### 14｜中文开源文档贡献者｜首次使用说明

你好，我是 ApebookLM 的作者，正在改进开源社区版的首次使用说明。想请你读 README，并尝试判断能否清楚理解登录、平台模型、个人 Key 和嵌入下载的关系。仓库：https://github.com/Pvigors/ApebookLM 。可以只读文档，也可自托管或约本地演示。若愿意，请直接标出让你误解的句子；不用承诺提交代码。

### 15｜BYOK 多模型使用者｜权限边界是否可理解

你好，我是 ApebookLM 的作者。项目支持内置供应商目录中的个人 Key，但只对本人私有且无协作者的笔记本及主动研究生效，自动解析、共享和系统任务仍走平台配置。我想请你看看设置界面能否把这个区别讲清。源码：https://github.com/Pvigors/ApebookLM 。可自托管或约演示，无须向我提供 Key，也不要求测试付费功能。

### 16｜工程教育工作者｜CAD 教学边界

你好，我是 ApebookLM 的作者。除资料和引用流程外，项目有受控 CAD 辅助入口，可预览并导出 STEP、STL 和二维 DXF。我想请你从教学角度判断是否把能力边界讲清：它不是制造认证，DXF 也不是完整工程图。仓库：https://github.com/Pvigors/ApebookLM 。目前可自托管或约本地演示；若愿意，希望只验证一个明确尺寸的教学件。

### 17｜自托管 Chinese-document researcher｜English invitation

Hi, I'm the maker of ApebookLM, an open-source research workspace for Chinese source material. I'd like to invite you to try one document-to-citation workflow and tell me where checking the evidence becomes difficult. The UI is currently Simplified Chinese. Source and setup instructions: https://github.com/Pvigors/ApebookLM . There is no hosted demo; you can self-host it or arrange a walkthrough of my local instance. Please use material you can share or a redacted example. No endorsement is expected.

### 18｜English README reviewer｜English invitation

Hi, I'm the maker of ApebookLM. I'm looking for feedback on whether the English README makes a first self-hosted run understandable, especially model configuration, administrator login, and initial model downloads. Repository: https://github.com/Pvigors/ApebookLM . The app UI is Simplified Chinese, and there is no public hosted demo. A documentation review alone would help; you do not need to deploy it or provide credentials. Would you be interested in pointing out the first confusing instruction?

### 19｜Bilingual knowledge-work practitioner｜English invitation

Hi, I'm the maker of ApebookLM. It collects documents and links into a notebook, supports questions with source citations, and lets you keep notes or export outputs. I'm inviting a few people who work with Chinese material to test whether the result fits their existing research workflow. Repository: https://github.com/Pvigors/ApebookLM . The UI is Simplified Chinese; access currently means self-hosting or arranging a local walkthrough. I'd value one concrete task and an honest account of what did not work. Please keep private material private.

### 20｜CAD exchange / maker-tool reviewer｜English invitation

Hi, I'm the maker of ApebookLM. Its main focus is source-based research, with an additional constrained CAD tool that exports STEP/STL and 2D DXF top-view edges. I'd like feedback on one supported teaching example and whether the stated limitations are clear. This is not manufacturing certification or a full CAD replacement. Source: https://github.com/Pvigors/ApebookLM . There is no hosted demo; you can self-host it or arrange a local walkthrough. No positive review or public post is expected.

### 邀约记录字段

实际记录放在不公开的工作表中，不把真实姓名、联系方式、私人反馈提交到本仓库：席位编号、本人同意的称呼、联系渠道、联系依据、邀约状态、是否同意演示、测试任务、卡点、问题链接、是否同意再次联系。无需采集年龄、住址、雇主等与试用无关的信息。

## 8. 14 天执行日历

以下是相对启动日的人工执行计划，并非已创建的自动任务。D1 由维护者确定；发帖和邀约步骤只有在用户明确授权实际发送、平台规则允许且素材满足当天事实时才执行。某个平台暂不适用时，保留草稿，将当天精力用于已有反馈。

| 天 | 主要动作 | 当天可复核产出 / 继续条件 |
| --- | --- | --- |
| D1 | 核对仓库入口、版本、README 双语、截图和首次运行路径 | 记录实际测试环境与结果；修正文案和源码事实不一致处 |
| D2 | 用可公开资料录制本地演示，展示一次点击引用与一次笔记 / 报告导出 | 检查没有 Key 或私人资料；标明剪辑和本地演示；导出可用录像 |
| D3 | 找到前 5 个匹配的种子席位，按真实背景逐条调整邀请 | 获准后单独发送；记录送达与答复，未授权时只留草稿 |
| D4 | 开展已同意的首轮演示 / 自托管反馈 | 记录第一个卡点及复现方式；不把作者演示成功当作用户独立完成 |
| D5 | 处理阻碍导入、登录、引用核对的最优先问题，更新说明 | 有变更则先检查，再形成可链接的改动记录；没有证据就记录待验证 |
| D6 | 复核 V2EX 当前节点与自荐规则，发布作者长帖（获准时） | 只保留一个实际帖子入口；回应具体问题，不要求顶帖 |
| D7 | 复核 Bilibili 规则，发布与成片一致的标题和简介（获准时） | 填真实视频链接与章节时间；回看一遍确保演示和描述一致 |
| D8 | 选择种子席位 6–10，结合前一轮卡点调整邀请与任务 | 获准后发送；只向已答应者安排后续测试 |
| D9 | 整理中文技术长帖，按掘金规则发布（获准时） | 补真实界面和已验证的技术说明；不写尚未取得的转化 / 性能数据 |
| D10 | 汇总独立部署反馈，校准英文 README；联系种子席位 11–15 | 区分“读过说明”“启动成功”“完成引用任务”；实际发送仍需授权 |
| D11 | 复核 Show HN 当前资格与规则，准备或提交 maker 帖（获准时） | 确认外部读者能从仓库理解并尝试项目；如条件不符则继续草稿 |
| D12 | 选择一个允许此类分享的 Reddit 社区；联系席位 16–20 | 各自按规则与授权执行，不跨社区群发；保留作者披露 |
| D13 | 检查 Product Hunt 的可用性与素材要求，决定保留草稿或发布（获准时） | 如平台要求尚未具备的体验入口则等待，不编造 URL；持续处理已有反馈 |
| D14 | 汇总首轮事实，确定下一轮要解决的一个主要问题 | 输出真实漏斗与问题清单，标明分母和来源；不将计划当成果 |

不把平台全部发完当作目标。每天优先回复已有的真实反馈；同一问题重复出现时先改善流程或说明，再继续下一批邀请。只有得到同意的受访者才安排回访。

### 记录哪些数据

本轮基线未知，先记录再判断，不预填增长目标或增长成绩：

- 已获准且实际发送的独立邀请数、回复人数、同意参与人数。
- 自行部署的人数及成功人数；作者演示参与者单独计数。
- 实际完成“导入 → 提问 → 点开引用”的人数，以及每一步停止的人数。
- 实际导出且表示会继续使用结果的人数；“会继续使用”与随后真实再使用分开记录。
- 最常见阻碍、可复现 Issue、已解决问题，以及对应版本。

如要报告比例，必须同时给出分子、分母、统计窗口和口径；小样本只描述观察，不外推所有用户。GitHub Star 只能是附加观察，不能代替任务完成或可信引用。

## 9. 反馈问题与访谈收尾

### 中文反馈单

1. 你原本想完成什么任务？之前怎么做？
2. 你使用了什么类型、什么语言的资料？是否需要扫描 OCR、字幕或登录态？不必上传原文。
3. 你自己部署了，还是看了作者演示？第一个让你停下来的步骤是什么？
4. 你点开了哪一条引用？对应原文是否支持回答中的具体说法？若不支持，能否给脱敏示例？
5. 勾选来源后，你能否清楚知道本次回答用了哪些资料？有没有不该混入的内容？
6. 哪份笔记或输出会进入你原来的工作流程？需要做哪些修改才能使用？
7. 平台模型、个人 Key、共享笔记本与外部资料发送的关系，哪里让你困惑？不要提交 Key。
8. 如果只改一件事，什么改动会让你愿意再用一次？如果不打算再用，主要原因是什么？
9. 可选：若测试了 CAD，实际对象 / 尺寸是什么？查看器和导出是否满足这次教学或设计辅助任务？你是否清楚它不代表制造认证？
10. 是否同意我们在修复后再联系一次？是否允许公开脱敏后的问题摘要？两项分别确认，默认均不公开。

### English feedback prompts

1. What task were you trying to complete, and how do you normally do it?
2. What source types and languages did you use? No private documents are needed.
3. Did you deploy it yourself or attend a maker walkthrough? Where did you first get stuck?
4. Did a cited passage support the specific claim in the answer? Can you describe a redacted failure?
5. Was it clear which sources were selected for the question?
6. Would you use any resulting note or export in your existing workflow? What would need editing?
7. Were the instance model, personal BYOK, sharing, and external data-routing boundaries understandable?
8. What one change would make you try it again? If you would not return, why?
9. Optional for CAD: Did one supported example and its exported files meet your design/teaching task? Were the limitations clear?
10. May we contact you once after a fix? Separately, may we publish an anonymized issue summary? Neither is assumed.

### 简短回复模板

感谢你指出这个问题。我会先按你给的步骤复现，并把结果记录在对应 Issue 中。请不要补充私人原文或 Key；如果确实需要样例，我会先说明最小信息范围，再请你决定是否提供。修复后是否回访，按你之前的选择处理。

## 10. 发布当天事实复核入口

| 文案事实 | 仓库核对入口 |
| --- | --- |
| 开源版本、许可、现役截图 | `README.md`、`README_EN.md`、`LICENSE`、`docs/images/` |
| 来源格式与视频限制 | `app/api/notebooks/[id]/sources/route.ts`、`lib/extract.ts` |
| 引用文本、位置与内容哈希 | `lib/rag.ts` |
| 个人 Key 目录、加密与调用范围 | `lib/model-provider-catalog.ts`、`lib/user-model-config.ts`、`lib/ai-provider-context.ts`、`docs/user-model-api-config.md` |
| 默认平台端点与模型 | `lib/openai.ts`、`.env.example` |
| 启动、管理员和离线嵌入条件 | `docker-compose.yml`、`scripts/generate-admin-password-config.mjs`、`docs/SELF_HOSTING.md` |
| CAD 输出、隔离与能力边界 | `docs/cad-mvp.md`、`docker-compose.yml` |
| 默认制品与生成入口 | `lib/app-config.ts`、`lib/generation-contract.ts`、`README.md` |

本文件没有执行任何外部发布、联系种子用户或创建自动任务。正式使用前，把新获得的真实入口、录像和反馈事实纳入复核；不要把本地演示成功、计划席位或准备好的文案改写为已经公开运营的结果。
