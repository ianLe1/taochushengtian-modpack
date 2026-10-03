# 逃出生天 · 整合包版本仓库

PrismLauncher 实例 `逃出生天-备份` 的**版本控制仓库**。设计参考
[基于 PrismLauncher 和 Git 版本控制的多人协作友好整合包开发环境](https://www.mcmod.cn/post/5088.html)：
仓库根就是 Prism 的**实例文件夹**（含 `minecraft/`、`instance.cfg`、`mmc-pack.json`），
用**白名单 `.gitignore`** 只放行「整合包定义 + 模组清单 + 配置 + 脚本」。

## 这个仓库里有什么

| 内容 | 路径 | 作用 |
|---|---|---|
| 实例定义 | `instance.cfg`、`mmc-pack.json`、`icon.png` | 加载器版本（NeoForge 21.1.251 / MC 1.21.1）、内存与 JVM 参数 |
| 模组清单 | `minecraft/mods/.index/*.pw.toml` | packwiz 格式元数据，**Prism 的「检查模组更新」据此一键下载全部模组** |
| 资源包 / 光影清单 | `minecraft/resourcepacks/.index/*.pw.toml`、`minecraft/shaderpacks/*.pw.toml` | 同上 |
| 模组配置 | `minecraft/config/` | 整合包调参的核心内容 |
| 脚本 | `minecraft/kubejs/` | KubeJS 脚本 |
| 键位轮盘 | `minecraft/keybind_bundles.json` | 键位轮盘（界面/光影两组）定义 |
| 文档 | `键位方案.md`、`键位改动表.md`、`键位自检小抄.md` | 上一轮键位改造的交付说明 |

## 什么**不**入库（分发合规）

`.gitignore` 是白名单模式（`/*` 先全忽略），以下内容**永远**不会进 git：

- **所有模组 `*.jar`、资源包/光影 `*.zip`、`*.mrpack`** —— 这是刻意的：本仓库只分发**清单与配置**，
  模组本体由使用者在 Prism 里按清单从 Modrinth / CurseForge 官方源下载，不经过本仓库。
- `saves/`（存档，含玩家数据）、`logs/`、`crash-reports/`、`screenshots/`、`downloads/`
- `.cache/`、`.kscan.*`、`.pg-native`、`.sable`、`tellus/`、`local/`、`parachute/`、`battleroyale/`、`data/`、`mcpskins/`
- `xaero/`、`XaeroWaypoints_BACKUP*`、`usernamecache.json`、`usercache.json`、`emi.json`、
  `command_history.txt`、`SHADER_DUMP.txt`、`*.log`、`streamsreflowing-stall-*.txt`
- `tacz/`、`tacz_backup/`、`_disabled_2026-10-03/`（枪包与禁用模组，均为第三方二进制）
- `kubejs/_recon/`、`.kbwork/`、`packwiz-pack/`（分析/施工用临时目录）

> ⚠️ `minecraft/options.txt` 目前**不入库**（它含分辨率、音量、语言等个人视频/音频设置）。
> 如果想连键位方案一起分发，把这行加进 `.gitignore`：`!/minecraft/options.txt`。
>
> ⚠️ 模组、资源包、光影、枪包各有自己的授权条款；本仓库不含它们的二进制文件，
> 但**发布前请再确认配置内容**（`config/`、`kubejs/`、文档）是否允许再分发。

## 怎么用

**你自己提交改动**

```bash
cd <Prism>/instances/逃出生天-备份
git status          # Prism 里加/删/改模组、改配置后，这里立刻能看到
git add -A && git commit -m "加了 xx 模组"
```

**别人克隆一份来玩**

```bash
cd <Prism>/instances/ && git clone <本仓库> 逃出生天
```

然后在 Prism 里对该实例执行**「检查模组更新」**：Prism 会按 `mods/.index/*.pw.toml`
把全部模组从官方源下载齐（这一步需要联网）。

## 与 `packwiz-pack/` 的关系

`packwiz-pack/` 是另一份**标准布局**的 packwiz 发布清单（`mods/<slug>.pw.toml` + `pack.toml` + `index.toml`），
面向 packwiz / packwiz-installer / `.mrpack` 导出。本仓库面向 Prism 实例本身，两者数据同源但用途不同；
`packwiz-pack/` 已被本仓库忽略，避免一个仓库套一个仓库。
