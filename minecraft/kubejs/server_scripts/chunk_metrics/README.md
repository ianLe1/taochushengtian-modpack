# chunk_metrics —— 逐区块「破坏程度 / 人工程度」统计

给智能玩家选出生点用：对每个已扫描区块给出两个可直接互相比较的数值。

- 运行环境：Minecraft 1.21.1 + NeoForge 21.1.251 + KubeJS 7.2 (build 377)，Java 21。
- 落地位置：`<实例>/minecraft/kubejs/server_scripts/chunk_metrics/chunk_metrics.js`（本文件与 README 同目录）。
- 加载：放进上面的目录后在游戏里执行 `/reload`，看到日志 `[CM] chunk_metrics v1 就绪` 即成功。
- 无需改 options / 无需重启客户端以外的任何配置。

## 1. 两项指标

两者都归一到 **[0,1]**，同维度任意两区块可直接比较。

### 1.1 破坏程度 D —— 地形被改造 + 资源被开采

D = clamp( 0.30*B1 + 0.25*B2 + 0.25*B3 + 0.10*B4 + 0.10*B5 , 0, 1 )

| 分量 | 含义 | 怎么算 | 权重 |
|---|---|---|---|
| B1 | 地下人工痕迹 | 地表以下的火把/铁轨/梯子/脚手架数量，饱和映射 | 0.30 |
| B2 | 地下空腔超出自然基线 | (地表以下空气占比 - 自然空腔率基线)，饱和映射 | 0.25 |
| B3 | 地表被削低 | 每列与「局部参考面」(中值滤波) 的落差，超过阈值部分求均值，再乘人工佐证门控 | 0.25 |
| B4 | 矿石被剥露 | 抽样列里「≥2 面邻空气」的矿石密度估计 | 0.10 |
| B5 | 埋入岩层的人工材料 | 6 邻域有 ≥4 个自然固体的结构方块 / 地下体积，饱和映射 | 0.10 |

饱和映射：`sat(x, k) = x / (x + k)`（x<=0 时取 0）。它把任意大的原始量压进 [0,1)，**分数不能靠线性堆量无限刷高**。

### 1.2 人工程度 A —— 集中建筑与机械

A = clamp( 0.35*C1 + 0.25*C2 + 0.20*C3 + 0.10*C4 + 0.10*C5 , 0, 1 )

| 分量 | 含义 | 怎么算 | 权重 |
|---|---|---|---|
| C1 | 结构体量 x 质量 | 对每个「被认可的连通体」求 体积 x 质量，求和后饱和 | 0.35 |
| C2 | 机械/功能方块 | 有方块实体的方块 + 机械类后缀方块，数量 x 种类加成，饱和 | 0.25 |
| C3 | 成片度 | 最大连通体体积 / min(人工方块总数, 128) | 0.20 |
| C4 | 垂直发展 | 含结构的段数 + 结构高度跨度 | 0.10 |
| C5 | 地面铺装 | 结构方块贴近地表的列数占比 | 0.10 |

其中 C3/C4/C5 都再乘一个由 C1 导出的门控 `g = clamp(C1 / 0.05, 0, 1)`，
C2 乘 `clamp(最大连通体 / 32, 0, 1)`。**没有真实结构时这几项一起归零**，
避免「乱七八糟铺一地」或「一只落单的刷怪笼」凑出人工程度。

单个连通体的质量：

质量 = sizeFactor x (0.45 x 种类丰富度 + 0.35 x 形态丰富度 + 0.20 x 有无机械)

- sizeFactor = min(1, log1p(体积) / log1p(256))
- 种类丰富度 = min(1, 不同方块种类 / 6)
- 形态丰富度 = 0.5 + 0.5 x min(1, (台阶+楼梯+墙+栅栏+门+窗格+机械 占比) / 0.25)

## 2. 为什么不易被玩家滥用

