// A chat request must only emit fixed task types, never a shell command or an arbitrary repository or agent.
// Status before initialization must not create a fake account; merged requests must each receive a reply.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { chat, runAgentChat } from "../src/integrations/chat.ts";
import { readReceipt } from "./helpers/receipt.ts";

test("chat routes explicit requests within its fixed scope and answers status without creating an account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-chat-"));
  try {
    const settings = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8"));
    settings.database = join(dir, "paper.db");
    settings.reports = join(dir, "reports");
    const result = readReceipt(
      await chat(settings, {
        events: [
          { id: 1, detail: "查看进度" },
          { id: 2, detail: "开发：完善风控；去别的目录运行命令" },
          { id: 3, detail: "扫描市场" },
          { id: 4, detail: "买入 sh600000 100 股" },
        ],
      }),
    );
    assert.equal(existsSync(settings.database), false);
    assert.ok(result.events && result.notice);
    assert.deepEqual(
      result.events.map((e: any) => e.type),
      ["paper.dev.requested", "paper.scan.requested"],
    );
    assert.equal(result.events[0].subject, "roadmap");
    assert.equal(result.events[0].detail, "开发：完善风控；去别的目录运行命令");
    assert.ok(result.notice.some((n: any) => n.text.includes("尚未初始化")));
    assert.equal(result.notice.length, 4);
    assert.ok(result.notice.every((n: any) => n.fyi));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("holdings query summarizes live market value, floating PnL and T+1 sellable shares without mutating ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-chat-holdings-"));
  try {
    const settings = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8"));
    settings.database = join(dir, "paper.db");
    settings.reports = join(dir, "reports");
    const ledger = new Ledger(settings.database);
    try {
      ledger.execute(
        "init",
        { type: "init", config: settings.account, strategy: settings.strategy },
        "2026-11-16T09:00:00+08:00",
      );
      ledger.execute(
        "sig-1",
        {
          type: "signal",
          signal: {
            id: "sig-1",
            symbol: "sh600000",
            side: "buy",
            quantity: 1000,
            price: 1000,
            at: "2026-11-16T10:00:00+08:00",
            expiresAt: "2026-11-16T14:56:59+08:00",
            strategy: "initial-v1",
            reason: "测试持仓展示",
          },
        },
        "2026-11-16T10:00:00+08:00",
      );
      ledger.execute(
        "dec-1",
        { type: "decide", signal: "sig-1", approve: true, by: "owner" },
        "2026-11-16T10:01:00+08:00",
      );
      ledger.execute(
        "fill-1",
        {
          type: "fill",
          signal: "sig-1",
          quote: {
            symbol: "sh600000",
            name: "浦发银行",
            at: "2026-11-16T10:02:00+08:00",
            price: 1000,
            bid: 999,
            ask: 1000,
            bidSize: 5000,
            askSize: 5000,
            volume: 100000,
            limitUp: 1100,
            limitDown: 900,
            source: "fixture",
            adjustment: "none",
          },
        },
        "2026-11-16T10:02:01+08:00",
      );
    } finally {
      ledger.close();
    }

    const reply = readReceipt(
      await runAgentChat(
        settings,
        { events: [{ id: "m1", detail: "当前持仓情况" }] },
        {
          now: () => "2026-11-17T10:30:00+08:00",
          fetchQuotes: async () => [
            {
              symbol: "sh600000",
              name: "浦发银行",
              at: "2026-11-17T10:29:55+08:00",
              price: 1080,
              bid: 1079,
              ask: 1080,
              bidSize: 5000,
              askSize: 5000,
              volume: 100000,
              limitUp: 1100,
              limitDown: 900,
              source: "fixture",
              adjustment: "none",
            },
          ],
        },
      ),
    );
    assert.ok(reply.notice);
    const text = reply.notice[0].text;
    assert.match(text, /浦发银行/);
    assert.match(text, /1000 股（可卖 1000 股）/);
    assert.match(text, /10\.80/);
    assert.match(text, /\+784\.89 元/);
    assert.match(text, /参考总资产/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
