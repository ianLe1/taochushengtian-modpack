// priority: 900
// ============================================================================
//  面包军火库 × TACZ —— Create（机械动力）配方工程
//  作者：KubeJS 脚本（本包定制）
//
//  设计原则（"真实"）：
//   1. 材料走真实工业链：合金冶炼(create:mixing 加热) → 轧板(pressing) → 切削/冲压 → 热处理/抛光
//   2. 制造走真实工序：枪管先锻造毛坯→切削膛线→抛光；机匣锻造→切削→装配；
//      枪械用「机匣组(mechanical_crafting) + 总装线(sequenced_assembly)」两段式；
//      弹药用「弹壳(mechanical_crafting) + 装药装配」；全部按口径区分弹壳长度与装药量。
//   3. 成本按口径/型号分级：口径越大、TACZ 原工作台材料点越高 → 用料越多、总装循环越多。
//
//  文件分工：
//    00_data.js        数据表（自动生成）：口径表、54 枪参数、99 配件、118 MW 物品
//    05_helpers.js     本文件：配方构造工具
//    10_materials.js   合金、板材、弹簧、发射药、弹壳体、弹头、战斗部等基础件
//    20_ammo.js        TACZ 24 种弹药
//    30_guns.js        TACZ 54 把枪
//    40_attachments.js TACZ 99 个配件
//    50_mw.js          面包军火库(MW) 118 件装备
// ============================================================================

// ---------- 物品/输入 ----------
function MZ_in(id, count) { var o = { item: id }; if (count && count > 1) { o.count = count; } return o; }
function MZ_inTag(tag, count) { var o = { tag: tag }; if (count && count > 1) { o.count = count; } return o; }
function MZ_fluid(id, amount) { return { type: 'neoforge:single', amount: amount, fluid: id }; }

// ---------- 输出 ----------
function MZ_o(id, count) { var o = { id: id }; if (count && count > 1) { o.count = count; } return o; }
function MZ_scrap(id, chance) { return { id: id, chance: chance }; }
// TACZ 枪：数据存在 minecraft:custom_data 的 GunId（TimelessAPI 会按 GunId 自动解析显示/模型）
function MZ_gun(gunId) {
  return { id: 'tacz:modern_kinetic_gun', components: { 'minecraft:custom_data': { GunId: gunId } }, count: 1 };
}
function MZ_ammoOut(ammoId, count) {
  return { id: 'tacz:ammo', components: { 'minecraft:custom_data': { AmmoId: ammoId } }, count: count || 1 };
}
function MZ_attOut(attId) {
  return { id: 'tacz:attachment', components: { 'minecraft:custom_data': { AttachmentId: attId } }, count: 1 };
}

// ---------- 字符串重复（Rhino 兼容，不用 String.repeat）----------
function MZ_rep(ch, n) { var s = ''; for (var i = 0; i < n; i++) { s += ch; } return s; }
function MZ_ord(name) { // 由名字派生一个稳定序号（0..N）
  var h = 0;
  for (var i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) % 9973; }
  return h;
}