1. **先要求「人工形态」**：一个连通体必须同时满足「台阶/楼梯/墙/栅栏/门/窗格/有方块实体的方块」≥ 2 个，且这类方块占比 ≥ 3%，才计入 C1。自然地形里几乎不存在台阶和方块实体，这条也顺带挡住了「未打标签的模组地形方块被误判成人工」的情况。
2. **实心同质体归零**：若一个连通体「方块种类 ≤ 3」且「包围盒填充率 ≥ 0.6」，质量直接记 0。堆一个 8x8x8 的鹅卵石实心大块，A = 0（自测实测确为 0.0000）。
3. **连通性门槛**：26 邻域连通分解，零散方块各自成 1 格连通体，体积质量极小；小于 4 格的连通体不计入体量。
4. **种类与形态丰富度**：单一材质的墙/柱子拿不到太多分，真实建筑通常混用多种材质与形态。
5. **饱和映射**：所有分量都用 `x/(x+k)`，量堆得再多也只逼近上限，不存在「线性收益」。
6. **每次都从当前方块状态重算**：分数不累积、不记账。把建筑拆了分数立刻掉回去，不存在「刷一次就永久保留」。
7. **破坏程度与建设分开记账**：放置方块不加 D（放置只会让 C 系列上升）；只有真的开挖、塞入岩层、铺火把铁轨才会加 D。反过来纯建筑也不会误报破坏——自测里一个多样化基地 D = 0.0000 / A = 0.5246，一条挖出来的矿道 D = 0.1371 / A = 0.0000。

## 3. 数据来源与判定依据

### 3.1 只用「运行时世界状态」

| 数据 | 来源 | 说明 |
|---|---|---|
| 逐格方块 | `LevelChunkSection.getStates().count(...)` + `getBlockState(x,y,z)` | 直方图走 Java 侧回调，逐格定位只用于稀有方块 |
| 地表高度 | `ChunkAccess.getHeight(Heightmap.Types.OCEAN_FLOOR, x, z)` | 语义 = 最高匹配方块 y + 1；OCEAN_FLOOR 忽略水与树叶，只认固体地形 |
| 邻区块参考面 | `Level.isLoaded(pos)` 为真时才 `getChunk(nx,nz).getHeight(...)` | 绝不为了统计去加载/生成区块 |
| 方块分类 | 方块标签 + 显式 id 名单 + 名称后缀名单 | 见 `CM_CONFIG.classifier` |
| 持久化 | `level.persistentData` (CompoundTag) | 存在世界数据里，跨重启存活，零文件 IO |

### 3.2 能读区块 NBT 吗？（任务里的待补充项之一）

- **内存里的 `LevelChunk` 不暴露它的原始 NBT。** 没有 `getNbt()` 这类接口，只有分段的 `PalettedContainer`。
- **落盘的 `.mca` 理论上能读**：`NbtIo.readCompressed(Path, NbtAccounter)` 在 1.21.1 存在。但 `world/level/chunk/storage/` 下只有 `ChunkSerializer` / `EntityStorage` / `SectionStorage`，**没有 `RegionFile` / `RegionFileStorage`**，意味着要自己解析 .mca 分区表与分段压缩。成本高、版本脆弱，收益（拿到同样的方块数据）却几乎为零。
- **所以本实现走运行时区块 API，不读 NBT。** 好处：不依赖存档内部格式，模组方块、方块实体、区块状态迁移都由游戏自己处理。

### 3.3 能拿到「原始地形」作基线与比较基准吗？（待补充项之二）

**不能自动拿到。** 纯 KubeJS 无法「用同一个种子重放世界生成」再和现状对比。所以破坏程度用的是**无基线代理**（B1/B2/B3/B4/B5），并且对每条代理都写明了它的判定依据与局限。

两条可选的「真基线」路线，按需要选：

1. **游玩前快照（最准）**：在世界还没被改造时，把 `<世界>/region/` 整个复制成一份基线。之后想拿精确的「挖掉了多少方块」，用离线工具（Python / MCA Selector 之类）逐区块比对即可。本脚本不实现离线比对。
2. **无玩家区域经验标定（本脚本内置）**：见第 6 节 `/cm calib`。它把「未被打扰区块里普遍存在的方块」判定为自然方块，并把这个表和版本号写进世界数据。运行期表是冻结的，所以不破坏可重复性。

## 4. 存储与读取接口

### 4.1 存储位置

结果写在**每个维度自己的** `level.persistentData` 里（因此主世界/下界/末地互不干扰），结构：

