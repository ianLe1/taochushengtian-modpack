#!/usr/bin/env bash
# 世界存档恢复 / 回滚演练（方案 §9 风险 10 的缓解措施之二）
#
# 用法：
#   ./restore-world.sh list                     列出所有快照（从新到旧，带大小与校验文件状态）
#   ./restore-world.sh drill                    一键回滚演练：解包最新快照到临时目录、逐项校验、打印 PASS/FAIL、清理
#   ./restore-world.sh restore <snapshot> <dir> [--force]
#                                               真正恢复：把快照解到 <dir>（默认应填线上 world 的兄弟路径）
#   ./restore-world.sh restore-latest <dir> [--force]
#
# 安全纪律：
#   * 目标目录已存在且非空时，必须显式 --force；且 --force 也只是把它改名成 <dir>.replaced-<时间戳>，
#     绝不直接删除 —— 回滚的最大风险不是恢复失败，而是把当前世界删了。
#   * 恢复前后都不动快照本身；快照只读。
set -eo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BASE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
DEST=$BASE_DIR/backups/world
if [ -z "$BACKUP_DEST" ]; then BACKUP_DEST=$DEST; fi

if [ -z "$1" ]; then
  sed -n '2,16p' "$0"
  exit 2
fi
CMD=$1
shift

list_snapshots() {
  if [ ! -d "$BACKUP_DEST" ]; then echo "(备份目录不存在：$BACKUP_DEST)"; return; fi
  local found=0
  for f in $(ls -1t "$BACKUP_DEST"/world-*.tar.gz 2>/dev/null); do
    found=1
    local size sum state
    size=$(stat -c%s "$f")
    if [ -f "$f.sha256" ]; then
      if ( cd "$BACKUP_DEST" && sha256sum -c "$(basename "$f").sha256" >/dev/null 2>&1 ); then
        state=OK
      else
        state="校验失败"
      fi
    else
      state="无校验文件"
    fi
    printf '%s  %10d 字节  [%s]\n' "$(basename "$f")" "$size" "$state"
  done
  if [ "$found" = "0" ]; then echo "(还没有任何快照：$BACKUP_DEST)"; fi
}

verify_snapshot() {
  local snap=$1
  local rc=0
  echo "  1) sha256 校验 ...... "
  if [ -f "$snap.sha256" ]; then
    if ( cd "$(dirname "$snap")" && sha256sum -c "$(basename "$snap").sha256" >/dev/null 2>&1 ); then
      echo "     [OK] 与 .sha256 一致"
    else
      echo "     [FAIL] 哈希不一致（快照可能损坏）"; rc=1
    fi
  else
    echo "     [WARN] 没有 .sha256 文件，跳过（建议重新备份一次）"
  fi
  echo "  2) 解包列表 ...... "
  if tar -tzf "$snap" >/dev/null 2>&1; then
    echo "     [OK] 归档可读"
  else
    echo "     [FAIL] 归档无法解包"; rc=1
  fi
  return $rc
}

do_restore() {
  local snap=$1 target=$2 force=$3
  if [ ! -f "$snap" ]; then echo "[FAIL] 找不到快照：$snap"; exit 1; fi
  verify_snapshot "$snap" || { echo "[FAIL] 快照自身未通过校验，拒绝恢复。"; exit 1; }

  if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
    if [ "$force" != "yes" ]; then
      echo "[FAIL] 目标已存在且非空：$target"
      echo "       若确认要覆盖，加 --force；届时旧目录会被改名为 $target.replaced-<时间戳>（不删除）。"
      exit 1
    fi
    MOVED=$target.replaced-$(date +%Y%m%d-%H%M%S)
    mv "$target" "$MOVED"
    echo "  旧目标已改名保留：$MOVED"
  fi

  mkdir -p "$(dirname "$target")"
  echo "  3) 解包到 $target ......"
  tar -xzf "$snap" -C "$(dirname "$target")"
  echo "     [OK] 解包完成"

  # 若快照内部顶层目录名与目标名不同（世界目录改名过），自动纠正
  TOP=$(tar -tzf "$snap" | head -1 | cut -d/ -f1)
  if [ "$TOP" != "$(basename "$target")" ] && [ -d "$(dirname "$target")/$TOP" ]; then
    echo "     [INFO] 快照顶层目录为 $TOP，重命名为 $(basename "$target")"
    mv "$(dirname "$target")/$TOP" "$target"
  fi
}

