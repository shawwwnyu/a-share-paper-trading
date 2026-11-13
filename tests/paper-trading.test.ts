// Failure modes: approval fabricates a fill, stale quotes or same-day stock can be traded, replay books money twice,
// deposits inflate returns, last week's floating gain leaks into this week, or an untested strategy activates itself.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { review } from "../src/review.ts";
import { validateCandidate } from "../src/strategy.ts";
import { closesAsOf, direction } from "../src/strategy.ts";
import { history, parseQuotes } from "../src/market.ts";
import type { AccountConfig, Dataset, Quote, Strategy } from "../src/types.ts";
import { cycle } from "../src/integrations/agent-autoloop.ts";
import { readReceipt } from "./helpers/receipt.ts";

const scratch = mkdtempSync(join(tmpdir(), "autoloop-paper-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const strategy: Strategy = { id: "v1", lookback: 3, entryBps: 100, exitBps: 100, allocationBps: 2000 };
const config: AccountConfig = {
  cash: 1_000_000,
  commissionBps: 3,
  minimumCommission: 500,
  sellTaxBps: 5,
  transferBps: 0.1,
  slippageBps: 10,
  maxQuoteAgeSeconds: 60,
  symbols: ["sh600000"],
};
const time = (day: string, clock = "10:00:00") => `${day}T${clock}+08:00`;
const quote = (at: string, price = 1000): Quote => ({
  symbol: "sh600000",
  name: "演示股票",
  at,
  price,
  bid: price,
  ask: price,
  bidSize: 10_000,
  askSize: 10_000,
  volume: 100_000,
  limitUp: 2000,
  limitDown: 500,
  source: "fixture",
  adjustment: "none",
});
let serial = 0;
function account() {
  const ledger = new Ledger(join(scratch, `account-${serial++}.db`));
  ledger.execute("init", { type: "init", config, strategy }, time("2026-11-02", "09:00:00"));
  return ledger;
}
function signal(ledger: Ledger, id: string, at: string, side: "buy" | "sell" = "buy", quantity = 100) {
  ledger.execute(
    id,
    {
      type: "signal",
      signal: {
        id,
        symbol: "sh600000",
        side,
        quantity,
        price: 1000,
        at,
        expiresAt: time(at.slice(0, 10), "14:56:59"),
        strategy: "v1",
        reason: "测试信号",
      },
    },
    at,
  );
}
function buy(ledger: Ledger, id: string, day: string) {
  signal(ledger, id, time(day));
  ledger.execute(`${id}-yes`, { type: "decide", signal: id, approve: true, by: "owner" }, time(day, "10:01:00"));
  ledger.execute(
    `${id}-fill`,
    { type: "fill", signal: id, quote: quote(time(day, "10:02:00")) },
    time(day, "10:02:01"),
  );
}

test("approval waits for a later valid quote, and replay retains one durable fill", () => {
  const ledger = account();
  try {
    signal(ledger, "buy", time("2026-11-02"));
    ledger.execute(
      "yes",
      { type: "decide", signal: "buy", approve: true, by: "owner" },
      time("2026-11-02", "10:01:00"),
    );
    assert.equal(ledger.state().fills.length, 0);
    assert.equal(ledger.state().cash, config.cash);
    assert.throws(
      () =>
        ledger.execute(
          "old",
          { type: "fill", signal: "buy", quote: quote(time("2026-11-02")) },
          time("2026-11-02", "10:02:00"),
        ),
      /行情|确认/,
    );
    const command = { type: "fill" as const, signal: "buy", quote: quote(time("2026-11-02", "10:02:00"), 1010) };
    const first = ledger.execute("fill", command, time("2026-11-02", "10:02:01"));
    assert.deepEqual(ledger.execute("fill", command, time("2026-11-02", "10:05:00")), first);
    assert.equal(ledger.state().fills[0].price, 1012);
    assert.equal(ledger.state().cash, config.cash - 101200 - 502);
    assert.throws(
      () => ledger.execute("fill", { ...command, signal: "other" }, time("2026-11-02", "10:06:00")),
      /编号/,
    );
    const reopened = new Ledger(ledger.file);
    try {
      assert.deepEqual(reopened.state(), ledger.state());
    } finally {
      reopened.close();
    }
  } finally {
    ledger.close();
  }
});

test("A-share execution enforces T+1 and checks the current order book and price limits", () => {
  const ledger = account();
  try {
    buy(ledger, "buy", "2026-11-02");
    signal(ledger, "sell", time("2026-11-02", "10:03:00"), "sell");
    ledger.execute(
      "sell-yes",
      { type: "decide", signal: "sell", approve: true, by: "owner" },
      time("2026-11-02", "10:04:00"),
    );
    assert.throws(
      () =>
        ledger.execute(
          "sell-now",
          { type: "fill", signal: "sell", quote: quote(time("2026-11-02", "10:05:00")) },
          time("2026-11-02", "10:05:01"),
        ),
      /T\+1|可卖/,
    );
    signal(ledger, "next-buy", time("2026-11-03"));
    ledger.execute(
      "next-yes",
      { type: "decide", signal: "next-buy", approve: true, by: "owner" },
      time("2026-11-03", "10:01:00"),
    );
    const q = quote(time("2026-11-03", "10:02:00"));
    assert.throws(
      () =>
        ledger.execute(
          "limit",
          { type: "fill", signal: "next-buy", quote: { ...q, ask: q.limitUp, askSize: 0 } },
          time("2026-11-03", "10:02:01"),
        ),
      /盘口|涨跌停/,
    );
    assert.throws(
      () =>
        ledger.execute(
          "weekend",
          { type: "fill", signal: "next-buy", quote: quote(time("2026-11-07")) },
          time("2026-11-07"),
        ),
      /过期|交易/,
    );
    assert.equal(ledger.state().fills.length, 1);
  } finally {
    ledger.close();
  }
});

test("weekly attribution uses opening market value and cash-flow neutral returns", () => {
  const ledger = account();
  try {
    buy(ledger, "buy", "2026-11-02");
    ledger.execute(
      "opening",
      { type: "mark", quotes: [quote(time("2026-11-06", "15:00:00"), 1100)] },
      time("2026-11-06", "15:00:01"),
    );
    ledger.execute(
      "deposit",
      { type: "cash", amount: 100_000, quotes: [quote(time("2026-11-09"), 1100)], note: "模拟入金" },
      time("2026-11-09", "10:00:01"),
    );
    ledger.execute(
      "closing",
      { type: "mark", quotes: [quote(time("2026-11-13", "15:00:00"), 1200)] },
      time("2026-11-13", "15:00:01"),
    );
    const result = review(ledger.state(), time("2026-11-06", "15:00:01"), time("2026-11-13", "15:00:01"));
    assert.equal(result.pnl, 10_000);
    assert.equal(result.cashFlow, 100_000);
    assert.equal(result.unrealizedChange, 10_000);
    assert.equal(result.realized, 0);
    assert.ok(result.returnRate! > 0 && result.returnRate! < 0.01);
    assert.equal(result.recommendation, "保持不变，已平仓样本不足");
    assert.equal(review(ledger.state(), time("2026-11-01"), time("2026-11-13", "15:00:01")).complete, false);
  } finally {
    ledger.close();
  }
});

test("selling allocates fees and FIFO cost to the original entry strategy", () => {
  const ledger = account();
  try {
    buy(ledger, "buy", "2026-11-02");
    signal(ledger, "sell", time("2026-11-03"), "sell");
    ledger.execute(
      "yes",
      { type: "decide", signal: "sell", approve: true, by: "owner" },
      time("2026-11-03", "10:01:00"),
    );
    ledger.execute(
      "sell-fill",
      { type: "fill", signal: "sell", quote: quote(time("2026-11-03", "10:02:00"), 1100) },
      time("2026-11-03", "10:02:01"),
    );
    const s = ledger.state();
    assert.equal(s.lots.length, 0);
    assert.equal(s.realized, s.cash - config.cash);
    assert.equal(s.closed[0].entryStrategy, "v1");
    assert.equal(s.closed[0].pnl, s.realized);
  } finally {
    ledger.close();
  }
});

test("holdout comparison cannot activate a proposal without validation and owner approval", () => {
  const ledger = account();
  try {
    const candidate = { ...strategy, id: "v2", entryBps: 200 };
    ledger.execute(
      "proposal",
      {
        type: "propose",
        strategy: candidate,
        rationale: "减少过早入场",
        evidence: "周报样本",
        risk: "可能错过上涨",
        trainingEnd: "2026-10-01",
      },
      time("2026-11-02", "10:01:00"),
    );
    assert.throws(
      () =>
        ledger.execute(
          "activate",
          { type: "activate", proposal: "v2", approve: true, by: "owner" },
          time("2026-11-02", "10:02:00"),
        ),
      /验证/,
    );
    assert.equal(ledger.state().active, "v1");
    const data: Dataset = {
      source: "fixture",
      adjustment: "none",
      marketRulesVerified: false,
      corporateActionsVerified: false,
      bars: [],
    };
    assert.equal(validateCandidate(strategy, candidate, data, config, "2026-10-01").passed, false);
    ledger.execute(
      "reject",
      { type: "activate", proposal: "v2", approve: false, by: "owner" },
      time("2026-11-02", "10:03:00"),
    );
    assert.equal(ledger.state().proposals.v2.status, "rejected");
    assert.equal(ledger.state().active, "v1");
  } finally {
    ledger.close();
  }
});

test("Tencent quotes retain exchange identity, exchange timestamp and price-band fields", () => {
  const fields = Array(60).fill("0");
  Object.assign(fields, {
    1: "演示",
    2: "000001",
    3: "10.00",
    9: "9.99",
    10: "20",
    19: "10.01",
    20: "30",
    6: "1000",
    30: "20261113100000",
    47: "11.00",
    48: "9.00",
  });
  const result = parseQuotes(`v_sz000001="${fields.join("~")}";`, ["sz000001"]);
  assert.equal(result[0].symbol, "sz000001");
  assert.equal(result[0].askSize, 3000);
  assert.equal(result[0].at, "2026-11-13T10:00:00+08:00");
  assert.equal(result[0].limitUp, 1100);
  assert.throws(() => parseQuotes(`v_sh000001="${fields.join("~")}";`, ["sz000001"]), /缺少/);
});

test("the live Tencent daily format accepts trailing decimal zeroes without using adjusted prices", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      data: {
        sh600000: {
          day: [["2026-11-12", "10.140", "10.210", "10.240", "10.030", "500817.000"]],
          qfqday: [["2026-11-12", "1.000", "1.000", "1.000", "1.000", "1"]],
        },
      },
    }),
  );
  const data = await history(["sh600000"]);
  assert.equal(data.bars[0].close, 1021);
  assert.equal(data.bars[0].volume, 50081700);
  assert.equal(data.marketRulesVerified, false);
});

