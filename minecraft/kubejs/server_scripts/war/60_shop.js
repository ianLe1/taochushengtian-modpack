// ============================================================================
// 战服 · 60_shop.js —— 系统商店（M1 最小版）
// ============================================================================
// 数据与代码分离（lead 规格）：**价格是数据**，在 minecraft/kubejs/data/war/shop/catalog.json，
//   服务器主人直接编辑该文件即可；本文件只**读**它，不写、不改。
// 货币纪律（lead 硬要求）：买卖的钱侧一律走 30_economy 的账本 API（mint / burn / withdraw / deposit），
//   **本文件不自己改任何余额数字**。顺序：
//     · 买入 = 先账本（burn 扣款）→ 后物品（给货）；物品没给全 → 用 mint 退回未交付部分（仍走账本 API）
//     · 卖出 = 先物品（收走货）→ 后账本（mint 进款）；进款失败 → 把物品退还给玩家
//   两处都写审计（shop.buy / shop.sell，result = ok / deny / rollback）。
// 边界（lead 划定）：不做文件导出、不做限购（M5）、不做破坏性操作；本文件不碰 00_core/10_team/20_spawn/
//   30_economy/90_admin。
// 已核实 API：JsonIO.readString(java.nio.file.Path)（javap 实证，另有 readJson/parse/write）；
//   Path.of(String) 为标准 Java API；InventoryKJS.insertItem/getSlots/getStackInSlot/extractItem；
//   Item.getId(Item)；WAR.econ.{burn,mint,withdraw,deposit,balanceOf,total,invariant}；WAR.audit.append。
// ============================================================================

// 暂定默认值（lead 批复的口径）。注意：core 的 WAR_CONFIG.shop 只声明了 { enabled:false, catalogPath }，
//   enabled 的旧值 false 是实现前占位；按「单一起源」我不改 core 文件，只在本域加载时把口径对齐到批复值，
//   并在交付报告里列明。要改回文件里的字面值，改 00_core.js 一行即可（需报备）。
var SHOP_CONFIG = WAR.config.shop;
SHOP_CONFIG.enabled = true;              // 暂定默认值：商店默认开放
SHOP_CONFIG.spread = 0;                  // 暂定默认值：买卖差价（0 = 卖出价省略时按 buy 同价）
SHOP_CONFIG.maxPerTransaction = 64;      // 暂定默认值：单次上限

var SHOP_CATALOG = { loaded: false, source: null, error: null, items: [], byId: {} };

function shopLog(msg) { warLog('[shop] ' + msg); }

// ----------------------------------------------------------------------------
// 0. 货架读取（只读）
// ----------------------------------------------------------------------------
function shopCandidatePaths() {
  var out = [], cfg = SHOP_CONFIG.catalogPath;
  if (cfg != null && String(cfg) !== '') {
    out.push('kubejs/data/' + cfg);
    out.push('minecraft/kubejs/data/' + cfg);
  }
  out.push('minecraft/kubejs/data/war/shop/catalog.json');
  out.push('kubejs/data/war/shop/catalog.json');
  return out;
}

function shopReadText(file) {
  var PathCls = Java.loadClass('java.nio.file.Path');
  return String(JsonIO.readString(PathCls.of(String(file))));
}

function shopParse(text) {
  try { if (typeof JSON !== 'undefined' && JSON != null && typeof JSON.parse === 'function') return JSON.parse(text); } catch (e) { }
  return JsonIO.parse(String(text));     // 备用：JsonIO.parse(String) 已核实存在
}

function shopLoad() {
  var cands = shopCandidatePaths(), lastErr = null;
  for (var i = 0; i < cands.length; i++) {
    try {
      var obj = shopParse(shopReadText(cands[i]));
      if (obj == null || obj.items == null || typeof obj.items.length !== 'number') throw new Error('catalog.items 不是数组');
      var list = [], byId = {};
      for (var k = 0; k < obj.items.length; k++) {
        var it = obj.items[k];
        if (it == null || it.id == null) continue;
        var id = String(it.id);
        list.push(it); byId[id] = it;
      }
      SHOP_CATALOG.items = list; SHOP_CATALOG.byId = byId;
      SHOP_CATALOG.loaded = true; SHOP_CATALOG.source = cands[i]; SHOP_CATALOG.error = null;
      shopLog('货架载入 ' + list.length + ' 项（source=' + cands[i] + '）');
      return true;
    } catch (e) { lastErr = e; }
  }
  SHOP_CATALOG.loaded = false; SHOP_CATALOG.source = null;
  SHOP_CATALOG.items = []; SHOP_CATALOG.byId = {}; SHOP_CATALOG.error = String(lastErr);
  warWarnOnce('shop-catalog', '货架读取失败（/war shop list 会如实告知）：' + lastErr);
  return false;
}

