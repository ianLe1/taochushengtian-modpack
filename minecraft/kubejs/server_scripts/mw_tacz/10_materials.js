// priority: 50
// ============================================================================
//  10_materials.js —— 基础材料链（合金 / 板材 / 弹簧 / 发射药 / 弹壳体 / 弹头 / 战斗部）
//  现实依据：枪管与枪机用铬镍合金钢，弹簧用弹簧钢，弹壳用黄铜或涂漆钢，
//            底火用击发药（斯蒂芬酸铅系，此处以铅+火药近似），发射药为双基（硝化甘油+火药）。
// ============================================================================
ServerEvents.recipes(event => {

  // ---------- 一、枪钢（Cr-Ni 合金钢）：枪管 / 机匣 / 枪机 ----------
  // 现实：枪管钢约 0.3%C-1%Cr-0.5%Ni 调质钢，需在合金炉中高温熔炼
  MZ_mix(event, 'kubejs:mat/gun_steel', [
      MZ_in('tfmg:steel_ingot', 2), MZ_in('chemica:chromium_nugget', 2),
      MZ_in('chemica:nickel_dust', 1), MZ_in('tfmg:coal_coke_dust', 1)
    ], [MZ_o('kubejs:gun_steel_ingot', 2)], 'superheated');
  MZ_press(event, 'kubejs:mat/gun_steel_sheet', MZ_in('kubejs:gun_steel_ingot'), 'kubejs:gun_steel_sheet');

  // ---------- 二、弹簧钢（Si-Mn 弹簧钢）与复进簧 ----------
  MZ_mix(event, 'kubejs:mat/spring_steel', [
      MZ_in('tfmg:steel_ingot', 1), MZ_in('chemica:chromium_nugget', 1), MZ_in('tfmg:coal_coke_dust', 1)
    ], [MZ_o('kubejs:spring_steel_ingot', 1)], 'heated');
  MZ_press(event, 'kubejs:mat/spring_steel_sheet', MZ_in('kubejs:spring_steel_ingot'), 'kubejs:spring_steel_sheet');
  // 拉丝：一块弹簧钢板切 2 根钢线
  MZ_cut(event, 'kubejs:mat/spring_wire', MZ_in('kubejs:spring_steel_sheet'), 'kubejs:spring_wire', 2, 80);
  // 绕簧
  MZ_mc(event, 'kubejs:mat/recoil_spring', ['W', 'W', 'W'],
    { W: MZ_in('kubejs:spring_wire') }, MZ_o('kubejs:recoil_spring'));

  // ---------- 三、枪机 / 击针 / 击发机构 / 弹匣 / 导轨 / 脚架 ----------
  MZ_cut(event, 'kubejs:mat/firing_pin', MZ_in('kubejs:gun_steel_sheet'), 'kubejs:firing_pin', 4, 60);
  MZ_mc(event, 'kubejs:mat/bolt_group', ['S', 'B', 'P'],
    { S: MZ_in('kubejs:gun_steel_sheet'), B: MZ_in('kubejs:gun_steel_ingot'), P: MZ_in('kubejs:firing_pin') },
    MZ_o('kubejs:bolt_group'));
  MZ_mc(event, 'kubejs:mat/trigger_group', ['SS', 'TP'],
    { S: MZ_in('kubejs:gun_steel_sheet'), T: MZ_in('kubejs:recoil_spring'), P: MZ_in('kubejs:gun_steel_ingot') },
    MZ_o('kubejs:trigger_group'));
  MZ_mc(event, 'kubejs:mat/magazine_body', ['SS', 'SS'],
    { S: MZ_in('kubejs:gun_steel_sheet') }, MZ_o('kubejs:magazine_body', 2));
  MZ_cut(event, 'kubejs:mat/rail_mount', MZ_in('kubejs:gun_steel_sheet'), 'kubejs:rail_mount', 2, 80);
  MZ_mc(event, 'kubejs:mat/bipod', ['S', 'S', 'W'],
    { S: MZ_in('kubejs:gun_steel_sheet'), W: MZ_in('kubejs:spring_wire') }, MZ_o('kubejs:bipod'));

  // ---------- 四、枪身材料：聚合物 / 碳纤维 / 铝合金 ----------
  MZ_compact(event, 'kubejs:mat/polymer_furniture', [
      MZ_in('tfmg:plastic_sheet', 3), MZ_in('tfmg:rubber_sheet', 1)
    ], [MZ_o('kubejs:polymer_furniture', 2)], 'heated');
  MZ_compact(event, 'kubejs:mat/carbon_furniture', [
      MZ_in('chemica:carbon_fiber_composite_sheet', 2), MZ_in('chemica:cured_epoxy_sheet', 1)
    ], [MZ_o('kubejs:carbon_furniture', 1)], 'heated');
  MZ_compact(event, 'kubejs:mat/aluminum_receiver', [
      MZ_in('tfmg:aluminum_ingot', 2), MZ_in('create:zinc_ingot', 1)
    ], [MZ_o('kubejs:aluminum_receiver', 2)], 'heated');

  // ---------- 五、机匣：锻造 → 切削加工（序列组装）----------
  MZ_mc(event, 'kubejs:mat/receiver_forging', ['AA', 'AA', 'SS'],
    { A: MZ_in('kubejs:gun_steel_ingot'), S: MZ_in('kubejs:gun_steel_sheet') },
    MZ_o('kubejs:receiver_forging'));
  MZ_sa(event, 'kubejs:mat/receiver_machined', MZ_in('kubejs:receiver_forging'), 'kubejs:incomplete_receiver', [
      MZ_sCut('kubejs:incomplete_receiver'),                                    // 铣削机匣内腔
      MZ_sPolish('kubejs:incomplete_receiver'),                                 // 机械磨石磨平面
      MZ_sDep('kubejs:incomplete_receiver', MZ_in('tfmg:screw'))                // 装紧固件
    ], [MZ_o('kubejs:receiver_machined')], 1);

  // ---------- 六、枪管：锻造毛坯 → 切削膛线 → 抛光 ----------
  MZ_mc(event, 'kubejs:mat/barrel_blank', ['AAA'], { A: MZ_in('kubejs:gun_steel_ingot') }, MZ_o('kubejs:barrel_blank'));
  MZ_sa(event, 'kubejs:mat/rifled_barrel', MZ_in('kubejs:barrel_blank'), 'kubejs:incomplete_barrel', [
      MZ_sCut('kubejs:incomplete_barrel'),          // 切削膛线沟槽
      MZ_sPress('kubejs:incomplete_barrel'),        // 压床校直
      MZ_sPolish('kubejs:incomplete_barrel')        // 机械磨石研磨内膛
    ], [MZ_o('kubejs:rifled_barrel')], 1);
  // 按枪管族做长管 / 加重管
  MZ_mc(event, 'kubejs:mat/barrel_pistol', ['R', 'S'], { R: MZ_in('kubejs:rifled_barrel'), S: MZ_in('kubejs:gun_steel_sheet') }, MZ_o('kubejs:barrel_pistol'));
  MZ_mc(event, 'kubejs:mat/barrel_rifle', ['R', 'S', 'S'], { R: MZ_in('kubejs:rifled_barrel'), S: MZ_in('kubejs:gun_steel_sheet') }, MZ_o('kubejs:barrel_rifle'));
  MZ_mc(event, 'kubejs:mat/barrel_heavy', ['R', 'S', 'S', 'S'], { R: MZ_in('kubejs:rifled_barrel'), S: MZ_in('kubejs:gun_steel_sheet') }, MZ_o('kubejs:barrel_heavy'));
  MZ_mc(event, 'kubejs:mat/barrel_shotgun', ['S', 'R', 'S'], { R: MZ_in('kubejs:rifled_barrel'), S: MZ_in('kubejs:gun_steel_sheet') }, MZ_o('kubejs:barrel_shotgun'));
  MZ_mc(event, 'kubejs:mat/launcher_tube', ['PPP', 'P P'], { P: MZ_in('tfmg:steel_pipe') }, MZ_o('kubejs:launcher_tube'));

  // ---------- 七、弹药基础件：弹壳坯 / 杯 / 底火 / 发射药 ----------
  MZ_cut(event, 'kubejs:ammo/brass_blank', MZ_in('create:brass_sheet'), 'kubejs:brass_blank', 4, 50);
  MZ_press(event, 'kubejs:ammo/brass_cup', MZ_in('kubejs:brass_blank'), 'kubejs:brass_cup');
  MZ_cut(event, 'kubejs:ammo/steel_blank', MZ_in('kubejs:gun_steel_sheet'), 'kubejs:steel_blank', 4, 50);
  MZ_press(event, 'kubejs:ammo/steel_cup', MZ_in('kubejs:steel_blank'), 'kubejs:steel_cup');
  // 壳杯去毛刺抛光：砂纸抛光配方，可用鼓风机 + 磨砂催化剂批量自动化
  event.custom({
    type: 'create:sandpaper_polishing',
    ingredients: [MZ_in('kubejs:brass_cup')],
    results: [MZ_o('kubejs:brass_cup_bright')]
  }).id('kubejs:ammo/brass_cup_bright');
  event.custom({
    type: 'create:sandpaper_polishing',
    ingredients: [MZ_in('kubejs:steel_cup')],
    results: [MZ_o('kubejs:steel_cup_bright')]
  }).id('kubejs:ammo/steel_cup_bright');
  MZ_compact(event, 'kubejs:ammo/shot_hull', [MZ_in('tfmg:plastic_sheet', 2)], [MZ_o('kubejs:shot_hull', 4)], 'heated');
  MZ_press(event, 'kubejs:ammo/primer_cup', MZ_in('create:copper_sheet'), 'kubejs:primer_cup', 2);
  MZ_mix(event, 'kubejs:ammo/priming_compound', [
      MZ_in('tfmg:lead_nugget', 2), MZ_in('minecraft:gunpowder', 1)
    ], [MZ_o('kubejs:priming_compound', 4)], 'heated');
  MZ_mc(event, 'kubejs:ammo/primer_small', ['C', 'P'], { C: MZ_in('kubejs:primer_cup'), P: MZ_in('kubejs:priming_compound') }, MZ_o('kubejs:primer_small'));
  MZ_mc(event, 'kubejs:ammo/primer_large', ['C', 'P', 'S'], { C: MZ_in('kubejs:primer_cup'), P: MZ_in('kubejs:priming_compound'), S: MZ_in('kubejs:gun_steel_sheet') }, MZ_o('kubejs:primer_large'));
  MZ_mc(event, 'kubejs:ammo/primer_shotgun', ['CC', 'PP'], { C: MZ_in('kubejs:primer_cup'), P: MZ_in('kubejs:priming_compound') }, MZ_o('kubejs:primer_shotgun', 2));
  // 双基无烟火药：硝化甘油 + 火药（现实中为硝化棉+硝化甘油，这里用化学模组的硝化甘油做近似）
  MZ_mix(event, 'kubejs:ammo/smokeless_powder', [
      MZ_in('minecraft:gunpowder', 2), MZ_fluid('chemica:nitroglycerin', 100)
    ], [MZ_o('kubejs:smokeless_powder', 4)], 'heated');
  // 黑火药：火药 + 焦炭粉（老式弹药）
  MZ_mix(event, 'kubejs:ammo/black_powder', [
      MZ_in('minecraft:gunpowder', 2), MZ_in('tfmg:coal_coke_dust', 1)
    ], [MZ_o('kubejs:black_powder', 4)], 'none');

  // ---------- 八、弹头：铅芯 / 钨芯 / 被甲 ----------
  MZ_press(event, 'kubejs:ammo/lead_core', MZ_in('tfmg:lead_ingot'), 'kubejs:lead_core', 2);
  MZ_press(event, 'kubejs:ammo/tungsten_core', MZ_in('chemica:tungsten_carbide_ingot'), 'kubejs:tungsten_core', 2);
  MZ_mc(event, 'kubejs:ammo/proj_pistol', ['J', 'L'], { J: MZ_in('create:copper_sheet'), L: MZ_in('kubejs:lead_core') }, MZ_o('kubejs:proj_pistol'));
  MZ_mc(event, 'kubejs:ammo/proj_mag', ['J', 'L', 'L'], { J: MZ_in('create:copper_sheet'), L: MZ_in('kubejs:lead_core') }, MZ_o('kubejs:proj_mag'));
  MZ_mc(event, 'kubejs:ammo/proj_mag_heavy', ['JJ', 'LL'], { J: MZ_in('create:copper_sheet'), L: MZ_in('kubejs:lead_core') }, MZ_o('kubejs:proj_mag_heavy'));
  MZ_mc(event, 'kubejs:ammo/proj_ap_small', ['J', 'W'], { J: MZ_in('create:copper_sheet'), W: MZ_in('kubejs:tungsten_core') }, MZ_o('kubejs:proj_ap_small'));
  MZ_mc(event, 'kubejs:ammo/proj_rifle', ['JL', 'LL'], { J: MZ_in('create:copper_sheet'), L: MZ_in('kubejs:lead_core') }, MZ_o('kubejs:proj_rifle'));
  MZ_mc(event, 'kubejs:ammo/proj_rifle_heavy', ['JJ', 'LL', 'LL'], { J: MZ_in('create:copper_sheet'), L: MZ_in('kubejs:lead_core') }, MZ_o('kubejs:proj_rifle_heavy'));
  MZ_mc(event, 'kubejs:ammo/proj_sniper', ['JJ', 'LW'], { J: MZ_in('create:copper_sheet'), L: MZ_in('kubejs:lead_core'), W: MZ_in('kubejs:tungsten_core') }, MZ_o('kubejs:proj_sniper'));
  MZ_mc(event, 'kubejs:ammo/proj_heavy_ap', ['JJ', 'WW'], { J: MZ_in('create:copper_sheet'), W: MZ_in('kubejs:tungsten_core') }, MZ_o('kubejs:proj_heavy_ap'));
  MZ_mc(event, 'kubejs:ammo/proj_heavy_lead', ['LL', 'LL'], { L: MZ_in('kubejs:lead_core') }, MZ_o('kubejs:proj_heavy_lead'));
  MZ_mc(event, 'kubejs:ammo/proj_shot', ['LL', 'LL'], { L: MZ_in('tfmg:lead_nugget') }, MZ_o('kubejs:proj_shot', 2));

  // ---------- 九、火工品与战斗部 ----------
  MZ_mix(event, 'kubejs:ord/explosive_filler', [
      MZ_in('minecraft:gunpowder', 4), MZ_in('tfmg:coal_coke_dust', 1), MZ_fluid('chemica:nitroglycerin', 250)
    ], [MZ_o('kubejs:explosive_filler', 2)], 'heated');
  MZ_mc(event, 'kubejs:ord/shaped_charge', ['C', 'E'], { C: MZ_in('create:copper_sheet'), E: MZ_in('kubejs:explosive_filler') }, MZ_o('kubejs:shaped_charge'));
  MZ_mc(event, 'kubejs:ord/bomb_casing', ['III', 'I I', 'III'], { I: MZ_in('create:iron_sheet') }, MZ_o('kubejs:bomb_casing'));
  MZ_fill(event, 'kubejs:ord/bomb_casing_filled', MZ_in('kubejs:bomb_casing'), 'chemica:nitroglycerin', 500, 'kubejs:bomb_casing_filled', 1);
  MZ_mc(event, 'kubejs:ord/warhead_small', ['SE'], { S: MZ_in('create:iron_sheet'), E: MZ_in('kubejs:explosive_filler') }, MZ_o('kubejs:warhead_small'));
  MZ_mc(event, 'kubejs:ord/warhead_medium', ['SS', 'EE'], { S: MZ_in('create:iron_sheet'), E: MZ_in('kubejs:explosive_filler') }, MZ_o('kubejs:warhead_medium'));
  MZ_mc(event, 'kubejs:ord/warhead_heavy', ['SSS', 'EEE'], { S: MZ_in('tfmg:steel_ingot'), E: MZ_in('kubejs:explosive_filler') }, MZ_o('kubejs:warhead_heavy'));
  MZ_mc(event, 'kubejs:ord/rocket_motor', ['P', 'S', 'E'], { P: MZ_in('tfmg:steel_pipe'), S: MZ_in('kubejs:smokeless_powder'), E: MZ_in('kubejs:gun_steel_ingot') }, MZ_o('kubejs:rocket_motor'));
  MZ_mc(event, 'kubejs:ord/guidance_module', ['CAC', 'ABA', 'CAC'],
    { C: MZ_in('northstar:circuit'), A: MZ_in('northstar:advanced_circuit'), B: MZ_in('powergrid:battery') },
    MZ_o('kubejs:guidance_module'));
  MZ_mc(event, 'kubejs:ord/seeker_head', ['OA', 'AC'],
    { O: MZ_in('create_optical:optical_device'), A: MZ_in('northstar:advanced_circuit'), C: MZ_in('powergrid:capacitor') },
    MZ_o('kubejs:seeker_head'));
  MZ_mc(event, 'kubejs:ord/fuze', ['C', 'S'], { C: MZ_in('powergrid:circuit_board'), S: MZ_in('kubejs:gun_steel_ingot') }, MZ_o('kubejs:fuze', 2));
  MZ_mc(event, 'kubejs:ord/tnt_filler', ['EG'], { E: MZ_in('kubejs:explosive_filler'), G: MZ_in('tfmg:coal_coke_dust') }, MZ_o('kubejs:tnt_filler'));

  // ---------- 十、无人机 / 光学 / 传感器 / 单兵防护 ----------
  MZ_mc(event, 'kubejs:ord/drone_frame', ['AAA', 'A A'], { A: MZ_in('tfmg:aluminum_sheet') }, MZ_o('kubejs:drone_frame'));
  MZ_mc(event, 'kubejs:ord/drone_motor', ['WA'], { W: MZ_in('tfmg:copper_wire'), A: MZ_in('kubejs:gun_steel_ingot') }, MZ_o('kubejs:drone_motor', 2));
  MZ_mc(event, 'kubejs:opt/optic_tube', ['AA', 'AA'], { A: MZ_in('tfmg:aluminum_sheet') }, MZ_o('kubejs:optic_tube'));
  MZ_mc(event, 'kubejs:opt/optic_lens', ['G', 'M'], { G: MZ_in('minecraft:glass'), M: MZ_in('create_optical:mirror') }, MZ_o('kubejs:optic_lens', 2));
  MZ_mc(event, 'kubejs:opt/suppressor_baffle', ['HH'], { H: MZ_in('tfmg:heavy_plate') }, MZ_o('kubejs:suppressor_baffle', 2));
  MZ_mc(event, 'kubejs:opt/magnetic_sensor', ['CB'], { C: MZ_in('powergrid:circuit_board'), B: MZ_in('powergrid:battery') }, MZ_o('kubejs:magnetic_sensor'));
  MZ_mc(event, 'kubejs:opt/pressure_plate_kit', ['H', 'H', 'W'], { H: MZ_in('tfmg:heavy_plate'), W: MZ_in('kubejs:spring_wire') }, MZ_o('kubejs:pressure_plate_kit', 2));
  MZ_mc(event, 'kubejs:med/gauze', ['SS'], { S: MZ_in('minecraft:string') }, MZ_o('kubejs:gauze', 2));
  MZ_fill(event, 'kubejs:med/antiseptic', MZ_in('minecraft:glass_bottle'), 'chemica:phenol', 250, 'kubejs:antiseptic', 1);
  MZ_mc(event, 'kubejs:med/splint', ['SS', 'S '], { S: MZ_in('minecraft:stick') }, MZ_o('kubejs:splint', 2));
  MZ_mc(event, 'kubejs:gear/ballistic_plate', ['HH', 'HH'], { H: MZ_in('tfmg:heavy_plate') }, MZ_o('kubejs:ballistic_plate'));
  MZ_mc(event, 'kubejs:gear/composite_plate', ['CC', 'CC'], { C: MZ_in('chemica:carbon_fiber_composite_sheet') }, MZ_o('kubejs:composite_plate'));
  MZ_mc(event, 'kubejs:gear/filter_canister', ['IC', 'C '], { I: MZ_in('create:iron_sheet'), C: MZ_in('minecraft:charcoal') }, MZ_o('kubejs:filter_canister'));
  MZ_mc(event, 'kubejs:gear/nv_tube', ['G', 'A'], { G: MZ_in('minecraft:glass'), A: MZ_in('northstar:advanced_circuit') }, MZ_o('kubejs:nv_tube'));
});
