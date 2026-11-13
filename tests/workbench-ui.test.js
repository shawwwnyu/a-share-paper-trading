// These are model tests only; they do not substitute for browser interaction QA.
import assert from "node:assert/strict";
import { test } from "node:test";
import { money, percent, filterOrders, filterCandidates, navSeries } from "../web/model.js";

test("unknown money and returns stay unknown instead of displaying zero", () => {
  assert.equal(money(null), "—");
  assert.equal(money(undefined), "—");
  assert.equal(money(10000000), "100,000.00");
  assert.equal(money(0), "0.00");
  assert.equal(percent(null), "—");
  assert.equal(percent(0.0125), "+1.25%");
});
test("filters preserve effective expiry, search safely and do not mutate API data", () => {
  const orders = [
    { id: "a", status: "approved", effectiveStatus: "expired-unrecorded", symbol: "sh600000" },
    { id: "b", status: "pending", effectiveStatus: "pending", symbol: "sz000001" },
  ];
  assert.deepEqual(
    filterOrders(orders, "pending").map((o) => o.id),
    ["b"],
  );
  assert.deepEqual(
    filterOrders(orders, "expired").map((o) => o.id),
    ["a"],
  );
  const candidates = [
    { symbol: "sh600000", name: "合成甲" },
    { symbol: "sz000001", name: "合成乙" },
  ];
  assert.deepEqual(filterCandidates(candidates, " 合成乙 "), [candidates[1]]);
  assert.deepEqual(filterCandidates(candidates, "<script>"), []);
  assert.equal(candidates.length, 2);
});
test("NAV ranges use only recorded points and never manufacture a series for an empty account", () => {
  const points = [
    { at: "2026-10-01T15:00:00+08:00", nav: 1 },
    { at: "2026-11-12T15:00:00+08:00", nav: 1.02 },
    { at: "2026-11-14T15:00:00+08:00", nav: 9 },
  ];
  assert.deepEqual(navSeries(points, 7, "2026-11-13T18:00:00+08:00"), [points[1]]);
  assert.deepEqual(navSeries([], 7, "2026-11-13T18:00:00+08:00"), []);
});
