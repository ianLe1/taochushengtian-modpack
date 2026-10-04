// ============================================================================
// .wartest/selftest.js —— 战服 war/ 脚本离线自检（假 Java 桥 + 假服务器/假命令树）
// ============================================================================
// 用法： cd <实例> && node .wartest/selftest.js
// 做法：仿 <实例>/.cmtest/selftest.js —— 不启动游戏，用假 Java 桥驱动**真实脚本**。
// 差异（有意）：本 harness 用 vm.runInThisContext 按文件名顺序加载 war/*.js，
//   以复刻 KubeJS「同级 server 脚本共享同一作用域（顶层 var/function 互相可见）」
//   的语义；require() 会把顶层 var 关在模块作用域里，跨文件引用（warUuid 等）会失败。
// 本批次（M0 第一刀）断言：命名空间骨架 / 命令树 / 数据根往返 / 审计 / 启动 / 降级。
// team 状态机断言在 10_team.js 交付后由本文件同一入口继续跑（当前明确 SKIP）。
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
FakeTag.prototype.putString = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.putBoolean = function (k, v) { this.m.set(k, v); };
FakeTag.prototype.getInt = function (k) { return this.m.has(k) ? Number(this.m.get(k)) : 0; };
FakeTag.prototype.getLong = function (k) { return this.m.has(k) ? Number(this.m.get(k)) : 0; };
FakeTag.prototype.getString = function (k) { return this.m.has(k) ? String(this.m.get(k)) : ''; };
FakeTag.prototype.getBoolean = function (k) { return this.m.has(k) ? this.m.get(k) === true : false; };
FakeTag.prototype.getCompound = function (k) {
  var v = this.m.get(k);
  return (v instanceof FakeTag) ? v : new FakeTag();   // 与真机一致：缺失时返回游离空 tag
};
FakeTag.prototype.getAllKeys = function () { return Array.from(this.m.keys()); };
FakeTag.prototype.remove = function (k) { this.m.delete(k); };

// ---------------------------------------------------------------- 假 Java 桥
var CLASSES = {
  'net.minecraft.nbt.CompoundTag': FakeTag,
  'net.minecraft.network.chat.Component': { literal: function (s) { return String(s); } }
};
global.Java = { loadClass: function (n) { if (!CLASSES[n]) throw new Error('no class ' + n); return CLASSES[n]; } };
global.NBT = { compoundTag: function () { return new FakeTag(); }, listTag: function () { return []; } };
// 60_shop.js 读货架要用：java.nio.file.Path.of(String) + JsonIO.readString(Path)（均 javap 实证）
CLASSES['java.nio.file.Path'] = { of: function (s) { return { _p: String(s), toString: function () { return String(s); } }; } };
global.JsonIO = {
  readString: function (p) { return fs.readFileSync(String(p), 'utf8'); },   // 直接读真实货架文件（保真）
  readJson: function (p) { return JSON.parse(fs.readFileSync(String(p), 'utf8')); },
  parse: function (s) { return JSON.parse(String(s)); },
  write: function () { throw new Error('harness: 不允许写文件'); }
};
// Text 绑定：TextWrapper.string(String) -> MutableComponent（字节码实证）
global.Text = {
  string: function (s) { return { text: String(s), toString: function () { return String(s); } }; },
  literal: function (s) { return global.Text.string(s); },
  gold: function (c) { return c; }, green: function (c) { return c; },
  red: function (c) { return c; }, yellow: function (c) { return c; }, gray: function (c) { return c; }
};

// ---------------------------------------------------------------- 假事件注册
var REG = { loaded: [], unloaded: [], tick: [], commandRegistry: [], beforeHurt: [], death: [], loggedIn: [] };
global.ServerEvents = {
  loaded: function (fn) { REG.loaded.push(fn); },
  unloaded: function (fn) { REG.unloaded.push(fn); },
  tick: function (fn) { REG.tick.push(fn); },
  commandRegistry: function (fn) { REG.commandRegistry.push(fn); },
  recipes: function () { }
};
// 事件名实证：EntityEvents = death/beforeHurt/checkSpawn/spawned/drops；PlayerEvents = loggedIn/...
global.EntityEvents = {
  beforeHurt: function (fn) { REG.beforeHurt.push(fn); },
  death: function (fn) { REG.death.push(fn); }
};
global.PlayerEvents = {
  loggedIn: function (fn) { REG.loggedIn.push(fn); },
  loggedOut: function () { }, tick: function () { }
};

// 启动注册桩（startup_scripts）：捕获 event.create(id) 与链式调用
var STARTUP = [];
function FakeItemBuilder(id) { this.id = id; this.texturePath = null; }
FakeItemBuilder.prototype.texture = function (t) { this.texturePath = String(t); return this; };
FakeItemBuilder.prototype.maxStackSize = function () { return this; };
FakeItemBuilder.prototype.unstackable = function () { return this; };
FakeItemBuilder.prototype.displayName = function () { return this; };
FakeItemBuilder.prototype.group = function () { return this; };
global.StartupEvents = {
  registry: function (type, cb) {
    cb({ create: function (id) {
      var b = new FakeItemBuilder(String(id));
      STARTUP.push({ type: String(type), id: String(id), builder: b });
      return b;
    } });
  }
};

// ---------------------------------------------------------------- 假 CM（chunk_metrics）：只实现口径一页纸声明的只读契约
var CM_FAKE = { rev: 0, calib: null, grid: {} };
function cmFakeSet(cx, cz, a, d, opts) {
  CM_FAKE.grid[cx + ',' + cz] = {
    a: a, d: d,
    status: (opts != null && opts.status != null) ? opts.status : 'ok',
    stale: (opts != null && opts.stale === true),
    rev: (opts != null && opts.rev != null) ? opts.rev : CM_FAKE.rev
  };
}
function cmFakeClear() { CM_FAKE.grid = {}; }
global.CM = {
  rev: function () { return CM_FAKE.rev; },
  getStatus: function (level, cx, cz) {
    var g = CM_FAKE.grid[cx + ',' + cz];
    if (g == null) return { ok: false, status: 'no-record', source: 'none', cx: cx, cz: cz, d: null, a: null, rev: null, curRev: CM_FAKE.rev, stale: false };
    if (g.status === 'read-fail') return { ok: false, status: 'read-fail', source: 'disk', cx: cx, cz: cz, d: null, a: null, rev: g.rev, curRev: CM_FAKE.rev, stale: false };
    return { ok: true, status: 'ok', source: 'disk', cx: cx, cz: cz, d: g.d, a: g.a, rev: g.rev, curRev: CM_FAKE.rev, stale: g.stale === true };
  },
  scoreArea: function (level, cx, cz, radius, opts) {
    var r = Number(radius); if (isNaN(r) || r < 0) r = 2; r = Math.floor(r);
    var cands = [], counts = { ok: 0, fresh: 0, stale: 0, noRecord: 0, readFail: 0, mem: 0 };
    for (var dx = -r; dx <= r; dx++) {
      for (var dz = -r; dz <= r; dz++) {
        var key = (cx + dx) + ',' + (cz + dz), g = CM_FAKE.grid[key];
        if (g == null) { cands.push({ status: 'no-record', stale: false, source: 'none', rev: null, d: null, a: null, partial: false }); counts.noRecord++; continue; }
        if (g.status === 'read-fail') { cands.push({ status: 'read-fail', stale: false, source: 'disk', rev: g.rev, d: null, a: null, partial: false }); counts.readFail++; continue; }
        cands.push({ status: 'ok', stale: g.stale === true, source: 'disk', rev: g.rev, d: g.d, a: g.a, partial: false });
        counts.ok++; if (g.stale === true) counts.stale++; else counts.fresh++;
      }
    }
    return { ok: true, cx: cx, cz: cz, radius: r, width: r * 2 + 1, curRev: CM_FAKE.rev, candidates: cands, counts: counts, usable: counts.fresh };
  }
};

// ---------------------------------------------------------------- 假 Brigadier
function FakeNode(kind, name) { this.kind = kind; this.name = name; this.children = []; this.executor = null; this.requires_ = null; this.argType = null; }
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
    getResult: function (ctx, n) { return parseInt(String((ctx.args && ctx.args[n] !== undefined) ? ctx.args[n] : ''), 10); }
  },
  PLAYER: {
    create: function () { return { type: 'player' }; },
    getResult: function (ctx, n) { return (ctx.args && ctx.args[n] !== undefined) ? ctx.args[n] : null; }
  }
};

// ---------------------------------------------------------------- 假服务器 / 玩家 / 命令源
function FakeServer() { this.persistentData = new FakeTag(); this.cmds = []; }
FakeServer.prototype.runCommandSilent = function (c) { this.cmds.push(String(c)); return 1; };
FakeServer.prototype.runCommand = function (c) { this.cmds.push(String(c)); return 1; };
FakeServer.prototype.getPlayers = function () { return this.players || []; };
FakeServer.prototype.overworld = function () { return null; };

function FakeStack(id, count) { this.id = String(id); this.count = count == null ? 1 : Number(count); }
FakeStack.prototype.getItem = function () { return { id: this.id }; };
FakeStack.prototype.getCount = function () { return this.count; };
FakeStack.prototype.setCount = function (n) { this.count = n; };
FakeStack.prototype.shrink = function (n) { this.count = Math.max(0, this.count - n); };
FakeStack.prototype.isEmpty = function () { return this.count <= 0; };
FakeStack.prototype.copy = function () { return new FakeStack(this.id, this.count); };
global.Item = {
  of: function (id, n) { return new FakeStack(id, n == null ? 1 : n); },
  getId: function (item) { return (item && item.id != null) ? item.id : String(item); },
  getEmpty: function () { return new FakeStack('minecraft:air', 0); },
  exists: function () { return true; }
};
function FakeInventory(slots) {
  this.slots = new Array(slots || 36);
  for (var si0 = 0; si0 < this.slots.length; si0++) this.slots[si0] = null;
}
FakeInventory.prototype.getSlots = function () { return this.slots.length; };
FakeInventory.prototype.getStackInSlot = function (i) { return this.slots[i] || null; };
FakeInventory.prototype.setStackInSlot = function (i, s) { this.slots[i] = s; return true; };
FakeInventory.prototype.insertItem = function (stack, simulate) {
  if (stack == null || stack.isEmpty()) return null;
  var left = stack.getCount();
  for (var i = 0; i < this.slots.length && left > 0; i++) {
    var s = this.slots[i];
    if (s == null || s.isEmpty()) {
      var put = Math.min(left, 64);
      if (!simulate) this.slots[i] = new FakeStack(stack.id, put);
      left -= put;
    } else if (s.id === stack.id) {
      var put2 = Math.min(64 - s.getCount(), left);
      if (put2 > 0) { if (!simulate) s.setCount(s.getCount() + put2); left -= put2; }
    }
  }
  return left <= 0 ? null : new FakeStack(stack.id, left);
};
FakeInventory.prototype.extractItem = function (i, amount, simulate) {
  var s = this.slots[i];
  if (s == null || s.isEmpty()) return null;
  var take = Math.min(amount, s.getCount());
  if (!simulate) { s.setCount(s.getCount() - take); if (s.getCount() <= 0) this.slots[i] = null; }
  return new FakeStack(s.id, take);
};
FakeInventory.prototype.count = function () { var n = 0; for (var ci = 0; ci < this.slots.length; ci++) if (this.slots[ci]) n += this.slots[ci].getCount(); return n; };
FakeInventory.prototype.isEmpty = function () { return this.count() <= 0; };

function FakePlayer(name, uuid) {
  this.username = name; this.uuid = uuid; this.persistentData = new FakeTag(); this.messages = [];
  this.inventory = new FakeInventory(36);
  this.blockX = 0; this.blockZ = 0;                     // 40_base.js 的锚点要用（玩家所在区块）
  this.level = { dim: 'minecraft:overworld', tag: new FakeTag(), isClientSide: false };   // CM 的 API 取 level 而非 dim 字符串
}
FakePlayer.prototype.getUUID = function () { return this.uuid; };
FakePlayer.prototype.getStringUUID = function () { return this.uuid; };
FakePlayer.prototype.getScoreboardName = function () { return this.username; };
FakePlayer.prototype.getName = function () { var n = this.username; return { getString: function () { return n; } }; };
FakePlayer.prototype.tell = function (c) { this.messages.push(String(c)); };
FakePlayer.prototype.isPlayer = function () { return true; };
FakePlayer.prototype.getType = function () { return 'minecraft:player'; };
FakePlayer.prototype.give = function (stack) {
  var rest = this.inventory.insertItem(stack, false);
  if (rest != null && rest.getCount() > 0) throw new Error('inventory full');
};

function FakeSource(level, player) {
  this.level = level == null ? 4 : level; this.pl = player || null; this.messages = []; this.failures = [];
}
FakeSource.prototype.hasPermission = function (n) { return Number(this.level) >= Number(n); };
FakeSource.prototype.getPlayer = function () { return this.pl; };
FakeSource.prototype.getServer = function () { return fakeServer; };
FakeSource.prototype.getLevel = function () { return null; };
FakeSource.prototype.sendSystemMessage = function (c) { this.messages.push(String(c)); };
FakeSource.prototype.sendSuccess = function (sup) { this.messages.push(String(sup())); };
FakeSource.prototype.sendFailure = function (c) { this.failures.push(String(c)); };

// ---------------------------------------------------------------- 加载真实脚本
// war/ 目录是多名成员共写的（例如 20_spawn.js 属出生点域，依赖 chunk_metrics 的 global.CM）——
// 全量 glob 会把别人正在写的文件一起拉进来：既让本 harness 与他们的代码耦合，又会污染事件计数。
// ⇒ 只加载本 harness 负责的文件（显式白名单），其余只报告不加载。
var WAR_FILES = ['00_core.js', '10_team.js', '30_economy.js', '40_base.js', '60_shop.js', '90_admin.js'];
var present = fs.readdirSync(WAR_DIR).filter(function (f) { return /[.]js$/.test(f); }).sort();
var skipped = present.filter(function (f) { return WAR_FILES.indexOf(f) < 0; });
console.log('=== 加载 war/ 脚本（白名单）：' + WAR_FILES.join(', '));
if (skipped.length) console.log('    （同目录他人负责、本 harness 不加载：' + skipped.join(', ') + '）');
for (var fi = 0; fi < WAR_FILES.length; fi++) {
  var src = fs.readFileSync(path.join(WAR_DIR, WAR_FILES[fi]), 'utf8');
  vm.runInThisContext(src, { filename: path.join(WAR_DIR, WAR_FILES[fi]) });
}
var WAR = global.WAR;