// ----------------------------------------------------------------------------
// 1. 价格（数据 → 数字；本层不做经济判断，只做口径换算）
// ----------------------------------------------------------------------------
function shopSpend() {
  var sp = Number(SHOP_CONFIG.spread);
  if (isNaN(sp) || sp < 0) sp = 0;
  if (sp > 0.9) sp = 0.9;
  return sp;
}

function shopPrice(entry, side) {
  if (entry == null) return -1;
  if (side === 'sell') {
    if (entry.sell != null) return warToInt(entry.sell, -1);
    return Math.round(warToInt(entry.buy, 0) * (1 - shopSpend()));
  }
  return warToInt(entry.buy, -1);
}

function shopIsCurrency(id) {
  var s = String(id);
  return s === String(WAR.config.econ.currencyItem) || s === 'war:credit';
}

function shopListText() {
  if (!SHOP_CATALOG.loaded) {
    return '货架未载入（' + (SHOP_CATALOG.error || '未知原因') + '）｜请检查 minecraft/kubejs/data/war/shop/catalog.json';
  }
  if (SHOP_CATALOG.items.length === 0) return '货架是空的（catalog.json 里 items 为空）';
  var parts = [];
  for (var i = 0; i < SHOP_CATALOG.items.length; i++) {
    var e = SHOP_CATALOG.items[i];
    if (e == null || e.id == null) continue;
    parts.push(String(e.id) + (e.label ? '（' + e.label + '）' : '') + ' 买' + shopPrice(e, 'buy') + '/卖' + shopPrice(e, 'sell'));
  }
  return '货架(' + parts.length + ')｜' + parts.join('｜') + '｜单位=' + WAR.config.econ.ledgerKey;
}

// ----------------------------------------------------------------------------
// 2. 物品侧（通用物品；与 30_economy 的 credit 专用实现同源，但这里不限物品 id）
// ----------------------------------------------------------------------------
function shopItemId(stack) {
  if (stack == null) return '';
  try { var a = stack.id; if (a != null && String(a) !== '') return String(a); } catch (e1) { }
  try { var it = stack.getItem(); var b = Item.getId(it); if (b != null) return String(b); } catch (e2) { }
  try { return String(stack.getItem()); } catch (e3) { }
  return '';
}

function shopStackCount(stack) {
  if (stack == null) return 0;
  try { var a = stack.count; if (typeof a === 'number') return a; } catch (e1) { }
  try { var b = stack.getCount(); if (typeof b === 'number') return b; } catch (e2) { }
  return 1;
}

function shopStackEmpty(s) {
  try { if (s.isEmpty && s.isEmpty() === true) return true; } catch (e1) { }
  try { if (shopStackCount(s) <= 0) return true; } catch (e2) { }
  return false;
}

function shopInv(p) {
  if (p == null) return null;
  try { var a = p.inventory; if (a != null) return a; } catch (e1) { }
  try { var b = p.getInventory(); if (b != null) return b; } catch (e2) { }
  return null;
}

function shopCount(p, id) {
  var inv = shopInv(p);
  if (inv == null) return -1;
  var n = 0, want = String(id);
  try {
    var slots = inv.getSlots();
    for (var i = 0; i < slots; i++) {
      var s = inv.getStackInSlot(i);
      if (s != null && !shopStackEmpty(s) && shopItemId(s) === want) n += shopStackCount(s);
    }
  } catch (e) { warWarnOnce('shop-count', '背包清点失败：' + e); return -1; }
  return n;
}

