import { chinaDay, integer, requireThat, symbolCode, timestamp } from "./types.ts";
import type { AccountConfig, Fill, Order, Quote, State } from "./types.ts";

export function checkQuote(q: Quote, now: string, maxAge: number) {
  symbolCode(q.symbol);
  requireThat(
    q.adjustment === "none" && typeof q.source === "string" && q.source.length > 0,
    "成交和估值需要带来源的不复权行情",
  );
  const age = timestamp(now) - timestamp(q.at);
  requireThat(age >= 0 && age <= maxAge * 1000, "行情已过期或来自未来");
  integer(q.price, "行情价格", 1);
  for (const key of ["bid", "ask", "bidSize", "askSize", "volume", "limitUp", "limitDown"] as const)
    integer(q[key], `行情 ${key}`);
  requireThat(q.limitUp > q.limitDown && q.limitDown > 0, "行情缺少有效涨跌停价格，暂不撮合");
  requireThat(q.price >= q.limitDown && q.price <= q.limitUp, "行情价格超出涨跌停范围");
}
export function tradingTime(at: string) {
  const local = new Date(timestamp(at) + 8 * 3600_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return (
    local.getUTCDay() > 0 &&
    local.getUTCDay() < 6 &&
    ((minute >= 570 && minute < 690) || (minute >= 780 && minute < 897))
  );
}
export function buyQuantity(symbol: string, budget: number, price: number) {
  const amount = Math.floor(budget / price);
  if (symbol.startsWith("sh688")) return amount >= 200 ? amount : 0;
  if (symbol.startsWith("bj")) return amount >= 100 ? amount : 0;
  return Math.floor(amount / 100) * 100;
}
export function checkQuantity(symbol: string, side: string, quantity: number) {
  integer(quantity, "数量", 1);
  requireThat(quantity <= (symbol.startsWith("sh688") ? 100000 : 1000000), "超过单笔模拟申报数量上限");
  if (side === "buy") requireThat(buyQuantity(symbol, quantity, 1) === quantity, "买入数量不符合整手或最低申报数量");
}
export function costs(price: number, quantity: number, side: "buy" | "sell", c: AccountConfig) {
  const gross = integer(price * quantity, "成交金额", 1);
  const commission = Math.max(c.minimumCommission, Math.ceil((gross * c.commissionBps) / 10000));
  const tax = side === "sell" ? Math.ceil((gross * c.sellTaxBps) / 10000) : 0;
  const transfer = Math.ceil((gross * c.transferBps) / 10000);
  return { commission, tax, transfer, fees: commission + tax + transfer };
}
export function makeFill(state: State, order: Order, q: Quote, now: string): Fill {
  const c = state.config!;
  requireThat(order.status === "approved", "交易尚未确认或已处理");
  requireThat(timestamp(now) <= timestamp(order.expiresAt), "确认的交易已过期，请重新生成信号");
  requireThat(q.symbol === order.symbol, "行情与交易股票不一致");
  checkQuote(q, now, c.maxQuoteAgeSeconds);
  requireThat(timestamp(q.at) > timestamp(order.confirmedAt!), "只能使用确认之后的行情成交");
  requireThat(tradingTime(q.at) && tradingTime(now) && chinaDay(q.at) === chinaDay(now), "当前不在连续竞价交易时间");
  requireThat(q.volume > 0, "没有当日成交，可能停牌或休市");
  checkQuantity(order.symbol, order.side, order.quantity);
  const buying = order.side === "buy";
  const bookPrice = buying ? q.ask : q.bid;
  const size = buying ? q.askSize : q.bidSize;
  requireThat(bookPrice > 0 && size >= order.quantity, "盘口可成交数量不足，保留待成交状态");
  const price = buying
    ? Math.ceil(bookPrice * (1 + c.slippageBps / 10000))
    : Math.floor(bookPrice * (1 - c.slippageBps / 10000));
  requireThat(price >= q.limitDown && price <= q.limitUp && price > 0, "加入滑点后的价格超出涨跌停范围");
  const fee = costs(price, order.quantity, order.side, c);
  if (buying) requireThat(state.cash >= price * order.quantity + fee.fees, "模拟资金不足");
  else {
    const sellable = state.lots
      .filter((lot) => lot.symbol === order.symbol && lot.day < chinaDay(q.at))
      .reduce((sum, lot) => sum + lot.quantity, 0);
    requireThat(sellable >= order.quantity, "T+1 可卖数量不足");
    const holding = state.lots.filter((lot) => lot.symbol === order.symbol).reduce((sum, lot) => sum + lot.quantity, 0);
    if (!order.symbol.startsWith("sh688") && !order.symbol.startsWith("bj"))
      requireThat(order.quantity % 100 === 0 || order.quantity === holding, "不足整手的余额须一次卖完");
  }
  return {
    signal: order.id,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    strategy: order.strategy,
    at: q.at,
    confirmedAt: order.confirmedAt!,
    signalAt: order.at,
    signalPrice: order.price,
    price,
    ...fee,
    slippage: Math.abs(price - bookPrice) * order.quantity,
    source: q.source,
  };
}
export function bookFill(state: State, fill: Fill) {
  const gross = integer(fill.price * fill.quantity, "成交金额", 1);
  state.fills.push(fill);
  state.fees += fill.fees;
  if (fill.side === "buy") {
    state.cash -= gross + fill.fees;
    state.lots.push({
      symbol: fill.symbol,
      quantity: fill.quantity,
      cost: gross + fill.fees,
      fees: fill.fees,
      day: chinaDay(fill.at),
      strategy: fill.strategy,
      signal: fill.signal,
    });
  } else {
    state.cash += gross - fill.fees;
    let left = fill.quantity;
    let remainingFee = fill.fees;
    for (const lot of state.lots) {
      if (!left || lot.symbol !== fill.symbol || lot.day >= chinaDay(fill.at)) continue;
      const quantity = Math.min(left, lot.quantity);
      const cost = Math.round((lot.cost * quantity) / lot.quantity);
      const entryFee = Math.round((lot.fees * quantity) / lot.quantity);
      const exitFee = quantity === left ? remainingFee : Math.round((fill.fees * quantity) / fill.quantity);
      const pnl = fill.price * quantity - exitFee - cost;
      state.closed.push({
        at: fill.at,
        symbol: fill.symbol,
        quantity,
        pnl,
        entryStrategy: lot.strategy,
        exitStrategy: fill.strategy,
        signal: lot.signal,
      });
      state.realized += pnl;
      lot.cost -= cost;
      lot.fees -= entryFee;
      lot.quantity -= quantity;
      left -= quantity;
      remainingFee -= exitFee;
    }
    requireThat(left === 0, "账本可卖数量不一致");
    state.lots = state.lots.filter((lot) => lot.quantity > 0);
  }
}
