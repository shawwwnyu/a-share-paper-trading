import { createWorkbenchDemo } from "../src/workbench-demo.ts";
import { startWorkbench } from "../src/workbench.ts";

const demo = createWorkbenchDemo();
try {
  const server = await startWorkbench(demo.settings, {
    port: process.argv[2] === undefined ? 8787 : Number(process.argv[2]),
    demo: true,
    clock: () => demo.now,
  });
  const address = server.address();
  if (address && typeof address !== "string")
    console.log(`合成演示工作台：http://127.0.0.1:${address.port}\n只使用本次临时演示资料，退出后清理。`);
  const stop = () => {
    server.closeAllConnections();
    server.close(() => {
      demo.dispose();
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch {
  demo.dispose();
  console.error("演示工作台未能启动，请检查端口是否可用。");
  process.exitCode = 1;
}
