import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeFailure } from "../src/errors.ts";
import { PiLinkStatusClient, parseLinkStatusPayload } from "../src/link/pi-link-status.ts";

function mockFetch(response: Response): typeof fetch {
  return (async () => response.clone()) as typeof fetch;
}

test("pi-link status parser keeps named terminals", () => {
  assert.deepEqual(
    parseLinkStatusPayload({
      terminals: [
        { name: "lead@team", cwd: "/tmp/project" },
        { name: "", cwd: "/tmp/ignored" },
        { nope: true },
      ],
    }),
    [{ name: "lead@team", cwd: "/tmp/project" }],
  );
});

test("pi-link status parser rejects unsupported payload shape", () => {
  assert.throws(() => parseLinkStatusPayload({}), RuntimeFailure);
});

test("pi-link client reads a supported status snapshot", async () => {
  const client = new PiLinkStatusClient(
    mockFetch(
      new Response(JSON.stringify({ terminals: [{ name: "lead@team", cwd: "/tmp/project" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  const snapshot = await client.snapshot();
  assert.equal(snapshot.supported, true);
  assert.equal(snapshot.reachable, true);
  assert.deepEqual([...client.names(snapshot)], ["lead@team"]);
  assert.equal(client.connection("lead@team", snapshot).connected, true);
  assert.equal(client.connection("worker@team", snapshot).connected, false);
});

test("pi-link client recognizes legacy hub without /status support", async () => {
  const client = new PiLinkStatusClient(mockFetch(new Response("upgrade", { status: 426 })));
  const snapshot = await client.snapshot();
  assert.equal(snapshot.supported, false);
  assert.equal(snapshot.reachable, true);
  assert.equal(snapshot.reason, "hub_status_unsupported");
});

test("pi-link waitFor returns immediately when target is already connected", async () => {
  const client = new PiLinkStatusClient(
    mockFetch(
      new Response(JSON.stringify({ terminals: [{ name: "worker@team", cwd: "/tmp/project" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  const result = await client.waitFor("worker@team", { timeoutMs: 5 });
  assert.equal(result.connected, true);
});
