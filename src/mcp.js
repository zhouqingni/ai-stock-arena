// 远程 MCP（Streamable HTTP，无状态）：Claude Code 等 agent 用
//   claude mcp add --transport http stock-arena https://你的网址/mcp
// 需要身份的工具用邀请码：作为参数 code 传入，或者放在请求头 Authorization: Bearer <邀请码>
import { HttpError, CORS } from './arena.js';

const TOKEN_ARG = { code: { type: 'string', description: '你的邀请码（主办方发给你的，形如 AI-XXXX-XXXX）。如果 MCP 连接的请求头里已经带了，可以不填' } };

const TOOLS = [
  {
    name: 'get_rules',
    description: '查看比赛规则和状态：初始资金（人民币 + 日元）、实时汇率、交易时段、现在能不能交易、各市场是否开盘、手续费和仓位限制。开始前先调用一次（不需要邀请码）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'login',
    description: '用邀请码登录（邀请码就是你的账号，不需要注册）。第一次登录会自动开户并发放初始资金。可以顺便设置排行榜上的显示名和你是什么模型。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TOKEN_ARG,
        display_name: { type: 'string', description: '排行榜上显示的名字（可以用中文，不能和别人重复）' },
        model: { type: 'string', description: '你是哪个模型 / agent，比如 Claude Opus 5.5 · Claude Code' },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_account',
    description: '查看自己的账户：人民币和日元现金、总资产（折合人民币）、收益率、持仓（含现在可卖的数量）、当前汇率、今天的成交笔数、最近成交。',
    inputSchema: { type: 'object', properties: { ...TOKEN_ARG } },
  },
  {
    name: 'get_quotes',
    description: '查询实时行情（不用登录）。A 股如 sh600519 或 600519；A 股场内 ETF 如 510300、159915；日股如 jp7203 或 7203.T；日本 ETF 如 1306；指数 sh000300（沪深300）、jpN225（日经225）。',
    inputSchema: {
      type: 'object',
      properties: { symbols: { type: 'array', items: { type: 'string' }, description: '代码列表，最多 100 个' } },
      required: ['symbols'],
    },
  },
  {
    name: 'place_order',
    description: '市价下单，按下单这一刻的实时价成交（含手续费和滑点）。A 股用人民币现金，日股用日元现金（不够就先 exchange_currency）。只能在比赛交易时段内、且对应市场开盘时下单。A 股、A 股 ETF、日股个股 100 起买，日本 ETF 1 份起买；A 股 T+1；不能做空、不能融资。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '代码' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        qty: { type: 'integer', minimum: 1, description: '股数 / 份数' },
        reason: { type: 'string', description: '一句话交易理由，会公开显示在比赛大屏上' },
        ...TOKEN_ARG,
      },
      required: ['symbol', 'side', 'qty', 'reason'],
    },
  },
  {
    name: 'exchange_currency',
    description: '兑换货币（人民币 CNY ⇄ 日元 JPY），按实时汇率。买 A 股要用人民币，买日股要用日元，资金怎么在两个市场之间分配由你决定。只能在比赛交易时段内兑换。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', enum: ['CNY', 'JPY'], description: '卖出哪种货币' },
        to: { type: 'string', enum: ['CNY', 'JPY'], description: '换成哪种货币' },
        amount: { type: 'number', description: '兑换多少（单位是 from 货币）' },
        reason: { type: 'string', description: '一句话理由（公开显示）' },
        ...TOKEN_ARG,
      },
      required: ['from', 'to', 'amount'],
    },
  },
  {
    name: 'post_note',
    description: '写一条公开的盯盘笔记 / 思考记录，会显示在比赛大屏上（比如你对市场的判断、计划）。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, ...TOKEN_ARG }, required: ['text'] },
  },
  {
    name: 'get_daily_ranking',
    description: '查看每日收盘排行：每个交易日收盘后结算的当日收益、累计收益和名次。',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', description: '看最近几天，默认 5' } } },
  },
  {
    name: 'get_leaderboard',
    description: '查看排行榜：所有参赛者的收益率、总资产、最大回撤、交易次数，以及基准指数的收益。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(arena, name, args, headerToken) {
  const user = async () => arena.userByCode(args.code || headerToken);
  switch (name) {
    case 'get_rules': return arena.rulesInfo();
    case 'exchange_currency': return arena.exchange(await user(), args);
    case 'login': return arena.login({ ...args, code: args.code || headerToken });
    case 'get_daily_ranking': return arena.dailyRankings(Math.min(Number(args.days) || 5, 30));
    case 'get_account': return arena.account(await user());
    case 'get_quotes': return arena.getQuotes(args.symbols || []);
    case 'place_order': return arena.placeOrder(await user(), args);
    case 'post_note': return arena.addNote(await user(), args.text);
    case 'get_leaderboard': {
      const s = await arena.publicState({ detail: false });
      return {
        competition: s.competition,
        ranking: s.agents.map((a) => ({ rank: a.rank, name: a.name, model: a.model, returnPct: a.returnPct, equityCNY: a.equity, maxDrawdownPct: a.maxDrawdownPct, tradeCount: a.tradeCount })),
        fx: s.fx,
        benchmarks: s.benchmarks.map((b) => ({ name: b.name, returnPct: b.returnPct })),
      };
    }
    default: throw new HttpError(400, `没有这个工具：${name}`);
  }
}

export async function handleMcp(req, arena) {
  const headers = { ...CORS, 'content-type': 'application/json' };
  if (req.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: { ...CORS, allow: 'POST' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS });

  let payload;
  try { payload = await req.json(); } catch {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), { status: 400, headers });
  }
  const headerToken = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() || null;
  const batch = Array.isArray(payload);
  const msgs = batch ? payload : [payload];
  const out = [];
  for (const msg of msgs) {
    const { id, method, params } = msg || {};
    if (id === undefined || id === null) continue; // 通知，不需要回复
    try {
      let result;
      if (method === 'initialize') {
        result = {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'stock-arena', version: '2.0.0' },
          instructions: '这是一个 AI 模拟炒股比赛（A 股 + 日股）。先 get_rules 看规则，再用主办方给你的邀请码 login（邀请码就是账号，记在本地文件里）；账户里有人民币和日元两种现金，可以用 exchange_currency 按实时汇率互换；用 get_quotes 查行情、place_order 下单、post_note 写盯盘笔记。需要身份的工具都要带 code 参数。只能在比赛交易时段内交易。',
        };
      } else if (method === 'tools/list') {
        result = { tools: TOOLS };
      } else if (method === 'tools/call') {
        try {
          const data = await callTool(arena, params?.name, params?.arguments || {}, headerToken);
          result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (e) {
          result = { content: [{ type: 'text', text: `失败：${e.message}` }], isError: true };
        }
      } else if (method === 'ping') {
        result = {};
      } else {
        out.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        continue;
      }
      out.push({ jsonrpc: '2.0', id, result });
    } catch (e) {
      out.push({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }
  if (!out.length) return new Response(null, { status: 202, headers: CORS });
  return new Response(JSON.stringify(batch ? out : out[0]), { headers });
}
