import { checkQuote, costs } from "./execution.ts";
import { chinaDay, integer, requireThat, symbolCode, timestamp } from "./types.ts";
import type { Fill, Order, Quote, RiskPolicy, State } from "./types.ts";

export function checkRiskPolicy(risk: RiskPolicy) {
  requireThat(risk && typeof risk === "object" && !Array.isArray(risk), "风险配置无效");
  const bounds = {
    maxTotalBps: 10000,
    maxSymbolBps: 10000,
    maxPositions: 10000,
    maxIndustryBps: 10000,
    stopLossBps: 9999,
    takeProfitBps: 100000,
    maxHoldingDays: 36500,
    maxOrderAgeMinutes: 1440,
  };
  for (const [key, value] of Object.entries(risk)) {
    requireThat(key === "industries" || Object.hasOwn(bounds, key), `风险配置含未知参数 ${key}`);
    if (key === "industries") continue;
    requireThat(typeof value === "number", `风险参数 ${key} 必须是数字`);
    integer(value, `风险参数 ${key}`, 1);
    requireThat(value <= bounds[key as keyof typeof bounds], `风险参数 ${key} 超出范围`);
  }
  if (risk.industries !== undefined) {
    requireThat(
      risk.industries && typeof risk.industries === "object" && !Array.isArray(risk.industries),
      "行业资料无效",
    );
    for (const [symbol, industry] of Object.entries(risk.industries)) {
      symbolCode(symbol);
      requireThat(
        typeof industry === "string" && industry.trim() === industry && industry.length > 0 && industry.length <= 100,
        "行业资料无效",
      );
    }
  }
  if (risk.maxIndustryBps !== undefined)
    requireThat(risk.industries && Object.keys(risk.industries).length > 0, "行业限制需要已核实的行业资料");
}

export function expiryReason(order: Order, state: State, now: string) {
  if (!["pending", "approved"].includes(order.status)) return null;
  if (timestamp(order.expiresAt) <= timestamp(now)) return "委托有效期已结束";
  if (order.strategy !== state.active) return "策略版本已变化";
  return null;
}
export function liveOrder(order: Order, state: State, now: string) {
  return ["pending", "approved"].includes(order.status) && !expiryReason(order, state, now);
}
export function orderPriority(a: Order, b: Order) {
  return (
    Number(a.side === "buy") - Number(b.side === "buy") ||
    timestamp(a.confirmedAt ?? a.at) - timestamp(b.confirmedAt ?? b.at) ||
    a.id.localeCompare(b.id)
  );
}
export function orderedApprovals(state: State, now: string) {
  return Object.values(state.orders)
    .filter((order) => order.status === "approved" && !expiryReason(order, state, now))
    .sort(orderPriority);
}

export type RiskExit = { kind: "stop-loss" | "take-profit" | "holding-time"; reason: string };
export function riskExit(state: State, quote: Quote, now: string): RiskExit | null {
  const risk = state.config?.risk;
  if (!risk || !(risk.stopLossBps || risk.takeProfitBps || risk.maxHoldingDays)) return null;
  const lots = state.lots.filter((lot) => lot.symbol === quote.symbol);
  if (!lots.length) return null;
  checkQuote(quote, now, state.config!.maxQuoteAgeSeconds);
  requireThat(chinaDay(quote.at) === chinaDay(now), "退出判断需要当日行情");
  const quantity = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const cost = lots.reduce((sum, lot) => sum + lot.cost, 0);
  // Without a bid, the last price can flag risk but can never authorize a fill.
  const price = Math.floor((quote.bid || quote.price) * (1 - state.config!.slippageBps / 10000));
  const net = price > 0 ? price * quantity - costs(price, quantity, "sell", state.config!).fees : 0;
  const pnlBps = cost > 0 ? ((net - cost) * 10000) / cost : 0;
  if (risk.stopLossBps !== undefined && pnlBps <= -risk.stopLossBps)
    return {
      kind: "stop-loss",
      reason: `止损：按当前卖出价估算的含费收益率 ${(pnlBps / 100).toFixed(2)}%，达到亏损阈值 ${risk.stopLossBps / 100}%`,
    };
  if (risk.takeProfitBps !== undefined && pnlBps >= risk.takeProfitBps)
    return {
      kind: "take-profit",
      reason: `止盈：按当前卖出价估算的含费收益率 ${(pnlBps / 100).toFixed(2)}%，达到盈利阈值 ${risk.takeProfitBps / 100}%`,
    };
  const oldest = lots.map((lot) => lot.day).sort()[0];
  const days = (Date.parse(chinaDay(now)) - Date.parse(oldest)) / 86400_000;
  if (risk.maxHoldingDays !== undefined && days >= risk.maxHoldingDays)
    return {
      kind: "holding-time",
      reason: `持有期限：最早剩余持仓已持有 ${days} 个自然日，达到 ${risk.maxHoldingDays} 日上限`,
    };
  return null;
}

