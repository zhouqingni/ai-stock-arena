// 虚拟交易所：账户、撮合（按实时价成交）、规则、净值快照、持久化
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSymbol, marketOf, currencyOf, isIndex, isMarketOpen, marketDate } from './market.js';

const round2 = (n) => Math.round(n * 100) / 100;

export class Exchange {
  constructor(config, quotes, dataFile) {
    this.cfg = config;
    this.quotes = quotes;
    this.dataFile = dataFile;
    this.saveTimer = null;
    this.lock = Promise.resolve(); // 下单串行化，避免并发导致资金算错
    this.state = this.load();
    this.syncAgents();
  }

  // ---------- 持久化 ----------
  load() {
    try {
      return JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
    } catch {
      return { startedAt: new Date().toISOString(), agents: {}, benchmarks: {} };
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  /** 立即写盘（GitHub Actions 单次运行结束前调用） */
  flush() {
    clearTimeout(this.saveTimer);
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    const tmp = this.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.dataFile);
  }

  /** 配置里新增的选手自动开户（已有的不动） */
  syncAgents() {
    for (const a of this.cfg.agents) {
      if (!this.state.agents[a.id]) {
        this.state.agents[a.id] = {
          id: a.id,
          cash: this.cfg.initialCash,
          positions: {},
          trades: [],
          decisions: [],
          equityHistory: [],
          createdAt: new Date().toISOString(),
        };
      }
    }
    this.save();
  }

  reset() {
    this.state = { startedAt: new Date().toISOString(), agents: {}, benchmarks: {} };
    this.syncAgents();
  }

  /** token 可写在 config 里，也可用环境变量 ARENA_TOKEN_<ID大写>（公开仓库里别写明文 token） */
  agentByToken(token) {
    if (!token) return null;
    return this.cfg.agents.find((a) => {
      const t = a.token || process.env['ARENA_TOKEN_' + a.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')];
      return t && t === token;
    }) || null;
  }

  fx(currency) {
    return this.cfg.fx?.[currency] ?? 1;
  }

  // ---------- 估值 ----------
  async valuate(agentId) {
    const acc = this.state.agents[agentId];
    const syms = Object.keys(acc.positions);
    const q = syms.length ? await this.quotes.get(syms) : {};
    let marketValue = 0;
    const positions = syms.map((s) => {
      const p = acc.positions[s];
      const price = q[s]?.price ?? p.lastPrice ?? p.avgCost;
      p.lastPrice = price;
      const cur = currencyOf(s);
      const value = p.qty * price * this.fx(cur);
      marketValue += value;
      return {
        symbol: s,
        name: q[s]?.name || p.name || s,
        qty: p.qty,
        sellable: this.sellableQty(s, p),
        avgCost: round2(p.avgCost),
        price,
        currency: cur,
        valueBase: round2(value),
        pnlPct: p.avgCost ? round2(((price - p.avgCost) / p.avgCost) * 100) : 0,
        changePct: q[s]?.changePct ?? null,
      };
    });
    const equity = acc.cash + marketValue;
    return {
      id: agentId,
      cash: round2(acc.cash),
      marketValue: round2(marketValue),
      equity: round2(equity),
      returnPct: round2(((equity - this.cfg.initialCash) / this.cfg.initialCash) * 100),
      positions: positions.sort((a, b) => b.valueBase - a.valueBase),
    };
  }

  sellableQty(sym, p) {
    if (marketOf(sym) === 'CN' && this.cfg.rules.cnTPlus1 && p.boughtDate === marketDate('CN')) {
      return Math.max(0, p.qty - (p.boughtToday || 0));
    }
    return p.qty;
  }

  // ---------- 下单 ----------
  /** 市价单：{ symbol, side: 'buy'|'sell', qty, reason } —— 以实时价 ± 滑点成交 */
  placeOrder(agentId, order) {
    const run = this.lock.then(() => this._placeOrder(agentId, order));
    this.lock = run.catch(() => {});
    return run;
  }

  async _placeOrder(agentId, { symbol, side, qty, reason }) {
    const acc = this.state.agents[agentId];
    if (!acc) throw new Error(`未知选手 ${agentId}`);
    const sym = normalizeSymbol(symbol);
    if (!sym) throw new Error(`无法识别的股票代码：${symbol}`);
    if (isIndex(sym)) throw new Error(`${sym} 是指数，不能直接交易`);
    side = String(side || '').toLowerCase();
    if (side !== 'buy' && side !== 'sell') throw new Error('side 必须是 buy 或 sell');
    qty = Math.floor(Number(qty));
    if (!(qty > 0)) throw new Error('qty 必须是正整数');

    const rules = this.cfg.rules;
    const mkt = marketOf(sym);
    if (rules.allowedMarkets && !rules.allowedMarkets.includes(mkt)) {
      throw new Error(`本场比赛不允许交易 ${mkt} 市场，允许：${rules.allowedMarkets.join(',')}`);
    }
    if (rules.enforceMarketHours && this.quotes.source !== 'mock' && !isMarketOpen(mkt)) {
      throw new Error(`${mkt} 市场当前休市，无法成交`);
    }
    const lot = rules.lotSize?.[mkt] || 1;
    if (side === 'buy' && lot > 1 && qty % lot !== 0) {
      throw new Error(`${mkt === 'JP' ? '日股' : 'A 股'}买入数量必须是 ${lot} 股的整数倍`);
    }

    const q = (await this.quotes.get([sym]))[sym];
    if (!q?.price) throw new Error(`拿不到 ${sym} 的实时价格（代码错误、停牌或数据源故障）`);
    if (q.ageSec > 120) throw new Error(`${sym} 行情已过期 ${q.ageSec}s，拒绝成交`);

    const slip = (rules.slippageBps || 0) / 10000;
    const price = side === 'buy' ? q.price * (1 + slip) : q.price * (1 - slip);
    const fx = this.fx(currencyOf(sym));
    const amountBase = price * qty * fx;
    let fee = Math.max(amountBase * (rules.feeRate || 0), amountBase > 0 ? rules.minFee || 0 : 0);
    if (side === 'sell' && mkt === 'CN') fee += amountBase * (rules.cnStampTaxRate || 0);
    fee = round2(fee);

    const today = marketDate(mkt);
    let p = acc.positions[sym];

    if (side === 'buy') {
      const cost = amountBase + fee;
      if (cost > acc.cash + 1e-6) {
        throw new Error(`现金不足：需要 ${round2(cost)}，可用 ${round2(acc.cash)}`);
      }
      if (rules.maxPositionPct) {
        const { equity } = await this.valuate(agentId);
        const after = ((p ? p.qty * q.price * fx : 0) + amountBase) / equity * 100;
        if (after > rules.maxPositionPct + 1e-6) {
          throw new Error(`单只股票仓位不能超过总资产 ${rules.maxPositionPct}%（买入后将达 ${round2(after)}%）`);
        }
      }
      acc.cash -= cost;
      if (!p) p = acc.positions[sym] = { qty: 0, avgCost: 0, name: q.name };
      p.avgCost = (p.avgCost * p.qty + price * qty) / (p.qty + qty);
      p.qty += qty;
      if (p.boughtDate !== today) { p.boughtDate = today; p.boughtToday = 0; }
      p.boughtToday += qty;
    } else {
      if (!p || p.qty <= 0) throw new Error(`没有持仓 ${sym}，不能卖出（不支持做空）`);
      const sellable = this.sellableQty(sym, p);
      if (qty > sellable) throw new Error(`可卖数量不足：持有 ${p.qty}，今日可卖 ${sellable}（A 股 T+1）`);
      acc.cash += amountBase - fee;
      p.qty -= qty;
      if (p.qty === 0) delete acc.positions[sym];
    }
    p && (p.lastPrice = q.price);

    const trade = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      time: new Date().toISOString(),
      agentId,
      symbol: sym,
      name: q.name,
      side,
      qty,
      price: +price.toFixed(4),
      currency: currencyOf(sym),
      amountBase: round2(amountBase),
      fee,
      reason: reason ? String(reason).slice(0, 500) : '',
    };
    acc.trades.push(trade);
    if (acc.trades.length > 2000) acc.trades.splice(0, acc.trades.length - 2000);
    this.save();
    return { ok: true, trade, cash: round2(acc.cash) };
  }

  logDecision(agentId, entry) {
    const acc = this.state.agents[agentId];
    if (!acc) return;
    acc.decisions.push({ time: new Date().toISOString(), ...entry });
    if (acc.decisions.length > 300) acc.decisions.splice(0, acc.decisions.length - 300);
    this.save();
  }

  // ---------- 净值快照 ----------
  async snapshot() {
    const t = Date.now();
    for (const id of Object.keys(this.state.agents)) {
      const v = await this.valuate(id);
      const h = this.state.agents[id].equityHistory;
      h.push([t, v.equity]);
      if (h.length > 20000) h.splice(0, h.length - 20000);
    }
    const bms = this.cfg.benchmarks || [];
    if (bms.length) {
      const st = (this.state.benchmarks ||= {});
      const q = await this.quotes.get(bms);
      for (const sym of bms) {
        if (!q[sym]?.price) continue;
        st[sym] ||= { symbol: sym, name: q[sym].name, startPrice: q[sym].price, history: [] };
        st[sym].history.push([t, q[sym].price]);
        if (st[sym].history.length > 20000) st[sym].history.splice(0, 1000);
      }
    }
    this.save();
  }

  // ---------- 排行榜（公开数据） ----------
  async publicState() {
    const agents = [];
    for (const a of this.cfg.agents) {
      const acc = this.state.agents[a.id];
      if (!acc) continue;
      const v = await this.valuate(a.id);
      let peak = this.cfg.initialCash, mdd = 0;
      for (const [, e] of acc.equityHistory) {
        peak = Math.max(peak, e);
        mdd = Math.max(mdd, (peak - e) / peak);
      }
      agents.push({
        ...v,
        name: a.name,
        model: a.llm ? `${a.llm.provider}/${a.llm.model}` : '外部接入 (API)',
        maxDrawdownPct: round2(mdd * 100),
        tradeCount: acc.trades.length,
        feesPaid: round2(acc.trades.reduce((s, t) => s + t.fee, 0)),
        trades: acc.trades.slice(-50).reverse(),
        decisions: acc.decisions.slice(-20).reverse(),
        equityHistory: downsample(acc.equityHistory, 600),
      });
    }
    const rank = [...agents].sort((x, y) => y.equity - x.equity).map((x) => x.id);
    agents.forEach((x) => { x.rank = rank.indexOf(x.id) + 1; });
    return {
      generatedAt: new Date().toISOString(),
      startedAt: this.state.startedAt,
      watchlist: this.cfg.watchlist || [],
      runner: this.state.runnerMeta || {},
      initialCash: this.cfg.initialCash,
      baseCurrency: this.cfg.baseCurrency,
      rules: this.cfg.rules,
      dataSource: this.quotes.source,
      quoteError: this.quotes.lastError,
      agents,
      benchmarks: (this.cfg.benchmarks || []).map((sym) => this.state.benchmarks?.[sym]).filter(Boolean).map((bm) => ({
        symbol: bm.symbol,
        name: bm.name,
        returnPct: bm.history.length ? round2(((bm.history.at(-1)[1] - bm.startPrice) / bm.startPrice) * 100) : 0,
        history: downsample(bm.history, 600).map(([t, p]) => [t, round2(this.cfg.initialCash * p / bm.startPrice)]),
      })),
    };
  }
}

function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr.at(-1));
  return out;
}
