// ============================================================================
// 战服 · 20_spawn.js —— 出生点域（P0；战服开发方案.md §2「出生点系统」）
// ============================================================================
// 依赖：
//   · 00_core.js        —— global.WAR（数据根 / 审计 / 命令节点工厂 / 公共工具）
//   · chunk_metrics.js  —— global.CM（每区块破坏度 D、人工程度 A；只读消费，不复制打分逻辑）
// 权威存储：global.WAR.data.state.spawn（JSON 载荷，由 00_core.js 统一落盘）
// 对外接口：global.WAR.spawn.roll(player, opts) -> {ok, code, message, x,y,z, ...}
//           global.WAR.spawn.status() / gaps() / center(source,x,z) / radius(source,r)
// 命令：/war spawn [roll|status|last]
//       /war spawn admin center [<x> <z>] | radius <n>      （OP2，同 00_core 的 admin 谓词）
//
// ── 降级策略（task 要求：三种输入必须有确定行为且不抛错）───────────────────
//   CM 未加载       ⇒ 拒绝掷点，code=CM_MISSING
//   候选区块未扫描   ⇒ 跳过该候选，全部失败后拒绝，code=NO_SCANNED_CANDIDATE
//   读取失败        ⇒ 候选的失败原因**全是**「world data 读不出来」时，拒绝码用
//                      CM_READ_FAIL（而不是 NO_SCANNED_CANDIDATE）——「还没扫描」与
//                      「数据坏了」给管理员的下一步完全不同。只有 CM 扩展版
//                      （有 scoreArea/getStatus，2026-10-04）才分得出这两者。
//   旧版 CM（无 scoreArea）⇒ 自动退化回 9 次 CM.getAt，且无法区分「无记录 / 读取失败」，
//                      统一按未扫描处理（与本次改动前的行为逐字一致）。
//   选「明确拒绝并告知玩家」而不是生物群系/结构启发式回退，理由：
//     ① 本域的验收标准就是「低破坏、低人工、已扫描」，启发式回退拿不到 D/A，
//        会给出与口径不可比、事后无法解释的落点；
//     ② 回退要么复制一份打分逻辑（与 chunk_metrics 权重漂移），要么退化成「只看地形」，
//        两种都会让「出生点质量」这件事失去单一权威；
//     ③ 拒绝是确定行为、可解释、可操作（消息里直接给可执行的下一步）。
//     代价：新服未预扫描前 /war spawn 会一直拒绝 —— 方案 §2 第 4 点本来就是
//     「Chunky 预生成环带 + CM 扫描」，这是预期内的前置条件，不是缺陷。
//     （若日后要改成回退，只需实现 spRoll 里的候选接受分支，不改任何外部契约。）
//
// ── 已核实的 KubeJS/原版 API（出处：00_core.js 头注 + chunk_metrics.js 实证行号）──
//   ServerEvents.commandRegistry / event.commands / event.arguments / event.register
//   Arguments.INTEGER.create(event) / getResult(ctx,name)
//   source.hasPermission(int) / getPlayer() / getLevel() / sendSystemMessage(Component)
//   level.persistentData（ServerLevelMixin）/ server.persistentData
//   chunk.getHeight(Heightmap.Types, lx, lz)（chunk_metrics.js:434）
//   chunk.getBlockState(lx, y, lz)（chunk_metrics.js:709）
//   level.isLoaded(BlockPos)（chunk_metrics.js:480,962）/ new BlockPos(x,y,z)
//   Java.loadClass('net.minecraft.world.level.levelgen.Heightmap$Types')(chunk_metrics.js:192)
//   Java.loadClass('net.minecraft.core.registries.BuiltInRegistries').BLOCK（chunk_metrics.js:188）
//   state.isAir()（chunk_metrics.js:404）/ state.getFluidState().isEmpty()（chunk_metrics.js:267）
//   EntityEvents.beforeHurt('minecraft:player', handler)（KubeJS TargetedEventHandler，字节码实证）
//   BeforeLivingEntityHurtKubeEvent: getEntity() / getSource() / setDamage(float)
//   ⚠ 该事件不可 cancel（LivingDamageEvent$Pre 未实现 ICancellableEvent）⇒ 只能用 setDamage(0)
//
// ── ⚠ 仅实机可证（本机无 MC 运行时；离线自检用假桥，见 .wartest/spawn_selftest.js）──
//   level.dimension().location().toString() / server.overworld()
//   level.getSharedSpawnPos() / level.getLevelData().getSpawnPos()
//   level.getMinY() / level.getChunk(cx,cz)
//   player.teleportToLevel(level,x,y,z,yaw,pitch) 与兜底 player.teleportTo(x,y,z)
//   player.level / source.getLevel() 在玩家上下文里的实际返回类型
//   DamageSource.getEntity()（判定攻击者是不是玩家）
//   Heightmap$Types.WORLD_SURFACE 常量名（worldgen 里应为 WORLD_SURFACE / OCEAN_FLOOR / MOTION_BLOCKING）
//   player.getX()/getZ()（改中心用）
// ============================================================================

var SP_OWNER = '20_spawn.js';
var SP_VERSION = 2;   // v2：读数切到 CM.scoreArea 批量接口（旧版 CM 自动退化回逐点）

// ============================================================================
// CONFIG —— 本域的「待补充参数」（方案 §10）。标「暂定默认值」= 尚未拍板。
// 运行时可被持久化配置覆盖（/war spawn admin center|radius，或直接改数据根）：
// 下面的 SP_CONFIG 只是首次初始化时的默认值来源。
// ⚠ maxRadius / tries **不在这里写死**：唯一真值源是 00_core 的 WAR_CONFIG.spawn
//   .candidateRadius / .tries（见 spDefaultConfig 的 core 段）。core 缺键时用 SP_FALLBACK
//   + warWarnOnce 明确警告一次 —— 绝不静默回落（core 改名后继续用 5000/64 跑，这种 bug 最难查）。
// ============================================================================
var SP_CONFIG = {
  minRadius: 64,                 // 暂定默认值：环带内边界（方块），避免落在中心附近
  maxMillis: 50,                 // 暂定默认值：单次掷点时间预算（ms）——选点低频、绝不进 tick
  minScored: 5,                  // 暂定默认值：候选 3×3 区块中至少几个「非过期」记录才算已扫描
  weights: { d: 0.6, a: 1.0, used: 0.35 },  // 暂定默认值：D̄ / Ā / 已用次数 的权重
  usedScale: 4,                  // 暂定默认值：used 次数 → 惩罚饱和的刻度
  earlyExitScore: 0.90,          // 暂定默认值：评分达此值即停止采样（够好就收，省预算）
  cooldownMs: 60000,             // 暂定默认值：同一玩家两次掷点最小间隔
  maxRolls: 5,                   // 暂定默认值：同一玩家掷点次数上限（OP 豁免，便于测试）
  protectionMs: 60000,           // 暂定默认值：新手保护窗口（task 传的「暂定 60 秒」）
  logLimit: 200,                 // 暂定默认值：spawn.log 保留的玩家条数（按 lastAt 淘汰最旧）
  rngSeed: 0,                    // 0 = 每次用当前时间；>0 = 固定种子（掷点可复现，方案 §2「可复现」）
  sampleGrid: 4,                 // 暂定默认值：每区块地形采样网格（4 → 4×4 = 16 列）
  maxSlope: 3,                   // 暂定默认值：落点邻域最大高差（方块）
  allowFluidGround: false,       // 暂定默认值：是否允许站在水/岩浆表面（false = 拒绝）
  rankRadiusMax: 8,              // 暂定默认值：status 里 CM.rank 扫描半径上限（区块）——防大范围卡顿
  rings: [ { rMin: 0.55, rMax: 1.0, weight: 1 } ],  // 暂定默认值：相对 maxRadius 的比例环带
  // 非固体装饰方块白名单（脚/头位置允许）。用白名单而非 isSolid()/blocksMotion()：
  // 后者方法名未经本机字节码核实，白名单离线可测、行为确定、可由策划编辑。
  passableBlocks: [
    'minecraft:short_grass', 'minecraft:grass', 'minecraft:tall_grass', 'minecraft:fern',
    'minecraft:large_fern', 'minecraft:dead_bush', 'minecraft:snow', 'minecraft:torch',
    'minecraft:wall_torch', 'minecraft:soul_torch', 'minecraft:redstone_torch', 'minecraft:vine',
    'minecraft:sugar_cane', 'minecraft:dandelion', 'minecraft:poppy', 'minecraft:blue_orchid',
    'minecraft:azure_bluet', 'minecraft:oxeye_daisy', 'minecraft:cornflower',
    'minecraft:lily_of_the_valley', 'minecraft:allium', 'minecraft:orange_tulip',
    'minecraft:red_tulip', 'minecraft:white_tulip', 'minecraft:pink_tulip',
    'minecraft:sunflower', 'minecraft:lilac', 'minecraft:rose_bush', 'minecraft:peony',
    'minecraft:seagrass', 'minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:rail'
  ],
  // 危险地面（含流体以外的伤害源）。水/岩浆另由流体判定拦截，不必列在这里。
  hazardBlocks: [
    'minecraft:lava', 'minecraft:fire', 'minecraft:soul_fire', 'minecraft:magma_block',
    'minecraft:campfire', 'minecraft:soul_campfire', 'minecraft:cactus',
    'minecraft:sweet_berry_bush', 'minecraft:nether_portal', 'minecraft:end_portal',
    'minecraft:cobweb', 'minecraft:powder_snow', 'minecraft:pointed_dripstone',
    'minecraft:wither_rose', 'minecraft:sculk_shrieker', 'minecraft:magma_cream_block'
  ]
};

// 00_core 缺 candidateRadius / tries 时的保底值；使用它一定会 warWarnOnce 点名（不是静默默认值）
var SP_FALLBACK = { maxRadius: 5000, tries: 64 };

