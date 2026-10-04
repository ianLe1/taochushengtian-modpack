// ============================================================================
// 战服 · 30_economy.js —— 经济域（M1 账本侧）：war:credit ↔ war.credit
// ============================================================================
// 权威存储：server.persistentData.war.econ（沿用 00_core.js 的「结构化域 = JSON 字符串载荷」方案，
//   由 WAR.data 统一落盘）。物品侧只有一种实体：kubejs:credit（startup_scripts/war_items.js 注册）。
//
// 术语（避免以后有人以为是两套东西）：
//   · kubejs:credit —— 玩家背包里能拿在手上的**物品**
//   · war.credit    —— 服务端权威**账本数字**（state.econ.balance[uuid]）
//   两者是同一价值的两形态：withdraw = 账本→物品；deposit = 物品→账本。
//
// 不变量（自检直接断言它）：
//   Σ balance  ==  minted - burned - withdrawn + deposited
//   （mint=管理员铸造进账本，burn=管理员销毁账本，withdraw=账本转物品，deposit=物品转账本）
//   任何一次失败的操作都必须让这条等式继续成立 —— 这就是「失败回滚」的判据。
//
// 顺序纪律（lead 要求 / 方案 §3 防刷）：发放与回收一律**先改账本、再动物品库存**；
//   物品侧失败（异常或取到的实物少于预期）就把账本改回原值，并写审计（result=fail/rollback）。
//   余额不足的路径在账本层就拒绝，绝不出现负余额。
//
// 幂等：所有写操作支持可选 opId；同一 opId 第二次进入直接返回首次结果，不重复扣款
//   （对应自检里的「重放不重复扣款」）。
//
// 已核实 API（javap 字节码实证；harness 里以假对象等价实现）：
//   PlayerKJS.kjs$getInventory() -> InventoryKJS；InventoryKJS.kjs$getSlots()/kjs$getStackInSlot(int)/
//     kjs$setStackInSlot(int,ItemStack)/kjs$insertItem(ItemStack,boolean)/kjs$extractItem(int,int,boolean)/
//     kjs$count()/kjs$isEmpty()/kjs$getAllItems()
//   PlayerKJS.kjs$give(ItemStack)
//   ItemWrapper（全局 Item）：of(...) 系列、plus getId(Item)->ResourceLocation、exists(ResourceLocation)
//   CommandRegistryKubeEvent / Arguments.STRING|INTEGER|PLAYER / CommandSourceStack.hasPermission(2)
// ============================================================================

// ----------------------------------------------------------------------------
// ECON_CONFIG —— 数值口径的**单一起源**是 00_core.js 的 WAR_CONFIG.econ
// （2026-10-04 按 lead 批复从本文件迁入 core；此处只是别名，不再重复定义数值。
//   约定：经济数值只改 core 那一处，本文件不新增常量。）
// ----------------------------------------------------------------------------
var ECON_CONFIG = WAR.config.econ;

// ============================================================================
// 0. 内部工具
// ============================================================================

function econLog(msg) { WAR.log('[econ] ' + msg); }

// 保证 state.econ 结构完整（旧档/坏档也能跑）
function econNorm() {
  var st = WAR.data.state;
  if (st == null) return null;
  st.econ = WAR.data.normalize ? st.econ : st.econ;
  var e = st.econ;
  if (e == null || typeof e !== 'object') { e = {}; st.econ = e; }
  if (e.balance == null || typeof e.balance !== 'object') e.balance = {};
  if (typeof e.minted !== 'number') e.minted = 0;
  if (typeof e.burned !== 'number') e.burned = 0;
  if (typeof e.withdrawn !== 'number') e.withdrawn = 0;
  if (typeof e.deposited !== 'number') e.deposited = 0;
  if (typeof e.seq !== 'number') e.seq = 0;
  if (e.ops == null || typeof e.ops !== 'object') e.ops = {};
  if (e.joined == null || typeof e.joined !== 'object') e.joined = {};   // 首见记录（firstJoinGrant 用）
  if (!(e.journal instanceof Array)) e.journal = [];
  e.__stub = false;
  e.__owner = '30_economy.js';
  return e;
}

