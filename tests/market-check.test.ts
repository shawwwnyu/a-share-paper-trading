// Failure mode: diagnostics imply executable trades, hide partial failures, or mutate the account.
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkMarket, quoteAvailability } from "../src/market-check.ts";
import type { Quote } from "../src/types.ts";
import { fixtureFetch } from "./helpers/market-fetch.ts";

const now = "2026-11-13T10:00:01+08:00";
const quote: Quote = {
  symbol: "sh600000",
  name: "样例",
  at: "2026-11-13T10:00:00+08:00",
  price: 1000,
  bid: 1000,
  ask: 1000,
  bidSize: 1000,
  askSize: 1000,
  volume: 10000,
  limitUp: 1100,
  limitDown: 900,
  source: "fixture",
  adjustment: "none",
};

test("availability does not confuse successful reading with permission to fill", () => {
  assert.equal(quoteAvailability(quote, now, 60, true).buy.available, true);
  for (const [q, at, calendar, reason] of [
    [quote, "2026-11-13T10:02:00+08:00", true, /过期/],
    [{ ...quote, at: "2026-11-13T10:01:00+08:00" }, now, true, /未来/],
    [{ ...quote, volume: 0 }, now, true, /无当日成交/],
    [quote, now, false, /休市/],
    [quote, now, null, /未核实/],
    [quote, "2026-11-13T12:00:00+08:00", true, /连续竞价/],
    [{ ...quote, limitUp: 0 }, now, true, /涨跌停/],
    [{ ...quote, at: "2026-11-12T10:00:00+08:00" }, now, true, /当日数据/],
  ] as const) {
    const result = quoteAvailability(q, at, 60, calendar);
    assert.equal(result.buy.available, false);
    assert.equal(result.sell.available, false);
    assert.match(result.buy.reasons.join("；"), reason);
  }
  const oneSide = quoteAvailability({ ...quote, askSize: 0 }, now, 60, true);
  assert.equal(oneSide.buy.available, false);
  assert.equal(oneSide.sell.available, true);
  assert.equal(quoteAvailability({ ...quote, ask: 1100 }, now, 60, true, 10).buy.available, false);
});

test("diagnostics retain per-stock successes after quote, history and calendar failures", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string) => {
    if (input.includes("szse.cn")) throw new Error("日历暂不可用");
    if (input.includes("q=sh600000")) throw new Error("快照暂不可用");
    if (input.includes("fqkline") && input.includes("sz000001")) throw new Error("日线暂不可用");
    return fixtureFetch(input);
  });
  const report = await checkMarket(["sh600000", "sz000001", "bj920001"], 60);
  assert.equal(report.readSucceeded, false);
  assert.equal(report.calendar.status, "读取失败");
  assert.equal(report.items[0].quote.status, "读取失败");
  assert.equal(report.items[0].history.status, "读取成功");
  assert.equal(report.items[1].quote.status, "读取成功");
  assert.equal(report.items[1].history.status, "读取失败");
  assert.equal(report.items[2].history.status, "不支持");
  assert.ok(report.items.every((i) => !i.availability.buy.available));
});

test("receipt time and freshness are measured after requests finish", async (t) => {
  const start = Date.now();
  let elapsed = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    if (input.includes("fqkline")) elapsed += 120000;
    return fixtureFetch(input);
  });
  const report = await checkMarket(["sh600000"], 60, 3, () => new Date(start + elapsed).toISOString());
  assert.equal(report.items[0].history.receivedAt, report.assessedAt);
  assert.equal(report.readSucceeded, true);
  assert.equal(report.items[0].availability.buy.available, false);
  assert.match(report.items[0].availability.buy.reasons.join("；"), /过期/);
});

test("CLI reads market data without creating or modifying a database", () => {
  const scratch = mkdtempSync(join(tmpdir(), "paper-market-check-"));
  try {
    const config = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8"));
    config.database = "account.db";
    const settingsPath = join(scratch, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(config));
    const run = (symbols: string) =>
      spawnSync(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          "--import",
          "./tests/helpers/market-preload.ts",
          "src/cli.ts",
          "market-check",
          settingsPath,
          symbols,
          "3",
        ],
        { encoding: "utf8", timeout: 20000, windowsHide: true },
      );
    const first = run("sh600000,sz000001,sh688981,sh689009");
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.items.length, 4);
    assert.equal(report.readSucceeded, true);
    assert.equal(existsSync(join(scratch, "account.db")), false);
    assert.equal(existsSync(join(scratch, "private")), false);
    writeFileSync(join(scratch, "account.db"), "untouched sentinel");
    const unsupported = run("bj920001,sh600000");
    assert.equal(unsupported.status, 1);
    assert.equal(JSON.parse(unsupported.stdout).items[0].history.status, "不支持");
    assert.equal(readFileSync(join(scratch, "account.db"), "utf8"), "untouched sentinel");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
