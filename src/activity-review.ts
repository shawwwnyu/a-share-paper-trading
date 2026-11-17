import { portfolioRisk } from "./portfolio-risk.ts";
import { review, renderReview } from "./review.ts";
import { chinaDay, requireThat, timestamp } from "./types.ts";
import type { Order } from "./types.ts";
import type { Ledger, LedgerView } from "./ledger.ts";

const countMap = () => Object.create(null) as Record<string, number>;
const bump = (map: Record<string, number>, key: string) => {
  map[key] = (map[key] ?? 0) + 1;
};
export function activityReview(view: LedgerView, from: string, to: string) {
  const start = timestamp(from),
    end = timestamp(to);
  requireThat(end > start, "复盘结束时间须晚于开始时间");
  const within = (at: string) => timestamp(at) > start && timestamp(at) <= end;
  const { state } = view;
  requireThat(!state.lastAt || timestamp(state.lastAt) <= end, "账本视图晚于报告截止时点，请读取对应历史视图");
  const records = view.records.filter((r) => timestamp(r.at) <= end);
  const scans = records
    .filter((r) => within(r.at) && (r.command.type === "watchlist" || r.command.type === "scan-observation"))
    .map((r) => {
      const scan = r.command.type === "watchlist" || r.command.type === "scan-observation" ? r.command.scan : undefined;
      return { at: r.at, applied: r.command.type === "watchlist", scan: scan! };
    });
  const scanReasons = countMap();
  for (const { scan } of scans) for (const item of scan.excluded) bump(scanReasons, item.reason);
  const signalRecords = records.filter((r) => within(r.at) && r.command.type === "signal");
  const checks = records
    .filter((r) => within(r.at) && r.command.type === "record-check")
    .flatMap((r) => (r.command.type === "record-check" ? [{ at: r.at, check: r.command.check }] : []));
  const byStrategy = Object.create(null) as Record<
    string,
    { created: number; buy: number; sell: number; blocked: number }
  >;
  const group = (strategy: string) => (byStrategy[strategy] ??= { created: 0, buy: 0, sell: 0, blocked: 0 });
  for (const r of signalRecords)
    if (r.command.type === "signal") {
      const signal = r.command.signal,
        row = group(signal.strategy);
      row.created++;
      row[signal.side]++;
    }
  for (const { check } of checks) if (check.kind === "signal-blocked") group(check.strategy).blocked++;
  const decisions = Object.values(state.orders).filter((o) => o.confirmedAt && within(o.confirmedAt));
  const delays = decisions.map((o) => (timestamp(o.confirmedAt!) - timestamp(o.at)) / 1000).sort((a, b) => a - b);
  const percentile = (p: number) => (delays.length ? delays[Math.ceil(delays.length * p) - 1] : null);
  const fills = state.fills.filter((f) => within(f.at));
  const executionByStrategy = Object.create(null) as Record<
    string,
    { fills: number; fees: number; executionDifference: number }
  >;
  for (const fill of fills) {
    const row = (executionByStrategy[fill.strategy] ??= { fills: 0, fees: 0, executionDifference: 0 });
    row.fills++;
    row.fees += fill.fees;
    row.executionDifference += (fill.price - fill.signalPrice) * fill.quantity * (fill.side === "buy" ? 1 : -1);
  }
  const realizedByEntry = Object.create(null) as Record<string, { pnl: number; exits: number; quantity: number }>;
  const realizedByExit = Object.create(null) as Record<string, { pnl: number; exits: number; quantity: number }>;
  for (const trade of state.closed.filter((t) => within(t.at))) {
    for (const [map, key] of [
      [realizedByEntry, trade.entryStrategy],
      [realizedByExit, trade.exitStrategy],
    ] as const) {
      const row = (map[key] ??= { pnl: 0, exits: 0, quantity: 0 });
      row.pnl += trade.pnl;
      row.exits++;
      row.quantity += trade.quantity;
    }
  }
  const fillChecks = checks.filter(({ check }) => check.kind === "fill-blocked");
  const byReason = countMap();
  for (const { check } of fillChecks) bump(byReason, check.reason);
  const recordedExpired: { id: string; at: string; reason: string }[] = [],
    recordedRejected: { id: string; at: string; reason: string }[] = [];
  let oldOrders: Record<string, Order> = {};
  for (const r of records)
    if (r.changes.orders) {
      for (const order of Object.values(r.changes.orders)) {
        if (within(r.at) && oldOrders[order.id]?.status !== order.status) {
          const entry = { id: order.id, at: r.at, reason: order.closedReason ?? "本人拒绝" };
          if (order.status === "expired") recordedExpired.push(entry);
          if (order.status === "rejected") recordedRejected.push(entry);
        }
      }
      oldOrders = r.changes.orders;
    }
  const outstanding = Object.values(state.orders).filter((o) => ["pending", "approved"].includes(o.status));
  const lapsed = (order: Order) => timestamp(order.expiresAt) <= end || order.strategy !== state.active;
  const snapshots = state.riskSnapshots.filter((r) => timestamp(r.at) <= end);
  return {
    from,
    to,
    coverage: "只统计截至时点已登记的事实；旧轮次未保存的检查不能推断为成功，筛选尝试不包含取数前即中断的轮次",
    screening: {
      scans: scans.length,
      complete: scans.filter((s) => s.scan.complete).length,
      incomplete: scans.filter((s) => !s.scan.complete).length,
      selected: scans.reduce((sum, s) => sum + s.scan.selected.length, 0),
      exclusions: scanReasons,
      snapshots: scans.map(({ at, scan, applied }) => ({
        at,
        id: scan.id,
        rule: scan.rule,
        universeSize: scan.universeSize,
        observed: scan.observed,
        selected: scan.selected.length,
        applied,
      })),
      promoted: state.watchlistHistory.filter((c) => within(c.at) && c.from !== "selected" && c.to === "selected")
        .length,
      removed: state.watchlistHistory.filter((c) => within(c.at) && c.from === "selected" && c.to !== "selected")
        .length,
    },
    signals: {
      created: signalRecords.length,
      blocked: checks.filter((c) => c.check.kind === "signal-blocked").length,
      byStrategy,
    },
    confirmation: {
      count: decisions.length,
      approved: decisions.filter((o) => o.decision === true).length,
      rejected: decisions.filter((o) => o.decision === false).length,
      averageSeconds: delays.length ? delays.reduce((sum, d) => sum + d, 0) / delays.length : null,
      medianSeconds: percentile(0.5),
      p95Seconds: percentile(0.95),
    },
    execution: {
      fills: fills.length,
      fees: fills.reduce((sum, f) => sum + f.fees, 0),
      byStrategy: executionByStrategy,
    },
    realizedByEntry,
    realizedByExit,
    unfilled: {
      pending: outstanding.filter((o) => o.status === "pending" && !lapsed(o)),
      approved: outstanding.filter((o) => o.status === "approved" && !lapsed(o)),
      expiredUnrecorded: outstanding.filter(lapsed),
      recordedExpired,
      recordedRejected,
      attempts: fillChecks.length,
      affectedOrders: new Set(fillChecks.flatMap(({ check }) => (check.kind === "fill-blocked" ? [check.signal] : [])))
        .size,
      byReason,
    },
    dataFailures: checks.filter(({ check }) => check.kind === "data-failure"),
    risk: {
      snapshots: snapshots.filter((r) => within(r.at)).length,
      latest: snapshots.at(-1) ?? null,
      current: portfolioRisk(state, Object.values(state.quotes), to),
    },
  };
}
export function renderActivityReview(activity: ReturnType<typeof activityReview>) {
  const seconds = (value: number | null) => (value === null ? "无已确认样本" : `${value.toFixed(1)} 秒`);
  return [
    "",
    "## 筛选、信号与执行",
    "",
    activity.coverage,
    "",
    `- 筛选：完整 ${activity.screening.complete} 次，不完整 ${activity.screening.incomplete} 次；累计入选 ${activity.screening.selected} 次（同股跨次重复计数），进入自选 ${activity.screening.promoted} 次、移出 ${activity.screening.removed} 次。`,
    `- 信号：登记 ${activity.signals.created} 笔，阻止生成 ${activity.signals.blocked} 次。`,
    `- 确认：${activity.confirmation.count} 笔，批准 ${activity.confirmation.approved}、拒绝 ${activity.confirmation.rejected}；平均延迟 ${seconds(activity.confirmation.averageSeconds)}，中位数 ${seconds(activity.confirmation.medianSeconds)}，95 分位 ${seconds(activity.confirmation.p95Seconds)}（含未成交与拒绝）。`,
    `- 未成交：待确认 ${activity.unfilled.pending.length} 笔，已确认待成交 ${activity.unfilled.approved.length} 笔；已到期或策略已变但尚未登记清理 ${activity.unfilled.expiredUnrecorded.length} 笔，本期记账过期 ${activity.unfilled.recordedExpired.length} 笔。`,
    `- 已记录的成交检查未通过 ${activity.unfilled.attempts} 次，涉及 ${activity.unfilled.affectedOrders} 笔委托。`,
    ...Object.entries(activity.unfilled.byReason).map(([reason, count]) => `- 未成交原因：${reason}，${count} 次。`),
    ...Object.entries(activity.signals.byStrategy).map(
      ([id, row]) =>
        `- 策略 ${id}：登记信号 ${row.created} 笔（买 ${row.buy}、卖 ${row.sell}），阻止生成 ${row.blocked} 次。`,
    ),
    "",
    "## 已实现交易归因",
    "",
    "以下是同一笔 FIFO 盈亏的两种分组，不可相加；保留已记账数值，不以现有策略重算。",
    "",
    ...Object.entries(activity.realizedByEntry).map(
      ([id, row]) => `- 入场策略 ${id}：${(row.pnl / 100).toFixed(2)} 元，${row.exits} 笔卖出归因。`,
    ),
    ...Object.entries(activity.realizedByExit).map(
      ([id, row]) => `- 退出策略 ${id}：${(row.pnl / 100).toFixed(2)} 元，${row.exits} 笔卖出归因。`,
    ),
    "",
    "## 持仓风险",
    "",
    `本期记录 ${activity.risk.snapshots} 次风险快照，最近快照 ${activity.risk.latest?.at ?? "缺少"}。`,
    `截至报告时点的风险估值${activity.risk.current.complete ? "资料齐全" : "资料不足"}，实际持仓 ${activity.risk.current.positionCount} 种。`,
    ...activity.risk.current.alerts.map((alert) => `- 截至时点提示：${alert.symbol ?? "组合"} ${alert.reason}。`),
    ...activity.risk.current.issues.map((issue) => `- ${issue}`),
    ...(activity.risk.latest?.alerts ?? []).map(
      (alert) => `- 最近快照提示：${alert.symbol ?? "组合"} ${alert.reason}。`,
    ),
    "",
    "风险快照只记录当时状态，不代表卖出或新增仓位已获批准；卖出仍需本人确认并满足 T+1 和成交条件。",
    "",
  ].join("\n");
}
export function dailyReview(ledger: Ledger, day: string, now = new Date().toISOString()) {
  const start = timestamp(`${day}T00:00:00+08:00`);
  requireThat(
    /^\d{4}-\d{2}-\d{2}$/.test(day) && chinaDay(new Date(start).toISOString()) === day && day <= chinaDay(now),
    "日报日期无效或来自未来",
  );
  const end = start + 86400000 - 1;
  const from = `${chinaDay(new Date(start - 1).toISOString())}T23:59:59.999+08:00`;
  const to = timestamp(now) < end ? now : `${day}T23:59:59.999+08:00`;
  const view = ledger.view(to);
  requireThat(view.state.config, "截止时点账户尚未初始化");
  const performance = review(view.state, from, to);
  if (
    timestamp(to) >= timestamp(`${day}T15:00:00+08:00`) &&
    (!performance.closingAt || timestamp(performance.closingAt) < timestamp(`${day}T15:00:00+08:00`))
  ) {
    performance.complete = false;
    performance.issues.push("缺少当日收盘估值");
    performance.pnl =
      performance.cashFlow =
      performance.returnRate =
      performance.maxDrawdown =
      performance.realized =
      performance.unrealizedChange =
      performance.fees =
        null;
    performance.recommendation = "保持不变，缺少当日收盘估值";
  }
  return {
    version: "daily-review-v1",
    day,
    from,
    to,
    dayEnded: timestamp(now) >= end,
    ledgerAt: view.state.lastAt,
    performance,
    workflow: activityReview(view, from, to),
    recommendation: performance.complete
      ? "保持现有策略；每日复盘不自动调参，策略变化须先独立验证并经本人批准"
      : performance.recommendation,
  };
}
export function renderDailyReview(report: ReturnType<typeof dailyReview>) {
  return (
    renderReview(report.performance).replace("# 模拟交易周度复盘", `# 模拟交易每日复盘：${report.day}`) +
    `\n统计截至 ${report.to}，${report.dayEnded ? "该自然日已结束" : "该自然日尚未结束"}。\n` +
    renderActivityReview(report.workflow) +
    `\n${report.recommendation}\n`
  );
}