function econBalance(uuid) {
  var e = econNorm();
  if (e == null || uuid == null || uuid === '') return 0;
  var v = e.balance[String(uuid)];
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

function econTotal() {
  var e = econNorm();
  if (e == null) return 0;
  var sum = 0;
  for (var k in e.balance) if (e.balance.hasOwnProperty(k)) sum += warToInt(e.balance[k], 0);
  return sum;
}

// 不变量：Σbalance == minted - burned - withdrawn + deposited
function econInvariant() {
  var e = econNorm();
  if (e == null) return { ok: false, reason: '数据根未载入' };
  var expect = e.minted - e.burned - e.withdrawn + e.deposited;
  var actual = econTotal();
  return { ok: expect === actual, expect: expect, actual: actual, delta: actual - expect };
}

function econJournal(kind, actor, from, to, amount, result, detail) {
  var e = econNorm();
  if (e == null) return null;
  e.seq = warToInt(e.seq, 0) + 1;
  var rec = {
    seq: e.seq, t: warNow(), kind: String(kind), actor: String(actor == null ? '-' : actor),
    from: from == null ? '-' : String(from), to: to == null ? '-' : String(to),
    amount: warToInt(amount, 0), result: String(result)
  };
  if (detail != null) rec.detail = String(detail);
  e.journal.push(rec);
  var cap = Math.max(1, warToInt(ECON_CONFIG.journalSize, 200));
  while (e.journal.length > cap) e.journal.shift();
  WAR.data.touch();
  WAR.audit.append(rec.actor, 'econ.' + rec.kind, rec.to !== '-' ? rec.to : rec.from, rec.result, rec.detail || (rec.amount + ''));
  return rec;
}

// 幂等闸：同一 opId 只允许生效一次
function econReplay(opId) {
  if (opId == null || opId === '') return null;
  var e = econNorm();
  var k = String(opId);
  if (e.ops[k] != null) return e.ops[k];
  return undefined;   // undefined = 首次
}
function econRemember(opId, result) {
  if (opId == null || opId === '') return;
  var e = econNorm();
  e.ops[String(opId)] = { t: warNow(), result: String(result) };
  var keys = Object.keys(e.ops);
  var cap = Math.max(1, warToInt(ECON_CONFIG.opMemory, 200));
  while (keys.length > cap) { delete e.ops[keys.shift()]; }
  WAR.data.touch();
}

// 金额口径校验
function econCheckAmount(n, label) {
  var v = warToInt(n, -1);
  if (v <= 0) return { ok: false, error: (label || '金额') + '必须为正整数' };
  if (v < warToInt(ECON_CONFIG.payMin, 1)) return { ok: false, error: (label || '金额') + '不得小于 ' + ECON_CONFIG.payMin };
  if (v > warToInt(ECON_CONFIG.payMax, 1000)) return { ok: false, error: (label || '金额') + '不得超过单笔上限 ' + ECON_CONFIG.payMax };
  return { ok: true, value: v };
}

function econFeeOf(n) {
  if (ECON_CONFIG.feeEnabled !== true) return 0;
  var rate = Number(ECON_CONFIG.feeRate) || 0;
  return Math.max(0, Math.floor(n * rate));
}

// ---------------- 物品侧（全部走已核实的 InventoryKJS / give）----------------

function econItemId(stack) {
  if (stack == null) return '';
  try { var a = stack.id; if (a != null && String(a) !== '') return String(a); } catch (e1) { }
  try { var it = stack.getItem(); var b = Item.getId(it); if (b != null) return String(b); } catch (e2) { }
  try { return String(stack.getItem()); } catch (e3) { }
  return '';
}

function econStackCount(stack) {
  if (stack == null) return 0;
  try { var a = stack.count; if (typeof a === 'number') return a; } catch (e1) { }
  try { var b = stack.getCount(); if (typeof b === 'number') return b; } catch (e2) { }
  return 1;
}

function econIsCredit(stack) {
  var id = econItemId(stack);
  if (id === ECON_CONFIG.currencyItem) return true;
  // 兼容写法：kubejs:credit / war:credit 两种字符串都算（账本键 war.credit 是文档口径，不是物品 id）
  return id === 'war:credit';
}

function econInv(p) {
  if (p == null) return null;
  try { var a = p.inventory; if (a != null) return a; } catch (e1) { }
  try { var b = p.getInventory(); if (b != null) return b; } catch (e2) { }
  return null;
}

function econCountItems(p) {
  var inv = econInv(p);
  if (inv == null) return -1;
  var n = 0;
  try {
    var slots = inv.getSlots();
    for (var i = 0; i < slots; i++) {
      var s = inv.getStackInSlot(i);
      if (s != null && !econStackIsEmpty(s) && econIsCredit(s)) n += econStackCount(s);
    }
  } catch (e) { econWarnOnce('count', '背包清点失败：' + e); return -1; }
  return n;
}

function econStackIsEmpty(s) {
  try { if (s.isEmpty && s.isEmpty() === true) return true; } catch (e1) { }
  try { if (econStackCount(s) <= 0) return true; } catch (e2) { }
  return false;
}

// 从背包取出最多 amount 个货币物品，返回实际取出数
function econTakeItems(p, amount) {
  var inv = econInv(p);
  if (inv == null) return -1;
  var need = amount, taken = 0;
  try {
    var slots = inv.getSlots();
    for (var i = 0; i < slots && need > 0; i++) {
      var s = inv.getStackInSlot(i);
      if (s == null || econStackIsEmpty(s) || !econIsCredit(s)) continue;
      var give = Math.min(need, econStackCount(s));
      var got = null;
      try { got = inv.extractItem(i, give, false); } catch (e1) { got = null; }
      var gotN = (got == null) ? 0 : econStackCount(got);
      taken += gotN; need -= gotN;
      if (gotN < give) break;   // 实际取出少于预期：立刻停手，由调用方按 taken 结算
    }
  } catch (e2) { econWarnOnce('take', '背包取物失败：' + e2); return taken; }
  return taken;
}

// 给物品；返回**实际放入背包的数量**（-1 = 背包不可用）
// 注意：这里刻意不把 p.give() 当主路径 —— 它的返回是 void，失败/溢出（可能掉地上）都判断不到，
//   会造成「账本已扣、物品没到手」的单边损失。主路径用 InventoryKJS.insertItem（返回余量，可判定）。
//   放入数少于请求数时，由调用方按差额回滚账本（withdraw 里已实现）。
function econGiveItems(p, amount) {
  if (p == null) return -1;
  try {
    var stack = Item.of(ECON_CONFIG.currencyItem, amount);
    if (stack == null) return -1;
    var inv = econInv(p);
    if (inv != null) {
      var rest = inv.insertItem(stack, false);          // 放不下的留在 rest，不落地
      var restN = (rest == null) ? 0 : econStackCount(rest);
      return amount - restN;
    }
    try { p.give(stack); return amount; } catch (e1) { return -1; }   // 无 inventory 包装时的退路（已在报告标注风险）
  } catch (e2) { econWarnOnce('give', '发币失败：' + e2); return -1; }
}

function econWarnOnce(tag, msg) { warWarnOnce('econ-' + tag, msg); }

// ============================================================================
// 1. 账本原语（只动数字，不动物品）
// ============================================================================

function econCredit(uuid, amount, bucket) {
  var e = econNorm();
  var v = warToInt(amount, 0);
  if (v <= 0) return { ok: false, error: '金额必须为正' };
  var cur = econBalance(uuid);
  if (cur + v > warToInt(ECON_CONFIG.maxBalance, 1000000)) return { ok: false, error: '超过单账户上限 ' + ECON_CONFIG.maxBalance };
  e.balance[String(uuid)] = cur + v;
  if (bucket === 'mint') e.minted += v;
  else if (bucket === 'deposit') e.deposited += v;
  WAR.data.touch();
  return { ok: true, balance: e.balance[String(uuid)] };
}

function econDebit(uuid, amount, bucket) {
  var e = econNorm();
  var v = warToInt(amount, 0);
  if (v <= 0) return { ok: false, error: '金额必须为正' };
  var cur = econBalance(uuid);
  if (cur < v) return { ok: false, error: '余额不足（当前 ' + cur + '，需要 ' + v + '）' };
  e.balance[String(uuid)] = cur - v;
  if (bucket === 'burn') e.burned += v;
  else if (bucket === 'withdraw') e.withdrawn += v;
  WAR.data.touch();
  return { ok: true, balance: e.balance[String(uuid)] };
}

// 回滚一个 credit（deposit 失败时用）：余额减回去，对应计数也减回去
function econRestoreCredit(uuid, amount, bucket) {
  var e = econNorm();
  var v = warToInt(amount, 0);
  if (v <= 0) return;
  e.balance[String(uuid)] = econBalance(uuid) - v;
  if (bucket === 'mint') e.minted = Math.max(0, e.minted - v);
  else if (bucket === 'deposit') e.deposited = Math.max(0, e.deposited - v);
  WAR.data.touch();
}
// 回滚一个 debit（withdraw / pay 失败时用）：余额加回去，对应计数也减回去
function econRestoreDebit(uuid, amount, bucket) {
  var e = econNorm();
  var v = warToInt(amount, 0);
  if (v <= 0) return;
  e.balance[String(uuid)] = econBalance(uuid) + v;
  if (bucket === 'burn') e.burned = Math.max(0, e.burned - v);
  else if (bucket === 'withdraw') e.withdrawn = Math.max(0, e.withdrawn - v);
  WAR.data.touch();
}

// ============================================================================
// 2. 对外 API（global.WAR.econ）
// ============================================================================

var WAR_ECON = {
  __stub: false,
  __owner: '30_economy.js',
  config: ECON_CONFIG,

  status: function () {
    var inv = econInvariant();
    return {
      domain: 'econ', implemented: true, owner: '30_economy.js',
      currencyItem: ECON_CONFIG.currencyItem, ledgerKey: ECON_CONFIG.ledgerKey,
      accounts: warCountKeys(econNorm() ? econNorm().balance : {}),
      total: econTotal(), minted: econNorm() ? econNorm().minted : 0,
      burned: econNorm() ? econNorm().burned : 0,
      withdrawn: econNorm() ? econNorm().withdrawn : 0,
      deposited: econNorm() ? econNorm().deposited : 0,
      invariantOk: inv.ok, invariantDelta: inv.delta,
      payMin: ECON_CONFIG.payMin, payMax: ECON_CONFIG.payMax, feeEnabled: ECON_CONFIG.feeEnabled
    };
  },

  balanceOf: function (playerOrUuid) {
    var u = (typeof playerOrUuid === 'string') ? playerOrUuid : WAR.uuidOf(playerOrUuid);
    return econBalance(u);
  },

  // 铸造：账本 +n（权威发放；/war money admin give）
  mint: function (actor, uuid, amount, opId) {
    var rep = econReplay(opId);
    if (rep !== undefined && rep != null) return { ok: true, replayed: true, balance: econBalance(uuid) };
    var c = econCheckAmount(amount, '发放金额');
    if (!c.ok) { econJournal('mint', actor, null, uuid, amount, 'deny', c.error); econRemember(opId, 'deny'); return c; }
    if (uuid == null || uuid === '') { var e0 = { ok: false, error: '目标玩家无 UUID' }; econJournal('mint', actor, null, '-', amount, 'deny', e0.error); return e0; }
    var r = econCredit(uuid, c.value, 'mint');
    econJournal('mint', actor, null, uuid, c.value, r.ok ? 'ok' : 'fail', r.ok ? '' : r.error);
    econRemember(opId, r.ok ? 'ok' : 'fail');
    return r;
  },

  // 销毁：账本 -n（/war money admin take）
  burn: function (actor, uuid, amount, opId) {
    var rep = econReplay(opId);
    if (rep !== undefined && rep != null) return { ok: true, replayed: true, balance: econBalance(uuid) };
    var c = econCheckAmount(amount, '回收金额');
    if (!c.ok) { econJournal('burn', actor, uuid, null, amount, 'deny', c.error); return c; }
    var r = econDebit(uuid, c.value, 'burn');
    econJournal('burn', actor, uuid, null, c.value, r.ok ? 'ok' : 'fail', r.ok ? '' : r.error);
    econRemember(opId, r.ok ? 'ok' : 'fail');
    return r;
  },

  // 账本转账（数字→数字）：pay
  pay: function (actor, fromUuid, toUuid, amount, opId) {
    var rep = econReplay(opId);
    if (rep !== undefined && rep != null) return { ok: true, replayed: true, balance: econBalance(fromUuid) };
    var c = econCheckAmount(amount, '转账金额');
    if (!c.ok) { econJournal('pay', actor, fromUuid, toUuid, amount, 'deny', c.error); return c; }
    if (fromUuid === toUuid) { econJournal('pay', actor, fromUuid, toUuid, amount, 'deny', '不能转给自己'); return { ok: false, error: '不能转给自己' }; }
    var fee = econFeeOf(c.value);
    var need = c.value + fee;
    var cur = econBalance(fromUuid);
    if (cur < need) {
      var msg = '余额不足（当前 ' + cur + '，需要 ' + need + (fee ? '，含手续费 ' + fee : '') + '）';
      econJournal('pay', actor, fromUuid, toUuid, c.value, 'deny', msg);
      econRemember(opId, 'deny');
      return { ok: false, error: msg };
    }
    var d = econDebit(fromUuid, need, 'burn');           // 手续费直接销毁
    if (!d.ok) { econJournal('pay', actor, fromUuid, toUuid, c.value, 'fail', d.error); return d; }
    var cr = econCredit(toUuid, c.value, 'mint');        // 账本内部转移：计入 minted 与 burned 使不变量仍成立
    if (!cr.ok) { econRestoreDebit(fromUuid, need, 'burn'); econJournal('pay', actor, fromUuid, toUuid, c.value, 'rollback', cr.error); return cr; }
    econJournal('pay', actor, fromUuid, toUuid, c.value, 'ok', fee ? ('fee=' + fee) : '');
    econRemember(opId, 'ok');
    return { ok: true, fromBalance: econBalance(fromUuid), toBalance: econBalance(toUuid), fee: fee };
  },

  // 发放（账本→物品）：先扣账本，再给物品；失败回滚
  withdraw: function (actor, player, amount, opId) {
    var rep = econReplay(opId);
    if (rep !== undefined && rep != null) return { ok: true, replayed: true };
    var c = econCheckAmount(amount, '提取金额');
    if (!c.ok) { econJournal('withdraw', actor, WAR.uuidOf(player), null, amount, 'deny', c.error); return c; }
    var u = WAR.uuidOf(player);
    if (u === '') { econJournal('withdraw', actor, '-', null, amount, 'deny', '目标无 UUID'); return { ok: false, error: '目标玩家无 UUID' }; }
    var d = econDebit(u, c.value, 'withdraw');
    if (!d.ok) { econJournal('withdraw', actor, u, null, c.value, 'deny', d.error); econRemember(opId, 'deny'); return d; }
    var got = econGiveItems(player, c.value);
    if (got !== c.value) {
      // 物品侧没给全：把账本改回原值（只回滚没发出去的部分）
      var back = c.value - Math.max(0, got);
      econRestoreDebit(u, back, 'withdraw');
      var err = (got < 0) ? '背包不可用' : ('物品只发放 ' + got + '/' + c.value);
      econJournal('withdraw', actor, u, null, back, 'rollback', err);
      econRemember(opId, 'rollback');
      return { ok: false, error: err, rolledBack: back, balance: econBalance(u) };
    }
    econJournal('withdraw', actor, u, null, c.value, 'ok', 'items=' + got);
    econRemember(opId, 'ok');
    return { ok: true, balance: econBalance(u), items: got };
  },

  // 回收（物品→账本）：先清点物品，再记帐本，再取物品；取出少于清点就回滚
  deposit: function (actor, player, amount, opId) {
    var rep = econReplay(opId);
    if (rep !== undefined && rep != null) return { ok: true, replayed: true };
    var c = econCheckAmount(amount, '存入金额');
    if (!c.ok) { econJournal('deposit', actor, WAR.uuidOf(player), null, amount, 'deny', c.error); return c; }
    var u = WAR.uuidOf(player);
    if (u === '') { econJournal('deposit', actor, '-', null, amount, 'deny', '目标无 UUID'); return { ok: false, error: '目标玩家无 UUID' }; }
    var have = econCountItems(player);
    if (have < 0) { econJournal('deposit', actor, u, null, c.value, 'fail', '背包不可用'); return { ok: false, error: '背包不可用' }; }
    if (have < c.value) {
      var msg = '身上的 ' + ECON_CONFIG.currencyItem + ' 不足（现有 ' + have + '，需要 ' + c.value + '）';
      econJournal('deposit', actor, u, null, c.value, 'deny', msg);
      econRemember(opId, 'deny');
      return { ok: false, error: msg };
    }
    // 先记账本（回收结果有据可查），再取物品；取出不足则按实际数回滚
    var cr = econCredit(u, c.value, 'deposit');
    if (!cr.ok) { econJournal('deposit', actor, u, null, c.value, 'fail', cr.error); return cr; }
    var taken = econTakeItems(player, c.value);
    if (taken !== c.value) {
      var back = c.value - Math.max(0, taken);
      econRestoreCredit(u, back, 'deposit');
      var err = '实际只取到 ' + Math.max(0, taken) + '/' + c.value + ' 件';
      econJournal('deposit', actor, u, null, back, 'rollback', err);
      econRemember(opId, 'rollback');
      return { ok: false, error: err, rolledBack: back, balance: econBalance(u) };
    }
    econJournal('deposit', actor, u, null, c.value, 'ok', 'items=' + taken);
    econRemember(opId, 'ok');
    return { ok: true, balance: econBalance(u), items: taken };
  },

  invariant: econInvariant,
  total: econTotal,
  journalText: function (n) {
    var e = econNorm();
    if (e == null) return '无数据';
    var list = e.journal.slice(Math.max(0, e.journal.length - warToInt(n, 10)));
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      out.push('#' + r.seq + ' ' + WAR.fmtTime(r.t) + ' ' + r.kind + ' ' + r.from + '->' + r.to + ' ' + r.amount + ' ' + r.result);
    }
    return out.length ? out.join(' | ') : '暂无流水';
  }
};

