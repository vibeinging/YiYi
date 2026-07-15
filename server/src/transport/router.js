// 轻量路由匹配:(method, pathPattern) → 提取 :param。接管 express 唯一还需要的能力。
// 按 '/' 分段:`:x` 段 → 捕获组并记 key;字面段 → 转义。

function compile(pattern) {
  const keys = [];
  const rxStr = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // 字面段转义
    })
    .join('/');
  return { rx: new RegExp('^' + rxStr + '$'), keys };
}

export function makeRouter(routes) {
  const compiled = routes.map((r) => ({ ...r, ...compile(r.p) }));
  return function match(method, path) {
    for (const r of compiled) {
      if (r.m !== method) continue;
      const m = r.rx.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route: r, params };
    }
    return null;
  };
}
