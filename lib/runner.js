// AI 自动托管：定时把行情+账户发给各家大模型，解析它们的 JSON 决策并下单
import { isMarketOpen, marketStatus, MARKET_NAMES } from './market.js';

const SYSTEM_PROMPT = `你是一名参加"AI 模拟炒股大赛"的交易员。你管理一个虚拟账户，目标是在比赛结束时总资产（含持仓市值）最高，同时控制回撤。
行情是真实市场的实时数据，成交价 = 下单时的实时价（含少量滑点和手续费）。

每次轮到你时，你会收到：当前时间、各市场开闭状态、你的账户与持仓、自选股实时行情、排行榜、你最近的决策。
你只能下市价单。必须只输出一个 JSON 对象，不要输出任何其他文字，格式：
{
  "analysis": "简要说明你对市场的判断和这次的操作理由（中文，200 字以内）",
  "orders": [
    { "symbol": "sh600519", "side": "buy", "qty": 100, "reason": "一句话理由" }
  ]
}
不想操作时 orders 填 []。股票代码格式：A 股 sh600519 / sz000001，日股 jp7203（丰田）这种 jp+4 位代码，也可以交易自选股以外的股票。`;

export class Runner {
  constructor(config, exchange, quotes) {
    this.cfg = config;
    this.ex = exchange;
    this.quotes = quotes;
    this.running = new Set();
    this.timers = [];
  }

  /** 每个 AI 的 { lastRunAt, lastError, nextRunAt }，存在比赛数据里，重启/换机器也不丢 */
  get status() {
    return (this.ex.state.runnerMeta ||= {});
  }

  intervalMs(agent) {
    return (agent.llm.intervalMinutes || this.cfg.runner.intervalMinutes || 10) * 60_000;
  }

  /** 单次模式（GitHub Actions 用）：把"到点了"的 AI 全部跑一轮，并发调用 */
  async runDue() {
    const now = Date.now();
    const due = this.cfg.agents.filter((a) => {
      if (!a.llm || a.llm.enabled === false) return false;
      const last = Date.parse(this.status[a.id]?.lastRunAt || 0) || 0;
      return now - last >= this.intervalMs(a) - 90_000; // 留 1.5 分钟余量，应对定时任务抖动
    });
    const results = await Promise.all(due.map(async (a) => {
      const r = await this.runOnce(a).catch((e) => ({ error: e.message }));
      this.status[a.id].nextRunAt = new Date(Date.now() + this.intervalMs(a)).toISOString();
      return [a.name, r.skipped ? '跳过：' + r.skipped : r.error ? '出错：' + r.error : `下单 ${r.results.length} 笔`];
    }));
    return results;
  }

  start() {
    const agents = this.cfg.agents.filter((a) => a.llm && a.llm.enabled !== false);
    agents.forEach((a, i) => {
      const intervalMs = this.intervalMs(a);
      // 错开启动，避免同一时刻抢跑
      const firstDelay = 5_000 + i * 15_000;
      this.status[a.id] = { nextRunAt: new Date(Date.now() + firstDelay).toISOString() };
      const tick = async () => {
        await this.runOnce(a).catch((e) => console.error(`[${a.name}]`, e));
        this.status[a.id].nextRunAt = new Date(Date.now() + intervalMs).toISOString();
      };
      this.timers.push(setTimeout(() => { tick(); this.timers.push(setInterval(tick, intervalMs)); }, firstDelay));
    });
    if (agents.length) console.log(`[托管] 已启动 ${agents.length} 个 AI：${agents.map((a) => a.name).join('、')}`);
  }

