/**
 * 轻量建造意图检测(R6)—— 只用于 chat 群聊里的「去工作页发起?」**路标横幅**,
 * 不参与任何路由决策(决策 X:work 显式发起,不猜措辞)。宁缺勿滥:漏报无害
 * (用户自己会去工作页),误报烦人(闲聊弹横幅),所以词面收紧。
 */
export function looksLikeBuildIntent(text: string): boolean {
  const t = text.trim();
  if (t.length < 6 || t.length > 500) return false;
  // 动词面:做/写/搭/开发/实现/建 + 交付物名词面:app/应用/网站/网页/页面/插件/脚本/工具/系统/小程序/游戏/接口
  const verb = /(帮我|给我|我想|我要|咱们|我们)?(做|写|搭|开发|实现|建|弄)(一?个|一款|一套)/;
  const noun = /(app|应用|网站|网页|页面|落地页|插件|脚本|工具|系统|小程序|游戏|接口|爬虫|机器人|demo)/i;
  return verb.test(t) && noun.test(t);
}
