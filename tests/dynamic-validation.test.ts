// Dynamic comparisons must use past membership and evidence, with identical execution and intact former holdings.
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { sealSnapshot, verifySnapshot } from "../src/scan-snapshot.ts";
import { validateDynamic, type DynamicDataset, type DynamicPlan } from "../src/dynamic-validation.ts";
import { screen } from "../src/monitor.ts";
import { screenWithEvidence, type Evidence, type EvidenceDataset, type ScreeningRecord } from "../src/evidence.ts";
import type { MarketRow } from "../src/monitor.ts";
import type { Quote } from "../src/types.ts";

const symbols = ["sh600000", "sz000001"];
const at = (day: string, clock: string) => `${day}T${clock}+08:00`;
const asOf = "2026-11-13T18:00:00+08:00";
const plan: DynamicPlan = {
  trainingEnd: "2026-06-03",
  strategy: { id: "fixture-v1", lookback: 3, entryBps: 100, exitBps: 100, allocationBps: 2000 },
  account: {
    cash: 10000000,
    commissionBps: 3,
    minimumCommission: 500,
    sellTaxBps: 5,
    transferBps: 0.1,
    slippageBps: 10,
    maxQuoteAgeSeconds: 60,
    symbols,
  },
};
function proof<T>(value: T, day: string, clock: string): Evidence<T> {
  return {
    value,
    source: "合成核实资料",
    publishedAt: at(day, "09:00:00"),
    checkedAt: at(day, clock),
    validUntil: at(day, "23:59:59"),
  };
}
function evidence(day: string, clock: string): EvidenceDataset {
  return {
    records: symbols.map((symbol): ScreeningRecord => ({
      symbol,
      industry: proof({ classification: "合成分类", name: "合成行业" }, day, clock),
      financial: proof(
        { periodEnd: "2026-03-31", netProfit: 100, operatingCashFlow: symbol === symbols[0] ? 120 : -100 },
        day,
        clock,
      ),
      listing: proof({ listedOn: "2000-01-01" }, day, clock),
      trading: proof({ status: "trading" }, day, clock),
      announcements: proof({ from: "2026-01-01", through: day, items: [] }, day, clock),
      corporateActions: proof({ from: "2025-01-01", through: day, events: [] }, day, clock),
    })),
  };
}
function quote(symbol: string, time: string, price: number): Quote {
  return {
    symbol,
    name: "fixture",
    at: time,
    price,
    bid: price,
    ask: price,
    bidSize: 1000000,
    askSize: 1000000,
    volume: 1000000,
    limitDown: 100,
    limitUp: 3000,
    source: "合成盘口",
    adjustment: "none",
  };
}
function fixture(count = 73): DynamicDataset {
  const days: string[] = [];
  for (let date = Date.parse("2026-06-01T00:00:00Z"); days.length < count; date += 86400000) {
    const day = new Date(date);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) days.push(day.toISOString().slice(0, 10));
  }
  return {
    source: "完全合成的动态验证数据，不代表真实市场",
    adjustment: "none",
    marketRulesVerified: true,
    corporateActionsVerified: true,
    universeHistoryVerified: true,
    calendar: { source: "合成交易日历", verified: true, days },
    sessions: days.map((day, i) => {
      const price = [1000, 1000, 1100, 1200, 1000, 950][i % 6];
      const rows: MarketRow[] = symbols.map((symbol) => ({
        ...quote(symbol, at(day, "15:00:00"), price),
        previousClose: Math.round(price / 1.03),
        amount: 300000000,
        turnover: 3,
        pe: 20,
      }));
      const data = evidence(day, "15:00:00");
      const report = screenWithEvidence(
        screen(symbols, rows, [], at(day, "15:00:00")),
        rows,
        data,
        at(day, "15:00:00"),
      );
      return {
        day,
        snapshot: sealSnapshot(
          { universe: { source: "合成历史目录", sourceTotal: 2, symbols }, rows, evidence: data, report },
          at(day, "15:00:01"),
        ),
        decisionAt: at(day, "09:30:00"),
        executionAt: at(day, "09:30:02"),
        decisionQuotes: symbols.map((s) => quote(s, at(day, "09:30:00"), price)),
        executionQuotes: symbols.map((s) => quote(s, at(day, "09:30:02"), price)),
        openingEvidence: evidence(day, "09:30:00"),
        bars: symbols.map((symbol) => ({
          symbol,
          day,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 10000000,
          suspended: false,
          limitDown: 100,
          limitUp: 3000,
        })),
      };
    }),
  };
}
function reseal(data: DynamicDataset, index: number) {
  const session = data.sessions[index];
  const old = session.snapshot;
  const report = screenWithEvidence(
    screen(old.universe.symbols, old.rows, [], old.report.at),
    old.rows,
    old.evidence!,
    old.report.at,
  );
  session.snapshot = sealSnapshot(
    { universe: old.universe, rows: old.rows, evidence: old.evidence, report },
    old.availableAt,
  );
}