// ---------- Create 配方 ----------
// 注意：Create 的机械合成继承原版 ShapedRecipe —— 每一行必须等宽（原版校验
// "Invalid pattern: each row must be the same width"），所以这里统一右补空格成矩形。
function MZ_pad(s, w) { var r = s; while (r.length < w) { r += ' '; } return r; }
function MZ_rect(pattern) {
  var w = 0, i, out = [];
  for (i = 0; i < pattern.length; i++) { if (pattern[i].length > w) { w = pattern[i].length; } }
  for (i = 0; i < pattern.length; i++) { out.push(MZ_pad(pattern[i], w)); }
  return out;
}
// 机械合成器阵列越大越贵：图样统一限制在 6x6 以内（与本包既有配方规模一致），
// 超限时按行序把格子重排成 6 列。
function MZ_fit(pattern) {
  var i, j, w = 0, cells = '';
  // 行尾空格无意义（原版 ShapedRecipePattern 会 shrink 掉），先裁掉再判断尺寸
  for (i = 0; i < pattern.length; i++) {
    var row = pattern[i];
    while (row.length > 0 && row.charAt(row.length - 1) === ' ') { row = row.substring(0, row.length - 1); }
    pattern[i] = row;
    if (row.length > w) { w = row.length; }
  }
  if (pattern.length <= 6 && w <= 6) { return MZ_rect(pattern); }
  // 超过 6x6：只按顺序取有效格，重排成 6 列（零件种类与数量不变，只是排布更紧凑）
  for (i = 0; i < pattern.length; i++) {
    for (j = 0; j < pattern[i].length; j++) {
      if (pattern[i].charAt(j) !== ' ') { cells += pattern[i].charAt(j); }
    }
  }
  var out = [];
  for (i = 0; i < cells.length; i += 6) { out.push(cells.substring(i, i + 6)); }
  return MZ_rect(out);
}
function MZ_mc(event, id, pattern, key, result, mirrored) {
  event.custom({ type: 'create:mechanical_crafting', accept_mirrored: mirrored !== false, pattern: MZ_fit(pattern), key: key, result: result }).id(id);
}
// 机械合成：在基础图样后追加三行"型号用料行"，用**该族真实材料**轮换 + 用量差异来区分型号。
// （原先这三行是螺丝/锌粒/铜粒占位标记，导致同族配方在 EMI 里几乎长得一样，已废弃。）
var MZ_POOLS = {
  'tfmg:aluminum_sheet': ['tfmg:aluminum_sheet', 'create:iron_sheet', 'northstar:circuit', 'powergrid:capacitor'],
  'tfmg:heavy_plate': ['tfmg:heavy_plate', 'create:iron_sheet', 'create:copper_sheet', 'tfmg:screw'],
  'create:iron_sheet': ['create:iron_sheet', 'tfmg:heavy_plate', 'create:copper_sheet', 'tfmg:screw'],
  'create:zinc_nugget': ['create:zinc_nugget', 'create:copper_nugget', 'tfmg:screw', 'create:iron_sheet'],
  'tfmg:plastic_sheet': ['tfmg:plastic_sheet', 'tfmg:rubber_sheet', 'kubejs:polymer_furniture', 'tfmg:aluminum_sheet'],
  'tfmg:rubber_sheet': ['tfmg:rubber_sheet', 'tfmg:plastic_sheet', 'kubejs:polymer_furniture', 'tfmg:screw'],
  'tfmg:screw': ['tfmg:screw', 'create:iron_sheet', 'create:copper_sheet', 'tfmg:heavy_plate'],
  'tfmg:cast_iron_sheet': ['tfmg:cast_iron_sheet', 'tfmg:heavy_plate', 'create:iron_sheet', 'tfmg:screw'],
  'kubejs:gun_steel_sheet': ['kubejs:gun_steel_sheet', 'tfmg:cast_iron_sheet', 'create:iron_sheet', 'tfmg:heavy_plate'],
  'kubejs:ballistic_plate': ['kubejs:ballistic_plate', 'tfmg:heavy_plate', 'kubejs:composite_plate', 'tfmg:screw'],
  'kubejs:composite_plate': ['kubejs:composite_plate', 'chemica:carbon_fiber_composite_sheet', 'kubejs:ballistic_plate', 'tfmg:screw'],
  'northstar:circuit': ['northstar:circuit', 'powergrid:circuit_board', 'powergrid:capacitor', 'create:copper_sheet'],
  'tfmg:steel_ingot': ['tfmg:steel_ingot', 'kubejs:gun_steel_ingot', 'create:brass_ingot', 'tfmg:screw'],
  'tfmg:steel_pipe': ['tfmg:steel_pipe', 'create:fluid_pipe', 'tfmg:heavy_plate', 'tfmg:screw'],
  'kubejs:explosive_filler': ['kubejs:explosive_filler', 'minecraft:gunpowder', 'kubejs:tnt_filler', 'createbigcannons:packed_gunpowder'],
  'chemica:graphite_ingot': ['chemica:graphite_ingot', 'chemica:tungsten_carbide_ingot', 'northstar:advanced_circuit', 'powergrid:battery'],
  'kubejs:optic_tube': ['kubejs:optic_tube', 'kubejs:optic_lens', 'tfmg:aluminum_sheet', 'northstar:circuit'],
  'minecraft:white_wool': ['minecraft:white_wool', 'kubejs:gauze', 'minecraft:string', 'kubejs:antiseptic']
};
function MZ_pool(filler) {
  var p = MZ_POOLS[filler];
  return p ? p : [filler, 'create:iron_sheet', 'tfmg:screw', 'create:copper_sheet'];
}
function MZ_mcU(event, id, pattern, key, filler, ord, result) {
  var k = {}, p = [], i, pool = MZ_pool(filler), L = ['X', 'Y', 'Z'];
  for (var a in key) { k[a] = key[a]; }
  for (i = 0; i < pattern.length; i++) { p.push(pattern[i]); }
  for (i = 0; i < 3; i++) {
    k[L[i]] = MZ_in(pool[(ord + i) % pool.length]);
    p.push(MZ_rep(L[i], 1 + (Math.floor(ord / Math.pow(4, i)) % 4)));
  }
  MZ_mc(event, id, p, k, result, true);
}
function MZ_sa(event, id, ing, transitional, sequence, results, loops) {
  event.custom({
    type: 'create:sequenced_assembly',
    ingredient: ing,
    transitional_item: { id: transitional },
    sequence: sequence,
    results: results,
    loops: loops || 1
  }).id(id);
}
function MZ_step(type, ingredients, out) { return { type: type, ingredients: ingredients, results: [{ id: out }] }; }
function MZ_sDep(item, added, out) { return MZ_step('create:deploying', [MZ_in(item), added], out || item); }
function MZ_sPress(item, out) { return MZ_step('create:pressing', [MZ_in(item)], out || item); }
function MZ_sCut(item, out) { return MZ_step('create:cutting', [MZ_in(item)], out || item); }
// 磨削/光整工序：用 create_enchantment_industry 的「机械磨石(Mechanical Grindstone)」推进。
// 说明：create:sandpaper_polishing 只能做独立配方（可由鼓风机 + 磨砂催化剂 batch 自动化，
//   本包 create_connected 提供 fan_sanding_catalyst），但它**不能**作为序列组装的步骤——
//   Create 里会推进序列的机器只有 机械手(deploying)/压床(pressing)/动力锯(cutting)/注液口(filling)，
//   外加各模组自注册的序列工序类型（本包：机械磨石 = create_enchantment_industry:grinding）。
function MZ_sPolish(item, out) { return MZ_step('create_enchantment_industry:grinding', [MZ_in(item)], out || item); }
function MZ_sFill(item, fluid, amount, out) { return MZ_step('create:filling', [MZ_in(item), MZ_fluid(fluid, amount)], out || item); }

