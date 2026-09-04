# 自托管指南

## 1. 准备配置

复制 `.env.example` 为 `.env`，至少配置 PostgreSQL、主模型、个人模型密钥加密和导出指纹四组参数。所有密钥应使用独立随机值，文件权限建议设为 `0600`。

生成随机值示例：

```bash
openssl rand -hex 32
```

Compose 自带数据库使用 `SELF_HOSTING_DATABASE_MODE=compose`。数据库密码必须至少
24 位、包含足够字符变化并只使用 URL-safe 字符；`DATABASE_URL` 中的用户名、密码和
数据库名必须分别与 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB` 一致，主机为
`db:5432`。模板刻意留空；未填写、使用弱口令或两处不一致时，Compose 会在数据库启动前拒绝继续。

写好配置后先执行一次显式预检：

```bash
chmod 600 .env
docker compose run --rm config-check
```

该容器不联网，只接收数据库配置且不会输出凭据。主机已安装 Node.js 20 时，也可运行
`npm run preflight:self-hosting` 做同一检查。使用外部 PostgreSQL 时设置
`SELF_HOSTING_DATABASE_MODE=external`，并按编排注释删除内置 `db` 服务和相应依赖。

## 2. 配置首位管理员

社区版不会自动创建固定账号。推荐使用独立管理员密码配置：

```bash
read -s ADMIN_CONFIG_PASSWORD
export ADMIN_CONFIG_PASSWORD
node scripts/generate-admin-password-config.mjs --username admin --display-name 系统管理员
unset ADMIN_CONFIG_PASSWORD
```

把命令输出的三项环境变量写入 `.env`，不要保存或提交明文密码。启动后从 `/admin-login` 登录。

## 3. 启动

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
docker compose exec web node scripts/embed-health.mjs
```

最后一条会首次下载并验证本地嵌入模型；成功后模型保存在 `media-data` 卷中，
重建容器不会重复下载。若网络受限，请配置可直出文件的 `HF_ENDPOINT`，或把已经
完整下载的 Transformers.js 缓存预置到该卷。不要仅以数据库健康代替嵌入模型就绪。

需要把模型带入隔离网络时，在一台能联网且已启动 Web 容器的机器上生成冻结缓存包：

```bash
docker compose exec web node scripts/embed-health.mjs
docker compose exec web node scripts/embed-cache.mjs export \
  --cache-dir /app/.data/models --output /app/.data/embed-cache-bundle
docker compose cp web:/app/.data/embed-cache-bundle ./embed-cache-bundle
```

首个社区版同时在 GitHub Release 提供相同的审计缓存包，可在能访问 GitHub 的机器上下载：

```bash
curl -fL https://github.com/Pvigors/ApebookLM/releases/download/v0.1.0/apebooklm-bge-small-zh-v1.5-r75c43b0.tar.gz \
  -o apebooklm-bge-small-zh-v1.5-r75c43b0.tar.gz
echo 'e010796d658fc4d4598d5e00095121b704208ed85a66139552cac3caeba084a8  apebooklm-bge-small-zh-v1.5-r75c43b0.tar.gz' \
  | sha256sum -c -
tar -xzf apebooklm-bge-small-zh-v1.5-r75c43b0.tar.gz
```

缓存包内仍会再次逐文件核对固定 revision、大小、SHA-256 和 MIT 许可；外层压缩包校验不能替代导入检查。

把整个 `embed-cache-bundle` 目录传到离线主机后导入持久卷：

```bash
docker compose cp ./embed-cache-bundle web:/tmp/embed-cache-bundle
docker compose exec web node scripts/embed-cache.mjs verify --bundle /tmp/embed-cache-bundle
docker compose exec web node scripts/embed-cache.mjs import \
  --bundle /tmp/embed-cache-bundle --cache-dir /app/.data/models
```

然后在 `.env` 设置 `LOCAL_EMBED_OFFLINE=1`，重建 Web 容器并做严格离线推理检查：

```bash
docker compose up -d --force-recreate web
docker compose exec web node scripts/embed-health.mjs
```

缓存包固定到经过审计的 `Xenova/bge-small-zh-v1.5` revision，并逐文件验证大小与
SHA-256；缺文件、篡改、额外文件或符号链接都会拒绝导入。严格离线模式下缓存缺失会
直接失败，且不会回退到网络下载。主机直接运行时，可用 `npm run embed:health` 与
`npm run embed:cache -- <verify-cache|export|verify|import|recover> ...` 执行同一流程。
导入进程被意外中止后，可运行 `npm run embed:cache -- recover` 清理死亡进程残留并安全恢复有效备份。

默认仅绑定本机 `127.0.0.1:3000`。需要改宿主机端口时设置 `HOST_PORT`；容器内端口固定为 3000，不能通过 `PORT` 改写。如需公网访问，请使用反向代理终止 TLS，并把 `PUBLIC_ORIGIN` 设置为准确的 HTTPS Origin。

## 4. 数据持久化

Compose 创建三个具名卷：

- `postgres-data`：业务数据库
- `media-data`：音视频、图片等生成物
- `cad-data`：CAD 文件，供 Web 与独立 CAD worker 共同访问

升级或重建容器不会自动删除具名卷。不要在未确认备份前执行带 `-v` 的关闭命令。

## 5. 备份与恢复

数据库使用 `pg_dump -Fc`；媒体卷和 CAD 卷需要一起备份。仓库中的 `scripts/backup.sh` 可作为对象存储备份示例，但运行前必须显式配置 `DATABASE_URL`、`OSS_BUCKET` 和 `MEDIA_DIR`。

恢复必须先在临时数据库中演练，核对用户、笔记本、来源、任务与制品数量后再切换。

## 6. 可选服务

Docling、Crawl4AI 与 LiteLLM 的独立编排见 `deploy/`。它们默认关闭，不影响基础启动。启用前应固定镜像摘要、配置访问令牌并确认不会把敏感资料发送到未批准的公网服务。

CAD 使用独立 worker 和 FreeCAD STEP 回读。生产用途应保持 worker 非 root、只读根文件系统和资源上限，不应绕过独立回读门禁。

## 7. 升级

1. 备份数据库与全部媒体卷。
2. 阅读版本说明和数据库变更。
3. 拉取明确的 tag，不要直接跟随浮动分支。
4. 重新构建并等待健康检查通过。
5. 验证登录、导入、引用问答和至少一个制品生成。

社区版不附带官方 SLA。需要高可用时，应外置 PostgreSQL、使用共享对象存储并为 Web 与 worker 建立独立监控。
