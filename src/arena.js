// 比赛交易所：一个 Durable Object（单实例、自带 SQLite），所有参赛者、资金、成交都在这里
// 多币种账户：人民币买 A 股，日元买日股，可以按实时汇率互相兑换；排名按计价货币（默认人民币）折算
import { DurableObject } from 'cloudflare:workers';
import {
  QuoteService, normalizeSymbol, marketOf, currencyOf, isIndex, isFund, isMarketOpen, marketDate, marketStatus, MARKET_NAMES, localParts,
} from './market.js';
import { handleMcp } from './mcp.js';
import { agentDoc } from './agent-doc.js';

export const CURRENCIES = ['CNY', 'JPY'];
export const CUR_NAMES = { CNY: '人民币', JPY: '日元' };

export const DEFAULT_SETTINGS = {
  title: 'AI 炒股竞技场',
  initialCash: { CNY: 30_000, JPY: 500_000 },
  baseCurrency: 'CNY', // 排名用的计价货币
  fx: { JPY: 0.047 }, // 备用汇率（1 单位外币 = 多少人民币），拿不到实时汇率时用
  fxLive: true, // 用实时汇率（Yahoo Finance JPYCNY=X）
  allowedMarkets: ['CN', 'JP'],
  enforceMarketHours: true,
  // 比赛交易时段：只有在这个时间窗内才能下单和兑换（下单还要求对应市场开盘）
  tradingWindow: { enabled: true, start: '10:00', end: '12:00', timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5] },
  competitionStart: null, // ISO 时间；之前可以登录但不能交易
  competitionEnd: null, // ISO 时间；之后停止交易，排名定格
  rules: {
    feeRate: 0.0003,
    minFee: { CNY: 5, JPY: 100 },
    cnStampTaxRate: 0.0005,
    cnTPlus1: true,
    slippageBps: 5,
    fxFeeBps: 0, // 兑换手续费（基点），0 = 完全按实时汇率
    maxPositionPct: 60,
    lotSize: { CN: 100, JP: 100, JP_FUND: 1 }, // 日本 ETF 大多 1 份起买
    maxOrdersPerDay: 50,
  },
  benchmarks: ['sh000300', 'jpN225'],
  watchlist: ['sh510300', 'sh510500', 'sz159915', 'sh588000', 'sh518880', 'sh513100', 'jp1306', 'jp1321',
    'sh600519', 'sh601318', 'sz000858', 'sz300750', 'sh600036', 'sz002594', 'sh601899', 'sz000333',
    'jp7203', 'jp6758', 'jp8306', 'jp9984', 'jp6861', 'jp8035', 'jp9983', 'jp7974'],
  dataSource: 'auto',
  snapshotMinutes: 5,
};

const round2 = (n) => Math.round(n * 100) / 100;
const nowIso = () => new Date().toISOString();
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}
function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr.at(-1));
  return out;
}
const money = (n, cur) => `${cur === 'JPY' ? '¥' : '￥'}${Math.round(n).toLocaleString()}${cur === 'JPY' ? ' 日元' : ' 元'}`;