var fakeServer = new FakeServer();

// ---------------------------------------------------------------- 命令树工具
var registeredRoot = null;
function findChild(node, name) {
  if (node == null || node.children == null) return null;
  for (var i = 0; i < node.children.length; i++) if (node.children[i].name === name) return node.children[i];
  return null;
}
function runPath(node, p, source, args) {
  var cur = node;
  function gate(n) { return (typeof n.requires_ === 'function') ? (n.requires_(source) === true) : true; }
  if (!gate(cur)) return null;                       // 根节点自身的权限门
  for (var i = 0; i < p.length; i++) {
    var c = findChild(cur, p[i]);
    if (c == null) return null;
    if (!gate(c)) return null;                       // 逐级权限门：无权限 → 不可达（不回显）
    cur = c;
  }
  if (typeof cur.executor !== 'function') return null;
  return cur.executor({ source: source, args: args || {} });
}
function dumpTree(node, prefix, out) {
  out.push(prefix + node.name + (node.kind === 'argument' ? ' <arg>' : '') +
           (node.requires_ ? ' [op-only]' : '') + (typeof node.executor === 'function' ? ' ⏎' : ''));
  for (var i = 0; i < (node.children || []).length; i++) dumpTree(node.children[i], prefix + '   ', out);
  return out;
}

// ---------------------------------------------------------------- 断言工具
var ok = true, passN = 0, failN = 0, skipN = 0;
function assert(cond, label) {
  if (cond) { passN++; console.log('PASS: ' + label); }
  else { failN++; ok = false; console.log('FAIL: ' + label); }
}
function skip(label) { skipN++; console.log('SKIP: ' + label); }

// ================================================================ T1 骨架
console.log('\n--- T1 global.WAR 骨架 ---');
assert(WAR != null, 'global.WAR 存在');
assert(typeof WAR.version === 'string' && WAR.version.length > 0, 'WAR.version = ' + WAR.version);
var domains = ['data', 'audit', 'team', 'econ', 'spawn', 'claim', 'trade', 'shop'];
for (var di = 0; di < domains.length; di++) assert(WAR[domains[di]] != null, 'WAR.' + domains[di] + ' 存在');
assert(WAR.claim.__stub === true && WAR.trade.__stub === true, '未实现域带 __stub 标记（claim/trade）');
assert(WAR.shop.__stub === false && WAR.shop.__owner === '60_shop.js', 'shop 已被 60_shop.js 实现（__stub=false）');
assert(WAR.econ.__stub === false && WAR.econ.__owner === '30_economy.js', 'econ 已被 30_economy.js 实现（__stub=false）');
assert(WAR.team.__stub === false && WAR.team.__owner === '10_team.js', 'team 已被 10_team.js 实现（__stub=false）');
assert(typeof WAR.every === 'function' && typeof WAR.boot === 'function' && typeof WAR.tick === 'function', '框架入口 every/boot/tick 存在');
assert(WAR.config.team.maxMembers === 8 && WAR.config.team.friendlyFire === false &&
       WAR.config.team.inviteExpireSeconds === 300 && WAR.config.audit.bufferSize === 500,
       'CONFIG 暂定默认值：单队 8 / 队内伤害关 / 邀请 300s / 审计 500');

// ================================================================ T2 命令树
console.log('\n--- T2 /war 命令树 ---');
assert(REG.commandRegistry.length === 1, 'commandRegistry 处理器已注册（' + REG.commandRegistry.length + ' 个）');
REG.commandRegistry[0]({
  commands: FakeCommands, arguments: FakeArguments,
  register: function (n) { registeredRoot = n; }
});
assert(registeredRoot != null && registeredRoot.name === 'war', '/war 根节点已 event.register');
var nodeVersion = findChild(registeredRoot, 'version');
assert(nodeVersion != null && typeof nodeVersion.executor === 'function', '/war version 节点存在且可执行');
assert(findChild(registeredRoot, 'help') != null, '/war help 节点存在');
assert(findChild(registeredRoot, 'bogus') == null, '未知子命令不存在（/war bogus）');

var srcVer = new FakeSource(0, null);
assert(runPath(registeredRoot, ['version'], srcVer) === 1, '/war version 执行返回 1');
var verMsg = srcVer.messages.join(' ');
assert(verMsg.indexOf('战服 v' + WAR.version) >= 0, '/war version 响应含版本号：' + verMsg.slice(0, 70) + '...');
assert(verMsg.indexOf('schema v1') >= 0 && verMsg.indexOf('server.persistentData.war') >= 0, '响应含 schema 与权威存储路径');

var srcHelp = new FakeSource(0, null);
runPath(registeredRoot, ['help'], srcHelp);
assert(srcHelp.messages.join(' ').indexOf('/war version') >= 0, '/war help 列出 /war version');
assert(srcHelp.messages.join(' ').indexOf('/war admin') >= 0, '/war help 列出 /war admin');

var nodeAdmin = findChild(registeredRoot, 'admin');
assert(nodeAdmin != null, '/war admin 节点存在');
assert(typeof nodeAdmin.requires_ === 'function', '/war admin 挂了 requires 权限谓词');
assert(nodeAdmin.requires_(new FakeSource(1, null)) === false, 'OP level 1 看不到 /war admin');
assert(nodeAdmin.requires_(new FakeSource(2, null)) === true, 'OP level 2 可见 /war admin');

var srcAdmin = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'status'], srcAdmin);
var adminMsg = srcAdmin.messages.join(' ');
assert(adminMsg.indexOf('OP 自检') >= 0, '/war admin status 有响应');
assert(adminMsg.indexOf('ready=') >= 0 && adminMsg.indexOf('java桥=') >= 0, 'status 显示 ready/java桥 字段（启动前 ready=N 属正常）');
assert(adminMsg.indexOf('NBT键=') >= 0 && adminMsg.indexOf('war') >= 0, 'status 显示 NBT 根键');

var nodeAudit = findChild(findChild(registeredRoot, 'admin'), 'audit');
assert(nodeAudit != null && findChild(nodeAudit, 'n') != null, '/war admin audit [n] 参数节点存在');
var srcAudit = new FakeSource(2, null);
var auditRet = runPath(registeredRoot, ['admin', 'audit', 'n'], srcAudit, { n: 3 });
assert(auditRet === 1, '/war admin audit 3 执行返回 1');

console.log('\n=== 命令树清单 ===');
console.log(dumpTree(registeredRoot, '', []).join('\n'));

// ================================================================ T3 启动 + 数据根往返
console.log('\n--- T3 启动与数据根往返 ---');
assert(REG.loaded.length === 1 && REG.tick.length === 1 && REG.unloaded.length === 1, 'loaded/tick/unloaded 处理器均已注册');
REG.loaded[0]({ server: fakeServer });
assert(WAR.ready === true, 'loaded 后 WAR.ready = true');
assert(WAR.data.state.bootCount === 1, '首次启动 bootCount = 1');
assert(WAR.audit.count() >= 1 && WAR.audit.last().action === 'server.boot', '启动写了一条 server.boot 审计');

var rootTag = fakeServer.persistentData.getCompound('war');
assert(fakeServer.persistentData.contains('war'), '权威存储键 war 已创建');
var need = ['version', 'dataVersion', 'createdAt', 'bootCount', 'savedAt', 'teams', 'audit', 'econ', 'spawn', 'claim', 'trade', 'shop', 'base', 'think', 'kv'];
var missing = [];
for (var ni = 0; ni < need.length; ni++) if (!rootTag.contains(need[ni])) missing.push(need[ni]);
assert(missing.length === 0, 'NBT 根包含全部约定键' + (missing.length ? '（缺 ' + missing.join(',') + '）' : ''));

WAR.data.kv.set('probe', { a: 1, b: 'x' });
WAR.data.state.teams.byId['wt1'] = { id: 'wt1', name: '测试队', color: 'blue', members: [], invites: [] };
WAR.data.state.teams.byPlayer['uuid-0001'] = 'wt1';
WAR.data.touch();
assert(WAR.data.dirty === true, 'touch 后标记 dirty');
assert(WAR.data.save('selftest') === true, 'save() 落盘成功');

// 模拟重启：同一 persistentData（= 磁盘），全新 server 与内存状态
WAR.data.server = null; WAR.data.state = null; WAR.data.dirty = false;
var server2 = new FakeServer(); server2.persistentData = fakeServer.persistentData;
REG.loaded[0]({ server: server2 });
assert(WAR.data.state.bootCount === 2, '重启后 bootCount 递增到 2（数据未丢）');
assert(WAR.data.kv.get('probe').a === 1 && WAR.data.kv.get('probe').b === 'x', 'kv 跨重启往返');
assert(WAR.data.state.teams.byId['wt1'] != null && WAR.data.state.teams.byId['wt1'].name === '测试队', 'teams.byId 跨重启保留');
assert(WAR.data.state.teams.byPlayer['uuid-0001'] === 'wt1', 'teams.byPlayer 反查跨重启保留');

var srcAdmin2 = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'status'], srcAdmin2);
var adminMsg2 = srcAdmin2.messages.join(' ');
assert(adminMsg2.indexOf('ready=Y') >= 0 && adminMsg2.indexOf('java桥=Y') >= 0, '启动后 /war admin status 显示 ready=Y / java桥=Y');
assert(adminMsg2.indexOf('bootCount=2') >= 0, 'status 显示 bootCount=2');
assert(adminMsg2.indexOf('teams') >= 0, 'status 列出的 NBT 键含 teams');

// 载荷损坏容错
rootTag.putString('teams', '{这不是 JSON');
WAR.data.state = null;
REG.loaded[0]({ server: server2 });
assert(WAR.data.state.teams != null && WAR.data.state.teams.byId != null && WAR.data.state.teams.byPlayer != null,
       'JSON 载荷损坏时回退默认结构且不抛异常');

// ================================================================ T4 审计
console.log('\n--- T4 审计环形缓冲 ---');
var e1 = WAR.audit.append('alice', 'team.create', 'wt1', 'ok', '单测');
assert(e1 != null && e1.seq > 0 && e1.t > 0 && e1.actor === 'alice' && e1.action === 'team.create' &&
       e1.target === 'wt1' && e1.result === 'ok' && e1.detail === '单测', '审计条目含 时间/主体/动作/对象/结果/细节+seq');
var seqBefore = e1.seq;
var e2 = WAR.audit.append('bob', 'team.invite', 'wt1', 'fail');
assert(e2.seq === seqBefore + 1, '审计 seq 单调递增');
assert(WAR.audit.last().actor === 'bob' && WAR.audit.tail(2).length === 2, 'last/tail 正常');

var cap0 = WAR.config.audit.bufferSize;
WAR.config.audit.bufferSize = 5;
var dropped0 = WAR.data.state.audit.dropped;
var beforeRing = WAR.audit.count();
var oldestSeq = WAR.data.state.audit.items[0].seq;
for (var ai = 0; ai < 8; ai++) WAR.audit.append('u' + ai, 'act', 't', 'ok', 'i' + ai);
var expectDropped = Math.max(0, beforeRing + 8 - 5);
assert(WAR.audit.count() === 5, '环形缓冲截断到 bufferSize=5（实际 ' + WAR.audit.count() + '）');
assert(WAR.data.state.audit.dropped - dropped0 === expectDropped,
       '溢出丢帧计数 = ' + expectDropped + '（进环前 ' + beforeRing + ' 条 + 8 条 - 容量 5）');
assert(WAR.data.state.audit.items[0].seq > oldestSeq, '最旧条目已被挤出（原 #' + oldestSeq + ' → 现 #' + WAR.data.state.audit.items[0].seq + '）');
assert(WAR.audit.last().detail === 'i7', '保留的是最新条目');
WAR.config.audit.bufferSize = cap0;

WAR.data.save('audit-ring');
var ringItems = WAR.audit.tail(WAR.audit.count()), ringSeqs = [];
for (var ri = 0; ri < ringItems.length; ri++) ringSeqs.push(ringItems[ri].seq);
var ringCount = ringSeqs.length, ringDropped = WAR.data.state.audit.dropped, ringLastSeq = ringItems[ri - 1].seq;
WAR.data.state = null;
REG.loaded[0]({ server: server2 });
var afterItems = WAR.audit.tail(WAR.audit.count()), afterSeqs = {};
for (var rj = 0; rj < afterItems.length; rj++) afterSeqs[afterItems[rj].seq] = true;
var lost = [];
for (var rk = 0; rk < ringSeqs.length; rk++) if (afterSeqs[ringSeqs[rk]] !== true) lost.push(ringSeqs[rk]);
assert(lost.length === 0, '审计 ' + ringCount + ' 条全部跨重启保留（丢 ' + lost.length + ' 条）');
assert(afterSeqs[ringLastSeq] === true, '重启前的最后一条 #' + ringLastSeq + ' 仍在');
assert(WAR.data.state.audit.dropped === ringDropped, '丢帧计数跨重启保留 = ' + ringDropped);
assert(WAR.audit.last().action === 'server.boot', '重启追加 server.boot 条目');

// ================================================================ T5 tick 分发
console.log('\n--- T5 tick 分发器 ---');
var hits = 0;
WAR.every(5, 'probe', function () { hits++; });
for (var ti = 0; ti < 12; ti++) REG.tick[0]({ server: server2 });
assert(hits === 2, '每 5 tick 触发一次，12 tick 内触发 2 次（实际 ' + hits + '）');
var threw = false;
WAR.every(2, 'boom', function () { throw new Error('预期异常'); });
for (var tj = 0; tj < 4; tj++) { try { REG.tick[0]({ server: server2 }); } catch (e) { threw = true; } }
assert(threw === false, '定时器回调抛异常不冒泡（只记日志）');

// ================================================================ T6 持久化降级
console.log('\n--- T6 持久化不可用时的降级 ---');
var brokenTag = {
  contains: function () { throw new Error('boom'); },
  getCompound: function () { throw new Error('boom'); },
  put: function () { throw new Error('boom'); }
};
WAR.data.bind({ persistentData: brokenTag, runCommandSilent: function () { } });
var saveRet = null, saveThrew = false;
try { saveRet = WAR.data.save('degrade'); } catch (e) { saveThrew = true; }
assert(saveThrew === false && saveRet === false, 'persistentData 抛异常时 save 返回 false 而不炸');
var rootRet = null, rootThrew = false;
try { rootRet = WAR.data.root(); } catch (e2) { rootThrew = true; }
assert(rootThrew === false && rootRet === null, 'persistentData 抛异常时 root() 返回 null 而不炸');
var server3 = new FakeServer();
WAR.data.bind(server3);
assert(WAR.data.save('recover') === true, '换回可用存储后 save 恢复成功');