test("a passing validation waits for its weekly approval card and preserves old signals", async () => {
  const ledger = account();
  const candidate = { ...strategy, id: "v2", entryBps: 200 };
  const data: Dataset = {
    source: "explicit synthetic test data",
    adjustment: "none",
    marketRulesVerified: true,
    corporateActionsVerified: true,
    bars: [],
  };
  const closes = [1000, 1000, 1020, 950, 950, 950, 950, 1000, 1100, 1200, 1200, 1200, 1180, 1100, 1100, 1000];
  let previous = 1000;
  for (let day = new Date("2025-01-01T00:00:00Z"), index = 0; index < 400; day.setUTCDate(day.getUTCDate() + 1)) {
    if ([0, 6].includes(day.getUTCDay())) continue;
    const close = closes[index++ % closes.length];
    data.bars.push({
      symbol: "sh600000",
      day: day.toISOString().slice(0, 10),
      open: previous,
      high: Math.max(previous, close),
      low: Math.min(previous, close),
      close,
      volume: 10000000,
      limitUp: 2000,
      limitDown: 500,
      suspended: false,
    });
    previous = close;
  }
  const trainingEnd = data.bars[4].day;
  try {
    signal(ledger, "old-signal", time("2026-11-02"));
    ledger.execute(
      "propose",
      {
        type: "propose",
        strategy: candidate,
        trainingEnd,
        rationale: "测试假设",
        evidence: "合成数据",
        risk: "仅验证流程",
      },
      time("2026-11-02", "10:01:00"),
    );
    ledger.execute("validate", { type: "validate", proposal: "v2", dataset: data }, time("2026-11-02", "10:02:00"));
    assert.equal(
      ledger.state().proposals.v2.validation?.passed,
      true,
      JSON.stringify(ledger.state().proposals.v2.validation),
    );
    assert.equal(ledger.state().active, "v1");
    const output = await cycle(
      { database: ledger.file, reports: scratch, account: config, strategy },
      { answers: [] },
      () => time("2026-11-02", "18:00:00"),
    );
    const receipt = readReceipt(output);
    assert.equal(receipt.ask?.length ?? 0, 0, "the trading rule must not repeat the weekly rule's strategy approval");
    ledger.execute(
      "owner-approval",
      { type: "activate", proposal: "v2", approve: true, by: "owner" },
      time("2026-11-02", "10:03:00"),
    );
    assert.equal(ledger.state().active, "v2");
    assert.equal(ledger.state().orders["old-signal"].strategy, "v1");
    assert.deepEqual(ledger.state().strategies.v1, strategy);
  } finally {
    ledger.close();
  }
});

test("a recorded dividend adjusts daily signal history just as validation does", () => {
  const ledger = account();
  try {
    buy(ledger, "buy", "2026-11-02");
    ledger.execute(
      "dividend",
      { type: "corporate-action", symbol: "sh600000", shareRatio: 1, cashPerShare: 50, reference: "test announcement" },
      time("2026-11-03", "09:00:00"),
    );
    const prices = closesAsOf(
      [
        { symbol: "sh600000", day: "2026-10-29", close: 1000 },
        { symbol: "sh600000", day: "2026-10-30", close: 1000 },
        { symbol: "sh600000", day: "2026-11-02", close: 1000 },
        { symbol: "sh600000", day: "2026-11-03", close: 950 },
      ],
      ledger.state().corporateActions,
      "2026-11-04",
    );
    assert.deepEqual(prices, [950, 950, 950, 950]);
    assert.equal(direction(prices, strategy, true), null);
    assert.equal(ledger.state().realized, 5000);
  } finally {
    ledger.close();
  }
});
