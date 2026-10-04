// minecraft/kubejs/client_scripts/tacz_attachment_tooltips.js
// 由 .team/drafts/art-copy/15-生成配件描述.py 自动生成，请勿手改。
// A 路径（备选方案）：客户端 ItemEvents.dynamicTooltips 追加配件 desc 行，读物品 CUSTOM_DATA 的 AttachmentId。
// 重要：dynamicTooltips 不是按物品 id 触发；先用 modifyTooltips 给 tacz 通用配件物品挂一个 dynamic 动作 id，
//       再由 dynamicTooltips('<那个 id>') 接管（KubeJSClientEventHandler.handleItemTooltips 字节码实证）。
// 与 B 方案互斥：B 方案开启时本开关必须为 false，否则 desc 行出现两次。

const TACZ_ATT_DESC_A = false;      // A 路径总开关，默认关；实机对比时可单独开
const TACZ_ATT_DESC_A_DEBUG = false; // true = 加 §7[A] 前缀，便于肉眼分辨这行来自 A 路径
const TACZ_ATT_DESC_A_ITEM = 'tacz:attachment'; // 通用配件物品 id（静态推断，待实机确认）
const TACZ_ATT_DESC_A_DYNAMIC = 'tacz_attachment_desc'; // 动作 id，随意命名，两端一致即可
// 枪包原生 index 自带 tooltip 的 5 条：A 模式下跳过，避免与引擎自带的那一行重复
const TACZ_ATT_DESC_NATIVE = ['ammo_mod_fmj', 'ammo_mod_he', 'ammo_mod_hp', 'ammo_mod_i', 'ammo_mod_slug'];

if (TACZ_ATT_DESC_A) {
  const DataComponents = Java.loadClass('net.minecraft.core.component.DataComponents');
  ItemEvents.modifyTooltips(event => {
    event.modify(TACZ_ATT_DESC_A_ITEM, tooltip => {
      tooltip.dynamic(TACZ_ATT_DESC_A_DYNAMIC);
    });
  });
  ItemEvents.dynamicTooltips(TACZ_ATT_DESC_A_DYNAMIC, event => {
    const data = event.item.get(DataComponents.CUSTOM_DATA);
    const id = data ? data.getUnsafe().getString('AttachmentId') : '';
    if (!id) return;
    if (TACZ_ATT_DESC_NATIVE.indexOf(id) >= 0) return;
    const line = Text.translate('tacz.attachment.' + id + '.desc');
    event.add([TACZ_ATT_DESC_A_DEBUG ? Text.of('§7[A] ').append(line) : line]);
  });
}
