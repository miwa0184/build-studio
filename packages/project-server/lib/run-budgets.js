'use strict';

/**
 * The budgets, and the one place that decides whether one is spent.
 *
 * Every cap in the engine was renewable by something ordinary:
 *
 *   - `another_round` set `wf.round = 1`, and every cap check reads `wf.round`.
 *     A cap of 5 meant five rounds since the last reset. Simulated against the
 *     unmodified code, 20 rounds ran under a cap of 5 via four renewals.
 *   - The auto-advance refusal counter was a `let` in the server process, and
 *     re-enabling auto-advance cleared it deliberately.
 *   - `taskPlan.tasks` had a ceiling; `fixPlan.tasks` had none at all, so a fix
 *     planner could emit a list of any length.
 *   - Strict review at its cap with findings still open fell back to "approve
 *     unless blocking", turning an exhausted budget into an approval.
 *
 * The common cause is that the counters lived where the run's own bookkeeping
 * lives, and the run's bookkeeping is what a loop is allowed to change. So the
 * counters moved to the run guard (run-guard.js), which is a different file with
 * no reset path, and the cap questions moved here.
 *
 * `wf.round` still exists and still drives display and per-loop routing. It is
 * no longer the budget.
 *
 * Semantics, stated once: a ceiling of N means N ALLOWED units in this run.
 * Spending the Nth is within budget; asking for the (N+1)th is not.
 */

const { createTechnicalStop, REASON_CODES } = require('./technical-stop');

/** Mirrors DEFAULT_MAX_REVIEW_ROUNDS in config.js. */
const DEFAULT_MAX_REVIEW_ROUNDS = 5;
/** Mirrors the existing `max_tasks_per_plan` fallback in the planning gate. */
const DEFAULT_MAX_TASKS_PER_PLAN = 25;
/** Mirrors the existing MAX_FIX_CYCLES in the task-execution loop. */
const DEFAULT_MAX_TASK_FIX_CYCLES = 3;
/** Mirrors the existing AUTO_ADVANCE_MAX_REJECTS ceiling, now per run and on disk. */
const DEFAULT_MAX_AUTO_ADVANCE_REFUSALS = 3;
/**
 * The run-wide refusal ceiling, which is a different question from the per-step
 * one and must not share its number.
 *
 * Three refusals on ONE step means that step is stuck — pause it. Three
 * refusals across a whole run means almost nothing: a long execution sequence
 * has a dozen gated steps, and a run that pauses briefly at three of them is
 * ordinary, not runaway. Sharing the ceiling made the third refusal anywhere in
 * a run terminal, which turned a recoverable pause into a dead run in 24
 * seconds of ticks.
 *
 * The run-wide budget exists only to stop a run burning refusals forever, so it
 * is set well above what a healthy run spends: every step may pause several
 * times before the run itself is called stuck.
 */
const AUTO_ADVANCE_TOTAL_MULTIPLIER = 5;

const COUNTERS = {
  REVIEW_ROUNDS: 'review_rounds',
  FIX_ROUNDS: 'fix_rounds',
  AUTO_ADVANCE_REFUSALS: 'auto_advance_refusals',
  taskFixCycles: (taskIndex) => `task_fix_cycles:${taskIndex}`,
};

/**
 * Resolve every budget from project config.
 *
 * `max_fix_plan_tasks` defaults to `max_tasks_per_plan` rather than to a new
 * number of its own. The implementation plan's ceiling is the one bound this
 * codebase has already tuned against real runs — the planning gate's own message
 * explains that a plan past 25 means the PRD should have been split — and a fix
 * plan is a plan for the same run against the same PRD. A second, separately
 * guessed number would drift from it and mean nothing in particular. A project
 * that needs them apart can set `max_fix_plan_tasks` explicitly.
 */
function resolveBudgets(config) {
  const c = config || {};
  const maxTasksPerPlan = Number(c.max_tasks_per_plan) || DEFAULT_MAX_TASKS_PER_PLAN;
  const perStepRefusals = Number(c.max_auto_advance_refusals) || DEFAULT_MAX_AUTO_ADVANCE_REFUSALS;
  return {
    maxReviewRounds: Number(c.max_review_rounds) || DEFAULT_MAX_REVIEW_ROUNDS,
    maxFixRounds: Number(c.max_fix_rounds) || Number(c.max_review_rounds) || DEFAULT_MAX_REVIEW_ROUNDS,
    maxTaskFixCycles: Number(c.max_task_fix_cycles) || DEFAULT_MAX_TASK_FIX_CYCLES,
    maxTasksPerPlan,
    maxFixPlanTasks: Number(c.max_fix_plan_tasks) || maxTasksPerPlan,
    maxAutoAdvanceRefusals: perStepRefusals,
    maxAutoAdvanceRefusalsTotal:
      Number(c.max_auto_advance_refusals_total) || perStepRefusals * AUTO_ADVANCE_TOTAL_MULTIPLIER,
  };
}

