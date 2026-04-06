/**
 * Buddy Growth Keywords — 属性成长触发词库
 *
 * 每个属性对应一组中英文关键词。对话中出现这些词时，对应属性会微量增长。
 * 关键词不区分大小写，支持正则。
 */

import type { StatName } from './buddy'

// ─── ENERGY 活力 ───
// 触发场景：兴奋、积极、高频互动、深夜活跃、表达热情
const ENERGY_KEYWORDS = [
  // 中文
  '太棒了', '太好了', '太厉害', '太强了', '牛逼', '牛啊', '厉害',
  '冲冲冲', '冲啊', '加油', '继续', '开始吧', '来吧', '走起',
  '嗨', '耶', '哇', '呀', '哈哈', '嘿嘿', '哦耶',
  '666', '999', 'yyds', '绝了', '爽', '过瘾', '带劲',
  '干得漂亮', '做得好', '完美', '好耶', '好棒', '真不错',
  '兴奋', '激动', '期待', '等不及', '迫不及待',
  '再来', '还要', '下一个', '接着', '快快快',
  '精力充沛', '活力', '满血复活', '打起精神',
  // 英文
  'awesome', 'amazing', 'great', 'fantastic', 'incredible', 'wonderful',
  'nice', 'cool', 'perfect', 'excellent', 'brilliant', 'outstanding',
  'let\'s go', 'go go', 'gogogo', 'lesgo', 'yeah', 'yay', 'woohoo',
  'hype', 'hyped', 'excited', 'pumped', 'stoked', 'fired up',
  'well done', 'good job', 'nailed it', 'crushed it', 'killed it',
  'lol', 'lmao', 'rofl', 'haha', 'omg', 'wow',
  'keep going', 'more', 'again', 'next', 'continue',
  // 符号
  '🔥', '💪', '🚀', '⚡', '🎉', '🎊', '✊', '👏',
]

// ─── WARMTH 温柔 ───
// 触发场景：感谢、关心、正面情感、礼貌、共情
const WARMTH_KEYWORDS = [
  // 中文
  '谢谢', '感谢', '多谢', '感恩', '辛苦了', '辛苦啦',
  '你真好', '你好棒', '你真棒', '好温暖', '好贴心', '暖心',
  '晚安', '早安', '午安', '早上好', '晚上好', '下午好',
  '爱你', '喜欢你', '么么', '亲亲', '抱抱', '摸摸头',
  '关心', '在意', '陪伴', '陪我', '不孤单', '有你真好',
  '温暖', '温柔', '善良', '可爱', '贴心', '懂我',
  '没关系', '别担心', '放心', '慢慢来', '不急', '别着急',
  '保重', '注意身体', '休息一下', '别熬夜', '好好睡',
  '对不起', '抱歉', '不好意思', '打扰了', '请', '麻烦',
  '鼓励', '支持', '相信你', '你可以的', '加油打气',
  '❤️', '🥰', '😊', '🤗', '💕', '💖', '💝', '💗', '🫶',
  // 英文
  'thank', 'thanks', 'thx', 'appreciate', 'grateful', 'gratitude',
  'kind', 'sweet', 'lovely', 'adorable', 'cute', 'precious',
  'love', 'love you', 'luv', 'heart', 'care', 'caring',
  'good night', 'good morning', 'sweet dreams', 'take care',
  'sorry', 'excuse me', 'pardon', 'please', 'forgive',
  'hug', 'hugs', 'cuddle', 'comfort', 'warm', 'warmth',
  'don\'t worry', 'it\'s okay', 'no worries', 'take your time',
  'you\'re the best', 'you rock', 'bless', 'blessed',
  'support', 'encourage', 'believe in you', 'proud of you',
  'miss you', 'thinking of you',
]

// ─── MISCHIEF 调皮 ───
// 触发场景：玩笑、搞怪、摸头互动、创意发散、轻松氛围
const MISCHIEF_KEYWORDS = [
  // 中文
  '哈哈哈', '笑死', '笑了', '笑喷', '太搞笑了', '有趣',
  '好玩', '好笑', '逗死', '调皮', '搞事', '整活',
  '皮一下', '恶作剧', '闹着玩', '逗你的', '开玩笑',
  '彩蛋', '惊喜', '意外', '没想到', '竟然', '居然',
  '摸摸', '摸头', '揉揉', '戳', '拍拍', '挠挠',
  '嘻嘻', '嘿嘿', '略略略', '呵呵', '嗯哼',
  '沙雕', '离谱', '奇葩', '脑洞', '脑回路',
  '无聊', '随便玩玩', '试试看', '搞一个', '整一个',
  '表情包', '梗', '段子', '冷笑话',
  '🤪', '😜', '😝', '🤡', '👻', '😈', '🎭', '🎪',
  '😂', '🤣', '😆', '💀', '☠️',
  // 英文
  'hahaha', 'lmao', 'rofl', 'lol', 'dying', 'dead',
  'funny', 'hilarious', 'comedy', 'joke', 'prank', 'meme',
  'bruh', 'sus', 'yeet', 'vibe', 'vibes', 'mood',
  'random', 'chaos', 'chaotic', 'wild', 'crazy', 'insane',
  'troll', 'trolling', 'mischief', 'naughty', 'cheeky',
  'pet', 'pat', 'poke', 'boop', 'tickle', 'squish',
  'easter egg', 'surprise', 'unexpected', 'plot twist',
  'creative', 'weird', 'cursed', 'blursed', 'based',
  'shenanigans', 'tomfoolery', 'bamboozle',
]

