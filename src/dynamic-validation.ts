import { emptyState } from "./ledger.ts";
import { bookFill, buyQuantity, checkQuote, checkQuantity, makeFill, tradingTime } from "./execution.ts";
import { checkBuyRisk, checkRiskPolicy, orderPriority, riskExit } from "./risk.ts";
import { closesAsOf, direction } from "./strategy.ts";
import { assessEvidence, EVIDENCE_VERSION, screenWithEvidence } from "./evidence.ts";
import type { EvidenceDataset } from "./evidence.ts";
import { screen, SCREEN_VERSION } from "./monitor.ts";
import { dayNumber, digest, verifySnapshot } from "./scan-snapshot.ts";
import type { ScanSnapshot } from "./scan-snapshot.ts";
import { checkStrategy, chinaDay, integer, requireThat, symbolCode, timestamp } from "./types.ts";
import type { AccountConfig, Bar, Fill, Lot, Order, Performance, Quote, Strategy } from "./types.ts";

export const DYNAMIC_MODEL = "dynamic-watchlist-daily-v1";
export type DynamicPlan = { account: AccountConfig; strategy: Strategy; trainingEnd: string };
export type DynamicSession = {
  day: string;
  snapshot: ScanSnapshot;
  bars: Bar[];
  decisionAt: string;
  executionAt: string;
  decisionQuotes: Quote[];
  executionQuotes: Quote[];
  openingEvidence: EvidenceDataset;
};
export type DynamicDataset = {
  source: string;
  adjustment: "none";
  marketRulesVerified: boolean;
  corporateActionsVerified: boolean;
  universeHistoryVerified: boolean;
  calendar: { source: string; verified: boolean; days: string[] };
  sessions: DynamicSession[];
};
export type DynamicRun = Performance & {
  fills: Fill[];
  holdings: Lot[];
  equity: { day: string; equity: number }[];
  decisions: { day: string; snapshotHash: string; symbols: string[] }[];
  skipped: { day: string; symbol: string; side: "buy" | "sell"; reason: string }[];
};
export type DynamicValidation = {
  model: string;
  datasetHash: string;
  planHash: string;
  trainingEnd: string;
  from: string | null;
  to: string | null;
  valid: boolean;
  passed: boolean;
  canActivate: false;
  reasons: string[];
  limitations: string[];
  baseline?: DynamicRun;
  candidate?: DynamicRun;
};
function checkPlan(plan: DynamicPlan) {
  dayNumber(plan.trainingEnd);
  checkStrategy(plan.strategy);
  const c = plan.account;
  integer(c.cash, "初始资金", 1);
  integer(c.minimumCommission, "最低佣金");
  integer(c.maxQuoteAgeSeconds, "行情有效秒数", 1);
  requireThat(c.maxQuoteAgeSeconds <= 300, "行情有效期超出范围");
  for (const key of ["commissionBps", "sellTaxBps", "transferBps", "slippageBps"] as const)
    requireThat(Number.isFinite(c[key]) && c[key] >= 0 && c[key] <= 1000, "费用或滑点参数无效");
  requireThat(
    Array.isArray(c.symbols) && c.symbols.length > 0 && new Set(c.symbols).size === c.symbols.length,
    "初始股票配置无效",
  );
  c.symbols.forEach(symbolCode);
  if (c.risk) checkRiskPolicy(c.risk);
}
function checkData(data: DynamicDataset, asOf: string) {
  requireThat(data?.source?.trim() && data.adjustment === "none", "动态验证需要有来源的不复权资料");
  requireThat(data.universeHistoryVerified === true, "缺少逐日历史股票池目录核实，不能排除幸存者偏差");
  requireThat(
    data.marketRulesVerified === true && data.corporateActionsVerified === true,
    "缺少逐日交易限制或公司行为核实",
  );
  requireThat(
    data.calendar?.verified === true && data.calendar.source?.trim() && Array.isArray(data.calendar.days),
    "缺少核实交易日历",
  );
  const days = data.calendar.days;
  requireThat(days.length > 0 && new Set(days).size === days.length, "交易日历为空或重复");
  days.forEach((day, i) =>
    requireThat(
      Number.isFinite(dayNumber(day)) && (!i || day > days[i - 1]) && day < chinaDay(asOf),
      "交易日历日期乱序、未结束或来自未来",
    ),
  );
  requireThat(
    Array.isArray(data.sessions) && digest(data.sessions.map((s) => s.day)) === digest(days),
    "逐日数据与核实交易日历不一致",
  );
  const seen = new Set<string>();
  for (const s of data.sessions) {
    verifySnapshot(s.snapshot);
    requireThat(
      chinaDay(s.snapshot.report.at) === s.day &&
        timestamp(s.snapshot.report.at) >= timestamp(at(s.day, "15:00:00")) &&
        timestamp(s.snapshot.availableAt) <= timestamp(asOf),
      "历史快照须在当日收盘后可知，且不晚于验证时间",
    );
    requireThat(
      chinaDay(s.decisionAt) === s.day &&
        chinaDay(s.executionAt) === s.day &&
        tradingTime(s.decisionAt) &&
        tradingTime(s.executionAt) &&
        timestamp(s.executionAt) > timestamp(s.decisionAt) + 1 &&
        timestamp(s.executionAt) < timestamp(s.snapshot.report.at),
      "决策和后续成交行情时间无效",
    );
    for (const symbol of s.snapshot.universe.symbols) seen.add(symbol);
    requireThat(Array.isArray(s.bars), "缺少历史成员日线");
    const bars = new Map<string, Bar>();
    for (const b of s.bars) {
      symbolCode(b.symbol);
      requireThat(b.day === s.day && !bars.has(b.symbol), "日线日期、代码或重复行无效");
      for (const key of ["open", "high", "low", "close"] as const) integer(b[key], key, 1);
      integer(b.volume, "成交量");
      integer(b.limitDown!, "跌停价格", 1);
      integer(b.limitUp!, "涨停价格", 1);
      requireThat(
        typeof b.suspended === "boolean" &&
          b.low <= Math.min(b.open, b.close) &&
          b.high >= Math.max(b.open, b.close) &&
          b.limitDown! <= b.low &&
          b.limitUp! >= b.high &&
          b.limitDown! < b.limitUp!,
        "日线价格、停牌或交易限制无效",
      );
      if (b.action) {
        requireThat(Number.isFinite(b.action.shareRatio) && b.action.shareRatio > 0, "公司行为股数比例无效");
        integer(b.action.cashPerShare, "公司行为红利");
      }
      bars.set(b.symbol, b);
    }
    for (const symbol of seen) requireThat(bars.has(symbol), `缺少历史成员 ${symbol} 的日线，不能丢弃退出目录的股票`);
    for (const [quotes, time] of [
      [s.decisionQuotes, s.decisionAt],
      [s.executionQuotes, s.executionAt],
    ] as const) {
      requireThat(
        Array.isArray(quotes) && new Set(quotes.map((q) => q.symbol)).size === quotes.length,
        "逐日盘口缺失或重复",
      );
      for (const symbol of seen)
        requireThat(
          quotes.some((q) => q.symbol === symbol),
          `缺少历史成员 ${symbol} 的盘口`,
        );
      for (const q of quotes) {
        requireThat(q.at === time && bars.has(q.symbol), "盘口时间与本次取数时间不符或缺少日线");
        checkQuote(q, time, 300);
        const bar = bars.get(q.symbol)!;
        requireThat(
          q.limitDown === bar.limitDown && q.limitUp === bar.limitUp && q.price >= bar.low && q.price <= bar.high,
          "盘口与当日日线或限制不一致",
        );
        requireThat(!bar.suspended || q.volume === 0, "停牌记录与成交量不一致");
      }
    }
    requireThat(s.openingEvidence && Array.isArray(s.openingEvidence.records), "缺少开盘时的证据列表");
    requireThat(
      new Set(s.openingEvidence.records.map((r) => r.symbol)).size === s.openingEvidence.records.length,
      "开盘证据股票重复",
    );
  }
}
const at = (day: string, clock: string) => `${day}T${clock}+08:00`;
function replay(plan: DynamicPlan, data: DynamicDataset, from: string, evidenceRule: boolean): DynamicRun {
  const state = emptyState();
  state.config = structuredClone(plan.account);
  state.active = plan.strategy.id;
  state.cash = plan.account.cash;
  const history = new Map<string, Bar[]>();
  const previousVolume = new Map<string, number>();
  const result: DynamicRun = {
    pnl: 0,
    returnRate: 0,
    maxDrawdown: 0,
    closedTrades: 0,
    fees: 0,
    fills: [],
    holdings: [],
    equity: [],
    decisions: [],
    skipped: [],
  };
  let peak = state.cash;
  for (let i = 0; i < data.sessions.length; i++) {
    const s = data.sessions[i];
    for (const b of s.bars)
      if (b.action) {
        state.corporateActions.push({ symbol: b.symbol, day: s.day, ...b.action, reference: data.source });
        for (const lot of state.lots.filter((l) => l.symbol === b.symbol && l.day < s.day)) {
          state.cash += lot.quantity * b.action.cashPerShare;
          lot.quantity = integer(lot.quantity * b.action.shareRatio, "公司行为调整后股数", 1);
        }
      }
    if (s.day >= from) {
      const previous = data.sessions[i - 1].snapshot;
      requireThat(timestamp(previous.availableAt) < timestamp(s.decisionAt), "前次股票池在决策时尚不可知");
      const missing = previous.report.excluded.filter((x) => !previous.rows.some((r) => r.symbol === x.symbol));
      const basic = screen(previous.universe.symbols, previous.rows, [], previous.report.at, missing);
      const selected = evidenceRule
        ? screenWithEvidence(basic, previous.rows, previous.evidence ?? { records: [] }, previous.report.at).selected
        : basic.selected;
      const members = new Set(selected.map((c) => c.symbol));
      result.decisions.push({ day: s.day, snapshotHash: previous.hash, symbols: [...members] });
      const orders: Order[] = [];
      for (const q of s.decisionQuotes) {
        const holding = state.lots.filter((l) => l.symbol === q.symbol).reduce((sum, l) => sum + l.quantity, 0);
        const closes = closesAsOf(history.get(q.symbol) ?? [], state.corporateActions, s.day);
        const exit = holding ? riskExit(state, q, s.decisionAt) : null;
        const side = exit ? "sell" : direction(closes, plan.strategy, holding > 0);
        if (!side || (side === "buy" && !members.has(q.symbol))) continue;
        const quantity =
          side === "sell"
            ? holding
            : buyQuantity(q.symbol, (state.cash * plan.strategy.allocationBps) / 10000, q.price);
        if (!quantity) continue;
        const expiresAt = new Date(
          Math.min(
            timestamp(at(s.day, "14:57:00")),
            timestamp(s.decisionAt) + (plan.account.risk?.maxOrderAgeMinutes ?? 1440) * 60000,
          ),
        ).toISOString();
        orders.push({
          id: `${s.day}/${q.symbol}/${side}`,
          symbol: q.symbol,
          side,
          quantity,
          price: q.price,
          at: s.decisionAt,
          strategy: state.active,
          expiresAt,
          reason: exit?.reason ?? "前次收盘股票池与此前已结束日线",
          status: "approved",
          decision: true,
          confirmedAt: new Date(timestamp(s.decisionAt) + 1).toISOString(),
          by: "backtest-assumption",
        });
      }
      for (const order of orders.sort(orderPriority)) {
        try {
          const q = s.executionQuotes.find((q) => q.symbol === order.symbol)!;
          const bar = s.bars.find((b) => b.symbol === order.symbol)!;
          requireThat(!bar.suspended && q.volume > 0, "停牌或没有当日成交");
          requireThat(order.quantity <= (previousVolume.get(order.symbol) ?? 0) * 0.01, "超过上一交易日成交量的 1%");
          requireThat(q.price > q.limitDown && q.price < q.limitUp, "触及涨跌停，跳过本次成交");
          if (order.side === "buy" && evidenceRule) {
            const record = s.openingEvidence.records.find((r) => r.symbol === order.symbol);
            const reasons = [...assessEvidence(record, s.decisionAt), ...assessEvidence(record, s.executionAt)];
            requireThat(!reasons.length, reasons.join("；"));
            for (const action of record!.corporateActions!.value.events)
              requireThat(
                state.corporateActions.some(
                  (known) =>
                    known.symbol === order.symbol &&
                    known.day === action.day &&
                    known.shareRatio === action.shareRatio &&
                    known.cashPerShare === action.cashPerShare,
                ),
                "公司行为尚未在模拟账本核对",
              );
            if (plan.account.risk?.maxIndustryBps !== undefined)
              requireThat(
                plan.account.risk.industries?.[order.symbol] === record!.industry!.value.name,
                "行业证据与冻结分类不符",
              );
          }
          checkQuantity(order.symbol, order.side, order.quantity);
          const fill = makeFill(state, order, q, s.executionAt);
          requireThat(fill.price > q.limitDown && fill.price < q.limitUp, "含滑点成交价触及涨跌停，跳过本次成交");
          checkBuyRisk(state, fill, q, s.executionQuotes, s.executionAt);
          bookFill(state, fill);
        } catch (error) {
          result.skipped.push({ day: s.day, symbol: order.symbol, side: order.side, reason: (error as Error).message });
        }
      }
    }
    for (const b of s.bars) {
      const past = history.get(b.symbol) ?? [];
      past.push(b);
      history.set(b.symbol, past);
      previousVolume.set(b.symbol, b.volume);
    }
    if (s.day >= from) {
      const equity = integer(
        state.cash +
          state.lots.reduce((sum, lot) => sum + lot.quantity * s.bars.find((b) => b.symbol === lot.symbol)!.close, 0),
        "期末资产",
      );
      peak = Math.max(peak, equity);
      result.maxDrawdown = Math.max(result.maxDrawdown, (peak - equity) / peak);
      result.equity.push({ day: s.day, equity });
    }
  }
  result.pnl = result.equity.at(-1)!.equity - plan.account.cash;
  result.returnRate = result.pnl / plan.account.cash;
  result.closedTrades = state.closed.length;
  result.fees = state.fees;
  result.fills = state.fills;
  result.holdings = state.lots;
  return result;
}
export function validateDynamic(
  plan: DynamicPlan,
  data: DynamicDataset,
  asOf = new Date().toISOString(),
): DynamicValidation {
  const report: DynamicValidation = {
    model: DYNAMIC_MODEL,
    datasetHash: digest(data),
    planHash: digest(plan),
    trainingEnd: plan.trainingEnd,
    from: null,
    to: null,
    valid: false,
    passed: false,
    canActivate: false,
    reasons: [],
    limitations: [
      "导入者须独立核实历史目录、交易日历、停牌与公司行为，校验值只检测内容变化",
      "每日仅在所提供的两个时点决策及撮合，不等同盘中连续执行；确认按事先同意全部模拟信号处理",
      "本报告为离线反事实比较，不更改既有账本或策略，也不能直接作为启用许可",
    ],
  };
  try {
    checkPlan(plan);
    checkData(data, asOf);
    const holdout = data.sessions.filter((s) => s.day > plan.trainingEnd);
    report.from = holdout[0]?.day ?? null;
    report.to = holdout.at(-1)?.day ?? null;
    requireThat(holdout.length >= 60, "未参与调参的历史资料不足 60 个交易日");
    requireThat(
      data.sessions.filter((s) => s.day <= plan.trainingEnd).length >= plan.strategy.lookback,
      "独立区间之前缺少均线预热数据",
    );
    const baseline = replay(plan, data, report.from!, false),
      candidate = replay(plan, data, report.from!, true);
    report.baseline = baseline;
    report.candidate = candidate;
    report.valid = true;
    if (Math.min(baseline.closedTrades, candidate.closedTrades) < 20)
      report.reasons.push("基线或候选的卖出归因样本不足 20 笔，保持现有策略");
    if (candidate.returnRate <= baseline.returnRate) report.reasons.push("候选扣除费用和滑点后的收益未改善");
    if (candidate.maxDrawdown > baseline.maxDrawdown) report.reasons.push("候选的最大回撤增大");
    report.passed = report.reasons.length === 0;
  } catch (error) {
    report.reasons.push((error as Error).message);
  }
  return report;
}
