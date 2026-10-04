// priority: 30
// ============================================================================
//  30_guns.js —— TACZ 54 把枪
//  两段式：机械合成「机匣组(kubejs:incomplete_<枪>)」→ 序列组装总装线 → 成品枪
//  现实依据：机匣组 = 机匣 + 枪机 + 击发机构 + 复进簧 + 弹匣 + 枪托/护木 + 导轨（按型号参数配齐），
//            总装线 = 装枪管（该枪实际口径对应的枪管族）→ 装紧固件 → 抛光入库。
//  成本随 TACZ 原枪械工作台材料点数分档（tier 1..5）：钢锭/钢板数、总装循环次数递增。
// ============================================================================
ServerEvents.recipes(event => {

  // 各类别的"特征件"（使同类同参数的型号也能区分，且符合现实：导气管/轻合金机匣/加重件）
  var extraOf = {
    rifle: 'tfmg:steel_pipe',        // 导气管
    smg: 'kubejs:aluminum_receiver', // 轻合金机匣
    sniper: 'tfmg:heavy_plate',      // 加重机匣
    mg: 'kubejs:ballistic_plate',    // 机枪加固板
    rpg: 'tfmg:steel_pipe',          // 发射筒
    pistol: '',
    shotgun: ''
  };
  var barrelOf = {
    pistol: 'kubejs:barrel_pistol', rifle: 'kubejs:barrel_rifle',
    heavy: 'kubejs:barrel_heavy', shotgun: 'kubejs:barrel_shotgun', tube: 'kubejs:launcher_tube'
  };

  for (var i = 0; i < MZ_GUNS.length; i++) {
    var g = MZ_GUNS[i], nm = g.name;
    var inc = 'kubejs:incomplete_' + nm;
    var key = {
      A: MZ_in('kubejs:gun_steel_ingot'),
      S: MZ_in('kubejs:gun_steel_sheet'),
      E: MZ_in('kubejs:receiver_machined'),
      B: MZ_in('kubejs:bolt_group'),
      T: MZ_in('kubejs:trigger_group'),
      P: MZ_in('kubejs:recoil_spring')
    };
    // 机匣组图样（6 行以内，贴合本包机械合成阵列规模）
    var pattern = [];
    pattern.push(MZ_rep('A', g.steel));                                   // 枪钢锭
    pattern.push(MZ_rep('S', g.sheet) + 'E');                             // 枪钢板 + 精加工机匣
    if (g.mag > 0) { key.M = MZ_in('kubejs:magazine_body'); }
    pattern.push('B' + 'T' + MZ_rep('M', g.mag));                         // 枪机 + 击发机构 + 弹匣
    if (g.stock > 0) { key.F = MZ_in(g.tier >= 4 ? 'kubejs:carbon_furniture' : 'kubejs:polymer_furniture'); }
    if (g.rail > 0) { key.R = MZ_in('kubejs:rail_mount'); }
    pattern.push(MZ_rep('F', g.stock) + MZ_rep('R', g.rail));             // 枪托/护木 + 导轨
    if (g.grip > 0) { key.G = MZ_in('tfmg:rubber_sheet'); }
    if (g.bipod > 0) { key.D = MZ_in('kubejs:bipod'); }
    pattern.push(MZ_rep('G', g.grip) + MZ_rep('D', g.bipod) + MZ_rep('P', g.spring)); // 握把 + 脚架 + 复进簧
    if (g.extra > 0 && extraOf[g.cls]) { key.X = MZ_in(extraOf[g.cls]); }
    pattern.push(MZ_rep('X', g.extra));                                   // 类别特征件
    MZ_mc(event, 'kubejs:gun/kit_' + nm, pattern, key, MZ_o(inc));

    // ---- 总装线 ----
    var seq = [];
    seq.push(MZ_sDep(inc, MZ_in(barrelOf[g.barrel]), inc));   // 装枪管
    if (g.cls === 'rpg' || g.cls === 'mg') {
      seq.push(MZ_sDep(inc, MZ_in('tfmg:heavy_plate'), inc));  // 加固
    } else {
      seq.push(MZ_sDep(inc, MZ_in('tfmg:screw'), inc));        // 紧固件
    }
    seq.push(MZ_sPolish(inc, inc));                            // 机械磨石光整入库
    var loops = 1;
    if (g.tier >= 5) { loops = 3; } else if (g.tier >= 3) { loops = 2; }
    MZ_sa(event, 'kubejs:gun/assemble_' + nm, MZ_in(inc), inc, seq, [
      MZ_gun(g.id),
      MZ_scrap('kubejs:gun_steel_sheet', 8.0),
      MZ_scrap('tfmg:screw', 5.0)
    ], loops);
  }
});
