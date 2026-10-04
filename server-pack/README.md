# server-pack —— 「逃出生天」专用服产物（M0）

> 任务：把纯客户端实例变成**能开起来的专用服**（战服开发方案 M0 第一件事）。
> 本目录是**新增**的，全程**只读** `minecraft/`：没有移动、删除、改名过任何一个 jar，也没有 git commit。
> 本目录**不含 jar**（分发条例），只有清单、脚本与文档。

## 1. 结论摘要（快照：2026-10-04 15:22 扫描时点）

| 类别 | 数量 | 体积 | 结论 | 明细文件 |
|---|---|---|---|---|
| 实盘 jar 总数 | 333 | 923.4 MB | 全部逐个解析了 `neoforge.mods.toml`/`mods.toml`/`fabric.mod.json` | `reports/mods-scan.json` |
| **服务端可用（keep）** | **253** | 556.4 MB | 可放进专用服 `mods/` | `server-mods.list` |
| **仅客户端（drop）** | **80** | 367.0 MB | **必须从专用服剔除** | `client-only.list` |
| 待真机验证（keep 的子集） | 55 | — | 判据不足，只有真开服才能定 | `verify-on-server.list` |
| 对账 | — | — | 剔除 80 + 保留 253 = 333 ✓ | `reports/reconcile.txt` |
| 分发来源 | 253 | — | 可用直链拿到 252（其中 1 项需人工） | `dist/server-mods.tsv` |

清单对账的硬证据：`dist/download-mods.sh --check --target minecraft/mods` ⇒
**253/253 哈希通过，exit=0**（清单里的哈希与磁盘上的 jar 一致，不是抄来的）。

## 2. 剔除依据的口径（为什么这 80 个被判仅客户端）

只有**拿到证据**才剔，证据分四级；**证据不足一律 keep**（宁可多留也不误剔）：

| 级别 | 数量 | 判据 | 例子 |
|---|---|---|---|
| **A** | 70 | Modrinth 项目 `server_side=unsupported`（权威服务端侧声明） | `AmbientSounds`、`AdvancementPlaques` |
| **B** | 1 | jar 内清单自述仅客户端（`clientSideOnly=true` / `[[mods]] side="CLIENT"` / `fabric.mod.json environment=client`） | `alexsimprovements-1.2.4.jar` |
| **A+B** | 8 | 上面两条**独立**证据同时成立 | `Flashback`、`entity_texture_features`、`sable-cool-rain`、`sounds`、`pv-addon-flashback`、`emixx`、`let-them-talk`、`talking-heads` |
| **C-upstream** | 1 | 上游项目 `server_side=unsupported` + jar 内容特征（该 jar 清单未写 side，故非清单级硬证据） | `neo-voxy.jar` |

保留侧的分布（用于说明「为什么这 55 个要实测」）：
`packwiz side` = both 143 / server 43 / 空 66 / **client 1**（`create-jadeaddon-tfmg-compat-1.0.0.jar`，
Modrinth 无该项目，依赖标 CLIENT ⇒ 归入待验，不剔）。
另有 6 个 jar 没有 packwiz 元数据，逐个人工核对（`tools/scan_mods.py` 的 MANUAL 段），
其中 3 个 keep（connector / kotlinforforge / simurail）已在 `dist/server-mods.tsv` 里给出来源或人工标记。

## 3. 文件索引

