// ============================================================================
// .wartest/spawn_selftest.js —— war/20_spawn.js（出生点域）离线自检
// ============================================================================
// 用法： cd <实例> && node .wartest/spawn_selftest.js
// 做法：仿 .wartest/selftest.js（00_core 的既有自检）——不启动游戏，用假 Java 桥
//   + vm.runInThisContext 按文件名顺序加载 war/*.js（复刻 KubeJS「同级 server 脚本
//   共享同一作用域」的语义），然后驱动**真实脚本**。
// 本文件独立，不改 .wartest/selftest.js（那是 00_core/10_team 的入口）。
//
// 假 CM 桥覆盖 task 要求的三类输入：
//   已扫描（正常记录） / 未扫描（null 或全 stale） / CM 缺失（global.CM = null）
//   —— 另加 getAt 抛异常、地形不合格、冷却/上限、非 OP 拒绝等边界。
// v2 追加：CM.scoreArea 批量路径 / 旧版 CM 逐点退化 / world data 读取失败（CM_READ_FAIL）
//   与「未扫描」的区分（含用 getStatus 复核原因的那条分支）。
//
// ⚠ 证据边界：本自检全部是离线证据（假 Java 桥）。真正只有实机能证的见文件末尾
//   「只能实机验证」清单（Java 方法名/签名、事件对象形态、传送与伤害事件的真实语义）。
// ============================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INST = '/home/lee/.local/share/PrismLauncher/instances/逃出生天-备份';
const WAR_DIR = path.join(INST, 'minecraft/kubejs/server_scripts/war');

// ---------------------------------------------------------------- 假 CompoundTag
function FakeTag() { this.m = new Map(); }
FakeTag.prototype.contains = function (k) { return this.m.has(k); };
FakeTag.prototype.put = function (k, v) { this.m.set(k, v); return v; };
FakeTag.prototype.putInt = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.putLong = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.putDouble = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.putString = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.putBoolean = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.getInt = function (k) { return this.m.has(k) ? Number(this.m.get(k)) : 0; };
FakeTag.prototype.getLong = function (k) { return this.m.has(k) ? Number(this.m.get(k)) : 0; };
FakeTag.prototype.getDouble = function (k) { return this.m.has(k) ? Number(this.m.get(k)) : 0; };
FakeTag.prototype.getString = function (k) { return this.m.has(k) ? String(this.m.get(k)) : ''; };
FakeTag.prototype.getBoolean = function (k) { return this.m.has(k) ? this.m.get(k) === true : false; };
FakeTag.prototype.getCompound = function (k) {
  var v = this.m.get(k);
  return (v instanceof FakeTag) ? v : new FakeTag();   // 与真机一致：缺失时返回游离空 tag
};
FakeTag.prototype.getAllKeys = function () { return Array.from(this.m.keys()); };
FakeTag.prototype.remove = function (k) { this.m.delete(k); };

// ---------------------------------------------------------------- 假方块/状态/区块/维度
// 地形模式：grass（安全）/ lava（危险地面）/ void（高度图<=minY）
var TERRAIN = 'grass';
var LOADED = true;

function FakeState(id, liquid) {
  this.id = String(id);
  this.liquid = (liquid === true);
}
FakeState.prototype.isAir = function () { return this.id === 'minecraft:air'; };
FakeState.prototype.getFluidState = function () {
  var lq = this.liquid;
  return { isEmpty: function () { return !lq; } };
};
FakeState.prototype.getBlock = function () { return { key: this.id }; };

function mkState(id) { return new FakeState(id, id === 'minecraft:lava' || id === 'minecraft:water'); }

function FakeChunk(cx, cz) { this.cx = cx; this.cz = cz; }
FakeChunk.prototype.getHeight = function (ht, lx, lz) {
  if (TERRAIN === 'void') return -64;                 // <= minY+1 ⇒ 候选作废
  return 64;
};
FakeChunk.prototype.getBlockState = function (lx, y, lz) {
  if (y === 63) return mkState(TERRAIN === 'lava' ? 'minecraft:lava' : 'minecraft:grass_block');
  if (y === 64 || y === 65) return mkState('minecraft:air');
  return mkState('minecraft:stone');
};

function FakeLevel() { }
FakeLevel.prototype.dimension = function () {
  return { location: function () { return 'minecraft:overworld'; } };
};
FakeLevel.prototype.getMinY = function () { return -64; };
FakeLevel.prototype.isLoaded = function (pos) { return LOADED === true; };
FakeLevel.prototype.getChunk = function (cx, cz) { return new FakeChunk(cx, cz); };
FakeLevel.prototype.getSharedSpawnPos = function () {
  return { getX: function () { return 0; }, getZ: function () { return 0; } };
};
FakeLevel.prototype.getLevelData = function () {
  return { getSpawnPos: function () { return null; } };
};

// ---------------------------------------------------------------- 假 Java 桥
var CLASSES = {
  'net.minecraft.nbt.CompoundTag': FakeTag,
  'net.minecraft.network.chat.Component': { literal: function (s) { return String(s); } },
  'net.minecraft.core.BlockPos': function (x, y, z) { this.x = x; this.y = y; this.z = z; },
  'net.minecraft.core.registries.BuiltInRegistries': {
    BLOCK: { getKey: function (b) { return (b != null && b.key != null) ? b.key : null; } }
  },
  'net.minecraft.world.level.levelgen.Heightmap$Types': { WORLD_SURFACE: 'WORLD_SURFACE' }
};
global.Java = { loadClass: function (n) { if (!CLASSES[n]) throw new Error('no class ' + n); return CLASSES[n]; } };
global.NBT = { compoundTag: function () { return new FakeTag(); }, listTag: function () { return []; } };
global.Text = {
  string: function (s) { return { text: String(s), toString: function () { return String(s); } }; },
  literal: function (s) { return global.Text.string(s); },
  gold: function (c) { return c; }, green: function (c) { return c; },
  red: function (c) { return c; }, yellow: function (c) { return c; }, gray: function (c) { return c; }
};

