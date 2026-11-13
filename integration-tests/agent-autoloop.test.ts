// Failure mode: the standalone app emits receipts or rules that the real hub no longer accepts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { cycle, weekly } from "../src/integrations/agent-autoloop.ts";

test("standalone rules, trade asks and weekly notices are accepted by the real hub", async () => {
  assert.ok(process.env.AGENT_AUTOLOOP_REPO, "请将 AGENT_AUTOLOOP_REPO 指向中台源码目录");
  const hub = resolve(process.env.AGENT_AUTOLOOP_REPO);
  const app = resolve(import.meta.dirname, "..");
  const scratch = mkdtempSync(join(tmpdir(), "paper-hub-"));
  try {
    const checked = spawnSync(
      process.execPath,
      [join(hub, "bin/agent-autoloop.ts"), "check", join(app, "integrations/agent-autoloop/rules.json")],
      {
        encoding: "utf8",
        env: { ...process.env, AGENT_AUTOLOOP_HOME: join(scratch, "hub") },
      },
    );
    assert.equal(checked.status, 0, checked.stderr);
    const settings = JSON.parse(readFileSync(join(app, "account.example.json"), "utf8"));
    settings.database = join(scratch, "account.db");
    settings.reports = join(scratch, "reports");
    const now = "2026-11-13T18:00:00+08:00";
    const ledger = new Ledger(settings.database);
    try {
      ledger.execute("init", { type: "init", config: settings.account, strategy: settings.strategy }, now);
      ledger.execute(
        "signal",
        {
          type: "signal",
          signal: {
            id: "integration",
            symbol: "sh600000",
            side: "buy",
            quantity: 100,
            price: 1000,
            at: now,
            expiresAt: "2026-11-14T14:56:59+08:00",
            strategy: settings.strategy.id,
            reason: "接口验收",
          },
        },
        now,
      );
    } finally {
      ledger.close();
    }
    const outputs = [
      await cycle(settings, { answers: [] }, () => now),
      weekly(settings, { answers: [], events: [{ type: "schedule.tick", receivedAt: now }] }, now),
    ];
    const moduleUrl = pathToFileURL(join(hub, "worker/contract.ts")).href;
    const script = [
      "import { readFileSync } from 'node:fs';",
      "const { readMessage, resultFrom } = await import(process.argv[1]);",
      "const results = JSON.parse(readFileSync(0, 'utf8')).map(text => resultFrom(readMessage(text), {}));",
      "if (results.some(result => result.problem)) throw new Error(JSON.stringify(results));",
      "console.log(JSON.stringify(results.map(result => result.result)));",
    ].join("\n");
    const checkedReceipts = spawnSync(process.execPath, ["--input-type=module", "-e", script, moduleUrl], {
      encoding: "utf8",
      input: JSON.stringify(outputs),
    });
    assert.equal(checkedReceipts.status, 0, checkedReceipts.stderr);
    const receipts = JSON.parse(checkedReceipts.stdout);
    assert.equal(receipts[0].ask[0].about, "paper-trade:integration");
    assert.equal(receipts[1].notice[0].fyi, true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
