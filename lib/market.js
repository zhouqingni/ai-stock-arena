// 行情模块：代码规范化、实时报价（腾讯 / Yahoo / 模拟）、交易时段判断
// 比赛市场：A 股（沪深北）+ 日本股市（东京证券交易所）
// 统一代码格式：sh600519 / sz000001 / bj430047 / jp7203（丰田）/ 指数 sh000300、jpN225

const MARKETS = {
  CN: { currency: 'CNY', tz: 'Asia/Shanghai', sessions: [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]] },
  JP: { currency: 'JPY', tz: 'Asia/Tokyo', sessions: [[9 * 60, 11 * 60 + 30], [12 * 60 + 30, 15 * 60 + 30]] },
};

/** 把各种写法统一成内部代码。无法识别返回 null。 */
export function normalizeSymbol(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(low)) return low;
  // 日本：jp7203 / 7203.T / 7203 / 新式代码 130A
  let m = s.match(/^jp([0-9][0-9A-Za-z]{3})$/i) || s.match(/^([0-9][0-9A-Za-z]{3})\.t$/i) || s.match(/^([0-9][0-9A-Za-z]{3})$/);
  if (m && !/^\d{6}$/.test(s)) return 'jp' + m[1].toUpperCase();
  if (/^(jp)?(\^?n225|nikkei|日经225?)$/i.test(s)) return 'jpN225';
  if (/^(jp)?(\^?topx|topix)$/i.test(s)) return 'jpTOPX';
  // Yahoo 写法的 A 股
  m = low.match(/^(\d{6})\.(ss|sh)$/); if (m) return 'sh' + m[1];
  m = low.match(/^(\d{6})\.sz$/); if (m) return 'sz' + m[1];
  m = low.match(/^(\d{6})\.bj$/); if (m) return 'bj' + m[1];
  // 纯 6 位数字：A 股
  if (/^\d{6}$/.test(s)) {
    if (/^[569]/.test(s)) return 'sh' + s;
    if (/^[48]/.test(s)) return 'bj' + s;
    return 'sz' + s;
  }
  return null;
}

export function marketOf(sym) {
  return sym.startsWith('jp') ? 'JP' : 'CN';
}

export function currencyOf(sym) {
  return MARKETS[marketOf(sym)].currency;
}

export const MARKET_NAMES = { CN: 'A股', JP: '日股' };

/** 是否是指数（只能看不能买） */
export function isIndex(sym) {
  return /^sh000\d{3}$/.test(sym) || /^sz399\d{3}$/.test(sym) || sym === 'jpN225' || sym === 'jpTOPX';
}

function localParts(tz, now = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return { weekday: p.weekday, minutes: hour * 60 + Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}

/** 该市场当地日期（用于 A 股 T+1） */
export function marketDate(market, now = new Date()) {
  return localParts(MARKETS[market].tz, now).date;
}

/** 粗略判断是否在交易时段（不含节假日） */
export function isMarketOpen(market, now = new Date()) {
  const { tz, sessions } = MARKETS[market];
  const { weekday, minutes } = localParts(tz, now);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return sessions.some(([a, b]) => minutes >= a && minutes < b);
}

export function marketStatus(now = new Date()) {
  return Object.fromEntries(Object.keys(MARKETS).map((m) => [m, isMarketOpen(m, now)]));
}

// ---------------- 数据源 ----------------

async function fetchText(url, { encoding = 'utf-8', headers = {}, timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (ai-stock-arena)', Referer: 'https://gu.qq.com/', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const buf = await res.arrayBuffer();
    return new TextDecoder(encoding).decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** 腾讯行情：A 股实时，国内外都能访问 */
async function tencentQuotes(symbols) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    const text = await fetchText(`https://qt.gtimg.cn/q=${batch.join(',')}`, { encoding: 'gbk' });
    for (const line of text.split(';')) {
      const m = line.match(/v_([A-Za-z0-9.\-]+)="([^"]*)"/);
      if (!m || !m[2]) continue;
      const raw = m[1];
      const sym = raw.startsWith('us') ? 'us' + raw.slice(2).toUpperCase() : raw;
      const f = m[2].split('~');
      const price = num(f[3]);
      const prevClose = num(f[4]);
      if (!price) continue; // 停牌/无数据
      out[sym] = {
        symbol: sym,
        name: f[1],
        price,
        prevClose,
        open: num(f[5]),
        high: num(f[33]),
        low: num(f[34]),
        change: prevClose ? +(price - prevClose).toFixed(4) : null,
        changePct: prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : null,
        time: f[30] || null,
      };
    }
  }
  return out;
}

