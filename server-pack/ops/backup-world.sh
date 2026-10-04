#!/usr/bin/env bash
# 世界存档定时备份（方案 §9 风险 10 的缓解措施之一）
#
# 用法：
#   ./backup-world.sh                        备份 <父目录>/world → <父目录>/backups/world
#   ./backup-world.sh --world <dir>          指定世界目录
#   ./backup-world.sh --dest <dir>           指定备份目录
#   ./backup-world.sh --keep 14              保留最近 N 份（默认 14）
#   ./backup-world.sh --tag before-upgrade   给快照加标签
#   ./backup-world.sh --dry-run              只打印将要做什么
#
# 特性：可重复执行（同一秒重复执行不会互相覆盖，自动加 -2/-3 后缀）；每次备份都做「解包列表自检」，
#       失败即保留现场并退出非零，绝不静默产出一个坏快照。
set -eo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BASE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

WORLD=$BASE_DIR/world
DEST=$BASE_DIR/backups/world
KEEP=14
TAG=
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --world) WORLD=$2; shift 2 ;;
    --dest)  DEST=$2;  shift 2 ;;
    --keep)  KEEP=$2;  shift 2 ;;
    --tag)   TAG=$2;   shift 2 ;;
    --dry-run) DRY=1;  shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

if [ ! -d "$WORLD" ]; then
  echo "[FAIL] 世界目录不存在：$WORLD"
  echo "       首次开服前没有世界是正常的；开服跑过一次后 world/ 才存在。"
  exit 1
fi
if [ ! -f "$WORLD/level.dat" ]; then
  echo "[WARN] $WORLD 里没有 level.dat —— 它可能不是世界目录，或世界正在生成中。继续备份，但请在 drill 里注意。"
fi

mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M%S)
NAME=world-$TS
if [ -n "$TAG" ]; then NAME=$NAME-$TAG; fi

SNAP=$DEST/$NAME.tar.gz
N=1
while [ -e "$SNAP" ]; do
  N=$((N+1))
  SNAP=$DEST/$NAME-$N.tar.gz
done
SUM=$SNAP.sha256

if [ "$DRY" = "1" ]; then
  echo "[dry-run] 将执行： tar -czf $SNAP -C $(dirname "$WORLD") $(basename "$WORLD")"
  echo "[dry-run] 将写入： sha256 校验文件 $SUM"
  echo "[dry-run] 将保留： 最近 $KEEP 份（多出的旧快照会被删）"
  exit 0
fi

echo "== 世界备份 =="
echo "世界目录 : $WORLD"
echo "快照文件 : $SNAP"

tar -czf "$SNAP" -C "$(dirname "$WORLD")" "$(basename "$WORLD")"

# 自检：能否列出归档内容 + 清单行数
if ! tar -tzf "$SNAP" > "$SNAP.list" 2>/dev/null; then
  echo "[FAIL] 快照无法解包自检，保留现场：$SNAP"
  exit 1
fi
FILES=$(wc -l < "$SNAP.list")
BYTES=$(stat -c%s "$SNAP")
echo "快照自检 : [OK] $FILES 个条目, $BYTES 字节"

( cd "$DEST" && sha256sum "$(basename "$SNAP")" > "$(basename "$SUM")" )
echo "校验文件 : $SUM"

# 保留策略：按文件名时间戳排序，删除最旧的
COUNT=$(ls -1 "$DEST"/world-*.tar.gz 2>/dev/null | wc -l)
if [ "$COUNT" -gt "$KEEP" ]; then
  REMOVE=$((COUNT-KEEP))
  echo "保留策略 : 现有 $COUNT 份 > 上限 $KEEP，删除最旧 $REMOVE 份"
  ls -1t "$DEST"/world-*.tar.gz | tail -n "$REMOVE" | while read -r old; do
    echo "  删除 $(basename "$old")"
    rm -f "$old" "$old.sha256" "$old.list"
  done
else
  echo "保留策略 : 现有 $COUNT 份，未超上限 $KEEP"
fi

echo "[OK] 备份完成。演练恢复： $SCRIPT_DIR/restore-world.sh drill"
