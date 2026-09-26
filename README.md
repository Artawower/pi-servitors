# pi-servitors

Persistent Pi workers with pluggable terminal backends and event-driven pi-link callbacks.

The package deliberately separates three concerns:

- **Lead / skill** decides when to use researcher, coder, or reviewer.
- **WorkerHost backend** owns terminal/session/slot/process lifecycle.
- **pi-link** owns all normal Lead↔worker communication.

The initial backend is Herdr. The core runtime does not depend on Herdr-specific
workspace/pane APIs, so tmux/cmux backends can be added without rewriting swarm
semantics.

## Architecture

Detailed diagrams and lifecycle documentation: [`docs/architecture.md`](docs/architecture.md).

```text
Lead Pi
  │
  ├── pi-servitors skill       routing / policy
  │
  ├── TypeScript runtime         deterministic worker lifecycle
  │      │
  │      └── WorkerHost
  │             └── HerdrHost   current backend
  │
  └── pi-link                    Lead ↔ worker communication
```

Core runtime invariants are backend-independent:

- one deterministic worker identity per host scope + cwd + role
- lazy worker creation
- no adoption across scopes/cwds
- no duplicate managed worker
- explicit `TASK_ID` + `REPLY_TO`
- event-driven callback through `link_send`
- no polling as the normal wait path

## Layout

```text
pi-servitors/
├── package.json
├── README.md
├── agents/
│   ├── pi-servitors-coder.md
│   ├── pi-servitors-reviewer.md
│   └── pi-servitors-researcher.md
├── skills/
│   └── pi-servitors/
│       └── SKILL.md
├── src/
│   ├── index.ts
│   ├── command.ts
│   ├── config.ts
│   ├── errors.ts
│   ├── types.ts
│   ├── host/
│   │   ├── worker-host.ts
│   │   └── herdr-host.ts
│   ├── delegation/
│   │   ├── protocol.ts
│   │   └── tracker.ts
│   ├── link/
│   │   └── pi-link-status.ts
│   ├── ui/
│   │   └── delegation-status.ts
│   └── runtime/
│       ├── contracts.ts
│       ├── dependencies.ts
│       ├── identity.ts
│       ├── lock.ts
│       ├── profiles.ts
│       └── worker-runtime.ts
├── docs/
│   └── architecture.md
└── tests/
```

There is no Python runtime or Python prerequisite.


## Worker activity grid

After a successful delegated `link_send`, the extension tracks the packet's
`TASK_ID` and renders every active delegation as a responsive tile above the
editor. Multiple tasks are laid out side by side when terminal width allows it,
which makes parallel worker execution visible without mixing task state together.

Each tile shows:

- role and task ID
- total elapsed task time
- live pi-link state (`thinking`, current `tool:*`, `idle`, or offline)
- an indeterminate activity pulse while the worker is running
- real context-window usage when pi-link reports it

The activity bar is intentionally **not** a fabricated task-completion percentage.
LLM tasks have no reliable completion percentage unless a workflow defines explicit
milestones. Context usage is shown separately and labeled as `ctx`.

The UI refreshes from pi-link's local read-only `/status` endpoint. This is normal
JavaScript/HTTP polling inside the extension; it creates no Lead model turns and
never calls `link_list`, `team_runtime_status`, or sleeps through the LLM.

A worker callback containing the same `TASK_ID` removes that tile. Batched
callbacks and multiple active task IDs are supported. Callback completion is
detected from Pi's `context` event because trigger-turn custom messages currently
bypass `before_agent_start`.

Example with two currently supported parallel roles:

```text
workers 2 active · coder 18s · researcher-code 11s

╭ coder ────────────────────────╮  ╭ researcher-code ──────────────╮
│ ● thinking              18s  │  │ ● read                  11s  │
│ ░░██░░░░ active              │  │ ░░██░░░░ active              │
│ ctx 31K/272K · 11%           │  │ ctx 54K/272K · 20%           │
│ task implementation          │  │ task investigate-cache       │
╰──────────────────────────────╯  ╰──────────────────────────────╯
```