// ---------------------------------------------------------------- 假事件注册
var REG = { loaded: [], unloaded: [], tick: [], commandRegistry: [], beforeHurt: [] };
global.ServerEvents = {
  loaded: function (fn) { REG.loaded.push(fn); },
  unloaded: function (fn) { REG.unloaded.push(fn); },
  tick: function (fn) { REG.tick.push(fn); },
  commandRegistry: function (fn) { REG.commandRegistry.push(fn); },
  recipes: function () { }
};
// EntityEvents.beforeHurt 支持两种签名：beforeHurt(fn) 与 beforeHurt(target, fn)
global.EntityEvents = {
  beforeHurt: function (a, b) {
    if (typeof a === 'function') REG.beforeHurt.push({ target: null, fn: a });
    else REG.beforeHurt.push({ target: String(a), fn: b });
  },
  death: function () { }
};
global.PlayerEvents = { loggedIn: function () { }, loggedOut: function () { }, tick: function () { } };

// ---------------------------------------------------------------- 假 Brigadier
function FakeNode(kind, name) {
  this.kind = kind; this.name = name; this.children = []; this.executor = null;
  this.requires_ = null; this.argType = null;
}
FakeNode.prototype.requires = function (f) { this.requires_ = f; return this; };
FakeNode.prototype.executes = function (f) { this.executor = f; return this; };
FakeNode.prototype.then = function (b) { this.children.push(b); return this; };
var FakeCommands = {
  literal: function (n) { return new FakeNode('literal', n); },
  argument: function (n, t) { var x = new FakeNode('argument', n); x.argType = t; return x; }
};
var FakeArguments = {
  STRING: {
    create: function () { return { type: 'string' }; },
    getResult: function (ctx, n) { return String((ctx.args && ctx.args[n] !== undefined) ? ctx.args[n] : ''); }
  },
  INTEGER: {
    create: function () { return { type: 'integer' }; },
    getResult: function (ctx, n) {
      var v = (ctx.args && ctx.args[n] !== undefined) ? ctx.args[n] : '';
      if (String(v).length === 0) throw new Error('missing arg ' + n);
      return parseInt(String(v), 10);
    }
  },
  PLAYER: {
    create: function () { return { type: 'player' }; },
    getResult: function (ctx, n) { return (ctx.args && ctx.args[n] !== undefined) ? ctx.args[n] : null; }
  }
};

// ---------------------------------------------------------------- 假服务器 / 玩家 / 命令源
var fakeServer = null;
function FakeServer() { this.persistentData = new FakeTag(); this.cmds = []; }
FakeServer.prototype.runCommandSilent = function (c) { this.cmds.push(String(c)); return 1; };
FakeServer.prototype.runCommand = function (c) { this.cmds.push(String(c)); return 1; };
FakeServer.prototype.getPlayers = function () { return []; };
FakeServer.prototype.overworld = function () { return null; };

function FakePlayer(name, uuid) {
  this.username = name; this.uuid = uuid; this.persistentData = new FakeTag();
  this.messages = []; this.tps = []; this.player = true; this.level = null;
  this.x = 0; this.z = 0;
}
FakePlayer.prototype.getUUID = function () { return this.uuid; };
FakePlayer.prototype.getStringUUID = function () { return this.uuid; };
FakePlayer.prototype.getScoreboardName = function () { return this.username; };
FakePlayer.prototype.getName = function () { var n = this.username; return { getString: function () { return n; } }; };
FakePlayer.prototype.tell = function (c) { this.messages.push(String(c)); };
FakePlayer.prototype.isPlayer = function () { return true; };
FakePlayer.prototype.getType = function () { return 'minecraft:player'; };
FakePlayer.prototype.getX = function () { return this.x; };
FakePlayer.prototype.getZ = function () { return this.z; };
FakePlayer.prototype.teleportToLevel = function (lv, x, y, z, yaw, pitch) {
  this.tps.push({ how: 'teleportToLevel', x: x, y: y, z: z, yaw: yaw, pitch: pitch });
  return true;
};
FakePlayer.prototype.teleportTo = function (x, y, z, yaw, pitch) {
  this.tps.push({ how: 'teleportTo', x: x, y: y, z: z, yaw: yaw, pitch: pitch });
  return true;
};

function FakeSource(level, player) {
  this.lv = level >= 0 ? level : 0;
  this.pl = player || null;
  this.messages = []; this.failures = [];
  this.levelObj = new FakeLevel();
}
FakeSource.prototype.hasPermission = function (n) { return Number(this.lv) >= Number(n); };
FakeSource.prototype.getPlayer = function () { return this.pl; };
FakeSource.prototype.getServer = function () { return fakeServer; };
FakeSource.prototype.getLevel = function () { return this.levelObj; };
FakeSource.prototype.sendSystemMessage = function (c) { this.messages.push(String(c)); };
FakeSource.prototype.sendSuccess = function (sup) { this.messages.push(String(sup())); };
FakeSource.prototype.sendFailure = function (c) { this.failures.push(String(c)); };

// ---------------------------------------------------------------- 加载真实脚本
// 只加载本域自检需要的脚本，顺序 = 文件名顺序（复刻 KubeJS 的加载序）。
// 同目录其它域脚本（30_* 等，由别的 teammate 负责、可能随时在改）**刻意不加载**：
// 本 harness 只依赖 00_core 的框架契约 + 10_team 的队内免伤（T9 要按函数身份挑处理器）
// + 本域 20_spawn。—— 与 .wartest/selftest.js 的白名单做法一致。
var WANT = ['00_core.js', '10_team.js', '20_spawn.js'];
var files = fs.readdirSync(WAR_DIR).filter(function (f) { return /[.]js$/.test(f); }).sort();
var load = [];
for (var wi = 0; wi < WANT.length; wi++) {
  if (files.indexOf(WANT[wi]) >= 0) load.push(WANT[wi]);
  else console.log('[warn] war/ 里缺少 ' + WANT[wi]);
}
console.log('=== 加载 war/ 脚本：' + load.join(', ') + '（目录内共 ' + files.length + ' 个 js，其余不加载）');
for (var fi = 0; fi < load.length; fi++) {
  var src = fs.readFileSync(path.join(WAR_DIR, load[fi]), 'utf8');
  vm.runInThisContext(src, { filename: path.join(WAR_DIR, load[fi]) });
}
var WAR = global.WAR;

