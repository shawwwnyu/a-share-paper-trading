// Reviews must preserve facts known at the cutoff and keep workflow diagnostics separate from asset performance.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Ledger, emptyState } from "../src/ledger.ts";
import { activityReview, dailyReview, renderActivityReview } from "../src/activity-review.ts";
import { saveDailyReview } from "../src/daily-report.ts";
import { review } from "../src/review.ts";
import { portfolioRisk } from "../src/portfolio-risk.ts";
import { cycle, weekly, markAccount } from "../src/integrations/agent-autoloop.ts";
import { runScan } from "../src/monitor-run.ts";
import { chat } from "../src/integrations/chat.ts";
import { readReceipt } from "./helpers/receipt.ts";
import type { Quote, Signal } from "../src/types.ts";
import type { TestContext } from "node:test";

const at = (day: string, clock = "10:00:00") => `2026-11-${day}T${clock}+08:00`;
const from = at("12", "23:59:59.999"),
  to = at("13", "23:59:59.999");
function q(time = at("13", "10:02:00"), price = 1000): Quote {
  return {
    symbol: "sh600000",
    name: "fixture",
    at: time,
    price,
    bid: price,
    ask: price,
    bidSize: 10000,
    askSize: 10000,
    volume: 1000000,
    limitDown: 500,
    limitUp: 2000,
    source: "合成行情",
    adjustment: "none",
  };
}
function setup() {
  const folder = mkdtempSync(join(tmpdir(), "paper-daily-"));
  const settings = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8"));
  settings.database = join(folder, "paper.db");
  settings.reports = join(folder, "reports");
  settings.account.risk = { stopLossBps: 500 };
  const ledger = new Ledger(settings.database);
  ledger.execute("init", { type: "init", config: settings.account, strategy: settings.strategy }, at("12", "09:00:00"));
  ledger.execute("opening", { type: "mark", quotes: [] }, at("12", "15:00:01"));
  return {
    folder,
    settings,
    ledger,
    close() {
      ledger.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
function signal(id: string, time = at("13")): Signal {
  return {
    id,
    symbol: "sh600000",
    side: "buy",
    quantity: 100,
    price: 1000,
    at: time,
    expiresAt: at("13", "14:56:59"),
    strategy: "initial-v1",
    reason: "合成建议",
  };
}
function add(ledger: Ledger, id: string) {
  ledger.execute(id, { type: "signal", signal: signal(id) }, at("13"));
}
function market(t: TestContext, quote = q()) {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "www.szse.cn")
      return Response.json({
        data: Array.from({ length: 30 }, (_, i) => ({ jyrq: `2026-11-${String(i + 1).padStart(2, "0")}`, jybz: "1" })),
      });
    if (url.hostname === "web.ifzq.gtimg.cn") {
      const symbol = url.searchParams.get("param")!.split(",")[0];
      return Response.json({ data: { [symbol]: { day: [["2026-11-12", "10", "10", "11", "9", "1000"]] } } });
    }
    if (url.hostname === "qt.gtimg.cn") {
      const raw = url.pathname
        .slice(3)
        .split(",")
        .map((symbol) => {
          const f = Array(60).fill("0");
          Object.assign(f, {
            1: "fixture",
            2: symbol.slice(2),
            3: String(quote.price / 100),
            4: "9.7",
            6: "10000",
            9: String(quote.bid / 100),
            10: String(quote.bidSize / 100),
            19: String(quote.ask / 100),
            20: String(quote.askSize / 100),
            30: quote.at.slice(0, 19).replace(/\D/g, ""),
            37: "30000",
            38: "3",
            39: "20",
            47: "20",
            48: "5",
          });
          return `v_${symbol}="${f.join("~")}";`;
        })
        .join("\n");
      return new Response(raw);
    }
    throw new Error("测试禁止外部网络");
  });
}

