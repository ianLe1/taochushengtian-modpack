// ============================================================================
// 战服 · 00_core.js —— 命名空间 / 数据根 / 审计 / 命令框架 / 公共工具
// ============================================================================
// 定位：M0「服务器骨架」（战服开发方案.md §0.2 全局架构、§8 M0 行、文末「编码第一刀」第 1 项）
// 权威存储：server.persistentData['war']（CompoundTag）——这是唯一权威，JSON 文件只当只读配置。
//
// 载荷约定（本文件是唯一读写入口，其它域脚本一律走 global.WAR.* API，禁止直接改 NBT）：
//   · 标量键：version / dataVersion / createdAt / bootCount / savedAt（NBT 原生标量）
//   · 结构化域：teams / audit / econ / spawn / claim / trade / shop / base / think / kv
//     各以「JSON 字符串」存放，一个域一个键。
//   ⚠ 为什么结构化域用 JSON 文本而不是嵌套 CompoundTag：
//     ① 跨字段一致性（队伍表 byId/byPlayer 必须同一笔落盘，避免只写一半）；
//     ② 不依赖 CompoundTag 的「创建」API（getCompound 在键缺失时返回游离空 tag，
//        写进去会静默丢失，是本类代码的经典坑）；
//     ③ 未来加字段无需改 NBT 结构，配合 dataVersion 迁移。
//   ⚠ 规模上限（lead 2026-10-04 批注）：本方案「整域重写 JSON」在单域条目涨到数千级
//     （M6 思索平台、M4 交易表）时序列化开销会变得可观；到那时应改为分片/增量落盘，先记于此。
//     —— 这是本文件的设计决定，交付报告里已向 lead 标注为「判断与偏差」之一。
//
// 已核实的 KubeJS/原版 API（javap 字节码实证，不臆造）：
//   ServerEvents.loaded / unloaded / tick / commandRegistry —— EventGroup 字符串名实证
//   CommandRegistryKubeEvent.register(LiteralArgumentBuilder) / .commands / .arguments
//   ArgumentTypeWrapper: create(CommandRegistryKubeEvent) / getResult(CommandContext, String)
//   CommandSourceStack: hasPermission(int) getPlayer() getServer() getLevel()
//                       sendSystemMessage(Component) sendSuccess(Supplier,boolean) sendFailure(Component)
//   CompoundTag: contains/getInt/getLong/getString/getBoolean/putInt/putLong/putString/putBoolean/
//                put/remove/getAllKeys
//   Java.loadClass('net.minecraft.nbt.CompoundTag') —— 本实例 chunk_metrics.js:832 已有先例
//   NBT.compoundTag()（兜底）；Text.string(String) -> MutableComponent；Text.<color>(Component)
//   server.persistentData / player.persistentData（WithPersistentData.kjs$getPersistentData）
//   server.runCommandSilent(String)
// ============================================================================

var WAR_NS = 'war';                 // server.persistentData 下的根键
var WAR_TICK = { n: 0, timers: [] }; // tick 分发器
var WAR_HOOKS = { boot: [] };        // 启动钩子（10_team.js 等域脚本往里挂）

