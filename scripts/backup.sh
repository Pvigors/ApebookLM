#!/usr/bin/env bash
# scripts/backup.sh —— PostgreSQL 逻辑备份与媒体目录增量同步到兼容 OSS 的对象存储。
#
# 用阿里云 RDS PostgreSQL 时:RDS 控制台已有自动备份(主手段),此脚本作为【异地冷备补充】
#   ——把逻辑 dump 也甩一份到 OSS,防 RDS 区域级故障 / 误删实例。
# 用自托管 PG(compose 的 db 服务)时:这就是【主备份手段】。
#
# 定时运行时应从权限为 0600 的环境文件加载配置。
#
# 依赖:pg_dump(postgresql-client,版本需 ≥ 服务端大版本)、ossutil、flock(util-linux)。
# 环境变量:
#   DATABASE_URL  PG 连接串 postgres://用户:密码@主机:5432/库名,必填(与应用同一份)
#   OSS_BUCKET    目标 bucket 名(不带 oss:// 前缀),必填,缺则报错退出
#   MEDIA_DIR     媒体根目录,必填 —— 内含 audio/video/xhs/infographic/aippt/cad。
set -euo pipefail
umask 077

# —— 配置从 env 读,给出与部署约定一致的默认值 ——
DATABASE_URL="${DATABASE_URL:-}"
OSS_BUCKET="${OSS_BUCKET:-}"
MEDIA_DIR="${MEDIA_DIR:-}"

# —— 必填校验:缺关键变量直接退出,避免备份跑了个寂寞 ——
if [ -z "$DATABASE_URL" ]; then
  echo "[backup] 错误:未设置 DATABASE_URL 环境变量" >&2
  exit 1
fi
if [ -z "$OSS_BUCKET" ]; then
  echo "[backup] 错误:未设置 OSS_BUCKET 环境变量" >&2
  exit 1
fi
if [ -z "$MEDIA_DIR" ]; then
  echo "[backup] 错误:未设置 MEDIA_DIR，拒绝只备份数据库而静默漏掉媒体" >&2
  exit 1
fi
if [ ! -d "$MEDIA_DIR" ]; then
  echo "[backup] 错误:MEDIA_DIR 不存在或不可访问: $MEDIA_DIR" >&2
  exit 1
fi
MEDIA_SUBDIRS=(audio video xhs infographic aippt cad)
PRESENT_MEDIA_DIRS=0
for sub in "${MEDIA_SUBDIRS[@]}"; do
  [ -d "$MEDIA_DIR/$sub" ] && PRESENT_MEDIA_DIRS=$((PRESENT_MEDIA_DIRS + 1))
done
if [ "$PRESENT_MEDIA_DIRS" -eq 0 ]; then
  echo "[backup] 错误:MEDIA_DIR 下没有任何已知媒体子目录，疑似路径配置错误" >&2
  exit 1
fi

for binary in pg_dump ossutil flock; do
  resolved="$(command -v "$binary" || true)"
  [ -n "$resolved" ] || { echo "[backup] 错误:缺少 $binary" >&2; exit 1; }
  echo "[backup] 依赖 $binary=$resolved"
done

# 定时任务、人工发版备份和上一轮慢同步不得重叠。锁在任何 pg_dump/OSS 写入前获取。
LOCK_FILE="${BACKUP_LOCK_FILE:-/tmp/apebooklm-backup.lock}"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "[backup] 错误:已有备份任务正在运行" >&2; exit 75; }

STAMP="$(date +%F-%H%M)"
TMP_DUMP="$(mktemp "/tmp/nblm-db-${STAMP}-XXXXXX.dump")"
BACKUP_SUCCEEDED=0
cleanup_failed_backup() {
  [ "$BACKUP_SUCCEEDED" -eq 1 ] || rm -f "$TMP_DUMP"
}
trap cleanup_failed_backup EXIT

echo "[backup] 开始:$(date '+%F %T')  BUCKET=$OSS_BUCKET"

# —— 1) 逻辑备份:pg_dump 自定义格式(-Fc)——
# 自定义格式=自带压缩 + 支持 pg_restore 并行(-j)/选择性恢复,无需另行 gzip。
# pg_dump 在一致快照(MVCC)上导出,不阻塞并发读写,产出一份自洽备份。
echo "[backup] 1/3 pg_dump(自定义格式)→ $TMP_DUMP"
pg_dump "$DATABASE_URL" -Fc -f "$TMP_DUMP"
chmod 600 "$TMP_DUMP"
[ "$(stat -c '%a' "$TMP_DUMP")" = "600" ] || { echo "[backup] 错误:dump 权限不是 600" >&2; exit 1; }

# —— 2) 上传 DB 备份到 oss://$OSS_BUCKET/db/ ——
echo "[backup] 2/3 上传 DB → oss://$OSS_BUCKET/db/"
ossutil cp "$TMP_DUMP" "oss://$OSS_BUCKET/db/"

# —— 3) 媒体目录增量同步到 oss://$OSS_BUCKET/media/ ——
# ossutil sync 只传新增/变更文件:首次全量,之后增量。逐子目录同步,缺失的跳过不整体失败。
echo "[backup] 3/3 媒体增量同步 → oss://$OSS_BUCKET/media/"
SYNCED_MEDIA_DIRS=0
for sub in "${MEDIA_SUBDIRS[@]}"; do
  src="$MEDIA_DIR/$sub"
  if [ -d "$src" ]; then
    echo "[backup]   sync $sub/"
    ossutil sync "$src/" "oss://$OSS_BUCKET/media/$sub/"
    SYNCED_MEDIA_DIRS=$((SYNCED_MEDIA_DIRS + 1))
  else
    echo "[backup]   跳过 $sub/(目录不存在)"
  fi
done
if [ "$SYNCED_MEDIA_DIRS" -ne "$PRESENT_MEDIA_DIRS" ]; then
  echo "[backup] 错误:媒体同步计数不完整($SYNCED_MEDIA_DIRS/$PRESENT_MEDIA_DIRS)" >&2
  exit 1
fi

# —— 本地保留最近 7 份:删掉 /tmp 下更旧的 nblm-db-*.dump ——
echo "[backup] 本地清理:仅保留最近 7 份"
ls -t /tmp/nblm-db-*.dump 2>/dev/null | tail -n +8 | while read -r old; do
  echo "[backup]   删除旧备份 $old"
  rm -f "$old"
done

# —— OSS 侧保留 30 天 ——
# 更稳的做法是在 OSS 控制台给 db/ 前缀配「生命周期规则:30 天后删除」(服务端自动执行,
# 不依赖脚本每天跑成功)。此处不主动删远端对象,避免误删历史备份。

BACKUP_SUCCEEDED=1
echo "[backup] 完成:$(date '+%F %T')"
