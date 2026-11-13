import { timestamp } from "./types.ts";
import type { State } from "./types.ts";

export function review(state: State, from: string, to: string) {
  const start = timestamp(from);
  const end = timestamp(to);
  if (end <= start) throw new Error("复盘结束时间须晚于开始时间");
  const opening = state.points.filter((p) => timestamp(p.at) <= start).at(-1);
  const closing = state.points.filter((p) => timestamp(p.at) <= end).at(-1);
  const issues: string[] = [];
  if (!opening) issues.push("缺少期初估值");
  if (!closing || timestamp(closing.at) <= start) issues.push("缺少本期末估值");
  if (opening && start - timestamp(opening.at) > 4 * 86400_000) issues.push("期初估值超过四天，请核对节假日与行情缺口");
  if (closing && end - timestamp(closing.at) > 4 * 86400_000) issues.push("期末估值超过四天，请补齐行情");
  const complete = issues.length === 0;
  const within = (at: string) => timestamp(at) > start && timestamp(at) <= end;
  const fills = state.fills.filter((f) => within(f.at));
  const closed = state.closed.filter((t) => within(t.at));
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const points = state.points.filter((p) => within(p.at));
  let peak = opening?.nav ?? 1;
  let maxDrawdown = 0;
  for (const p of points) {
    peak = Math.max(peak, p.nav);
    maxDrawdown = Math.max(maxDrawdown, (peak - p.nav) / peak);
  }
  const byStrategy: Record<string, { realized: number; exits: number }> = {};
  for (const t of closed) {
    const group = (byStrategy[t.entryStrategy] ??= { realized: 0, exits: 0 });
    group.realized += t.pnl;
    group.exits++;
  }
  const cashFlow = complete ? closing!.cashFlow - opening!.cashFlow : null;
  return {
    from,
    to,
    openingAt: opening?.at ?? null,
    closingAt: closing?.at ?? null,
    complete,
    issues,
    pnl: complete ? closing!.equity - opening!.equity - cashFlow! : null,
    cashFlow,
    returnRate: complete ? closing!.nav / opening!.nav - 1 : null,
    maxDrawdown: complete ? maxDrawdown : null,
    realized: complete ? closing!.realized - opening!.realized : null,
    unrealizedChange: complete ? closing!.unrealized - opening!.unrealized : null,
    fees: complete ? closing!.fees - opening!.fees : null,
    trades: fills.length,
    exits: closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    averageWin: wins.length ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : null,
    averageLoss: losses.length ? losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length : null,
    averageConfirmationSeconds: fills.length
      ? fills.reduce((sum, f) => sum + (timestamp(f.confirmedAt) - timestamp(f.signalAt)) / 1000, 0) / fills.length
      : null,
    executionDifference: fills.reduce(
      (sum, f) => sum + (f.price - f.signalPrice) * f.quantity * (f.side === "buy" ? 1 : -1),
      0,
    ),
    byStrategy,
    recommendation: !complete
      ? "保持不变，估值资料不完整"
      : closed.length < 20
        ? "保持不变，已平仓样本不足"
        : "核对分策略表现后提出单项修改，验证通过再交本人批准",
  };
}
export function renderReview(result: ReturnType<typeof review>) {
  const money = (n: number | null) => (n === null ? "资料不足" : `${(n / 100).toFixed(2)} 元`);
  const percent = (n: number | null) => (n === null ? "资料不足" : `${(n * 100).toFixed(2)}%`);
  return [
    "# 模拟交易周度复盘",
    "",
    `${result.from} 至 ${result.to}`,
    "",
    "| 指标 | 结果 |",
    "| --- | --- |",
    `| 本期盈亏 | ${money(result.pnl)} |`,
    `| 模拟净入金 | ${money(result.cashFlow)} |`,
    `| 现金流调整后收益率 | ${percent(result.returnRate)} |`,
    `| 已记录估值点的最大回撤 | ${percent(result.maxDrawdown)} |`,
    `| 已实现盈亏 | ${money(result.realized)} |`,
    `| 持仓浮盈亏变化 | ${money(result.unrealizedChange)} |`,
    `| 本期费用（已计入盈亏） | ${money(result.fees)} |`,
    `| 成交笔数 / 卖出归因笔数 | ${result.trades} / ${result.exits} |`,
    `| 胜率 | ${percent(result.winRate)} |`,
    `| 平均盈利 / 平均亏损 | ${money(result.averageWin)} / ${money(result.averageLoss)} |`,
    `| 平均确认延迟 | ${result.averageConfirmationSeconds?.toFixed(1) ?? "无成交"} 秒 |`,
    `| 相对信号价格的执行成本 | ${money(result.executionDifference)} |`,
    "",
    `期初估值 ${result.openingAt ?? "缺少"}，期末估值 ${result.closingAt ?? "缺少"}。`,
    "",
    ...Object.entries(result.byStrategy).map(
      ([id, row]) => `- 策略 ${id} 的已实现交易盈亏 ${money(row.realized)}，卖出归因 ${row.exits} 笔。`,
    ),
    "",
    ...result.issues.map((issue) => `- ${issue}`),
    "",
    result.recommendation,
    "",
    "卖出按 FIFO 分配到买入策略，分批卖出按实际卖出部分统计。回撤基于已记录估值点，盘中未采样的波动可能更大。",
    "",
  ].join("\n");
}
