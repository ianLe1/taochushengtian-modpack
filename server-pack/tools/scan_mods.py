#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""server-pack/tools/scan_mods.py — 服务端模组筛选扫描器（只读 minecraft/mods/）

用途：把 minecraft/mods/ 下的每个 jar 按「依据」分类为
  - 可上专用服 (server-mods.list)
  - 仅客户端、必须从服务端包剔除 (client-only.list)
并产出一份「必须真机开服才能确认」的清单 (verify-on-server.list)。

依据来源（按强度排序）：
  A 权威(元数据)  Modrinth 项目的 server_side == "unsupported"（mod 作者自报，可引用）
  B 清单声明      neoforge.mods.toml / mods.toml 里 clientSideOnly=true 或 [[mods]] 块内 side="CLIENT"
                  fabric.mod.json 的 "environment":"client"（仅在 jar 无 NeoForge 清单、即 fabric 主体时采信）
  C 人工/上游     无元数据的自建 jar（neo-voxy / simurail / 6 个无清单 jar）逐个人工核，写明出处
  D 未知          无元数据且无声明 -> 默认保留，进 verify-on-server.list

用法：
  python3 server-pack/tools/scan_mods.py            # 联网拉 Modrinth，同时写缓存
  python3 server-pack/tools/scan_mods.py --offline  # 只用已有缓存（结果与联网首次一致）

产物（全部写在 server-pack/ 下，绝不写 minecraft/）：
  server-mods.list  client-only.list  verify-on-server.list
  reports/mods-scan.json  reports/mods-scan.tsv  reports/modrinth-cache.json
  reports/reconcile.txt   reports/md5sums.txt
