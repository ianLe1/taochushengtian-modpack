// ============================================================================
// 战服 · 40_base.js —— 据点域（**隐性人工程度**模型，M3 最小实现）
// ============================================================================
// 口径来源：用户「基地判定是按照人为化程度来，是隐性的」+ CM 的口径一页纸
//   （.team/drafts/chunk-metrics/口径一页纸-a-d.md，121 行，md5 9283cef0…）：a/d ∈ [0,1] 小数、有饱和、
//   不是计数；**A 不按面积归一**（C1 在单区块内算体量）⇒ 同建筑跨区块会被切断、每块 a 变小。
//   ⇒ 因此**禁止用「单区块 a 高」当据点判据**：本文件一律在**区域尺度聚合**，且聚合窗口覆盖 1–2 块边界。
//   **聚合方式 = 区域内新鲜区块的 a 求和**（不是取最大、也不是简单平均）——理由：单块 a 被区块边界切碎后，
//   求和能同时表达「体量」与「跨区」，而 max 只看最高一块（单块高就成据点，噪声大）、平均会被空地稀释
//   （大基地周围一圈空地会把均值拉到门槛以下）。求和的口径与「单位」已写进 core 的 WAR_CONFIG.base 注释。
// 只读纪律：本域只调 CM 的只读接口（scoreArea / getStatus / rev / calib），**不 analyze、不加载区块、不写 CM 数据**。
// 范围（lead 限定，只做不依赖实机结论的部分）：据点状态机（含**未标定拒绝**）+ CM 区域聚合 + 审计/通知 + 参数全 CONFIG。
//   **不做**：BlockEvents.placed 真归因（未证实）、事件加速判定接线（等实机）、废墟视觉。
// 数据落点：state.base（core 的 save/load 已持久化该键；不新增 core 字段、不碰其他域文件）。
// ============================================================================

var BASE_CONFIG = WAR.config.base;   // 唯一真源 = core 的 WAR_CONFIG.base（本文件不写 BASE_CONFIG.xxx = 赋值）

function baseLog(m) { warLog('[base] ' + m); }
// 数值显示：4 位小数（本域私有小工具；**不复用别人的域私有函数**，避免跨域耦合）
function baseFmt(v) { var n = Number(v); return isNaN(n) ? '-' : n.toFixed(4); }

// ----------------------------------------------------------------------------
// 0. 标定门（未标定 ⇒ 明确拒绝工作，不用默认基线悄悄跑）
//    CM 的口径一页纸 §4 承认「未标定」当前没有独立状态（缺口），并给出修法建议：新增只读
//    calib:{calibrated,rev}。本文件**优先读该字段**，缺失时用 rev()>0 近似（CM_REV 初值 0、
//    只有 /cm calib 会 ++），两者都拿不到就拒绝并说明原因。
// ----------------------------------------------------------------------------
function baseCalib() {
  var out = { calibrated: false, rev: null, source: 'none', ok: false, reason: '' };
  try {
    if (typeof CM === 'undefined' || CM == null) { out.reason = 'CM（chunk_metrics）未加载'; return out; }
    var cal = null;
    try { cal = (typeof CM.calib === 'function') ? CM.calib() : CM.calib; } catch (e0) { cal = null; }
    if (cal != null && typeof cal === 'object' && cal.calibrated != null) {
      out.calibrated = cal.calibrated === true;
      out.rev = (cal.rev == null) ? null : warToInt(cal.rev, 0);
      out.source = 'calib-field';
      out.reason = out.calibrated ? '' : 'CM 报告未标定（calib.calibrated=false），请先跑 /cm calib';
    } else if (typeof CM.rev === 'function') {
      var r = warToInt(CM.rev(), 0);
      out.calibrated = r > 0; out.rev = r; out.source = 'rev-fallback';
      out.reason = out.calibrated ? '' : 'CM 未提供 calib 字段，且自然表版本 rev=0（未标定）——请先跑 /cm calib';
    } else {
      out.reason = 'CM 既无 calib 字段也无 rev()，无法判定标定状态';
    }
    out.ok = out.calibrated === true;
  } catch (e) { out.reason = '标定状态读取异常：' + e; }
  return out;
}