// ---------------------------------------------------------------- 断言工具
var passN = 0, failN = 0;
var fails = [];
function assert(cond, label) {
  if (cond) { passN++; console.log('  PASS  ' + label); }
  else { failN++; fails.push(label); console.log('  FAIL  ' + label); }
}
function near(a, b, eps) { return Math.abs(Number(a) - Number(b)) <= (eps == null ? 1e-6 : eps); }

// ---------------------------------------------------------------- 命令树工具
var registeredRoot = null;
function findChild(node, name) {
  if (node == null || node.children == null) return null;
  for (var i = 0; i < node.children.length; i++) if (node.children[i].name === name) return node.children[i];
  return null;
}
// 走命令路径，沿途检查 requires（brigadier 语义：谓词 false 则该节点不可达）
function runPath(names, source, args) {
  var cur = registeredRoot;
  for (var i = 0; i < names.length; i++) {
    if (cur.requires_ != null && cur.requires_(source) !== true) return { ok: false, denied: true, at: names[i] };
    var c = findChild(cur, names[i]);
    if (c == null) return { ok: false, missing: names[i] };
    cur = c;
  }
  if (cur.requires_ != null && cur.requires_(source) !== true) return { ok: false, denied: true, at: names[names.length - 1] };
  // 继续下钻 argument 子节点（brigadier：literal 后面挂的 x/z <arg>，args 里给了名字就进）
  var guard = 0;
  while (guard++ < 8) {
    var kids = cur.children || [];
    var nxt = null;
    for (var ci = 0; ci < kids.length; ci++) {
      if (kids[ci].kind === 'argument' && args != null && args[kids[ci].name] !== undefined) { nxt = kids[ci]; break; }
    }
    if (nxt == null) break;
    cur = nxt;
  }
  if (typeof cur.executor !== 'function') return { ok: false, noexec: true };
  return { ok: true, ret: cur.executor({ source: source, args: args || {} }) };
}

// ---------------------------------------------------------------- 假 CM 桥
function cmRec(d, a, stale, partial) {
  return { d: d, a: a, stale: stale === true, partial: partial === true, dim: 'minecraft:overworld', ts: Date.now() };
}
// 假 CM 桥：同时提供扩展版接口（scoreArea/getStatus）与旧版接口（getAt），
// 好分别驱动「批量路径」与「退化为逐点」两条代码路径。
//   _fn(bx,bz)  单点记录；返回 null = 该区块没有记录
//   _pd         'ok' | 'fail'，'fail' 模拟 level.persistentData 读取失败
//   _statusFn   可选，覆盖 getStatus 的返回值
var CM = {
  version: 1,
  nGetAt: 0, nRank: 0, nStats: 0, nScoreArea: 0, nGetStatus: 0,
  _fn: function (bx, bz) { return cmRec(0.1, 0.2, false, false); },
  _pd: 'ok',
  _statusFn: null,
  getAt: function (level, bx, bz) { this.nGetAt++; return this._fn(bx, bz); },
  scoreArea: function (level, cx, cz, radius) {
    this.nScoreArea++;
    var rr = (radius == null ? 0 : radius), cands = [];
    var counts = { ok: 0, fresh: 0, stale: 0, noRecord: 0, readFail: 0, mem: 0 };
    for (var x = cx - rr; x <= cx + rr; x++) {
      for (var z = cz - rr; z <= cz + rr; z++) {
        var rec;
        if (this._pd === 'fail') {
          rec = { cx: x, cz: z, status: 'read-fail', stale: false, source: 'none', d: null, a: null, rev: null };
          counts.readFail++;
        } else {
          var m = this._fn(x * 16 + 8, z * 16 + 8);
          if (m == null) {
            rec = { cx: x, cz: z, status: 'no-record', stale: false, source: 'none', d: null, a: null, rev: null };
            counts.noRecord++;
          } else {
            rec = { cx: x, cz: z, status: 'ok', stale: m.stale === true, source: 'disk',
                    d: m.d, a: m.a, partial: m.partial === true, dim: m.dim, rev: 3 };
            counts.ok++;
            if (rec.stale) counts.stale++; else counts.fresh++;
          }
        }
        cands.push(rec);
      }
    }
    return { ok: true, pd: this._pd, cx: cx, cz: cz, radius: rr, width: rr * 2 + 1, curRev: 3,
             candidates: cands, counts: counts, usable: counts.fresh };
  },
  getStatus: function (level, cx, cz) {
    this.nGetStatus++;
    if (typeof this._statusFn === 'function') return this._statusFn(cx, cz);
    if (this._pd === 'fail') return { ok: false, status: 'read-fail', pd: 'fail', cx: cx, cz: cz, stale: false, rev: null, curRev: 3 };
    return { ok: true, status: 'ok', pd: 'ok', cx: cx, cz: cz, stale: false, rev: 3, curRev: 3, d: 0.1, a: 0.2 };
  },
  get: function () { return null; },
  ensure: function () { return null; },
  rank: function () { this.nRank++; return []; },
  stats: function () { this.nStats++; return '已统计 12 区块 平均D=0.100 平均A=0.200 最大D=0.300 最大A=0.400 队列=0'; },
  rev: function () { return 3; },
  queueSize: function () { return 0; }
};

// ================================================================ 测试
console.log('\n=== war/20_spawn.js 出生点域自检 ===');

// ---- T1 域接管 / status / 命令树 ----
console.log('\n--- T1 域接管与命令树 ---');
assert(WAR != null, 'global.WAR 存在（00_core 已加载）');
assert(WAR.spawn != null && WAR.spawn.__stub !== true, 'WAR.spawn stub 已被 20_spawn.js 接管（非 stub）');
assert(WAR.spawn.__owner === '20_spawn.js', 'WAR.spawn.__owner = 20_spawn.js');
var st0 = null, stThrew = null;
try { st0 = WAR.spawn.status(); } catch (e) { stThrew = e; }
assert(stThrew == null, 'WAR.spawn.status() 不抛异常（stubStatus 会调用它）' + (stThrew ? ('：' + stThrew) : ''));
assert(st0 != null && st0.implemented === true && st0.domain === 'spawn', 'status(): implemented=true / domain=spawn');
assert(st0 != null && Array.isArray(st0.gaps) === false && st0.gaps === 3, 'status(): 剩余接口缺口计数 = 3');

