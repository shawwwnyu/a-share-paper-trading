import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, valueOf } from "../ledger.ts";
import { buyQuantity, tradingTime } from "../execution.ts";
import { quotes, history, isTradingDay } from "../market.ts";
import { closesAsOf, direction } from "../strategy.ts";
import { review, renderReview } from "../review.ts";
import { chinaDay, requireThat, timestamp } from "../types.ts";
import type { Command, Dataset, State } from "../types.ts";
import type { Settings } from "../config.ts";

type Answer = {
  card: number;
  title: string;
  options: string[];
  about: string;
  choice: number | null;
  at: string;
  by: string;
};
type Context = {
  answers: Answer[];
  events?: { type?: string; receivedAt?: string; detail?: string }[];
  open?: { card: number; title: string }[];
};
const TRADE_OPTIONS = ["确认模拟交易", "拒绝这笔建议"];
const STRATEGY_OPTIONS = ["批准启用候选策略", "保留当前策略"];
const tradeTitle = (id: string) => `模拟交易 ${id}`;
const strategyTitle = (id: string) => `策略版本 ${id}`;

export function handleAnswers(ledger: Ledger, context: Context, now: string) {
  const messages: string[] = [];
  for (const answer of context.answers) {
    if (!Number.isInteger(answer.card) || ![0, 1].includes(answer.choice!) || !answer.by) continue;
    const state = ledger.state();
    const trade = /^paper-trade:([\w.-]+)$/.exec(answer.about);
    const proposal = /^paper-strategy:([\w-]+)$/.exec(answer.about);
    if (
      trade &&
      state.orders[trade[1]] &&
      answer.title === tradeTitle(trade[1]) &&
      JSON.stringify(answer.options) === JSON.stringify(TRADE_OPTIONS)
    ) {
      ledger.execute(
        `answer-${answer.card}`,
        { type: "decide", signal: trade[1], approve: answer.choice === 0, by: answer.by, decidedAt: answer.at },
        now,
      );
      if (ledger.state().orders[trade[1]].status === "expired")
        messages.push("确认时信号已过期或策略已变，已结束这笔建议");
    } else if (
      proposal &&
      state.proposals[proposal[1]] &&
      answer.title === strategyTitle(proposal[1]) &&
      JSON.stringify(answer.options) === JSON.stringify(STRATEGY_OPTIONS)
    ) {
      const current = state.proposals[proposal[1]];
      if (current.status !== "proposed" || current.base !== state.active) {
        messages.push("这份候选策略已处理或基线已变，已保留原决定");
        continue;
      }
      ledger.execute(
        `answer-${answer.card}`,
        { type: "activate", proposal: proposal[1], approve: answer.choice === 0, by: answer.by },
        now,
      );
    }
  }
  return messages;
}
export function pendingCards(state: State, now: string) {
  const cards = [];
  for (const order of Object.values(state.orders)) {
    if (order.status !== "pending" || timestamp(order.expiresAt) <= timestamp(now) || order.strategy !== state.active)
      continue;
    cards.push({
      key: `paper-${order.id}`,
      title: tradeTitle(order.id),
      text: `${order.symbol} ${order.side === "buy" ? "买入" : "卖出"} ${order.quantity} 股，信号价 ${(order.price / 100).toFixed(2)} 元。\n策略 ${order.strategy}。${order.reason}\n确认后用后续有效盘口模拟成交，另计费用和滑点。有效至 ${order.expiresAt}。`,
      options: TRADE_OPTIONS,
      recommend: 1,
      about: `paper-trade:${order.id}`,
    });
  }
  for (const [id, p] of Object.entries(state.proposals)) {
    if (p.status !== "proposed" || p.base !== state.active || !p.validation?.passed) continue;
    const performance = p.validation;
    cards.push({
      key: `strategy-${id}`,
      title: strategyTitle(id),
      text: `${p.rationale}\n依据 ${p.evidence}\n风险 ${p.risk}\n原策略 ${p.base}，候选参数 ${JSON.stringify(p.strategy)}。\n验证区间 ${performance.from} 至 ${performance.to}。原收益 ${(performance.baseline!.returnRate * 100).toFixed(2)}%，候选 ${(performance.candidate!.returnRate * 100).toFixed(2)}%。原回撤 ${(performance.baseline!.maxDrawdown * 100).toFixed(2)}%，候选 ${(performance.candidate!.maxDrawdown * 100).toFixed(2)}%。`,
      options: STRATEGY_OPTIONS,
      recommend: 1,
      about: `paper-strategy:${id}`,
    });
  }
  return cards;
}
export function suggestion(state: State, result: ReturnType<typeof review>, now: string): Command | null {
  if (!result.complete || result.exits < 20 || result.averageLoss === null || result.averageWin === null) return null;
  if (Object.values(state.proposals).some((p) => p.status === "proposed" && p.base === state.active)) return null;
  const base = state.strategies[state.active];
  if (Math.abs(result.averageLoss) <= result.averageWin || base.entryBps >= 10000) return null;
  const id = `candidate-${chinaDay(now).replaceAll("-", "")}`;
  if (state.proposals[id] || state.strategies[id]) return null;
  return {
    type: "propose",
    strategy: { ...base, id, entryBps: Math.min(10000, base.entryBps + 25) },
    rationale: "本期平均亏损大于平均盈利，提出提高入场阈值的待验证假设",
    evidence: `${result.exits} 笔卖出归因，平均盈利 ${result.averageWin / 100} 元，平均亏损 ${result.averageLoss / 100} 元`,
    risk: "提高阈值可能减少成交或错过行情，需要在未参与本次判断的数据上比较",
    trainingEnd: chinaDay(now),
  };
}
function receipt(summary: string, body: object) {
  return `${summary}\n\n\`\`\`agent-autoloop\n${JSON.stringify(body)}\n\`\`\``;
}
export async function cycle(settings: Settings, context: Context, clock = () => new Date().toISOString()) {
  const ledger = new Ledger(settings.database);
  const problems: string[] = [];
  try {
    const now = clock();
    problems.push(...handleAnswers(ledger, context, now));
    let state = ledger.state();
    requireThat(state.config, "请先初始化模拟账户");
    const day = chinaDay(now);
    if (tradingTime(now) && (await isTradingDay(day))) {
      const observed = await quotes(state.config.symbols);
      const checkedAt = clock();
      for (const order of Object.values(state.orders)) {
        if (order.status !== "approved" || timestamp(order.expiresAt) <= timestamp(checkedAt)) continue;
        try {
          ledger.execute(
            `fill-${order.id}`,
            { type: "fill", signal: order.id, quote: observed.find((q) => q.symbol === order.symbol)! },
            checkedAt,
          );
        } catch (error) {
          problems.push(`${order.symbol} ${(error as Error).message}`);
        }
      }
      state = ledger.state();
      const data = await history(state.config!.symbols);
      const active = state.strategies[state.active];
      for (const q of observed) {
        const past = data.bars
          .filter((b) => b.symbol === q.symbol && b.day < day)
          .sort((a, b) => a.day.localeCompare(b.day));
        const holding = state.lots.filter((lot) => lot.symbol === q.symbol).reduce((sum, lot) => sum + lot.quantity, 0);
        const side = direction(closesAsOf(past, state.corporateActions, day), active, holding > 0);
        if (!side || !past.length) continue;
        const id = createHash("sha256").update(`${state.active}/${day}/${q.symbol}/${side}`).digest("hex").slice(0, 24);
        if (state.orders[id]) continue;
        const quantity =
          side === "sell" ? holding : buyQuantity(q.symbol, (state.cash * active.allocationBps) / 10000, q.price);
        if (!quantity) continue;
        const created = clock();
        try {
          ledger.execute(
            `signal-${id}`,
            {
              type: "signal",
              signal: {
                id,
                symbol: q.symbol,
                side,
                quantity,
                price: q.price,
                at: created,
                expiresAt: `${day}T14:56:59+08:00`,
                strategy: state.active,
                reason: `已收盘的 ${active.lookback} 日均线信号，最新日线 ${past.at(-1)!.day}。行情来源 ${q.source}`,
              },
            },
            created,
          );
        } catch (error) {
          problems.push((error as Error).message);
        }
      }
    }
    state = ledger.state();
    const finish = clock();
    const resolveCards = (context.open ?? [])
      .filter((card) =>
        Object.values(state.orders).some(
          (order) =>
            card.title === tradeTitle(order.id) &&
            (timestamp(order.expiresAt) <= timestamp(finish) || order.strategy !== state.active),
        ),
      )
      .map((card) => ({ card: card.card, reason: "信号已经过期或策略版本已变，请以新建议为准" }));
    return receipt(problems.length ? `已检查模拟交易，${problems.join("；")}` : "模拟交易检查完成", {
      ask: pendingCards(state, finish).filter((card) => card.about.startsWith("paper-trade:")),
      resolve: resolveCards,
    });
  } finally {
    ledger.close();
  }
}
export async function markAccount(settings: Settings, clock = () => new Date().toISOString()) {
  const ledger = new Ledger(settings.database);
  try {
    const state = ledger.state();
    requireThat(state.config, "请先初始化模拟账户");
    const now = clock();
    const day = chinaDay(now);
    if (ledger.recorded(`close-${day}`)) return "没事可做：今天的收盘估值已经记录";
    if (!(await isTradingDay(day))) return "没事可做：今天休市";
    const observed = await quotes(
      [...new Set(state.lots.map((lot) => lot.symbol))].length
        ? [...new Set(state.lots.map((lot) => lot.symbol))]
        : state.config.symbols.slice(0, 1),
    );
    // The close may be delivered a few seconds after 15:00. Store the actual quote time and record time separately.
    ledger.execute(`close-${day}`, { type: "mark", quotes: observed }, clock());
    return `模拟账户估值完成，资产 ${(valueOf(ledger.state()).equity / 100).toFixed(2)} 元`;
  } finally {
    ledger.close();
  }
}
export function weekly(settings: Settings, context: Context, now = new Date().toISOString()) {
  const ledger = new Ledger(settings.database);
  try {
    const answers = handleAnswers(ledger, context, now);
    const trigger = context.events?.findLast((event) => event.type === "schedule.tick" || event.type === "run.manual");
    if (context.answers.length && !trigger) return receipt(answers.join("；") || "策略决定已记录", {});
    const to = trigger?.receivedAt ?? now;
    const from = new Date(timestamp(to) - 7 * 86400_000).toISOString();
    let state = ledger.state();
    const result = review(state, from, to);
    const proposal = suggestion(state, result, to);
    // Training includes this review; holdout data must start on a subsequent day.
    if (proposal?.type === "propose") ledger.execute(`suggest-${proposal.strategy.id}`, proposal, now);
    if (settings.validationData) {
      const data = JSON.parse(readFileSync(settings.validationData, "utf8")) as Dataset;
      state = ledger.state();
      for (const [id, p] of Object.entries(state.proposals)) {
        if (p.status !== "proposed" || p.base !== state.active || p.validation?.passed) continue;
        const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
        ledger.execute(`validate-${id}-${hash}`, { type: "validate", proposal: id, dataset: data }, now);
      }
    }
    const report = renderReview(result);
    mkdirSync(settings.reports, { recursive: true });
    const file = join(settings.reports, `${chinaDay(to)}.md`);
    writeFileSync(file, report, { mode: 0o600 });
    writeFileSync(file.replace(/\.md$/, ".json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    return receipt("模拟交易周度复盘已生成", {
      notice: [
        {
          key: `paper-week-${chinaDay(to)}`,
          title: "模拟交易周度复盘",
          text: `${result.recommendation}\n完整报告保存在 ${file}${proposal ? "\n已登记单项修改假设，等待后续独立数据验证。" : ""}`,
          fyi: true,
        },
      ],
      ask: pendingCards(ledger.state(), now).filter((card) => card.about.startsWith("paper-strategy:")),
    });
  } finally {
    ledger.close();
  }
}
