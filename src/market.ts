import { integer, requireThat, symbolCode } from "./types.ts";
import type { Bar, Dataset, Quote } from "./types.ts";

const QUOTES = "https://qt.gtimg.cn/q=";
const KLINES = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const CALENDAR = "https://www.szse.cn/api/report/exchange/onepersistenthour/monthList";
function money(value: string) {
  requireThat(typeof value === "string" && /^\d+(?:\.\d{1,2}0*)?$/.test(value), "行情价格格式异常");
  return integer(Math.round(Number(value) * 100), "价格");
}
function count(value: string, scale = 1) {
  requireThat(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value), "行情数量格式异常");
  return integer(Math.round(Number(value) * scale), "数量");
}
export function parseQuotes(raw: string, symbols: string[]): Quote[] {
  const found = new Map<string, Quote>();
  for (const match of raw.matchAll(/v_([a-z]{2}\d{6})="([^"]*)"/g)) {
    const symbol = match[1];
    if (!symbols.includes(symbol)) continue;
    const f = match[2].split("~");
    requireThat(!found.has(symbol) && f.length > 48 && f[2] === symbol.slice(2), "行情重复或返回了其他股票");
    requireThat(/^\d{14}$/.test(f[30]), "行情缺少交易所时间");
    const d = f[30];
    const at = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}+08:00`;
    found.set(symbol, {
      symbol,
      name: f[1],
      at,
      price: money(f[3]),
      bid: money(f[9] || "0"),
      ask: money(f[19] || "0"),
      bidSize: count(f[10] || "0", 100),
      askSize: count(f[20] || "0", 100),
      volume: count(f[6] || "0", 100),
      limitUp: money(f[47] || "0"),
      limitDown: money(f[48] || "0"),
      source: `${QUOTES}${symbol}`,
      adjustment: "none",
    });
  }
  return symbols.map((symbol) => {
    requireThat(found.has(symbol), `行情缺少 ${symbol}`);
    return found.get(symbol)!;
  });
}
async function request(url: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    headers: { "user-agent": "Mozilla/5.0" },
  });
  requireThat(response.ok, `行情请求失败，HTTP ${response.status}`);
  return response;
}
export async function quotes(symbols: string[]) {
  symbols.forEach(symbolCode);
  requireThat(symbols.length > 0 && symbols.length <= 100, "每次查询 1 至 100 只股票");
  const response = await request(QUOTES + symbols.join(","));
  return parseQuotes(new TextDecoder("gbk").decode(await response.arrayBuffer()), symbols);
}
export async function history(symbols: string[], limit = 320): Promise<Dataset> {
  integer(limit, "日线数量", 1);
  requireThat(limit <= 640, "单次日线数量不超过 640");
  const bars: Bar[] = [];
  for (const symbol of symbols) {
    symbolCode(symbol);
    requireThat(!symbol.startsWith("bj"), "腾讯历史日线不覆盖北交所，请导入经核实的数据文件");
    const response = await request(`${KLINES}?${new URLSearchParams({ param: `${symbol},day,,,${limit},` })}`);
    const payload = (await response.json()) as { data?: Record<string, { day?: string[][] }> };
    const rows = payload.data?.[symbol]?.day;
    requireThat(Array.isArray(rows) && rows.length > 0, `${symbol} 缺少不复权日线`);
    const seen = new Set<string>();
    for (const row of rows) {
      requireThat(row.length >= 6 && /^\d{4}-\d{2}-\d{2}$/.test(row[0]) && !seen.has(row[0]), "日线格式改变或日期重复");
      seen.add(row[0]);
      bars.push({
        symbol,
        day: row[0],
        open: money(row[1]),
        close: money(row[2]),
        high: money(row[3]),
        low: money(row[4]),
        volume: count(row[5], symbol.startsWith("sh688") ? 1 : 100),
      });
    }
  }
  return { source: KLINES, adjustment: "none", marketRulesVerified: false, corporateActionsVerified: false, bars };
}
export async function isTradingDay(day: string) {
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(day), "交易日格式无效");
  const [year, month] = day.split("-").map(Number);
  const response = await request(`${CALENDAR}?${new URLSearchParams({ month: `${year}-${month}` })}`);
  const payload = (await response.json()) as { data?: { jyrq: string; jybz: string | number }[] };
  requireThat(Array.isArray(payload.data), "交易日历不可用");
  const days = new Map<string, boolean>();
  for (const row of payload.data) {
    const date = row.jyrq?.slice(0, 10);
    requireThat(
      date?.startsWith(day.slice(0, 7)) && !days.has(date) && ["0", "1"].includes(String(row.jybz)),
      "交易日历格式改变或重复",
    );
    days.set(date, String(row.jybz) === "1");
  }
  const expected = new Date(Date.UTC(year, month, 0)).getUTCDate();
  requireThat(days.size === expected && days.has(day), "交易日历不完整");
  return days.get(day)!;
}