// ================================================================ T7 team 状态机
console.log('\n--- T7 team 状态机（10_team.js）---');
var alice = new FakePlayer('alice', 'uuid-a'), bob = new FakePlayer('bob', 'uuid-b'), carol = new FakePlayer('carol', 'uuid-c');
var sA = new FakeSource(2, alice), sB = new FakeSource(0, bob), sC = new FakeSource(0, carol);
var srvT = new FakeServer();
srvT.persistentData = server3.persistentData;   // 同一「磁盘」
srvT.players = [alice, bob, carol];
WAR.data.bind(srvT);
REG.loaded[0]({ server: srvT });
WAR.data.state.teams.byId = {}; WAR.data.state.teams.byPlayer = {}; WAR.data.state.teams.seq = 0;
assert(REG.beforeHurt.length === 1 && REG.death.length === 1 && REG.loggedIn.length >= 1, 'team 侧事件已接线（beforeHurt/death/loggedIn）');

// 1) 建队
runPath(registeredRoot, ['team', 'create', 'name'], sA, { name: '测试队' });
var t1 = WAR.team.byName('测试队');
assert(t1 != null && t1.id === 'wt1', 'create：队伍建立（id=' + (t1 && t1.id) + '）');
assert(t1.leader === 'uuid-a' && t1.members.length === 1 && t1.members[0].role === 'leader', 'create：建队者即队长（members[0].role=leader）');
assert(WAR.team.state().byPlayer['uuid-a'] === 'wt1', 'create：byPlayer 反查建立');
var sc = srvT.cmds.join(' ; ');
assert(sc.indexOf('team add wt1') >= 0, 'create：计分板 team add 已下发');
assert(sc.indexOf('team modify wt1 color blue') >= 0, 'create：计分板颜色 = 默认 blue');
assert(sc.indexOf('team modify wt1 friendlyFire false') >= 0, 'create：计分板 friendlyFire false（驼峰字面量实证）');
assert(sc.indexOf('team join wt1 alice') >= 0, 'create：计分板 team join alice');
assert(sA.messages.join(' ').indexOf('已建队「测试队」') >= 0, 'create：成功回显');

// 颜色：非法被拒 / 合法生效
runPath(registeredRoot, ['team', 'create', 'name', 'color'], sC, { name: '彩虹队', color: 'rainbow' });
assert(WAR.team.byName('彩虹队') == null, '非法颜色被拒（未建队）');
runPath(registeredRoot, ['team', 'create', 'name', 'color'], sC, { name: '金队', color: 'gold' });
var t2 = WAR.team.byId('wt2');
assert(t2 != null && t2.color === 'gold', '带颜色参数建队成功（wt2 = gold）');
assert(srvT.cmds.join(' ; ').indexOf('team modify wt2 color gold') >= 0, '自定义颜色下发到计分板');

// 2) 邀请
runPath(registeredRoot, ['team', 'invite', 'player'], sA, { player: bob });
var t1b = WAR.team.byId('wt1');
assert(t1b.invites.length === 1 && t1b.invites[0].uuid === 'uuid-b', 'invite：邀请落到 L1（invites[0]=bob）');
assert(t1b.invites[0].expireAt > Date.now(), 'invite：有效期在未来（配置 ' + WAR.config.team.inviteExpireSeconds + ' 秒）');
assert(bob.messages.join(' ').indexOf('/war team accept wt1') >= 0, 'invite：被邀者收到提示');

// 3) 接受
runPath(registeredRoot, ['team', 'accept', 'teamId'], sB, { teamId: 'wt1' });
assert(WAR.team.byId('wt1').members.length === 2, 'accept：成员数 1→2');
assert(WAR.team.state().byPlayer['uuid-b'] === 'wt1', 'accept：byPlayer 反查建立');
assert(WAR.team.byId('wt1').invites.length === 0, 'accept：邀请被消费');
assert(srvT.cmds.join(' ; ').indexOf('team join wt1 bob') >= 0, 'accept：计分板 team join bob');

// 4) 退出
runPath(registeredRoot, ['team', 'leave'], sB);
assert(WAR.team.byId('wt1').members.length === 1, 'leave：成员数 2→1');
assert(WAR.team.state().byPlayer['uuid-b'] === undefined, 'leave：byPlayer 反查清除');
assert(srvT.cmds.join(' ; ').indexOf('team leave bob') >= 0, 'leave：计分板 team leave bob');

// 5) 再邀一次 + 队长踢人
runPath(registeredRoot, ['team', 'invite', 'player'], sA, { player: bob });
runPath(registeredRoot, ['team', 'accept', 'teamId'], sB, { teamId: 'wt1' });
assert(WAR.team.byId('wt1').members.length === 2, '二次邀请+接受成功');
runPath(registeredRoot, ['team', 'kick', 'player'], sA, { player: bob });
assert(WAR.team.byId('wt1').members.length === 1 && WAR.team.state().byPlayer['uuid-b'] === undefined, 'kick：bob 被移出');
assert(bob.messages.join(' ').indexOf('你被移出了队伍') >= 0, 'kick：被踢者有通知');

// 6) list
var sList = new FakeSource(0, alice);
runPath(registeredRoot, ['team', 'list'], sList);
var listMsg = sList.messages.join(' ');
assert(listMsg.indexOf('测试队') >= 0 && listMsg.indexOf('alice(队长)') >= 0, 'list：本队详情含队名与队长标识');
assert(listMsg.indexOf('队内免伤=开') >= 0, 'list：显示队内免伤状态');
var sListC = new FakeSource(0, carol);
runPath(registeredRoot, ['team', 'list'], sListC);
assert(sListC.messages.join(' ').indexOf('金队') >= 0, 'list：无队伍时列全服队伍');

// 7) 邀请过期
var ttl0 = WAR.config.team.inviteExpireSeconds;
WAR.config.team.inviteExpireSeconds = 0;
runPath(registeredRoot, ['team', 'invite', 'player'], sA, { player: bob });
WAR.config.team.inviteExpireSeconds = ttl0;
runPath(registeredRoot, ['team', 'accept', 'teamId'], sB, { teamId: 'wt1' });
assert(WAR.team.state().byPlayer['uuid-b'] === undefined, '过期邀请无法接受（有效期临时设为 0 秒）');

// 8) 队内免伤守卫
runPath(registeredRoot, ['team', 'invite', 'player'], sC, { player: bob });
runPath(registeredRoot, ['team', 'accept', 'teamId'], sB, { teamId: 'wt2' });
assert(WAR.team.state().byPlayer['uuid-b'] === 'wt2', 'bob 加入金队（用于免伤测试）');
var dmg = { called: null };
var hurtSame = {
  getEntity: function () { return bob; },
  getSource: function () { return { getEntity: function () { return carol; }, getDirectEntity: function () { return carol; } }; },
  getDamage: function () { return 5; },
  setDamage: function (v) { dmg.called = v; }
};
var blocked0 = WAR.team.byId('wt2').stats.friendlyBlocked;
REG.beforeHurt[0](hurtSame);
assert(dmg.called === 0, '队内免伤：同队攻击被 setDamage(0) 拦下');
assert(WAR.team.byId('wt2').stats.friendlyBlocked === blocked0 + 1, '队内免伤：friendlyBlocked 计数 +1');
dmg.called = null;
REG.beforeHurt[0]({
  getEntity: function () { return bob; },
  getSource: function () { return { getEntity: function () { return alice; }, getDirectEntity: function () { return alice; } }; },
  setDamage: function (v) { dmg.called = v; }
});
assert(dmg.called === null, '不同队伍不拦（alice@wt1 vs bob@wt2）');
dmg.called = null;
WAR.config.team.friendlyFire = true;
REG.beforeHurt[0](hurtSame);
assert(dmg.called === null, 'CONFIG 打开队内伤害后不拦');
WAR.config.team.friendlyFire = false;

// 9) 解散
var srvCmdsBefore = srvT.cmds.length;
runPath(registeredRoot, ['team', 'disband'], sA);
assert(WAR.team.byId('wt1') == null, 'disband：队伍从 L1 删除');
assert(WAR.team.state().byPlayer['uuid-a'] === undefined, 'disband：成员反查清空');
assert(srvT.cmds.slice(srvCmdsBefore).join(' ; ').indexOf('team remove wt1') >= 0, 'disband：计分板 team remove 下发');
assert(WAR.team.byId('wt2') != null, '其他队伍不受影响（wt2 仍在）');

// 10) 审计留痕
var acts = {};
var audItems = WAR.audit.tail(WAR.audit.count());
for (var qi = 0; qi < audItems.length; qi++) acts[audItems[qi].action] = (acts[audItems[qi].action] || 0) + 1;
assert((acts['team.create'] || 0) >= 2 && (acts['team.invite'] || 0) >= 3 && (acts['team.accept'] || 0) >= 2 &&
       (acts['team.leave'] || 0) >= 1 && (acts['team.kick'] || 0) >= 1 && (acts['team.disband'] || 0) >= 1,
       '审计留痕覆盖 create/invite/accept/leave/kick/disband（实测 ' + JSON.stringify(acts) + '）');

// ================================================================ T8 战服物品注册（startup_scripts）
console.log('\n--- T8 war_items.js（kubejs:credit）---');
var WAR_ITEMS_PATH = path.join(INST, 'minecraft/kubejs/startup_scripts/war_items.js');
var warItemsSrc = fs.readFileSync(WAR_ITEMS_PATH, 'utf8');
vm.runInThisContext(warItemsSrc, { filename: WAR_ITEMS_PATH });

var itemRegs = STARTUP.filter(function (x) { return x.type === 'item'; });
assert(itemRegs.length === 1, 'war_items.js 只注册了 1 个物品（实际 ' + itemRegs.length + '）');
assert(itemRegs[0].id === 'kubejs:credit', '注册 id = kubejs:credit（实际 ' + itemRegs[0].id + '）');
var idParts = itemRegs[0].id.split(':');
assert(idParts.length === 2 && 'item.' + idParts[0] + '.' + idParts[1] === 'item.kubejs.credit',
       '默认 lang 键拼接 = item.kubejs.credit（只验字符串，不要求资源存在）');
assert(/^[a-z0-9_]+:item\/[a-z0-9_\/]+$/.test(itemRegs[0].builder.texturePath || ''),
       '贴图路径形如 <ns>:item/<path>（实际 ' + itemRegs[0].builder.texturePath + '）');
// 贴图必须复用本包既有资源：与 mw_tacz_registry.js 里已上机运行过的 .texture(...) 之一相同
var mwRegSrc = fs.readFileSync(path.join(INST, 'minecraft/kubejs/startup_scripts/mw_tacz_registry.js'), 'utf8');
var existingTextures = {};
var tm = mwRegSrc.match(/\.texture\('([^']+)'\)/g) || [];
for (var ti = 0; ti < tm.length; ti++) existingTextures[tm[ti].replace(/^\.texture\('/, '').replace(/'\)$/, '')] = true;
assert(existingTextures[itemRegs[0].builder.texturePath] === true,
       '贴图复用既有资源（在 mw_tacz_registry.js 已上机的 ' + Object.keys(existingTextures).length + ' 种贴图内）');
assert(warItemsSrc.indexOf('war.credit') >= 0 && warItemsSrc.indexOf('kubejs:credit') >= 0,
       '文件头写明了 id 与账本键 war.credit 的对应关系（同一件东西的两面）');
assert(warItemsSrc.indexOf('30_economy.js') >= 0, '文件头指明账本逻辑归 30_economy.js（本文件不写账本）');
assert(warItemsSrc.indexOf('WAR.econ') < 0 && warItemsSrc.indexOf('balance') < 0,
       'war_items.js 只注册物品、不碰账本');

// ================================================================ T9 经济：账本与物品双向兑换
console.log('\n--- T9 经济：账本↔物品（30_economy.js）---');
function fakeCreditCount(p) {
  var inv = p.inventory, n = 0;
  for (var i = 0; i < inv.getSlots(); i++) { var s = inv.getStackInSlot(i); if (s != null && s.id === 'kubejs:credit') n += s.count; }
  return n;
}
var srvE = new FakeServer();
srvE.persistentData = server3.persistentData;
var pA = new FakePlayer('eve', 'uuid-eve'), pB = new FakePlayer('mallory', 'uuid-mal');
srvE.players = [pA, pB];
WAR.data.bind(srvE);
REG.loaded[0]({ server: srvE });
var e0 = WAR.data.state.econ;
e0.balance = {}; e0.minted = 0; e0.burned = 0; e0.withdrawn = 0; e0.deposited = 0; e0.ops = {}; e0.journal = [];
assert(WAR.econ.__stub === false && WAR.econ.__owner === '30_economy.js', 'econ 已实现（__stub=false）');
assert(WAR.econ.config.currencyItem === 'kubejs:credit' && WAR.econ.config.startBalance === 0 &&
       WAR.econ.config.payMin === 1 && WAR.econ.config.payMax === 1000 && WAR.econ.config.feeEnabled === false,
       'ECON_CONFIG 暂定默认值：初始 0 / 最小 1 / 单笔上限 1000 / 无手续费');
assert(WAR.econ.balanceOf('uuid-eve') === 0, '初始余额 0（startBalance 暂定默认值）');
assert(WAR.econ.balanceOf('uuid-eve') === 0 && WAR.econ.mint('console', 'uuid-eve', 100, null).ok === true &&
       WAR.econ.balanceOf('uuid-eve') === 100, 'admin give 100 → 账本 100');
