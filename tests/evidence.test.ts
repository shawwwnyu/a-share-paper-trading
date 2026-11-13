// Evidence must be available at decision time; a manual observation must never bypass missing or unsafe facts.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { verifySnapshot } from "../src/scan-snapshot.ts";
import { runScan } from "../src/monitor-run.ts";
import { cycle } from "../src/integrations/agent-autoloop.ts";
import { chat } from "../src/integrations/chat.ts";
import { readReceipt } from "./helpers/receipt.ts";
import { screen, type MarketRow } from "../src/monitor.ts";
import { checkEvidenceBuy, screenWithEvidence, type ScreeningRecord, type EvidenceDataset } from "../src/evidence.ts";
import { Ledger } from "../src/ledger.ts";
import { loadSettings } from "../src/config.ts";

const now = "2026-11-13T10:00:00+08:00";
const later = "2026-11-13T10:02:00+08:00";
const row: MarketRow = {
  symbol: "sh600000",
  name: "合成股票",
  at: now,
  price: 1000,
  previousClose: 970,
  amount: 300000000,
  turnover: 3,
  pe: 20,
  volume: 30000000,
  bid: 999,
  ask: 1000,
  bidSize: 10000,
  askSize: 10000,
  limitUp: 1067,
  limitDown: 873,
  adjustment: "none",
  source: "fixture",
};
function proof<T>(value: T) {
  return {
    source: "合成核对来源",
    publishedAt: "2026-11-13T09:00:00+08:00",
    checkedAt: now,
    validUntil: "2026-11-13T18:00:00+08:00",
    value,
  };
}
function facts(symbol = row.symbol): ScreeningRecord {
  return {
    symbol,
    industry: proof({ classification: "合成分类", name: "合成行业" }),
    financial: proof({ periodEnd: "2026-09-30", netProfit: 100, operatingCashFlow: 120 }),
    announcements: proof({ from: "2026-10-01", through: "2026-11-13", items: [] }),
    trading: proof({ status: "trading" }),
    listing: proof({ listedOn: "2000-01-01" }),
    corporateActions: proof({ from: "2025-11-01", through: "2026-11-13", events: [] }),
  };
}
function dataset(records = [facts()]): EvidenceDataset {
  return { records };
}
function scan(records = [facts()], rows = [row]) {
  return screenWithEvidence(
    screen(
      rows.map((r) => r.symbol),
      rows,
      [],
      now,
    ),
    rows,
    dataset(records),
    now,
  );
}
function setup() {
  const folder = mkdtempSync(join(tmpdir(), "paper-evidence-"));
  const file = join(folder, "paper.db");
  const settings = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8"));
  let ledger = new Ledger(file);
  ledger.execute("init", { type: "init", config: settings.account, strategy: settings.strategy }, now);
  return {
    folder,
    settings,
    get ledger() {
      return ledger;
    },
    reopen() {
      ledger.close();
      ledger = new Ledger(file);
    },
    close() {
      ledger.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
function signal(id: string) {
  return {
    id,
    symbol: row.symbol,
    side: "buy" as const,
    quantity: 100,
    price: 1000,
    at: now,
    expiresAt: "2026-11-13T14:56:59+08:00",
    strategy: "initial-v1",
    reason: "合成行为测试",
  };
}

test("evidence screening retains the source snapshot and rejects missing, future, stale and unsafe facets", () => {
  const good = scan();
  assert.equal(good.selected.length, 1);
  assert.deepEqual(good.selected[0].evidence, facts());
  assert.notEqual(good.rule, screen([row.symbol], [row], [], now).rule);
  assert.equal(scan([]).selected.length, 0);
  const cases: [string, (r: ScreeningRecord) => void, RegExp][] = [
    [
      "missing industry",
      (r) => {
        delete r.industry;
      },
      /行业.*缺失/,
    ],
    [
      "future publication",
      (r) => {
        r.financial!.publishedAt = later;
      },
      /未来|时间/,
    ],
    [
      "future check",
      (r) => {
        r.trading!.checkedAt = later;
      },
      /未来|时间/,
    ],
    [
      "expired",
      (r) => {
        r.trading!.validUntil = now;
      },
      /过期/,
    ],
    [
      "overlong validity",
      (r) => {
        r.trading!.validUntil = "2027-11-13T10:00:00+08:00";
      },
      /时效/,
    ],
    [
      "unprofitable",
      (r) => {
        r.financial!.value.netProfit = 0;
      },
      /利润/,
    ],
    [
      "missing cashflow",
      (r) => {
        r.financial!.value.operatingCashFlow = NaN;
      },
      /财务|现金流/,
    ],
    [
      "old financial",
      (r) => {
        r.financial!.value.periodEnd = "2025-09-30";
      },
      /财务/,
    ],
    [
      "new listing",
      (r) => {
        r.listing!.value.listedOn = "2026-11-01";
      },
      /上市/,
    ],
    [
      "invalid calendar",
      (r) => {
        r.listing!.value.listedOn = "2026-02-30";
      },
      /上市/,
    ],
    [
      "suspension",
      (r) => {
        r.trading!.value.status = "suspended";
      },
      /停牌|交易状态/,
    ],
    [
      "partial announcements",
      (r) => {
        r.announcements!.value.from = "2026-11-12";
      },
      /公告.*覆盖/,
    ],
    [
      "risky announcement",
      (r) => {
        r.announcements!.value.items.push({
          title: "合成风险公告",
          publishedAt: now,
          reference: "fixture",
          risk: true,
        });
      },
      /公告/,
    ],
    [
      "future announcement",
      (r) => {
        r.announcements!.value.items.push({ title: "未来资料", publishedAt: later, reference: "fixture", risk: false });
      },
      /公告/,
    ],
    [
      "partial actions",
      (r) => {
        r.corporateActions!.value.through = "2026-11-12";
      },
      /公司行为.*覆盖/,
    ],
  ];
  for (const [label, mutate, reason] of cases) {
    const record = facts();
    mutate(record);
    const report = scan([record]);
    assert.equal(report.selected.length, 0, label);
    assert.match(report.excluded.map((item) => item.reason).join("；"), reason, label);
  }
  const changed = facts();
  changed.industry!.source = "另一合成来源";
  assert.notEqual(scan([changed]).id, good.id);
  assert.throws(() => scan([facts(), facts()]), /重复/);
});

test("manual observations promote only with valid evidence and demotions preserve fills, decisions and exit reasons", () => {
  const env = setup();
  try {
    env.ledger.execute("missing", { type: "watchlist", scan: scan([]) }, now);
    const manual = {
      type: "manual-watch" as const,
      symbol: row.symbol,
      name: row.name,
      action: "add" as const,
      reason: "本人观察合成行业",
      by: "owner",
    };
    env.ledger.execute("manual", manual, now);
    assert.equal(env.ledger.state().manualWatchlist.length, 1);
    assert.equal(env.ledger.state().watchlist.length, 0);
    assert.throws(() => env.ledger.execute("blocked", { type: "signal", signal: signal("blocked") }, now), /自选|证据/);
    env.ledger.execute("qualified", { type: "watchlist", scan: scan() }, now);
    env.ledger.execute("signal", { type: "signal", signal: signal("buy") }, now);
    env.ledger.execute("yes", { type: "decide", signal: "buy", approve: true, by: "owner" }, now);
    env.ledger.execute("fill", { type: "fill", signal: "buy", quote: { ...row, at: later } }, later);
    env.ledger.execute("signal-2", { type: "signal", signal: { ...signal("waiting"), at: later } }, later);
    env.ledger.execute("yes-2", { type: "decide", signal: "waiting", approve: true, by: "owner" }, later);
    const suspended = facts();
    suspended.trading!.value.status = "suspended";
    env.ledger.execute("demote", { type: "watchlist", scan: scan([suspended]) }, later);
    const state = env.ledger.state();
    assert.equal(state.watchlist.length, 0);
    assert.equal(state.manualWatchlist.length, 1);
    assert.equal(state.lots[0].quantity, 100);
    assert.equal(state.orders.waiting.decision, true);
    assert.equal(state.orders.waiting.status, "expired");
    assert.match(state.orders.waiting.closedReason!, /停牌|交易状态/);
    assert.match(state.watchlistHistory.at(-1)!.reasons.join("；"), /停牌|交易状态/);
    assert.deepEqual(state.fills.length, 1);
    env.ledger.execute("demote", { type: "watchlist", scan: scan([suspended]) }, later);
    env.reopen();
    assert.deepEqual(env.ledger.state(), state);
    env.ledger.execute("remove", { ...manual, action: "remove", reason: "停止人工跟踪" }, later);
    assert.equal(env.ledger.state().manualWatchlist.length, 0);
    assert.match(env.ledger.state().watchlistHistory.at(-1)!.reasons.join("；"), /停止人工跟踪/);
    const sellAt = "2026-11-16T10:00:00+08:00";
    env.ledger.execute(
      "sell",
      {
        type: "signal",
        signal: { ...signal("sell"), side: "sell", at: sellAt, expiresAt: "2026-11-16T14:56:59+08:00" },
      },
      sellAt,
    );
    env.ledger.execute("yes-sell", { type: "decide", signal: "sell", approve: true, by: "owner" }, sellAt);
    env.ledger.execute(
      "fill-sell",
      { type: "fill", signal: "sell", quote: { ...row, at: "2026-11-16T10:02:00+08:00" } },
      "2026-11-16T10:02:00+08:00",
    );
    assert.equal(env.ledger.state().lots.length, 0);
    assert.equal(env.ledger.state().fills.length, 2);
  } finally {
    env.close();
  }
});

test("manual picks beyond the automatic top twenty can qualify while incomplete scans cannot change them", () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({ ...row, symbol: `sh${600000 + i}` }));
  const env = setup();
  try {
    const report = scan(
      rows.map((r) => facts(r.symbol)),
      rows,
    );
    env.ledger.execute("watch", { type: "watchlist", scan: report }, now);
    assert.equal(env.ledger.state().watchlist.length, 20);
    env.ledger.execute(
      "pick",
      {
        type: "manual-watch",
        action: "add",
        symbol: rows[20].symbol,
        name: "人工观察",
        reason: "跟踪排名之外候选",
        by: "owner",
      },
      now,
    );
    assert.equal(env.ledger.state().watchlist.length, 21);
    assert.throws(
      () => env.ledger.execute("partial", { type: "watchlist", scan: { ...report, complete: false } }, now),
      /不完整/,
    );
    assert.equal(env.ledger.state().watchlist.length, 21);
  } finally {
    env.close();
  }
});

test("buy signal and fill recheck evidence expiry and corporate actions without crediting assets", () => {
  const env = setup();
  try {
    const short = facts();
    short.trading!.validUntil = "2026-11-13T10:01:00+08:00";
    env.ledger.execute("watch", { type: "watchlist", scan: scan([short]) }, now);
    env.ledger.execute("signal", { type: "signal", signal: signal("buy") }, now);
    env.ledger.execute("yes", { type: "decide", signal: "buy", approve: true, by: "owner" }, now);
    assert.throws(
      () => env.ledger.execute("fill", { type: "fill", signal: "buy", quote: { ...row, at: later } }, later),
      /过期/,
    );
    assert.throws(
      () => env.ledger.execute("late-signal", { type: "signal", signal: { ...signal("late"), at: later } }, later),
      /过期/,
    );
    const action = facts();
    action.corporateActions!.value.events.push({
      day: "2026-11-13",
      shareRatio: 1,
      cashPerShare: 10,
      reference: "合成公司行为",
    });
    env.ledger.execute("refresh", { type: "watchlist", scan: scan([action]) }, later);
    assert.throws(
      () => env.ledger.execute("fill", { type: "fill", signal: "buy", quote: { ...row, at: later } }, later),
      /公司行为.*账本/,
    );
    assert.equal(env.ledger.state().cash, env.settings.account.cash);
    env.ledger.execute(
      "action",
      {
        type: "corporate-action",
        symbol: row.symbol,
        day: "2026-11-13",
        shareRatio: 1,
        cashPerShare: 10,
        reference: "核实后记录",
      },
      later,
    );
    env.ledger.execute("fill", { type: "fill", signal: "buy", quote: { ...row, at: later } }, later);
    assert.equal(env.ledger.state().fills.length, 1);
  } finally {
    env.close();
  }
});

test("evidence file resolves relative to account settings", () => {
  const folder = mkdtempSync(join(tmpdir(), "paper-evidence-config-"));
  try {
    const file = join(folder, "config.json");
    const base = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8"));
    writeFileSync(file, JSON.stringify({ ...base, screeningEvidence: "evidence.json" }));
    assert.equal(loadSettings(file).screeningEvidence, join(folder, "evidence.json"));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("manual removal before a first scan expires queued buys and keeps exclusions through later scans", () => {
  const env = setup();
  try {
    env.ledger.execute("signal", { type: "signal", signal: signal("buy") }, now);
    env.ledger.execute("yes", { type: "decide", signal: "buy", approve: true, by: "owner" }, now);
    env.ledger.execute(
      "remove",
      { type: "manual-watch", action: "remove", symbol: row.symbol, reason: "本人暂不跟踪", by: "owner" },
      now,
    );
    assert.equal(env.ledger.state().orders.buy.status, "expired");
    assert.throws(
      () => env.ledger.execute("fill", { type: "fill", signal: "buy", quote: { ...row, at: later } }, later),
      /移出|排除|确认/,
    );
    assert.throws(() => env.ledger.execute("signal-2", { type: "signal", signal: signal("buy-2") }, now), /排除/);
    env.ledger.execute("watch", { type: "watchlist", scan: scan() }, now);
    assert.equal(env.ledger.state().watchlist.length, 0);
    env.ledger.execute(
      "add",
      { type: "manual-watch", action: "add", symbol: row.symbol, name: row.name, reason: "恢复观察", by: "owner" },
      now,
    );
    assert.equal(env.ledger.state().watchlist.length, 1);
  } finally {
    env.close();
  }
});

test("evidence mode cannot silently fall back to a legacy scan and industry conflicts block buys", () => {
  const env = setup();
  try {
    env.ledger.execute("watch", { type: "watchlist", scan: scan() }, now);
    assert.throws(
      () => env.ledger.execute("legacy", { type: "watchlist", scan: screen([row.symbol], [row], [], now) }, now),
      /回退/,
    );
    const state = env.ledger.state();
    assert.equal(state.watchlistScan!.rule, scan().rule);
    // Query the guard with a frozen industry limit without changing an initialized account.
    state.config!.risk = { maxIndustryBps: 5000, industries: { [row.symbol]: "另一行业" } };
    assert.throws(() => checkEvidenceBuy(state, row.symbol, now), /行业.*不符/);
    assert.throws(() => checkEvidenceBuy(env.ledger.state(), row.symbol, "2026-11-14T10:00:00+08:00"), /过期/);
  } finally {
    env.close();
  }
});

function fakeMarket(t: TestContext) {
  const quoteBatches: string[][] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "www.szse.cn")
      return Response.json({
        data: Array.from({ length: 30 }, (_, i) => ({ jyrq: `2026-11-${String(i + 1).padStart(2, "0")}`, jybz: "1" })),
      });
    if (url.hostname === "qt.gtimg.cn") {
      const symbols = url.pathname.slice(3).split(",");
      quoteBatches.push(symbols);
      const raw = symbols
        .map((symbol) => {
          const f = Array(60).fill("0");
          Object.assign(f, {
            1: "fixture",
            2: symbol.slice(2),
            3: "10",
            4: "9.7",
            6: "300000",
            9: "9.99",
            10: "100",
            19: "10",
            20: "100",
            30: "20261113100000",
            37: "30000",
            38: "3",
            39: "20",
            47: "10.67",
            48: "8.73",
          });
          return `v_${symbol}="${f.join("~")}";`;
        })
        .join("\n");
      return new Response(raw);
    }
    if (url.hostname === "web.ifzq.gtimg.cn") {
      const symbol = url.searchParams.get("param")!.split(",")[0];
      return Response.json({ data: { [symbol]: { day: [["2026-11-12", "10", "10", "11", "9", "1000"]] } } });
    }
    throw new Error("测试禁止访问其他网络");
  });
  return quoteBatches;
}

test("scan command saves the exact evidence snapshot, replays it once, and preserves facts on corrupt imports", async (t) => {
  const env = setup();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  const batches = fakeMarket(t);
  try {
    const settings = {
      ...env.settings,
      database: env.ledger.file,
      reports: join(env.folder, "reports"),
      screeningEvidence: join(env.folder, "evidence.json"),
    };
    const folder = join(settings.reports, "scans");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "universe-2026-11-13.json"),
      JSON.stringify({ source: "fixture", sourceTotal: 2, symbols: [row.symbol, "sz000001"] }),
    );
    writeFileSync(settings.screeningEvidence, JSON.stringify(dataset()));
    const receipt = readReceipt(await runScan(settings, "101"));
    assert.match(receipt.notice![0].text, /证据/);
    const state = env.ledger.state();
    assert.equal(state.watchlist.length, 1);
    const saved = JSON.parse(readFileSync(join(folder, `${state.watchlistScan!.id}.json`), "utf8"));
    assert.equal(saved.schema, "screening-snapshot-v1");
    assert.doesNotThrow(() => verifySnapshot(saved));
    assert.deepEqual(saved.evidence, dataset());
    assert.deepEqual(saved.report.assessments[1].reasons, ["筛选证据缺失"]);
    writeFileSync(settings.screeningEvidence, "{broken");
    await runScan(settings, "101");
    assert.equal(batches.length, 1);
    assert.deepEqual(env.ledger.state(), state);
    await assert.rejects(runScan(settings, "102"), /JSON|property/);
    assert.deepEqual(env.ledger.state(), state);
    assert.equal(JSON.parse(readFileSync(join(settings.reports, "scan-progress.json"), "utf8")).state, "failed");
    for (const bad of ["null", "false", "{}"]) {
      writeFileSync(settings.screeningEvidence, bad);
      await assert.rejects(runScan(settings), /records/);
      assert.deepEqual(env.ledger.state(), state);
    }
  } finally {
    env.close();
  }
});