// ============================================================================
// CONFIG —— 全部「待补充参数」集中在此，改一行即全局生效
// 标「暂定默认值」的项 = 用户/策划尚未拍板（见方案 §10 待补充清单），先给能跑的数。
// ============================================================================
var WAR_CONFIG = {
  version: '0.1.0-m0',           // 脚本版本（随里程碑递增）
  dataVersion: 1,                // 落盘 schema 版本（将来迁移用）
  debug: false,                  // 暂定默认值：是否输出 [war][debug] 细节日志
  team: {
    maxMembers: 8,               // 暂定默认值：单队人数上限
    friendlyFire: false,         // 暂定默认值：队内伤害（false = 关闭，队内免伤生效）
    inviteExpireSeconds: 300,    // 暂定默认值：邀请有效期（秒）
    nameMin: 2,                  // 暂定默认值：队名长度下限
    nameMax: 16,                 // 暂定默认值：队名长度上限
    defaultColor: 'blue',        // 暂定默认值：默认队伍颜色
    colors: ['blue', 'green', 'red', 'yellow', 'gold', 'aqua', 'light_purple',
             'dark_aqua', 'dark_green', 'dark_red', 'dark_blue', 'dark_purple',
             'gray', 'dark_gray', 'white', 'black']
  },
  audit: {
    bufferSize: 500              // 暂定默认值：审计环形缓冲条数（溢出即丢最旧并计数）
  },
  data: {
    autosaveTicks: 6000,         // 暂定默认值：脏数据自动落盘间隔（20 tick = 1 秒 → 300 秒）
    saveOnUnload: true           // 暂定默认值：服务器卸载时落盘
  },
  // 经济数值：2026-10-04 按 lead 批复从 30_economy.js 迁入（数值逐项一致，只挪位置；账本实现仍在 30_economy.js）
  econ: {
    currencyItem: 'kubejs:credit',   // 暂定默认值：货币物品 id（与 startup_scripts/war_items.js 注册的一致）
    ledgerKey: 'war.credit',         // 暂定默认值：账本键名（文档口径；实际存储位置 state.econ.balance）
    startBalance: 0,                 // 暂定默认值：新档初始发放（0 = 不自动发）
    firstJoinGrant: 0,               // 暂定默认值：玩家首次进服自动发放量（0 = 不发放，机制已就位）
    payMin: 1,                       // 暂定默认值：/war money pay 单笔最小额
    payMax: 1000,                    // 暂定默认值：单笔上限（pay / withdraw / deposit / admin 共用）
    feeEnabled: false,               // 暂定默认值：是否需要手续费
    feeRate: 0,                      // 暂定默认值：手续费比例（feeEnabled=false 时不生效）
    maxBalance: 1000000,             // 暂定默认值：单账户余额上限（防溢出/防空投砸盘）
    journalSize: 200,                // 暂定默认值：经济流水环大小
    opMemory: 200                    // 暂定默认值：幂等 opId 记忆条数
  },
  // 暂定默认值；出生点域实现在 20_spawn.js。dMax = 出生点硬门的**破坏度上限**：
  //   ① **暂定值、待实机标定** —— 标定方法：/cm scan 之后用 /war spawn admin dcalib 看 d 的真实分位数，
  //      **自然底噪的 p75 决定阈值下限**（当前这个数只是猜，不是结论）。
  //   ② **唯一真源** —— 20_spawn.js 侧的 SP_D_MAX_FALLBACK=0.05 只在 core 缺键时保底，并 warWarnOnce('spawn-cfg-dmax') 点名。
  // 另：coverMin = 出生点**覆盖度门槛**（3×3 窗口里 fresh 记录数下限，取值 1..9）：
  //   ① **暂定值、待实机标定** —— 标定方法：/cm scan 之后用 /war spawn admin dcalib，看「fresh ≥ coverMin 的窗口占比」；
  //      覆盖不足时 a/d 不可信 ⇒ 会出现「只有几块扫过、恰好都是 a=0」的**假放行**（用户规格里最坏的失效模式）。
  //   ② **唯一真源** —— 20_spawn.js 侧的 SP_COVER_MIN_FALLBACK=7 只在 core 缺键时保底，并 warWarnOnce('spawn-cfg-covermin') 点名。
  spawn: { mode: 'cm-score', candidateRadius: 5000, tries: 64, dMax: 0.05, coverMin: 7 },
  claim: { enabled: false, defaultRadius: 32 },            // 暂定默认值；40_base.js
  // 暂定默认值；据点域实现在 40_base.js（**隐性人工程度**模型）。**单位口径**（CM 口径一页纸）：
  //   a/d ∈ [0,1] 小数、有饱和、不是计数；聚合口径 = 区域内**新鲜区块**（status=ok 且 stale=false）的 a 求和。
  //   **下列数字全部是暂定值、待标定**（标定方法：/cm calib 定基线 → /cm scan 重扫 → 看区域 aSum/dSum 的真实分位数再定阈值）；
  //   谁能把暂定值当结论，复核时会挑出来。
  base: {
    enabled: true,               // 暂定默认值：据点系统开关（**未标定时无论如何都拒绝工作**，见 40_base.js）
    radiusChunks: 2,             // 暂定默认值：区域半径（区块）—— 必须覆盖 1–2 块边界，否则跨区建筑会被判丢
    aSumMin: 1.2,                // 暂定默认值：据点门槛【单位 = 新鲜区块 a 求和；半径 2 ⇒ 25 槽、理论上限 25.0】
    holdTicks: 1200,             // 暂定默认值：连续满足 aSumMin 的时长（tick）才算形成据点
    aSumDrop: 0.4,               // 暂定默认值：aSum 相对峰值下降多少 ⇒ damaged
    dSumMax: 2.0,                // 暂定默认值：d 求和上限（超过视为重破坏）
    minFreshShare: 0.6,          // 暂定默认值：新鲜读数占槽位比例下限（低于此不判定、不登记）
    absentTicks: 24000,          // 暂定默认值：主导者缺席多久算长期缺席（20 分钟）
    captureRatio: 1.2,           // 暂定默认值：新主导者 ≥ 原主导者 × 该比例（近似期用「在场连续时长」比较）
    scanInterval: 1200,          // 暂定默认值：扫描间隔（tick，60 秒）
    maxBases: 64                 // 暂定默认值：单次扫描最多维护的据点数（防跑飞）
  },
  trade: { enabled: false, taxRate: 0 },                   // 暂定默认值；50_trade.js
  shop:  { enabled: true, catalogPath: 'war/shop/catalog.json', spread: 0, maxPerTransaction: 64 }, // 暂定默认值；60_shop.js（唯一真源，域侧只读）
  think: { enabled: false, intelTtlSeconds: 900 },         // 暂定默认值；70_think.js
  admin: { commandPermissionLevel: 2 }                     // /war admin * 所需原版权限等级
};

// ============================================================================
// 0. 公共工具
// ============================================================================

function warNow() { return Date.now(); }

function warPad2(n) { return (n < 10 ? '0' : '') + n; }

function warFmtTime(ms) {
  try {
    var d = new Date(ms);
    return d.getFullYear() + '-' + warPad2(d.getMonth() + 1) + '-' + warPad2(d.getDate()) + ' ' +
           warPad2(d.getHours()) + ':' + warPad2(d.getMinutes()) + ':' + warPad2(d.getSeconds());
  } catch (e) { return String(ms); }
}

function warJ(v) {
  try { return JSON.stringify(v); } catch (e) { console.error('[war] JSON 序列化失败：' + e); return null; }
}

function warParse(s, dft) {
  if (s == null || s === '') return dft;
  try { var v = JSON.parse(String(s)); return (v == null) ? dft : v; }
  catch (e) {
    console.error('[war] JSON 解析失败，回退默认值：' + e);
    return dft;
  }
}

function warToInt(v, dft) {
  var n = parseInt(String(v), 10);
  return isNaN(n) ? dft : n;
}

function warLog(msg) { console.info('[war] ' + msg); }

function warDebug(msg, opts) { try { if (WAR_CONFIG.debug) console.info('[war][debug] ' + msg); } catch (e) { } }

function warCountKeys(o) {
  try { return (o == null) ? 0 : Object.keys(o).length; } catch (e) { return 0; }
}

// 玩家标识：优先 .uuid（KubeJS 属性），逐级回落到原版方法名。
// ⚠ 全部为「离线不可判定、需实机确认」项：Rhino 的 mojmap→运行时映射在真机上才生效。
function warUuid(p) {
  if (p == null) return '';
  try { var a = p.uuid; if (a != null) return String(a); } catch (e1) { }
  try { var b = p.getUUID(); if (b != null) return String(b); } catch (e2) { }
  try { var c = p.getStringUUID(); if (c != null) return String(c); } catch (e3) { }
  return '';
}

