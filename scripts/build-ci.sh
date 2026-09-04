#!/usr/bin/env bash
# 带重试的生产构建 —— CI / Docker / 蓝绿部署统一入口。
#
# 背景:`next build` 的「Collecting page data」阶段偶发 worker 崩溃,报「Cannot find
# module for page: <随机路由>」——注意编译本身永远成功(✓ Compiled successfully),
# 失败的只是随机某路由/静态资源的模块解析,报错目标每次漂移(admin 路由、icon.png 等)。
# 这是 Next.js 15.5.x 已知的框架级 flake(next.config 已加 experimental.cpus:1 降低频率
# 但无法根治,属框架内部,非本项目代码缺陷)。
#
# 对策:最多重试 5 次,任一次成功即整体成功;5 次全挂才判真失败(那才是真代码问题,
# 因为真代码错在「Compiled successfully」之前就会稳定失败,不会时好时坏)。
#
# 另设单次硬超时:next build 的依赖或原生编译链仍可能访问网络
# (例如缺原生 SWC 时回落去下二进制)；`next/font/google` 已移除，不再是构建依赖。
# 国内网络下一旦"连上了但对端不回数据",进程会无限期
# 挂着,docker build 就永远停在这一步 —— 只能靠人去分辨"到底是慢还是死了"(今晚反复
# 误判过)。加上它,最坏 40 分钟必然收敛成一次明确失败。国内正常构建十几分钟,余量充足。
set -uo pipefail
MAX="${BUILD_MAX_RETRY:-5}"
TIMEOUT="${BUILD_TIMEOUT:-2400}"
for i in $(seq 1 "$MAX"); do
  echo "▶ build 尝试 $i/$MAX (单次上限 ${TIMEOUT}s) ..."
  started_at=$(date +%s)
  # -s KILL 而非默认的 TERM:挂在 socket 上的进程未必响应 TERM。
  # 用 command -v 兜一下,没有 timeout 的环境退回原行为,不至于跑不起来。
  if command -v timeout >/dev/null 2>&1; then
    timeout -s KILL "$TIMEOUT" npm run build
  else
    # 没有 timeout 就没有超时保护,挂死会无限期占着构建机。不静默降级,喊一声,
    # 否则将来有人在别的基础镜像上构建、卡了半天也想不到是这里少了个命令。
    echo "⚠ 未找到 timeout 命令,本次构建没有超时保护(挂死不会自动终止)"
    npm run build
  fi
  rc=$?
  elapsed=$(( $(date +%s) - started_at ))
  if [ "$rc" -eq 0 ]; then
    echo "✅ build 成功(第 $i 次)"
    exit 0
  fi
  # GNU timeout 正常超时返回 124；部分实现会透出 137(SIGKILL)。
  # 但 137 也会在容器 OOM/cgroup 或人工 kill 时出现，不能一律误报成「40 分钟网络超时」。
  # 只有墙钟真正接近 TIMEOUT 时才把 137 归类为超时。
  timeout_floor=$(( TIMEOUT > 2 ? TIMEOUT - 2 : TIMEOUT ))
  if [ "$rc" -eq 124 ] || { [ "$rc" -eq 137 ] && [ "$elapsed" -ge "$timeout_floor" ]; }; then
    echo "✗ build 超过 ${TIMEOUT}s 仍未完成,已强制终止(rc=$rc) —— 这不是 flake,多半是某处网络挂死"
    echo "  排查步骤见 docs/deploy.md §10(判定卡死 / 定位是哪个包在等境外源)"
    exit 1
  fi
  if [ "$rc" -eq 137 ]; then
    echo "✗ build 在 ${elapsed}s 被 SIGKILL，未到 ${TIMEOUT}s 超时线 —— 优先查 OOM/cgroup/人工 kill，不是网络超时"
    exit 1
  fi
  echo "⚠ 第 $i 次 build 失败(rc=$rc,疑似 collect-page-data flake),清 .next 重试"
  rm -rf .next
done
echo "✗ build 连续 $MAX 次失败 —— 这不是 flake 是真问题,请查日志(编译阶段是否有真错)"
exit 1
