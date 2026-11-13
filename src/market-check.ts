import { checkQuote, tradingTime } from "./execution.ts";
import { CALENDAR, KLINES, QUOTES, checkSymbols, history, isTradingDay, quotes } from "./market.ts";
import { chinaDay, integer, requireThat, timestamp } from "./types.ts";
import type { Quote } from "./types.ts";

type ReadResult<T> =
  | { status: "读取成功"; source: string; receivedAt: string; data: T }
  | { status: "读取失败" | "不支持"; source: string; receivedAt: string; error: string };

async function read<T>(source: string, action: () => Promise<T>, clock: () => string): Promise<ReadResult<T>> {
  try {
    const data = await action();
    return { status: "读取成功", source, receivedAt: clock(), data };
  } catch (error) {
    return { status: "读取失败", source, receivedAt: clock(), error: (error as Error).message };
  }
}

export function quoteAvailability(q: Quote, now: string, maxAge: number, calendar: boolean | null, slippageBps = 0) {
  const reasons: string[] = [];
  try {
    checkQuote(q, now, maxAge);
  } catch (error) {
    reasons.push((error as Error).message);
  }
  if (calendar === null) reasons.push("交易日历未核实");
  else if (!calendar) reasons.push("交易日历显示休市");
  if (!tradingTime(now) || !tradingTime(q.at)) reasons.push("不在连续竞价时段");
  if (chinaDay(q.at) !== chinaDay(now)) reasons.push("行情不是当日数据");
  if (q.volume <= 0) reasons.push("无当日成交，可能停牌、未开盘或代码已失效");
  const side = (price: number, size: number, buying: boolean) => {
    const issues = [...reasons];
    const slipped = buying
      ? Math.ceil(price * (1 + slippageBps / 10000))
      : Math.floor(price * (1 - slippageBps / 10000));
    if (price <= 0 || size <= 0) issues.push("缺少有效对手盘口");
    if (slipped <= 0 || slipped < q.limitDown || slipped > q.limitUp) issues.push("加入滑点后的盘口价格超出涨跌停范围");
    return { available: issues.length === 0, reasons: issues };
  };
  return {
    assessedAt: now,
    ageSeconds: (timestamp(now) - timestamp(q.at)) / 1000,
    buy: side(q.ask, q.askSize, true),
    sell: side(q.bid, q.bidSize, false),
    note: "仅检查行情条件；成交仍需人工确认后的有效行情，并检查委托数量、盘口深度、现金、费用和 T+1 可卖持仓",
  };
}

export async function checkMarket(
  symbols: string[],
  maxQuoteAgeSeconds: number,
  limit = 60,
  clock = () => new Date().toISOString(),
  slippageBps = 0,
) {
  checkSymbols(symbols);
  integer(maxQuoteAgeSeconds, "行情有效秒数", 1);
  integer(limit, "日线数量", 1);
  requireThat(limit <= 640, "单次日线数量不超过 640");
  requireThat(Number.isFinite(slippageBps) && slippageBps >= 0 && slippageBps < 10000, "滑点配置无效");
  const startedAt = clock();
  const day = chinaDay(startedAt);
  const calendarSource = `${CALENDAR}?month=${day.slice(0, 7)}`;
  let calendar = await read(calendarSource, () => isTradingDay(day), clock);
  const items = [];
  for (const symbol of symbols) {
    const quote = await read(QUOTES + symbol, async () => (await quotes([symbol]))[0], clock);
    const historySource = `${KLINES}?${new URLSearchParams({ param: `${symbol},day,,,${limit},` })}`;
    const daily = symbol.startsWith("bj")
      ? {
          status: "不支持" as const,
          source: historySource,
          receivedAt: clock(),
          error: "腾讯历史日线不覆盖北交所，请导入经核实的数据文件",
        }
      : await read(
          historySource,
          async () => {
            const data = await history([symbol], limit);
            const bars = data.bars;
            requireThat(
              bars.every((b) => b.day <= chinaDay(clock())),
              "日线包含未来日期",
            );
            return {
              adjustment: data.adjustment,
              bars: bars.length,
              requestedBars: limit,
              from: bars[0].day,
              to: bars.at(-1)!.day,
              latest: bars.at(-1)!,
              marketRulesVerified: data.marketRulesVerified,
              corporateActionsVerified: data.corporateActionsVerified,
              note: "返回行数可能包含当日未收盘日线；覆盖范围不保证每个交易日齐全，不能直接视为已核实的回测数据",
            };
          },
          clock,
        );
    items.push({ symbol, quote, history: daily });
  }
  // Assess freshness after all requests; a slow history request can age a quote.
  const assessedAt = clock();
  if (chinaDay(assessedAt) !== day)
    calendar = {
      status: "读取失败",
      source: calendarSource,
      receivedAt: assessedAt,
      error: "检查跨越交易日期，请重新检查当日日历",
    };
  return {
    startedAt,
    assessedAt,
    day,
    units: { prices: "人民币分", sizes: "股（689 存托凭证为份）", timestamps: "带时区；行情时间为北京时间" },
    readSucceeded:
      calendar.status === "读取成功" &&
      items.every((i) => i.quote.status === "读取成功" && i.history.status === "读取成功"),
    calendar,
    items: items.map((item) => ({
      ...item,
      availability:
        item.quote.status === "读取成功"
          ? quoteAvailability(
              item.quote.data,
              assessedAt,
              maxQuoteAgeSeconds,
              calendar.status === "读取成功" ? calendar.data : null,
              slippageBps,
            )
          : {
              assessedAt,
              buy: { available: false, reasons: ["行情读取失败"] },
              sell: { available: false, reasons: ["行情读取失败"] },
            },
    })),
  };
}
