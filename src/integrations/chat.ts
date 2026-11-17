import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "../ledger.ts";
import { quotes } from "../market.ts";
import { chinaDay, timestamp } from "../types.ts";
import type { Settings } from "../config.ts";
import type { Quote, State } from "../types.ts";

export type ChatContext = {
  events?: { id: string | number; detail?: string }[];
  answers?: { card: number; chosen?: string | null; text?: string | null }[];
};

const HOLDINGS_RE = /^(查看|看看|当前|现在|查询)?(持仓|持仓情况|账户|账户情况|仓位|资产|盈亏)[？?。！!]*$/;
const help =
  "可以直接发送：\n持仓（或 查看持仓 / 盈亏）\n查看自选\n查看日报\n查看周报\n查看进度\n扫描市场\n买卖建议通过确认卡片处理。";
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const yuan = (cents: number) => (cents / 100).toFixed(2);
const signedYuan = (cents: number) => `${cents >= 0 ? "+" : ""}${yuan(cents)}`;
const signedPct = (num: number, den: number) =>
  den > 0 ? `${num >= 0 ? "+" : ""}${((num / den) * 100).toFixed(2)}%` : "—";

function formatHoldings(state: State | undefined, liveQuotes: Quote[], now: string) {
  if (!state?.config) return "模拟账户尚未初始化。";
  const quoteMap = new Map(liveQuotes.map((q) => [q.symbol, q]));
  const today = chinaDay(now);
  const symbols = [...new Set(state.lots.map((l) => l.symbol))];
  const pendingCount = Object.values(state.orders).filter(
    (o) => o.status === "pending" && o.strategy === state.active && timestamp(o.expiresAt) > timestamp(now),
  ).length;
  const approvedCount = Object.values(state.orders).filter(
    (o) => o.status === "approved" && o.strategy === state.active && timestamp(o.expiresAt) > timestamp(now),
  ).length;

  if (!symbols.length) {
    return [
      `可用现金：${yuan(state.cash)} 元｜累计成交：${state.fills.length} 笔`,
      "当前空仓，没有持仓股票。",
      ...(pendingCount || approvedCount
        ? [`未结委托：待确认 ${pendingCount} 笔，已确认待撮合 ${approvedCount} 笔`]
        : []),
    ].join("\n");
  }

  let totalCost = 0;
  let totalMarket = 0;
  let allQuoted = true;
  let latestQuoteAt = "";
  const lines: string[] = [];

  for (const symbol of symbols) {
    const lots = state.lots.filter((l) => l.symbol === symbol);
    const quantity = lots.reduce((sum, l) => sum + l.quantity, 0);
    const sellable = lots.filter((l) => l.day < today).reduce((sum, l) => sum + l.quantity, 0);
    const cost = lots.reduce((sum, l) => sum + l.cost, 0);
    totalCost += cost;
    const avgCost = cost / quantity;
    const q = quoteMap.get(symbol);
    if (q) {
      const value = quantity * q.price;
      const pnl = value - cost;
      totalMarket += value;
      if (q.at > latestQuoteAt) latestQuoteAt = q.at;
      lines.push(
        `• ${symbol} ${q.name}：${quantity} 股（可卖 ${sellable} 股）｜成本 ${(avgCost / 100).toFixed(2)} → 现价 ${yuan(q.price)}｜市值 ${yuan(value)} 元｜浮盈 ${signedYuan(pnl)} 元（${signedPct(pnl, cost)}）`,
      );
    } else {
      allQuoted = false;
      lines.push(
        `• ${symbol}：${quantity} 股（可卖 ${sellable} 股）｜含费成本 ${yuan(cost)} 元（每股 ${(avgCost / 100).toFixed(2)} 元，暂未取到实时报价）`,
      );
    }
  }

  const header = allQuoted
    ? [
        `参考总资产：${yuan(state.cash + totalMarket)} 元（初始本金 ${yuan(state.config.cash)} 元，总变动 ${signedYuan(state.cash + totalMarket - state.config.cash)} 元）`,
        `可用现金：${yuan(state.cash)} 元｜持仓市值：${yuan(totalMarket)} 元｜持仓成本：${yuan(totalCost)} 元`,
        `持仓浮盈亏：${signedYuan(totalMarket - totalCost)} 元（${signedPct(totalMarket - totalCost, totalCost)}）｜报价时间：${latestQuoteAt.slice(0, 19).replace("T", " ")}`,
      ]
    : [`可用现金：${yuan(state.cash)} 元｜持仓含费总成本：${yuan(totalCost)} 元（部分实时行情未取到）`];

  return [
    ...header,
    ...(pendingCount || approvedCount ? [`未结委托：待确认 ${pendingCount} 笔，已确认待撮合 ${approvedCount} 笔`] : []),
    `持仓明细（共 ${symbols.length} 只）：`,
    ...lines,
  ].join("\n");
}