assert(WAR.econ.mint('console', 'uuid-eve', 0, null).ok === false, '金额 0 被拒（payMin=1）');
assert(WAR.econ.mint('console', 'uuid-eve', 1001, null).ok === false, '金额 1001 被拒（payMax=1000）');
var pay1 = WAR.econ.pay('eve', 'uuid-eve', 'uuid-mal', 30, null);
assert(pay1.ok === true && WAR.econ.balanceOf('uuid-eve') === 70 && WAR.econ.balanceOf('uuid-mal') === 30, 'pay 30 → 70/30');
var payR1 = WAR.econ.pay('eve', 'uuid-eve', 'uuid-mal', 5, 'op-replay-1');
var balAfterR1 = WAR.econ.balanceOf('uuid-eve');
var payR2 = WAR.econ.pay('eve', 'uuid-eve', 'uuid-mal', 5, 'op-replay-1');
assert(payR2.replayed === true && WAR.econ.balanceOf('uuid-eve') === balAfterR1, '同 opId 重放不重复扣款（余额不变）');
assert(WAR.econ.pay('eve', 'uuid-eve', 'uuid-mal', 1000, null).ok === false && WAR.econ.balanceOf('uuid-eve') >= 0, '超额转账被拒且余额不为负');
var drain = WAR.econ.pay('eve', 'uuid-eve', 'uuid-mal', WAR.econ.balanceOf('uuid-eve'), null);
assert(drain.ok === true && WAR.econ.balanceOf('uuid-eve') === 0, '转空后余额恰为 0（不为负）');
assert(WAR.econ.pay('eve', 'uuid-eve', 'uuid-mal', 1, null).ok === false, '零余额再转 1 被拒');
WAR.econ.mint('console', 'uuid-eve', 50, null);
assert(fakeCreditCount(pA) === 0, '此时背包里还没有货币物品');
var wd = WAR.econ.withdraw('eve', pA, 20, null);
assert(wd.ok === true && WAR.econ.balanceOf('uuid-eve') === 30, 'withdraw 20：账本 50→30');
assert(fakeCreditCount(pA) === 20, 'withdraw 20：背包 +20 件 kubejs:credit');
assert(WAR.econ.withdraw('eve', pA, 999, null).ok === false && WAR.econ.balanceOf('uuid-eve') === 30, 'withdraw 超余额被拒且账本不变');
var dep = WAR.econ.deposit('eve', pA, 15, null);
assert(dep.ok === true && WAR.econ.balanceOf('uuid-eve') === 45, 'deposit 15：账本 30→45');
assert(fakeCreditCount(pA) === 5, 'deposit 15：背包 20→5 件');
assert(WAR.econ.deposit('eve', pA, 99, null).ok === false && WAR.econ.balanceOf('uuid-eve') === 45, 'deposit 超持有被拒且账本不变');
var invE = WAR.econ.invariant();
assert(invE.ok === true, '不变量 Σbalance = minted - burned - withdrawn + deposited（Δ=' + invE.delta + '）');
var pC = new FakePlayer('packed', 'uuid-packed');
srvE.players.push(pC);
WAR.econ.mint('console', 'uuid-packed', 100, null);
for (var si2 = 0; si2 < 36; si2++) pC.inventory.setStackInSlot(si2, new FakeStack('minecraft:stone', 64));
var balPacked = WAR.econ.balanceOf('uuid-packed');
var wdFull = WAR.econ.withdraw('packed', pC, 10, null);
assert(wdFull.ok === false && wdFull.rolledBack === 10, '背包满时 withdraw 失败并回滚 10（rolledBack=' + wdFull.rolledBack + '）');
assert(WAR.econ.balanceOf('uuid-packed') === balPacked, '回滚后账本恢复原值');
assert(WAR.econ.invariant().ok === true, '回滚后不变量仍成立');
var pD = new FakePlayer('partial', 'uuid-partial');
srvE.players.push(pD);
WAR.econ.mint('console', 'uuid-partial', 100, null);
for (var si3 = 0; si3 < 35; si3++) pD.inventory.setStackInSlot(si3, new FakeStack('minecraft:stone', 64));
pD.inventory.setStackInSlot(35, new FakeStack('kubejs:credit', 59));   // 只剩 5 个空位
var balPartial = WAR.econ.balanceOf('uuid-partial');
var itemsPartial = fakeCreditCount(pD);
var wdPart = WAR.econ.withdraw('partial', pD, 10, null);
assert(wdPart.ok === false && wdPart.rolledBack === 5, '部分放得下时只回滚未发放的 5（rolledBack=' + wdPart.rolledBack + '）');
assert(WAR.econ.balanceOf('uuid-partial') === balPartial - 5, '账本只扣实际发放的 5（' + balPartial + '→' + WAR.econ.balanceOf('uuid-partial') + '）');
assert(fakeCreditCount(pD) === itemsPartial + 5, '物品只多了实际放入的 5 件');
assert(WAR.econ.invariant().ok === true, '部分发放后不变量仍成立');
var acts3 = {};
var jl = WAR.audit.tail(WAR.audit.count());
for (var qi3 = 0; qi3 < jl.length; qi3++) acts3[jl[qi3].action] = (acts3[jl[qi3].action] || 0) + 1;
assert((acts3['econ.mint'] || 0) >= 2 && (acts3['econ.pay'] || 0) >= 2 && (acts3['econ.withdraw'] || 0) >= 2 && (acts3['econ.deposit'] || 0) >= 1,
       '审计留痕覆盖 econ.mint/pay/withdraw/deposit（实测 ' + JSON.stringify(acts3) + '）');
assert(WAR.econ.journalText(3).split(' | ').length === 3, '经济流水可回看（journal）');

// ================================================================ T10 常量迁移与首见发放
console.log('\n--- T10 ECON_CONFIG 单一起源 + firstJoinGrant ---');
assert(typeof global.ECON_CONFIG !== 'undefined' && global.ECON_CONFIG === WAR.config.econ,
       'ECON_CONFIG 是 WAR_CONFIG.econ 的别名（数值单一起源，全局只有一份）');
var econVals = {
  currencyItem: 'kubejs:credit', ledgerKey: 'war.credit', startBalance: 0, firstJoinGrant: 0,
  payMin: 1, payMax: 1000, feeEnabled: false, feeRate: 0, maxBalance: 1000000, journalSize: 200, opMemory: 200
};
var econBad = [];
for (var ek in econVals) if (econVals.hasOwnProperty(ek) && WAR.config.econ[ek] !== econVals[ek]) econBad.push(ek + '=' + WAR.config.econ[ek]);
assert(econBad.length === 0, '迁移后 11 项数值逐项一致' + (econBad.length ? '（不符：' + econBad.join(',') + '）' : ''));
var pNew = new FakePlayer('newbie', 'uuid-newbie');
srvE.players.push(pNew);
var balNew0 = WAR.econ.balanceOf('uuid-newbie');
for (var li = 0; li < REG.loggedIn.length; li++) REG.loggedIn[li]({ player: pNew });
assert(WAR.econ.balanceOf('uuid-newbie') === balNew0, 'firstJoinGrant=0 时首次进服不发放（余额不变）');
assert(WAR.data.state.econ.joined['uuid-newbie'] != null, '首次进服被记入 joined');
var joinAudit = WAR.audit.tail(WAR.audit.count()).filter(function (x) { return x.action === 'econ.firstJoin'; });
assert(joinAudit.length >= 1 && joinAudit[joinAudit.length - 1].result === 'skip', '审计记录 econ.firstJoin=skip（暂定 0 未发放）');
WAR.config.econ.firstJoinGrant = 5;
var pNew2 = new FakePlayer('newbie2', 'uuid-newbie2');
srvE.players.push(pNew2);
for (var lj = 0; lj < REG.loggedIn.length; lj++) REG.loggedIn[lj]({ player: pNew2 });
assert(WAR.econ.balanceOf('uuid-newbie2') === 5, '把 firstJoinGrant 临时设为 5 后首次进服到账 5（机制可用，数值待定）');
for (var lk = 0; lk < REG.loggedIn.length; lk++) REG.loggedIn[lk]({ player: pNew2 });
assert(WAR.econ.balanceOf('uuid-newbie2') === 5, '再次触发进服不重复发放（joined + opId 双重幂等）');
WAR.config.econ.firstJoinGrant = 0;
assert(WAR.config.econ.firstJoinGrant === 0, '恢复暂定默认值 0');
assert(WAR.econ.invariant().ok === true, '首见发放后不变量仍成立');

// ================================================================ T11 OP 谓词统一（抽取步骤 1）
console.log('\n--- T11 OP 谓词统一 ---');
assert(typeof WAR.opPredicate === 'function', 'WAR.opPredicate 已暴露给各域');
var opDef = WAR.opPredicate();
assert(opDef(new FakeSource(1, null)) === false && opDef(new FakeSource(2, null)) === true,
       '缺省 level = WAR_CONFIG.admin.commandPermissionLevel（1 拒 / 2 过）');
var op4 = WAR.opPredicate(4);
assert(op4(new FakeSource(2, null)) === false && op4(new FakeSource(4, null)) === true, '显式 level 生效（2 拒 / 4 过）');
assert(opDef(new FakeSource(3, null)) === true && opDef(new FakeSource(2, null)) === true, '同一谓词重复调用结果稳定');
var adminNode2 = findChild(registeredRoot, 'admin');
assert(adminNode2.requires_(new FakeSource(1, null)) === false && adminNode2.requires_(new FakeSource(2, null)) === true,
       '/war admin 权限行为与重构前一致');
var moneyAdminNode = findChild(findChild(registeredRoot, 'money'), 'admin');
assert(moneyAdminNode != null && typeof moneyAdminNode.requires_ === 'function', '/war money admin 挂了 requires 谓词');
assert(moneyAdminNode.requires_(new FakeSource(1, null)) === false && moneyAdminNode.requires_(new FakeSource(2, null)) === true,
       '/war money admin 权限行为一致（此前没有断言，这次补上）');

// ================================================================ T12 整数参数与钳位归一（抽取步骤 2）
console.log('\n--- T12 warIntArg / warClampInt ---');
assert(typeof WAR.intArg === 'function' && typeof WAR.clampInt === 'function', 'WAR.intArg / WAR.clampInt 已暴露');
var fakeInt = { getResult: function (ctx, n) { return ctx.args[n]; } };
assert(WAR.intArg(fakeInt, { args: { n: 7 } }, 'n', 20) === 7, '正常整数原样返回');
assert(WAR.intArg(fakeInt, { args: { n: '42' } }, 'n', 20) === 42, '数字字符串解析为整数');
assert(WAR.intArg(fakeInt, { args: { n: 'abc' } }, 'n', 20) === 20, '非数字回落 dft（不再外泄 NaN）');
assert(WAR.intArg(fakeInt, { args: {} }, 'n', 20) === 20, '缺参数回落 dft');
assert(WAR.intArg({ getResult: function () { throw new Error('boom'); } }, { args: {} }, 'n', -1) === -1, 'getResult 抛异常回落 dft');
assert(WAR.intArg(fakeInt, { args: { n: '-3' } }, 'n', 20) === -3, '负数原样返回（本层不钳位，交业务校验）');
assert(WAR.clampInt(5, 1, 10, 3) === 5, '钳位：区间内原样');
assert(WAR.clampInt(0, 1, 10, 3) === 1 && WAR.clampInt(99, 1, 10, 3) === 10, '钳位：越界夹到端点');
assert(WAR.clampInt('abc', 1, 10, 4) === 4 && WAR.clampInt(undefined, 1, 10, 4) === 4, '钳位：非数字回落 dft 再夹');
assert(WAR.clampInt(Infinity, 1, 10, 4) === 4, '钳位：Infinity 回落 dft（对齐 spClampNum 的 !isFinite 分支，不是夹到上界）');
assert(WAR.clampInt(3.6, 1, 10, 4) === 4 && WAR.clampInt(7.2, 1, 10, 4) === 7, '钳位：小数四舍五入（对齐 spClampInt 的 Math.round）');
// 端到端①：/war admin audit [n] 的 n 现在过 warIntArg + warClampInt
var sAudit0 = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'audit', 'n'], sAudit0, { n: 0 });
var msg0 = sAudit0.messages.join(' ');
function countAuditEntries(m) { var mm = m.match(/#\d+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g); return mm ? mm.length : 0; }
var cnt0 = countAuditEntries(msg0);
assert(cnt0 === 1, '/war admin audit 0 → 夹到 1 条（实际 ' + cnt0 + ' 条）');
var sAuditBig = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'audit', 'n'], sAuditBig, { n: 999 });
var cntBig = countAuditEntries(sAuditBig.messages.join(' '));
assert(cntBig === WAR.audit.count(), '/war admin audit 999 → 夹到 bufferSize，等于当前审计条数（' + cntBig + '）');
assert(cntBig <= WAR.config.audit.bufferSize, '输出条数不超过审计缓冲上限 ' + WAR.config.audit.bufferSize);
// 端到端②：/war money withdraw <非整数> → -1 哨兵被 econCheckAmount 拒绝，余额不变
var pZ = new FakePlayer('zero', 'uuid-zero');
srvE.players.push(pZ);
WAR.econ.mint('console', 'uuid-zero', 40, null);
var sZ = new FakeSource(0, pZ);
var balZ0 = WAR.econ.balanceOf('uuid-zero');
runPath(registeredRoot, ['money', 'withdraw', 'amount'], sZ, { amount: 'abc' });
assert(sZ.messages.join(' ').indexOf('必须为正整数') >= 0, '非整数金额被拒并给出原因（实际：' + sZ.messages.join(' ').slice(0, 40) + '）');
assert(WAR.econ.balanceOf('uuid-zero') === balZ0, '被拒后余额不变');
assert(WAR.econ.invariant().ok === true, '步骤 2 后端到端不变量仍成立');

// ================================================================ T13 warPlayerArg（抽取步骤 3）
console.log('\n--- T13 warPlayerArg ---');
assert(typeof WAR.playerArg === 'function', 'WAR.playerArg 已暴露');
var fakePA = { getResult: function (ctx, n) { return (ctx.args && ctx.args[n] !== undefined) ? ctx.args[n] : null; } };
var tgtP = new FakePlayer('tgt', 'uuid-tgt');
assert(WAR.playerArg(fakePA, { args: { player: tgtP } }, 'player') === tgtP, '有效玩家：返回同一对象（与替换前 getResult 结果一致）');
assert(WAR.playerArg(fakePA, { args: {} }, 'player') === null, '缺参数：返回 null');
assert(WAR.playerArg(fakePA, { args: { player: null } }, 'player') === null, '参数为 null：返回 null');
assert(WAR.playerArg({ getResult: function () { throw new Error('boom'); } }, { args: {} }, 'player') === null, 'getResult 抛异常：返回 null（原来 10_team 裸调会外泄）');
var teamSrc3 = fs.readFileSync(WAR_DIR + '/10_team.js', 'utf8');
assert(teamSrc3.indexOf('WAR_TEAM.invite(a, Arguments.PLAYER.getResult') < 0 &&
       teamSrc3.indexOf('WAR_TEAM.kick(a, Arguments.PLAYER.getResult') < 0,
       '10_team 两处调用点已无裸调 getResult（只看调用点，不算头注释）');
