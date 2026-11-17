// The scheduled entry must enforce risk without relying on history availability or owner response latency.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { cycle, pendingCards } from "../src/integrations/agent-autoloop.ts";
import type { Settings } from "../src/config.ts";
import type { Quote, RiskPolicy } from "../src/types.ts";
import { readReceipt } from "./helpers/receipt.ts";

const time = (day: string, clock = "10:00:00") => `${day}T${clock}+08:00`;
const quote = (symbol: string, at: string, price = 1000): Quote => ({
  symbol,
  name: "fixture",
  at,
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
function setup(risk: RiskPolicy) {
  const dir = mkdtempSync(join(tmpdir(), "paper-risk-cycle-"));
  const settings: Settings = {
    database: join(dir, "paper.db"),
    reports: join(dir, "reports"),
    account: {
      cash: 1000000,
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      transferBps: 0,
      slippageBps: 0,
      maxQuoteAgeSeconds: 60,
      symbols: ["sh600000", "sz000001"],
      risk,
    },
    strategy: { id: "v1", lookback: 3, entryBps: 100, exitBps: 100, allocationBps: 2000 },
  };
  const ledger = new Ledger(settings.database);
  ledger.execute(
    "init",
    { type: "init", config: settings.account, strategy: settings.strategy },
    time("2026-11-12", "09:00:00"),
  );
  return {
    ledger,
    settings,
    close: () => {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function order(ledger: Ledger, id: string, symbol: string, day: string, side: "buy" | "sell" = "buy") {
  const now = time(day);
  ledger.execute(
    id,
    {
      type: "signal",
      signal: {
        id,
        symbol,
        side,
        quantity: 200,
        price: 1000,
        at: now,
        expiresAt: time(day, "14:56:59"),
        strategy: "v1",
        reason: "fixture",
      },
    },
    now,
  );
  ledger.execute(`yes-${id}`, { type: "decide", signal: id, approve: true, by: "owner" }, time(day, "10:01:00"));
}
function market(t: TestContext, observed: Quote[], failHistory = false) {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("szse.cn"))
      return Response.json({
        data: Array.from({ length: 30 }, (_, i) => ({ jyrq: `2026-11-${String(i + 1).padStart(2, "0")}`, jybz: "1" })),
      });
    if (url.includes("fqkline")) {
      if (failHistory) throw new Error("合成历史服务不可用");
      return Response.json({
        data: Object.fromEntries(
          observed.map((q) => [
            q.symbol,
            {
              day: [
                ["2026-11-09", "10", "10", "10", "10", "10000"],
                ["2026-11-10", "10", "10", "10", "10", "10000"],
                ["2026-11-11", "10", "10", "10", "10", "10000"],
              ],
            },
          ]),
        ),
      });
    }
    return new Response(
      observed
        .map((q) => {
          const fields = Array(60).fill("0");
          Object.assign(fields, {
            1: "fixture",
            2: q.symbol.slice(2),
            3: String(q.price / 100),
            9: String(q.bid / 100),
            10: "100",
            19: String(q.ask / 100),
            20: "100",
            6: "1000",
            30: q.at.slice(0, 19).replaceAll(/[-T:]/g, ""),
            47: "20",
            48: "5",
          });
          return `v_${q.symbol}="${fields.join("~")}";`;
        })
        .join("\n"),
    );
  });
}

test("a risk exit reaches the owner even if history fails, remains T+1 blocked, and expires durably", async (t) => {
  const env = setup({ stopLossBps: 500, maxOrderAgeMinutes: 10 });
  try {
    order(env.ledger, "entry", "sh600000", "2026-11-12");
    env.ledger.execute(
      "entry-fill",
      { type: "fill", signal: "entry", quote: quote("sh600000", time("2026-11-12", "10:02:00")) },
      time("2026-11-12", "10:02:00"),
    );
    const observed = [
      quote("sh600000", time("2026-11-12", "10:03:00"), 900),
      quote("sz000001", time("2026-11-12", "10:03:00")),
    ];
    market(t, observed, true);
    const first = readReceipt(await cycle(env.settings, { answers: [] }, () => time("2026-11-12", "10:03:01")));
    assert.equal(first.ask?.length, 1);
    const card = first.ask![0];
    assert.match(card.text, /止损/);
    assert.match(card.text, /T\+1/);
    assert.equal(env.ledger.state().fills.length, 1);
    observed.forEach((q) => {
      q.at = time("2026-11-12", "10:04:02");
    });
    const second = await cycle(
      env.settings,
      {
        answers: [
          {
            card: 10,
            title: card.title,
            options: card.options!,
            about: card.about!,
            choice: 0,
            by: "owner",
            at: time("2026-11-12", "10:04:00"),
          },
        ],
      },
      () => time("2026-11-12", "10:04:03"),
    );
    assert.match(second, /T\+1/);
    const exit = Object.values(env.ledger.state().orders).find((o) => o.side === "sell")!;
    assert.equal(exit.status, "approved");
    const last = readReceipt(
      await cycle(env.settings, { answers: [], open: [{ card: 10, title: card.title }] }, () =>
        time("2026-11-12", "18:00:00"),
      ),
    );
    assert.equal(env.ledger.state().orders[exit.id].status, "expired");
    assert.equal(last.resolve?.[0].card, 10);
    assert.equal(env.ledger.state().lots[0].quantity, 200);
  } finally {
    env.close();
  }
});

test("risk evaluation precedes approved buys, ending a conflicting add without a fill", async (t) => {
  const env = setup({ stopLossBps: 500 });
  try {
    order(env.ledger, "entry", "sh600000", "2026-11-12");
    env.ledger.execute(
      "entry-fill",
      { type: "fill", signal: "entry", quote: quote("sh600000", time("2026-11-12", "10:02:00")) },
      time("2026-11-12", "10:02:00"),
    );
    order(env.ledger, "add", "sh600000", "2026-11-13");
    market(t, [
      quote("sh600000", time("2026-11-13", "10:02:00"), 900),
      quote("sz000001", time("2026-11-13", "10:02:00")),
    ]);
    const result = readReceipt(await cycle(env.settings, { answers: [] }, () => time("2026-11-13", "10:02:01")));
    assert.equal(env.ledger.state().orders.add.status, "expired");
    assert.equal(env.ledger.state().fills.length, 1);
    assert.equal(result.ask?.length, 1);
    const again = readReceipt(
      await cycle(env.settings, { answers: [], open: [{ card: 11, title: result.ask![0].title }] }, () =>
        time("2026-11-13", "10:02:02"),
      ),
    );
    assert.equal(again.ask?.length, 0);
  } finally {
    env.close();
  }
});

test("scheduled fills use the complete current portfolio and deterministic approval priority", async (t) => {
  const env = setup({ maxTotalBps: 3000 });
  try {
    order(env.ledger, "z", "sz000001", "2026-11-12");
    env.ledger.execute(
      "a",
      {
        type: "signal",
        signal: {
          id: "a",
          symbol: "sh600000",
          side: "buy",
          quantity: 200,
          price: 1000,
          at: time("2026-11-12", "10:01:00"),
          expiresAt: time("2026-11-12", "14:56:59"),
          strategy: "v1",
          reason: "fixture",
        },
      },
      time("2026-11-12", "10:01:00"),
    );
    env.ledger.execute(
      "yes-a",
      { type: "decide", signal: "a", approve: true, by: "owner" },
      time("2026-11-12", "10:01:00"),
    );
    market(t, [quote("sh600000", time("2026-11-12", "10:02:00")), quote("sz000001", time("2026-11-12", "10:02:00"))]);
    const output = await cycle(env.settings, { answers: [] }, () => time("2026-11-12", "10:02:01"));
    assert.equal(env.ledger.state().orders.a.status, "filled");
    assert.equal(env.ledger.state().orders.z.status, "approved");
    assert.match(output, /总仓位/);
  } finally {
    env.close();
  }
});

test("an approved sell releases exposure before an earlier queued buy is checked", async (t) => {
  const env = setup({ maxTotalBps: 2000 });
  try {
    order(env.ledger, "entry", "sh600000", "2026-11-12");
    env.ledger.execute(
      "entry-fill",
      { type: "fill", signal: "entry", quote: quote("sh600000", time("2026-11-12", "10:02:00")) },
      time("2026-11-12", "10:02:00"),
    );
    order(env.ledger, "buy", "sz000001", "2026-11-13");
    const now = time("2026-11-13", "10:01:00");
    env.ledger.execute(
      "exit",
      {
        type: "signal",
        signal: {
          id: "exit",
          symbol: "sh600000",
          side: "sell",
          quantity: 200,
          price: 1000,
          at: now,
          expiresAt: time("2026-11-13", "14:56:59"),
          strategy: "v1",
          reason: "fixture",
        },
      },
      now,
    );
    env.ledger.execute("yes-exit", { type: "decide", signal: "exit", approve: true, by: "owner" }, now);
    market(t, [quote("sh600000", time("2026-11-13", "10:02:00")), quote("sz000001", time("2026-11-13", "10:02:00"))]);
    await cycle(env.settings, { answers: [] }, () => time("2026-11-13", "10:02:01"));
    assert.deepEqual(
      env.ledger.state().fills.map((f) => f.signal),
      ["entry", "exit", "buy"],
    );
    assert.equal(env.ledger.state().cash, 800000);
    assert.equal(env.ledger.state().lots[0].symbol, "sz000001");
  } finally {
    env.close();
  }
});

test("rejecting a risk exit is respected for the day and the next day requires a new decision", async (t) => {
  const env = setup({ stopLossBps: 500 });
  try {
    order(env.ledger, "entry", "sh600000", "2026-11-12");
    env.ledger.execute(
      "entry-fill",
      { type: "fill", signal: "entry", quote: quote("sh600000", time("2026-11-12", "10:02:00")) },
      time("2026-11-12", "10:02:00"),
    );
    const observed = [
      quote("sh600000", time("2026-11-12", "10:03:00"), 900),
      quote("sz000001", time("2026-11-12", "10:03:00")),
    ];
    market(t, observed);
    const first = readReceipt(await cycle(env.settings, { answers: [] }, () => time("2026-11-12", "10:03:01")));
    const card = first.ask![0];
    observed.forEach((q) => {
      q.at = time("2026-11-12", "10:04:01");
    });
    const rejected = readReceipt(
      await cycle(
        env.settings,
        {
          answers: [
            {
              card: 15,
              title: card.title,
              options: card.options,
              about: card.about,
              choice: 1,
              by: "owner",
              at: time("2026-11-12", "10:04:00"),
            },
          ],
        },
        () => time("2026-11-12", "10:04:02"),
      ),
    );
    assert.equal(rejected.ask?.length, 0);
    assert.equal(env.ledger.state().fills.length, 1);
    observed.forEach((q) => {
      q.at = time("2026-11-13", "10:00:00");
    });
    const next = readReceipt(await cycle(env.settings, { answers: [] }, () => time("2026-11-13", "10:00:01")));
    assert.equal(next.ask?.length, 1);
    assert.notEqual(next.ask![0].key, card.key);
    assert.equal(env.ledger.state().fills.length, 1);
    assert.equal(Object.values(env.ledger.state().orders).filter((o) => o.status === "rejected").length, 1);
  } finally {
    env.close();
  }
});

test("exit confirmation cards take priority over queued entries within the five-card delivery limit", () => {
  const env = setup({ stopLossBps: 500 });
  try {
    order(env.ledger, "entry", "sh600000", "2026-11-12");
    const now = time("2026-11-12", "10:02:00");
    env.ledger.execute("entry-fill", { type: "fill", signal: "entry", quote: quote("sh600000", now) }, now);
    for (let index = 0; index < 6; index++) {
      const id = `queued-${index}`;
      env.ledger.execute(
        id,
        {
          type: "signal",
          signal: {
            id,
            symbol: "sz000001",
            side: "buy",
            quantity: 100,
            price: 1000,
            at: now,
            expiresAt: time("2026-11-12", "14:56:59"),
            strategy: "v1",
            reason: "fixture",
          },
        },
        now,
      );
    }
    env.ledger.execute(
      "exit",
      {
        type: "signal",
        signal: {
          id: "exit",
          symbol: "sh600000",
          side: "sell",
          quantity: 200,
          price: 900,
          at: now,
          expiresAt: time("2026-11-12", "14:56:59"),
          strategy: "v1",
          reason: "止损合成测试",
        },
      },
      now,
    );
    const firstFive = pendingCards(env.ledger.state(), now).slice(0, 5);
    assert.equal(firstFive[0].about, "paper-trade:exit");
  } finally {
    env.close();
  }
});
