# 预构建镜像快速启动

这条路径用于单机试用：拉取 Web、CAD worker 与配置预检镜像，启动内置 PostgreSQL。
无需在本机安装应用依赖或编译镜像；初始化向导只需要 Node.js 20。

**当前边界：本次变更提供发布工作流与启动工具，并不代表镜像已经发布。已有 `v0.1.0`
GitHub Release 不附带这套 GHCR 镜像。** 请先在维护者的成功发布记录中取得明确的镜像标签；
没有记录时使用 [源码构建指南](SELF_HOSTING.md)，不要直接填写 `v0.1.0`、`main` 或 `latest`。

## 1. 准备

- 安装支持 `docker compose up --wait` 的 Docker Engine/Desktop 与 Compose v2，以及 Node.js 20。
- 首轮发布只验证 `linux/amd64`。Apple Silicon/ARM 主机需要 Docker 的 amd64 仿真，速度更慢，
  尚未完成原生 ARM 验收；不要把它当作已支持的原生 ARM 部署。
- 建议给 Docker 至少 8 GB 内存、4 核和 20 GB 可用磁盘，作为单人试用起点；实际需求随文档和生成任务变化。
  CAD 容器单独限制为 3 GB、2 核，其它服务还需要资源。
- 准备一个 OpenAI 兼容模型服务的 HTTPS 地址、API Key 和该服务实际支持的聊天/视觉模型名称。
- 能访问 GHCR、Docker Hub 与嵌入模型下载源；嵌入模型约 90 MB，首次启动后需要单独验证。

获取仓库，并切换到**发布记录注明的源码标签或完整提交**。镜像和编排应来自同一次发布。
下面的占位文字需要替换，不能原样运行：

```bash
git clone https://github.com/Pvigors/ApebookLM.git
cd ApebookLM
git checkout <发布记录中的源码标签或完整SHA>
node scripts/init-self-hosting.mjs
```

向导会要求填写已发布的 `vX.Y.Z` 或 `sha-完整40位提交` 镜像标签、站点地址、管理员用户名和密码、模型配置。
数据库密码、个人模型加密密钥、导出密钥与预留会话密钥分别随机生成，数据库连接串自动保持一致。
管理员密码只保存 scrypt 哈希，配置有效期 365 天。密码与 API Key 输入不回显，也不会打印到输出。
视觉模型留空表示明确使用同一聊天模型，此时它必须支持图片输入；纯文本模型用户应单独填写同一网关下可用的视觉模型。
留空不会关闭图片理解，也不会回落到另一供应商的默认模型。向导尚不验证模型能力或供应商额度。

向导只创建新 `.env`，权限为 `0600`；遇到既有文件或符号链接会拒绝，**不会自动轮换或覆盖密钥**。
需要独立配置时用 `node scripts/init-self-hosting.mjs --env /绝对路径/.env`，后续每条 Compose 命令都增加
`--env-file /绝对路径/.env`。`ENV_FILE` 已自动指向这份文件。
不要将配置、展开后的 Compose 环境、管理员密码或 API Key 发到 Issue。

## 2. 拉取与启动

在仓库根目录运行，使用这份独立编排，不与 `docker-compose.yml` 合并：

```bash
node scripts/self-hosting-preflight.mjs --env .env
docker compose -f docker-compose.quickstart.yml pull
docker compose -f docker-compose.quickstart.yml run --rm --no-deps config-check
docker compose -f docker-compose.quickstart.yml up -d --no-build --wait --wait-timeout 240
docker compose -f docker-compose.quickstart.yml ps
```

预检容器不联网，只接收数据库配置；数据库健康后 Web 才启动，Web 完成空库初始化后 CAD worker 才启动。
CAD 保留独立 FreeCAD 回读、非 root、只读根目录、受限临时目录和资源配额。不会用关闭回读门禁来绕过启动失败。