// ============================================================================
// SPAWN_D_MAX（出生点「破坏程度」硬门）—— 暂定值 + 标定流程（不要当结论用）
// ============================================================================
// 0.05 是**暂定值，不是结论**：离线拿不到真实 a/d 分布，任何拍出来的数都是猜。
// 标定流程（一次实机 + 一次抄数）：
//   1) /cm scan 8    —— 先在中心附近扫一个半径（区块数），让 CM 有真实记录；
//   2) /war spawn admin dcalib 8
//      —— 本域只读导出**仅来自已扫描记录**的分布：a 与 d 的 min/p25/中位/p75/max，
//         以及 a===0 的比例；不 analyze、不加载区块、不写 pd（沿用 scoreArea 的铁律）；
//   3) 读结论：**d 的天然底噪 p75 决定阈值下限**。
//      自然悬崖/洞穴会被计入 B2/B3 ⇒ d 天然带非零底噪；阈值必须 **> 底噪**，
//      否则几乎每个候选都被 SPAWN_DESTROYED 刷掉、出生点永远刷不出来。
//      取值建议 = max(当前值, d 的 p75) 再加一点余量，然后写回 00_core 的
//      WAR_CONFIG.spawn.dMax（core 是唯一真值源；本文件只保留缺键保底 + 警告）。
// 注意：a 的硬门是 **a === 0**（不是「低」），与阈值无关；分布里的「a===0 比例」
//       用来判断这个门在你们服务器上有多严——比例过低说明 A 把太多自然物算成了人工。
// ============================================================================
var SP_D_MAX_FALLBACK = 0.05;      // 仅 core 缺键时的保底（会 warWarnOnce 点名）
var SP_COVER_MIN_FALLBACK = 7;     // 3×3 覆盖度门槛（fresh 块数，1..9）；暂定 7/9，用 dcalib 的覆盖度分布标定
var SP_DCALIB_R_MAX = 32;          // dcalib 的半径上限（区块）
// 覆盖度门槛（coverMin）为什么必须先于 a/d 硬门：
//   候选的 a/d 是 3×3 聚合，且 no-record / stale **不参与均值**（spChunkAvgBatch）。
//   若只看 minScored=5/9，就会出现「只有 5 块扫过、恰好都是 a=0」而通过 a===0 的假放行，
//   而剩下 4 块里可能正是一座基地 —— 这在「人为化不为 0 不行」这条规格下是最坏的失效模式。
//   标定：/cm scan 后用 /war spawn admin dcalib，看「3×3 窗口里 fresh ≥ coverMin 的占比」，
//   占比过低说明门槛偏严（会把还没扫密的区域全判为覆盖不足）。

// 接口缺口（task ⑤ 要求列出；扩 CM 属 chunk_metrics.js 改动，须单独授权）
// 2026-10-04 的 CM 扩展已兑现其中三条（getStatus / scoreArea / rank 的 order+skipStale，
// 见 chunk_metrics/README.md §4.2），下面是**仍然存在**的缺口。
var SP_GAPS = [
  '方案 §2 的 S 还含 资源潜力 / 他人基地距离 / 队伍聚集度 三项 ⇒ 分别依赖 40_base（基地与宣称）与尚未实现的资源域；本域把它们列为缺口、不参与加权（按 0 参与会人为拉低所有候选分数、稀释 D/A 权重，且 0 会被误读成「无惩罚」）。',
  '方案 §2 的「预生成环带（Chunky）」与「落地 10 秒无敌」的时长参数仍是待补充项；本域只做 60 秒保护窗口（SP_CONFIG.protectionMs，任务给的是暂定值）。',
  'CM.scoreArea 只覆盖方形区域（radius ≤ 32），而本域的候选是环带上的散点 ⇒ 现在每个候选调一次 scoreArea(radius 1)，64 候选 = 64 次调用。若 CM 将来提供「一次多组散点坐标」的批量打分，这里还能再降一档。'
];

// 运行期内存（不落盘）
var SP_MEM = {
  pos: null,          // 缓存 BlockPos 类
  posFailed: false,
  blockReg: null,     // 缓存 BuiltInRegistries.BLOCK
  heightType: null,   // 缓存 Heightmap$Types.WORLD_SURFACE
  msgAt: {},          // 保护提示节流：uuid -> 上次提示时间
  bootDim: '',        // boot 时解析到的维度键（仅供参考日志）
  hurtReg: 'none',    // 伤害拦截注册方式：targeted / untargeted / none
  lastGate: null      // 上次掷点的硬门统计（给 status 报「分别刷掉多少」，见 spGateStat）
};

// ============================================================================
// 0. 小工具（本域私有；war* 前缀的公共工具来自 00_core.js，见那里的工具导出清单：
//    opPredicate / intArg / clampInt / nameOf / uuidOf / reply / tell / run / every …）
// ============================================================================

function spNum(v, dft) {
  var n = Number(v);
  return (isNaN(n) || !isFinite(n)) ? dft : n;
}
function spClampNum(v, lo, hi, dft) {
  var n = spNum(v, dft);
  if (n < lo) n = lo;
  if (n > hi) n = hi;
  return n;
}
// 整数钳位统一走 00_core 的 WAR.clampInt（它在 00_core.js 的注释里自证「语义照抄本域旧 spClampInt」：
// 小数四舍五入、Infinity 回落 dft、越界夹取）。旧 spClampInt **已删**，本域不留副本，
// 免得两处实现漂移。浮点的 spNum / spClampNum 没有对应共享工具（warToInt 是整数解析、
// 语义不同），仍留本域。
function spListHas(list, v) {
  if (list == null || v == null) return false;
  for (var i = 0; i < list.length; i++) { if (list[i] === v) return true; }
  return false;
}
function spStr(s) { return (s == null) ? '' : String(s); }

