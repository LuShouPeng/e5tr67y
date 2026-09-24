# 归属声明（Attribution）

## 上游

本项目复刻的「BTC 5 分钟涨跌预测」玩法，业务语义来自
[**mamawai/wtfibought**](https://github.com/mamawai/wtfibought)（站点 `wtfibought.com`）。

```
MIT License
Copyright (c) 2026 mamawai
```

## 具体沿用了什么

| 项 | 来源 | 本项目实现位置 |
| --- | --- | --- |
| 5 分钟窗口对齐口径（`window_start = now − now % 300`） | 上游 `prediction_round.window_start` | `backend/src/domain/window.ts` |
| 结算口径：收盘 60 秒 TWAP **≥** 开盘 60 秒 TWAP 判 UP（相等算 UP） | 上游 `PredictionServiceImpl.settleWithPrice` + Polymarket 官方规则 | `backend/src/domain/settlement.ts` |
| 吃单费 `份数 × 0.07 × p × (1 − p)`（Polymarket crypto_fees_v2） | 上游 `PredictionFee` | `backend/src/domain/fee.ts` |
| 份数换算（`金额 ÷ 价格`，4 位小数向零取整）与成本/派彩字段语义 | 上游 `prediction_bet` 表 + `PredictionServiceImpl.buy` | `backend/src/domain/order.ts` |
| 卖价只认当前窗口（防按已知结果套现）、部分卖出拆单、作废退本金 | 上游 `PredictionServiceImpl.sell` / `voidRound` | `backend/src/services/predictionService.ts` |
| 缺价等待策略（有注单等 1 小时、无注单等 2 个窗口） | 上游 `PredictionServiceImpl.voidRound` | `backend/src/domain/settlement.ts` |
| 行情接口：Gamma `events/slug/btc-updown-5m-{ts}` 取 token、CLOB 账本、`crypto-price` 取 TWAP 开收盘价 | 上游 `PolymarketWsClient` / `PolymarketPriceClient` | `backend/src/market/polymarket.ts` |
| 持仓估值口径（当前窗口按买一价、其余按成本挂账） | 上游 `AssetValuationService.predictionBetValue` | `backend/src/services/pnl.ts` |

## 没有沿用

- **没有复制上游源码**：上游是 Java（Spring Boot + MyBatis-Plus + Redis + PostgreSQL）与
  React 应用；本项目是独立的 Node/TypeScript + SQLite + React 实现，分层、命名与并发模型均不同。
- 未包含上游的合约 AI 交易员、合约量化策略（turtle / smc / fibo / sqzmom）、新闻/财经日历、游戏（21 点、视频扑克、翻牌）、
  排行榜与真实登录体系——这些不属于「预测」玩法。
- 上游的 **Jev 预测员**（`wiib-agent/.../prediction/`：`PredictionModel`、`PredictionStateWriter`、
  `PredictionQuestions`、`PredictionRules`、`JevPredictionRunner`、`JevClient`）已按其逻辑用 TypeScript 重写到
  `backend/src/strategy/`，详见 `docs/strategy.md`。
- 未使用上游的 WebSocket 推送方案，改为 SSE + REST 轮询。

## 合规说明

上游为 MIT 许可，允许复制、修改、分发与商用，条件是保留版权声明与许可全文。
本项目已在 `LICENSE` 中保留上游版权行，并在本文件逐项列明沿用的业务语义。

页面配色（白纸墨线 + 橙色强调）参考了上游观感以便对照，未复制其样式表或图片资源。
