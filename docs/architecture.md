# 架构说明

## 1. 分层

```
┌────────────────────────── frontend (Vite + React + TS) ──────────────────────────┐
│  页面预测盘：倒计时 / 赔率盘口 / 下注面板 / 持仓 / 往期回合 / 实时成交流          │
│  api/client.ts  ──fetch──┐                     usePredictionMarket.ts ──SSE──┐   │
└──────────────────────────┼──────────────────────────────────────────────────┼───┘
                           │ /api/prediction/*                                │ /api/prediction/stream
┌──────────────────────────▼──────────────────────────────────────────────────▼───┐
│                          backend (Fastify + node:sqlite)                         │
│  http/routes/prediction.ts     HTTP 契约层（校验 + 编排 + 序列化）               │
│  services/predictionService.ts 用例层：买入 / 卖出 / 结算 / 巡检                 │
│  services/pnl.ts               盈亏与胜率统计                                    │
│  domain/*                      纯函数核心：窗口、费率、报价、结算判定            │
│  infra/*                       SQLite 建表 + 回合/注单/账户仓储                  │
│  market/*                      Polymarket 行情接入：Gamma / CLOB / crypto-price  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

设计原则：**钱的算法全在 `domain/`，且是纯函数**。窗口取模、吃单费、份数换算、涨跌判定
都不依赖数据库、时钟或网络，因此可以用固定输入穷举边界（`p=0.5` 最贵、相等算 UP 等）。

## 2. 数据模型

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `prediction_round` | `window_start` UNIQUE, `start_price`, `end_price`, `outcome`, `status` | 一回合一行；`window_start` 是天然幂等键 |
| `prediction_bet` | `user_id`, `round_id`, `side`, `contracts`, `cost`, `avg_price`, `payout`, `status` | `contracts`/`cost` 精度 4 位 |
| `account` | `user_id`, `balance`, `game_balance` | 交易钱包 / 游戏钱包隔离 |

状态机（两边都只允许单向迁移）：

- 回合：`OPEN → LOCKED → SETTLED`；缺价走 `OPEN|LOCKED → SETTLED(outcome=VOID)`
- 注单：`ACTIVE → WON | LOST | SOLD | DRAW`（`DRAW` 即作废退款标记）

## 3. 关键数据流

**下单**：`POST /buy` → 校验方向与金额 → 取盘口卖一价 → `份数 = 金额 ÷ 卖一价`（DOWN 取整）
→ 成本 `份数 × 价` + 吃单费 → 扣游戏钱包 → 落 `ACTIVE` 注单 → 广播成交流。

**卖出**：`POST /sell/:betId` → 仅当前 `OPEN` 窗口的注单可卖（否则就是拿已知结果套现）
→ 按买一价成交 → 扣吃单费 → 全卖置 `SOLD`，部分卖拆出一条 `SOLD` 记录、原单继续持有。

**结算**：`LOCKED` 回合取收盘价 → 批量置 `WON`/`LOST` → 赢方按 `份数` 注入钱包。
整回合一个事务：状态与派彩必须同生共死，否则会出现「标了赢却没拿到钱」。重复结算由
`WHERE status='LOCKED'` 的 CAS 拦住，天然幂等。

## 4. 行情接入与降级

| 用途 | 上游 | 降级 |
| --- | --- | --- |
| 目标价 / 结算价 | `polymarket.com/api/crypto/crypto-price`（`twapEnabled=true&twapLookbackSeconds=60`） | 取不到价 → 回合 `VOID` 退本金 |
| UP/DOWN 盘口 | Gamma `events/slug/btc-updown-5m-{windowStart}` → `clobTokenIds` → CLOB 买一卖一 | 上游不可达 → 本地模拟盘口（随机游走 + 均值回归），保证可离线演示与测试 |

| BTC 逐秒现货（策略用） | Polymarket RTDS `wss://ws-live-data.polymarket.com` 的 `crypto_prices_chainlink` | 断流 5 秒以上策略不下单（`STALE_CHAINLINK`） |
| 波动 / 逐笔 / 强平（策略用） | Binance `klines`、`aggTrades`、合约 `forceOrder` | 缺哪段 state 里就不写哪段；K 线缺失则不下单 |

自动策略、模拟盘 / 实盘分离与数据源评估见 [`strategy.md`](./strategy.md)。

`market/` 所有出网调用都包了超时与 `null` 降级：**拿不到价不算错，算「没有报价」**，
调用方据此拒绝下单或作废回合，绝不会用脏数据成交。

## 5. 测试策略

| 层 | 工具 | 覆盖重点 |
| --- | --- | --- |
| `domain/` 纯函数 | `node:test` | 边界值：窗口取模、`p=0.5` 费率峰值、相等判 UP、取整方向 |
| `services/` 用例 | `node:test` + 内存 SQLite | 余额扣减、重复买单、部分卖出、幂等结算、作废退款 |
| `http/` 契约 | `fastify.inject()`（不起端口） | 状态码、参数校验、鉴权头、错误码 |
| `frontend` | `vitest` + Testing Library | 倒计时渲染、美分换算、手续费预览、空态 |

## 6. 归属声明

预测玩法规则、`prediction_round` / `prediction_bet` 的字段语义、吃单费公式
`份数 × 0.07 × p × (1 − p)` 与「相等判 UP」的结算口径，参考自
[mamawai/wtfibought](https://github.com/mamawai/wtfibought)（MIT License，
Copyright © 2026 mamawai）。本项目为独立实现的复刻，未复制其 Java/React 源码。
