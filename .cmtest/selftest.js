// 用假 Java 桥 + 合成世界驱动真实的 chunk_metrics.js，验证：确定性、量纲、排序、误判抑制、存储。
const path = require('path');
const CM_SCRIPT = '/home/lee/.local/share/PrismLauncher/instances/逃出生天-备份/minecraft/kubejs/server_scripts/chunk_metrics/chunk_metrics.js';

// ---------------- 假方块 / 假状态 ----------------
function mkState(block) {
  return {
    getBlock: function () { return block; },
    is: function (t) { return block.tags.has(t); },
    isAir: function () { return block.air === true; },
    getFluidState: function () { return { isEmpty: function () { return !block.fluid; } }; },
    hasBlockEntity: function () { return block.be === true; }
  };
}
function mkBlock(id, opts) {
  opts = opts || {};
  var b = { id: id, tags: new Set(opts.tags || []), fluid: !!opts.fluid, be: !!opts.be, air: !!opts.air };
  b.defaultBlockState = function () { return mkState(b); };
  return b;
}

var AIR = mkBlock('minecraft:air', { air: true });
var STONE = mkBlock('minecraft:stone', { tags: ['minecraft:base_stone_overworld', 'c:stones'] });
var DEEPSLATE = mkBlock('minecraft:deepslate', { tags: ['minecraft:base_stone_overworld', 'c:stones'] });
var GRASS = mkBlock('minecraft:grass_block', { tags: ['minecraft:dirt'] });
var WATER = mkBlock('minecraft:water', { fluid: true });
var IRON_ORE = mkBlock('minecraft:iron_ore', { tags: ['c:ores'] });
// 未打标签的“模组地形石”：默认会落到 MAN，应当被下游门槛挡住
var MODROCK = mkBlock('tellus:chalk_stone');
// 人工
var COBBLE = mkBlock('minecraft:cobblestone');
var PLANKS = mkBlock('minecraft:oak_planks');
var STAIRS = mkBlock('minecraft:oak_stairs');
var SLAB = mkBlock('minecraft:oak_slab');
var GLASS = mkBlock('minecraft:glass');
var BRICKS = mkBlock('minecraft:stone_bricks');
var DEEPBRICK = mkBlock('minecraft:deepslate_bricks');
var WALL = mkBlock('minecraft:cobblestone_wall');
var FENCE = mkBlock('minecraft:oak_fence');
var DOOR = mkBlock('minecraft:oak_door');
var CHEST = mkBlock('minecraft:chest', { be: true });
var FURNACE = mkBlock('minecraft:furnace', { be: true });
var TORCH = mkBlock('minecraft:torch');
var RAIL = mkBlock('minecraft:rail');
var SPAWNER = mkBlock('minecraft:spawner', { be: true });

// ---------------- 假 CompoundTag ----------------
function FakeTag() { this.m = new Map(); }
FakeTag.prototype.contains = function (k) { return this.m.has(k); };
FakeTag.prototype.put = function (k, v) { this.m.set(k, v); return v; };
FakeTag.prototype.putInt = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.putDouble = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.putLong = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.putString = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.getInt = function (k) { return this.m.has(k) ? this.m.get(k) : 0; };
FakeTag.prototype.getDouble = function (k) { return this.m.has(k) ? Number(this.m.get(k)) : 0; };
FakeTag.prototype.getLong = function (k) { return this.m.has(k) ? Number(this.m.get(k)) : 0; };
FakeTag.prototype.getString = function (k) { return this.m.has(k) ? String(this.m.get(k)) : ''; };
FakeTag.prototype.getCompound = function (k) { var v = this.m.get(k); return (v instanceof FakeTag) ? v : new FakeTag(); };
FakeTag.prototype.getAllKeys = function () { return Array.from(this.m.keys()); };

