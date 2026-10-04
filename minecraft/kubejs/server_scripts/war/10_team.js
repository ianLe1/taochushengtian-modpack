// ============================================================================
// 战服 · 10_team.js —— 团队域（原版计分板队伍 + L1 队伍表）
// ============================================================================
// 依赖 00_core.js 的 global.WAR（数据层 / 审计 / 命令框架 / 工具）；本文件按文件名顺序后加载。
// 架构（方案 §1）：L1 = server.persistentData.war.teams 是**权威**；原版计分板队伍只是
//   「队内免伤 + 颜色」的显示与判定镜像 —— 任何时候都能由 L1 全量重建（syncAll）。
//   L2 = player.persistentData.war.teamId 只作缓存，读判定永远回 L1。
//
// 已核实的 API（javap 字节码实证，不臆造）：
//   Commands.literal/argument(...).requires/.executes/.then；Arguments.STRING / Arguments.PLAYER
//   Arguments.PLAYER.getResult(ctx, name) -> ServerPlayer（ArgumentTypeWrapper.getResult 实证）
//   EntityEvents.beforeHurt -> BeforeLivingEntityHurtKubeEvent（getEntity/getSource/getDamage/setDamage）
//     DamageSource.getEntity()/getDirectEntity()
//   EntityEvents.death -> LivingEntityDeathKubeEvent（getEntity/getSource）
//   PlayerEvents.loggedIn -> KubePlayerEvent.getPlayer()
//   server.runCommandSilent(String)；CommandSourceStack.getPlayer()
//   原版命令字面量（net/minecraft/server/commands/TeamCommand.class strings 实证）：
//     team add / team join / team leave / team remove / team modify <team> color|friendlyFire|displayName
//     —— 注意是 **friendlyFire**（驼峰），不是 friendlyfire。
//   EntityKJS: isPlayer()/getType()/getTeamName()/tell(...)
//
// ⚠ 有意未做：不给计分板队伍设 displayName —— 它需要传文本组件 JSON，队名含空格/引号时
//   经 runCommandSilent 拼串会被命令解析器切断；本批次先只做「颜色 + 免伤」，显示名留给
//   M1 之后用更稳的方式（或在 00_core 里统一封装文本参数）。
// ============================================================================

