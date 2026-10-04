// minecraft/kubejs/client_scripts/tacz_attachment_tooltips.js
// 由 .team/drafts/art-copy/15-生成配件描述.py 生成（含 2026-10-04 防御性加固），请勿手改；要改请改生成器。
// A 路径（备选方案，默认关）：客户端 ItemEvents.dynamicTooltips 追加配件 desc 行，读物品 CUSTOM_DATA 的 AttachmentId。
// 重要：dynamicTooltips 不是按物品 id 触发；先用 modifyTooltips 给 tacz 通用配件物品挂一个 dynamic 动作 id，
//       再由 dynamicTooltips('<那个 id>') 接管（KubeJSClientEventHandler.handleItemTooltips 字节码实证）。
// 与 B 方案互斥：B 方案开启时本开关必须为 false，否则 desc 行出现两次。
//
// 【加固约定】2026-10-04 由 lead 授权动手，写范围仅本文件。加固动因：本文件是唯一可能在加载期抛错的
//   KubeJS 注册点（其余 4 条都发生在回调期，不会拖垮加载）。三条约定：
//   1) 每个注册各包一层 try/catch ⇒ 其中一条失败不会连带丢掉同文件里的其它注册；
//   2) 失败一律留痕，前缀 [tacz-att-desc]（可 grep），不静默吞掉；
//   3) 注册顺序 = 先 modifyTooltips（挂 dynamic 动作 id），再 dynamicTooltips（接管该 id）。
//      依据 = API 语义推断（DYNAMIC_TOOLTIPS 是 TargetedEventHandler<String>，target 必须先被
//      tooltip.dynamic(id) 注册过），**未实机证实** —— 若实机日志报 FAILED，见下面「实机检查项」。
//
// 【实机检查项】（供 <实例>/实机验证清单.md 使用）
//  · 加载后看 logs/kubejs/client.log（或 latest.log）里有没有前缀 [tacz-att-desc]
//  · 没有该前缀 ⇒ 注册链路没报错（注意：TACZ_ATT_DESC_A = false 时本文件只加载不注册，本来就不会打印，这是预期）
//  · 出现 FAILED ⇒ A 路径不可用，以 B 路径（index 覆盖 + generateData last + lang）为准，把 A 路径标成「实机不可用」
//  · 开启 A 路径后既无 desc 行也无 FAILED ⇒ 注册成功但链路没接上（CUSTOM_DATA 的 AttachmentId 读不到 / target 物品 id 不对）

const TACZ_ATT_DESC_A = false;      // A 路径总开关，默认关；实机对比时可单独开
const TACZ_ATT_DESC_A_DEBUG = false; // true = 加 §7[A] 前缀，便于肉眼分辨这行来自 A 路径
const TACZ_ATT_DESC_A_ITEM = 'tacz:attachment'; // 通用配件物品 id（静态推断，待实机确认）
const TACZ_ATT_DESC_A_DYNAMIC = 'tacz_attachment_desc'; // 动作 id，随意命名，两端一致即可
const TACZ_ATT_DESC_TAG = '[tacz-att-desc]'; // 日志前缀；实机检查就是 grep 它
// 枪包原生 index 自带 tooltip 的 5 条：A 模式下跳过，避免与引擎自带的那一行重复
const TACZ_ATT_DESC_NATIVE = ['ammo_mod_fmj', 'ammo_mod_he', 'ammo_mod_hp', 'ammo_mod_i', 'ammo_mod_slug'];

// 注册期防御性包裹：失败留痕并返回 false，但不外抛（外抛会连带丢掉同文件后续语句）
function taczAttGuard(label, fn) {
  try {
    fn();
    return true;
  } catch (err) {
    console.error(TACZ_ATT_DESC_TAG + ' FAILED [' + label + ']: ' + err);
    return false;
  }
}
// 回调期错误只打第一条：tooltip 每次渲染都会跑回调，逐次打印会把日志刷爆；但绝不静默（首条带说明）
let taczAttCallbackErrLogged = false;
function taczAttCallbackGuard(label, err) {
  if (taczAttCallbackErrLogged) return;
  taczAttCallbackErrLogged = true;
  console.error(TACZ_ATT_DESC_TAG + ' FAILED (callback) [' + label + ']: ' + err + ' —— 后续同类错误不再重复打印');
}

if (TACZ_ATT_DESC_A) {
  console.info(TACZ_ATT_DESC_TAG + ' A 路径开启，开始注册（顺序：modifyTooltips -> dynamicTooltips）');
  let DataComponents = null;
  taczAttGuard('loadClass net.minecraft.core.component.DataComponents', () => {
    DataComponents = Java.loadClass('net.minecraft.core.component.DataComponents');
  });
  // (1) 先挂 dynamic 动作 id —— 这个 id 必须先存在，下面 (2) 才接得住
  taczAttGuard('register modifyTooltips/dynamic(' + TACZ_ATT_DESC_A_DYNAMIC + ')', () => {
    ItemEvents.modifyTooltips(event => {
      event.modify(TACZ_ATT_DESC_A_ITEM, tooltip => {
        tooltip.dynamic(TACZ_ATT_DESC_A_DYNAMIC);
      });
    });
  });
  // (2) 再接管该动作 id —— 本调用失败不影响 (1)，也不影响本文件其它语句
  taczAttGuard('register dynamicTooltips(' + TACZ_ATT_DESC_A_DYNAMIC + ')', () => {
    ItemEvents.dynamicTooltips(TACZ_ATT_DESC_A_DYNAMIC, event => {
      try {
        if (!DataComponents) return; // loadClass 已失败并报过错，这里不再重复刷日志
        const data = event.item.get(DataComponents.CUSTOM_DATA);
        const id = data ? data.getUnsafe().getString('AttachmentId') : '';
        if (!id) return;
        if (TACZ_ATT_DESC_NATIVE.indexOf(id) >= 0) return;
        const line = Text.translate('tacz.attachment.' + id + '.desc');
        event.add([TACZ_ATT_DESC_A_DEBUG ? Text.of('§7[A] ').append(line) : line]);
      } catch (err) {
        taczAttCallbackGuard('dynamicTooltips body', err);
      }
    });
  });
}