// ---------------- 假 Java 桥 ----------------
function FakeBlockPos(x, y, z) { this.x = x; this.y = y; this.z = z; }
var CLASSES = {
  'net.minecraft.core.BlockPos': FakeBlockPos,
  'net.minecraft.tags.TagKey': { create: function (reg, rl) { return rl; } },
  'net.minecraft.core.registries.Registries': { BLOCK: 'BLOCK' },
  'net.minecraft.resources.ResourceLocation': { parse: function (s) { return s; } },
  'net.minecraft.world.level.levelgen.Heightmap$Types': { OCEAN_FLOOR: 'OCEAN_FLOOR' },
  'net.minecraft.nbt.CompoundTag': FakeTag,
  'net.minecraft.network.chat.Component': { literal: function (s) { return s; } },
  'net.minecraft.core.registries.BuiltInRegistries': { BLOCK: { getKey: function (b) { return b.id; } } }
};

global.Java = { loadClass: function (n) { if (!CLASSES[n]) throw new Error('no class ' + n); return CLASSES[n]; } };
global.ServerEvents = { loaded: function () { }, tick: function () { }, commandRegistry: function () { } };

// ---------------- 假区块 ----------------
var MIN_Y = -64, N_SEC = 24, CHUNK_H = N_SEC * 16;

function makeCellIndexer() { return function (x, y, z) { return ((y - MIN_Y) * 256) + (z * 16 + x); }; }

function buildChunk(scenario) {
  var idx = makeCellIndexer();
  var cells = new Array(CHUNK_H * 256);
  for (var i = 0; i < cells.length; i++) cells[i] = AIR;
  var SURF = 64;
  for (var z = 0; z < 16; z++) {
    for (var x = 0; x < 16; x++) {
      for (var y = MIN_Y; y <= SURF; y++) {
        var b = (y === SURF) ? GRASS : STONE;
        if (y < 40 && (y % 37) === 0) b = DEEPSLATE;
        cells[idx(x, y, z)] = b;
      }
      // 自然洞穴（确定性伪随机，约 1/5 列）
      if (((x * 7 + z * 13) % 5) !== 0) {
        for (var cy = 28; cy <= 31; cy++) cells[idx(x, cy, z)] = AIR;
      }
      // 天然矿脉
      if (((x * 11 + z * 5) % 7) === 0) cells[idx(x, 20, z)] = IRON_ORE;
    }
  }
  if (scenario) scenario(cells, idx);
  return buildFromCells(cells, idx);
}

function buildFromCells(cells, idx) {
  var sections = [];
  for (var s = 0; s < N_SEC; s++) {
    (function (s) {
      var y0 = MIN_Y + s * 16;
      var palette = new Map();
      var onlyAir = true;
      for (var ly = 0; ly < 16; ly++) {
        for (var z = 0; z < 16; z++) {
          for (var x = 0; x < 16; x++) {
            var b = cells[idx(x, y0 + ly, z)];
            if (!b.air) onlyAir = false;
            palette.set(b, (palette.get(b) || 0) + 1);
          }
        }
      }
      sections.push({
        hasOnlyAir: function () { return onlyAir; },
        getStates: function () {
          return {
            count: function (cb) { palette.forEach(function (n, b) { cb(b.defaultBlockState(), n); }); }
          };
        },
        getBlockState: function (x, ly, z) { return cells[idx(x, y0 + ly, z)].defaultBlockState(); },
        maybeHas: function (pred) {
          var hit = false;
          palette.forEach(function (n, b) { if (!hit && pred(b.defaultBlockState())) hit = true; });
          return hit;
        }
      });
    })(s);
  }
  var heights = new Int32Array(256);
  for (var z = 0; z < 16; z++) {
    for (var x = 0; x < 16; x++) {
      var top = MIN_Y - 1;
      for (var y = MIN_Y; y < MIN_Y + CHUNK_H; y++) if (!cells[idx(x, y, z)].air) top = y;
      heights[z * 16 + x] = top + 1;
    }
  }
  return {
    getSections: function () { return sections; },
    getHeight: function (type, x, z) { return heights[z * 16 + x]; },
    cells: cells, idx: idx
  };
}

