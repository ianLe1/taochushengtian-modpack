#!/usr/bin/env bash
# 服务端模组下载器：按 dist/server-mods.tsv 把 253 个服务端模组下载到 <目标>/mods 并逐个校验。
#
# 为什么需要它：白名单仓库（packwiz-pack/）只带 .pw.toml 与索引，不带 jar（分发条例）。
# 所以「拿到 jar」这一步必须单独做 —— 这就是这个脚本。
#
# 用法：
#   ./download-mods.sh --target /srv/mc/mods          下载缺失的，已存在的先校验、校验通过就跳过
#   ./download-mods.sh --target /srv/mc/mods --check  只校验不下载（对账用）
#   ./download-mods.sh --target /srv/mc/mods --only 'keywheel*'
#   ./download-mods.sh --list                         打印清单来源统计
#   ./download-mods.sh --target ./mods --no-ipv4      允许 IPv6（默认强制 IPv4，见 DISTRIBUTE.md）
#
# 特性：幂等（重跑只补缺失/损坏项）；每个文件按清单里的 hash-format（sha512/sha1）或 md5 校验；
#       校验失败的文件会被删除并重下；下载失败不静默 —— 结束时非零退出并列出失败项。
set -eo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
MANIFEST=$SCRIPT_DIR/server-mods.tsv
TARGET=./mods
CHECK=0
ONLY=
DO_LIST=0
# 默认强制 IPv4：本机 IPv6 到 cdn.modrinth.com（fastly）会 TLS 断连（curl 35 unexpected eof），
# 加 -4 后 200。纯 IPv6 主机可用 --no-ipv4 关掉。
IPV4=1

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET=$2; shift 2 ;;
    --manifest) MANIFEST=$2; shift 2 ;;
    --check) CHECK=1; shift ;;
    --only) ONLY=$2; shift 2 ;;
    --list) DO_LIST=1; shift ;;
    --no-ipv4) IPV4=0; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

if [ ! -f "$MANIFEST" ]; then
  echo "[FAIL] 找不到清单：$MANIFEST"
  echo "       先生成： python3 ../tools/gen-dist-manifest.py"
  exit 1
fi

CURL_FLAGS=--ipv4
if [ "$IPV4" = "0" ]; then CURL_FLAGS=; fi

if [ "$CHECK" = "0" ] && [ "$DO_LIST" = "0" ]; then mkdir -p "$TARGET"; fi

TMPFAIL=$(mktemp /tmp/dl-fail-XXXXXX)
trap 'rm -f "$TMPFAIL"' EXIT

file_hash() {
  case "$2" in
    sha512) sha512sum "$1" | cut -d' ' -f1 ;;
    sha1)   sha1sum "$1" | cut -d' ' -f1 ;;
    md5)    md5sum "$1" | cut -d' ' -f1 ;;
    *)      md5sum "$1" | cut -d' ' -f1 ;;
  esac
}

short() { printf '%s' "$1" | cut -c1-12; }

ok=0; got=0; bad=0; fail=0; manual=0

while IFS=$(printf '\t') read -r fn md5 bytes source url hash fmt note; do
  case "$fn" in ''|\#*) continue ;; esac
  if [ -n "$ONLY" ]; then
    case "$fn" in $ONLY) : ;; *) continue ;; esac
  fi

  if [ "$DO_LIST" = "1" ]; then
    printf '%s\t%s\t%s\n' "$source" "$fn" "$note"
    continue
  fi

  # 清单里的空列写成 "-"（POSIX read 会折叠空字段），这里还原
  URLV=$url;  if [ "$URLV" = "-" ]; then URLV=; fi
  HASHV=$hash; if [ "$HASHV" = "-" ]; then HASHV=; fi
  EXPECT=$md5
  if [ -n "$HASHV" ]; then EXPECT=$HASHV; fi

  DEST=$TARGET/$fn
  if [ -f "$DEST" ]; then
    GOT=$(file_hash "$DEST" "$fmt")
    if [ "$GOT" = "$EXPECT" ]; then
      ok=$((ok+1))
      if [ "$CHECK" = "1" ]; then echo "[OK]      $fn"; fi
      continue
    fi
    echo "[BAD]     $fn 校验不符（期望 $(short "$EXPECT")… 实际 $(short "$GOT")…）"
    if [ "$CHECK" = "1" ]; then bad=$((bad+1)); continue; fi
    rm -f "$DEST"
  fi

  if [ "$CHECK" = "1" ]; then
    echo "[MISSING] $fn"
    bad=$((bad+1))
    continue
  fi

  if [ -z "$URLV" ]; then
    echo "[MANUAL]  $fn —— $note"
    manual=$((manual+1))
    echo "$fn (需人工分发)" >> "$TMPFAIL"
    continue
  fi

  echo "[GET ]    $fn  <- $source"
  # --retry-all-errors：CDN 偶发 TLS/连接重置也要重试，否则一次抖动就整个失败
  if ! curl $CURL_FLAGS -fsSL --connect-timeout 20 --retry 5 --retry-delay 2 --retry-all-errors -o "$DEST.part" "$URLV"; then
    echo "          [FAIL] 下载失败：$URLV"
    rm -f "$DEST.part"
    fail=$((fail+1)); echo "$fn (下载失败)" >> "$TMPFAIL"
    continue
  fi
  GOT=$(file_hash "$DEST.part" "$fmt")
  if [ "$GOT" != "$EXPECT" ]; then
    echo "          [FAIL] 下载后校验不符（期望 $(short "$EXPECT")… 实际 $(short "$GOT")…）"
    rm -f "$DEST.part"; fail=$((fail+1)); echo "$fn (校验失败)" >> "$TMPFAIL"
    continue
  fi
  mv "$DEST.part" "$DEST"
  got=$((got+1))
done < "$MANIFEST"

if [ "$DO_LIST" = "1" ]; then
  echo "== 清单来源统计 =="
  awk -F'\t' '!/^#/ && NF>3 {c[$4]++} END {for (k in c) printf "  %-10s %d\n", k, c[k]}' "$MANIFEST"
  exit 0
fi

echo
echo "== 结果 =="
echo "  已存在且校验通过 : $ok"
echo "  本次下载成功     : $got"
if [ "$CHECK" = "1" ]; then
  echo "  校验不符/缺失    : $bad   （--check 模式，未下载）"
else
  echo "  需人工分发       : $manual"
  echo "  失败             : $fail"
fi
if [ -s "$TMPFAIL" ]; then
  echo "  待处理清单："
  while read -r x; do echo "    - $x"; done < "$TMPFAIL"
fi
if [ "$CHECK" = "1" ] && [ "$bad" != "0" ]; then exit 1; fi
if [ "$fail" != "0" ]; then exit 1; fi
if [ "$CHECK" = "0" ] && [ "$manual" != "0" ]; then
  echo "[WARN] 有 $manual 项需要人工拷贝（见上），其余已就绪。"
fi
echo "[OK] 完成。目标目录：$TARGET"