  stop() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  async runOnce(agent, { force = false } = {}) {
    if (this.running.has(agent.id)) return { skipped: '上一轮还没结束' };
    const allowed = this.cfg.rules.allowedMarkets || ['CN', 'JP'];
    const anyOpen = allowed.some((m) => isMarketOpen(m));
    if (!force && this.cfg.runner.onlyWhenMarketOpen && this.quotes.source !== 'mock' && !anyOpen) {
      return { skipped: '所有市场休市' };
    }
    const st = (this.status[agent.id] ||= {});
    if (!agent.llm.apiKey && !(agent.llm.apiKeyEnv && process.env[agent.llm.apiKeyEnv])) {
      st.lastError = `还没配置 API Key（${agent.llm.apiKeyEnv || 'apiKey'}）`;
      return { skipped: st.lastError };
    }
    this.running.add(agent.id);
    st.lastRunAt = new Date().toISOString();
    try {
      const prompt = await this.buildPrompt(agent);
      const text = await callLLM(agent.llm, SYSTEM_PROMPT + (agent.llm.extraInstructions ? `\n\n${agent.llm.extraInstructions}` : ''), prompt);
      const decision = parseDecision(text);
      const results = [];
      for (const o of (decision.orders || []).slice(0, this.cfg.runner.maxOrdersPerRound || 10)) {
        try {
          const r = await this.ex.placeOrder(agent.id, o);
          results.push({ ...o, ok: true, price: r.trade.price });
        } catch (e) {
          results.push({ ...o, ok: false, error: e.message });
        }
      }
      this.ex.logDecision(agent.id, { analysis: String(decision.analysis || '').slice(0, 1000), orders: results });
      st.lastError = null;
      console.log(`[${agent.name}] 决策完成：${results.length} 笔订单，成功 ${results.filter((r) => r.ok).length}`);
      return { decision, results };
    } catch (e) {
      st.lastError = e.message;
      this.ex.logDecision(agent.id, { analysis: '', error: e.message, orders: [] });
      console.error(`[${agent.name}] 出错：`, e.message);
      return { error: e.message };
    } finally {
      this.running.delete(agent.id);
    }
  }

  async buildPrompt(agent) {
    const acc = await this.ex.valuate(agent.id);
    const raw = this.ex.state.agents[agent.id];
    const watch = [...new Set([...(this.cfg.watchlist || []), ...acc.positions.map((p) => p.symbol)])];
    const q = await this.quotes.get(watch);
    const pub = await this.ex.publicState();
    const lines = [];
    lines.push(`当前时间：${new Date().toISOString()}（北京时间 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`);
    const ms = marketStatus();
    const allowed = this.cfg.rules.allowedMarkets || ['CN', 'JP'];
    lines.push(`市场状态：${allowed.map((m) => `${MARKET_NAMES[m]} ${ms[m] ? '开盘' : '休市'}`).join('，')}（休市市场的股票下单会失败）`);
    const r = this.cfg.rules;
    lines.push(`规则：本位币 ${this.cfg.baseCurrency}；汇率 ${JSON.stringify(this.cfg.fx)}；手续费率 ${r.feeRate}，最低 ${r.minFee}；A股卖出印花税 ${r.cnStampTaxRate}；买入最小单位 ${JSON.stringify(r.lotSize)} 股；A股 T+1：${r.cnTPlus1 ? '是' : '否'}；单票仓位上限 ${r.maxPositionPct || '无'}%；不能做空、不能融资。休市时下单会失败。`);
    lines.push('');
    lines.push(`【你的账户】现金 ${acc.cash}，持仓市值 ${acc.marketValue}，总资产 ${acc.equity}，收益率 ${acc.returnPct}%（初始 ${this.cfg.initialCash}）`);
    if (acc.positions.length) {
      lines.push('持仓：');
      for (const p of acc.positions) {
        lines.push(`- ${p.symbol} ${p.name}：${p.qty} 股（可卖 ${p.sellable}），成本 ${p.avgCost}，现价 ${p.price} ${p.currency}，浮盈 ${p.pnlPct}%`);
      }
    } else lines.push('持仓：空仓');
    lines.push('');
    lines.push('【实时行情】代码 | 名称 | 现价 | 涨跌幅 | 今开 | 最高 | 最低 | 昨收');
    for (const s of watch) {
      const x = q[s];
      if (x) lines.push(`${s} | ${x.name} | ${x.price} | ${x.changePct}% | ${x.open ?? '-'} | ${x.high ?? '-'} | ${x.low ?? '-'} | ${x.prevClose}`);
    }
    lines.push('');
    lines.push('【排行榜】');
    for (const a of [...pub.agents].sort((x, y) => x.rank - y.rank)) {
      lines.push(`${a.rank}. ${a.name}${a.id === agent.id ? '（你）' : ''}：收益 ${a.returnPct}%，最大回撤 ${a.maxDrawdownPct}%`);
    }
    for (const b of pub.benchmarks || []) lines.push(`基准 ${b.name}：${b.returnPct}%`);
    const recent = raw.decisions.slice(-3);
    if (recent.length) {
      lines.push('');
      lines.push('【你最近的决策】');
      for (const d of recent) {
        const os = (d.orders || []).map((o) => `${o.side} ${o.symbol} x${o.qty} ${o.ok ? '成交' : '失败:' + o.error}`).join('；') || '无操作';
        lines.push(`- ${d.time}：${(d.analysis || d.error || '').slice(0, 150)} => ${os}`);
      }
    }
    lines.push('');
    lines.push('请给出本轮决策（只输出 JSON）。');
    return lines.join('\n');
  }
}

