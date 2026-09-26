import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProfileStore } from "../src/runtime/profiles.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

for (const file of [
  "pi-servitors-coder.md",
  "pi-servitors-reviewer.md",
  "pi-servitors-researcher.md",
]) {
  test(`${file} uses callback contract without pinning a model/provider`, async () => {
    const text = await readFile(path.join(root, "agents", file), "utf8");
    assert.match(text, /link_send/);
    assert.match(text, /REPLY_TO/);
    assert.match(text, /to=REPLY_TO/);
    assert.equal(/\nmodel:/.test(text), false);
    assert.equal(text.toLowerCase().includes("antigravity"), false);
  });
}

test("reserved profile is atomically synchronized", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-servitors-test-"));
  try {
    const store = new ProfileStore(root, { ...process.env, PI_CODING_AGENT_DIR: tmp });
    const target = store.target("coder");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "stale\n", "utf8");
    assert.equal(await store.sync("coder"), target);
    assert.equal(await readFile(target, "utf8"), await readFile(store.source("coder"), "utf8"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
