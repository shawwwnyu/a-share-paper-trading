import assert from "node:assert/strict";
import { test } from "node:test";
import { isStaticDemo, readSnapshot, readReport } from "../web/data.js";

test("the live data adapter uses only existing read APIs and rejects failed responses", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    calls.push({ path, options });
    return { ok: true, json: async () => ({ marker: path }) };
  });
  assert.equal(isStaticDemo, false);
  assert.deepEqual(await readSnapshot(), { marker: "/api/workbench" });
  assert.deepEqual(await readReport("daily", "2026-11-13"), { marker: "/api/reports/daily/2026-11-13" });
  assert.ok(calls.every(({ options }) => options.cache === "no-store" && !options.method));
  t.mock.method(globalThis, "fetch", async () => ({ ok: false }));
  await assert.rejects(readSnapshot(), /读取暂时失败/);
  await assert.rejects(readReport("weekly", "2026-11-12"), /复盘暂不可读/);
});
