# polymarket-predict

复刻 WhatIfIBought（WIIB）的 **BTC 5 分钟涨跌预测**：用虚拟资金，按 Polymarket 实时概率定价，
买卖「BTC 在 5 分钟窗口内涨跌」的合约，回合结束后结算，赢家每份合约兑付 $1。

- 语义与费率对齐 Polymarket 官方（Chainlink 60 秒 TWAP 结算、7% 吃单费公式）。
- 前后端分离：`backend/`（Node + Fastify + SQLite）、`frontend/`（Vite + React + TypeScript）。
- 敏捷开发：一个 Feature 一个 `feat/*` 分支、一次约定式提交，**每个 Feature 的提交都带自动化测试**。

## 快速开始

```bash
# 后端（默认 http://127.0.0.1:8787）
cd backend && npm install && npm run dev

# 前端（默认 http://127.0.0.1:5173，已代理 /api → 8787）
cd frontend && npm install && npm run dev
```

> 若宿主环境变量是 `NODE_ENV=production`，npm 会跳过 devDependencies（vite/tsc 就装不上），
> 用 `npm install --include=dev` 显式带上。

### 一键起容器

```bash
cp .env.example .env          # 可选：改端口与行情来源
docker compose up --build -d
# 前端 http://127.0.0.1:8080，后端 http://127.0.0.1:8787
```

前端由 nginx 托管，`/api` 反代到后端；SSE 那条路径单独关掉了缓冲
（`proxy_buffering off`），否则事件会被 nginx 攒着、页面看着像「不推送」。

`MARKET_FEED` 三档：

| 值 | 行为 |
| --- | --- |
| `polymarket` | 只用真实盘口与 Chainlink TWAP（需要能访问 Polymarket） |
| `simulated` | 只用本地闭式模拟行情，完全离线可跑通下单→结算全链路 |
| `auto`（默认） | 先用真盘，连续失败到阈值自动降级为模拟 |

```bash
# 端口被占用时换一个（例如宿主已有服务占了 8080）
FRONTEND_PORT=18080 docker compose up -d

# 看日志 / 停掉
docker compose logs -f backend
docker compose down          # 加 -v 连数据卷一起删
```

## 自动策略（可选）

移植了上游的 **Jev 预测员**：每 15 秒把盘面写成英文 state 问一次判官，判官决定买 UP、买 DOWN 或不买
（持仓时决定拿着还是卖掉）。代码只负责拦机械问题；下单走异步队列，「价没变差」才成交；实盘赢了自动在链上领奖。

| 变量 | 可选值 |
| --- | --- |
| `STRATEGY_JUDGE` | `math`（随机游走基线，不需要 key）/ `jev`（TypeSafe Jev，`JEV_API_KEY`）/ `claude`（Anthropic，`ANTHROPIC_API_KEY`） |
| `STRATEGY_BROKER` | `paper`（模拟盘：虚拟资金，机器人账户）/ `live`（Polymarket 实盘：独立库、风控、默认 dry-run） |

```bash
STRATEGY_ENABLED=true STRATEGY_JUDGE=math STRATEGY_BROKER=paper STRATEGY_ADMIN_TOKEN=secret npm run dev
curl -XPOST localhost:8787/api/strategy/switch -H 'x-admin-token: secret' -H 'content-type: application/json' -d '{"on":true}'
curl localhost:8787/api/strategy/status
```

实盘只在 Polymarket 允许的地区可用：下单前调用官方 geoblock 接口，受限或检查失败一律拒单。
本项目不支持任何绕过地域限制的方式。完整说明、风控、数据源评估见 [`docs/strategy.md`](docs/strategy.md)。

## 测试

```bash
cd backend  && npm test        # node:test，300 例
cd frontend && npm test        # vitest，127 例
```

后端与前端各自的类型检查：`npm run typecheck`。前端生产构建：`npm run build`。

## 玩法规则

| 项 | 规则 |
| --- | --- |
| 窗口 | UTC 整 5 分钟切片（`windowStart = now − now % 300`） |
| 回合状态 | `OPEN` 可买卖 → `LOCKED` 封盘 → `SETTLED` 已定盘 |
| 目标价 | 开盘时刻往前 60 秒 Chainlink TWAP |
| 结算价 | 窗口末 60 秒 Chainlink TWAP；`≥ 目标价` 判 UP（相等算 UP），否则 DOWN |
| 合约 | 每份预测正确兑付 $1；`份数 = 金额 ÷ 买入价`（4 位小数向下取整） |
| 吃单费 | `份数 × 0.07 × p × (1 − p)`，买卖双向，50¢ 时最贵（1.75¢/份） |
| 作废 | 取不到开/收盘价 → `VOID`，退本金，盈亏记 0 |

## 目录结构

```
backend/
  src/domain/     窗口、费率、报价与结算的纯函数（可测试核心）
  src/infra/      SQLite 建表与仓储
  src/services/   下单、卖出、结算、盈亏编排
  src/market/     Polymarket Gamma / CLOB / crypto-price / Chainlink 实时流、Binance 行情接入与降级
  src/strategy/   自动策略：公平价模型、state、判官（math / jev / claude）、检查点回路
  src/execution/  下单通道接口与模拟盘通道
  src/live/       Polymarket 实盘通道：CLOB 客户端、独立账本、地域检查、风控
  src/http/       Fastify 路由与 SSE 推送
frontend/
  src/hooks/      回合与盘口订阅
  src/components/ 终端风格卡片、赔率盘口、下注面板
docs/
  backlog.md      产品待办与验收标准
  architecture.md 架构与数据流
  strategy.md     自动策略、模拟盘 / 实盘分离、数据源评估
```

## 归属声明

预测玩法的业务语义、费率公式与结算口径参考自
[mamawai/wtfibought](https://github.com/mamawai/wtfibought)（MIT License，Copyright © 2026 mamawai），
本项目为独立实现，仅保留其预测玩法规则。详见 `docs/architecture.md`。