test("chat shows manual observations and exclusion reasons without treating them as buy candidates", () => {
  const env = setup();
  try {
    env.ledger.execute("watch", { type: "watchlist", scan: scan([]) }, now);
    env.ledger.execute(
      "observe",
      {
        type: "manual-watch",
        action: "add",
        symbol: row.symbol,
        name: row.name,
        reason: "本人观察合成行业",
        by: "owner",
      },
      now,
    );
    const receipt = readReceipt(
      chat(
        { ...env.settings, database: env.ledger.file, reports: env.folder },
        { events: [{ id: 1, detail: "查看自选" }] },
      ),
    );
    assert.match(receipt.notice![0].text, /本人观察合成行业/);
    assert.match(receipt.notice![0].text, /证据缺失/);
    assert.match(receipt.notice![0].text, /仅观察/);
    assert.equal(env.ledger.state().orders.buy, undefined);
  } finally {
    env.close();
  }
});

test("daily cycle batches actionable manual picks within the quote service limit", async (t) => {
  const env = setup();
  const batches = fakeMarket(t);
  try {
    const rows = Array.from({ length: 101 }, (_, i) => ({ ...row, symbol: `sh${600000 + i}` }));
    env.ledger.execute(
      "watch",
      {
        type: "watchlist",
        scan: scan(
          rows.map((r) => facts(r.symbol)),
          rows,
        ),
      },
      now,
    );
    for (const item of rows.slice(20))
      env.ledger.execute(
        `manual-${item.symbol}`,
        { type: "manual-watch", action: "add", symbol: item.symbol, reason: "合成观察", by: "owner" },
        now,
      );
    const receipt = readReceipt(
      await cycle({ ...env.settings, database: env.ledger.file }, { answers: [] }, () => now),
    );
    assert.deepEqual(
      batches.map((b) => b.length),
      [100, 1],
    );
    assert.equal(receipt.ask?.length, 0);
    assert.equal(env.ledger.state().fills.length, 0);
  } finally {
    env.close();
  }
});

test("manual removal also works on an older recorded watchlist without a saved evidence report", () => {
  const env = setup();
  try {
    env.ledger.execute("old-scan", { type: "watchlist", scan: screen([row.symbol], [row], [], now) }, now);
    const db = new DatabaseSync(env.ledger.file);
    try {
      const entry = db.prepare("SELECT changes FROM entries WHERE id='old-scan'").get()!;
      const changes = JSON.parse(String(entry.changes));
      delete changes.watchlistReport;
      delete changes.watchlistHistory;
      db.prepare("UPDATE entries SET changes=? WHERE id='old-scan'").run(JSON.stringify(changes));
    } finally {
      db.close();
    }
    env.reopen();
    assert.equal(env.ledger.state().watchlistReport, undefined);
    env.ledger.execute(
      "remove",
      { type: "manual-watch", action: "remove", symbol: row.symbol, reason: "旧自选退出", by: "owner" },
      now,
    );
    assert.equal(env.ledger.state().watchlist.length, 0);
    assert.match(env.ledger.state().watchlistHistory.at(-1)!.reasons.join("；"), /旧自选退出/);
  } finally {
    env.close();
  }
});
