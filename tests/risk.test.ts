// Risk limits must use committed holdings, never approvals or a cached account valuation.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { riskExit, orderedApprovals } from "../src/risk.ts";
import { validateCandidate } from "../src/strategy.ts";
import type { AccountConfig, Quote, RiskPolicy, Signal } from "../src/types.ts";

const scratch = mkdtempSync(join(tmpdir(), "paper-risk-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const at = (day = "2026-11-12", clock = "10:00:00") => `${day}T${clock}+08:00`;
const strategy = { id: "v1", lookback: 3, entryBps: 100, exitBps: 100, allocationBps: 2000 };
const config: AccountConfig = {
  cash: 1_000_000,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  transferBps: 0,
  slippageBps: 0,
  maxQuoteAgeSeconds: 60,
  symbols: ["sh600000", "sz000001", "sh600001"],
};
const q = (symbol = "sh600000", price = 1000, now = at("2026-11-12", "10:02:00")): Quote => ({
  symbol,
  name: "合成行情",
  at: now,
  price,
  bid: price,
  ask: price,
  bidSize: 10000,
  askSize: 10000,
  volume: 100000,
  limitUp: 2000,
  limitDown: 500,
  source: "fixture",
  adjustment: "none",
});
let serial = 0;
function account(risk?: RiskPolicy, overrides: Partial<AccountConfig> = {}) {
  const ledger = new Ledger(join(scratch, `${serial++}.db`));
  try {
    ledger.execute(
      "init",
      { type: "init", config: { ...config, ...overrides, ...(risk && { risk }) }, strategy },
      at(),
    );
    return ledger;
  } catch (error) {
    ledger.close();
    throw error;
  }
}
function signal(
  ledger: Ledger,
  id: string,
  symbol = "sh600000",
  quantity = 200,
  side: "buy" | "sell" = "buy",
  now = at(),
) {
  const value: Signal = {
    id,
    symbol,
    side,
    quantity,
    price: 1000,
    at: now,
    expiresAt: `${now.slice(0, 10)}T14:56:59+08:00`,
    strategy: "v1",
    reason: "合成行为测试",
  };
  ledger.execute(id, { type: "signal", signal: value }, now);
}
function approve(ledger: Ledger, id: string, now = at("2026-11-12", "10:01:00")) {
  ledger.execute(`yes-${id}`, { type: "decide", signal: id, approve: true, by: "owner" }, now);
}
function fill(ledger: Ledger, id: string, quote = q(), quotes?: Quote[]) {
  return ledger.execute(`fill-${id}`, { type: "fill", signal: id, quote, ...(quotes && { quotes }) }, quote.at);
}

for (const [name, risk, symbol, error] of [
  ["total", { maxTotalBps: 3500 }, "sz000001", /总仓位/],
  ["symbol", { maxSymbolBps: 3500 }, "sh600000", /单股仓位/],
  ["count", { maxPositions: 1 }, "sz000001", /持仓数量/],
  ["industry", { maxIndustryBps: 3500, industries: { sh600000: "银行", sz000001: "银行" } }, "sz000001", /行业集中度/],
] as const) {
  test(`${name}: two approved buys cannot jointly exceed the actual portfolio limit`, () => {
    const ledger = account(risk);
    const other = new Ledger(ledger.file);
    try {
      signal(ledger, "a");
      signal(ledger, "b", symbol);
      approve(ledger, "a");
      approve(ledger, "b");
      assert.equal(ledger.state().cash, config.cash);
      assert.equal(ledger.state().lots.length, 0);
      fill(ledger, "a");
      const before = ledger.state();
      assert.throws(() => fill(other, "b", q(symbol), [q()]), error);
      assert.deepEqual(other.state(), before);
      assert.equal(other.state().orders.b.status, "approved");
      assert.equal(other.recorded("fill-b"), false);
      assert.deepEqual(fill(other, "a"), fill(ledger, "a"));
      assert.equal(other.state().fills.length, 1);
    } finally {
      other.close();
      ledger.close();
    }
  });
}

test("limits include fees and adverse slippage; exact boundaries without costs remain allowed", () => {
  for (const overrides of [{ minimumCommission: 500 }, { slippageBps: 10 }]) {
    const ledger = account({ maxTotalBps: 2000 }, overrides);
    try {
      signal(ledger, "a");
      approve(ledger, "a");
      assert.throws(() => fill(ledger, "a"), /总仓位/);
      assert.equal(ledger.state().fills.length, 0);
    } finally {
      ledger.close();
    }
  }
  const ledger = account({ maxTotalBps: 2000 });
  try {
    signal(ledger, "a");
    approve(ledger, "a");
    fill(ledger, "a");
    assert.equal(ledger.state().lots.length, 1);
  } finally {
    ledger.close();
  }
});

test("missing, stale, duplicate or future holding quotes cannot use cached valuations to admit a buy", () => {
  const ledger = account({ maxTotalBps: 8000 });
  try {
    signal(ledger, "a");
    signal(ledger, "b", "sz000001");
    approve(ledger, "a");
    approve(ledger, "b");
    fill(ledger, "a");
    const next = q("sz000001", 1000, at("2026-11-12", "10:04:00"));
    for (const observed of [
      undefined,
      [q()],
      [q("sh600000", 1000, at("2026-11-12", "10:05:00"))],
      [q("sh600000", 1000, next.at), q("sh600000", 1000, next.at)],
    ])
      assert.throws(() => fill(ledger, "b", next, observed), /持仓|行情|重复/);
    fill(ledger, "b", next, [q("sh600000", 1000, next.at)]);
    assert.equal(ledger.state().fills.length, 2);
  } finally {
    ledger.close();
  }
});

test("industry caps reject missing classification and include holdings removed from the watchlist", () => {
  const ledger = account({ maxIndustryBps: 3000, industries: { sh600000: "银行", sz000001: "银行" } });
  try {
    signal(ledger, "a");
    signal(ledger, "missing", "sh600001");
    signal(ledger, "b", "sz000001");
    approve(ledger, "a");
    approve(ledger, "missing");
    approve(ledger, "b");
    fill(ledger, "a");
    assert.throws(() => fill(ledger, "missing", q("sh600001"), [q()]), /行业资料/);
    ledger.execute(
      "scan",
      {
        type: "watchlist",
        scan: {
          id: "fixture-scan",
          rule: "fixture",
          at: q().at,
          universeSize: 2,
          observed: 2,
          complete: true,
          failures: [],
          excluded: [],
          selected: ["sz000001", "sh600001"].map((symbol) => ({
            symbol,
            name: "合成股票",
            at: q().at,
            price: 1000,
            score: 1,
            reasons: ["合成数据"],
            source: "fixture",
          })),
        },
      },
      q().at,
    );
    assert.equal(
      ledger.state().watchlist.some((c) => c.symbol === "sh600000"),
      false,
    );
    assert.equal(ledger.state().lots.length, 1);
    assert.throws(() => fill(ledger, "b", q("sz000001"), [q()]), /行业集中度/);
  } finally {
    ledger.close();
  }
});

test("stop loss beats holding duration, profit beats duration, and missing history does not prevent exits", () => {
  const ledger = account({ stopLossBps: 500, takeProfitBps: 1000, maxHoldingDays: 1 });
  try {
    signal(ledger, "a");
    approve(ledger, "a");
    fill(ledger, "a");
    const now = at("2026-11-13");
    assert.equal(riskExit(ledger.state(), q("sh600000", 950, now), now)?.kind, "stop-loss");
    assert.equal(riskExit(ledger.state(), q("sh600000", 1100, now), now)?.kind, "take-profit");
    assert.equal(riskExit(ledger.state(), q("sh600000", 1000, now), now)?.kind, "holding-time");
    assert.throws(() => riskExit(ledger.state(), q(), now), /行情/);
  } finally {
    ledger.close();
  }
});

test("exit suggestions supersede buys but approval cannot bypass T+1, book depth or expiry", () => {
  const ledger = account({ stopLossBps: 500, maxOrderAgeMinutes: 10 });
  try {
    signal(ledger, "a");
    approve(ledger, "a");
    fill(ledger, "a");
    const now = at("2026-11-12", "10:03:00");
    signal(ledger, "add", "sh600000", 100, "buy", now);
    approve(ledger, "add", now);
    signal(ledger, "exit", "sh600000", 200, "sell", now);
    assert.equal(ledger.state().orders.add.status, "expired");
    assert.match(ledger.state().orders.add.closedReason!, /卖出/);
    assert.equal(ledger.state().orders.exit.status, "pending");
    approve(ledger, "exit", now);
    assert.throws(() => fill(ledger, "exit", q("sh600000", 900, at("2026-11-12", "10:04:00"))), /T\+1/);
    ledger.execute("expire", { type: "expire-orders" }, at("2026-11-12", "10:13:00"));
    assert.equal(ledger.state().orders.exit.status, "expired");
    assert.equal(ledger.state().orders.exit.decision, true);
    assert.equal(ledger.state().lots[0].quantity, 200);
    signal(ledger, "next", "sh600000", 200, "sell", at("2026-11-13"));
    approve(ledger, "next", at("2026-11-13", "10:01:00"));
    const next = q("sh600000", 900, at("2026-11-13", "10:02:00"));
    assert.throws(() => fill(ledger, "next", { ...next, bidSize: 0 }), /盘口/);
    fill(ledger, "next", next);
    assert.equal(ledger.state().lots.length, 0);
  } finally {
    ledger.close();
  }
});

test("order age caps apply to manual orders and expire pending and approved orders at the boundary", () => {
  const ledger = account({ maxOrderAgeMinutes: 5 });
  try {
    signal(ledger, "a");
    signal(ledger, "b");
    approve(ledger, "a");
    assert.equal(Date.parse(ledger.state().orders.a.expiresAt), Date.parse(at()) + 300000);
    assert.throws(() => fill(ledger, "a", q("sh600000", 1000, at("2026-11-12", "10:05:00"))), /过期/);
    const command = { type: "expire-orders" as const };
    ledger.execute("expire", command, at("2026-11-12", "10:05:00"));
    const before = ledger.state();
    ledger.execute("expire", command, at("2026-11-12", "10:06:00"));
    assert.deepEqual(ledger.state(), before);
    assert.ok(Object.values(before.orders).every((o) => o.status === "expired"));
  } finally {
    ledger.close();
  }
});

test("execution priority is sells then approval time then ID, independent of input ordering", () => {
  const ledger = account();
  try {
    signal(ledger, "holding");
    approve(ledger, "holding");
    fill(ledger, "holding");
    const now = at("2026-11-13");
    signal(ledger, "z", "sz000001", 100, "buy", now);
    signal(ledger, "a", "sh600001", 100, "buy", now);
    signal(ledger, "sell", "sh600000", 200, "sell", now);
    approve(ledger, "z", now);
    approve(ledger, "a", now);
    approve(ledger, "sell", now);
    assert.deepEqual(
      orderedApprovals(ledger.state(), now).map((o) => o.id),
      ["sell", "a", "z"],
    );
  } finally {
    ledger.close();
  }
});

test("invalid risk settings are rejected and fixed-pool validation cannot silently ignore risk rules", () => {
  for (const risk of [
    { maxTotalBps: 10001 },
    { maxPositions: 0 },
    { stopLossBps: -1 },
    { maxHoldingDays: 0 },
    { maxIndustryBps: 5000 },
    { maxOrderAgeMinutes: 1.5 },
  ]) {
    assert.throws(() => {
      const ledger = account(risk);
      ledger.close();
    }, /风险|行业|整数/);
  }
  const result = validateCandidate(
    strategy,
    { ...strategy, id: "v2", entryBps: 200 },
    {
      source: "fixture",
      adjustment: "none",
      marketRulesVerified: true,
      corporateActionsVerified: true,
      bars: [],
    },
    { ...config, risk: { stopLossBps: 500 } },
    "2026-01-01",
  );
  assert.equal(result.passed, false);
  assert.match(result.reasons.join("；"), /风险/);
});
