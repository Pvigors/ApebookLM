# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# =============================================================================
# ApebookLM 多阶段镜像
#   dependencies 阶段:安装原生编译链并执行 npm ci。
#   build 阶段:从缓存依赖生成 Next standalone 产物。
#   runtime 阶段:按 Web/CAD 分别安装运行期系统依赖，再合并 standalone 产物。
# 运行期数据:业务数据在 PostgreSQL(db 服务 / 阿里云 RDS,见 DATABASE_URL);
# 生成的音视频 / 信息图等媒体在 /app/.data,由 volume 挂载,不进镜像 —— 见 docker-compose.yml。
# =============================================================================

# ---------- 独立配置预检 ----------
# 放在 builder 前，确保没有 BuildKit 的旧版 Docker 也只需构建这个轻量阶段。
# 该目标只含纯 Node 校验脚本；Compose 在启动数据库前运行它，弱口令或不一致配置会
# 直接阻止后续服务启动。它不接收模型/API 密钥，也不需要网络。
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS config-validator
WORKDIR /app
COPY scripts/self-hosting-preflight.mjs ./scripts/self-hosting-preflight.mjs
USER node
ENTRYPOINT ["node", "scripts/self-hosting-preflight.mjs", "--from-environment"]

# ---------- 依赖阶段 ----------
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS dependencies
WORKDIR /app

# 构建在国内(阿里云 ECS)进行:deb.debian.org 与 registry.npmjs.org 直连极慢,
# npm ci 曾整整 41 分钟零 CPU 挂死在等 npm 官方源响应(连接悬着又不超时)。
# 两个源都换成国内镜像,构建时间从数小时降到十几分钟。
# 境外构建可用 --build-arg 覆盖回官方源。
ARG APT_MIRROR=deb.debian.org
ARG NPM_REGISTRY=https://registry.npmjs.org
# node-gyp 编译原生模块时,要另外去 nodejs.org 下载 node 头文件 ——
# 那是**独立于 npm registry** 的地址,只配 registry 挡不住它。国内直连 nodejs.org
# 会 ECONNRESET,导致 npm ci 在需要编译的包上失败。
# 这个问题此前一直被 Docker 层缓存掩盖:npm ci 那层没重跑就不会暴露,
# 一旦缓存失效(比如一次构建中途失败)就会突然"无缘无故"构建不过。
ARG NODE_DISTURL=https://nodejs.org/download/release/
# 同理:node-pre-gyp 取预编译二进制走的又是另一个地址(GitHub releases)。见下方 canvas 一段。
ARG CANVAS_BINARY_MIRROR=

# onnxruntime-node(本地嵌入)等原生包需要 python3 + make + g++ 从源码编译;
# 运行期数据库走 pg(纯 JS,无需编译)。
# ffmpeg 在构建期无需,装 chromium 依赖在 runtime 阶段做,这里只留编译链。
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 先只拷 package 清单,利用 Docker 层缓存:依赖没变则跳过重装。
COPY package.json package-lock.json* ./
# x-data-spreadsheet 1.1.9 的 editor 将用户文本写入 innerHTML。postinstall 在 npm ci
# 阶段执行确定性 fail-closed 补丁，因此脚本必须先于依赖安装进入 builder。
COPY scripts/patch-x-data-spreadsheet.mjs ./scripts/patch-x-data-spreadsheet.mjs
COPY scripts/patch-excalidraw-worker.mjs ./scripts/patch-excalidraw-worker.mjs
# npm 安装期一共会碰三类地址,只配 registry 挡不住后两类:
#   1. registry        —— 包本体,已换 npmmirror
#   2. node 头文件      —— node-gyp 编译原生模块时去 nodejs.org 取。disturl 属于 node-gyp 而非
#      npm(npm 10 对 `npm config set disturl` 直接报 "not a valid npm option"),
#      只能通过 npm_config_* 环境变量传。
#   3. 预编译二进制     —— node-pre-gyp 去 GitHub releases 取。见下面 canvas 一段。
ENV npm_config_disturl=${NODE_DISTURL}