function warName(p) {
  if (p == null) return '?';
  try { var a = p.username; if (a != null && String(a) !== '') return String(a); } catch (e1) { }
  try { var b = p.getName().getString(); if (b != null && String(b) !== '') return String(b); } catch (e2) { }
  try { var c = p.getScoreboardName(); if (c != null && String(c) !== '') return String(c); } catch (e3) { }
  return '?';
}

function warHasPermission(source, level) {
  try { return source.hasPermission(warToInt(level, 2)) === true; } catch (e) { return false; }
}

// 读 INTEGER 命令参数：argType = 命令事件里的 event.arguments.INTEGER（ArgumentTypeWrapper）。
// 失败/非数字一律回落 dft —— 不再让 NaN 外泄（这是与 20_spawn 原 spIntOf 的唯一语义差异）。
// 签名比最初设想多一个 argType：getResult 是 ArgumentTypeWrapper 的方法，而 core 里没有全局 Arguments
// （它只在 commandRegistry 事件回调内有效），所以由调用方把已 create 好的类型传进来。
function warIntArg(argType, ctx, name, dft) {
  var w = warArgWrapper(argType, 'int');
  if (w == null) return dft;
  try { return warToInt(w.getResult(ctx, name), dft); } catch (e) { return dft; }
}

// 参数包装对象守卫：必须传 event.arguments.<TYPE>（ArgumentTypeWrapper），**不是** create(event) 的返回值
//（那个是 ArgumentType，没有 getResult）。传错时告警一次并回落，避免像之前那样静默算出错值。
function warArgWrapper(argType, tag) {
  if (argType != null && typeof argType.getResult === 'function') return argType;
  warWarnOnce('argwrap-' + tag, '参数工具收到不合法的参数类型：应传 Arguments.<TYPE> 包装对象，而不是 create(event) 的结果（已按缺省值回落）');
  return null;
}

// 整数钳位：语义**照抄 20_spawn.js:142 的 spClampInt**（Number → NaN/±Inf 回落 dft → 夹 [lo,hi] → Math.round），
// 目的就是将来把它的 4 个调用点换过来时逐条等价。注意与 warToInt/parseInt 的差别：
// 传入小数会四舍五入（3.6→4），Infinity 会回落 dft 而不是夹到上界 —— 这两条都是 spClampInt 的既有行为。
function warClampInt(v, lo, hi, dft) {
  var n = Number(v);
  if (isNaN(n) || !isFinite(n)) n = dft;
  if (n < lo) n = lo;
  if (n > hi) n = hi;
  return Math.round(n);
}

// 读 PLAYER 命令参数：argType = 命令事件里的 event.arguments.PLAYER（ArgumentTypeWrapper）。
// 失败/未解析一律返回 null，由调用方给出各自的既有文案 —— 本函数不产出任何面向玩家的文本（故对文案零影响）。
// 签名同 warIntArg 需带 argType；这是唯一被统一掉的差异：原 10_team 裸调会把异常外泄，原 30_economy 的
// playerOf 已经吞异常返回 null —— 统一后一律取「吞异常」这一侧（更稳，且不改变任何既有文案）。
function warPlayerArg(argType, ctx, name) {
  var w = warArgWrapper(argType, 'player');
  if (w == null) return null;
  try {
    var p = w.getResult(ctx, name);
    return (p == null) ? null : p;
  } catch (e) { return null; }
}

// OP 谓词工厂（三域统一入口）：给 admin 子命令挂权限；level 缺省 = WAR_CONFIG.admin.commandPermissionLevel。
// 抽取理由：00_core / 20_spawn / 30_economy 原本各写一份内联谓词，写法还不一致（warHasPermission vs WAR.hasPermission）。
function warOpPredicate(level) {
  var lv = warToInt(level, WAR_CONFIG.admin.commandPermissionLevel);
  return function (src) { return warHasPermission(src, lv); };
}

// 命令回显：控制台与玩家都可用。Text.string 已核实（TextWrapper.string(String)）。
function warReply(source, msg) {
  warLog(msg);
  var comp = null;
  try { comp = Text.string(String(msg)); } catch (e0) { comp = null; }
  if (comp != null) {
    try { source.sendSystemMessage(comp); return 1; } catch (e1) { }
    try { source.sendSuccess(function () { return comp; }, false); return 1; } catch (e2) { }
    try { source.sendFailure(comp); return 1; } catch (e3) { }
  }
  try { source.sendSystemMessage(String(msg)); return 1; } catch (e4) { }
  return 1;
}

function warTell(player, msg) {
  if (player == null) return false;
  try { player.tell(Text.string(String(msg))); return true; } catch (e1) { }
  try { player.tell(String(msg)); return true; } catch (e2) { }
  return false;
}

// 执行原版命令（计分板队伍等）。静默执行，失败只记日志。
function warRun(cmd) {
  try {
    if (WAR_DATA.server != null && WAR_DATA.server.runCommandSilent != null) {
      WAR_DATA.server.runCommandSilent(String(cmd));
      warDebug('run: ' + cmd);
      return true;
    }
  } catch (e) { console.error('[war] 命令执行失败 [' + cmd + ']：' + e); }
  return false;
}

// ============================================================================
// 1. 数据层（L1 权威存储）：server.persistentData['war']
// ============================================================================

// 有序迁移链：WAR_DATA_MIGRATIONS[n] = function(st) 把 schema n 升到 n+1。
// **当前为空**（lead 明确：不许顺手给现有域加迁移函数）；缺哪一级就拒绝接管，绝不猜形状。
var WAR_DATA_MIGRATIONS = [];