// ----------------------------------------------------------------------------
// 1. 区域聚合（CM.scoreArea；未知一律 null、绝不当 0）
// ----------------------------------------------------------------------------
function baseRadius() { return warClampInt(BASE_CONFIG.radiusChunks, 1, 32, 2); }

function baseAreaAgg(level, cx, cz) {
  if (level == null) return { ok: false, error: '缺少 level（CM 的 API 取 level 而不是 dim 字符串）' };
  var area = null;
  try { area = CM.scoreArea(level, cx, cz, baseRadius(), { freshOnly: false }); }
  catch (e) { return { ok: false, error: 'CM.scoreArea 异常：' + e }; }
  if (area == null || area.ok !== true) {
    return { ok: false, error: 'CM.scoreArea 未返回可用区域（ok=' + (area == null ? 'null' : area.ok) + '）' };
  }
  var aSum = 0, dSum = 0, fresh = 0, stale = 0, unknown = 0, readFail = 0, slots = 0;
  var cands = area.candidates || [];
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i]; slots++;
    if (c == null) { unknown++; continue; }                     // 槽位缺失按未知
    if (c.status === 'ok' && c.stale !== true) {
      if (c.a == null || c.d == null) { unknown++; continue; }  // 契约：未知必须 null
      aSum += Number(c.a); dSum += Number(c.d); fresh++;
    } else if (c.status === 'ok' && c.stale === true) { stale++; }
    else if (c.status === 'read-fail') { readFail++; }
    else { unknown++; }                                          // no-record 等
  }
  var minShare = Number(BASE_CONFIG.minFreshShare);
  if (isNaN(minShare) || minShare <= 0) minShare = 0.6;
  var share = (slots > 0) ? (fresh / slots) : 0;
  return {
    ok: true, enough: share >= minShare, aSum: aSum, dSum: dSum,
    fresh: fresh, stale: stale, unknown: unknown, readFail: readFail, slots: slots, share: share,
    curRev: area.curRev, counts: area.counts
  };
}

// ----------------------------------------------------------------------------
// 2. 据点状态（落 state.base；core 的 save/load 已覆盖该键）
// ----------------------------------------------------------------------------
function baseStateEnsure() {
  var st = WAR.data.state;
  if (st == null) return null;
  var b = st.base;
  if (b == null || typeof b !== 'object') { b = {}; st.base = b; }
  if (b.byId == null || typeof b.byId !== 'object') b.byId = {};
  if (typeof b.seq !== 'number') b.seq = 0;
  if (b.candidates == null || typeof b.candidates !== 'object') b.candidates = {};
  if (b.runtime == null || typeof b.runtime !== 'object') b.runtime = { lastScanTick: -1, lastScanAt: 0, lastResult: null };
  b.__stub = false; b.__owner = '40_base.js';
  return b;
}

function baseKey(cx, cz) { return warToInt(cx, 0) + ',' + warToInt(cz, 0); }

// 锚点 = 在线玩家所在区块（level 从玩家身上取，**规避未授权的 dim→level 解析**）+ 已有据点中心（只在其附近有人时才被扫到）
function baseAnchors(server) {
  var out = [], seen = {};
  var players = [];
  try { players = (server != null && server.getPlayers) ? server.getPlayers() : []; } catch (e) { players = []; }
  for (var i = 0; i < players.length; i++) {
    var p = players[i], lv = null, px = null, pz = null;
    try { lv = p.level; } catch (e1) { lv = null; }
    if (lv == null) { try { lv = p.getLevel(); } catch (e2) { lv = null; } }
    try { px = p.blockX; pz = p.blockZ; } catch (e3) { px = null; pz = null; }
    if (px == null || pz == null) continue;
    var cx = Math.floor(px / 16), cz = Math.floor(pz / 16), k = baseKey(cx, cz);
    if (seen[k]) continue;
    seen[k] = true;
    out.push({ cx: cx, cz: cz, level: lv, player: p, name: WAR.nameOf(p) });
  }
  return out;
}

