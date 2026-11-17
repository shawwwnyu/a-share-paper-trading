import { money, percent, filterOrders, filterCandidates, navSeries, dateTime, labels } from "./model.js";
import { isStaticDemo, readSnapshot, readReport } from "./data.js";

const $ = (id) => document.getElementById(id);
let snapshot = null;
let busy = false;
let previousFocus = null;
let reportSequence = 0;
const node = (tag, text = "", className = "") => {
  const element = document.createElement(tag);
  if (text !== null && text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
};
const show = (id, value) => {
  $(id).textContent = value;
};
const amount = (id, value) => {
  show(id, money(value));
  $(id).classList.toggle("positive", value > 0);
  $(id).classList.toggle("negative", value < 0);
};
const badge = (text) =>
  node("span", text, /缺|不足|失效|待清理|未接入|待本人|风险/.test(text) ? "pill caution" : "pill");
const side = (value) => (value === "buy" ? "买入" : "卖出");
function notice(container, text) {
  container.append(node("p", text, "notice"));
}
function cell(row, content, numeric = false) {
  const td = node("td", "", numeric ? "right" : "");
  if (content instanceof Node) td.append(content);
  else td.textContent = String(content ?? "—");
  row.append(td);
  return td;
}
function stock(symbol, name = "") {
  const result = node("div", name || symbol);
  if (name) result.append(node("small", symbol));
  return result;
}
function button(label, click) {
  const result = node("button", label, "text-button");
  result.type = "button";
  result.addEventListener("click", click);
  return result;
}
function openDialog(title, content) {
  previousFocus = document.activeElement;
  show("detail-title", title);
  $("detail-body").className = "dialog-body";
  $("detail-body").replaceChildren(content);
  $("detail-dialog").showModal();
}
$("detail-close").addEventListener("click", () => $("detail-dialog").close());
$("detail-dialog").addEventListener("close", () => previousFocus?.focus());
function fields(data) {
  const dl = node("dl", "", "detail-fields");
  for (const [label, value] of data) {
    const row = node("div");
    row.append(node("dt", label), node("dd", value ?? "未记录"));
    dl.append(row);
  }
  return dl;
}
function candidateDetail(candidate) {
  const body = node("div");
  body.append(badge(candidate.evidenceStatus));
  const list = node("ul", "", "detail-list");
  for (const reason of candidate.reasons) list.append(node("li", reason));
  body.append(list);
  for (const issue of candidate.issues) notice(body, issue);
  const names = {
    classification: "分类体系",
    name: "行业名称",
    periodEnd: "财务期末",
    netProfit: "净利润 / 元",
    operatingCashFlow: "经营现金流 / 元",
    from: "覆盖起日",
    through: "核实至",
    status: "交易状态",
    listedOn: "上市日期",
  };
  const statuses = { trading: "正常交易", suspended: "停牌", delisted: "退市" };
  const grid = node("div", "", "evidence-grid");
  for (const facet of candidate.facets) {
    const card = node("article", "", "evidence-card");
    card.append(node("h3", facet.label));
    for (const [key, value] of Object.entries(facet.values))
      card.append(node("p", `${names[key] ?? key}：${(statuses[value] ?? value) || "未提供"}`));
    card.append(
      node("p", `来源：${facet.source || "未提供"}`),
      node("p", `公开：${dateTime(facet.publishedAt)}`),
      node("p", `核实：${dateTime(facet.checkedAt)}`),
      node("p", `有效至：${dateTime(facet.validUntil)}`),
    );
    for (const announcement of facet.announcements)
      card.append(
        node(
          "p",
          `${announcement.risk ? "风险公告" : "已核对公告"}：${announcement.title}；${dateTime(announcement.publishedAt)}；${announcement.reference}`,
        ),
      );
    for (const event of facet.events)
      card.append(
        node(
          "p",
          `${event.day}：股份比例 ${event.shareRatio}，每股净红利 ${money(event.cashPerShare)} 元；${event.reference}`,
        ),
      );
    grid.append(card);
  }
  body.append(
    grid,
    node("p", "这些资料用于解释当时的观察依据，证据通过不代表收益有效，也不代表买入决定。", "small muted"),
  );
  openDialog(`${candidate.symbol} ${candidate.name}`, body);
}
function renderCandidates() {
  const rows = filterCandidates(snapshot.candidates, $("candidate-search").value);
  $("candidate-rows").replaceChildren();
  for (const candidate of rows) {
    const row = node("tr");
    cell(row, stock(candidate.symbol, candidate.name));
    cell(row, money(candidate.price), true);
    cell(row, candidate.score?.toFixed(2) ?? "—", true);
    cell(row, badge(candidate.evidenceStatus));
    cell(row, dateTime(candidate.at));
    cell(
      row,
      button("查看依据 ↗", () => candidateDetail(candidate)),
    );
    $("candidate-rows").append(row);
  }
  show("candidate-count", `当前 ${rows.length} 只 / 合格候选 ${snapshot.candidateTotal} 只`);
  $("candidate-empty").hidden = rows.length > 0;
}
function renderWatchlist() {
  show("watch-count", `${snapshot.watchlist.length} 只自选`);
  const cards = $("watch-cards");
  cards.replaceChildren();
  for (const candidate of snapshot.watchlist) {
    const card = node("article", "", "watch-card"),
      top = node("div", "", "watch-top");
    top.append(stock(candidate.symbol, candidate.name), badge(candidate.manualReason ? "人工保留" : "规则入选"));
    card.append(top, node("p", candidate.reasons.slice(0, 2).join("；")), node("small", candidate.evidenceStatus));
    if (candidate.manualReason) card.append(node("p", candidate.manualReason));
    card.append(button("展开观察依据 ↗", () => candidateDetail(candidate)));
    cards.append(card);
  }
  if (!snapshot.watchlist.length)
    cards.append(node("p", "尚无可跟踪自选；完整扫描和合格证据不会由页面刷新生成。", "empty"));
  for (const [id, rows, empty] of [
    ["manual-list", snapshot.manual, "没有人工仅观察记录。"],
    ["excluded-list", snapshot.excluded, "没有本人排除记录。"],
  ]) {
    const container = $(id);
    container.replaceChildren();
    for (const item of rows) {
      const entry = node("div", "", "list-entry");
      entry.append(stock(item.symbol, item.name), node("p", item.reason), node("p", dateTime(item.at)));
      container.append(entry);
    }
    if (!rows.length) container.append(node("p", empty, "empty"));
  }
}
function renderOrders() {
  const rows = filterOrders(snapshot.orders, $("order-status").value);
  $("order-rows").replaceChildren();
  for (const order of rows) {
    const row = node("tr");
    cell(row, stock(order.symbol, `${order.symbol} · ${side(order.side)}`));
    cell(row, `${order.quantity} 股`, true);
    cell(row, money(order.price), true);
    cell(row, badge(labels[order.effectiveStatus] ?? order.effectiveStatus));
    cell(row, order.strategy);
    cell(row, dateTime(order.expiresAt));
    cell(
      row,
      button("查看记录 ↗", () =>
        openDialog(
          `${order.symbol} · ${side(order.side)}`,
          fields([
            ["委托编号", order.id],
            ["实际账本状态", labels[order.status]],
            ["截至当前状态", labels[order.effectiveStatus]],
            ["信号时间", dateTime(order.at)],
            ["本人决定", order.decision === null ? "尚未确认" : order.decision ? "同意模拟交易" : "拒绝模拟交易"],
            ["决定时间", dateTime(order.confirmedAt)],
            ["有效至", dateTime(order.expiresAt)],
            [
              "最近未成交检查",
              order.lastCheck ? `${dateTime(order.lastCheck.at)} · ${order.lastCheck.reason}` : "尚未记录",
            ],
            ["建议依据", order.reason],
            ["结束原因", order.closedReason ?? "尚未结束；确认后仍须满足有效行情、现金、T+1 与盘口条件"],
          ]),
        ),
      ),
    );
    $("order-rows").append(row);
  }
  show("order-count", `当前显示 ${rows.length} 条 / 已记录 ${snapshot.summary.orders} 条`);
  $("order-empty").hidden = rows.length > 0;
}
function renderHoldings() {
  const risk = snapshot.risk;
  show("position-count", snapshot.account.initialized ? `${risk.positionCount} 种` : "尚未初始化");
  show(
    "risk-coverage",
    risk.complete
      ? "本次风险估值资料齐全；实际仓位不包含尚未成交的确认。"
      : "当前风险估值资料不足，缺失市值和仓位显示未知；保留最近已记录快照。",
  );
  $("holding-rows").replaceChildren();
  for (const holding of snapshot.holdings) {
    const row = node("tr");
    cell(row, stock(holding.symbol, holding.industry || "行业未登记"));
    cell(row, `${holding.quantity} 股`, true);
    cell(row, `${holding.sellable} 股`, true);
    cell(row, money(holding.cost), true);
    cell(row, money(holding.value), true);
    cell(row, percent(holding.weightBps === null ? null : holding.weightBps / 10000), true);
    cell(row, dateTime(holding.quoteAt));
    $("holding-rows").append(row);
  }
  $("holding-empty").hidden = snapshot.holdings.length > 0;
  const alerts = $("risk-alerts");
  alerts.replaceChildren();
  for (const issue of risk.issues) notice(alerts, issue);
  for (const alert of risk.alerts) notice(alerts, `${alert.symbol ?? "组合"}：${alert.reason}`);
  if (!risk.complete && snapshot.latestRisk)
    notice(
      alerts,
      `最近风险快照：${dateTime(snapshot.latestRisk.at)}。以下提示保留其原始时点：${snapshot.latestRisk.alerts.map((alert) => alert.reason).join("；") || "当时未记录触发提示"}`,
    );
  $("fill-rows").replaceChildren();
  for (const fill of snapshot.fills) {
    const row = node("tr");
    cell(row, dateTime(fill.at));
    cell(row, `${fill.symbol} · ${side(fill.side)}`);
    cell(row, `${fill.quantity} 股`, true);
    cell(row, money(fill.price), true);
    cell(row, money(fill.fees), true);
    cell(row, fill.strategy);
    cell(
      row,
      button("费用明细 ↗", () =>
        openDialog(
          `${fill.symbol} · 已记录成交`,
          fields([
            ["信号时间", dateTime(fill.signalAt)],
            ["本人确认", dateTime(fill.confirmedAt)],
            ["实际成交", dateTime(fill.at)],
            ["信号价", `${money(fill.signalPrice)} 元`],
            ["成交价", `${money(fill.price)} 元`],
            ["佣金", `${money(fill.commission)} 元`],
            ["税费", `${money(fill.tax)} 元`],
            ["过户费", `${money(fill.transfer)} 元`],
            ["费用合计", `${money(fill.fees)} 元`],
            ["不利滑点金额", `${money(fill.slippage)} 元`],
          ]),
        ),
      ),
    );
    $("fill-rows").append(row);
  }
  $("fill-empty").hidden = snapshot.fills.length > 0;
  show("fill-count", `累计 ${snapshot.summary.fills} 笔，展示最近 ${snapshot.fills.length} 笔`);
}
function renderChart() {
  const container = $("chart");
  container.replaceChildren();
  const points = navSeries(snapshot.points, Number($("chart-range").value), snapshot.at);
  if (!points.length) {
    container.append(node("p", "这个区间还没有已记录估值点。", "empty"));
    return;
  }
  const svgNode = (tag, attrs, text = "") => {
    const result = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) result.setAttribute(key, String(value));
    if (text) result.textContent = text;
    return result;
  };
  const width = 650,
    height = 200,
    left = 45,
    right = 15,
    top = 15,
    bottom = 30;
  const values = points.map((p) => p.nav),
    low = Math.min(...values),
    high = Math.max(...values);
  const pad = Math.max((high - low) * 0.15, 0.001),
    min = low - pad,
    max = high + pad;
  const x = (i) => left + (points.length > 1 ? i / (points.length - 1) : 0.5) * (width - left - right);
  const y = (nav) => top + ((max - nav) / (max - min)) * (height - top - bottom);
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${points.length} 个已记录净值点，最近单位净值 ${points.at(-1).nav.toFixed(4)}`,
  });
  for (let i = 0; i < 3; i++) {
    const nav = min + ((max - min) * i) / 2,
      py = y(nav);
    svg.append(
      svgNode("line", { x1: left, x2: width - right, y1: py, y2: py, class: "grid-line" }),
      svgNode("text", { x: 0, y: py + 4 }, nav.toFixed(3)),
    );
  }
  svg.append(svgNode("polyline", { points: points.map((p, i) => `${x(i)},${y(p.nav)}`).join(" "), class: "nav-line" }));
  const last = points.at(-1);
  const dot = svgNode("circle", { cx: x(points.length - 1), cy: y(last.nav), r: 4.5, class: "nav-point" });
  dot.append(svgNode("title", {}, `${dateTime(last.at)} · 净值 ${last.nav.toFixed(4)}`));
  svg.append(dot);
  svg.append(
    svgNode("text", { x: left, y: height - 7 }, dateTime(points[0].at, true)),
    svgNode("text", { x: width - right, y: height - 7, "text-anchor": "end" }, dateTime(last.at, true)),
  );
  container.append(svg);
}
function renderReportOptions() {
  const kind = $("report-kind").value,
    old = $("report-day").value,
    options = snapshot.reports[kind];
  $("report-day").replaceChildren();
  for (const item of options) {
    const option = node("option", item.title);
    option.value = item.day;
    $("report-day").append(option);
  }
  if (options.some((item) => item.day === old)) $("report-day").value = old;
  $("report-load").disabled = !options.length;
  $("report-day").disabled = !options.length;
}
function reportMetric(label, value) {
  const result = node("div", "", "report-metric");
  result.append(node("span", label), node("strong", value));
  return result;
}
async function loadReport() {
  const sequence = ++reportSequence,
    day = $("report-day").value,
    kind = $("report-kind").value;
  show("report-status", "");
  if (!day) {
    $("report-content").replaceChildren(node("p", "当前类型还没有保存的复盘。", "empty"));
    return;
  }
  $("report-load").disabled = true;
  show("report-status", "正在读取已保存复盘…");
  try {
    const report = await readReport(kind, day);
    if (sequence !== reportSequence) return;
    const body = node("div", "", "report-content"),
      heading = node("div", "", "report-title");
    heading.append(
      node("h2", `${day} · ${kind === "daily" ? "每日复盘" : "每周复盘"}`),
      badge(report.complete ? "资金资料齐全" : "资金资料不足"),
    );
    body.append(
      heading,
      node("p", `${dateTime(report.from)} 至 ${dateTime(report.to)}，以这次保存的截止时点为准。`, "small muted"),
    );
    const metrics = node("div", "", "report-metrics");
    metrics.append(
      reportMetric("本期盈亏 / 元", money(report.performance.pnl)),
      reportMetric("现金流调整后收益", percent(report.performance.returnRate)),
      reportMetric("已记录点最大回撤", percent(report.performance.maxDrawdown)),
      reportMetric("已计入盈亏的费用 / 元", money(report.performance.fees)),
    );
    body.append(metrics, node("p", report.recommendation, "report-note"));
    for (const issue of report.issues) notice(body, issue);
    if (report.workflow.available) {
      const w = report.workflow,
        grid = node("div", "", "report-detail");
      const blocks = [
        [
          "筛选与信号",
          [
            `完整扫描 ${w.screening.complete ?? "—"} 次，不完整 ${w.screening.incomplete ?? "—"} 次`,
            `登记信号 ${w.signals.created ?? "—"} 笔，阻止生成 ${w.signals.blocked ?? "—"} 次`,
          ],
        ],
        [
          "确认与未成交",
          [
            `确认 ${w.confirmation.count ?? "—"} 笔，平均延迟 ${w.confirmation.averageSeconds === null ? "无样本" : w.confirmation.averageSeconds.toFixed(1) + " 秒"}`,
            `检查未通过 ${w.unfilled.attempts ?? "—"} 次，涉及 ${w.unfilled.affectedOrders ?? "—"} 笔委托`,
            ...w.unfilled.byReason.map((r) => `${r.reason}：${r.count} 次`),
          ],
        ],
        [
          "持仓风险",
          [
            `记录快照 ${w.risk.snapshots ?? "—"} 次，最近 ${dateTime(w.risk.latestAt)}`,
            `截止时点风险资料${w.risk.complete ? "齐全" : "不足"}`,
            ...w.risk.issues,
          ],
        ],
        [
          "实际执行",
          [
            `成交 ${w.execution.fills ?? "—"} 笔，费用 ${money(w.execution.fees)} 元`,
            `截止时点待确认 ${w.unfilled.pending ?? "—"} 笔，已确认待成交 ${w.unfilled.approved ?? "—"} 笔`,
          ],
        ],
      ];
      for (const [title, lines] of blocks) {
        const card = node("article");
        card.append(node("h3", title));
        for (const line of lines) card.append(node("p", line));
        grid.append(card);
      }
      body.append(
        grid,
        node("h3", "入场与退出策略归因"),
        node("p", "同一份已实现交易盈亏的两种分组，不可相加。", "small muted"),
      );
      for (const [label, rows] of [
        ["入场", w.realizedByEntry],
        ["退出", w.realizedByExit],
      ]) {
        if (!rows.length) body.append(node("p", `${label}策略尚无本期已实现归因。`, "small muted"));
        for (const row of rows)
          body.append(
            node("p", `${label}策略 ${row.strategy}：${money(row.pnl)} 元，卖出归因 ${row.exits} 笔。`, "small muted"),
          );
      }
      body.append(node("p", w.coverage, "panel-foot"));
    } else body.append(node("p", "这份历史报告尚未保存工作流统计，不能补推当时未记录的原因。", "small muted"));
    $("report-content").replaceChildren(body);
    show("report-status", "");
  } catch (error) {
    if (sequence === reportSequence) show("report-status", error.message);
  } finally {
    if (sequence === reportSequence) $("report-load").disabled = false;
  }
}
function renderSnapshot() {
  amount("equity", snapshot.account.valuation?.equity);
  amount("cash", snapshot.account.cash);
  amount("pnl", snapshot.account.valuation?.pnl);
  $("equity").classList.remove("positive", "negative");
  $("cash").classList.remove("positive", "negative");
  show(
    "valuation-at",
    snapshot.account.valuation ? `估值时间 ${dateTime(snapshot.account.valuation.at)}` : "尚无估值记录",
  );
  show("pending", snapshot.account.initialized ? snapshot.summary.pending : "—");
  show("approved", `另有 ${snapshot.summary.approved} 笔已确认待成交`);
  show("strategy", snapshot.account.activeStrategy || "尚未登记");
  show("updated", `${isStaticDemo ? "演示时点" : "读取于"} ${dateTime(snapshot.at)}`);
  $("warnings").replaceChildren();
  for (const warning of snapshot.warnings) notice($("warnings"), warning);
  if (snapshot.demo) notice($("warnings"), "合成演示资料 · 用于核对工作台交互，不代表真实市场或账户收益。");
  const market = snapshot.market.latest,
    progress = snapshot.market.progress;
  show("coverage-title", market ? (market.complete ? "目录行情已完整覆盖" : "最近扫描尚未完整") : "尚无已记录扫描");
  show("observed", market ? market.observed.toLocaleString("zh-CN") : "—");
  show("universe", ` / ${market ? market.universeSize.toLocaleString("zh-CN") : "—"} 只`);
  $("coverage").value = market?.universeSize ? (market.observed * 100) / market.universeSize : 0;
  show("scan-at", dateTime(market?.dataAt));
  show(
    "coverage-note",
    market
      ? `入选 ${market.selected} 只，读取失败 ${market.failures} 只。${market.applied ? "已登记自选，仍需本人确认交易。" : "保留此前自选。"}`
      : "覆盖只代表相对已读取目录的完整性，不代表策略效果。",
  );
  if (progress?.state === "running")
    notice(
      $("warnings"),
      `扫描进行中：${progress.done ?? "待定"} / ${progress.total ?? "待定"}，进度记录于 ${dateTime(progress.at)}；下方保留上次已登记结果。`,
    );
  if (progress?.state === "failed")
    notice($("warnings"), `最近一次扫描未完成，进度记录于 ${dateTime(progress.at)}；已登记资产和自选继续保留。`);
  renderChart();
  renderCandidates();
  renderWatchlist();
  renderOrders();
  renderHoldings();
  renderReportOptions();
}
async function refresh() {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true;
  show("connection", isStaticDemo ? "正在读取内置合成演示资料…" : "正在读取本机账本与报告…");
  $("connection").classList.remove("error");
  try {
    snapshot = await readSnapshot();
    renderSnapshot();
    show(
      "connection",
      isStaticDemo
        ? `合成演示资料 · 固定时点 ${dateTime(snapshot.at)}。刷新仅重载演示，未连接账户或实时行情。`
        : `账本记录截至 ${dateTime(snapshot.ledgerAt)}。刷新仅读取，不代表抓取了新行情。`,
    );
    await loadReport();
  } catch (error) {
    show("connection", error.message || "无法连接本机工作台，保留上次成功内容。");
    $("connection").classList.add("error");
  } finally {
    busy = false;
    $("refresh").disabled = false;
  }
}
$("refresh").addEventListener("click", refresh);
$("candidate-search").addEventListener("input", () => {
  if (snapshot) renderCandidates();
});
$("order-status").addEventListener("change", () => {
  if (snapshot) renderOrders();
});
$("chart-range").addEventListener("change", () => {
  if (snapshot) renderChart();
});
$("report-kind").addEventListener("change", () => {
  if (snapshot) {
    renderReportOptions();
    loadReport();
  }
});
$("report-load").addEventListener("click", loadReport);
refresh();

function markNavigation() {
  const current = location.hash || "#overview";
  for (const link of document.querySelectorAll(".sidebar nav a")) {
    if (link.getAttribute("href") === current) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", markNavigation);
markNavigation();
