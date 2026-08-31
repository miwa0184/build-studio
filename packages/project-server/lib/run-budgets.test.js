'use strict';

// F7 / F9 / F10 / F4 — the budgets that were renewable.
//
//   F9  `another_round` set `wf.round = 1`, so a cap of 5 was five rounds
//       *since the last reset* — renewable for as long as anyone kept clicking.
//   F7  the implementation plan has a task ceiling; fixPlan.tasks had none, so a
//       fix planner could emit an unbounded task list.
//   F10 strict review at its cap with findings still open fell back to
//       "approve unless blocking" — findings survived into an approval.
//   F4  the auto-advance refusal counter lived in process memory.
//
// The budgets are now counted in the run guard and read from here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunGuard } = require('./run-guard');
const {
  resolveBudgets,
  consumeReviewRound,
  consumeFixRound,
  consumeTaskFixCycle,
  checkTaskPlanCeiling,
  checkFixPlanCeiling,
  noteAutoAdvanceRefusal,
  strictReviewOutcome,
} = require('./run-budgets');
const { TECHNICAL_STOP, REASON_CODES } = require('./technical-stop');

function guard() {
  return createRunGuard({ statePath: fs.mkdtempSync(path.join(os.tmpdir(), 'bs-budgets-')) });
}

test('budgets come from config, defaulting to the values the engine already ships', () => {
  const b = resolveBudgets({});
  assert.equal(b.maxReviewRounds, 5);          // DEFAULT_MAX_REVIEW_ROUNDS
  assert.equal(b.maxTasksPerPlan, 25);         // existing max_tasks_per_plan default
  assert.equal(b.maxFixPlanTasks, 25);         // F7: same established ceiling, now enforced
  assert.equal(b.maxTaskFixCycles, 3);         // existing MAX_FIX_CYCLES
  assert.ok(b.maxAutoAdvanceRefusals >= 3);

  const custom = resolveBudgets({ max_review_rounds: 2, max_tasks_per_plan: 8, max_fix_plan_tasks: 4 });
  assert.equal(custom.maxReviewRounds, 2);
  assert.equal(custom.maxTasksPerPlan, 8);
  assert.equal(custom.maxFixPlanTasks, 4);
});

test('a configured cap of 5 means exactly five allowed review rounds in the run', () => {
  const g = guard();
  const b = resolveBudgets({ max_review_rounds: 5 });
  const allowed = [];
  for (let i = 0; i < 6; i++) allowed.push(consumeReviewRound(g, 'run-a', b, { step: 'reviewing' }).allowed);
  assert.deepEqual(allowed, [true, true, true, true, true, false]);
});

test('F9 — resetting wf.round does not renew the review budget', () => {
  const g = guard();
  const b = resolveBudgets({ max_review_rounds: 5 });
  const wf = { id: 'run-a', round: 1 };
  for (let i = 0; i < 5; i++) { consumeReviewRound(g, wf.id, b, { step: 'reviewing' }); wf.round++; }

  // "another_round": the old code set wf.round = 1 and the loop began again.
  wf.round = 1;

  const sixth = consumeReviewRound(g, wf.id, b, { step: 'reviewing' });
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.technicalStop.outcome, TECHNICAL_STOP);
  assert.equal(sixth.technicalStop.reasonCode, REASON_CODES.REVIEW_ROUND_BUDGET_EXHAUSTED);
});

test('F4 — the review budget survives a project-server restart', () => {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-budgets-restart-'));
  const b = resolveBudgets({ max_review_rounds: 3 });
  const before = createRunGuard({ statePath });
  for (let i = 0; i < 3; i++) consumeReviewRound(before, 'run-a', b, { step: 'reviewing' });

  const after = createRunGuard({ statePath }); // restart
  assert.equal(consumeReviewRound(after, 'run-a', b, { step: 'reviewing' }).allowed, false);
});

