// ============================================================================
// chunk_metrics.js  ——  逐区块「破坏程度 / 人工程度」统计
// 目标环境：Minecraft 1.21.1 + NeoForge 21.1.251 + KubeJS 7.2 (build 377)
// 放置位置：<实例>/minecraft/kubejs/server_scripts/chunk_metrics/chunk_metrics.js
//
// 设计要点（详见同目录 README.md）：
//  * 口径固定为「区块总体积」（按维度实际段数换算，主世界 16 x 384 x 16 = 98304 格），
//    因此同维度任意两区块的数值可直接比较。
//  * 结果写入 level.persistentData（世界数据，跨重启存活，零文件 IO）。
//  * 计算完全由「世界当前状态 + 配置常量 + 标定表」决定，不含随机数、
//    不含硬编码坐标、不依赖玩家名 => 同状态重复计算结果一致。
//  * 未加载区块不主动加载（可配置）；无数据区块返回 null 而不猜一个值。
// ============================================================================

// ---------------------------------------------------------------- 0. 基础常量

var CM_VERSION = 1;                 // 记录格式版本
var CM_NS = 'chunk_metrics';        // level.persistentData 下的命名空间

// 方块类别位标记
var CM_AIR      = 1;
var CM_FLUID    = 2;
var CM_NATURAL  = 4;
var CM_ORE      = 8;
var CM_MAN      = 16;
var CM_MACH     = 32;
var CM_SUPPORT  = 64;    // 火把/铁轨/梯子/脚手架等「零散支持物」：只作破坏证据，不计入人工程度
var CM_SHAPED   = 128;   // 台阶/楼梯/墙/栅栏/门/窗格等「人工形态」：人工建筑的强判据
var CM_VEG      = 256;   // 自然植被

// ---------------------------------------------------------------- 1. 配置

var CM_CONFIG = {
  version: CM_VERSION,

  // ---- 扫描调度 ----
  scan: {
    chunksPerTick: 1,            // 每 tick 最多完成几个区块
    maxMillisPerTick: 8,         // 每 tick 时间预算(ms)，只决定「还做不做下一个」
    onlyLoadedChunks: true,      // true = 绝不因统计而加载/生成区块
    autoScan: false,             // 是否自动扫描玩家周围
    autoScanIntervalTicks: 600,  // 自动扫描周期
    autoScanRadius: 6,           // 自动扫描半径(区块)
    maxQueue: 8192
  },

  // ---- 破坏程度 D ----
  destruction: {
    weights: {
      traces:      0.30,   // B1 地下人工痕迹（火把/铁轨/梯子/脚手架位于地表以下）
      voidExcess:  0.25,   // B2 地下空腔超出自然基线
      surfaceCut:  0.25,   // B3 地表被削低（相对局部参考面）
      oreExposure: 0.10,   // B4 矿石被剥露（抽样估计）
      backfill:    0.10    // B5 人工材料塞入地下（回填/基础/支撑）
    },
    naturalVoidFraction: 0.030,  // 自然地下空腔率基线（可在世界内标定）
    voidSatK:       0.050,
    traceSatK:      24,
    cutThreshold:   4,           // 每列最小削减量(格)才算「削低」
    cutSatK:        6,
    filterRadius:   3,           // 中值滤波半径(格)：局部参考面的窗口半宽
    cutEvidenceMin: 8,           // B3 需要的人工佐证量，达到此值才给满权重
    oreSampleStride: 16,         // 抽样列步长（hash mod 16 == 0 的列被抽中，约 1/16）
    oreBaseline:    2,           // 自然洞穴剥露矿石的经验基线，先扣除
    oreSatK:        16,
    backfillSatK:   0.004
  },

  // ---- 人工程度 A ----
  artificial: {
    weights: {
      structure:     0.35,  // C1 结构体量 x 质量
      machinery:     0.25,  // C2 机械/功能方块
      concentration: 0.20,  // C3 成片度（最大连通体占比）
      vertical:      0.10,  // C4 垂直发展（层数/高度跨度）
      ground:        0.10   // C5 地面铺装（地表附近的人工覆盖）
    },
    refComponentSize:    256,   // 连通体达到此体积时 sizeFactor = 1
    refTypeDiversity:    6,     // 连通体内不同方块种类达到此数时 diversityFactor = 1
    structureSatK:       260,
    machinerySatK:       24,
    minComponentSize:    4,     // 小于此体积的连通体不计入体量
    minShapeOrMachine:   2,     // 连通体内「人工形态+机械」方块数下限（自然地形几乎为 0）
    minShapedRatio:      0.03,  // 「人工形态+机械」占比下限
    maxTerrainTypes:     3,     // 种类 <= 此值 且 填充率 >= terrainFillThreshold
    terrainFillThreshold: 0.6,  //   => 视为实心同质体，质量归零（同时挡住刷方块与未打标签的地形方块）
    gateAt:              0.05   // C3/C4/C5 由 C1 门控的软阈值
  },

  // ---- 分类器 ----
  classifier: {
    naturalTags: [
      'minecraft:base_stone_overworld', 'minecraft:base_stone_nether',
      'minecraft:dirt', 'minecraft:sand', 'minecraft:ice', 'minecraft:snow',
      'minecraft:logs', 'minecraft:leaves', 'minecraft:flowers',
      'minecraft:small_flowers', 'minecraft:tall_flowers', 'minecraft:saplings',
      'minecraft:crops', 'minecraft:cave_vines', 'minecraft:corals',
      'minecraft:replaceable', 'minecraft:mushroom_grow_block',
      'c:stones', 'c:dirt', 'c:sand', 'c:gravel', 'c:ores',
      'c:ores_in_ground/stone', 'c:ores_in_ground/deepslate',
      'c:obsidians', 'c:end_stones', 'c:netherracks', 'c:mushrooms'
    ],
    oreTags: ['c:ores', 'c:ores_in_ground/stone', 'c:ores_in_ground/deepslate',
              'forge:ores', 'minecraft:coal_ores', 'minecraft:iron_ores',
              'minecraft:copper_ores', 'minecraft:gold_ores',
              'minecraft:redstone_ores', 'minecraft:lapis_ores',
              'minecraft:diamond_ores', 'minecraft:emerald_ores'
    ],
    naturalIds: [
      'minecraft:stone', 'minecraft:deepslate', 'minecraft:granite',
      'minecraft:diorite', 'minecraft:andesite', 'minecraft:tuff',
      'minecraft:calcite', 'minecraft:dripstone_block', 'minecraft:pointed_dripstone',
      'minecraft:bedrock', 'minecraft:obsidian', 'minecraft:crying_obsidian',
      'minecraft:netherrack', 'minecraft:basalt', 'minecraft:smooth_basalt',
      'minecraft:blackstone', 'minecraft:soul_sand', 'minecraft:soul_soil',
      'minecraft:magma_block', 'minecraft:glowstone', 'minecraft:end_stone',
      'minecraft:gravel', 'minecraft:clay', 'minecraft:sand', 'minecraft:red_sand',
      'minecraft:sandstone', 'minecraft:red_sandstone', 'minecraft:dirt',
      'minecraft:coarse_dirt', 'minecraft:rooted_dirt', 'minecraft:grass_block',
      'minecraft:podzol', 'minecraft:mycelium', 'minecraft:moss_block',
      'minecraft:mud', 'minecraft:muddy_mangrove_roots', 'minecraft:snow_block',
      'minecraft:powder_snow', 'minecraft:ice', 'minecraft:packed_ice',
      'minecraft:blue_ice', 'minecraft:terracotta', 'minecraft:suspicious_sand',
      'minecraft:suspicious_gravel', 'minecraft:cobweb', 'minecraft:amethyst_block',
      'minecraft:budding_amethyst', 'minecraft:sculk', 'minecraft:sculk_vein',
      'minecraft:sculk_catalyst', 'minecraft:sculk_shrieker', 'minecraft:sculk_sensor',
      'minecraft:moss_carpet', 'minecraft:glow_lichen', 'minecraft:hanging_roots',
      'minecraft:big_dripleaf', 'minecraft:small_dripleaf', 'minecraft:spore_blossom',
      'minecraft:azalea', 'minecraft:flowering_azalea', 'minecraft:lily_pad',
      'minecraft:seagrass', 'minecraft:kelp', 'minecraft:vine',
      'minecraft:dead_bush', 'minecraft:cactus', 'minecraft:sugar_cane',
      'minecraft:bamboo', 'minecraft:sweet_berry_bush', 'minecraft:water',
      'minecraft:lava', 'minecraft:bubble_column'
    ],
    // 路径后缀 => 自然。默认留空：宁可漏判也不要误判；
    // 模组地形请在游戏内跑 /cm calib 标定（见 README「标定」一节）
    naturalSuffixes: [],
    supportIds: [
      'minecraft:torch', 'minecraft:wall_torch', 'minecraft:soul_torch',
      'minecraft:soul_wall_torch', 'minecraft:lantern', 'minecraft:soul_lantern',
      'minecraft:rail', 'minecraft:powered_rail', 'minecraft:detector_rail',
      'minecraft:activator_rail', 'minecraft:ladder', 'minecraft:scaffolding',
      'minecraft:campfire', 'minecraft:soul_campfire', 'minecraft:end_rod'
    ],
    supportSuffixes: ['_rail', '_torch', '_lantern'],
    shapedSuffixes: ['_slab', '_stairs', '_wall', '_fence', '_fence_gate',
                     '_pane', '_door', '_trapdoor', '_carpet', '_button',
                     '_pressure_plate', '_bars', '_chain', '_gate'],
    machineSuffixes: ['_shaft', '_cogwheel', '_gear', '_belt', '_pipe', '_pump',
                      '_piston', '_bearing', '_chassis', '_wheel', '_casing',
                      '_panel', '_valve', '_motor', '_turbine', '_conveyor',
                      '_millstone', '_crusher', '_mixer', '_press', '_saw',
                      '_drill', '_fan', '_nozzle', '_tank', '_basin', '_depot',
                      '_funnel', '_chute', '_arm', '_clutch', '_gearbox',
                      '_dynamo', '_generator', '_engine', '_battery', '_reactor'],
    calibrateMinChunkShare: 0.6   // 标定：出现在 >=60% 参考区块里的方块判定为自然
  },

  debug: false
};

