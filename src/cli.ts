import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "./ledger.ts";
import { history, quotes } from "./market.ts";
import { checkMarket } from "./market-check.ts";
import { loadSettings } from "./config.ts";
import { cycle, markAccount, weekly } from "./integrations/agent-autoloop.ts";
import { review, renderReview } from "./review.ts";
import { requireThat } from "./types.ts";
import type { Command, Quote } from "./types.ts";

const [action, file, ...args] = process.argv.slice(2);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function demo(file: string) {
  requireThat(!existsSync(file), "演示数据库已存在，请使用一个新的文件路径");
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const ledger = new Ledger(file);
  const at = (day: string, clock = "10:00:00") => `${day}T${clock}+08:00`;
  const q = (day: string, price: number): Quote => ({
    symbol: "sh600000",
    name: "演示股票",
    at: at(day, "10:02:00"),
    price,
    bid: price,
    ask: price,
    bidSize: 10000,
    askSize: 10000,
    volume: 100000,
    limitUp: 2000,
    limitDown: 500,
    source: "明确标记的演示数据",
    adjustment: "none",
  });
  try {
    const settings = read(fileURLToPath(new URL("../account.example.json", import.meta.url)));
    const strategy = { ...settings.strategy, id: "demo-v1" };
    ledger.execute("init", { type: "init", config: settings.account, strategy }, at("2026-11-02", "09:00:00"));
    for (const [day, side, price] of [
      ["2026-11-02", "buy", 1000],
      ["2026-11-03", "sell", 1100],
    ] as const) {
      ledger.execute(
        side,
        {
          type: "signal",
          signal: {
            id: side,
            symbol: "sh600000",
            side,
            quantity: 100,
            price: 1000,
            at: at(day),
            expiresAt: at(day, "14:56:59"),
            strategy: strategy.id,
            reason: "人工确认闭环演示",
          },
        },
        at(day),
      );
      ledger.execute(
        `${side}-answer`,
        { type: "decide", signal: side, approve: true, by: "demo-owner" },
        at(day, "10:01:00"),
      );
      ledger.execute(`${side}-fill`, { type: "fill", signal: side, quote: q(day, price) }, at(day, "10:02:01"));
    }
    ledger.execute("close", { type: "mark", quotes: [] }, at("2026-11-06", "15:00:00"));
    const result = review(ledger.state(), at("2026-11-02", "09:00:00"), at("2026-11-06", "15:00:00"));
    console.log(`模拟闭环演示通过\n${renderReview(result)}`);
  } finally {
    ledger.close();
  }
}

try {
  requireThat(
    file,
    "用法 node src/cli.ts <init|status|apply|quotes|history|market-check|review|agent-cycle|agent-mark|agent-review|demo> <配置文件或演示数据库> [参数]",
  );
  if (action === "demo") demo(resolve(file));
  else {
    const settings = loadSettings(file);
    const context = () => {
      requireThat(process.env.AGENT_AUTOLOOP_CONTEXT, "本命令由中台接单程序调用，需要轮次资料文件");
      return read(process.env.AGENT_AUTOLOOP_CONTEXT);
    };
    if (action === "market-check") {
      const result = await checkMarket(
        args[0] ? args[0].split(",") : settings.account.symbols,
        settings.account.maxQuoteAgeSeconds,
        args[1] === undefined ? 60 : Number(args[1]),
        undefined,
        settings.account.slippageBps,
      );
      console.log(JSON.stringify(result, null, 2));
      if (!result.readSucceeded) process.exitCode = 1;
    } else if (action === "agent-cycle") console.log(await cycle(settings, context()));
    else if (action === "agent-mark") console.log(await markAccount(settings));
    else if (action === "agent-review") console.log(weekly(settings, context()));
    else if (action === "quotes") console.log(JSON.stringify(await quotes(settings.account.symbols), null, 2));
    else if (action === "history") {
      const data = await history(settings.account.symbols);
      requireThat(args[0], "请指定历史行情输出文件");
      writeFileSync(args[0], JSON.stringify(data, null, 2), { mode: 0o600 });
      console.log("历史行情已保存，逐日交易限制和公司行为需核实后才能用于策略批准");
    } else {
      if (action === "init") mkdirSync(dirname(settings.database), { recursive: true });
      const ledger = new Ledger(settings.database);
      try {
        if (action === "init") {
          ledger.execute("init", { type: "init", config: settings.account, strategy: settings.strategy });
          console.log("模拟账户已初始化");
        } else if (action === "status") console.log(JSON.stringify(ledger.state(), null, 2));
        else if (action === "apply") {
          requireThat(args[0] && args[1], "用法 node src/cli.ts apply account.json <唯一操作编号> <操作JSON文件>");
          const command = read(args[1]) as Command;
          ledger.execute(args[0], command);
          console.log(`模拟账户操作已记录 ${args[0]}`);
        } else if (action === "review") {
          requireThat(args[0] && args[1], "请指定带时区的复盘开始和结束时间");
          console.log(renderReview(review(ledger.state(), args[0], args[1])));
        } else throw new Error("不认识的命令");
      } finally {
        ledger.close();
      }
    }
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
