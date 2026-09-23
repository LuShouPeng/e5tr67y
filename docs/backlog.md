# 产品待办列表（Product Backlog）

> 敏捷实践：需求以用户故事（User Story）描述，每条附带验收标准（AC）。
> 一个 Feature 对应一个 `feat/*` 分支 + 一个约定式提交，**提交必须包含该 Feature 的自动化测试**。

## 产品目标

复刻 WhatIfIBought（WIIB）的 **BTC 5 分钟涨跌预测**玩法：用虚拟资金，按 Polymarket 实时概率定价，
买卖"BTC 在 5 分钟窗口内涨跌"合约，回合结束后结算，赢家每份合约兑付 $1。

上游来源：`https://github.com/mamawai/wtfibought`（MIT），语义对齐上游 `prediction_*` 模块。

## 玩法规则（对齐 Polymarket 官方口径）

| 项 | 规则 |
| --- | --- |
| 窗口 | UTC 整 5 分钟切片，`windowStart = now - now % 300` |
| 回合状态 | `OPEN`（可买卖）→ `LOCKED`（封盘等收盘）→ `SETTLED`（已定盘） |
| 目标价 | 开盘时刻往前 60 秒 Chainlink TWAP（Polymarket 官方 `openPrice`） |
| 结算价 | 窗口末 60 秒 Chainlink TWAP（Polymarket 官方 `closePrice`） |
| 判定 | `结算价 >= 目标价` 判 **UP**（相等算 UP，与官方一致），否则 **DOWN** |
| 合约 | 预测正确每份兑付 $1；`份数 = 金额 ÷ 买入价` |
| 吃单费 | `份数 × 0.07 × p × (1 − p)`，买卖双向按吃单收取，p=0.5 时最贵（1.75¢/份） |
| 定额 | 单笔金额 `[1, 10000]` |
| 作废 | 取不到开/收盘价 → 回合 `VOID`，注单退本金，盈亏记 0 |

## Sprint 1 — 后端预测引擎（backend/）

| ID | Feature | 验收标准（AC） | 分支 |
| --- | --- | --- | --- |
| S1-1 | 5 分钟窗口与回合生命周期 | 窗口对齐到 300s 边界；剩余秒数正确；状态机 OPEN→LOCKED→SETTLED 只允许单向迁移 | `feat/window-lifecycle` |
| S1-2 | Polymarket 吃单费公式 | `fee(份数,p)=份数×0.07×p×(1−p)`；p=0.5 时每份 1.75¢；边界 p=0/1 费为 0 | `feat/taker-fee` |
| S1-3 | 盘口报价与合约换算 | 按卖一价买入、买一价卖出；份数向下取整到 4 位；预计收益 = 金额 ÷ 价格 | `feat/quote-math` |
| S1-4 | 买入下单 | 校验方向/金额/回合状态/盘口；扣 `成本 + 手续费`；余额不足拒绝 | `feat/buy-order` |
| S1-5 | 卖出与部分卖出 | 仅当前 OPEN 回合可卖；全卖→`SOLD`，部分卖→拆出 `SOLD` 记录且剩余继续持有 | `feat/sell-order` |
| S1-6 | 回合结算与作废退款 | 赢方注入 `份数`；输方 0；`VOID` 退本金；重复结算幂等 | `feat/settlement` |
| S1-7 | 预测盈亏统计 | 已实现盈亏 = 结算/卖出 − 成本；未实现按买一价估值；胜率分母为已结算笔数 | `feat/pnl-stats` |
| S1-8 | REST API 与实时推送 | 8 个端点契约稳定；SSE 推送 `round`/`market`/`activity` 事件 | `feat/http-api` |
| S1-9 | Polymarket 行情接入 | Gamma 事件取 UP/DOWN token；crypto-price 取 TWAP 开收盘价；上游不可用时降级为本地模拟盘口 | `feat/market-feed` |

## Sprint 2 — 前端预测页（frontend/）

| ID | Feature | 验收标准（AC） | 分支 |
| --- | --- | --- | --- |
| S2-1 | 项目骨架与终端浅色主题 | Vite+React+TS 可构建；白色金融终端配色；API 客户端带类型 | `feat/web-scaffold` |
| S2-2 | 回合倒计时与赔率盘口 | 倒计时对齐服务端时钟；BID/ASK 以美分显示；90 秒价格曲线（SVG） | `feat/round-panel` |
| S2-3 | 下注面板与手续费预览 | 输入金额实时显示份数/手续费/预计收益；UP/DOWN 双向下单 | `feat/bet-ticket` |
| S2-4 | 我的持仓与往期回合 | 持仓含当前估值与卖出入口；往期回合含结果与目标价/结算价 | `feat/positions-history` |
| S2-5 | 实时成交流与盈亏统计 | SSE 实时追加成交流；盈亏卡片显示已实现/未实现/胜率 | `feat/live-feed` |

## Sprint 3 — 交付

| ID | Feature | 验收标准（AC） |
| --- | --- | --- |
| S3-1 | Docker 部署与文档 | `docker compose up` 可起前后端；README 含运行/测试说明；附上游 MIT 归属声明 |

## 完成定义（Definition of Done）

1. 代码通过类型检查（`npm run typecheck`）。
2. 该 Feature 的测试已提交且全绿（`npm test`）。
3. 提交信息符合 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)。
4. `CHANGELOG.md` 已更新。