var WAR_TEAM = {
  __stub: false,
  __owner: '10_team.js',

  // ---------------------------------------------------------------- 只读视图
  status: function () {
    var st = WAR.data.state;
    return {
      domain: 'team', implemented: true, owner: '10_team.js',
      teams: st ? warCountKeys(st.teams.byId) : 0,
      mapped: st ? warCountKeys(st.teams.byPlayer) : 0,
      maxMembers: WAR.config.team.maxMembers,
      friendlyFire: WAR.config.team.friendlyFire,
      inviteExpireSeconds: WAR.config.team.inviteExpireSeconds
    };
  },

  state: function () { return WAR.data.state ? WAR.data.state.teams : { seq: 0, byId: {}, byPlayer: {} }; },

  byId: function (id) { try { return WAR_TEAM.state().byId[String(id)] || null; } catch (e) { return null; } },

  byName: function (name) {
    var n = String(name == null ? '' : name);
    var byId = WAR_TEAM.state().byId;
    for (var k in byId) if (byId.hasOwnProperty(k) && String(byId[k].name).toLowerCase() === n.toLowerCase()) return byId[k];
    return null;
  },

  member: function (t, uuid) {
    if (t == null || uuid == null) return null;
    for (var i = 0; i < (t.members || []).length; i++) if (t.members[i].uuid === uuid) return t.members[i];
    return null;
  },

  of: function (entity) {
    var u = WAR.uuidOf(entity);
    if (u === '') return null;
    var id = WAR_TEAM.state().byPlayer[u];
    return id ? WAR_TEAM.byId(id) : null;
  },

  same: function (a, b) {
    var t1 = WAR_TEAM.of(a), t2 = WAR_TEAM.of(b);
    return (t1 != null && t2 != null && t1.id === t2.id);
  },

  isAlly: function (a, b) {
    var t1 = WAR_TEAM.of(a), t2 = WAR_TEAM.of(b);
    if (t1 == null || t2 == null) return false;
    if (t1.id === t2.id) return true;
    return (t1.allies || []).indexOf(t2.id) >= 0;
  },

  // ---------------------------------------------------------------- 写操作
  create: function (actor, name, color) {
    var src = 'team.create';
    if (actor == null) return werr(src, '-', '该命令只能由玩家执行');
    if (WAR_TEAM.of(actor.p) != null) return werr(src, WAR.nameOf(actor.p), '你已经在一个队伍里了（先 /war team leave）');

    var nm = String(name == null ? '' : name).replace(/^\s+|\s+$/g, '');
    if (nm.length < WAR.config.team.nameMin || nm.length > WAR.config.team.nameMax) {
      return werr(src, WAR.nameOf(actor.p), '队名长度需在 ' + WAR.config.team.nameMin + '-' + WAR.config.team.nameMax + ' 之间');
    }
    if (/\s/.test(nm)) return werr(src, WAR.nameOf(actor.p), '队名不能含空白字符（计分板命令拼接限制）');
    if (WAR_TEAM.byName(nm) != null) return werr(src, WAR.nameOf(actor.p), '队名已被占用：' + nm);

    var col = String(color == null ? WAR.config.team.defaultColor : color).toLowerCase();
    if (WAR.config.team.colors.indexOf(col) < 0) return werr(src, WAR.nameOf(actor.p), '颜色不合法：' + col);

    var muuid = WAR.uuidOf(actor.p);
    if (muuid === '') return werr(src, WAR.nameOf(actor.p), '读不到你的 UUID，无法建队（见实机待验清单）');

    var res = WAR.data.mutate('team.create', function (st) {
      st.teams.seq = warToInt(st.teams.seq, 0) + 1;
      var t = {
        id: 'wt' + st.teams.seq,
        name: nm,
        color: col,
        leader: muuid,
        members: [{ uuid: muuid, name: WAR.nameOf(actor.p), role: 'leader', joinAt: warNow() }],
        invites: [],
        treasury: 0,
        baseIds: [],
        allies: [],
        diplomacy: 'neutral',
        createdAt: warNow(),
        stats: { kills: 0, deaths: 0, basesLost: 0, friendlyBlocked: 0 }
      };
      st.teams.byId[t.id] = t;
      st.teams.byPlayer[muuid] = t.id;
      return t;
    });
    if (!res.ok) return werr(src, WAR.nameOf(actor.p), '建队失败：' + res.error);

    var t = res.ret;
    warTeamScoreboardSync(t);
    WAR.run('team join ' + t.id + ' ' + WAR.nameOf(actor.p));
    warTeamCacheWrite(actor.p, t.id);
    WAR.audit.append(actor.name, 'team.create', t.id, 'ok', t.name + '/' + t.color);
    WAR.reply(actor.source, '已建队「' + t.name + '」（' + t.id + '，颜色 ' + t.color + '）。用 /war team invite <玩家> 拉人。');
    warDebug('team.create ' + t.id + ' by ' + actor.name);
    return { ok: true, team: t };
  },

  invite: function (actor, target) {
    var src = 'team.invite';
    if (actor == null) return werr(src, '-', '该命令只能由玩家执行');
    var t = WAR_TEAM.of(actor.p);
    if (t == null) return werr(src, actor.name, '你还没有队伍');
    if (target == null) return werr(src, actor.name, '找不到目标玩家（当前仅支持在线玩家）');
    var tuuid = WAR.uuidOf(target);
    if (tuuid === '') return werr(src, actor.name, '读不到目标 UUID');
    if (WAR_TEAM.member(t, tuuid) != null) return werr(src, actor.name, WAR.nameOf(target) + ' 已经在队里');
    if (WAR_TEAM.of(target) != null) return werr(src, actor.name, WAR.nameOf(target) + ' 已在别的队伍里');

    warTeamPurgeInvites(t);
    var pending = (t.members || []).length + (t.invites || []).length;
    if (pending >= WAR.config.team.maxMembers) {
      return werr(src, actor.name, '队伍已满（' + (t.members || []).length + '/' + WAR.config.team.maxMembers + ' 人，另有 ' + t.invites.length + ' 个待接受邀请）');
    }
    var expireAt = warNow() + warToInt(WAR.config.team.inviteExpireSeconds, 300) * 1000;
    var replaced = false;
    for (var i = 0; i < t.invites.length; i++) {
      if (t.invites[i].uuid === tuuid) { t.invites[i].expireAt = expireAt; t.invites[i].by = actor.name; replaced = true; break; }
    }
    if (!replaced) t.invites.push({ uuid: tuuid, name: WAR.nameOf(target), by: actor.name, expireAt: expireAt });
    WAR.data.touch();
    WAR.audit.append(actor.name, 'team.invite', t.id, 'ok', WAR.nameOf(target));
    WAR.reply(actor.source, '已邀请 ' + WAR.nameOf(target) + '（' + WAR.config.team.inviteExpireSeconds + ' 秒内有效）');
    WAR.tell(target, '你收到「' + t.name + '」的邀请：/war team accept ' + t.id);
    return { ok: true, team: t, target: tuuid };
  },

  accept: function (player, ref) {
    var src = 'team.accept';
    if (player == null) return werr(src, '-', '该命令只能由玩家执行');
    var u = WAR.uuidOf(player.p);
    if (u === '') return werr(src, player.name, '读不到你的 UUID');

    var cands = [];
    var byId = WAR_TEAM.state().byId;
    for (var k in byId) {
      if (!byId.hasOwnProperty(k)) continue;
      var t = byId[k];
      warTeamPurgeInvites(t);
      for (var i = 0; i < (t.invites || []).length; i++) {
        if (t.invites[i].uuid === u) {
          if (ref == null || String(ref) === t.id || String(ref).toLowerCase() === String(t.name).toLowerCase()) cands.push(t);
          break;
        }
      }
    }
    if (cands.length === 0) {
      WAR.audit.append(player.name, 'team.accept', String(ref == null ? '-' : ref), 'fail', '无有效邀请');
      return werr(src, player.name, ref == null ? '你没有待接受的邀请' : '没有指向该队伍的邀请：' + ref);
    }
    if (cands.length > 1 && ref == null) {
      return werr(src, player.name, '你有多个邀请，请指明：/war team accept <队伍ID>');
    }
    var t = cands[0];
    if (WAR_TEAM.of(player.p) != null) return werr(src, player.name, '你已经在队伍里了');
    if ((t.members || []).length >= WAR.config.team.maxMembers) return werr(src, player.name, '队伍已满');

    t.members.push({ uuid: u, name: player.name, role: 'member', joinAt: warNow() });
    t.invites = t.invites.filter(function (iv) { return iv.uuid !== u; });
    WAR_TEAM.state().byPlayer[u] = t.id;
    WAR.data.touch();

    WAR.run('team join ' + t.id + ' ' + player.name);
    warTeamCacheWrite(player.p, t.id);
    WAR.audit.append(player.name, 'team.accept', t.id, 'ok', 'members=' + t.members.length);
    WAR.reply(player.source, '已加入「' + t.name + '」（' + t.members.length + '/' + WAR.config.team.maxMembers + '）');
    warTeamNotify(t, player.name + ' 加入了队伍', player.name);
    return { ok: true, team: t };
  },

  leave: function (player) {
    var src = 'team.leave';
    if (player == null) return werr(src, '-', '该命令只能由玩家执行');
    var t = WAR_TEAM.of(player.p);
    if (t == null) return werr(src, player.name, '你还没有队伍');
    var u = WAR.uuidOf(player.p);

    var becameLeader = null, dissolved = false;
    t.members = (t.members || []).filter(function (m) { return m.uuid !== u; });
    delete WAR_TEAM.state().byPlayer[u];
    if (t.members.length === 0) {
      warTeamRemove(t);
      dissolved = true;
    } else if (t.leader === u) {
      t.leader = t.members[0].uuid;
      t.members[0].role = 'leader';
      becameLeader = t.members[0].name;
    }
    WAR.data.touch();
    WAR.run('team leave ' + player.name);
    warTeamCacheWrite(player.p, '');
    WAR.audit.append(player.name, 'team.leave', t.id, 'ok', dissolved ? '队伍解散（无人）' : 'members=' + t.members.length);
    WAR.reply(player.source, dissolved ? '你离开了队伍，队伍因无人而解散' : '已离开「' + t.name + '」');
    if (becameLeader != null) warTeamNotify(t, becameLeader + ' 成为新队长', null);
    return { ok: true, team: t, dissolved: dissolved };
  },

  kick: function (actor, target) {
    var src = 'team.kick';
    if (actor == null) return werr(src, '-', '该命令只能由玩家执行');
    var t = WAR_TEAM.of(actor.p);
    if (t == null) return werr(src, actor.name, '你还没有队伍');
    if (t.leader !== WAR.uuidOf(actor.p)) return werr(src, actor.name, '只有队长能踢人');
    if (target == null) return werr(src, actor.name, '找不到目标玩家');
    var tuuid = WAR.uuidOf(target);
    if (tuuid === WAR.uuidOf(actor.p)) return werr(src, actor.name, '队长不能踢自己（用 /war team disband 或 leave）');
    if (WAR_TEAM.member(t, tuuid) == null) return werr(src, actor.name, WAR.nameOf(target) + ' 不在你的队伍里');

    t.members = t.members.filter(function (m) { return m.uuid !== tuuid; });
    delete WAR_TEAM.state().byPlayer[tuuid];
    WAR.data.touch();
    WAR.run('team leave ' + WAR.nameOf(target));
    warTeamCacheWrite(target, '');
    WAR.audit.append(actor.name, 'team.kick', t.id, 'ok', WAR.nameOf(target));
    WAR.reply(actor.source, '已把 ' + WAR.nameOf(target) + ' 踢出队伍');
    WAR.tell(target, '你被移出了队伍「' + t.name + '」');
    return { ok: true, team: t };
  },

  list: function (player) {
    var src = 'team.list';
    var st = WAR_TEAM.state();
    var t = player == null ? null : WAR_TEAM.of(player.p);
    if (t != null) {
      var parts = [];
      for (var i = 0; i < t.members.length; i++) {
        var m = t.members[i];
        parts.push(m.name + (m.role === 'leader' ? '(队长)' : ''));
      }
      var iv = [];
      for (var j = 0; j < (t.invites || []).length; j++) iv.push(t.invites[j].name);
      return '「' + t.name + '」' + t.id + ' 颜色=' + t.color +
             ' 人数=' + t.members.length + '/' + WAR.config.team.maxMembers +
             ' 队内免伤=' + (WAR.config.team.friendlyFire ? '关（可互伤）' : '开') +
             ' 成员：' + parts.join(', ') +
             (iv.length ? '｜待接受：' + iv.join(', ') : '');
    }
    var names = [];
    for (var k in st.byId) {
      if (!st.byId.hasOwnProperty(k)) continue;
      names.push(st.byId[k].name + '(' + st.byId[k].id + ',' + st.byId[k].members.length + '人)');
    }
    return names.length === 0 ? '当前没有任何队伍' : '共 ' + names.length + ' 队：' + names.join(' ');
  },

  disband: function (actor) {
    var src = 'team.disband';
    if (actor == null) return werr(src, '-', '该命令只能由玩家执行');
    var t = WAR_TEAM.of(actor.p);
    if (t == null) return werr(src, actor.name, '你还没有队伍');
    if (t.leader !== WAR.uuidOf(actor.p)) return werr(src, actor.name, '只有队长能解散队伍');
    var n = t.members.length;
    warTeamRemove(t);
    WAR.data.touch();
    WAR.audit.append(actor.name, 'team.disband', t.id, 'ok', 'members=' + n);
    WAR.reply(actor.source, '已解散「' + t.name + '」（' + n + ' 人）');
    return { ok: true, teamId: t.id };
  },

  // 账本留给 30_economy.js（本批次只保证 API 存在且行为可预期）
  treasuryAdd: function (teamId, amount, reason) {
    var t = WAR_TEAM.byId(teamId);
    if (t == null) return { ok: false, error: '队伍不存在' };
    if (WAR.econ.__stub === true) {
      WAR.audit.append('system', 'team.treasury', teamId, 'fail', '经济域未实现（30_economy.js）');
      return { ok: false, error: '经济域未实现，账本由 30_economy.js 提供' };
    }
    t.treasury = warToInt(t.treasury, 0) + warToInt(amount, 0);
    WAR.data.touch();
    WAR.audit.append('system', 'team.treasury', teamId, 'ok', String(reason || '') + ' ' + amount);
    return { ok: true, treasury: t.treasury };
  },

  // 计分板全量重建（boot / L1 与镜像失步时调）
  syncAll: function (server) {
    var st = WAR_TEAM.state();
    var n = 0;
    for (var k in st.byId) {
      if (!st.byId.hasOwnProperty(k)) continue;
      warTeamScoreboardSync(st.byId[k]);
      n++;
    }
    var online = warTeamOnlinePlayers(server);
    for (var i = 0; i < online.length; i++) {
      var p = online[i];
      var t = WAR_TEAM.of(p);
      if (t != null) WAR.run('team join ' + t.id + ' ' + WAR.nameOf(p));
    }
    warDebug('scoreboard 重建：' + n + ' 队 / 在线 ' + online.length + ' 人');
    return { ok: true, teams: n, online: online.length };
  }
};