// 确定性 PRNG（Lehmer / park-miller）——不用 Math.imul，Rhino 上无需 ES6
function spRngNew(seed) {
  var s = Math.abs(Math.floor(spNum(seed, 1))) % 2147483647;
  if (s <= 0) s = 123456789;
  return function () {
    s = (s * 48271) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function spCm() {
  try {
    var cm = global.CM;
    if (cm == null) return null;
    if (typeof cm.getAt !== 'function') return null;
    return cm;
  } catch (e) { return null; }
}

function spBlockPos(x, y, z) {
  if (SP_MEM.posFailed) return null;
  if (SP_MEM.pos == null) {
    try { SP_MEM.pos = Java.loadClass('net.minecraft.core.BlockPos'); } catch (e) { SP_MEM.posFailed = true; return null; }
  }
  try { return new SP_MEM.pos(x, y, z); } catch (e2) { return null; }
}

function spBlockRegistry() {
  if (SP_MEM.blockReg != null) return SP_MEM.blockReg;
  try { SP_MEM.blockReg = Java.loadClass('net.minecraft.core.registries.BuiltInRegistries').BLOCK; } catch (e) { SP_MEM.blockReg = null; }
  return SP_MEM.blockReg;
}

// 方块 id 字符串（'minecraft:lava'）；取不到返回 ''
function spBlockId(state) {
  if (state == null) return '';
  var b = null;
  try { b = state.getBlock(); } catch (e1) { return ''; }
  if (b == null) return '';
  try {
    var reg = spBlockRegistry();
    if (reg != null && typeof reg.getKey === 'function') {
      var rl = reg.getKey(b);
      if (rl != null) return String(rl);
    }
  } catch (e2) { }
  try { if (b.id != null) return String(b.id); } catch (e3) { }
  return '';
}

function spHeightType() {
  if (SP_MEM.heightType != null) return SP_MEM.heightType;
  try {
    var T = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap$Types');
    if (T != null && T.WORLD_SURFACE != null) { SP_MEM.heightType = T.WORLD_SURFACE; return SP_MEM.heightType; }
  } catch (e1) { }
  try {
    var H = Java.loadClass('net.minecraft.world.level.levelgen.Heightmap');
    if (H != null && H.Types != null && H.Types.WORLD_SURFACE != null) { SP_MEM.heightType = H.Types.WORLD_SURFACE; return SP_MEM.heightType; }
  } catch (e2) { }
  return null;
}

function spIsLiquid(state) {
  if (state == null) return false;
  try { return state.getFluidState().isEmpty() !== true; } catch (e) { return false; }
}
function spIsAir(state) {
  if (state == null) return false;
  try { return state.isAir() === true; } catch (e) { return false; }
}
function spIsOpenSpace(state, cfg) {
  if (state == null) return false;
  if (spIsAir(state)) return true;
  var id = spBlockId(state);
  return (id !== '') && spListHas(cfg.passableBlocks, id);
}
function spIsSafeGround(state, cfg) {
  if (state == null) return false;
  var id = spBlockId(state);
  if (id === '') return false;
  if (spListHas(cfg.hazardBlocks, id)) return false;
  if (spIsLiquid(state)) return cfg.allowFluidGround === true;
  if (spIsAir(state)) return false;   // 悬空：下方没东西
  return true;
}

function spDimKey(level) {
  try {
    var d = level.dimension();
    if (d != null) {
      var loc = d.location();
      if (loc != null) return String(loc);
    }
  } catch (e1) { }
  try { var d2 = level.dimension(); if (d2 != null) return String(d2); } catch (e2) { }
  return '?';
}
function spChunkKey(level, cx, cz) {
  // 注意：数据根 spawn 域是全局的（不按维度分表），所以键里必须带维度
  return spDimKey(level) + '@' + cx + ',' + cz;
}
function spMinY(level) {
  try { return Math.floor(spNum(level.getMinY(), 0)); } catch (e) { return 0; }
}
function spIsChunkLoaded(level, cx, cz) {
  var p = spBlockPos(cx * 16 + 8, spMinY(level) + 1, cz * 16 + 8);
  if (p == null) return false;   // 判定不了就按「未加载」跳过，绝不去 level.getChunk 触发加载
  try { return level.isLoaded(p) === true; } catch (e) { return false; }
}

// ============================================================================
// 1. 数据域：global.WAR.data.state.spawn（唯一可写副本在 00_core，本域只经 mutate 写）
// ============================================================================

var SP_NUM_KEYS = [
  ['minRadius', 0, 100000], ['maxRadius', 64, 100000], ['tries', 1, 4096],
  ['maxMillis', 5, 10000], ['minScored', 1, 9], ['usedScale', 1, 1000],
  ['cooldownMs', 0, 604800000], ['maxRolls', 0, 1000], ['protectionMs', 0, 86400000],
  ['logLimit', 1, 5000], ['rngSeed', 0, 2147483647], ['sampleGrid', 2, 8],
  ['maxSlope', 1, 16], ['rankRadiusMax', 1, 32]
];

function spCopyRings(list) {
  var out = [];
  if (list == null || !(list instanceof Array)) list = SP_CONFIG.rings;
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (r == null) continue;
    var rMin = spClampNum(r.rMin, 0, 1, 0);
    var rMax = spClampNum(r.rMax, 0, 1, 1);
    if (rMax <= rMin) continue;
    out.push({ rMin: rMin, rMax: rMax, weight: spClampNum(r.weight, 0.0001, 1000, 1) });
  }
  if (out.length === 0) out.push({ rMin: 0.55, rMax: 1.0, weight: 1 });
  return out;
}

function spDefaultConfig() {
  var c = {
    centerX: null, centerZ: null,
    mode: 'cm-score',
    minRadius: SP_CONFIG.minRadius,
    maxRadius: SP_FALLBACK.maxRadius,   // 仅 core 缺键时的保底；正常路径由下方 core 段覆盖
    tries: SP_FALLBACK.tries,           // 同上
    maxMillis: SP_CONFIG.maxMillis,
    minScored: SP_CONFIG.minScored,
    weights: { d: SP_CONFIG.weights.d, a: SP_CONFIG.weights.a, used: SP_CONFIG.weights.used },
    usedScale: SP_CONFIG.usedScale,
    earlyExitScore: SP_CONFIG.earlyExitScore,
    cooldownMs: SP_CONFIG.cooldownMs,
    maxRolls: SP_CONFIG.maxRolls,
    protectionMs: SP_CONFIG.protectionMs,
    logLimit: SP_CONFIG.logLimit,
    rngSeed: SP_CONFIG.rngSeed,
    sampleGrid: SP_CONFIG.sampleGrid,
    maxSlope: SP_CONFIG.maxSlope,
    allowFluidGround: SP_CONFIG.allowFluidGround,
    dMax: SP_D_MAX_FALLBACK,        // 硬门：破坏程度上限（暂定，标定流程见文件顶部）
    coverMin: SP_COVER_MIN_FALLBACK, // 硬门前置：3×3 fresh 覆盖度门槛（暂定，用 dcalib 标定）
    rankRadiusMax: SP_CONFIG.rankRadiusMax,
    rings: spCopyRings(SP_CONFIG.rings)
  };
  // maxRadius / tries 的唯一真值源 = 00_core 的 WAR_CONFIG.spawn。
  // 缺键不是「用默认值继续跑」，而是明确警告一次再退保底（静默回落最难排查）。
  try {
    var core = (global.WAR != null) ? global.WAR.config.spawn : null;
    if (core != null && core.candidateRadius != null) {
      c.maxRadius = global.WAR.clampInt(core.candidateRadius, 64, 100000, c.maxRadius);
    } else {
      warWarnOnce('spawn-cfg-maxradius', '00_core 的 WAR_CONFIG.spawn.candidateRadius 缺失：环带外半径回落到 ' + c.maxRadius + ' 格（请查 00_core.js，勿静默依赖保底值）');
    }
    if (core != null && core.tries != null) {
      c.tries = global.WAR.clampInt(core.tries, 1, 4096, c.tries);
    } else {
      warWarnOnce('spawn-cfg-tries', '00_core 的 WAR_CONFIG.spawn.tries 缺失：候选上限回落到 ' + c.tries + '（请查 00_core.js，勿静默依赖保底值）');
    }
    if (core != null && core.dMax != null) {
      c.dMax = spClampNum(core.dMax, 0, 1, c.dMax);
    } else {
      warWarnOnce('spawn-cfg-dmax', '00_core 的 WAR_CONFIG.spawn.dMax 缺失：出生点破坏度硬门回落到 ' + c.dMax + '（暂定值，需按 20_spawn.js 顶部「标定流程」实机标定）');
    }
    if (core != null && core.coverMin != null) {
      c.coverMin = global.WAR.clampInt(core.coverMin, 1, 9, c.coverMin);
    } else {
      warWarnOnce('spawn-cfg-covermin', '00_core 的 WAR_CONFIG.spawn.coverMin 缺失：出生点覆盖度门槛回落到 ' + c.coverMin + '/9（暂定值，需按 20_spawn.js 顶部「标定流程」用 dcalib 标定）');
    }
    if (core != null && core.mode != null) c.mode = String(core.mode);
  } catch (e) { }
  return c;
}

function spNormConfig(prev) {
  var d = spDefaultConfig();
  var src = (prev == null || typeof prev !== 'object') ? {} : prev;
  var out = {};
  out.centerX = (src.centerX == null) ? null : Math.floor(spNum(src.centerX, 0));
  out.centerZ = (src.centerZ == null) ? null : Math.floor(spNum(src.centerZ, 0));
  out.mode = (src.mode == null) ? d.mode : String(src.mode);
  for (var i = 0; i < SP_NUM_KEYS.length; i++) {
    var k = SP_NUM_KEYS[i][0];
    out[k] = global.WAR.clampInt(src[k], SP_NUM_KEYS[i][1], SP_NUM_KEYS[i][2], d[k]);
  }
  if (out.maxRadius < out.minRadius + 16) out.maxRadius = out.minRadius + 16;
  if (out.weights == null || typeof out.weights !== 'object') out.weights = d.weights;
  out.weights = {
    d: spClampNum(out.weights.d, 0, 100, d.weights.d),
    a: spClampNum(out.weights.a, 0, 100, d.weights.a),
    used: spClampNum(out.weights.used, 0, 100, d.weights.used)
  };
  out.earlyExitScore = spClampNum(src.earlyExitScore, 0, 1, d.earlyExitScore);
  out.allowFluidGround = (src.allowFluidGround === true);
  out.rings = spCopyRings(src.rings);
  out.dMax = spClampNum(src.dMax, 0, 1, d.dMax);
  out.coverMin = global.WAR.clampInt(src.coverMin, 1, 9, d.coverMin);
  return out;
}

// 就地补齐默认字段（防呆：外部改坏 JSON 也能跑）
function spEnsure(sp) {
  if (sp == null || typeof sp !== 'object') sp = {};
  try { if (sp.__stub === true) delete sp.__stub; } catch (e0) { }
  try { if (sp.__note != null) delete sp.__note; } catch (e1) { }
  sp.__owner = SP_OWNER;
  if (sp.version == null) sp.version = SP_VERSION;
  sp.config = spNormConfig(sp.config);
  if (sp.log == null || typeof sp.log !== 'object') sp.log = {};
  if (sp.used == null || typeof sp.used !== 'object') sp.used = {};
  if (sp.banned == null || typeof sp.banned !== 'object') sp.banned = {};
  if (sp.stats == null || typeof sp.stats !== 'object') sp.stats = {};
  if (typeof sp.stats.rolls !== 'number') sp.stats.rolls = 0;
  if (typeof sp.stats.placed !== 'number') sp.stats.placed = 0;
  if (typeof sp.stats.denied !== 'number') sp.stats.denied = 0;
  if (typeof sp.stats.lastRollAt !== 'number') sp.stats.lastRollAt = 0;
  return sp;
}

function spState() {
  try { return global.WAR.data.state; } catch (e) { return null; }
}

// 只读视图：拿不到数据根时返回一个临时域对象（命令仍能给出可解释的回应，而不是抛异常）
function spRoot() {
  var st = spState();
  if (st == null || typeof st !== 'object') return spEnsure({});
  return spEnsure(st.spawn);
}

function spConfig() { return spNormConfig(spRoot().config); }

// 所有写操作都经 00_core 的 mutate（出错不落盘、不标脏）
function spMutate(label, fn) {
  try {
    if (global.WAR == null || global.WAR.data == null || typeof global.WAR.data.mutate !== 'function') {
      return { ok: false, error: '数据根不可用' };
    }
    return global.WAR.data.mutate('spawn.' + label, function (st) { return fn(spEnsure(st.spawn)); });
  } catch (e) { return { ok: false, error: String(e) }; }
}

function spAudit(actor, action, target, result, detail) {
  try {
    if (global.WAR != null && global.WAR.audit != null) global.WAR.audit.append(actor, action, target, result, detail);
  } catch (e) { }
}

// log 上限：按 lastAt 淘汰最旧的玩家条目
function spTrimLog(sp) {
  try {
    var limit = sp.config.logLimit;
    var keys = Object.keys(sp.log);
    if (keys.length <= limit) return 0;
    var arr = [];
    for (var i = 0; i < keys.length; i++) arr.push({ k: keys[i], t: spNum(sp.log[keys[i]].lastAt, 0) });
    arr.sort(function (a, b) { return a.t - b.t; });
    var drop = arr.length - limit;
    for (var j = 0; j < drop; j++) delete sp.log[arr[j].k];
    return drop;
  } catch (e) { return 0; }
}

// ============================================================================
// 2. 打分：只消费 CM 的 D/A，不复制 chunk_metrics 的任何判定逻辑
// ============================================================================
//
//   D̄/Ā  = 候选点所在区块 + 周围 8 区块（3×3）的算术均值，只计「非 stale」记录；
//           覆盖数 < cfg.minScored 视为「未扫描」，候选作废。
//   读数  = CM 扩展版走一次 CM.scoreArea(level,cx,cz,1)（不 analyze、不加载区块，
//           逐条带 status/stale）；旧版 CM 自动退化为 9 次 CM.getAt。
//           两条路径的聚合口径完全一致，返回值多带 how='batch'|'legacy' 便于观测。
//   used  = 该区块已被用作出生点的次数 / cfg.usedScale，截到 0..1（防热点）。
//   S     = ( wd·(1−D̄) + wa·(1−Ā) ) / (wd+wa)  −  wused·usedFrac
//
//   ⚠ 方案 §2 的 S 还含 −w4·基地距离 −w5·队伍聚集度 +w3·资源潜力。
//     这三项的数据源（基地/宣称、资源域）都还没实现；本域**不把它们按 0 参与加权**——
//     那样会人为拉低所有候选的分数、稀释 D/A 权重，且 0 值会被误读成「无惩罚」。
//     改为：只在已实现项之内归一，并把缺口暴露在 status/gaps() 里（见 SP_GAPS）。
//
// 读数入口：优先走 CM 的批量接口（扩展版），旧版 CM 自动退化为逐点读取。
// 两条路径返回同形状：{ ok, code, n, nul, stale, partial, readFail, mem, pd, how, dim, d?, a? }
//   code: 'ok' | 'CM_MISSING' | 'NOT_SCANNED' | 'CM_READ_FAIL'
function spChunkAvg(level, cx, cz, cfg) {
  var cm = spCm();
  if (cm == null) {
    return { ok: false, code: 'CM_MISSING', n: 0, nul: 0, stale: 0, partial: 0, readFail: 0, mem: 0, pd: '', how: 'none', dim: '' };
  }
  if (typeof cm.scoreArea === 'function') return spChunkAvgBatch(cm, level, cx, cz, cfg);
  return spChunkAvgLegacy(cm, level, cx, cz, cfg);
}

// 批量路径（CM.scoreArea）：一次读 3×3，不 analyze、不加载区块，且逐条带 status/stale
// ⇒ 能把「该区块还没扫过」（no-record）与「world data 读不出来」（read-fail）分开。
// 任何异常/畸形返回都退回逐点路径，绝不把失败当成功。
function spChunkAvgBatch(cm, level, cx, cz, cfg) {
  var area = null;
  try { area = cm.scoreArea(level, cx, cz, 1); } catch (e) { area = null; }
  if (area == null || area.ok !== true || area.candidates == null) {
    return spChunkAvgLegacy(cm, level, cx, cz, cfg);
  }
  var n = 0, nul = 0, stale = 0, partial = 0, readFail = 0, mem = 0, sumD = 0, sumA = 0, dim = '';
  var list = area.candidates;
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    if (m == null) continue;
    if (m.status === 'read-fail') { readFail++; nul++; continue; }
    if (m.status !== 'ok') { nul++; continue; }        // no-record：该区块还没扫过
    if (m.stale === true) { stale++; continue; }       // 过期记录不参与均值
    n++; sumD += spNum(m.d, 0); sumA += spNum(m.a, 0);
    if (m.partial === true) partial++;
    if (m.source === 'mem') mem++;
    if (dim === '' && m.dim != null) dim = String(m.dim);
  }
  var pd = (area.pd === 'fail') ? 'fail' : 'ok';
  if (n < cfg.minScored) {
    var code = (readFail > 0 || pd === 'fail') ? 'CM_READ_FAIL' : 'NOT_SCANNED';
    // 用 getStatus 复核一次中心区块，把「未扫描 / 读取失败」的原因问准
    if (code === 'NOT_SCANNED' && typeof cm.getStatus === 'function') {
      var s = null;
      try { s = cm.getStatus(level, cx, cz); } catch (e2) { s = null; }
      if (s != null && (s.status === 'read-fail' || s.pd === 'fail')) code = 'CM_READ_FAIL';
    }
    return { ok: false, code: code, n: n, nul: nul, stale: stale, partial: partial, readFail: readFail, mem: mem, pd: pd, how: 'batch', dim: dim };
  }
  return { ok: true, code: 'ok', n: n, d: sumD / n, a: sumA / n, nul: nul, stale: stale, partial: partial, readFail: readFail, mem: mem, pd: pd, how: 'batch', dim: dim };
}

