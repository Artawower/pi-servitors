import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeFailure } from "../src/errors.ts";
import {
  buildRuntimeContext,
  inferLeadLink,
  linkGroup,
  linkTarget,
  runtimeName,
  wrongGroupTargets,
} from "../src/runtime/identity.ts";
import type { LinkSnapshot } from "../src/types.ts";

const ctx = buildRuntimeContext({
  backend: "herdr",
  scopeId: "w5",
  leadSlotId: "w5:p2",
  cwd: "/tmp/test-swarm",
});

test("managed worker names are deterministic, short, and group-free", () => {
  for (const role of ["coder", "reviewer", "researcher-code"] as const) {
    const name = runtimeName(ctx, role);
    assert.ok(name.length <= 32);
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
    assert.equal(name.includes("@"), false);
  }
});

test("backend participates in runtime identity", () => {
  const tmux = buildRuntimeContext({
    backend: "tmux",
    scopeId: "w5",
    leadSlotId: "w5:p2",
    cwd: "/tmp/test-swarm",
  });
  assert.notEqual(runtimeName(ctx, "coder"), runtimeName(tmux, "coder"));
});

test("pi-link group semantics preserve everything after the first @", () => {
  assert.equal(linkGroup("lead"), null);
  assert.equal(linkGroup("lead@"), null);
  assert.equal(linkGroup("lead@frontend"), "frontend");
  assert.equal(linkGroup("lead@g@h"), "g@h");
});

test("worker inherits the exact Lead group", () => {
  const local = runtimeName(ctx, "coder");
  assert.equal(linkTarget(ctx, "coder", "lead@team"), `${local}@team`);
  assert.equal(linkTarget(ctx, "coder", "lead"), local);
});

test("Lead inference ignores managed workers in the same cwd", () => {
  const worker = linkTarget(ctx, "coder", "lead@team");
  const snapshot: LinkSnapshot = {
    supported: true,
    reachable: true,
    reason: null,
    terminals: [
      { name: "lead@team", cwd: "/tmp/test-swarm" },
      { name: worker, cwd: "/tmp/test-swarm" },
      { name: "other@other", cwd: "/tmp/other" },
    ],
  };
  const lead = inferLeadLink(ctx, snapshot);
  assert.equal(lead.name, "lead@team");
  assert.equal(lead.group, "team");
});

test("Lead inference fails closed on ambiguity", () => {
  const snapshot: LinkSnapshot = {
    supported: true,
    reachable: true,
    reason: null,
    terminals: [
      { name: "lead-a@team", cwd: "/tmp/test-swarm" },
      { name: "lead-b@team", cwd: "/tmp/test-swarm" },
    ],
  };
  assert.throws(() => inferLeadLink(ctx, snapshot), RuntimeFailure);
});

test("wrong-group detection finds stale variants", () => {
  const local = runtimeName(ctx, "coder");
  const snapshot: LinkSnapshot = {
    supported: true,
    reachable: true,
    reason: null,
    terminals: [
      { name: local },
      { name: `${local}@old` },
      { name: "other@x" },
    ],
  };
  assert.deepEqual(wrongGroupTargets(ctx, "coder", snapshot), [local, `${local}@old`]);
});