function baseNotify(st, base, text) {
  var owner = base.owner || null;
  if (owner == null || owner.uuid == null) return;
  try {
    if (BASE_CONFIG.notifyTeam !== true) return;
    var ps = (WAR.data.server != null && WAR.data.server.getPlayers) ? WAR.data.server.getPlayers() : [];
    for (var i = 0; i < ps.length; i++) {
      var u = WAR.uuidOf(ps[i]);
      if (u === owner.uuid) { WAR.tell(ps[i], text); continue; }
      var t = WAR.team.of(ps[i]);
      if (t != null && owner.teamId != null && t.id === owner.teamId) WAR.tell(ps[i], text);
    }
  } catch (e) { warWarnOnce('base-notify', '据点通知失败：' + e); }
}

function baseApply(st, anchor, agg, tick, out) {
  var k = baseKey(anchor.cx, anchor.cz);
  var b = st.byId[k];
  if (b == null) {
    // 候选 → 形成
    if (agg.aSum < Number(BASE_CONFIG.aSumMin)) { delete st.candidates[k]; return; }
    var cand = st.candidates[k];
    if (cand == null) { st.candidates[k] = { cx: anchor.cx, cz: anchor.cz, since: tick, aSum: agg.aSum }; return; }
    cand.aSum = agg.aSum;
    if ((tick - warToInt(cand.since, tick)) < warToInt(BASE_CONFIG.holdTicks, 1200)) return;
    if (warCountKeys(st.byId) >= warToInt(BASE_CONFIG.maxBases, 64)) { out.skipped++; return; }
    st.seq = warToInt(st.seq, 0) + 1;
    b = {
      id: 'wb' + st.seq, cx: anchor.cx, cz: anchor.cz, state: 'intact',
      aSum: agg.aSum, aSumPeak: agg.aSum, dSum: agg.dSum, fresh: agg.fresh, slots: agg.slots,
      owner: { name: anchor.name, uuid: WAR.uuidOf(anchor.player), approx: true, source: 'approx-activity', since: tick },
      ownerSince: tick, absentSince: null, firstSeenAt: warNow(), lastSeenAt: warNow()
    };
    st.byId[k] = b; delete st.candidates[k];
    out.formed++;
    WAR.audit.append('system', 'base.formed', b.id, 'ok',
      'cx=' + b.cx + ' cz=' + b.cz + ' aSum=' + baseFmt(b.aSum) + ' dSum=' + baseFmt(b.dSum) + ' fresh=' + b.fresh + '/' + b.slots + ' owner=' + b.owner.name + '(approx)');
    baseNotify(st, b, '据点已形成（#' + b.id + '，区域 a 求和 ' + baseFmt(b.aSum) + '）——由人工程度推断，非声明');
    return;
  }
  // 已登记据点：更新与状态迁移
  b.aSum = agg.aSum; b.dSum = agg.dSum; b.fresh = agg.fresh; b.slots = agg.slots; b.lastSeenAt = warNow();
  if (agg.aSum > warToInt(b.aSumPeak, 0)) b.aSumPeak = agg.aSum;
  var drop = Number(BASE_CONFIG.aSumDrop); if (isNaN(drop)) drop = 0.4;
  var dMaxSum = Number(BASE_CONFIG.dSumMax); if (isNaN(dMaxSum)) dMaxSum = 2.0;
  if (b.state === 'intact' && (agg.aSum <= warToInt(b.aSumPeak, 0) - drop || agg.dSum >= dMaxSum)) {
    b.state = 'damaged'; b.damagedAt = warNow();
    out.damaged++;
    WAR.audit.append('system', 'base.damaged', b.id, 'ok',
      'cx=' + b.cx + ' cz=' + b.cz + ' aSum=' + baseFmt(agg.aSum) + '(峰值 ' + baseFmt(b.aSumPeak) + ') dSum=' + baseFmt(agg.dSum) + ' 注意=与自建时的正常破坏需数据标定区分');
  }
  if (b.state === 'damaged' && b.absentSince != null && (tick - warToInt(b.absentSince, tick)) >= warToInt(BASE_CONFIG.absentTicks, 24000)) {
    b.state = 'abandoned';
    out.abandoned++;
    WAR.audit.append('system', 'base.abandoned', b.id, 'ok', 'cx=' + b.cx + ' cz=' + b.cz + ' 缺席=' + (tick - warToInt(b.absentSince, tick)) + 'tick');
  }
  // 归属（**近似，未证实**）：锚点上的玩家若与记录不同且连续在场更久，先记一次「近似易主」候选
  if (anchor.player != null && b.owner != null) {
    var u = WAR.uuidOf(anchor.player);
    if (u !== b.owner.uuid) {
      if (b.ownerChallenger == null || b.ownerChallenger.uuid !== u) b.ownerChallenger = { name: anchor.name, uuid: u, since: tick };
      var ratio = Number(BASE_CONFIG.captureRatio); if (isNaN(ratio) || ratio < 1) ratio = 1.2;
      var oldStreak = Math.max(1, tick - warToInt(b.ownerSince, tick));
      var newStreak = tick - warToInt(b.ownerChallenger.since, tick);
      var oldAbsent = (b.absentSince == null) ? 0 : (tick - warToInt(b.absentSince, tick));
      if (newStreak >= oldStreak * ratio && oldAbsent >= warToInt(BASE_CONFIG.absentTicks, 24000)) {
        var from = b.owner.name, to = b.ownerChallenger.name;
        b.owner = { name: to, uuid: u, approx: true, source: 'approx-activity', since: tick };
        b.ownerSince = tick; b.ownerChallenger = null;
        if (b.state === 'abandoned' || b.state === 'damaged') b.state = 'intact';
        out.captured++;
        WAR.audit.append('system', 'base.captured', b.id, 'ok',
          'cx=' + b.cx + ' cz=' + b.cz + ' from=' + from + ' to=' + to + ' 依据=在场连续时长近似(ownerSource=approx-activity)');
        baseNotify(st, b, '据点易主：' + to + ' 在区域内的在场主导度超过 ' + from + '（近似判定，非方块归因）');
      }
    } else {
      b.ownerChallenger = null;
      b.ownerSince = tick;                      // 原主在场：清空缺席
      b.absentSince = null;
    }
    if (b.absentSince == null && u !== b.owner.uuid) b.absentSince = tick;   // 原主不在锚点 ⇒ 开始计缺席
  }
}