assert(REG.commandRegistry.length >= 1, 'commandRegistry 处理器已注册');
REG.commandRegistry[0]({
  commands: FakeCommands, arguments: FakeArguments,
  register: function (n) { registeredRoot = n; }
});
assert(registeredRoot != null && registeredRoot.name === 'war', '/war 根节点已注册');
// 诊断：每个域节点工厂单独试构造（不改注册结果）
console.log('  [diag] registry 处理器 ' + REG.commandRegistry.length + ' 个；域节点工厂 ' + WAR.commands.nodes.length + ' 个');
for (var ni = 0; ni < WAR.commands.nodes.length; ni++) {
  try { WAR.commands.nodes[ni](FakeCommands, FakeArguments, { commands: FakeCommands, arguments: FakeArguments }); }
  catch (eN) { console.log('  [diag] 节点工厂 #' + ni + ' 抛错：' + eN + '\n' + String(eN.stack).split('\n').slice(0,4).join('\n')); }
}
var nodeSpawn = findChild(registeredRoot, 'spawn');
assert(nodeSpawn != null && typeof nodeSpawn.executor === 'function', '/war spawn 节点存在且可执行');
var subs = ['roll', 'status', 'last', 'gaps', 'admin'];
var missSub = [];
for (var si = 0; si < subs.length; si++) if (findChild(nodeSpawn, subs[si]) == null) missSub.push(subs[si]);
assert(missSub.length === 0, '/war spawn 子命令齐备 roll/status/last/gaps/admin' + (missSub.length ? ('（缺 ' + missSub.join(',') + '）') : ''));
var nodeAdmin = findChild(nodeSpawn, 'admin');
assert(nodeAdmin != null && nodeAdmin.requires_ != null, '/war spawn admin 带 OP 谓词（requires）');
var adminSubs = ['status', 'center', 'radius'];
var missA = [];
for (var ai = 0; ai < adminSubs.length; ai++) if (findChild(nodeAdmin, adminSubs[ai]) == null) missA.push(adminSubs[ai]);
assert(missA.length === 0, '/war spawn admin 子命令齐备 status/center/radius' + (missA.length ? ('（缺 ' + missA.join(',') + '）') : ''));
var helpHasSpawn = false;
for (var hp = 0; hp < WAR.commands.help.length; hp++) if (String(WAR.commands.help[hp].usage).indexOf('war spawn') >= 0) helpHasSpawn = true;
assert(helpHasSpawn, '/war help 收录了 /war spawn 条目');

// 启动（00_core 的 loaded 处理器）——之后 global.WAR.data.state 才存在
fakeServer = new FakeServer();
REG.loaded[0]({ server: fakeServer });
assert(WAR.ready === true, 'REG.loaded 后 WAR.ready = true（boot 钩子已跑）');
// 初始化数据域（spRoot 会在首次访问时就地补齐 spawn 域）
WAR.spawn.status();
var SPS = WAR.data.state.spawn;
assert(SPS != null && SPS.config != null && SPS.log != null && SPS.used != null && SPS.stats != null,
       '数据域已就位：config/log/used/stats');

// ---- T2 已扫描 → 正常掷点 ----
console.log('\n--- T2 已扫描：正常掷点（tries=1 / 固定种子 / 中心 0,0）---');
global.CM = CM;
CM._fn = function (bx, bz) { return cmRec(0.1, 0.2, false, false); };
SPS.config.tries = 1;
SPS.config.rngSeed = 12345;
SPS.config.maxRadius = 5000;
SPS.config.cooldownMs = 60000;
SPS.config.maxRolls = 5;
SPS.config.centerX = 0; SPS.config.centerZ = 0;
var lvl = new FakeLevel();
var alice = new FakePlayer('alice', 'uuid-a');
alice.level = lvl;
var before = CM.nGetAt;
var beforeSA = CM.nScoreArea;
var r2 = WAR.spawn.roll(alice, { level: lvl, op: true });
assert(r2 != null && r2.ok === true, '掷点成功（ok=true）' + (r2 && r2.message ? ('：' + r2.message) : ''));
assert(CM.nScoreArea - beforeSA === 1, '一次候选恰好 1 次 CM.scoreArea（批量读 3×3）：' + (CM.nScoreArea - beforeSA));
assert(CM.nGetAt - before === 0, '批量路径完全不调 CM.getAt（旧路径要 9 次）：' + (CM.nGetAt - before));
assert(r2.ok && r2.scoredVia === 'batch', '返回体标注读数路径 scoredVia=batch');
assert(r2.ok && near(r2.d, 0.1) && near(r2.a, 0.2), 'D̄=' + (r2.d) + ' Ā=' + (r2.a) + '（= 假 CM 的 0.1/0.2）');
assert(r2.ok && r2.coverage === 9, '覆盖率 9/9');
// S = (0.6·(1-0.1) + 1.0·(1-0.2)) / 1.6 - 0.35·0 = 1.34/1.6 = 0.8375
assert(r2.ok && near(r2.score, 0.8375, 1e-9), '评分 S=' + (r2.ok ? r2.score : '?') + '（期望 0.8375 = (0.6·0.9+1.0·0.8)/1.6）');
assert(r2.ok && r2.usedFrac === 0, 'usedFrac=0（该区块未被用过）');
assert(r2.ok && r2.teleport === 'teleportToLevel', '传送走 teleportToLevel');
assert(alice.tps.length === 1 && near(alice.tps[0].x - r2.x, 0.5), '落地坐标 = 落点 + 0.5（取方块中心）');
assert(r2.ok && r2.protectionMs === 60000 && r2.protectUntil > Date.now(), '新手保护窗口 = 60000ms 且已记账（protectUntil 在未来）');
var uidA = 'uuid-a';
assert(SPS.log[uidA] != null && SPS.log[uidA].rolls === 1, 'log[uuid-a].rolls = 1');
assert(SPS.log[uidA].lastSeed === 12345, 'log 记录了本次种子（可复现）');
assert(SPS.log[uidA].lastCode === 'ok', 'log.lastCode = ok');
var usedKey = r2.dim + '@' + r2.cx + ',' + r2.cz;
assert(SPS.used[usedKey] === 1, 'used[' + usedKey + '] = 1（防热点计数）');
assert(SPS.stats.placed === 1 && SPS.stats.rolls === 1, 'stats.placed/rolls = 1');
assert(r2.ok && r2.seed === 12345, '返回体带 seed（可复现）');
assert(WAR.audit != null && WAR.audit.count() >= 1, '掷点写入了审计');

