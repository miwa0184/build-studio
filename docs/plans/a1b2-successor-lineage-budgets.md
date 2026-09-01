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

### Authority/state closure table

| State or transition | Server-owned authority | Fail-closed proof | May create external CLI side effect? | Terminal/ambiguous states |
| --- | --- | --- | --- | --- |
| Registry schema | The complete on-disk registry document at one supported `schemaVersion` | Deep schema validation precedes every read or mutation; unknown future schemas and partial schema-2 documents refuse | No | Corrupt or unknown schema is terminal until repaired out of band |
| Nonce and request identity | Canonical RunRequest plus its server-computed digest, cross-linked from the root run and consumed nonce entry | Digest is recomputed; nonce, run, verdict, lineage and request identity must agree bidirectionally | No | Missing, mistyped or inconsistent schema-2 authority refuses; only explicit v1 capture may add the new binding |
| Canonical cause identity | Canonical predecessor technical cause (`reasonCode`, step, tasks and evidence), never a supplied fingerprint | Server recomputes the digest with stable recursive key ordering; stored digest is only a checked receipt | No | Missing source or digest mismatch is terminal authority corruption |
| Lineage charge | One locked registry mutation over predecessor claim, ordered runs/events, immutable limits and cumulative spend | Charge and cause are revalidated inside the registry lock before the one commit point | No | Budget exhaustion and corrupt lineage authority are terminal refusals |
| Launch attempt/outbox | Per-run launch receipt under the launch lock: intent -> dispatching -> started -> completed, or terminal | Immutable attempt and Git identity; every transition is monotonic and durable before the next boundary | Only `dispatching` may attempt one `send-keys`; only durable `started` may invoke the CLI | A dispatched attempt without provable safe adoption becomes `LAUNCH_AMBIGUOUS`; it is never relaunched |
| Git branch/ref/head/tree | Durable baseline captured before successor commit and copied into the immutable launch attempt | Attached concrete ref, exact head/tree and clean status are checked under launch exclusion immediately before send; the executed wrapper repeats the same check before `started` and CLI | Yes, only after both the durable dispatch claim and final server check | Detached, wrong ref, dirty tree or head/tree drift is a typed terminal launch refusal |
| External side-effect transition | The launch receipt plus verified admission context and exact Git identity | At-most-once dispatch is chosen over false liveness across filesystem/tmux/process boundaries | Exactly one attempted dispatch; no automatic retry after dispatch begins | Unprovable post-dispatch state is terminal ambiguity, not evidence that the process never started |

Exactly-once execution cannot be proven across the filesystem/tmux/process
boundary. The implementable contract is therefore at-most-once dispatch plus a
terminal ambiguity outcome. Liveness is intentionally surrendered whenever a
crash leaves insufficient proof that the assignment was not sent.

Every root admission creates a lineage entry in the registry. The entry pins:

- immutable `lineageId` and `rootRunId`,
- immutable limits captured from validated server config,
- monotonic spend (`successorsCreated`, `recoveryUnits`, repeated-cause count),
- the ordered run ids and append-only successor events.

The registry write is protected by an exclusive same-filesystem lock in
addition to its revision check. Contending writers either observe the winner
and return that exact successor or receive a typed fail-closed refusal; two
processes cannot both commit children for one predecessor.

Schema 2 is authority, not a best-effort cache. Every read and pre-write check
validates run identity, immutable limits, cumulative spend, the ordered run
chain and its append-only events as one internally consistent document. Unknown
future versions and partial schema-2 structures fail closed with typed path
evidence; no missing schema-2 authority field is defaulted. The only upgrade is
an explicit schema-1→schema-2 transaction that captures every legacy root with
complete limits before the first schema-2 write.

The per-run guard applies the same discipline at a finer key: a mkdir lock
serialises the complete read/mutate/rename cycle for that run. A revision check
alone did not close the cross-process TOCTOU window. Once `technicalStop` is
durable the whole guard freezes, including every charged counter, so successor
charging reads a stable terminal document and no late writer can replace the
stop with a stale pre-stop snapshot.

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
   predecessor evidence. Before tmux or a CLI starts, persist a deterministic
   launch attempt and the planned agent under a separate per-run launch lock.
   The wrapper records durable `started` and `completed` receipts. Restart
   adopts the exact matching live window; it never kill-replaces a started
   attempt. If process state and receipts cannot prove safe adoption or safe
   first launch, the step parks with a typed technical failure instead of
   risking duplicate repository side effects.

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
launched, the server records the repository's exact Git head and full branch
ref. Launch and continuation both require that same concrete ref. Continuation
also requires a different head that Git proves is a forward descendant, a
non-empty committed tree delta from the baseline, **and** an empty index/worktree under
`git status --porcelain=v1 --untracked-files=all`; staged, unstaged or untracked
residue, an allow-empty commit, branch drift, rewritten history,
evidence-shaped prose or a free-form `yes` is a repeated failure. Typed branch,
tree and dirty-path evidence is retained in the refusal. The clean same-ref
tree delta is deterministic evidence that a concrete repair candidate exists,
**not** semantic proof that the cause is fixed. The original stopped step is
therefore re-run and remains responsible for the real verification and
acceptance evidence.

Only then does the *successor* — never the predecessor — move onto the
predecessor's stopped step with that step's transient agent state reset. The
original type, input, branch and remaining verification pipeline continue under
the successor id. This is the canary that terminal predecessor evidence and
forward progress can coexist without overstating what a commit proves.

## Enforcement boundaries

- The registry is the only writer of lineage identity, successor pointers and
  lineage spend.