test('fix rounds and per-task fix cycles are budgeted the same way', () => {
  const g = guard();
  const b = resolveBudgets({ max_review_rounds: 2 });
  assert.equal(consumeFixRound(g, 'run-a', b, { step: 'fix_execution' }).allowed, true);
  assert.equal(consumeFixRound(g, 'run-a', b, { step: 'fix_execution' }).allowed, true);
  const over = consumeFixRound(g, 'run-a', b, { step: 'fix_execution' });
  assert.equal(over.allowed, false);
  assert.equal(over.technicalStop.reasonCode, REASON_CODES.FIX_ROUND_BUDGET_EXHAUSTED);

  for (let i = 0; i < 3; i++) assert.equal(consumeTaskFixCycle(g, 'run-a', 0, b).allowed, true);
  assert.equal(consumeTaskFixCycle(g, 'run-a', 0, b).allowed, false);
  // A different task has its own cycle budget.
  assert.equal(consumeTaskFixCycle(g, 'run-a', 1, b).allowed, true);
});

test('F7 — fixPlan.tasks has a hard ceiling, like the implementation plan', () => {
  const b = resolveBudgets({ max_fix_plan_tasks: 3 });
  assert.equal(checkFixPlanCeiling(new Array(3).fill({ name: 'x' }), b, { runId: 'run-a', step: 'fix_plan' }).ok, true);

  const over = checkFixPlanCeiling(new Array(4).fill({ name: 'x' }), b, { runId: 'run-a', step: 'fix_plan' });
  assert.equal(over.ok, false);
  assert.equal(over.technicalStop.outcome, TECHNICAL_STOP);
  assert.equal(over.technicalStop.reasonCode, REASON_CODES.FIX_PLAN_TASK_CEILING);
  assert.match(over.technicalStop.evidence.join(' '), /4/);
});

test('the task-plan ceiling is a technical stop too', () => {
  const b = resolveBudgets({ max_tasks_per_plan: 2 });
  const over = checkTaskPlanCeiling(new Array(5).fill({ name: 'x' }), b, { runId: 'run-a', step: 'planning' });
  assert.equal(over.ok, false);
  assert.equal(over.technicalStop.reasonCode, REASON_CODES.TASK_PLAN_CEILING);
});

test('F4 — auto-advance refusals are counted on disk and are not renewed by re-enabling', () => {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-budgets-aa-'));
  const b = resolveBudgets({});
  const g1 = createRunGuard({ statePath });
  let last;
  for (let i = 0; i < b.maxAutoAdvanceRefusals; i++) {
    last = noteAutoAdvanceRefusal(g1, 'run-a', 'qa_validation', b, 'gate said no');
  }
  assert.equal(last.exhausted, true);
  assert.equal(last.technicalStop.reasonCode, REASON_CODES.AUTO_ADVANCE_REFUSAL_BUDGET_EXHAUSTED);

  // Restart + re-enable auto-advance: the budget is still spent.
  const g2 = createRunGuard({ statePath });
  assert.equal(noteAutoAdvanceRefusal(g2, 'run-a', 'qa_validation', b, 'again').exhausted, true);
});

test('F10 — strict review at its cap with findings open is a technical stop, never an approval', () => {
  const b = resolveBudgets({ max_review_rounds: 5 });
  const ctx = { runId: 'run-a', step: 'reviewing', findings: ['**Medium:** 2'] };

  const under = strictReviewOutcome({ hasFindings: true, roundsUsed: 2, budgets: b, ctx });
  assert.equal(under.kind, 'escalate');

  const atCap = strictReviewOutcome({ hasFindings: true, roundsUsed: 5, budgets: b, ctx });
  assert.equal(atCap.kind, 'technical_stop');
  assert.notEqual(atCap.kind, 'approve');
  assert.equal(atCap.technicalStop.reasonCode, REASON_CODES.STRICT_REVIEW_CAP_WITH_FINDINGS);
  assert.equal(atCap.technicalStop.principal, 'technical');
  // No founder question is created for a technical outcome.
  assert.equal(atCap.technicalStop.founderRejection, false);
  assert.equal(atCap.founderQuestion, undefined);
});

test('F10 — a strict review with no findings left approves normally', () => {
  const b = resolveBudgets({ max_review_rounds: 5 });
  const clean = strictReviewOutcome({ hasFindings: false, roundsUsed: 5, budgets: b, ctx: { runId: 'run-a', step: 'reviewing' } });
  assert.equal(clean.kind, 'approve');
});
