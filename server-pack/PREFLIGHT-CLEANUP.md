# 开服/分发前的清理清单（PREFLIGHT-CLEANUP）

> 这份清单**不自动执行**：涉及删文件、删清单、改分发策略，属于人的决定。
> 每条给出「现象 → 后果 → 选项与代价」。命令可直接复制，但请先看后果。

## 1. 六个「有 jar 没清单」的模组

`minecraft/mods/*.jar` 里有 6 个 jar 在 `minecraft/mods/.index/` 找不到对应的 `.pw.toml`
（注意：`.pw.toml` 的文件名与 jar 名**不同**，别按文件名对比，以扫描报告为准）。
后果：**clone 这个仓库后跑「下载 Mod / packwiz install」的人拿不到这 6 个**，会缺件。
判断依据不是印象 —— 下面是 sha512 反查 Modrinth 的真实结果：

| jar | 服务端决策 | sha512 反查 Modrinth | 建议 |
|---|---|---|---|
| `connector-2.0.0-beta.17+1.21.1-full.jar` | keep | **命中** `u58R1TMW` / `2.0.0-beta.17+1.21.1` | **建清单**（Modrinth 源） |
| `kotlinforforge-5.12.0-all.jar` | keep | **命中** `ordsPcFz` / `5.12.0` | **建清单**（Modrinth 源） |
| `simurail-0.1.0+mc1.21.1+76f9008.jar` | keep | **未命中**（Modrinth 无此哈希，仅 CurseForge） | 只能**人工分发**；私有来源写进分发说明，jar 不入 git |
| `neo-voxy.jar` | drop（服务端剔除，客户端仍需） | **未命中**（上游 voxy 的 NeoForge 分支） | 客户端侧也要人工带；客户端清单里单列「自建/魔改」 |
| `let-them-talk-1.0.1+1.21.1+neoforge.jar` | drop（仅客户端） | 命中 `SZ1DDiij` | 建清单，客户端即可自动装 |
| `talking-heads-1.1.4+1.21.1+neoforge.jar` | drop（仅客户端） | 命中 `Os35nfkh` | 建清单 |

建清单（在 `packwiz-pack/` 里）：
```bash
packwiz modrinth add <slug-or-url>     # 生成 mods/<name>.pw.toml
packwiz refresh
```
**代价**：仓库开始追踪该模组的版本，以后「更新全部」会带上它。
不建的代价：每次 clone 都得从 `dist/server-mods.tsv` 或人工拷贝补齐。

## 2. 一个「有清单没 jar」的孤儿（真缺陷 · 待用户拍板）

**现状（2026-10-04 15:37 实测）**

| 项 | 值 |
|---|---|
| 清单 | `minecraft/mods/.index/create-bits-n-tracks.pw.toml`（640 B，md5 `9874d0664123168002dbf0384c71f6c7`，mtime 2026-10-03 20:13） |
| 声明内容 | `bits_n_tracks-1.0.3.1-release.jar`（Modrinth `wYkiNwv2` / 版本 `CbqV5KMv`，sha512 76dada3f…32fe5） |
| 磁盘上的 jar | `minecraft/mods/bits_n_tracks-1.0.3.1-release.jar.disabled`（261727 B，禁用） |
| git 跟踪状态 | 该清单**已被跟踪**，`git status --porcelain -- minecraft/mods/.index/` 当前**无输出**（干净） |
| `packwiz-pack/` 侧 | **没有**同名清单（已确认不存在，无需处理）—— 见下 |

**后果**：谁 clone 之后跑一次「下载 Mod」，这个被禁用的 mod 会被**重新下载并启用**（真 jar 落到
`bits_n_tracks-1.0.3.1-release.jar`，与 `.disabled` 并存且生效）—— 禁用决定被静默推翻。
这不是理论风险，是清单与磁盘不一致的必然结果。

**旁证（为什么这条更像「漏改」而不是「故意」）**：`packwiz-pack/README.md` 第 59 行已明确记录
「本仓库已排除 Create: Bits 'n' Tracks」，理由是 packwiz 的 `[option]` 没有 `disabled` 字段、
装上去会重新启用。**packwiz 那一侧已经处理干净，只有实例根的 `.index/` 漏了这一步。**

**原文已留档**（备份放在 `server-pack/` 下、不在 `.index/` 里，Prism/packwiz 不会读它，不构成复活风险）：
`server-pack/ops/orphan-manifest-backup/create-bits-n-tracks.pw.toml`（md5 与原文一致 `9874d066…f6c7`，
复原命令见同目录 `ORIGIN.md`）。

