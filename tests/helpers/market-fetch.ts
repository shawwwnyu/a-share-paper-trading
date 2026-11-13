import { chinaDay } from "../../src/types.ts";

// Offline HTTP responses for the CLI subprocess and diagnostic tests.
export const fixtureFetch: typeof fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === "www.szse.cn") {
    const [year, month] = url.searchParams.get("month")!.split("-").map(Number);
    return Response.json({
      data: Array.from({ length: new Date(Date.UTC(year, month, 0)).getUTCDate() }, (_, i) => ({
        jyrq: `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`,
        jybz: [0, 6].includes(new Date(Date.UTC(year, month - 1, i + 1)).getUTCDay()) ? "0" : "1",
      })),
    });
  }
  if (url.hostname === "web.ifzq.gtimg.cn") {
    const symbol = url.searchParams.get("param")!.split(",")[0];
    const day = chinaDay(new Date(Date.now() - 86400_000).toISOString());
    return Response.json({ code: 0, data: { [symbol]: { day: [[day, "10", "10", "11", "9", "100"]] } } });
  }
  if (url.hostname === "qt.gtimg.cn") {
    const symbol = url.pathname.slice(3);
    const f = Array(60).fill("0");
    const at = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace(/\D/g, "");
    Object.assign(f, {
      1: "fixture",
      2: symbol.slice(2),
      3: "10",
      6: "100",
      9: "10",
      10: "10",
      19: "10",
      20: "10",
      30: at,
      47: "11",
      48: "9",
    });
    return new Response(`v_${symbol}="${f.join("~")}";`);
  }
  throw new Error("测试禁止访问其他网络地址");
};