// 逐点路径（旧版 CM；行为与本次改动前逐字一致：9 次 getAt，null 与 stale 都算「未扫描」）
function spChunkAvgLegacy(cm, level, cx, cz, cfg) {
  var n = 0, nul = 0, stale = 0, partial = 0, sumD = 0, sumA = 0, dim = '';
  for (var dx = -1; dx <= 1; dx++) {
    for (var dz = -1; dz <= 1; dz++) {
      var bx = (cx + dx) * 16 + 8, bz = (cz + dz) * 16 + 8;
      var m = null;
      try { m = cm.getAt(level, bx, bz); } catch (e) { m = null; }
      if (m == null) { nul++; continue; }
      if (m.stale === true) { stale++; continue; }
      n++; sumD += spNum(m.d, 0); sumA += spNum(m.a, 0);
      if (m.partial === true) partial++;
      if (dim === '' && m.dim != null) dim = String(m.dim);
    }
  }
  if (n < cfg.minScored) {
    return { ok: false, code: 'NOT_SCANNED', n: n, nul: nul, stale: stale, partial: partial, readFail: 0, mem: 0, pd: '', how: 'legacy', dim: dim };
  }
  return { ok: true, code: 'ok', n: n, d: sumD / n, a: sumA / n, nul: nul, stale: stale, partial: partial, readFail: 0, mem: 0, pd: '', how: 'legacy', dim: dim };
}

function spUsedFrac(root, key, cfg) {
  var c = warToInt(root.used[key], 0);
  if (c <= 0) return 0;
  return spClampNum(c / cfg.usedScale, 0, 1, 0);
}
function spScoreOf(avgD, avgA, usedFrac, cfg) {
  var wd = cfg.weights.d, wa = cfg.weights.a, wu = cfg.weights.used;
  var den = wd + wa;
  if (!(den > 0)) den = 1;
  return (wd * (1 - avgD) + wa * (1 - avgA)) / den - wu * usedFrac;
}

// ============================================================================
// 3. 地形：在候选区块里找一个安全落点（只在已加载区块内做，不触发加载/生成）
// ============================================================================

function spSlope(level, chunk, ht, lx, lz, y, minY) {
  var lo = y, hi = y, bad = 0;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      var nx = lx + dx, nz = lz + dz;
      if (nx < 0) nx = 0; if (nx > 15) nx = 15;
      if (nz < 0) nz = 0; if (nz > 15) nz = 15;
      var h = null;
      try { h = Math.floor(spNum(chunk.getHeight(ht, nx, nz), y)); } catch (e) { bad++; continue; }
      if (h <= minY + 1) { bad += 4; continue; }   // 邻格是虚空 ⇒ 视为危险
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  return (hi - lo) + bad;
}

function spPickSpot(level, cx, cz, rng, cfg) {
  var chunk = null;
  try { chunk = level.getChunk(cx, cz); } catch (e) { return { ok: false, code: 'CHUNK_READ_FAIL', detail: String(e) }; }
  if (chunk == null) return { ok: false, code: 'CHUNK_READ_FAIL' };
  var ht = spHeightType();
  if (ht == null) return { ok: false, code: 'NO_HEIGHTMAP' };
  var minY = spMinY(level);
  var grid = cfg.sampleGrid;
  var step = Math.max(1, Math.floor(16 / grid));
  var best = null;
  for (var gx = 0; gx < grid; gx++) {
    for (var gz = 0; gz < grid; gz++) {
      var lx = 2 + gx * step; if (lx > 15) lx = 15;
      var lz = 2 + gz * step; if (lz > 15) lz = 15;
      var wy = null;
      try { wy = Math.floor(spNum(chunk.getHeight(ht, lx, lz), minY - 1)); } catch (e2) { continue; }
      if (wy <= minY + 1) continue;                       // 虚空/未生成
      var ground = null, feet = null, head = null;
      try {
        ground = chunk.getBlockState(lx, wy - 1, lz);
        feet = chunk.getBlockState(lx, wy, lz);
        head = chunk.getBlockState(lx, wy + 1, lz);
      } catch (e3) { continue; }
      if (!spIsSafeGround(ground, cfg)) continue;
      if (!spIsOpenSpace(feet, cfg)) continue;
      if (!spIsOpenSpace(head, cfg)) continue;
      var slope = spSlope(level, chunk, ht, lx, lz, wy, minY);
      if (slope > cfg.maxSlope) continue;
      var cand = { x: cx * 16 + lx, y: wy, z: cz * 16 + lz, slope: slope, lx: lx, lz: lz, jitter: rng() };
      if (best == null || spBetterSpot(cand, best)) best = cand;
    }
  }
  if (best == null) return { ok: false, code: 'NO_SAFE_TERRAIN' };
  return { ok: true, code: 'ok', x: best.x, y: best.y, z: best.z, slope: best.slope, lx: best.lx, lz: best.lz };
}

function spBetterSpot(a, b) {
  if (a.slope !== b.slope) return a.slope < b.slope;   // 先要平
  return a.jitter > b.jitter;                          // 再按种子随机
}

// 环带采样：按权重挑一个环，在环内均匀取角度+半径
function spPickRingPos(rng, center, cfg) {
  var rings = cfg.rings, total = 0, i;
  for (i = 0; i < rings.length; i++) total += rings[i].weight;
  var pick = rng() * total, acc = 0, ring = rings[rings.length - 1];
  for (i = 0; i < rings.length; i++) {
    acc += rings[i].weight;
    if (pick <= acc) { ring = rings[i]; break; }
  }
  var rr = cfg.minRadius + (cfg.maxRadius - cfg.minRadius) * (ring.rMin + rng() * (ring.rMax - ring.rMin));
  var ang = rng() * Math.PI * 2;
  return { x: center.x + Math.round(Math.cos(ang) * rr), z: center.z + Math.round(Math.sin(ang) * rr), r: Math.round(rr) };
}

function spResolveCenter(level, cfg) {
  if (cfg.centerX != null && cfg.centerZ != null) {
    return { ok: true, x: cfg.centerX, z: cfg.centerZ, src: 'admin' };
  }
  // 未显式设中心 ⇒ 尝试世界出生点；两条 API 都失败则拒绝（不静默用 0,0）
  try {
    var sp = level.getSharedSpawnPos();
    if (sp != null) return { ok: true, x: Math.floor(spNum(sp.getX(), 0)), z: Math.floor(spNum(sp.getZ(), 0)), src: 'world-spawn' };
  } catch (e1) { }
  try {
    var ld = level.getLevelData();
    if (ld != null) {
      var sp2 = ld.getSpawnPos();
      if (sp2 != null) return { ok: true, x: Math.floor(spNum(sp2.getX(), 0)), z: Math.floor(spNum(sp2.getZ(), 0)), src: 'world-spawn' };
    }
  } catch (e2) { }
  return { ok: false, code: 'NO_CENTER', x: 0, z: 0, src: 'none' };
}

// ============================================================================
// 4. 传送 + 新手保护
// ============================================================================

function spPlayerPos(p) {
  var x = 0, z = 0;
  try { x = Math.floor(spNum(p.getX(), 0)); z = Math.floor(spNum(p.getZ(), 0)); return { x: x, z: z }; } catch (e1) { }
  try { return { x: Math.floor(spNum(p.x, 0)), z: Math.floor(spNum(p.z, 0)) }; } catch (e2) { }
  return null;
}

function spTeleport(player, level, spot, center) {
  var yaw = 0;
  try {
    var dx = center.x - spot.x, dz = center.z - spot.z;
    if (dx !== 0 || dz !== 0) yaw = Math.atan2(dz, dx) * 180 / Math.PI - 90;   // 面朝环带中心
  } catch (e0) { }
  try {
    player.teleportToLevel(level, spot.x + 0.5, spot.y, spot.z + 0.5, yaw, 0);
    return { ok: true, how: 'teleportToLevel' };
  } catch (e1) { }
  try {
    player.teleportTo(spot.x + 0.5, spot.y, spot.z + 0.5, yaw, 0);
    return { ok: true, how: 'teleportTo' };
  } catch (e2) { }
  try {
    if (player.teleportTo != null) { player.teleportTo(spot.x + 0.5, spot.y, spot.z + 0.5); return { ok: true, how: 'teleportTo3' }; }
  } catch (e3) { }
  return { ok: false, how: 'none' };
}

