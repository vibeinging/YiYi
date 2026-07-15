// L0 传输适配层(HTTP 侧):薄 express,把 TCP 请求喂进**同一个 registry/usecase/信封**。
// 仅用于 eval/CI(独立启动 或 YIW_TCP=1);app 路径走 ipc_server,不经这里。
// 与 ipc_server 共享 router/auth/envelope/ctx —— eval 测的就是 app 跑的同一份用例代码。
import express from 'express';
import cors from 'cors';
import { makeRouter } from './router.js';
import { verifyToken, resolveUserId, DESKTOP_NO_AUTH } from './auth.js';
import { okBody, failBody } from './envelope.js';
import { makeCtx } from '../ctx.js';
import { ApiError } from '../errors.js';
import { ROUTES } from './registry.js';
import { createStreamEvent, StreamEventType } from '../engine/stream/agent_stream_protocol.js';

const match = makeRouter(ROUTES);

export function startHttpServer(port) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  app.all('/api/*', async (req, res) => {
    const hit = match(req.method, req.path);
    if (!hit) return res.status(404).json(failBody(`接口未找到: ${req.method} ${req.path}`, 404));
    const { route, params } = hit;
    try {
      let userId = null;
      if (route.auth !== false) {
        // DESKTOP_NO_AUTH:本地 eval/CI 场景跳过 token(免鉴权),视为内置用户
        userId = resolveUserId(req.headers);
        if (!userId) return res.status(401).json(failBody('未登录或令牌缺失', 401));
      }
      const input = { params, query: req.query || {}, body: req.body || {}, headers: req.headers || {} };

      // 流式 SSE
      if (route.stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const controller = new AbortController();
        req.on('close', () => controller.abort());
        const emit = (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ } };
        try {
          await route.fn(makeCtx({ userId, signal: controller.signal }), input, emit);
        } catch (e) {
          const m = e instanceof ApiError ? e.message : '服务错误: ' + (e?.message || e);
          emit(createStreamEvent({
            type: StreamEventType.MESSAGE_DELTA,
            visibility: 'primary',
            payload: {
              block_id: 'transport:error',
              channel: 'error',
              format: 'error',
              mode: 'replace',
              content: m,
              title: '错误',
            },
          }));
          emit(createStreamEvent({ type: StreamEventType.RUN_FAILED, payload: { status: 'failed', message: m } }));
        } finally {
          try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* closed */ }
        }
        return;
      }

      const result = await route.fn(makeCtx({ userId }), input);
      // 二进制下载
      if (result && result._binary) {
        const buf = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data ?? '');
        if (result.headers) for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
        return res.status(result.status || 200).send(buf);
      }
      const data = result && typeof result === 'object' && 'data' in result ? result.data : (result ?? null);
      const message = (result && result.message) || '操作成功';
      res.json(okBody(data, message));
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json(failBody(e.message, e.code));
      console.error('[http usecase]', route.m, route.p, e?.message || e);
      res.status(500).json(failBody('服务错误: ' + (e?.message || e), 500));
    }
  });

  // 仅绑 loopback:HTTP server 专供本机 eval/CI 复用运行中的 server 实例,不暴露到局域网。
  // (DESKTOP_NO_AUTH 免鉴权开启时尤为必要;即便未开启,本端口服務于可信本地進程。)
  const srv = app.listen(port, '127.0.0.1', () => console.log(`🟢 desktop server (node) HTTP(eval/CI) on http://127.0.0.1:${port}${DESKTOP_NO_AUTH ? ' [NO_AUTH]' : ''}`));
  srv.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') console.warn(`[server] TCP ${port} 已占用,跳过监听`);
    else throw e;
  });
  return srv;
}
