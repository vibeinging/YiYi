// 请求上下文:用例层(L1)与外界的唯一边界。替代 req.userId + 闭包捕获的 query/queryOne。
// usecase 只依赖 ctx,不碰 req/res/express → 可纯函数单测:fn(makeCtx({userId,query:fake}), input)。
import { query, queryOne } from './db.js';

export function makeCtx({ userId = null, signal = null } = {}) {
  return {
    userId, // 来自 transport 鉴权(替代 req.userId)
    query,
    queryOne, // L2 句柄;测试可替身
    signal, // AbortSignal:流式/长任务用(替代 res.on('close')),批 5 接入
    // 重型 service(MetricService 等)后续按需加 lazy getter
  };
}
