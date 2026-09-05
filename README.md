<p align="center">
  <img src="public/brand/yuanbiji-head.png" width="88" alt="ApebookLM 猿笔记标志">
</p>

<h1 align="center">ApebookLM（猿笔记）</h1>

<p align="center">简体中文 · <a href="README_EN.md">English</a> · <a href="https://pvigors.github.io/ApebookLM/">交互导览</a></p>

<p align="center">
  <strong>把分散的中文资料，变成可核对、可复用、可自托管的研究工作台。</strong>
</p>

<p align="center">
  导入网页、PDF、公众号、Bilibili / YouTube 链接、音频、图片和本地文档，<br>
  围绕原文进行带引用问答，再生成报告、图表、演示文稿、音视频、测验和 CAD 等可交付内容。
</p>

<p align="center">
  <a href="https://github.com/Pvigors/ApebookLM/actions/workflows/ci.yml"><img src="https://github.com/Pvigors/ApebookLM/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Pvigors/ApebookLM/releases/latest"><img src="https://img.shields.io/github/v/release/Pvigors/ApebookLM" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Pvigors/ApebookLM" alt="License: AGPL-3.0"></a>
  <img src="https://img.shields.io/badge/Node.js-20-43853d" alt="Node.js 20">
  <img src="https://img.shields.io/badge/PostgreSQL-16-336791" alt="PostgreSQL 16">
  <img src="https://img.shields.io/badge/self--hosted-Docker-2496ED" alt="Docker self-hosted">
</p>

<p align="center">
  <strong><a href="https://github.com/Pvigors/ApebookLM/archive/refs/tags/v0.1.0.zip">下载 v0.1.0 源码</a></strong>
  · <a href="https://github.com/Pvigors/ApebookLM/releases/tag/v0.1.0">Release 与离线资产</a>
  · <a href="docs/SELF_HOSTING.md">自托管指南</a>
  · <a href="https://github.com/Pvigors/ApebookLM/releases/download/v0.1.0/apebooklm-intro-zh-60s.mp4">60 秒介绍视频</a>
  · <a href="CONTRIBUTING.md">参与贡献</a>
</p>

> ApebookLM 是独立开源项目，与 Google 或 NotebookLM 无隶属、授权或合作关系。

![ApebookLM 首页：把多种资料变成带引用的问答与可交付内容](docs/images/hero.png)

## ApebookLM 能做什么

ApebookLM 不只是一个“和 PDF 聊天”的界面。它把资料采集、引用问答、笔记沉淀、内容生成和导出放在同一个笔记本里：

```text
导入资料 → 勾选取材范围 → 带引用问答 → 生成智能制品 → 分享或导出
```

- **先核对，再下结论**：基于已选来源生成的回答可附原文引用，点击即可返回对应来源和文本位置。
- **资料不再只读一次**：问答可沉淀为笔记，手工笔记和部分文本制品可继续编辑或转为来源，参与下一轮检索。
- **一份资料，多种交付形式**：生成报告、图表、导图、表格、演示文稿、音视频、测验、画板和 CAD。
- **模型中立，可自带 Key**：部署者可配置平台模型，个人也可在私有笔记本中使用自己的模型 API。
- **数据和权限可控**：默认数据存在自己的 PostgreSQL 和 Docker 卷中，笔记本默认私有。

## 真实界面

### 三栏工作台

左侧管理来源，中间完成问答与快捷创作，右侧管理智能制品和手工笔记。每次对话或生成前，都可先确认本次使用哪些来源。

![ApebookLM 三栏工作台：来源、对话、笔记与智能制品](docs/images/workspace.png)

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/images/add-sources.png" alt="ApebookLM 添加来源弹窗">
      <br><sub><strong>多来源导入</strong>：本地文件、网页、Bilibili、粘贴文本与 Obsidian ZIP 从同一入口汇入。</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/images/model-api-settings.png" alt="ApebookLM 模型 API 配置弹窗">
      <br><sub><strong>个人模型 API</strong>：横向浏览 8 家供应商，用一个 Key 为对话、视觉与研究任务分别选择模型。</sub>
    </td>
  </tr>
