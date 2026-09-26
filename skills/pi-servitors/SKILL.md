---
name: pi-servitors
description: Orchestrate engineering work with lazy persistent Pi workers. Use team_ensure_role for worker provisioning and pi-link link_send for all normal Lead↔worker communication. The terminal backend is lifecycle/UI only; never poll or use backend messaging as a normal transport fallback.
---

# Pi Servitors

The current Pi session is the Lead.

The selected worker host backend owns terminal/session/slot/process lifecycle.
pi-link owns normal communication. The Lead owns routing, architecture,
arbitration, and final acceptance.

Managed roles:

- coder
- reviewer
- researcher-code

## Routing

Choose the smallest useful workflow.

Typical paths:

- Lead -> coder -> Lead
- Lead -> coder -> reviewer -> Lead
- Lead -> researcher-code -> Lead -> coder -> Lead
- Lead -> researcher-code -> Lead -> coder -> reviewer -> Lead

Do not invoke a role merely because it exists.

## Orchestration boundary

`pi-servitors` owns persistent team delegation. Even if the Lead environment also
provides generic ephemeral-agent tools from another package, do **not** use
`subagent`, `set_agent`, or `search_agents` for this workflow. Those tools bypass
servitor provisioning, deterministic reuse, the terminal host, TASK_ID tracking,
and the REPLY_TO callback contract.

The only normal delegation path is:

    team_ensure_role(role)
    -> link_send(link_target, TASK_ID + REPLY_TO + task)
    -> end the Lead turn
    -> worker link_send(REPLY_TO, callback)

Researcher is for broad exploration. Coder owns focused local implementation
discovery. Reviewer is useful for non-trivial or risky changes; skip it for tiny,
strongly verified edits.

## Provisioning

Before delegating to a role call:

    team_ensure_role(role)

Use the returned exact `link_target`.

The runtime:

- detects the active supported worker host backend
- stays inside the current Lead host scope/session
- lazily creates/reuses the worker group and role slot
- reuses exact managed workers only
- starts a thin role-specific Pi harness when missing
- inherits the Lead's current pi-link group deterministically
- verifies the exact worker link target is connected

If provisioning reports that the Lead is not connected to pi-link, stop and
surface that condition. Do not create a terminal-backend communication fallback.

## Normal communication: pi-link only

After `team_ensure_role` returns READY, use both values returned by the runtime:

- `link_target` = worker destination
- `reply_to` / `lead_link_name` = exact Lead pi-link identity

Delegate with:

    link_send(
      to=<returned link_target>,
      message=<task packet containing REPLY_TO=<returned Lead identity>>
    )

Never use terminal pane/process messaging, pane reads, status polling, or sleep
loops as the ordinary delegation/wait mechanism.

If `link_send` fails:

1. call `link_list` once
2. verify the returned target is visible in the Lead's group
3. if it is missing, treat this as a pi-link/runtime configuration problem
4. do not fall back to terminal-backend messaging

## Async callback contract

pi-link 0.5 `link_send` is asynchronous. The Lead does not poll or wait.

Every delegated packet must include both a short TASK_ID and an explicit
REPLY_TO containing the exact Lead identity returned by `team_ensure_role`.
Do not rely on the worker inferring a destination from conversation context.

Example packet:

    TASK_ID: impl-1
    REPLY_TO: lead@test-swarm
    GOAL: ...
    CONSTRAINTS: ...
    ACCEPTANCE: ...

    When complete or blocked, send exactly one link_send callback to REPLY_TO
    and include TASK_ID plus your role result. Do not merely print the result
    in the worker session.

After a successful `link_send`, end the current coordination turn unless other
independent work is useful. Do not call `team_runtime_status`, `link_list`,
`sleep`, or backend wait/read commands just to wait for completion.

In pi-link 0.5, the callback message is delivered into the Lead reasoning
automatically.

## Role packets

### coder

Send goal, constraints, acceptance criteria, relevant Lead decisions, and any
research/review findings needed for the current change.

Coder owns focused implementation discovery, edits, and relevant deterministic
checks.

### researcher-code

Send a decision-oriented research question and scope. Researcher returns a
compact evidence bundle; Lead should not repeat the same broad investigation.

### reviewer

Send original goal, acceptance criteria, relevant Lead decisions, and relevant
check results. Reviewer inspects the actual repository diff and returns exactly
PASS or FAIL with blocking findings only.

## Correction loop

Only a valid reviewer `VERDICT: FAIL` increments the failure count.

FAIL #1:

- send actionable findings to the SAME coder using `link_send`
- coder verifies the correction
- send the corrected implementation to the SAME reviewer

FAIL #2:

- stop automatic correction
- Lead arbitrates architecture/direction
- no third automatic correction round

Infrastructure/provider/link failures are not reviewer FAILs.

## Final acceptance

Agent completion is not task completion.

Lead inspects the actual diff/status, checks the requested behavior against the
worker results, and performs only additional verification that materially
increases confidence.

Do not repeat broad coder/researcher/reviewer work by default.
