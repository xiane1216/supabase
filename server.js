/*
 * Supabase 中转代理 (零依赖 Node.js)
 *
 * 用途: Supabase 域名在大陆被阻断 (Connection reset) 时,
 *       部署在 Zeabur 等海外平台做中转, App 连本代理, 代理再连 Supabase。
 *
 * 环境变量 (在 Zeabur 的 Variables 里配置):
 *   TARGETS         目标列表, 格式: "别名=URL,别名=URL"
 *                   例: supa=https://abcdefgh.supabase.co,mcp=https://mcp.supabase.com
 *   DEFAULT_TARGET  默认目标的别名, 不带别名的路径会转发给它
 *                   例: supa  (则 https://代理域名/rest/v1/... 直接进 Supabase)
 *   PORT            监听端口 (Zeabur 会自动注入, 本地测试默认 8080)
 *
 * 路由规则:
 *   https://代理域名/_status            状态页 (查看配置 + 测试上游连通性)
 *   https://代理域名/别名/路径...        转发到对应目标
 *   https://代理域名/路径...             转发到 DEFAULT_TARGET
 *
 * 例 (TARGETS 如上):
 *   https://代理域名/rest/v1/chat_messages       -> https://abcdefgh.supabase.co/rest/v1/chat_messages
 *   https://代理域名/mcp/mcp                     -> https://mcp.supabase.com/mcp
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);

// ---------- DNS 缓存 ----------
// 集群 DNS 空闲后第一查容易超时 (EAI_AGAIN), 导致空闲后第一条请求失败。
// 这里把解析结果缓存 DNS_TTL_MS 毫秒 (默认 5 分钟), 期间新建连接不再查 DNS。
// 上游 IP 变化时最多在 TTL 过期后自动更新, 风险可忽略。
const _dnsLookup = dns.lookup.bind(dns);
const dnsCache = new Map(); // "hostname|family" -> { result, all, exp }
const DNS_TTL_MS = Number(process.env.DNS_TTL_MS || 5 * 60 * 1000);

dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const all = !!options.all;
  const family = options.family || 0;
  const key = `${hostname}|${family}`;
  const now = Date.now();
  const hit = dnsCache.get(key);
  if (hit && hit.exp > now) {
    process.nextTick(() => (all ? callback(null, hit.result) : callback(null, hit.addr, hit.fam)));
    return;
  }
  _dnsLookup(hostname, options, (err, ...args) => {
    if (!err) {
      dnsCache.set(key, all ? { result: args[0], all: true, exp: now + DNS_TTL_MS }
                            : { addr: args[0], fam: args[1], exp: now + DNS_TTL_MS });
    }
    callback(err, ...args);
  });
};

// ---------- 解析环境变量 ----------

const targets = new Map(); // 别名(小写) -> 基础 URL
for (const pair of String(process.env.TARGETS || '').split(',')) {
  const trimmed = pair.trim();
  if (!trimmed) continue;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) continue;
  const alias = trimmed.slice(0, eq).trim().toLowerCase();
  const url = trimmed.slice(eq + 1).trim().replace(/\/+$/, ''); // 去尾部斜杠
  if (alias && /^https?:\/\//.test(url)) {
    targets.set(alias, url);
  }
}
const defaultTargetKey = String(process.env.DEFAULT_TARGET || '').trim().toLowerCase();

// ---------- 工具 ----------

// 逐跳头不应转发, Host 必须改成上游的 (否则 Supabase 无法路由)
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

function buildUpstreamHeaders(headers, host) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out.host = host;
  return out;
}

function stripHopByHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// 测试代理服务器 -> 上游的连通性 (只给状态页用)
function testUpstream(baseUrl, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const u = new URL('/', baseUrl);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, { method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume(); // 丢弃响应体
        resolve({ ok: true, status: res.statusCode });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: `超时 (${timeoutMs / 1000}s)` });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// ---------- 状态页 ----------

async function handleStatus(_req, res) {
  const info = {
    ok: true,
    说明: '代理运行中。upstream_test 里 ok=true 表示代理服务器能连上目标。',
    default_target: defaultTargetKey || '(未配置)',
    targets: Object.fromEntries(targets),
    upstream_test: {},
  };

  const tests = await Promise.all(
    [...targets.entries()].map(async ([alias, url]) => [alias, await testUpstream(url)])
  );
  info.upstream_test = Object.fromEntries(tests);

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(info, null, 2));
}

// ---------- 代理主逻辑 ----------

const server = http.createServer((req, res) => {
  // 状态页 (在别名匹配之前处理)
  if (req.url.split('?')[0] === '/_status') {
    handleStatus(req, res).catch(() => {
      res.writeHead(500);
      res.end('status error');
    });
    return;
  }

  let path = req.url;
  let base = '';

  // 尝试匹配别名前缀: /别名/路径...
  const m = path.match(/^\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (m && targets.has(m[1].toLowerCase())) {
    base = targets.get(m[1].toLowerCase());
    path = m[2] || '/';
  } else if (targets.has(defaultTargetKey)) {
    // 没匹配到别名 -> 走默认目标
    base = targets.get(defaultTargetKey);
  }

  if (!base) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      '代理未配置: 请在环境变量里设置 TARGETS (格式: 别名=URL,别名=URL)' +
        (defaultTargetKey ? ` 和确认 DEFAULT_TARGET=${defaultTargetKey} 存在于 TARGETS 中` : ' 和 DEFAULT_TARGET')
    );
    return;
  }

  let target;
  try {
    target = new URL(path, base);
  } catch (e) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }

  const mod = target.protocol === 'https:' ? https : http;

  const upstreamReq = mod.request(
    target,
    {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, target.host),
    },
    (upstreamRes) => {
      // 原样回传状态码和响应头, 内容用管道流式转发 (支持 SSE 长连接)
      res.writeHead(upstreamRes.statusCode, stripHopByHop(upstreamRes.headers));
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('error', (e) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      `上游连接失败: ${e.message}\n` +
        `请求目标: ${target.href}\n` +
        '请检查环境变量 TARGETS 里的地址是否正确。'
    );
  });

  // 客户端断开时, 同步断开上游连接 (避免悬挂)
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });

  // 请求体流式转发
  req.pipe(upstreamReq);
});

server.listen(PORT, () => {
  console.log(`[supabase-proxy] 监听端口 ${PORT}`);
  console.log(`[supabase-proxy] DNS 缓存: 开启, TTL ${DNS_TTL_MS / 1000}s`);
  console.log(`[supabase-proxy] 目标列表: ${[...targets.entries()].map(([a, u]) => `${a} -> ${u}`).join(', ') || '(空!)'}`);
  console.log(`[supabase-proxy] 默认目标: ${defaultTargetKey || '(未配置)'}`);
});
