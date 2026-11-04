// AI 炒股竞技场 —— 启动：node server.js   （断网调试：node server.js --mock）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuoteService, normalizeSymbol, marketStatus } from './lib/market.js';
import { Exchange } from './lib/exchange.js';
import { Runner } from './lib/runner.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(ROOT, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (process.argv.includes('--mock')) config.dataSource = 'mock';
config.rules ||= {};
config.runner ||= {};

const quotes = new QuoteService({ source: config.dataSource, cacheSeconds: config.quoteCacheSeconds ?? 5 });
const exchange = new Exchange(config, quotes, path.join(ROOT, 'docs', 'data', config.dataSource === 'mock' ? 'state-mock.json' : 'state.json'));
const runner = new Runner(config, exchange, quotes);

// ---------------- HTTP ----------------
const send = (res, code, obj, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
  res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('请求体不是合法 JSON')); } });
});
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');

    // 公开：排行榜/页面数据
    if (p === '/api/state' && req.method === 'GET') {
      const s = await exchange.publicState();
      s.markets = marketStatus();
      return send(res, 200, s);
    }

    // 公开：实时行情  /api/quote?symbols=600519,AAPL,00700
    if (p === '/api/quote' && req.method === 'GET') {
      const raw = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
      const syms = raw.map(normalizeSymbol).filter(Boolean);
      return send(res, 200, { markets: marketStatus(), quotes: await quotes.get(syms) });
    }

    // 给 AI 看的接口说明
    if (p === '/api/docs') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'AI_API.md'), 'utf8'), 'text/markdown; charset=utf-8');
    }

    // 选手：查自己账户
    if (p === '/api/account' && req.method === 'GET') {
      const a = exchange.agentByToken(bearer(req));
      if (!a) return send(res, 401, { error: 'token 无效' });
      const v = await exchange.valuate(a.id);
      const acc = exchange.state.agents[a.id];
      return send(res, 200, { ...v, name: a.name, initialCash: config.initialCash, rules: config.rules, recentTrades: acc.trades.slice(-20).reverse() });
    }

    // 选手：下单
    if (p === '/api/order' && req.method === 'POST') {
      const a = exchange.agentByToken(bearer(req));
      if (!a) return send(res, 401, { error: 'token 无效' });
      const body = await readBody(req);
      try {
        const r = await exchange.placeOrder(a.id, body);
        if (body.reason) exchange.logDecision(a.id, { analysis: body.reason, orders: [{ ...body, ok: true, price: r.trade.price }] });
        return send(res, 200, r);
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message });
      }
    }

    // 管理：手动让某个 AI 立刻决策一次 / 重置比赛
    if (p.startsWith('/api/admin/')) {
      const adminToken = config.adminToken || process.env.ARENA_ADMIN_TOKEN;
      if (!adminToken || bearer(req) !== adminToken) return send(res, 401, { error: '需要 adminToken' });
      if (p === '/api/admin/run' && req.method === 'POST') {
        const { agentId } = await readBody(req);
        const a = config.agents.find((x) => x.id === agentId);
        if (!a?.llm) return send(res, 404, { error: '找不到该托管 AI' });
        return send(res, 200, await runner.runOnce(a, { force: true }));
      }
      if (p === '/api/admin/reset' && req.method === 'POST') {
        exchange.reset();
        await exchange.snapshot();
        return send(res, 200, { ok: true });
      }
    }

    // 静态页面
    if (req.method === 'GET') {
      const file = p === '/' ? 'index.html' : p.slice(1);
      const full = path.join(ROOT, 'docs', path.normalize(file));
      if (full.startsWith(path.join(ROOT, 'docs')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(full)] || 'application/octet-stream';
        return send(res, 200, fs.readFileSync(full), type + '; charset=utf-8');
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

const port = Number(process.env.PORT || config.port || 3000);
server.listen(port, async () => {
  console.log(`\n🏁 AI 炒股竞技场已启动：http://localhost:${port}`);
  console.log(`   配置文件：${path.basename(configPath)}   行情源：${quotes.source}   选手：${config.agents.map((a) => a.name).join('、')}`);
  await exchange.snapshot().catch((e) => console.warn('首次快照失败', e.message));
  setInterval(() => exchange.snapshot().catch((e) => console.warn('快照失败', e.message)), (config.snapshotSeconds || 60) * 1000);
  runner.start();
});