export class Arena extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.settings = this.loadSettings();
      this.quotes = new QuoteService({ source: env.DATA_SOURCE || this.settings.dataSource, cacheSeconds: 5 });
      if (!this.getMeta('baseRates')) await this.setBaseRates(await this.rates()); // 旧数据升级：补上统一的起始汇率
      if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, code TEXT UNIQUE, label TEXT, display_name TEXT, model TEXT,
        initial_base REAL, created_at TEXT, activated_at TEXT, last_seen TEXT, disabled INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cash (user_id TEXT, currency TEXT, amount REAL, PRIMARY KEY (user_id, currency));
      CREATE TABLE IF NOT EXISTS positions (
        user_id TEXT, symbol TEXT, name TEXT, qty INTEGER, avg_cost REAL, last_price REAL,
        bought_date TEXT, bought_today INTEGER, PRIMARY KEY (user_id, symbol));
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, time TEXT, symbol TEXT, name TEXT, side TEXT,
        qty INTEGER, price REAL, currency TEXT, amount REAL, amount_base REAL, fee REAL, reason TEXT);
      CREATE INDEX IF NOT EXISTS trades_user ON trades (user_id, id);
      CREATE TABLE IF NOT EXISTS fx_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, time TEXT, from_cur TEXT, to_cur TEXT,
        amount_from REAL, amount_to REAL, rate REAL, reason TEXT);
      CREATE TABLE IF NOT EXISTS equity (user_id TEXT, t INTEGER, v REAL);
      CREATE INDEX IF NOT EXISTS equity_user ON equity (user_id, t);
      CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, time TEXT, text TEXT);
      CREATE INDEX IF NOT EXISTS notes_user ON notes (user_id, id);
      CREATE TABLE IF NOT EXISTS bench (symbol TEXT, t INTEGER, price REAL);
      CREATE TABLE IF NOT EXISTS daily (
        date TEXT, user_id TEXT, name TEXT, model TEXT, equity REAL, day_pct REAL, total_pct REAL,
        rank INTEGER, day_rank INTEGER, trades INTEGER, PRIMARY KEY (date, user_id));
    `);
    if (!this.getMeta('startedAt')) this.setMeta('startedAt', nowIso());
  }

  getMeta(k) {
    return this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v ?? null;
  }
  setMeta(k, v) {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }
  loadSettings() {
    const saved = this.getMeta('settings');
    return deepMerge(DEFAULT_SETTINGS, saved ? JSON.parse(saved) : {});
  }

  // ---------------- 汇率 ----------------
  /** 返回每种货币折合计价货币的汇率，例如 { CNY: 1, JPY: 0.0471 }（计价货币为人民币时） */
  async rates() {
    let jpycny = null; // 1 日元 = ? 人民币
    let source = 'fallback';
    if (this.settings.fxLive) {
      // 用“人民币兑日元”（约 21~24，有效数字多）再取倒数，比直接取“日元兑人民币”（只给到 0.042）精确得多
      const q = (await this.quotes.get(['fxCNYJPY'])).fxCNYJPY;
      if (q?.price > 0 && q.ageSec < 3600) {
        jpycny = 1 / q.price;
        source = 'live';
        this.setMeta('lastFx', String(jpycny));
      } else if (Number(this.getMeta('lastFx')) > 0) {
        jpycny = Number(this.getMeta('lastFx'));
        source = 'last';
      }
    }
    jpycny ||= this.settings.fx?.JPY || 0.047;
    const inCny = { CNY: 1, JPY: jpycny };
    const base = this.settings.baseCurrency;
    const out = Object.fromEntries(CURRENCIES.map((c) => [c, inCny[c] / inCny[base]]));
    return { ...out, JPYCNY: jpycny, CNYJPY: 1 / jpycny, source };
  }

  // ---------------- 比赛时间 ----------------
  windowOpen(now = new Date()) {
    const w = this.settings.tradingWindow;
    if (!w?.enabled) return true;
    const { weekday, minutes } = localParts(w.timezone || 'Asia/Shanghai', now);
    if (w.weekdays && !w.weekdays.includes(WEEKDAY[weekday])) return false;
    const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
    return minutes >= toMin(w.start) && minutes < toMin(w.end);
  }

  competitionStatus(now = new Date()) {
    const s = this.settings;
    const w = s.tradingWindow;
    const windowText = w?.enabled ? `每${w.weekdays?.length === 5 ? '个工作日' : '天'} ${w.start}–${w.end}（${w.timezone === 'Asia/Shanghai' ? '北京时间' : w.timezone}）` : '各市场开盘时间内随时';
    let status = 'running';
    let message = `比赛进行中，交易时段：${windowText}`;
    if (s.competitionStart && now < new Date(s.competitionStart)) {
      status = 'pending';
      message = `比赛将于 ${new Date(s.competitionStart).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）开始，现在可以先登录`;
    } else if (s.competitionEnd && now >= new Date(s.competitionEnd)) {
      status = 'ended';
      message = '比赛已结束，排名已定格';
    }
    const windowOpenNow = this.windowOpen(now);
    const markets = marketStatus(now);
    const tradableMarkets = s.allowedMarkets.filter((m) => !s.enforceMarketHours || markets[m]);
    const canTradeNow = status === 'running' && windowOpenNow && tradableMarkets.length > 0;
    return { status, message, windowText, windowOpenNow, canTradeNow, tradableMarkets, markets };
  }

  assertInWindow() {
    const st = this.competitionStatus();
    if (st.status !== 'running') throw new HttpError(403, st.message);
    if (!st.windowOpenNow) throw new HttpError(403, `现在不在比赛交易时段（${st.windowText}）`);
  }

  assertCanTrade(sym) {
    this.assertInWindow();
    const mkt = marketOf(sym);
    if (!this.settings.allowedMarkets.includes(mkt)) throw new HttpError(400, `本场比赛不允许交易${MARKET_NAMES[mkt] || mkt}`);
    if (this.settings.enforceMarketHours && this.quotes.source !== 'mock' && !isMarketOpen(mkt)) {
      throw new HttpError(403, `${MARKET_NAMES[mkt]}当前休市`);
    }
  }

  // ---------------- 现金 ----------------
  cashOf(userId) {
    const out = Object.fromEntries(CURRENCIES.map((c) => [c, 0]));
    for (const r of this.sql.exec('SELECT currency, amount FROM cash WHERE user_id = ?', userId).toArray()) out[r.currency] = r.amount;
    return out;
  }
  addCash(userId, cur, delta) {
    this.sql.exec('INSERT INTO cash (user_id, currency, amount) VALUES (?, ?, ?) ON CONFLICT(user_id, currency) DO UPDATE SET amount = ROUND(amount + excluded.amount, 2)', userId, cur, round2(delta));
  }
  initialBase(rates) {
    return Object.entries(this.settings.initialCash).reduce((s, [c, v]) => s + v * (rates[c] ?? 0), 0);
  }
  /**
   * 比赛起始汇率：所有人的初始资金都按这一个汇率折算，作为收益率的基准。
   * 这样谁先登录、谁后登录都一样，之后汇率涨跌对所有人的影响也一样。
   * 在比赛重置时重新确定；设置时把已开户的人的基准一起改掉。
   */
  baseRates() {
    return JSON.parse(this.getMeta('baseRates'));
  }
  async setBaseRates(rates) {
    const fixed = Object.fromEntries(CURRENCIES.map((c) => [c, rates[c]]));
    this.setMeta('baseRates', JSON.stringify(fixed));
    const base = round2(this.initialBase(fixed));
    this.sql.exec('UPDATE users SET initial_base = ? WHERE activated_at IS NOT NULL', base);
  }

  /** 开户 / 重置：发放初始资金，基准总资产按比赛起始汇率折算（人人相同） */
  fundAccount(userId) {
    this.sql.exec('DELETE FROM cash WHERE user_id = ?', userId);
    for (const [c, v] of Object.entries(this.settings.initialCash)) this.addCash(userId, c, v);
    const base = round2(this.initialBase(this.baseRates()));
    this.sql.exec('UPDATE users SET initial_base = ? WHERE id = ?', base, userId);
    this.sql.exec('INSERT INTO equity (user_id, t, v) VALUES (?, ?, ?)', userId, Date.now(), base);
  }

  // ---------------- 参赛者：邀请码就是账号 ----------------
  static normCode(code) {
    return String(code || '').trim().toUpperCase();
  }

  /** 用邀请码找人；第一次使用时自动开户 */
  async userByCode(code) {
    code = Arena.normCode(code);
    if (!code) throw new HttpError(401, '需要邀请码：请求头加 Authorization: Bearer <邀请码>');
    let u = this.sql.exec('SELECT * FROM users WHERE code = ?', code).toArray()[0];
    if (!u) throw new HttpError(401, '邀请码不对');
    if (u.disabled) throw new HttpError(403, '这个邀请码已被主办方停用');
    if (!u.activated_at) {
      this.sql.exec('UPDATE users SET activated_at = ? WHERE id = ?', nowIso(), u.id);
      this.fundAccount(u.id);
      u = this.sql.exec('SELECT * FROM users WHERE id = ?', u.id).one();
    }
    this.sql.exec('UPDATE users SET last_seen = ? WHERE id = ?', nowIso(), u.id);
    return u;
  }

  /** 登录（可顺便设置显示名和模型） */
  async login({ code, display_name, model } = {}) {
    const row = this.sql.exec('SELECT id, activated_at FROM users WHERE code = ?', Arena.normCode(code)).toArray()[0];
    const first = !row?.activated_at;
    const wanted = String(display_name || '').trim().slice(0, 30);
    if (row && wanted && this.sql.exec('SELECT 1 FROM users WHERE display_name = ? AND id != ?', wanted, row.id).toArray().length) {
      throw new HttpError(409, `名字「${wanted}」已经有人用了，换一个`);
    }
    const u = await this.userByCode(code);
    if (display_name || model) this.updateProfile(u, { display_name, model });
    const v = this.sql.exec('SELECT * FROM users WHERE id = ?', u.id).one();
    const init = Object.entries(this.settings.initialCash).map(([c, n]) => money(n, c)).join(' + ');
    return {
      ok: true,
      firstLogin: first,
      display_name: v.display_name,
      model: v.model,
      cash: this.cashOf(u.id),
      message: (first ? `欢迎参赛！已发放初始资金 ${init}。` : '登录成功。')
        + '之后每个请求都在请求头带上 Authorization: Bearer <你的邀请码>。'
        + (v.display_name === v.label ? '你还可以用 display_name 和 model 参数给自己起名、写上你是什么模型。' : ''),
    };
  }

  updateProfile(u, { display_name, model } = {}) {
    if (display_name !== undefined && String(display_name).trim()) {
      const name = String(display_name).trim().slice(0, 30);
      if (this.sql.exec('SELECT 1 FROM users WHERE display_name = ? AND id != ?', name, u.id).toArray().length) throw new HttpError(409, `名字「${name}」已经有人用了，换一个`);
      this.sql.exec('UPDATE users SET display_name = ? WHERE id = ?', name, u.id);
    }
    if (model !== undefined && String(model).trim()) this.sql.exec('UPDATE users SET model = ? WHERE id = ?', String(model).trim().slice(0, 60), u.id);
    return { ok: true };
  }

  /** 管理员生成邀请码，labels 是备注（比如“Claude”），也会作为默认显示名 */
  createInvites({ count = 1, labels = [] } = {}) {
    const n = Math.min(Math.max(Number(count) || labels.length || 1, labels.length), 50);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const made = [];
    for (let i = 0; i < n; i++) {
      const raw = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => alphabet[b % alphabet.length]).join('');
      const code = `AI-${raw.slice(0, 4)}-${raw.slice(4)}`;
      const id = 'p' + hex(crypto.getRandomValues(new Uint8Array(4)));
      let label = String(labels[i] || '').trim().slice(0, 30) || `选手${this.sql.exec('SELECT COUNT(*) AS n FROM users').one().n + 1}`;
      if (this.sql.exec('SELECT 1 FROM users WHERE display_name = ?', label).toArray().length) label += '-' + id.slice(1, 4);
      this.sql.exec('INSERT INTO users (id, code, label, display_name, model, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, code, label, label, '', nowIso());
      made.push({ id, code, label });
    }
    return { ok: true, invites: made };
  }

  listInvites() {
    return this.sql.exec('SELECT id, code, label, display_name, model, created_at, activated_at, last_seen, disabled FROM users ORDER BY created_at').toArray();
  }

  // ---------------- 估值 ----------------
  positionsOf(userId) {
    return this.sql.exec('SELECT * FROM positions WHERE user_id = ?', userId).toArray();
  }

  sellable(p) {
    if (marketOf(p.symbol) === 'CN' && this.settings.rules.cnTPlus1 && p.bought_date === marketDate('CN')) {
      return Math.max(0, p.qty - (p.bought_today || 0));
    }
    return p.qty;
  }

  /** 估值：现金按币种列出，总资产按计价货币折算 */
  valuate(user, q, rates) {
    const cash = this.cashOf(user.id);
    let marketValue = 0;
    const positions = this.positionsOf(user.id).map((p) => {
      const price = q[p.symbol]?.price ?? p.last_price ?? p.avg_cost;
      const cur = currencyOf(p.symbol);
      const value = p.qty * price;
      const valueBase = value * rates[cur];
      marketValue += valueBase;
      return {
        symbol: p.symbol, name: q[p.symbol]?.name || p.name || p.symbol, qty: p.qty, sellable: this.sellable(p),
        avgCost: +p.avg_cost.toFixed(3), price, currency: cur, value: round2(value), valueBase: round2(valueBase),
        pnlPct: p.avg_cost ? round2(((price - p.avg_cost) / p.avg_cost) * 100) : 0,
        changePct: q[p.symbol]?.changePct ?? null,
      };
    }).sort((a, b) => b.valueBase - a.valueBase);
    const cashBase = CURRENCIES.reduce((s, c) => s + cash[c] * rates[c], 0);
    const equity = cashBase + marketValue;
    const init = user.initial_base || this.initialBase(rates);
    return {
      cash: Object.fromEntries(CURRENCIES.map((c) => [c, round2(cash[c])])),
      cashBase: round2(cashBase), marketValue: round2(marketValue), equity: round2(equity),
      initialBase: round2(init), returnPct: round2(((equity - init) / init) * 100), positions,
    };
  }

  async quotesFor(symbols) {
    const syms = [...new Set(symbols)];
    return syms.length ? this.quotes.get(syms) : {};
  }

  async account(user) {
    const [q, rates] = await Promise.all([this.quotesFor(this.positionsOf(user.id).map((p) => p.symbol)), this.rates()]);
    const v = this.valuate(user, q, rates);
    return {
      display_name: user.display_name, model: user.model, baseCurrency: this.settings.baseCurrency,
      initialCash: this.settings.initialCash, ...v,
      fxRate: { JPYCNY: rates.JPYCNY, CNYJPY: rates.CNYJPY, source: rates.source },
      ordersToday: this.ordersToday(user.id),
      recentTrades: this.sql.exec('SELECT * FROM trades WHERE user_id = ? ORDER BY id DESC LIMIT 20', user.id).toArray().map(this.tradeOut),
      recentExchanges: this.sql.exec('SELECT * FROM fx_trades WHERE user_id = ? ORDER BY id DESC LIMIT 10', user.id).toArray().map(this.fxOut),
      competition: this.competitionStatus(),
    };
  }

  ordersToday(userId, day = marketDate('CN')) {
    return this.sql.exec('SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND substr(time, 1, 10) >= ?', userId, day).one().n;
  }

  tradeOut(t) {
    return { id: t.id, time: t.time, symbol: t.symbol, name: t.name, side: t.side, qty: t.qty, price: t.price, currency: t.currency, amount: t.amount, amountBase: t.amount_base, fee: t.fee, reason: t.reason };
  }
  fxOut(x) {
    return { id: x.id, time: x.time, from: x.from_cur, to: x.to_cur, amountFrom: x.amount_from, amountTo: x.amount_to, rate: x.rate, reason: x.reason };
  }

  // ---------------- 下单 ----------------
  async placeOrder(user, { symbol, side, qty, reason } = {}) {
    const sym = normalizeSymbol(symbol);
    if (!sym) throw new HttpError(400, `无法识别的代码：${symbol}（A 股如 sh600519，ETF 如 510300，日股如 jp7203）`);
    if (isIndex(sym)) throw new HttpError(400, `${sym} 是指数，不能交易`);
    side = String(side || '').toLowerCase();
    if (side !== 'buy' && side !== 'sell') throw new HttpError(400, 'side 必须是 buy 或 sell');
    qty = Math.floor(Number(qty));
    if (!(qty > 0)) throw new HttpError(400, 'qty 必须是正整数');
    this.assertCanTrade(sym);
    const r = this.settings.rules;
    const mkt = marketOf(sym);
    const cur = currencyOf(sym);
    const fund = isFund(sym);
    const lot = (fund && mkt === 'JP' ? r.lotSize?.JP_FUND : r.lotSize?.[mkt]) || 1;
    if (side === 'buy' && lot > 1 && qty % lot !== 0) throw new HttpError(400, `${MARKET_NAMES[mkt]}${fund ? '基金' : ''}买入数量必须是 ${lot} 的整数倍`);
    if (r.maxOrdersPerDay && this.ordersToday(user.id) >= r.maxOrdersPerDay) throw new HttpError(429, `今天已经成交 ${r.maxOrdersPerDay} 笔，达到每日上限`);

    // 先拿行情和汇率（异步），之后的检查和记账全部同步完成，保证不会并发算错
    const held = this.positionsOf(user.id).map((p) => p.symbol);
    const [q, rates] = await Promise.all([this.quotes.get([sym, ...held]), this.rates()]);
    const quote = q[sym];
    if (!quote?.price) throw new HttpError(503, `拿不到 ${sym} 的实时价格（代码错误、停牌或行情源故障）`);
    if (quote.ageSec > 120) throw new HttpError(503, `${sym} 行情已过期，请稍后再试`);

    const cash = this.cashOf(user.id); // 重新读，拿最新现金
    const slip = (r.slippageBps || 0) / 10000;
    const price = side === 'buy' ? quote.price * (1 + slip) : quote.price * (1 - slip);
    const amount = price * qty;
    const minFee = typeof r.minFee === 'object' ? r.minFee[cur] || 0 : r.minFee || 0;
    let fee = Math.max(amount * (r.feeRate || 0), minFee);
    if (side === 'sell' && mkt === 'CN' && !fund) fee += amount * (r.cnStampTaxRate || 0); // 场内基金免印花税
    fee = round2(fee);
    const today = marketDate(mkt);
    const p = this.sql.exec('SELECT * FROM positions WHERE user_id = ? AND symbol = ?', user.id, sym).toArray()[0];

    if (side === 'buy') {
      const cost = amount + fee;
      if (cost > cash[cur] + 1e-6) {
        throw new HttpError(400, `${CUR_NAMES[cur]}现金不足：需要 ${money(cost, cur)}，可用 ${money(cash[cur], cur)}（可以先用 exchange 兑换货币）`);
      }
      if (r.maxPositionPct) {
        const v = this.valuate(user, q, rates);
        const after = (((p?.qty || 0) * quote.price + amount) * rates[cur] / v.equity) * 100;
        if (after > r.maxPositionPct + 1e-6) throw new HttpError(400, `单只股票仓位不能超过总资产 ${r.maxPositionPct}%（买入后将达到 ${round2(after)}%）`);
      }
      this.addCash(user.id, cur, -cost);
      if (p) {
        const newQty = p.qty + qty;
        const boughtToday = (p.bought_date === today ? p.bought_today || 0 : 0) + qty;
        this.sql.exec('UPDATE positions SET qty = ?, avg_cost = ?, last_price = ?, bought_date = ?, bought_today = ?, name = ? WHERE user_id = ? AND symbol = ?',
          newQty, (p.avg_cost * p.qty + price * qty) / newQty, quote.price, today, boughtToday, quote.name, user.id, sym);
      } else {
        this.sql.exec('INSERT INTO positions (user_id, symbol, name, qty, avg_cost, last_price, bought_date, bought_today) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          user.id, sym, quote.name, qty, price, quote.price, today, qty);
      }
    } else {
      if (!p || p.qty <= 0) throw new HttpError(400, `没有持有 ${sym}，不能卖出（不支持做空）`);
      const can = this.sellable(p);
      if (qty > can) throw new HttpError(400, `可卖数量不足：持有 ${p.qty}，现在可卖 ${can}${can < p.qty ? '（A 股 T+1，今天买的明天才能卖）' : ''}`);
      this.addCash(user.id, cur, amount - fee);
      if (p.qty === qty) this.sql.exec('DELETE FROM positions WHERE user_id = ? AND symbol = ?', user.id, sym);
      else this.sql.exec('UPDATE positions SET qty = qty - ?, last_price = ? WHERE user_id = ? AND symbol = ?', qty, quote.price, user.id, sym);
    }
    const row = this.sql.exec(
      'INSERT INTO trades (user_id, time, symbol, name, side, qty, price, currency, amount, amount_base, fee, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
      user.id, nowIso(), sym, quote.name, side, qty, +price.toFixed(4), cur, round2(amount), round2(amount * rates[cur]), fee, String(reason || '').slice(0, 500),
    ).one();
    return { ok: true, trade: this.tradeOut(row), cash: this.cashOf(user.id) };
  }

  // ---------------- 兑换货币 ----------------
  /** { from: 'CNY', to: 'JPY', amount: 10000 }：卖出 amount 的 from 货币，按实时汇率换成 to 货币 */
  async exchange(user, { from, to, amount, reason } = {}) {
    from = String(from || '').toUpperCase();
    to = String(to || '').toUpperCase();
    if (!CURRENCIES.includes(from) || !CURRENCIES.includes(to) || from === to) throw new HttpError(400, `from / to 只能是 ${CURRENCIES.join(' 或 ')}，而且不能相同`);
    amount = Number(amount);
    if (!(amount > 0)) throw new HttpError(400, 'amount 必须大于 0（单位是 from 货币）');
    this.assertInWindow();
    const rates = await this.rates();
    const cash = this.cashOf(user.id);
    if (amount > cash[from] + 1e-6) throw new HttpError(400, `${CUR_NAMES[from]}不够：想兑换 ${money(amount, from)}，可用 ${money(cash[from], from)}`);
    const rate = rates[from] / rates[to]; // 1 from = rate to
    const got = round2(amount * rate * (1 - (this.settings.rules.fxFeeBps || 0) / 10000));
    this.addCash(user.id, from, -amount);
    this.addCash(user.id, to, got);
    const row = this.sql.exec('INSERT INTO fx_trades (user_id, time, from_cur, to_cur, amount_from, amount_to, rate, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
      user.id, nowIso(), from, to, round2(amount), got, rate, String(reason || '').slice(0, 300)).one();
    return { ok: true, exchange: this.fxOut(row), rateSource: rates.source, cash: this.cashOf(user.id) };
  }

  addNote(user, text) {
    text = String(text || '').trim();
    if (!text) throw new HttpError(400, 'text 不能为空');
    const recent = this.sql.exec('SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND time > ?', user.id, new Date(Date.now() - 3600_000).toISOString()).one().n;
    if (recent >= 30) throw new HttpError(429, '一小时内最多写 30 条笔记');
    this.sql.exec('INSERT INTO notes (user_id, time, text) VALUES (?, ?, ?)', user.id, nowIso(), text.slice(0, 2000));
    return { ok: true };
  }

  // ---------------- 行情（公开） ----------------
  async getQuotes(symbols) {
    const syms = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))].slice(0, 100);
    const [quotes, rates] = await Promise.all([this.quotes.get(syms), this.rates()]);
    return { markets: marketStatus(), fx: { JPYCNY: rates.JPYCNY, CNYJPY: rates.CNYJPY, source: rates.source }, quotes };
  }

  // ---------------- 排行榜（公开） ----------------
  activeUsers() {
    return this.sql.exec('SELECT * FROM users WHERE disabled = 0 AND activated_at IS NOT NULL').toArray();
  }

  async publicState({ detail = true } = {}) {
    const s = this.settings;
    const users = this.activeUsers();
    const allSyms = this.sql.exec('SELECT DISTINCT symbol FROM positions').toArray().map((r) => r.symbol);
    const [q, rates] = await Promise.all([this.quotesFor(allSyms), this.rates()]);
    const agents = [];
    for (const u of users) {
      const v = this.valuate(u, q, rates);
      const hist = this.sql.exec('SELECT t, v FROM equity WHERE user_id = ? ORDER BY t', u.id).toArray().map((r) => [r.t, r.v]);
      hist.push([Date.now(), v.equity]);
      let peak = v.initialBase;
      let mdd = 0;
      for (const [, e] of hist) { peak = Math.max(peak, e); mdd = Math.max(mdd, (peak - e) / peak); }
      const stats = this.sql.exec('SELECT COUNT(*) AS n FROM trades WHERE user_id = ?', u.id).one();
      const a = {
        id: u.id, name: u.display_name, model: u.model || '', createdAt: u.activated_at, lastSeen: u.last_seen,
        ...v, maxDrawdownPct: round2(mdd * 100), tradeCount: stats.n,
      };
      if (detail) {
        a.equityHistory = downsample(hist, 500).map(([t, e]) => [t, round2(((e - v.initialBase) / v.initialBase) * 100)]);
        a.trades = this.sql.exec('SELECT * FROM trades WHERE user_id = ? ORDER BY id DESC LIMIT 50', u.id).toArray().map(this.tradeOut);
        a.exchanges = this.sql.exec('SELECT * FROM fx_trades WHERE user_id = ? ORDER BY id DESC LIMIT 20', u.id).toArray().map(this.fxOut);
        a.notes = this.sql.exec('SELECT time, text FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 30', u.id).toArray();
      }
      agents.push(a);
    }
    agents.sort((x, y) => y.returnPct - x.returnPct).forEach((a, i) => { a.rank = i + 1; });
    const benchmarks = [];
    for (const sym of s.benchmarks || []) {
      const rows = this.sql.exec('SELECT t, price FROM bench WHERE symbol = ? ORDER BY t', sym).toArray();
      const start = Number(this.getMeta('benchStart:' + sym));
      if (!rows.length || !start) continue;
      benchmarks.push({
        symbol: sym, name: this.getMeta('benchName:' + sym) || sym,
        returnPct: round2(((rows.at(-1).price - start) / start) * 100),
        history: detail ? downsample(rows.map((r) => [r.t, round2(((r.price - start) / start) * 100)]), 500) : undefined,
      });
    }
    return {
      generatedAt: nowIso(),
      title: s.title,
      startedAt: this.getMeta('startedAt'),
      initialCash: s.initialCash,
      baseCurrency: s.baseCurrency,
      fx: { JPYCNY: rates.JPYCNY, CNYJPY: rates.CNYJPY, source: rates.source },
      allowedMarkets: s.allowedMarkets,
      rules: s.rules,
      competition: this.competitionStatus(),
      dataSource: this.quotes.source,
      quoteError: this.quotes.lastError,
      markets: marketStatus(),
      watchlist: s.watchlist,
      agents,
      benchmarks,
      daily: this.dailyRankings(),
    };
  }

  // ---------------- 定时任务：记录净值、每日结算 ----------------
  async alarm() {
    try {
      const s = this.settings;
      const open = s.allowedMarkets.some((m) => isMarketOpen(m)) || this.quotes.source === 'mock';
      if (open) await this.snapshot();
      // 每个交易日北京时间 15:05 之后（A 股、日股都已收盘）结算一次当日排行
      const { weekday, minutes } = localParts('Asia/Shanghai');
      const today = marketDate('CN');
      if (!['Sat', 'Sun'].includes(weekday) && minutes >= 15 * 60 + 5 && !this.sql.exec('SELECT 1 FROM daily WHERE date = ? LIMIT 1', today).toArray().length) {
        await this.snapshot();
        await this.settleDay(today);
      }
    } catch (e) {
      console.error('alarm failed', e);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + (this.settings.snapshotMinutes || 5) * 60_000);
    }
  }

  async snapshot() {
    const s = this.settings;
    const syms = this.sql.exec('SELECT DISTINCT symbol FROM positions').toArray().map((r) => r.symbol);
    const [q, rates] = await Promise.all([this.quotesFor([...syms, ...(s.benchmarks || [])]), this.rates()]);
    const t = Date.now();
    for (const u of this.activeUsers()) this.sql.exec('INSERT INTO equity (user_id, t, v) VALUES (?, ?, ?)', u.id, t, this.valuate(u, q, rates).equity);
    for (const sym of s.benchmarks || []) {
      if (!q[sym]?.price) continue;
      if (!this.getMeta('benchStart:' + sym)) {
        this.setMeta('benchStart:' + sym, String(q[sym].price));
        this.setMeta('benchName:' + sym, q[sym].name);
      }
      this.sql.exec('INSERT INTO bench (symbol, t, price) VALUES (?, ?, ?)', sym, t, q[sym].price);
    }
    // 持仓最新价存一下，行情源故障时估值不至于归零
    for (const sym of syms) if (q[sym]?.price) this.sql.exec('UPDATE positions SET last_price = ? WHERE symbol = ?', q[sym].price, sym);
  }

  // ---------------- 每日收盘排行 ----------------
  async settleDay(date = marketDate('CN')) {
    const users = this.activeUsers();
    if (!users.length) return { ok: true, date, rows: 0 };
    const syms = this.sql.exec('SELECT DISTINCT symbol FROM positions').toArray().map((r) => r.symbol);
    const [q, rates] = await Promise.all([this.quotesFor(syms), this.rates()]);
    const rows = [];
    for (const u of users) {
      const v = this.valuate(u, q, rates);
      const prev = this.sql.exec('SELECT equity FROM daily WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1', u.id, date).toArray()[0]?.equity ?? v.initialBase;
      const trades = this.sql.exec('SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND substr(time, 1, 10) = ?', u.id, date).one().n;
      rows.push({ u, equity: v.equity, day: ((v.equity - prev) / prev) * 100, total: v.returnPct, trades });
    }
    const byTotal = [...rows].sort((a, b) => b.total - a.total);
    const byDay = [...rows].sort((a, b) => b.day - a.day);
    this.sql.exec('DELETE FROM daily WHERE date = ?', date);
    for (const r of rows) {
      this.sql.exec('INSERT INTO daily (date, user_id, name, model, equity, day_pct, total_pct, rank, day_rank, trades) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        date, r.u.id, r.u.display_name, r.u.model || '', round2(r.equity), round2(r.day), round2(r.total), byTotal.indexOf(r) + 1, byDay.indexOf(r) + 1, r.trades);
    }
    return { ok: true, date, rows: rows.length };
  }

  dailyRankings(limit = 30) {
    const dates = this.sql.exec('SELECT DISTINCT date FROM daily ORDER BY date DESC LIMIT ?', limit).toArray().map((r) => r.date);
    return dates.map((date) => ({
      date,
      rows: this.sql.exec('SELECT user_id AS id, name, model, equity, day_pct AS dayPct, total_pct AS totalPct, rank, day_rank AS dayRank, trades FROM daily WHERE date = ? ORDER BY day_rank', date).toArray(),
    }));
  }

  // ---------------- 管理 ----------------
  assertAdmin(req) {
    const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!this.env.ADMIN_TOKEN) throw new HttpError(503, '还没有设置管理员口令（在 Cloudflare 里添加 ADMIN_TOKEN）');
    if (tok !== this.env.ADMIN_TOKEN) throw new HttpError(401, '管理员口令不对');
  }

  updateSettings(patch) {
    if (!isPlainObject(patch)) throw new HttpError(400, '需要 JSON 对象');
    const next = deepMerge(this.settings, patch);
    if (!isPlainObject(next.initialCash) || !Object.values(next.initialCash).some((v) => v > 0)) throw new HttpError(400, 'initialCash 格式：{"CNY": 30000, "JPY": 500000}');
    for (const c of Object.keys(next.initialCash)) if (!CURRENCIES.includes(c)) throw new HttpError(400, `不支持的货币 ${c}`);
    if (!CURRENCIES.includes(next.baseCurrency)) throw new HttpError(400, 'baseCurrency 只能是 CNY 或 JPY');
    this.settings = next;
    const diff = {};
    for (const k of Object.keys(next)) if (JSON.stringify(next[k]) !== JSON.stringify(DEFAULT_SETTINGS[k])) diff[k] = next[k];
    this.setMeta('settings', JSON.stringify(diff));
    this.quotes.source = this.env.DATA_SOURCE || next.dataSource;
    return next;
  }

  async resetCompetition(mode) {
    const rates = await this.rates();
    this.sql.exec('DELETE FROM positions; DELETE FROM trades; DELETE FROM fx_trades; DELETE FROM equity; DELETE FROM notes; DELETE FROM bench; DELETE FROM daily; DELETE FROM cash;');
    this.sql.exec("DELETE FROM meta WHERE k LIKE 'bench%'");
    if (mode === 'all') {
      this.sql.exec('DELETE FROM users');
    } else {
      // 邀请码保留；已经开户的人重新发初始资金，从现在开始重新记净值
      await this.setBaseRates(rates);
      for (const u of this.sql.exec('SELECT id FROM users WHERE activated_at IS NOT NULL').toArray()) this.fundAccount(u.id);
    }
    if (mode === 'all') await this.setBaseRates(rates);
    this.setMeta('startedAt', nowIso());
    return { ok: true };
  }

  adminUser({ id, action } = {}) {
    const u = this.sql.exec('SELECT * FROM users WHERE id = ?', String(id || '')).toArray()[0];
    if (!u) throw new HttpError(404, '没有这个参赛者');
    if (action === 'disable' || action === 'enable') {
      this.sql.exec('UPDATE users SET disabled = ? WHERE id = ?', action === 'disable' ? 1 : 0, u.id);
    } else if (action === 'delete') {
      for (const tbl of ['positions', 'trades', 'fx_trades', 'equity', 'notes', 'cash', 'daily']) this.sql.exec(`DELETE FROM ${tbl} WHERE user_id = ?`, u.id);
      this.sql.exec('DELETE FROM users WHERE id = ?', u.id);
    } else throw new HttpError(400, 'action 可选 disable / enable / delete');
    return { ok: true };
  }

  async rulesInfo() {
    const s = this.settings;
    const rates = await this.rates();
    return {
      competition: this.competitionStatus(), initialCash: s.initialCash, baseCurrency: s.baseCurrency,
      fx: { JPYCNY: rates.JPYCNY, CNYJPY: rates.CNYJPY, source: rates.source },
      allowedMarkets: s.allowedMarkets, tradingWindow: s.tradingWindow, competitionStart: s.competitionStart, competitionEnd: s.competitionEnd,
      rules: s.rules, suggestedWatchlist: s.watchlist,
    };
  }

  // ---------------- HTTP 路由 ----------------
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const json = (obj, status = 200) => Response.json(obj, { status, headers: CORS });
    const body = async () => {
      try { return await req.json(); } catch { throw new HttpError(400, '请求体必须是 JSON'); }
    };
    const code = () => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim(); // Bearer 后面就是邀请码
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (p === '/mcp') return await handleMcp(req, this);
      if (p === '/agent.md' || p === '/llms.txt' || p === '/api/docs') {
        return new Response(agentDoc(url.origin, this.settings, this.competitionStatus()), { headers: { ...CORS, 'content-type': 'text/markdown; charset=utf-8' } });
      }
      if (p === '/api/state' && req.method === 'GET') return json(await this.publicState());
      if (p === '/api/leaderboard' && req.method === 'GET') return json(await this.publicState({ detail: false }));
      if (p === '/api/daily' && req.method === 'GET') return json(this.dailyRankings(Number(url.searchParams.get('days')) || 30));
      if (p === '/api/rules' && req.method === 'GET') return json(await this.rulesInfo());
      if (p === '/api/quote' && req.method === 'GET') return json(await this.getQuotes((url.searchParams.get('symbols') || '').split(',')));
      if (p === '/api/login' && req.method === 'POST') {
        const b = await body();
        return json(await this.login({ ...b, code: b.code || code() }));
      }
      if (p === '/api/profile' && req.method === 'POST') return json(this.updateProfile(await this.userByCode(code()), await body()));
      if (p === '/api/account' && req.method === 'GET') return json(await this.account(await this.userByCode(code())));
      if (p === '/api/order' && req.method === 'POST') return json(await this.placeOrder(await this.userByCode(code()), await body()));
      if (p === '/api/exchange' && req.method === 'POST') return json(await this.exchange(await this.userByCode(code()), await body()));
      if (p === '/api/note' && req.method === 'POST') return json(this.addNote(await this.userByCode(code()), (await body()).text));
      if (p.startsWith('/api/admin/')) {
        this.assertAdmin(req);
        if (p === '/api/admin/settings' && req.method === 'GET') return json(this.settings);
        if (p === '/api/admin/settings' && req.method === 'POST') return json(this.updateSettings(await body()));
        if (p === '/api/admin/reset' && req.method === 'POST') return json(await this.resetCompetition((await body()).mode));
        if (p === '/api/admin/user' && req.method === 'POST') return json(this.adminUser(await body()));
        if (p === '/api/admin/invites' && req.method === 'GET') return json(this.listInvites());
        if (p === '/api/admin/invites' && req.method === 'POST') return json(this.createInvites(await body()));
        if (p === '/api/admin/snapshot' && req.method === 'POST') { await this.snapshot(); return json({ ok: true }); }
        if (p === '/api/admin/settle' && req.method === 'POST') return json(await this.settleDay((await body().catch(() => ({}))).date || undefined));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
      console.error(e);
      return json({ ok: false, error: e.message || String(e) }, 500);
    }
  }
}

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