// ============================================================================
// 内部工具
// ============================================================================

function werr(action, actorName, msg) {
  WAR.audit.append(actorName, action, '-', 'deny', msg);
  // 命令路径下 currentSource 由 actorOf(ctx) 设置；直接调用 API 时可能为空，此时只记审计。
  if (currentSource != null) WAR.reply(currentSource, msg);
  return { ok: false, message: msg };
}

// werr 需要一个 source；命令路径下由调用方设置（避免把 source 透传进每个域方法）
var currentSource = null;

function warTeamScoreboardSync(t) {
  WAR.run('team add ' + t.id);
  WAR.run('team modify ' + t.id + ' color ' + t.color);
  WAR.run('team modify ' + t.id + ' friendlyFire ' + (WAR.config.team.friendlyFire ? 'true' : 'false'));
}

function warTeamRemove(t) {
  var st = WAR_TEAM.state();
  for (var i = 0; i < (t.members || []).length; i++) {
    delete st.byPlayer[t.members[i].uuid];
    try { WAR.run('team leave ' + t.members[i].name); } catch (e) { }
  }
  try { WAR.run('team empty ' + t.id); } catch (e2) { }
  try { WAR.run('team remove ' + t.id); } catch (e3) { }
  delete st.byId[t.id];
  WAR.data.touch();
}