- The run guard remains the only writer of per-run spend and terminality.
- The run guard serialises all writers across processes and is immutable after
  its first durable terminal stop.
- The successor launch receipt is the only writer of repair attempt identity
  and external-process lifecycle; workflow state mirrors it for rendering.
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

The implemented contract now contains 12 lineage tests and eleven actual-server
canaries, including concurrent creation, cumulative spend, replay, restart,
exact cap persistence, autonomous startup reconciliation on both sides of the
workflow/agent-launch boundary, rejection of a free-form success assertion,
all three dirty-worktree shapes after a valid forward commit, a crash
immediately after real `send-keys`, and a synchronised two-server launch race.
Two additional run-guard tests exercise 40 concurrent process writers and a
counter/terminal-stop race. Transient registry contention is a bounded,
retryable 503 and is never presented as an exhausted lineage. The final
exact-head server CI receipt is recorded on the PR.

### Authority-closure red-first receipt

The P1-A–D authority mutations were copied into a separate disposable worktree
at exact start head `ef0c887a5758abba27e7ee02abb231d52e426779`. Production
files were unchanged there. Every new assertion failed before this closure:

- P1-A: 0/5 passed. Deleting the consumed nonce reconstructed usable authority;
  missing or mistyped nonce digests and missing or inconsistent root request
  identities were accepted.
- P1-B: 0/2 passed. No canonical predecessor cause source existed, and replacing
  a structurally valid cached cause fingerprint did not invalidate authority.
- P1-C: 0/1 passed against a real server. After `send-keys`, deleting the launch
  receipt, killing the exact tmux window and restarting caused a second launch
  instead of terminal `LAUNCH_AMBIGUOUS`.
- P1-D: 0/1 passed against a real server. Switching branch after window creation
  but before `send-keys` still launched the repair CLI.

The same permanent tests now exercise fail-closed nonce/request binding,
canonical cause recomputation, durable pre-send dispatch retirement, and both
server-side and executed-wrapper Git self-checks. Their green counts belong to
the final local verification receipt below; protected CI and independent review
must bind the result to one frozen remote head.

## Independent review and bounded repair receipt

The single context-free review of frozen head
`0c96a7901728871fa173566c80418a5d6b9c6bb4` returned `REPAIR_REQUIRED` and
blocked merge. It independently reproduced three release blockers:

1. the run-guard revision check had a cross-process TOCTOU window that lost
   acknowledged counters and could overwrite terminal truth;
2. a forward descendant plus dirty staged/unstaged/untracked state was accepted
   as progress; and
3. the repair CLI started before its running receipt was persisted, so crash or
   two servers could kill-replace/relaunch one assignment.

The one authorised repair round fixes those causes rather than weakening the
contract. A fresh context-free reviewer must falsify the new exact head after
protected CI; no merge is permitted on the first head or on inherited review.

A second frozen review of `e43aff8a2a33f3ba2e4f58e32413f5589d350fc0`
returned `REPAIR_REQUIRED` and found four further blockers: partial schema-2
lineage authority failed open; a failed wrapper `started` write still invoked
the CLI; allow-empty or wrong-branch commits counted as progress; and C8 could
finish before a delayed second launch. The successor repair adds deep
schema-specific validation with one explicit v1 upgrade, hard-gates the CLI on
durable `started`, binds launch and approval to the captured ref plus a real
tree delta, and strengthens C8 with two-contender reconciliation and a bounded
stability window. This repair likewise requires protected exact-head CI and one
new context-free review; inherited green status is not a merge verdict.

## Final local verification receipt

- Focused authority closure after the final code change: lineage plus A1b.1
  identity 41/41 passed, and the real-server/wrapper canary 28/28 passed. The
  matrix includes the original P1-A–D mutations plus canonical request-derived
  verdict/guard drift, a nonce forged onto a successor, live-guard cause drift
  hidden behind replay, visible-stop/canonical-cause divergence, monotonic
  terminal/completed receipt replay, exact clean wrapper success, detached/wrong
  branch and same-branch head/tree refusal, lost receipt plus lost tmux window,
  and the ensure-window/send boundary. The external CLI count stays zero in
  every refusal case.
- The earlier repair canaries remain in the same real-server suite: partial
  schema authority across identity/limits/spend/run/event invariants,
  missing/unreadable/unwritable started receipts with crash/restart, live-server
  confirmation, allow-empty and branch-drift refusal, every dirty-worktree
  shape, positive clean same-ref tree progress and local CLI retry. The two
  cross-process run-guard stress tests also pass. A disposable delayed-duplicate
  mutation still makes strengthened C8 fail at `observed 2`, proving its
  post-reconciliation stability window is active.
- The final focused historical A1b.1/A1b.2 matrix passed 149/149 with zero
  skips, cancellations or todos against the same frozen local code.
- Full project-server suite (`node --test` from `packages/project-server`):
  three fresh successful processes after the final authority-closure code
  changes, each 1052/1052 passed with zero skips, cancellations or todos. One
  non-counted intervening attempt hit the operating system's transient `EMFILE`
  limit in `watch-paths.test.js` (1051/1052); the unchanged watcher suite then
  passed 6/6 in isolation and the replacement full process passed 1052/1052.
- One pre-final repair run reached 1011/1014: three direct-router fixtures had
  `projectRoot` but omitted the normalised `statePath` that the real server
  always supplies. The launch store now uses the same
  `<projectRoot>/.build-studio` fallback as state authority; the focused three
  tests and every final full run pass without loosening their assertions.
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
