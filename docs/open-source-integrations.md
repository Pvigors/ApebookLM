# Docling、Crawl4AI、LangGraph.js、LiteLLM 嵌入说明

> 当前阶段：代码已接入、默认全部关闭；生产启用仍需固定镜像签名、真实 sidecar 联调、资源压测与灰度观察。不要把本地/Mock 通过写成生产可用。

## 1. 设计边界

- ApebookLM 仍是账号、租户、来源、引用、任务、积分、制品和审计的唯一真源。
- Docling/Crawl4AI/LiteLLM 是独立共享服务，不进入蓝绿 Web Compose，不连接业务数据库，不挂载媒体目录。
- 原 PDF/网页解析器与主备模型直连长期保留，作为回滚边界。
- LangGraph.js 首期只编排测验外层阶段；现有 PostgreSQL jobs 继续负责 durable queue、`run_attempt`、积分扣减、退回和发布事务。

## 2. Docling 与 Crawl4AI

### 启动共享 sidecar

```bash
DEPLOY_USER="$(id -un)"; DEPLOY_GROUP="$(id -gn)"
sudo install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" /etc/apebooklm
sudo install -m 0600 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" \
  deploy/extractors/extractors.env.example /etc/apebooklm/extractors.env
# 用 sudoedit 将两个 CHANGE_TO_* 替换为不同的、至少 32 字符随机密钥
sudoedit /etc/apebooklm/extractors.env
node scripts/open-source-services-preflight.mjs --extractors /etc/apebooklm/extractors.env
docker compose -f deploy/extractors/docker-compose.yml \
  --env-file /etc/apebooklm/extractors.env -p apebooklm-extractors up -d
```

这份 Compose 是“同一台宿主机、独立容器”模式：不映射宿主机端口，只加入既有 `apebooklm_default` 网络：

- `http://docling:5001`
- `http://crawl4ai:11235`

它不是跨主机网络合同。现役 2C4G 机器不能启动这两个 sidecar；若部署到独立节点，需先另行提供私网 DNS/LB 或 overlay、TLS/mTLS、ACL 和健康检查，再将 Web 中的 URL 指向该私网端点。处理器 URL 必须使用 RFC1918 私网 IP 或受控 `.internal` 域名（并配合 egress ACL）；普通公网 FQDN 默认拒绝。在这些条件没有验收前，保持 `MODE=off`。

Web 环境先配置 `MODE=shadow` 与 5% 稳定灰度：

```dotenv
NBLM_DOCLING_MODE=shadow
NBLM_DOCLING_URL=http://docling:5001
NBLM_DOCLING_API_KEY=<与 sidecar 一致>
FLAG_DOCLING_EXTRACT_PCT=5

NBLM_CRAWL4AI_MODE=shadow
NBLM_CRAWL4AI_URL=http://crawl4ai:11235
NBLM_CRAWL4AI_API_TOKEN=<与 sidecar 一致>
FLAG_CRAWL4AI_EXTRACT_PCT=5
```

模式：

- `off`：只走原生解析，立即回滚。
- `shadow`：原生结果为真源；外部结果只记录长度/质量对照。
- `primary`：外部结果通过实质正文和导航壳门后使用；超时、鉴权、空输出、薄内容等自动回原生。

安全约束：

- Docling 只收服务器已有的 PDF 字节，只调用 `/v1/convert/file`，从不接收用户 URL。
- Crawl4AI 只用于普通网页；微信、B站、YouTube、PDF 直链保持现有专属/native 链。
- URL 在应用侧先做公网 DNS 预检，Crawl4AI 0.9.2 在真正建连/重定向处再次执行 egress 防护。
- Sidecar Base URL 默认只允许本机、Docker 单标签或私网；公网处理器需 `NBLM_EXTERNAL_PROCESSOR_ALLOW_PUBLIC=1` 明确授权。
- 响应按字节上限读取后才解析 JSON，错误不回显密钥或 sidecar 地址。

来源会保存：`extraction_backend`、`extraction_version` 与 `extraction_meta`。它们和正文、页数、chunks 在同一个摄取 claim 事务中换版，避免“正文 A + 引擎 B 元数据”。

## 3. LangGraph.js

启用需同时满足总闸与稳定灰度：

```dotenv
NBLM_LANGGRAPH_QUIZ_ENABLED=1
FLAG_LANGGRAPH_QUIZ_PCT=5
```