function toYahoo(sym) {
  if (sym === 'jpN225') return '^N225';
  if (sym === 'jpTOPX') return '^TOPX';
  if (sym.startsWith('jp')) return sym.slice(2) + '.T';
  if (sym.startsWith('sh')) return sym.slice(2) + '.SS';
  if (sym.startsWith('sz')) return sym.slice(2) + '.SZ';
  return sym.slice(2) + '.BJ';
}

/** Yahoo Finance：日股用它（约 20 分钟延迟）；A 股也可以用它做备选 */
async function yahooQuotes(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      const text = await fetchText(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahoo(sym))}?interval=1m&range=1d`,
        { headers: { Referer: 'https://finance.yahoo.com/' } },
      );
      const meta = JSON.parse(text)?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return;
      const price = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
      out[sym] = {
        symbol: sym,
        name: meta.shortName || meta.longName || meta.symbol,
        price,
        prevClose,
        open: null,
        high: meta.regularMarketDayHigh ?? null,
        low: meta.regularMarketDayLow ?? null,
        change: prevClose ? +(price - prevClose).toFixed(4) : null,
        changePct: prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : null,
        time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      };
    } catch { /* 单只失败忽略 */ }
  }));
  return out;
}

/** 模拟行情：断网时用来调试，随机游走 */
const mockState = new Map();
function mockQuotes(symbols) {
  const out = {};
  for (const sym of symbols) {
    let st = mockState.get(sym);
    if (!st) {
      let h = 0;
      for (const c of sym) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      const base = 10 + (h % 2000) / 4;
      st = { prevClose: base, price: base };
      mockState.set(sym, st);
    }
    st.price = Math.max(0.5, st.price * (1 + (Math.random() - 0.5) * 0.006));
    out[sym] = {
      symbol: sym,
      name: `模拟-${sym}`,
      price: +st.price.toFixed(2),
      prevClose: +st.prevClose.toFixed(2),
      open: +st.prevClose.toFixed(2),
      high: null,
      low: null,
      change: +(st.price - st.prevClose).toFixed(2),
      changePct: +(((st.price - st.prevClose) / st.prevClose) * 100).toFixed(2),
      time: new Date().toISOString(),
    };
  }
  return out;
}

export class QuoteService {
  constructor({ source = 'tencent', cacheSeconds = 5 } = {}) {
    this.source = source;
    this.cacheMs = cacheSeconds * 1000;
    this.cache = new Map(); // sym -> { quote, at }
    this.lastError = null;
  }

  /** 获取报价，返回 { sym: quote }。缓存期内不重复请求。 */
  async get(symbols) {
    const uniq = [...new Set(symbols.filter(Boolean))];
    const now = Date.now();
    const stale = uniq.filter((s) => !this.cache.has(s) || now - this.cache.get(s).at > this.cacheMs);
    if (stale.length) {
      try {
        let fresh;
        if (this.source === 'mock') fresh = mockQuotes(stale);
        else if (this.source === 'yahoo') fresh = await yahooQuotes(stale);
        else {
          // auto：A 股走腾讯（实时），日股走 Yahoo
          const cn = stale.filter((x) => marketOf(x) === 'CN');
          const jp = stale.filter((x) => marketOf(x) === 'JP');
          const [a, b] = await Promise.all([cn.length ? tencentQuotes(cn) : {}, jp.length ? yahooQuotes(jp) : {}]);
          fresh = { ...a, ...b };
          if (jp.length && !Object.keys(b).length) throw new Error('日股行情（Yahoo）获取失败');
        }
        for (const [s, q] of Object.entries(fresh)) this.cache.set(s, { quote: q, at: now });
        this.lastError = null;
      } catch (e) {
        this.lastError = `${new Date().toISOString()} ${e.message}`;
        console.warn('[行情] 获取失败：', e.message);
      }
    }
    const out = {};
    for (const s of uniq) {
      const c = this.cache.get(s);
      if (c) out[s] = { ...c.quote, ageSec: Math.round((now - c.at) / 1000) };
    }
    return out;
  }
}