assert(teamSrc3.split('warPlayerArg(Arguments.PLAYER, ctx').length - 1 === 2, '10_team 两处取参都换成 warPlayerArg(Arguments.PLAYER, ctx, ...)');
var econSrc3 = fs.readFileSync(WAR_DIR + '/30_economy.js', 'utf8');
assert(econSrc3.split('warPlayerArg(Arguments.PLAYER, ctx, name)').length - 1 === 1, '30_economy 的 playerOf 已改为一行绑定');
assert(econSrc3.indexOf('warIntArg(I, ctx') < 0, '30_economy 已不再把 create(event) 的结果当包装对象传（回归防线）');
assert(WAR.intArg({ type: 'integer' }, { args: { n: 3 } }, 'n', 9) === 9, '传错对象（create 的结果，无 getResult）时回落 dft，不静默出错值');
assert(WAR.data.warned['argwrap-int'] === true, '传错对象会告警一次（不再静默）');
assert(WAR.playerArg({ type: 'player' }, { args: {} }, 'player') === null, 'warPlayerArg 同守卫：返回 null');
// 自足前置：T9 的 boot 会用落盘数据覆盖内存 teams（T7 的 wt2 不保证还在），所以 T13 自己建队
var capT13 = new FakePlayer('cap13', 'uuid-cap13');
srvE.players.push(capT13);
var sCap = new FakeSource(0, capT13);
runPath(registeredRoot, ['team', 'create', 'name'], sCap, { name: '取参队' });
assert(WAR.team.of(capT13) != null, 'T13 前置：自建队伍成功');
var srcNoT = new FakeSource(0, capT13);
runPath(registeredRoot, ['team', 'invite', 'player'], srcNoT, {});
assert(srcNoT.messages.join('') === '找不到目标玩家（当前仅支持在线玩家）', 'invite 出错分支：文案逐字未变');
var srcNoK = new FakeSource(0, capT13);
runPath(registeredRoot, ['team', 'kick', 'player'], srcNoK, {});
assert(srcNoK.messages.join('') === '找不到目标玩家', 'kick 出错分支：文案逐字未变');
var guest3 = new FakePlayer('guest', 'uuid-guest');
srvE.players.push(guest3);
var srcInv3 = new FakeSource(0, capT13);
runPath(registeredRoot, ['team', 'invite', 'player'], srcInv3, { player: guest3 });
assert(srcInv3.messages.join('') === '已邀请 guest（300 秒内有效）', 'invite 成功路径：文案逐字未变');
var t13team = WAR.team.of(capT13);
assert(t13team != null && t13team.invites.filter(function (iv) { return iv.uuid === 'uuid-guest'; }).length === 1,
       'invite 成功：邀请确实落到 L1（统一取参链路打通）');

// ================================================================ T14 经济命令路径（有效金额）
console.log('\n--- T14 经济命令路径（有效金额；专为抓 intOf 传参回归）---');
var pCmd = new FakePlayer('cmduser', 'uuid-cmduser');
srvE.players.push(pCmd);
WAR.econ.mint('console', 'uuid-cmduser', 100, null);
var balCmd0 = WAR.econ.balanceOf('uuid-cmduser');
var sW = new FakeSource(0, pCmd);
runPath(registeredRoot, ['money', 'withdraw', 'amount'], sW, { amount: 25 });
assert(WAR.econ.balanceOf('uuid-cmduser') === balCmd0 - 25, '命令路径 /war money withdraw 25 真扣 25（回归断言）');
assert(fakeCreditCount(pCmd) === 25, '命令路径 withdraw：真的拿到 25 件');
var sD = new FakeSource(0, pCmd);
runPath(registeredRoot, ['money', 'deposit', 'amount'], sD, { amount: 10 });
assert(WAR.econ.balanceOf('uuid-cmduser') === balCmd0 - 15, '命令路径 /war money deposit 10 账本 +10');
assert(fakeCreditCount(pCmd) === 15, '命令路径 deposit：物品 -10');
var balTarget0 = WAR.econ.balanceOf('uuid-zero');
var sP = new FakeSource(0, pCmd);
runPath(registeredRoot, ['money', 'pay', 'player', 'amount'], sP, { player: pZ, amount: 5 });
assert(WAR.econ.balanceOf('uuid-cmduser') === balCmd0 - 20, '命令路径 pay：付款方 -5');
assert(WAR.econ.balanceOf('uuid-zero') === balTarget0 + 5, '命令路径 pay：收款方 +5');
assert(WAR.econ.invariant().ok === true, 'T14 后不变量仍成立');

// ================================================================ T15 warWarnOnce 归一（抽取步骤 5）
console.log('\n--- T15 warWarnOnce 归一 ---');
var econSrc5 = fs.readFileSync(WAR_DIR + '/30_economy.js', 'utf8');
assert(econSrc5.indexOf('function econWarnOnce') < 0, 'econWarnOnce 包裱已删除（不再有第二层）'.replace('裱', '装'));
assert(econSrc5.split('warWarnOnce(').length - 1 === 3, '30_economy 直接调用核心 warWarnOnce 共三处');
assert(econSrc5.indexOf("warWarnOnce('econ-count'") >= 0 && econSrc5.indexOf("warWarnOnce('econ-take'") >= 0 &&
       econSrc5.indexOf("warWarnOnce('econ-give'") >= 0,
       '三处告警键与替换前逐字一致（econ-count / econ-take / econ-give）');
// 三条真实失败路径各触发一次，证明调用点仍然走到核心工具且键不变
var pBadCount = new FakePlayer('badcount', 'uuid-badcount');
srvE.players.push(pBadCount);
pBadCount.inventory = { getSlots: function () { throw new Error('boom'); } };
var rBadCount = WAR.econ.deposit('tester', pBadCount, 1, null);
assert(rBadCount.ok === false && rBadCount.error === '背包不可用', '清点失败 → deposit 返回口径不变');
assert(WAR.data.warned['econ-count'] === true, '清点失败路径：键 econ-count 在位（直呼核心工具成功）');
var pBadTake = new FakePlayer('badtake', 'uuid-badtake');
srvE.players.push(pBadTake);
// 让「清点成功、取物时访问背包才抛」—— 这是 econ-take 告警唯一可达的路径
var slotsCalls = 0;
pBadTake.inventory = {
  getSlots: function () { slotsCalls++; if (slotsCalls >= 2) throw new Error('slots-boom'); return 1; },
  getStackInSlot: function () { return new FakeStack('kubejs:credit', 3); },
  extractItem: function () { throw new Error('extract-boom'); }
};
var balBadTake = WAR.econ.balanceOf('uuid-badtake');
var rBadTake = WAR.econ.deposit('tester', pBadTake, 2, null);
assert(rBadTake.ok === false && WAR.econ.balanceOf('uuid-badtake') === balBadTake, '取物异常 → 账本回滚（余额不变）');
assert(WAR.data.warned['econ-take'] === true, '取物前访问背包抛异常：键 econ-take 在位');
// 观察（未改代码）：单槽 extractItem 抛异常走内层 catch（got=null→break），不写告警，只靠 rollback 文案暴露给玩家
var pOneSlot = new FakePlayer('oneslot', 'uuid-oneslot');
srvE.players.push(pOneSlot);
pOneSlot.inventory = {
  getSlots: function () { return 1; },
  getStackInSlot: function () { return new FakeStack('kubejs:credit', 3); },
  extractItem: function () { throw new Error('extract-boom'); }
};
var rOneSlot = WAR.econ.deposit('tester', pOneSlot, 2, null);
assert(rOneSlot.ok === false && rOneSlot.rolledBack === 2, '单槽取物失败：按实际取到 0 件回滚 2（文案走 rollback）');
var pBadGive = new FakePlayer('badgive', 'uuid-badgive');
srvE.players.push(pBadGive);
pBadGive.inventory = { getSlots: function () { return 0; }, insertItem: function () { throw new Error('give-boom'); } };
pBadGive.give = function () { throw new Error('give-boom'); };
WAR.econ.mint('console', 'uuid-badgive', 10, null);
var balBadGive = WAR.econ.balanceOf('uuid-badgive');
var rBadGive = WAR.econ.withdraw('tester', pBadGive, 5, null);
assert(rBadGive.ok === false && WAR.econ.balanceOf('uuid-badgive') === balBadGive, '发币异常 → 账本回滚（余额不变）');
assert(WAR.data.warned['econ-give'] === true, '发币失败路径：键 econ-give 在位');
assert(WAR.econ.invariant().ok === true, 'T15 后不变量仍成立');
// warn-once 语义本身：同名第二次不再报（数 console.error 次数）
var errN = 0; var origErr2 = console.error;
console.error = function () { errN++; };
warWarnOnce('t15-once', '第一次');
warWarnOnce('t15-once', '第二次');
console.error = origErr2;
assert(errN === 1 && WAR.data.warned['t15-once'] === true, 'warWarnOnce 同名只报一次（第二次静默），已记录该键');

// ================================================================ T16 actorName 归一（抽取步骤 4a）
console.log('\n--- T16 actorName 归一 ---');
assert(typeof WAR.actorName === 'function', 'WAR.actorName 已由 core 导出');
var pActor = new FakePlayer('actorx', 'uuid-actorx');
assert(WAR.actorName(new FakeSource(0, pActor)) === WAR.nameOf(pActor), '有玩家：等于 WAR.nameOf(玩家)（与原两处实现一致）');
assert(WAR.actorName(new FakeSource(0, pActor)) === 'actorx', '有玩家：实际返回玩家名');
assert(WAR.actorName(new FakeSource(0, null)) === 'console', '无玩家（控制台）：返回 console（与原实现一致）');
assert(WAR.actorName({ getPlayer: function () { throw new Error('x'); } }) === 'console', 'getPlayer 抛异常：返回 console（与原实现一致）');
var teamSrc4 = fs.readFileSync(WAR_DIR + '/10_team.js', 'utf8');
assert(teamSrc4.indexOf('currentSource = ctx.source') >= 0, '隐式契约保留：actorOf 仍为 currentSource 赋值（werr 依赖）');
assert(teamSrc4.indexOf('name: WAR.actorName(ctx.source)') >= 0 && teamSrc4.indexOf('name: WAR.nameOf(p)') < 0, '10_team 取名改用 WAR.actorName(source)');
var econSrc4 = fs.readFileSync(WAR_DIR + '/30_economy.js', 'utf8');
assert(econSrc4.indexOf('function actorName(ctx) { return WAR.actorName(ctx.source); }') >= 0, '30_economy 的 actorName 改为传 source 的薄包装');
assert(econSrc4.indexOf('function actorName(ctx) { try { var p = ctx.source.getPlayer()') < 0, '30_economy 的 actorName 不再自己取 player 取名（断言收窄到该函数，selfPlayer 仍是 4a 范围之外）');
var pActor2 = new FakePlayer('actorpay', 'uuid-actorpay');
srvE.players.push(pActor2);
WAR.econ.mint('console', 'uuid-actorpay', 30, null);
var sActorPay = new FakeSource(0, pActor2);
runPath(registeredRoot, ['money', 'pay', 'player', 'amount'], sActorPay, { player: pZ, amount: 3 });
var payAudit4 = WAR.audit.tail(WAR.audit.count()).filter(function (x) { return x.action === 'econ.pay'; });
assert(payAudit4.length >= 1 && payAudit4[payAudit4.length - 1].actor === 'actorpay',
       '端到端：玩家执行时审计 actor = 玩家名（实测 ' + (payAudit4.length ? payAudit4[payAudit4.length - 1].actor : '无') + '）');
var sConsole4 = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'save'], sConsole4, {});
var saveAudit4 = WAR.audit.tail(WAR.audit.count()).filter(function (x) { return x.action === 'admin.save'; });
assert(saveAudit4.length >= 1 && saveAudit4[saveAudit4.length - 1].actor === 'cmd:console',
       '端到端：控制台执行时审计 actor = cmd:console（无玩家分支价值不变）');
assert(WAR.econ.invariant().ok === true, 'T16 后不变量仍成立');

// ================================================================ T17 /war admin（90_admin.js，D1-a 搬移 + 四条批准项）
console.log('\n--- T17 /war admin（90_admin.js）---');
// ① admin 字面量只有一份 + 权限门
var adminNodes = [];
for (var an = 0; an < registeredRoot.children.length; an++) {
  if (registeredRoot.children[an].name === 'admin') adminNodes.push(registeredRoot.children[an]);
}
assert(adminNodes.length === 1, '/war admin 在命令树里只有一份（D1-a：不留第二个字面量，实际 ' + adminNodes.length + ' 份）');
var adminNode = adminNodes[0];
assert(typeof adminNode.requires_ === 'function', '/war admin 有权限门');
assert(adminNode.requires_(new FakeSource(1, null)) === false && adminNode.requires_(new FakeSource(2, null)) === true,
       '/war admin 权限门：level1 拒 / level2 过');