test("snapshot seals preserve the historical directory and reject edits, future evidence and incomplete coverage", () => {
  const snapshot = fixture(1).sessions[0].snapshot;
  assert.doesNotThrow(() => verifySnapshot(snapshot));
  const changed = structuredClone(snapshot);
  changed.universe.symbols.pop();
  assert.throws(() => verifySnapshot(changed), /校验|完整/);
  const partial = structuredClone(snapshot);
  partial.report.complete = false;
  assert.throws(() => sealSnapshot(partial, partial.availableAt), /不完整/);
  const future = structuredClone(snapshot);
  future.evidence!.records[0].financial!.publishedAt = "2026-11-13T10:00:00+08:00";
  assert.throws(() => sealSnapshot(future, future.availableAt), /未来|时间/);
});

test("dynamic comparison retains both historical members, uses the same strategy and charges real execution costs", () => {
  const data = fixture();
  const before = JSON.stringify(data);
  const report = validateDynamic(plan, data, asOf);
  assert.equal(report.valid, true, report.reasons.join("；"));
  assert.equal(report.canActivate, false);
  assert.equal(report.from, data.sessions[3].day);
  assert.equal(report.baseline!.decisions[0].snapshotHash, data.sessions[2].snapshot.hash);
  assert.ok(report.baseline!.fills.length > report.candidate!.fills.length);
  assert.ok(report.candidate!.fills.every((f) => f.symbol === symbols[0]));
  assert.ok(report.baseline!.fills.some((f) => f.symbol === symbols[1]));
  assert.ok(report.candidate!.fees > 0);
  assert.ok(report.candidate!.fills.every((f) => Date.parse(f.at) > Date.parse(f.confirmedAt)));
  const free = structuredClone(plan);
  Object.assign(free.account, {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    transferBps: 0,
    slippageBps: 0,
  });
  assert.ok(validateDynamic(free, data, asOf).candidate!.pnl > report.candidate!.pnl);
  assert.equal(JSON.stringify(data), before);
});

test("current close membership cannot authorize today's opening trade and missing former members fail closed", () => {
  const data = fixture();
  data.sessions[2].snapshot.rows[0].name = "*STfixture";
  reseal(data, 2);
  const report = validateDynamic(plan, data, asOf);
  assert.equal(report.valid, true, report.reasons.join("；"));
  assert.ok(report.candidate!.fills.length > 0);
  assert.ok(!report.candidate!.fills.some((f) => f.symbol === symbols[0] && f.at.startsWith(data.sessions[3].day)));
  const missing = fixture();
  missing.sessions[10].bars = missing.sessions[10].bars.slice(1);
  const invalid = validateDynamic(plan, missing, asOf);
  assert.equal(invalid.valid, false);
  assert.match(invalid.reasons.join("；"), /历史成员|缺少.*日线/);
});