// 从背包取走指定物品；返回实际取走数量
function shopTake(p, id, amount) {
  var inv = shopInv(p);
  if (inv == null) return -1;
  var want = String(id), need = amount, taken = 0;
  try {
    var slots = inv.getSlots();
    for (var i = 0; i < slots && need > 0; i++) {
      var s = inv.getStackInSlot(i);
      if (s == null || shopStackEmpty(s) || shopItemId(s) !== want) continue;
      var give = Math.min(need, shopStackCount(s)), got = null;
      try { got = inv.extractItem(i, give, false); } catch (e1) { got = null; }
      var gotN = (got == null) ? 0 : shopStackCount(got);
      taken += gotN; need -= gotN;
      if (gotN < give) break;
    }
  } catch (e2) { warWarnOnce('shop-take', '背包取物失败：' + e2); return taken; }
  return taken;
}

// 给物品；返回**实际放入背包的数量**（-1 = 背包不可用）。放不下的不落地，由调用方按差额回滚。
function shopGive(p, id, amount) {
  if (p == null) return -1;
  try {
    var stack = Item.of(String(id), amount);
    if (stack == null) return -1;
    var inv = shopInv(p);
    if (inv == null) return -1;
    var rest = inv.insertItem(stack, false);
    var restN = (rest == null) ? 0 : shopStackCount(rest);
    return amount - restN;
  } catch (e) { warWarnOnce('shop-give', '发货失败：' + e); return -1; }
}

// ----------------------------------------------------------------------------
// 3. 买卖（钱侧全走 30_economy；本文件不自己改余额）
// ----------------------------------------------------------------------------
function shopGuard(actor, player, id, n) {
  if (SHOP_CONFIG.enabled !== true) return { ok: false, error: '商店未开放（WAR_CONFIG.shop.enabled=false）' };
  if (!SHOP_CATALOG.loaded) return { ok: false, error: '货架未载入：' + (SHOP_CATALOG.error || '未知原因') };
  var e = WAR_SHOP.entryOf(id);
  if (e == null) return { ok: false, error: '货架没有这件商品：' + id };
  if (shopIsCurrency(e.id)) return { ok: false, error: '货币本身不上架；账本↔物品请用 /war money deposit|withdraw' };
  var maxN = warToInt(SHOP_CONFIG.maxPerTransaction, 64);
  var q = warToInt(n, 1);
  if (q < 1) return { ok: false, error: '数量必须为正整数' };
  if (q > maxN) return { ok: false, error: '单次最多 ' + maxN + ' 个（本次 ' + q + '）' };
  var uuid = (player == null) ? '' : WAR.uuidOf(player);
  if (uuid === '') return { ok: false, error: '读不到你的 UUID' };
  return { ok: true, entry: e, qty: q, uuid: uuid };
}

function shopBuy(actor, player, id, n) {
  var g = shopGuard(actor, player, id, n);
  if (g.ok !== true) {
    if (WAR_SHOP.entryOf(id) != null || !SHOP_CATALOG.loaded || SHOP_CONFIG.enabled !== true) {
      WAR.audit.append(actor, 'shop.buy', String(id), 'deny', g.error);
    }
    return g;
  }
  var unit = shopPrice(g.entry, 'buy');
  if (unit <= 0) { WAR.audit.append(actor, 'shop.buy', String(id), 'deny', 'buy 价不合法：' + g.entry.buy); return { ok: false, error: '货架价格不合法（buy=' + g.entry.buy + '）' }; }
  var total = unit * g.qty;
  var payMax = warToInt(WAR.config.econ.payMax, 1000);
  if (total > payMax) { WAR.audit.append(actor, 'shop.buy', String(id), 'deny', '超单笔上限 ' + payMax); return { ok: false, error: '本次共 ' + total + '，超过账本单笔上限 ' + payMax + '，请分次购买' }; }
  // 先账本：burn 扣款（走 30_economy，不在本文件改余额）
  var burn = WAR.econ.burn(actor, g.uuid, total, null);
  if (burn.ok !== true) { WAR.audit.append(actor, 'shop.buy', String(id), 'deny', burn.error); return { ok: false, error: burn.error }; }
  // 后物品：给货；没给全就按差额用账本 API 退回
  var inserted = shopGive(player, g.entry.id, g.qty);
  if (inserted !== g.qty) {
    var back = (g.qty - Math.max(0, inserted)) * unit;
    if (back > 0) WAR.econ.mint(actor, g.uuid, back, null);
    WAR.audit.append(actor, 'shop.buy', String(id), 'rollback', '只交付 ' + Math.max(0, inserted) + '/' + g.qty + '，退回 ' + back);
    return { ok: false, error: '背包放不下：已交付 ' + Math.max(0, inserted) + '/' + g.qty + '，退回 ' + back + ' ' + WAR.config.econ.ledgerKey, rolledBack: back, balance: WAR.econ.balanceOf(g.uuid) };
  }
  WAR.audit.append(actor, 'shop.buy', String(id), 'ok', g.qty + '×' + unit + '=' + total);
  return { ok: true, qty: g.qty, unit: unit, total: total, balance: WAR.econ.balanceOf(g.uuid) };
}