var adminSubs = ['status', 'audit', 'save', 'help', 'domains', 'tasks', 'profile', 'auditf'];
for (var asn = 0; asn < adminSubs.length; asn++) {
  assert(findChild(adminNode, adminSubs[asn]) != null, '/war admin ' + adminSubs[asn] + ' 子命令存在');
}
// ② 四个**新增**子命令的权限门（level1 不可达且无回显 / level2 可达）
var newSubs = ['domains', 'tasks', 'profile', 'auditf'];
var pProfForGate = new FakePlayer('gate', 'uuid-gate');   // 供 profile 权限门测试用（不出现在输出断言里）
for (var nsn = 0; nsn < newSubs.length; nsn++) {
  var subNode = findChild(adminNode, newSubs[nsn]);
  var sLow = new FakeSource(1, null);
  runPath(registeredRoot, ['admin', newSubs[nsn]], sLow, {});
  assert(sLow.messages.length === 0, 'level1 时 /war admin ' + newSubs[nsn] + ' 不可达（无回显，继承 admin 的权限门）');
  var sHigh = new FakeSource(2, null);
  var hiPath = (newSubs[nsn] === 'profile') ? ['admin', 'profile', 'player'] : ['admin', newSubs[nsn]];
  runPath(registeredRoot, hiPath, sHigh, { player: pProfForGate });
  assert(sHigh.messages.length === 1, 'level2 时 /war admin ' + newSubs[nsn] + ' 可达');
}
// ③ status 逐字：14 段键名/顺序 + 同一快照整串全等 + 关键段与 state 独立对账
var sSt1 = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'status'], sSt1, {});
var st1 = sSt1.messages.join('');
var stSegs = st1.split(' | ');
var expectKeys = ['OP 自检', 'ready=', 'java桥=', 'dirty=', '存储键=', 'NBT键=', 'bootCount=', '队伍=', '玩家映射=', '审计=', 'lastLoad=', 'lastSave=', 'tick=', '定时器='];
assert(stSegs.length === expectKeys.length, '/war admin status 恰好 ' + expectKeys.length + ' 段（实际 ' + stSegs.length + '）');
for (var sk = 0; sk < expectKeys.length; sk++) {
  assert(stSegs[sk].indexOf(expectKeys[sk]) === 0, '第 ' + (sk + 1) + ' 段以「' + expectKeys[sk] + '」开头');
}
var sSt2 = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'status'], sSt2, {});
assert(sSt2.messages.join('') === st1, '同一状态快照下两次 /war admin status 整串全等（值也是逐字，不只是键序）');
assert(stSegs[6] === 'bootCount=' + WAR.data.state.bootCount, 'bootCount 段与 state 对账一致');
assert(stSegs[7] === '队伍=' + Object.keys(WAR.data.state.teams.byId).length, '队伍 段与 state 对账一致');
assert(stSegs[8] === '玩家映射=' + Object.keys(WAR.data.state.teams.byPlayer).length, '玩家映射 段与 state 对账一致');
assert(stSegs[9] === '审计=' + WAR.audit.count() + '/' + WAR.config.audit.bufferSize + '（丢帧 ' + WAR.data.state.audit.dropped + '）', '审计 段与 state 对账一致');
assert(/^tick=\d+$/.test(stSegs[12]) && stSegs[13] === '定时器=' + WAR.timers().length, 'tick 段为数字、定时器段与 WAR.timers() 对账一致');
// ④ domains：8 域 + 形状 + implemented 真假 + stubStatus 接管
var sDom = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'domains'], sDom, {});
var domMsg = sDom.messages.join('');
assert(domMsg.indexOf('域状态(8)') === 0, '/war admin domains 输出 8 域总览');
assert(domMsg.indexOf('team=on(') >= 0 && domMsg.indexOf('econ=on(') >= 0 && domMsg.indexOf('claim=off(') >= 0, 'domains 里 on/off 与实现状态相符');
var domObj = WAR.admin.domains();
var domNames = ['team', 'econ', 'spawn', 'claim', 'base', 'trade', 'shop', 'think'];
for (var dn = 0; dn < domNames.length; dn++) {
  var dN = domNames[dn], dS = domObj[dN];
  assert(dS != null && dS.domain === dN && typeof dS.implemented === 'boolean' && dS.owner != null, '域 ' + dN + ' 的 status 形状正确');
}
assert(domObj.team.implemented === true && domObj.econ.implemented === true, '已实现域标记 implemented=true（team/econ）');
assert(domObj.spawn.implemented === false, 'spawn 在本 harness 里仍是 stub（20_spawn.js 属他人文件、白名单不加载）——断言口径与实际加载面一致');
assert(domObj.claim.implemented === false && domObj.think.implemented === false, '未实现域标记 implemented=false（claim/think）');
assert(typeof WAR.stubStatus === 'function' && WAR.stubStatus().team.implemented === true,
       'WAR.stubStatus 已被 90_admin 接管，team 报真实状态（core 旧聚合用的是 WAR_TEAM_STUB，永远 false）');
assert(WAR.admin.status().implemented === true && WAR.admin.status().readOnly === true, 'WAR.admin.status() 声明 implemented + readOnly');
// ⑤ tasks：与 WAR.timers() 注册表一致
var tasks = WAR.timers();
var tLabels = tasks.map(function (t) { return t.label; });
assert(tLabels.indexOf('team.invite-expire') >= 0, '定时器注册表含 team.invite-expire');
var sTk = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'tasks'], sTk, {});
var tkMsg = sTk.messages.join('');
assert(tkMsg.indexOf('定时任务(' + tasks.length + ')') === 0, '/war admin tasks 条数与 WAR.timers() 一致');
var tkMissing = null;
for (var tl = 0; tl < tLabels.length; tl++) if (tkMsg.indexOf(tLabels[tl] + '(') < 0) { tkMissing = tLabels[tl]; break; }
assert(tkMissing == null, '/war admin tasks 列出了全部 label' + (tkMissing == null ? '' : '（漏 ' + tkMissing + '）'));
// ⑥ auditf：无过滤 == audit <n>；单条件过滤逐条匹配
var sAf0 = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'auditf', 'n'], sAf0, { n: 7 });
assert(sAf0.messages.join('') === WAR.audit.text(7), 'auditf 无过滤条件时与 /war admin audit 7 逐字一致（格式未漂移）');
var items5 = WAR.data.state.audit.items, lastDeny = null, lastSave5 = null;
for (var i5 = items5.length - 1; i5 >= 0; i5--) {
  if (lastDeny == null && items5[i5].result === 'deny') lastDeny = items5[i5];
  if (lastSave5 == null && items5[i5].action === 'admin.save') lastSave5 = items5[i5];
}
assert(lastDeny != null, '存在可用于过滤对照的 deny 条目');
var sAf1 = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'auditf', 'n', 'result', 'resultName'], sAf1, { n: 200, resultName: 'deny' });
var fMsg1 = sAf1.messages.join('');
assert(fMsg1.indexOf(' = deny') >= 0, 'auditf result=deny 命中条目');
assert(fMsg1.indexOf(' = ok') < 0 && fMsg1.indexOf(' = fail') < 0 && fMsg1.indexOf(' = rollback') < 0, 'auditf result=deny 未混入其它 result');
assert(fMsg1.indexOf('#' + lastDeny.seq + ' ') >= 0, 'auditf result=deny 命中最新 deny（#' + lastDeny.seq + '）');
assert(lastSave5 != null, '存在可用于过滤对照的 admin.save 条目');
var sAf2 = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'auditf', 'n', 'action', 'actionName'], sAf2, { n: 200, actionName: 'admin.save' });
var fMsg2 = sAf2.messages.join('');
assert(fMsg2.indexOf('admin.save') >= 0 && fMsg2.indexOf('econ.') < 0 && fMsg2.indexOf('team.') < 0, 'auditf action=admin.save 只命中该动作');
var sAf3 = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'auditf', 'n', 'result', 'resultName', 'action', 'actionName'], sAf3, { n: 200, resultName: 'deny', actionName: 'econ.mint' });
assert(sAf3.messages.join('').indexOf('econ.mint') >= 0 && sAf3.messages.join('').indexOf(' = deny') >= 0, 'auditf 两维叠加（result=deny + action=econ.mint）生效');
// ⑦ profile：只读（state 快照相等 + 不写审计）
var pProf = new FakePlayer('profu', 'uuid-profu');
srvE.players.push(pProf);
WAR.econ.mint('console', 'uuid-profu', 12, null);
var snapT = JSON.stringify(WAR.data.state.teams), snapE = JSON.stringify(WAR.data.state.econ);
var audN0 = WAR.audit.count();
var sPr = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'profile', 'player'], sPr, { player: pProf });
var prMsg = sPr.messages.join('');
assert(prMsg.indexOf('玩家档案') === 0 && prMsg.indexOf('余额=12') >= 0 && prMsg.indexOf('首见=') >= 0, 'profile 输出档案字段（含余额与首见）');
assert(JSON.stringify(WAR.data.state.teams) === snapT && JSON.stringify(WAR.data.state.econ) === snapE, 'profile 前后 state 快照相等（只读）');
assert(WAR.audit.count() === audN0, 'profile 不写审计（不污染审计面）');
var sPr2 = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'profile', 'player'], sPr2, {});
assert(sPr2.messages.join('') === '找不到目标玩家（当前仅支持在线玩家）', 'profile 缺目标：文案与其它域一致');
// ⑧ save：补断言（lastSaveAt + 审计留痕），功能未改
var sSv = new FakeSource(2, null);
runPath(registeredRoot, ['admin', 'save'], sSv, {});
assert(WAR.data.lastSaveAt != null, 'save 后 lastSaveAt 有值（落盘时间供 status 显示）');
var svAudit = WAR.audit.tail(WAR.audit.count()).filter(function (x) { return x.action === 'admin.save'; });
assert(svAudit.length >= 1 && svAudit[svAudit.length - 1].actor === 'cmd:console', 'save 写审计且 actor=cmd:console');
assert(sSv.messages.join('') === '已落盘（reason=manual）', 'save 回显逐字未变');
var sBare = new FakeSource(2, null);
runPath(registeredRoot, ['admin'], sBare, {});
assert(sBare.messages.join('') === '用法：/war admin status | audit [n] | save', '裸 /war admin 的用法串逐字未变（未因新增子命令改写）');
assert(WAR.econ.invariant().ok === true, 'T17 后不变量仍成立');

// ================================================================ T18 /war shop（60_shop.js，M1 系统商店）
console.log('\n--- T18 /war shop（60_shop.js）---');
assert(typeof WAR.shop.status === 'function', 'WAR.shop 已由 60_shop.js 实现（含 status()）');
var shopSt = WAR.shop.status();
assert(shopSt.implemented === true && shopSt.owner === '60_shop.js', 'WAR.shop.status(): implemented + owner 正确');
assert(WAR.config.shop.enabled === true && WAR.config.shop.spread === 0 && WAR.config.shop.maxPerTransaction === 64,
       'SHOP_CONFIG 暂定默认值：enabled=true / spread=0 / 单次上限 64');
assert(shopSt.catalogLoaded === true && shopSt.items > 0, '货架已载入（' + shopSt.items + ' 项，source=' + shopSt.catalogSource + '）');
var shopNode18 = findChild(registeredRoot, 'shop');
assert(shopNode18 != null && findChild(shopNode18, 'list') != null && findChild(shopNode18, 'buy') != null && findChild(shopNode18, 'sell') != null,
       '/war shop list|buy|sell 三个子命令存在');
// —— 账目恒等式工具（本段定义；对应 lead 的验收第 4 条）——
function t18CreditSum() {
  var n = 0;
  for (var i = 0; i < srvE.players.length; i++) {
    var inv = null;
    try { inv = srvE.players[i].inventory; } catch (e) { inv = null; }
    if (inv == null || typeof inv.getSlots !== 'function') continue;
    try {
      for (var s = 0; s < inv.getSlots(); s++) {
        var st = inv.getStackInSlot(s);
        if (st != null && st.id === 'kubejs:credit') n += st.count;
      }
    } catch (e2) { /* 故意坏背包的测试玩家：跳过 */ }
  }
  return n;
}
function t18Ledger() { return { bal: WAR.econ.total(), net: WAR.data.state.econ.minted - WAR.data.state.econ.burned }; }
var t18K0 = t18Ledger().bal + t18CreditSum();
var t18B0 = t18Ledger().net;
function t18Identity(label) {
  var inv = WAR.econ.invariant();
  assert(inv.ok === true && inv.delta === 0,
         label + '：账目恒等式 Σbalance = minted-burned-withdrawn+deposited（Δ=0，实际 Δ=' + inv.delta + '）');
  var L = t18Ledger();
  var dK = (L.bal + t18CreditSum()) - t18K0;
  var dB = L.net - t18B0;
  assert(dK - dB === 0, label + '：kubejs:credit 物品侧与账本侧差额为 0（ΔK=' + dK + '，Δ(minted-burned)=' + dB + '）');
}
// —— 买入 ——
var pShop = new FakePlayer('buyer', 'uuid-buyer');
srvE.players.push(pShop);
WAR.econ.mint('console', 'uuid-buyer', 100, null);
var t18Bal0 = WAR.econ.balanceOf('uuid-buyer');
var buy1 = WAR.shop.buy('buyer', pShop, 'minecraft:bread', 3);
assert(buy1.ok === true && buy1.unit === 3 && buy1.total === 9, '买入 3×minecraft:bread：单价 3 共 9');
assert(WAR.econ.balanceOf('uuid-buyer') === t18Bal0 - 9, '买入后账本 -9');
assert(WAR.shop.count(pShop, 'minecraft:bread') === 3, '买入后背包 +3 面包');
t18Identity('买入后');
// —— 拒绝路径 ——
var poor18 = new FakePlayer('poor18', 'uuid-poor18'); srvE.players.push(poor18);
assert(WAR.shop.buy('poor18', poor18, 'minecraft:bread', 1).ok === false, '余额不足 → 拒绝');
assert(WAR.shop.buy('buyer', pShop, 'minecraft:bread', 65).ok === false, '超过单次上限 64 → 拒绝');
assert(WAR.shop.buy('buyer', pShop, 'minecraft:not_a_real_item', 1).ok === false, '不在货架 → 拒绝');
assert(WAR.shop.buy('buyer', pShop, 'kubejs:credit', 1).ok === false, '货币本身不上架 → 拒绝');
assert(WAR.econ.balanceOf('uuid-buyer') === t18Bal0 - 9, '上列拒绝都不改余额');
t18Identity('拒绝路径后');
// —— 卖出 ——
var have18 = WAR.shop.count(pShop, 'minecraft:bread');
var sell1 = WAR.shop.sell('buyer', pShop, 'minecraft:bread', 2);
assert(sell1.ok === true && sell1.unit === 1 && sell1.total === 2, '卖出 2×minecraft:bread：回收价 1 共 2');
assert(WAR.econ.balanceOf('uuid-buyer') === t18Bal0 - 9 + 2, '卖出后账本 +2');
assert(WAR.shop.count(pShop, 'minecraft:bread') === have18 - 2, '卖出后背包 -2');
assert(WAR.shop.sell('buyer', pShop, 'minecraft:bread', 99).ok === false, '持有不足 → 拒绝');
t18Identity('卖出后');
// —— 背包满：买入按差额退回（钱侧仍走账本 API） ——
var pFull18 = new FakePlayer('fullshop', 'uuid-fullshop'); srvE.players.push(pFull18);
WAR.econ.mint('console', 'uuid-fullshop', 50, null);
for (var f18 = 0; f18 < 36; f18++) pFull18.inventory.setStackInSlot(f18, new FakeStack('minecraft:stone', 64));
var fullBal0 = WAR.econ.balanceOf('uuid-fullshop');
var buyFull = WAR.shop.buy('fullshop', pFull18, 'minecraft:bread', 4);
assert(buyFull.ok === false && buyFull.rolledBack === 12, '背包满：买入失败并按差额退回 12（rolledBack=' + buyFull.rolledBack + '）');
assert(WAR.econ.balanceOf('uuid-fullshop') === fullBal0, '退回后余额恢复原值');
t18Identity('买入回滚后');
// —— 命令路径（玩家实执行） ——
var sList18 = new FakeSource(0, pShop);
runPath(registeredRoot, ['shop', 'list'], sList18, {});
assert(sList18.messages.join('').indexOf('货架(') === 0, '/war shop list 输出货架');
var sBuy18 = new FakeSource(0, pShop);
runPath(registeredRoot, ['shop', 'buy', 'id', 'n'], sBuy18, { id: 'minecraft:torch', n: 2 });
assert(sBuy18.messages.join('').indexOf('买入 2×minecraft:torch') === 0, '/war shop buy <id> <n> 命令路径成功');
var sSell18 = new FakeSource(0, pShop);
runPath(registeredRoot, ['shop', 'sell', 'id'], sSell18, { id: 'minecraft:torch' });
assert(sSell18.messages.join('').indexOf('卖出 1×minecraft:torch') === 0, '/war shop sell <id> 默认卖 1 个');
t18Identity('命令路径后');
// —— 审计与数据源 ——
var act18 = {};
var j18 = WAR.audit.tail(WAR.audit.count());
for (var jj18 = 0; j18 && jj18 < j18.length; jj18++) act18[j18[jj18].action] = (act18[j18[jj18].action] || 0) + 1;
assert((act18['shop.buy'] || 0) >= 3 && (act18['shop.sell'] || 0) >= 2, '审计覆盖 shop.buy / shop.sell（实测 ' + JSON.stringify(act18) + '）');
var cat18 = WAR.shop.catalog();
assert(cat18.loaded === true && cat18.source != null && cat18.source.indexOf('catalog.json') >= 0, '货架来源指向 catalog.json（价格是数据）');
assert(WAR.shop.priceOf('minecraft:iron_ingot', 'buy') === 12 && WAR.shop.priceOf('minecraft:iron_ingot', 'sell') === 6,
       '价格确实来自数据文件（铁锭 买12/卖6）');