The tracker/UI are already task-based and can render two reviewer instances in
the future; the current runtime still provisions one deterministic worker per role.

See [`docs/architecture.md`](docs/architecture.md) for the event flow.

## WorkerHost abstraction

`src/host/worker-host.ts` is the boundary between orchestration semantics and the
terminal environment. A backend provides:

- backend detection and current host context
- group/session lookup and creation
- slot/window lookup and creation
- slot inspection and runnable-state checks
- worker discovery/readiness/labeling
- command execution inside a slot

The core runtime uses only this interface. `HerdrHost` is the first implementation.
Future `TmuxHost` or `CmuxHost` implementations should not need changes to routing,
identity, pi-link, callback, profile, or correction-loop behavior.

Runtime identity includes:

```text
backend + host scope id + cwd + role
```

so workers from different terminal backends or sessions are never silently reused.

## Pi package dependencies

The package owns these Pi-package dependencies:

- `pi-link` 0.5.0
- `pi-open-agents` 0.1.22

They are declared in both `dependencies` and `bundledDependencies`.

`pi-link` is also exposed from this package manifest so the Lead gets the
`link_send`/`link_list` tools without a separate manual Pi package install.
Workers load the bundled `pi-link` and `pi-open-agents` extension files directly
from this package's `node_modules` instead of resolving `npm:` packages each time
a worker starts.

The Lead manifest exposes only `src/index.ts` and bundled `pi-link`. It does not
expose `pi-open-agents`, so installing `pi-servitors` alone does not register the
`subagent`, `set_agent`, or `search_agents` tools in the Lead session.

No provider/model extension is bundled. In particular, **Antigravity is not a
dependency**. Worker profiles do not pin a provider or model; model selection is
left to the user's Pi configuration.

## System backend dependencies

Terminal backends are environment prerequisites, not hidden install side effects.

For the current release:

- Herdr CLI must already be installed and on `PATH`
- the Lead must be running inside a Herdr pane

`/team-doctor` reports whether the backend is available/active. The package does
not install Herdr automatically. Future tmux/cmux support should follow the same
rule: detect the user's environment rather than silently modifying it.

## Install

### Published npm package

Once published:

```bash
pi install npm:pi-servitors
```

Pi installs npm/git package dependencies automatically.

### Local checkout / unpacked archive

Local Pi package paths are not dependency installers, so install dependencies in
the checkout first:

```bash
cd /absolute/path/to/pi-servitors
npm install
pi install "$PWD"
```

Then restart Pi or run `/reload`.

The package should expose:

```text
Extensions:
  pi-servitors/src/index.ts
  pi-servitors/node_modules/pi-link/index.ts

Skills:
  pi-servitors
```

Do not separately install `pi-link` or copy the skill into `~/.agents/skills`
when using this package. `pi-servitors` owns the compatible `pi-link` copy used
by the Lead and workers.

`pi-open-agents` is bundled only so worker processes can load it explicitly from
`node_modules`; it is **not** listed as a Lead extension in the package manifest.
If you independently install `pi-open-agents`, its generic `subagent` tools may
still be visible to the Lead. The `pi-servitors` skill explicitly forbids using
those tools for servitor orchestration.

### Migrating from pi-worker-host / herdr-swarm / standalone pi-link

Remove the old package/resources before enabling `pi-servitors`. In particular,
do not leave a separately installed `pi-link` extension enabled alongside the
bundled one: Pi treats those as distinct extension resources, so duplicate tool
registration/load order is not a supported dependency-deduplication mechanism.

Typical migration from earlier development builds:

```bash
pi remove npm:pi-link 2>/dev/null || true
pi remove "$HOME/Downloads/pi-worker-host" 2>/dev/null || true
pi remove "$HOME/Downloads/herdr-swarm" 2>/dev/null || true
rm -rf ~/.pi/agent/extensions/herdr-swarm
rm -f ~/.pi/agent/agents/herdr-swarm-*.md
rm -f ~/.pi/agent/agents/pi-worker-host-*.md
```