function MZ_mix(event, id, ingredients, results, heat) {
  var r = { type: 'create:mixing', ingredients: ingredients, results: results };
  if (heat === 'heated' || heat === 'superheated') { r.heat_requirement = heat; }
  event.custom(r).id(id);
}
function MZ_press(event, id, input, output, count) {
  event.custom({ type: 'create:pressing', ingredients: [input], results: [count ? MZ_o(output, count) : MZ_o(output)] }).id(id);
}
function MZ_cut(event, id, input, output, count, time) {
  event.custom({ type: 'create:cutting', ingredients: [input], results: [count ? MZ_o(output, count) : MZ_o(output)], processing_time: time || 50 }).id(id);
}
function MZ_crush(event, id, input, output, count, time) {
  event.custom({ type: 'create:crushing', ingredients: [input], results: [count ? MZ_o(output, count) : MZ_o(output)], processing_time: time || 150 }).id(id);
}
function MZ_compact(event, id, ingredients, results, heat) {
  var r = { type: 'create:compacting', ingredients: ingredients, results: results };
  if (heat === 'heated' || heat === 'superheated') { r.heat_requirement = heat; }
  event.custom(r).id(id);
}
function MZ_fill(event, id, item, fluid, amount, output, count) {
  event.custom({
    type: 'create:filling',
    ingredients: [item, MZ_fluid(fluid, amount)],
    results: [count ? MZ_o(output, count) : MZ_o(output)]
  }).id(id);
}
function MZ_deploy(event, id, a, b, output, count) {
  event.custom({
    type: 'create:deploying',
    ingredients: [a, b],
    results: [count ? MZ_o(output, count) : MZ_o(output)]
  }).id(id);
}
