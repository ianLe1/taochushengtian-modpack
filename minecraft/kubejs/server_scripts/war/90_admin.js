// ============================================================================
// 战服 · 90_admin.js —— 管理面（/war admin 的唯一所有者）
// ============================================================================
// 归属（lead 批复 D1-a）：core 不再注册 admin 子树，整个 /war admin 由本文件独占 ⇒ 权限门只声明一次。
//   既有三个子命令 status / audit / save 是**逐字搬移**（文本、审计 actor/action、回显一字未改）。
// 前置（lead 批复 C1）：core 新增只读入口 WAR.timers()（只列 label/ticks/last，不导出 fn）。
// 范围（lead 划定，本域**只读**）：域状态总览 / 审计过滤检索 / 定时任务视图 / 只读玩家档案 / 沿用既有 save。
//   **不做**：文件导出（jsonl 落盘，KubeJS 运行期写文件未实证）、强制退队·解散·清队等破坏性操作、
//   列出备份文件（目录路径未定义，备份回滚已是实例外脚本 server-pack/ops/）。
// 已核实 API：WAR.commands.add / WAR.reply / WAR.actorName / WAR.opPredicate / WAR.intArg(需传 Arguments.INTEGER
//   包装对象) / WAR.clampInt / WAR.timers（C1）/ WAR.data.{state,save,lastSaveAt} / WAR.audit.{count,tail,text}
// ============================================================================

// ----------------------------------------------------------------------------
// 1. 域状态总览（core 的 stubStatus 聚合逻辑迁到此处；WAR.stubStatus 由本文件接管）
// ----------------------------------------------------------------------------
var WAR_ADMIN_DOMAINS = ['team', 'econ', 'spawn', 'claim', 'base', 'trade', 'shop', 'think'];

function warAdminDomains() {
  var out = {};
  for (var i = 0; i < WAR_ADMIN_DOMAINS.length; i++) {
    var d = WAR_ADMIN_DOMAINS[i], st = null;
    try { st = (global.WAR[d] != null && typeof global.WAR[d].status === 'function') ? global.WAR[d].status() : null; }
    catch (e) { st = { domain: d, implemented: false, owner: '?', note: 'status() 抛异常：' + e }; }
    if (st == null) st = { domain: d, implemented: false, owner: '?' };
    out[d] = st;
  }
  return out;
}

function warAdminDomainsText() {
  var d = warAdminDomains(), parts = [];
  for (var i = 0; i < WAR_ADMIN_DOMAINS.length; i++) {
    var k = WAR_ADMIN_DOMAINS[i], s = d[k] || {};
    parts.push(k + '=' + (s.implemented === true ? 'on' : 'off') + '(' + (s.owner == null ? '?' : s.owner) + ')' + (s.note ? '｜' + s.note : ''));
  }
  return '域状态(' + WAR_ADMIN_DOMAINS.length + ') | ' + parts.join(' | ');
}

// 兼容入口：接管 WAR.stubStatus（core 那份留作本文件加载前兜底）。注意与原实现的差异见报告：
// core 旧聚合用 WAR_TEAM_STUB.status()（永远 implemented:false），这里改为 WAR.team.status()（真实状态）。
global.WAR.stubStatus = function () { return warAdminDomains(); };

// ----------------------------------------------------------------------------
// 2. 审计过滤（纯读 WAR.data.state.audit.items）
// ----------------------------------------------------------------------------
function warAdminAuditPick(n, f) {
  var items = [];
  try { items = WAR.data.state.audit.items; } catch (e) { items = []; }
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var e = items[i];
    if (f.actor != null && String(e.actor) !== String(f.actor)) continue;
    if (f.action != null && String(e.action) !== String(f.action)) continue;
    if (f.result != null && String(e.result) !== String(f.result)) continue;
    out.push(e);
  }
  var k = warClampInt(n, 1, WAR.config.audit.bufferSize, 20);
  return out.slice(Math.max(0, out.length - k));
}

// 条目格式与 core WAR_AUDIT.text() 逐字一致（自检里有「无过滤条件 == audit <n>」的等价断言兜住漂移）
function warAdminAuditLine(e) {
  return '#' + e.seq + ' ' + WAR.fmtTime(e.t) + ' ' + e.actor + ' ' + e.action +
         ' -> ' + e.target + ' = ' + e.result + (e.detail ? '（' + e.detail + '）' : '');
}

