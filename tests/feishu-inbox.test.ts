// Failure mode: untrusted/group Feishu messages trigger hub events, or valid owner private queries drop their message ID.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { parseFeishuPrivateMessage, forwardFeishuMessage } from "../src/integrations/feishu-inbox.ts";

const sample = {
  type: "im.message.receive_v1",
  sender_type: "user",
  sender_id: "ou_owner",
  chat_type: "p2p",
  chat_id: "oc_chat_1",
  message_type: "text",
  message_id: "om_msg_1",
  content: "查看持仓",
};

test("only the configured owner's private text message becomes a hub event and posts with bearer auth", async () => {
  const parsed = parseFeishuPrivateMessage(sample, "ou_owner");
  assert.deepEqual(parsed, {
    id: "om_msg_1",
    type: "message.received",
    subject: "oc_chat_1",
    summary: "本人飞书私聊查询",
    detail: "查看持仓",
  });
  for (const invalid of [
    { sender_id: "ou_other" },
    { sender_type: "bot" },
    { chat_type: "group" },
    { message_type: "image" },
    { message_id: "bad id" },
    { chat_id: "../bad" },
    { content: "   " },
    { content: "x".repeat(4001) },
  ]) {
    assert.equal(parseFeishuPrivateMessage({ ...sample, ...invalid }, "ou_owner"), null);
  }

  const received: { url?: string; auth?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ event: 1, duplicate: false, routed: ["飞书持仓与账户对话"] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const ok = await forwardFeishuMessage(JSON.stringify(sample), {
      owner: "ou_owner",
      hubUrl: `http://127.0.0.1:${port}`,
      sourceKey: "test-source-key",
    });
    assert.equal(ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, "/v1/events");
    assert.equal(received[0].auth, "Bearer test-source-key");
    assert.equal(received[0].body.id, "om_msg_1");
    assert.equal(received[0].body.detail, "查看持仓");
  } finally {
    server.close();
  }
});