```
level.persistentData
  └ chunk_metrics            (CompoundTag)
      ├ v      : int         记录格式版本
      ├ rev    : int         自然表版本（标定过几次）
      ├ calib  : CompoundTag { rev, natural, chunks, t }   标定结果（自然方块 id 用逗号拼成字符串）
      └ chunks : CompoundTag
          └ "x,z" : CompoundTag                  区块键（区块坐标，逗号分隔）
              ├ v : int      记录格式版本（写入时为脚本常量 CM_VERSION；读侧目前不校验，只用根级 v 判断重建）
              ├ d : double   破坏程度 [0,1]
              ├ a : double   人工程度 [0,1]
              ├ t : long     计算时刻的时间戳
              ├ p : int      参考面是否不完整（1 = 有邻区块没加载）
              ├ rev : int    计算时的自然表版本（与当前 rev 不等 => 该记录过期）
              └ r : CompoundTag   各分量明细（B1..B5, C1..C5, subFrac, cutAvg, manTotal ...）
```

取值 0..1，不需要额外归一化。每条记录都带 raw 明细，方便你调权重时回看是哪一项在起作用。

### 4.2 脚本接口（`global.CM`）

```js
// 签名说明：所有接口的第一个参数都是 level（ServerLevel 对象），不是维度字符串——
// 记录就写在 level.persistentData 上（每个维度各一份），调用方本来就持有 level；
// dim→level 需要 server.getLevel，那条 Java 路径未做字节码验证，故不提供 dim 重载。

// 只读，不计算。没有记录返回 null。
const m = global.CM.get(level, chunkX, chunkZ)
const m2 = global.CM.getAt(level, blockX, blockZ)   // 按方块坐标取所在区块

// 状态查询：明确区分「无记录 / 读取失败 / 有记录」，并带 stale 与 rev。
// get / getAt 拿到 null 时分不清是哪种，出生点这类要给玩家原因的逻辑用这个。
const s = global.CM.getStatus(level, chunkX, chunkZ)
s.status    // 'ok' 有记录 | 'no-record' 还没扫过 | 'read-fail' world data 读取失败
s.source    // 'disk' 落盘记录 | 'mem' 内存兜底 | 'none'
s.ok        // 只有 read-fail 时为 false（查询本身失败）
s.stale     // 计算时的自然表版本与当前不等 => 过期
s.rev, s.curRev, s.d, s.a, s.raw

// 批量候选读数：一次遍历 world data 读一整个方形区域。
// 不调用 analyze、不加载/生成区块；逐条给出状态，绝不把过期记录混进可用数。
const area = global.CM.scoreArea(level, chunkX, chunkZ, 1)   // 半径 1 => 3×3
area.candidates   // 每个 { cx, cz, status, stale, source, d, a, rev, partial, dim }
                  // ⚠ 默认**包含** stale 与 no-record 的候选并逐个标注，由调用方决定怎么用
area.counts       // { ok, fresh, stale, noRecord, readFail, mem }
area.usable       // = counts.fresh（非 stale 的有效记录数）
                  // ⚠ 可用数只看这里：stale / no-record / read-fail 绝不混进 usable
area.pd           // 'ok' | 'fail'：数据根是否可读
global.CM.scoreArea(level, chunkX, chunkZ, 1, { freshOnly: true })   // 只返回有效记录
global.CM.scoreArea(level, chunkX, chunkZ, 1, { raw: true })         // 附带 31 键分量明细
global.CM.readAreaRadiusMax      // 半径上限（32），超出自动钳制

// 与逐点读取的差别（实测于合成世界、625 条记录）：区域读取只付一次数据根遍历的代价，
// 默认还省掉分量明细，比「逐点 get × N」快约 8 倍。要读一批候选区块时优先用它。

// 有则读、无则立刻算并落盘（未加载区块默认不计算，返回 null）
const m3 = global.CM.ensure(level, chunkX, chunkZ)

// 后台按 tick 预算排队扫描（不卡服）
global.CM.scanArea(level, chunkX, chunkZ, 6)        // 半径 6 区块
global.CM.enqueue(level, chunkX, chunkZ)

// 排行：给出生点逻辑用。默认 score = 1.0*a - 0.5*d
const list = global.CM.rank(level, chunkX, chunkZ, 8, {
  wA: 1.0,      // 人工程度权重（越大越偏好已开发区域）
  wD: 0.5,      // 破坏程度权重（越大越回避被挖烂的区域）
  minA: 0.2,    // 只要人工程度 >= 0.2 的区块
  maxD: 0.6,    // 排除破坏程度 > 0.6 的区块
  limit: 20,
  order: 'desc',  // 'desc'（默认，分数大的排前）| 'asc'（分数小的排前 = 越原始越前）
  skipStale: false // true 时排除过期记录（默认 false 与旧行为一致）
})
list[0].score, list[0].cx, list[0].cz, list[0].d, list[0].a

// 其它
global.CM.analyze(level, cx, cz)    // 纯计算不落盘（用于调参、离线统计）
global.CM.stats(level)              // 已统计区块数、平均/最大 D 与 A、队列长度
global.CM.queueSize(), global.CM.rev(), global.CM.learned()
```