// ---------------------------------------------------------------- 2. 能力探测与 Java 桥

var CM_CAP = { count: true, maybeHas: true, getMinY: true };
var CM_JAVA = { loaded: false, ok: false, heightmapTypes: null, BlockPos: null,
                TagKey: null, Registries: null, ResourceLocation: null,
                Component: null, blockRegistry: null };
var CM_TAGS = {};
var CM_CACHE = new Map();          // Block -> 分类结果
var CM_LEARNED = new Set();        // 标定得到的自然方块 id
var CM_REV = 0;                    // 自然表版本（写入每条记录，供读者判断是否过期）
var CM_WARNED = {};

function cmWarnOnce(key, msg) {
  if (CM_WARNED[key]) return;
  CM_WARNED[key] = true;
  console.warn('[CM] ' + msg);
}

function cmLoadJava() {
  if (CM_JAVA.loaded) return CM_JAVA.ok;
  CM_JAVA.loaded = true;
  try {
    CM_JAVA.BlockPos = Java.loadClass('net.minecraft.core.BlockPos');
    CM_JAVA.TagKey = Java.loadClass('net.minecraft.tags.TagKey');
    CM_JAVA.Registries = Java.loadClass('net.minecraft.core.registries.Registries');
    CM_JAVA.ResourceLocation = Java.loadClass('net.minecraft.resources.ResourceLocation');
    CM_JAVA.blockRegistry = Java.loadClass('net.minecraft.core.registries.BuiltInRegistries').BLOCK;
    try { CM_JAVA.Component = Java.loadClass('net.minecraft.network.chat.Component'); }
    catch (e0) { CM_JAVA.Component = null; }
    try {
      CM_JAVA.heightmapTypes = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap$Types');
    } catch (e1) {
      try { CM_JAVA.heightmapTypes = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap').Types; }
      catch (e2) { CM_JAVA.heightmapTypes = null; }
    }
    CM_JAVA.ok = (CM_JAVA.heightmapTypes != null);
    if (!CM_JAVA.ok) cmWarnOnce('hmap', '无法加载 Heightmap.Types，统计无法进行（高度图是必需项）');
  } catch (err) {
    CM_JAVA.ok = false;
    cmWarnOnce('java', 'Java 类加载失败：' + err);
  }
  return CM_JAVA.ok;
}

function cmTag(name) {
  var t = CM_TAGS[name];
  if (t !== undefined) return t;
  t = null;
  try {
    t = CM_JAVA.TagKey.create(CM_JAVA.Registries.BLOCK, CM_JAVA.ResourceLocation.parse(name));
  } catch (err) { cmWarnOnce('tag:' + name, '无法构造标签 ' + name + '：' + err); t = null; }
  CM_TAGS[name] = t;
  return t;
}

function cmIsAnyTag(state, names) {
  for (var i = 0; i < names.length; i++) {
    var t = cmTag(names[i]);
    if (t == null) continue;
    try { if (state.is(t)) return true; } catch (err) { }
  }
  return false;
}

function cmIsBlockId(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i] === id) return true;
  return false;
}

function cmSuffixMatch(path, suffixes) {
  for (var i = 0; i < suffixes.length; i++) {
    var s = suffixes[i];
    if (path.length >= s.length && path.substring(path.length - s.length) === s) return true;
  }
  return false;
}

function cmBlockId(block) {
  try { return String(CM_JAVA.blockRegistry.getKey(block)); } catch (err) { return 'unknown:unknown'; }
}

// ---------------------------------------------------------------- 3. 分类器