### 动手前先核验（三条，确认与本文一致再执行）

```bash
cd <实例>
ls -l minecraft/mods/bits_n_tracks-1.0.3.1-release.jar.disabled   # 期望：存在，261727 B
ls -l minecraft/mods/.index/create-bits-n-tracks.pw.toml         # 期望：存在，640 B
md5sum minecraft/mods/.index/create-bits-n-tracks.pw.toml        # 期望：9874d0664123168002dbf0384c71f6c7
git status --porcelain -- minecraft/mods/.index/                 # 期望：无输出（已跟踪且未修改）
```

### 选项 A（推荐）删清单，保留禁用决定 —— 可直接执行

```bash
cd <实例>
# 1) 删实例根的清单（唯一需要动的文件）
rm minecraft/mods/.index/create-bits-n-tracks.pw.toml

# 2) 事后验证
ls minecraft/mods/.index/create-bits-n-tracks.pw.toml    # 期望：No such file or directory
ls minecraft/mods/bits_n_tracks-1.0.3.1-release.jar.disabled   # 期望：仍在（禁用不受影响）
git status --porcelain -- minecraft/mods/.index/         # 期望：一行  " D minecraft/mods/.index/create-bits-n-tracks.pw.toml"
git status --porcelain | grep -c 'bits-n-tracks'         # 期望：1
```

**`git status` 预期变化（改前 → 改后）**：改前该路径**无输出**；改后出现一条
` D minecraft/mods/.index/create-bits-n-tracks.pw.toml`（工作区删除、未暂存）。
其余已跟踪文件不应有任何新增变化 —— 若 `git status` 里冒出别的条目，说明动到了不该动的东西，请立刻停下。
**不需要**碰 `packwiz-pack/`（那里根本没有这个文件，`packwiz refresh` 是多余的）。

### 复原（若之后决定恢复该 mod 的清单）

```bash
cd <实例>
cp server-pack/ops/orphan-manifest-backup/create-bits-n-tracks.pw.toml \
   minecraft/mods/.index/create-bits-n-tracks.pw.toml
md5sum minecraft/mods/.index/create-bits-n-tracks.pw.toml   # 应回到 9874d0664123168002dbf0384c71f6c7
```
（复原后 `git status` 应回到「无输出」；若删除那一步已经被 commit，则需要 `git checkout -- <路径>` 或重新 `git add`。）

### 其余选项

* **B 恢复 jar**（若当初禁用是误操作）：把 `.disabled` 改回 `.jar`，清单不动
* **C（不要选）**：留着清单、jar 保持 `.disabled` —— 就是现在的状态，等于埋雷

## 3. 由此得到的两条操作纪律（并入 mod 管理流程）

1. **删 mod ⇒ 同时删对应 `.pw.toml`**（`minecraft/mods/.index/` 与 `packwiz-pack/mods/` 两处），
   再 `packwiz refresh`。只删 jar 就会制造孤儿清单。
2. **禁用 mod（改名 `.disabled`）⇒ 把 `.pw.toml` 一并移走或删掉**，否则「下载 Mod」会把它复活。
   `minecraft/_disabled_2026-10-03/` 里的 5 个已连带处理过，问题只出在 bits_n_tracks 这一个。

## 4. 和 server-pack 的关系（为什么这几条不影响本次交付）

* 本次扫描**遍历磁盘上的 333 个 jar**，孤儿清单没有对应 jar ⇒ 不进 keep/drop 任何一边；
  6 个无清单 jar 则按「无 packwiz 元数据」单独人工核对（见 `tools/scan_mods.py` 的 MANUAL 段）。
* 服务端 3 个无清单 keep（connector / kotlinforforge / simurail）已在 `dist/server-mods.tsv` 里
  给出下载来源或人工标记 ⇒ **开服这一步不受影响**。
* 受影响的是「客户端从仓库还原」这条路径，那是仓库（U1/U3）的分内事。
  本文**只登记问题与建议，未改动 `minecraft/` 里任何文件**。

## 5. 复现本文判断

```bash
cd <实例> && python3 -c "
import json
rows=json.load(open('server-pack/reports/mods-scan.json'))
print('无清单 jar:', [r['jar'] for r in rows if not r.get('metafile')])
print('keep 且无清单:', [r['jar'] for r in rows if not r.get('metafile') and r['decision']=='keep'])
"
grep '孤儿元数据' server-pack/reports/reconcile.txt
```