本机打开 [http://localhost:3000/admin-login?next=/](http://localhost:3000/admin-login?next=/)，用向导填写的管理员账号登录后进入工作台。
本机试用的 `PUBLIC_ORIGIN` 默认值是 `http://localhost:3000`，访问时保持相同域名和端口；
Docker 生产模式使用 Secure Cookie，浏览器的 localhost 特例通常允许本地登录，若浏览器拒绝则配置 HTTPS。
在服务器部署时，先按 [完整指南](SELF_HOSTING.md) 配置 HTTPS 反向代理，并把 `PUBLIC_ORIGIN` 改为准确公网 Origin。
端口始终仅绑定 `127.0.0.1`，不会自动开放公网端口。

## 3. 首次验证

```bash
curl -fsS http://127.0.0.1:3000/api/ready
docker compose -f docker-compose.quickstart.yml exec web node scripts/embed-health.mjs
docker compose -f docker-compose.quickstart.yml exec cad-worker node scripts/cad-cross-validator-health.mjs
```

`/api/ready` 成功说明数据库与 Web 就绪；嵌入健康检查成功后，首次下载的模型留在持久卷。
网络受限时在 `.env` 增加可信 `HF_ENDPOINT`，或按 [离线模型步骤](SELF_HOSTING.md) 导入经校验缓存。
容器健康还不能证明供应商 Key、模型名称和额度有效；登录后继续验证“导入一份文档 → 带引用问答 → 生成一种制品”。

常见问题：

| 现象 | 检查 |
| --- | --- |
| `manifest unknown` / `denied` | 目标标签尚未发布，或三个 GHCR 包尚未设为公开；先查发布记录，不要临时改用 `latest`。 |
| `no matching manifest` / 仿真失败 | 首轮仅 amd64；确认 Docker 的平台支持，ARM 用户可按完整指南源码构建并自行验证。 |
| `config-check` 失败 | 检查 `.env` 权限、随机数据库密码与 `DATABASE_URL` 是否一致；不要贴出配置值。 |
| Web 或 CAD 一直 unhealthy | 查看对应服务日志；检查可用内存、数据库就绪、FreeCAD 回读。配置预检成功退出的状态是正常现象。 |
| 嵌入下载失败 | 查看模型健康检查，确认网络或导入冻结缓存；容器 running 不能代替模型就绪。 |
| 登录/模型设置提示来源错误 | 浏览器地址必须与 `PUBLIC_ORIGIN` 一致，反向代理须正确传递 Origin/Host。 |

## 4. 停止、备份与更新

```bash
docker compose -f docker-compose.quickstart.yml stop
docker compose -f docker-compose.quickstart.yml start
```

数据分别保存在 `postgres-data`、`media-data`、`cad-data` 三个具名卷中。卸载或更新前按完整指南备份；
不要在未确认备份前删除卷或运行 `down -v`。如果此前已用源码编排启动实例，这份编排在同一目录会使用同一
Compose 项目与卷，属于更新现有实例；不要把它作为“全新测试”。测试另用目录与 `-p` 项目名，并保持端口不冲突。

更新时先备份并阅读变更，切换到目标源码版本，然后修改既有 `.env` 的 `APEBOOKLM_IMAGE_TAG` 为已发布标签，
重新执行 `pull`、`up -d --no-build --wait` 与上述验证。不要重新运行向导生成另一套密钥替换原实例。
要逐镜像固定 digest，可以将编排中三个 `image` 值分别设为发布证据里的 `ghcr.io/...@sha256:...`；
tag 是可变引用，生产留档应保留 registry digest。

## 维护者：首次发布镜像

工作流为 [`.github/workflows/publish-images.yml`](../.github/workflows/publish-images.yml)。
提交必须已在默认分支通过现有 `CI` 的全部 job；发布前会检查同一完整 SHA 的成功运行。
在 Actions 中手动运行 **Publish container images**，`ref` 填完整 SHA，即发布 `sha-<完整SHA>` 镜像。
只有版本标签与 `package.json` 版本一致时，才可通过推送 `vX.Y.Z` 标签或手动填该标签发布版本镜像。
不要重打旧 release 标签或把新 main 内容贴成 `v0.1.0`。首次新版本需要先同步包版本与锁文件。

工作流会构建原 Dockerfile 的 `runner`、`cad-runner`、`config-validator` 三个目标，在发布前运行
FreeCAD 原生检查、跨工具 STEP 门禁、全新临时数据库上的完整 quickstart 就绪检查，然后推送**同一批已测试镜像**。
模型供应商调用与嵌入模型下载不在这次容器就绪测试中；同一源码的现有 CI 另行检查嵌入模型。
发布使用短期 `GITHUB_TOKEN`；仅发布 job 获得 `packages: write`，无仓库写权限，不创建 GitHub Release。

镜像前缀跟随仓库，例如当前仓库为：

```text
ghcr.io/pvigors/apebooklm-web:<tag>
ghcr.io/pvigors/apebooklm-cad:<tag>
ghcr.io/pvigors/apebooklm-config-validator:<tag>
```

**首次 GHCR 发布默认可能是 private**。维护者应在三个包的设置中确认与仓库关联，并把可见性设为 Public；
再用未登录 GHCR 的环境分别匿名拉取三个镜像，完整运行一次本指南，最后才能对外宣称“可直接拉取”。
这属于 [GHCR 的可见性与权限规则](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。
Fork 的维护者还需在向导中改为自己的小写镜像前缀。

运行摘要与 `container-release-evidence-<tag>` artifact 保留源码 SHA、平台、Web/CAD SPDX 清单、
本地 image ID 与 registry digest，artifact 保留 90 天；正式发布需自行存档。发布前逐项检查目标标签，
任何一个已存在就拒绝覆盖；网络或鉴权状态不明确也拒绝发布。标签推送与手动发布串行运行。
若中途推送失败，GHCR 可能只收到部分镜像；不要宣传该次发布，先核查已上传内容，再用新提交/新版本完成一整套发布。
同一标签无法直接重跑覆盖。工作流不能阻止具有包写权限的其它发布者在外部改写标签，生产仍应留存并固定 digest。
