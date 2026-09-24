# 自动策略、模拟盘 / 实盘分离与数据源

## 1. 上游有哪些策略，移植了什么

上游 [mamawai/wtfibought](https://github.com/mamawai/wtfibought) 里跟「BTC 5 分钟涨跌」这个盘口相关的策略**只有一个**：
`wiib-agent/.../prediction/` 下的 **Jev 预测员**（`JevPredictionRunner`）。它由三部分组成：

| 上游 | 做什么 | 本仓库 |
| --- | --- | --- |
| `PredictionModel` | 随机游走公平价：领先幅度 ÷（剩余时间 × 波动）→ z → 正态分布概率；进了末分钟把已锁定的均价算进去 | `backend/src/strategy/model.ts` |
| `PredictionStateWriter` | 把盘面写成英文短句（clock / btc / binance_flow / odds / estimate / position） | `backend/src/strategy/state.ts` |
| `PredictionQuestions` + `PredictionJudge` + `JevClient` | 一次请求问 Jev 三道题：UP 会赢吗、DOWN 会赢吗、买 UP / 买 DOWN / 不买（持仓时是拿着 / 卖掉） | `strategy/questions.ts`、`strategy/judges/jevJudge.ts` |
| `PredictionRules` | 判官拍板、代码只拦机械问题：把握不够、没人卖、没人接盘、付不起 | `strategy/rules.ts` |
| `JevPredictionRunner` | 每 15 秒一个检查点；拍板后等 1 秒再看盘口，价没变差才成交；每分钟回填结果与盈亏 | `strategy/runner.ts` |

「LLM 预测」在上游就是 Jev 这一条（Jev 是 TypeSafe 家的判断模型，接口 `POST /v1/systemone`）。
本仓库在同一套 state 和题目上**多加了两个可互换的判官**：

- `claude`：Anthropic Claude，结构化输出拿回同样的概率与选择（默认 `claude-opus-5`、`effort=low`，开了服务端 `fallbacks: "default"` 兜底拒答）；
- `math`：不调任何 LLM，只拿随机游走公平价比含费成本，差出 `STRATEGY_MATH_MIN_EDGE` 才下。**它是基线**：LLM 判官的战绩要跟它比，才知道有没有多看出东西。

上游其余策略**没有移植**，因为它们不作用在这个盘口上：
`wiib-quant/strategy/` 下的 turtle / smc / fibo / sqzmom 是 BTC 永续合约的技术指标策略，
`wiib-agent/trader/` 是合约的 AI 交易员。这些策略的输出是「开多 / 开空 + 杠杆」，放到 5 分钟二元期权上没有意义。

## 2. 结构：模拟盘和实盘分离

```
                 ┌─────────────── 数据源 ───────────────┐
                 │ Polymarket crypto-price（开/收盘 60s 均价）│
                 │ Polymarket CLOB 盘口（买一卖一）          │
                 │ Polymarket RTDS：Chainlink 逐秒现货  ← 新增│
                 │ Binance 1m K 线 / 逐笔 / 强平        ← 新增│
                 └──────────────────┬───────────────────┘
                                    ▼
             state.ts（写盘面）→ 判官 math | jev | claude → rules.ts
                                    ▼
                        runner.ts（检查点、限价确认、回填）
                                    ▼  Broker 接口
                 ┌──────────────────┴──────────────────┐
         PaperBroker（模拟盘）                    LiveBroker（实盘）
   原有虚拟资金游戏、机器人账户 900001          Polymarket CLOB 官方客户端
   库：WIIB_DB（prediction.sqlite）            库：LIVE_DB（live.sqlite，独立文件）
   决策日志：同库 strategy_decision            决策日志：同库 strategy_decision
```

- 两个通道**不共享**余额、持仓、成交记录和决策日志；一次只跑一个通道（`STRATEGY_BROKER`）。
- 页面上的预测游戏照旧是模拟盘，和实盘无关。
- 实盘有三道前置：`LIVE_TRADING_ENABLED=true`、`MARKET_FEED=polymarket`（**不许降级到模拟价下真单**）、配置私钥。
- 每笔真单前：
  1. **地域合规**：调用 Polymarket 官方 `https://polymarket.com/api/geoblock`，受限或检查失败一律拒单（fail closed）。本项目不支持、也不提供任何绕过地域限制的方式；受限地区只能用模拟盘。
  2. **风控**：单笔上限 `LIVE_MAX_STAKE_USD`、未了结仓位成本上限 `LIVE_MAX_OPEN_COST_USD`、UTC 当日亏损上限 `LIVE_MAX_DAILY_LOSS_USD`。
  3. **dry-run**：`LIVE_DRY_RUN` 默认 `true`，只签名不提交，账本照记（`dry_run=1`）。确认一切正常再显式关掉。
- 下单方式：FAK 市价单带价格上 / 下限，吃得到限价以内的就成交、剩下的撤掉，等价于上游「价没变差才成交」。

### 实盘还需要你自己处理的事

- **领取奖金**：窗口结束后，赢的份额要到 Polymarket 上 redeem 才会变回 USDC。账本会把仓位记成 `WON`，但不会自动发链上交易。
- **授权与充值**：钱包需要先在 Polymarket 充 USDC 并完成交易授权（用网页下过一单即可）。
- **成交手续费**：账本按 CLOB 回包的实际金额记账；Polymarket 的吃单费以其结算为准。
- 实盘路径在本仓库的测试里用假 CLOB 覆盖，**没有连真实 Polymarket 跑过**。第一次上线请保持 dry-run、小额度，并对照 Polymarket 网页核对每一笔。

## 3. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/strategy/status` | 开关、判官、通道、最近错误、战绩汇总 |
| GET | `/api/strategy/decisions?limit=50` | 最近的决策（不含 state 原文） |
| POST | `/api/strategy/switch` | `{"on": true/false}`，需要请求头 `x-admin-token` |
| GET | `/api/live/status` | 地域检查结果、余额、风控用量（仅实盘） |
| GET | `/api/live/orders`、`/api/live/positions` | 实盘账本（仅实盘） |

## 4. 数据源够不够用

**结论：只靠原来的数据源不够。60 秒均价只能用来结算，不能用来判断。**

原来的真实数据只有两样：

1. `crypto-price` 接口的开盘 / 收盘 60 秒 Chainlink 均价。开盘价是目标价，收盘价要等窗口结束才有。**盘中拿不到任何 BTC 价格**。原来 `feed.ts` 在真盘下往价格曲线里塞的也只是开盘均价这一个数。
2. CLOB 盘口的买一卖一，每 5 秒轮询一次。

判断「这一局 UP 还是 DOWN」最关键的是 **现价离目标价有多远、还剩多少时间、平时波动多大**。三样里原来一样都没有：

| 需要什么 | 为什么 | 现在从哪来 |
| --- | --- | --- |
| Chainlink 逐秒现货 | 结算按 Chainlink 算；领先幅度、末分钟已锁定部分都要它 | Polymarket RTDS `crypto_prices_chainlink`（新增 `market/chainlinkStream.ts`） |
| 1m K 线（近一小时） | 算「正常波动」σ，没有它领先 $30 是多是少无从判断 | Binance `klines`（新增 `market/binance.ts`） |
| 近 3 分钟实际波动 | 刚起波时一小时 σ 偏小，取两者大的，避免过度自信 | 由 Chainlink tick 计算 |
| 主动买卖、大单、10/30 秒涨跌 | 短线动量；Chainlink 比交易所慢半拍，Binance 先动 | Binance `aggTrades` |
| 开盘以来强平方向 | 连环强平会延续方向 | Binance 合约 `forceOrder` 流（可关：`BINANCE_LIQUIDATIONS=false`） |
| 赔率 30 秒变化 | 市场在往哪边倒 | 策略回路每秒采样盘口中间价 |

这些都已经写进发给 LLM 的 state，和上游 Jev 看到的内容一致。

**还可以再加、但这次没加的：**

- **CLOB WebSocket 盘口**：现在 5 秒轮询一次，上游用 WS 实时推。实盘时 `STRATEGY_BOOK_MAX_AGE_MS` 不宜调太小，或者可以把 `FEED_POLL_MS` 降到 2000。
- **盘口深度**：现在只取买一卖一。stake 大的话应该看前几档的量，免得价格被自己吃穿。
- **资金费率 / 未平仓量**：对 5 分钟窗口作用弱，性价比不高。
- **宏观事件日历**（CPI、FOMC 等）：数据公布前后波动完全不同，上游有新闻 / 财经日历模块，可以作为 `clock` 里的一句提示加进去。

**网络提示**：新增的数据源要能访问 `ws-live-data.polymarket.com`、`data-api.binance.vision`、`fstream.binance.com`。
Binance 在部分地区不可用，这时逐笔和强平两段会自动缺席（state 里对应字段不出现）。但 K 线也拿不到的话，策略会记 `NO_STATE`，不下单。
