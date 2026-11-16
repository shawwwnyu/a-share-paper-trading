// The workbench must project recorded facts, keep expired decisions distinct and expose no mutation or private files.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { get } from "node:http";
import { test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { createWorkbenchDemo } from "../src/workbench-demo.ts";
import { workbenchSnapshot, startWorkbench } from "../src/workbench.ts";
import { screen, type MarketRow } from "../src/monitor.ts";
import { saveDailyReview } from "../src/daily-report.ts";
import type { Quote } from "../src/types.ts";

const at = (clock: string) => `2026-11-13T${clock}+08:00`;
const now = at("18:00:00");
const row: MarketRow = {
  symbol: "sh600000",
  name: "合成候选",
  at: at("10:00:00"),
  price: 1000,
  bid: 999,
  ask: 1000,
  bidSize: 10000,
  askSize: 10000,
  volume: 1000000,
  limitDown: 500,
  limitUp: 2000,
  adjustment: "none",
  source: "合成报价",
  previousClose: 970,
  amount: 300000000,
  turnover: 3,
  pe: 20,
};
function setup() {
  const folder = mkdtempSync(join(tmpdir(), "paper-workbench-"));
  const settings = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8"));
  settings.database = join(folder, "account.db");
  settings.reports = join(folder, "reports");
  settings.secret = "fixture-credential-never-return";
  const ledger = new Ledger(settings.database);
  ledger.execute(
    "init",
    { type: "init", config: settings.account, strategy: settings.strategy },
    "2026-11-12T15:00:00+08:00",
  );
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
function order(env: ReturnType<typeof setup>, id: string) {
  env.ledger.execute(
    id,
    {
      type: "signal",
      signal: {
        id,
        symbol: row.symbol,
        side: "buy",
        quantity: 100,
        price: 1000,
        at: at("10:00:00"),
        expiresAt: at("14:56:59"),
        strategy: env.settings.strategy.id,
        reason: "合成建议<script>bad()</script>",
      },
    },
    at("10:00:00"),
  );
}

test("the dashboard uses recorded valuation and preserves pending decisions without writing the ledger", () => {
  const env = setup();
  try {
    env.ledger.execute("watch", { type: "watchlist", scan: screen([row.symbol], [row], [], row.at) }, row.at);
    order(env, "waiting");
    const before = env.ledger.state();
    // A changed settings file cannot overwrite frozen cash, fees or strategy.
    env.settings.account.cash = 1;
    const data = workbenchSnapshot(env.settings, at("10:01:00"));
    assert.equal(data.account.initialized, true);
    assert.equal(data.account.cash, before.cash);
    assert.equal(data.account.valuation!.equity, before.points.at(-1)!.equity);
    assert.equal(data.orders[0].status, "pending");
    assert.equal(data.summary.pending, 1);
    assert.equal(data.market.latest!.universeSize, 1);
    assert.match(data.candidates[0].evidenceStatus, /未接入|缺失/);
    assert.equal(data.permissions.canTrade, false);
    assert.deepEqual(env.ledger.state(), before);
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes(env.settings.database));
    assert.ok(!serialized.includes(env.settings.reports));
    assert.ok(!serialized.includes(env.settings.secret));
  } finally {
    env.close();
  }
});

test("expired approvals remain decisions and stale prices never become a live equity estimate", () => {
  const env = setup();
  try {
    order(env, "buy");
    env.ledger.execute(
      "yes",
      { type: "decide", signal: "buy", approve: true, by: "private-owner-identity" },
      at("10:01:00"),
    );
    env.ledger.execute("fill", { type: "fill", signal: "buy", quote: { ...row, at: at("10:02:00") } }, at("10:02:00"));
    env.ledger.execute(
      "next",
      { type: "signal", signal: { ...env.ledger.state().orders.buy, id: "next", at: at("10:03:00") } },
      at("10:03:00"),
    );
    env.ledger.execute(
      "approve-next",
      { type: "decide", signal: "next", approve: true, by: "private-owner-identity" },
      at("10:04:00"),
    );
    const before = env.ledger.state();
    const data = workbenchSnapshot(env.settings, now);
    assert.equal(data.summary.pending, 0);
    assert.equal(data.orders.find((o: any) => o.id === "next")!.effectiveStatus, "expired-unrecorded");
    assert.equal(data.holdings[0].value, null);
    assert.equal(data.risk.complete, false);
    assert.equal(data.holdings[0].sellable, 0);
    assert.equal(data.fills.length, 1);
    assert.ok(!JSON.stringify(data).includes("private-owner-identity"));
    assert.deepEqual(env.ledger.state(), before);
  } finally {
    env.close();
  }
});

test("an absent account stays absent and optional broken reports do not fabricate balances", () => {
  const folder = mkdtempSync(join(tmpdir(), "paper-empty-workbench-"));
  try {
    const settings = { database: join(folder, "absent.db"), reports: join(folder, "reports") } as any;
    mkdirSync(settings.reports);
    writeFileSync(join(settings.reports, "scan-progress.json"), "broken");
    const data = workbenchSnapshot(settings, now);
    assert.equal(data.account.initialized, false);
    assert.equal(data.account.cash, null);
    assert.equal(data.account.valuation, null);
    assert.deepEqual(data.holdings, []);
    assert.equal(data.risk.complete, false);
    assert.equal(data.risk.cash, null);
    assert.equal(existsSync(settings.database), false);
    assert.ok(data.warnings.length > 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("read-only ledger connections reject writes and do not create new databases", () => {
  const env = setup();
  try {
    const reader = new Ledger(env.settings.database, { readOnly: true });
    try {
      assert.throws(() => reader.execute("no-write", { type: "mark", quotes: [] }, now), /只读/);
    } finally {
      reader.close();
    }
    assert.equal(env.ledger.recorded("no-write"), false);
    const absent = join(env.folder, "absent.db");
    assert.throws(() => new Ledger(absent, { readOnly: true }));
    assert.equal(existsSync(absent), false);
  } finally {
    env.close();
  }
});

test("the localhost server serves its business API, denies writes, traversal and foreign origins", async () => {
  const env = setup();
  const server = await startWorkbench(env.settings, { port: 0, clock: () => now });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
    const base = `http://127.0.0.1:${address.port}`;
    const before = env.ledger.state();
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /交易员工作台/);
    assert.match(home.headers.get("content-security-policy")!, /script-src 'self'/);
    for (const asset of ["/app.js", "/model.js", "/data.js", "/style.css"])
      assert.equal((await fetch(base + asset)).status, 200);
    const head = await fetch(base + "/api/workbench", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const api = await fetch(base + "/api/workbench");
    assert.equal(api.status, 200);
    assert.equal((await api.json()).permissions.canTrade, false);
    assert.equal(api.headers.get("cache-control"), "no-store");
    for (const path of ["/api/fill", "/api/approve", "/api/workbench"])
      assert.equal((await fetch(base + path, { method: "POST", body: "{}" })).status, 405);
    for (const path of [
      "/account.json",
      "/src/ledger.ts",
      "/.git/config",
      "/api/reports/daily/../../account",
      "/api/reports/daily/2026-02-30",
    ])
      assert.ok((await fetch(base + path)).status >= 400);
    assert.equal(
      (await fetch(base + "/api/workbench", { headers: { Origin: "https://external.invalid" } })).status,
      403,
    );
    const foreignHost = await new Promise<number>((resolve, reject) => {
      get(base + "/api/workbench", { headers: { Host: "external.invalid" } }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      }).on("error", reject);
    });
    assert.equal(foreignHost, 403);
    assert.equal((await fetch(base + "/api/workbench", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.deepEqual(env.ledger.state(), before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    env.close();
  }
});

test("report routes return allowlisted business fields and reject symlinked private files", async () => {
  const env = setup();
  env.ledger.execute("close", { type: "mark", quotes: [] }, at("15:00:01"));
  saveDailyReview(env.settings, "2026-11-13", now);
  const server = await startWorkbench(env.settings, { port: 0, clock: () => now });
  try {
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const file = join(env.settings.reports, "daily", "2026-11-13.json");
    const report = JSON.parse(readFileSync(file, "utf8"));
    report.privateToken = env.settings.secret;
    report.performance.internalPath = env.settings.database;
    writeFileSync(file, JSON.stringify(report));
    const response = await fetch(base + "/api/reports/daily/2026-11-13");
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(env.settings.secret));
    assert.ok(!text.includes(env.settings.database));
    assert.match(text, /recommendation|workflow/);
    report.workflow.unfilled = {};
    writeFileSync(file, JSON.stringify(report));
    const partial = await (await fetch(base + "/api/reports/daily/2026-11-13")).json();
    assert.equal(partial.workflow.unfilled.pending, null);
    const link = join(env.settings.reports, "daily", "2026-11-12.json");
    try {
      symlinkSync(file, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      // Unprivileged Windows disallows file symlinks; a junction exercises the same reparse-point rejection.
      symlinkSync(env.folder, link, "junction");
    }
    assert.equal((await fetch(base + "/api/reports/daily/2026-11-12")).status, 404);
    const snapshot = await (await fetch(base + "/api/workbench")).json();
    assert.equal(snapshot.reports.daily.length, 1);
    writeFileSync(file, "not-json");
    const broken = await fetch(base + "/api/reports/daily/2026-11-13");
    assert.equal(broken.status, 422);
    assert.ok(!(await broken.text()).includes(env.folder));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    env.close();
  }
});

test("the disposable demo includes evidence, T+1, outstanding decisions and a recorded unfilled reason", () => {
  const demo = createWorkbenchDemo();
  try {
    const data = workbenchSnapshot(demo.settings, demo.now, true);
    assert.equal(data.demo, true);
    assert.equal(data.summary.pending, 2);
    assert.equal(data.summary.approved, 1);
    assert.equal(data.summary.fills, 2);
    assert.equal(data.holdings.length, 2);
    assert.ok(data.candidates.every((c) => c.facets.length === 6));
    assert.ok(data.holdings.some((h) => h.sellable === 0));
    const approved = data.orders.find((o) => o.id === "demo-approved-add")!;
    assert.match(approved.lastCheck!.reason, /盘口/);
    assert.equal(data.reports.daily[0].day, "2026-11-13");
    assert.equal(data.permissions.canTrade, false);
    assert.ok(
      data.orders.some((order) => order.status === "pending" && order.effectiveStatus === "expired-unrecorded"),
    );
  } finally {
    demo.dispose();
  }
});

test("the review demo entry starts on a local random port and shuts down its owned process", async () => {
  const child = spawn(process.execPath, [resolve("scripts/workbench-demo.ts"), "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("演示入口未按时启动")), 10000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error(errors || "演示入口提前退出"));
      });
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    const response = await fetch(url + "/api/workbench");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.demo, true);
    assert.equal(data.summary.pending, 2);
  } finally {
    if (child.exitCode === null)
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
  }
});