// ─── WIT 聪慧 ───
// 触发场景：提问、分析、技术讨论、学习、解决问题
const WIT_KEYWORDS = [
  // 中文
  '为什么', '怎么', '如何', '什么是', '是什么', '原理',
  '分析', '研究', '学习', '了解', '理解', '掌握',
  '代码', '编程', '开发', '架构', '设计', '方案',
  '算法', '逻辑', '思路', '策略', '优化', '重构',
  'bug', '报错', '错误', '异常', '调试', '排查', '修复',
  '性能', '效率', '并发', '异步', '缓存', '索引',
  '部署', '上线', '发布', '测试', '验证', '检查',
  '数据', '数据库', '接口', '协议', '格式',
  '聪明', '机智', '智慧', '灵光一闪', '顿悟',
  '有道理', '说得对', '学到了', '涨知识', '原来如此',
  '想到了', '灵感', '创意', '方法', '解决',
  '总结', '归纳', '对比', '评估', '权衡',
  '文档', '教程', '指南', '手册', '参考',
  // 英文
  'why', 'how', 'what is', 'explain', 'understand', 'learn',
  'code', 'coding', 'programming', 'develop', 'development',
  'debug', 'debugging', 'error', 'fix', 'solve', 'solution',
  'algorithm', 'logic', 'architecture', 'design', 'pattern',
  'optimize', 'refactor', 'performance', 'efficiency',
  'deploy', 'release', 'test', 'testing', 'verify',
  'api', 'database', 'server', 'client', 'frontend', 'backend',
  'smart', 'clever', 'brilliant', 'genius', 'insight',
  'analyze', 'research', 'investigate', 'examine',
  'strategy', 'approach', 'method', 'technique',
  'documentation', 'tutorial', 'guide', 'reference',
  'function', 'class', 'module', 'component', 'library',
  'git', 'commit', 'branch', 'merge', 'pull request',
  'typescript', 'javascript', 'python', 'rust', 'react',
  'config', 'configuration', 'setup', 'install',
  'makes sense', 'i see', 'got it', 'aha', 'eureka',
  'TIL', 'interesting', 'fascinating', 'intriguing',
]

// ─── SASS 犀利 ───
// 触发场景：吐槽、不满、催促、犀利评价、傲娇
const SASS_KEYWORDS = [
  // 中文
  '不行', '不好', '不对', '不可以', '不要', '不需要',
  '太慢', '太烂', '太差', '太蠢', '太笨',
  '垃圾', '废物', '什么鬼', '什么玩意', '什么东西',
  '无语', '无聊', '无力吐槽', '没眼看',
  '离谱', '抽象', '逆天', '炸裂', '窒息',
  '吐槽', '差评', '一星', '难用', '难看',
  '算了', '得了', '罢了', '随便', '无所谓',
  '拒绝', '不想', '懒得', '烦', '烦死了',
  '傲娇', '哼', '切', '呸', '哦', '行吧',
  '快点', '赶紧', '效率', '磨叽', '拖拉',
  '重来', '重写', '删了', '不要了', '推倒重来',
  '为什么这么', '怎么回事', '搞什么',
  '又来', '又是', '老毛病', '又出问题',
  '能不能', '到底', '究竟', '凭什么',
  '😤', '😡', '🙄', '💢', '😒', '👎', '🤦',
  // 英文
  'no', 'nope', 'nah', 'hell no', 'absolutely not',
  'bad', 'terrible', 'awful', 'horrible', 'worst',
  'ugly', 'trash', 'garbage', 'useless', 'pointless',
  'annoying', 'frustrating', 'ridiculous', 'absurd',
  'cringe', 'yikes', 'oof', 'bruh moment',
  'whatever', 'idc', 'don\'t care', 'who cares',
  'sucks', 'hate', 'dislike', 'boring', 'meh',
  'slow', 'laggy', 'broken', 'buggy', 'glitchy',
  'ugh', 'smh', 'ffs', 'wtf', 'wth',
  'hurry', 'faster', 'speed up', 'come on',
  'redo', 'rewrite', 'delete', 'scrap', 'start over',
  'again?', 'seriously?', 'really?', 'are you kidding',
  'not again', 'same bug', 'still broken',
  'why is this', 'how is this', 'what the',
  'disappointed', 'unacceptable', 'unbelievable',
  'sassy', 'savage', 'brutal', 'harsh', 'blunt',
  'toxic', 'salty', 'petty', 'shade', 'roast',
]

// ─── Build RegExp for each stat ───

function buildRegex(keywords: string[]): RegExp {
  // Escape special regex chars, join with |, case-insensitive global
  const escaped = keywords.map(k =>
    k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )
  return new RegExp(`(?:${escaped.join('|')})`, 'gi')
}

export interface GrowthSignal {
  stat: StatName
  regex: RegExp
  keywordCount: number
}

export const GROWTH_SIGNALS: GrowthSignal[] = [
  { stat: 'ENERGY',   regex: buildRegex(ENERGY_KEYWORDS),   keywordCount: ENERGY_KEYWORDS.length },
  { stat: 'WARMTH',   regex: buildRegex(WARMTH_KEYWORDS),   keywordCount: WARMTH_KEYWORDS.length },
  { stat: 'MISCHIEF', regex: buildRegex(MISCHIEF_KEYWORDS), keywordCount: MISCHIEF_KEYWORDS.length },
  { stat: 'WIT',      regex: buildRegex(WIT_KEYWORDS),      keywordCount: WIT_KEYWORDS.length },
  { stat: 'SASS',     regex: buildRegex(SASS_KEYWORDS),     keywordCount: SASS_KEYWORDS.length },
]

// Stats:
// ENERGY:   ~80 keywords
// WARMTH:   ~90 keywords
// MISCHIEF: ~80 keywords
// WIT:      ~100 keywords
// SASS:     ~90 keywords
// Total:    ~440 keywords