# canvas 由 linkedom / unpdf 间接带入(在 unpdf 里本就是 optionalDependency),
# 应用代码一处都没 import 它。但它的安装脚本 `node-pre-gyp install --fallback-to-build`
# 默认去 https://github.com/Automattic/node-canvas/releases/download/ 拉二进制 ——
# 国内不报错,而是**长时间挂死**(实测:CPU 30 秒零增长,容器网络命名空间里挂着一条
# 到 185.199.x.x:443 的 ESTAB 连接;宿主机 ss 看不到它,得 nsenter 进容器 netns 才看得见)。
#
# 曾用 `npm ci --omit=optional && npm i --no-save sharp` 绕开,那是错的,实测两处翻车:
#   a) --omit=optional 的误伤面极大:**所有平台二进制包都在 optionalDependencies 里** ——
#      @next/swc-linux-x64-gnu(Next 原生编译器)、@esbuild/*(26 个)、@img/sharp-*、
#      @unrs/resolver-binding-*,全被一起砍掉;
#   b) 而紧随其后的 `npm i --no-save sharp` 会重算整棵树,把**刚砍掉的 optional 又全部装回来**
#      (实测:@esbuild/*、@img/sharp-* 悉数复原,canvas 与 @mapbox/node-pre-gyp 也一并回来)。
#      两条命令自相抵消,净效果和裸 `npm ci` 没差别 —— canvas 照样去 GitHub、照样挂死,
#      只是挂死点从前一条命令挪到了后一条。服务器上那次构建正是停在第二条上。
#
# 正确做法:不动 optional,只把 node-pre-gyp 的下载源指到国内镜像。
# 变量名规则是 npm_config_<binary.module_name>_binary_host_mirror,canvas 的 module_name 就是 canvas。
# 实测:请求从 github.com 完全改到 cdn.npmmirror.com,且
# canvas-v2.11.2-node-v115-linux-glibc-x64.tar.gz(node:20-slim 对应的 ABI/平台)在镜像上是 200。
# 就算镜像哪天缺档也只是 404 快速失败 → --fallback-to-build 源码编译失败 →
# 因 canvas 是 optional 被 npm 静默跳过,不会再挂死。
ENV npm_config_canvas_binary_host_mirror=${CANVAS_BINARY_MIRROR}

# onnxruntime-node 是同一类问题的第二处,而且比 canvas 更隐蔽 —— 它是**硬依赖**,
# 任何形态的 npm 安装都会跑它的 postinstall,没有哪个 --omit 开关能顺带挡住。
# 该脚本(node_modules/onnxruntime-node/script/install.js)的触发条件是
# `linux && x64 && bin 目录存在 && libonnxruntime_providers_cuda.so 不存在` —— 生产机三条全中;
# 更坑的是它检测不到 nvcc 时并不跳过,而是 `let ver = 12` 默认按 CUDA 12 继续下载(:150,:162),
# 所以**没有 GPU 的 ECS 照样会去拉**
# https://github.com/microsoft/onnxruntime/releases/download/v1.21.0/onnxruntime-linux-x64-gpu-1.21.0.tgz。
# 它用裸 https.get(:101),既没有超时也没有 error 监听 —— 静默丢包时会无限期挂死。
# 而我们只做 CPU 推理(lib/embed-worker.mjs),CPU 用的 .so 是 npm 包自带的,
# 这几百 MB 的 CUDA/TensorRT 库下下来纯属白背(还删不掉:下面的瘦身只删非 linux/非 x64 目录)。
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip

# fetch-timeout/retries:npm 默认 5 分钟超时,网络"连着但不动"时要等很久才失败。
# 收到 2 分钟 + 3 次重试,让任何卡顿变成明确报错而不是无声干等。
RUN npm config set registry "${NPM_REGISTRY}" \
  && npm config set fetch-timeout 120000 \
  && npm config set fetch-retries 3 \
  && npm ci

