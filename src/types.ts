export type Strategy = { id: string; lookback: number; entryBps: number; exitBps: number; allocationBps: number };
export type AccountConfig = {
  cash: number;
  commissionBps: number;
  minimumCommission: number;
  sellTaxBps: number;
  transferBps: number;
  slippageBps: number;
  maxQuoteAgeSeconds: number;
  symbols: string[];
};
export type Quote = {
  symbol: string;
  name: string;
  at: string;
  price: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  volume: number;
  limitUp: number;
  limitDown: number;
  source: string;
  adjustment: "none";
};
export type Signal = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  at: string;
  expiresAt: string;
  strategy: string;
  reason: string;
};
export type Order = Signal & {
  status: "pending" | "approved" | "rejected" | "filled" | "expired";
  confirmedAt?: string;
  by?: string;
  decision?: boolean;
};
export type Lot = {
  symbol: string;
  quantity: number;
  cost: number;
  fees: number;
  day: string;
  strategy: string;
  signal: string;
};
export type ClosedTrade = {
  at: string;
  symbol: string;
  quantity: number;
  pnl: number;
  entryStrategy: string;
  exitStrategy: string;
  signal: string;
};
export type Fill = {
  signal: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  strategy: string;
  at: string;
  confirmedAt: string;
  signalAt: string;
  signalPrice: number;
  price: number;
  fees: number;
  commission: number;
  tax: number;
  transfer: number;
  slippage: number;
  source: string;
};
export type Point = {
  at: string;
  equity: number;
  cash: number;
  cashFlow: number;
  realized: number;
  unrealized: number;
  fees: number;
  nav: number;
};
export type Bar = {
  symbol: string;
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  limitUp?: number;
  limitDown?: number;
  suspended?: boolean;
  action?: { shareRatio: number; cashPerShare: number };
};
export type Dataset = {
  source: string;
  adjustment: "none";
  marketRulesVerified: boolean;
  corporateActionsVerified: boolean;
  bars: Bar[];
};
export type Performance = { pnl: number; returnRate: number; maxDrawdown: number; closedTrades: number; fees: number };
export type Validation = {
  passed: boolean;
  reasons: string[];
  datasetHash: string;
  trainingEnd: string;
  from: string | null;
  to: string | null;
  baseline?: Performance;
  candidate?: Performance;
};
export type Proposal = {
  strategy: Strategy;
  base: string;
  rationale: string;
  evidence: string;
  risk: string;
  trainingEnd: string;
  status: "proposed" | "approved" | "rejected";
  validation?: Validation;
  approvedBy?: string;
  approvedAt?: string;
};
export type State = {
  corporateActions: { symbol: string; day: string; shareRatio: number; cashPerShare: number; reference: string }[];
  config: AccountConfig | null;
  active: string;
  strategies: Record<string, Strategy>;
  proposals: Record<string, Proposal>;
  cash: number;
  cashFlow: number;
  units: number;
  realized: number;
  fees: number;
  lots: Lot[];
  orders: Record<string, Order>;
  fills: Fill[];
  closed: ClosedTrade[];
  quotes: Record<string, Quote>;
  points: Point[];
  lastAt: string;
};
export type Command =
  | { type: "init"; config: AccountConfig; strategy: Strategy }
  | { type: "signal"; signal: Signal }
  | { type: "decide"; signal: string; approve: boolean; by: string; decidedAt?: string }
  | { type: "fill"; signal: string; quote: Quote }
  | { type: "mark"; quotes: Quote[] }
  | { type: "cash"; amount: number; quotes: Quote[]; note: string }
  | {
      type: "corporate-action";
      symbol: string;
      day?: string;
      shareRatio: number;
      cashPerShare: number;
      reference: string;
    }
  | { type: "propose"; strategy: Strategy; rationale: string; evidence: string; risk: string; trainingEnd: string }
  | { type: "validate"; proposal: string; dataset: Dataset }
  | { type: "activate"; proposal: string; approve: boolean; by: string };

export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function integer(value: number, label: string, min = 0) {
  requireThat(Number.isSafeInteger(value) && value >= min, `${label}必须是大于等于 ${min} 的安全整数`);
  return value;
}
export function timestamp(value: string) {
  requireThat(
    typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)),
    "时间必须含时区且有效",
  );
  return Date.parse(value);
}
export const chinaDay = (at: string) => new Date(timestamp(at) + 8 * 3600_000).toISOString().slice(0, 10);
export function symbolCode(value: string) {
  requireThat(
    /^(sh6\d{5}|sz[03]\d{5}|bj(?:[48]\d{5}|92\d{4}))$/.test(value),
    "股票代码须带 sh、sz 或 bj 前缀，例如 sh600000",
  );
  return value;
}
export function checkStrategy(strategy: Strategy) {
  requireThat(/^[a-zA-Z0-9_-]{1,60}$/.test(strategy.id), "策略版本号无效");
  integer(strategy.lookback, "均线窗口", 2);
  integer(strategy.entryBps, "入场阈值");
  integer(strategy.exitBps, "退出阈值");
  integer(strategy.allocationBps, "单笔仓位", 1);
  requireThat(
    strategy.lookback <= 250 &&
      strategy.entryBps <= 10000 &&
      strategy.exitBps < 10000 &&
      strategy.allocationBps <= 10000,
    "策略参数超出范围",
  );
}
