import assert from "node:assert/strict";
import test from "node:test";
import {
  callbackTaskIds,
  callbackTaskIdsFromContext,
  looksLikePiLinkDelivery,
  messageText,
  parseDelegationPacket,
} from "../src/delegation/protocol.ts";

test("parseDelegationPacket extracts callback routing fields", () => {
  assert.deepEqual(
    parseDelegationPacket(`
TASK_ID: impl-42
REPLY_TO: lead@test
ROLE: reviewer
GOAL: Review the diff
`),
    { taskId: "impl-42", replyTo: "lead@test", role: "reviewer" },
  );
});

test("parseDelegationPacket requires TASK_ID and REPLY_TO", () => {
  assert.equal(parseDelegationPacket("TASK_ID: impl-1\nROLE: coder"), null);
  assert.equal(parseDelegationPacket("REPLY_TO: lead\nROLE: coder"), null);
});

test("callbackTaskIds supports coalesced parallel callbacks", () => {
  const text = `
[Link: 2 message(s) received]
From worker-a:
STATUS: DONE
TASK_ID: task-a

From worker-b:
VERDICT: PASS
TASK_ID: task-b

TASK_ID: task-a
`;
  assert.deepEqual(callbackTaskIds(text), ["task-a", "task-b"]);
  assert.equal(looksLikePiLinkDelivery(text), true);
});

test("context callback extraction sees trigger-turn custom Link messages", () => {
  const messages = [
    { role: "user", content: "ordinary user prompt mentioning TASK_ID: not-a-callback" },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `[Link: 2 message(s) received]\n\nFrom "worker-a":\nSTATUS: DONE\nTASK_ID: task-a\n\nFrom "worker-b":\nVERDICT: PASS\nTASK_ID: task-b`,
        },
      ],
    },
  ];

  assert.deepEqual(callbackTaskIdsFromContext(messages), ["task-a", "task-b"]);
});

test("context callback extraction ignores historical Link messages", () => {
  const messages = [
    { role: "user", content: `[Link: 1 message(s) received]\nTASK_ID: reused-id` },
    { role: "assistant", content: [{ type: "text", text: "Previous work completed." }] },
    { role: "user", content: [{ type: "text", text: "Start a new task that happens to reuse the same id." }] },
  ];
  assert.deepEqual(callbackTaskIdsFromContext(messages), []);
});

test("messageText tolerates nested Pi message content", () => {
  assert.equal(messageText({ content: [{ type: "text", text: "hello" }] }), "hello");
  assert.equal(messageText({ message: { content: "world" } }), "world");
});