# 构建期断言。上面那些防护一旦失效都是**静默**的,没有断言就只能等它以"构建好像卡住了"
# 或"线上功能整体失效"的形式暴露 —— 今晚这两种都发生过了。
#   · 平台二进制包缺失不会让 npm ci 报错(它们是 optional,装不上就跳过),却会让 next build
#     退回 wasm 版 SWC:慢好几倍,又表现成"日志不动",和真卡死难以区分。
#     libvips 要单独验 —— 只有它缺时 sharp 目录仍在,运行期才因动态链接失败而炸。
#   · CUDA 库若存在,说明上面的 ONNXRUNTIME_NODE_INSTALL_CUDA 没生效(比如变量名被改错)。
#     那不会报错,只会白下几百 MB 并把镜像撑大 —— 同样需要当场拦住。
RUN node -e "const fs=require('fs');const arch=process.arch;\
const need=['@next/swc-linux-'+arch+'-gnu','@img/sharp-linux-'+arch,'@img/sharp-libvips-linux-'+arch,'@esbuild/linux-'+arch];\
const miss=need.filter(p=>!fs.existsSync('node_modules/'+p));\
if(miss.length){console.error('平台二进制包缺失: '+miss.join(', ')+'  —— 多半是 npm 安装期把 optional 跳过了');process.exit(1);}\
const cuda='node_modules/onnxruntime-node/bin/napi-v3/linux/'+arch+'/libonnxruntime_providers_cuda.so';\
if(fs.existsSync(cuda)){console.error('不该存在的 CUDA 库: '+cuda+'  —— ONNXRUNTIME_NODE_INSTALL_CUDA=skip 没生效');process.exit(1);}\
console.log('平台二进制包齐备,且未拉取 CUDA 库');"

# ---------- build 阶段 ----------
# 源码进入独立阶段；普通应用改动不会改变 dependencies 中的 npm 依赖层。
FROM dependencies AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bash scripts/build-ci.sh

# ---------- runtime 文件包 ----------
# 这里汇集源码构建产物；真正的 Web/CAD 系统包层在各自阶段先安装，再复制本阶段，
# 因而普通源码变化不会让 apt 下载层失效。
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime-files
WORKDIR /app

# standalone 产物:server.js + 最小 node_modules(含被追踪的原生包)。
COPY --from=builder /app/.next/standalone ./
# 静态资源(_next/static)与 public 不在 standalone 内,需单独拷。
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# 根项目许可与第三方声明随运行镜像保留；各显式 COPY 的 npm 包仍保留包内原始 LICENSE。
COPY --from=builder /app/LICENSE /app/NOTICE.md ./

# CAD 几何工人由运行时 child_process 通过路径启动，Next output tracing 看不到
# 这条动态依赖链；显式复制工人和 Open CASCADE/WASM 受控解释器。前端 three
# 已被打进静态 chunk，不需要在 runner 再保留整包。
COPY --from=builder /app/scripts/cad-worker.mjs ./scripts/cad-worker.mjs
COPY --from=builder /app/scripts/cad-health.mjs ./scripts/cad-health.mjs
COPY --from=builder /app/scripts/text2cad-worker.mjs ./scripts/text2cad-worker.mjs
COPY --from=builder /app/scripts/cad-step-validator.mjs ./scripts/cad-step-validator.mjs
COPY --from=builder /app/scripts/embed-health.mjs ./scripts/embed-health.mjs
COPY --from=builder /app/scripts/embed-cache.mjs ./scripts/embed-cache.mjs
RUN mkdir -p /app/.data

# ---------- 共享 runtime 基座 ----------
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime-base
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    # Docker 发布的 CAD v3 必须有第二个原生 STEP 读取器；普通 web 不带二进制，
    # 即使误开 CAD worker 也会 fail closed，不会降级成单内核发布。
    CAD_REQUIRE_EXTERNAL_STEP_VALIDATOR=1 \
    CAD_REQUIRE_WORKER_HEARTBEAT=1

EXPOSE 3000
# standalone 的入口是根目录 server.js(Next.js 生成),监听 PORT/HOSTNAME。
CMD ["node", "server.js"]

# ---------- Web 系统与 Node 依赖 ----------
# CAD 容器不需要 Chromium/ffmpeg/中文字体，不应继承近 1GB 的无关系统依赖。
# 源码产物尚未进入本阶段，系统包和 npm 运行依赖只随各自清单变化。
FROM runtime-base AS app-runtime-deps
ARG APT_MIRROR=deb.debian.org
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg espeak-ng chromium fonts-noto-cjk ca-certificates \
  && test -r /usr/share/doc/espeak-ng/copyright \
  && test -r /usr/share/doc/espeak-ng-data/copyright \
  && test -r /usr/share/doc/libespeak-ng1/copyright \
  && test -r /usr/share/common-licenses/GPL-3 \
  && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# CAD 服务端路径仍需要受控 Replicad 运行包；这组依赖来自独立 dependencies 阶段。