function spend(guard, runId, counterKey, max, buildStop) {
  const { value, exceeded } = guard.bump(runId, counterKey, max);
  if (!exceeded) return { allowed: true, used: value, max };
  const technicalStop = buildStop(value);
  return { allowed: false, used: value, max, technicalStop };
}

/**
 * Spend one review round.
 *
 * Called wherever the engine used to do `wf.round++` before a cap check. The
 * counter is per RUN, so `another_round` resetting `wf.round` changes the label
 * on the round and nothing about the budget.
 */
function consumeReviewRound(guard, runId, budgets, ctx = {}) {
  return spend(guard, runId, COUNTERS.REVIEW_ROUNDS, budgets.maxReviewRounds, (used) =>
    createTechnicalStop({
      reasonCode: REASON_CODES.REVIEW_ROUND_BUDGET_EXHAUSTED,
      runId,
      step: ctx.step || 'reviewing',
      evidence: [
        `review_rounds=${used} exceeds max_review_rounds=${budgets.maxReviewRounds}`,
        'the budget is counted for the whole run and is not renewed by another_round, reload or restart',
      ],
      recoveryHint:
        `This run has used all ${budgets.maxReviewRounds} review rounds it is allowed. `
        + 'Raise max_review_rounds in .build-studio/config.yaml for future runs, or start a fresh run — '
        + 'the spent budget is not renewable inside this one.',
    }));
}

function consumeFixRound(guard, runId, budgets, ctx = {}) {
  return spend(guard, runId, COUNTERS.FIX_ROUNDS, budgets.maxFixRounds, (used) =>
    createTechnicalStop({
      reasonCode: REASON_CODES.FIX_ROUND_BUDGET_EXHAUSTED,
      runId,
      step: ctx.step || 'fix_execution',
      evidence: [
        `fix_rounds=${used} exceeds the run's fix-round budget of ${budgets.maxFixRounds}`,
        `source step: ${ctx.fixSource || 'unknown'}`,
      ],
      recoveryHint:
        'The fix loop has spent its budget for this run. Review the outstanding findings directly; '
        + 'a further attempt needs a new run, not another round here.',
    }));
}

/** Per-task fix cycles. Each task has its own budget; one task's does not spend another's. */
function consumeTaskFixCycle(guard, runId, taskIndex, budgets) {
  return spend(guard, runId, COUNTERS.taskFixCycles(taskIndex), budgets.maxTaskFixCycles, (used) =>
    createTechnicalStop({
      reasonCode: REASON_CODES.BLOCKED_TASKS,
      runId,
      step: 'task_execution',
      tasks: [{ index: taskIndex, name: `task ${taskIndex + 1}`, reason: `reached max fix cycles (${used - 1}/${budgets.maxTaskFixCycles})` }],
      evidence: [`task_fix_cycles:${taskIndex}=${used} exceeds ${budgets.maxTaskFixCycles}`],
      recoveryHint: 'The reviewer refused this task on every allowed fix cycle. Address the findings directly, then relaunch the task.',
    }));
}

function checkCeiling(tasks, max, reasonCode, ctx, what) {
  const n = Array.isArray(tasks) ? tasks.length : 0;
  if (n <= max) return { ok: true, count: n, max };
  return {
    ok: false,
    count: n,
    max,
    technicalStop: createTechnicalStop({
      reasonCode,
      runId: ctx.runId,
      step: ctx.step,
      evidence: [`${what} produced ${n} tasks, ceiling is ${max}`],
      recoveryHint:
        `A ${what} of ${n} tasks is past the ${max}-task ceiling. Merge tasks that touch the same surface, `
        + 'or split the work across runs — a plan this size does not converge inside one run.',
    }),
  };
}

function checkTaskPlanCeiling(tasks, budgets, ctx = {}) {
  return checkCeiling(tasks, budgets.maxTasksPerPlan, REASON_CODES.TASK_PLAN_CEILING, ctx, 'implementation plan');
}

/** F7: the ceiling fixPlan.tasks never had. */
function checkFixPlanCeiling(tasks, budgets, ctx = {}) {
  return checkCeiling(tasks, budgets.maxFixPlanTasks, REASON_CODES.FIX_PLAN_TASK_CEILING, ctx, 'fix plan');
}

