# Plan: A1b.2R-S1 — root-one repair aggregate contract

> **Status: implemented 2026-09-01; authority repair completed 2026-09-02.** One reversible production slice. The
> admitted root's schema-2 run guard is the only repair aggregate: it owns root
> identity, non-renewable counters, terminal cause, repair budget, and one
> bounded continuation envelope. This slice records no successor run, exposes
> no successor route, and performs no launch, tmux, CLI, or worktree action.

## Why this replaces the earlier A1b.2 direction

PR #4 was re-read at its frozen head
`d055fe6f38dba91d7102317126b047a2bb577b7f` against base
`5be72a5e7195d0ee2c2dc5ad96db1773ae1ee743`. It remains reference material,
not an implementation source. Its admission-registry lineage authority,
generic continuation workflow, successor allocation, launch receipt, route,
tmux, and outbox mechanics combine several authority boundaries in one change.
This replacement keeps the A1b.1 registry unchanged and proves the root
aggregate contract before any successor can exist.

The central correction is structural: a root run must not have one store for
admission identity, another for budgets, a third for terminal cause, and a
fourth for repair continuation. The admission registry remains the immutable
proof that the root was admitted. Its only new relationship is a checked
cross-link from the root aggregate. It does not become a mutable lineage store.

## The aggregate

Every newly admitted root is created at schema version 2 with these exact
top-level fields:

`schemaVersion`, `runId`, `laneId`, `revision`, `identity`, `counters`,
`incidents`, `blockingTasks`, `acceptanceGaps`, `technicalStop`,
`technicalCause`, `technicalCauseDigest`, `repair`, `createdAt`, `updatedAt`.

`identity` contains the admitted root identity and one registry cross-link:
`runId`, `lineageId`, `predecessorRunId`, `successorOrdinal`, `registeredAt`,
`admissionRequestDigest`, `admittedHead`, `admittedRepo`, and `rootRegistry`
(`runId`, `requestDigest`). For this slice a root has `lineageId === runId`, no
predecessor, and ordinal zero.

`repair` is exactly:

```json
{
  "state": "ACTIVE_ROOT",
  "maxSuccessors": 1,
  "successorsUsed": 0,
  "continuationEnvelope": null,
  "continuationDigest": null
}
```

The only other state in this slice is `STOPPED`. Stopping does not consume the
successor budget and does not claim a successor exists. `maxSuccessors: 1` is a
future allocation bound; `successorsUsed` remains zero because allocation is
deliberately absent.

Every schema-2 read validates exact keys, types, root invariants, terminal
shape, repair state, cause digest, continuation digest, and the live admission
registry cross-link. Missing, unknown, mistyped, future, internally
inconsistent, or tampered authority refuses before mutation. A registry entry
that is missing or disagrees with the root cross-link returns the distinct
`RUN_GUARD_REGISTRY_MISMATCH` failure.

## Named transitions and write serialization

Arbitrary `save(doc)` and `mutate(runId, callback)` are no longer authority
APIs. They fail with `RUN_GUARD_NAMED_TRANSITION_REQUIRED`. Production callers
use named reducers for counter spend, one counter clear after genuine forward
progress, acceptance-gap evidence, incident evidence, and terminal capture.
A stopped aggregate is immutable; only a byte-equivalent terminal capture is
idempotent. Every other transition returns `RUN_GUARD_TERMINAL`.

One gate refusal is a compound named transition, not two counter calls. The
reducer derives exactly `auto_advance_refusals:<step>` and
`auto_advance_refusals`, increments both while holding the same per-run lease,
and commits one revision. There is no generic multi-key mutation API. A failed
atomic replace exposes neither increment; concurrent processes preserve one
step and one total unit for every acknowledged event.

Writes are serialized across project-server processes by a per-run filesystem
lease. A writer first publishes an owner receipt containing protocol version,
random token, pid, hostname, run id, and timestamp. A contender reclaims only
when the receipt is valid, the hostname is local, and `kill(pid, 0)` proves the
owner is gone with `ESRCH`. A permanent token-specific reclaim claim prevents
a delayed stale reclaimer from moving a newer live owner. A live, foreign-host,
or unprovable owner is never stolen; bounded waiting ends in `RUN_GUARD_BUSY`.

The aggregate write itself is temp-file write, file fsync, atomic rename, and
directory fsync. The monotonic revision is checked again while the lease is
held. There is still no pruning, reset, delete, or implicit file creation on
load.

## Terminal authority boundary

The terminal transition has one commit point:

1. Build the canonical technical cause from the typed stop.
2. Build the bounded continuation envelope from the still-active workflow.
3. Commit both, their digests, and `repair.state = STOPPED` to the root
   aggregate.
4. Project the committed stop to `workflow-state.json` for existing readers.

If the aggregate commit fails, the workflow projection cannot claim durable
success. The in-process state boundary keeps the stop pending and refuses with
`TECHNICAL_STOP_PERSIST_FAILED`. If the aggregate commits and the workflow
projection crashes, a restart re-projects the aggregate's terminal truth over
the stale workflow. This ordering makes the root aggregate, not workflow file
timing, the authority boundary.