test("historical views retain same-time records and never include later confirmations or executions", () => {
  const env = setup();
  try {
    add(env.ledger, "buy");
    const pending = env.ledger.view(at("13"));
    assert.equal(pending.state.orders.buy.status, "pending");
    assert.equal(pending.records.at(-1)!.id, "buy");
    env.ledger.execute("yes", { type: "decide", signal: "buy", approve: true, by: "owner" }, at("13", "10:01:00"));
    env.ledger.execute("fill", { type: "fill", signal: "buy", quote: q() }, at("13", "10:02:00"));
    assert.deepEqual(env.ledger.view(at("13")), pending);
    const old = dailyReview(env.ledger, "2026-11-13", at("13", "10:00:00"));
    assert.equal(old.workflow.unfilled.pending.length, 1);
    assert.equal(old.performance.trades, 0);
    const current = dailyReview(env.ledger, "2026-11-13", at("13", "10:02:00"));
    assert.equal(current.performance.trades, 1);
    assert.equal(current.performance.complete, false);
    assert.match(current.recommendation, /保持/);
    const before = env.ledger.view(to);
    dailyReview(env.ledger, "2026-11-13", to);
    assert.deepEqual(env.ledger.view(to), before);
  } finally {
    env.close();
  }
});

test("confirmation latency includes rejected and unfilled decisions, while attempts count once per recorded check", () => {
  const env = setup();
  try {
    add(env.ledger, "waiting");
    add(env.ledger, "rejected");
    add(env.ledger, "pending");
    env.ledger.execute("yes", { type: "decide", signal: "waiting", approve: true, by: "owner" }, at("13", "10:01:00"));
    env.ledger.execute("no", { type: "decide", signal: "rejected", approve: false, by: "owner" }, at("13", "10:02:00"));
    const command = {
      type: "record-check" as const,
      check: { kind: "fill-blocked" as const, signal: "waiting", reason: "盘口不足" },
    };
    env.ledger.execute("check", command, at("13", "10:03:00"));
    env.ledger.execute("check", command, at("13", "10:03:00"));
    env.ledger.execute("check-again", command, at("13", "10:04:00"));
    const report = activityReview(env.ledger.view(at("13", "10:05:00")), from, at("13", "10:05:00"));
    assert.equal(report.signals.created, 3);
    assert.equal(report.confirmation.count, 2);
    assert.equal(report.confirmation.averageSeconds, 90);
    assert.equal(report.confirmation.approved, 1);
    assert.equal(report.confirmation.rejected, 1);
    assert.equal(report.unfilled.pending.length, 1);
    assert.equal(report.unfilled.approved.length, 1);
    assert.equal(report.unfilled.attempts, 2);
    assert.equal(report.unfilled.affectedOrders, 1);
    assert.equal(report.unfilled.byReason["盘口不足"], 2);
    const expired = activityReview(env.ledger.view(to), from, to);
    assert.equal(expired.unfilled.expiredUnrecorded.length, 2);
    assert.equal(expired.unfilled.recordedExpired.length, 0);
    assert.equal(env.ledger.state().orders.waiting.status, "approved");
    assert.match(renderActivityReview(report), /确认|未成交/);
  } finally {
    env.close();
  }
});

test("risk snapshots respect T+1, actual holdings and missing quotes without changing assets", () => {
  const env = setup();
  try {
    add(env.ledger, "buy");
    env.ledger.execute("yes", { type: "decide", signal: "buy", approve: true, by: "owner" }, at("13", "10:01:00"));
    env.ledger.execute("fill", { type: "fill", signal: "buy", quote: q() }, at("13", "10:02:00"));
    const before = env.ledger.state();
    const risk = portfolioRisk(before, [q(at("13", "10:03:00"), 900)], at("13", "10:03:00"));
    assert.equal(risk.complete, true);
    assert.equal(risk.positions[0].sellable, 0);
    assert.ok(risk.alerts.some((item) => item.kind === "stop-loss"));
    assert.ok(risk.alerts.some((item) => item.kind === "t-plus-one"));
    const missing = portfolioRisk(before, [], at("13", "10:03:00"));
    assert.equal(missing.complete, false);
    assert.equal(missing.equity, null);
    const stale = portfolioRisk(before, [q()], at("13", "18:00:00"));
    assert.equal(stale.complete, false);
    assert.equal(stale.positions[0].value, null);
    env.ledger.execute("risk", { type: "risk-snapshot", quotes: [q(at("13", "10:03:00"), 900)] }, at("13", "10:03:00"));
    assert.deepEqual(env.ledger.state().lots, before.lots);
    assert.equal(env.ledger.state().cash, before.cash);
    const report = activityReview(env.ledger.view(to), from, to);
    assert.equal(report.risk.snapshots, 1);
    assert.equal(report.risk.latest!.at, at("13", "10:03:00"));
    assert.equal(report.risk.current.complete, false);
  } finally {
    env.close();
  }
});