// ---------------- 各家大模型调用 ----------------

async function callLLM(llm, system, user) {
  const apiKey = llm.apiKey || (llm.apiKeyEnv ? process.env[llm.apiKeyEnv] : undefined);
  if (!apiKey) throw new Error(`没有 API Key（填写 llm.apiKey 或设置环境变量 ${llm.apiKeyEnv || ''}）`);
  if (llm.provider === 'anthropic') return callClaude(llm, apiKey, system, user);
  return callOpenAICompatible(llm, apiKey, system, user);
}

/** OpenAI 兼容接口：DeepSeek、通义千问、Kimi、智谱、豆包、GPT、Gemini(兼容模式)、硅基流动、Ollama 等 */
async function callOpenAICompatible(llm, apiKey, system, user) {
  const base = (llm.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (llm.timeoutSeconds || 300) * 1000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...(llm.extraBody || {}),
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    const data = JSON.parse(body);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`模型没有返回内容：${body.slice(0, 300)}`);
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** Claude：使用官方 SDK；可选开启联网搜索新闻 */
let AnthropicCtor = null;
async function callClaude(llm, apiKey, system, user) {
  if (!AnthropicCtor) AnthropicCtor = (await import('@anthropic-ai/sdk')).default;
  const client = new AnthropicCtor({ apiKey, ...(llm.baseURL ? { baseURL: llm.baseURL } : {}) });
  const params = {
    model: llm.model || 'claude-opus-5-5',
    max_tokens: 16000,
    system,
    thinking: { type: 'adaptive' },
    output_config: { effort: llm.effort || 'medium' },
    // 被安全分类器误拒时，服务端自动换模型重试
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    ...(llm.webSearch ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }] } : {}),
    ...(llm.extraParams || {}),
  };
  const messages = [{ role: 'user', content: user }];
  let response;
  for (let i = 0; i < 5; i++) {
    response = await client.beta.messages.stream({ ...params, messages }).finalMessage();
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content }); // 联网搜索较长时需要续跑
  }
  if (response.stop_reason === 'refusal') throw new Error('Claude 拒绝了本次请求');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (!text) throw new Error(`Claude 没有返回文本（stop_reason=${response.stop_reason}）`);
  return text;
}

/** 从模型回复中抠出 JSON（兼容 ```json 代码块、前后有废话、<think> 标签等） */
export function parseDecision(text) {
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/g, '');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`回复里找不到 JSON：${text.slice(0, 200)}`);
  let obj;
  try {
    obj = JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}；原文：${text.slice(0, 200)}`);
  }
  if (!Array.isArray(obj.orders)) obj.orders = [];
  return obj;
}