// ---------------- 假 level ----------------
function makeLevel(chunkMap) {
  return {
    persistentData: new FakeTag(),
    getMinY: function () { return MIN_Y; },
    dimension: function () { return { location: function () { return 'minecraft:overworld'; } }; },
    isLoaded: function () { return false; },       // 邻区块未加载 => 走 refPartial 分支
    getChunk: function (cx, cz) {
      var c = chunkMap[cx + ',' + cz];
      if (!c) throw new Error('chunk not present: ' + cx + ',' + cz);
      return c;
    }
  };
}

// ---------------- 场景 ----------------
function scnUntouched() { }
function scnSpam(cells, idx) {                     // 8x8x8 实心同质鹅卵石大块
  for (var y = 65; y <= 72; y++) for (var z = 4; z <= 11; z++) for (var x = 4; x <= 11; x++) cells[idx(x, y, z)] = COBBLE;
}
function scnBase(cells, idx) {                     // 多样化、有形态、有机械的“基地”
  var shell = [PLANKS, BRICKS, GLASS, STAIRS, SLAB, WALL, FENCE, DOOR];
  for (var y = 65; y <= 74; y++) {
    for (var z = 2; z <= 13; z++) {
      for (var x = 2; x <= 13; x++) {
        var edge = (x === 2 || x === 13 || z === 2 || z === 13);
        var roof = (y === 74);
        if (!edge && !roof) continue;             // 中空 => 填充率低
        var b = shell[((x * 3 + z * 5 + y * 7) % shell.length)];
        cells[idx(x, y, z)] = b;
      }
    }
  }
  cells[idx(7, 65, 7)] = CHEST;
  cells[idx(8, 65, 7)] = FURNACE;
  cells[idx(6, 65, 7)] = CHEST;
}
function scnMine(cells, idx) {                     // 16 格长的矿道 + 火把 + 铁轨
  for (var y = 20; y <= 23; y++) for (var z = 1; z <= 14; z++) for (var x = 6; x <= 9; x++) cells[idx(x, y, z)] = AIR;
  for (var z2 = 1; z2 <= 14; z2 += 3) cells[idx(6, 21, z2)] = TORCH;
  for (var z3 = 1; z3 <= 14; z3++) cells[idx(7, 20, z3)] = RAIL;
}
function scnModRockChunk(cells, idx) {             // 整块未打标签的模组岩石：默认归 MAN，必须被门槛挡住
  for (var y = 30; y <= 64; y++) for (var z = 0; z < 16; z++) for (var x = 0; x < 16; x++) cells[idx(x, y, z)] = MODROCK;
}
function scnDungeon(cells, idx) {                  // 自然刷怪笼（有方块实体）：不应贡献人工程度
  cells[idx(8, 25, 8)] = SPAWNER;
  for (var y = 24; y <= 27; y++) for (var z = 6; z <= 10; z++) for (var x = 6; x <= 10; x++) cells[idx(x, y, z)] = (y === 24 || y === 27) ? COBBLE : AIR;
}
function scnBuried(cells, idx) {                    // 1x1x10 混合材质基础桩：四面被岩层包裹
  var types = [BRICKS, DEEPBRICK, STAIRS, COBBLE, WALL];
  for (var y = 45; y <= 54; y++) cells[idx(7, y, 7)] = types[(y - 45) % types.length];
}

// ---------------- 驱动 ----------------
var chunks = {
  '0,0': buildChunk(scnUntouched),
  '1,0': buildChunk(scnSpam),
  '2,0': buildChunk(scnBase),
  '3,0': buildChunk(scnMine),
  '4,0': buildChunk(scnModRockChunk),
  '5,0': buildChunk(scnDungeon),
  '6,0': buildChunk(scnBuried)
};
var level = makeLevel(chunks);
require(CM_SCRIPT);
var CM = global.CM;
CM.config.debug = false;