function shopSell(actor, player, id, n) {
  var g = shopGuard(actor, player, id, n);
  if (g.ok !== true) {
    if (WAR_SHOP.entryOf(id) != null || !SHOP_CATALOG.loaded || SHOP_CONFIG.enabled !== true) {
      WAR.audit.append(actor, 'shop.sell', String(id), 'deny', g.error);
    }
    return g;
  }
  var unit = shopPrice(g.entry, 'sell');
  if (unit < 0) { WAR.audit.append(actor, 'shop.sell', String(id), 'deny', 'sell 价不合法'); return { ok: false, error: '货架回收价不合法' }; }
  var have = shopCount(player, g.entry.id);
  if (have < 0) { WAR.audit.append(actor, 'shop.sell', String(id), 'deny', '背包不可用'); return { ok: false, error: '背包不可用' }; }
  if (have < g.qty) { WAR.audit.append(actor, 'shop.sell', String(id), 'deny', '持有不足 ' + have + '/' + g.qty); return { ok: false, error: '你身上只有 ' + have + ' 个 ' + g.entry.id }; }
  // 先物品：收走货
  var taken = shopTake(player, g.entry.id, g.qty);
  if (taken !== g.qty) {                       // 极少数：清点后取物失败 — 已取走的按量进款，其余照原样告知
    if (taken <= 0) { WAR.audit.append(actor, 'shop.sell', String(id), 'fail', '取物失败'); return { ok: false, error: '取物失败（背包异常）' }; }
  }
  var payout = unit * taken;
  var payMax = warToInt(WAR.config.econ.payMax, 1000);
  if (payout > payMax) {                        // 进款超账本单笔上限 → 把货退回去，不留半截状态
    var backItems = shopGive(player, g.entry.id, taken);
    WAR.audit.append(actor, 'shop.sell', String(id), 'rollback', '进款 ' + payout + ' 超单笔上限 ' + payMax + '，退货 ' + backItems);
    return { ok: false, error: '本次应收 ' + payout + '，超过账本单笔上限 ' + payMax + '，请分次卖出' };
  }
  // 后账本：mint 进款；失败就把货退回去
  var mint = WAR.econ.mint(actor, g.uuid, payout, null);
  if (mint.ok !== true) {
    var backN = shopGive(player, g.entry.id, taken);
    WAR.audit.append(actor, 'shop.sell', String(id), 'rollback', '进款失败：' + mint.error + '，退货 ' + backN);
    return { ok: false, error: mint.error, returned: backN };
  }
  WAR.audit.append(actor, 'shop.sell', String(id), 'ok', taken + '×' + unit + '=' + payout);
  return { ok: true, qty: taken, unit: unit, total: payout, balance: WAR.econ.balanceOf(g.uuid) };
}

// ----------------------------------------------------------------------------
// 4. 域对象（覆盖 core 的 shop stub；stubStatus 聚合会读 status()）
// ----------------------------------------------------------------------------
var WAR_SHOP = {
  __stub: false,
  __owner: '60_shop.js',
  config: SHOP_CONFIG,
  catalog: function () { return SHOP_CATALOG; },
  entries: function () { return SHOP_CATALOG.items; },
  entryOf: function (id) { return SHOP_CATALOG.byId[String(id)] || null; },
  priceOf: function (id, side) { return shopPrice(WAR_SHOP.entryOf(id), side || 'buy'); },
  listText: shopListText,
  reload: shopLoad,
  buy: shopBuy,
  sell: shopSell,
  count: shopCount,
  status: function () {
    return {
      domain: 'shop', implemented: true, owner: '60_shop.js',
      enabled: SHOP_CONFIG.enabled === true,
      catalogLoaded: SHOP_CATALOG.loaded, catalogSource: SHOP_CATALOG.source,
      catalogError: SHOP_CATALOG.error, items: SHOP_CATALOG.items.length,
      spread: shopSpend(), maxPerTransaction: warToInt(SHOP_CONFIG.maxPerTransaction, 64),
      catalogPath: SHOP_CONFIG.catalogPath
    };
  }
};
global.WAR.shop = WAR_SHOP;

