# 接入 agent-autoloop

中台负责定时、并发、重派和卡片。交易项目读取行情、检查成交条件、记录资产与策略版本。中台日志和交易账本分别保存。

1. 先按根目录 README 初始化模拟账户。中台和本项目可以分别安装在任意目录。
2. 将本目录 rules.json 的 agents、rules 和 desktop 通道合入中台已有规则。保留你原有的规则。
3. 将三处 worker 改成接单电脑名，cwd 指向本项目根目录，将命令中的 account.json 改为你的配置文件绝对路径。node 需要在后台 PATH 中可用，也可以填写绝对路径。
4. 运行 agent-autoloop check，按中台现有流程加载规则。
5. 通过桌面卡片的命令或卡片链接回答。确认后由后续有效行情撮合，策略只有验证通过并经本人批准才启用。

交易检查每个工作日每五分钟触发，脚本再核对交易日历和连续竞价时间。15 点触发估值，周日 18 点触发复盘。时区为 Asia/Shanghai，三条规则共用 paper-account 串行组。

命令入口为 src/cli.ts 的 agent-cycle、agent-mark 和 agent-review。中台通过 AGENT_AUTOLOOP_CONTEXT 提供本轮资料，命令输出 agent-autoloop JSON 回执。提问后结束本轮，收到回答再继续。

只将这些规则连接到本人可见的通道。接单账号需要读取配置和行情、写入交易数据库和报告的权限。事件正文不能改变命令、目录、接收人或授权范围。

## 从原模板迁移

原先尚未启用的账户可以直接按根目录 README 初始化。

已经运行原模板时，先暂停原来的三条规则，等正在执行的命令退出。备份账户配置、整个 private 目录以及仍存在的 SQLite WAL 文件。将 cwd 改到新项目根目录，命令入口从 cli.ts 改成 src/cli.ts，账户配置使用原来的绝对路径。保留原规则名、分组、数据库位置及配置内相对路径的基准目录，卡片和账本可以继续使用。

本次只迁移代码归属和入口路径，账本格式、操作编号和策略记录保持不变。不要对已有账户再次执行 init。运行 status 核对持仓和策略后，再恢复规则。

## 兼容性验收

本项目的 npm test、类型检查和格式检查独立运行。与中台的兼容性单独验证，使用真实的规则校验器和回执解析器，不启动服务或发送通知。

PowerShell 示例

```powershell
$env:AGENT_AUTOLOOP_REPO = "C:\path\to\agent-autoloop"
npm run test:integration
```

CI 使用固定的中台基线 c9ec4a187cab49627947e7e33db265ec143db3b8，升级中台时重新运行这项检查。

中台仓库 https://github.com/shawwwnyu/agent-autoloop
上游协议 https://github.com/KKKKhazix/agent-autoloop/blob/c9ec4a187cab49627947e7e33db265ec143db3b8/docs/protocol.md
