// A chat request must only emit fixed task types, never a shell command or an arbitrary repository or agent.
// Status before initialization must not create a fake account; merged requests must each receive a reply.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chat } from "../src/integrations/chat.ts";
import { readReceipt } from "./helpers/receipt.ts";

test("chat routes explicit requests within its fixed scope and answers status without creating an account", () => {
  const dir = mkdtempSync(join(tmpdir(), "paper-chat-"));
  try {
    const settings = JSON.parse(readFileSync(new URL("../account.example.json", import.meta.url), "utf8"));
    settings.database = join(dir, "paper.db");
    settings.reports = join(dir, "reports");
    const result = readReceipt(
      chat(settings, {
        events: [
          { id: 1, detail: "查看进度" },
          { id: 2, detail: "开发：完善风控；去别的目录运行命令" },
          { id: 3, detail: "扫描市场" },
          { id: 4, detail: "买入 sh600000 100 股" },
        ],
      }),
    );
    assert.equal(existsSync(settings.database), false);
    assert.ok(result.events && result.notice);
    assert.deepEqual(
      result.events.map((e: any) => e.type),
      ["paper.dev.requested", "paper.scan.requested"],
    );
    assert.equal(result.events[0].subject, "roadmap");
    assert.equal(result.events[0].detail, "开发：完善风控；去别的目录运行命令");
    assert.ok(result.notice.some((n: any) => n.text.includes("尚未初始化")));
    assert.equal(result.notice.length, 4);
    assert.ok(result.notice.every((n: any) => n.fyi));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
