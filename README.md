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

一键起容器：

```bash
docker compose up --build
```

## 测试

```bash
cd backend  && npm test        # node:test
cd frontend && npm test        # vitest
```

后端与前端各自的类型检查：`npm run typecheck`。

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
  src/market/     Polymarket Gamma / CLOB / crypto-price 接入与降级
  src/http/       Fastify 路由与 SSE 推送
frontend/
  src/hooks/      回合与盘口订阅
  src/components/ 终端风格卡片、赔率盘口、下注面板
docs/
  backlog.md      产品待办与验收标准
  architecture.md 架构与数据流
```

## 归属声明

预测玩法的业务语义、费率公式与结算口径参考自
[mamawai/wtfibought](https://github.com/mamawai/wtfibought)（MIT License，Copyright © 2026 mamawai），
本项目为独立实现，仅保留其预测玩法规则。详见 `docs/architecture.md`。
