# 🏁 AI 炒股竞技场（A 股 + 日股）

给几个 AI 每人发一笔虚拟资金，用**真实行情**比赛炒股。比赛完全跑在 GitHub 上，**不需要自己的电脑一直开着**，用手机打开网页就能看排行榜、收益曲线、持仓、成交记录，以及每个 AI 每一轮的思考。

- **市场**：A 股（沪深北）+ 日本股市（东京证券交易所）。日股按汇率折算成人民币，统一排名
- **行情**：A 股来自腾讯财经（实时），日股来自 Yahoo Finance（约 20 分钟延迟）
- **规则**：手续费、A 股印花税、滑点；买入以 100 股为单位；A 股 T+1；单只股票最多占总资产 40%；不能做空、不能融资；休市不能成交
- **对比基准**：沪深 300、日经 225（相当于“买入后一直不动”的收益）

## 它是怎么运转的

```
GitHub Actions（每 10 分钟醒一次，只在交易时段）
   ├─ 拉实时行情，给每个选手记一次净值
   ├─ 到点的 AI：把行情 + 它的账户 + 排行榜发给它 → 它回复买卖决定 → 按实时价成交
   ├─ 比赛数据保存回仓库（docs/data/）
   └─ 发布比赛网页（GitHub Pages）
```

## 上线步骤（全部在 GitHub 网页上操作）

1. **填 API Key**：仓库 → Settings → Secrets and variables → Actions → New repository secret。用到哪家就填哪家，名字必须一致：

   | 选手 | Secret 名字 | 在哪申请 |
   |---|---|---|
   | DeepSeek | `DEEPSEEK_API_KEY` | platform.deepseek.com |
   | 通义千问 | `DASHSCOPE_API_KEY` | 阿里云百炼 bailian.console.aliyun.com |
   | Kimi | `MOONSHOT_API_KEY` | platform.moonshot.cn |
   | Claude | `ANTHROPIC_API_KEY` | console.anthropic.com |

   还预留了 `ZHIPU_API_KEY`（智谱）、`ARK_API_KEY`（豆包）、`SILICONFLOW_API_KEY`（硅基流动）、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`OPENROUTER_API_KEY`。没填 Key 的选手不会报错，排行榜上会显示“未配置 Key”。

2. **打开网页功能**：Settings → Pages → Source 选 **GitHub Actions**。

3. **开赛**：Actions → “交易一轮” → Run workflow（勾选“重置比赛”可以让所有人回到初始资金）。跑完后，网页地址显示在这次运行的页面上，一般是 `https://你的用户名.github.io/仓库名/`。之后每个交易日会自动运行。

> 免费版 GitHub Pages 要求仓库是 **公开** 的。代码和比赛数据里没有任何密钥，Key 都存在 Secrets 里，别人看不到。

## 修改比赛设置（在 GitHub 网页上直接编辑 `config.json`）

| 想改什么 | 改哪里 |
|---|---|
| 加减选手、换模型 | `agents` 列表。所有 OpenAI 兼容接口都可以用：`provider` 写 `openai`，再改 `baseURL` 和 `model` |
| AI 多久决策一次 | `runner.intervalMinutes`（默认 30 分钟）。**越频繁 API 费用越高** |
| 只比 A 股 / 只比日股 | `rules.allowedMarkets` 改成 `["CN"]` 或 `["JP"]` |
| 初始资金 | `initialCash`（改完记得手动运行一次并勾选“重置比赛”） |
| 日元汇率 | `fx.JPY`（1 日元折合多少人民币，固定值，偶尔手动更新） |
| AI 每轮都能看到的股票 | `watchlist`（AI 也可以买列表以外的股票） |
| 单只股票仓位上限 | `rules.maxPositionPct` |
| 给某个 AI 定投资风格 | 在它的 `llm` 里加 `"extraInstructions": "你是价值投资者，长期持有"` |
| Claude 上网搜新闻 | `"webSearch": true`（已默认打开） |

再加一个选手的例子（智谱 GLM）：
```json
{ "id": "glm", "name": "智谱 GLM", "llm": { "provider": "openai", "baseURL": "https://open.bigmodel.cn/api/paas/v4", "model": "glm-4-plus", "apiKeyEnv": "ZHIPU_API_KEY" } }
```

## 进阶：让 agent 自主参赛（需要一台服务器）

GitHub 免费方案适合“填 API Key、由平台托管”的 AI。如果想让 Claude Code、Cursor 这类 **agent** 自己决定什么时候查行情、什么时候下单，需要一个一直在线的服务器（云服务器，或者一台不关机的电脑）：

```bash
npm install
npm start          # http://localhost:3000，没网时可以用 npm run mock 先看效果
```

服务器模式支持三种接入方式：上面的托管 AI；`mcp.js` MCP 工具（agent 会多出查行情、查账户、下单、看排行榜 4 个工具）；HTTP 接口（见 `AI_API.md`）。选手 token 用环境变量 `ARENA_TOKEN_<选手ID大写>` 设置，管理口令用 `ARENA_ADMIN_TOKEN`。

Claude Code 接入示例：
```bash
claude mcp add stock-arena -e ARENA_URL=http://你的服务器:3000 -e ARENA_TOKEN=该选手的token -- node /路径/ai-stock-arena/mcp.js
```

## 已知限制

- 只有市价单，不能做空，也没有处理涨跌停和分红
- 日股行情约有 20 分钟延迟；日元汇率是固定值
- 节假日不会自动识别：节假日行情不动，AI 一般也不会操作，但还是会调用 API（花一点钱）
- GitHub 的定时任务高峰期可能晚几分钟执行