function spIsPlayerEntity(e) {
  if (e == null) return false;
  try { if (e.player === true) return true; } catch (e1) { }
  try { if (e instanceof java.lang.Object) { } } catch (e2) { }
  try { if (typeof e.isPlayer === 'function' && e.isPlayer() === true) return true; } catch (e3) { }
  try { if (e.type != null && String(e.type) === 'minecraft:player') return true; } catch (e4) { }
  return false;
}

function spAttackerOf(source) {
  // 先取「责任实体」（玩家射的箭 → 玩家），再退到直接实体
  try { var a = source.getEntity(); if (a != null && spIsPlayerEntity(a)) return a; } catch (e1) { }
  try { var b = source.getDirectEntity(); if (b != null && spIsPlayerEntity(b)) return b; } catch (e2) { }
  return null;
}

// 新手保护：保护窗口内，被**其他玩家**伤害时把伤害置 0。
// 不拦环境伤害（摔落/怪物/岩浆）：保护期是「防被围杀」手段（方案 §2），不是无敌挂。
// 注意：beforeHurt 包装的 LivingDamageEvent$Pre 不可 cancel（字节码实证）⇒ 只能 setDamage(0)。
function spOnBeforeHurt(event) {
  try {
    var victim = event.getEntity();
    var vid = warUuid(victim);
    if (vid === '') return;
    var log = spRoot().log;
    var rec = log[vid];
    if (rec == null) return;
    var until = spNum(rec.protectUntil, 0);
    if (!(until > warNow())) return;
    var attacker = spAttackerOf(event.getSource());
    if (attacker == null) return;                       // 环境伤害放行
    var aid = warUuid(attacker);
    if (aid !== '' && aid === vid) return;              // 自伤/自杀放行
    event.setDamage(0);
    var last = spNum(SP_MEM.msgAt[vid], 0);
    if (warNow() - last > 3000) {
      SP_MEM.msgAt[vid] = warNow();
      if (warTell != null) warTell(victim, '新手保护中（还剩 ' + Math.ceil((until - warNow()) / 1000) + ' 秒）：其他玩家的伤害被挡下。');
    }
  } catch (err) {
    warWarnOnce('spawn-hurt', '保护判定异常：' + err);
  }
}

// ============================================================================
// 5. 掷点主流程
// ============================================================================

function spDeny(code, message, detail, actor) {
  var res = { ok: false, code: code, message: message, detail: detail || {} };
  try {
    spMutate('deny', function (sp) { sp.stats.denied++; return true; });
    spAudit(actor || 'system', 'spawn.roll', '-', 'deny', code);
  } catch (e) { }
  return res;
}

function spRoll(player, opts) {
  opts = opts || {};
  var t0 = warNow();
  var actor = warName(player);
  var cm = spCm();
  if (cm == null) {
    return spDeny('CM_MISSING',
      '出生点打分不可用：chunk_metrics 未加载（global.CM 缺失），本命令拒绝掷点。' +
      '请管理员确认 kubejs/server_scripts/chunk_metrics/chunk_metrics.js 正常加载。', {}, actor);
  }
  var level = opts.level;
  if (level == null) { try { level = player.level; } catch (e0) { } }
  if (level == null) {
    return spDeny('NO_LEVEL', '取不到玩家所在维度（level），无法选点。', {}, actor);
  }
  var uid = opts.uuid;
  if (uid == null) uid = warUuid(player);
  var root = spRoot();
  var cfg = root.config;

  // —— 限流（方案 §2：可刷防刷）。OP 豁免（便于测试，且 OP 本可改配置）——
  var isOp = (opts.op === true);
  var rec = (uid !== '' && root.log[uid] != null) ? root.log[uid] : null;
  if (!isOp && rec != null) {
    var since = warNow() - spNum(rec.lastAt, 0);
    if (since < cfg.cooldownMs) {
      return spDeny('COOLDOWN', '掷点冷却中：还需 ' + Math.ceil((cfg.cooldownMs - since) / 1000) + ' 秒。', { since: since }, actor);
    }
    if (warToInt(rec.rolls, 0) >= cfg.maxRolls) {
      return spDeny('MAX_ROLLS', '你的掷点次数已用尽（' + warToInt(rec.rolls, 0) + '/' + cfg.maxRolls + '）。', {}, actor);
    }
  }

  // —— 中心 ——
  var center = spResolveCenter(level, cfg);
  if (!center.ok) {
    return spDeny('NO_CENTER',
      '尚不知道环带中心：请管理员先执行 /war spawn admin center [<x> <z>]（或站在中心点执行 /war spawn admin center）。', {}, actor);
  }

  // —— 候选采样 ——
  var seed = (cfg.rngSeed > 0) ? cfg.rngSeed : (warNow() & 0x7fffffff);
  var rng = spRngNew(seed);
  var stat = { banned: 0, notLoaded: 0, notScanned: 0, readFail: 0, noTerrain: 0, chunkErr: 0, noRecord: 0, stale: 0, budget: false, tried: 0, ok: null,
               passed: 0, artificial: 0, destroyed: 0, filtered: 0, readable: 0, coverage: 0 };
  for (var i = 0; i < cfg.tries; i++) {
    if (warNow() - t0 > cfg.maxMillis) { stat.budget = true; break; }
    stat.tried++;
    var pos = spPickRingPos(rng, center, cfg);
    var cx = Math.floor(pos.x / 16), cz = Math.floor(pos.z / 16);
    var key = spChunkKey(level, cx, cz);
    if (root.banned[key] != null) { stat.banned++; continue; }
    if (!spIsChunkLoaded(level, cx, cz)) { stat.notLoaded++; continue; }
    var avg = spChunkAvg(level, cx, cz, cfg);
    if (!avg.ok) {
      if (avg.code === 'CM_MISSING') return spDeny('CM_MISSING', 'chunk_metrics 在读取候选区块时不可用。', {}, actor);
      if (avg.code === 'CM_READ_FAIL') stat.readFail++;
      stat.notScanned++; stat.noRecord += avg.nul; stat.stale += avg.stale;
      continue;
    }
    // —— 覆盖度门槛（先于 a/d 硬门：覆盖不足时 a/d 不可信；假放行是最坏失效模式）——
    stat.readable++;
    if (avg.n < cfg.coverMin) { stat.coverage++; continue; }
    // —— 硬门（用户规格：人为化程度不为 0 不行；破坏程度较大不行）——
    // a 必须**恰好为 0**（不是「低」）：有任何被计入人工的建造物就出局；
    // d 必须 <= cfg.dMax（含等号）。两条都在**打分之前**，通过后再按原有排序打分。
    stat.passed++;
    // 两条独立判定（同一条候选可以同时命中两条 ⇒ 计数可重叠，filtered 才是「刷掉多少条」）
    var badA = !(avg.a === 0), badD = (avg.d > cfg.dMax);
    if (badA) stat.artificial++;
    if (badD) stat.destroyed++;
    if (badA || badD) { stat.filtered++; continue; }
    var usedFrac = spUsedFrac(root, key, cfg);
    var score = spScoreOf(avg.d, avg.a, usedFrac, cfg);
    var spot = spPickSpot(level, cx, cz, rng, cfg);
    if (!spot.ok) {
      if (spot.code === 'NO_SAFE_TERRAIN' || spot.code === 'CHUNK_READ_FAIL') stat.noTerrain++;
      else stat.chunkErr++;
      continue;
    }
    var cand = {
      cx: cx, cz: cz, key: key, x: spot.x, y: spot.y, z: spot.z, slope: spot.slope,
      score: score, d: avg.d, a: avg.a, cov: avg.n, partial: avg.partial, usedFrac: usedFrac,
      how: (avg.how === 'legacy' ? 'legacy' : 'batch'),
      dim: (avg.dim !== '' ? avg.dim : spDimKey(level)), radius: pos.r
    };
    if (stat.ok == null || cand.score > stat.ok.score) stat.ok = cand;
    if (cand.score >= cfg.earlyExitScore) break;    // 够好就收（省预算）
  }

  if (stat.ok == null) {
    var why = '候选 ' + stat.tried + ' 个全部作废：未加载 ' + stat.notLoaded +
              ' / 未扫描 ' + stat.notScanned + '（读到 null ' + stat.noRecord + '、过期 ' + stat.stale + '）' +
              ' / 地形不合格 ' + stat.noTerrain + ' / 其它 ' + stat.chunkErr +
              ' / 已屏蔽 ' + stat.banned + (stat.readFail > 0 ? (' / 其中读取失败 ' + stat.readFail) : '') +
              (stat.budget ? ' / 预算用尽' : '');
    // 失败原因全是「world data 读不出来」⇒ 报 CM_READ_FAIL：这不是「还没扫描」，
    // 让玩家/管理员拿到正确的下一步（查日志与存档，而不是去 /cm scan）。
    if (stat.readFail > 0 && stat.readFail === stat.notScanned) {
      return spDeny('CM_READ_FAIL',
        '出生点打分不可用：候选区块的 world data 读取失败 —— 这不是「还没扫描」。' + why +
        '。请管理员查服务端日志里的 [CM] 警告与存档完整性，修好后重试。', stat, actor);
    }
    var gateStat0 = spGateStat(stat, cfg);
    // 情况一：读得到，但**都没过覆盖度门槛** ⇒ SPAWN_COVERAGE（与「未扫描」是两件事：
    //   这里是「扫得不够密」，正确动作是继续扫或换中心，而不是「这里没有已扫描区块」）
    if (stat.readable > 0 && stat.passed === 0) {
      gateStat0.code = 'SPAWN_COVERAGE';
      SP_MEM.lastGate = gateStat0;
      return spDeny('SPAWN_COVERAGE',
        '候选区块读得到，但 3×3 **覆盖度都不够**（每块需要 ≥ ' + cfg.coverMin + '/9 条有效记录）：共 ' + stat.readable +
        ' 个候选全部覆盖不足（其中未扫描 ' + stat.notScanned + ' / 过期 ' + stat.stale + '）。' +
        '这不是「一块都没扫过」，而是**扫得还不够密**：请继续 /cm scan（或换中心点/扩大半径）后再试。',
        gateStat0, actor);
    }
    // 情况二：有候选过了覆盖度，但**全被 a/d 硬门刷掉** ⇒ 按命中组合给码
    if (stat.passed > 0 && stat.filtered === stat.passed) {
      var gateCode = (stat.destroyed === 0) ? 'SPAWN_ARTIFICIAL'
                   : ((stat.artificial === 0) ? 'SPAWN_DESTROYED' : 'SPAWN_ALL_FILTERED');
      var gateStat = spGateStat(stat, cfg);
      gateStat.code = gateCode;
      // 注：passed>0 时「没过硬门」与「通过覆盖度」的计数必然相等（未通过者都已计入 filtered），
      // 所以这里就是「混合原因」的唯一出口：文案按需追加 coverage 计数，不需要第三分支。
      SP_MEM.lastGate = gateStat;
      return spDeny(gateCode,
        '候选区块都读到了，但**全部没过出生点硬门**（这不是「还没扫描」）：共 ' + stat.passed + ' 个候选 / 刷掉 ' + stat.filtered +
        ' 个；其中 人为化(a>0) 命中 ' + stat.artificial + ' 个、破坏度(d>' + spFmtNum(cfg.dMax, 4) + ') 命中 ' + stat.destroyed +
        ' 个（同一条可同时命中两条）。' +
        (stat.coverage > 0 ? ('另外还有 ' + stat.coverage + ' 个候选是**覆盖不足**被刷掉（需 ≥ ' + cfg.coverMin + '/9）——两类原因要分开处理。') : '') +
        '下一步：换中心点或扩大扫描范围；或先 /war spawn admin dcalib 看真实 a/d 分布标定 dMax。',
        gateStat, actor);
    }
    return spDeny('NO_SCANNED_CANDIDATE',
      '没找到「已扫描且地形安全」的落点。' + why +
      '。请先扫描：/cm scan <半径>（或用 Chunky 预生成环带后再 /cm scan）。', stat, actor);
  }
  var best = stat.ok;
  var okGate = spGateStat(stat, cfg);
  okGate.code = 'ok';
  SP_MEM.lastGate = okGate;

  // —— 先记账（防刷计数/保护窗口），再传送 ——
  var now = warNow();
  var protectUntil = now + cfg.protectionMs;
  var mut = spMutate('roll', function (sp) {
    if (uid !== '') {
      var r = sp.log[uid];
      if (r == null || typeof r !== 'object') { r = {}; sp.log[uid] = r; }
      r.rolls = warToInt(r.rolls, 0) + 1;
      r.lastAt = now;
      r.lastX = best.x; r.lastY = best.y; r.lastZ = best.z;
      r.lastDim = best.dim;
      r.lastScore = Number(best.score.toFixed(4));
      r.lastSeed = seed;
      r.lastCode = 'ok';
      r.protectUntil = protectUntil;
    }
    sp.used[best.key] = warToInt(sp.used[best.key], 0) + 1;
    sp.stats.rolls = warToInt(sp.stats.rolls, 0) + 1;
    sp.stats.placed = warToInt(sp.stats.placed, 0) + 1;
    sp.stats.lastRollAt = now;
    spTrimLog(sp);
    return true;
  });
  if (!mut.ok) {
    // 存储写失败不阻止落地（玩家体验优先），但明确告知
    warWarnOnce('spawn-store', '出生点记录写入失败（内存数据仍在）：' + mut.error);
  }

  var tp = spTeleport(player, level, best, center);
  if (!tp.ok) {
    return spDeny('TELEPORT_FAIL', '落点已选定但传送失败（已计入掷点次数）。坐标：' + best.x + ', ' + best.y + ', ' + best.z, stat, actor);
  }

  var msg = '出生点：' + best.x + ', ' + best.y + ', ' + best.z +
            '（区块 ' + best.cx + ',' + best.cz + '，距中心 ' + best.radius + ' 格）' +
            '｜D̄=' + best.d.toFixed(3) + ' Ā=' + best.a.toFixed(3) + '（覆盖 ' + best.cov + '/9' +
            (best.partial > 0 ? '，含部分扫描 ' + best.partial : '') + '）' +
            '｜评分=' + best.score.toFixed(3) + '｜新手保护 ' + Math.round(cfg.protectionMs / 1000) + ' 秒';
  spAudit(actor, 'spawn.roll', best.key, 'ok', 'S=' + best.score.toFixed(4) + ' seed=' + seed + ' used=' + spNum(best.usedFrac, 0).toFixed(2));
  return {
    ok: true, code: 'ok', message: msg,
    x: best.x, y: best.y, z: best.z, cx: best.cx, cz: best.cz, dim: best.dim,
    score: best.score, d: best.d, a: best.a, coverage: best.cov, slope: best.slope,
    scoredVia: best.how,
    usedFrac: best.usedFrac, seed: seed, protectionMs: cfg.protectionMs, protectUntil: protectUntil,
    markedUsed: mut.ok === true, teleport: tp.how, note: mut.ok ? '' : ('记录写入失败：' + mut.error)
  };
}

