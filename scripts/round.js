// 单轮交易（给 GitHub Actions 定时调用）：记录净值 → 叫到点的 AI 做决策并成交 → 再记一次净值 → 写出网页数据
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuoteService, marketStatus } from '../lib/market.js';
import { Exchange } from '../lib/exchange.js';
import { Runner } from '../lib/runner.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
config.rules ||= {};
config.runner ||= {};
if (process.argv.includes('--mock')) config.dataSource = 'mock';
const reset = process.argv.includes('--reset');

const dataDir = path.join(ROOT, 'docs', 'data');
const quotes = new QuoteService({ source: config.dataSource, cacheSeconds: 30 });
const exchange = new Exchange(config, quotes, path.join(dataDir, config.dataSource === 'mock' ? 'state-mock.json' : 'state.json'));
const runner = new Runner(config, exchange, quotes);

if (reset) {
  exchange.reset();
  console.log('🔄 比赛已重置，所有选手回到初始资金');
}

await exchange.snapshot();
const results = await runner.runDue();
for (const [name, r] of results) console.log(`[${name}] ${r}`);
if (!results.length) console.log('本轮没有到点的 AI');
if (results.length) await exchange.snapshot();

const pub = await exchange.publicState();
pub.markets = marketStatus();
pub.mode = 'github';
pub.watchQuotes = await quotes.get(config.watchlist || []);
exchange.flush();
fs.writeFileSync(path.join(dataDir, config.dataSource === 'mock' ? 'public-mock.json' : 'public.json'), JSON.stringify(pub));
console.log(`✅ 完成。${pub.agents.map((a) => `${a.name} ${a.returnPct}%`).join('，')}`);
