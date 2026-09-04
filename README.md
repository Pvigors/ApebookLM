# ApebookLM（猿笔记）

ApebookLM 是一个面向中文资料的、模型中立且可自托管的研究工作台。它把网页、PDF、公众号、视频、音频和本地文档汇入同一个笔记本，支持带原文引用的问答，并可生成报告、演示文稿、导图、测验、表格、音视频和 CAD 等制品。

> 本项目是独立开源项目，与 Google 或 NotebookLM 无隶属、授权或合作关系。

## 主要能力

- 多来源导入、分块、嵌入与检索
- 带引用回答，支持回到原始来源
- 用户自带模型 API Key，兼容多种 OpenAI 风格接口
- 19 类智能制品与异步任务队列
- STEP/STL CAD 生成、二维 DXF 顶视投影和独立 FreeCAD 回读验证
- 私有笔记本、协作、公开分享和 Markdown 导出
- PostgreSQL、Docker Compose、后台权限与审计

积分只是实例内部用于控制模型与生成资源的用量单位，不代表货币价值。

## 快速开始

要求：Docker 24+、Docker Compose v2，以及至少 4 核 CPU / 8GB 内存（启用 CAD 时）。

```bash
cp .env.example .env
```

至少修改 `.env` 中的：

```dotenv
POSTGRES_PASSWORD=请替换为随机密码
DATABASE_URL=postgres://apebooklm:同一个随机密码@db:5432/apebooklm
OPENAI_API_KEY=你的模型接口密钥
MODEL_API_CONFIG_SECRET=64位随机十六进制字符串
EXPORT_FP_SECRET=另一份独立随机字符串
```

随后启动：

```bash
chmod 600 .env
docker compose run --rm config-check
docker compose up -d --build
```

配置预检会拒绝少于 24 位的弱数据库密码，以及与 `POSTGRES_USER`、
`POSTGRES_PASSWORD` 或 `POSTGRES_DB` 不一致的 `DATABASE_URL`；正式启动也会自动执行同一检查。

访问 `http://localhost:3000`。健康检查：

```bash
curl -fsS http://127.0.0.1:3000/api/health
docker compose exec web node scripts/embed-health.mjs
```

最后一条验证本地嵌入模型。隔离网络部署可在联网机器导出带版本、许可和 SHA-256
清单的模型缓存包，再导入目标实例并设置 `LOCAL_EMBED_OFFLINE=1`；完整步骤见自托管指南。

首次管理员配置、反向代理、备份恢复与可选服务见 [自托管指南](docs/SELF_HOSTING.md)；全部环境变量见 [配置说明](docs/CONFIGURATION.md)。

## 本地开发

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

## 数据与外部服务边界

- 默认数据保存在 PostgreSQL 和 Docker 具名卷中。
- 模型、联网搜索、语音、文档解析与第三方登录均为可选外部服务。
- 启用外部服务后，完成请求所需的来源片段和指令可能发送给对应供应商。
- 如需资料完全留在本机，请配置本地模型与本地解析器，并关闭联网能力。
- `.env*`、`.data/`、数据库备份、用户媒体和真实凭据绝不能提交。

## 许可证

代码采用 [GNU AGPL v3](LICENSE)。第三方组件见 [NOTICE.md](NOTICE.md)，品牌使用边界见 [TRADEMARKS.md](TRADEMARKS.md)，图片资产见 [ASSET_LICENSES.md](ASSET_LICENSES.md)。

安全问题请勿创建公开 Issue，参见 [SECURITY.md](SECURITY.md)。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

首次对外发布必须从审查后的文件树创建干净的单根提交；不要把内部私有仓库的既有历史直接改为公开。