// ============================================================================
// 6. 文本输出
// ============================================================================

function spCfgText(cfg) {
  var rings = [];
  for (var i = 0; i < cfg.rings.length; i++) rings.push(cfg.rings[i].rMin + '-' + cfg.rings[i].rMax + '×' + cfg.rings[i].weight);
  return '中心=' + (cfg.centerX == null ? ('世界出生点/未定') : (cfg.centerX + ',' + cfg.centerZ)) +
         '｜环带=' + cfg.minRadius + '..' + cfg.maxRadius + ' 格[' + rings.join(' ') + ']' +
         '｜权重 D̄' + cfg.weights.d + '/Ā' + cfg.weights.a + '/已用' + cfg.weights.used +
         '｜候选上限=' + cfg.tries + '｜预算=' + cfg.maxMillis + 'ms｜已扫描门槛=' + cfg.minScored + '/9' +
         '｜冷却=' + Math.round(cfg.cooldownMs / 1000) + 's｜次数上限=' + cfg.maxRolls +
         '｜保护=' + Math.round(cfg.protectionMs / 1000) + 's｜种子=' + (cfg.rngSeed > 0 ? cfg.rngSeed : '时间') +
         '｜采样=' + cfg.sampleGrid + '×' + cfg.sampleGrid + '｜最大高差=' + cfg.maxSlope +
         '｜硬门=覆盖度≥' + cfg.coverMin + '/9 且 a=0 且 d≤' + spFmtNum(cfg.dMax, 4) + '(暂定待标定)';
}

// —— dMax 标定与硬门统计（全部只读：不 analyze、不加载区块、不写 pd）——
function spFmtNum(v, dg) { return (v == null) ? '?' : Number(v).toFixed(dg == null ? 3 : dg); }

// 分位数（线性插值，输入必须是已升序排序的数组；空数组返回 null）
function spQuantile(sortedArr, q) {
  var n = sortedArr.length;
  if (n === 0) return null;
  if (n === 1) return sortedArr[0];
  var pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (pos - lo);
}

function spGateStat(stat, cfg) {
  return { tried: stat.tried, readable: stat.readable, coverage: stat.coverage, passed: stat.passed,
           filtered: stat.filtered, artificial: stat.artificial, destroyed: stat.destroyed,
           dMax: cfg.dMax, coverMin: cfg.coverMin };
}

// /war spawn admin dcalib [<半径区块>]：读**已有记录**给出 a/d 分布，用来标定 dMax。
// 结论口径（写死在文案里，避免「调参玄学」）：**d 的天然底噪 p75 决定阈值下限**。
function spDCalib(source, radiusArg) {
  var cm = spCm();
  if (cm == null) return ['chunk_metrics 未加载（global.CM 缺失），无法标定。'];
  if (typeof cm.rank !== 'function') return ['chunk_metrics 的 CM.rank 不可用，无法标定（标定需要读已扫描记录）。'];
  var lvl = null;
  try { lvl = source.getLevel(); } catch (e0) { }
  if (lvl == null) return ['取不到维度，无法标定。'];
  var cfg = spConfig();
  var c = spResolveCenter(lvl, cfg);
  if (!c.ok) return ['还不知道环带中心：先 /war spawn admin center（或站在中心执行）。'];
  var r = warToInt(radiusArg, 8);
  if (!(r > 0)) r = 8;
  if (r > SP_DCALIB_R_MAX) r = SP_DCALIB_R_MAX;
  var list = null;
  try {
    list = cm.rank(lvl, Math.floor(spNum(c.x, 0) / 16), Math.floor(spNum(c.z, 0) / 16), r, { wA: 1.0, wD: 0.0, limit: 8192 });
  } catch (e1) { return ['CM.rank 读取失败：' + e1]; }
  if (list == null || list.length === 0) {
    return ['半径 ' + r + ' 区块内没有任何已扫描记录 —— 先 /cm scan ' + r + '（或更大）再做标定。'];
  }
  var ds = [], as = [], fkeys = [], staleN = 0, unknownN = 0, zeroA = 0, n = 0;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e == null) continue;
    if (e.stale === true) { staleN++; continue; }
    if (e.d == null || e.a == null) { unknownN++; continue; }   // 未知不许当 0（口径硬约束）
    ds.push(Number(e.d)); as.push(Number(e.a)); n++;
    if (e.cx != null && e.cz != null) fkeys.push(Number(e.cx) + ',' + Number(e.cz));
    if (Number(e.a) === 0) zeroA++;
  }
  if (n === 0) {
    return ['半径 ' + r + ' 区块内有 ' + list.length + ' 条记录，但全部过期/未知（stale ' + staleN + '、未知 ' + unknownN + '）—— 先 /cm scan 重扫。'];
  }
  ds.sort(function (p, q) { return p - q; });
  as.sort(function (p, q) { return p - q; });
  var dMax = spNum(cfg.dMax, SP_D_MAX_FALLBACK);
  var p75 = spQuantile(ds, 0.75);
  var out = [];
  out.push('[dMax 标定] 半径 ' + r + ' 区块｜有效记录 ' + n + '（剔除过期 ' + staleN + (unknownN > 0 ? ('、未知 ' + unknownN) : '') + '）｜当前 dMax=' + spFmtNum(dMax, 4) + '（暂定）');
  out.push('a: min=' + spFmtNum(spQuantile(as, 0)) + ' p25=' + spFmtNum(spQuantile(as, 0.25)) + ' 中位=' + spFmtNum(spQuantile(as, 0.5)) +
           ' p75=' + spFmtNum(spQuantile(as, 0.75)) + ' max=' + spFmtNum(spQuantile(as, 1)) +
           '｜a===0 比例=' + Math.round(100 * zeroA / n) + '%（这个比例就是 a 硬门放行率）');
  out.push('d: min=' + spFmtNum(spQuantile(ds, 0)) + ' p25=' + spFmtNum(spQuantile(ds, 0.25)) + ' 中位=' + spFmtNum(spQuantile(ds, 0.5)) +
           ' p75=' + spFmtNum(spQuantile(ds, 0.75)) + ' max=' + spFmtNum(spQuantile(ds, 1)) + '（p75 即自然底噪）');
  // 3×3 覆盖度分布（标定 coverMin 用）：以每条 fresh 记录为中心，数它 3×3 邻域里有几条 fresh
  var fset = {};
  for (var fi = 0; fi < fkeys.length; fi++) fset[fkeys[fi]] = 1;
  var hist = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], atLeast = 0;
  for (var fj = 0; fj < fkeys.length; fj++) {
    var pr = fkeys[fj].split(','), qx = warToInt(pr[0], 0), qz = warToInt(pr[1], 0), cnt = 0;
    for (var dx2 = -1; dx2 <= 1; dx2++) {
      for (var dz2 = -1; dz2 <= 1; dz2++) if (fset[(qx + dx2) + ',' + (qz + dz2)] === 1) cnt++;
    }
    hist[cnt]++;
    if (cnt >= cfg.coverMin) atLeast++;
  }
  var htxt = [];
  for (var hi = 1; hi <= 9; hi++) htxt.push(hi + ':' + hist[hi]);
  out.push('3×3 覆盖度（fresh 条数:窗口数）' + htxt.join(' ') +
           '｜fresh ≥ coverMin(' + cfg.coverMin + ') 的窗口占比 = ' + Math.round(100 * atLeast / n) +
           '%（占比过低＝门槛偏严，会把没扫密的区域全判成覆盖不足）');
  out.push('结论：' + (p75 > dMax
    ? ('d 的底噪 p75=' + spFmtNum(p75, 4) + ' **高于**当前 dMax=' + spFmtNum(dMax, 4) + ' ⇒ 阈值低于自然底噪，出生点会几乎永远刷不出来；建议 dMax ≥ ' + spFmtNum(p75, 4) + '（再留余量），并写回 00_core 的 WAR_CONFIG.spawn.dMax。')
    : ('d 的底噪 p75=' + spFmtNum(p75, 4) + ' ≤ 当前 dMax=' + spFmtNum(dMax, 4) + ' ⇒ 阈值尚高于底噪；放行率由 a===0 比例（' + Math.round(100 * zeroA / n) + '%）决定。')));
  return out;
}

