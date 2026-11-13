import { assessEvidence, EVIDENCE_VERSION } from "./evidence.ts";
import { requireThat, symbolCode } from "./types.ts";
import type { Command, State } from "./types.ts";
import type { Candidate, ScanReport } from "./monitor.ts";

export function validateEvidenceScan(scan: ScanReport) {
  if (scan.rule !== EVIDENCE_VERSION) return;
  requireThat(Array.isArray(scan.eligible) && Array.isArray(scan.assessments), "证据扫描缺少完整候选与依据");
  requireThat(new Set(scan.eligible.map((c) => c.symbol)).size === scan.eligible.length, "证据候选重复");
  for (const candidate of scan.eligible) {
    symbolCode(candidate.symbol);
    requireThat(candidate.evidence?.symbol === candidate.symbol, "候选证据代码不符");
    requireThat(assessEvidence(candidate.evidence, scan.at).length === 0, "候选筛选证据无效");
  }
  requireThat(
    scan.selected.every((candidate) =>
      scan.eligible!.some(
        (item) => item.symbol === candidate.symbol && JSON.stringify(item) === JSON.stringify(candidate),
      ),
    ),
    "入选候选与证据快照不符",
  );
}

function refresh(state: State, now: string) {
  const report = state.watchlistReport;
  if (!report) {
    state.watchlist = state.watchlist.filter(
      (candidate) => !state.watchlistExclusions.some((item) => item.symbol === candidate.symbol),
    );
    for (const order of Object.values(state.orders)) {
      const manual = state.watchlistExclusions.find((item) => item.symbol === order.symbol);
      if (manual && order.side === "buy" && ["pending", "approved"].includes(order.status)) {
        order.status = "expired";
        order.closedReason = `已移出自选：${manual.reason}`;
      }
    }
    return;
  }
  const selected = new Map<string, Candidate>(report.selected.map((candidate) => [candidate.symbol, candidate]));
  // Manual observations join the actionable watchlist only after passing the evidence rule.
  if (report.rule === EVIDENCE_VERSION)
    for (const manual of state.manualWatchlist) {
      const candidate = report.eligible?.find((item) => item.symbol === manual.symbol);
      if (candidate) selected.set(manual.symbol, candidate);
    }
  for (const excluded of state.watchlistExclusions) selected.delete(excluded.symbol);
  const previous = new Map(state.watchlist.map((candidate) => [candidate.symbol, candidate]));
  for (const symbol of new Set([...previous.keys(), ...selected.keys()])) {
    if (previous.has(symbol) === selected.has(symbol)) continue;
    const manual = state.watchlistExclusions.find((item) => item.symbol === symbol);
    const assessment = report.assessments?.find((item) => item.symbol === symbol);
    const reasons = selected.has(symbol)
      ? selected.get(symbol)!.reasons
      : manual
        ? [manual.reason]
        : assessment?.reasons.length
          ? assessment.reasons
          : [report.excluded.find((item) => item.symbol === symbol)?.reason ?? "本次未进入观察候选：目录或排名变化"];
    state.watchlistHistory.push({
      at: now,
      symbol,
      from: previous.has(symbol) ? "selected" : "absent",
      to: selected.has(symbol) ? "selected" : "absent",
      reasons: structuredClone(reasons),
      scan: report.id,
      ...(manual && { by: manual.by }),
    });
  }
  state.watchlist = structuredClone([...selected.values()]);
  for (const order of Object.values(state.orders)) {
    if (order.side === "buy" && ["pending", "approved"].includes(order.status) && !selected.has(order.symbol)) {
      const reason =
        state.watchlistExclusions.find((item) => item.symbol === order.symbol)?.reason ??
        report.excluded.find((item) => item.symbol === order.symbol)?.reason ??
        "本次未进入观察候选：目录或排名变化";
      order.status = "expired";
      order.closedReason = `已移出自选：${reason}`;
    }
  }
}

export function applyWatchlist(state: State, scan: ScanReport, now: string) {
  requireThat(
    state.watchlistScan?.rule !== EVIDENCE_VERSION || scan.rule === EVIDENCE_VERSION,
    "证据筛选已登记，不能静默回退基础规则",
  );
  validateEvidenceScan(scan);
  state.watchlistReport = structuredClone(scan);
  state.watchlistScan = { id: scan.id, rule: scan.rule, at: scan.at, universeSize: scan.universeSize };
  refresh(state, now);
}

export function manualWatch(state: State, command: Extract<Command, { type: "manual-watch" }>, now: string) {
  symbolCode(command.symbol);
  requireThat(command.action === "add" || command.action === "remove", "人工自选动作无效");
  requireThat(
    typeof command.reason === "string" &&
      command.reason.trim().length > 0 &&
      command.reason.length <= 4000 &&
      typeof command.by === "string" &&
      command.by.trim().length > 0,
    "人工自选需要理由与本人身份",
  );
  const before = state.watchlist.some((item) => item.symbol === command.symbol);
  state.manualWatchlist = state.manualWatchlist.filter((item) => item.symbol !== command.symbol);
  state.watchlistExclusions = state.watchlistExclusions.filter((item) => item.symbol !== command.symbol);
  const item = {
    symbol: command.symbol,
    name: command.name ?? command.symbol,
    reason: command.reason,
    by: command.by,
    at: now,
  };
  requireThat(typeof item.name === "string" && item.name.trim().length > 0, "人工自选名称无效");
  if (command.action === "add") state.manualWatchlist.push(item);
  else state.watchlistExclusions.push(item);
  requireThat(
    state.manualWatchlist.length + state.watchlistExclusions.length <= 100,
    "人工自选与排除合计不超过 100 只",
  );
  const historySize = state.watchlistHistory.length;
  refresh(state, now);
  if (historySize === state.watchlistHistory.length)
    state.watchlistHistory.push({
      at: now,
      symbol: command.symbol,
      from: before ? "selected" : "absent",
      to: state.watchlist.some((c) => c.symbol === command.symbol) ? "selected" : "absent",
      reasons: [command.reason],
      by: command.by,
    });
}
