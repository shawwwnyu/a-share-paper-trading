import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseQuotes, QUOTES } from "./market.ts";
import { tradingTime } from "./execution.ts";
import { chinaDay, requireThat, timestamp } from "./types.ts";
import type { Assessment, ScreeningRecord } from "./evidence.ts";
import type { Quote } from "./types.ts";

export const DIRECTORY = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.";
export const SCREEN_VERSION = "liquidity-momentum-v1";
export type Universe = { source: string; sourceTotal: number; symbols: string[] };
export type MarketRow = Quote & { previousClose: number; amount: number; turnover: number; pe: number };
export type Candidate = {
  symbol: string;
  name: string;
  at: string;
  price: number;
  score: number;
  reasons: string[];
  source: string;
  evidence?: ScreeningRecord;
};
export type ScanReport = {
  id: string;
  rule: string;
  at: string;
  universeSize: number;
  observed: number;
  complete: boolean;
  selected: Candidate[];
  eligible?: Candidate[];
  assessments?: Assessment[];
  excluded: { symbol: string; reason: string }[];
  failures: { symbol: string; reason: string }[];
};

async function response(url: string) {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.sina.com.cn/" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  requireThat(res.ok, `公开行情请求失败 HTTP ${res.status}`);
  return res;
}

export async function loadUniverse(
  get: (url: string) => Promise<any> = async (url) => (await response(url)).json(),
  pause: () => Promise<unknown> = () => delay(800),
  pageSize = 80,
): Promise<Universe> {
  const countUrl = DIRECTORY + "getHQNodeStockCount?node=hs_a";
  const total = Number(await get(countUrl));
  requireThat(Number.isSafeInteger(total) && total > 0, "股票目录总数无效");
  const symbols = new Set<string>();
  for (let page = 1; page <= Math.ceil(total / pageSize); page++) {
    await pause();
    const rows = await get(
      DIRECTORY +
        "getHQNodeData?" +
        new URLSearchParams({
          page: String(page),
          num: String(pageSize),
          sort: "symbol",
          asc: "1",
          node: "hs_a",
          symbol: "",
          _s_r_a: "page",
        }),
    );
    requireThat(
      Array.isArray(rows) && rows.length === Math.min(pageSize, total - (page - 1) * pageSize),
      "股票目录分页不完整",
    );
    for (const row of rows) {
      requireThat(
        typeof row?.symbol === "string" && /^(sh|sz|bj)\d{6}$/.test(row.symbol) && !symbols.has(row.symbol),
        "股票目录代码无效或分页重复",
      );
      symbols.add(row.symbol);
    }
  }
  await pause();
  requireThat(Number(await get(countUrl)) === total && symbols.size === total, "股票目录在读取期间变化或不完整");
  const included = [...symbols].filter((s) => /^(sh6\d{5}|sz[03]\d{5})$/.test(s)).sort();
  requireThat(
    included.some((s) => s.startsWith("sh")) && included.some((s) => s.startsWith("sz")),
    "股票目录未同时覆盖沪深市场",
  );
  return { source: countUrl, sourceTotal: total, symbols: included };
}