function cmClassify(block) {
  var hit = CM_CACHE.get(block);
  if (hit !== undefined) return hit;

  var id = cmBlockId(block);
  var sep = id.indexOf(':');
  var ns = sep < 0 ? 'minecraft' : id.substring(0, sep);
  var path = sep < 0 ? id : id.substring(sep + 1);

  var st = null;
  try { st = block.defaultBlockState(); } catch (err) { st = null; }

  var c = 0;
  var support = false;
  var shaped = false;
  var mach = false;

  if (path === 'air' || path === 'cave_air' || path === 'void_air' ||
      path === 'light' || path === 'barrier' || path === 'structure_void') {
    c = CM_AIR;
  } else {
    var isFluid = false;
    if (st != null) { try { isFluid = !st.getFluidState().isEmpty(); } catch (err) { isFluid = false; } }
    if (isFluid) c = CM_FLUID;
  }

  if (c === 0) {
    var isOre = false;
    if (st != null) isOre = cmIsAnyTag(st, CM_CONFIG.classifier.oreTags);
    if (isOre) {
      c = CM_NATURAL | CM_ORE;
    } else {
      var isNat = false;
      if (st != null) isNat = cmIsAnyTag(st, CM_CONFIG.classifier.naturalTags);
      if (!isNat) isNat = cmIsBlockId(CM_CONFIG.classifier.naturalIds, id);
      if (!isNat && CM_LEARNED.size > 0) isNat = CM_LEARNED.has(id);
      if (!isNat) isNat = cmSuffixMatch(path, CM_CONFIG.classifier.naturalSuffixes);
      if (isNat) {
        c = CM_NATURAL;
        if (cmSuffixMatch(path, ['_log', '_wood', '_leaves', '_sapling', '_flower',
                                 '_grass', '_bush', '_cane', '_vine', '_kelp',
                                 '_mushroom', '_roots', '_lily', '_cactus', '_bamboo'])) {
          c = c | CM_VEG;
        }
      } else {
        c = CM_MAN;   // 默认开放：无法证明是自然的按人工处理，但下游有多重门槛防误判
      }
    }
  }

  // 支持物：只作为破坏证据，排除出人工程度
  if ((c & (CM_AIR | CM_FLUID)) === 0) {
    if (cmIsBlockId(CM_CONFIG.classifier.supportIds, id) ||
        cmSuffixMatch(path, CM_CONFIG.classifier.supportSuffixes)) support = true;
  }

  if (c & CM_MAN) {
    if (cmSuffixMatch(path, CM_CONFIG.classifier.machineSuffixes)) mach = true;
    else if (st != null) { try { mach = st.hasBlockEntity(); } catch (err) { mach = false; } }
    if (mach) c = c | CM_MACH;
    shaped = cmSuffixMatch(path, CM_CONFIG.classifier.shapedSuffixes);
    if (shaped) c = c | CM_SHAPED;
  }
  if (support) c = c | CM_SUPPORT;

  var rec = { c: c, id: id, ns: ns, path: path, support: support, shaped: shaped, mach: mach };
  CM_CACHE.set(block, rec);
  return rec;
}

function cmInvalidate() { CM_CACHE.clear(); }

// ---------------------------------------------------------------- 4. 数学工具