Stop any old `hs-*` or `pwh-*` worker sessions/panes before the first
`pi-servitors` run. They use previous identity namespaces and intentionally are
not adopted by the new runtime.

## Lead connection and pi-link groups

The Lead must be connected to pi-link. For example:

```text
/link-connect
/link-name lead@test-swarm
```

pi-servitors reads pi-link's local read-only `/status` endpoint and identifies
the unique non-managed terminal in the current cwd. The worker inherits the exact
text after the first `@`.

Example:

```text
Lead:   lead@test-swarm
Coder:  psv-test-swarm-<hash>-coder@test-swarm
```

The worker host backend identity and pi-link identity remain separate concepts.

## Lazy provisioning

Calling:

```text
team_ensure_role({"role":"coder"})
```

will:

1. detect the active `WorkerHost` backend;
2. build a deterministic scope from backend + host scope + cwd;
3. verify the Lead is deterministically visible on pi-link;
4. synchronize the package-owned role profile;
5. reuse/create the worker group and role slot;
6. reuse an exact valid worker when possible;
7. otherwise launch a thin Pi worker in that slot;
8. pass the worker the exact grouped `--link-name`;
9. wait for the host to observe a real worker lifecycle state;
10. verify the exact pi-link target is connected;
11. return `link_target` and `lead_link_name`.

Workers are created only when requested.

## Thin worker harness

Workers load only the bundled extensions they need:

```text
pi-open-agents
pi-link
```

They use:

```text
--no-skills
--no-prompt-templates
```

but deliberately do **not** use `--no-context-files`, so repository instructions
such as `AGENTS.md` remain available.

No worker model/provider is hardcoded by pi-servitors.

## Communication

Normal communication is pi-link 0.5 `link_send` only.

```text
Lead
  -> team_ensure_role(coder)
  -> link_send(TASK_ID + REPLY_TO)
  -> end turn

Coder
  -> implementation / checks
  -> link_send(REPLY_TO, final result)

Lead
  -> resumes from callback
  -> final inspection
```

After successful delegation the Lead must not poll `link_list`,
`team_runtime_status`, sleep loops, or terminal backend status just to wait for
completion.

Terminal backend operations are lifecycle/diagnosis/recovery only; they are not
a fallback communication transport.

## Roles

Managed roles:

```text
coder
reviewer
researcher-code
```

The bundled profiles use no hardcoded model. They preserve the user's model
configuration while enforcing role behavior and the explicit pi-link callback
contract.

## Tools and commands

LLM tools:

```text
team_ensure_role
team_runtime_status
team_runtime_doctor
```

Manual commands:

```text
/team-ensure coder
/team-ensure reviewer
/team-ensure researcher-code
/team-status
/team-doctor
```

`PI_SERVITORS_BACKEND=<name>` is available as an explicit/debug backend
override. With only the Herdr backend implemented today it is normally unnecessary.

## Tests

The test suite uses Node's built-in `node:test` runner and fake implementations
of `WorkerHost`, link status, profiles, dependencies, and locking so the core
runtime is tested independently from Herdr.

```bash
npm test
npm run typecheck
npm run check
```

Coverage includes:

- deterministic backend-aware identity
- pi-link group inheritance and Lead inference
- stale/wrong-group detection
- WorkerHost-driven create/reuse flow
- Herdr `pane run` behavior
- shell quoting
- atomic profile synchronization
- provider-neutral worker profiles
- callback/no-polling policy
- package dependency manifest
- absence of the old Python runtime

## Publishing

Before publishing, install dependencies so npm can include the declared bundled
Pi packages, then run checks and inspect the tarball:

```bash
npm install
npm run check
npm pack --dry-run
npm publish
```

The published package should contain the bundled `pi-link` and `pi-open-agents`
dependencies in addition to `pi-servitors` own source/resources. Only `pi-link`
is exposed to the Lead by the package manifest; `pi-open-agents` is worker-only.
