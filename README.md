# A 股模拟交易与每周复盘

本项目用固定脚本完成行情读取、人工确认、模拟成交、账本、周报和策略版本审批。中台负责定时、卡片、回答和重派。所有金额以整数分保存，界面输出换算成人民币元。

## 先跑一遍

需要 Node.js 24。仓库根目录运行下面的命令，演示会在指定的新数据库中完成两次确认、买卖、费用记账和周度复盘。

```powershell
node src/cli.ts demo "$env:TEMP/paper-demo.db"
```

演示使用明确标记的合成行情。再次运行时换一个新的数据库文件名。测试通过的完整流程还包括候选验证、人工批准和旧版本保留。

## 安装和初始化

克隆本项目后进入项目根目录。运行需要 Node.js 24，业务命令无需安装 npm 依赖。开发和测试时执行 npm ci。

```powershell
git clone https://github.com/shawwwnyu/a-share-paper-trading.git
cd a-share-paper-trading
Copy-Item account.example.json account.json
```

先编辑 account.json，填写自选股池、模拟资金、手续费和滑点。示例资金是 10 万元，股票仅用于接口检查。核对后再初始化，初始化会冻结账户参数和初始策略，后续修改配置不会重写既有账户。

```powershell
node src/cli.ts init account.json
node src/cli.ts status account.json
```

数据库和报告默认位于 private/，配置和数据均已加入忽略规则，也可以把账户配置放在仓库外的私人目录。配置中的相对路径以账户配置文件所在目录为基准。

定时执行与卡片审批按 [中台接入说明](integrations/agent-autoloop/README.md)配置。中台独立安装，本项目保留手动 CLI 操作能力。

## 日常操作

```powershell
node src/cli.ts status account.json
node src/cli.ts quotes account.json
node src/cli.ts history account.json private/history.json
node src/cli.ts review account.json "2026-11-06T15:00:01+08:00" "2026-11-13T15:00:01+08:00"
```

`status` 输出信号、决定、成交、持仓、估值和策略记录。周报自动保存在 `private/reports/`，同时提供 Markdown 和 JSON。

本机手动记账用 `apply`，每个操作指定稳定且唯一的编号。同一编号和相同内容重试只记一次，换内容会报错。操作时间由命令运行时取值，历史信号时间和确认时间另存。

```powershell
node src/cli.ts apply account.json deposit-001 deposit.json
```

模拟入金的 `deposit.json` 如下。金额为分。账户有持仓时，`quotes` 必须包含全部持仓的最新行情，可从 `quotes` 命令取得。

```json
{ "type": "cash", "amount": 100000, "note": "增加一千元模拟资金", "quotes": [] }
```

人工录入建议也使用 `apply`。时间须按当前情况填写，股票和策略必须已经登记。

```json
{
  "type": "signal",
  "signal": {
    "id": "manual-001", "symbol": "sh600000", "side": "buy", "quantity": 100,
    "price": 1000, "at": "2026-11-13T10:00:00+08:00", "expiresAt": "2026-11-13T14:56:59+08:00",
    "strategy": "initial-v1", "reason": "填写本次判断的依据和数据时间"
  }
}
```

对应的确认操作为 `{"type":"decide","signal":"manual-001","approve":true,"by":"owner"}`。拒绝时 `approve` 填 `false`。撮合操作为 `{"type":"fill","signal":"manual-001","quote":{...}}`，`quote` 使用 `quotes` 输出的对应股票对象。后台轮询会自动处理已批准的建议。

## 成交口径

- 买入建议和卖出建议都先确认，确认记录不改变现金或持仓。只有确认之后、仍在有效期内、与当前时间相差最多配置秒数的行情可用于成交。
- 使用卖一买入、买一卖出，再加不利方向的滑点。盘口数量不足整笔数量时保持待成交。行情必须含有效涨跌停价格，加入滑点后的价格仍须在范围内。
- 沪深主板和创业板买入按 100 股整数倍。科创板至少 200 股，北交所至少 100 股，之后允许按 1 股增加。当天新买入的股票按 T+1 留到后续交易日卖出。零股卖出按整笔余额检查。
- 仅在 09:30–11:30 和 13:00–14:57 连续竞价时段撮合。休市、停牌、无当日成交、过期报价、无对手盘及缺少涨跌停字段都会保留待成交。限价字段取自当日报价。
- 佣金、最低佣金、卖出税费、过户费和滑点逐笔保存。卖出按 FIFO 分配买入成本与费用，已实现交易盈亏归到入场策略，另存退出策略。
- 本项目以现货多头和单币种现金账户为范围。估值使用不复权价格。分红、送转和拆并股须按真实生效日核实后录入公司行为，再进行当日估值和成交。公司行为需提供来源 `reference`、`shareRatio` 和每股净到账红利 `cashPerShare`，例如 `{"type":"corporate-action","symbol":"sh600000","shareRatio":1,"cashPerShare":10,"reference":"本人核对过的公告链接"}`。金额仍为分。配股、现金替代等复杂行为须先核对并整理到账本支持的现金与股份变动。

## 复盘口径

期末资产减期初资产，再扣模拟净入金，就是本期盈亏。期初已有持仓按期初市值进入本周，分解为本期已实现盈亏与持仓浮盈亏变化。费用已进入这两项，费用栏供单独核对。

