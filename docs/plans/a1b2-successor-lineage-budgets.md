# Plan: A1b.2 — successor repair runs and lineage-wide budgets

> **Status: implemented and locally verified 2026-09-01.** This record was
> written before implementation and retains the red-first contract. The PR and
> protected CI receipts bind these results to the final remote head.
> Third state-correctness slice after A1a and A1b.1; no product or acceptance
> policy changes.

Owner request: a terminal technical failure may be repaired by a separate run,
without reopening the failed run and without asking for a product decision.
Creating a new run must not renew the finite resources that stopped the old
one. Identity, terminality and the recovery budget therefore belong to the
whole lineage, not to whichever workflow object happens to be active.

## Re-measured writers, routes and stores

The existing authority is split deliberately, and this slice keeps that split:

- `.build-studio/admission/registry.json` is the existence and identity store.
  `registry.admit` atomically consumes a nonce and registers a root run. There
  is no delete or prune API.
- `.build-studio/run-guard/<run>.json` is the terminality and per-run spend
  store. It holds review rounds, fix rounds, task fix cycles, auto-advance
  refusals, incidents, acceptance gaps and `TECHNICAL_STOP`. It has monotonic
  revisions and no reset/delete/prune API.
- `.build-studio/workflow-state.json` is operational state, written whole by
  the workflow router, feedback handlers, the auto-advance loop, the watchdog,
  the overseer and restore. `attachStateAuthority` is the common write boundary:
  it projects the guard's stop on every read, refuses unverifiable guards, and
  prevents restore or a stale workflow save from replacing terminal truth.
- `POST /api/workflow/start` and `POST /api/launch` are root ingresses.
  `POST /api/workflow/advance`, feedback, auto-advance, model override,
  restore/recover, the two overseer task actions and run merge are registered-
  run mutations at the central Express admission seam. Agent/worktree/dev-
  server/review-worktree/tmux creation has in-process admission backstops.
- The hub only reads state and sends HTTP requests. It does not own identity,
  terminality, budgets or transitions.

No other store can safely decide that a predecessor has no successor. A new
sidecar would have to transact with the registry and would create a two-file
split-brain window. The lineage ledger therefore extends the admission
registry: one file, one monotonic revision, one commit point.

## Measured renewable resources

The current per-run guard meters only resources the engine can measure
truthfully:

- review rounds (default 5),
- fix rounds (default follows review rounds),
- per-task fix cycles (default 3), and
- auto-advance refusals (default 3 per step, 15 total per run).

`wf.round` remains a display/routing label and is not a budget. Holds such as an
acceptance gap consume no counter. Wallclock, model tokens and monetary cost are
observable in some agents but are not complete or authoritative for every CLI
and every launch, so this slice does not claim to budget them.

A fresh run currently receives fresh versions of every counter above. That is
correct for independent root work and wrong for a repair chain: without a
lineage ledger, repeatedly creating a new run renews every measured recovery
resource.

## Authority and transaction model

Every root admission creates a lineage entry in the registry. The entry pins:

- immutable `lineageId` and `rootRunId`,
- immutable limits captured from validated server config,
- monotonic spend (`successorsCreated`, `recoveryUnits`, repeated-cause count),
- the ordered run ids and append-only successor events.

The registry write is protected by an exclusive same-filesystem lock in
addition to its revision check. Contending writers either observe the winner
and return that exact successor or receive a typed fail-closed refusal; two
processes cannot both commit children for one predecessor.

Successor creation has this order:

1. Read the registered predecessor and its guard. Verify a durable terminal
   `TECHNICAL_STOP`, technical principal, a whitelisted successor-recovery
   contract, lineage identity and budget availability. This is read-only.
2. In one locked registry mutation, re-check all facts that live in the
   registry, charge the lineage, mark the predecessor's single successor, and
   register the successor identity. **This is the commit point.**
3. Materialise the successor guard from the committed identity. A failure
   leaves a registered but unlaunchable run; replay resumes materialisation
   from the registry. It never creates a runnable orphan.
4. Replace the active workflow with a repair workflow carrying structured
   predecessor evidence. Only after the committed registry and guard are
   readable may branch/worktree/state/agent side effects begin.

The predecessor guard and registry entry are never edited back to active. A
successor has a new `runId`, the same `lineageId`, the exact
`predecessorRunId`, and `successorOrdinal + 1`. Replay returns the already
committed successor; it never spends twice.

## Budget semantics and defaults

`max_successor_runs` defaults to 2. The cumulative recovery charge is concrete:
one unit for the terminal recovery event plus the predecessor guard's measured
review rounds, fix rounds, auto-advance refusals and every task-fix-cycle
counter. Standing holds and observation time are absent and cost zero.

`max_lineage_recovery_units` defaults to 58 under the shipped per-run defaults:
two repair attempts times `(5 review + 5 fix + 15 refusal + 3 task-fix + 1
terminal event)`. Actual charging sums every task-fix counter, so a run that
spent cycles on several tasks can stop earlier than this illustrative default.
Both values are validated, captured when the root lineage is created, and are
never recomputed upward for an existing lineage.