// ----------------------------------------------------------------------------
// 3. 扫描（低频；未标定直接拒绝）
// ----------------------------------------------------------------------------
function baseScan(server, opts) {
  var tick = warToInt(WAR_TICK.n, 0);
  var force = (opts != null && opts.force === true);
  var cal = baseCalib();
  if (cal.ok !== true) {
    var rr = { ok: false, refused: true, reason: cal.reason || 'CM 未标定', calibrated: false };
    var s0 = baseStateEnsure();
    if (s0 != null) { s0.runtime.lastResult = rr; s0.runtime.lastScanTick = tick; s0.runtime.lastScanAt = warNow(); }
    warWarnOnce('base-uncalibrated', '据点系统拒绝工作：' + rr.reason + '（提示：跑 /cm calib 定基线，再 /cm scan 重扫）');
    return rr;
  }
  if (BASE_CONFIG.enabled !== true) return { ok: false, refused: true, reason: '据点系统已关闭（WAR_CONFIG.base.enabled=false）' };
  var st = baseStateEnsure();
  if (st == null) return { ok: false, refused: true, reason: '数据根未载入' };
  var anchors = baseAnchors(server);
  var out = { ok: true, refused: false, tick: tick, anchors: anchors.length, scanned: 0, skipped: 0, formed: 0, damaged: 0, captured: 0, abandoned: 0, calibSource: cal.source, rev: cal.rev };
  for (var i = 0; i < anchors.length; i++) {
    var ag = baseAreaAgg(anchors[i].level, anchors[i].cx, anchors[i].cz);
    out.scanned++;
    if (ag == null || ag.ok !== true || ag.enough !== true) { out.skipped++; continue; }
    baseApply(st, anchors[i], ag, tick, out);
  }
  st.runtime.lastScanTick = tick; st.runtime.lastScanAt = warNow(); st.runtime.lastResult = out;
  WAR.data.touch();
  return out;
}