function spStatusLines(source) {
  var out = [];
  var cm = spCm();
  var root = spRoot();
  var cfg = root.config;
  out.push('[出生点] ' + spCfgText(cfg));
  // CM 侧
  if (cm == null) {
    out.push('CM=未加载（global.CM 缺失）⇒ /war spawn 会拒绝掷点（code=CM_MISSING）');
  } else {
    var lvl = null;
    try { lvl = source.getLevel(); } catch (e0) { }
    var parts = ['CM=v' + spNum(cm.version, '?') + ' rev=' + (typeof cm.rev === 'function' ? cm.rev() : '?') +
                 ' 队列=' + (typeof cm.queueSize === 'function' ? cm.queueSize() : '?') +
                 ' 读数=' + (typeof cm.scoreArea === 'function' ? '批量(scoreArea)' : '逐点(getAt)')];
    try { if (typeof cm.stats === 'function' && lvl != null) parts.push(String(cm.stats(lvl))); } catch (e1) { }
    out.push(parts.join('｜'));
    // rank 洞察：本中心附近「最原始」的已扫描区块（README:150 的负 wA 写法）
    try {
      if (typeof cm.rank === 'function' && lvl != null && maxRadiusOk(cfg)) {
        var ccx = Math.floor(spNum(spResolveCenter(lvl, cfg).x, 0) / 16);
        var ccz = Math.floor(spNum(spResolveCenter(lvl, cfg).z, 0) / 16);
        var rr = Math.max(1, Math.min(cfg.rankRadiusMax, Math.ceil(cfg.maxRadius / 16)));
        var top = cm.rank(lvl, ccx, ccz, rr, { wA: -0.5, wD: 1.0, limit: 3 });
        if (top != null && top.length > 0) {
          var seg = [];
          for (var i = 0; i < top.length; i++) {
            seg.push('(' + top[i].cx + ',' + top[i].cz + ') D=' + spNum(top[i].d, 0).toFixed(3) + ' A=' + spNum(top[i].a, 0).toFixed(3) + (top[i].stale ? '!stale' : ''));
          }
          out.push('最原始的已扫描区块（半径 ' + rr + ' 区块）：' + seg.join(' '));
        } else {
          out.push('最原始的已扫描区块：半径 ' + rr + ' 区块内一条记录都没有（先 /cm scan）');
        }
      }
    } catch (e2) { }
  }
  // 统计
  out.push('掷点统计：成功 ' + warToInt(root.stats.placed, 0) + ' / 拒绝 ' + warToInt(root.stats.denied, 0) +
           '｜已用区块 ' + warCountKeys(root.used) + '｜有记录的玩家 ' + warCountKeys(root.log) +
           '｜屏蔽区块 ' + warCountKeys(root.banned));
  // 硬门统计（上次掷点）：让玩家分清「没扫」与「扫了但都不合格」
  var lg = SP_MEM.lastGate;
  if (lg != null) {
    out.push('上次掷点硬门（先看覆盖度 ≥ ' + spNum(lg.coverMin, 0) + '/9，再看 a 必须为 0 且 d ≤ ' + spFmtNum(lg.dMax, 4) + '）：候选 ' + lg.tried +
             ' 个 / 读到 ' + spNum(lg.readable, 0) + ' / 覆盖不足 ' + spNum(lg.coverage, 0) + ' / 过门 ' + spNum(lg.passed, 0) +
             ' / 硬门刷掉 ' + spNum(lg.filtered, 0) +
             '｜人为化(a>0) 命中 ' + lg.artificial + '｜破坏度(d>阈值) 命中 ' + lg.destroyed + '（可重叠）' +
             (lg.code != null ? ('｜结果 ' + lg.code) : ''));
  } else {
    out.push('硬门（覆盖度 ≥ ' + cfg.coverMin + '/9，且 a 必须为 0、d ≤ ' + spFmtNum(cfg.dMax, 4) + '，暂定待标定）：还没有掷点记录 —— 掷一次点后这里会给出覆盖不足与两条命中的计数（用于区分「没扫」「扫得不密」「扫了但都不合格」）');
  }
  // 自己的保护剩余
  try {
    var p = source.getPlayer();
    if (p != null) {
      var uid = warUuid(p);
      var rec = (uid !== '') ? root.log[uid] : null;
      if (rec != null) {
        var left = Math.round((spNum(rec.protectUntil, 0) - warNow()) / 1000);
        out.push('你：掷点 ' + warToInt(rec.rolls, 0) + '/' + cfg.maxRolls +
                 '｜上次落点 ' + rec.lastX + ',' + rec.lastY + ',' + rec.lastZ +
                 '（S=' + spNum(rec.lastScore, 0) + ' seed=' + rec.lastSeed + '）' +
                 '｜保护' + (left > 0 ? ('剩余 ' + left + ' 秒') : '已结束'));
      } else {
        out.push('你：还没掷过点（/war spawn）');
      }
    }
  } catch (e3) { }
  return out;
}
function maxRadiusOk(cfg) { return cfg.maxRadius > 0; }

function spLastText(source) {
  try {
    var p = source.getPlayer();
    if (p == null) return '该命令需要玩家执行。';
    var uid = warUuid(p);
    var rec = spRoot().log[uid];
    if (rec == null) return '你还没有掷点记录。';
    var left = Math.round((spNum(rec.protectUntil, 0) - warNow()) / 1000);
    return '上次落点：' + rec.lastX + ', ' + rec.lastY + ', ' + rec.lastZ + '（' + spStr(rec.lastDim) + '）' +
           '｜S=' + spNum(rec.lastScore, 0) + '｜seed=' + rec.lastSeed +
           '｜掷点 ' + warToInt(rec.rolls, 0) + ' 次｜保护' + (left > 0 ? ('剩余 ' + left + ' 秒') : '已结束');
  } catch (e) { return '读取失败：' + e; }
}

function spGapsText() {
  var out = ['出生点域剩余接口缺口（' + SP_GAPS.length + ' 条；扩 CM 属 chunk_metrics.js 改动，需单独授权）：'];
  for (var i = 0; i < SP_GAPS.length; i++) out.push('(' + (i + 1) + ') ' + SP_GAPS[i]);
  out.push('已解决（2026-10-04 CM 扩展）：getStatus 区分「无记录/读取失败」、scoreArea 批量读 3×3、rank 的 order 与 skipStale —— 见 chunk_metrics/README.md §4.2。');
  return out;
}

// ============================================================================
// 7. admin 操作（OP 由 00_core 的 admin 谓词在命令层把关；域内再做一次自我校验）
// ============================================================================

function spSetCenter(source, x, z) {
  var mut = spMutate('center', function (sp) {
    sp.config.centerX = Math.floor(x);
    sp.config.centerZ = Math.floor(z);
    return true;
  });
  spAudit('cmd:' + global.WAR.actorName(source), 'spawn.admin.center', x + ',' + z, mut.ok ? 'ok' : 'fail');
  if (!mut.ok) return '保存失败（内存数据仍在）：' + mut.error;
  return '环带中心已设为 ' + Math.floor(x) + ', ' + Math.floor(z) + '（对全体玩家生效，已落盘待自动保存）';
}
function spSetRadius(source, r) {
  if (!(r > 0)) return '半径必须是正整数。';
  // 回显必须 == 落盘值：先归一化 → 钳位 → 再归一化，把「maxRadius ≥ minRadius + 16」的不变量
  // 当场写进配置，而不是等下次读取时才由 spNormConfig 抬高（否则会对玩家说错话：说 64、实际 80）。
  var mut = spMutate('radius', function (sp) {
    sp.config = spNormConfig(sp.config);
    sp.config.maxRadius = global.WAR.clampInt(r, 64, 100000, sp.config.maxRadius);
    sp.config = spNormConfig(sp.config);
    return sp.config.maxRadius;
  });
  spAudit('cmd:' + global.WAR.actorName(source), 'spawn.admin.radius', String(r), mut.ok ? 'ok' : 'fail');
  if (!mut.ok) return '保存失败：' + mut.error;
  if (mut.ret === r) return '环带外半径已设为 ' + mut.ret + ' 格。';
  return '环带外半径已设为 ' + mut.ret + ' 格（请求 ' + r + '，受半径下限 ' + spConfig().minRadius +
    ' 格与「外半径至少比内半径大 16 格」约束，已按 ' + mut.ret + ' 生效并写入存档）。';
}
// actor 取名统一走 00_core 的 WAR.actorName(source)（步骤 4b）。旧 warActor 已删除：
// 两处实现逐字相同，留着只会漂移；死代码（空壳 hasPermission 判断）随之消失。
// 注意：这里取的是「命令来源」的显示名（无玩家 => 'console'，审计里再前缀 'cmd:'）；
// 而 /war spawn 掷点路径记的是「动作执行者」本人（warName(player)），不是命令来源。

