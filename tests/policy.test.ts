import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("canonical skill requires explicit callback identity and forbids polling", async () => {
  const text = await readFile(path.join(root, "skills", "pi-servitors", "SKILL.md"), "utf8");
  assert.match(text, /link_send/);
  assert.match(text, /REPLY_TO/);
  assert.match(text, /lead_link_name/);
  assert.match(text, /team_runtime_status/);
  assert.match(text, /Do not call `team_runtime_status`, `link_list`/);
  assert.equal(text.includes("triggerTurn"), false);
  assert.equal(text.includes("swarm_prompt"), false);
  assert.match(text, /do \*\*not\*\* use\s+`subagent`, `set_agent`, or `search_agents`/i);
});

test("Python runtime has been removed", async () => {
  await assert.rejects(access(path.join(root, "runtime.py")));
});

test("core runtime has no Herdr-specific environment or CLI vocabulary", async () => {
  const text = await readFile(path.join(root, "src", "runtime", "worker-runtime.ts"), "utf8");
  assert.equal(text.includes("HERDR_"), false);
  assert.equal(text.includes('"herdr"'), false);
  assert.equal(text.includes("workspace"), false);
  assert.equal(text.includes("pane"), false);
});