A deterministic cause fingerprint hashes the technical reason, step, tasks and
evidence (excluding run id and timestamps). `max_lineage_no_progress_repeats`
defaults to 1: one repeated identical cause may receive the remaining repair
attempt, a second repetition refuses. This detects the exact same recorded
failure, not semantic code progress. The latter remains separate work; this
slice does not pretend a changed commit or an agent assertion proves progress.

Budget refusal happens before guard creation, workflow replacement, branch,
worktree or agent launch. It is terminal and typed, carries the ledger evidence,
does not create a founder question, and is idempotent across replay/restart.

## Repair workflow and continuation

A successor begins on one `successor_repair` step with one technical builder.
Its prompt contains the predecessor id, reason, step, tasks, evidence and cause
fingerprint, and explicitly forbids changing product requirements or acceptance
policy. It must report a structured repaired/not-repaired outcome and evidence.

A reported repair failure creates a new technical stop bound to the same cause
fingerprint. The same successor machinery may make the next bounded attempt.
A reported repair success is not trusted on its own. Before the repair agent is
launched, the server records the repository's exact Git head. Continuation
requires a different head that Git proves is a forward descendant of that
baseline; an uncommitted edit, rewritten history, evidence-shaped prose or a
free-form `yes` is a repeated failure. The head delta is deterministic evidence
that a concrete repair candidate exists, **not** semantic proof that the cause
is fixed. The original stopped step is therefore re-run and remains responsible
for the real verification and acceptance evidence.

Only then does the *successor* — never the predecessor — move onto the
predecessor's stopped step with that step's transient agent state reset. The
original type, input, branch and remaining verification pipeline continue under
the successor id. This is the canary that terminal predecessor evidence and
forward progress can coexist without overstating what a commit proves.

## Enforcement boundaries

- The registry is the only writer of lineage identity, successor pointers and
  lineage spend.
- The run guard remains the only writer of per-run spend and terminality.
- State restore may restore operational fields only; registry identity, lineage
  spend and guard terminality are outside the snapshot and cannot be lowered.
- The successor HTTP route is classified by the admission seam and has a
  handler backstop. Agent/worktree launch still verifies the successor's stored
  admission context.
- Product, acceptance and founder outcomes are not eligible inputs. A field
  named `TECHNICAL_STOP` is insufficient: principal, terminal properties,
  recovery contract and reason whitelist must all agree.

If a consumption-point backstop is the first thing to reject a normally routed
request, that remains a primary-gate defect.

## Retention

No compaction is required for this slice. Admission entries, nonces, lineage
events and guard files remain append-only. Time- or count-based deletion cannot
preserve the negative proof "this predecessor already had a successor" without
another authoritative archive, so adding one now would increase rather than
reduce risk. Storage growth remains a known, bounded-per-run cost.

## Deliberately not in A1b.2

Acceptance receipts and managed-project PR egress, one-shot ingress expansion,
platform onboarding, dependency triage, a multi-lane scheduler, product policy,
semantic progress detection, complete token/cost accounting, or a retention
subsystem. No new dependency is needed.

## Red-first receipt

The permanent A1b.2 tests were copied into a disposable worktree at the exact
start SHA `5be72a5e7195d0ee2c2dc5ad96db1773ae1ee743` before implementation:

- lineage contract: 0/10 passed because `admission.createSuccessor` did not
  exist;
- real-server route: 0/2 passed because
  `POST /api/workflow/successor` returned 404.

The implemented contract now contains 12 lineage tests and six actual-server
canaries, including concurrent creation, cumulative spend, replay, restart,
exact cap persistence, autonomous startup reconciliation on both sides of the
workflow/agent-launch boundary, and rejection of a free-form success assertion
without a forward Git delta. Transient registry contention is a bounded,
retryable 503 and is never presented as an exhausted lineage. The final
exact-head server CI receipt is recorded on the PR.

## Final local verification receipt

- Focused A1b.2 contract: 12 lineage tests plus six actual-server canaries,
  18/18 passed.
- Full project-server suite (`node --test` from `packages/project-server`):
  three fresh runs after the final code changes, each 1007/1007 passed.
- One earlier full-suite attempt exposed an existing stream race: counters were
  complete while the promised QA log could still be empty. The focused test
  passed in isolation, but inspection showed the child `close` handler resolved
  before the file stream's `finish`. The production promise now waits for the
  flush; the three clean full runs above are all after that repair.
- Hub: `npm run typecheck` passed and `npx next build` completed all 11 static
  pages and dynamic routes. Turbopack retained one pre-existing NFT tracing
  warning in `next.config.ts`; it did not fail compilation or type checking.
- `package-lock.json`, both changed workspaces' `package.json` files and their
  hashes were unchanged. No dependency was added.