function show(name, cx) {
  var m = CM.analyze(level, cx, 0);
  console.log(name.padEnd(22) + ' D=' + m.d.toFixed(4) + '  A=' + m.a.toFixed(4) +
    '  | B1..B5=' + [m.raw.B1, m.raw.B2, m.raw.B3, m.raw.B4, m.raw.B5].map(function (v) { return v.toFixed(3); }).join(',') +
    '  C1..C5=' + [m.raw.C1, m.raw.C2, m.raw.C3, m.raw.C4, m.raw.C5].map(function (v) { return v.toFixed(3); }).join(',') +
    '  manTotal=' + m.raw.manTotal + ' goodMass=' + m.raw.goodMass.toFixed(1) + ' comps=' + m.raw.manComponents +
    ' partial=' + m.partial + ' ' + m.ms + 'ms');
  return m;
}

console.log('--- 单区块指标 ---');
var untouched = show('untouched', 0);
var spam = show('spam(cobble cube)', 1);
var base = show('base(varied+BE)', 2);
var mine = show('mine(dug+torch)', 3);
var modrock = show('modrock(untagged)', 4);
var dungeon = show('dungeon(spawner)', 5);
var buried = show('buried(foundation)', 6);

console.log('--- 确定性 ---');
var a1 = CM.analyze(level, 2, 0), a2 = CM.analyze(level, 2, 0);
console.log('base 两次重算: d相等=' + (a1.d === a2.d) + ' a相等=' + (a1.a === a2.a));
console.log('全量重复一致=' + [0,1,2,3,4,5].every(function (cx) {
  var p = CM.analyze(level, cx, 0), q = CM.analyze(level, cx, 0);
  return p.d === q.d && p.a === q.a;
}));

console.log('--- 存储往返 ---');
CM.config.scan.onlyLoadedChunks = false;
var stored = CM.ensure(level, 2, 0);
var readBack = CM.get(level, 2, 0);
console.log('ensure→get: 命中=' + (readBack != null) + ' d一致=' + (readBack && readBack.d === stored.d) + ' a一致=' + (readBack && readBack.a === stored.a));

console.log('--- persistentData 抛异常时的内存兜底 ---');
var level2 = makeLevel(chunks);
level2.persistentData = { getCompound: function () { throw new Error('boom'); }, put: function () { throw new Error('boom'); } };
try {
  var e1 = CM.analyze(level2, 2, 0);
  console.log('analyze 仍可用: d=' + e1.d.toFixed(4));
} catch (e) { console.log('analyze 失败: ' + e); }
CM.config.scan.onlyLoadedChunks = false;
console.log('stats 不崩: ' + CM.stats(level2).slice(0, 40));

console.log('--- 标定后重扫必须清除 stale（回归：NBT 键 r 冲突） ---');
// 注意：CM_MEM 的键只有「维度 + 区块坐标」，不同 level 对象会共用同一缓存键；
// 必须用前面测试没碰过的坐标，否则 cmEnsure 会在内存缓存命中并提前返回、根本不落盘。
chunks['8,0'] = buildChunk(scnBase);
var lvRev = makeLevel(chunks);
CM.config.scan.onlyLoadedChunks = false;
CM.ensure(lvRev, 8, 0);                              // 落盘：记录版本号 = CM_REV(0)
var revTag = function () {
  return lvRev.persistentData.getCompound('chunk_metrics').getCompound('chunks').getCompound('8,0');
};
var diskRev0 = revTag().getInt('rev');               // 直接断言落盘 NBT：整数 rev 键
var stale0 = CM.get(lvRev, 8, 0).stale;
var calMsg = CM.calibrate(lvRev, 8, 0, 0);           // 标定：CM_REV++ => 1
var revAfterCalib = CM.rev();
var stale1 = CM.get(lvRev, 8, 0).stale;              // 标定后：旧记录应被标记 stale
CM.ensure(lvRev, 8, 0);                              // 重扫：写入新版本号
var diskRev1 = revTag().getInt('rev');
var rawOk = typeof CM.get(lvRev, 8, 0).raw.C1 === 'number';   // 分量明细仍应从 r 键读出
var stale2 = CM.get(lvRev, 8, 0).stale;              // 重扫后：不应再 stale
console.log('标定返回: ' + calMsg);
console.log('CM_REV=' + revAfterCalib + '  落盘rev: 首次=' + diskRev0 + ' 重扫后=' + diskRev1 +
            '  stale: 落盘=' + stale0 + ' 标定后=' + stale1 + ' 重扫后=' + stale2);
