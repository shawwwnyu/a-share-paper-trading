import { createHash } from "node:crypto";
import { screen, SCREEN_VERSION } from "./monitor.ts";
import type { MarketRow, ScanReport, Universe } from "./monitor.ts";
import { EVIDENCE_VERSION, screenWithEvidence } from "./evidence.ts";
import type { EvidenceDataset } from "./evidence.ts";
import { chinaDay, integer, requireThat, timestamp } from "./types.ts";

export type ScanInput = { universe: Universe; rows: MarketRow[]; report: ScanReport; evidence?: EvidenceDataset };
export type ScanSnapshot = ScanInput & { schema: "screening-snapshot-v1"; availableAt: string; hash: string };
export function digest(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, item]) => item !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, sorted(item)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}
export function dayNumber(day: string) {
  requireThat(typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day), "日期无效");
  const time = Date.parse(`${day}T00:00:00Z`);
  requireThat(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day, "日期无效");
  return time;
}
function checkInput(input: ScanInput, availableAt: string) {
  const { universe, rows, report } = input;
  requireThat(report?.complete && report.failures.length === 0, "扫描不完整，不能作为动态验证快照");
  requireThat(
    timestamp(availableAt) >= timestamp(report.at) && chinaDay(availableAt) === chinaDay(report.at),
    "快照可知时间无效",
  );
  requireThat(typeof universe?.source === "string" && universe.source.trim(), "历史股票池缺少来源");
  integer(universe.sourceTotal, "原始目录数量", 1);
  requireThat(
    Array.isArray(universe.symbols) &&
      universe.symbols.length > 0 &&
      universe.sourceTotal >= universe.symbols.length &&
      new Set(universe.symbols).size === universe.symbols.length &&
      universe.symbols.every((s) => /^(sh6\d{5}|sz[03]\d{5})$/.test(s)),
    "历史股票池代码或完整性无效",
  );
  requireThat(
    universe.symbols.some((s) => s.startsWith("sh")) && universe.symbols.some((s) => s.startsWith("sz")),
    "历史股票池须同时覆盖沪深",
  );
  requireThat(Array.isArray(rows), "快照缺少原始行情");
  const present = new Set(rows.map((row) => row.symbol));
  const unavailable = report.excluded.filter((item) => !present.has(item.symbol));
  const base = screen(universe.symbols, rows, [], report.at, unavailable);
  requireThat(
    base.complete && base.universeSize === report.universeSize && base.observed === report.observed,
    "历史股票池或行情覆盖不完整",
  );
  requireThat(report.rule === SCREEN_VERSION || report.rule === EVIDENCE_VERSION, "不支持的历史筛选规则版本");
  const expected = report.rule === EVIDENCE_VERSION ? screenWithEvidence(base, rows, input.evidence!, report.at) : base;
  requireThat(digest(expected) === digest(report), "筛选报告与当时原始证据或时间不一致");
}
export function sealSnapshot(input: ScanInput, availableAt: string): ScanSnapshot {
  checkInput(input, availableAt);
  const body = {
    schema: "screening-snapshot-v1" as const,
    availableAt,
    universe: input.universe,
    rows: input.rows,
    report: input.report,
    ...(input.evidence && { evidence: input.evidence }),
  };
  return structuredClone({ ...body, hash: digest(body) });
}
export function verifySnapshot(snapshot: ScanSnapshot) {
  requireThat(snapshot?.schema === "screening-snapshot-v1", "历史快照格式版本无效");
  const { hash, ...body } = snapshot;
  requireThat(typeof hash === "string" && digest(body) === hash, "历史快照校验失败，内容发生变化");
  checkInput(snapshot, snapshot.availableAt);
}
