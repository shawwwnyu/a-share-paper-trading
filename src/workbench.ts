import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, emptyState } from "./ledger.ts";
import { portfolioRisk } from "./portfolio-risk.ts";
import { assessEvidence } from "./evidence.ts";
import { dayNumber } from "./scan-snapshot.ts";
import { chinaDay, integer, requireThat, timestamp } from "./types.ts";
import type { Settings } from "./config.ts";
import type { Candidate, ScanReport } from "./monitor.ts";
import type { LedgerView } from "./ledger.ts";
import type { Order } from "./types.ts";

type Dict = Record<string, unknown>;
const object = (value: unknown): Dict =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const fields = (source: Dict, keys: string[]) => Object.fromEntries(keys.map((key) => [key, number(source[key])]));
function safeReportFile(settings: Settings, path: string) {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) return false;
  const inside = relative(realpathSync(settings.reports), realpathSync(path));
  return !isAbsolute(inside) && inside !== ".." && !inside.startsWith(".." + sep);
}
function reportIndex(settings: Settings, kind: "daily" | "weekly", now: string) {
  const folder = kind === "daily" ? join(settings.reports, "daily") : settings.reports;
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && safeReportFile(settings, join(folder, name)))
    .map((name) => name.slice(0, 10))
    .filter((day) => {
      try {
        dayNumber(day);
        return day <= chinaDay(now);
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()
    .slice(0, 90)
    .map((day) => ({ day, kind, title: `${day} ${kind === "daily" ? "每日复盘" : "每周复盘"}` }));
}
function orderProjection(order: Order, active: string, now: string) {
  let effectiveStatus: string = order.status;
  if (["pending", "approved"].includes(order.status)) {
    if (timestamp(order.expiresAt) <= timestamp(now)) effectiveStatus = "expired-unrecorded";
    else if (order.strategy !== active) effectiveStatus = "strategy-changed";
  }
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    price: order.price,
    at: order.at,
    expiresAt: order.expiresAt,
    strategy: order.strategy,
    reason: order.reason,
    status: order.status,
    effectiveStatus,
    confirmedAt: order.confirmedAt ?? null,
    decision: order.decision ?? null,
    closedReason: order.closedReason ?? null,
  };
}
function candidateProjection(candidate: Candidate, now: string) {
  const record = candidate.evidence;
  const issues = assessEvidence(record, now);
  const labels = {
    industry: "行业",
    financial: "财务",
    announcements: "公告",
    trading: "交易状态",
    listing: "上市日期",
    corporateActions: "公司行为",
  };
  const allowed = {
    industry: ["classification", "name"],
    financial: ["periodEnd", "netProfit", "operatingCashFlow"],
    announcements: ["from", "through"],
    trading: ["status"],
    listing: ["listedOn"],
    corporateActions: ["from", "through"],
  };
  const facets = Object.entries(labels).map(([key, label]) => {
    const proof = object(object(record)[key]),
      value = object(proof.value);
    const values = Object.fromEntries(
      allowed[key as keyof typeof allowed].map((field) => [
        field,
        typeof value[field] === "number" ? number(value[field]) : text(value[field]),
      ]),
    );
    return {
      key,
      label,
      source: text(proof.source),
      publishedAt: text(proof.publishedAt),
      checkedAt: text(proof.checkedAt),
      validUntil: text(proof.validUntil),
      values,
      events: Array.isArray(value.events)
        ? value.events.map((event) => {
            const item = object(event);
            return {
              day: text(item.day),
              shareRatio: number(item.shareRatio),
              cashPerShare: number(item.cashPerShare),
              reference: text(item.reference),
            };
          })
        : [],
      announcements: Array.isArray(value.items)
        ? value.items.map((event) => {
            const item = object(event);
            return {
              title: text(item.title),
              publishedAt: text(item.publishedAt),
              reference: text(item.reference),
              risk: item.risk === true,
            };
          })
        : [],
    };
  });
  return {
    symbol: candidate.symbol,
    name: candidate.name,
    at: candidate.at,
    price: candidate.price,
    score: candidate.score,
    reasons: [...candidate.reasons],
    source: candidate.source,
    facets,
    issues,
    evidenceStatus: !record ? "未接入完整证据" : issues.length ? "当前证据不足或已失效" : "当前证据检查通过",
  };
}
function scanProjection(scan: ScanReport, at: string, applied: boolean) {
  return {
    id: scan.id,
    at,
    dataAt: scan.at,
    rule: scan.rule,
    complete: scan.complete,
    universeSize: scan.universeSize,
    observed: scan.observed,
    selected: scan.selected.length,
    failures: scan.failures.length,
    excluded: scan.excluded.length,
    applied,
  };
}
export function workbenchSnapshot(settings: Settings, now = new Date().toISOString(), demo = false) {
  timestamp(now);
  const warnings: string[] = [];
  let view: LedgerView = { state: emptyState(), records: [] };
  if (existsSync(settings.database)) {
    const ledger = new Ledger(settings.database, { readOnly: true });
    try {
      view = ledger.view(now);
    } finally {
      ledger.close();
    }
  }
  const state = view.state;
  if (!state.config) warnings.push("账户尚未初始化；这里不会创建账户或展示虚构余额。");
  let progress: { state: string; at: string; done: number | null; total: number | null } | null = null;
  const progressFile = join(settings.reports, "scan-progress.json");
  if (existsSync(progressFile)) {
    try {
      requireThat(safeReportFile(settings, progressFile), "扫描进度来源无效");
      const data = object(JSON.parse(readFileSync(progressFile, "utf8"))),
        time = text(data.finished || data.started);
      requireThat(
        ["running", "done", "failed"].includes(text(data.state)) && timestamp(time) <= timestamp(now),
        "扫描进度时间或状态无效",
      );
      progress = {
        state: text(data.state),
        at: time,
        done: number(data.done ?? data.observed),
        total: number(data.total),
      };
    } catch {
      warnings.push("扫描进度暂不可读；账户和持仓继续以账本为准。");
    }
  }
  const scanRecord = view.records
    .filter((r) => r.command.type === "watchlist" || r.command.type === "scan-observation")
    .at(-1);
  const scan =
    scanRecord && (scanRecord.command.type === "watchlist" || scanRecord.command.type === "scan-observation")
      ? scanRecord.command.scan
      : null;
  const latest =
    scan && scanRecord ? scanProjection(scan, scanRecord.at, scanRecord.command.type === "watchlist") : null;
  const report = state.watchlistReport;
  const candidates = (report?.eligible ?? report?.selected ?? state.watchlist)
    .slice(0, 100)
    .map((c) => candidateProjection(c, now));
  const watchlist = state.watchlist.map((c) => ({
    ...candidateProjection(c, now),
    manualReason: state.manualWatchlist.find((m) => m.symbol === c.symbol)?.reason ?? null,
  }));
  const manual = state.manualWatchlist
    .filter((m) => !state.watchlist.some((c) => c.symbol === m.symbol))
    .map((m) => ({ symbol: m.symbol, name: m.name, reason: m.reason, at: m.at }));
  const excluded = state.watchlistExclusions.map((m) => ({
    symbol: m.symbol,
    name: m.name,
    reason: m.reason,
    at: m.at,
  }));
  const checks = new Map<string, { at: string; reason: string }>();
  for (const record of view.records)
    if (record.command.type === "record-check" && record.command.check.kind === "fill-blocked")
      checks.set(record.command.check.signal, { at: record.at, reason: record.command.check.reason });
  const allOrders = Object.values(state.orders)
    .map((o) => ({ ...orderProjection(o, state.active, now), lastCheck: checks.get(o.id) ?? null }))
    .sort((a, b) => timestamp(b.at) - timestamp(a.at) || a.id.localeCompare(b.id));
  const keep = new Set([
    ...allOrders.slice(0, 200).map((o) => o.id),
    ...allOrders.filter((o) => ["pending", "approved"].includes(o.status)).map((o) => o.id),
  ]);
  const risk = portfolioRisk(state, Object.values(state.quotes), now);
  const valuation = state.points.at(-1);
  const reports = { daily: reportIndex(settings, "daily", now), weekly: reportIndex(settings, "weekly", now) };
  return {
    version: "workbench-v1",
    at: now,
    ledgerAt: state.lastAt || null,
    demo,
    permissions: { canTrade: false, canActivateStrategy: false },
    warnings,
    account: {
      initialized: !!state.config,
      cash: state.config ? state.cash : null,
      activeStrategy: state.active || null,
      valuation: valuation
        ? {
            at: valuation.at,
            equity: valuation.equity,
            cashFlow: valuation.cashFlow,
            nav: valuation.nav,
            pnl: valuation.equity - valuation.cashFlow,
          }
        : null,
    },
    summary: {
      pending: allOrders.filter((o) => o.effectiveStatus === "pending").length,
      approved: allOrders.filter((o) => o.effectiveStatus === "approved").length,
      holdings: risk.positionCount,
      fills: state.fills.length,
      watchlist: state.watchlist.length,
      orders: allOrders.length,
    },
    market: { latest, progress, appliedAt: state.watchlistScan?.at ?? null },
    candidates,
    candidateTotal: report?.eligible?.length ?? report?.selected.length ?? state.watchlist.length,
    watchlist,
    manual,
    excluded,
    orders: allOrders.filter((o) => keep.has(o.id)),
    fills: state.fills
      .slice(-100)
      .reverse()
      .map((f) => ({
        signal: f.signal,
        symbol: f.symbol,
        side: f.side,
        quantity: f.quantity,
        at: f.at,
        confirmedAt: f.confirmedAt,
        signalAt: f.signalAt,
        price: f.price,
        signalPrice: f.signalPrice,
        fees: f.fees,
        commission: f.commission,
        tax: f.tax,
        transfer: f.transfer,
        slippage: f.slippage,
        strategy: f.strategy,
      })),
    holdings: risk.positions,
    risk: state.config
      ? risk
      : {
          ...risk,
          cash: null,
          equity: null,
          market: null,
          totalBps: null,
          complete: false,
          valuationComplete: false,
          issues: ["账户尚未初始化"],
        },
    latestRisk: state.riskSnapshots.at(-1) ?? null,
    points: state.points.slice(-365).map((p) => ({ at: p.at, nav: p.nav, equity: p.equity, cashFlow: p.cashFlow })),
    reports,
  };
}
function count(value: unknown) {
  return Array.isArray(value) ? value.length : null;
}
export function workbenchReport(settings: Settings, kind: "daily" | "weekly", day: string, now: string) {
  dayNumber(day);
  requireThat(day <= chinaDay(now), "复盘日期尚未结束或来自未来");
  const file = join(settings.reports, ...(kind === "daily" ? ["daily"] : []), `${day}.json`);
  if (!safeReportFile(settings, file)) return null;
  let data: Dict;
  try {
    data = object(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error("复盘文件内容无效");
  }
  const performance = kind === "daily" ? object(data.performance) : data;
  requireThat(
    typeof performance.complete === "boolean" &&
      typeof performance.from === "string" &&
      typeof performance.to === "string",
    "复盘文件内容无效",
  );
  requireThat(timestamp(performance.to) <= timestamp(now), "复盘截止时间尚未到达");
  const workflow = object(data.workflow),
    screening = object(workflow.screening),
    signals = object(workflow.signals),
    confirmation = object(workflow.confirmation),
    execution = object(workflow.execution),
    unfilled = object(workflow.unfilled),
    risk = object(workflow.risk);
  const attribution = (value: unknown) =>
    Object.entries(object(value)).map(([strategy, row]) => ({
      strategy,
      ...fields(object(row), ["pnl", "exits", "quantity"]),
    }));
  return {
    kind,
    day,
    from: text(performance.from),
    to: text(performance.to),
    complete: performance.complete,
    openingAt: text(performance.openingAt),
    closingAt: text(performance.closingAt),
    issues: strings(performance.issues),
    recommendation: text(data.recommendation || performance.recommendation),
    performance: fields(performance, [
      "pnl",
      "cashFlow",
      "returnRate",
      "maxDrawdown",
      "realized",
      "unrealizedChange",
      "fees",
      "trades",
      "exits",
      "winRate",
      "averageWin",
      "averageLoss",
      "averageConfirmationSeconds",
    ]),
    workflow: {
      available: Object.keys(workflow).length > 0,
      coverage: text(workflow.coverage),
      screening: fields(screening, ["scans", "complete", "incomplete", "selected", "promoted", "removed"]),
      signals: fields(signals, ["created", "blocked"]),
      confirmation: fields(confirmation, [
        "count",
        "approved",
        "rejected",
        "averageSeconds",
        "medianSeconds",
        "p95Seconds",
      ]),
      execution: fields(execution, ["fills", "fees"]),
      unfilled: {
        pending: count(unfilled.pending),
        approved: count(unfilled.approved),
        expiredUnrecorded: count(unfilled.expiredUnrecorded),
        recordedExpired: count(unfilled.recordedExpired),
        attempts: number(unfilled.attempts),
        affectedOrders: number(unfilled.affectedOrders),
        byReason: Object.entries(object(unfilled.byReason)).map(([reason, value]) => ({
          reason,
          count: number(value),
        })),
      },
      risk: {
        snapshots: number(risk.snapshots),
        latestAt: text(object(risk.latest).at),
        complete: object(risk.current).complete === true,
        issues: strings(object(risk.current).issues),
      },
      realizedByEntry: attribution(workflow.realizedByEntry),
      realizedByExit: attribution(workflow.realizedByExit),
    },
  };
}
export async function startWorkbench(
  settings: Settings,
  options: { port?: number; clock?: () => string; demo?: boolean } = {},
) {
  const port = options.port ?? 8787;
  integer(port, "工作台端口");
  requireThat(port <= 65535, "工作台端口超出范围");
  const clock = options.clock ?? (() => new Date().toISOString());
  const staticFiles: Record<string, [string, string]> = {
    "/": ["index.html", "text/html"],
    "/app.js": ["app.js", "text/javascript"],
    "/model.js": ["model.js", "text/javascript"],
    "/data.js": ["data.js", "text/javascript"],
    "/style.css": ["style.css", "text/css"],
  };
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    const send = (status: number, value: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(value));
    };
    const address = server.address();
    const actualPort = address && typeof address !== "string" ? address.port : port;
    const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (
      !hosts.includes(req.headers.host ?? "") ||
      (req.headers.origin && !hosts.map((host) => `http://${host}`).includes(req.headers.origin)) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      send(403, { error: "工作台仅允许本机同源访问" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      req.resume();
      res.setHeader("Allow", "GET, HEAD");
      send(405, { error: "工作台为只读，不接受交易或账户操作" });
      return;
    }
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
      if (url.pathname === "/api/workbench") {
        send(200, workbenchSnapshot(settings, clock(), options.demo));
        return;
      }
      const reportRoute = /^\/api\/reports\/(daily|weekly)\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
      if (reportRoute) {
        try {
          const report = workbenchReport(settings, reportRoute[1] as "daily" | "weekly", reportRoute[2], clock());
          send(report ? 200 : 404, report ?? { error: "没有对应复盘记录" });
        } catch {
          send(422, { error: "复盘日期或内容无效，请核对已保存报告" });
        }
        return;
      }
      const asset = staticFiles[url.pathname];
      if (!asset) {
        send(404, { error: "未找到页面或资料" });
        return;
      }
      const body = readFileSync(fileURLToPath(new URL(`../web/${asset[0]}`, import.meta.url)));
      res.setHeader("Content-Type", asset[1] + "; charset=utf-8");
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      send(503, { error: "资料暂不可读，页面保留上次内容；请核对账户和报告是否可用" });
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}
