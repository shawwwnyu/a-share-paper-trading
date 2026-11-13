import { createHash } from "node:crypto";
import { checkQuote } from "./execution.ts";
import { riskExit, liveOrder } from "./risk.ts";
import { chinaDay, requireThat } from "./types.ts";
import type { Quote, Signal, State } from "./types.ts";

export function riskSignal(state: State, quote: Quote, now: string): Signal | null {
  const exit = riskExit(state, quote, now);
  if (!exit) return null;
  const day = chinaDay(now);
  // Keep existing decisions and confirmations. A rejected or expired suggestion is not asked again on the same day.
  if (
    Object.values(state.orders).some(
      (order) =>
        order.symbol === quote.symbol &&
        order.side === "sell" &&
        (liveOrder(order, state, now) || (order.strategy === state.active && chinaDay(order.at) === day)),
    )
  )
    return null;
  const lots = state.lots.filter((lot) => lot.symbol === quote.symbol);
  const holding = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  const available = lots.filter((lot) => lot.day < day).reduce((sum, lot) => sum + lot.quantity, 0);
  const quantity = Math.min(holding, quote.symbol.startsWith("sh688") ? 100000 : 1000000);
  const id = createHash("sha256").update(`${state.active}/${day}/${quote.symbol}/risk-exit`).digest("hex").slice(0, 24);
  return {
    id,
    symbol: quote.symbol,
    side: "sell",
    quantity,
    price: quote.price,
    at: now,
    expiresAt: `${day}T14:56:59+08:00`,
    strategy: state.active,
    reason: `${exit.reason}。实际持仓 ${holding} 股，T+1 可卖 ${available} 股。${available < quantity ? "可卖数量不足，确认后仍须等待，过期后重新评估。" : ""}行情来源 ${quote.source}`,
  };
}

export function checkSignalQuote(state: State, quote: Quote, now: string) {
  checkQuote(quote, now, state.config!.maxQuoteAgeSeconds);
  requireThat(chinaDay(quote.at) === chinaDay(now), "生成建议需要当日行情");
}