给出生点用的典型写法（自己定策略即可）：

```js
// 例：想要「有点人味但没被挖烂」的地方
const candidates = global.CM.rank(level, spawnCx, spawnCz, 8, { wA: 1.0, wD: 0.8, minA: 0.15, maxD: 0.5 })
// 例：想要「完全原始」的地方（D 与 A 都接近 0）——用显式 order，别靠负权重
const wild = global.CM.rank(level, spawnCx, spawnCz, 8, { wA: 1.0, wD: 0.5, order: 'asc' })
// 旧的负权重写法仍然有效，但要与 order:'asc' 等价必须两个权重都取负（如 { wA: -1.0, wD: -0.5 }），
// 语义不自明，新代码请用 order。
```

### 4.3 命令（需要 OP，权限等级 2）

```
/cm                          帮助
/cm here                     看脚下区块的 D 与 A（没有就现算）
/cm get <x> <z>              看指定区块
/cm dump <x> <z>             看该区块的分量明细
/cm scan <radius>            以玩家为中心排队扫描（后台按 tick 预算跑）
/cm top <radius>             列出范围内 D/A 组合最好的 5 个区块
/cm stats                    总体统计
/cm calib <radius>           用当前范围标定自然方块表（见第 6 节）
/cm clear                    清空当前维度的统计记录
```

## 5. 触发时机与性能

| 触发 | 何时 |
|---|---|
| 手动扫描 | `/cm scan <radius>`，入队后由 tick 处理器按预算消化 |
| 按需计算 | 出生点逻辑调 `global.CM.ensure(level, cx, cz)` 时 |
| 自动扫描 | 默认**关闭**。把 `CM_CONFIG.scan.autoScan` 改成 `true` 后，每 `autoScanIntervalTicks`(600) tick 把玩家周围 `autoScanRadius`(6) 区块入队 |
| 列表加载 | `ServerEvents.loaded` 读取标定表并重置缓存 |

每 tick 的处理量由 `CM_CONFIG.scan.chunksPerTick`（默认 1）和 `maxMillisPerTick`（默认 8）控制。

性能事实（实测于合成世界）：

- **未建造区块最便宜**：`hasOnlyAir()` 跳空段 + `maybeHas()` 按调色板预判，人工方块命中 0 段时几乎不花时间（未建造区块 ~3-8 ms/区块）。
- **建造越多的区块越贵**：逐格定位扫描的代价正比于「含目标方块的段数 x 4096」。整块都是建筑的极端区块会明显更慢。
- 因此**默认每 tick 只做一个区块**。若你要一次性扫几百个区块，建议在没人玩的时候跑，或者把 `chunksPerTick` 调到 1 并观察 MSPT。
- 若 `PalettedContainer.count` 的 JS 回调在某些环境下不可用，脚本会自动退化为逐格直方图（结果不变，速度慢很多），并在日志里打一条 `[CM]` 警告。

## 6. 标定自然方块表（模组地形必做）

分类器默认走「标签 + 显式名单 + 后缀」，证明不了是自然的就按人工处理。334 个模组里难免有没打 `c:stones` 这类标签的地形方块，它们会被当成人工——不过第 2 节的第 1、2 条门槛（必须有台阶/门/方块实体，且不能是实心同质体）已经把这种误判挡在分数之外了。

如果还想更干净：

1. 找一个**没被玩家动过的区域**（新生成的、离基地远的），站到中间。
2. 执行 `/cm calib 8`。它在半径 8 区块里统计「出现在 ≥60% 区块中的方块」，判定为自然，写入世界数据并让自然表版本 +1。
3. 已有记录会被标记过期（读出来 `stale = true`），`/cm scan` 重扫即可。程序侧判断过期用 `global.CM.getStatus(...).stale`，读一批用 `global.CM.scoreArea(...)` 的逐条标注，`rank` 也可传 `skipStale: true` 直接跳过（见 4.2）。

