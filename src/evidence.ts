import { createHash } from "node:crypto";
import { chinaDay, requireThat, symbolCode, timestamp } from "./types.ts";
import type { State } from "./types.ts";
import type { MarketRow, ScanReport } from "./monitor.ts";

export const EVIDENCE_VERSION = "liquidity-momentum-evidence-v2";
const DAY = 86400000;
export type Evidence<T> = { source: string; publishedAt: string; checkedAt: string; validUntil: string; value: T };
export type ActionEvidence = { day: string; shareRatio: number; cashPerShare: number; reference: string };
export type ScreeningRecord = {
  symbol: string;
  industry?: Evidence<{ classification: string; name: string }>;
  financial?: Evidence<{ periodEnd: string; netProfit: number; operatingCashFlow: number }>;
  announcements?: Evidence<{
    from: string;
    through: string;
    items: { title: string; publishedAt: string; reference: string; risk: boolean }[];
  }>;
  trading?: Evidence<{ status: "trading" | "suspended" | "delisted" }>;
  listing?: Evidence<{ listedOn: string }>;
  corporateActions?: Evidence<{ from: string; through: string; events: ActionEvidence[] }>;
};
export type EvidenceDataset = { records: ScreeningRecord[] };
export type Assessment = { symbol: string; qualified: boolean; reasons: string[]; evidence?: ScreeningRecord };

const object = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
function dayTime(value: string) {
  requireThat(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "日期无效");
  const time = Date.parse(`${value}T00:00:00Z`);
  requireThat(Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value, "日期无效");
  return time;
}
function proof<T>(item: Evidence<T> | undefined, now: string, maxDays: number): T {
  requireThat(object(item), "证据缺失");
  requireThat(text(item!.source), "证据缺少来源");
  const checked = timestamp(item!.checkedAt);
  const published = timestamp(item!.publishedAt);
  const until = timestamp(item!.validUntil);
  requireThat(published <= checked && checked <= timestamp(now), "证据时间来自未来或顺序错误");
  requireThat(until > timestamp(now), "证据已过期");
  requireThat(until > checked && until - checked <= maxDays * DAY, "证据时效超出上限");
  requireThat(object(item!.value), "证据值缺失或格式错误");
  return item!.value;
}
function coverage(from: string, through: string, now: string, days: number, listedOn?: string) {
  const current = dayTime(chinaDay(now));
  const start = dayTime(from);
  const end = dayTime(through);
  const required = Math.max(current - days * DAY, listedOn ? dayTime(listedOn) : -Infinity);
  requireThat(start <= required && end === current, "覆盖区间不足，须核实到今天");
}

export function assessEvidence(record: ScreeningRecord | undefined, now: string): string[] {
  if (!object(record)) return ["筛选证据缺失"];
  const reasons: string[] = [];
  const check = (label: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      reasons.push(`${label}：${(error as Error).message}`);
    }
  };
  check("行业", () => {
    const value = proof(record!.industry, now, 366);
    requireThat(text(value.classification) && text(value.name), "行业分类或名称缺失");
  });
  check("财务", () => {
    const value = proof(record!.financial, now, 30);
    const end = dayTime(value.periodEnd);
    requireThat(end <= dayTime(chinaDay(record!.financial!.publishedAt)), "财务期末晚于公告时间");
    requireThat(end <= dayTime(chinaDay(now)) && dayTime(chinaDay(now)) - end <= 185 * DAY, "财务报告过旧或来自未来");
    requireThat(Number.isFinite(value.netProfit) && value.netProfit > 0, "净利润缺失或非正");
    requireThat(Number.isFinite(value.operatingCashFlow) && value.operatingCashFlow > 0, "经营现金流缺失或非正");
  });
  check("上市日期", () => {
    const value = proof(record!.listing, now, 366);
    requireThat(dayTime(chinaDay(now)) - dayTime(value.listedOn) >= 60 * DAY, "上市日期无效或不足 60 个自然日");
  });
  check("交易状态", () => {
    const value = proof(record!.trading, now, 1);
    requireThat(value.status === "trading", "停牌、退市或未知交易状态");
    requireThat(chinaDay(record!.trading!.checkedAt) === chinaDay(now), "交易状态须当日核实");
  });
  check("公告", () => {
    const value = proof(record!.announcements, now, 1);
    coverage(value.from, value.through, now, 30, record!.listing?.value?.listedOn);
    requireThat(chinaDay(record!.announcements!.checkedAt) === chinaDay(now), "公告须当日核实");
    requireThat(Array.isArray(value.items), "公告列表缺失，空列表也须明确核实覆盖");
    for (const item of value.items) {
      requireThat(
        object(item) && text(item.title) && text(item.reference) && typeof item.risk === "boolean",
        "公告内容或风险核对缺失",
      );
      requireThat(
        timestamp(item.publishedAt) <= timestamp(record!.announcements!.checkedAt) &&
          chinaDay(item.publishedAt) >= value.from &&
          chinaDay(item.publishedAt) <= value.through,
        "公告时间超出当时已知覆盖",
      );
      requireThat(!item.risk, `存在待处理风险公告：${item.title}`);
    }
  });
  check("公司行为", () => {
    const value = proof(record!.corporateActions, now, 1);
    coverage(value.from, value.through, now, 366, record!.listing?.value?.listedOn);
    requireThat(chinaDay(record!.corporateActions!.checkedAt) === chinaDay(now), "公司行为须当日核实");
    requireThat(Array.isArray(value.events), "公司行为列表缺失，空列表也须明确核实覆盖");
    const days = new Set<string>();
    for (const event of value.events) {
      requireThat(
        object(event) &&
          dayTime(event.day) >= dayTime(value.from) &&
          event.day <= value.through &&
          !days.has(event.day),
        "公司行为日期无效、重复或超出覆盖",
      );
      requireThat(
        text(event.reference) &&
          Number.isFinite(event.shareRatio) &&
          event.shareRatio > 0 &&
          Number.isSafeInteger(event.cashPerShare) &&
          event.cashPerShare >= 0,
        "公司行为来源或数值无效",
      );
      days.add(event.day);
    }
  });
  return reasons;
}