// ----------------------------------------------------------------------------
// 4. 域对象与命令
// ----------------------------------------------------------------------------
var WAR_BASE = {
  __stub: false,
  __owner: '40_base.js',
  config: BASE_CONFIG,
  calib: baseCalib,
  radius: baseRadius,
  area: baseAreaAgg,
  scan: baseScan,
  state: function () { return baseStateEnsure(); },
  byId: function (id) { var s = baseStateEnsure(); if (s == null) return null; for (var k in s.byId) if (s.byId[k] != null && s.byId[k].id === String(id)) return s.byId[k]; return null; },
  list: function () { var s = baseStateEnsure(); var out = []; if (s == null) return out; for (var k in s.byId) if (s.byId[k] != null) out.push(s.byId[k]); return out; },
  paramsText: function () {
    var p = ['据点参数（**全部暂定、待标定**；单位：a/d ∈ [0,1]，聚合 = 新鲜区块 a 求和）'];
    p.push('enabled=' + BASE_CONFIG.enabled + ' radiusChunks=' + BASE_CONFIG.radiusChunks + '(槽位 ' + (2 * baseRadius() + 1) * (2 * baseRadius() + 1) + ')');
    p.push('aSumMin=' + BASE_CONFIG.aSumMin + ' holdTicks=' + BASE_CONFIG.holdTicks + ' aSumDrop=' + BASE_CONFIG.aSumDrop);
    p.push('dSumMax=' + BASE_CONFIG.dSumMax + ' minFreshShare=' + BASE_CONFIG.minFreshShare + ' absentTicks=' + BASE_CONFIG.absentTicks);
    p.push('captureRatio=' + BASE_CONFIG.captureRatio + ' scanInterval=' + BASE_CONFIG.scanInterval + ' maxBases=' + BASE_CONFIG.maxBases);
    p.push('标定方法：/cm calib → /cm scan → 看区域 aSum/dSum 真实分位数再定阈值（当前数字只是猜）');
    return p.join(' | ');
  },
  status: function () {
    var s = baseStateEnsure(), cal = baseCalib();
    var n = 0, cands = 0;
    if (s != null) { n = warCountKeys(s.byId); cands = warCountKeys(s.candidates); }
    return {
      domain: 'base', implemented: true, owner: '40_base.js',
      enabled: BASE_CONFIG.enabled === true, calibrated: cal.calibrated === true,
      calibSource: cal.source, calibRev: cal.rev, calibReason: cal.reason,
      bases: n, candidates: cands, radiusChunks: baseRadius(),
      lastScanTick: (s && s.runtime) ? s.runtime.lastScanTick : null,
      lastResult: (s && s.runtime) ? s.runtime.lastResult : null,
      ownerSource: 'approx-activity', captureRule: 'presence-approx'
    };
  }
};
global.WAR.base = WAR_BASE;