收益率采用份额净值法，入出金前必须用完整持仓行情估值，再按当时净值增减份额。回撤用记录下来的净值点计算，周报写明实际采用的期初与期末时间，以及采样范围。缺少期初或期末估值时显示资料不足。跨节假日的四天以上估值间隔也会标记待核对。费用各项向上取整到分。

公司行为可填写 `day` 指定生效日期，默认当天。初始化后应补齐均线窗口内已经核实的历史公司行为。生效日及之后已经成交时，补记会被拒绝，需先核对账本。登记后的公司行为同时用于日常信号和候选回测的历史调整。

胜率与平均盈亏按 FIFO 卖出归因记录统计，分批卖出分别计入。周报同时列出确认延迟、成交价格相对信号价格的差额和各入场版本的交易盈亏。

## 策略改进和批准

初始策略用已收盘日线的均线及入退场阈值生成建议，每只股票持有一个方向。仓位上限是单次使用可用现金的比例。示例参数用于验证软件流程，用户可登记自己的初始配置。

周度样本不足 20 笔卖出归因时，报告写明保持不变。样本达到条件、平均亏损大于平均盈利时，脚本提出一项“提高入场阈值 25 个基点”的待验证假设。这个启发式方案包含原版本、证据和风险。每次只登记一个参数变化，调参截止日记为复盘当天。

自己提出候选也可以保存下列内容为 JSON 后 `apply`。训练截止日期必须覆盖提出该参数时使用过的全部数据。

```json
{
  "type": "propose",
  "strategy": { "id": "candidate-001", "lookback": 20, "entryBps": 125, "exitBps": 100, "allocationBps": 2000 },
  "rationale": "发现的问题和拟修改的规则", "evidence": "周报日期、样本与统计", "risk": "修改可能带来的代价",
  "trainingEnd": "2026-11-13"
}
```

验证数据采用以下格式，金额为分、成交量为股。`marketRulesVerified` 和 `corporateActionsVerified` 表示导入者已经逐日核对交易限制、停牌和公司行为，须在数据确实完整后填写 `true`。

```json
{
  "source": "核实过的数据来源和导出时间", "adjustment": "none",
  "marketRulesVerified": true, "corporateActionsVerified": true,
  "bars": [
    { "symbol": "sh600000", "day": "2026-11-12", "open": 1014, "high": 1024, "low": 1003, "close": 1021,
      "volume": 50081700, "limitUp": 1119, "limitDown": 915, "suspended": false }
  ]
}
```

有公司行为的当日日线增加 `action`，如 `{"shareRatio":1.1,"cashPerShare":10}`。自选股池中每只股票的每个日期都要有记录，停牌日也须保留。验证使用原始价格成交，公司行为发生时才调整当时可见的均线历史。腾讯日线导出默认将两个核实标记设为 `false`。

验证命令内容为 `{"type":"validate","proposal":"candidate-001","dataset":{...}}`，`dataset` 填完整数据对象。在 `account.json` 配置 `validationData` 指向该数据文件后，周度任务也会自动验证候选。

验证区间须晚于调参截止日，至少 60 个交易日，并提供此前的均线预热数据。原策略与候选使用相同数据、初始资金、费用与滑点。信号用已结束日线，最早在下一交易日开盘撮合，单笔数量不超过上一交易日成交量的 1%，触及涨跌停或停牌时跳过。回测中的确认按事先同意所有模拟信号处理，实际人工确认延迟在账户周报单列。

两个策略各有至少 20 笔卖出归因，候选净收益提高且最大回撤未增大，才发策略审批卡。自动周报提出的方案须积累截止日之后的数据。本人批准后保存新版本与批准记录，历史信号、成交和旧版本继续保留。选择保留当前策略会结束该候选。

## 数据与实测

接口路径和字段口径参考用户指定的 `a-stock-data`，本实现使用 Node 自带 `fetch` 和 GBK 解码。实时行情、原始日线和交易日历分别接腾讯与深交所。[a-stock-data](https://github.com/simonlin1212/a-stock-data)

2026-11-13 在 Windows、Node 24.22.3 实测了两只示例股票的实时价、盘口、涨跌停字段，读取了 61 行日线并核实当天交易日历。真实日线价格尾随第三位零的格式已经加入回归测试。北交所历史日线需从参考项目的其他来源或本人数据文件导入。

A 股交易时段、申报数量与交收约束以交易所规则为依据，市场差异体现在执行器中。[上交所 2026 年交易规则](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20260424_10816492.shtml)

数据库是本项目自己的 SQLite 事实账本，和中台日志分别保存。每个操作在同一事务内核对状态并追加已计算的变动，重启逐条恢复，费用和成交结果沿用已记录数值。备份须覆盖 `private/` 以及账户配置，运行中的 SQLite 还包括 WAL 文件。配置与交易数据放在私人目录中。

## 开发与项目边界

- src/ledger.ts、execution.ts 负责资产事实和模拟成交。
- src/market.ts、strategy.ts、review.ts 负责行情、策略验证与复盘。
- src/config.ts 负责账户配置，src/cli.ts 提供本地命令入口。
- src/integrations/agent-autoloop.ts 将中台上下文转换成业务调用并生成卡片回执。
- integrations/agent-autoloop 保存接入规则，integration-tests 单独检查与真实中台的兼容性。

```powershell
npm ci
npm test
npm run typecheck
npm run format:check
```

这些检查独立于中台源码。接入兼容性检查的配置见中台接入说明。[来源与拆分记录](docs/ORIGIN.md)保留初版提交与许可证信息。
