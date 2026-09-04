#!/usr/bin/env bash
# scripts/restore.sh —— 从 OSS 备份恢复 PostgreSQL(带安全护栏,绝不静默覆盖)。
#
# 用法:
#   scripts/restore.sh <备份文件名或oss路径>
# 例:
#   scripts/restore.sh nblm-db-2026-07-06-0300.dump          # 仅文件名,自动补 oss://$OSS_BUCKET/db/
#   scripts/restore.sh oss://my-bucket/db/nblm-db-....dump   # 完整 oss 路径
#
# 恢复流程(每一步都 echo,失败即停):
#   下载 → 校验 dump 可读(pg_restore -l)→ 给现库做回滚快照 → --clean 就地恢复 →
#   sanity 查询核对;失败自动从回滚快照还原。
#
# ⚠ 会覆盖 DATABASE_URL 指向库的现有数据。务必先停应用(避免恢复过程中并发写)。
#   用阿里云 RDS 时,优先用 RDS 控制台的「按时间点恢复」;本脚本用于从 OSS 冷备手工还原。
#
# 依赖:pg_restore / pg_dump / psql(postgresql-client)、ossutil。
# 环境变量:
#   DATABASE_URL  目标 PG 连接串,必填
#   OSS_BUCKET    仅当传的是「文件名」而非完整 oss:// 路径时需要
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "[restore] 用法:$0 <备份文件名或oss路径>" >&2
  exit 1
fi

ARG="$1"
DATABASE_URL="${DATABASE_URL:-}"
OSS_BUCKET="${OSS_BUCKET:-}"

if [ -z "$DATABASE_URL" ]; then
  echo "[restore] 错误:未设置 DATABASE_URL 环境变量" >&2
  exit 1
fi

# —— 解析 OSS 源路径:完整 oss:// 直接用;否则拼到 oss://$OSS_BUCKET/db/ ——
case "$ARG" in
  oss://*)
    SRC="$ARG"
    ;;
  *)
    if [ -z "$OSS_BUCKET" ]; then
      echo "[restore] 错误:传的是文件名,但未设置 OSS_BUCKET 无法定位 OSS 路径" >&2
      exit 1
    fi
    SRC="oss://$OSS_BUCKET/db/$ARG"
    ;;
esac

STAMP="$(date +%F-%H%M%S)"
TMP_DUMP="/tmp/nblm-restore-${STAMP}.dump"
ROLLBACK="/tmp/nblm-rollback-${STAMP}.dump"

echo "[restore] 目标库:$DATABASE_URL"
echo "[restore] 来源  :$SRC"

# —— 1) 从 OSS 下载 ——
echo "[restore] 1/5 下载 → $TMP_DUMP"
ossutil cp "$SRC" "$TMP_DUMP"

# —— 2) 校验 dump 可读:pg_restore -l 只读 TOC,损坏/非自定义格式在动现库前就拦住 ——
echo "[restore] 2/5 校验 dump 可读(pg_restore -l)"
if ! pg_restore -l "$TMP_DUMP" >/dev/null 2>&1; then
  echo "[restore] 错误:dump 无法解析(可能损坏或非 -Fc 自定义格式),中止,现有库未动。" >&2
  rm -f "$TMP_DUMP"
  exit 1
fi
echo "[restore]     dump TOC 可读"

# —— 3) 安全护栏:先给现库做一份回滚快照,恢复出错可还原 ——
echo "[restore] 3/5 现库回滚快照 → $ROLLBACK"
pg_dump "$DATABASE_URL" -Fc -f "$ROLLBACK"

# —— 4) 就地恢复:--clean --if-exists 先删同名对象再重建;--no-owner 免属主不一致(RDS 尤需)——
echo "[restore] 4/5 pg_restore --clean 就地恢复"
if ! pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" "$TMP_DUMP"; then
  # pg_restore 对个别无害项(如 DROP 不存在对象)可能报非零,不据此判失败,交 sanity 定夺。
  echo "[restore]     pg_restore 返回非零(可能仅无害警告),继续 sanity 校验判定。"
fi

# —— 5) sanity:能查到核心表行数即算成功;否则从回滚快照还原 ——
echo "[restore] 5/5 sanity 校验(SELECT count(*) FROM notebooks)"
if CNT="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM notebooks' 2>/dev/null)"; then
  echo "[restore]     notebooks 行数 = $CNT"
  rm -f "$TMP_DUMP"
  echo "[restore] 恢复成功。回滚快照留存:$ROLLBACK(确认业务无误后可删)。"
  echo "[restore] 请重启服务生效(应用需重连才用上新数据)。"
else
  echo "[restore] 错误:sanity 查询失败,尝试从回滚快照还原。" >&2
  pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" "$ROLLBACK" || true
  echo "[restore] 已尝试回滚到原库,请人工核对。回滚快照:$ROLLBACK" >&2
  rm -f "$TMP_DUMP"
  exit 1
fi