// ---- T3 usedFrac 惩罚 + OP 豁免冷却 ----
console.log('\n--- T3 已用次数惩罚（同一区块再被选中 → S 下降）---');
var bob = new FakePlayer('bob', 'uuid-b');
bob.level = lvl;
var r3 = WAR.spawn.roll(bob, { level: lvl, op: true });
assert(r3.ok === true, 'bob（OP 豁免冷却）掷点成功');
assert(r3.ok && near(r3.usedFrac, 0.25), 'usedFrac = 1/4 = 0.25（usedScale=4）');
assert(r3.ok && near(r3.score, 0.75, 1e-9), 'S 降为 0.75 = 0.8375 - 0.35·0.25');
assert(r3.ok && r3.cx === r2.cx && r3.cz === r2.cz, '同种子 + 同中心 ⇒ 复现同一候选区块（方案 §2「可复现」）');
assert(SPS.used[usedKey] === 2, 'used 计数递增到 2');

// ---- T4 未扫描（null / 全 stale）---
console.log('\n--- T4 未扫描：CM 返回 null / 全 stale ---');
CM._fn = function () { return null; };
var carol = new FakePlayer('carol', 'uuid-c');
carol.level = lvl;
var r4 = WAR.spawn.roll(carol, { level: lvl, op: true });
assert(r4.ok === false && r4.code === 'NO_SCANNED_CANDIDATE', '全 null ⇒ code=NO_SCANNED_CANDIDATE');
assert(r4.detail != null && r4.detail.noRecord === 9 && r4.detail.notScanned === 1, '分解计数 noRecord=9 / notScanned=1');
assert(String(r4.message).indexOf('/cm scan') >= 0, '拒绝消息给出可操作建议（/cm scan）');
var denied0 = SPS.stats.denied;
assert(denied0 >= 1, '被拒绝计入 stats.denied');

var seen = {};
CM._fn = function (bx, bz) { return cmRec(0.1, 0.2, true, false); };
var r4b = WAR.spawn.roll(carol, { level: lvl, op: true });
assert(r4b.ok === false && r4b.code === 'NO_SCANNED_CANDIDATE', '全 stale ⇒ 同样按「未扫描」拒绝（stale 不参与均值）');
assert(r4b.detail != null && r4b.detail.stale === 9, '分解计数 stale=9');

// 5 fresh + 4 stale：只按非 stale 计（覆盖 5/9 ≥ minScored=5）⇒ 应成功
var seenKeys = {};
CM._fn = function (bx, bz) {
  var k = Math.floor((bx - 8) / 16) + ',' + Math.floor((bz - 8) / 16);
  if (seenKeys[k] == null) seenKeys[k] = Object.keys(seenKeys).length;
  return cmRec(0.2, 0.3, seenKeys[k] < 4, false);
};
var dave = new FakePlayer('dave', 'uuid-d');
dave.level = lvl;
var r4c = WAR.spawn.roll(dave, { level: lvl, op: true });
assert(r4c.ok === true && r4c.coverage === 5, '5 fresh + 4 stale ⇒ 用 5 条算均值（覆盖 5/9）');
assert(r4c.ok && near(r4c.d, 0.2) && near(r4c.a, 0.3), '均值只含非 stale 记录（D̄=0.2 Ā=0.3）');

// ---- T5 getAt 抛异常 → 不崩，按未扫描处理 ----
console.log('\n--- T5 CM.getAt 抛异常：不崩、按未扫描处理 ---');
CM._fn = function () { throw new Error('persistentData 读取失败（模拟）'); };
var r5 = WAR.spawn.roll(carol, { level: lvl, op: true });
assert(r5.ok === false && r5.code === 'NO_SCANNED_CANDIDATE', 'getAt 抛异常不会冒泡（roll 正常返回）');
assert(r5.detail != null && r5.detail.noRecord === 9, '异常按 null 计入 noRecord=9');

// ---- T6 CM 缺失（三降级之一）----
console.log('\n--- T6 CM 缺失（global.CM = null）---');
global.CM = null;
var r6 = WAR.spawn.roll(alice, { level: lvl, op: true });
assert(r6.ok === false && r6.code === 'CM_MISSING', 'roll 直接拒绝：code=CM_MISSING');
assert(String(r6.message).indexOf('chunk_metrics') >= 0, 'CM_MISSING 消息指向 chunk_metrics 未加载');
var srcNp = new FakeSource(0, alice);
var c6 = runPath(['spawn'], srcNp);
assert(c6.ok === true && c6.ret === 1, '/war spawn 命令仍正常返回（不抛）');
assert(srcNp.messages.join(' ').indexOf('chunk_metrics') >= 0, '/war spawn 命令把 CM_MISSING 原因回给玩家');
assert(WAR.spawn.status().cm === false, 'status().cm = false（CM 缺失时可自检）');
global.CM = CM;
CM._fn = function (bx, bz) { return cmRec(0.1, 0.2, false, false); };

