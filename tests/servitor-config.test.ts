import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadServitorConfig,
  mergeConfigs,
  parseServitorsJson,
  parseSettingsJson,
  resolveRoleExtensions,
} from "../src/runtime/servitor-config.ts";

test("parseServitorsJson parses extensions and resolves relative paths", () => {
  const baseDir = "/test/project/.pi";
  const raw = {
    extensions: ["npm:@tian.zuo/pi-antigravity", "./local-ext.ts", "../shared/tool.ts"],
    roles: {
      coder: {
        extensions: ["./coder-only.ts"],
      },
    },
  };
  const config = parseServitorsJson(raw, baseDir);
  assert.deepEqual(config.extensions, [
    "npm:@tian.zuo/pi-antigravity",
    path.resolve(baseDir, "./local-ext.ts"),
    path.resolve(baseDir, "../shared/tool.ts"),
  ]);
  assert.deepEqual(config.roles?.coder?.extensions, [
    path.resolve(baseDir, "./coder-only.ts"),
  ]);
});

test("parseSettingsJson extracts servitors block", () => {
  const baseDir = "/test/project/.pi";
  const raw = {
    theme: "dark",
    packages: ["npm:@tian.zuo/pi-antigravity"],
    servitors: {
      extensions: ["npm:@tian.zuo/pi-antigravity"],
    },
  };
  const config = parseSettingsJson(raw, baseDir);
  assert.deepEqual(config.extensions, ["npm:@tian.zuo/pi-antigravity"]);
});

test("mergeConfigs merges global and project configs with deduplication", () => {
  const globalConfig = {
    extensions: ["npm:@tian.zuo/pi-antigravity"],
    roles: {
      coder: { extensions: ["npm:global-coder"] },
    },
  };
  const projectConfig = {
    extensions: ["npm:@tian.zuo/pi-antigravity", "npm:project-linter"],
    roles: {
      coder: { extensions: ["npm:project-coder"] },
      "researcher-code": { extensions: ["npm:browser"] },
    },
  };

  const merged = mergeConfigs([globalConfig, projectConfig]);
  assert.deepEqual(merged.extensions, [
    "npm:@tian.zuo/pi-antigravity",
    "npm:project-linter",
  ]);
  assert.deepEqual(merged.roles?.coder?.extensions, [
    "npm:global-coder",
    "npm:project-coder",
  ]);
  assert.deepEqual(merged.roles?.["researcher-code"]?.extensions, [
    "npm:browser",
  ]);
});

test("resolveRoleExtensions combines common and role-specific extensions", () => {
  const config = {
    extensions: ["npm:common-1", "npm:common-2"],
    roles: {
      reviewer: { extensions: ["npm:reviewer-tool", "npm:common-1"] },
    },
  };
  const coderExts = resolveRoleExtensions(config, "coder");
  assert.deepEqual(coderExts, ["npm:common-1", "npm:common-2"]);

  const reviewerExts = resolveRoleExtensions(config, "reviewer");
  assert.deepEqual(reviewerExts, ["npm:common-1", "npm:common-2", "npm:reviewer-tool"]);
});

test("default Pi config ignores a separate pig installation", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "servitors-home-"));
  t.mock.method(os, "homedir", () => home);
  const piDir = path.join(home, ".pi", "agent");
  const pigDir = path.join(home, ".pig", "agent");
  try {
    await mkdir(piDir, { recursive: true });
    await mkdir(pigDir, { recursive: true });
    await writeFile(path.join(piDir, "settings.json"), JSON.stringify({
      servitors: { extensions: ["npm:pi-provider"] },
    }));
    await writeFile(path.join(pigDir, "settings.json"), JSON.stringify({
      servitors: { extensions: ["npm:pig-provider"], roles: { coder: { extensions: ["npm:pig-coder"] } } },
    }));
    await writeFile(path.join(pigDir, "servitors.json"), JSON.stringify({ extensions: ["npm:pig-other"] }));
    const config = loadServitorConfig(path.join(home, "project"), {});
    assert.deepEqual(resolveRoleExtensions(config, "coder"), ["npm:pi-provider"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("explicit Pi directory replaces default globals while retaining project and env extensions", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "servitors-home-"));
  t.mock.method(os, "homedir", () => home);
  const customDir = path.join(home, "custom-agent");
  const project = path.join(home, "project");
  try {
    for (const dir of [customDir, path.join(home, ".pi", "agent"), path.join(home, ".pig", "agent"), path.join(project, ".pi")]) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
      servitors: { extensions: ["npm:default-provider"] },
    }));
    await writeFile(path.join(home, ".pig", "agent", "settings.json"), JSON.stringify({
      servitors: { extensions: ["npm:pig-provider"] },
    }));
    await writeFile(path.join(customDir, "servitors.json"), JSON.stringify({ extensions: ["./provider.ts"] }));
    await writeFile(path.join(customDir, "settings.json"), JSON.stringify({
      servitors: { roles: { coder: { extensions: ["npm:custom-coder"] } } },
    }));
    await writeFile(path.join(project, ".pi", "settings.json"), JSON.stringify({
      servitors: { extensions: ["npm:project-provider"] },
    }));
    const config = loadServitorConfig(project, {
      PI_CODING_AGENT_DIR: customDir,
      PI_SERVITORS_EXTENSIONS: "npm:env-provider",
    });
    assert.deepEqual(resolveRoleExtensions(config, "coder"), [
      path.join(customDir, "provider.ts"), "npm:project-provider", "npm:env-provider", "npm:custom-coder",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("loadServitorConfig reads from filesystem and environment variable", async () => {
  const tmpDir = path.join(os.tmpdir(), `servitors-cfg-test-${Date.now()}`);
  const projectPi = path.join(tmpDir, ".pi");
  await mkdir(projectPi, { recursive: true });

  try {
    await writeFile(
      path.join(projectPi, "servitors.json"),
      JSON.stringify({ extensions: ["npm:from-servitors-json"] }),
      "utf8",
    );

    const config = loadServitorConfig(tmpDir, {
      PI_CODING_AGENT_DIR: path.join(tmpDir, "nonexistent-global"),
      PI_SERVITORS_EXTENSIONS: "npm:from-env-1, npm:from-env-2",
    });

    assert.deepEqual(config.extensions, [
      "npm:from-servitors-json", "npm:from-env-1", "npm:from-env-2",
    ]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
