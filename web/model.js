const decimals = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (value) =>
  typeof value === "number" && Number.isFinite(value) ? decimals.format(value / 100) : "—";
export const percent = (value) =>
  typeof value === "number" && Number.isFinite(value) ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%` : "—";
export const filterOrders = (rows, status) =>
  status === "all"
    ? rows
    : rows.filter((row) =>
        status === "expired"
          ? ["expired", "expired-unrecorded", "strategy-changed"].includes(row.effectiveStatus)
          : row.effectiveStatus === status,
      );
export function filterCandidates(rows, query) {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter((row) => `${row.symbol} ${row.name}`.toLocaleLowerCase().includes(search));
}
export function navSeries(points, days, asOf) {
  const end = Date.parse(asOf),
    start = days ? end - days * 86400000 : -Infinity;
  return points.filter(
    (point) =>
      Number.isFinite(point.nav) && point.nav > 0 && Date.parse(point.at) >= start && Date.parse(point.at) <= end,
  );
}
export function dateTime(value, compact = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(compact ? {} : { second: "2-digit" }),
    hour12: false,
  }).format(new Date(value));
}
export const labels = {
  pending: "待本人确认",
  approved: "已确认待成交",
  rejected: "本人拒绝",
  filled: "已成交",
  expired: "已记账过期",
  "expired-unrecorded": "已到期，待清理",
  "strategy-changed": "策略已变，待清理",
};
