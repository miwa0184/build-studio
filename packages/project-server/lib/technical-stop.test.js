'use strict';

// F1 / F10 — TECHNICAL_STOP: the typed terminal outcome the engine had no way
// to express.
//
// Before this, every halt had to borrow a shape that meant something else. A
// task that exhausted its fix cycles was marked `blocked` and then walked past;
// a strict review that hit its cap with findings still open was APPROVED. Both
// produced a state a downstream reader could not distinguish from success.
//
// TECHNICAL_STOP is none of: approved, founder-rejected, auto-advanceable,
// merge-eligible, acceptance-eligible. It carries the evidence for why.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TECHNICAL_STOP,
  REASON_CODES,
  createTechnicalStop,
  isTechnicalStop,
  canAutoAdvance,
  countsAsApproval,
  isMergeEligible,
  isAcceptanceEligible,
} = require('./technical-stop');

function blockedTasksStop() {
  return createTechnicalStop({
    reasonCode: REASON_CODES.BLOCKED_TASKS,
    runId: 'run-a',
    step: 'task_execution',
    tasks: [
      { index: 2, name: 'Auth screen', reason: 'reached max fix cycles (3/3) with blocking findings' },
      { index: 5, name: 'Sync engine', reason: 'reached max fix cycles (3/3) with blocking findings' },
    ],
    evidence: ['taskStates.2.status=blocked', 'taskStates.5.status=blocked'],
    recoveryHint: 'Relaunch the blocked tasks after addressing the review findings, or cancel the run.',
  });
}

test('a technical stop is typed, and is not any kind of approval', () => {
  const stop = blockedTasksStop();
  assert.equal(stop.outcome, TECHNICAL_STOP);
  assert.equal(isTechnicalStop(stop), true);
  assert.equal(countsAsApproval(stop), false);
  assert.equal(stop.approved, false);
  assert.equal(stop.founderRejection, false);
});

test('a technical stop can never be auto-advanced, merged, or accepted', () => {
  const stop = blockedTasksStop();
  assert.equal(canAutoAdvance(stop), false);
  assert.equal(isMergeEligible(stop), false);
  assert.equal(isAcceptanceEligible(stop), false);
});

test('it carries reason code, run id, step, every blocking task, evidence and a recovery hint', () => {
  const stop = blockedTasksStop();
  assert.equal(stop.reasonCode, REASON_CODES.BLOCKED_TASKS);
  assert.equal(stop.runId, 'run-a');
  assert.equal(stop.step, 'task_execution');
  assert.equal(stop.tasks.length, 2);
  assert.deepEqual(stop.tasks.map((t) => t.index), [2, 5]);
  for (const t of stop.tasks) assert.match(t.reason, /max fix cycles/);
  assert.ok(stop.evidence.length >= 2);
  assert.match(stop.recoveryHint, /Relaunch/);
  assert.ok(stop.createdAt);
});

test('the reason code must be one of the declared codes', () => {
  assert.throws(
    () => createTechnicalStop({ reasonCode: 'MADE_UP', runId: 'r', step: 's' }),
    /reasonCode/,
  );
});

test('a strict review that hits its cap with findings open is a technical stop, not an approval', () => {
  const stop = createTechnicalStop({
    reasonCode: REASON_CODES.STRICT_REVIEW_CAP_WITH_FINDINGS,
    runId: 'run-a',
    step: 'reviewing',
    evidence: ['round 5/5', '**Medium:** 2 remain open'],
    recoveryHint: 'Address the remaining findings; the orchestrator may open a repair run.',
  });
  assert.equal(countsAsApproval(stop), false);
  assert.equal(canAutoAdvance(stop), false);
  // Explicitly NOT a question for the founder — this is a technical outcome.
  assert.equal(stop.principal, 'technical');
  assert.equal(stop.founderRejection, false);
});

test('reason codes cover the A1a halts', () => {
  for (const key of [
    'BLOCKED_TASKS',
    'STRICT_REVIEW_CAP_WITH_FINDINGS',
    'REVIEW_ROUND_BUDGET_EXHAUSTED',
    'FIX_ROUND_BUDGET_EXHAUSTED',
    'FIX_PLAN_TASK_CEILING',
    'TASK_PLAN_CEILING',
    'AUTO_ADVANCE_REFUSAL_BUDGET_EXHAUSTED',
  ]) {
    assert.equal(typeof REASON_CODES[key], 'string', `missing reason code ${key}`);
  }
});