console.log('--- 断言 ---');
var ok = true;
function assert(cond, label) { if (!cond) { ok = false; console.log('FAIL: ' + label); } else { console.log('PASS: ' + label); } }
assert(untouched.a === 0, '未建造区块 A == 0');
assert(untouched.d < 0.05, '未建造区块 D 接近 0 (实际 ' + untouched.d.toFixed(4) + ')');
assert(spam.a < 0.10, '实心同质刷方块 A 很低 (实际 ' + spam.a.toFixed(4) + ')');
assert(base.a > spam.a + 0.15, '真实基地 A 显著高于刷方块 (' + base.a.toFixed(3) + ' vs ' + spam.a.toFixed(3) + ')');
assert(mine.d > untouched.d + 0.05, '矿道 D 显著高于未建造 (' + mine.d.toFixed(3) + ' vs ' + untouched.d.toFixed(3) + ')');
assert(modrock.a < 0.05, '未打标签模组岩石不误判为人工程度 (实际 ' + modrock.a.toFixed(4) + ')');
assert(dungeon.a < 0.05, '自然刷怪笼不贡献人工程度 (实际 ' + dungeon.a.toFixed(4) + ')');
assert(buried.raw.encased >= 8, '埋入岩层的人工材料被识别 (encased=' + buried.raw.encased + ')');
assert(buried.raw.B5 > 0.05, '埋入岩层产生回填分量 B5=' + buried.raw.B5.toFixed(3));
assert(buried.d > 0.005, '埋入岩层推高破坏程度 (D=' + buried.d.toFixed(4) + ')');
assert(base.raw.B5 < 0.30, '地面建筑不再被误算成地下回填 (B5=' + base.raw.B5.toFixed(3) + ')');
assert(base.d >= 0 && base.d <= 1 && base.a >= 0 && base.a <= 1, '取值落在 [0,1]');
assert(diskRev0 === 0, '落盘记录的版本号是独立整数键 rev=0');
assert(stale0 === false, '落盘记录初始不 stale');
assert(revAfterCalib === 1, '标定使自然表版本 +1 (CM_REV=' + revAfterCalib + ')');
assert(stale1 === true, '标定后旧记录被标记 stale');
assert(diskRev1 === 1, '重扫后落盘 rev=1（不再被分量明细覆盖）');
assert(rawOk === true, '分量明细仍可从 r 键读出');
assert(stale2 === false, '标定后重扫清除 stale（回归 NBT 键 r 冲突）');