// schema 版本状态（只读对外；唯一代码侧版本常量是 WAR_CONFIG.dataVersion）
var WAR_SCHEMA = {
  code: 1, stored: 1, refused: false, reason: '', lastMigrate: '', lastRefuseAt: 0
};
WAR_SCHEMA.code = warToInt(WAR_CONFIG.dataVersion, 1);
WAR_SCHEMA.stored = WAR_SCHEMA.code;

var WAR_DATA = {
  server: null,
  state: null,          // 内存镜像（唯一可写副本），落盘时才序列化
  dirty: false,
  warned: {},
  lastLoadAt: 0,
  lastSaveAt: 0,
  javaOk: false,
  CT: null,
  readOnly: false,          // schema 拒绝接管时置真：不落盘、不写入
  schema: WAR_SCHEMA,
  migrations: WAR_DATA_MIGRATIONS,

  newTag: function () {
    if (!WAR_DATA.javaOk) {
      try { WAR_DATA.CT = Java.loadClass('net.minecraft.nbt.CompoundTag'); WAR_DATA.javaOk = true; }
      catch (e1) { WAR_DATA.javaOk = false; }
    }
    if (WAR_DATA.javaOk) {
      try { return new WAR_DATA.CT(); } catch (e2) { }
    }
    try { return NBT.compoundTag(); } catch (e3) { }
    return null;
  },

  defaultState: function () {
    return {
      version: WAR_CONFIG.version,
      schemaVersion: WAR_CONFIG.dataVersion,   // 权威：数据形状版本
      dataVersion: WAR_CONFIG.dataVersion,     // 遗留镜像（兼容老读取方，不参与判定）
      createdAt: warNow(),
      bootCount: 0,
      savedAt: 0,
      teams: { seq: 0, byId: {}, byPlayer: {} },
      audit: { seq: 0, dropped: 0, items: [] },
      econ:  { __stub: true, __owner: '30_economy.js', balance: {} },
      spawn: { __stub: true, __owner: '20_spawn.js' },
      claim: { __stub: true, __owner: '40_base.js' },
      trade: { __stub: true, __owner: '50_trade.js' },
      shop:  { __stub: true, __owner: '60_shop.js' },
      base:  { __stub: true, __owner: '40_base.js' },
      think: { __stub: true, __owner: '70_think.js' },
      kv:    {}
    };
  },

  bind: function (server) { WAR_DATA.server = server; return WAR_DATA.server != null; },

  // 只读拿到权威 NBT 根；不存在或不可用返回 null
  root: function () {
    if (WAR_DATA.server == null) return null;
    try {
      var pd = WAR_DATA.server.persistentData;
      if (pd.contains(WAR_NS)) return pd.getCompound(WAR_NS);
    } catch (e) { warWarnOnce('pd-read', 'persistentData 读取不可用：' + e); }
    return null;
  },

  // 结构防呆：JSON 载荷被外部改坏时仍能跑
  normalize: function (st) {
    if (st == null || typeof st !== 'object') st = WAR_DATA.defaultState();
    if (typeof st.version !== 'string') st.version = WAR_CONFIG.version;
    if (typeof st.schemaVersion !== 'number') st.schemaVersion = (typeof st.dataVersion === 'number') ? st.dataVersion : WAR_CONFIG.dataVersion;
    if (typeof st.dataVersion !== 'number') st.dataVersion = st.schemaVersion;
    if (typeof st.createdAt !== 'number' || st.createdAt <= 0) st.createdAt = warNow();
    if (typeof st.bootCount !== 'number') st.bootCount = 0;
    if (typeof st.savedAt !== 'number') st.savedAt = 0;
    if (st.teams == null || typeof st.teams !== 'object') st.teams = { seq: 0, byId: {}, byPlayer: {} };
    if (st.teams.byId == null || typeof st.teams.byId !== 'object') st.teams.byId = {};
    if (st.teams.byPlayer == null || typeof st.teams.byPlayer !== 'object') st.teams.byPlayer = {};
    if (typeof st.teams.seq !== 'number') st.teams.seq = warCountKeys(st.teams.byId);
    if (st.audit == null || typeof st.audit !== 'object') st.audit = { seq: 0, dropped: 0, items: [] };
    if (!(st.audit.items instanceof Array)) st.audit.items = [];
    if (typeof st.audit.seq !== 'number') st.audit.seq = st.audit.items.length;
    if (typeof st.audit.dropped !== 'number') st.audit.dropped = 0;
    if (st.kv == null || typeof st.kv !== 'object') st.kv = {};
    var domains = ['econ', 'spawn', 'claim', 'trade', 'shop', 'base', 'think'];
    for (var i = 0; i < domains.length; i++) {
      if (st[domains[i]] == null || typeof st[domains[i]] !== 'object') st[domains[i]] = { __stub: true };
    }
    return st;
  },

  // schema 判定：更旧 → 走迁移链；更新 → **拒绝接管**（只读；盘上数据一字不动）
  checkSchema: function (st) {
    var code = warToInt(WAR_CONFIG.dataVersion, 1);
    var stored = warToInt(st.schemaVersion, code);
    st.schemaVersion = stored;
    st.dataVersion = stored;                     // 镜像同步（只写不判）
    WAR_SCHEMA.code = code; WAR_SCHEMA.stored = stored;
    if (stored > code) {
      WAR_DATA.readOnly = true;
      WAR_SCHEMA.refused = true;
      WAR_SCHEMA.reason = '数据 schema v' + stored + ' 比代码 v' + code + ' 新';
      WAR_SCHEMA.lastRefuseAt = warNow();
      return { ok: false, refused: true, from: stored, to: code, ran: [] };
    }
    WAR_DATA.readOnly = false; WAR_SCHEMA.refused = false; WAR_SCHEMA.reason = '';
    if (stored < code) return WAR_DATA.migrate(st, code);
    return { ok: true, refused: false, migrated: false, from: stored, to: code, ran: [] };
  },

  // 逐级迁移：每步成功后推进版本 ⇒ 幂等（第二次 from===to 直接返回、不重复执行）
  // 缺函数 / 抛异常 → 返回失败且**不推进版本**（调用方据此拒绝接管，绝不猜形状）
  migrate: function (st, _to) {
    if (st == null) return { ok: false, error: '数据根为空' };
    var to = warToInt(_to, warToInt(WAR_CONFIG.dataVersion, 1));
    var from = warToInt(st.schemaVersion, to);
    if (from === to) return { ok: true, refused: false, migrated: false, from: from, to: to, ran: [] };
    if (from > to) return { ok: false, error: '数据 schema v' + from + ' 比目标 v' + to + ' 新（不降级）', from: from, to: to, ran: [] };
    var ran = [];
    for (var v = from; v < to; v++) {
      var fn = WAR_DATA_MIGRATIONS[v];
      if (typeof fn !== 'function') return { ok: false, error: '缺少 v' + v + ' → v' + (v + 1) + ' 的迁移函数', from: from, to: to, ran: ran };
      try { fn(st); } catch (e) { return { ok: false, error: 'v' + v + ' → v' + (v + 1) + ' 迁移抛异常：' + e, from: from, to: to, ran: ran }; }
      st.schemaVersion = v + 1;
      st.dataVersion = st.schemaVersion;
      ran.push(v + '→' + (v + 1));
    }
    WAR_SCHEMA.lastMigrate = 'v' + from + '→v' + to;
    return { ok: true, refused: false, migrated: true, from: from, to: to, ran: ran };
  },

  load: function (server) {
    if (server != null) WAR_DATA.bind(server);
    var st = WAR_DATA.defaultState();
    var root = WAR_DATA.root();
    var firstBoot = (root == null);
    if (root != null) {
      try {
        if (root.contains('version')) st.version = String(root.getString('version'));
        if (root.contains('schemaVersion')) st.schemaVersion = warToInt(root.getInt('schemaVersion'), WAR_CONFIG.dataVersion);
        if (root.contains('dataVersion')) st.dataVersion = warToInt(root.getInt('dataVersion'), WAR_CONFIG.dataVersion);
        if (!root.contains('schemaVersion') && root.contains('dataVersion')) st.schemaVersion = st.dataVersion;   // 旧档只写过 dataVersion
        if (root.contains('createdAt')) st.createdAt = Number(root.getLong('createdAt'));
        if (root.contains('bootCount')) st.bootCount = warToInt(root.getInt('bootCount'), 0);
        if (root.contains('savedAt')) st.savedAt = Number(root.getLong('savedAt'));
        st.teams = warParse(root.getString('teams'), st.teams);
        st.audit = warParse(root.getString('audit'), st.audit);
        st.econ  = warParse(root.getString('econ'),  st.econ);
        st.spawn = warParse(root.getString('spawn'), st.spawn);
        st.claim = warParse(root.getString('claim'), st.claim);
        st.trade = warParse(root.getString('trade'), st.trade);
        st.shop  = warParse(root.getString('shop'),  st.shop);
        st.base  = warParse(root.getString('base'),  st.base);
        st.think = warParse(root.getString('think'), st.think);
        st.kv    = warParse(root.getString('kv'),    st.kv);
      } catch (err) {
        console.error('[war] 数据根读取异常，已回退默认值：' + err);
      }
    }
    var chk = WAR_DATA.checkSchema(st);
    if (chk.refused === true) {
      // 拒绝接管：不 normalize（保持读到的原样）、不改盘；只把拒绝记进**内存**审计面
      WAR_DATA.state = st;
      WAR_DATA.dirty = false;
      WAR_DATA.lastLoadAt = warNow();
      WAR_AUDIT.append('system', 'data.refuse', 'schema', 'refuse',
                       'stored=v' + chk.from + ' code=v' + chk.to + (chk.error ? ' ' + chk.error : ''));
      warWarnOnce('schema-readonly', '数据来自更新版本（' + (WAR_SCHEMA.reason || chk.error || '') + '）：本次只读，不接管、不落盘；请升级脚本');
      warLog('数据根载入被拒绝：stored=v' + chk.from + ' > code=v' + chk.to + '（只读，磁盘数据原样保留）');
      return st;
    }
    st = WAR_DATA.normalize(st);
    WAR_DATA.state = st;
    WAR_DATA.dirty = false;
    if (chk.migrated === true) {
      WAR_AUDIT.append('system', 'data.migrate', 'schema', 'ok',
                       'from=v' + chk.from + ' to=v' + chk.to + ' 步骤=' + chk.ran.join(','));
      warLog('数据根已迁移：v' + chk.from + ' → v' + chk.to + '（步骤 ' + chk.ran.join(',') + '）');
    }
    WAR_DATA.lastLoadAt = warNow();
    warLog('数据根载入：' + (firstBoot ? '首次启动（将创建键 ' + WAR_NS + '）' : '已存在')
           + '｜schema v' + st.dataVersion + '｜bootCount=' + st.bootCount
           + '｜队伍=' + warCountKeys(st.teams.byId) + '｜审计=' + st.audit.items.length);
    return st;
  },

  save: function (reason) {
    if (WAR_DATA.state == null) return false;
    if (WAR_DATA.readOnly === true) {        // schema 拒绝接管：绝不按旧形状写盘
      warWarnOnce('schema-save-blocked', '数据来自更新版本（只读）：拒绝落盘，避免按旧形状写坏存档');
      return false;
    }
    if (WAR_DATA.server == null) { warWarnOnce('no-server', '尚未绑定服务器，落盘跳过'); return false; }
    var tag = WAR_DATA.newTag();
    if (tag == null) { warWarnOnce('no-tag', '无法创建 CompoundTag，落盘跳过（内存数据仍在）'); return false; }
    try {
      var st = WAR_DATA.state;
      tag.putString('version', String(st.version));
      tag.putInt('schemaVersion', warToInt(st.schemaVersion, WAR_CONFIG.dataVersion));   // 权威（数据形状版本）
      tag.putInt('dataVersion', warToInt(st.dataVersion, WAR_CONFIG.dataVersion));       // 遗留镜像
      tag.putLong('createdAt', Number(st.createdAt));
      tag.putInt('bootCount', warToInt(st.bootCount, 0));
      tag.putLong('savedAt', warNow());
      tag.putString('teams', warJ(st.teams) || '{}');
      tag.putString('audit', warJ(st.audit) || '{}');
      tag.putString('econ',  warJ(st.econ)  || '{}');
      tag.putString('spawn', warJ(st.spawn) || '{}');
      tag.putString('claim', warJ(st.claim) || '{}');
      tag.putString('trade', warJ(st.trade) || '{}');
      tag.putString('shop',  warJ(st.shop)  || '{}');
      tag.putString('base',  warJ(st.base)  || '{}');
      tag.putString('think', warJ(st.think) || '{}');
      tag.putString('kv',    warJ(st.kv)    || '{}');
      WAR_DATA.server.persistentData.put(WAR_NS, tag);
      WAR_DATA.lastSaveAt = warNow();
      WAR_DATA.state.savedAt = WAR_DATA.lastSaveAt;
      WAR_DATA.dirty = false;
      warDebug('已落盘（' + reason + '）');
      return true;
    } catch (err) {
      warWarnOnce('pd-write', 'persistentData 写入不可用，落盘失败（内存数据仍在）：' + err);
      return false;
    }
  },

  touch: function () { WAR_DATA.dirty = true; return true; },

  // 一次改动包成事务样子：出错不落盘、不标记脏
  mutate: function (label, fn) {
    if (WAR_DATA.state == null) return { ok: false, error: '数据根未载入' };
    if (WAR_DATA.readOnly === true) return { ok: false, error: '数据来自更新版本（只读）：拒绝写入' };
    try {
      var ret = fn(WAR_DATA.state);
      WAR_DATA.dirty = true;
      return { ok: true, ret: ret };
    } catch (err) {
      console.error('[war] mutate[' + label + '] 失败：' + err);
      return { ok: false, error: String(err) };
    }
  },

  // 通用 KV（给还没独立成域的脚本用；持久化在 kv 键）
  kv: {
    get: function (k, dft) {
      try { var v = WAR_DATA.state.kv[String(k)]; return (v === undefined) ? dft : v; } catch (e) { return dft; }
    },
    set: function (k, v) {
      try { WAR_DATA.state.kv[String(k)] = v; WAR_DATA.dirty = true; return true; } catch (e) { return false; }
    },
    has: function (k) {
      try { return WAR_DATA.state.kv.hasOwnProperty(String(k)); } catch (e) { return false; }
    },
    del: function (k) {
      try { delete WAR_DATA.state.kv[String(k)]; WAR_DATA.dirty = true; return true; } catch (e) { return false; }
    }
  }
};

