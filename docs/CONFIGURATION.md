# 配置说明

真实值只应写入部署环境或本地 `.env` 文件，不得提交到 Git。

## 核心配置

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | PostgreSQL 连接串 |
| `HOST_PORT` | 否 | Compose 暴露到宿主机的端口，默认 `3000`；不会改变容器内端口 |
| `SELF_HOSTING_DATABASE_MODE` | Compose 是 | `compose` 使用内置 PostgreSQL；`external` 使用外部数据库 |
| `LOCAL_EMBED_OFFLINE` | 否 | `1` 时严格只读本地嵌入缓存，缺失或损坏会拒绝启动相关能力且不联网 |
| `POSTGRES_USER/PASSWORD/DB` | Compose | 内置 PostgreSQL 的初始化参数 |
| `OPENAI_API_KEY` | 是 | 主模型接口密钥 |
| `OPENAI_BASE_URL` | 按供应商 | OpenAI 兼容接口地址 |
| `OPENAI_CHAT_MODEL` | 建议 | 对话模型名称 |
| `OPENAI_VISION_MODEL` | 使用视觉能力时 | 视觉模型名称 |
| `MODEL_API_CONFIG_SECRET` | 是 | 加密用户个人 API Key 的独立主密钥 |
| `EXPORT_FP_SECRET` | 是 | 导出追溯指纹的独立密钥 |
| `PUBLIC_ORIGIN` | 公网部署 | 精确 HTTPS Origin，不带尾斜杠 |

## 管理员与登录

- `ADMIN_PASSWORD_LOGIN_ENABLED`、`ADMIN_PASSWORD_ACCOUNT_B64`：独立管理员入口。
- `ALIYUN_SMS_*`：可选短信验证码服务，仅从部署环境读取，不进入数据库或后台页面。
- `WECHAT_APP_ID/SECRET`：可选微信开放平台登录，仅从部署环境读取，不进入数据库或后台页面。

社区版不包含公众号、关注增长或固定运营账号配置，不会内置固定账号，也不支持通过环境变量把手机号或微信账号隐式提升为管理员。请使用独立管理员密码配置完成首次初始化。

## 模型和处理器

- `FALLBACK_*`：备用模型。
- `LITELLM_*`：可选内网模型网关。
- `NBLM_DOCLING_*`：可选文档解析 sidecar。
- `NBLM_CRAWL4AI_*`：可选网页解析 sidecar。
- `TAVILY_API_KEY`、`BOCHA_API_KEY`、`ZHIPU_SEARCH_KEY`、`SERPER_API_KEY`：可选联网搜索。
- `MINIMAX_API_KEY/GROUP_ID`：可选语音生成。
- `AIPPT_API_KEY`：可选演示文稿服务。

## 运行与安全

- `TRUSTED_PROXY_HOPS`：可信反向代理层数；直连时设为 `0`。
- `NBLM_WORKER_ENABLED`：任务处理总开关。
- `NBLM_NON_CAD_WORKER_ENABLED`、`NBLM_CAD_WORKER_ENABLED`：worker 车道开关。
- `NBLM_CAD_ENABLED`：CAD 用户入口开关；官方 Compose 默认 `1`，服务未就绪时生成预检仍会在扣分前拒绝。
- `CAD_REQUIRE_EXTERNAL_STEP_VALIDATOR`：正式 CAD 输出应保持开启。
- `NBLM_EXTERNAL_PROCESSOR_ALLOW_PUBLIC`：默认 `0`，避免把完整资料发送到公网处理器。

变量的默认值、格式与更完整注释以 `.env.example` 为准。