function warAdminFilterDesc(f) {
  var p = [];
  if (f.actor != null) p.push('actor=' + f.actor);
  if (f.action != null) p.push('action=' + f.action);
  if (f.result != null) p.push('result=' + f.result);
  return p.length ? p.join(' ') : '无';
}

function warAdminAuditFilterText(n, f) {
  var list = warAdminAuditPick(n, f);
  if (list.length === 0) return '审计为空（过滤：' + warAdminFilterDesc(f) + '）';
  var out = [];
  for (var i = 0; i < list.length; i++) out.push(warAdminAuditLine(list[i]));
  return out.join(' | ');
}

// ----------------------------------------------------------------------------
// 3. 定时任务视图（数据来自 C1 的 WAR.timers()）
// ----------------------------------------------------------------------------
function warAdminTasksText() {
  var list = WAR.timers(), parts = [];
  for (var i = 0; i < list.length; i++) {
    parts.push(list[i].label + '(' + list[i].ticks + 'tick,last=#' + list[i].last + ')');
  }
  return '定时任务(' + list.length + ') | ' + (parts.length ? parts.join(' | ') : '无');
}

// ----------------------------------------------------------------------------
// 4. 只读玩家档案（队伍/角色/余额/首见时间；不改 state、不写审计）
// ----------------------------------------------------------------------------
function warAdminProfile(player) {
  var u = WAR.uuidOf(player), st = WAR.data.state;
  var team = null, role = null;
  try {
    var tid = st.teams.byPlayer[u];
    if (tid != null) {
      var t = st.teams.byId[tid];
      if (t != null) { team = t; var m = WAR.team.member(t, u); role = m ? m.role : null; }
    }
  } catch (e1) { }
  var bal = 0, joined = null;
  try { bal = WAR.econ.balanceOf(u); } catch (e2) { }
  try { joined = (st.econ.joined && st.econ.joined[u] != null) ? st.econ.joined[u] : null; } catch (e3) { }
  return {
    uuid: u, name: WAR.nameOf(player),
    teamId: team ? team.id : null, teamName: team ? team.name : null, role: role,
    balance: bal, firstJoin: joined
  };
}

function warAdminProfileText(player) {
  var p = warAdminProfile(player);
  return '玩家档案 | 名字=' + p.name + ' | UUID=' + p.uuid +
    ' | 队伍=' + (p.teamName == null ? '无' : (p.teamName + '(' + p.teamId + ')')) +
    ' | 角色=' + (p.role == null ? '-' : p.role) +
    ' | 余额=' + p.balance + ' ' + WAR.config.econ.ledgerKey +
    ' | 首见=' + (p.firstJoin == null ? '无记录' : WAR.fmtTime(p.firstJoin));
}

// ----------------------------------------------------------------------------
// 5. 域对象（对外：WAR.admin）
// ----------------------------------------------------------------------------
var WAR_ADMIN = {
  __stub: false,
  __owner: '90_admin.js',
  statusText: function () { return warAdminStatusText(); },   // 兼容视图：逐字复用 core 的输出函数
  domains: warAdminDomains,
  domainsText: warAdminDomainsText,
  auditPick: warAdminAuditPick,
  auditFilterText: warAdminAuditFilterText,
  tasksText: warAdminTasksText,
  profile: warAdminProfile,
  profileText: warAdminProfileText,
  status: function () {
    return { domain: 'admin', implemented: true, owner: '90_admin.js', commandRoot: '/war admin', readOnly: true };
  }
};

