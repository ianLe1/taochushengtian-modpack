#!/usr/bin/env bash
# 组装一个可启动的服务端根目录（本机/局域网用；公网分发请看 ../DISTRIBUTE.md）
#
# 为什么需要它：server-pack/ 本身只是一份「说明书 + 清单 + 脚本」，不是能直接开的服。
# 这个脚本把三样东西拼成一个目录：① 服务端模组（253 个）② 服务端配置（config/kubejs/defaultconfigs）
# ③ 启动脚本与运维脚本。拼完再跑一次 NeoForge 安装器就能开服。
#
# 用法：
#   ./make-server.sh --target ~/mc-server              模组从本机实例直接拷（最快，仅限本机）
#   ./make-server.sh --target ~/mc-server --no-mods    不拷模组，之后用 dist/download-mods.sh 拉
#   ./make-server.sh --target ~/mc-server --with-config 连 config/kubejs/defaultconfigs 一起拷
#   ./make-server.sh --target ~/mc-server --dry-run    只报告将要做什么
#
# 幂等与安全：目标非空时必须 --force，且旧目录只会被改名成 <target>.replaced-<时间戳>（绝不删除）；
#             已存在的 server.properties 默认不覆盖（避免踩掉服主手改过的配置）。
set -eo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PACK=$(cd "$SCRIPT_DIR/.." && pwd)            # server-pack/
INSTANCE=$(cd "$PACK/.." && pwd)              # <实例>/
MODS_SRC=$INSTANCE/minecraft/mods
LIST=$PACK/server-mods.list
TARGET=
WITH_CONFIG=0
DRY=0
FORCE=0
NO_MODS=0

# 测试用覆盖（合成实例验证脚本本身）
if [ -n "$INSTANCE_DIR_OVERRIDE" ]; then
  INSTANCE=$INSTANCE_DIR_OVERRIDE
  MODS_SRC=$INSTANCE/minecraft/mods
fi
if [ -n "$LIST_OVERRIDE" ]; then LIST=$LIST_OVERRIDE; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET=$2; shift 2 ;;
    --with-config) WITH_CONFIG=1; shift ;;
    --no-mods) NO_MODS=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

if [ -z "$TARGET" ]; then echo "[FAIL] 必须给 --target <服务端目录>"; exit 2; fi
if [ ! -f "$LIST" ]; then echo "[FAIL] 找不到模组清单：$LIST"; exit 1; fi
TARGET=$(mkdir -p "$(dirname "$TARGET")" && cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  if [ "$FORCE" != "1" ]; then
    echo "[FAIL] 目标已存在且非空：$TARGET"
    echo "       确认要重建就加 --force；旧目录会被改名成 $TARGET.replaced-<时间戳>，不会删。"
    exit 1
  fi
fi

echo "== 组装服务端根目录 =="
echo "实例（只读源）: $INSTANCE"
echo "模组清单      : $LIST"
echo "目标目录      : $TARGET"
if [ "$DRY" = "1" ]; then
  echo "[dry-run] 将创建 $TARGET/{mods,ops} 并拷入启动脚本与配置模板"
  if [ "$NO_MODS" = "0" ]; then
    echo "[dry-run] 将按清单 $(grep -vc '^#' "$LIST") 条记录从 $MODS_SRC 拷入 jar"
  else
    echo "[dry-run] --no-mods：跳过模组拷贝"
  fi
  if [ "$WITH_CONFIG" = "1" ]; then
    echo "[dry-run] 将拷入 config/ kubejs/ defaultconfigs/"
  fi
  exit 0
fi

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  MOVED=$TARGET.replaced-$(date +%Y%m%d-%H%M%S)
  mv "$TARGET" "$MOVED"
  echo "旧目标已改名保留：$MOVED"
fi
mkdir -p "$TARGET/mods" "$TARGET/ops"

# ---- 1) 模组 ----
if [ "$NO_MODS" = "0" ]; then
  n=0; miss=0
  while IFS=$(printf '\t') read -r jar rest; do
    case "$jar" in ''|\#*) continue ;; esac
    if [ ! -f "$MODS_SRC/$jar" ]; then
      echo "  [MISS] $jar 在 $MODS_SRC 里不存在"
      miss=$((miss+1)); continue
    fi
    cp -p "$MODS_SRC/$jar" "$TARGET/mods/$jar"
    n=$((n+1))
  done < "$LIST"
  echo "模组        : 拷入 $n 个，缺失 $miss 个"
  if [ "$miss" != "0" ]; then
    echo "  [WARN] 有缺失项：要么本机实例已被改动，要么用 dist/download-mods.sh 拉到新目录"
  fi
fi

# ---- 2) 配置 ----
if [ "$WITH_CONFIG" = "1" ]; then
  for d in config kubejs defaultconfigs; do
    if [ -d "$INSTANCE/minecraft/$d" ]; then
      cp -a "$INSTANCE/minecraft/$d" "$TARGET/$d"
      echo "配置        : 拷入 $d/（$(find "$TARGET/$d" -type f | wc -l) 个文件）"
    else
      echo "配置        : [SKIP] 实例里没有 minecraft/$d/"
    fi
  done
  echo "              注：config/ 里含本地路径与个人设置（如键位/HUD），分发前请自行过一遍。"
else
  echo "配置        : 未拷（加 --with-config 拷 config/ kubejs/ defaultconfigs/）"
fi

# ---- 3) 脚本与模板 ----
cp -p "$PACK/start.sh" "$TARGET/start.sh"
cp -p "$PACK/user_jvm_args.txt" "$TARGET/user_jvm_args.txt"
cp -p "$PACK/ops/backup-world.sh" "$TARGET/ops/backup-world.sh"
cp -p "$PACK/ops/restore-world.sh" "$TARGET/ops/restore-world.sh"
chmod +x "$TARGET/start.sh" "$TARGET/ops/"*.sh
if [ -f "$TARGET/server.properties" ]; then
  echo "properties  : 已存在，保留不动（模板见 $PACK/server.properties.template）"
else
  cp -p "$PACK/server.properties.template" "$TARGET/server.properties"
  echo "properties  : 从模板生成 server.properties"
fi

cat <<NEXT

== 下一步 ==
 1. 装服务端（只需一次）：
      java -jar neoforge-21.1.251-installer.jar --installServer
    安装器会在这个目录生成 libraries/ 与 run.sh（版本锁定见 ../VERSION-LOCK.md）
 2. 同意 EULA（只能由服主本人决定）：编辑 eula.txt 改成 eula=true
 3. 自检： ./start.sh --check
 4. 试开： ./start.sh         （首次会生成 world/，然后 Ctrl-C 停掉）
 5. 备份演练： ./ops/restore-world.sh drill    （必须 [PASS] 才敢放真人进来）
 6. 定时备份（可加到 cron）：
      17 */2 * * *  cd "$TARGET" && ./ops/backup-world.sh --keep 14
NEXT