// Called inside the ledger transaction after pricing, before booking. No approved order is treated as a holding.
export function checkBuyRisk(state: State, fill: Fill, quote: Quote, quotes: Quote[] | undefined, now: string) {
  if (fill.side !== "buy") return;
  requireThat(
    !Object.values(state.orders).some(
      (order) => order.symbol === fill.symbol && order.side === "sell" && liveOrder(order, state, now),
    ),
    "已有卖出建议，退出优先，暂不加仓",
  );
  const risk = state.config!.risk;
  if (!risk) return;
  requireThat(!riskExit(state, quote, now), "已触发风险退出，暂不加仓");
  if (
    ![risk.maxTotalBps, risk.maxSymbolBps, risk.maxPositions, risk.maxIndustryBps].some((value) => value !== undefined)
  )
    return;
  const observed = new Map<string, Quote>();
  for (const q of quotes ?? []) {
    requireThat(!observed.has(q.symbol), "持仓行情里有重复股票");
    checkQuote(q, now, state.config!.maxQuoteAgeSeconds);
    requireThat(chinaDay(q.at) === chinaDay(now), "持仓估值需要当日行情");
    observed.set(q.symbol, q);
  }
  if (observed.has(quote.symbol))
    requireThat(
      Object.entries(quote).every(([key, value]) => observed.get(quote.symbol)![key as keyof Quote] === value),
      "交易股票的持仓行情与成交行情不一致",
    );
  observed.set(quote.symbol, quote);
  const positions = new Map<string, number>();
  for (const lot of state.lots) {
    const current = observed.get(lot.symbol);
    requireThat(current, `缺少持仓 ${lot.symbol} 的本次风险估值行情`);
    positions.set(lot.symbol, integer((positions.get(lot.symbol) ?? 0) + lot.quantity * current.price, "持仓市值"));
  }
  // Price the added position at the less favorable of the last price and the actual slipped execution price.
  positions.set(
    fill.symbol,
    integer((positions.get(fill.symbol) ?? 0) + fill.quantity * Math.max(quote.price, fill.price), "成交后市值"),
  );
  const market = integer(
    [...positions.values()].reduce((sum, value) => sum + value, 0),
    "总持仓市值",
  );
  const equity = integer(state.cash - fill.price * fill.quantity - fill.fees + market, "成交后资产", 1);
  const within = (value: number, cap: number) => BigInt(value) * 10000n <= BigInt(equity) * BigInt(cap);
  if (risk.maxTotalBps !== undefined) requireThat(within(market, risk.maxTotalBps), "成交后总仓位超过风险上限");
  if (risk.maxSymbolBps !== undefined)
    for (const [symbol, value] of positions)
      requireThat(within(value, risk.maxSymbolBps), `${symbol} 单股仓位超过风险上限`);
  if (risk.maxPositions !== undefined) requireThat(positions.size <= risk.maxPositions, "成交后持仓数量超过风险上限");
  if (risk.maxIndustryBps !== undefined) {
    const industries = new Map<string, number>();
    for (const [symbol, value] of positions) {
      const industry = Object.hasOwn(risk.industries!, symbol) ? risk.industries![symbol] : undefined;
      requireThat(industry, `缺少 ${symbol} 的已核实行业资料，暂不买入`);
      industries.set(industry, (industries.get(industry) ?? 0) + value);
    }
    for (const [industry, value] of industries)
      requireThat(within(value, risk.maxIndustryBps), `${industry} 行业集中度超过风险上限`);
  }
}
