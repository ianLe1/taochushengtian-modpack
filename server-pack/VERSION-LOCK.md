# VERSION-LOCK —— 战争服版本锁（M0）

> 本文件是「不许动」清单。改版本 = 破坏 333 个 mod 与 328 条清单的兼容性，属于方案里的真冲突事项（技术负责人收口已确认：无升级计划）。

## 锁定的三件套

| 组件 | 锁定值 | 实测来源 |
|---|---|---|
| Minecraft | **1.21.1** | mmc-pack.json / instance.cfg |
| NeoForge | **21.1.251** | mmc-pack.json（客户端实例已装） |
| Java | **Microsoft OpenJDK 21.0.7 LTS**（java-runtime-delta, amd64） | instance.cfg 的 JavaPath + java -version |
| LWJGL | 3.3.3 | mmc-pack.json |

服务端与客户端这四项必须**主版本一致**；mod 只认这道门，不同则直接拒载或崩溃。

## 本机现成的服务端安装资源

- NeoForge 安装器（Prism 库缓存）：
  `~/.local/share/PrismLauncher/libraries/net/neoforged/neoforge/21.1.251/neoforge-21.1.251-installer.jar`
  md5 = `71719bf6615fb4ef01c1d27463085b16`
- 官方源（校验用，maven 返回 200）：
  `https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.251/neoforge-21.1.251-installer.jar`
- JRE：`/home/lee/.local/share/PrismLauncher/java/java-runtime-delta/bin/java`
  `openjdk version "21.0.7" 2025-04-15 LTS / OpenJDK Runtime Environment Microsoft-11369942 (build 21.0.7+6-LTS)`

## 安装服务端（一次性）

1. 建空目录（例：`/srv/逃出生天`），放入安装器。
2. `java -jar neoforge-21.1.251-installer.jar --installServer`
   —— 会生成 `libraries/`、`run.sh`、`user_jvm_args.txt`、`eula.txt`。
3. 用本目录的 `user_jvm_args.txt` 覆盖生成的同名文件（堆参数已按专用服调）。
4. 先跑一次生成 `mods/` 与 `server.properties`（首次只要接受 EULA），再用 `tools/make-server.sh` 灌入模组与配置。
5. `eula.txt` 里的 `eula=true` 必须由**服主本人**确认（这是 Mojang EULA 的同意行为，不由脚本代签）。

## 禁止事项

- ❌ 不要升 NeoForge / MC 去「修」某个 mod 的报错 —— 先查该 mod 是否本来就该被剔除。
- ❌ 不要在服务端装整合包里的客户端 only 模组（client-only.list 的 80 项）。
- ❌ 不要用打包器（Prism/packwiz）给服务端「更新全部」——服务端模组集合是人工收敛过的 253 项（见 README 计数）。