// —— 开关可关（暂定默认值可被覆盖） ——
WAR.config.shop.enabled = false;
var off18 = WAR.shop.buy('buyer', pShop, 'minecraft:bread', 1);
assert(off18.ok === false && off18.error.indexOf('商店未开放') >= 0, 'enabled=false 时买入被拒');
WAR.config.shop.enabled = true;
assert(WAR.shop.buy('buyer', pShop, 'minecraft:bread', 1).ok === true, '恢复 enabled=true 后买入恢复');
assert(WAR.econ.invariant().ok === true, 'T18 收尾不变量仍成立');

// ================================================================ T19 商店数值口径：core 唯一真源（lead 批复）
console.log('\n--- T19 商店数值口径单一起源 ---');
assert(typeof SHOP_CONFIG !== 'undefined' && SHOP_CONFIG === WAR.config.shop, 'SHOP_CONFIG 与 WAR.config.shop 是同一个对象引用（不是值相等的副本）');
assert(WAR.config.shop.enabled === true && WAR.config.shop.spread === 0 && WAR.config.shop.maxPerTransaction === 64,
       'core 的 WAR_CONFIG.shop 默认值：enabled=true / spread=0 / maxPerTransaction=64');
var shopSrc19 = fs.readFileSync(WAR_DIR + '/60_shop.js', 'utf8');
var assign19 = shopSrc19.split('\n').filter(function (ln) { return /^\s*SHOP_CONFIG\./.test(ln); });
assert(assign19.length === 0, '60_shop.js 里没有任何 SHOP_CONFIG.xxx = 赋值（域侧只读；命中 ' + assign19.length + ' 行）');
var coreSrc19 = fs.readFileSync(WAR_DIR + '/00_core.js', 'utf8');
assert(/shop:\s*\{[^}]*enabled:\s*true/.test(coreSrc19) && /shop:\s*\{[^}]*spread:\s*0/.test(coreSrc19) &&
       /shop:\s*\{[^}]*maxPerTransaction:\s*64/.test(coreSrc19),
       'core 的 WAR_CONFIG.shop 三个值都写在文件里（不靠运行时覆盖）');
// 超上限的拒绝必须给出「本次最多可买/可卖多少」——可执行的下一步
var entryIron19 = WAR.shop.entryOf('minecraft:iron_ingot');
var ironBuy019 = entryIron19.buy, ironSell019 = entryIron19.sell;
entryIron19.buy = 100;                                   // 测试用：临时抬价，让 64 件撞上账本上限 1000
entryIron19.sell = null;                                 // 卖出价省略 → 按 buy×(1-spread) 推导 = 100（顺带验证推导分支）
WAR.econ.mint('console', 'uuid-buyer', 1000, null);
var balBuy19 = WAR.econ.balanceOf('uuid-buyer');
var sMsg19 = new FakeSource(0, pShop);
runPath(registeredRoot, ['shop', 'buy', 'id', 'n'], sMsg19, { id: 'minecraft:iron_ingot', n: 20 });
var m19 = sMsg19.messages.join('');
assert(m19.indexOf('超过账本单笔上限 1000') >= 0 && m19.indexOf('本次最多可买 10 件') >= 0,
       '买入超上限：消息给出「本次最多可买 10 件」（实际：' + m19.slice(0, 70) + '）');
var resBuy19 = WAR.shop.buy('buyer', pShop, 'minecraft:iron_ingot', 20);
assert(resBuy19.ok === false && resBuy19.maxAffordable === 10, '买入拒绝返回 maxAffordable=10（玩家可直接照做）');
assert(WAR.econ.balanceOf('uuid-buyer') === balBuy19, '买入超上限被拒：账本未动');
assert(WAR.shop.priceOf('minecraft:iron_ingot', 'sell') === 100, '卖出价省略时按 buy×(1-spread) 推导 = 100');
pShop.inventory.insertItem(new FakeStack('minecraft:iron_ingot', 20), false);
var balSell19 = WAR.econ.balanceOf('uuid-buyer');
var resSell19 = WAR.shop.sell('buyer', pShop, 'minecraft:iron_ingot', 20);
assert(resSell19.ok === false && resSell19.maxSellable === 10 && resSell19.error.indexOf('本次最多可卖 10 件') >= 0 &&
       resSell19.error.indexOf('货已退回') >= 0,
       '卖出超上限：消息给出「本次最多可卖 10 件（货已退回）」（实际：' + resSell19.error + '）');
assert(WAR.shop.count(pShop, 'minecraft:iron_ingot') === 20, '卖出超上限：货物全部退回（一件不少）');
assert(WAR.econ.balanceOf('uuid-buyer') === balSell19, '卖出超上限被拒：账本未动');
// 单件价就超过账本上限（K=0 分支）：必须明确说「本商品当前不可购买/回收」，而不是给出「最多可买 0 件」
entryIron19.buy = 2000; entryIron19.sell = 2000;
var resZero = WAR.shop.buy('buyer', pShop, 'minecraft:iron_ingot', 1);
assert(resZero.ok === false && resZero.maxAffordable === 0 && resZero.error.indexOf('本商品当前不可购买') >= 0,
       '单件超上限：给出「本商品当前不可购买」（实际：' + resZero.error + '）');
var resZeroS = WAR.shop.sell('buyer', pShop, 'minecraft:iron_ingot', 1);
assert(resZeroS.ok === false && resZeroS.error.indexOf('本商品当前不可回收') >= 0, '单件超上限（卖）：给出「本商品当前不可回收」');
entryIron19.buy = ironBuy019; entryIron19.sell = ironSell019;   // 还原货架数据（价格是数据，测试也要还原）
assert(WAR.shop.priceOf('minecraft:iron_ingot', 'buy') === 12 && WAR.shop.priceOf('minecraft:iron_ingot', 'sell') === 6, '货架价格已还原（买12/卖6）');
assert(WAR.econ.invariant().ok === true, 'T19 后账目恒等式仍成立');

// ================================================================ T20 数据 schema 版本化 + 迁移框架
console.log('\n--- T20 schema 版本化与迁移框架 ---');
// ① 当前版本：加载行为完全不变
assert(WAR.schema != null && WAR.schema.code === 1 && WAR.schema.stored === 1 && WAR.schema.refused === false,
       '当前版本：code=1 / stored=1 / 未拒绝');
assert(WAR.data.readOnly === false && WAR.ready === true, '当前版本：非只读、ready 仍为是（加载行为未变）');
assert(WAR.data.state.schemaVersion === 1 && WAR.data.state.dataVersion === 1,
       'state：schemaVersion=1（权威）+ dataVersion=1（遗留镜像）');
assert(WAR.data.migrations === WAR_DATA_MIGRATIONS && WAR.data.migrations.length === 0,
       '迁移注册表当前为空（不顺手给现有域加迁移函数）');
// ② 迁移：能升 + 幂等 + 缺函数则拒绝推进
var st20 = WAR.data.defaultState();
st20.schemaVersion = 0; st20.dataVersion = 0; st20.kv.marker = 'v0';
var calls20 = 0;
WAR.data.migrations[0] = function (s) { calls20++; s.kv.marker = 'v1'; s.kv.addedByMigration = true; };
var mig20 = WAR.data.migrate(st20);
assert(mig20.ok === true && mig20.from === 0 && mig20.to === 1 && mig20.ran.join(',') === '0→1',
       'v0→v1 迁移成功且记录步骤 0→1');
assert(calls20 === 1 && st20.schemaVersion === 1 && st20.dataVersion === 1 && st20.kv.marker === 'v1',
       '迁移函数执行一次、版本推进到 1、数据被改写成 v1');
var snap20 = JSON.stringify(st20);
var mig20b = WAR.data.migrate(st20);
assert(mig20b.ok === true && mig20b.ran.length === 0 && JSON.stringify(st20) === snap20 && calls20 === 1,
       '迁移幂等：第二次重入不执行、状态逐字节不变（函数仍只被调用一次）');
delete WAR.data.migrations[0];
var st20miss = WAR.data.defaultState(); st20miss.schemaVersion = 0; st20miss.dataVersion = 0;
var mig20miss = WAR.data.migrate(st20miss);
assert(mig20miss.ok === false && mig20miss.error.indexOf('缺少') >= 0 && st20miss.schemaVersion === 0,
       '缺迁移函数：不推进版本、返回失败（绝不猜形状）');
assert(WAR.data.migrate(null).ok === false, '数据根为空：迁移拒绝');
// ③ 真实 load 路径：v0 盘上数据 → 迁移 → 写审计 → 落盘后磁盘变成 v1
WAR.data.migrations[0] = function (s) { s.kv.marker = 'v1'; s.kv.addedByMigration = true; };
var srv20 = new FakeServer();
var root20 = new FakeTag();
root20.putString('version', 'v0.1.0-m0');
root20.putInt('schemaVersion', 0);
root20.putInt('dataVersion', 0);
root20.putInt('bootCount', 3);
root20.putString('kv', JSON.stringify({ marker: 'v0' }));
srv20.persistentData.put('war', root20);
srv20.players = [];
var audBefore20 = WAR.audit.count();
WAR.data.load(srv20);
assert(WAR.data.readOnly === false && WAR.data.state.schemaVersion === 1 && WAR.data.state.kv.marker === 'v1',
       'v0 盘上数据经 load 升到 v1（迁移函数生效）');
var migAudit20 = [];
var items20 = WAR.data.state.audit.items;
for (var i20 = 0; i20 < items20.length; i20++) if (items20[i20].action === 'data.migrate') migAudit20.push(items20[i20]);
assert(migAudit20.length === 1 && migAudit20[0].result === 'ok' && migAudit20[0].detail.indexOf('from=v0 to=v1') >= 0,
       '迁移写审计 data.migrate（from=v0 to=v1）');
REG.loaded[0]({ server: srv20 });
// 注意：save() 会新建一个 tag 并 put 回 persistentData ⇒ 断言必须读**当前**根，不能读旧引用
var root20live = srv20.persistentData.getCompound('war');
assert(root20live.getInt('schemaVersion') === 1 && root20live.getInt('dataVersion') === 1,
       '迁移后落盘：磁盘 schemaVersion 由 0 变成 1、镜像 dataVersion 同步（迁移真正持久化）');
assert(root20live.getAllKeys().indexOf('schemaVersion') >= 0, '根 NBT 出现 schemaVersion 标量键');
assert(JSON.parse(root20live.getString('kv')).marker === 'v1', '迁移后的 kv 载荷已落盘（读当前根）');
delete WAR.data.migrations[0];
// ④ 数据比代码新（v2 vs code v1）：拒绝接管 + 盘上数据逐字节不变 + 审计 + warnOnce 一次
var srv21 = new FakeServer();
var root21 = new FakeTag();
root21.putString('version', 'v0.9.0-future');
root21.putInt('schemaVersion', 2);
root21.putInt('dataVersion', 2);
root21.putInt('bootCount', 9);
root21.putString('futureField', '不许被改写');
root21.putString('kv', JSON.stringify({ marker: 'future' }));
srv21.persistentData.put('war', root21);
srv21.players = [];
function diskSnap(root) {
  var keys = Array.from(root.m.keys()).sort();
  var out = [];
  for (var i = 0; i < keys.length; i++) out.push(keys[i] + '=' + String(root.m.get(keys[i])));
  return out.join('|');
}
var snap21a = diskSnap(root21);
var errN21 = 0, origErr21 = console.error;
console.error = function () { errN21++; };
WAR.data.load(srv21);
console.error = origErr21;
assert(WAR.data.readOnly === true && WAR_SCHEMA.refused === true && WAR_SCHEMA.stored === 2 && WAR_SCHEMA.code === 1,
       'v2 数据：标成只读 + 记录 stored=2 / code=1（拒绝接管）');
assert(diskSnap(root21) === snap21a, '被拒后磁盘数据逐字节未变（前后快照全等）');
assert(root21.getString('futureField') === '不许被改写' && root21.getInt('schemaVersion') === 2, '未来字段与版本号原样保留');
var refuseAudit20 = WAR.data.state.audit.items.filter(function (x) { return x.action === 'data.refuse'; });
assert(refuseAudit20.length === 1 && refuseAudit20[0].result === 'refuse', '拒绝写审计 data.refuse（会话内可见）');
assert(errN21 === 1 && WAR.data.warned['schema-readonly'] === true, 'warnOnce 只报一次（console.error 计数=1）');
assert(WAR.data.save('t20') === false, '只读状态：save() 拒绝落盘');
assert(WAR.data.mutate('t20', function (s) { s.kv.hacked = 1; }).ok === false, '只读状态：mutate() 拒绝写入');
var errN21b = 0, origErr21b = console.error;
console.error = function () { errN21b++; };
WAR.data.mutate('t20b', function () { });
WAR.data.save('t20b');
console.error = origErr21b;
assert(errN21b === 0, '只读状态重复写：不再产生新的告警（warnOnce 生效；本轮新增告警=' + errN21b + '）');
REG.loaded[0]({ server: srv21 });
assert(WAR.ready === false, '被拒数据上 boot：不就绪（宁可不工作，也不按错误形状写）');
assert(diskSnap(root21) === snap21a, '被拒数据上 boot 之后：磁盘数据仍逐字节未变（没被 bootCount++/落盘污染）');
// ⑤ 恢复：换回正常数据后系统重新可用（拒绝不是永久枷锁）
var srv22 = new FakeServer();
srv22.players = [];
REG.loaded[0]({ server: srv22 });
assert(WAR.ready === true && WAR.data.readOnly === false && WAR_SCHEMA.refused === false,
       '换回正常（无数据）后：ready=是、非只读、拒绝标记清除');

