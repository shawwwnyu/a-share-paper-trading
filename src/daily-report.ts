import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Ledger } from "./ledger.ts";
import { dailyReview, renderDailyReview } from "./activity-review.ts";
import { requireThat, timestamp } from "./types.ts";
import type { Settings } from "./config.ts";

export function saveDailyReview(settings: Settings, day: string, now = new Date().toISOString()) {
  requireThat(existsSync(settings.database), "请先初始化模拟账户，日报不会创建账户");
  const ledger = new Ledger(settings.database);
  try {
    const report = dailyReview(ledger, day, now);
    const json = JSON.stringify(report, null, 2) + "\n",
      markdown = renderDailyReview(report);
    const hash = createHash("sha256").update(json).digest("hex");
    const folder = join(settings.reports, "daily");
    mkdirSync(join(folder, "versions"), { recursive: true });
    const latestFile = join(folder, `${day}.json`);
    const previous = existsSync(latestFile) ? JSON.parse(readFileSync(latestFile, "utf8")) : null;
    const updateLatest = !previous || timestamp(previous.to) <= timestamp(report.to);
    for (const [suffix, body] of [
      ["json", json],
      ["md", markdown],
    ]) {
      const archive = join(folder, "versions", `${day}-${hash}.${suffix}`);
      if (existsSync(archive)) requireThat(readFileSync(archive, "utf8") === body, "已保存的日报版本内容不一致");
      else writeFileSync(archive, body, { flag: "wx", mode: 0o600 });
      if (!updateLatest) continue;
      const latest = join(folder, `${day}.${suffix}`);
      writeFileSync(latest + ".tmp", body, { mode: 0o600 });
      renameSync(latest + ".tmp", latest);
    }
    return { report, markdown, file: join(folder, `${day}.json`), hash };
  } finally {
    ledger.close();
  }
}