The canonical cause contains only version, run id, reason code, stopped step,
blocking tasks, and evidence. The continuation envelope is an allowlist of
workflow type/input, task packet, branch names, stopped step, round, sanitized
step states, task plan, task execution, and fix-task index. It excludes agents,
PIDs, tmux/session/window coordinates, timers, launch receipts, guard markers,
and successor mechanics. Those are live process details, not continuation
authority.

## Acceptance-gap authority boundary

Acceptance gaps are monotonic evidence in the same root aggregate. Recording a
gap merges a previously unseen task index; an empty or stale write cannot clear
one, and conflicting evidence for an already recorded index refuses. Every
workflow load, save, and snapshot restore projects the aggregate list and sets
the corresponding task state's `acceptanceCovered` to `false`. A stale workflow
that says `merge_to_main`, carries no gaps, or says the task is covered therefore
loads and persists with the aggregate evidence restored.

Creating new gap authority is guard-first. If the aggregate write fails, the
state boundary throws `ACCEPTANCE_GAP_PERSIST_FAILED` before it mutates the
workflow object or writes `workflow-state.json`; task execution cannot be marked
complete and merge cannot begin. Cancellation remains the escape hatch and does
not mutate either schema-1 or schema-2 authority. Technical-stop projection and
gap projection compose: a stopped workflow loads with both the terminal stop and
its acceptance gap intact.

## Legacy contract

Schema 1 is not migrated in place. It remains readable so historical runs can
render and cancel. Every authority mutation returns `LEGACY_READ_ONLY` and
leaves the file byte-identical. An unregistered id with no guard still loads as
an in-memory legacy empty document and writes nothing. A registered id with a
missing guard remains `RUN_GUARD_MISSING`.

## Red-first evidence

The permanent contract file is
`packages/project-server/lib/a1b2r-root-aggregate.test.js`, SHA-256
`4e73debbcaa7db475d642259ac714a8eb9f609f29dcb9a20ae2fd78658065b47`.
The identical file ran in a disposable detached worktree at frozen start SHA
`5be72a5e7195d0ee2c2dc5ad96db1773ae1ee743`: 9 tests, 0 passed, 9 failed, no
skip/todo. Failures proved the absent strict schema, lost cross-process spends,
missing lock and repair authority, mutable legacy state, missing canonical
cause/continuation, missing real stop-path aggregate, and missing registry
cross-link enforcement. The implemented slice runs the identical file 9/9.

The separate lock canary pins proved-dead reclamation and the permanent-token
protection for a new live lock. Existing A1a terminal/state-authority and A1b.1
admission/identity suites remain part of the mandatory regression matrix.

The post-implementation authority-repair canary is
`packages/project-server/lib/a1b2r-authority-repair.test.js`, SHA-256
`5008a88e5308b44ccea645e13323ec99ae2eff01378d2440dcd91b38eb8e772d`.
The identical file ran at frozen pre-repair SHA
`07d473106a87dacf8f4efa36501b8bb29041c582`: 7 tests, 0 passed, 7 failed, no
skip/todo. It reproduced the partial refusal spend (`revision` moved from 1 to
2 with only the per-step counter), absent compound APIs, stale save/snapshot gap
loss, and a guard persistence failure that still reached merge. The repaired
slice runs the same file 7/7, including an atomic-write failure after both
counter values were reduced in memory and 40 concurrent cross-process refusal
events with no lost spend.

## Deliberately not in Slice 1

- no successor id, allocation, registration, state, admission verdict, or
  `successorsUsed` increment;
- no successor API or CLI route;
- no successor worktree, branch, agent, tmux session/window, launch receipt,
  outbox, or background retry;
- no admission-registry schema change or lineage migration;
- no hub change and no product-policy change;
- no merge, push, release, or remote mutation.

These exclusions are acceptance criteria, not unfinished implementation. The
next slice requires a separate founder decision after this authority contract
has been reviewed.

## Operational notes and known limits

The only managed-project behavior change is fail-closed: schema-1 guard
authority cannot be advanced by the new server. It can still render and cancel.
Newly admitted roots receive schema 2 automatically. Token-specific stale-lock
claims are intentionally retained; they are tiny proof records and must not be
pruned until a separately designed retention model can preserve their safety
property.

Incident projection was re-evaluated during the authority repair and is not
extended in this slice. The concrete production consumers of
`wf.overseer.incidents` drive banner selection, deduplication, and explicit
operational recovery actions; they do not decide merge eligibility or
acceptance coverage. Incidents therefore remain aggregate evidence rather than
state-boundary decision authority. If a future consumer gates safety,
acceptance, or merge on incident absence, it must first gain a named monotonic
transition and the same projection/fail-closed treatment; a generic incident
overwrite is not sufficient.

This slice changes project-server JavaScript only. The hub has no changed file,
so hub typecheck/build is not part of the validation matrix. Rebuild/repackage
requirements are limited to the project-server-containing bundle used by the
operator.
