import { createHash } from "node:crypto";
import { bookFill, buyQuantity, costs } from "./execution.ts";
import { checkStrategy, integer, requireThat, symbolCode } from "./types.ts";
import type { AccountConfig, Bar, Dataset, Performance, State, Strategy, Validation } from "./types.ts";

const adjustedPrice = (price: number, action: { shareRatio: number; cashPerShare: number }) =>
  Math.max(1, Math.round((price - action.cashPerShare) / action.shareRatio));

export function closesAsOf(
  bars: Pick<Bar, "symbol" | "day" | "close">[],
  actions: State["corporateActions"],
  asOf: string,
) {
  return [...bars]
    .filter((bar) => bar.day < asOf)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((bar) => {
      let price = bar.close;
      for (const action of [...actions].sort((a, b) => a.day.localeCompare(b.day))) {
        if (action.symbol === bar.symbol && action.day > bar.day && action.day <= asOf)
          price = adjustedPrice(price, action);
      }
      return price;
    });
}

export function direction(closes: number[], strategy: Strategy, holding: boolean): "buy" | "sell" | null {
  if (closes.length < strategy.lookback) return null;
  const recent = closes.slice(-strategy.lookback);
  recent.forEach((price) => integer(price, "收盘价格", 1));
  const average = recent.reduce((sum, price) => sum + price, 0) / recent.length;
  const last = recent.at(-1)!;
  if (!holding && last > average * (1 + strategy.entryBps / 10000)) return "buy";
  if (holding && last < average * (1 - strategy.exitBps / 10000)) return "sell";
  return null;
}

function checkDataset(data: Dataset, symbols: string[]) {
  requireThat(
    data.adjustment === "none" && data.source?.trim() && Array.isArray(data.bars),
    "回测需要有来源的不复权数据",
  );
  const seen = new Set<string>();
  for (const b of data.bars) {
    symbolCode(b.symbol);
    requireThat(
      symbols.includes(b.symbol) && /^\d{4}-\d{2}-\d{2}$/.test(b.day) && !seen.has(`${b.symbol}/${b.day}`),
      "回测股票、日期或重复行无效",
    );
    seen.add(`${b.symbol}/${b.day}`);
    for (const key of ["open", "high", "low", "close"] as const) integer(b[key], key, 1);
    integer(b.volume, "成交量");
    requireThat(b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close), "K 线价格范围无效");
    if (data.marketRulesVerified) {
      integer(b.limitUp!, "当日涨停价", 1);
      integer(b.limitDown!, "当日跌停价", 1);
      requireThat(
        typeof b.suspended === "boolean" && b.limitUp! >= b.high && b.limitDown! <= b.low,
        "缺少当日停牌标志或涨跌停资料不匹配",
      );
    }
    if (b.action) {
      requireThat(Number.isFinite(b.action.shareRatio) && b.action.shareRatio > 0, "除权股数比例无效");
      integer(b.action.cashPerShare, "每股红利");
    }
  }
  const days = [...new Set(data.bars.map((b) => b.day))].sort();
  for (const day of days)
    for (const symbol of symbols) requireThat(seen.has(`${symbol}/${day}`), "回测区间存在缺失股票日线，请补齐停牌记录");
  return days;
}

