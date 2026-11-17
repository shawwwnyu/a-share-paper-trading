// A full watchlist must not exceed the hub's five-question limit or starve suggestions behind existing open cards.
// Merged repeated chat requests must fit the ten-notice limit without losing requested work.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { cycle } from "../src/integrations/agent-autoloop.ts";
import { chat } from "../src/integrations/chat.ts";
import { readReceipt } from "./helpers/receipt.ts";

test("six pending suggestions are delivered five then one, without repeating open cards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-capacity-"));
  const settings = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8"));
  settings.database = join(dir, "paper.db");
  settings.reports = join(dir, "reports");
  settings.account.symbols = Array.from({ length: 6 }, (_, i) => `sh60000${i}`);
  const now = "2026-11-13T18:00:00+08:00";
  const ledger = new Ledger(settings.database);
  try {
    ledger.execute("init", { type: "init", config: settings.account, strategy: settings.strategy }, now);
    for (const symbol of settings.account.symbols)
      ledger.execute(
        symbol,
        {
          type: "signal",
          signal: {
            id: symbol,
            symbol,
            side: "buy",
            quantity: 100,
            price: 1000,
            at: now,
            expiresAt: "2026-11-14T14:56:59+08:00",
            strategy: settings.strategy.id,
            reason: "fixture",
          },
        },
        now,
      );
    const first = readReceipt(await cycle(settings, { answers: [] }, () => now));
    assert.equal(first.ask?.length, 5);
    const second = readReceipt(
      await cycle(
        settings,
        { answers: [], open: first.ask!.map((c, i) => ({ card: i + 1, title: c.title })) },
        () => now,
      ),
    );
    assert.equal(second.ask?.length, 1);
    assert.equal(new Set([...first.ask!, ...second.ask!].map((c) => c.key)).size, 6);
    const received = readReceipt(
      chat(settings, { events: Array.from({ length: 11 }, (_, i) => ({ id: i, detail: "扫描市场" })) }),
    );
    assert.ok(received.notice!.length <= 10);
    assert.equal(received.events!.length, 11);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