为什么这样不会破坏可重复性：标定表存进世界数据并只增加版本号，运行期是冻结的；只要自然表版本不变，同一区块重算结果就一致。`CM_CONFIG.classifier.naturalSuffixes` 默认是空数组，宁可漏判也不误判——你要给自家模组加后缀规则，在那里加。

## 7. 边界条件与假设

| 情况 | 处理 |
|---|---|
| 新区块（还没生成） | 不生成。`scan.onlyLoadedChunks = true`（默认）时，`isLoaded` 为假直接跳过，不会为了统计去加载区块。设成 false 才会主动加载。 |
| 未加载区块 | `get` 返回 null；`ensure` 也不计算（默认）。**不会拿不到数据就瞎猜一个值。** |
| 无相关数据的区块 | `get` 返回 null，`rank` 自动跳过。 |
| 读取失败 vs 没有记录 | `get` / `getAt` 都只给 null，分不清两者；要区分用 `getStatus`：`status='no-record'`（该区块还没扫过）或 `status='read-fail'`（`level.persistentData` 读取失败，此时 `ok=false`、`pd='fail'`）。 |
| 批量读取会不会加载区块 | 不会。`scoreArea` 只读 world data 与内存缓存，不调用 analyze、不触发区块加载或生成（自检里 `getChunk` 调用数为 0）。 |
| 过期（stale）记录 | 默认读取接口照样返回；`scoreArea` 逐条标 `stale` 并给出 `counts.fresh` / `usable`（过期绝不混进可用数），`rank` 可传 `skipStale: true`，`getStatus` 同时给 `rev` 与 `curRev`。 |
| 参考面邻区块缺失 | 中值滤波窗口**自适应缩小**（最多降到 3x3），只有连 3x3 都不完整的列才放弃，并置 `partial = true` 供下游判断可信度。 |
| 跨区块的大型建筑 | 每个区块只统计自己那部分，连通体在区块边界被截断，因此大型建筑的单区块 A 会偏低。补偿办法：用 `rank` 的 3x3 / NxN 范围汇总，或自己把相邻区块的 A 相加。**这是已知的、有意为之的取舍**（区块独立、可并行、可缓存）。 |
| 未打标签的模组地形方块 | 默认按人工处理，但会被「人工形态 + 占比」门槛挡住，人工程度不会因此虚高（自测里 8960 格未打标签岩石 A = 0.0000）。 |
| 自然洞穴 | B2 用可调的自然空腔率基线扣除；基线偏低会把这部分算成破坏。**`naturalVoidFraction` 默认 0.030 是经验起点，请按你的地形模组标定。** |
| 自然悬崖 | B3 对「局部参考面」求落差，天然断崖可能产生误报，所以 B3 乘了一个人工佐证门控：只有出现火把/铁轨/结构才给分。无火把的野外施工会被漏判。 |
| `level.persistentData` 不可用 | 脚本自动退回内存缓存（本次会话有效，重启丢失）并打 `[CM]` 警告，其余功能不受影响。 |
| 破坏程度的语义边界 | 它是**「人为改造证据强度」的代理**，不是「挖掉了多少格」的精确体积。要精确值请用第 3.3 节的游玩前快照路线。 |

## 8. 调参见

| 参数 | 默认 | 作用 |
|---|---|---|
| `destruction.naturalVoidFraction` | 0.030 | 自然地下空腔率基线，**最该优先标定的一个** |
| `destruction.weights` | 见 1.1 | 五个破坏分量的权重 |
| `artificial.weights` | 见 1.2 | 五个人工分量的权重 |
| `artificial.minShapeOrMachine` | 2 | 连通体被认可所需的人工形态/机械数下限 |
| `artificial.minShapedRatio` | 0.03 | 人工形态占比下限 |
| `artificial.maxTerrainTypes` / `terrainFillThreshold` | 3 / 0.6 | 实心同质体的判定，防刷方块 |
| `destruction.filterRadius` | 3 | 局部参考面窗口半径（越大越抗噪，但邻区块要求越高） |
| `scan.chunksPerTick` / `maxMillisPerTick` | 1 / 8 | 扫描节流 |

改完 `CM_CONFIG` 后 `/reload`，再 `/cm clear` + `/cm scan` 重扫一遍，分数才会按新权重更新。

---

## 8. 口径一页纸：a / d 契约（并入自草案台 · 2026-10-04）

