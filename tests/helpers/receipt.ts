import assert from "node:assert/strict";

export function readReceipt(output: string): {
  ask?: { key: string; about: string; title: string; text: string; options: string[] }[];
  notice?: { fyi?: boolean; text: string }[];
} {
  const match = /\x60{3}agent-autoloop\s*\n([\s\S]*?)\n\x60{3}/.exec(output);
  assert.ok(match, "命令应输出中台 JSON 回执");
  return JSON.parse(match[1]);
}
