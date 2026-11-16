import { readFileSync } from "node:fs";
import { createWorkbenchDemo } from "./workbench-demo.ts";
import { workbenchSnapshot, workbenchReport } from "./workbench.ts";

// This exporter accepts no account settings: only disposable synthetic data can be embedded.
export function buildWorkbenchDemoHtml() {
  const demo = createWorkbenchDemo();
  try {
    const snapshot = workbenchSnapshot(demo.settings, demo.now, true);
    const reports: Record<string, NonNullable<ReturnType<typeof workbenchReport>>> = {};
    for (const kind of ["daily", "weekly"] as const)
      for (const entry of snapshot.reports[kind]) {
        const report = workbenchReport(demo.settings, kind, entry.day, demo.now);
        if (!report) throw new Error("演示复盘缺失，停止导出。");
        reports[`${kind}/${entry.day}`] = report;
      }
    const data = JSON.stringify({ snapshot, reports }).replaceAll("<", "\\u003c");
    const asset = (name: string) => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8");
    const model = asset("model.js").replace(/^export /gm, "");
    const app = asset("app.js").replace(/^import .* from "\.\/(?:model|data)\.js";\n/gm, "");
    if (/^import\s/m.test(app) || /^import\s/m.test(model)) throw new Error("页面新增依赖，请更新演示导出器。");
    const adapter = `
const isStaticDemo = true;
const embeddedDemo = JSON.parse(document.getElementById("demo-data").textContent);
async function readSnapshot() { return structuredClone(embeddedDemo.snapshot); }
async function readReport(kind, day) {
  const report = embeddedDemo.reports[kind + "/" + day];
  if (!report) throw new Error("演示未包含这份复盘。");
  return structuredClone(report);
}
`;
    const code = `${model}\n${adapter}\n${app}`;
    if (/<\/script/i.test(code) || /<\/style/i.test(asset("style.css")))
      throw new Error("页面资源包含内联结束标签，停止导出。");
    return asset("index.html")
      .replace('<link rel="stylesheet" href="/style.css" />', () => `<style>\n${asset("style.css")}\n</style>`)
      .replace('<script type="module" src="/app.js"></script>', "")
      .replace("<title>交易员工作台 · A 股模拟交易</title>", "<title>交易员工作台 · 合成演示</title>")
      .replace("事实账本 · 本机访问", "合成演示资料 · 离线演示")
      .replace("刷新记录", "重载演示")
      .replace("等待读取账本", "等待读取演示资料")
      .replace("正在连接本机业务接口…", "正在读取内置合成演示资料…")
      .replace(
        "请在浏览器启用 JavaScript 以读取本机业务记录。账户不会因页面加载发生变化。",
        "请在浏览器启用 JavaScript 以查看内置合成演示资料。",
      )
      .replace(
        "请在原飞书卡片处理交易决定；本页刷新只读取记录。",
        "以下为合成委托示例，用于查看状态和详情；本演示不提供交易确认。",
      )
      .replace(
        "</body>",
        () =>
          `<script id="demo-data" type="application/json">${data}</script>\n<script type="module">\n${code}\n</script>\n</body>`,
      );
  } finally {
    demo.dispose();
  }
}