COPY --from=dependencies /app/node_modules/replicad ./node_modules/replicad
COPY --from=dependencies /app/node_modules/replicad-opencascadejs ./node_modules/replicad-opencascadejs
COPY --from=dependencies /app/node_modules/flatbush ./node_modules/flatbush
COPY --from=dependencies /app/node_modules/flatqueue ./node_modules/flatqueue
COPY --from=dependencies /app/node_modules/opentype.js ./node_modules/opentype.js
COPY --from=dependencies /app/node_modules/string.prototype.codepointat ./node_modules/string.prototype.codepointat
COPY --from=dependencies /app/node_modules/tiny-inflate ./node_modules/tiny-inflate

# 本地向量嵌入只由 Web/非 CAD worker 使用。CAD 容器不拷这组大依赖。
COPY --from=dependencies /app/node_modules/@huggingface ./node_modules/@huggingface
COPY --from=dependencies /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=dependencies /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
COPY --from=dependencies /app/node_modules/sharp ./node_modules/sharp
COPY --from=dependencies /app/node_modules/@img ./node_modules/@img
# onnxruntime-node 只保留当前 linux 架构，同时删掉 transformers 源码/类型副本。
RUN find /app/node_modules/onnxruntime-node/bin/napi-v3 -mindepth 1 -maxdepth 1 \
      ! -name linux -exec rm -rf {} + \
  && runtime_arch="$(node -p 'process.arch')" \
  && find /app/node_modules/onnxruntime-node/bin/napi-v3/linux -mindepth 1 -maxdepth 1 \
      ! -name "$runtime_arch" -exec rm -rf {} + \
  && rm -rf /app/node_modules/@huggingface/transformers/src \
            /app/node_modules/@huggingface/transformers/types

# ---------- Web / 非 CAD worker 运行时 ----------
# 最后才复制应用构建产物；普通源码变化不会使上面的系统包和依赖层失效。
FROM app-runtime-deps AS app-runtime
COPY --from=runtime-files /app /app
ENV TRANSFORMERS_CACHE=/app/.data/models \
    HF_HOME=/app/.data/models \
    HOME=/tmp
RUN mkdir -p /app/.data/models \
  && chown -R node:node /app/.data
USER node

# Web 构建显式选择 runner；它位于 CAD 阶段之前，旧版顺序构建器也不会白装 FreeCAD。
FROM app-runtime AS runner

# ---------- CAD 系统与 Node 依赖 ----------
# 与 web 用不同容器/进程，并额外安装 Debian 维护的原生 FreeCAD
# STEP 读取器。它与 Replicad/WASM 生成器是不同编译产物和导入路径。
FROM runtime-base AS cad-runtime-deps
ARG APT_MIRROR=deb.debian.org
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update && apt-get install -y --no-install-recommends \
      libfreecad-python3-0.20=0.20.2+dfsg1-4 python3-minimal ca-certificates \
  && test -f /usr/lib/freecad-python3/lib/FreeCAD.so \
  && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /app/node_modules/replicad ./node_modules/replicad
COPY --from=dependencies /app/node_modules/replicad-opencascadejs ./node_modules/replicad-opencascadejs
COPY --from=dependencies /app/node_modules/flatbush ./node_modules/flatbush
COPY --from=dependencies /app/node_modules/flatqueue ./node_modules/flatqueue
COPY --from=dependencies /app/node_modules/opentype.js ./node_modules/opentype.js
COPY --from=dependencies /app/node_modules/string.prototype.codepointat ./node_modules/string.prototype.codepointat
COPY --from=dependencies /app/node_modules/tiny-inflate ./node_modules/tiny-inflate

# ---------- CAD 专用 worker 运行时 ----------
FROM cad-runtime-deps AS cad-runner
COPY --from=runtime-files /app /app
COPY --from=builder /app/scripts/freecad-step-validator.py ./scripts/freecad-step-validator.py
COPY --from=builder /app/scripts/freecad-health.py ./scripts/freecad-health.py
COPY --from=builder /app/scripts/cad-cross-validator-health.mjs ./scripts/cad-cross-validator-health.mjs
ENV CAD_EXTERNAL_STEP_VALIDATOR_BIN=/usr/bin/python3 \
    PYTHONPATH=/usr/lib/freecad-python3/lib \
    QT_QPA_PLATFORM=offscreen \
    HOME=/tmp
RUN mkdir -p /app/.data/cad /app/.data/cad-tmp \
  && chown -R node:node /app/.data
USER node

# 不指定 --target 时仍输出 Web 镜像；Compose/CI 均显式选择 runner，可跳过上面的 CAD 阶段。
FROM runner AS default-runner