// ================================================================ T21 出生点硬门配置真源（WAR_CONFIG.spawn.dMax）
console.log('\n--- T21 WAR_CONFIG.spawn.dMax（出生点硬门配置真源）---');
assert('dMax' in WAR.config.spawn && WAR.config.spawn.dMax === 0.05, 'WAR.config.spawn.dMax 存在且为 0.05');
var coreSrc21 = fs.readFileSync(WAR_DIR + '/00_core.js', 'utf8');
assert(/spawn:\s*\{[^}]*dMax:\s*0\.05/.test(coreSrc21), 'core 的 spawn CONFIG 里写着 dMax: 0.05（文件里的事实，不是运行时补的）');
assert(coreSrc21.indexOf('唯一真源') >= 0 && coreSrc21.indexOf('dcalib') >= 0 && coreSrc21.indexOf('暂定') >= 0,
       'core 注释写明：暂定待标定 + 标定方法(dcalib) + 唯一真源');
var spawnSrc21 = fs.readFileSync(WAR_DIR + '/20_spawn.js', 'utf8');
assert(/SP_D_MAX_FALLBACK\s*=\s*0\.05/.test(spawnSrc21), '20_spawn.js 侧有 SP_D_MAX_FALLBACK = 0.05（缺键保底常量）');
var lit21 = [];
var lines21 = spawnSrc21.split('\n');
for (var i21 = 0; i21 < lines21.length; i21++) {
  if (lines21[i21].indexOf('0.05') < 0) continue;
  if (/SP_D_MAX_FALLBACK\s*=\s*0\.05/.test(lines21[i21])) continue;   // 保底常量本身
  if (/^\s*\/\//.test(lines21[i21])) continue;                          // 注释里出现不算第二份真源
  lit21.push((i21 + 1) + ': ' + lines21[i21].trim());
}
assert(lit21.length === 0, '20_spawn.js 里没有第二份 dMax 阈值字面量赋值（命中 ' + lit21.length + ' 行' + (lit21.length ? '：' + lit21.join(' | ') : '') + '）');
assert(spawnSrc21.indexOf('core.dMax != null') >= 0 && spawnSrc21.indexOf('spawn-cfg-dmax') >= 0,
       '20_spawn.js 只在 core 缺键时回落，并 warnOnce 点名 spawn-cfg-dmax');

// ================================================================ T21 CM.scoreArea 契约（照抄 chunk-metrics 的骨架）
console.log('\n--- T21 CM 接口契约（a/d 口径）---');
cmFakeClear();
for (var gx = -2; gx <= 2; gx++) for (var gz = -2; gz <= 2; gz++) cmFakeSet(gx, gz, 0.5, 0.2);
cmFakeSet(-2, -2, 0, 0, { status: 'read-fail' });        // 读取失败
cmFakeSet(2, 2, 0.9, 0.9, { stale: true });              // 过期（stale ≠ 无效）
delete CM_FAKE.grid['1,1'];                              // 未扫描 ⇒ no-record
var area21 = CM.scoreArea(srvE.players[0].level, 0, 0, 2, { freshOnly: false });
assert(area21.ok === true && area21.candidates.length === 25, '区域槽位 = (2r+1)^2 = 25');
assert(area21.counts.fresh === 22 && area21.counts.stale === 1 && area21.counts.noRecord === 1 && area21.counts.readFail === 1,
       'counts 分类正确（fresh 22 / stale 1 / no-record 1 / read-fail 1）');
assert(area21.usable === area21.counts.fresh, 'usable == counts.fresh（fresh 才是权威可用计数）');
assert(area21.candidates.every(function (c) { return (c.status !== 'no-record' && c.status !== 'read-fail') || (c.a === null && c.d === null); }),
       '未知（no-record / read-fail）必须是 null —— 绝不许用 0 冒充');
assert(area21.candidates.every(function (c) { return c.a === null || (c.a >= 0 && c.a <= 1); }) &&
       area21.candidates.every(function (c) { return c.d === null || (c.d >= 0 && c.d <= 1); }), 'd/a 值域 [0,1]（不是 0–100、不是计数）');
assert(area21.candidates.every(function (c) { return c.status !== 'ok' || c.rev !== null; }) && typeof area21.curRev === 'number',
       '每条带 rev、区域带 curRev（stale 判据是 rev !== curRev，别缓存 rev）');

// ================================================================ T22 据点域（隐性人工程度，40_base.js）
console.log('\n--- T22 据点域（40_base.js）---');
assert(WAR.base != null && WAR.base.__stub === false && typeof WAR.base.calib === 'function', 'WAR.base 已由 40_base.js 实现（含 calib()）');
assert(typeof BASE_CONFIG !== 'undefined' && BASE_CONFIG === WAR.config.base, 'BASE_CONFIG 与 WAR.config.base 是同一对象引用（单一起源）');
var baseSrc22 = fs.readFileSync(WAR_DIR + '/40_base.js', 'utf8');
var assign22 = baseSrc22.split('\n').filter(function (ln) { return /^\s*BASE_CONFIG\./.test(ln); });
assert(assign22.length === 0, '40_base.js 里没有 BASE_CONFIG.xxx = 赋值（域侧只读 core 的 CONFIG；命中 ' + assign22.length + ' 行）');
assert(baseSrc22.indexOf('BASE_CONFIG.xxx = ') >= 0 && baseSrc22.indexOf('禁止用「单区块 a 高」当据点判据') >= 0,
       '代码头写明：唯一真源 + 禁止单块判据（聚合窗口覆盖 1–2 块边界）');
// 隔离：T22 用**专用服务器**（共享 srvE 里多个玩家默认都在区块 (0,0)，会污染锚点与归属）
var srvB22 = new FakeServer();
srvB22.players = [];
WAR.data.state.base = { seq: 0, byId: {}, candidates: {}, presence: {}, runtime: {} };
// —— ① 未标定：拒绝工作，不悄悄用默认基线跑 ——
CM_FAKE.calib = null; CM_FAKE.rev = 0;
var cal22 = WAR.base.calib();
assert(cal22.ok === false && cal22.calibrated === false && cal22.source === 'rev-fallback',
       '未标定判定：无 calib 字段且 rev=0 ⇒ 未标定（来源 rev-fallback）');
var ref22 = WAR.base.scan(srvB22, { force: true });
assert(ref22.ok === false && ref22.refused === true && String(ref22.reason).indexOf('/cm calib') >= 0,
       '未标定 ⇒ 扫描拒绝 + 给出可执行提示（/cm calib）：' + ref22.reason);
var sList22 = new FakeSource(0, null);
runPath(registeredRoot, ['base', 'list'], sList22, {});
assert(sList22.messages.join('').indexOf('据点系统未启用') >= 0, '未标定时 /war base list 给出可解释文案');
// —— ② 标定后：区域聚合 + 形成据点 ——
CM_FAKE.rev = 1;
assert(WAR.base.calib().ok === true && WAR.base.calib().rev === 1, 'rev>0 ⇒ 视为已标定（calib 字段落地前的近似）');
cmFakeClear();
for (var bx = -2; bx <= 2; bx++) for (var bz = -2; bz <= 2; bz++) cmFakeSet(bx, bz, 0.15, 0.01);
var pBase22 = new FakePlayer('founder', 'uuid-founder');
pBase22.blockX = 8; pBase22.blockZ = 8;                 // 区块 (0,0)
srvB22.players = [pBase22];
var agg22 = WAR.base.area(pBase22.level, 0, 0);
assert(agg22.ok === true && agg22.fresh === 25 && agg22.unknown === 0 && Math.abs(agg22.aSum - 3.75) < 1e-9,
       '区域聚合：25 块 fresh、aSum = Σa = 3.75（**求和**，不是 max/平均）');
var t0 = WAR_TICK.n;
var scan1 = WAR.base.scan(srvB22, { force: true });
assert(scan1.ok === true && scan1.formed === 0 && WAR.base.list().length === 0 && WAR.base.state().candidates['0,0'] != null,
       '第一次扫描：只登记候选（未到 holdTicks，不形成据点）');
WAR_TICK.n = t0 + warToInt(BASE_CONFIG.holdTicks, 1200);
var scan2 = WAR.base.scan(srvB22, { force: true });
var blist22 = WAR.base.list();
assert(scan2.formed === 1 && blist22.length === 1 && blist22[0].state === 'intact', '连续满足 holdTicks ⇒ 形成据点（intact）');
assert(blist22[0].owner != null && blist22[0].owner.name === 'founder' && blist22[0].owner.source === 'approx-activity',
       '主导者 = founder（**近似**：ownerSource=approx-activity，不是方块归因）');
var formedAudit = WAR.data.state.audit.items.filter(function (x) { return x.action === 'base.formed'; });
assert(formedAudit.length === 1 && formedAudit[0].result === 'ok', '形成据点写审计 base.formed');
// —— ③ 有效读数不足 ⇒ 不判定、不登记（unknown 不当 0） ——
cmFakeClear();
for (var cx3 = -2; cx3 <= 2; cx3++) for (var cz3 = -2; cz3 <= 2; cz3++) { if (Math.abs(cx3) + Math.abs(cz3) <= 2) cmFakeSet(cx3, cz3, 0.15, 0.01); }
var agg22b = WAR.base.area(pBase22.level, 0, 0);
assert(agg22b.ok === true && agg22b.fresh === 13 && agg22b.enough === false && agg22b.unknown === 12 && agg22b.aSum > 0,
       '有效读数不足（13/25=0.52 < minFreshShare 0.6）⇒ enough=false（不判定、不登记，而不是把未知当 0）');
assert(WAR.base.scan(srvB22, { force: true }).skipped >= 1, '读数不足的锚点在扫描里被跳过（skipped≥1）');
// —— ④ a 下降 / d 上升 ⇒ damaged ——
cmFakeClear();
for (var dx4 = -2; dx4 <= 2; dx4++) for (var dz4 = -2; dz4 <= 2; dz4++) cmFakeSet(dx4, dz4, 0.02, 0.5);
var scan4 = WAR.base.scan(srvB22, { force: true });
assert(scan4.damaged === 1 && WAR.base.list()[0].state === 'damaged', 'aSum 跌破峰值-aSumDrop ⇒ damaged');
assert(WAR.data.state.audit.items.filter(function (x) { return x.action === 'base.damaged'; }).length === 1,
       'damaged 写审计（detail 注明「与自建时的正常破坏需数据标定区分」）');
// —— ⑤ 缺席 + 新主导 ⇒ abandoned / captured（近似判定） ——
var pChal22 = new FakePlayer('challenger', 'uuid-challenger');
pChal22.blockX = 8; pChal22.blockZ = 8;
srvB22.players = [pChal22];                              // 原主离开该区块（只留挑战者）
var keepRatio = BASE_CONFIG.captureRatio;
BASE_CONFIG.captureRatio = 999;                          // 先只验 abandoned：把夺取门槛抬到不可能
var tAbs = WAR_TICK.n;
WAR.base.scan(srvB22, { force: true });
assert(WAR.base.list()[0].absentSince != null, '原主不在锚点 ⇒ 开始计缺席（absentSince 有值）');
WAR_TICK.n = tAbs + warToInt(BASE_CONFIG.absentTicks, 24000) + 1;
var scan5 = WAR.base.scan(srvB22, { force: true });
assert(scan5.abandoned === 1 && WAR.base.list()[0].state === 'abandoned', 'damaged + 缺席超 absentTicks ⇒ abandoned');
assert(WAR.data.state.audit.items.filter(function (x) { return x.action === 'base.abandoned'; }).length === 1, 'abandoned 写审计');
BASE_CONFIG.captureRatio = keepRatio;
var b22 = WAR.base.list()[0];
b22.ownerSince = WAR_TICK.n - 1000;                       // 让「原主导在场时长」确定性地短于挑战者
var scan6 = WAR.base.scan(srvB22, { force: true });
assert(scan6.captured === 1 && b22.owner.name === 'challenger', '新主导连续在场 ≥ 原主导 × captureRatio 且原主长期缺席 ⇒ captured（近似）');
var capAudit = WAR.data.state.audit.items.filter(function (x) { return x.action === 'base.captured'; });
assert(capAudit.length === 1 && capAudit[0].detail.indexOf('approx-activity') >= 0, 'captured 审计写明依据 = 在场连续时长近似');
// —— ⑥ 命令与权限 ——
var sList22b = new FakeSource(0, pChal22);
runPath(registeredRoot, ['base', 'list'], sList22b, {});
assert(sList22b.messages.join('').indexOf('据点(1)') === 0 && sList22b.messages.join('').indexOf('近似') >= 0, '/war base list 列据点并标注主导者为近似');
var sInfo22 = new FakeSource(0, pChal22);
runPath(registeredRoot, ['base', 'info', 'id'], sInfo22, { id: b22.id });
assert(sInfo22.messages.join('').indexOf('未证实') >= 0 && sInfo22.messages.join('').indexOf('BlockEvents.placed') >= 0,
       '/war base info 明说主导者近似（真归因需 BlockEvents.placed）');
var sPar22 = new FakeSource(0, pChal22);
runPath(registeredRoot, ['base', 'params'], sPar22, {});
assert(sPar22.messages.join('').indexOf('暂定') >= 0 && sPar22.messages.join('').indexOf('待标定') >= 0, '/war base params 明标「暂定、待标定」');
var sScanLow = new FakeSource(1, null);
runPath(registeredRoot, ['base', 'scan'], sScanLow, {});
assert(sScanLow.messages.length === 0, 'level1 时 /war base scan 不可达（OP 门生效）');
assert(WAR.econ.invariant().ok === true, 'T22 后账目恒等式仍成立');

console.log('\n--- 汇总 ---');
console.log('PASS=' + passN + ' FAIL=' + failN + ' SKIP=' + skipN);
console.log(ok ? 'ALL_PASS' : 'SOME_FAILED');
if (!ok) process.exitCode = 1;
