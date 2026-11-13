import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { loadUniverse, scanMarket } from "./monitor.ts";
import type { Universe, ScanReport } from "./monitor.ts";
import { EVIDENCE_VERSION, screenWithEvidence } from "./evidence.ts";
import type { EvidenceDataset } from "./evidence.ts";
import { Ledger } from "./ledger.ts";
import { isTradingDay } from "./market.ts";
import { chinaDay } from "./types.ts";
import type { Settings } from "./config.ts";

function save(file: string, data: unknown) {
  writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
}
export async function runScan(settings: Settings, runKey?: string) {
  const started = new Date().toISOString();
  const day = chinaDay(started);
  if (!(await isTradingDay(day))) return "没事可做：今天休市，保留已有自选";
  const folder = join(settings.reports, "scans");
  mkdirSync(folder, { recursive: true });
  const progress = join(settings.reports, "scan-progress.json");
  const runFile = runKey && /^\d+$/.test(runKey) ? join(folder, `run-${runKey}.json`) : null;
  let report: ScanReport;
  try {
    if (runFile && existsSync(runFile)) report = JSON.parse(readFileSync(runFile, "utf8"));
    else {
      save(progress, { state: "running", phase: "读取沪深股票目录", started });
      const cache = join(folder, `universe-${day}.json`);
      const universe: Universe = existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : await loadUniverse();
      if (!existsSync(cache)) save(cache, universe);
      const result = await scanMarket(universe, (done, total) =>
        save(progress, { state: "running", phase: "读取全市场行情", started, done, total }),
      );
      // Read once and persist this exact evidence snapshot, rather than rereading it at ledger replay.
      const evidence: EvidenceDataset | undefined = settings.screeningEvidence
        ? JSON.parse(readFileSync(settings.screeningEvidence, "utf8"))
        : undefined;
      report = settings.screeningEvidence
        ? screenWithEvidence(result.report, result.rows, evidence!, result.report.at)
        : result.report;
      result.report = report;
      save(join(folder, `${report.id}.json`), { ...result, universe, ...(evidence && { evidence }) });
      if (runFile) save(runFile, report);
    }
    let applied = false;
    let watchlistSize = 0;
    if (report.complete && existsSync(settings.database)) {
      const ledger = new Ledger(settings.database);
      try {
        if (ledger.state().config) {
          ledger.execute(`scan-${report.id}`, { type: "watchlist", scan: report });
          applied = true;
          watchlistSize = ledger.state().watchlist.length;
        }
      } finally {
        ledger.close();
      }
    }
    save(join(settings.reports, "scan-latest.json"), report);
    save(progress, {
      state: "done",
      started,
      finished: new Date().toISOString(),
      complete: report.complete,
      observed: report.observed,
      total: report.universeSize,
    });
    const top = report.selected
      .slice(0, 8)
      .map((c) => `${c.symbol} ${c.name}：${c.reasons.slice(0, 2).join("；")}`)
      .join("\n");
    const text = `沪深目录 ${report.universeSize} 只，读到 ${report.observed} 只。${report.complete ? `本次入选 ${report.selected.length} 只，${applied ? `已更新模拟账户自选，当前 ${watchlistSize} 只可跟踪候选` : "尚未初始化账户，已保存观察名单"}` : "行情不完整，保留原自选"}。\n规则 ${report.rule}，数据时间 ${report.at}。${report.rule === EVIDENCE_VERSION ? "已逐项记录证据缺失和排除原因。" : "当前为基础观察，行业、财务、公告等完整证据尚未核对。"}\n${top}\n基础筛选尚未证明有效，入选不代表买入；买卖仍需本人确认。`;
    return `沪深全市场扫描${report.complete ? "完成" : "不完整"}\n\n\`\`\`agent-autoloop\n${JSON.stringify({ notice: [{ key: `scan-${report.id}`, title: "沪深全市场观察", text, fyi: true }] })}\n\`\`\``;
  } catch (error) {
    save(progress, { state: "failed", started, finished: new Date().toISOString(), error: (error as Error).message });
    throw error;
  }
}