// ============================================================================
// 3. 命令：/war money ...
// ============================================================================

WAR.commands.add(function (Commands, Arguments, event) {
  var S = Arguments.STRING.create(event);
  var I = Arguments.INTEGER.create(event);
  var P = Arguments.PLAYER.create(event);

  function intOf(ctx, name) { return warToInt(Arguments.INTEGER.getResult(ctx, name), -1); }
  function playerOf(ctx, name) { try { return Arguments.PLAYER.getResult(ctx, name); } catch (e) { return null; } }
  function actorName(ctx) { try { var p = ctx.source.getPlayer(); if (p != null) return WAR.nameOf(p); } catch (e) { } return 'console'; }
  function selfPlayer(ctx) { try { return ctx.source.getPlayer(); } catch (e) { return null; } }

  function replyResult(ctx, res, okMsg) {
    if (res == null) { WAR.reply(ctx.source, '经济操作未产生结果'); return 0; }
    if (res.ok === false) { WAR.reply(ctx.source, '✗ ' + res.error); return 1; }
    WAR.reply(ctx.source, okMsg);
    return 1;
  }

  var money = Commands.literal('money')
    .executes(function (ctx) {
      return WAR.reply(ctx.source, '用法：/war money balance | pay <玩家> <数量> | deposit [数量] | withdraw <数量> | admin give|take <玩家> <数量>');
    })
    .then(Commands.literal('balance').executes(function (ctx) {
      var p = selfPlayer(ctx);
      if (p == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
      var u = WAR.uuidOf(p);
      var inv = econInvariant();
      return WAR.reply(ctx.source, '账本余额 ' + econBalance(u) + ' ' + ECON_CONFIG.ledgerKey +
        '（物品 ' + ECON_CONFIG.currencyItem + ' 现值 ' + econCountItems(p) + '；全服在账 ' + econTotal() +
        '，不变量 ' + (inv.ok ? 'OK' : '失衡 ' + inv.delta) + '）');
    }))
    .then(Commands.literal('pay')
      .then(Commands.argument('player', P)
        .then(Commands.argument('amount', I).executes(function (ctx) {
          var p = selfPlayer(ctx);
          if (p == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
          var target = playerOf(ctx, 'player');
          var res = WAR_ECON.pay(actorName(ctx), WAR.uuidOf(p), WAR.uuidOf(target), intOf(ctx, 'amount'), null);
          if (res.ok === false) { WAR.reply(ctx.source, '✗ ' + res.error); return 1; }
          WAR.reply(ctx.source, '已转 ' + intOf(ctx, 'amount') + ' 给 ' + WAR.nameOf(target) +
            '（你剩 ' + res.fromBalance + '，对方 ' + res.toBalance + (res.fee ? '，手续费 ' + res.fee : '') + '）');
          WAR.tell(target, '收到 ' + WAR.nameOf(p) + ' 转来的 ' + intOf(ctx, 'amount') + ' ' + ECON_CONFIG.ledgerKey);
          return 1;
        }))))
    .then(Commands.literal('deposit')
      .executes(function (ctx) {
        var p = selfPlayer(ctx);
        if (p == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
        var have = econCountItems(p);
        if (have <= 0) return WAR.reply(ctx.source, '身上没有 ' + ECON_CONFIG.currencyItem);
        var res = WAR_ECON.deposit(actorName(ctx), p, have, null);
        return replyResult(ctx, res, '已存入 ' + have + '，账本余额 ' + res.balance);
      })
      .then(Commands.argument('amount', I).executes(function (ctx) {
        var p = selfPlayer(ctx);
        if (p == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
        var res = WAR_ECON.deposit(actorName(ctx), p, intOf(ctx, 'amount'), null);
        return replyResult(ctx, res, '已存入 ' + intOf(ctx, 'amount') + '，账本余额 ' + res.balance);
      })))
    .then(Commands.literal('withdraw')
      .then(Commands.argument('amount', I).executes(function (ctx) {
        var p = selfPlayer(ctx);
        if (p == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
        var res = WAR_ECON.withdraw(actorName(ctx), p, intOf(ctx, 'amount'), null);
        return replyResult(ctx, res, '已取出 ' + intOf(ctx, 'amount') + ' 件，账本余额 ' + res.balance);
      })))
    .then(Commands.literal('admin')
      .requires(function (src) { return WAR.hasPermission(src, WAR.config.admin.commandPermissionLevel); })
      .executes(function (ctx) { return WAR.reply(ctx.source, '用法：/war money admin give|take <玩家> <数量> | status'); })
      .then(Commands.literal('status').executes(function (ctx) {
        return WAR.reply(ctx.source, JSON.stringify(WAR_ECON.status()));
      }))
      .then(Commands.literal('give')
        .then(Commands.argument('player', P)
          .then(Commands.argument('amount', I).executes(function (ctx) {
            var target = playerOf(ctx, 'player');
            var amount = intOf(ctx, 'amount');
            var res = WAR_ECON.mint(actorName(ctx), WAR.uuidOf(target), amount, null);
            if (res.ok === false) { WAR.reply(ctx.source, '✗ ' + res.error); return 1; }
            WAR.reply(ctx.source, '已向 ' + WAR.nameOf(target) + ' 铸造 ' + amount + '（其账本余额 ' + res.balance + '）');
            WAR.tell(target, '管理员向你发放了 ' + amount + ' ' + ECON_CONFIG.ledgerKey);
            return 1;
          }))))
      .then(Commands.literal('take')
        .then(Commands.argument('player', P)
          .then(Commands.argument('amount', I).executes(function (ctx) {
            var target = playerOf(ctx, 'player');
            var amount = intOf(ctx, 'amount');
            var res = WAR_ECON.burn(actorName(ctx), WAR.uuidOf(target), amount, null);
            if (res.ok === false) { WAR.reply(ctx.source, '✗ ' + res.error); return 1; }
            WAR.reply(ctx.source, '已从 ' + WAR.nameOf(target) + ' 回收 ' + amount + '（其账本余额 ' + res.balance + '）');
            return 1;
          })))));

  WAR.commands.helpLine('/war money balance', '查看账本余额（' + ECON_CONFIG.ledgerKey + '）与手上物品数');
  WAR.commands.helpLine('/war money pay <玩家> <数量>', '账本转账（单笔 ' + ECON_CONFIG.payMin + '-' + ECON_CONFIG.payMax + '）');
  WAR.commands.helpLine('/war money deposit [数量]', '把 ' + ECON_CONFIG.currencyItem + ' 物品存入账本');
  WAR.commands.helpLine('/war money withdraw <数量>', '从账本取出 ' + ECON_CONFIG.currencyItem + ' 物品');
  WAR.commands.helpLine('/war money admin give|take <玩家> <数量>', 'OP' + WAR.config.admin.commandPermissionLevel + '：铸造 / 回收');
  return money;
});

// 载入时校正结构 + 报不变量
WAR.hooks.boot.push(function () {
  try {
    econNorm();
    var inv = econInvariant();
    if (!inv.ok) console.error('[econ] 不变量失衡：Σbalance=' + inv.actual + ' 期望=' + inv.expect);
    else econLog('账本就绪（在账 ' + econTotal() + '，不变量 OK）');
  } catch (e) { console.error('[econ] 初始化失败：' + e); }
});

// 首次进服：记首见；若 firstJoinGrant > 0 才发放（暂定默认值 0 ⇒ 只记账不发放，行为与迁入前一致）
// 幂等用 opId 'first-join:<uuid>'：即使 joined 记录丢失，重放也不会二次发放。
PlayerEvents.loggedIn(function (event) {
  try {
    var e = econNorm();
    if (e == null) return;
    var p = event.player;
    var u = WAR.uuidOf(p);
    if (u === '') return;
    if (e.joined[u] == null) {
      e.joined[u] = warNow();
      WAR.data.touch();
      var grant = warToInt(ECON_CONFIG.firstJoinGrant, 0);
      if (grant > 0) {
        var r = WAR_ECON.mint('system', u, grant, 'first-join:' + u);
        if (r.ok === true) {
          WAR.tell(p, '首次进服获得 ' + grant + ' ' + ECON_CONFIG.ledgerKey);
          econLog('首次进服发放 ' + grant + ' → ' + WAR.nameOf(p));
        }
      } else {
        WAR.audit.append('system', 'econ.firstJoin', u, 'skip', 'firstJoinGrant=0（暂定默认值，未发放）');
      }
    }
  } catch (err) { console.error('[econ] 首次进服处理失败：' + err); }
});

global.WAR.econ = WAR_ECON;   // 覆盖 00_core.js 的 econ stub
warLog('30_economy.js 已加载：经济账本就绪（货币 ' + ECON_CONFIG.currencyItem + ' / 账本键 ' + ECON_CONFIG.ledgerKey + '）');
