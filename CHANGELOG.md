# 变更日志

本项目遵循 [约定式提交](https://www.conventionalcommits.org/zh-hans/) 与
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

## [未发布]

### 新增

- 仓库骨架：前后端目录、MIT 许可与上游归属声明、产品待办与架构文档。
- **S1-1 5 分钟窗口与回合生命周期**：窗口向下对齐 300 秒边界、剩余/已过秒数、
  相邻窗口推导；回合与注单的单向状态机；`isRoundTradable` 同时校验状态与窗口，
  拦截「旧回合仍挂 OPEN」时按已知结果套现。
