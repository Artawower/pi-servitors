import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeLock } from "../src/runtime/lock.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("runtime lock serializes concurrent work for the same scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-servitors-lock-"));
  try {
    const lock = new RuntimeLock(root);
    const events: string[] = [];
    const first = lock.withLock("same-scope", undefined, async () => {
      events.push("first:start");
      await delay(30);
      events.push("first:end");
    });
    await delay(5);
    const second = lock.withLock("same-scope", undefined, async () => {
      events.push("second:start");
      events.push("second:end");
    });
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime lock recovers a stale lock owned by a dead process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-servitors-lock-"));
  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "stale.lock"),
      JSON.stringify({ pid: 99999999, createdAt: Date.now() - 60_000 }),
      "utf8",
    );
    const lock = new RuntimeLock(root);
    const value = await lock.withLock("stale", undefined, async () => 42);
    assert.equal(value, 42);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
