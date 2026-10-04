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
var WAR_FILES = ['00_core.js', '10_team.js', '30_economy.js'];
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
  for (var i = 0; i < p.length; i++) {
    var c = findChild(cur, p[i]);
    if (c == null) return null;
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
assert(WAR.claim.__stub === true && WAR.shop.__stub === true, '未实现域带 __stub 标记（claim/shop）');
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

console.log('\n--- 汇总 ---');
console.log('PASS=' + passN + ' FAIL=' + failN + ' SKIP=' + skipN);
console.log(ok ? 'ALL_PASS' : 'SOME_FAILED');
if (!ok) process.exitCode = 1;
