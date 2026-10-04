#!/usr/bin/env python3
"""生成服务端分发清单 dist/server-mods.tsv

输入：server-pack/reports/mods-scan.json（决定 keep/drop）+ minecraft/mods/.index/*.pw.toml（下载源）
输出：server-pack/dist/server-mods.tsv

为什么需要它：白名单仓库（packwiz-pack/）只带 .pw.toml 与索引，**不带 jar**（分发条例），
所以拿不到 jar 的人必须有一份「文件名 + 下载直链 + 校验值」的清单，配合 download-mods.sh 落地。
本脚本让这份清单可重复再生成（改了 mods 就重跑，不要手编）。

用法： python3 server-pack/tools/gen-dist-manifest.py
"""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent                      # server-pack/
ROOT = OUT.parent                      # <实例>/
MODS = ROOT / "minecraft" / "mods"
INDEX = MODS / ".index"
SCAN = OUT / "reports" / "mods-scan.json"
DIST = OUT / "dist"

# 无 .pw.toml 的 3 个 keep 模组：前两个的直链由 sha512 反查 Modrinth 得到，simurail 只能人工分发
MANUAL_SOURCES = {
    "connector-2.0.0-beta.17+1.21.1-full.jar": dict(
        source="modrinth",
        url="https://cdn.modrinth.com/data/u58R1TMW/versions/IITF0PRC/connector-2.0.0-beta.17%2B1.21.1-full.jar",
        note="无 .pw.toml；sha512 反查 Modrinth 命中 u58R1TMW/2.0.0-beta.17+1.21.1"),
    "kotlinforforge-5.12.0-all.jar": dict(
        source="modrinth",
        url="https://cdn.modrinth.com/data/ordsPcFz/versions/uhJhCT7X/kotlinforforge-5.12.0-all.jar",
        note="无 .pw.toml；sha512 反查 Modrinth 命中 ordsPcFz/5.12.0"),
    "simurail-0.1.0+mc1.21.1+76f9008.jar": dict(
        source="manual",
        url="",
        note="★ 人工分发：Modrinth 无此哈希（仅 CurseForge），必须由本地副本拷入 mods/"),
}


def md5_file(p):
    h = hashlib.md5()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_pw(path):
    txt = path.read_text(encoding="utf-8")
    def g(key):
        m = re.search(r"^" + re.escape(key) + r"\s*=\s*'([^']*)'", txt, re.M)
        return m.group(1) if m else ""
    def gsec(sec, key):
        m = re.search(r"^\[" + re.escape(sec) + r"\](.*?)(?=^\[|\Z)", txt, re.M | re.S)
        if not m:
            return ""
        m2 = re.search(r"^" + re.escape(key) + r"\s*=\s*'([^']*)'", m.group(1), re.M)
        return m2.group(1) if m2 else ""
    def gnum(sec, key):
        m = re.search(r"^" + re.escape(key) + r"\s*=\s*(\d+)", txt, re.M)
        return m.group(1) if m else ""
    return dict(filename=g("filename"), side=g("side"),
                url=gsec("download", "url"), hash=gsec("download", "hash"),
                hash_format=gsec("download", "hash-format"),
                mode=gsec("download", "mode"),
                cf_project=g("project-id") or gnum("update.curseforge", "project-id"),
                cf_file=g("file-id") or gnum("update.curseforge", "file-id"))


def curseforge_url(file_id, filename):
    """CurseForge 公开 CDN 直链：mediafilez.forgecdn.net/files/<fid//1000>/<fid%1000>/<文件名>
    已实测：keywheel（file 8459900）下载 60922 B，sha1 与清单一致。"""
    n = int(file_id)
    return "https://mediafilez.forgecdn.net/files/%d/%d/%s" % (n // 1000, n % 1000, filename)


def main():
    if not SCAN.is_file():
        sys.exit("缺少 %s（先跑 tools/scan_mods.py）" % SCAN)
    rows = json.loads(SCAN.read_text(encoding="utf-8"))
    keep = [r for r in rows if r["decision"] == "keep"]
    DIST.mkdir(parents=True, exist_ok=True)

    out = []
    missing = []
    for r in sorted(keep, key=lambda x: x["jar"]):
        jar = r["jar"]
        m = MANUAL_SOURCES.get(jar)
        if m:
            out.append((jar, r["md5"], str(r["size"]), m["source"], m["url"], "", "", m["note"]))
            continue
        mf = r.get("metafile")
        if not mf:
            missing.append(jar)
            continue
        info = parse_pw(INDEX / mf)
        if info["url"]:
            out.append((jar, r["md5"], str(r["size"]), "packwiz", info["url"], info["hash"],
                        info["hash_format"], "来自 minecraft/mods/.index/%s" % mf))
            continue
        if info["mode"] == "metadata:curseforge" and info["cf_file"]:
            out.append((jar, r["md5"], str(r["size"]), "curseforge",
                        curseforge_url(info["cf_file"], jar), info["hash"], info["hash_format"],
                        "CF project %s / file %s（清单 mode=metadata:curseforge，无现成 url，按 CF CDN 规则拼出）"
                        % (info["cf_project"], info["cf_file"])))
            continue
        out.append((jar, r["md5"], str(r["size"]), "manual", "", "", "",
                    "清单无直链（mode=%s），需人工分发" % (info["mode"] or "?")))

    with open(DIST / "server-mods.tsv", "w", encoding="utf-8") as f:
        f.write("# 服务端模组分发清单（keep %d 项）：filename / md5 / bytes / source / url / hash / hash-format / note\n" % len(out))
        f.write("# 生成：server-pack/tools/gen-dist-manifest.py（勿手编）\n")
        for t in out:
            # 空列写成 "-"：POSIX read 会折叠连续分隔符产生的空字段，不留空列才解析可靠
            f.write("\t".join(x if x != "" else "-" for x in t) + "\n")

    src_count = {}
    for t in out:
        src_count[t[3]] = src_count.get(t[3], 0) + 1
    print("== 分发清单 ==")
    print("  keep 模组数        = %d" % len(keep))
    print("  写入 dist/server-mods.tsv = %d 行" % len(out))
    print("  来源分布           = %s" % src_count)
    if missing:
        print("  [FAIL] 以下 keep 模组既无 .pw.toml 也不在 MANUAL_SOURCES：%s" % missing)
        sys.exit(1)
    manual = [t[0] for t in out if t[3] == "manual"]
    if manual:
        print("  需人工分发的 %d 个：%s" % (len(manual), manual))
    print("  [OK] 每个 keep 模组都有下载来源")


if __name__ == "__main__":
    main()