export function parseMarketRows(raw: string, symbols: string[]) {
  const rows: MarketRow[] = [];
  const failures: ScanReport["failures"] = [];
  const excluded: ScanReport["excluded"] = [];
  const fields = new Map([...raw.matchAll(/v_([a-z]{2}\d{6})="([^"]*)"/g)].map((m) => [m[1], m[2].split("~")]));
  for (const symbol of symbols) {
    try {
      const f = fields.get(symbol)!;
      // Observed on sh688827: listing-day price bands are -1. Do not weaken the fill parser for these shares.
      if (f && f[2] === symbol.slice(2) && /^[NC]/.test(f[1]) && f[47] === "-1" && f[48] === "-1") {
        excluded.push({ symbol, reason: "上市初期无涨跌停限制，排除观察候选" });
        continue;
      }
      const quote = parseQuotes(raw, [symbol])[0];
      const numeric = (index: number) => {
        requireThat(/^-?\d+(?:\.\d+)?$/.test(f[index]), `${symbol} 缺少筛选字段 ${index}`);
        const value = Number(f[index]);
        requireThat(Number.isFinite(value), "筛选数值无效");
        return value;
      };
      // Tencent amount is ten-thousand yuan; turnover is percent and PE is a ratio.
      rows.push({
        ...quote,
        previousClose: Math.round(numeric(4) * 100),
        amount: numeric(37) * 10000,
        turnover: numeric(38),
        pe: numeric(39),
      });
    } catch (error) {
      failures.push({ symbol, reason: (error as Error).message });
    }
  }
  return { rows, failures, excluded };
}

export function screen(
  symbols: string[],
  rows: MarketRow[],
  failures: ScanReport["failures"],
  now: string,
  unavailable: ScanReport["excluded"] = [],
): ScanReport {
  const day = chinaDay(now);
  const observed = new Map(rows.map((q) => [q.symbol, q]));
  const covered = new Set([...observed.keys(), ...unavailable.map((item) => item.symbol)]);
  const complete =
    new Set(symbols).size === symbols.length &&
    covered.size === symbols.length &&
    rows.length + unavailable.length === covered.size &&
    symbols.every((s) => covered.has(s)) &&
    failures.length === 0;
  const candidates: Candidate[] = [];
  const excluded: ScanReport["excluded"] = [...unavailable];
  for (const q of rows) {
    let reason = "";
    const change = (q.price / q.previousClose - 1) * 100;
    if (/ST|退|^[NC]/i.test(q.name)) reason = "风险警示、退市整理或上市初期标记";
    else if (
      chinaDay(q.at) !== day ||
      timestamp(q.at) > timestamp(now) ||
      (tradingTime(now) && timestamp(now) - timestamp(q.at) > 300000)
    )
      reason = "非当日或过期行情";
    else if (
      q.price < 300 ||
      q.previousClose <= 0 ||
      q.volume <= 0 ||
      q.bid <= 0 ||
      q.ask <= 0 ||
      q.limitUp <= 0 ||
      q.limitDown <= 0
    )
      reason = "价格、成交或盘口条件不足";
    else if (q.price >= q.limitUp || q.price <= q.limitDown) reason = "触及涨跌停";
    else if (q.amount < 100000000) reason = "成交额不足一亿元";
    else if (q.turnover < 0.5 || q.turnover > 15) reason = "换手率不在 0.5%–15%";
    else if (q.pe <= 0 || q.pe > 80) reason = "市盈率不在 0–80";
    else if (change < 1 || change > 7) reason = "当日涨幅不在 1%–7%";
    if (reason) {
      excluded.push({ symbol: q.symbol, reason });
      continue;
    }
    const score = Math.round((change + Math.min(Math.log10(q.amount / 100000000 + 1), 2)) * 100) / 100;
    candidates.push({
      symbol: q.symbol,
      name: q.name,
      at: q.at,
      price: q.price,
      score,
      source: q.source,
      reasons: [
        `当日涨幅 ${change.toFixed(2)}%`,
        `成交额 ${(q.amount / 100000000).toFixed(2)} 亿元`,
        `换手率 ${q.turnover}%`,
        `市盈率 ${q.pe}`,
        "基础观察规则，尚未证明有超额收益",
      ],
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const id = createHash("sha256")
    .update(JSON.stringify({ now, rule: SCREEN_VERSION, symbols, rows, failures }))
    .digest("hex")
    .slice(0, 24);
  return {
    id,
    rule: SCREEN_VERSION,
    at: now,
    universeSize: symbols.length,
    observed: covered.size,
    complete,
    selected: complete ? candidates.slice(0, 20) : [],
    eligible: complete ? candidates : [],
    excluded,
    failures,
  };
}

export async function scanMarket(
  universe: Universe,
  progress: (done: number, total: number) => void = () => {},
  clock = () => new Date().toISOString(),
) {
  const rows: MarketRow[] = [];
  const failures: ScanReport["failures"] = [];
  const unavailable: ScanReport["excluded"] = [];
  for (let start = 0; start < universe.symbols.length; start += 80) {
    const symbols = universe.symbols.slice(start, start + 80);
    try {
      const raw = new TextDecoder("gbk", { fatal: true }).decode(
        await (await response(QUOTES + symbols.join(","))).arrayBuffer(),
      );
      const batch = parseMarketRows(raw, symbols);
      rows.push(...batch.rows);
      failures.push(...batch.failures);
      unavailable.push(...batch.excluded);
    } catch (error) {
      failures.push(...symbols.map((symbol) => ({ symbol, reason: (error as Error).message })));
    }
    progress(Math.min(start + 80, universe.symbols.length), universe.symbols.length);
    if (start + 80 < universe.symbols.length) await delay(350);
  }
  return { report: screen(universe.symbols, rows, failures, clock(), unavailable), rows };
}