// ---- T7 地形不合格 ----
console.log('\n--- T7 地形不合格（危险地面）---');
TERRAIN = 'lava';
var r7 = WAR.spawn.roll(carol, { level: lvl, op: true });
assert(r7.ok === false && r7.code === 'NO_SCANNED_CANDIDATE', '岩浆地面 ⇒ 无安全落点（拒绝而非硬塞）');
assert(r7.detail != null && r7.detail.noTerrain === 1, '分解计数 noTerrain=1');
TERRAIN = 'void';
var r7b = WAR.spawn.roll(carol, { level: lvl, op: true });
assert(r7b.ok === false && r7b.detail != null && r7b.detail.noTerrain === 1, '高度图 <= minY（虚空）同样计入 noTerrain');
TERRAIN = 'grass';
LOADED = false;
var r7c = WAR.spawn.roll(carol, { level: lvl, op: true });
assert(r7c.ok === false && r7c.detail != null && r7c.detail.notLoaded === 1, '区块未加载 ⇒ 跳过（notLoaded），不去 getChunk 触发加载');
LOADED = true;

// ---- T8 冷却 / 次数上限 / OP 豁免 ----
console.log('\n--- T8 冷却与次数上限 ---');
var r8 = WAR.spawn.roll(alice, { level: lvl });           // 非 OP，60s 冷却内
assert(r8.ok === false && r8.code === 'COOLDOWN', '冷却内再次掷点被拒：code=COOLDOWN');
assert(String(r8.message).indexOf('冷却') >= 0, '冷却消息可读');
var r8b = WAR.spawn.roll(alice, { level: lvl, op: true });
assert(r8b.ok === true, 'OP 豁免冷却');
SPS.config.cooldownMs = 0;
SPS.config.maxRolls = 3;              // alice 此时已有 2 次
SPS.config.tries = 1;
var r8c = WAR.spawn.roll(alice, { level: lvl });
assert(r8c.ok === true, '冷却 0 后非 OP 可掷（第 3 次）');
var r8d = WAR.spawn.roll(alice, { level: lvl });    // 第 4 次，上限 3
assert(r8d.ok === false && r8d.code === 'MAX_ROLLS', '达到 maxRolls=3 ⇒ 第 4 次被拒：code=MAX_ROLLS');
SPS.config.maxRolls = 50;
SPS.config.cooldownMs = 0;

// ---- T9 新手保护伤害拦截 ----
console.log('\n--- T9 新手保护：伤害拦截 ---');
// 注意：10_team.js 也注册了一个 beforeHurt（队内免伤）⇒ 必须按函数身份挑出本域的处理器
var myHurt = null;
for (var hi = 0; hi < REG.beforeHurt.length; hi++) {
  if (global.spOnBeforeHurt != null && REG.beforeHurt[hi].fn === global.spOnBeforeHurt) myHurt = REG.beforeHurt[hi];
}
if (myHurt == null && REG.beforeHurt.length > 0) myHurt = REG.beforeHurt[REG.beforeHurt.length - 1];  // 20_spawn 最后加载
assert(REG.beforeHurt.length >= 1, 'EntityEvents.beforeHurt 已注册（队内免伤 + 新手保护共 ' + REG.beforeHurt.length + ' 个）');
var anyTargeted = false;
for (var hj = 0; hj < REG.beforeHurt.length; hj++) if (REG.beforeHurt[hj].target === 'minecraft:player') anyTargeted = true;
assert(anyTargeted, '全部注册都是 target=minecraft:player');
assert(myHurt != null && typeof myHurt.fn === 'function', '本域 spOnBeforeHurt 已注册（按函数身份定位）');
assert(global.SP_MEM != null && global.SP_MEM.hurtReg === 'targeted', 'SP_MEM.hurtReg = targeted');
var HURT = myHurt.fn;
SPS.log['uuid-a'].protectUntil = Date.now() + 60000;      // alice 在保护期内
var dmgBlocked = { v: null };
var evPvp = {
  getEntity: function () { return alice; },
  getSource: function () { return { getEntity: function () { return bob; }, getDirectEntity: function () { return bob; } }; },
  setDamage: function (v) { dmgBlocked.v = v; }
};
HURT(evPvp);
assert(dmgBlocked.v === 0, '保护期内被其他玩家打 ⇒ setDamage(0)');
var dmgEnv = { v: null };
var evEnv = {
  getEntity: function () { return alice; },
  getSource: function () { return { getEntity: function () { return null; }, getDirectEntity: function () { return null; } }; },
  setDamage: function (v) { dmgEnv.v = v; }
};
HURT(evEnv);
assert(dmgEnv.v === null, '环境伤害（摔落/怪物）放行（不改伤害）');
var dmgSelf = { v: null };
var evSelf = {
  getEntity: function () { return alice; },
  getSource: function () { return { getEntity: function () { return alice; }, getDirectEntity: function () { return alice; } }; },
  setDamage: function (v) { dmgSelf.v = v; }
};
HURT(evSelf);
assert(dmgSelf.v === null, '自伤放行（不拦）');
SPS.log['uuid-a'].protectUntil = 0;                        // 保护期结束
var dmgAfter = { v: null };
var evAfter = {
  getEntity: function () { return alice; },
  getSource: function () { return { getEntity: function () { return bob; } }; },
  setDamage: function (v) { dmgAfter.v = v; }
};
HURT(evAfter);
assert(dmgAfter.v === null, '保护期结束后不再拦截');
var evNoRec = {
  getEntity: function () { return new FakePlayer('nobody', 'uuid-x'); },
  getSource: function () { return { getEntity: function () { return bob; } }; },
  setDamage: function (v) { throw new Error('不该被调用'); }
};
var noRecThrew = false;
try { HURT(evNoRec); } catch (e) { noRecThrew = true; }
assert(noRecThrew === false, '无掷点记录的玩家不抛异常');

