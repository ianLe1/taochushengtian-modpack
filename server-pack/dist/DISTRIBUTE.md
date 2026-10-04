# 分发说明（server-pack）

> 目标读者：要把这个整合包开到专用服上的人，以及维护 fork 的人。
> 一句话：**白名单仓库负责「清单」，本目录的 dist/ 负责「拿到 jar」** —— 两者不能互相替代。

## 1. 三样东西的关系（先把它们分清）

| 东西 | 内容 | 能不能拿到 jar | 用途 |
|---|---|---|---|
| 白名单 git 仓库（`packwiz-pack/`，以及实例根仓库） | `.pw.toml` / `index.toml` / `pack.toml` 等**元数据**，不含 jar（分发条例 U3） | ❌ | 同步「要装什么、什么版本」；`packwiz refresh/install` 靠它 |
| `dist/server-mods.tsv` | 服务端 253 个 jar 的文件名 + md5 + 直链 + 官方哈希 | ✅ 描述所有 jar 的来源 | 「拿到 jar」的唯一权威清单 |
| `dist/download-mods.sh` | 读上面那份 TSV 并下载 + 逐文件校验 | ✅ 落地 | 一台空服务器从零装满模组 |

**为什么必须两套**：仓库不带 jar 是硬约束（避免把 bin 塞进 git、也避免再分发条款风险），
所以「clone 仓库就能开服」这个期待本身不成立 —— 必须再多一步「按清单把 jar 拉下来」。
这正是 U15/§9 风险 8 要处理的那件事。

## 2. 三条可用路径

**路径 A —— 全新服务器（推荐）**（在 server-pack/ 目录里执行）
```bash
python3 tools/gen-dist-manifest.py                # 清单已随包提供；改了 mods 才需要重跑
tools/make-server.sh --target /srv/mc --no-mods --with-config
dist/download-mods.sh --target /srv/mc/mods       # 253 个 jar 逐个下载并校验
cd /srv/mc && ./start.sh --check
```
**路径 B —— 本机/局域网（最快）**：模组直接从本机实例拷，不联网
```bash
./tools/make-server.sh --target /srv/mc --with-config
```
**路径 C —— 已经有客户端并装了 packwiz**：用 packwiz 同步，然后按 TSV 补齐 3 个「不在仓库里」的模组
（connector / kotlinforforge / simurail，见 §4）

> 脚本位置注：`download-mods.sh` 默认在它自己所在目录找 `server-mods.tsv`，所以要么直接调用
> `server-pack/dist/download-mods.sh`，要么把 `dist/` 整个拷到目标机上。

## 3. 校验口径（怎么知道装对了）

* `download-mods.sh --check --target <mods目录>`：逐文件按清单哈希校验，缺/坏逐条列出，非零退出。
* 已实测对账：对**本机实例的 minecraft/mods/** 跑 `--check` ⇒ **253/253 全部通过，exit=0**。
  也就是说清单里的哈希与磁盘上的 jar 一一对得上，不是抄来的。
* 抽验下载（联网真下 + 校验）：
  * Modrinth 路径（sha512）：`sableexplosionfix-1.0.0.jar` 4795 B ✓
  * CurseForge 路径（sha1）：`keywheel-neoforge-1.1.7-1.21.1-java21.jar` 60922 B ✓
  * 幂等性：同一文件重复跑 ⇒ 「已存在且校验通过 1，本次下载 0」✓
* **未做全量下载**（253 个、约 556 MB）：只抽验了上述样本。首次全量建议在网络好的时候跑，
  失败项会被记录并重跑补齐（幂等）。

## 4. 需要人工处理的 1 项 + 3 项特别说明

| jar | 来源 | 说明 |
|---|---|---|
| `simurail-0.1.0+mc1.21.1+76f9008.jar` | **人工** | Modrinth 没有这个哈希（只在 CurseForge），也没有 `.pw.toml` ⇒ 只能从本地副本拷进 `mods/` |
| `connector-2.0.0-beta.17+1.21.1-full.jar` | modrinth | 无 `.pw.toml`；用 sha512 反查到 Modrinth 项目 `u58R1TMW`，直链已写进 TSV |
| `kotlinforforge-5.12.0-all.jar` | modrinth | 同上，项目 `ordsPcFz` / version `5.12.0` |
| `neo-voxy.jar` | 人工（客户端侧） | 服务端已剔除；但**客户端仍需要**它，且 Modrinth 无此哈希 ⇒ 客户端分发也要人工带 |

`dist/download-mods.sh` 遇到人工项会打印 `[MANUAL]` 并列入「待处理清单」，**不会静默跳过**。

## 5. 16 个 CurseForge 模组的直链是怎么来的（口径，别当成猜的）

这 16 个的 `.pw.toml` 是 `mode = 'metadata:curseforge'`，**没有现成 url**，只有
`[update.curseforge] project-id / file-id` 和 `sha1`。清单里的直链按 CurseForge 公开 CDN 规则拼出：

```
https://mediafilez.forgecdn.net/files/<file-id 整除 1000>/<file-id 模 1000>/<文件名>
```

* 例：`croptopia.pw.toml` file-id=7958876 ⇒ `https://mediafilez.forgecdn.net/files/7958/876/croptopia-neoforge-1.21.1-4.2.4.jar`（实测 HTTP 200）
* `edge.forgecdn.net` 对同一路径返回 302 → `mediafilez.forgecdn.net`（等价，脚本用 302 后终址亦可）
* CurseForge 官方 API `/api/v1/mods/<pid>/files/<fid>/download` 需要 API key/浏览器，本环境实测 403（Cloudflare challenge）⇒ 不走它
* 校验值取自 `.pw.toml` 里的 sha1（不是我们算的）；已抽验 keywheel 一个文件的 sha1 完全一致

## 6. IPv6 陷阱（本环境实测，务必知道）

`cdn.modrinth.com` 在本机解析到 Fastly 的 IPv6（`2a04:4e42:8c::498`）时，TLS 握手会
`error:0A000126:SSL routines::unexpected eof while reading`（curl 35）；加 `-4` 强制 IPv4 后 **HTTP 200**。
因此 `download-mods.sh` **默认加 --ipv4**；纯 IPv6 主机可以 `--no-ipv4` 关掉。
（`mediafilez.forgecdn.net` 与 `api.modrinth.com` 不受影响。）

## 7. 分发纪律（照抄 U3 的要求）

* **不要把 jar / mrpack / zip 提交进任何 git 仓库**（实例根仓库与 `packwiz-pack/` 都不行）。
  `server-pack/dist/` 里只有清单与脚本，没有二进制 —— 保持这样。
* 每次改 mods，先改仓库里的 `.pw.toml`（增删都要），再重跑 `../tools/gen-dist-manifest.py` 让清单跟上；
  **手编 TSV 一定会漂移。**
* 分发前把 `config/` 过一遍：里面有个人设置与本机路径（键位、HUD、性能参数），不是所有人都该原样继承。
