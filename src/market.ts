import { integer, requireThat, symbolCode } from "./types.ts";
import type { Bar, Dataset, Quote } from "./types.ts";

export const QUOTES = "https://qt.gtimg.cn/q=";
export const KLINES = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
export const CALENDAR = "https://www.szse.cn/api/report/exchange/onepersistenthour/monthList";

export function checkSymbols(symbols: string[]) {
  requireThat(Array.isArray(symbols) && symbols.length > 0 && symbols.length <= 100, "每次查询 1 至 100 只股票");
  symbols.forEach(symbolCode);
  requireThat(new Set(symbols).size === symbols.length, "查询股票重复");
}
function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validPayload(value: unknown): asserts value is Record<string, unknown> {
  requireThat(record(value), "行情响应不是有效对象");
  requireThat(value.code === undefined || value.code === 0 || value.code === "0", "行情接口返回错误");
}
// Tencent STAR cumulative volume is in shares; best bid/ask sizes remain in lots.
const volumeScale = (symbol: string) => (/^sh68[89]/.test(symbol) ? 1 : 100);
function money(value: string) {
  requireThat(typeof value === "string" && /^\d+(?:\.\d{1,2}0*)?$/.test(value), "行情价格格式异常");
  return integer(Math.round(Number(value) * 100), "价格");
}
function count(value: string, scale = 1) {
  requireThat(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value), "行情数量格式异常");
  return integer(Math.round(Number(value) * scale), "数量");
}
export function parseQuotes(raw: string, symbols: string[]): Quote[] {
  checkSymbols(symbols);
  const found = new Map<string, Quote>();
  for (const match of raw.matchAll(/v_([a-z]{2}\d{6})="([^"]*)"/g)) {
    const symbol = match[1];
    if (!symbols.includes(symbol)) continue;
    const f = match[2].split("~");
    requireThat(!found.has(symbol) && f.length > 48 && f[2] === symbol.slice(2), "行情重复或返回了其他股票");
    requireThat(/^\d{14}$/.test(f[30]), "行情缺少交易所时间");
    const d = f[30];
    const at = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}+08:00`;
    requireThat(
      validDay(at.slice(0, 10)) &&
        Number(d.slice(8, 10)) < 24 &&
        Number(d.slice(10, 12)) < 60 &&
        Number(d.slice(12, 14)) < 60,
      `${symbol} 行情日期或时间无效`,
    );
    found.set(symbol, {
      symbol,
      name: f[1],
      at,
      price: money(f[3]),
      bid: money(f[9] || "0"),
      ask: money(f[19] || "0"),
      bidSize: count(f[10] || "0", 100),
      askSize: count(f[20] || "0", 100),
      volume: count(f[6] || "0", volumeScale(symbol)),
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
  checkSymbols(symbols);
  const response = await request(QUOTES + symbols.join(","));
  return parseQuotes(new TextDecoder("gbk", { fatal: true }).decode(await response.arrayBuffer()), symbols);
}
export async function history(symbols: string[], limit = 320): Promise<Dataset> {
  checkSymbols(symbols);
  integer(limit, "日线数量", 1);
  requireThat(limit <= 640, "单次日线数量不超过 640");
  requireThat(!symbols.some((s) => s.startsWith("bj")), "腾讯历史日线不覆盖北交所，请导入经核实的数据文件");
  const bars: Bar[] = [];
  for (const symbol of symbols) {
    const response = await request(`${KLINES}?${new URLSearchParams({ param: `${symbol},day,,,${limit},` })}`);
    const payload: unknown = await response.json();
    validPayload(payload);
    const node = record(payload.data) ? payload.data[symbol] : undefined;
    const rows = record(node) ? node.day : undefined;
    requireThat(Array.isArray(rows) && rows.length > 0, `${symbol} 缺少不复权日线`);
    let previous = "";
    for (const row of rows) {
      requireThat(
        Array.isArray(row) && row.length >= 6 && validDay(row[0]) && row[0] > previous,
        `${symbol} 日线格式改变、日期无效、重复或乱序`,
      );
      previous = row[0];
      const bar = {
        symbol,
        day: row[0],
        open: money(row[1]),
        close: money(row[2]),
        high: money(row[3]),
        low: money(row[4]),
        volume: count(row[5], volumeScale(symbol)),
      };
      requireThat(
        bar.low > 0 && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close),
        `${symbol} ${bar.day} 日线价格范围异常`,
      );
      bars.push(bar);
    }
  }
  return { source: KLINES, adjustment: "none", marketRulesVerified: false, corporateActionsVerified: false, bars };
}
export async function isTradingDay(day: string) {
  requireThat(validDay(day), "交易日日期无效");
  const [year, month] = day.split("-").map(Number);
  const response = await request(`${CALENDAR}?${new URLSearchParams({ month: `${year}-${month}` })}`);
  const payload: unknown = await response.json();
  validPayload(payload);
  requireThat(Array.isArray(payload.data), "交易日历不可用");
  const days = new Map<string, boolean>();
  for (const row of payload.data) {
    requireThat(
      record(row) && typeof row.jyrq === "string" && /^\d{4}-\d{2}-\d{2}(?:[ T]00:00:00)?$/.test(row.jyrq),
      "交易日历日期格式异常",
    );
    const date = row.jyrq.slice(0, 10);
    requireThat(
      validDay(date) &&
        date.startsWith(day.slice(0, 7)) &&
        !days.has(date) &&
        ["0", "1", 0, 1].includes(row.jybz as string | number),
      "交易日历格式改变或重复",
    );
    days.set(date, String(row.jybz) === "1");
  }
  const expected = new Date(Date.UTC(year, month, 0)).getUTCDate();
  requireThat(
    days.size === expected &&
      Array.from({ length: expected }, (_, i) => `${day.slice(0, 7)}-${String(i + 1).padStart(2, "0")}`).every((date) =>
        days.has(date),
      ),
    "交易日历不完整",
  );
  return days.get(day)!;
}
