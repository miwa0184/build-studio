# Plan: A1a — state correctness and a single autonomous transition authority

> **Status: implemented 2026-08-31.** Ten verified fail-open paths in the
> workflow engine, each reproduced against the unchanged head before anything
> was written. This is the first of three technical slices (A1a/A1b/A1c) and
> carries no product change.

Owner request: before budgets, no-progress detection and acceptance receipts are
built on top of the workflow engine, close the paths where the engine already
walks past its own halts. An autonomy layer inherits whatever the state machine
underneath it will let through, so the fail-opens have to go first.

## The shape of the problem

The ten defects are not ten unrelated bugs. They fall into four groups, and each
group has one cause.

**A halt that no reader treats as terminal.** A task that exhausts its fix
cycles is marked `blocked`, and `launchNextTask` looks for the next task with
status `pending`. `blocked` is not `pending`, so the search comes up empty — for
the wrong reason — and the step reports completed. The run then advances to
`merge_for_review` carrying code a reviewer refused three times, and nothing
downstream re-reads the task states. `deriveNeedsAttention`, the one function
every consumer asks "does this need a human?", reads *step* status, so it
answered `null` about that run.

**Budgets kept where the loop can reach them.** The auto-advance refusal counter
was a `let` in the project-server process; the hub's round counter was React
state. A restart reset one, a reload the other. `another_round` set
`wf.round = 1` with the comment "restart the budget", and every cap check reads
`wf.round` — so a ceiling of five meant five rounds since the last click.
`fixPlan.tasks` had no ceiling at all: it was checked for being *empty*, and any
other length was accepted. And what did reach disk lived inside the workflow
object, which `saveWorkflow` writes whole with no revision check.

**Two autonomous drivers.** The server's 8-second tick and a React effect in
`workflow-view.tsx` both derived transitions and both POSTed them. They
disagreed by construction — the client deliberately left round-1 reviews manual
and the server did not — and the effect ran on *mount*, so opening the app could
carry a run past a halt the server had already decided on.

**No way to say "this broke".** Every halt had to borrow a shape that meant
something else. A strict review at its round cap with findings still open was
recorded as an approval, because "approve unless blocking" was the only fallback
available; the code said so in its own log line. Force-complete pasted an
agent's terminal scrollback into `agent.feedback` under a literal
`**Approved:** yes`, and every verdict parser reads approval by regexing that
string — so an operator ending a runaway agent manufactured positive review
evidence. And a single `pendingEscalation` slot, with five detectors written
`if (!overseer.pendingEscalation)`, meant the first symptom to fire hid all the
others.

## What was measured before writing anything

Each defect was reproduced against the unchanged head. Where an existing export
could express the defect, the permanent regression test itself fails on
behaviour; where the logic sits inline in a route handler, a probe drove the
real code paths and its output is recorded in the PR. Selected results:

- The `launchNextTask` selection returns `-1` with a blocked task present, and
  the branch it falls into sets `currentStep = 'merge_for_review'`.
- A save from a stale whole-object snapshot took `round` 4 → 1, dropped an
  intervention record, and dropped `capOverrides` entirely.
- Simulated against the old cap check, twenty review rounds ran under a cap of
  five, via four `another_round` renewals.
- Six overseer detectors sit behind the single-slot guard.
- At round 5/5 with findings open, the strict path computes `action = 'approve'`.

## What was decided

**A run guard, not a bigger workflow object.** The budgets that must not be
renewable moved to a separate file per run, with a monotonic revision and
lost-update detection. Deliberately small: it is not a replacement for the
workflow state, only the handful of fields a loop must not be able to rewind.
One file per run is also the seam a later multi-lane scheduler needs.

Rejected: adding a revision to `saveWorkflow` itself. That would touch every
write in the engine to fix a problem that only affects a dozen fields, and the
reproduced failure is specifically *stale whole-object* saves — the fix is to
stop keeping guard state inside that object.

**`blocked` is terminal, `skipped` is not.** A blocked task fails the run
closed: no transition toward merge, a typed stop naming every blocking task. An
operator-skipped task does *not* stop the step — a person decided that — but its
acceptance coverage stays unmet, so nothing can later claim it was verified.
Conflating the two would either strand operators or launder skips into passes.

**TECHNICAL_STOP as a type, with its properties stated as fields.** Not
approved, not a founder rejection, not auto-advanceable, not merge-eligible, not
acceptance-eligible — asserted as data as well as behaviour, so a reader holding
only the serialised object reaches the same conclusion as one holding the
helpers. `principal` is always `technical`: a technical fault is never a founder
question.

**Provenance, not a better regex.** Text cannot be trusted to describe its own
origin — a pane echoes the prompt, and the prompt contains the format example,
so scrollback legitimately contains approval markers that were never a verdict.
Origin is a separate structured field. Operator output is *kept*, because it is
genuinely useful diagnostic evidence, and labelled untrusted.

**Incidents, deduplicated.** Replacing one slot with an unbounded stream of
banners trades one failure for another. An incident is deduplicated by symptom
while open, several can be open at once, and resolving one leaves the rest.
`pendingEscalation` survives as a derived mirror of the most urgent open
incident so the existing banner keeps rendering — it is a view now, never a gate.

**The fix-plan ceiling follows `max_tasks_per_plan`.** A fix plan is a plan for
the same run against the same PRD, and the implementation-plan ceiling is the
one bound this codebase has already tuned against real runs. A second,
separately-guessed number would drift from it. `max_fix_plan_tasks` separates
them where a project needs it.

**The hub keeps its explicit actions.** It may render state and incidents, send
a user's explicit action, and toggle the server's auto-advance *policy*. It may
not decide a transition, hold a budget, or re-enable autonomy as a side effect
of being rendered. The manual advance / override / skip buttons are untouched —
they are the operator's escape hatch, and a fail-closed engine needs one.

## Deliberately not in A1a

Wallclock and agent-start budgets, progress fingerprinting and no-progress
detection, admission control, acceptance modes, the Founder Acceptance Receipt,
PR egress for managed projects, platform onboarding, dependency triage, a
general multi-lane scheduler. A1a is the state-correctness floor those are built
on; each of them is easier to reason about once the engine cannot walk past its
own halts.

Also not done: rebuilding the workflow state system. The separate guard store is
enough for what A1a has to guarantee, and a rewrite would have made the
regression surface far larger than the defects being closed.

## Known limits

- The per-step refusal count clears when that step genuinely advances; only the
  run-wide refusal budget is strictly monotonic. A step that alternates between
  refusing and advancing can therefore spend more than the per-step ceiling
  suggests — bounded by the run-wide budget, which is the one that matters.
- `wf.round` still exists and still drives per-loop routing and display. It is
  no longer the budget, but two numbers describing adjacent things is a
  simplification A1b should revisit.
- A pre-existing intermittent failure in `qa-suite-run.test.js` ("a full run is
  streamed to the log and parsed") reproduces on the unchanged head under
  full-suite parallelism and is untouched by this work.