/**
 * Record that a gate refused an auto-advance.
 *
 * Two counters, on purpose. The per-step one pauses a step that keeps being
 * refused and clears when that step actually advances — that is progress, not
 * renewal. The run-wide one never clears: a run that spends its whole refusal
 * budget across five different steps is as stuck as one that spent it on a
 * single step, and neither a restart nor re-enabling auto-advance gives it more.
 */
function noteAutoAdvanceRefusal(guard, runId, stepKey, budgets, errMsg) {
  const perStepKey = `${COUNTERS.AUTO_ADVANCE_REFUSALS}:${stepKey}`;
  const totalMax = budgets.maxAutoAdvanceRefusalsTotal;
  const perStep = guard.bump(runId, perStepKey, budgets.maxAutoAdvanceRefusals);
  const total = guard.bump(runId, COUNTERS.AUTO_ADVANCE_REFUSALS, totalMax);

  // Pausing a step is not the same event as giving up on the run, so the two
  // read different counters against different ceilings. `paused` fires when the
  // step has used its allowance; `exhausted` only when the RUN has used a much
  // larger one. `exceeded` carries the `> max` semantics stated at the top of
  // this file — spending the Nth unit is within budget.
  const paused = perStep.value >= budgets.maxAutoAdvanceRefusals;
  const exhausted = total.exceeded;

  const out = {
    paused,
    exhausted,
    stepCount: perStep.value,
    totalCount: total.value,
    max: budgets.maxAutoAdvanceRefusals,
    totalMax,
  };
  if (!exhausted) return out;

  out.technicalStop = createTechnicalStop({
    reasonCode: REASON_CODES.AUTO_ADVANCE_REFUSAL_BUDGET_EXHAUSTED,
    runId,
    step: stepKey,
    evidence: [
      `auto_advance_refusals=${total.value} of ${totalMax} allowed for this run`,
      `last refusal on ${stepKey}: ${errMsg || 'no message'}`,
    ],
    recoveryHint:
      'A gate has refused to advance this run as many times as its budget allows. Fix the cause the gate is '
      + 'reporting and advance the step explicitly — re-enabling auto-advance does not restore the budget.',
  });
  return out;
}

/** Clear the per-step refusal count. Called only when that step genuinely advanced. */
function clearStepRefusals(guard, runId, stepKey) {
  guard.mutate(runId, (doc) => { delete doc.counters[`${COUNTERS.AUTO_ADVANCE_REFUSALS}:${stepKey}`]; });
}

/**
 * What strict review does at its round cap.
 *
 * The old fallback was "approve unless blocking", which is how findings survived
 * into an approval — the code said so in its own log line: "findings remain but
 * round cap reached — approving". Reaching the cap is a statement about the
 * budget, not about the code, so the outcome must be typed as such.
 *
 * A1a stops here. Deciding whether to open a repair run against the remaining
 * findings is the orchestrator's call under A1b's budget model; this returns the
 * stop and nothing else. It never creates a founder question: a spent budget is
 * not a product decision.
 */
function strictReviewOutcome({ hasFindings, roundsUsed, budgets, ctx = {} }) {
  if (!hasFindings) return { kind: 'approve' };
  if (roundsUsed < budgets.maxReviewRounds) return { kind: 'escalate' };
  return {
    kind: 'technical_stop',
    technicalStop: createTechnicalStop({
      reasonCode: REASON_CODES.STRICT_REVIEW_CAP_WITH_FINDINGS,
      runId: ctx.runId,
      step: ctx.step || 'reviewing',
      evidence: [
        `round ${roundsUsed}/${budgets.maxReviewRounds} with findings still open`,
        ...(ctx.findings || []).slice(0, 10).map(String),
      ],
      recoveryHint:
        'Strict review ran out of rounds with findings still open. The findings are the outcome — read them '
        + 'and decide directly; the engine will not approve them away.',
    }),
  };
}

module.exports = {
  DEFAULT_MAX_REVIEW_ROUNDS,
  DEFAULT_MAX_TASKS_PER_PLAN,
  DEFAULT_MAX_TASK_FIX_CYCLES,
  DEFAULT_MAX_AUTO_ADVANCE_REFUSALS,
  COUNTERS,
  resolveBudgets,
  consumeReviewRound,
  consumeFixRound,
  consumeTaskFixCycle,
  checkTaskPlanCeiling,
  checkFixPlanCeiling,
  noteAutoAdvanceRefusal,
  clearStepRefusals,
  strictReviewOutcome,
};
