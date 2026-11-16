import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkbenchDemoHtml } from "../src/workbench-export.ts";

test("the portable demo contains only synthetic read models and all saved report dates", () => {
  const html = buildWorkbenchDemoHtml();
  const match = html.match(/<script id="demo-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match);
  const data = JSON.parse(match[1]);
  assert.equal(data.snapshot.demo, true);
  assert.equal(data.snapshot.permissions.canTrade, false);
  assert.equal(data.snapshot.summary.pending, 2);
  assert.equal(data.snapshot.summary.holdings, 2);
  for (const kind of ["daily", "weekly"])
    for (const entry of data.snapshot.reports[kind]) assert.ok(data.reports[`${kind}/${entry.day}`]);
  assert.ok(data.reports["daily/2026-11-13"]);
  assert.ok(data.reports["weekly/2026-11-12"]);
  assert.doesNotMatch(match[1], /demo-owner|demo\.db|paper-workbench-demo-|"database"|"by"/);
});

test("the portable demo works without imports, network requests or local-only instructions", () => {
  const html = buildWorkbenchDemoHtml();
  assert.match(html, /合成演示资料/);
  assert.match(html, /离线演示/);
  assert.doesNotMatch(
    html,
    /<script[^>]+src=|<link[^>]+stylesheet|\bimport\s|\bfetch\s*\(|本机业务接口|事实账本 · 本机访问/,
  );
  assert.doesNotMatch(html, /请在原飞书卡片处理交易决定/);
  for (const id of ["candidate-search", "order-status", "detail-dialog", "chart-range", "report-kind", "report-day"])
    assert.ok(html.includes(`id="${id}"`));
});