test("entry and exit strategy attribution uses recorded FIFO facts instead of current strategy parameters", () => {
  const state = emptyState();
  state.closed = [
    {
      at: at("13"),
      symbol: "sh600000",
      quantity: 100,
      pnl: -1234,
      entryStrategy: "entry-v1",
      exitStrategy: "exit-v2",
      signal: "old-buy",
    },
  ];
  state.active = "future-v3";
  const report = activityReview({ state, records: [] }, from, to);
  assert.equal(report.realizedByEntry["entry-v1"].pnl, -1234);
  assert.equal(report.realizedByExit["exit-v2"].pnl, -1234);
  assert.equal(report.realizedByEntry["future-v3"], undefined);
  assert.equal(report.execution.fills, 0);
});

test("daily cycle records blocked executions and repeated runs preserve a single check", async (t) => {
  const env = setup();
  try {
    add(env.ledger, "waiting");
    env.ledger.execute("yes", { type: "decide", signal: "waiting", approve: true, by: "owner" }, at("13", "10:01:00"));
    market(t, { ...q(), askSize: 0 });
    await cycle(env.settings, { answers: [] }, () => at("13", "10:02:00"));
    await cycle(env.settings, { answers: [] }, () => at("13", "10:02:00"));
    const report = dailyReview(env.ledger, "2026-11-13", at("13", "10:02:00"));
    assert.equal(report.workflow.unfilled.attempts, 1);
    assert.match(Object.keys(report.workflow.unfilled.byReason).join("；"), /盘口/);
    assert.equal(env.ledger.state().orders.waiting.status, "approved");
    assert.equal(env.ledger.state().fills.length, 0);
    assert.ok(report.workflow.risk.snapshots > 0);
  } finally {
    env.close();
  }
});

test("daily CLI writes a report without changing ledger facts or enabling a proposal", () => {
  const env = setup();
  try {
    env.ledger.execute("close", { type: "mark", quotes: [] }, at("13", "15:00:01"));
    const before = env.ledger.view(to);
    const file = join(env.folder, "config.json");
    writeFileSync(file, JSON.stringify(env.settings));
    const done = spawnSync(process.execPath, [resolve("src/cli.ts"), "daily-review", file, "2026-11-13"], {
      encoding: "utf8",
    });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /每日复盘/);
    assert.ok(existsSync(join(env.settings.reports, "daily", "2026-11-13.json")));
    assert.deepEqual(env.ledger.view(to), before);
    assert.equal(Object.keys(env.ledger.state().proposals).length, 0);
    const response = readReceipt(chat(env.settings, { events: [{ id: 1, detail: "查看日报" }] }));
    assert.match(response.notice![0].text, /每日复盘/);
  } finally {
    env.close();
  }
});

test("weekly reports include workflow diagnostics while retaining the existing keep-unchanged behavior", () => {
  const env = setup();
  try {
    add(env.ledger, "pending");
    env.ledger.execute("close", { type: "mark", quotes: [] }, at("13", "15:00:01"));
    const receipt = readReceipt(
      weekly(
        env.settings,
        { answers: [], events: [{ type: "schedule.tick", receivedAt: at("13", "18:00:00") }] },
        at("13", "18:00:00"),
      ),
    );
    assert.equal(receipt.ask?.length ?? 0, 0);
    const saved = JSON.parse(readFileSync(join(env.settings.reports, "2026-11-13.json"), "utf8"));
    assert.equal(saved.workflow.signals.created, 1);
    assert.match(saved.recommendation, /保持不变/);
    assert.match(readFileSync(join(env.settings.reports, "2026-11-13.md"), "utf8"), /未成交|筛选/);
  } finally {
    env.close();
  }
});