// ---- T10 admin：center / radius / 非 OP 拒绝 ----
console.log('\n--- T10 admin center/radius 与 OP 谓词 ---');
var srcOp = new FakeSource(2, null);
var c10 = runPath(['spawn', 'admin', 'center'], srcOp, { x: 128, z: -256 });
assert(c10.ok === true, 'OP 执行 /war spawn admin center 128 -256');
assert(SPS.config.centerX === 128 && SPS.config.centerZ === -256, '中心写入 config.centerX/Z = 128/-256');
var c10b = runPath(['spawn', 'admin', 'radius'], srcOp, { n: 1000 });
assert(c10b.ok === true, 'OP 执行 /war spawn admin radius 1000');
assert(SPS.config.maxRadius === 1000, '外半径写入 maxRadius = 1000');
var clampMsg = WAR.spawn.radius(srcOp, 10);
assert(SPS.config.maxRadius === 64 && String(clampMsg).indexOf('64') >= 0, '半径钳制：10 被 clamp 到 64 格');
WAR.spawn.radius(srcOp, 1000);
assert(SPS.config.maxRadius === 1000, '半径恢复为 1000');
var srcNonOp = new FakeSource(0, null);
var c10d = runPath(['spawn', 'admin', 'center'], srcNonOp, { x: 1, z: 1 });
assert(c10d.ok === false && c10d.denied === true, '非 OP（level 0）执行 admin 被 requires 拒绝');
assert(SPS.config.centerX === 128, '被拒后配置未被改动');
var centerFromPlayer = new FakeSource(2, alice);
alice.x = 40; alice.z = -40;
var c10e = runPath(['spawn', 'admin', 'center'], centerFromPlayer);
assert(c10e.ok === true && SPS.config.centerX === 40 && SPS.config.centerZ === -40, '不带坐标 ⇒ 用玩家当前位置设中心');

// ---- T11 持久化往返 ----
console.log('\n--- T11 持久化往返（save → 新 server 重启）---');
var usedBefore = SPS.used[usedKey];
var rollsBefore = SPS.log['uuid-a'].rolls;
var centerBefore = SPS.config.centerX;
WAR.data.touch();
assert(WAR.data.save('spawn-selftest') === true, 'save() 落盘成功');
WAR.data.server = null; WAR.data.state = null; WAR.data.dirty = false;
var server2 = new FakeServer(); server2.persistentData = fakeServer.persistentData;
REG.loaded[0]({ server: server2 });
var SPS2 = WAR.data.state.spawn;
assert(SPS2 != null && SPS2.__owner === '20_spawn.js', '重启后 spawn 域仍归 20_spawn.js 所有');
assert(SPS2.used[usedKey] === usedBefore, 'used[] 跨重启保留（' + usedKey + ' = ' + usedBefore + '）');
assert(SPS2.log['uuid-a'] != null && SPS2.log['uuid-a'].rolls === rollsBefore, 'log[].rolls 跨重启保留');
assert(SPS2.config.centerX === centerBefore && SPS2.config.maxRadius === 1000, 'config 跨重启保留（center/radius）');
assert(SPS2.stats.placed >= 1, 'stats 跨重启保留');

// ---- T12 文本输出与命令驱动 ----
console.log('\n--- T12 status/text/last/gaps 与命令 ---');
global.CM = CM;
var t12 = null, t12Threw = null;
try { t12 = WAR.spawn.text(new FakeSource(0, alice)); } catch (e) { t12Threw = e; }
assert(t12Threw == null && Array.isArray(t12) && t12.length >= 3, 'text(source) 返回多行（不抛）');
assert(t12.join(' ').indexOf('[出生点]') >= 0, 'status 首行含 [出生点]');
assert(t12.join(' ').indexOf('掷点统计') >= 0, 'status 含掷点统计');
assert(t12.join(' ').indexOf('读数=') >= 0, 'status 暴露读数路径（批量 scoreArea / 逐点 getAt）');
var srcSt = new FakeSource(2, alice);
var c12 = runPath(['spawn', 'status'], srcSt);
assert(c12.ok === true && srcSt.messages.join(' ').indexOf('[出生点]') >= 0, '/war spawn status 命令回显状态');
var srcLast = new FakeSource(0, alice);
var c12b = runPath(['spawn', 'last'], srcLast);
assert(c12b.ok === true && srcLast.messages.join(' ').indexOf('上次落点') >= 0, '/war spawn last 命令回显上次落点');
var srcGaps = new FakeSource(0, null);
var c12c = runPath(['spawn', 'gaps'], srcGaps);
assert(c12c.ok === true && srcGaps.messages.join(' ').indexOf('接口缺口') >= 0, '/war spawn gaps 命令列出缺口');
assert(srcGaps.messages.join(' ').indexOf('已解决') >= 0, '/war spawn gaps 同时说明已由 CM 扩展解决的三条');
assert(WAR.spawn.gaps().length === 3, 'WAR.spawn.gaps() 返回 3 条（剩余缺口）');
var srcRoll = new FakeSource(0, bob);
SPS.config.cooldownMs = 0; SPS.config.maxRolls = 50;
var c12d = runPath(['spawn', 'roll'], srcRoll);
assert(c12d.ok === true && srcRoll.messages.join(' ').indexOf('出生点') >= 0, '/war spawn roll 命令驱动真实掷点并回报坐标');
var c12e = runPath(['spawn'], new FakeSource(0, null));
assert(c12e.ok === true, '/war spawn（控制台/无玩家）不抛，给出提示');

// ---- T13 未实现的预览接口 + /war version 回归 ----
console.log('\n--- T13 preview 只读接口 + 框架回归 ---');
var pv = WAR.spawn.preview(lvl, 8, 8);
assert(pv != null && pv.ok === true && near(pv.d, 0.1) && near(pv.a, 0.2), 'preview() 只读返回该区块 D/A（不改状态）');
var srcVer = new FakeSource(0, null);
var verRet = runPath(['version'], srcVer);
assert(verRet.ok === true && verRet.ret === 1, '/war version 仍可执行（未破坏 00_core 命令树）');
assert(srcVer.messages.join(' ').indexOf('战服 v') >= 0, '/war version 输出正常');
assert(WAR.ready === true, 'restart 后 WAR.ready = true（boot 钩子跑过）');

