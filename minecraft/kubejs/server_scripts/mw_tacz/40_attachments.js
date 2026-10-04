// priority: 20
// ============================================================================
//  40_attachments.js —— TACZ 99 个配件
//  工艺：全部走机械合成（配件本质是精密小件装配），按类别使用不同材料：
//    瞄具/镜      光学镜片 + 铝镜筒 + 电路（高倍带电池）
//    枪口         消音器(挡板+钢管) / 制退器(钢板) / 缩喉 / 刺刀 / 长枪管
//    弹匣         弹匣壳 + 复进簧 + 钢板（按容量分级）
//    枪托         聚合物 / 碳纤维 / 铝合金
//    握把         橡胶 + 聚合物
//    激光         光学器件 + 电池 + 电路 + 铝壳
//  说明：同类配件用料随档位递增；MZ_mcU 会追加"工装行"以保证每个配件配方唯一。
// ============================================================================
ServerEvents.recipes(event => {

  var i, a, nm, ord;

  for (i = 0; i < MZ_ATTS.length; i++) {
    a = MZ_ATTS[i]; nm = a.name; ord = i;
    var out = MZ_attOut(a.id);

    if (a.cls === 'scope') {
      // 光学瞄具：按型号真实结构区分 —— 倍率决定镜片数，管式/棱镜结构决定镜筒与反射镜，
      // 供电决定电路与电池，壳体在铝/铸铁/钢之间按型号取一（不再靠占位标记凑唯一性）
      var micro = (nm.indexOf('rmr') >= 0 || nm.indexOf('sro') >= 0 || nm.indexOf('deltapoint') >= 0 || nm.indexOf('acro') >= 0);
      var mag = 2;
      if (nm.indexOf('_8x') >= 0 || nm.indexOf('mk5hd') >= 0 || nm.indexOf('vudu') >= 0) { mag = 4; }
      else if (nm.indexOf('_6x') >= 0 || nm.indexOf('lpvo') >= 0 || nm.indexOf('qmk152') >= 0) { mag = 3; }
      else if (nm.indexOf('_4x') >= 0 || nm.indexOf('acog') >= 0 || nm.indexOf('elcan') >= 0 || nm.indexOf('hamr') >= 0) { mag = 3; }
      else if (nm.indexOf('_2x') >= 0 || nm.indexOf('retro') >= 0 || nm.indexOf('contender') >= 0 || nm.indexOf('98k') >= 0) { mag = 2; }
      // 壳体（铝/铸铁/铁/枪钢/钛）与安装方式（导轨夹/螺钉/铜垫）也按型号不同
      var housList = ['tfmg:aluminum_sheet', 'tfmg:cast_iron_sheet', 'create:iron_sheet', 'kubejs:gun_steel_sheet', 'northstar:titanium_ingot'];
      var mountList = ['kubejs:rail_mount', 'tfmg:screw', 'create:copper_sheet'];
      var rows = [], key = {};
      key.L = MZ_in('kubejs:optic_lens');
      var isScope = (nm.indexOf('scope_') === 0);
      rows.push(MZ_rep('L', (micro || !isScope) ? 1 : mag));
      if (nm.indexOf('aug_default') >= 0 || nm.indexOf('p90') >= 0 || micro) {
        // 微型红点/机瞄：一片镜片 + 铝壳，无镜筒
        rows.push('A'); key.A = MZ_in('tfmg:aluminum_sheet');
      } else if (nm.indexOf('sight_') === 0) {
        // 红点/全息：单镜筒 + 电路（无棱镜），与倍镜结构不同
        rows.push('T'); key.T = MZ_in('kubejs:optic_tube');
        rows.push('C'); key.C = MZ_in('northstar:circuit');
        if (nm.indexOf('uh1') >= 0 || nm.indexOf('exp3') >= 0) {
          rows.push('P'); key.P = MZ_in('create_optical:polarizing_filter');   // 全息光栅
        } else if (nm.indexOf('srs_02') >= 0) {
          rows.push('L');                                                        // 大口径红点多一片镜片
        }
      } else {
        // 倍镜：双镜筒 + 棱镜/反射镜 + 电路（高档加电源）
        rows.push('T'); rows.push('T'); key.T = MZ_in('kubejs:optic_tube');
        rows.push('M'); key.M = MZ_in('create_optical:mirror');
        rows.push('C'); key.C = MZ_in('northstar:circuit');
        if (a.tier >= 3) { rows.push('B'); key.B = MZ_in('powergrid:battery'); }
      }
      key.H = MZ_in(housList[ord % housList.length]); rows.push('H');
      key.R = MZ_in(mountList[ord % mountList.length]); rows.push('R');
      MZ_mc(event, 'kubejs:att/' + nm, rows, key, out);

    } else if (a.cls === 'muzzle') {
      if (nm.indexOf('silencer') >= 0) {
        MZ_mcU(event, 'kubejs:att/' + nm,
          [MZ_rep('B', a.tier + 1), 'P'],
          { B: MZ_in('kubejs:suppressor_baffle'), P: MZ_in('tfmg:steel_pipe') },
          'tfmg:heavy_plate', ord, out);
      } else if (nm.indexOf('brake') >= 0 || nm.indexOf('compensator') >= 0) {
        MZ_mcU(event, 'kubejs:att/' + nm,
          [MZ_rep('S', a.tier), 'C'],
          { S: MZ_in('kubejs:gun_steel_sheet'), C: MZ_in('create:copper_sheet') },
          'tfmg:screw', ord, out);
      } else if (nm.indexOf('choke') >= 0) {
        MZ_mcU(event, 'kubejs:att/' + nm, ['S', 'I'],
          { S: MZ_in('kubejs:gun_steel_sheet'), I: MZ_in('kubejs:gun_steel_ingot') },
          'tfmg:screw', ord, out);
      } else if (nm.indexOf('bayonet') >= 0) {
        MZ_mcU(event, 'kubejs:att/' + nm, ['II', 'S '],
          { I: MZ_in('kubejs:gun_steel_ingot'), S: MZ_in('kubejs:gun_steel_sheet') },
          'tfmg:screw', ord, out);
      } else {
        // 长枪管（金色沙鹰）
        MZ_mcU(event, 'kubejs:att/' + nm, ['R', 'G'],
          { R: MZ_in('kubejs:rifled_barrel'), G: MZ_in('minecraft:gold_ingot') },
          'tfmg:screw', ord, out);
      }

    } else if (a.cls === 'extended_mag') {
      if (nm.indexOf('ammo_mod') >= 0) {
        // 弹种改装：换弹芯/被甲
        var mk = {}, mrows;
        if (nm.indexOf('he') >= 0) { mrows = ['C', 'E', 'S']; mk.C = MZ_in('create:copper_sheet'); mk.E = MZ_in('kubejs:explosive_filler'); mk.S = MZ_in('kubejs:gun_steel_sheet'); }
        else if (nm.indexOf('hp') >= 0) { mrows = ['L', 'L']; mk.L = MZ_in('kubejs:lead_core'); }
        else if (nm.indexOf('slug') >= 0) { mrows = ['L', 'S']; mk.L = MZ_in('kubejs:lead_core'); mk.S = MZ_in('kubejs:gun_steel_sheet'); }
        else if (nm.indexOf('_i') >= 0) { mrows = ['C', 'I']; mk.C = MZ_in('create:copper_sheet'); mk.I = MZ_in('tfmg:coal_coke_dust'); }
        else { mrows = ['C', 'L']; mk.C = MZ_in('create:copper_sheet'); mk.L = MZ_in('kubejs:lead_core'); }
        MZ_mc(event, 'kubejs:att/' + nm, mrows, mk, out);
      } else {
        // 扩容量弹匣：按族换材料（标准钢匣 / 轻量铝匣 / 霰弹铸铁 / 狙击加重），尺寸由名字里的 1/2/3 决定用量
        var sz = (nm.indexOf('_3') >= 0) ? 3 : ((nm.indexOf('_2') >= 0) ? 2 : 1);
        if (nm.indexOf('light_') >= 0) {
          MZ_mc(event, 'kubejs:att/' + nm, [MZ_rep('M', sz), 'P', 'A'],
            { M: MZ_in('kubejs:magazine_body'), P: MZ_in('kubejs:recoil_spring'), A: MZ_in('tfmg:aluminum_ingot') }, out);
        } else if (nm.indexOf('shotgun_') >= 0) {
          MZ_mc(event, 'kubejs:att/' + nm, [MZ_rep('M', sz), 'P', 'C'],
            { M: MZ_in('kubejs:magazine_body'), P: MZ_in('kubejs:recoil_spring'), C: MZ_in('tfmg:cast_iron_sheet') }, out);
        } else if (nm.indexOf('sniper_') >= 0) {
          MZ_mc(event, 'kubejs:att/' + nm, [MZ_rep('M', sz), 'P', 'H'],
            { M: MZ_in('kubejs:magazine_body'), P: MZ_in('kubejs:recoil_spring'), H: MZ_in('tfmg:heavy_plate') }, out);
        } else {
          MZ_mc(event, 'kubejs:att/' + nm, [MZ_rep('M', sz), 'P', MZ_rep('S', sz)],
            { M: MZ_in('kubejs:magazine_body'), P: MZ_in('kubejs:recoil_spring'), S: MZ_in('kubejs:gun_steel_sheet') }, out);
        }
      }

    } else if (a.cls === 'stock') {
      // 枪托：按型号用不同材料（聚合物 / 碳纤维 / 铝 / 钢 / 铸铁），不再靠占位标记区分
      var sk = {}, sr = [];
      if (nm.indexOf('carbon') >= 0) { sr = ['F', 'E']; sk.F = MZ_in('kubejs:carbon_furniture'); sk.E = MZ_in('chemica:cured_epoxy_sheet'); }
      else if (nm.indexOf('heavy_spas') >= 0) { sr = ['CC', 'F']; sk.C = MZ_in('tfmg:cast_iron_sheet'); sk.F = MZ_in('kubejs:polymer_furniture'); }
      else if (nm.indexOf('tactical_spas') >= 0) { sr = ['C', 'F', 'X']; sk.C = MZ_in('tfmg:cast_iron_sheet'); sk.F = MZ_in('kubejs:polymer_furniture'); sk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('ak12') >= 0) { sr = ['FF', 'S', 'X']; sk.F = MZ_in('kubejs:polymer_furniture'); sk.S = MZ_in('tfmg:steel_ingot'); sk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('ripstock') >= 0) { sr = ['S', 'F', 'X']; sk.S = MZ_in('tfmg:steel_ingot'); sk.F = MZ_in('kubejs:polymer_furniture'); sk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('militech') >= 0) { sr = ['AA', 'F']; sk.A = MZ_in('tfmg:aluminum_ingot'); sk.F = MZ_in('kubejs:polymer_furniture'); }
      else if (nm.indexOf('m4ss') >= 0) { sr = ['FF', 'S']; sk.F = MZ_in('kubejs:polymer_furniture'); sk.S = MZ_in('tfmg:steel_ingot'); }
      else if (nm.indexOf('sba3') >= 0) { sr = ['F', 'A', 'G']; sk.F = MZ_in('kubejs:polymer_furniture'); sk.A = MZ_in('tfmg:aluminum_ingot'); sk.G = MZ_in('tfmg:rubber_sheet'); }
      else if (nm.indexOf('slim_line') >= 0) { sr = ['F', 'A', 'X']; sk.F = MZ_in('kubejs:polymer_furniture'); sk.A = MZ_in('tfmg:aluminum_ingot'); sk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('moe') >= 0) { sr = ['FF', 'G']; sk.F = MZ_in('kubejs:polymer_furniture'); sk.G = MZ_in('tfmg:rubber_sheet'); }
      else if (nm.indexOf('tactical_ar') >= 0) { sr = ['FF', 'A']; sk.F = MZ_in('kubejs:polymer_furniture'); sk.A = MZ_in('tfmg:aluminum_ingot'); }
      else if (nm.indexOf('oem_stock_heavy') >= 0) { sr = ['FFF', 'H']; sk.F = MZ_in('kubejs:polymer_furniture'); sk.H = MZ_in('tfmg:heavy_plate'); }
      else if (nm.indexOf('oem_stock_tactical') >= 0) { sr = ['FF', 'A', 'X']; sk.F = MZ_in('kubejs:polymer_furniture'); sk.A = MZ_in('tfmg:aluminum_ingot'); sk.X = MZ_in('tfmg:screw'); }
      else { sr = ['F', 'A']; sk.F = MZ_in('kubejs:polymer_furniture'); sk.A = MZ_in('tfmg:aluminum_ingot'); }
      MZ_mc(event, 'kubejs:att/' + nm, sr, sk, out);

    } else if (a.cls === 'grip') {
      // 握把：橡胶 / 聚合物 / 铝 / 铸铁 / 钢 / 碳纤维，按型号区分
      var gk = {}, gr = [];
      if (nm.indexOf('cobra') >= 0) { gr = ['GG', 'F']; gk.G = MZ_in('tfmg:rubber_sheet'); gk.F = MZ_in('tfmg:plastic_sheet'); }
      else if (nm.indexOf('cqr') >= 0) { gr = ['FF', 'A']; gk.F = MZ_in('tfmg:plastic_sheet'); gk.A = MZ_in('tfmg:aluminum_ingot'); }
      else if (nm.indexOf('osovets') >= 0) { gr = ['F', 'G', 'X']; gk.F = MZ_in('tfmg:plastic_sheet'); gk.G = MZ_in('tfmg:rubber_sheet'); gk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('rk0') >= 0) { gr = ['C', 'F', 'X']; gk.C = MZ_in('tfmg:cast_iron_sheet'); gk.F = MZ_in('tfmg:plastic_sheet'); gk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('rk1') >= 0) { gr = ['C', 'G', 'X']; gk.C = MZ_in('tfmg:cast_iron_sheet'); gk.G = MZ_in('tfmg:rubber_sheet'); gk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('rk6') >= 0) { gr = ['S', 'F', 'X']; gk.S = MZ_in('tfmg:steel_ingot'); gk.F = MZ_in('tfmg:plastic_sheet'); gk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('se_5') >= 0) { gr = ['B', 'F', 'X']; gk.B = MZ_in('chemica:carbon_fiber_composite_sheet'); gk.F = MZ_in('tfmg:plastic_sheet'); gk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('afg') >= 0) { gr = ['F', 'A', 'X']; gk.F = MZ_in('tfmg:plastic_sheet'); gk.A = MZ_in('tfmg:aluminum_ingot'); gk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('grip_td') >= 0) { gr = ['AA', 'S']; gk.A = MZ_in('tfmg:aluminum_ingot'); gk.S = MZ_in('kubejs:gun_steel_sheet'); }
      else if (nm.indexOf('vertical_military') >= 0) { gr = ['S', 'G', 'X']; gk.S = MZ_in('kubejs:gun_steel_sheet'); gk.G = MZ_in('tfmg:rubber_sheet'); gk.X = MZ_in('tfmg:screw'); }
      else if (nm.indexOf('ranger') >= 0) { gr = ['F', 'G', 'A']; gk.F = MZ_in('tfmg:plastic_sheet'); gk.G = MZ_in('tfmg:rubber_sheet'); gk.A = MZ_in('tfmg:aluminum_ingot'); }
      else { gr = ['F', 'G', 'S']; gk.F = MZ_in('tfmg:plastic_sheet'); gk.G = MZ_in('tfmg:rubber_sheet'); gk.S = MZ_in('kubejs:gun_steel_sheet'); }
      MZ_mc(event, 'kubejs:att/' + nm, gr, gk, out);

    } else {
      // 激光指示器/激光盒：按型号给不同配置（紧凑 / 常规 / 夜战 / 高级 + 加固）
      if (nm.indexOf('compact') >= 0) {
        MZ_mc(event, 'kubejs:att/' + nm, ['O', 'B', 'A'],
          { O: MZ_in('create_optical:optical_device'), B: MZ_in('powergrid:battery'), A: MZ_in('tfmg:aluminum_sheet') }, out);
      } else if (nm.indexOf('lopro') >= 0) {
        MZ_mc(event, 'kubejs:att/' + nm, ['O', 'B', 'C', 'A'],
          { O: MZ_in('create_optical:optical_device'), B: MZ_in('powergrid:battery'), C: MZ_in('northstar:circuit'), A: MZ_in('tfmg:aluminum_sheet') }, out);
      } else if (nm.indexOf('nightstick') >= 0) {
        MZ_mc(event, 'kubejs:att/' + nm, ['O', 'B', 'C', 'G'],
          { O: MZ_in('create_optical:optical_device'), B: MZ_in('powergrid:battery'), C: MZ_in('northstar:circuit'), G: MZ_in('tfmg:rubber_sheet') }, out);
      } else if (nm.indexOf('peq6') >= 0) {
        MZ_mc(event, 'kubejs:att/' + nm, ['O', 'B', 'D', 'H'],
          { O: MZ_in('create_optical:optical_device'), B: MZ_in('powergrid:battery'), D: MZ_in('northstar:advanced_circuit'), H: MZ_in('tfmg:heavy_plate') }, out);
      } else {
        MZ_mc(event, 'kubejs:att/' + nm, ['O', 'B', 'D', 'A'],
          { O: MZ_in('create_optical:optical_device'), B: MZ_in('powergrid:battery'), D: MZ_in('northstar:advanced_circuit'), A: MZ_in('tfmg:aluminum_sheet') }, out);
      }
    }
  }
});