- 作者：chunk-metrics｜2026-10-04｜供 M3（基地隐性子模型：区域多块 a 持续高 ⇒ 据点）与出生点硬门共用
- 证据来源：minecraft/kubejs/server_scripts/chunk_metrics/chunk_metrics.js（md5 6e16ba7d408306d58819b4f3f59da121 / 1389 行）逐行核对，非回忆
- 行号/口径以本文为准；配套接口判定见 §6

### 0. 结论先行（四问四答）

| 问题 | 结论 |
|---|---|
| 1) 值域与饱和 | **d, a ∈ [0, 1]**，连续值，**有饱和**（不是原始计数，也不是 0–100） |
| 2) 是否按面积/体积归一 | **不归一**：是「本区块内认定的人工/破坏体量的饱和映射」；只有 A 的 C5 是面积分数。**同一建筑跨区块会被切开、每块各自变小** |
| 3) rev 何时推进 + stale 定义 | **只有 /cm calib 会 rev++**；重扫不推进。**stale = 该记录是用旧版自然基线表算的**（值仍有效，口径可能过时） |
| 4) 未知返回什么 | 未扫描 ⇒ **null**；读取失败 ⇒ **null + status=read-fail**；**「未标定」当前没有独立状态（缺口）**；任何情况都**不用 0 冒充未知** ✔ |

### 1. 值域与饱和（问题 1）

公式（chunk_metrics.js）：
- `D = clamp01(0.30·B1 + 0.25·B2 + 0.25·B3 + 0.10·B4 + 0.10·B5)`（:755-756）
- `A = clamp01(0.35·C1 + 0.25·C2 + 0.20·C3 + 0.10·C4 + 0.10·C5)`（:781-782）
- 每个分量先过饱和映射 `cmSat(x, k) = x/(x+k)`（x≤0 时 0，:320），再 `cmClamp01` 夹到 [0,1]（:321）
- 两组权重各自**恰好和为 1.00**（D: .30+.25+.25+.10+.10；A: .35+.25+.20+.10+.10）

给 M3 的用法：阈值（aMin / d 上限）按 **[0,1] 小数**写（0.5 不是 50）；`a === 0` 是**精确 0**，正是出生点硬门要的合格值。

### 2. 是否按面积/体积归一（问题 2）——不归一

A 的五个分量（都在**单区块**内计算；连通体 quality/members 见 :640-652）：

| 分量 | 表达式 | 归一口径 |
|---|---|---|
| C1 结构体量 | `cmSat(goodMass, structureSatK=260)`，goodMass = Σ(体素数×质量)（:648-651, :760） | **本区块内绝对体量**（不除面积） |
| C2 机械 | `cmSat(machScore, machinerySatK)` × `clamp01(maxGood/32)`（:763） | 绝对计数 × 体积门槛 |
| C3 成片度 | `min(1, maxGood / max(1, min(manTotal,128))) × g`（:764） | 区块内比例（再被 C1 门控） |
| C4 垂直发展 | `(0.5·min(1, goodSec.size/6) + 0.5·min(1, span/32)) × g`（:772） | 层数/跨度（非面积） |
| C5 地面铺装 | `cmSat(pavedSet.size / 256, 0.5) × g`（:778） | **面积分数**（铺装列数 / 256 列） |

⇒ **同一座房子在 1 个区块里 a 高；拆到 4 个区块后连通体被切断，每块的 goodMass/maxGood/span 都变小 ⇒ 每块 a 显著下降**（C5 受影响最小）。
D 同样是混合口径：B2 = 地下空腔比例（归一）、B3 = 每列削减均值（:750-753）、B4 = 抽样外推（:742）、B1/B5 = 计数饱和（:747, :754）。

给 M3 的直接含义：不能指望「单块 a 高」= 据点；必须**在区域尺度聚合多块**（这正是隐性子模型的方向），且区域窗口要覆盖建筑可能跨的 1–2 块边界。

### 3. rev 推进时机与 stale 精确含义（问题 3）

