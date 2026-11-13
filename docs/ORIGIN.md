# 来源与拆分记录

本项目的初版开发于 shawwwnyu/agent-autoloop 的 feat/a-share-paper-trading 分支，随后作为独立业务项目拆分。

来源提交 https://github.com/shawwwnyu/agent-autoloop/commit/055d125824cfe506e7bf549728af3d2d1ddcc623

原业务目录为 examples/recipes/paper-trading，原行为测试为 tests/paper-trading.test.ts 和 tests/paper-trading-workflow.test.ts。拆分保留交易、费用、持仓、策略和账本格式，调整源码与入口路径，并将中台兼容性验证移入 integration-tests。

原项目采用 MIT 许可，本项目保留原 LICENSE。行情接口参考项目与交易所资料见 README，相关实现使用 Node 原生能力。

## 2026-11-13 本机验收

Windows、Node 24.22.3。拆分前已真实读取腾讯报价、日线及深交所交易日历。拆分后的验收使用隔离临时数据库和固定行情，检查原行为测试、独立 CLI 演示、旧账本读取、真实中台规则校验与回执解析。无需启动后台服务或发送真实消息。