// 饱和映射 x/(x+k)：把任意非负量压缩到 [0,1)，避免「线性刷分」
function cmSat(x, k) { if (x <= 0) return 0; return x / (x + k); }
function cmClamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function cmClampInt(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// 确定性哈希（只用区块坐标与列坐标，无随机数、无硬编码坐标）
function cmHash(x, z, cx, cz) {
  var h = Math.imul(x + 1, 374761393) ^ Math.imul(z + 1, 668265263) ^
          Math.imul(cx, 2246822519) ^ Math.imul(cz, 3266489917);
  h = h ^ (h >>> 15);
  h = Math.imul(h, 2246822507);
  h = h ^ (h >>> 13);
  return h >>> 0;
}

// ---------------------------------------------------------------- 5. 底层读块辅助

function cmSectionBlockCounts(sec) {
  var m = new Map();
  if (CM_CAP.count) {
    try {
      sec.getStates().count(function (state, n) {
        var b = state.getBlock();
        var p = m.get(b);
        m.set(b, (p === undefined ? 0 : p) + n);
      });
      return m;
    } catch (err) {
      CM_CAP.count = false;
      cmWarnOnce('count', 'PalettedContainer.count 回调不可用，回退逐格扫描（变慢）：' + err);
      m = new Map();
    }
  }
  for (var y = 0; y < 16; y++) {
    for (var z = 0; z < 16; z++) {
      for (var x = 0; x < 16; x++) {
        var b2 = sec.getBlockState(x, y, z).getBlock();
        var p2 = m.get(b2);
        m.set(b2, (p2 === undefined ? 0 : p2) + 1);
      }
    }
  }
  return m;
}

function cmMaybeHas(sec, pred) {
  if (CM_CAP.maybeHas) {
    try { return sec.maybeHas(pred); } catch (err) {
      CM_CAP.maybeHas = false;
      cmWarnOnce('maybeHas', 'LevelChunkSection.maybeHas 不可用，回退全段扫描（变慢）：' + err);
    }
  }
  return true;
}

// 在「调色板预判命中」的段里逐格定位满足 pred 的方块，返回扁平数组 [x,y,z, x,y,z, ...]
function cmFindPositions(sections, nSec, minY, pred) {
  var out = [];
  for (var i = 0; i < nSec; i++) {
    var sec = sections[i];
    if (sec.hasOnlyAir()) continue;
    if (!cmMaybeHas(sec, pred)) continue;
    var y0 = minY + i * 16;
    for (var y = 0; y < 16; y++) {
      var ay = y0 + y;
      for (var z = 0; z < 16; z++) {
        for (var x = 0; x < 16; x++) {
          if (pred(sec.getBlockState(x, y, z))) out.push(x, ay, z);
        }
      }
    }
  }
  return out;
}

function cmStateAt(sections, minY, nSec, x, y, z) {
  if (x < 0 || x > 15 || z < 0 || z > 15) return null;
  var si = (y >> 4) - (minY >> 4);
  if (si < 0 || si >= nSec) return null;
  return sections[si].getBlockState(x, y & 15, z);
}

function cmIsAirAt(sections, minY, nSec, x, y, z) {
  var st = cmStateAt(sections, minY, nSec, x, y, z);
  if (st == null) return false;
  try { return st.isAir(); } catch (err) { return false; }
}

function cmMinY(level) {
  if (CM_CAP.getMinY) {
    try { return level.getMinY(); } catch (err) { CM_CAP.getMinY = false; }
  }
  try { return level.getMinBuildHeight(); } catch (err2) { return -64; }
}

// ---------------------------------------------------------------- 6. 单区块分析

function cmAnalyzeChunk(level, cx, cz, cfg) {
  if (!cmLoadJava()) throw new Error('Java 桥未就绪');
  var t0 = Date.now();

  var chunk = level.getChunk(cx, cz);
  var sections = chunk.getSections();
  var nSec = sections.length;
  var minY = cmMinY(level);
  var minSecY = minY >> 4;
  var maxY = minY + nSec * 16;
  var ht = CM_JAVA.heightmapTypes;

  var i, x, y, z, k;

  // ---- 6.1 高度图：H[z*16+x] = 地表固体之上第一格的 y ----
  var H = new Int32Array(256);
  for (z = 0; z < 16; z++) {
    for (x = 0; x < 16; x++) {
      H[z * 16 + x] = chunk.getHeight(ht.OCEAN_FLOOR, x, z);
    }
  }

  // ---- 6.2 逐段直方图（Java 侧 count，按调色板回调，代价约等于不同状态数）----
  var secAir = new Int32Array(nSec);
  var secMan = new Int32Array(nSec);
  var airTotal = 0, fluidTotal = 0, naturalTotal = 0, manTotal = 0;
  var machTotal = 0, oreTotal = 0, supportTotal = 0, shapedManTotal = 0;
  var manByBlock = new Map();
  var machBlocks = new Set();

  for (i = 0; i < nSec; i++) {
    var sec = sections[i];
    if (sec.hasOnlyAir()) { secAir[i] = 4096; airTotal += 4096; continue; }
    var counts = cmSectionBlockCounts(sec);
    var manInSec = 0;
    counts.forEach(function (n, block) {
      var e = cmClassify(block);
      if (e.c & CM_AIR) { airTotal += n; secAir[i] += n; return; }
      if (e.c & CM_FLUID) { fluidTotal += n; return; }
      if (e.c & CM_ORE) oreTotal += n;
      if (e.c & CM_NATURAL) { naturalTotal += n; return; }
      if (e.support) { supportTotal += n; return; }   // 零散支持物不计入人工程度
      manTotal += n;
      manInSec += n;
      if (e.mach) { machTotal += n; machBlocks.add(block); }
      if (e.shaped) shapedManTotal += n;
      var prev = manByBlock.get(block);
      manByBlock.set(block, (prev === undefined ? 0 : prev) + n);
    });
    secMan[i] = manInSec;
  }

  // ---- 6.3 局部参考面（中值滤波）与地表削减 ----
  var R = cfg.destruction.filterRadius;
  var hFields = new Map();
  hFields.set(cx + ',' + cz, H);

  // 邻区块高度场：已加载才读，未加载记 null（绝不触发区块生成）
  function chunkField(ncx, ncz) {
    var key = ncx + ',' + ncz;
    var f = hFields.get(key);
    if (f === undefined) {
      f = null;
      try {
        if (level.isLoaded(new CM_JAVA.BlockPos(ncx << 4, 0, ncz << 4))) {
          var c2 = level.getChunk(ncx, ncz);
          var arr = new Int32Array(256);
          for (var zz = 0; zz < 16; zz++) {
            for (var xx = 0; xx < 16; xx++) arr[zz * 16 + xx] = c2.getHeight(ht.OCEAN_FLOOR, xx, zz);
          }
          f = arr;
        }
      } catch (err) { f = null; }
      hFields.set(key, f);
    }
    return f;
  }

  function heightAt(gx, gz) {
    var ncx = cx + Math.floor(gx / 16);
    var ncz = cz + Math.floor(gz / 16);
    var lx = ((gx % 16) + 16) % 16;
    var lz = ((gz % 16) + 16) % 16;
    var f = chunkField(ncx, ncz);
    if (f === null) return -2147483647;
    return f[lz * 16 + lx];
  }

  // 窗口 [x-r, x+r] x [z-r, z+r] 是否完全落在已加载区块内
  function windowOk(x, z, r) {
    var a0 = cx + Math.floor((x - r) / 16), a1 = cx + Math.floor((x + r) / 16);
    var b0 = cz + Math.floor((z - r) / 16), b1 = cz + Math.floor((z + r) / 16);
    for (var aa = a0; aa <= a1; aa++) {
      for (var bb = b0; bb <= b1; bb++) {
        if (chunkField(aa, bb) === null) return false;
      }
    }
    return true;
  }

  // 窗口半径自适应：邻区块缺失时缩小窗口，尽量保住该列（只统计真正算不出来的列）
  var win = new Int32Array((2 * R + 1) * (2 * R + 1));
  var cutSum = 0, cutCols = 0, refPartial = false;
  for (z = 0; z < 16; z++) {
    for (x = 0; x < 16; x++) {
      var useR = -1;
      for (var rr = R; rr >= 1; rr--) {
        if (windowOk(x, z, rr)) { useR = rr; break; }
      }
      if (useR < 0) { refPartial = true; continue; }
      if (useR < R) refPartial = true;
      var n = 0;
      for (var dz = -useR; dz <= useR; dz++) {
        for (var dx = -useR; dx <= useR; dx++) win[n++] = heightAt(x + dx, z + dz);
      }
      var arr2 = win.slice(0, n);
      arr2.sort();
      var ref = arr2[n >> 1];
      var d = ref - H[z * 16 + x];
      if (d > cfg.destruction.cutThreshold) cutSum += (d - cfg.destruction.cutThreshold);
      cutCols++;
    }
  }
  var cutAvg = cutCols > 0 ? (cutSum / cutCols) : 0;

  // ---- 6.4 地下支持物（破坏证据 B1）----
  var supportPos = cmFindPositions(sections, nSec, minY, function (st) {
    return (cmClassify(st.getBlock()).c & CM_SUPPORT) !== 0;
  });
  var traceBelow = 0;
  for (k = 0; k < supportPos.length; k += 3) {
    if (supportPos[k + 1] < H[supportPos[k + 2] * 16 + supportPos[k]]) traceBelow++;
  }

  // ---- 6.5 人工方块定位 + 连通体分析（26 邻域）----
  var manPos = cmFindPositions(sections, nSec, minY, function (st) {
    var c3 = cmClassify(st.getBlock()).c;
    return (c3 & CM_MAN) !== 0 && (c3 & CM_SUPPORT) === 0;
  });
  var nMan = (manPos.length / 3) | 0;

  var cellIdx = new Int32Array(nSec * 4096);
  for (i = 0; i < cellIdx.length; i++) cellIdx[i] = -1;
  var px = new Int16Array(nMan), py = new Int32Array(nMan), pz = new Int16Array(nMan);
  var pblk = new Array(nMan);
  for (k = 0; k < nMan; k++) {
    var bx = manPos[k * 3], by = manPos[k * 3 + 1], bz = manPos[k * 3 + 2];
    px[k] = bx; py[k] = by; pz[k] = bz;
    pblk[k] = sections[(by >> 4) - minSecY].getBlockState(bx, by & 15, bz).getBlock();
    cellIdx[(((by >> 4) - minSecY) * 4096) + (((by & 15) * 16 + bz) * 16 + bx)] = k;
  }

  var visited = new Uint8Array(nMan);
  var stack = new Int32Array(nMan);
  var comps = [];

  for (var s0 = 0; s0 < nMan; s0++) {
    if (visited[s0]) continue;
    var sp = 0;
    stack[sp++] = s0;
    visited[s0] = 1;
    var members = [];
    var typeSet = new Set();
    var shapedCnt = 0, machCnt = 0, aboveCnt = 0, belowCnt = 0;
    var bx0 = 15, bx1 = -1, bz0 = 15, bz1 = -1, by0 = 2147483647, by1 = -2147483648;
    while (sp > 0) {
      var cur = stack[--sp];
      members.push(cur);
      var cxx = px[cur], cyy = py[cur], czz = pz[cur];
      var blk = pblk[cur];
      var e2 = cmClassify(blk);
      typeSet.add(blk);
      if (e2.shaped) shapedCnt++;
      if (e2.mach) machCnt++;
      if (cyy >= H[czz * 16 + cxx]) aboveCnt++; else belowCnt++;
      if (cxx < bx0) bx0 = cxx;
      if (cxx > bx1) bx1 = cxx;
      if (czz < bz0) bz0 = czz;
      if (czz > bz1) bz1 = czz;
      if (cyy < by0) by0 = cyy;
      if (cyy > by1) by1 = cyy;
      var yl2 = cyy & 15;
      var sBase2 = ((cyy >> 4) - minSecY) * 4096;
      for (var ddy = -1; ddy <= 1; ddy++) {
        var ny = cyy + ddy;
        if (ny < minY || ny >= maxY) continue;
        var yl3 = ny & 15;
        var sBase3 = ((ny >> 4) - minSecY) * 4096;
        for (var ddz = -1; ddz <= 1; ddz++) {
          var nz = czz + ddz;
          if (nz < 0 || nz > 15) continue;
          for (var ddx = -1; ddx <= 1; ddx++) {
            if (ddx === 0 && ddy === 0 && ddz === 0) continue;
            var nx = cxx + ddx;
            if (nx < 0 || nx > 15) continue;
            var j = cellIdx[sBase3 + (((yl3 * 16 + nz) * 16) + nx)];
            if (j >= 0 && !visited[j]) { visited[j] = 1; stack[sp++] = j; }
          }
        }
      }
    }
    var size = members.length;
    var typeCount = typeSet.size;
    var bboxVol = (bx1 - bx0 + 1) * (by1 - by0 + 1) * (bz1 - bz0 + 1);
    var fill = bboxVol > 0 ? (size / bboxVol) : 0;
    comps.push({ size: size, typeCount: typeCount, fill: fill, shaped: shapedCnt,
                 mach: machCnt, above: aboveCnt, below: belowCnt,
                 y0: by0, y1: by1, x0: bx0, x1: bx1, z0: bz0, z1: bz1,
                 quality: 0, credited: false, members: members });
  }

  // 质量评估 + 门槛（抗刷分 / 抗「未打标签的地形方块」误判）
  var a = cfg.artificial;
  var goodMass = 0, maxGood = 0, manBelowStructured = 0, machGood = 0, goodAbove = 0;
  var goodSec = new Set();
  var goodMembers = [];
  var structCol = new Uint8Array(256);   // 含被认可人工结构的柱：其下方中空不计入地下空腔
  for (var ci = 0; ci < comps.length; ci++) {
    var c = comps[ci];
    var craft = c.shaped + c.mach;
    var craftRatio = c.size > 0 ? (craft / c.size) : 0;
    c.credited = (craft >= a.minShapeOrMachine && craftRatio >= a.minShapedRatio);
    if (!c.credited || c.size < a.minComponentSize) continue;
    if (c.typeCount <= a.maxTerrainTypes && c.fill >= a.terrainFillThreshold) continue;
    var sizeFactor = Math.min(1, Math.log1p(c.size) / Math.log1p(a.refComponentSize));
    var divFactor = Math.min(1, c.typeCount / a.refTypeDiversity);
    var shapeFactor = 0.5 + 0.5 * Math.min(1, craftRatio / 0.25);
    var machFactor = c.mach > 0 ? 1 : 0;
    c.quality = sizeFactor * (0.45 * divFactor + 0.35 * shapeFactor + 0.20 * machFactor);
    if (c.quality <= 0) continue;
    goodMass += c.size * c.quality;
    if (c.size > maxGood) maxGood = c.size;
    machGood += c.mach;
    manBelowStructured += c.below;
    goodAbove += c.above;
    for (var mi = 0; mi < c.members.length; mi++) {
      var mk = c.members[mi];
      goodSec.add((py[mk] >> 4) - minSecY);
      goodMembers.push(mk);
      structCol[pz[mk] * 16 + px[mk]] = 1;
    }
  }

  // 6.6b 埋入岩层的人工材料（回填/基础/地下塞填）：
  // 6 邻域里 >=4 个是自然固体。用「局部被岩层包裹」而不是「低于当前地表」，
  // 因为建筑自身会把地表高度顶上去，用当前地表会把高楼底层误算成地下。
  var encasedStructured = 0;
  var AZ6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (var ei = 0; ei < goodMembers.length; ei++) {
    var ek = goodMembers[ei];
    var ex = px[ek], ey = py[ek], ez = pz[ek];
    var natN = 0;
    for (var ni = 0; ni < 6; ni++) {
      var sst = cmStateAt(sections, minY, nSec, ex + AZ6[ni][0], ey + AZ6[ni][1], ez + AZ6[ni][2]);
      if (sst == null) continue;
      if (sst.isAir()) continue;
      if ((cmClassify(sst.getBlock()).c & CM_NATURAL) !== 0) natN++;
    }
    if (natN >= 4) encasedStructured++;
  }

  // ---- 6.6 地表以下体积 与 地下空腔（放在连通体分析之后，因为需要 structCol）----
  // 只统计「没有人工结构」的柱：建筑会把该柱高度顶高，使建筑自身的中空内部落在
  // 「地表以下」。若不排除，一个纯建筑仅凭中空内部就会拿到破坏分（初版 B2 实测 0.283）。
  // 整段位于地表以下的深处空气与结构无关（矿道/洞穴这类真实地下空腔必须保留），仍全量计入。
  var subsurfaceVolume = 0;
  for (k = 0; k < 256; k++) {
    var hv = H[k] - minY;
    if (hv > 0) subsurfaceVolume += hv;
  }
  var subsurfaceAir = 0;
  var scannedSections = 0;
  for (i = 0; i < nSec; i++) {
    var y0 = minY + i * 16;
    var below = 0;
    for (k = 0; k < 256; k++) {
      var v = H[k] - y0;
      if (v <= 0) continue;
      if (v >= 16) { below += 16; continue; }
      below += v;
    }
    if (below === 0) continue;
    if (below === 4096) { subsurfaceAir += secAir[i]; continue; }
    if (secAir[i] === 0) continue;
    scannedSections++;
    var s2 = sections[i];
    var airHere = 0;
    for (y = 0; y < 16; y++) {
      for (z = 0; z < 16; z++) {
        for (x = 0; x < 16; x++) {
          var ci2 = z * 16 + x;
          if (y0 + y >= H[ci2]) continue;
          if (structCol[ci2] === 1) continue;
          if (s2.getBlockState(x, y, z).isAir()) airHere++;
        }
      }
    }
    subsurfaceAir += airHere;
  }
  var subFrac = subsurfaceVolume > 0 ? (subsurfaceAir / subsurfaceVolume) : 0;

  // ---- 6.7 矿石剥露抽样估计 ----
  var sampledCols = 0, exposedOre = 0;
  var stride = cfg.destruction.oreSampleStride;
  for (z = 0; z < 16; z++) {
    for (x = 0; x < 16; x++) {
      if (cmHash(x, z, cx, cz) % stride !== 0) continue;
      sampledCols++;
      var hcol = H[z * 16 + x];
      for (y = minY; y < hcol; y++) {
        var stx = cmStateAt(sections, minY, nSec, x, y, z);
        if (stx == null) continue;
        var e3 = cmClassify(stx.getBlock());
        if ((e3.c & CM_ORE) === 0) continue;
        var airN = 0;
        if (cmIsAirAt(sections, minY, nSec, x + 1, y, z)) airN++;
        if (cmIsAirAt(sections, minY, nSec, x - 1, y, z)) airN++;
        if (cmIsAirAt(sections, minY, nSec, x, y + 1, z)) airN++;
        if (cmIsAirAt(sections, minY, nSec, x, y - 1, z)) airN++;
        if (cmIsAirAt(sections, minY, nSec, x, y, z + 1)) airN++;
        if (cmIsAirAt(sections, minY, nSec, x, y, z - 1)) airN++;
        if (airN >= 2) exposedOre++;
      }
    }
  }
  var oreExposedEst = sampledCols > 0 ? (exposedOre * (256 / sampledCols)) : 0;

  // ---- 6.8 破坏程度 D ----
  var wD = cfg.destruction.weights;

  var B1 = cmSat(traceBelow, cfg.destruction.traceSatK);
  var B2 = cmSat(subFrac - cfg.destruction.naturalVoidFraction, cfg.destruction.voidSatK);
  // 地表削减需要人工佐证：自然悬崖没有火把/结构，避免误判
  var cutEvidence = traceBelow + encasedStructured + goodAbove;
  var cutGate = cmClamp01(cutEvidence / cfg.destruction.cutEvidenceMin);
  var B3 = cmSat(cutAvg, cfg.destruction.cutSatK) * cutGate;
  var B4 = cmSat(oreExposedEst - cfg.destruction.oreBaseline, cfg.destruction.oreSatK);
  var B5 = cmSat(subsurfaceVolume > 0 ? (encasedStructured / subsurfaceVolume) : 0,
                 cfg.destruction.backfillSatK);
  var D = cmClamp01(wD.traces * B1 + wD.voidExcess * B2 + wD.surfaceCut * B3 +
                    wD.oreExposure * B4 + wD.backfill * B5);

  // ---- 6.9 人工程度 A ----
  var wA = cfg.artificial.weights;
  var C1 = cmSat(goodMass, cfg.artificial.structureSatK);
  var g = cmClamp01(C1 / cfg.artificial.gateAt);
  var machScore = machTotal * (1 + 0.3 * Math.min(machBlocks.size, 10) / 10);
  var C2 = cmSat(machScore, cfg.artificial.machinerySatK) * cmClamp01(maxGood / 32);
  var C3 = Math.min(1, maxGood / Math.max(1, Math.min(manTotal, 128))) * g;
  var span = 0;
  for (var cj = 0; cj < comps.length; cj++) {
    if (comps[cj].quality > 0) {
      var sp2 = comps[cj].y1 - comps[cj].y0 + 1;
      if (sp2 > span) span = sp2;
    }
  }
  var C4 = (0.5 * Math.min(1, goodSec.size / 6) + 0.5 * Math.min(1, span / 32)) * g;
  var pavedSet = new Set();
  for (var gm = 0; gm < goodMembers.length; gm++) {
    var gk = goodMembers[gm];
    var gx = px[gk], gy = py[gk], gz2 = pz[gk];
    var gh = H[gz2 * 16 + gx];
    if (gy >= gh - 2 && gy <= gh + 2) pavedSet.add(gz2 * 16 + gx);
  }
  var C5 = cmSat(pavedSet.size / 256, 0.5) * g;
  var A = cmClamp01(wA.structure * C1 + wA.machinery * C2 + wA.concentration * C3 +
                    wA.vertical * C4 + wA.ground * C5);

  // ---- 6.10 诊断信息 ----
  var topMan = [];
  manByBlock.forEach(function (nn, block) { topMan.push([cmBlockId(block), nn]); });
  topMan.sort(function (p1, p2) { return p2[1] - p1[1]; });
  if (topMan.length > 5) topMan = topMan.slice(0, 5);

  return {
    v: CM_VERSION,
    rev: CM_REV,
    cx: cx,
    cz: cz,
    dim: String(level.dimension().location()),
    d: D,
    a: A,
    partial: refPartial,
    ms: Date.now() - t0,
    raw: {
      B1: B1, B2: B2, B3: B3, B4: B4, B5: B5,
      C1: C1, C2: C2, C3: C3, C4: C4, C5: C5,
      subFrac: subFrac, subsurfaceAir: subsurfaceAir, subsurfaceVolume: subsurfaceVolume,
      naturalVoidFraction: cfg.destruction.naturalVoidFraction,
      cutAvg: cutAvg, cutCols: cutCols, cutEvidence: cutEvidence,
      traceBelow: traceBelow, traceAll: supportPos.length / 3,
      encased: encasedStructured, manBelowAll: manBelowStructured,
      exposedOreEst: oreExposedEst, sampledCols: sampledCols,
      manTotal: manTotal, goodMass: goodMass, maxGood: maxGood, machGood: machGood,
      manComponents: comps.length,
      machTotal: machTotal, machTypes: machBlocks.size,
      manSections: goodSec.size, manSpan: span, pavedCols: pavedSet.size,
      airTotal: airTotal, fluidTotal: fluidTotal, naturalTotal: naturalTotal,
      oreTotal: oreTotal, supportTotal: supportTotal, shapedManTotal: shapedManTotal,
      scannedStraddleSections: scannedSections, sections: nSec,
      minY: minY, topMan: topMan
    }
  };
}

// ---------------------------------------------------------------- 7. 持久化

function cmKey(cx, cz) { return cx + ',' + cz; }

// 内存兜底：万一 level.persistentData 在某些版本/环境不可用，仍能读到本次会话的统计
var CM_MEM = new Map();

function cmMemKey(level, cx, cz) {
  return String(level.dimension().location()) + '/' + cmKey(cx, cz);
}

function cmNewTag() { return new (Java.loadClass('net.minecraft.nbt.CompoundTag'))(); }

function cmRoot(level, create) {
  var root = level.persistentData.getCompound(CM_NS);
  if (create && (!root.contains('v') || root.getInt('v') !== CM_VERSION)) {
    root = cmNewTag();
    root.putInt('v', CM_VERSION);
    root.put('chunks', cmNewTag());
  }
  return root;
}

function cmStore(level, res) {
  CM_MEM.set(cmMemKey(level, res.cx, res.cz), {
    cx: res.cx, cz: res.cz, dim: res.dim, d: res.d, a: res.a,
    ts: Date.now(), partial: res.partial, stale: false, raw: res.raw
  });
  try {
  var root = cmRoot(level, true);
  if (!root.contains('chunks')) root.put('chunks', cmNewTag());
  var chunks = root.getCompound('chunks');
  var tag = cmNewTag();
  tag.putInt('v', CM_VERSION);
  tag.putInt('rev', res.rev);          // 自然表版本（int）；勿与下面的分量 CompoundTag 同键
  tag.putDouble('d', res.d);
  tag.putDouble('a', res.a);
  tag.putLong('t', Date.now());
  tag.putInt('p', res.partial ? 1 : 0);
  var rw = cmNewTag();
  var keys = ['B1', 'B2', 'B3', 'B4', 'B5', 'C1', 'C2', 'C3', 'C4', 'C5',
              'subFrac', 'cutAvg', 'traceBelow', 'exposedOreEst', 'manTotal',
              'goodMass', 'maxGood', 'machTotal', 'machTypes', 'manSections',
              'manSpan', 'pavedCols', 'airTotal', 'fluidTotal', 'naturalTotal', 'encased',
              'oreTotal', 'supportTotal', 'shapedManTotal', 'sections', 'minY'];
  for (var i = 0; i < keys.length; i++) rw.putDouble(keys[i], res.raw[keys[i]]);
  tag.put('r', rw);                    // 分量明细（CompoundTag）；版本号在独立的 'rev' 键
  chunks.put(cmKey(res.cx, res.cz), tag);
  root.put('chunks', chunks);
  root.putInt('rev', CM_REV);
  level.persistentData.put(CM_NS, root);
  } catch (err) {
    cmWarnOnce('pd', 'level.persistentData 写入不可用，退回内存缓存（重启后丢失）：' + err);
  }
}

function cmGet(level, cx, cz) {
  var disk = cmGetDisk(level, cx, cz);
  if (disk != null) return disk;
  var mem = CM_MEM.get(cmMemKey(level, cx, cz));
  return mem === undefined ? null : mem;
}

function cmGetDisk(level, cx, cz) {
  try {
    var root = level.persistentData.getCompound(CM_NS);
    if (!root.contains('chunks')) return null;
    var chunks = root.getCompound('chunks');
    var kk = cmKey(cx, cz);
    if (!chunks.contains(kk)) return null;
    var t = chunks.getCompound(kk);
    var out = {
      cx: cx,
      cz: cz,
      dim: String(level.dimension().location()),
      d: t.getDouble('d'),
      a: t.getDouble('a'),
      ts: t.getLong('t'),
      partial: t.getInt('p') === 1,
      stale: t.getInt('rev') !== CM_REV,
      raw: {}
    };
    if (t.contains('r')) {
      var rr = t.getCompound('r');
      rr.getAllKeys().forEach(function (key) {
        out.raw[String(key)] = rr.getDouble(String(key));
      });
    }
    return out;
  } catch (err) {
    cmWarnOnce('pd', 'level.persistentData 读取不可用，退回内存缓存：' + err);
    return null;
  }
}

function cmLoadCalibration(level) {
  CM_LEARNED.clear();
  CM_REV = 0;
  try {
    var root = level.persistentData.getCompound(CM_NS);
    if (!root.contains('calib')) return;
    var cal = root.getCompound('calib');
    CM_REV = cal.contains('rev') ? cal.getInt('rev') : 0;
    var s = cal.contains('natural') ? String(cal.getString('natural')) : '';
    if (s.length > 0) {
      var parts = s.split(',');
      for (var i = 0; i < parts.length; i++) if (parts[i].length > 0) CM_LEARNED.add(parts[i]);
    }
  } catch (err) { cmWarnOnce('calib', '读取标定表失败：' + err); }
  cmInvalidate();
}

// ---------------------------------------------------------------- 8. 调度

var cmQueue = [];
var cmQueued = {};
var cmTick = 0;
var cmLastAuto = 0;

function cmEnqueue(level, cx, cz, front) {
  var kk = String(level.dimension().location()) + '/' + cmKey(cx, cz);
  if (cmQueued[kk]) return false;
  if (cmQueue.length >= CM_CONFIG.scan.maxQueue) return false;
  cmQueued[kk] = true;
  var job = { level: level, cx: cx, cz: cz };
  if (front) cmQueue.unshift(job); else cmQueue.push(job);
  return true;
}

function cmEnqueueArea(level, cx, cz, radius) {
  var n = 0;
  for (var x = cx - radius; x <= cx + radius; x++) {
    for (var z = cz - radius; z <= cz + radius; z++) {
      if (cmEnqueue(level, x, z, false)) n++;
    }
  }
  return n;
}

function cmSkipsUnloaded(level, cx, cz) {
  if (!CM_CONFIG.scan.onlyLoadedChunks) return false;
  try { return !level.isLoaded(new CM_JAVA.BlockPos(cx << 4, 0, cz << 4)); }
  catch (err) { return false; }
}

function cmDrain(server) {
  if (cmQueue.length === 0) return 0;
  if (!cmLoadJava()) return 0;
  var t0 = Date.now();
  var done = 0;
  var budget = CM_CONFIG.scan.maxMillisPerTick;
  while (cmQueue.length > 0 && done < CM_CONFIG.scan.chunksPerTick) {
    if (done > 0 && (Date.now() - t0) >= budget) break;
    var job = cmQueue.shift();
    delete cmQueued[String(job.level.dimension().location()) + '/' + cmKey(job.cx, job.cz)];
    done++;
    if (cmSkipsUnloaded(job.level, job.cx, job.cz)) continue;
    try {
      var res = cmAnalyzeChunk(job.level, job.cx, job.cz, CM_CONFIG);
      cmStore(job.level, res);
      if (CM_CONFIG.debug) {
        console.info('[CM] ' + cmKey(job.cx, job.cz) + ' D=' + res.d.toFixed(3) +
                     ' A=' + res.a.toFixed(3) + ' ' + res.ms + 'ms');
      }
    } catch (err) {
      console.error('[CM] 区块 ' + cmKey(job.cx, job.cz) + ' 分析失败：' + err);
    }
  }
  return done;
}

function cmAutoEnqueue(server) {
  var players = null;
  try { players = server.players; } catch (e1) { }
  if (players == null) { try { players = server.getPlayers(); } catch (e2) { } }
  if (players == null) { try { players = server.getMcPlayers(); } catch (e3) { } }
  if (players == null) return;
  var jobs = [];
  try {
    players.forEach(function (p) {
      try { jobs.push([p.level(), Math.floor(p.getX() / 16), Math.floor(p.getZ() / 16)]); }
      catch (err) { }
    });
  } catch (err) { }
  for (var i = 0; i < jobs.length; i++) {
    cmEnqueueArea(jobs[i][0], jobs[i][1], jobs[i][2], CM_CONFIG.scan.autoScanRadius);
  }
}

ServerEvents.loaded(function (event) {
  try {
    if (!cmLoadJava()) return;
    var ow = event.server.overworld();
    if (ow != null) cmLoadCalibration(ow);
    console.info('[CM] chunk_metrics v' + CM_VERSION + ' 就绪（自然表版本 ' + CM_REV +
                 '，标定条目 ' + CM_LEARNED.size + '）');
  } catch (err) { console.error('[CM] 初始化失败：' + err); }
});

ServerEvents.tick(function (event) {
  cmTick++;
  try {
    if (CM_CONFIG.scan.autoScan && (cmTick - cmLastAuto) >= CM_CONFIG.scan.autoScanIntervalTicks) {
      cmLastAuto = cmTick;
      cmAutoEnqueue(event.server);
    }
    cmDrain(event.server);
  } catch (err) { cmWarnOnce('tick', 'tick 处理异常：' + err); }
});

// ---------------------------------------------------------------- 9. 命令（失败不影响 JS API）

function cmReply(source, msg) {
  console.info('[CM] ' + msg);
  try { source.sendSystemMessage(CM_JAVA.Component.literal(msg)); return 1; } catch (err) { }
  try {
    source.sendSuccess(function () { return CM_JAVA.Component.literal(msg); }, false);
    return 1;
  } catch (err2) { }
  try { source.sendFailure(CM_JAVA.Component.literal(msg)); return 1; } catch (err3) { }
  return 1;
}

function cmFmt(m) {
  if (m == null) return '无数据';
  return 'D=' + m.d.toFixed(3) + ' A=' + m.a.toFixed(3) +
         (m.partial ? ' [参考面不完整]' : '') + (m.stale ? ' [标定已变，需重扫]' : '');
}

ServerEvents.commandRegistry(function (event) {
  try {
    var Commands = event.commands;
    var Arguments = event.arguments;
    var S = Arguments.STRING.create(event);
    var SI = Arguments.INTEGER.create(event);

    function argInt(ctx, name) {
      try { return parseInt(String(Arguments.INTEGER.getResult(ctx, name)), 10); }
      catch (err) { return parseInt(String(Arguments.STRING.getResult(ctx, name)), 10); }
    }

    var root = Commands.literal('cm')
      .requires(function (src) { return src.hasPermission(2); })
      .executes(function (ctx) {
        return cmReply(ctx.source, 'chunk_metrics: /cm here | get <x> <z> | scan <radius> | top <radius> | stats | calib <radius> | dump <x> <z> | clear');
      })
      .then(Commands.literal('here').executes(function (ctx) {
        var p = ctx.source.getPlayer();
        var lv = ctx.source.getLevel();
        var qx = Math.floor(p.getX() / 16), qz = Math.floor(p.getZ() / 16);
        var m = cmEnsure(lv, qx, qz);
        return cmReply(ctx.source, '[' + qx + ',' + qz + '] ' + cmFmt(m));
      }))
      .then(Commands.literal('get')
        .then(Commands.argument('x', SI).then(Commands.argument('z', SI).executes(function (ctx) {
          var lv = ctx.source.getLevel();
          var gx = argInt(ctx, 'x'), gz = argInt(ctx, 'z');
          return cmReply(ctx.source, '[' + gx + ',' + gz + '] ' + cmFmt(cmEnsure(lv, gx, gz)));
        }))))
      .then(Commands.literal('scan')
        .then(Commands.argument('radius', SI).executes(function (ctx) {
          var lv = ctx.source.getLevel();
          var p = ctx.source.getPlayer();
          var r = cmClampInt(argInt(ctx, 'radius'), 0, 64);
          var n = cmEnqueueArea(lv, Math.floor(p.getX() / 16), Math.floor(p.getZ() / 16), r);
          return cmReply(ctx.source, '已入队 ' + n + ' 个区块（半径 ' + r + '），后台按 tick 预算处理');
        })))
      .then(Commands.literal('top')
        .then(Commands.argument('radius', SI).executes(function (ctx) {
          var lv = ctx.source.getLevel();
          var p = ctx.source.getPlayer();
          var r = cmClampInt(argInt(ctx, 'radius'), 0, 64);
          var list = cmRank(lv, Math.floor(p.getX() / 16), Math.floor(p.getZ() / 16), r, { limit: 5 });
          if (list.length === 0) return cmReply(ctx.source, '范围内暂无已统计区块，先 /cm scan ' + r);
          var msg = 'TOP: ';
          for (var i2 = 0; i2 < list.length; i2++) {
            msg += '[' + list[i2].cx + ',' + list[i2].cz + ']D' + list[i2].d.toFixed(2) +
                   '/A' + list[i2].a.toFixed(2) + '  ';
          }
          return cmReply(ctx.source, msg);
        })))
      .then(Commands.literal('stats').executes(function (ctx) {
        return cmReply(ctx.source, cmStatsText(ctx.source.getLevel()));
      }))
      .then(Commands.literal('clear').executes(function (ctx) {
        var lv = ctx.source.getLevel();
        var rt = cmRoot(lv, false);
        rt.put('chunks', cmNewTag());
        lv.persistentData.put(CM_NS, rt);
        return cmReply(ctx.source, '已清空该维度的区块统计记录');
      }))
      .then(Commands.literal('calib')
        .then(Commands.argument('radius', SI).executes(function (ctx) {
          var lv = ctx.source.getLevel();
          var p = ctx.source.getPlayer();
          var r = cmClampInt(argInt(ctx, 'radius'), 0, 64);
          return cmReply(ctx.source, cmCalibrate(lv, Math.floor(p.getX() / 16), Math.floor(p.getZ() / 16), r));
        })))
      .then(Commands.literal('dump')
        .then(Commands.argument('x', SI).then(Commands.argument('z', SI).executes(function (ctx) {
          var m = cmEnsure(ctx.source.getLevel(), argInt(ctx, 'x'), argInt(ctx, 'z'));
          if (m == null) return cmReply(ctx.source, '无数据');
          var ks = Object.keys(m.raw);
          var msg = '';
          for (var i3 = 0; i3 < ks.length && i3 < 14; i3++) msg += ks[i3] + '=' + m.raw[ks[i3]] + '  ';
          return cmReply(ctx.source, msg);
        }))));

    event.register(root);
  } catch (err) {
    console.error('[CM] 命令注册失败（JS API 不受影响）：' + err);
  }
});

// ---------------------------------------------------------------- 10. 标定与统计

function cmCalibrate(level, cx, cz, radius) {
  if (!cmLoadJava()) return 'Java 桥未就绪';
  var share = {};
  var totalChunks = 0;
  for (var x = cx - radius; x <= cx + radius; x++) {
    for (var z = cz - radius; z <= cz + radius; z++) {
      if (cmSkipsUnloaded(level, x, z)) continue;
      try {
        var chunk = level.getChunk(x, z);
        var sections = chunk.getSections();
        var nSec = sections.length;
        totalChunks++;
        var seen = {};
        for (var i = 0; i < nSec; i++) {
          var sec = sections[i];
          if (sec.hasOnlyAir()) continue;
          var counts = cmSectionBlockCounts(sec);
          counts.forEach(function (n, block) {
            var id = cmBlockId(block);
            if (seen[id]) return;
            seen[id] = true;
            share[id] = (share[id] === undefined ? 0 : share[id]) + 1;
          });
        }
      } catch (err) { }
    }
  }
  if (totalChunks === 0) return '标定失败：范围内没有已加载区块（请在原版未探索区域执行）';
  var need = Math.max(2, Math.ceil(totalChunks * CM_CONFIG.classifier.calibrateMinChunkShare));
  var picked = [];
  for (var id2 in share) {
    if (!share.hasOwnProperty(id2)) continue;
    if (share[id2] >= need) picked.push(id2);
  }
  picked.sort();
  CM_LEARNED.clear();
  for (var p2 = 0; p2 < picked.length; p2++) CM_LEARNED.add(picked[p2]);
  CM_REV++;
  cmInvalidate();
  var root = cmRoot(level, true);
  var cal = cmNewTag();
  cal.putInt('rev', CM_REV);
  cal.putString('natural', picked.join(','));
  cal.putInt('chunks', totalChunks);
  cal.putLong('t', Date.now());
  root.put('calib', cal);
  level.persistentData.put(CM_NS, root);
  return '标定完成：参考 ' + totalChunks + ' 区块，判定自然方块 ' + picked.length +
         ' 种（自然表版本 ' + CM_REV + '）。已有记录会被标记 stale，建议重扫。';
}

function cmStatsText(level) {
  try {
    var root = level.persistentData.getCompound(CM_NS);
    if (!root.contains('chunks')) return '暂无数据';
    var chunks = root.getCompound('chunks');
    var keys = chunks.getAllKeys();
    var n = 0, sumD = 0, sumA = 0, maxD = 0, maxA = 0;
    keys.forEach(function (key) {
      var t = chunks.getCompound(String(key));
      var dd = t.getDouble('d'), aa = t.getDouble('a');
      n++; sumD += dd; sumA += aa;
      if (dd > maxD) maxD = dd;
      if (aa > maxA) maxA = aa;
    });
    if (n === 0) return '暂无数据';
    return '已统计 ' + n + ' 区块  平均D=' + (sumD / n).toFixed(3) + ' 平均A=' + (sumA / n).toFixed(3) +
           '  最大D=' + maxD.toFixed(3) + ' 最大A=' + maxA.toFixed(3) + '  队列=' + cmQueue.length;
  } catch (err) { return '统计失败：' + err; }
}

// ---------------------------------------------------------------- 11. 读取接口（供出生点逻辑调用）

function cmEnsure(level, cx, cz) {
  var m = cmGet(level, cx, cz);
  if (m != null && !m.stale) return m;
  if (cmSkipsUnloaded(level, cx, cz)) return m;   // 未加载：返回已有记录或 null，不主动生成
  try {
    cmStore(level, cmAnalyzeChunk(level, cx, cz, CM_CONFIG));
    return cmGet(level, cx, cz);
  } catch (err) {
    cmWarnOnce('ensure', '即时计算失败：' + err);
    return m;
  }
}

function cmGetAt(level, blockX, blockZ) {
  return cmGet(level, Math.floor(blockX / 16), Math.floor(blockZ / 16));
}

function cmRank(level, cx, cz, radius, opts) {
  opts = opts || {};
  var wD = (opts.wD === undefined) ? 0.5 : opts.wD;
  var wA = (opts.wA === undefined) ? 1.0 : opts.wA;
  var minA = (opts.minA === undefined) ? 0 : opts.minA;
  var maxD = (opts.maxD === undefined) ? 1 : opts.maxD;
  var limit = opts.limit || 64;
  var out = [];
  for (var x = cx - radius; x <= cx + radius; x++) {
    for (var z = cz - radius; z <= cz + radius; z++) {
      var m = cmGet(level, x, z);
      if (m == null) continue;
      if (m.a < minA || m.d > maxD) continue;
      m.score = wA * m.a - wD * m.d;
      out.push(m);
    }
  }
  out.sort(function (p, q) { return q.score - p.score; });
  if (out.length > limit) out = out.slice(0, limit);
  return out;
}

function cmScore(m, wD, wA) {
  if (m == null) return 0;
  return wA * m.a - wD * m.d;
}

global.CM = {
  version: CM_VERSION,
  config: CM_CONFIG,
  analyze: function (level, cx, cz) { return cmAnalyzeChunk(level, cx, cz, CM_CONFIG); },
  ensure: cmEnsure,
  get: cmGet,
  getAt: cmGetAt,
  enqueue: cmEnqueue,
  scanArea: cmEnqueueArea,
  rank: cmRank,
  score: cmScore,
  stats: cmStatsText,
  calibrate: cmCalibrate,
  reloadCalibration: cmLoadCalibration,
  invalidate: cmInvalidate,
  queueSize: function () { return cmQueue.length; },
  learned: function () { return CM_LEARNED; },
  rev: function () { return CM_REV; }
};