function warWarnOnce(tag, msg) {
  var t = String(tag || '?');
  if (WAR_DATA.warned[t] === true) return;
  WAR_DATA.warned[t] = true;
  console.error('[war] ' + msg);
}

// ============================================================================
// 2. 审计日志（环形缓冲 + 结构化条目：时间/主体/动作/对象/结果）
// ============================================================================

var WAR_AUDIT = {
  // actor = 谁（玩家名 / 'system' / 'cmd:console'），action = 做了什么，
  // target = 对谁/对什么，result = 'ok' | 'fail' | 'deny' | ...，detail = 可选细节
  append: function (actor, action, target, result, detail) {
    if (WAR_DATA.state == null) return null;
    try {
      WAR_DATA.state.audit.seq = warToInt(WAR_DATA.state.audit.seq, 0) + 1;
      var e = {
        seq: WAR_DATA.state.audit.seq,
        t: warNow(),
        actor: String(actor == null ? '-' : actor),
        action: String(action == null ? '-' : action),
        target: String(target == null ? '-' : target),
        result: String(result == null ? '-' : result)
      };
      if (detail != null) e.detail = String(detail);
      WAR_DATA.state.audit.items.push(e);
      var cap = warToInt(WAR_CONFIG.audit.bufferSize, 500);
      if (cap < 1) cap = 1;
      while (WAR_DATA.state.audit.items.length > cap) {
        WAR_DATA.state.audit.items.shift();
        WAR_DATA.state.audit.dropped = warToInt(WAR_DATA.state.audit.dropped, 0) + 1;
      }
      WAR_DATA.dirty = true;
      return e;
    } catch (err) { console.error('[war] 审计写入失败：' + err); return null; }
  },

  count: function () {
    try { return WAR_DATA.state.audit.items.length; } catch (e) { return 0; }
  },

  tail: function (n) {
    var k = warToInt(n, 20);
    if (k < 1) k = 1;
    try {
      var a = WAR_DATA.state.audit.items;
      return a.slice(Math.max(0, a.length - k));
    } catch (e) { return []; }
  },

  last: function () {
    try { var a = WAR_DATA.state.audit.items; return a.length ? a[a.length - 1] : null; } catch (e) { return null; }
  },

  text: function (n) {
    var list = WAR_AUDIT.tail(n);
    if (list.length === 0) return '审计为空';
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      out.push('#' + e.seq + ' ' + warFmtTime(e.t) + ' ' + e.actor + ' ' + e.action +
               ' -> ' + e.target + ' = ' + e.result + (e.detail ? '（' + e.detail + '）' : ''));
    }
    return out.join(' | ');
  }
};