| 文件 | 作用 | 什么时候用 |
|---|---|---|
| `VERSION-LOCK.md` | 版本锁定：MC 1.21.1 / NeoForge 21.1.251 / Java 21.0.7 + 安装器 md5 | 装服之前必读 |
| `server.properties.template` | 逐项带「为什么」的服务端配置模板 | `make-server.sh` 会自动拷；也可手抄 |
| `start.sh` | 启动脚本（含自检 `--check`、`--dry-run`） | 拷进服务端根目录后执行 |
| `user_jvm_args.txt` | 堆与 GC 参数（Aikar G1，10G 档） | 与 `start.sh` 一起用 |
| `server-mods.list` | 253 个服务端模组（jar / modid / server_side / 备注） | 人工核对 |
| `client-only.list` | 80 个被剔除模组 + **逐个的依据** | 复核剔除是否合理 |
| `verify-on-server.list` | 55 个必须实测的模组 + 为什么要实测 | 首次开服时重点盯 |
| `tools/scan_mods.py` | 扫描器：解析 333 个 jar 的清单 + 查 Modrinth 缓存 + 依赖闭合 | 改了 mods 之后重跑（注意联网与缓存） |
| `tools/make-server.sh` | 组装服务端根目录（模组 + 配置 + 脚本） | 开服第一步 |
| `tools/gen-dist-manifest.py` | 生成分发清单 `dist/server-mods.tsv` | 改了 mods 之后重跑 |
| `dist/server-mods.tsv` | 253 个 jar 的文件名 + md5 + 直链 + 官方哈希 | 分发/下载的唯一权威清单 |
| `dist/download-mods.sh` | 按清单下载 + 逐文件校验（幂等、可 `--check`） | 空服务器装满模组 |
| `dist/DISTRIBUTE.md` | 分发说明：仓库/清单/脚本三者关系、CF 直链口径、IPv6 陷阱 | 要把包给别人时 |
| `ops/backup-world.sh` | 世界定时备份（tar + sha256 + 保留策略 + 可解包自检） | 开服后加进 cron |
| `ops/restore-world.sh` | 恢复 / 列出 / **一键回滚演练 drill** | 放真人进来之前必须 drill 一次 |
| `PREFLIGHT-CLEANUP.md` | 6 个无清单 jar + 1 个孤儿清单的处理建议（§2 含**可直接执行的命令 + 改前/改后核验**） | 维护 mod 清单时 |
| `ops/orphan-manifest-backup/` | 孤儿清单的**原文留档**（`.pw.toml` + `ORIGIN.md` 说明与复原命令） | 决定删清单之前/之后 |
| `reports/` | 扫描原始数据与对账（JSON/TSV/md5/dep-check） | 复核任何一条结论 |

## 4. 怎么复现（改了 mods 之后）

```bash
cd <实例>
python3 server-pack/tools/scan_mods.py            # 重扫 333 个 jar（会读/更新 Modrinth 缓存，需联网）
python3 server-pack/tools/gen-dist-manifest.py    # 重生成分发清单
server-pack/tools/make-server.sh --target /srv/mc --no-mods --with-config
server-pack/dist/download-mods.sh --target /srv/mc/mods
cd /srv/mc && ./start.sh --check
```
扫描是**可重复**的，但依赖 `reports/modrinth-cache.json`（网络抖动会让结论漂移）；本次交付的结论都绑定在
这份 15:22 的快照上，改动 mods 之后必须重跑并重新对账。

## 5. 哪些结论**必须真机开服**才能定

1. **55 个** `verify-on-server.list`：Modrinth `server_side=optional/absent` 或未知 ⇒ 是否需要在服务端保留，只有实跑才知道。
2. **22 条** required 依赖在服务端包内不存在（`reports/dep-check.txt` 的 WARN）。
   两种解释都成立：①那是个客户端模组提供的依赖（正常）；②真的漏了（会崩）。**必须实开验证**。
   影响面最大的是 `simulated` / `aeronautics`（Create 航空系）与 `xaerolib` / `apollib`。
3. `create-jadeaddon-tfmg-compat-1.0.0.jar`（keep 里唯一 `side=client`）是否会让服务端报错/加载。
4. `allow-flight=true`、`max-tick-time=-1`、`view-distance=10`/`simulation-distance=6` 这组参数的实机表现
   （服务端配置的取舍理由写在模板注释里，但效果要实测）。