// ============================================================================
// 8. 域对象 + 命令节点注册（照 00_core 的命令工厂写法）
// ============================================================================

var SP_DOMAIN = {
  __owner: SP_OWNER,
  version: SP_VERSION,

  // 供 global.WAR.stubStatus() 消费；字段与 warStub().status() 同形 + 本域补充
  status: function () {
    var root = spRoot();
    return {
      domain: 'spawn', implemented: true, owner: SP_OWNER,
      cm: (spCm() != null),
      config: root.config,
      stats: root.stats,
      players: warCountKeys(root.log),
      usedChunks: warCountKeys(root.used),
      bannedChunks: warCountKeys(root.banned),
      hurts: SP_MEM.hurtReg,
      gaps: SP_GAPS.length
    };
  },

  roll: function (player, opts) { return spRoll(player, opts || {}); },
  text: function (source) { return spStatusLines(source); },
  gaps: function () { return SP_GAPS.slice(); },
  gapsText: function () { return spGapsText(); },
  last: function (source) { return spLastText(source); },

  center: function (source, x, z) { return spSetCenter(source, x, z); },
  radius: function (source, r) { return spSetRadius(source, r); },
  // 只读预览：某方块坐标所在区块的 D̄/Ā 与评分（给其它域/调试用）
  preview: function (level, blockX, blockZ) {
    var cfg = spConfig();
    var cx = Math.floor(blockX / 16), cz = Math.floor(blockZ / 16);
    var avg = spChunkAvg(level, cx, cz, cfg);
    if (!avg.ok) return { ok: false, code: avg.code, cx: cx, cz: cz, n: avg.n };
    var key = spChunkKey(level, cx, cz);
    var uf = spUsedFrac(spRoot(), key, cfg);
    return { ok: true, code: 'ok', cx: cx, cz: cz, n: avg.n, d: avg.d, a: avg.a, usedFrac: uf, score: spScoreOf(avg.d, avg.a, uf, cfg), banned: (spRoot().banned[key] != null) };
  }
};

// 命令节点工厂：00_core 在它自己的 commandRegistry 里统一 root.then(node)
// （脚本加载顺序 00_core.js → 20_spawn.js，工厂在事件触发前就已入列）
function spCommandNode(Commands, Arguments, event) {
  var SI = Arguments.INTEGER.create(event);
  // 整数参数读取走 00_core 的 WAR.intArg；dft 传 NaN ⇒ 与旧内联实现逐字一致，
  // 调用点的 isNaN 分支继续负责「必须是整数」的提示（绝不静默用默认值设坐标）。
  // ⚠ 第一个实参必须是 Arguments.INTEGER（ArgumentTypeWrapper，有 getResult），
  //   不能传 SI = Arguments.INTEGER.create(event) 的结果（ArgumentType，没有 getResult）
  //   —— 传错 warArgWrapper 会警告一次并回落 dft，命令就会永远报「必须是整数」。
  function iArg(ctx, name) {
    return global.WAR.intArg(Arguments.INTEGER, ctx, name, NaN);
  }
  var node = Commands.literal('spawn')
    .executes(function (ctx) { return spCmdRoll(ctx); })
    .then(Commands.literal('roll').executes(function (ctx) { return spCmdRoll(ctx); }))
    .then(Commands.literal('status').executes(function (ctx) {
      var lines = spStatusLines(ctx.source);
      for (var i = 0; i < lines.length; i++) warReply(ctx.source, lines[i]);
      return 1;
    }))
    .then(Commands.literal('last').executes(function (ctx) { return warReply(ctx.source, spLastText(ctx.source)); }))
    .then(Commands.literal('gaps').executes(function (ctx) {
      var lines = spGapsText();
      for (var i = 0; i < lines.length; i++) warReply(ctx.source, lines[i]);
      return 1;
    }));

  var admin = Commands.literal('admin')
    // OP 谓词走 00_core 的统一入口（level 缺省 = WAR_CONFIG.admin.commandPermissionLevel）
    .requires(global.WAR.opPredicate())
    .executes(function (ctx) { return warReply(ctx.source, '用法：/war spawn admin center [<x> <z>] | radius <n> | status'); })
    .then(Commands.literal('status').executes(function (ctx) {
      var lines = spStatusLines(ctx.source);
      for (var i = 0; i < lines.length; i++) warReply(ctx.source, lines[i]);
      return 1;
    }))
    .then(Commands.literal('center')
      .executes(function (ctx) {
        var p = null;
        try { p = ctx.source.getPlayer(); } catch (e1) { }
        if (p == null) return warReply(ctx.source, '控制台执行需要坐标：/war spawn admin center <x> <z>');
        var pos = spPlayerPos(p);
        if (pos == null) return warReply(ctx.source, '取不到你的坐标，请显式给坐标：/war spawn admin center <x> <z>');
        return warReply(ctx.source, spSetCenter(ctx.source, pos.x, pos.z));
      })
      .then(Commands.argument('x', SI).then(Commands.argument('z', SI).executes(function (ctx2) {
        var x = iArg(ctx2, 'x'), z = iArg(ctx2, 'z');
        if (isNaN(x) || isNaN(z)) return warReply(ctx2.source, '坐标必须是整数。');
        return warReply(ctx2.source, spSetCenter(ctx2.source, x, z));
      }))))
    .then(Commands.literal('radius')
      .then(Commands.argument('n', SI).executes(function (ctx) {
        var n = iArg(ctx, 'n');
        if (isNaN(n)) return warReply(ctx.source, '半径必须是整数。');
        return warReply(ctx.source, spSetRadius(ctx.source, n));
      })))
    // dMax 标定入口：读已有记录给 a/d 分布，不 analyze、不加载区块
    .then(Commands.literal('dcalib')
      .executes(function (ctx) {
        var lines = spDCalib(ctx.source, 8);
        for (var i = 0; i < lines.length; i++) warReply(ctx.source, lines[i]);
        return 1;
      })
      .then(Commands.argument('r', SI).executes(function (ctx) {
        var n = iArg(ctx, 'r');
        if (isNaN(n)) return warReply(ctx.source, '半径必须是整数。');
        var lines2 = spDCalib(ctx.source, n);
        for (var i2 = 0; i2 < lines2.length; i2++) warReply(ctx.source, lines2[i2]);
        return 1;
      })));
  node.then(admin);
  return node;
}

function spCmdRoll(ctx) {
  var player = null;
  try { player = ctx.source.getPlayer(); } catch (e1) { }
  if (player == null) {
    return warReply(ctx.source, '该命令需要玩家执行（控制台可用 /war spawn admin center|radius）。');
  }
  var level = null;
  try { level = ctx.source.getLevel(); } catch (e2) { }
  var op = false;
  try { op = warHasPermission(ctx.source, WAR_CONFIG.admin.commandPermissionLevel); } catch (e3) { }
  var res = spRoll(player, { level: level, op: op });
  return warReply(ctx.source, res.message);
}

// 伤害拦截注册（targeted 优先，失败退到不筛目标的注册；两者都在 handler 内自校验玩家身份）
try {
  EntityEvents.beforeHurt('minecraft:player', spOnBeforeHurt);
  SP_MEM.hurtReg = 'targeted';
} catch (e1) {
  try {
    EntityEvents.beforeHurt(spOnBeforeHurt);
    SP_MEM.hurtReg = 'untargeted';
  } catch (e2) {
    SP_MEM.hurtReg = 'none';
    warWarnOnce('spawn-hurt-reg', '新手保护的伤害拦截注册失败（保护窗口仍会记账，但伤害拦不住）：' + e2);
  }
}

// 域对象接管 00_core 预留的 spawn stub
try {
  if (global.WAR != null) {
    if (global.WAR.spawn != null && global.WAR.spawn.__stub === true) {
      warDebug('接管 spawn stub（' + SP_OWNER + '）');
    }
    global.WAR.spawn = SP_DOMAIN;
    global.WAR.commands.add(spCommandNode);
    global.WAR.commands.helpLine('/war spawn [roll|status|last|gaps]', '出生点：按 CM 的 D/A 选低破坏、低人工的已扫描落点 + 新手保护');
    global.WAR.commands.helpLine('/war spawn admin center [<x> <z>] | radius <n> | dcalib [<r>]', 'OP' + WAR_CONFIG.admin.commandPermissionLevel + '：设置环带中心/外半径；dcalib 读已扫描记录给 a/d 分布以标定 dMax');
    global.WAR.hooks.boot.push(function (server) {
      try {
        var sp = null;
        if (server != null && typeof server.overworld === 'function') sp = server.overworld();
        if (sp != null) {
          var c = spResolveCenter(sp, spConfig());
          if (c.ok) SP_MEM.bootDim = c.src + ':' + c.x + ',' + c.z;
        }
      } catch (e) { }
      warLog('出生点域就绪（' + SP_OWNER + ' v' + SP_VERSION + '）：' +
             (spCm() != null ? 'CM 可用' : 'CM 缺失（掷点将拒绝）') +
             '｜伤害拦截=' + SP_MEM.hurtReg + '｜help=/war spawn status');
    });
  } else {
    console.error('[spawn] global.WAR 不存在（00_core.js 未加载？）——20_spawn.js 未注册，命令不可用');
  }
} catch (e) {
  console.error('[spawn] 域注册失败：' + e);
}

warLog('20_spawn.js 已加载 v' + SP_VERSION + '（等待 ServerEvents.loaded / 命令注册）');