// ============================================================================
// 新接口自检：CM.getStatus / CM.scoreArea / CM.rank 口径显式化（缺口 1/2/3/4）
// ============================================================================
console.log('--- 新接口：CM.getStatus ---');
var RAW_KEYS = ['B1','B2','B3','B4','B5','C1','C2','C3','C4','C5','subFrac','cutAvg','traceBelow','exposedOreEst','manTotal','goodMass','maxGood','machTotal','machTypes','manSections','manSpan','pavedCols','airTotal','fluidTotal','naturalTotal','encased','oreTotal','supportTotal','shapedManTotal','sections','minY'];
function seedRecord(chunksTag, cx, cz, d, a, rev) {
  var t = new FakeTag();
  t.putInt('v', 1); t.putInt('rev', rev); t.putDouble('d', d); t.putDouble('a', a);
  t.putLong('t', 1000); t.putInt('p', 0);
  var rw = new FakeTag();
  for (var i = 0; i < RAW_KEYS.length; i++) rw.putDouble(RAW_KEYS[i], i + 1);
  t.put('r', rw);
  chunksTag.put(cx + ',' + cz, t);
}
// 直接铺 NBT 记录（不经过 analyze）：既能精确控制 rev/stale，也保证「读接口不碰区块」
function seedLevel(cx0, cz0, w, h, rev) {
  var lv = makeLevel({});
  var loads = { n: 0 };
  lv.getChunk = function (a, b) { loads.n++; throw new Error('不应访问区块 ' + a + ',' + b); };
  lv.__loads = loads;
  var root = new FakeTag();
  root.putInt('v', 1);
  var ck = new FakeTag();
  for (var x = 0; x < w; x++) for (var z = 0; z < h; z++) seedRecord(ck, cx0 + x, cz0 + z, 0.10 + 0.01 * x, 0.20 + 0.01 * z, rev);
  root.put('chunks', ck);
  root.putInt('rev', rev);
  lv.persistentData.put('chunk_metrics', root);
  return lv;
}
function bumpRev(lv) {
  var root = lv.persistentData.getCompound('chunk_metrics');
  var cal = new FakeTag();
  cal.putInt('rev', CM.rev() + 1);
  cal.putString('natural', 'minecraft:stone');
  cal.putInt('chunks', 1);
  cal.putLong('t', 0);
  root.put('calib', cal);
  lv.persistentData.put('chunk_metrics', root);
  CM.reloadCalibration(lv);
}

var rev0 = CM.rev();
var lvA = seedLevel(500, 500, 2, 2, rev0);
var gs1 = CM.getStatus(lvA, 500, 500);
var gs2 = CM.getStatus(lvA, 999, 999);
var lvBad2 = makeLevel({});
lvBad2.persistentData = { getCompound: function () { throw new Error('boom'); }, put: function () { throw new Error('boom'); } };
var gs3 = CM.getStatus(lvBad2, 4242, 4242);
assert(gs1.ok === true && gs1.status === 'ok' && gs1.source === 'disk', 'getStatus：有记录 => ok / source=disk');
assert(gs1.stale === false && gs1.rev === rev0 && gs1.curRev === rev0, 'getStatus：带 stale=false 与 rev=curRev');
assert(typeof gs1.raw.C1 === 'number', 'getStatus：默认带 31 键分量明细（与 CM.get 对齐）');
assert(gs2.ok === true && gs2.status === 'no-record' && gs2.pd === 'ok', 'getStatus：无记录 => no-record（查询本身成功）');
assert(gs3.ok === false && gs3.status === 'read-fail' && gs3.pd === 'fail', 'getStatus：persistentData 抛错 => read-fail（查询失败）');

var lvB = seedLevel(600, 600, 1, 1, rev0);
bumpRev(lvB);
var gsStale = CM.getStatus(lvB, 600, 600);
assert(CM.rev() === rev0 + 1, '标定表版本 +1（CM_REV=' + CM.rev() + '）');
assert(gsStale.status === 'ok' && gsStale.stale === true && gsStale.rev === rev0 && gsStale.curRev === rev0 + 1,
  'getStatus：标定后旧记录 => stale=true 且 rev(curRev) 可区分');

