// priority: 10
// ============================================================================
//  50_mw.js —— 面包军火库 (Mianbao's ModernWarfare) 118 件装备
//  该模组原本没有任何配方（jar 内只有一个覆盖原版的 data/minecraft/recipes），
//  这里按 17 个类别给出 Create 机械动力配方，全部走机械合成 + 火工品装配。
//  现实依据：
//    导弹/炸弹 = 金属弹体 + 高爆/成型装药 + 引信/制导组件 + 固体火箭发动机
//    炮塔/近防 = 精密构件 + 重装甲 + 目标跟踪电子 + 炮管
//    无人机    = 铝机架 + 电机 + 电池 + 光学吊舱（攻击型再加战斗部）
//    单兵装备  = 防弹板/复合板 + 滤毒罐 + 光学/电路
//  说明：MZ_mcU 会追加"工装行"保证同类别不同型号的配方互不冲突。
//  magicalstick / speedupstick 是模组的娱乐道具，不提供配方。
// ============================================================================
ServerEvents.recipes(event => {

  for (var i = 0; i < MZ_MW.length; i++) {
    var m = MZ_MW[i], nm = m.name, t = m.tier, ord = i, out = MZ_o(m.id);
    if (m.cat === 'special') { continue; }

    if (m.cat === 'missile') {
      var mrows = [MZ_rep('A', 2 + t), 'E', 'M'], mk = {
        A: MZ_in('tfmg:aluminum_sheet'), E: MZ_in('kubejs:warhead_medium'), M: MZ_in('kubejs:rocket_motor')
      };
      if (t >= 3) { mrows.push('G'); mk.G = MZ_in('kubejs:guidance_module'); }
      if (t >= 4) { mrows.push('K'); mk.K = MZ_in('kubejs:seeker_head'); }
      // 导引方式不同 → 加装不同的导引头/战斗部（现实区别，也让同族配方不再雷同）
      if (nm.indexOf('antiradiation') >= 0) { mrows.push('R'); mk.R = MZ_in('northstar:advanced_circuit'); }
      else if (nm.indexOf('optical') >= 0 || nm.indexOf('visual') >= 0) { mrows.push('O'); mk.O = MZ_in('create_optical:optical_device'); }
      else if (nm.indexOf('laser') >= 0) { mrows.push('L'); mk.L = MZ_in('create_optical:optical_sensor'); }
      else if (nm.indexOf('antitank') >= 0 || nm.indexOf('agmmissile') >= 0) { mrows.push('S'); mk.S = MZ_in('kubejs:shaped_charge'); }
      else if (nm.indexOf('cruise') >= 0 || nm.indexOf('groundmissile') >= 0 || nm.indexOf('ballistic') >= 0) { mrows.push('N'); mk.N = MZ_in('create:propeller'); }
      else { mrows.push('D'); mk.D = MZ_in('northstar:circuit'); }
      mrows.push('F'); mk.F = MZ_in('kubejs:fuze');
      MZ_mcU(event, 'kubejs:mw/' + nm, mrows, mk, 'tfmg:aluminum_sheet', ord, out);

    } else if (m.cat === 'nuke') {
      MZ_mcU(event, 'kubejs:mw/' + nm,
        ['WWW', 'GGG', 'FCF'],
        { W: MZ_in('kubejs:warhead_heavy'), G: MZ_in('kubejs:guidance_module'),
          C: MZ_in('create:precision_mechanism'), F: MZ_in('kubejs:fuze') },
        'chemica:graphite_ingot', ord, out);

    } else if (m.cat === 'bomb') {
      var brows = ['C', 'C', 'F'], bk = {
        C: MZ_in('kubejs:bomb_casing_filled'), F: MZ_in('kubejs:fuze')
      };
      var n = 1 + Math.floor(t / 2);
      for (var j = 0; j < n; j++) { brows.push('I'); }
      bk.I = MZ_in('create:iron_sheet');
      if (nm.indexOf('jdam') >= 0 || nm.indexOf('glide') >= 0 || nm.indexOf('earthpenetrator') >= 0) {
        brows.push('G'); bk.G = MZ_in('kubejs:guidance_module');
      }
      MZ_mcU(event, 'kubejs:mw/' + nm, brows, bk, 'create:iron_sheet', ord, out);

    } else if (m.cat === 'rocket_ammo') {
      var rrows = ['E', 'M'], rk = { E: MZ_in('kubejs:warhead_medium'), M: MZ_in('kubejs:rocket_motor') };
      if (nm.indexOf('laser') >= 0 || nm.indexOf('cluster') >= 0) { rrows.push('G'); rk.G = MZ_in('kubejs:guidance_module'); }
      if (nm.indexOf('fire') >= 0 || nm.indexOf('wp') >= 0) { rk.E = MZ_in('kubejs:explosive_filler'); }
      MZ_mcU(event, 'kubejs:mw/' + nm, rrows, rk, 'tfmg:steel_ingot', ord, out);

    } else if (m.cat === 'mortar') {
      if (nm.indexOf('gas') >= 0) {
        // 毒气型号：chemica:phenol 是流体，不能放进机械合成的物品格；
        // 改由注液口(create:filling)把 250 mB 苯酚灌进普通迫击炮弹 mortarammo → 毒气弹。
        // 250 mB 与 chemica 自身反应釜配方的苯酚用量一致；本型号不再有机械合成配方（避免同一产物两条配方）。
        MZ_fill(event, 'kubejs:mw/' + nm + '_fill', MZ_in('mianbaos_modernwarfare:mortarammo'), 'chemica:phenol', 250, m.id, 1);
        continue;
      }
      var krows = ['S', 'E', 'F'], kk = {
        S: MZ_in('create:iron_sheet'), E: MZ_in('kubejs:explosive_filler'), F: MZ_in('kubejs:fuze')
      };
      if (nm.indexOf('smoke') >= 0) { kk.E = MZ_in('tfmg:coal_coke_dust'); }
      if (nm.indexOf('fire') >= 0 || nm.indexOf('wp') >= 0) { kk.E = MZ_in('kubejs:explosive_filler'); }
      if (nm.indexOf('laser') >= 0) { krows.push('G'); kk.G = MZ_in('kubejs:guidance_module'); }
      MZ_mcU(event, 'kubejs:mw/' + nm, krows, kk, 'create:iron_sheet', ord, out);

    } else if (m.cat === 'grenade') {
      var grows = ['SS', 'EE', 'F'], gk = {
        S: MZ_in('create:iron_sheet'), E: MZ_in('kubejs:explosive_filler'), F: MZ_in('kubejs:fuze')
      };
      if (nm.indexOf('smoke') >= 0 || nm.indexOf('firesurpports') >= 0) { gk.E = MZ_in('tfmg:coal_coke_dust'); }
      if (nm.indexOf('cluster') >= 0 || nm.indexOf('wolves') >= 0) { grows = ['SSS', 'EEE', 'F']; }
      MZ_mcU(event, 'kubejs:mw/' + nm, grows, gk, 'create:iron_sheet', ord, out);

    } else if (m.cat === 'mine') {
      var irows = ['S', 'E', 'X'], ik = {
        S: MZ_in('tfmg:heavy_plate'), E: MZ_in('kubejs:explosive_filler'), X: MZ_in('kubejs:pressure_plate_kit')
      };
      if (nm.indexOf('anti') >= 0) { ik.X = MZ_in('kubejs:magnetic_sensor'); }
      // 注：00_data 当前无 cat:'mine' 物品 ⇒ 本分支是死代码，入游戏不会执行。
      // 苯酚是流体、机械合成只吃物品，故用其桶装物品形态 phenol_bucket 保持「毒气=苯酚」语义；
      // 将来若真的加入 mine 类物品，建议照 mortar 毒气型号改走灌注工序。
      if (nm.indexOf('gas') >= 0) { ik.E = MZ_in('chemica:phenol_bucket'); }
      if (nm.indexOf('fire') >= 0) { ik.E = MZ_in('kubejs:tnt_filler'); }
      MZ_mcU(event, 'kubejs:mw/' + nm, irows, ik, 'tfmg:heavy_plate', ord, out);

    } else if (m.cat === 'demolition') {
      if (nm.indexOf('cutter') >= 0) {
        MZ_mcU(event, 'kubejs:mw/' + nm, ['SS', 'S '],
          { S: MZ_in('kubejs:gun_steel_ingot') }, 'tfmg:screw', ord, out);
      } else if (nm.indexOf('detonater') >= 0 || nm.indexOf('tn_t') >= 0) {
        MZ_mcU(event, 'kubejs:mw/' + nm, ['CB', 'S '],
          { C: MZ_in('powergrid:circuit_board'), B: MZ_in('powergrid:battery'), S: MZ_in('tfmg:plastic_sheet') },
          'tfmg:screw', ord, out);
      } else {
        MZ_mcU(event, 'kubejs:mw/' + nm, ['EE', 'PP'],
          { E: MZ_in('kubejs:explosive_filler'), P: MZ_in('tfmg:plastic_sheet') },
          'kubejs:explosive_filler', ord, out);
      }

    } else if (m.cat === 'launcher') {
      var lrows = ['TT', 'T ', 'G'], lk = {
        T: MZ_in('tfmg:steel_pipe'), G: MZ_in('kubejs:trigger_group')
      };
      if (nm.indexOf('flame') >= 0) {
        lrows = ['TT', 'IF', 'G']; lk.I = MZ_in('kubejs:filter_canister'); lk.F = MZ_in('kubejs:fuze');
      } else {
        lrows.push('O'); lk.O = MZ_in('kubejs:optic_tube');
      }
      MZ_mcU(event, 'kubejs:mw/' + nm, lrows, lk, 'tfmg:steel_pipe', ord, out);

    } else if (m.cat === 'turret') {
      MZ_mcU(event, 'kubejs:mw/' + nm,
        [MZ_rep('H', 4), 'PP', 'BB', 'GG'],
        { H: MZ_in('tfmg:heavy_plate'), P: MZ_in('create:precision_mechanism'),
          B: MZ_in('kubejs:barrel_heavy'), G: MZ_in('kubejs:guidance_module') },
        'kubejs:ballistic_plate', ord, out);

    } else if (m.cat === 'drone') {
      var drows = ['FFF', 'MMM', 'B P'], dk = {
        F: MZ_in('kubejs:drone_frame'), M: MZ_in('kubejs:drone_motor'),
        B: MZ_in('powergrid:battery'), P: MZ_in('create_optical:optical_device')
      };
      if (nm.indexOf('drone') >= 0 && (nm.indexOf('fire') >= 0 || nm.indexOf('smasher') >= 0 || nm.indexOf('explode') >= 0)) {
        drows.push('W'); dk.W = MZ_in('kubejs:warhead_small');
      }
      if (nm.indexOf('uavcall') >= 0 || nm.indexOf('ucavitem') >= 0 || nm.indexOf('gundefendercar') >= 0) {
        drows.push('C'); dk.C = MZ_in('northstar:advanced_circuit');
      }
      MZ_mcU(event, 'kubejs:mw/' + nm, drows, dk, 'tfmg:aluminum_sheet', ord, out);

    } else if (m.cat === 'medical') {
      MZ_mcU(event, 'kubejs:mw/' + nm,
        ['GAG', 'SSS'],
        { G: MZ_in('kubejs:gauze'), A: MZ_in('kubejs:antiseptic'), S: MZ_in('kubejs:splint') },
        'minecraft:white_wool', ord, out);

    } else if (m.cat === 'caller') {
      MZ_mcU(event, 'kubejs:mw/' + nm,
        ['CB', 'CS'],
        { C: MZ_in('northstar:circuit'), B: MZ_in('powergrid:battery'), S: MZ_in('tfmg:plastic_sheet') },
        'northstar:circuit', ord, out);

    } else if (m.cat === 'torpedo') {
      MZ_mcU(event, 'kubejs:mw/' + nm,
        ['SSS', 'EEE', 'RGG', 'FFF'],
        { S: MZ_in('tfmg:steel_ingot'), E: MZ_in('kubejs:warhead_heavy'),
          R: MZ_in('kubejs:rocket_motor'), G: MZ_in('kubejs:guidance_module'), F: MZ_in('kubejs:fuze') },
        'tfmg:steel_ingot', ord, out);

    } else if (m.cat === 'mw_ammo') {
      var arows = ['E', 'M'], ak = { E: MZ_in('kubejs:warhead_small'), M: MZ_in('kubejs:rocket_motor') };
      if (nm.indexOf('countermeasure') >= 0) { ak.E = MZ_in('tfmg:coal_coke_dust'); }
      if (nm.indexOf('smoke') >= 0) { ak.E = MZ_in('tfmg:coal_coke_dust'); }
      if (nm.indexOf('aps') >= 0) { arows = ['W', 'C']; ak.W = MZ_in('kubejs:warhead_small'); ak.C = MZ_in('kubejs:gun_steel_sheet'); }
      MZ_mcU(event, 'kubejs:mw/' + nm, arows, ak, 'create:iron_sheet', ord, out);

    } else {
      // gear / device：夜视仪、防毒面具、终端、坐标设置器等
      if (nm.indexOf('nightvision') >= 0) {
        MZ_mcU(event, 'kubejs:mw/' + nm, ['PBP', 'NNN'],
          { P: MZ_in('kubejs:ballistic_plate'), B: MZ_in('powergrid:battery'), N: MZ_in('kubejs:nv_tube') },
          'kubejs:ballistic_plate', ord, out);
      } else if (nm.indexOf('gasmask') >= 0) {
        MZ_mcU(event, 'kubejs:mw/' + nm, ['SSS', 'FFF'],
          { S: MZ_in('tfmg:rubber_sheet'), F: MZ_in('kubejs:filter_canister') },
          'tfmg:rubber_sheet', ord, out);
      } else if (nm.indexOf('pilothelmet') >= 0) {
        MZ_mcU(event, 'kubejs:mw/' + nm, ['CCC', 'GGG'],
          { C: MZ_in('kubejs:composite_plate'), G: MZ_in('minecraft:glass') },
          'kubejs:composite_plate', ord, out);
      } else if (nm.indexOf('flamelauncherpack') >= 0) {
        MZ_mcU(event, 'kubejs:mw/' + nm, ['HHH', 'PPP'],
          { H: MZ_in('kubejs:ballistic_plate'), P: MZ_in('tfmg:steel_pipe') },
          'kubejs:ballistic_plate', ord, out);
      } else if (nm.indexOf('dianzuan') >= 0) {
        MZ_mcU(event, 'kubejs:mw/' + nm, ['CB', 'S '],
          { C: MZ_in('create:precision_mechanism'), B: MZ_in('powergrid:battery'), S: MZ_in('create:iron_sheet') },
          'tfmg:screw', ord, out);
      } else if (nm.indexOf('hatchkey') >= 0) {
        MZ_mcU(event, 'kubejs:mw/' + nm, ['SS', 'S '],
          { S: MZ_in('kubejs:gun_steel_ingot') }, 'tfmg:screw', ord, out);
      } else {
        // 电子设备：坐标设置器 / 频道设置器 / 终端 / 雷达控制器 / 指示器 / 遥控器
        MZ_mcU(event, 'kubejs:mw/' + nm,
          ['CBC', 'ADA', 'SSS'],
          { C: MZ_in('powergrid:circuit_board'), B: MZ_in('powergrid:battery'),
            A: MZ_in('northstar:advanced_circuit'), D: MZ_in('create_optical:optical_device'),
            S: MZ_in('tfmg:plastic_sheet') },
          'northstar:circuit', ord, out);
      }
    }
  }
});