function warTeamPurgeInvites(t) {
  if (t == null || !(t.invites instanceof Array)) return 0;
  var now = warNow(), dropped = 0, keep = [];
  for (var i = 0; i < t.invites.length; i++) {
    if (warToInt(t.invites[i].expireAt, 0) > now) keep.push(t.invites[i]);
    else dropped++;
  }
  if (dropped > 0) { t.invites = keep; WAR.data.touch(); }
  return dropped;
}

function warTeamCacheWrite(p, teamId) {
  if (p == null) return false;
  try {
    var tag = WAR.data.newTag();
    if (tag == null) return false;
    tag.putString('teamId', String(teamId == null ? '' : teamId));
    p.persistentData.put('war', tag);
    return true;
  } catch (e) { return false; }
}

function warTeamCacheRead(p) {
  try {
    var pd = p.persistentData;
    if (pd != null && pd.contains('war')) return String(pd.getCompound('war').getString('teamId'));
  } catch (e) { }
  return '';
}

function warTeamOnlinePlayers(server) {
  var out = [];
  try {
    var ps = server.getPlayers();
    if (ps == null) return out;
    if (typeof ps.forEach === 'function') { ps.forEach(function (p) { out.push(p); }); return out; }
    var n = warToInt(ps.size ? ps.size() : 0, 0);
    for (var i = 0; i < n; i++) if (ps.get) out.push(ps.get(i));
  } catch (e) { }
  return out;
}