console.log('--- 新接口：CM.scoreArea ---');
var revN = CM.rev();
var lvC = seedLevel(700, 700, 3, 3, revN);
var sa1 = CM.scoreArea(lvC, 701, 701, 1);   // 记录铺在 700..702 × 700..702，中心取 (701,701)
assert(sa1.ok === true && sa1.width === 3 && sa1.candidates.length === 9, 'scoreArea：3×3 => 9 个候选');
assert(sa1.counts.ok === 9 && sa1.counts.fresh === 9 && sa1.usable === 9, 'scoreArea：9 条全 fresh（usable=9）');
assert(Object.keys(sa1.candidates[0].raw).length === 0, 'scoreArea：默认 light（不读 31 键分量明细）');
var saRaw = CM.scoreArea(lvC, 700, 700, 0, { raw: true });
assert(Object.keys(saRaw.candidates[0].raw).length === RAW_KEYS.length, 'scoreArea：raw=true 时带分量明细（' + Object.keys(saRaw.candidates[0].raw).length + ' 键）');
var diff = 0, diffNone = 0;
for (var ci2 = 0; ci2 < sa1.candidates.length; ci2++) {
  var cc = sa1.candidates[ci2];
  var mm = CM.get(lvC, cc.cx, cc.cz);
  if (cc.status === 'ok') {
    if (!(mm != null && mm.d === cc.d && mm.a === cc.a && mm.stale === cc.stale)) diff++;
  } else if (cc.status === 'no-record') {
    if (mm !== null) diffNone++;                       // 标了无记录而单点却能读到 => 不一致
  }
}
assert(diff === 0, 'scoreArea 与逐点 CM.get 逐条一致（d/a/stale，9 条）');
assert(diffNone === 0, 'scoreArea：标 no-record 的候选在单点读取里确实是 null');
var lvD = seedLevel(800, 800, 1, 1, revN);
var sa2 = CM.scoreArea(lvD, 800, 800, 1);
assert(sa2.counts.ok === 1 && sa2.counts.noRecord === 8, 'scoreArea：有记录与无记录混在一起逐个标注（ok=1 / noRecord=8）');
var lvE = makeLevel({});
lvE.persistentData = { getCompound: function () { throw new Error('boom'); }, put: function () { throw new Error('boom'); } };
var sa3 = CM.scoreArea(lvE, 9000, 9000, 1);
assert(sa3.ok === true && sa3.pd === 'fail' && sa3.counts.readFail === 9, 'scoreArea：数据根读取失败 => pd=fail，9 条候选都标 read-fail');
var lvF = seedLevel(900, 900, 1, 2, revN - 1);
var sa4 = CM.scoreArea(lvF, 900, 900, 1);
var sa5 = CM.scoreArea(lvF, 900, 900, 1, { freshOnly: true });
assert(sa4.counts.ok === 2 && sa4.counts.stale === 2 && sa4.counts.fresh === 0 && sa4.candidates.length === 9, 'scoreArea：过期记录带 stale=true，不混进 usable');
assert(sa5.candidates.length === 0 && sa5.counts.stale === 2, 'scoreArea：freshOnly=true 时剔除 stale');
var saBig = CM.scoreArea(lvC, 700, 700, 9999);
assert(saBig.radius === CM.readAreaRadiusMax && saBig.width === CM.readAreaRadiusMax * 2 + 1, 'scoreArea：radius 超限被钳到 ' + CM.readAreaRadiusMax);
assert(lvA.__loads.n === 0 && lvC.__loads.n === 0 && lvD.__loads.n === 0, 'scoreArea 全程不访问区块（getChunk 调用数=0，不触发加载/生成）');