</table>

### 从描述和资料生成 CAD

CAD 在独立 worker 中生成。输入明确的对象、尺寸和约束后，可在浏览器中旋转查看几何，并下载 STEP、STL 和二维 DXF 顶视边线。

![ApebookLM CAD 查看器与 STEP、STL、DXF 下载](docs/images/cad-viewer.png)

> CAD 输出是受控几何和教学 / 设计辅助结果，不等同于制造认证。DXF 为毫米单位的顶视二维边线，不包含尺寸、公差、图框或隐藏线消除。投入生产前请由工程师复核。

## 功能全览

| 能力 | 你可以做什么 |
| --- | --- |
| 多来源导入 | 将 PDF、DOCX、PPTX、EPUB、TXT / Markdown、CSV、图片、音频、网页、公众号、Bilibili / YouTube 链接、粘贴文本和 Obsidian ZIP 汇入同一笔记本 |
| 解析与检索 | PDF 优先读文本层，必要时使用视觉模型 OCR；音频可本地转写；中文嵌入和向量检索在本地运行 |
| 来源范围控制 | 逐条勾选本次问答或生成使用的资料，无需删除暂时不用的来源 |
| 带引用问答 | 保存引用原文、字符偏移与来源内容哈希，点击引用可定位并高亮原文 |
| 富文本笔记 | 手工记录，或将对话 / 报告沉淀为笔记；成熟后可转为 RAG 来源 |
| 智能制品 | 内置 19 种制品类型，覆盖报告、导图、表格、音视频、测验、闪卡、画板、演示文稿、小红书卡组、专业图表和 CAD |
| 模型 API | 部署者配置平台主 / 备模型；用户可在符合安全边界的私有笔记本中使用个人 API Key |
| 分享与协作 | 笔记本默认私有；支持 owner / editor / viewer 角色和公开只读链接 |
| 导出 | 按制品下载 Markdown、Obsidian ZIP、PDF、XLSX、PPTX、MP3、MP4、PNG、`.excalidraw`、`.drawio`、STEP、STL 或 DXF |
| 自托管管理 | PostgreSQL 持久化、异步任务、后台权限、用量账本、审计、健康检查与备份恢复 |

### 关于“19 种制品”

系统定义了 19 种制品类型。新实例默认开放 PDF 报告、专业图表、思维导图、数据表格、音频概览和 CAD 六个核心磁贴，管理员可按需启用其余类型；信息图当前仅兼容已有制品，不作为新的生成入口。

## 个人模型 API（BYOK）

当前固定安全目录内置 8 家供应商：**通义千问、OpenAI、OpenRouter、DeepSeek、Kimi、智谱 GLM、xAI 和硅基流动**。

1. 选择供应商并输入 Key。
2. 分别选择对话、视觉和研究用途的模型（不支持的用途不会出现）。
3. 点击“确认”，逐项连接测试通过后才启用。

个人 Key 使用 AES-256-GCM 在服务端加密，页面只返回是否已配置和末四位提示。用户不能填写任意 Base URL，可减少 SSRF 和资料被发送到未受控终点的风险。

> 个人接口仅用于用户本人拥有、未公开且没有协作者的私有笔记本，以及用户主动发起的联网研究。共享、公开、自动解析和系统任务继续使用部署者配置的平台模型。

详细设计与密钥轮换见 [用户模型 API 配置](docs/user-model-api-config.md)。

## CAD 特色与边界

- 支持来源驱动、提示词驱动和固定模板三种入口。
- 提供安装平板、安装支架、设备外壳、法兰、轴径转接套、人形机器人概念装配和汽车概念装配模板，以及自动匹配 / 自由参数化入口。
- Text2CAD V2 支持命名部件、XY / XZ / YZ 轮廓、拉伸和受控布尔序列。
- 几何通过 Replicad 隔离复读，STEP 再经独立 FreeCAD 原生回读。
- 下载前按冻结 manifest 复核文件大小和 SHA-256；失败任务不留在普通用户制品列表。