test("future suffix changes do not alter earlier trades and future opening evidence cannot authorize a buy", () => {
  const data = fixture();
  const original = validateDynamic(plan, data, asOf);
  const changed = structuredClone(data);
  changed.sessions[25].snapshot.rows[0].name = "*STfixture";
  reseal(changed, 25);
  const rerun = validateDynamic(plan, changed, asOf);
  const cutoff = at(data.sessions[25].day, "09:30:03");
  assert.deepEqual(
    rerun.candidate!.fills.filter((f) => f.at <= cutoff),
    original.candidate!.fills.filter((f) => f.at <= cutoff),
  );
  const future = fixture();
  future.sessions[3].openingEvidence.records[0].industry!.publishedAt = at(future.sessions[3].day, "10:00:00");
  const blocked = validateDynamic(plan, future, asOf);
  assert.equal(blocked.valid, true, blocked.reasons.join("；"));
  assert.ok(!blocked.candidate!.fills.some((f) => f.side === "buy" && f.at.startsWith(future.sessions[3].day)));
  assert.match(blocked.candidate!.skipped.map((s) => s.reason).join("；"), /未来|时间/);
});

test("unverified calendars, short holdouts, missing warmup and current-day data never pass", () => {
  const cases: [DynamicDataset, DynamicPlan, RegExp][] = [];
  const unverified = fixture();
  unverified.universeHistoryVerified = false;
  cases.push([unverified, plan, /历史.*目录|历史.*股票池/]);
  const gap = fixture();
  gap.sessions.splice(5, 1);
  cases.push([gap, plan, /交易日历/]);
  const badDay = fixture();
  badDay.calendar.days[0] = "2026-02-30";
  cases.push([badDay, plan, /日期|交易日历/]);
  cases.push([fixture(20), plan, /60/]);
  cases.push([fixture(), { ...plan, trainingEnd: "2026-06-01" }, /预热/]);
  for (const [data, config, reason] of cases) {
    const report = validateDynamic(config, data, asOf);
    assert.equal(report.passed, false);
    assert.match(report.reasons.join("；"), reason);
  }
  assert.equal(validateDynamic(plan, fixture(), "2026-06-03T10:00:00+08:00").valid, false);
});

test("missing later quotes, exhausted depth, price limits and portfolio caps retain explicit unfilled reasons", () => {
  const data = fixture();
  const session = data.sessions[3];
  session.executionQuotes[0].askSize = 0;
  const report = validateDynamic(plan, data, asOf);
  assert.match(report.candidate!.skipped.map((s) => s.reason).join("；"), /盘口/);
  const limit = fixture();
  limit.sessions[3].executionQuotes[0].ask = 3000;
  assert.match(
    validateDynamic(plan, limit, asOf)
      .candidate!.skipped.map((s) => s.reason)
      .join("；"),
    /涨跌停/,
  );
  const capped = structuredClone(plan);
  capped.account.risk = { maxPositions: 1 };
  const capReport = validateDynamic(capped, fixture(), asOf);
  assert.match(capReport.baseline!.skipped.map((s) => s.reason).join("；"), /持仓.*上限/);
  const missing = fixture();
  missing.sessions[3].executionQuotes.pop();
  assert.equal(validateDynamic(plan, missing, asOf).valid, false);
});

