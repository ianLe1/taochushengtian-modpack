#!/usr/bin/env bash
# 逃出生天 战争服启动脚本（M0）
# 用法：
#   ./start.sh            正常启动（前台，Ctrl-C 优雅停服）
#   ./start.sh --dry-run  只做环境自检并打印将要执行的命令，不启动（可重复执行，用于验收）
#   ./start.sh --check    只做环境自检
#
# 版本锁（改动前先读 VERSION-LOCK.md）：
#   Minecraft 1.21.1 / NeoForge 21.1.251 / Java 21.0.7 (Microsoft OpenJDK)
# 不用 set -u：JAVA_BIN / MEM_NOTE 允许由环境变量可选覆盖，未设置时应取默认值而不是报错。
set -eo pipefail

# 允许用 SERVER_DIR_OVERRIDE 指定服务端根目录；默认 = 本脚本所在目录（把本脚本拷进服务端根即可）。
if [ -z "$SERVER_DIR_OVERRIDE" ]; then SERVER_DIR_OVERRIDE=$(cd "$(dirname "$0")" && pwd); fi
SERVER_DIR=$SERVER_DIR_OVERRIDE
NEOFORGE_VERSION=21.1.251
MC_VERSION=1.21.1
DEFAULT_JAVA=/home/lee/.local/share/PrismLauncher/java/java-runtime-delta/bin/java

if [ -z "$JAVA_BIN" ]; then JAVA_BIN=$DEFAULT_JAVA; fi
if [ -z "$MEM_NOTE" ]; then MEM_NOTE=1; fi

MODE=start
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE=dry ;;
    --check)   MODE=check ;;
  esac
done

echo "== 逃出生天 战争服 =="
echo "服务端目录 : $SERVER_DIR"
echo "版本锁     : MC $MC_VERSION / NeoForge $NEOFORGE_VERSION / Java 21"

if [ ! -x "$JAVA_BIN" ]; then
  echo "[FAIL] 找不到 Java：$JAVA_BIN"
  echo "       用 JAVA_BIN=/path/to/java ./start.sh 指定，或改回 Prism 的 java-runtime-delta。"
  exit 1
fi
JAVA_VER=$("$JAVA_BIN" -version 2>&1 | head -1)
echo "Java       : $JAVA_VER"
case "$JAVA_VER" in
  *'"21.'*) : ;;
  *) echo "[WARN] 版本锁要求 Java 21，当前不是 21 —— 继续可能因 mod 字节码版本不符而失败。" ;;
esac

ARGS_FILE=$SERVER_DIR/libraries/net/neoforged/neoforge/$NEOFORGE_VERSION/unix_args.txt
if [ ! -f "$ARGS_FILE" ]; then
  echo "[FAIL] 缺少 NeoForge 启动参数文件：$ARGS_FILE"
  echo "       说明这个目录还没装服务端。按 VERSION-LOCK.md「安装服务端（一次性）」先跑安装器："
  echo "       java -jar neoforge-$NEOFORGE_VERSION-installer.jar --installServer"
  exit 1
fi
echo "启动参数   : $ARGS_FILE  [OK]"

JVM_ARGS=$SERVER_DIR/user_jvm_args.txt
if [ ! -f "$JVM_ARGS" ]; then
  echo "[WARN] 缺少 user_jvm_args.txt，将使用 JVM 默认堆（不推荐）；可从 server-pack/ 拷一份。"
  JVM_ARGS=
fi

if [ ! -f "$SERVER_DIR/eula.txt" ]; then
  echo "[FAIL] 没有 eula.txt。首次启动需由服主阅读并同意 https://aka.ms/MinecraftEULA"
  echo "       同意后创建 eula.txt 内容为：eula=true   （本脚本不代签）"
  exit 1
fi
if ! grep -q '^eula=true' "$SERVER_DIR/eula.txt"; then
  echo "[FAIL] eula.txt 里 eula 不是 true —— 服主需自行确认 EULA。"
  exit 1
fi
echo "EULA       : 已由服主确认 [OK]"

MOD_COUNT=$(ls -1 "$SERVER_DIR/mods" 2>/dev/null | grep -c '\.jar$' || true)
echo "mods/      : $MOD_COUNT 个 jar"
if [ "$MOD_COUNT" = "0" ]; then
  echo "[WARN] mods/ 是空的 —— 先用 ../tools/make-server.sh 灌入 253 个保留模组，否则开出来是原版空壳。"
fi

if [ "$MEM_NOTE" = "1" ]; then
  echo "内存       : 默认 -Xms10G -Xmx10G（user_jvm_args.txt），改前先看那里的说明。"
fi

echo "命令       : cd $SERVER_DIR"
echo "             $JAVA_BIN @user_jvm_args.txt @libraries/net/neoforged/neoforge/$NEOFORGE_VERSION/unix_args.txt nogui"

if [ "$MODE" = "dry" ] || [ "$MODE" = "check" ]; then
  echo "[dry-run] 自检通过，未启动。"
  exit 0
fi

echo "---- 启动（Ctrl-C 停止；关服请在控制台输入 stop，不要直接 kill -9）----"
cd "$SERVER_DIR"
exec "$JAVA_BIN" @"user_jvm_args.txt" "@libraries/net/neoforged/neoforge/$NEOFORGE_VERSION/unix_args.txt" nogui