console.log('--- CM.rank 口径显式化 ---');
var revR = CM.rev();
var lvR = makeLevel({});
var ckR = new FakeTag();
seedRecord(ckR, 1000, 1000, 0.10, 0.90, revR);      // score = 0.85
seedRecord(ckR, 1001, 1000, 0.60, 0.10, revR);      // score = -0.20
seedRecord(ckR, 1002, 1000, 0.30, 0.30, revR);      // score = 0.15
seedRecord(ckR, 1003, 1000, 0.20, 0.05, revR - 1);  // score = -0.05（过期）
var rootR = new FakeTag(); rootR.putInt('v', 1); rootR.put('chunks', ckR); rootR.putInt('rev', revR);
lvR.persistentData.put('chunk_metrics', rootR);
var rDefault = CM.rank(lvR, 1001, 1000, 2, {});
var rAsc = CM.rank(lvR, 1001, 1000, 2, { order: 'asc' });
var rSkip = CM.rank(lvR, 1001, 1000, 2, { skipStale: true });
var rNeg = CM.rank(lvR, 1001, 1000, 2, { wA: -1.0, wD: -0.5 });
var rFilt = CM.rank(lvR, 1001, 1000, 2, { minA: 0.20 });
function cxSeq(arr) { return arr.map(function (m) { return m.cx; }).join(','); }
assert(cxSeq(rDefault) === '1000,1002,1003,1001', 'rank 默认（desc）保持旧行为：' + cxSeq(rDefault));
assert(cxSeq(rAsc) === '1001,1003,1002,1000', 'rank order=asc：最原始排前面：' + cxSeq(rAsc));
assert(rSkip.length === 3 && cxSeq(rSkip).indexOf('1003') < 0, 'rank skipStale=true：过期记录被排除（' + cxSeq(rSkip) + '）');
assert(cxSeq(rNeg) === cxSeq(rAsc), '旧「负权重」写法与 order=asc 等价（两个权重都取负）：' + cxSeq(rNeg));
assert(rFilt.length === 2, 'rank minA/maxD 过滤行为不变（minA=0.20 => ' + rFilt.length + ' 条）');

console.log('--- 批量 vs 单点：625 条记录的读取耗时（合成世界） ---');
var revBench = CM.rev();
var lvP = seedLevel(2000, 2000, 25, 25, revBench);
var PN = 625;
function bench(fn, reps) {
  var best = Infinity;
  for (var i = 0; i < reps; i++) {
    var t0 = performance.now();
    fn();
    var ms = performance.now() - t0;
    if (ms < best) best = ms;
  }
  return best;
}
var tLegacy = bench(function () {
  for (var x = 2000; x < 2025; x++) for (var z = 2000; z < 2025; z++) CM.getAt(lvP, x * 16 + 8, z * 16 + 8);
}, 3);
var tBatchRaw = bench(function () { CM.scoreArea(lvP, 2012, 2012, 12, { raw: true }); }, 3);
var tBatchLight = bench(function () { CM.scoreArea(lvP, 2012, 2012, 12); }, 3);
console.log('625 条记录：单点 getAt ×625      = ' + tLegacy.toFixed(2) + ' ms（' + (tLegacy * 1000 / PN).toFixed(1) + ' µs/条）');
console.log('            scoreArea(raw=true)  = ' + tBatchRaw.toFixed(2) + ' ms（' + (tBatchRaw * 1000 / PN).toFixed(1) + ' µs/条）  ← 只省「数据根遍历」');
console.log('            scoreArea(默认 light)= ' + tBatchLight.toFixed(2) + ' ms（' + (tBatchLight * 1000 / PN).toFixed(1) + ' µs/条）  ← 再省「31 键分量明细」');
console.log('加速比：单点 / 批量(light) = ' + (tLegacy / tBatchLight).toFixed(1) + '×（合成世界；实机收益主要来自 Java 边界调用次数）');
var legOne = CM.getAt(lvP, 2012 * 16 + 8, 2012 * 16 + 8);
var candOne = CM.scoreArea(lvP, 2012, 2012, 0).candidates[0];
assert(legOne.d === candOne.d && legOne.a === candOne.a && Object.keys(candOne.raw).length === 0, '批量结果与单点一致，且默认不带分量明细');
assert(tBatchLight < tLegacy, '批量（light）快于 625 次单点读取（' + tBatchLight.toFixed(2) + 'ms vs ' + tLegacy.toFixed(2) + 'ms）');
assert(tBatchRaw <= tLegacy, '即使带分量明细，批量也不慢于单点（只遍历一次数据根）');
assert(lvP.__loads.n === 0, '整轮测速没有访问任何区块数据');

console.log(ok ? 'ALL_PASS' : 'SOME_FAILED');