// ============================================================================
// 3. 未实现域的 stub（按方案 §0.2 的拆档预留；实现时覆盖同名成员）
// ============================================================================

function warStub(domain, owner, note) {
  return {
    __stub: true,
    __owner: owner,
    __note: note,
    status: function () { return { domain: domain, implemented: false, owner: owner, note: note }; }
  };
}

var WAR_TEAM_STUB = {
  __stub: true,
  __owner: '10_team.js',
  __note: '团队域：由 10_team.js 覆盖（create/invite/accept/leave/kick/list/disband/of/sameTeam）',
  status: function () { return { domain: 'team', implemented: false, owner: '10_team.js', note: WAR_TEAM_STUB.__note }; },
  of: function () { return null; },
  sameTeam: function () { return false; },
  isAlly: function () { return false; }
};

// ============================================================================
// 4. 命令框架 + /war 命令树
// ============================================================================

var WAR_COMMANDS = {
  nodes: [],   // 各域注册的节点工厂：function (Commands, Arguments, event) -> node
  help: [],
  add: function (factory) { WAR_COMMANDS.nodes.push(factory); return true; },
  helpLine: function (usage, desc) { WAR_COMMANDS.help.push({ usage: usage, desc: desc }); return true; }
};

function warVersionText() {
  var st = WAR_DATA.state;
  var teams = 0, audit = 0, dropped = 0, boots = '-';
  if (st != null) {
    teams = warCountKeys(st.teams.byId);
    audit = (st.audit.items instanceof Array) ? st.audit.items.length : 0;
    dropped = st.audit.dropped;
    boots = st.bootCount;
  }
  return '战服 v' + WAR_CONFIG.version + '（数据 schema v' + WAR_CONFIG.dataVersion + '）' +
         ' | 就绪=' + (WAR.ready ? '是' : '否') +
         ' | 权威存储=server.persistentData.' + WAR_NS + (WAR_DATA.root() != null ? '（已存在）' : '（待创建）') +
         ' | 启动次数=' + boots + ' | 队伍=' + teams + ' 审计=' + audit + '（丢帧 ' + dropped + '）';
}

