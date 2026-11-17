import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildWorkbenchDemoHtml } from "../src/workbench-export.ts";

const output = resolve(process.argv[2] ?? "dist/miaoda-demo/index.html");
const html = buildWorkbenchDemoHtml();
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, html, { flag: "wx" });
console.log(`合成演示已导出：${output}\n可直接用浏览器打开；不需要账户、后端或网络连接。`);
