# ✨ pi-servitors

[![npm version](https://img.shields.io/npm/v/pi-servitors)](https://www.npmjs.com/package/pi-servitors)
[![npm downloads](https://img.shields.io/npm/dm/pi-servitors)](https://www.npmjs.com/package/pi-servitors)

Persistent Pi workers for engineering tasks.

## What is pi-servitors?

pi-servitors provides three managed worker roles:

- `coder` — implementation;
- `reviewer` — independent review;
- `researcher-code` — repository research.

Workers are created lazily and reused for the current project scope. Lead-to-worker communication uses `pi-link` callbacks with explicit task IDs.

The current worker host backend is Herdr.

## Install

```shell
pi install npm:pi-servitors
```

For a local checkout:

```shell
npm install
pi install "$PWD"
```

The Lead must run inside a supported worker host and be connected to `pi-link`.

```text
/link-connect
/link-name lead@test-swarm
```

Run `/reload` after installing or updating the package.

## Usage

Ordinary prompts run solo. Start a Servitors task explicitly with its prompt:

```text
/servitors implement the requested feature and verify it
```

That opts the current Pi session into Servitors mode: follow the team workflow
for subsequent prompts as well as the initial task, including callbacks, useful
research, implementation, review, and final verification. Run `/solo` to return
to solo work. The mode survives reload and branch navigation. The
worker-provisioning tool is hidden outside Servitors mode; `/team-ensure` is
deprecated.

Read-only diagnostics remain available as `team_runtime_status` and
`team_runtime_doctor`.

A normal delegation looks like:

```text
Lead
  -> team_ensure_role
  -> link_send(TASK_ID + REPLY_TO)
  -> worker
  -> link_send(REPLY_TO, result)
  -> Lead
```

Workers are not created until their role is requested.

## Diagnosing a stalled flow

Use the existing commands for a one-shot snapshot, not a completion polling loop:

```text
/team-status
/team-doctor
/team-doctor --report
```

- **Status** separates observed process/link state from flow progress: current
  phase, time in that phase, last confirmed transition, run ID and pending
  `TASK_ID`s. Launch submission is not proof Pi executed; successful `link_send`
  is not proof the worker received or started the task.
- **Doctor** reports environment prerequisites separately from execution health,
  explains incomplete/failed transitions, and suggests the next safe check. It
  includes package origin/fingerprint, configuration sources and configured
  extensions. These do not establish the actual worker provider/model.
- **Report** explicitly writes a private JSON file under
  `$PI_CODING_AGENT_DIR/servitors/diagnostics/` (otherwise
  `~/.pi/agent/servitors/diagnostics/`). Share the printed path when investigating
  a hang, preferably before restarting or resending the task. The equivalent tool
  call is `team_runtime_doctor` with `{ "report": true }`.

The journal is persisted as non-context custom entries in the Lead's Pi session.
It starts collecting after this version is loaded; earlier runs have no retroactive
history. Reload/resume/tree navigation reconstruct the selected branch only;
unfinished restored operations are **unconfirmed**, not assumed to be still
running. A long wait alone is not classified as a deadlock.

Snapshots retain up to 200 recent events and 200 run summaries, preferentially
retaining unresolved runs. Truncation and persistence failures are reported.
Reports contain metadata, not task bodies, prompts, raw errors, terminal output,
credentials or full sessions. Task IDs, identities and local paths remain visible;
review before sharing. The original tool result/session remains the source for
raw error details. Commands do not start, restart or adopt workers; only the
explicit report option writes a file.

## Worker Extensions

By default, workers start in a lean environment (`-ne`) without ambient user extensions. To enable model provider extensions (such as Antigravity) or custom tools in subagent worker sessions, declare them in your Pi `settings.json` (`~/.pi/agent/settings.json` or `.pi/settings.json`):

```json
{
  "servitors": {
    "extensions": [
      "npm:@tian.zuo/pi-antigravity"
    ]
  }
}
```

Or create a dedicated `.pi/servitors.json`:

```json
{
  "extensions": [
    "npm:@tian.zuo/pi-antigravity"
  ],
  "roles": {
    "researcher-code": {
      "extensions": ["npm:pi-browser-model"]
    }
  }
}
```

Global settings are read only from `PI_CODING_AGENT_DIR` when set, otherwise
`~/.pi/agent`. Settings from other installations (such as `~/.pig/agent`) are not
merged. Global and project extension lists are combined and deduplicated.

Extensions can also be supplied via the `PI_SERVITORS_EXTENSIONS` environment variable (comma-separated).

## Development

```shell
npm install
npm run check
npm run pack:check
```

The test suite uses Node's built-in test runner and fake host/runtime dependencies, so the core runtime can be tested without a live Herdr environment.

## Repository layout

```text
agents/                 worker role profiles
skills/                 pi-servitors skill
src/                    package implementation
tests/                  runtime and integration tests
docs/architecture.md    architecture and lifecycle details
```

See [Architecture](docs/architecture.md) for lifecycle, runtime, host, and communication details.

## Links

- [GitHub](https://github.com/artawower/pi-servitors)
- [npm](https://www.npmjs.com/package/pi-servitors)