WAR.commands.add(function (Commands, Arguments, event) {
  var S = Arguments.STRING.create(event);
  function strOf(ctx, name) { try { var v = Arguments.STRING.getResult(ctx, name); return v == null ? '' : String(v); } catch (e) { return ''; } }
  function line(b) {
    return '#' + b.id + ' (' + b.cx + ',' + b.cz + ') 状态=' + b.state + ' aSum=' + baseFmt(b.aSum) + ' dSum=' + baseFmt(b.dSum) +
      ' 主导=' + ((b.owner == null) ? '-' : b.owner.name + '(近似)');
  }
  var base = Commands.literal('base')
    .executes(function (ctx) { return WAR.reply(ctx.source, '用法：/war base list | info <据点id> | params | scan(OP' + WAR.config.admin.commandPermissionLevel + ')'); })
    .then(Commands.literal('list').executes(function (ctx) {
      var cal = baseCalib();
      if (cal.ok !== true) return WAR.reply(ctx.source, '✗ 据点系统未启用：' + cal.reason + '（跑 /cm calib 定基线后再 /cm scan）');
      var all = WAR_BASE.list();
      if (all.length === 0) return WAR.reply(ctx.source, '暂无据点（据点由人工程度推断，不靠声明；当前扫描锚点=在线玩家所在区块）');
      var parts = [];
      for (var i = 0; i < all.length; i++) parts.push(line(all[i]));
      return WAR.reply(ctx.source, '据点(' + all.length + ')｜' + parts.join('｜'));
    }))
    .then(Commands.literal('info')
      .then(Commands.argument('id', S).executes(function (ctx) {
        var b = WAR_BASE.byId(strOf(ctx, 'id'));
        if (b == null) return WAR.reply(ctx.source, '✗ 找不到据点：' + strOf(ctx, 'id'));
        return WAR.reply(ctx.source, line(b) + '｜峰值=' + baseFmt(b.aSumPeak) + '｜新鲜读数=' + b.fresh + '/' + b.slots +
          '｜主导来源=' + (b.owner ? b.owner.source : '-') + '（**近似，未证实**：真归因需 BlockEvents.placed）');
      })))
    .then(Commands.literal('params').executes(function (ctx) { return WAR.reply(ctx.source, WAR_BASE.paramsText()); }))
    .then(Commands.literal('scan')
      .requires(warOpPredicate())
      .executes(function (ctx) {
        var r = baseScan(WAR.data.server, { force: true });
        if (r.ok !== true) return WAR.reply(ctx.source, '✗ ' + r.reason);
        return WAR.reply(ctx.source, '扫描完成：锚点 ' + r.anchors + '｜扫描 ' + r.scanned + '（跳过 ' + r.skipped + '）｜形成 ' + r.formed +
          '｜damaged ' + r.damaged + '｜captured ' + r.captured + '｜abandoned ' + r.abandoned + '｜标定来源=' + r.calibSource);
      }));
  WAR.commands.helpLine('/war base list', '看据点（由人工程度推断；未标定时拒绝工作并提示 /cm calib）');
  WAR.commands.helpLine('/war base info <据点id>', '单据点详情（状态/a/d 聚合/主导者近似）');
  WAR.commands.helpLine('/war base params', '看据点参数（全部暂定、待标定）');
  WAR.commands.helpLine('/war base scan', 'OP' + WAR.config.admin.commandPermissionLevel + '：手动跑一次据点扫描');
  return base;
});

WAR.hooks.boot.push(function () {
  try {
    var cal = baseCalib();
    baseLog('标定状态：' + (cal.calibrated ? ('已标定 rev=' + cal.rev + '（来源 ' + cal.source + '）') : ('未标定 —— ' + cal.reason)));
  } catch (e) { warWarnOnce('base-boot', '标定检查失败：' + e); }
});

WAR.every(warToInt(BASE_CONFIG.scanInterval, 1200), 'base.scan', function (server) {
  try { baseScan(server, null); } catch (e) { warWarnOnce('base-scan', '据点扫描异常：' + e); }
});

warLog('40_base.js 已加载：据点域就绪（隐性人工程度；半径 ' + baseRadius() + ' 区块，未标定时拒绝工作）');
