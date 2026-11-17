// Partial market coverage must not replace the watchlist; stale/ST/new shares must not be called screened candidates.
// Updating the watchlist must not erase holdings, approve trades or let removed buy signals execute.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadUniverse, screen, parseMarketRows, type MarketRow } from "../src/monitor.ts";
import { Ledger } from "../src/ledger.ts";

const now = "2026-11-13T10:00:00+08:00";

test("a real new-listing negative price band is excluded without weakening trade quote checks", () => {
  const fields = Array(50).fill("0");
  fields[1] = "C钶锐";
  fields[2] = "688827";
  fields[3] = "95.98";
  fields[30] = "20261113150639";
  fields[47] = "-1";
  fields[48] = "-1";
  const parsed = parseMarketRows(`v_sh688827="${fields.join("~")}";`, ["sh688827"]);
  assert.equal(parsed.failures.length, 0);
  assert.equal(parsed.excluded[0].symbol, "sh688827");
  const report = screen(["sh688827"], parsed.rows, parsed.failures, "2026-11-13T15:07:00+08:00", parsed.excluded);
  assert.equal(report.complete, true);
  assert.deepEqual(report.selected, []);
});
const row: MarketRow = {
  symbol: "sh600000",
  name: "测试股票",
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

test("universe reads every page, excludes other markets and rejects missing or repeated pages", async () => {
  const rows = [
    { symbol: "bj920001", name: "北交所" },
    { symbol: "sh600000", name: "沪市" },
    { symbol: "sz000001", name: "深市" },
  ];
  const fetchPage = async (url: string) =>
    url.includes("StockCount")
      ? "3"
      : rows.slice(
          (Number(new URL(url).searchParams.get("page")) - 1) * 2,
          Number(new URL(url).searchParams.get("page")) * 2,
        );
  const result = await loadUniverse(fetchPage, async () => {}, 2);
  assert.deepEqual(result.symbols, ["sh600000", "sz000001"]);
  assert.equal(result.sourceTotal, 3);
  await assert.rejects(
    loadUniverse(
      async (url) => (url.includes("StockCount") ? "3" : rows.slice(0, 2)),
      async () => {},
      2,
    ),
    /重复|不完整/,
  );
});

test("screening records explainable evidence and refuses incomplete or stale market coverage", () => {
  const samples = [
    row,
    { ...row, symbol: "sz000001", name: "*ST测试" },
    { ...row, symbol: "sh600001", at: "2026-11-12T15:00:00+08:00" },
    { ...row, symbol: "sz300001", name: "N新股" },
  ];
  const result = screen(
    samples.map((r) => r.symbol),
    samples,
    [],
    now,
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.selected.map((r) => r.symbol),
    ["sh600000"],
  );
  assert.ok(result.selected[0].reasons.length > 0);
  assert.equal(result.excluded.length, 3);
  const partial = screen([row.symbol, "sz000001"], [row], [{ symbol: "sz000001", reason: "请求失败" }], now);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.selected, []);
});

test("watchlist updates persist without rewriting the account or manufacturing a trade", () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-watchlist-"));
  const file = join(dir, "paper.db");
  const settings = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8"));
  let ledger = new Ledger(file);
  try {
    ledger.execute("init", { type: "init", config: settings.account, strategy: settings.strategy }, now);
    ledger.execute(
      "signal",
      {
        type: "signal",
        signal: {
          id: "pending",
          symbol: "sh600000",
          side: "buy",
          quantity: 100,
          price: 1000,
          at: now,
          expiresAt: "2026-11-13T14:56:59+08:00",
          strategy: settings.strategy.id,
          reason: "fixture",
        },
      },
      now,
    );
    const report = screen(["sz000001"], [{ ...row, symbol: "sz000001" }], [], now);
    ledger.execute("watch", { type: "watchlist", scan: report }, now);
    const state = ledger.state();
    assert.deepEqual(state.config, settings.account);
    assert.equal(state.orders.pending.status, "expired");
    assert.equal(state.cash, settings.account.cash);
    assert.equal(state.fills.length, 0);
    assert.deepEqual(
      state.watchlist.map((r) => r.symbol),
      ["sz000001"],
    );
    ledger.close();
    ledger = new Ledger(file);
    assert.deepEqual(ledger.state().watchlist, state.watchlist);
    assert.throws(
      () => ledger.execute("partial", { type: "watchlist", scan: { ...report, complete: false } }, now),
      /不完整/,
    );
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