- `CM_REV` 初值 0（:171），启动时从 `persistentData.calib.rev` 读入；没有 calib 就保持 0（:971-976）。
- **只有 `/cm calib`（cmCalibrate :1190-1236）会 `CM_REV++`（:1227）并写回 calib（:1231）**。`/cm scan` **不推进** rev——它只是**按当前 rev 重写**记录（`rec.rev = CM_REV`，:792）。
- 每条磁盘记录带 rev；读取时 `stale = t.getInt('rev') !== CM_REV`（:853）。内存兜底记录没有 rev，按「当前版本」看待（:1289）。
- ⇒ **stale 的精确含义：这条 d/a 是在上一版自然基线表下算出来的**（标定改了基线 ⇒ 旧记录没重算）。**stale ≠ 值无效**，只用来说「口径可能过时」。
- 批量读取：`CM.scoreArea` 默认**返回 stale 条目并标注 stale=true**（不静默丢弃），`counts.fresh` 才是「可用（未过期有效）」的权威计数；`opts.freshOnly=true` 时才直接过滤。

### 4. 未知 / 未标定 / 读取失败分别返回什么（问题 4，含硬约束判定）

| 状态 | d / a | 判别方式 | 证据 |
|---|---|---|---|
| 有记录（新鲜） | 数值 | `status='ok'` 且 `stale=false` | cmReadCandidate :868-877 |
| 有记录但过期 | 数值 | `status='ok'` 且 `stale=true` | stale 判定 :853 |
| **未扫描** | **null / null** | `status='no-record'`，`source='none'` | :890-892 |
| **读取失败** | **null / null** | `status='read-fail'`，`ok=false` | :878-882 |
| 内存兜底记录 | 数值 | `source='mem'`，`rev=null` | :884-889 |
| **未标定** | —— | **当前没有独立状态**（缺口，见下） | —— |

**硬约束判定：满足「未知必须是 null 或显式 stale」** ✔ —— `CM.getAt/cmGet` 对无记录返回 **null**（:947-952）；`CM.getStatus` 用 status 三态显式区分（:1291-1300）；`CM.scoreArea` 的 candidates 逐个带 status/stale，未知块 d/a 一律 null。**本项目没有任何地方用 0 冒充未知。**

**一个真实缺口（请 lead 定夺是否单开一轮修）：没有「未标定」状态。**
CM_REV=0 / 无 calib 时，analyze 用 `CM_CONFIG.destruction.naturalVoidFraction=0.030` 等**默认基线**照常算，记录有 d/a、rev=0、stale=false ⇒ 数据上**分不出「按默认基线算」与「按本世界标定算」**。出生点影响有限，但对 M3 的「阈值是否可信」有影响。
最小修法（**设计建议，未实现**）：`cmGetStatus/cmScoreArea` 增加只读字段 `calib:{calibrated:boolean, rev:number}`（不改 d/a 语义），`/cm stats` 同步显示——不新增 API、不改量纲。

### 4b. 出生点侧残余风险（写这份口径时发现，已单报 lead）
出生点候选读数是 **3×3 聚合**，`no-record` 与 `stale` **不参与均值**（20_spawn.js:493-499），且有覆盖率下限 `minScored`（默认 5/9）。⇒ 仍存在「9 块里只有 5 块扫过且那 5 块 a=0」而通过硬门的情形。**不是本次硬门引入的**，但「a===0 必须」的本意是「整片都没有人工建造物」；若要更严，建议把覆盖率门槛单列（例如 fresh ≥ 7/9），单开一轮。

### 5. 契约页（M3 与出生点共用）

**① 只读保证**：`get/getAt/getStatus/scoreArea/rank/stats` 全部只读——不 analyze、不触发区块加载/生成（`onlyLoadedChunks=true`）、不写 persistentData。只有 `/cm scan`、`/cm calib`、`ensure` 会写。

**② 重入语义（M3 低频扫描 vs 本域 tick 驱动）**：
- 本域扫描队列每 tick 最多完成 `chunksPerTick=1` 块、预算 8 ms；**读侧不受写侧影响**：读到「还没扫到」就是 no-record。
- 同区块并发读+写：写是**整条记录替换**（cmStore 先算完再 put，:914-916），读要么旧要么新，**不会读到半条**；但可能刚好跨过一次标定。⇒ **不要假设 rev 在一次读中恒定**：请用 `cmGetStatus` 返回的 `curRev`（本次读取时的当前 rev）。
- 内存兜底：`persistentData` 不可用时退回会话内缓存并 `cmWarnOnce('pd', …)`，此时 `source='mem'`、`rev=null`、重启即丢 ⇒ 按 source 区分，别当持久数据。