// ----------------------------------------------------------------------------
// 5. 命令：/war shop list | buy <id> [n] | sell <id> [n]
// ----------------------------------------------------------------------------
WAR.commands.add(function (Commands, Arguments, event) {
  var S = Arguments.STRING.create(event);
  var I = Arguments.INTEGER.create(event);

  function strOf(ctx, name) { try { var v = Arguments.STRING.getResult(ctx, name); return v == null ? '' : String(v); } catch (e) { return ''; } }
  function intOf(ctx, name, dft) { return warIntArg(Arguments.INTEGER, ctx, name, dft); }
  function selfPlayer(ctx) { try { return ctx.source.getPlayer(); } catch (e) { return null; } }

  function needPlayer(ctx) {
    var p = selfPlayer(ctx);
    if (p == null) { WAR.reply(ctx.source, '该命令只能由玩家执行'); return null; }
    return p;
  }

  function doBuy(ctx, qty) {
    var p = needPlayer(ctx); if (p == null) return 0;
    var id = strOf(ctx, 'id');
    var res = WAR_SHOP.buy(WAR.actorName(ctx.source), p, id, qty);
    if (res.ok !== true) { WAR.reply(ctx.source, '✗ ' + res.error); return 1; }
    WAR.reply(ctx.source, '买入 ' + res.qty + '×' + id + '（-' + res.total + ' ' + WAR.config.econ.ledgerKey + '，余额 ' + res.balance + '）');
    return 1;
  }
  function doSell(ctx, qty) {
    var p = needPlayer(ctx); if (p == null) return 0;
    var id = strOf(ctx, 'id');
    var res = WAR_SHOP.sell(WAR.actorName(ctx.source), p, id, qty);
    if (res.ok !== true) { WAR.reply(ctx.source, '✗ ' + res.error); return 1; }
    WAR.reply(ctx.source, '卖出 ' + res.qty + '×' + id + '（+' + res.total + ' ' + WAR.config.econ.ledgerKey + '，余额 ' + res.balance + '）');
    return 1;
  }

  var shop = Commands.literal('shop')
    .executes(function (ctx) { return WAR.reply(ctx.source, '用法：/war shop list | buy <商品id> [数量] | sell <商品id> [数量]'); })
    .then(Commands.literal('list').executes(function (ctx) { return WAR.reply(ctx.source, WAR_SHOP.listText()); }))
    .then(Commands.literal('buy')
      .then(Commands.argument('id', S)
        .executes(function (ctx) { return doBuy(ctx, 1); })
        .then(Commands.argument('n', I).executes(function (ctx) { return doBuy(ctx, intOf(ctx, 'n', 1)); }))))
    .then(Commands.literal('sell')
      .then(Commands.argument('id', S)
        .executes(function (ctx) { return doSell(ctx, 1); })
        .then(Commands.argument('n', I).executes(function (ctx) { return doSell(ctx, intOf(ctx, 'n', 1)); }))));

  WAR.commands.helpLine('/war shop list', '看货架（价格来自 data/war/shop/catalog.json，可直接编辑）');
  WAR.commands.helpLine('/war shop buy <商品id> [数量]', '买入：先账本扣款 → 再给物品，未交付部分退回');
  WAR.commands.helpLine('/war shop sell <商品id> [数量]', '卖出：先收物品 → 再账本进款，进款失败则退物');
  return shop;
});

// 载入时读货架（只读；失败只告警，不抛出）
WAR.hooks.boot.push(function () { try { shopLoad(); } catch (e) { warWarnOnce('shop-boot', '货架载入异常：' + e); } });

warLog('60_shop.js 已加载：商店就绪（enabled=' + (SHOP_CONFIG.enabled === true) + '，货架 ' + SHOP_CATALOG.items.length + ' 项，挂载时读取）');