function warTeamNotify(t, msg, exceptName) {
  if (t == null) return;
  var online = warTeamOnlinePlayers(WAR.data.server);
  for (var i = 0; i < online.length; i++) {
    var p = online[i];
    if (WAR_TEAM.member(t, WAR.uuidOf(p)) == null) continue;
    if (exceptName != null && WAR.nameOf(p) === exceptName) continue;
    WAR.tell(p, msg);
  }
}

function warTeamIsPlayerEntity(e) {
  try { if (e.isPlayer() === true) return true; } catch (x1) { }
  try { if (String(e.getType()) === 'minecraft:player') return true; } catch (x2) { }
  return false;
}

// 队内免伤兜底：计分板 friendlyFire=false 已由原版拦截；这是在脚本层再兜一层
// （只 setDamage(0)，BeforeLivingEntityHurtKubeEvent 的公开方法里没有 cancel）
function warTeamFriendlyGuard(event) {
  try {
    if (WAR.config.team.friendlyFire === true) return;
    var victim = event.getEntity();
    if (!warTeamIsPlayerEntity(victim)) return;
    var src = event.getSource();
    var attacker = null;
    try { attacker = src.getEntity(); } catch (e1) { }
    if (attacker == null) { try { attacker = src.getDirectEntity(); } catch (e2) { } }
    if (attacker == null || attacker === victim) return;
    if (!warTeamIsPlayerEntity(attacker)) return;
    var t1 = WAR_TEAM.of(victim), t2 = WAR_TEAM.of(attacker);
    if (t1 == null || t2 == null || t1.id !== t2.id) return;
    event.setDamage(0);
    t1.stats.friendlyBlocked = warToInt(t1.stats.friendlyBlocked, 0) + 1;
    WAR.data.touch();
    warDebug('队内免伤拦截：' + WAR.nameOf(attacker) + ' -> ' + WAR.nameOf(victim) + '（' + t1.id + '）');
  } catch (err) { warWarnOnce('ff-guard', '队内免伤守卫异常：' + err); }
}