// Signals see only earlier closes. An order decided after a close first becomes eligible at the following open.
export function backtest(strategy: Strategy, data: Dataset, config: AccountConfig, from: string): Performance {
  checkStrategy(strategy);
  const days = checkDataset(data, config.symbols);
  const state: State = {
    corporateActions: [],
    config,
    active: strategy.id,
    strategies: {},
    proposals: {},
    cash: config.cash,
    cashFlow: config.cash,
    units: config.cash,
    realized: 0,
    fees: 0,
    lots: [],
    orders: {},
    fills: [],
    closed: [],
    quotes: {},
    points: [],
    lastAt: "",
  };
  const history = new Map<string, number[]>();
  const pending = new Map<string, "buy" | "sell">();
  const previousVolume = new Map<string, number>();
  let peak = config.cash;
  let equity = config.cash;
  let maxDrawdown = 0;
  for (const day of days) {
    const bars = data.bars.filter((b) => b.day === day).sort((a, b) => a.symbol.localeCompare(b.symbol));
    for (const b of bars) {
      const prior = history.get(b.symbol) ?? [];
      if (b.action) {
        // Adjust the available history only when the action becomes effective, never using a future adjustment factor.
        for (let i = 0; i < prior.length; i++) prior[i] = adjustedPrice(prior[i], b.action);
        for (const lot of state.lots.filter((lot) => lot.symbol === b.symbol)) {
          const dividend = lot.quantity * b.action.cashPerShare;
          state.cash += dividend;
          state.realized += dividend;
          lot.quantity = integer(lot.quantity * b.action.shareRatio, "除权后的持仓股数", 1);
        }
      }
      const side = pending.get(b.symbol);
      const holding = state.lots.filter((lot) => lot.symbol === b.symbol).reduce((sum, lot) => sum + lot.quantity, 0);
      if (day >= from && side && !b.suspended && b.volume > 0) {
        const buying = side === "buy";
        const price = buying
          ? Math.ceil(b.open * (1 + config.slippageBps / 10000))
          : Math.floor(b.open * (1 - config.slippageBps / 10000));
        const quantity = buying ? buyQuantity(b.symbol, (state.cash * strategy.allocationBps) / 10000, price) : holding;
        const fee = quantity ? costs(price, quantity, side, config) : null;
        const liquid = quantity <= (previousVolume.get(b.symbol) ?? 0) * 0.01;
        const withinLimits = price > b.limitDown! && price < b.limitUp!;
        if (quantity && fee && liquid && withinLimits && (!buying || price * quantity + fee.fees <= state.cash)) {
          bookFill(state, {
            signal: `${b.symbol}-${day}`,
            symbol: b.symbol,
            side,
            quantity,
            strategy: strategy.id,
            at: `${day}T09:30:00+08:00`,
            confirmedAt: `${days[days.indexOf(day) - 1]}T15:00:00+08:00`,
            signalAt: `${days[days.indexOf(day) - 1]}T15:00:00+08:00`,
            signalPrice: prior.at(-1)!,
            price,
            ...fee,
            slippage: Math.abs(price - b.open) * quantity,
            source: data.source,
          });
        }
      }
      prior.push(b.close);
      history.set(b.symbol, prior);
      previousVolume.set(b.symbol, b.volume);
      const held = state.lots.some((lot) => lot.symbol === b.symbol);
      const next = direction(prior, strategy, held);
      if (next) pending.set(b.symbol, next);
      else pending.delete(b.symbol);
    }
    if (day >= from) {
      equity =
        state.cash +
        state.lots.reduce((sum, lot) => sum + lot.quantity * bars.find((b) => b.symbol === lot.symbol)!.close, 0);
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }
  return {
    pnl: equity - config.cash,
    returnRate: equity / config.cash - 1,
    maxDrawdown,
    closedTrades: state.closed.length,
    fees: state.fees,
  };
}

export function validateCandidate(
  base: Strategy,
  candidate: Strategy,
  data: Dataset,
  config: AccountConfig,
  trainingEnd: string,
): Validation {
  const report: Validation = {
    passed: false,
    reasons: [],
    datasetHash: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    trainingEnd,
    from: null,
    to: null,
  };
  if (!data.marketRulesVerified || !data.corporateActionsVerified)
    report.reasons.push("缺少逐日涨跌停、停牌或公司行为核实记录");
  let days: string[];
  try {
    days = checkDataset(data, config.symbols);
  } catch (error) {
    report.reasons.push((error as Error).message);
    return report;
  }
  const holdout = days.filter((day) => day > trainingEnd);
  report.from = holdout[0] ?? null;
  report.to = holdout.at(-1) ?? null;
  if (holdout.length < 60) report.reasons.push("未参与调参的数据不足 60 个交易日");
  const warmup = days.filter((day) => day <= trainingEnd).length;
  if (warmup < Math.max(base.lookback, candidate.lookback)) report.reasons.push("验证区间之前缺少均线预热数据");
  if (report.reasons.length) return report;
  report.baseline = backtest(base, data, config, report.from!);
  report.candidate = backtest(candidate, data, config, report.from!);
  if (Math.min(report.baseline.closedTrades, report.candidate.closedTrades) < 20)
    report.reasons.push("原策略或候选策略的已平仓样本不足 20 笔");
  if (report.candidate.returnRate <= report.baseline.returnRate)
    report.reasons.push("候选策略扣除费用和滑点后的收益未改善");
  if (report.candidate.maxDrawdown > report.baseline.maxDrawdown) report.reasons.push("候选策略的回撤增大");
  report.passed = report.reasons.length === 0;
  return report;
}
