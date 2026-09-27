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

Provision a worker when needed:

```text
/team-ensure coder
/team-ensure reviewer
/team-ensure researcher-code
```

Or use the LLM tools:

```text
team_ensure_role
team_runtime_status
team_runtime_doctor
```

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