首期固定节点：

```text
START → prepare → generate → verify → complete → END
```

每个节点都会更新现有 job 进度；取消、换代或 300 秒硬超时会 abort 测验模型请求，禁止继续切备用模型。

当前明确限制：首期尚未接入 LangGraph 持久 checkpointer，跨进程恢复仍由 jobs 重新执行该 attempt。不要宣称“从模型内部轮次断点恢复”。后续接 PostgresSaver 前必须先解决跨 attempt Token 累计、thread 隔离、保留清理和 schema 迁移。

## 4. LiteLLM

LiteLLM 必须独立部署，不能随 blue/green 各起一套：

```bash
DEPLOY_USER="$(id -un)"; DEPLOY_GROUP="$(id -gn)"
sudo install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" /etc/apebooklm
sudo install -m 0600 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" \
  deploy/litellm/litellm.env.example /etc/apebooklm/litellm.env
# master key 必须以 sk- 开头；salt key 创建后固定保存，不得每次启动重生成。
# PostgreSQL 密码会进入 DATABASE_URL，请用 `openssl rand -hex 32` 生成 URL-safe 值。
sudoedit /etc/apebooklm/litellm.env
node scripts/open-source-services-preflight.mjs --litellm /etc/apebooklm/litellm.env
docker compose -f deploy/litellm/docker-compose.yml \
  --env-file /etc/apebooklm/litellm.env -p apebooklm-litellm up -d
```

同 sidecar 模板一样，这份 Compose 仅支持与 Web 同宿主机的 Docker 内网模式。独立节点需先完成私网/TLS/ACL 方案；不得为了连通性直接把 4000 端口暴露到公网。

启动后用 master key 创建只允许 `apebook-chat` / `apebook-vision` 的受限 Virtual Key。Web 仅保存该 Virtual Key：

```dotenv
LITELLM_ENABLED=0
LITELLM_BASE_URL=http://litellm-gateway:4000
LITELLM_API_KEY=<受限 Virtual Key，绝不是 master key>
LITELLM_CHAT_MODEL=apebook-chat
LITELLM_VISION_MODEL=apebook-vision
LITELLM_EMERGENCY_DIRECT=0
```

也可在后台“模型与外部服务 → 内网模型网关”完成：

1. 保存配置（强制保持未启用）。
2. 通过 readiness、模型别名和最小请求测试。
3. 测试通过后才允许点击启用。

路由语义：

- 网关关闭：保持原主模型 → 备用模型行为。
- 网关开启：先走稳定 alias，SDK `maxRetries=0`；供应商 fallback 由网关控制。
- 只有连接建立前明确的连接拒绝、DNS 或路由不可达，且显式开启 `emergencyDirect`，才进入原直连链。
- 连接重置可能发生在网关已转发请求之后，因此与已开始的流一样禁止旁路，避免双重生成/双计费。
- 401/403/429、模型错误、网关超时、已开始的流均禁止旁路，避免绕过预算或重复计费。
- 猿笔记 Token/积分账本仍是结算真源，LiteLLM spend 只做对账。

## 5. 发布前门禁

1. `npm ci`、TypeScript、全量测试、生产构建。
2. Docling：中文扫描 PDF、双栏、表格、公式、25MB/页数/响应上限、超时和 partial。
3. Crawl4AI：普通文章、JS 页面、导航壳、302→私网、DNS rebinding、401/429/5xx。
4. LangGraph：四阶段、取消、硬超时、旧 run_attempt 回写、单一产物与积分退回。
5. LiteLLM：真实容器 + 假上游顺序 fallback、Virtual Key alias 限制、流式 usage、故障直连边界。
6. 镜像 digest、Cosign、SBOM、LICENSE/NOTICE、模型卡；当前只有 LiteLLM 固定 digest，Docling/Crawl4AI/PostgreSQL 禁止在生产启动，直到发布时冻结并验证 digest。
7. 资源压测：当前 2C4G 生产机不允许同机启动 Docling + Crawl4AI + LiteLLM；必须使用独立节点或先扩容。
8. Crawl4AI 当前容器参数含 Chromium `--no-sandbox`；生产启用前必须在真实 Linux 验证 userns/seccomp 后去掉该参数，或使用独立隔离网络与出网 ACL。
9. 灰度 `5% → 25% → 50% → 100%`，每档至少观察成功率、P95、OOM、fallback code 和积分/Token 对账。