export function chat(
  settings: Settings,
  context: ChatContext,
  liveQuotes: Quote[] = [],
  now = new Date().toISOString(),
) {
  const notice: { key: string; title: string; text: string; fyi: true }[] = [];
  const events: { id: string; type: string; subject: string; summary: string; detail: string }[] = [];
  const ledger = existsSync(settings.database) ? new Ledger(settings.database, { readOnly: true }) : null;
  try {
    const state = ledger?.state();
    const inputs = [
      ...(context.events ?? []).map((e) => ({ id: String(e.id), words: e.detail?.trim() ?? "" })),
      ...(context.answers ?? []).map((a) => ({
        id: `card-${a.card}`,
        words: a.text?.trim() || a.chosen?.trim() || "",
      })),
    ];
    for (const item of inputs) {
      const { words } = item;
      let text = help;
      let title = "账户助手";
      if (/^(查看)?(进度|开发进度|状态|进展)[？?。！!]*$/.test(words)) {
        const progress = read(fileURLToPath(new URL("../../docs/progress.json", import.meta.url)));
        const scanFile = join(settings.reports, "scan-progress.json");
        const scan = existsSync(scanFile) ? read(scanFile) : null;
        text = `目标：沪深全市场监控 → 自选 → 人工确认模拟买卖 → 复盘。\n${progress.summary}\n后续：${progress.next.join("；")}\n账户：${state?.config ? `已初始化，成交 ${state.fills.length} 笔` : "尚未初始化"}。\n${scan ? `最近扫描：${scan.state}，${scan.done ?? scan.observed ?? 0}/${scan.total ?? "待定"}。` : "尚未运行全市场扫描。"}`;
      } else if (/^(扫描市场|全市场扫描|监控股票|开始监控|扫描)$/.test(words)) {
        events.push({
          id: `chat-${item.id}-scan`,
          type: "paper.scan.requested",
          subject: "all-a",
          summary: "本人请求沪深全市场扫描",
          detail: "",
        });
        text = "已提交沪深全市场扫描。完成后发送覆盖情况和入选名单。";
      } else if (/^(开发(?:[：:\s]|$)|继续开发|改进[：:])/.test(words)) {
        events.push({
          id: `chat-${item.id}-develop`,
          type: "paper.dev.requested",
          subject: "roadmap",
          summary: "本人提出交易项目开发需求",
          detail: words,
        });
        text = "开发需求已登记，将在交易仓库按已批准的监控、自选、模拟买卖和复盘路线处理。完成一批后回报验收结果。";
      } else if (/^(查看)?自选(股)?[？?。！!]*$/.test(words)) {
        title = "自选观察名单";
        const file = join(settings.reports, "scan-latest.json");
        const scan = existsSync(file) ? read(file) : null;
        const selected = state?.watchlistScan ? state.watchlist : scan?.complete ? scan.selected : [];
        const manual =
          state?.manualWatchlist.filter((entry) => !selected.some((c: any) => c.symbol === entry.symbol)) ?? [];
        const observations = manual.map((entry) => {
          const reasons = state?.watchlistReport?.assessments?.find((a) => a.symbol === entry.symbol)?.reasons;
          return `${entry.symbol} ${entry.name}（仅观察）：${entry.reason}；${reasons?.length ? reasons.join("；") : "尚未取得合格筛选证据"}`;
        });
        const exclusions = state?.watchlistExclusions.map((entry) => `${entry.symbol}：${entry.reason}`) ?? [];
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
      } else if (HOLDINGS_RE.test(words)) {
        title = "模拟账户持仓概览";
        text = formatHoldings(state, liveQuotes, now);
      } else if (/^(查看)?(日报|每日复盘)[？?。！!]*$/.test(words)) {
        title = "最新每日复盘";
        const folder = join(settings.reports, "daily");
        const files = existsSync(folder)
          ? readdirSync(folder)
              .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
              .sort()
          : [];
        text = files.length
          ? readFileSync(join(folder, files.at(-1)!), "utf8").slice(0, 3500)
          : "还没有每日复盘，收盘估值后将从账本生成；资料不足会明确标出。";
      } else if (/^(查看)?(复盘|周报)[？?。！!]*$/.test(words)) {
        title = "最新每周复盘";
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
      if (!notice.some((entry) => entry.text === text)) notice.push({ key: `chat-${item.id}`, title, text, fyi: true });
    }
    return `已处理 ${inputs.length} 条对话查询\n\n\`\`\`agent-autoloop\n${JSON.stringify({ notice, events })}\n\`\`\``;
  } finally {
    ledger?.close();
  }
}

export async function runAgentChat(
  settings: Settings,
  context: ChatContext,
  deps: { now?: () => string; fetchQuotes?: (symbols: string[]) => Promise<Quote[]> } = {},
) {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const fetchQuotes = deps.fetchQuotes ?? quotes;
  const words = [
    ...(context.events ?? []).map((e) => e.detail?.trim() ?? ""),
    ...(context.answers ?? []).map((a) => a.text?.trim() || a.chosen?.trim() || ""),
  ];
  let liveQuotes: Quote[] = [];
  if (words.some((w) => HOLDINGS_RE.test(w)) && existsSync(settings.database)) {
    const ledger = new Ledger(settings.database, { readOnly: true });
    let symbols: string[] = [];
    try {
      symbols = [...new Set(ledger.state().lots.map((l) => l.symbol))];
    } finally {
      ledger.close();
    }
    if (symbols.length) {
      try {
        for (let start = 0; start < symbols.length; start += 100)
          liveQuotes.push(...(await fetchQuotes(symbols.slice(start, start + 100))));
      } catch {
        // Degrade gracefully to recorded cost basis if live quote network fails.
      }
    }
  }
  return chat(settings, context, liveQuotes, now);
}
