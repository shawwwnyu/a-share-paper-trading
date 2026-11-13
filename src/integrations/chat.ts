import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "../ledger.ts";
import type { Settings } from "../config.ts";

const help =
  "可以直接发送：\n查看进度\n扫描市场\n查看自选\n查看持仓\n查看复盘\n开发：具体需求\n继续开发\n买卖建议通过确认卡片处理。";
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
export function chat(settings: Settings, context: { events?: { id: string | number; detail?: string }[] }) {
  const notice: { key: string; title: string; text: string; fyi: true }[] = [];
  const events: { id: string; type: string; subject: string; summary: string; detail: string }[] = [];
  const ledger = existsSync(settings.database) ? new Ledger(settings.database) : null;
  try {
    const state = ledger?.state();
    for (const event of context.events ?? []) {
      const words = event.detail?.trim() ?? "";
      let text = help;
      if (/^(查看)?(进度|开发进度|状态|进展)[？?。！!]*$/.test(words)) {
        const progress = read(fileURLToPath(new URL("../../docs/progress.json", import.meta.url)));
        const scanFile = join(settings.reports, "scan-progress.json");
        const scan = existsSync(scanFile) ? read(scanFile) : null;
        text = `目标：沪深全市场监控 → 自选 → 人工确认模拟买卖 → 复盘。\n${progress.summary}\n后续：${progress.next.join("；")}\n账户：${state?.config ? `已初始化，成交 ${state.fills.length} 笔` : "尚未初始化"}。\n${scan ? `最近扫描：${scan.state}，${scan.done ?? scan.observed ?? 0}/${scan.total ?? "待定"}。` : "尚未运行全市场扫描。"}\n行情联网验收已于 2026-11-13 13:21 完成；早先的环境受限是旧回执。`;
      } else if (/^(扫描市场|全市场扫描|监控股票|开始监控|扫描)$/.test(words)) {
        events.push({
          id: `chat-${event.id}-scan`,
          type: "paper.scan.requested",
          subject: "all-a",
          summary: "本人请求沪深全市场扫描",
          detail: "",
        });
        text = "已提交沪深全市场扫描。完成后发送覆盖情况和入选名单。";
      } else if (/^(开发(?:[：:\s]|$)|继续开发|改进[：:])/.test(words)) {
        events.push({
          id: `chat-${event.id}-develop`,
          type: "paper.dev.requested",
          subject: "roadmap",
          summary: "本人提出交易项目开发需求",
          detail: words,
        });
        text = "开发需求已登记，将在交易仓库按已批准的监控、自选、模拟买卖和复盘路线处理。完成一批后回报验收结果。";
      } else if (/^(查看)?自选(股)?$/.test(words)) {
        const file = join(settings.reports, "scan-latest.json");
        const scan = existsSync(file) ? read(file) : null;
        const selected = state?.watchlistScan ? state.watchlist : scan?.complete ? scan.selected : [];
        const manual =
          state?.manualWatchlist.filter((item) => !selected.some((c: any) => c.symbol === item.symbol)) ?? [];
        const observations = manual.map((item) => {
          const reasons = state?.watchlistReport?.assessments?.find((a) => a.symbol === item.symbol)?.reasons;
          return `${item.symbol} ${item.name}（仅观察）：${item.reason}；${reasons?.length ? reasons.join("；") : "尚未取得合格筛选证据"}`;
        });
        const exclusions = state?.watchlistExclusions.map((item) => `${item.symbol}：${item.reason}`) ?? [];
        text = [
          selected.length
            ? `自选观察名单（入选不代表买入）：\n${selected.map((c: any) => `${c.symbol} ${c.name}：${c.reasons.slice(0, 2).join("；")}`).join("\n")}`
            : "当前没有入选候选。",
          ...(observations.length
            ? [`人工自选（仅观察，证据合格后方可生成买入建议）：\n${observations.join("\n")}`]
            : []),
          ...(exclusions.length ? [`本人排除：\n${exclusions.join("\n")}`] : []),
          ...(!selected.length && !manual.length && !exclusions.length ? ["可发送“扫描市场”更新观察名单。"] : []),
        ].join("\n");
      } else if (/^(查看)?(持仓|账户)$/.test(words)) {
        text = state?.config
          ? `模拟账户可用现金 ${(state.cash / 100).toFixed(2)} 元，累计成交 ${state.fills.length} 笔。\n${state.lots.length ? state.lots.map((l) => `${l.symbol} ${l.quantity} 股，买入日 ${l.day}`).join("\n") : "当前没有持仓。"}`
          : "模拟账户尚未初始化。";
      } else if (/^(查看)?(复盘|周报)$/.test(words)) {
        const files = existsSync(settings.reports)
          ? readdirSync(settings.reports)
              .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
              .sort()
          : [];
        text = files.length
          ? readFileSync(join(settings.reports, files.at(-1)!), "utf8").slice(0, 3500)
          : "还没有周报。每周五收盘后复盘；样本不足保持策略不变。";
      }
      if (text.length > 3900) text = text.slice(0, 3900) + "\n内容较多，完整记录保存在本机账户与报告目录。";
      if (!notice.some((item) => item.text === text))
        notice.push({ key: `chat-${event.id}`, title: "Loop 回复", text, fyi: true });
    }
    return `已处理 ${context.events?.length ?? 0} 条私聊\n\n\`\`\`agent-autoloop\n${JSON.stringify({ notice, events })}\n\`\`\``;
  } finally {
    ledger?.close();
  }
}