5. KubeJS：`--with-config` 会把 `kubejs/` 一起带上，其中**服务端侧脚本是否引用了仅客户端存在的类**，只有开服看日志才能定。
6. `max-players=20` 是占位值 —— 方案 §10 没给目标人数；人数定了才能算内存与视距。
7. 本实例**没有 world/**（纯客户端）⇒ 首次开服才生成世界。备份/回滚脚本是用**合成世界**验证的
   （见 §6），真实世界的第一份快照请在首次开服后立刻打一份并 drill。

## 6. 已经验证过的部分（证据）

* **清单对账**：253/253 哈希通过，exit=0（对 `minecraft/mods/` 实盘校验）。
* **真实下载抽验**：Modrinth 路径（sha512）`sableexplosionfix-1.0.0.jar` 4795 B ✓；
  CurseForge 路径（sha1）`keywheel-neoforge-1.1.7-1.21.1-java21.jar` 60922 B ✓；重复跑 ⇒ 幂等 ✓。
* **备份/回滚**：合成世界上 3 次备份 + `--keep 2` 触发保留策略；`restore-world.sh drill` 全程
  `[PASS]`（sha256 → 归档可读 → `level.dat` gzip 魔数 1f8b → 文件数对账 → 清理），exit=0。
* **make-server.sh**：合成实例上 dry-run / 实跑 / 缺件告警 / 非空目录拒绝覆盖 全部符合预期；
  对真实实例 dry-run 得到 253 条记录且**零缺失**。
* **start.sh --check**：在未装服务端的目录里按设计 `[FAIL]` 并提示先跑安装器（不是缺陷，是自检生效）。
* **版本事实**：Java `21.0.7`（Microsoft `java-runtime-delta`）、NeoForge 安装器 `21.1.251`
  本地副本 md5 `71719bf6615fb4ef01c1d27463085b16`。

## 7. 已知缺口（不要当成已解决）

* **未真机开服**：M0 的最终验收在真机上；本文所有「可上专用服」都是**静态证据**结论。
* **未全量下载 253 个 jar**（约 556 MB）：只抽验了 2 条分发路径 + 幂等性。
* `reports/mods-scan.json` 是 2026-10-04 15:22 的磁盘快照；之后任何 mods 改动都会让它过期。
* 服务端**尚未安装**（无 `libraries/`），`eula.txt` 需服主本人确认 —— 脚本刻意不代签。

## 8. 要不要让 `server-pack/` 进版本管理（**待用户拍板**，本文只给依据）

现状：实例根仓库是**白名单模式** —— `.gitignore` 第 7 行的 `/*` 默认忽略一切，再逐条放行。
`server-pack/` 没有对应的放行规则 ⇒ **整目录被忽略**（实测 `git check-ignore -v server-pack/README.md`
→ `.gitignore:7:/*`）。后果：不会误提交，但也不受版本管理 —— clone 之后拿不到这份产物，
只能人工拷（或从本次会话的交付里取）。

三种做法，`git status` 会多出什么、占多大，都是在临时仓库里**实测**的（复制真实 `.gitignore` + 真实 `server-pack/`）：

| 做法 | `.gitignore` 要改什么 | `git status` 多出 | 占用 |
|---|---|---|---|
| **A** 只放行目录 | 在**第 49 行**（`# =====黑名单=====` 注释）**之前**插 1 行 `!/server-pack/` | **25 个文件** | **676 KB**（其中 `reports/` 占 432 KB，`mods-scan.json` 单个 296 KB） |
| **B（推荐）** 放行目录 + 只跟文本交付物、忽略 `reports/` | 插下面那段 **27 行**片段 | **19 个文件** | **244 KB** |
| **C** 维持现状 | 不改 | 0（继续被忽略） | 0，但 clone 拿不到 |

**推荐 B 的片段**（插在 `.gitignore` 第 49 行之前，即白名单区的末尾）：

```gitignore
# ---- 专用服产物（server-pack）：只跟文本交付物 ----
!/server-pack/
/server-pack/*
!/server-pack/*.md
!/server-pack/*.list
!/server-pack/*.template
!/server-pack/start.sh
!/server-pack/user_jvm_args.txt
!/server-pack/dist/
/server-pack/dist/*
!/server-pack/dist/*.md
!/server-pack/dist/*.tsv
!/server-pack/dist/*.sh
!/server-pack/tools/
/server-pack/tools/*
!/server-pack/tools/*.py
!/server-pack/tools/*.sh
!/server-pack/ops/
/server-pack/ops/*
!/server-pack/ops/*.sh
!/server-pack/ops/orphan-manifest-backup/
/server-pack/ops/orphan-manifest-backup/*
!/server-pack/ops/orphan-manifest-backup/*.md
!/server-pack/ops/orphan-manifest-backup/*.toml
# server-pack/reports/ 与 __pycache__ 不入库（快照/缓存，会随时间漂移）
__pycache__/
```

**为什么写成这样（三条硬约束，改之前请先读）**：

1. **git 不能「忽略目录却放行里面的文件」**：要放行 `a/b/c.txt`，必须逐级放行目录 `a/`、`a/b/`，
   再 `/a/b/*` 全忽略，最后才放行具体文件。所以片段看着啰嗦，这是 gitignore 的语义要求，不是冗余。
2. **`reports/` 不该入库**：`mods-scan.json`（296 KB）/ `modrinth-cache.json` / `*.tsv` 是**某个时点的扫描快照**，
   内容随磁盘与网络漂移；入库只会制造噪声 diff。结论写在本文 §1/§2，快照可按 §4 的命令重跑复原。
3. **`__pycache__/` 已从交付里删掉**（`py_compile` 的副产物），片段里再挡一道，
   防止以后跑 `python3 -m py_compile` 又带进来。

**入库后仍要注意**：`dist/server-mods.tsv`（92 KB 文本）含 253 个 jar 的下载直链 ——
它是**清单**不是二进制，符合「仓库不带 jar」的纪律；但正因如此，**改了 `minecraft/mods/` 就必须重跑
`tools/gen-dist-manifest.py`**，否则清单与磁盘脱节（与 `PREFLIGHT-CLEANUP.md` §3 的纪律同源）。
