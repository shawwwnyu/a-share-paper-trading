export const isStaticDemo = false;

export async function readSnapshot() {
  const response = await fetch("/api/workbench", { cache: "no-store" });
  if (!response.ok) throw new Error("读取暂时失败。请核对本机服务与账户资料；页面保留上次成功内容。");
  return response.json();
}

export async function readReport(kind, day) {
  const response = await fetch(`/api/reports/${kind}/${encodeURIComponent(day)}`, { cache: "no-store" });
  if (!response.ok) throw new Error("这份复盘暂不可读，请核对保存的报告；此前成功读取的内容仍保留。");
  return response.json();
}