test("read-only dynamic validation CLI neither opens an account nor changes its input files", () => {
  const folder = mkdtempSync(join(tmpdir(), "paper-dynamic-cli-"));
  try {
    const planFile = join(folder, "plan.json"),
      dataFile = join(folder, "data.json");
    const config = { ...plan, database: join(folder, "must-not-create.db") };
    writeFileSync(planFile, JSON.stringify(config));
    writeFileSync(dataFile, JSON.stringify(fixture()));
    const before = readFileSync(dataFile, "utf8");
    const run = spawnSync(process.execPath, [resolve("src/cli.ts"), "validate-dynamic", planFile, dataFile], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.canActivate, false);
    assert.equal(report.valid, true);
    assert.equal(existsSync(config.database), false);
    assert.equal(readFileSync(dataFile, "utf8"), before);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("removed directory members remain valued and monitored for exits, and suspended shares never fill", () => {
  const data = fixture();
  const changed = data.sessions[4];
  const extra = "sh600002";
  const old = changed.snapshot;
  const kept = old.rows.filter((q) => q.symbol !== symbols[0]);
  const rows = [...kept, { ...old.rows[0], symbol: extra }];
  const universe = { source: "合成成员更替目录", sourceTotal: 2, symbols: [extra, symbols[1]] };
  const proofData = structuredClone(old.evidence!);
  proofData.records = proofData.records.filter((r) => r.symbol !== symbols[0]);
  const extraFacts = structuredClone(old.evidence!.records[0]);
  extraFacts.symbol = extra;
  proofData.records.push(extraFacts);
  const report = screenWithEvidence(screen(universe.symbols, rows, [], old.report.at), rows, proofData, old.report.at);
  changed.snapshot = sealSnapshot({ universe, rows, evidence: proofData, report }, old.availableAt);
  for (const s of data.sessions.slice(4)) {
    s.bars.push({ ...s.bars[0], symbol: extra });
    s.decisionQuotes.push({ ...s.decisionQuotes[0], symbol: extra });
    s.executionQuotes.push({ ...s.executionQuotes[0], symbol: extra });
  }
  const validation = validateDynamic(plan, data, asOf);
  assert.equal(validation.valid, true, validation.reasons.join("；"));
  assert.ok(
    validation.candidate!.fills.some((f) => f.symbol === symbols[0] && f.side === "sell" && f.at > changed.decisionAt),
  );
  const suspended = fixture();
  suspended.sessions[3].bars[0].suspended = true;
  suspended.sessions[3].decisionQuotes[0].volume = suspended.sessions[3].executionQuotes[0].volume = 0;
  const result = validateDynamic(plan, suspended, asOf);
  assert.ok(!result.candidate!.fills.some((f) => f.at.startsWith(suspended.sessions[3].day)));
  assert.match(result.candidate!.skipped.map((s) => s.reason).join("；"), /停牌|当日成交/);
});

test("corporate actions adjust quantities and histories only on their effective day", () => {
  const data = fixture();
  const session = data.sessions[4];
  session.bars[0].action = { shareRatio: 2, cashPerShare: 10 };
  // Subsequent prices express the split in the original, unadjusted price series.
  for (const [i, s] of data.sessions.entries())
    if (i >= 4) {
      const bar = s.bars[0];
      for (const field of ["open", "close", "high", "low"] as const) bar[field] = Math.round(bar[field] / 2);
      for (const q of [s.decisionQuotes[0], s.executionQuotes[0], s.snapshot.rows[0]]) {
        q.price = q.bid = q.ask = bar.close;
      }
      s.snapshot.rows[0].previousClose = Math.round(bar.close / 1.03);
      const action = { day: session.day, shareRatio: 2, cashPerShare: 10, reference: "合成送股与分红" };
      s.openingEvidence.records[0].corporateActions!.value.events = [action];
      s.snapshot.evidence!.records[0].corporateActions!.value.events = [action];
      reseal(data, i);
    }
  const result = validateDynamic(plan, data, asOf);
  assert.equal(result.valid, true, result.reasons.join("；"));
  const buys = result.candidate!.fills.filter((f) => f.side === "buy");
  const firstSale = result.candidate!.fills.find((f) => f.side === "sell")!;
  assert.equal(firstSale.quantity, buys[0].quantity * 2);
  assert.ok(
    result
      .candidate!.fills.filter((f) => f.side === "sell")
      .every(
        (sale) =>
          sale.at.slice(0, 10) >
          buys
            .filter((buy) => buy.at < sale.at)
            .at(-1)!
            .at.slice(0, 10),
      ),
  );
});

test("fills at a price band are skipped even with zero slippage, and short-lived confirmations expire", () => {
  const noSlip = structuredClone(plan);
  noSlip.account.slippageBps = 0;
  const limit = fixture();
  limit.sessions[3].executionQuotes[0].ask = 3000;
  assert.match(
    validateDynamic(noSlip, limit, asOf)
      .candidate!.skipped.map((item) => item.reason)
      .join("；"),
    /涨跌停/,
  );
  const expiring = structuredClone(plan);
  expiring.account.risk = { maxOrderAgeMinutes: 1 };
  const late = fixture();
  late.sessions[3].executionAt = at(late.sessions[3].day, "09:31:00");
  late.sessions[3].executionQuotes.forEach((q) => {
    q.at = late.sessions[3].executionAt;
  });
  const report = validateDynamic(expiring, late, asOf);
  assert.match(report.candidate!.skipped.map((item) => item.reason).join("；"), /过期/);
});
