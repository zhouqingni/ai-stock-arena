#!/usr/bin/env node
// MCP 工具服务器（stdio）：让 Claude Code / Cursor / Cherry Studio / Codex 等 agent 直接用工具炒股
// 环境变量：ARENA_URL（默认 http://localhost:3000）、ARENA_TOKEN（该选手在 config.json 里的 token）
import readline from 'node:readline';

const BASE = (process.env.ARENA_URL || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = process.env.ARENA_TOKEN || '';

const TOOLS = [
  {
    name: 'get_quotes',
    description: '查询股票实时行情。代码示例：A股 sh600519 或 600519；日股 jp7203 或 7203.T（丰田）；指数 sh000300（沪深300）、jpN225（日经225）。同时返回各市场是否开盘。',
    inputSchema: {
      type: 'object',
      properties: { symbols: { type: 'array', items: { type: 'string' }, description: '股票代码列表，最多 100 个' } },
      required: ['symbols'],
    },
  },
  {
    name: 'get_account',
    description: '查看自己的比赛账户：现金、总资产、收益率、持仓（含今日可卖数量）、比赛规则、最近成交。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'place_order',
    description: '下市价单，按实时价成交（含手续费和滑点）。不能做空、不能融资；A股和日股买入须为100股整数倍，A股T+1；休市时会失败。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        qty: { type: 'integer', minimum: 1, description: '股数' },
        reason: { type: 'string', description: '一句话交易理由，会展示在比赛大屏上' },
      },
      required: ['symbol', 'side', 'qty', 'reason'],
    },
  },
  {
    name: 'get_leaderboard',
    description: '查看排行榜：所有选手的收益率、最大回撤、交易次数，以及基准指数收益。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'get_quotes':
      return api(`/api/quote?symbols=${encodeURIComponent((args.symbols || []).join(','))}`);
    case 'get_account':
      return api('/api/account');
    case 'place_order':
      return api('/api/order', { method: 'POST', body: JSON.stringify(args) });
    case 'get_leaderboard': {
      const s = await api('/api/state');
      return {
        agents: s.agents.map((a) => ({ rank: a.rank, name: a.name, returnPct: a.returnPct, equity: a.equity, maxDrawdownPct: a.maxDrawdownPct, tradeCount: a.tradeCount })).sort((x, y) => x.rank - y.rank),
        benchmarks: (s.benchmarks || []).map((b) => ({ name: b.name, returnPct: b.returnPct })),
        markets: s.markets,
      };
    }
    default:
      throw new Error(`未知工具 ${name}`);
  }
}

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // 通知类消息无需回复
  try {
    let result;
    if (method === 'initialize') {
      result = {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-stock-arena', version: '1.0.0' },
        instructions: '你在参加 AI 模拟炒股比赛，用这些工具查行情、看账户、下单。目标：总资产最高且回撤可控。',
      };
    } else if (method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (method === 'tools/call') {
      try {
        const data = await callTool(params.name, params.arguments);
        result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (e) {
        result = { content: [{ type: 'text', text: `失败：${e.message}` }], isError: true };
      }
    } else if (method === 'ping') {
      result = {};
    } else {
      return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
    write({ jsonrpc: '2.0', id, result });
  } catch (e) {
    write({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});
