# 中台接入与定时运行

中台使用原版已安装的 `~/.agent-autoloop/app`，无需改动中台源码。飞书（Xiaoyu）通道负责推送观察通知、交易确认卡片与开发阶段汇报卡片，并接收本人的按钮选择或卡片文本回复。

## 运行与开发目录隔离

- **开发源仓库**：`C:\Users\xingxiaoyu\Documents\Workspace\a-share-paper-trading`，仅供 `paper-dev`（Codex）按 `docs/development.md` 和 `docs/roadmap.md` 迭代开发与测试。
- **已验收运行副本**：`C:\Users\xingxiaoyu\.agent-autoloop\paper-trading\app`，供日常定时命令 Agent 稳定调用，避免开发分支改动直接影响盘中撮合。
- **私人账户与报告目录**：`C:\Users\xingxiaoyu\.agent-autoloop\paper-trading\data`（含 `account.json`、`paper.db` 和 `reports/`），10 万元模拟初始资金，不进入任何 Git 仓库。

## 定时与开发规则（Asia/Shanghai）

1. **沪深全市场观察扫描**（`agent-scan`）：交易日 `45 9 * * 1-5` 与 `15 10,11,13,14 * * 1-5` 执行，完整覆盖沪深目录后更新账本观察自选并推送仅告知摘要卡。
2. **模拟交易确认与撮合**（`agent-cycle`）：交易日 `*/5 9-14 * * 1-5` 执行，脚本核对交易日历与连续竞价时段，处理本人已确认卡片、按实时盘口模拟撮合，并推送新建议确认卡（每轮最多发 5 张新卡，已开卡片不重复占名额）。
3. **模拟账户收盘估值**（`agent-mark`）：交易日 `5 15 * * 1-5` 执行收盘市值记账。
4. **模拟交易每周复盘**（`agent-review`）：每周五 `15 15 * * 5` 执行份额净值法周报与候选策略评估。
   - 以上四条业务规则共用 `paper-account` 串行组，避免并发写入同一模拟账本。
5. **开发交易项目**（`paper-dev` / Codex）：独立 `paper-development` 组（`maxActive: 1`），手动运行 `agent-autoloop run 开发交易项目` 启动首轮，之后每完成一个路线图阶段自动在飞书发送交互卡片；点“继续开发下一阶段”或在卡片输入框提交补充需求即自动续跑下一阶段，点“先暂停，待我验收”即安静停下。

所有买卖建议均须本人在飞书确认卡点击确认，单独文字消息不构成交易确认。密钥、账户数据库和报告均保存在本机私人目录。