"""
import argparse, glob, hashlib, json, os, re, sys, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve()
ROOT = HERE.parents[2]                 # <实例>/
MODS = ROOT / "minecraft" / "mods"
INDEX = MODS / ".index"
OUT = ROOT / "server-pack"
REPORTS = OUT / "reports"
CACHE = REPORTS / "modrinth-cache.json"
UA = {"User-Agent": "dsh-server-pack/0.1 (offline audit)"}

# ---- 无 packwiz 元数据的 jar：人工核对（依据逐条写明来源）-------------------
MANUAL = [
    dict(pat="connector-*", modid="connector", decision="keep",
         tier="C-manual",
         ev="Sinytra Connector：Modrinth 项目 connector client_side=optional / server_side=optional；"
            "本包内为 Fabric 兼容层（META-INF/jarjar 内嵌 connector 本体 + runtime），仅当启用 Fabric 模组时需要；"
            "本包 Fabric 模组已全部禁用 ⇒ 服务端可保留，也可移除以减小体积（无硬依赖）"),
    dict(pat="kotlinforforge-*", modid="kotlinforforge", decision="keep",
         tier="C-manual",
         ev="Kotlin for Forge：Modrinth 项目 kotlin-for-forge client_side=optional / server_side=optional；"
            "库模组（纯 jar-in-jar：kotlin-stdlib/kfflib/kfflang），KotlinLangForge 等服务端可用模组的前置 ⇒ 保留"),
    dict(pat="let-them-talk-*", modid="let_them_talk", decision="drop",
         tier="A+B",
         ev="Modrinth 项目 let-them-talk client_side=required / server_side=unsupported；"
            "且 jar 内 neoforge.mods.toml 的 [[mods]] 块声明 side=\"CLIENT\"，描述自述 Client-side Addon for Plasmo Voice"),
    dict(pat="talking-heads-*", modid="talkingheads", decision="drop",
         tier="A+B",
         ev="Modrinth 项目 talkingheads client_side=required / server_side=unsupported；"
            "且 jar 内 neoforge.mods.toml 的 [[mods]] 块声明 side=\"CLIENT\"，描述自述 Client-side Addon"),
    dict(pat="neo-voxy*", modid="voxy", decision="drop",
         tier="C-upstream",
         ev="上游 Modrinth 项目 voxy client_side=required / server_side=unsupported；"
            "本 jar 是其 NeoForge 分支 neo-voxy 0.3.3（manifest 未写 side，故非清单级硬证据）："
            "含 client.voxy.mixins.json/iris.voxy.mixins.json、assets/ 72 项、内嵌 lwjgl_lmdb/zstd 原生库，无 data/ 服务端内容"),
    dict(pat="simurail-*", modid="simurail", decision="keep",
         tier="D-unknown",
         ev="Create Simurail：Modrinth 无此项目（仅 CurseForge）；jar 内 neoforge.mods.toml 未声明任何 side；"
            "含 assets/217 + data/76（有服务端内容），依赖 minecraft [1.21,1.21.2) 与 sable ⇒ 默认保留，待真机确认"),
]

FABRIC_ENV_RE = re.compile(r'"environment"\s*:\s*"client"')
CLIENT_SIDE_ONLY_RE = re.compile(r'clientSideOnly\s*=\s*true')
SIDE_CLIENT_RE = re.compile(r'side\s*=\s*"CLIENT"')
BLOCK_RE = re.compile(r"^\s*\[\[([^\]]+)\]\]", re.M)


def md5(p):
    h = hashlib.md5()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def parse_metafiles():
    """读 minecraft/mods/.index/*.pw.toml（packwiz 元数据，单引号 TOML）"""
    recs = {}
    for f in sorted(glob.glob(str(INDEX / "*.pw.toml"))):
        t = open(f, encoding="utf-8").read()
        def g(k):
            m = re.search(k + r"\s*=\s*['\"]([^'\"]*)['\"]", t)
            return m.group(1) if m else None
        mid = None
        m = re.search(r"\[update\.modrinth\]\s*\n\s*mod-id\s*=\s*['\"]([^'\"]+)['\"]", t)
        if m:
            mid = m.group(1)
        recs[os.path.basename(f)] = dict(filename=g("filename"), side=g("side"),
                                         modrinth_id=mid, hash=g("hash"), url=g("url"))
    return recs


def iter_blocks(txt, kind):
    """返回 toml 中 [[kind]] 或 [[kind.*]] 的块文本（含 mod 依赖块）"""
    res = []
    for m in BLOCK_RE.finditer(txt):
        h = m.group(1).strip()
        if h != kind and not h.startswith(kind + "."):
            continue
        seg = txt[m.end():]
        nxt = BLOCK_RE.search(seg)
        res.append(seg[:nxt.start()] if nxt else seg)
    return res


def parse_jar(path):
    """只读提取 jar 的清单证据"""
    import zipfile
    info = dict(manifest=None, modids=[], client_side_only=False, mod_block_side_client=False,
                fabric_env_client=False, dep_side_client=False, badzip=None)
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        info["badzip"] = str(e)
        return info
    txt = ""
    for cand in ("META-INF/neoforge.mods.toml", "META-INF/mods.toml"):
        if cand in z.namelist():
            info["manifest"] = cand
            txt += z.read(cand).decode("utf-8", "replace") + "\n"
    fab = "fabric.mod.json" in z.namelist()
    fabtxt = z.read("fabric.mod.json").decode("utf-8", "replace") if fab else ""
    z.close()
    info["fabric_primary"] = fab and info["manifest"] is None
    mod_blocks = iter_blocks(txt, "mods")
    info["modids"] = []
    for b in mod_blocks:
        info["modids"] += re.findall(r'modId\s*=\s*"([^"]+)"', b)
    info["client_side_only"] = bool(CLIENT_SIDE_ONLY_RE.search(txt))
    info["fabric_env_client"] = bool(FABRIC_ENV_RE.search(fabtxt))
    # [[mods]] 块内 side="CLIENT"（mod 级声明，区别于 [[dependencies.*]] 的 side）
    info["mod_block_side_client"] = any(SIDE_CLIENT_RE.search(b) for b in mod_blocks)
    # 依赖块（type/side）供「剔除后的依赖闭合检查」
    info["deps"] = []
    for b in iter_blocks(txt, "dependencies"):
        dep_id = re.search(r'modId\s*=\s*"([^"]+)"', b)
        typ = re.search(r'type\s*=\s*"([^"]+)"', b) or re.search(r'mandatory\s*=\s*(\w+)', b)
        side = re.search(r'side\s*=\s*"([^"]+)"', b)
        info["deps"].append(dict(modId=dep_id.group(1) if dep_id else None,
                                 type=typ.group(1) if typ else "unknown",
                                 side=side.group(1) if side else "BOTH"))
    # 依赖级 side="CLIENT" 仅作提示，不作为剔除依据
    info["dep_side_client"] = bool(SIDE_CLIENT_RE.search(txt)) and not info["mod_block_side_client"]
    return info


def fetch_modrinth(ids, cache):
    missing = [i for i in ids if i not in cache]
    for k in range(0, len(missing), 100):
        chunk = missing[k:k + 100]
        url = "https://api.modrinth.com/v2/projects?ids=" + urllib.parse.quote(json.dumps(chunk))
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
        except Exception as e:
            print("WARN Modrinth batch failed: %s" % e, file=sys.stderr)
            continue
        for p in data:
            cache[p["id"]] = dict(slug=p.get("slug"), title=p.get("title"),
                                  client_side=p.get("client_side"), server_side=p.get("server_side"))
        for i in chunk:
            cache.setdefault(i, dict(slug=None, title=None, client_side="unknown",
                                     server_side="unknown", error="not-found"))
    return cache


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()
    REPORTS.mkdir(parents=True, exist_ok=True)

    cache = json.load(open(CACHE, encoding="utf-8")) if CACHE.exists() else {}
    metas = parse_metafiles()
    jars = sorted(glob.glob(str(MODS / "*.jar")))
    by_name = {os.path.basename(j): j for j in jars}
    fname_to_meta = {}
    for mf, rec in metas.items():
        if rec["filename"]:
            fname_to_meta.setdefault(rec["filename"], []).append((mf, rec))

    if not args.offline:
        ids = sorted(set(r["modrinth_id"] for r in metas.values() if r["modrinth_id"]))
        cache = fetch_modrinth(ids, cache)
        json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False, indent=1, sort_keys=True)

    rows = []
    for name in sorted(by_name):
        jp = by_name[name]
        jinfo = parse_jar(jp)
        mlist = fname_to_meta.get(name, [])
        meta = mlist[0][1] if mlist else None
        mr = cache.get(meta["modrinth_id"]) if meta and meta["modrinth_id"] else None
        ev, tier = [], set()
        if mr and mr.get("server_side") == "unsupported":
            ev.append("Modrinth 项目 %s server_side=unsupported (client_side=%s)" % (mr.get("slug"), mr.get("client_side")))
            tier.add("A")
        if jinfo["client_side_only"]:
            ev.append("jar 内 %s 声明 clientSideOnly=true" % jinfo["manifest"])
            tier.add("B")
        if jinfo["mod_block_side_client"]:
            ev.append("jar 内 %s 的 [[mods]] 块声明 side=\"CLIENT\"" % jinfo["manifest"])
            tier.add("B")
        if jinfo["fabric_env_client"] and jinfo["fabric_primary"]:
            ev.append("fabric.mod.json environment=client（该 jar 无 NeoForge 清单，fabric 主体）")
            tier.add("B")
        manual = next((m for m in MANUAL if __import__("fnmatch").fnmatch(name, m["pat"])), None)
        if manual:
            decision = manual["decision"]
            ev = [manual["ev"]]
            tier = {manual["tier"]}
            modid = manual["modid"]
            src = "manual"
        else:
            decision = "drop" if ev else "keep"
            modid = ",".join(jinfo["modids"][:3]) or (meta["modrinth_id"] if meta else "-")
            src = "auto"
        rows.append(dict(jar=name, md5=md5(jp), size=os.path.getsize(jp),
                         modids=jinfo["modids"], manifest=jinfo["manifest"],
                         metafile=mlist[0][0] if mlist else None,
                         packwiz_side=(meta or {}).get("side"),
                         modrinth_id=(meta or {}).get("modrinth_id"),
                         modrinth=mr, decision=decision, deps=jinfo["deps"],
                         tiers=sorted(tier), evidence=ev, source=src,
                         fabric_env_client=jinfo["fabric_env_client"],
                         dep_side_client_hint=jinfo["dep_side_client"]))

    drop = [r for r in rows if r["decision"] == "drop"]
    keep = [r for r in rows if r["decision"] == "keep"]
    # 冲突提示：fabric 声明 client 但 Modrinth 说服务端可用（NeoForge 装载时不读 fabric.mod.json）
    conflicts = [r for r in rows if r["fabric_env_client"] and r["manifest"]
                 and (r["modrinth"] or {}).get("server_side") == "required"]
    verify = [r for r in keep if not (r["modrinth"] or {}).get("server_side") == "required"
              or r["source"] == "manual"]

    # ---- 依赖闭合检查：剔除客户端模组后，保留模组的 required 依赖是否仍满足 ----
    IGNORE = {"minecraft", "neoforge", "forge", "fml", "java"}
    kept_ids = set(i for r in keep for i in r["modids"])
    dropped_ids = set(i for r in drop for i in r["modids"])
    dep_conflicts, dep_missing, dep_client_only = [], [], []
    for r in keep:
        for d in r["deps"]:
            mid = d["modId"]
            if not mid or mid in IGNORE:
                continue
            if d["type"] not in ("required", "true", "mandatory"):
                continue
            if d["side"] == "CLIENT":
                if mid in dropped_ids:
                    dep_client_only.append((r["jar"], mid))
                continue
            if mid in dropped_ids:
                dep_conflicts.append((r["jar"], mid))
            elif mid not in kept_ids:
                dep_missing.append((r["jar"], mid))
    with open(REPORTS / "dep-check.txt", "w", encoding="utf-8") as f:
        f.write("依赖闭合检查（保留 %d vs 剔除 %d；只看 type=required 的依赖）\n" % (len(keep), len(drop)))
        f.write("  [FAIL] 保留模组的 required 依赖指向被剔除的客户端模组 = %d\n" % len(dep_conflicts))
        for a, b in dep_conflicts:
            f.write("    - %s -> %s\n" % (a, b))
        f.write("  [WARN] 保留模组的 required 依赖在服务端包内不存在 = %d\n" % len(dep_missing))
        for a, b in dep_missing:
            f.write("    - %s -> %s\n" % (a, b))
        f.write("  [OK] required 依赖标 side=CLIENT 且指向被剔除模组（客户端依赖，服务端不需）= %d\n" % len(dep_client_only))
        for a, b in dep_client_only[:40]:
            f.write("    - %s -> %s\n" % (a, b))

    def tsv(path, header, items, cols):
        with open(path, "w", encoding="utf-8") as f:
            f.write("# %s\n" % header)
            f.write("# 生成：server-pack/tools/scan_mods.py%s\n" % (" --offline" if args.offline else ""))
            for it in items:
                f.write("\t".join(str(c(it)).replace("\t", " ") for c in cols) + "\n")

    tsv(OUT / "client-only.list",
        "仅客户端模组（必须从专用服剔除）：jar / modid / 依据强度 / 依据",
        drop, [lambda r: r["jar"], lambda r: ",".join(r["modids"][:2]) or r["modrinth_id"] or "-",
               lambda r: "+".join(r["tiers"]) or "-", lambda r: " | ".join(r["evidence"])])
    tsv(OUT / "server-mods.list",
        "可上专用服模组：jar / modid / Modrinth server_side / 备注",
        keep, [lambda r: r["jar"], lambda r: ",".join(r["modids"][:2]) or r["modrinth_id"] or "-",
               lambda r: (r["modrinth"] or {}).get("server_side", "unknown"),
               lambda r: ("manual: " + r["evidence"][0][:120]) if r["source"] == "manual"
               else ("packwiz side=%s" % r["packwiz_side"] if r["packwiz_side"] else "")])
    tsv(OUT / "verify-on-server.list",
        "必须真机开服才能定的模组：jar / modid / server_side / 为什么要实测",
        verify, [lambda r: r["jar"], lambda r: ",".join(r["modids"][:2]) or r["modrinth_id"] or "-",
                 lambda r: (r["modrinth"] or {}).get("server_side", "no-metadata"),
                 lambda r: "无元数据/人工判定" if r["source"] == "manual"
                 else ("server_side=%s≠required ⇒ 是否需要在服务端保留需实测" % (r["modrinth"] or {}).get("server_side", "absent"))])

    json.dump(rows, open(REPORTS / "mods-scan.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    with open(REPORTS / "mods-scan.tsv", "w", encoding="utf-8") as f:
        f.write("jar\tmd5\tbytes\tmodids\tmanifest\tpackwiz_side\tmodrinth_id\tclient_side\tserver_side\tdecision\ttiers\tsource\tevidence\n")
        for r in rows:
            f.write("\t".join([r["jar"], r["md5"], str(r["size"]), ",".join(r["modids"]),
                               r["manifest"] or "-", r["packwiz_side"] or "", r["modrinth_id"] or "",
                               (r["modrinth"] or {}).get("client_side", ""), (r["modrinth"] or {}).get("server_side", ""),
                               r["decision"], "+".join(r["tiers"]) or "-", r["source"],
                               " | ".join(r["evidence"])]) + "\n")
    with open(REPORTS / "md5sums.txt", "w", encoding="utf-8") as f:
        for r in keep:
            f.write("%s  %s\n" % (r["md5"], r["jar"]))

    orphan = sorted(set(r["filename"] for r in metas.values() if r["filename"]) - set(by_name))
    nomf = sorted(r["jar"] for r in rows if not r["metafile"])
    with open(REPORTS / "reconcile.txt", "w", encoding="utf-8") as f:
        f.write("对账（%d 个 jar）\n" % len(rows))
        f.write("  jar 总数            = %d\n" % len(rows))
        f.write("  剔除(仅客户端)      = %d\n" % len(drop))
        f.write("  保留(可上专用服)    = %d\n" % len(keep))
        f.write("  保留中需真机验证    = %d（verify-on-server.list）\n" % len(verify))
        f.write("  校验 剔除+保留==总数 : %s\n" % ("OK" if len(drop) + len(keep) == len(rows) else "FAIL"))
        f.write("  无 packwiz 元数据 jar = %d %s\n" % (len(nomf), nomf))
        f.write("  孤儿元数据(有清单无 jar) = %d %s\n" % (len(orphan), orphan))
        f.write("  依赖闭合 [FAIL] required->被剔除客户端模组 = %d（reports/dep-check.txt）\n" % len(dep_conflicts))
        f.write("  依赖闭合 [WARN] required->服务端包内不存在   = %d（reports/dep-check.txt）\n" % len(dep_missing))
        f.write("  fabric 声明 client 但 Modrinth=required 的冲突 = %d\n" % len(conflicts))
        for c in conflicts:
            f.write("    - %s (Modrinth %s server_side=%s)\n" % (c["jar"], (c["modrinth"] or {}).get("slug"), (c["modrinth"] or {}).get("server_side")))
    print(open(REPORTS / "reconcile.txt", encoding="utf-8").read())
    print("CLIENT-ONLY (%d):" % len(drop))
    for r in drop:
        print("  - %s  [%s]  %s" % (r["jar"], "+".join(r["tiers"]), r["evidence"][0][:110]))


if __name__ == "__main__":
    main()
