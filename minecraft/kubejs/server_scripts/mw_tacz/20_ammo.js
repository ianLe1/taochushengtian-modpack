// priority: 40
// ============================================================================
//  20_ammo.js —— TACZ 24 种弹药
//  工艺链（每步都是真实工序）：
//    铜/钢杯（冲压）→ 弹壳（按口径长度叠杯 + 底火 + 壳底黄铜/铸铁余料）
//    → 装药装配（batch 个弹壳 + batch 份发射药 + batch 个弹头 → batch 发成品弹）
//  现实依据：9mm 黄铜短壳小底火；7.62x39/5.45x39 苏系涂漆钢壳；12 号霰弹塑料壳+黄铜壳头+大底火；
//            .45-70 用黑火药；40mm 榴弹钢壳；RPG 火箭弹为成型装药战斗部 + 固体火箭发动机。
//  唯一性：弹壳按 (壳材, 铜杯数, 底火型号) 分组，组内用"壳底余料"数量区分。
// ============================================================================
ServerEvents.recipes(event => {

  var names = Object.keys(MZ_CAL);
  var groups = {}, gi;
  for (gi = 0; gi < names.length; gi++) {
    var cc = MZ_CAL[names[gi]];
    if (cc.case === 'none') { continue; }
    var gk = cc.case + '|' + cc.cups + '|' + cc.primer;
    if (!groups[gk]) { groups[gk] = []; }
    groups[gk].push(names[gi]);
  }

  // 弹壳图样：cups 个铜/钢杯 + 壳底余料 + 底火 → 1 发弹壳
  function casePattern(cups, idx) {
    var p = [];
    var r1 = 1 + (idx % (cups > 1 ? cups : 1));
    var r2 = cups - r1;
    if (r2 > 0) { p.push(MZ_rep('C', r1)); p.push(MZ_rep('C', r2)); } else { p.push(MZ_rep('C', cups)); }
    p.push(MZ_rep('N', 1 + idx));
    p.push('P');
    return p;
  }
  // 把 n 个同种零件排成每行最多 6 格（batch 上限 12 → 每种零件 2 行，共 6 行）
  function fill(rows, ch, n) {
    var left = n;
    while (left > 0) { var k = (left > 6) ? 6 : left; rows.push(MZ_rep(ch, k)); left -= k; }
    return rows;
  }

  for (var i = 0; i < names.length; i++) {
    var nm = names[i], c = MZ_CAL[nm];
    var primer = 'kubejs:primer_' + c.primer;
    var powder = (c.cls === 'black_powder') ? 'kubejs:black_powder' : 'kubejs:smokeless_powder';
    var batch = (c.batch > 12) ? 12 : c.batch;

    // ---- 1. 弹壳：1 发 ----
    if (c.case !== 'none') {
      var gk2 = c.case + '|' + c.cups + '|' + c.primer;
      var idx = groups[gk2].indexOf(nm);
      if (c.case === 'hull') {
        MZ_mc(event, 'kubejs:ammo/case_' + nm, ['H', 'P'],
          { H: MZ_in('kubejs:shot_hull'), P: MZ_in(primer) }, MZ_o('kubejs:case_' + nm, 1));
      } else {
        var cup = (c.case === 'steel') ? 'kubejs:steel_cup_bright' : 'kubejs:brass_cup_bright';
        var nug = (c.case === 'steel') ? 'tfmg:cast_iron_nugget' : 'create:brass_nugget';
        MZ_mc(event, 'kubejs:ammo/case_' + nm, casePattern(c.cups, idx),
          { C: MZ_in(cup), N: MZ_in(nug), P: MZ_in(primer) }, MZ_o('kubejs:case_' + nm, 1));
      }
    }

    // ---- 2. 成品弹 ----
    if (nm === 'rpg_rocket') {
      MZ_mc(event, 'kubejs:ammo/round_' + nm, ['W', 'M'],
        { W: MZ_in('kubejs:shaped_charge'), M: MZ_in('kubejs:rocket_motor') },
        MZ_ammoOut(c.ammo, 1));
      continue;
    }
    var rows = [];
    fill(rows, 'C', batch);                       // 弹壳
    fill(rows, 'W', (nm === '40mm') ? batch : batch);  // 发射药（40mm 也自带抛射药）
    fill(rows, 'J', batch);                       // 弹头
    var key = {
      C: MZ_in('kubejs:case_' + nm), W: MZ_in(powder),
      J: MZ_in('kubejs:' + (nm === '40mm' ? 'proj_grenade40' : 'proj_' + c.proj))
    };
    MZ_mc(event, 'kubejs:ammo/round_' + nm, rows, key, MZ_ammoOut(c.ammo, batch));
  }
});