export function screenWithEvidence(
  base: ScanReport,
  rows: MarketRow[],
  data: EvidenceDataset,
  now: string,
): ScanReport {
  requireThat(object(data) && Array.isArray(data.records), "筛选证据文件需要 records 列表");
  requireThat(timestamp(base.at) === timestamp(now), "证据筛选须使用本次扫描时间");
  const records = new Map<string, ScreeningRecord>();
  for (const record of data.records) {
    requireThat(object(record), "筛选证据记录无效");
    symbolCode(record.symbol);
    requireThat(!records.has(record.symbol), "筛选证据股票重复");
    records.set(record.symbol, record);
  }
  const assessments: Assessment[] = rows.map((row) => {
    const evidence = records.get(row.symbol);
    const reasons = assessEvidence(evidence, now);
    const basic = base.excluded.find((item) => item.symbol === row.symbol);
    if (basic) reasons.unshift(basic.reason);
    return {
      symbol: row.symbol,
      qualified: !reasons.length,
      reasons,
      ...(evidence && { evidence: structuredClone(evidence) }),
    };
  });
  const eligible = (base.eligible ?? base.selected).flatMap((candidate) => {
    const assessment = assessments.find((item) => item.symbol === candidate.symbol);
    if (!assessment?.qualified) return [];
    const evidence = assessment.evidence!;
    return [
      {
        ...candidate,
        evidence,
        reasons: [
          ...candidate.reasons,
          `行业：${evidence.industry!.value.classification} / ${evidence.industry!.value.name}`,
          `财务期末 ${evidence.financial!.value.periodEnd}，利润与经营现金流为正`,
          "公告、交易状态和公司行为已按来源当日核对；仍为待验证观察规则",
        ],
      },
    ];
  });
  const id = createHash("sha256")
    .update(JSON.stringify({ base: base.id, rule: EVIDENCE_VERSION, data }))
    .digest("hex")
    .slice(0, 24);
  return {
    ...base,
    id,
    rule: EVIDENCE_VERSION,
    eligible,
    selected: base.complete ? eligible.slice(0, 20) : [],
    assessments,
    excluded: [
      ...base.excluded,
      ...assessments
        .filter((a) => !a.qualified && !base.excluded.some((b) => b.symbol === a.symbol))
        .map((a) => ({ symbol: a.symbol, reason: a.reasons.join("；") })),
    ],
  };
}

export function checkEvidenceBuy(state: State, symbol: string, now: string) {
  requireThat(!state.watchlistExclusions.some((item) => item.symbol === symbol), "已由本人排除自选，暂停买入");
  if (state.watchlistScan?.rule !== EVIDENCE_VERSION) return;
  requireThat(chinaDay(state.watchlistScan.at) === chinaDay(now), "筛选证据扫描已过期，须重新扫描");
  const candidate = state.watchlist.find((item) => item.symbol === symbol);
  requireThat(candidate?.evidence?.symbol === symbol, "买入缺少有效自选筛选证据");
  const reasons = assessEvidence(candidate.evidence, now);
  requireThat(!reasons.length, reasons.join("；"));
  for (const event of candidate.evidence.corporateActions!.value.events) {
    requireThat(
      state.corporateActions.some(
        (record) =>
          record.symbol === symbol &&
          record.day === event.day &&
          record.shareRatio === event.shareRatio &&
          record.cashPerShare === event.cashPerShare,
      ),
      "公司行为尚未核对登记到账本，暂停新增买入",
    );
  }
  if (state.config?.risk?.maxIndustryBps !== undefined)
    requireThat(
      state.config.risk.industries?.[symbol] === candidate.evidence.industry!.value.name,
      "行业证据与账本冻结分类不符，暂停买入并核对",
    );
}