**③ 过期 / 未标定取值**：过期 ⇒ 数值照给 + `stale=true`（可用计数 = `counts.fresh`）；未标定 ⇒ **当前无状态字段**（缺口，见 §4）。

**④ 字段表**：

| 字段 | 单位/值域 | 来源 |
|---|---|---|
| d | [0,1] 小数（有饱和） | 区块内 D 公式（§1） |
| a | [0,1] 小数（有饱和）；`a===0` = 认定人工体量为 0 | 区块内 A 公式（§1） |
| rev | 整数（写记录时的自然基线版本） | :792 |
| curRev | 整数（读取时的当前版本） | :1294 |
| stale | 布尔 = `rev !== CM_REV` | :853 |
| status | ok / no-record / read-fail | :866-892 |
| source | disk / mem / none | 同上 |
| partial | 布尔（该块部分扫描，覆盖 < 9/9 子格） | cmParseTag |
| ts | 毫秒时间戳（0 = 无） | cmStore |

**⑤ 离线自检样例（T21 骨架，供 kubejs-crafting）**：

```js
// 目标：把 CM.scoreArea 当「区域读取」用，只依赖已声明契约
var area = CM.scoreArea(fakeLevel, 0, 0, 2, { freshOnly: false });
assert(area.ok === true && area.candidates.length === 25, '区域槽位 = (2r+1)^2');
var fresh = area.candidates.filter(function (c) { return c.status === 'ok' && c.stale !== true; });
assert(area.counts.fresh === fresh.length, 'counts.fresh 就是可用块数（权威口径）');
assert(area.candidates.every(function (c) {
  return c.status !== 'no-record' || (c.d === null && c.a === null);
}), '未扫描必须是 null —— 绝不许用 0 冒充未知');
assert(area.candidates.every(function (c) { return c.d === null || (c.d >= 0 && c.d <= 1); }), 'd 值域 [0,1]');
assert(area.candidates.every(function (c) { return c.a === null || (c.a >= 0 && c.a <= 1); }), 'a 值域 [0,1]');
assert(typeof area.curRev === 'number', '带 curRev（判定 stale 用它，不要缓存 rev）');
```

### 6. 接口判定：scoreArea 能否直接充当 M3 的「一次取整片」？——能，且零新增 API

**结论：M3 不需要新的 regionArea，也不需要 chunkStats。只补文档与 opts 契约。**

- 证据：`CM.scoreArea(level, cx, cz, radius, opts)` **一次遍历数据根**返回 **(2r+1)² 个区块**的 `{status, stale, source, rev, d, a, partial}` + `counts{ok,fresh,stale,noRecord,readFail,mem}` + `usable=counts.fresh`；`radius` 钳到 `CM_READ_MAX_AREA_RADIUS=32`（单次最多 65×65=4225 块）；`opts.raw=false`（默认）跳过 31 键分量明细。**这正是「一次取整片」。**
- 性能预算：合成世界实测 625 槽位（radius 12、light）**0.44 ms**（README §4.2）；真实世界按命中记录数线性。M3 低频（如每 30 s 一片）预算充裕。不 analyze、不加载区块。
- 与 `CM.chunkStats(dim,cx,cz)` 的关系：**同一份能力已被 `CM.getStatus(level,cx,cz)` 覆盖**（返回 `{ok,status,source,pd,cx,cz,dim,d,a,ts,partial,v,rev,curRev,stale}`，轻读、不含 31 键）⇒ 按「新增接口必须有具体消费者与具体缺陷」的规矩，**chunkStats 不新增**（否则是同一能力的第二个名字，两份文档将来会漂移）。
- 唯一签名差异（要写进契约）：**本域 API 一律取 `level` 而非 `dim` 字符串**（数据在 `level.persistentData`；`dim→level` 需要未验证的 `server.getLevel`）。若 M3 手上只有 dim：①在调用点顺手拿 level；②将来单独授权我加 dim→level 解析（需实机验证）。
- 已知限制（写进文档，不当缺陷）：方形区域（不规则形状自行裁剪）；radius ≤ 32（更大分片调用）；stale 语义与「未标定」缺口见 §3/§4。

> 2026-10-04 更新：出生点覆盖度门槛 coverMin=7/9 已实现（拒绝码 SPAWN_COVERAGE，见 war/20_spawn.js）；getStatus/scoreArea 的 calib:{calibrated,rev} 只读字段与 /cm stats 同步显示待实现（下一轮）。