function warHelpText() {
  var out = ['战服命令（' + WAR_COMMANDS.help.length + ' 条）：'];
  for (var i = 0; i < WAR_COMMANDS.help.length; i++) {
    out.push(WAR_COMMANDS.help[i].usage + ' —— ' + WAR_COMMANDS.help[i].desc);
  }
  return out.join(' | ');
}

function warAdminStatusText() {
  var st = WAR_DATA.state;
  var root = WAR_DATA.root();
  var keys = '-';
  try { if (root != null) keys = String(root.getAllKeys()); } catch (e) { }
  var parts = [
    'OP 自检',
    'ready=' + (WAR.ready ? 'Y' : 'N'),
    'java桥=' + (WAR_DATA.javaOk ? 'Y' : 'N'),
    'dirty=' + (WAR_DATA.dirty ? 'Y' : 'N'),
    '存储键=' + WAR_NS,
    'NBT键=' + keys,
    'bootCount=' + (st ? st.bootCount : '-'),
    '队伍=' + (st ? warCountKeys(st.teams.byId) : 0),
    '玩家映射=' + (st ? warCountKeys(st.teams.byPlayer) : 0),
    '审计=' + (st ? st.audit.items.length : 0) + '/' + WAR_CONFIG.audit.bufferSize + '（丢帧 ' + (st ? st.audit.dropped : 0) + '）',
    'lastLoad=' + (WAR_DATA.lastLoadAt ? warFmtTime(WAR_DATA.lastLoadAt) : '-'),
    'lastSave=' + (WAR_DATA.lastSaveAt ? warFmtTime(WAR_DATA.lastSaveAt) : '-'),
    'tick=' + WAR_TICK.n,
    '定时器=' + WAR_TICK.timers.length
  ];
  return parts.join(' | ');
}

WAR_COMMANDS.helpLine('/war version', '版本与运行状态');
WAR_COMMANDS.helpLine('/war help', '本帮助');
WAR_COMMANDS.helpLine('/war admin status|audit [n]|save', 'OP' + WAR_CONFIG.admin.commandPermissionLevel + '：数据根自检 / 审计回看 / 手动落盘');

ServerEvents.commandRegistry(function (event) {
  try {
    var Commands = event.commands;
    var Arguments = event.arguments;

    var root = Commands.literal('war')
      .executes(function (ctx) { return warReply(ctx.source, warHelpText()); })
      .then(Commands.literal('version').executes(function (ctx) {
        return warReply(ctx.source, warVersionText());
      }))
      .then(Commands.literal('help').executes(function (ctx) {
        return warReply(ctx.source, warHelpText());
      }));

    // /war admin 子树已整体迁至 90_admin.js（D1-a，lead 批复：权限声明唯一，避免第二个字面量漏挂 requires
    // 形成权限洞）。status/audit/save 三个子命令的文本、审计字段与回显**逐字搬移**，未改动。
    // warAdminStatusText() 仍留在本文件（被 90_admin.js 复用）。

    // 各域脚本注册的命令节点（10_team.js 等）
    for (var i = 0; i < WAR_COMMANDS.nodes.length; i++) {
      try {
        var node = WAR_COMMANDS.nodes[i](Commands, Arguments, event);
        if (node != null) root.then(node);
      } catch (e1) { console.error('[war] 命令节点注册失败 #' + i + '：' + e1); }
    }

    event.register(root);
    warDebug('命令树已注册（域节点 ' + WAR_COMMANDS.nodes.length + ' 个）');
  } catch (err) {
    console.error('[war] 命令注册失败（JS API 不受影响）：' + err);
  }
});

function warActorName(source) {
  try {
    var p = source.getPlayer();
    if (p != null) return warName(p);
  } catch (e) { }
  return 'console';
}

// ============================================================================
// 5. tick 分发器 + 启动/卸载钩子
// ============================================================================

// 注册一个周期任务（ticks = 间隔）；回调异常只记日志，不影响其它任务
function warEvery(ticks, label, fn) {
  WAR_TICK.timers.push({ ticks: Math.max(1, warToInt(ticks, 20)), last: WAR_TICK.n, label: String(label || '?'), fn: fn });
  return true;
}

