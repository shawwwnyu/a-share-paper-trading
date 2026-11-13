// Failure mode: malformed source data or incorrect share units silently enter the market feed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { history, isTradingDay, parseQuotes, quotes } from "../src/market.ts";

function snapshot(symbol = "sh600000", fields: Record<number, string> = {}) {
  const f = Array(60).fill("0");
  Object.assign(f, {
    1: "fixture",
    2: symbol.slice(2),
    3: "10.120",
    6: "12345",
    9: "10.11",
    10: "2",
    19: "10.12",
    20: "3",
    30: "20261113100000",
    47: "11",
    48: "9",
    ...fields,
  });
  return `v_${symbol}="${f.join("~")}";`;
}
const bar = ["2026-11-12", "10.000", "10.120", "10.200", "9.900", "12345.000"];
const calendar = (month = "2026-11", count = 30) =>
  Array.from({ length: count }, (_, i) => ({
    jyrq: `${month}-${String(i + 1).padStart(2, "0")}`,
    jybz: i === 0 ? "0" : "1",
  }));

for (const symbol of ["sh600000", "sz000001", "sz300001", "sh688981", "sh689009"]) {
  test(`${symbol} uses shares for STAR volume and lots for the order book`, async (t) => {
    const expected = symbol.startsWith("sh68") ? 12345 : 1234500;
    const q = parseQuotes(snapshot(symbol), [symbol])[0];
    assert.equal(q.volume, expected);
    assert.equal(q.bidSize, 200);
    assert.equal(q.askSize, 300);
    assert.equal(q.price, 1012);
    t.mock.method(globalThis, "fetch", async () => Response.json({ code: 0, data: { [symbol]: { day: [bar] } } }));
    assert.equal((await history([symbol])).bars[0].volume, expected);
  });
}

for (const at of ["20260230100000", "20261301100000", "20261113240000", "20261113106000", "20261113100060"]) {
  test(`rejects impossible quote time ${at}`, () => {
    assert.throws(() => parseQuotes(snapshot("sh600000", { 30: at }), ["sh600000"]), /时间|日期/);
  });
}

test("rejects duplicate requests and missing, duplicate or mismatched quote responses", async (t) => {
  const raw = snapshot();
  assert.throws(() => parseQuotes(raw, ["sh600000", "sh600000"]), /重复/);
  assert.throws(() => parseQuotes(raw + raw, ["sh600000"]), /重复/);
  assert.throws(() => parseQuotes(raw, ["sh600000", "sz000001"]), /sz000001/);
  assert.throws(() => parseQuotes(snapshot("sh600000", { 2: "000001" }), ["sh600000"]), /股票/);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(raw);
  });
  await assert.rejects(history(["sh600000", "sh600000"]), /重复/);
  await assert.rejects(quotes(["sh600000", "sh600000"]), /重复/);
  await assert.rejects(history([]), /1 至 100/);
  await assert.rejects(history(["bj920001"]), /北交所/);
  assert.equal(calls, 0);
});

test("decodes GBK names and rejects damaged GBK responses", async (t) => {
  const gbk = Buffer.concat([
    Buffer.from(snapshot().replace("fixture", "NAME").split("NAME")[0]),
    Buffer.from([0xc6, 0xd6, 0xb7, 0xa2, 0xd2, 0xf8, 0xd0, 0xd0]),
    Buffer.from(snapshot().replace("fixture", "NAME").split("NAME")[1]),
  ]);
  t.mock.method(globalThis, "fetch", async () => new Response(gbk));
  assert.equal((await quotes(["sh600000"]))[0].name, "浦发银行");
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(Buffer.concat([Buffer.from(snapshot()), Buffer.from([0x81])])),
  );
  await assert.rejects(quotes(["sh600000"]));
});

for (const rows of [
  [["2026-02-30", ...bar.slice(1)]],
  [bar, bar],
  [bar, ["2026-11-11", ...bar.slice(1)]],
  [null],
  ["2026-11-12"],
  [[bar[0], "10", "11", "9", "8", "1"]],
]) {
  test(`rejects invalid daily rows ${JSON.stringify(rows)}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: { sh600000: { day: rows } } }));
    await assert.rejects(history(["sh600000"]));
  });
}

for (const payload of [
  null,
  [],
  { code: 1, data: { sh600000: { day: [bar] } } },
  { data: { sz000001: { day: [bar] } } },
  { data: { sh600000: { qfqday: [bar], hfqday: [bar] } } },
]) {
  test(`rejects error or adjusted-only daily payload ${JSON.stringify(payload)}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    await assert.rejects(history(["sh600000"]));
  });
}

test("calendar validates every actual date, not just the number of rows", async (t) => {
  const data = calendar();
  data[29].jyrq = "2026-11-31";
  t.mock.method(globalThis, "fetch", async () => Response.json({ data }));
  await assert.rejects(isTradingDay("2026-11-13"), /日期|日历/);
});

test("calendar rejects incomplete, duplicate, wrong-month and malformed responses", async (t) => {
  for (const data of [
    [],
    calendar().slice(1),
    [...calendar().slice(1), calendar()[1]],
    calendar("2026-10"),
    [null],
    calendar().map((r) => ({ ...r, jybz: "yes" })),
    calendar().map((r) => ({ ...r, jyrq: r.jyrq + "garbage" })),
  ]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ data }));
    await assert.rejects(isTradingDay("2026-11-13"));
  }
});

test("calendar rejects impossible input before requesting and handles leap years and closed days", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ data: calendar("2024-02", 29) });
  });
  for (const day of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-01"])
    await assert.rejects(isTradingDay(day), /日期|交易日/);
  assert.equal(calls, 0);
  assert.equal(await isTradingDay("2024-02-29"), true);
  assert.equal(await isTradingDay("2024-02-01"), false);
});

test("HTTP, JSON and quote error responses never produce market data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(quotes(["sh600000"]), /503/);
  await assert.rejects(history(["sh600000"]), /503/);
  await assert.rejects(isTradingDay("2026-11-13"), /503/);
  t.mock.method(globalThis, "fetch", async () => new Response("<html>error</html>"));
  await assert.rejects(quotes(["sh600000"]), /缺少/);
  await assert.rejects(history(["sh600000"]));
  await assert.rejects(isTradingDay("2026-11-13"));
});
