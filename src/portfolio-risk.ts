import { checkQuote } from "./execution.ts";
import { riskExit } from "./risk.ts";
import { chinaDay, timestamp } from "./types.ts";
import type { Quote, State } from "./types.ts";

export type PortfolioRisk = {
  at: string;
  complete: boolean;
  valuationComplete: boolean;
  cash: number;
  equity: number | null;
  market: number | null;
  totalBps: number | null;
  positionCount: number;
  positions: {
    symbol: string;
    quantity: number;
    sellable: number;
    cost: number;
    value: number | null;
    weightBps: number | null;
    industry: string | null;
    quoteAt: string | null;
    source: string | null;
  }[];
  industries: { industry: string; value: number; weightBps: number | null }[];
  alerts: { kind: string; symbol?: string; reason: string }[];
  issues: string[];
};
export function portfolioRisk(state: State, quotes: Quote[], now: string): PortfolioRisk {
  timestamp(now);
  const issues: string[] = [],
    alerts: PortfolioRisk["alerts"] = [];
  const valid = new Map<string, Quote>();
  const duplicate = new Set<string>();
  for (const q of quotes) {
    if (!state.lots.some((lot) => lot.symbol === q.symbol)) continue;
    if (valid.has(q.symbol) || duplicate.has(q.symbol)) {
      valid.delete(q.symbol);
      duplicate.add(q.symbol);
      issues.push(`${q.symbol} 风险行情重复`);
      continue;
    }
    try {
      checkQuote(q, now, state.config?.maxQuoteAgeSeconds ?? 60);
      if (chinaDay(q.at) !== chinaDay(now)) throw new Error("不是当日风险行情");
      valid.set(q.symbol, q);
    } catch (error) {
      issues.push(`${q.symbol} ${(error as Error).message}`);
    }
  }
  const symbols = [...new Set(state.lots.map((lot) => lot.symbol))].sort();
  const positions: PortfolioRisk["positions"] = symbols.map((symbol) => {
    const lots = state.lots.filter((l) => l.symbol === symbol),
      q = valid.get(symbol);
    const quantity = lots.reduce((sum, l) => sum + l.quantity, 0);
    const sellable = lots.filter((l) => l.day < chinaDay(now)).reduce((sum, l) => sum + l.quantity, 0);
    const industry = state.config?.risk?.industries?.[symbol] ?? null;
    if (!q) issues.push(`${symbol} 缺少本次有效风险估值行情`);
    if (sellable < quantity)
      alerts.push({ kind: "t-plus-one", symbol, reason: `T+1 限制 ${quantity - sellable} 股，可卖 ${sellable} 股` });
    if (state.config?.risk?.maxIndustryBps !== undefined && !industry) issues.push(`${symbol} 缺少冻结行业分类`);
    if (q && state.config) {
      try {
        const exit = riskExit(state, q, now);
        if (exit) alerts.push({ kind: exit.kind, symbol, reason: exit.reason });
      } catch (error) {
        issues.push(`${symbol} ${(error as Error).message}`);
      }
    }
    return {
      symbol,
      quantity,
      sellable,
      cost: lots.reduce((sum, l) => sum + l.cost, 0),
      value: q ? quantity * q.price : null,
      weightBps: null,
      industry,
      quoteAt: q?.at ?? null,
      source: q?.source ?? null,
    };
  });
  const valuationComplete = positions.every((p) => p.value !== null);
  const market = valuationComplete ? positions.reduce((sum, p) => sum + p.value!, 0) : null;
  const equity = market === null ? null : state.cash + market;
  const weight = (value: number) => (equity && equity > 0 ? (value * 10000) / equity : null);
  for (const p of positions) p.weightBps = p.value === null ? null : weight(p.value);
  const industryValues = new Map<string, number>();
  for (const p of positions)
    if (p.industry && p.value !== null) industryValues.set(p.industry, (industryValues.get(p.industry) ?? 0) + p.value);
  const industries = [...industryValues].map(([industry, value]) => ({
    industry,
    value,
    weightBps: valuationComplete ? weight(value) : null,
  }));
  const risk = state.config?.risk;
  const totalBps = market === null ? null : weight(market);
  if (risk?.maxTotalBps !== undefined && totalBps !== null && totalBps > risk.maxTotalBps)
    alerts.push({ kind: "total-exposure", reason: "实际总仓位超过冻结上限" });
  if (risk?.maxPositions !== undefined && positions.length > risk.maxPositions)
    alerts.push({ kind: "position-count", reason: "实际持仓数量超过冻结上限" });
  for (const p of positions)
    if (risk?.maxSymbolBps !== undefined && p.weightBps !== null && p.weightBps > risk.maxSymbolBps)
      alerts.push({ kind: "symbol-exposure", symbol: p.symbol, reason: "实际单股仓位超过冻结上限" });
  for (const p of industries)
    if (risk?.maxIndustryBps !== undefined && p.weightBps !== null && p.weightBps > risk.maxIndustryBps)
      alerts.push({ kind: "industry-exposure", reason: `${p.industry} 实际行业仓位超过冻结上限` });
  return {
    at: now,
    complete: valuationComplete && issues.length === 0,
    valuationComplete,
    cash: state.cash,
    equity,
    market,
    totalBps,
    positionCount: positions.length,
    positions,
    industries,
    alerts,
    issues,
  };
}