目前不支持任意复杂装配、自由曲面、BIM、钣金展开、GD&T、CAM、BOM、仿真或制造认证；人形机器人和汽车模板仅用于概念布局。更多技术边界见 [CAD MVP 说明](docs/cad-mvp.md)。

## 适合谁使用

- **研究者与学生**：阅读论文、整理课程材料，生成学习指南、闪卡和测验。
- **产品、咨询与内容团队**：汇总调研、会议记录和用户访谈，生成报告、图表与演示文稿。
- **工程与创客团队**：从明确对象、尺寸和约束生成受控 CAD 几何，下载 STEP、STL 或二维 DXF。
- **重视数据控制的个人和组织**：使用自己的模型接口，在自己的 PostgreSQL 和 Docker 卷中保存资料。

## 下载

想先了解界面？打开[中英文交互导览](https://pvigors.github.io/ApebookLM/)。导览使用示例截图，不接收文件或调用模型。完整功能需要自行部署。

当前版本提供源码与 Docker 自托管部署，**暂不提供桌面安装包**。

- [下载 v0.1.0 ZIP](https://github.com/Pvigors/ApebookLM/archive/refs/tags/v0.1.0.zip)
- [下载 v0.1.0 tar.gz](https://github.com/Pvigors/ApebookLM/archive/refs/tags/v0.1.0.tar.gz)
- [Release、离线嵌入模型包、校验文件与 SBOM](https://github.com/Pvigors/ApebookLM/releases/tag/v0.1.0)

预构建镜像的初始化向导和独立编排见 [Docker 快速启动](docs/QUICKSTART.md)；请使用成功发布记录中的明确标签，旧版 v0.1.0 源码包不含这些新工具。

## 快速开始

### 环境要求

- Docker 24+
- Docker Compose v2
- 至少 4 核 CPU / 8 GB 内存（启用 CAD 时建议）
- Node.js 20（只在本机生成管理员密码配置时需要）

### 1. 获取代码

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/Pvigors/ApebookLM.git
cd ApebookLM
cp .env.example .env
```

### 2. 填写最小配置

至少修改 `.env` 中的以下值：

```dotenv
POSTGRES_PASSWORD=<至少 24 位的随机密码>
DATABASE_URL=postgres://apebooklm:<同一个随机密码>@db:5432/apebooklm
OPENAI_API_KEY=<平台模型接口密钥>
MODEL_API_CONFIG_SECRET=<openssl rand -hex 32 的输出>
EXPORT_FP_SECRET=<另一份独立随机字符串>
```

当前平台模型默认连接通义千问（Qwen）。使用其它供应商时，需要同时填写 `OPENAI_BASE_URL`、`OPENAI_CHAT_MODEL` 和 `OPENAI_VISION_MODEL`；仅修改 Key 不会自动切换供应商。

配置预检会拒绝少于 24 位的弱数据库密码，以及与 `POSTGRES_USER`、`POSTGRES_PASSWORD` 或 `POSTGRES_DB` 不一致的 `DATABASE_URL`。

### 3. 生成首位管理员配置

```bash
read -s ADMIN_CONFIG_PASSWORD
export ADMIN_CONFIG_PASSWORD
node scripts/generate-admin-password-config.mjs --username admin --display-name 系统管理员
unset ADMIN_CONFIG_PASSWORD
```

将命令输出的三项环境变量写入 `.env`。密码不会出现在命令参数或 Git 历史中。如需改用手机验证码或微信开放平台登录，请查看完整配置说明。

### 4. 预检并启动

```bash
chmod 600 .env
docker compose run --rm config-check
docker compose up -d --build
docker compose ps
```

打开 `http://localhost:3000`，点击“已有账号”并选择本地管理员登录；也可直接打开 `http://localhost:3000/admin-login?next=/`，登录后返回工作台。默认端口只绑定 `127.0.0.1`；对公网开放时，请在前面配置 TLS 反向代理。

健康检查：

```bash
curl -fsS http://127.0.0.1:3000/api/health
docker compose exec web node scripts/embed-health.mjs
```

最后一条会验证本地中文嵌入模型。音频转写首次使用时也会下载本地 ASR 模型；网络受限环境请提前准备相应缓存。

首次管理员配置、反向代理、备份恢复、离线嵌入模型和可选服务见 [自托管指南](docs/SELF_HOSTING.md)；全部环境变量见 [配置说明](docs/CONFIGURATION.md)。

## 运行架构

```text
浏览器
  └─ Next.js Web + 非 CAD 任务 worker
       ├─ PostgreSQL 16（用户、笔记本、来源、引用、任务、审计）
       ├─ 媒体卷（上传文件与生成制品）
       ├─ 独立 CAD worker + CAD 卷（FreeCAD / Replicad 验证）
       └─ 可选外部服务（模型、搜索、语音、文档解析、第三方登录）
```

Web 容器包含 Chromium、ffmpeg、espeak-ng 和中文字体；CAD 容器包含 FreeCAD。CAD worker 以非 root、只读根文件系统、去除 capabilities 和资源限制运行。

## 数据、隐私与外部服务边界

- 默认业务数据位于 PostgreSQL、`media-data` 和 `cad-data` 具名卷。
- 启用模型、联网搜索、语音、文档解析或第三方登录后，完成请求所需的来源片段和指令可能发送给对应供应商。
- 公开分享页是只读的；登录用户复制公开笔记本时会获得其完整来源正文和检索分块，因此只应公开你拥有再分发权的资料。
- 匿名公开响应不包含首版 CAD 规格、尺寸和制造文件。
- 如需资料尽可能留在本机，请使用本地模型、本地解析器和离线嵌入缓存，并关闭联网能力。
- `.env*`、`.data/`、数据库备份、用户媒体和真实凭据绝不能提交。

## 本地开发与质量门禁

要求：Node.js 20、PostgreSQL 16。

```bash
npm ci
cp .env.example .env.local
npm run dev
```

测试账号必须使用独立 PostgreSQL 管理连接，不得指向已有业务库：

```bash
PG_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test
npx tsc --noEmit --incremental false
npm run check:public
npm run build
```

当前代码树包含 116 个测试文件和 785 个测试用例。CI 同时检查 TypeScript、公开树泄密 / 企业残留、本地嵌入模型的联网与严格离线路径、Next.js 生产构建、CAD 容器与 FreeCAD 交叉回读，并生成 SBOM。

## 常见问题

### 使用 ApebookLM 需要付费吗？

开源仓库不包含支付或订单模块。界面中的“积分”只是实例内部用于控制模型和生成资源的用量单位，不代表货币价值。模型、搜索、语音或其他第三方服务的费用由你选择的供应商收取。

### 能否完全离线运行？

本地中文嵌入支持导入冻结缓存包并在严格离线模式下校验。但完整业务是否离线还取决于你选择的对话模型、视觉解析、搜索与语音方案。需要完全隔离网络时，应配置本地服务并关闭联网能力。

### 视频来源支持上传本地 MP4 吗？

当前来源导入支持 Bilibili / YouTube 链接的字幕或页面提取，不支持直接上传 MP4、MOV、MKV 或 AVI 作为视频来源。

### 整本 Markdown 导出包含所有制品吗？

Obsidian 友好的 Markdown ZIP 包含笔记、可文本化的智能制品和来源清单。Excalidraw、Drawviso 和 CAD 需分别从对应查看器下载。

## 社区与贡献

- 遇到问题或有功能建议：[创建 Issue](https://github.com/Pvigors/ApebookLM/issues/new/choose)
- 准备提交代码：先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)
- 发现安全问题：不要创建公开 Issue，请按 [SECURITY.md](SECURITY.md) 的流程报告

如果 ApebookLM 对你有帮助，欢迎 **Star 项目、提交 Issue，或分享你的使用方式**。

## 许可证

代码采用 [GNU AGPL v3](LICENSE)。第三方组件见 [NOTICE.md](NOTICE.md)，品牌使用边界见 [TRADEMARKS.md](TRADEMARKS.md)，图片资产见 [ASSET_LICENSES.md](ASSET_LICENSES.md)。
