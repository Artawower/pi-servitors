import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RuntimeDependencies } from "../src/runtime/dependencies.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("worker harness uses bundled pi-link/open-agents and excludes unconfigured extensions", () => {
  const dependencies = new RuntimeDependencies(root, {}, { extensions: [] });
  const args = dependencies.buildPiArgs("coder", "worker@team");
  const joined = args.join(" ");
  assert.match(joined, /node_modules\/pi-open-agents\/index\.ts/);
  assert.match(joined, /node_modules\/pi-link\/index\.ts/);
  assert.match(joined, /--link-name worker@team/);
  assert.match(joined, /--no-skills/);
  assert.match(joined, /--no-prompt-templates/);
  assert.equal(joined.includes("antigravity"), false);
  assert.equal(joined.includes("npm:pi-"), false);
  assert.equal(joined.includes("--no-context-files"), false);
});

test("worker harness forwards configured worker extensions", () => {
  const dependencies = new RuntimeDependencies(root, {}, {
    extensions: ["npm:@tian.zuo/pi-antigravity", "npm:pi-custom-provider"],
  });
  const args = dependencies.buildPiArgs("coder", "worker@team");
  const joined = args.join(" ");
  assert.match(joined, /-e npm:@tian\.zuo\/pi-antigravity/);
  assert.match(joined, /-e npm:pi-custom-provider/);
});

test("worker harness includes role-specific extensions", () => {
  const dependencies = new RuntimeDependencies(root, {}, {
    extensions: ["npm:@tian.zuo/pi-antigravity"],
    roles: {
      "researcher-code": {
        extensions: ["npm:pi-browser-model"],
      },
    },
  });
  const coderArgs = dependencies.buildPiArgs("coder", "coder@team");
  const researcherArgs = dependencies.buildPiArgs("researcher-code", "researcher@team");

  assert.ok(coderArgs.includes("npm:@tian.zuo/pi-antigravity"));
  assert.equal(coderArgs.includes("npm:pi-browser-model"), false);

  assert.ok(researcherArgs.includes("npm:@tian.zuo/pi-antigravity"));
  assert.ok(researcherArgs.includes("npm:pi-browser-model"));
});

test("package bundles worker dependencies but exposes only pi-link to Lead", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-servitors");
  assert.equal(manifest.dependencies["pi-link"], "0.5.0");
  assert.equal(manifest.dependencies["pi-open-agents"], "0.1.22");
  assert.deepEqual(new Set(manifest.bundledDependencies), new Set(["pi-link", "pi-open-agents"]));
  assert.ok(manifest.pi.extensions.includes("./node_modules/pi-link/index.ts"));
  assert.ok(manifest.pi.extensions.includes("./src/index.ts"));
  assert.equal(manifest.pi.extensions.includes("./node_modules/pi-open-agents/index.ts"), false);
});
