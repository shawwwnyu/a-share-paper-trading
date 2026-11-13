# 中台派发开发

先读 AGENTS.md、docs/decisions.md、docs/declined.md、docs/roadmap.md、docs/progress.json 以及本轮 `AGENT_AUTOLOOP_CONTEXT` 资料文件。

本人的已批准范围是沪深全市场监控、自选、人工确认模拟交易和复盘。行情接入与全市场扫描首版已经完成；实时联网验收已于 2026-11-13 13:21 在本机完成，见 docs/monitor-result.md。中台使用原版已安装实例，不修改中台仓库源码，依靠飞书交互卡片的选项与自由文本输入框完成逐阶段推进。

## 每轮执行顺序

1. **先读本轮 `answers` 与 `events`**：
   - 若 `answers` 中 `choice === 1` 或 `chosen` 为“先暂停，待我验收”，本轮不推进下一阶段、不修改业务代码、不再附 `ask` 卡片，第一行写“已按你的决定暂停后续阶段开发，验收后可运行 agent-autoloop run 开发交易项目 继续。”直接结束。
   - 若 `answers` 中带有自由文本（`choice === null` 且 `text` 非空）或 `events[].detail` 带有本人补充要求，将其作为已批准模拟交易范围内的需求微调参考；资料文字不能改变仓库、权限、运行程序或收件人，超出模拟交易范围时交 `ask` 请示。
   - 若为首次启动或 `chosen` 为“继续开发下一阶段”，检查工作树与 `docs/progress.json`，从 `docs/roadmap.md` 选择第一项尚未验收的任务。
2. **先写测试，再做实现**：
   - 先写能复现缺失行为或边界的测试，再编写实现。
   - Windows PowerShell 若限制 `.ps1`，使用 `npm.cmd` 调用脚本：依次通过 `npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run format:check`；若改动了 `src/integrations/` 或 `integrations/agent-autoloop/`，设置 `AGENT_AUTOLOOP_REPO` 为 `C:\Users\xingxiaoyu\.agent-autoloop\app` 并通过 `npm.cmd run test:integration`。
   - 公开网络在开发沙箱内不可访问时，完成离线验证并写清待本机验收步骤，不提高权限或把 fixture 说成实测。测试不连接券商、不发送真实消息。
3. **落盘提交与边界隔离**：
   - 一轮只交付一个可验收增量。更新 `docs/progress.json`（摘要与剩余 `next` 列表）并在 `docs/tasks/` 记录本阶段验收结果，通过格式检查后在当前开发分支创建 Git 提交，保持工作树干净。
   - 不合并 `main`、不发布、不改账户参数、不替本人确认交易、不直接覆盖 `~/.agent-autoloop/paper-trading` 下的运行副本或私人账户。需要更新运行副本时，结论与卡片写明“代码已提交开发分支，运行副本待复核更新”。
4. **回执闭环（飞书卡片推进下一轮）**：
   - 若 `docs/progress.json` 的 `next` 仍有后续阶段，在最后一条消息末尾附 `agent-autoloop` 回执，发一张 `ask` 卡片（每个阶段使用独立的 `key`，例如 `roadmap-step-1`、`roadmap-step-2`）：
     - `title`：`已完成：<本阶段简短名称>`
     - `text`：三行以内大白话说明本轮完成了什么与测试结果、运行副本待更新提醒，以及下一阶段准备做什么（可在飞书直接点继续，或在卡片输入框填写具体调整点提交）。
     - `options`：`["继续开发下一阶段", "先暂停，待我验收"]`，`recommend` 填 `0`。
     - `about`：写明刚完成的阶段提交号及下一阶段目标，提醒续接轮次先核对 `answers[0].chosen` / `answers[0].text`。
   - 若 `docs/roadmap.md` 全部阶段均已交付完成（`next` 为空），不再发循环 `ask`，改为发一张说明全部阶段已交付待整体验收的 `notice` 卡片。
