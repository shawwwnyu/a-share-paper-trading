import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "./ledger.ts";
import { screen } from "./monitor.ts";
import { screenWithEvidence } from "./evidence.ts";
import { saveDailyReview } from "./daily-report.ts";
import { weekly } from "./integrations/agent-autoloop.ts";
import type { Settings } from "./config.ts";
import type { Quote, Signal } from "./types.ts";
import type { Evidence, ScreeningRecord } from "./evidence.ts";

// This corpus is disposable, synthetic and entirely separate from the configured running account.
export function createWorkbenchDemo() {
  const folder = mkdtempSync(join(tmpdir(), "paper-workbench-demo-"));
  const settings = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8")) as Settings;
  settings.database = join(folder, "demo.db");
  settings.reports = join(folder, "reports");
  settings.strategy.id = "demo-v1";
  settings.account.symbols = ["sh600000", "sz000001", "sz300001"];
  settings.account.risk = {
    maxTotalBps: 8000,
    maxSymbolBps: 5000,
    maxPositions: 10,
    maxIndustryBps: 6000,
    industries: { sh600000: "合成金融", sz000001: "合成制造" },
    stopLossBps: 500,
  };
  const at = (day: string, clock: string) => `2026-11-${day}T${clock}+08:00`;
  const quote = (symbol: string, time: string, price: number): Quote => ({
    symbol,
    name: symbol === "sh600000" ? "合成金融甲" : symbol === "sz000001" ? "合成制造乙" : "*ST合成观察",
    at: time,
    price,
    bid: price,
    ask: price,
    bidSize: 10000,
    askSize: 10000,
    volume: 5000000,
    limitUp: 2000,
    limitDown: 500,
    source: "明确标记的合成演示行情",
    adjustment: "none",
  });
  const ledger = new Ledger(settings.database);
  try {
    ledger.execute(
      "demo-init",
      { type: "init", config: settings.account, strategy: settings.strategy },
      at("11", "15:00:00"),
    );
    const signal = (
      id: string,
      symbol: string,
      side: "buy" | "sell",
      quantity: number,
      time: string,
      price: number,
    ): Signal => ({
      id,
      symbol,
      side,
      quantity,
      price,
      at: time,
      expiresAt: time.slice(0, 10) + "T14:56:59+08:00",
      strategy: settings.strategy.id,
      reason: "合成演示建议，用于核对确认、成交与费用展示",
    });
    const entryA = signal("demo-entry-a", "sh600000", "buy", 500, at("12", "10:00:00"), 1000);
    ledger.execute(entryA.id, { type: "signal", signal: entryA }, entryA.at);
    ledger.execute(
      "demo-yes-a",
      { type: "decide", signal: entryA.id, approve: true, by: "demo-owner" },
      at("12", "10:01:00"),
    );
    ledger.execute(
      "demo-fill-a",
      { type: "fill", signal: entryA.id, quote: quote("sh600000", at("12", "10:02:00"), 1000) },
      at("12", "10:02:00"),
    );
    const expired = signal("demo-expired-pending", "sh600000", "buy", 100, at("12", "10:03:00"), 1000);
    ledger.execute(expired.id, { type: "signal", signal: expired }, expired.at);
    ledger.execute(
      "demo-close-12",
      { type: "mark", quotes: [quote("sh600000", at("12", "15:00:00"), 1010)] },
      at("12", "15:00:01"),
    );
    saveDailyReview(settings, "2026-11-12", at("12", "18:00:00"));
    weekly(
      settings,
      { answers: [], events: [{ type: "schedule.tick", receivedAt: at("12", "18:00:00") }] },
      at("12", "18:00:00"),
    );
    const entryB = signal("demo-entry-b", "sz000001", "buy", 500, at("13", "10:00:00"), 1500);
    ledger.execute(entryB.id, { type: "signal", signal: entryB }, entryB.at);
    ledger.execute(
      "demo-yes-b",
      { type: "decide", signal: entryB.id, approve: true, by: "demo-owner" },
      at("13", "10:01:00"),
    );
    const observed = [quote("sh600000", at("13", "10:02:00"), 1030), quote("sz000001", at("13", "10:02:00"), 1500)];
    ledger.execute(
      "demo-fill-b",
      { type: "fill", signal: entryB.id, quote: observed[1], quotes: observed },
      at("13", "10:02:00"),
    );
    const proof = <T>(value: T): Evidence<T> => ({
      value,
      source: "合成已核对资料，不代表真实市场",
      publishedAt: at("13", "09:00:00"),
      checkedAt: at("13", "10:05:00"),
      validUntil: at("13", "23:59:59"),
    });
    const rows = settings.account.symbols.map((symbol) => ({
      ...quote(symbol, at("13", "10:05:00"), symbol === "sz000001" ? 1560 : 1050),
      previousClose: symbol === "sz000001" ? 1500 : 1020,
      amount: 350000000,
      turnover: 3.2,
      pe: 19,
    }));
    const evidence = {
      records: settings.account.symbols.map((symbol): ScreeningRecord => ({
        symbol,
        industry: proof({ classification: "合成分类", name: settings.account.risk!.industries![symbol] ?? "合成其他" }),
        financial: proof({ periodEnd: "2026-09-30", netProfit: 1200000, operatingCashFlow: 1500000 }),
        listing: proof({ listedOn: "2000-01-01" }),
        trading: proof({ status: "trading" }),
        announcements: proof({ from: "2026-10-01", through: "2026-11-13", items: [] }),
        corporateActions: proof({ from: "2025-01-01", through: "2026-11-13", events: [] }),
      })),
    };
    const scan = screenWithEvidence(
      screen(settings.account.symbols, rows, [], at("13", "10:05:00")),
      rows,
      evidence,
      at("13", "10:05:00"),
    );
    ledger.execute("demo-watchlist", { type: "watchlist", scan }, scan.at);
    for (const item of [
      signal("demo-pending-add", "sh600000", "buy", 100, at("13", "10:06:00"), 1050),
      signal("demo-pending-exit", "sz000001", "sell", 200, at("13", "10:07:00"), 1560),
      signal("demo-approved-add", "sh600000", "buy", 100, at("13", "10:08:00"), 1050),
    ])
      ledger.execute(item.id, { type: "signal", signal: item }, item.at);
    ledger.execute(
      "demo-approve-add",
      { type: "decide", signal: "demo-approved-add", approve: true, by: "demo-owner" },
      at("13", "10:09:00"),
    );
    try {
      ledger.execute(
        "demo-blocked-fill",
        {
          type: "fill",
          signal: "demo-approved-add",
          quote: { ...quote("sh600000", at("13", "10:10:00"), 1050), askSize: 0 },
        },
        at("13", "10:10:00"),
      );
    } catch (error) {
      ledger.execute(
        "demo-check",
        {
          type: "record-check",
          check: { kind: "fill-blocked", signal: "demo-approved-add", reason: (error as Error).message },
        },
        at("13", "10:10:00"),
      );
    }
    ledger.execute(
      "demo-manual",
      {
        type: "manual-watch",
        action: "add",
        symbol: "sz300001",
        name: "*ST合成观察",
        reason: "仅观察风险警示状态，不具备新增买入资格",
        by: "demo-owner",
      },
      at("13", "10:11:00"),
    );
    ledger.execute(
      "demo-exclude",
      {
        type: "manual-watch",
        action: "remove",
        symbol: "sh600002",
        name: "合成排除示例",
        reason: "演示本人持续排除的跟踪理由",
        by: "demo-owner",
      },
      at("13", "10:12:00"),
    );
    const closing = [quote("sh600000", at("13", "14:29:00"), 1100), quote("sz000001", at("13", "14:29:00"), 1340)];
    ledger.execute("demo-latest-valuation", { type: "mark", quotes: closing }, at("13", "14:29:01"));
    ledger.execute("demo-risk", { type: "risk-snapshot", quotes: closing }, at("13", "14:29:01"));
    saveDailyReview(settings, "2026-11-13", at("13", "14:30:00"));
    return { settings, now: at("13", "14:30:00"), dispose: () => rmSync(folder, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  } finally {
    ledger.close();
  }
}
