import { DatabaseSync } from "node:sqlite";
import { checkQuote, checkQuantity, makeFill, bookFill } from "./execution.ts";
import { validateCandidate } from "./strategy.ts";
import { checkStrategy, chinaDay, integer, requireThat, symbolCode, timestamp } from "./types.ts";
import type { Command, Point, Quote, State } from "./types.ts";

export const emptyState = (): State => ({
  corporateActions: [],
  config: null,
  active: "",
  strategies: {},
  proposals: {},
  cash: 0,
  cashFlow: 0,
  units: 0,
  realized: 0,
  fees: 0,
  lots: [],
  orders: {},
  fills: [],
  closed: [],
  quotes: {},
  points: [],
  lastAt: "",
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function valueOf(state: State) {
  let market = 0;
  let cost = 0;
  for (const lot of state.lots) {
    const q = state.quotes[lot.symbol];
    requireThat(q, `缺少 ${lot.symbol} 的估值行情`);
    market += lot.quantity * q.price;
    cost += lot.cost;
  }
  return { equity: integer(state.cash + market, "资产"), unrealized: market - cost };
}
function markQuotes(state: State, quotes: Quote[], now: string) {
  const seen = new Set<string>();
  for (const q of quotes) {
    checkQuote(q, now, state.config!.maxQuoteAgeSeconds);
    requireThat(!seen.has(q.symbol), "行情里有重复股票");
    seen.add(q.symbol);
    state.quotes[q.symbol] = q;
  }
  for (const lot of state.lots) requireThat(seen.has(lot.symbol), `缺少持仓 ${lot.symbol} 的本次估值行情`);
}
function point(state: State, at: string): Point {
  const { equity, unrealized } = valueOf(state);
  return {
    at,
    equity,
    unrealized,
    cash: state.cash,
    cashFlow: state.cashFlow,
    realized: state.realized,
    fees: state.fees,
    nav: state.units ? equity / state.units : 1,
  };
}
function apply(state: State, command: Command, now: string) {
  timestamp(now);
  requireThat(!state.lastAt || timestamp(now) >= timestamp(state.lastAt), "不能倒填早于账本最后记录的时间");
  if (command.type === "init") {
    requireThat(!state.config, "账户已经初始化");
    const c = command.config;
    integer(c.cash, "初始模拟资金", 1);
    integer(c.minimumCommission, "最低佣金");
    integer(c.maxQuoteAgeSeconds, "行情有效秒数", 1);
    for (const key of ["commissionBps", "sellTaxBps", "transferBps", "slippageBps"] as const)
      requireThat(Number.isFinite(c[key]) && c[key] >= 0 && c[key] <= 1000, `${key}超出范围`);
    requireThat(
      c.maxQuoteAgeSeconds <= 300 && c.symbols.length > 0 && new Set(c.symbols).size === c.symbols.length,
      "自选股池或行情有效期无效",
    );
    c.symbols.forEach(symbolCode);
    checkStrategy(command.strategy);
    state.config = structuredClone(c);
    state.strategies[command.strategy.id] = structuredClone(command.strategy);
    state.active = command.strategy.id;
    state.cash = state.cashFlow = state.units = c.cash;
    state.points.push(point(state, now));
  } else {
    requireThat(state.config, "请先初始化模拟账户");
    switch (command.type) {
      case "signal": {
        const s = command.signal;
        requireThat(/^[\w.-]{1,120}$/.test(s.id) && !state.orders[s.id], "信号编号无效或重复");
        requireThat(
          state.config.symbols.includes(s.symbol) && s.strategy === state.active,
          "信号不在自选股池或策略已经变化",
        );
        requireThat(s.side === "buy" || s.side === "sell", "买卖方向无效");
        checkQuantity(s.symbol, s.side, s.quantity);
        integer(s.price, "信号价格", 1);
        requireThat(typeof s.reason === "string" && s.reason.length > 0 && s.reason.length <= 4000, "需要填写信号依据");
        requireThat(
          timestamp(s.at) <= timestamp(now) && timestamp(s.expiresAt) > timestamp(now),
          "信号时间或有效期无效",
        );
        state.orders[s.id] = { ...s, status: "pending" };
        break;
      }
      case "decide": {
        const order = state.orders[command.signal];
        requireThat(order?.status === "pending", "信号已确认、已拒绝或不存在");
        requireThat(
          typeof command.approve === "boolean" && typeof command.by === "string" && command.by.length > 0,
          "需要记录本人决定及身份",
        );
        const at = command.decidedAt ?? now;
        requireThat(timestamp(at) >= timestamp(order.at) && timestamp(at) <= timestamp(now), "确认时间无效");
        const expired = timestamp(now) >= timestamp(order.expiresAt) || order.strategy !== state.active;
        order.status = command.approve ? (expired ? "expired" : "approved") : "rejected";
        order.decision = command.approve;
        order.confirmedAt = at;
        order.by = command.by;
        break;
      }
      case "fill": {
        const order = state.orders[command.signal];
        requireThat(order, "找不到信号");
        const fill = makeFill(state, order, command.quote, now);
        bookFill(state, fill);
        state.quotes[fill.symbol] = command.quote;
        order.status = "filled";
        break;
      }
      case "mark":
        markQuotes(state, command.quotes, now);
        state.points.push(point(state, now));
        break;
      case "cash": {
        requireThat(
          Number.isSafeInteger(command.amount) && command.amount !== 0 && command.note?.trim(),
          "入出金须为非零整数分并填写说明",
        );
        markQuotes(state, command.quotes, now);
        const before = point(state, now);
        requireThat(state.cash + command.amount >= 0 && before.equity > 0, "可用资金不足或净值无效");
        state.points.push(before);
        state.units += command.amount / before.nav;
        requireThat(state.units > 0, "请保留大于零的模拟账户资产");
        state.cash += command.amount;
        state.cashFlow += command.amount;
        state.points.push(point(state, now));
        break;
      }
      case "corporate-action": {
        requireThat(
          command.reference?.trim() && Number.isFinite(command.shareRatio) && command.shareRatio > 0,
          "公司行为需要核实来源和有效股份比例",
        );
        integer(command.cashPerShare, "每股到账红利");
        const day = command.day ?? chinaDay(now);
        requireThat(/^\d{4}-\d{2}-\d{2}$/.test(day) && day <= chinaDay(now), "公司行为生效日期无效");
        requireThat(
          !state.fills.some((fill) => fill.symbol === command.symbol && chinaDay(fill.at) >= day),
          "请在生效日交易之前登记公司行为，已有后续成交须先核对账本",
        );
        state.corporateActions.push({
          symbol: command.symbol,
          day,
          shareRatio: command.shareRatio,
          cashPerShare: command.cashPerShare,
          reference: command.reference,
        });
        let dividend = 0;
        for (const lot of state.lots.filter((lot) => lot.symbol === command.symbol && lot.day < day)) {
          const quantity = lot.quantity * command.shareRatio;
          integer(quantity, "调整后股数", 1);
          dividend += lot.quantity * command.cashPerShare;
          lot.quantity = quantity;
        }
        state.cash += dividend;
        state.realized += dividend;
        delete state.quotes[command.symbol];
        break;
      }
      case "propose": {
        checkStrategy(command.strategy);
        requireThat(
          !state.strategies[command.strategy.id] && !state.proposals[command.strategy.id],
          "策略版本已经存在",
        );
        requireThat(
          command.rationale?.trim() && command.evidence?.trim() && command.risk?.trim(),
          "候选方案须写明问题、证据和风险",
        );
        requireThat(
          /^\d{4}-\d{2}-\d{2}$/.test(command.trainingEnd) && command.trainingEnd <= chinaDay(now),
          "请记录调参数据的截止日期",
        );
        const base = state.strategies[state.active];
        const changes = (["lookback", "entryBps", "exitBps", "allocationBps"] as const).filter(
          (key) => base[key] !== command.strategy[key],
        );
        requireThat(changes.length === 1, "每个候选版本只调整一个参数，便于归因");
        state.proposals[command.strategy.id] = {
          strategy: command.strategy,
          base: state.active,
          rationale: command.rationale,
          evidence: command.evidence,
          risk: command.risk,
          trainingEnd: command.trainingEnd,
          status: "proposed",
        };
        break;
      }
      case "validate": {
        const p = state.proposals[command.proposal];
        requireThat(p?.status === "proposed" && p.base === state.active, "候选版本不存在、已处理或基线已变");
        requireThat(
          command.dataset.bars.every((b) => b.day < chinaDay(now)),
          "验证只能使用已经结束的交易日",
        );
        p.validation = validateCandidate(
          state.strategies[p.base],
          p.strategy,
          command.dataset,
          state.config,
          p.trainingEnd,
        );
        break;
      }
      case "activate": {
        const p = state.proposals[command.proposal];
        requireThat(p?.status === "proposed", "候选版本已处理或不存在");
        requireThat(typeof command.approve === "boolean" && command.by?.trim(), "策略决定需要本人身份");
        if (command.approve) {
          requireThat(p.validation?.passed && p.base === state.active, "候选策略尚未通过验证或基线已经变化");
          state.strategies[p.strategy.id] = p.strategy;
          state.active = p.strategy.id;
        }
        p.status = command.approve ? "approved" : "rejected";
        p.approvedBy = command.by;
        p.approvedAt = now;
        break;
      }
      default:
        throw new Error("不认识的模拟账户操作");
    }
  }
  integer(state.cash, "可用资金");
  state.lastAt = now;
}

// Store computed changes, including fills and fees, so replay never reruns today's market or strategy calculations.
export class Ledger {
  readonly file: string;
  private db: DatabaseSync;
  constructor(file: string) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, request TEXT NOT NULL, changes TEXT NOT NULL)",
    );
  }
  state(): State {
    const state = emptyState();
    for (const row of this.db.prepare("SELECT changes FROM entries ORDER BY seq").iterate())
      Object.assign(state, JSON.parse(String(row.changes)));
    return state;
  }
  recorded(id: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM entries WHERE id=?").get(id));
  }
  execute(id: string, command: Command, now = new Date().toISOString()) {
    requireThat(typeof id === "string" && id.length > 0 && id.length <= 200, "操作编号无效");
    const request = canonical(command);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT request, changes FROM entries WHERE id=?").get(id);
      if (old) {
        requireThat(old.request === request, "同一操作编号不能提交不同内容");
        this.db.exec("COMMIT");
        return JSON.parse(String(old.changes)) as Partial<State>;
      }
      const state = this.state();
      const before = structuredClone(state);
      apply(state, command, now);
      const changes = Object.fromEntries(
        Object.entries(state).filter(([key, value]) => canonical(value) !== canonical(before[key as keyof State])),
      );
      this.db
        .prepare("INSERT INTO entries (id, request, changes) VALUES (?, ?, ?)")
        .run(id, request, JSON.stringify(changes));
      this.db.exec("COMMIT");
      return changes as Partial<State>;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