// 只读入口（C1，lead 批复）：供 90_admin.js 的 /war admin tasks 用；只列 label/ticks/last，**不导出 fn**
function warTimerList() {
  var out = [];
  try {
    for (var i = 0; i < WAR_TICK.timers.length; i++) {
      var t = WAR_TICK.timers[i];
      out.push({ label: t.label, ticks: t.ticks, last: t.last });
    }
  } catch (e) { warWarnOnce('timer-list', '定时器清单读取失败：' + e); }
  return out;
}

function warTick(server) {
  WAR_TICK.n++;
  for (var i = 0; i < WAR_TICK.timers.length; i++) {
    var t = WAR_TICK.timers[i];
    if ((WAR_TICK.n - t.last) >= t.ticks) {
      t.last = WAR_TICK.n;
      try { t.fn(server); } catch (err) { console.error('[war] 定时器[' + t.label + '] 异常：' + err); }
    }
  }
  try {
    if (WAR_DATA.dirty && (WAR_TICK.n - warLastAutosave) >= warToInt(WAR_CONFIG.data.autosaveTicks, 6000)) {
      warLastAutosave = WAR_TICK.n;
      WAR_DATA.save('autosave');
    }
  } catch (err2) { warWarnOnce('autosave', '自动落盘异常：' + err2); }
}
var warLastAutosave = 0;

function warBoot(server) {
  try {
    if (server == null) return false;
    WAR_DATA.bind(server);
    WAR_DATA.load(server);
    if (WAR_DATA.readOnly === true) {
      // schema 拒绝接管：不跑 boot 钩子、不落盘、ready=否 —— 宁可不工作，也不按错误形状写坏存档
      WAR.ready = false;
      warLog('拒绝接管：' + (WAR_SCHEMA.reason || 'schema 不兼容') + '（只读；磁盘数据原样保留）');
      return false;
    }
    WAR_DATA.state.bootCount = warToInt(WAR_DATA.state.bootCount, 0) + 1;
    WAR.ready = true;
    WAR.bootAt = warNow();
    WAR_AUDIT.append('system', 'server.boot', 'world', 'ok',
                     'v' + WAR_CONFIG.version + ' boot#' + WAR_DATA.state.bootCount);
    for (var i = 0; i < WAR_HOOKS.boot.length; i++) {
      try { WAR_HOOKS.boot[i](server); } catch (e1) { console.error('[war] boot 钩子 #' + i + ' 异常：' + e1); }
    }
    WAR_DATA.save('boot');
    warLog('核心就绪 v' + WAR_CONFIG.version + '｜' + warVersionText());
    return true;
  } catch (err) {
    console.error('[war] boot 失败：' + err);
    return false;
  }
}

function warShutdown(server) {
  try {
    if (WAR_CONFIG.data.saveOnUnload) WAR_DATA.save('unload');
    WAR_AUDIT.append('system', 'server.unload', 'world', 'ok');
    WAR_DATA.save('unload-final');
    WAR.ready = false;
    warLog('已停服落盘');
    return true;
  } catch (err) { console.error('[war] 停服落盘失败：' + err); return false; }
}

ServerEvents.loaded(function (event) { warBoot(event.server); });
ServerEvents.unloaded(function (event) { warShutdown(event.server); });
ServerEvents.tick(function (event) { try { warTick(event.server); } catch (err) { warWarnOnce('tick', 'tick 异常：' + err); } });

// ============================================================================
// 6. 对外命名空间（唯一的写入口）
// ============================================================================

global.WAR = {
  version: WAR_CONFIG.version,
  config: WAR_CONFIG,
  ready: false,
  bootAt: 0,

  // 核心三件套
  data: WAR_DATA,
  schema: WAR_SCHEMA,
  audit: WAR_AUDIT,

  // 域（未实现的仍是 stub，见 §3）
  team: WAR_TEAM_STUB,
  econ:  warStub('econ',  '30_economy.js', '经济账本未实现；货币物品 war:credit 由 startup_scripts/war_items.js 注册'),
  spawn: warStub('spawn', '20_spawn.js',   '出生点未实现；计划复用 chunk_metrics（global.CM）打分'),
  claim: warStub('claim', '40_base.js',    '领地保护未实现'),
  base:  warStub('base',  '40_base.js',    '基地管理未实现'),
  trade: warStub('trade', '50_trade.js',   '玩家交易未实现'),
  shop:  warStub('shop',  '60_shop.js',    '商店未实现'),
  think: warStub('think', '70_think.js',   '思索/情报未实现'),

  // 框架
  commands: WAR_COMMANDS,
  hooks: WAR_HOOKS,
  every: warEvery,
  timers: warTimerList,             // C1：定时器只读清单（label/ticks/last）
  tick: warTick,
  boot: warBoot,
  shutdown: warShutdown,

  // 工具（域脚本可复用）
  reply: warReply,
  tell: warTell,
  run: warRun,
  uuidOf: warUuid,
  nameOf: warName,
  actorName: warActorName,          // 步骤 4a：域侧统一用它取「执行者名字」（无玩家 → 'console'）
  hasPermission: warHasPermission,
  opPredicate: warOpPredicate,
  intArg: warIntArg,
  clampInt: warClampInt,
  playerArg: warPlayerArg,
  fmtTime: warFmtTime,
  stubStatus: function () {
    return {
      team: WAR_TEAM_STUB.status(), econ: global.WAR.econ.status(), spawn: global.WAR.spawn.status(),
      claim: global.WAR.claim.status(), base: global.WAR.base.status(), trade: global.WAR.trade.status(),
      shop: global.WAR.shop.status(), think: global.WAR.think.status()
    };
  }
};

warLog('00_core.js 已加载 v' + WAR_CONFIG.version + '（等待 ServerEvents.loaded）');
