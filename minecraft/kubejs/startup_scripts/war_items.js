// ============================================================================
// 战服 · war_items.js —— 物品注册（startup_scripts，只做物品本身）
// ============================================================================
// 本文件只干一件事：注册战服货币物品的**物品实体**。
//
//   · 物品 id ：kubejs:credit
//   · 账本键   ：war.credit
//   —— 这两者不是两套东西，而是同一件东西的两个面：
//      kubejs:credit 是玩家手里/箱子里/交易里的**物品**；
//      war.credit   是服务端权威账本（server.persistentData.war.econ 里的数字，由 30_economy.js 维护）。
//      兑换与对账全部在 30_economy.js；本文件**不写任何账本/发放/兑换逻辑**。
//
// 命名空间约定（避免以后混淆）：
//   · 物品走 kubejs:* —— 与本包既有 157 个物品（startup_scripts/mw_tacz_registry.js）同一条
//     已在实机跑过的路径，也与 art-copy 正在做的 item.kubejs.* 文案覆盖线同源；
//   · 数据与命令走 war —— global.WAR 命名空间、server.persistentData.war、账本键 war.credit。
//
// 贴图：沿用本包既有资源 create:item/brass_sheet（与 mw_tacz_registry.js 里已上机的同款），
//   本批次不新增 png；正式外观等 art-copy 那条线。
//
// 已核实（字节码/本包先例）：
//   StartupEvents.registry('item', callback)（RegisterType 注册事件，本包 157 件先例）；
//   event.create(id) 的 id 经 dev.latvian.mods.kubejs.util.KubeResourceLocation → ID.kjs 解析，
//   含冒号的字符串原样使用 ⇒ 这里写显式命名空间，不依赖默认前缀。
// ============================================================================

StartupEvents.registry('item', function (event) {
  event.create('kubejs:credit')
    .texture('create:item/brass_sheet');
});
