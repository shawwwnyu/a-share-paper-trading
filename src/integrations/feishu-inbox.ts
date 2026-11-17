// Standalone Feishu private-message source bridge: attaches to lark-cli's shared local bus and forwards only the
// configured owner's 1:1 text messages to agent-autoloop /v1/events without modifying the hub codebase.
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { requireThat } from "../types.ts";

export type FeishuInboxConfig = {
  owner: string;
  hubUrl: string;
  sourceKey: string;
  larkProgram?: string;
};

export function parseFeishuPrivateMessage(event: Record<string, unknown>, owner: string) {
  if (
    event.type !== "im.message.receive_v1" ||
    event.sender_type !== "user" ||
    event.sender_id !== owner ||
    event.chat_type !== "p2p" ||
    event.message_type !== "text" ||
    typeof event.message_id !== "string" ||
    !/^om_[\w-]{1,120}$/.test(event.message_id) ||
    typeof event.chat_id !== "string" ||
    !/^oc_[\w-]{1,90}$/.test(event.chat_id) ||
    typeof event.content !== "string" ||
    !event.content.trim() ||
    [...event.content].length > 4000
  )
    return null;
  return {
    id: event.message_id,
    type: "message.received",
    subject: event.chat_id,
    summary: "本人飞书私聊查询",
    detail: event.content.trim(),
  };
}

export async function forwardFeishuMessage(line: string, config: FeishuInboxConfig): Promise<boolean> {
  if (!line.trim()) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return false;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const event = parseFeishuPrivateMessage(raw as Record<string, unknown>, config.owner);
  if (!event) return false;

  const response = await fetch(`${config.hubUrl.replace(/\/+$/, "")}/v1/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.sourceKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15_000),
  });
  requireThat(response.ok, `中台拒收私聊事件 HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return true;
}

function notifyFailure(program: string, owner: string, messageId: string) {
  execFile(
    program,
    [
      "im",
      "+messages-send",
      "--user-id",
      owner,
      "--as",
      "bot",
      "--msg-type",
      "text",
      "--idempotency-key",
      `paper-inbox-failed-${messageId}`,
      "--content",
      JSON.stringify({ text: "指令未能送达中台，请稍后重发。" }),
    ],
    { timeout: 15_000 },
    () => {},
  );
}

export async function runFeishuInbox(config: FeishuInboxConfig, signal?: AbortSignal) {
  requireThat(config.owner && config.hubUrl && config.sourceKey, "飞书私聊入口需要 owner、hubUrl 和来源密钥");
  const program = config.larkProgram ?? "lark-cli";
  while (!signal?.aborted) {
    const child = spawn(program, ["event", "consume", "im.message.receive_v1", "--as", "bot"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop);
    child.stderr.on("data", (chunk) => process.stderr.write(`[feishu-inbox] ${chunk}`));
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      void forwardFeishuMessage(line, config).catch((error) => {
        console.error(`[feishu-inbox] ${error}`);
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.message_id === "string") notifyFailure(program, config.owner, parsed.message_id);
        } catch {}
      });
    });
    await new Promise((resolve) => child.on("close", resolve));
    signal?.removeEventListener("abort", stop);
    if (!signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}