test("risk coverage considers holdings only and an activity view must not be newer than its cutoff", () => {
  const env = setup();
  try {
    const risk = portfolioRisk(env.ledger.state(), [q(at("12"))], at("13", "18:00:00"));
    assert.equal(risk.complete, true);
    assert.equal(risk.positionCount, 0);
    add(env.ledger, "future");
    assert.throws(() => activityReview(env.ledger.view(to), from, at("13", "09:59:00")), /截止|视图/);
  } finally {
    env.close();
  }
});

test("incomplete scans count as observations without replacing a watchlist or approving a trade", async (t) => {
  const env = setup();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at("13", "10:02:00")) });
  market(t);
  const fixtureFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname.includes("sina"))
      return url.pathname.includes("StockCount")
        ? Response.json("2")
        : Response.json([{ symbol: "sh600000" }, { symbol: "sz000001" }]);
    const response = await fixtureFetch(input);
    if (url.hostname === "qt.gtimg.cn") return new Response((await response.text()).replace(/v_sz000001="[^"]*";/, ""));
    return response;
  });
  try {
    await runScan(env.settings, "500");
    await runScan(env.settings, "500");
    const report = dailyReview(env.ledger, "2026-11-13", at("13", "10:02:00"));
    assert.equal(report.workflow.screening.incomplete, 1);
    assert.equal(report.workflow.screening.complete, 0);
    assert.equal(env.ledger.state().watchlistScan, undefined);
    assert.equal(env.ledger.state().fills.length, 0);
  } finally {
    env.close();
  }
});

test("immutable daily versions survive later facts and an older cutoff cannot replace the latest daily report", () => {
  const env = setup();
  try {
    const first = saveDailyReview(env.settings, "2026-11-13", at("13", "09:00:00"));
    add(env.ledger, "late");
    const later = saveDailyReview(env.settings, "2026-11-13", at("13", "10:00:00"));
    const replay = saveDailyReview(env.settings, "2026-11-13", at("13", "09:00:00"));
    assert.equal(first.hash, replay.hash);
    assert.equal(JSON.parse(readFileSync(later.file, "utf8")).to, at("13", "10:00:00"));
    assert.equal(
      readdirSync(join(env.settings.reports, "daily", "versions")).filter((file) => file.endsWith(".json")).length,
      2,
    );
  } finally {
    env.close();
  }
});

test("closing valuations create a daily report and retries repair its file without refetching or duplicate facts", async (t) => {
  const env = setup();
  market(t, q(at("13", "15:00:00")));
  try {
    await markAccount(env.settings, () => at("13", "15:00:01"));
    const file = join(env.settings.reports, "daily", "2026-11-13.json");
    assert.ok(existsSync(file));
    const before = env.ledger.view(to);
    rmSync(file);
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("重试不能重新取行情");
    });
    await markAccount(env.settings, () => at("13", "15:00:01"));
    assert.ok(existsSync(file));
    assert.deepEqual(env.ledger.view(to), before);
    const midday = setup();
    try {
      midday.ledger.execute("cash", { type: "cash", amount: 100, quotes: [], note: "合成入金" }, at("13", "10:00:00"));
      const missing = dailyReview(midday.ledger, "2026-11-13", to);
      assert.equal(missing.performance.complete, false);
      assert.equal(missing.performance.pnl, null);
      assert.match(missing.performance.issues.join("；"), /收盘/);
    } finally {
      midday.close();
    }
  } finally {
    env.close();
  }
});

test("a sufficient winning sample still recommends keeping the current strategy instead of periodic retuning", () => {
  const state = emptyState();
  state.points = [
    { at: from, equity: 1000000, cash: 1000000, cashFlow: 1000000, realized: 0, unrealized: 0, fees: 0, nav: 1 },
    {
      at: at("13", "15:00:01"),
      equity: 1002000,
      cash: 1002000,
      cashFlow: 1000000,
      realized: 2000,
      unrealized: 0,
      fees: 0,
      nav: 1.002,
    },
  ];
  state.closed = Array.from({ length: 20 }, (_, i) => ({
    at: at("13"),
    symbol: "sh600000",
    quantity: 100,
    pnl: 100,
    entryStrategy: "v1",
    exitStrategy: "v1",
    signal: `fixture-${i}`,
  }));
  const report = review(state, from, to);
  assert.equal(report.complete, true);
  assert.equal(report.exits, 20);
  assert.match(report.recommendation, /保持不变/);
});