// ----------------------------------------------------------------------------
// 6. 命令：/war admin ...（权限门只在这里声明一次）
// ----------------------------------------------------------------------------
WAR.commands.add(function (Commands, Arguments, event) {
  var S = Arguments.STRING.create(event);
  var I = Arguments.INTEGER.create(event);
  var P = Arguments.PLAYER.create(event);

  function intOf(ctx, name, dft) { return warIntArg(Arguments.INTEGER, ctx, name, dft); }
  function strOf(ctx, name) {
    try { var v = Arguments.STRING.getResult(ctx, name); return (v == null) ? '' : String(v); } catch (e) { return ''; }
  }
  function auditN(ctx) { return warClampInt(intOf(ctx, 'n', 20), 1, WAR.config.audit.bufferSize, 20); }
  function pickDims(ctx) {
    var f = {};
    var a = strOf(ctx, 'actorName'); if (a !== '') f.actor = a;
    var b = strOf(ctx, 'actionName'); if (b !== '') f.action = b;
    var c = strOf(ctx, 'resultName'); if (c !== '') f.result = c;
    return f;
  }
  function replyFilter(ctx) { return WAR.reply(ctx.source, warAdminAuditFilterText(auditN(ctx), pickDims(ctx))); }

  // 审计过滤：三个维度可任意顺序、任意组合叠加（参数名固定，Brigadier 按名取值，与输入顺序无关）
  var FILTER_DIMS = ['actor', 'action', 'result'];
  function buildAuditf(node, used) {
    node.executes(replyFilter);
    for (var i = 0; i < FILTER_DIMS.length; i++) {
      var dim = FILTER_DIMS[i];
      if (used.indexOf(dim) >= 0) continue;
      var deeper = Commands.argument(dim + 'Name', S);
      buildAuditf(deeper, used.concat([dim]));
      node.then(Commands.literal(dim).then(deeper));
    }
    return node;
  }

  // auditf 树：auditf（无 n，用默认 20）→ n（无过滤）→ 各过滤维度（可任意顺序叠加）
  var auditfNode = Commands.literal('auditf').executes(replyFilter);
  var auditfN = Commands.argument('n', I);
  buildAuditf(auditfN, []);
  auditfNode.then(auditfN);

  var admin = Commands.literal('admin')
    .requires(warOpPredicate())                                   // ← 唯一的权限门
    .executes(function (ctx) { return WAR.reply(ctx.source, '用法：/war admin status | audit [n] | save'); })  // 逐字搬移
    .then(Commands.literal('help').executes(function (ctx) {
      return WAR.reply(ctx.source, '管理面 | status 数据根自检 | audit [n] 审计回看 | save 立即落盘 | ' +
        'domains 域状态总览 | tasks 定时任务 | profile <玩家> 只读档案 | ' +
        'auditf <n> [actor <名>] [action <动作>] [result <结果>] 审计检索');
    }))
    .then(Commands.literal('status').executes(function (ctx) {
      return WAR.reply(ctx.source, warAdminStatusText());          // 逐字搬移
    }))
    .then(Commands.literal('audit')                                // 逐字搬移
      .executes(function (ctx) { return WAR.reply(ctx.source, WAR.audit.text(20)); })
      .then(Commands.argument('n', I).executes(function (ctx2) {
        return WAR.reply(ctx2.source, WAR.audit.text(auditN(ctx2)));
      })))
    .then(Commands.literal('save').executes(function (ctx) {        // 逐字搬移
      var ok = WAR.data.save('manual');
      WAR.audit.append('cmd:' + WAR.actorName(ctx.source), 'admin.save', WAR_NS, ok ? 'ok' : 'fail');
      return WAR.reply(ctx.source, ok ? '已落盘（reason=manual）' : '落盘失败：见服务器日志');
    }))
    .then(Commands.literal('domains').executes(function (ctx) {
      return WAR.reply(ctx.source, warAdminDomainsText());
    }))
    .then(Commands.literal('tasks').executes(function (ctx) {
      return WAR.reply(ctx.source, warAdminTasksText());
    }))
    .then(Commands.literal('profile')
      .then(Commands.argument('player', P).executes(function (ctx) {
        var target = warPlayerArg(Arguments.PLAYER, ctx, 'player');
        if (target == null) return WAR.reply(ctx.source, '找不到目标玩家（当前仅支持在线玩家）');
        return WAR.reply(ctx.source, warAdminProfileText(target));
      })))
    .then(auditfNode);

  WAR.commands.helpLine('/war admin domains', 'OP' + WAR.config.admin.commandPermissionLevel + '：各域实现状态总览');
  WAR.commands.helpLine('/war admin tasks', 'OP' + WAR.config.admin.commandPermissionLevel + '：定时任务清单');
  WAR.commands.helpLine('/war admin profile <玩家>', 'OP' + WAR.config.admin.commandPermissionLevel + '：只读玩家档案（队伍/余额/首见）');
  WAR.commands.helpLine('/war admin auditf <n> [actor <名>] [action <动作>] [result <结果>]', 'OP' + WAR.config.admin.commandPermissionLevel + '：审计检索（过滤）');
  return admin;
});

global.WAR.admin = WAR_ADMIN;   // 覆盖 core 的 admin stub（warStub 从未注册此域，属新增）
warLog('90_admin.js 已加载：管理面就绪（/war admin 唯一所有者，' + WAR_ADMIN_DOMAINS.length + ' 域总览）');