// ============================================================================
// 命令注册（/war team ...）
// ============================================================================

WAR.commands.add(function (Commands, Arguments, event) {
  var S = Arguments.STRING.create(event);
  var P = Arguments.PLAYER.create(event);

  function actorOf(ctx) {
    currentSource = ctx.source;
    var p = null;
    try { p = ctx.source.getPlayer(); } catch (e) { }
    if (p == null) return null;
    return { p: p, name: WAR.actorName(ctx.source), source: ctx.source };   // 步骤 4a：取名归 core；currentSource 赋值保留（werr 依赖）
  }
  var team = Commands.literal('team')
    .executes(function (ctx) {
      return WAR.reply(ctx.source, '用法：/war team create <队名> [颜色] | invite <玩家> | accept [队伍ID] | leave | kick <玩家> | list | disband');
    })
    .then(Commands.literal('create')
      .then(Commands.argument('name', S)
        .executes(function (ctx) {
          var a = actorOf(ctx);
          if (a == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
          return WAR._teamCreateReply(WAR_TEAM.create(a, String(Arguments.STRING.getResult(ctx, 'name')), null), ctx.source);
        })
        .then(Commands.argument('color', S).executes(function (ctx) {
          var a = actorOf(ctx);
          if (a == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
          return WAR._teamCreateReply(WAR_TEAM.create(a, String(Arguments.STRING.getResult(ctx, 'name')), String(Arguments.STRING.getResult(ctx, 'color'))), ctx.source);
        }))))
    .then(Commands.literal('invite')
      .then(Commands.argument('player', P).executes(function (ctx) {
        var a = actorOf(ctx);
        if (a == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
        return WAR._teamResult(WAR_TEAM.invite(a, warPlayerArg(Arguments.PLAYER, ctx, 'player')), ctx.source);
      })))
    .then(Commands.literal('accept')
      .executes(function (ctx) {
        var a = actorOf(ctx);
        if (a == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
        return WAR._teamResult(WAR_TEAM.accept(a, null), ctx.source);
      })
      .then(Commands.argument('teamId', S).executes(function (ctx) {
        var a = actorOf(ctx);
        if (a == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
        return WAR._teamResult(WAR_TEAM.accept(a, String(Arguments.STRING.getResult(ctx, 'teamId'))), ctx.source);
      })))
    .then(Commands.literal('leave').executes(function (ctx) {
      var a = actorOf(ctx);
      if (a == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
      return WAR._teamResult(WAR_TEAM.leave(a), ctx.source);
    }))
    .then(Commands.literal('kick')
      .then(Commands.argument('player', P).executes(function (ctx) {
        var a = actorOf(ctx);
        if (a == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
        return WAR._teamResult(WAR_TEAM.kick(a, warPlayerArg(Arguments.PLAYER, ctx, 'player')), ctx.source);
      })))
    .then(Commands.literal('list').executes(function (ctx) {
      var a = actorOf(ctx);
      return WAR.reply(ctx.source, WAR_TEAM.list(a));
    }))
    .then(Commands.literal('disband').executes(function (ctx) {
      var a = actorOf(ctx);
      if (a == null) return WAR.reply(ctx.source, '该命令只能由玩家执行');
      return WAR._teamResult(WAR_TEAM.disband(a), ctx.source);
    }));

  WAR.commands.helpLine('/war team create <队名> [颜色]', '建队（颜色：' + WAR.config.team.colors.join('/') + '）');
  WAR.commands.helpLine('/war team invite <玩家>', '邀请在线玩家（' + WAR.config.team.inviteExpireSeconds + ' 秒有效）');
  WAR.commands.helpLine('/war team accept [队伍ID]', '接受邀请');
  WAR.commands.helpLine('/war team leave', '退出队伍（队长退出自动移交；无人则解散）');
  WAR.commands.helpLine('/war team kick <玩家>', '队长踢人');
  WAR.commands.helpLine('/war team list', '看本队详情；无队伍则列出全服队伍');
  WAR.commands.helpLine('/war team disband', '队长解散队伍');

  return team;
});

// 命令层的结果包装：失败时 werr 已经回过消息（避免重复回显）
WAR._teamResult = function (res, source) {
  if (res == null) { WAR.reply(source, '操作未产生结果（内部错误）'); return 0; }
  if (res.ok === false) return 1;   // werr 已回显
  return 1;
};
WAR._teamCreateReply = function (res, source) {
  if (res == null) { WAR.reply(source, '建队未产生结果（内部错误）'); return 0; }
  return 1;
};

// ============================================================================
// 事件接线
// ============================================================================

// 上线：按 L1 纠正计分板归属 + 写 L2 缓存
PlayerEvents.loggedIn(function (event) {
  try {
    var p = event.player;
    var t = WAR_TEAM.of(p);
    if (t != null) {
      warTeamScoreboardSync(t);
      WAR.run('team join ' + t.id + ' ' + WAR.nameOf(p));
      warTeamCacheWrite(p, t.id);
    } else {
      WAR.run('team leave ' + WAR.nameOf(p));
      warTeamCacheWrite(p, '');
    }
  } catch (err) { console.error('[war] team loggedIn 同步失败：' + err); }
});

// 队伍击杀/阵亡统计（战斗数据，M1 之后的排行榜/结算要用）
EntityEvents.death(function (event) {
  try {
    var victim = event.getEntity();
    var attacker = null;
    try { attacker = event.getSource().getEntity(); } catch (e1) { }
    if (victim != null && warTeamIsPlayerEntity(victim)) {
      var tv = WAR_TEAM.of(victim);
      if (tv != null) { tv.stats.deaths = warToInt(tv.stats.deaths, 0) + 1; WAR.data.touch(); }
    }
    if (attacker != null && warTeamIsPlayerEntity(attacker)) {
      var ta = WAR_TEAM.of(attacker);
      if (ta != null) { ta.stats.kills = warToInt(ta.stats.kills, 0) + 1; WAR.data.touch(); }
    }
  } catch (err2) { warWarnOnce('team-death', 'death 统计异常：' + err2); }
});

// 队内免伤兜底
EntityEvents.beforeHurt(function (event) { warTeamFriendlyGuard(event); });

// 邀请过期清扫（60 秒一次）
WAR.every(1200, 'team.invite-expire', function () {
  var st = WAR_TEAM.state();
  var n = 0;
  for (var k in st.byId) if (st.byId.hasOwnProperty(k)) n += warTeamPurgeInvites(st.byId[k]);
  if (n > 0) warDebug('清理过期邀请 ' + n + ' 条');
});

// 开服后重建计分板镜像
WAR.hooks.boot.push(function (server) {
  try { WAR_TEAM.syncAll(server); } catch (e) { console.error('[war] team syncAll 失败：' + e); }
});

global.WAR.team = WAR_TEAM;   // 覆盖 00_core.js 里的 team stub（这是它预留的覆盖点）
warLog('10_team.js 已加载：团队域就绪（队内免伤=' + (WAR.config.team.friendlyFire ? '关' : '开') + '，上限 ' + WAR.config.team.maxMembers + ' 人）');