// ---- T14 批量路径 vs 旧版 CM：自动退化 + 读数路径可观测 ----
console.log('\n--- T14 CM.scoreArea 批量路径 / 旧版 CM 自动退化 ---');
CM._fn = function (bx, bz) { return cmRec(0.1, 0.2, false, false); };
var pvBatch = WAR.spawn.preview(lvl, 8, 8);
assert(pvBatch.ok === true && near(pvBatch.d, 0.1) && near(pvBatch.a, 0.2), '批量路径下 preview() 结果不变（D̄=0.1 Ā=0.2）');
var saBefore = CM.nScoreArea, gaBefore = CM.nGetAt;
WAR.spawn.preview(lvl, 8, 8);
assert(CM.nScoreArea - saBefore === 1 && CM.nGetAt - gaBefore === 0, 'preview 走 1 次 scoreArea、0 次 getAt');
var saKeep = CM.scoreArea;
CM.scoreArea = undefined;                       // 模拟旧版 CM（只有 getAt）
var pvLegacy = WAR.spawn.preview(lvl, 8, 8);
assert(pvLegacy.ok === true && near(pvLegacy.d, 0.1) && near(pvLegacy.a, 0.2), '旧版 CM（无 scoreArea）自动退化为逐点 getAt，结果一致');
assert(CM.nGetAt - gaBefore === 9, '退化路径恰好 9 次 getAt：' + (CM.nGetAt - gaBefore));
var r14 = WAR.spawn.roll(new FakePlayer('erin', 'uuid-e2'), { level: lvl, op: true });
assert(r14.ok === true && r14.scoredVia === 'legacy', '退化路径的 roll 也正常，scoredVia=legacy');
CM.scoreArea = saKeep;
CM._fn = function () { throw new Error('scoreArea 内部炸（模拟）'); };
var r14b = WAR.spawn.roll(new FakePlayer('frank', 'uuid-f2'), { level: lvl, op: true });
assert(r14b.ok === false && r14b.code === 'NO_SCANNED_CANDIDATE', 'scoreArea 抛异常 ⇒ 退化为逐点读取（不冒泡）');
CM._fn = function (bx, bz) { return cmRec(0.1, 0.2, false, false); };

// ---- T15 world data 读取失败（CM_READ_FAIL）≠ 未扫描 ----
console.log('\n--- T15 读取失败 ⇒ CM_READ_FAIL（与「未扫描」区分）---');
CM._pd = 'fail';
var r15 = WAR.spawn.roll(new FakePlayer('gina', 'uuid-g2'), { level: lvl, op: true });
assert(r15.ok === false && r15.code === 'CM_READ_FAIL', '全场读取失败 ⇒ code=CM_READ_FAIL（不是 NO_SCANNED_CANDIDATE）');
assert(String(r15.message).indexOf('不是「还没扫描」') >= 0, '消息明确区分「读取失败」与「未扫描」');
assert(String(r15.message).indexOf('/cm scan') < 0, '读取失败不误导玩家去 /cm scan');
assert(r15.detail != null && r15.detail.readFail === r15.detail.notScanned && r15.detail.readFail >= 1, '分解计数 readFail = notScanned（全部候选都是读失败）');
var src15 = new FakeSource(0, alice);
var c15 = runPath(['spawn'], src15);
assert(c15.ok === true && src15.messages.join(' ').indexOf('读取失败') >= 0, '/war spawn 把 CM_READ_FAIL 原因回给玩家');
CM._pd = 'ok';
var r15b = WAR.spawn.roll(new FakePlayer('hank', 'uuid-h2'), { level: lvl, op: true });
assert(r15b.ok === true, '读取恢复正常后掷点正常（CM_READ_FAIL 不是粘性状态）');
// scoreArea 说「无记录」、getStatus 复核出「读取失败」⇒ 原因纠正为 CM_READ_FAIL
CM._fn = function () { return null; };
CM._statusFn = function (cx, cz) { return { ok: false, status: 'read-fail', pd: 'fail', cx: cx, cz: cz, stale: false, rev: null, curRev: 3 }; };
var r15c = WAR.spawn.roll(new FakePlayer('ivy', 'uuid-i2'), { level: lvl, op: true });
assert(r15c.ok === false && r15c.code === 'CM_READ_FAIL', 'scoreArea 报「无记录」但 getStatus 复核出读取失败 ⇒ 仍报 CM_READ_FAIL');
assert(CM.nGetStatus >= 1, 'getStatus 被用来复核失败原因（累计 ' + CM.nGetStatus + ' 次）');
CM._statusFn = null;
CM._fn = function (bx, bz) { return cmRec(0.1, 0.2, false, false); };
var r15d = WAR.spawn.roll(new FakePlayer('jack', 'uuid-j2'), { level: lvl, op: true });
assert(r15d.ok === true, '清掉读取失败注入后恢复成功（三类原因都只是当次判定）');

// ================================================================ 汇总
console.log('\n=== 汇总：PASS ' + passN + ' / FAIL ' + failN + ' ===');
if (failN > 0) {
  console.log('失败项：');
  for (var qi = 0; qi < fails.length; qi++) console.log('  - ' + fails[qi]);
}
console.log('\n只能实机验证（本自检覆盖不到）：');
console.log('  · Java.loadClass/方法名与签名：BlockPos、BuiltInRegistries.BLOCK.getKey、');
console.log('    Heightmap$Types.WORLD_SURFACE、chunk.getHeight/getBlockState、level.isLoaded');
console.log('  · level.dimension().location() / level.getSharedSpawnPos() / getLevelData().getSpawnPos()');
console.log('  · player.teleportToLevel(level,x,y,z,yaw,pitch) 与 teleportTo 的真实重载');
console.log('  · EntityEvents.beforeHurt(target,fn) 的真实注册形态；DamageSource.getEntity/getDirectEntity');
console.log('  · server.persistentData 与 WAR.data.mutate/save 的真实落盘；ServerEvents.loaded 的事件对象');
console.log('  · 真实区块的地形/危险方块判定、性能（tries=64 × 1 次 CM.scoreArea + 64×9 的旧路径对照）；');
console.log('    本自检的假桥是纯 JS 对象，只能证明「不再逐点读」，Java 边界开销须实机复测');
console.log(failN > 0 ? '\nSOME_FAILED' : '\nALL_PASS');
process.exit(failN > 0 ? 1 : 0);