case "$CMD" in
  list)
    echo "== 快照列表（新 → 旧）：$BACKUP_DEST =="
    list_snapshots
    ;;
  drill)
    echo "== 回滚演练（不接触线上世界）=="
    LATEST=$(ls -1t "$BACKUP_DEST"/world-*.tar.gz 2>/dev/null | head -1)
    if [ -z "$LATEST" ]; then
      echo "[FAIL] 没有可演练的快照。先跑一次： ops/backup-world.sh"
      exit 1
    fi
    echo "快照     : $LATEST"
    DRILLDIR=$(mktemp -d /tmp/world-drill-XXXXXX)
    echo "演练目录 : $DRILLDIR"
    echo "步骤："
    do_restore "$LATEST" "$DRILLDIR/world" yes

    echo "  4) 世界完整性 ......"
    RC=0
    if [ -f "$DRILLDIR/world/level.dat" ]; then
      MAGIC=$(od -An -tx1 -N2 "$DRILLDIR/world/level.dat" | tr -d ' \n')
      if [ "$MAGIC" = "1f8b" ]; then
        echo "     [OK] level.dat 存在且是 gzip（魔数 1f8b）"
      else
        echo "     [WARN] level.dat 存在但魔数=$MAGIC（不是 gzip，可能是快照写入途中被抓拍）"
      fi
    else
      echo "     [FAIL] 演练目录里没有 level.dat"; RC=1
    fi
    N=$(find "$DRILLDIR/world" -type f | wc -l)
    echo "     [INFO] 恢复出 $N 个文件"
    if [ -f "$LATEST.list" ]; then
      M=$(grep -vc '/$' "$LATEST.list" || true)
      echo "     [INFO] 快照清单条目 $M（与恢复文件数的差异来自空目录与顶层目录本身）"
    fi

    rm -rf "$DRILLDIR"
    echo "  5) 清理演练目录 ...... [OK]"
    if [ "$RC" = "0" ]; then
      echo "[PASS] 回滚演练成功 —— 这套快照可用于真实回滚。"
      echo "       真实回滚： ./restore-world.sh restore-latest <线上世界路径> --force  （先停服！）"
    else
      echo "[FAIL] 回滚演练未通过，见上面 [FAIL] 行。"
      exit 1
    fi
    ;;
  restore)
    SNAP=$1; TARGET=$2; FORCE=no
    for a in "$@"; do if [ "$a" = "--force" ]; then FORCE=yes; fi; done
    case "$SNAP" in /*) : ;; *) SNAP=$BACKUP_DEST/$SNAP ;; esac
    echo "== 真实恢复 =="
    do_restore "$SNAP" "$TARGET" "$FORCE"
    echo "[OK] 恢复完成：$TARGET"
    echo "     提醒：恢复后先只读启动一次（或用 MCEdit/NBT 工具核对）再放玩家进来。"
    ;;
  restore-latest)
    TARGET=$1; FORCE=no
    for a in "$@"; do if [ "$a" = "--force" ]; then FORCE=yes; fi; done
    SNAP=$(ls -1t "$BACKUP_DEST"/world-*.tar.gz 2>/dev/null | head -1)
    if [ -z "$SNAP" ]; then echo "[FAIL] 没有快照可恢复"; exit 1; fi
    echo "== 真实恢复（最新快照）=="
    do_restore "$SNAP" "$TARGET" "$FORCE"
    echo "[OK] 恢复完成：$TARGET"
    ;;
  *)
    echo "未知子命令：$CMD"
    sed -n '2,16p' "$0"
    exit 2
    ;;
esac
