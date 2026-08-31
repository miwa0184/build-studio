'use strict';

// A1a canary — one synthetic run exercising the whole contract end to end.
//
// The individual F-tests each pin one defect. This drives a single fabricated
// workflow through the states that used to fail open, and asserts the six
// properties A1a exists to guarantee. If any one of them regresses, this fails
// even if a unit test elsewhere was quietly adjusted to match new behaviour.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunGuard } = require('./run-guard');
const { createOverseer } = require('./overseer');
const { resolveBudgets, consumeReviewRound, noteAutoAdvanceRefusal } = require('./run-budgets');
const { taskExecutionOutcome } = require('./blocked-tasks');
const { deriveNeedsAttention } = require('./needs-attention');
const { openIncident, openIncidents, PRINCIPALS, SEVERITIES } = require('./incidents');
const { countsAsApproval, countsAsAcceptanceEvidence } = require('./feedback-provenance');
const { TECHNICAL_STOP, REASON_CODES, canAutoAdvance, isMergeEligible } = require('./technical-stop');

const RUN_ID = 'canary-run-1';

function canaryWorkflow() {
  return {
    id: RUN_ID,
    type: 'execution',
    input: 'PRD-CANARY',
    sessionName: 'bs-canary',
    currentStep: 'task_execution',
    round: 1,
    autoAdvance: true,
    steps: { task_execution: { status: 'running', agents: [] }, merge_for_review: { status: 'pending', agents: [] } },
    taskPlan: { tasks: [{ name: 'Auth screen' }, { name: 'Sync engine' }, { name: 'Settings' }] },
    taskExecution: {
      currentTaskIndex: 1,
      taskStates: {
        0: { status: 'done' },
        1: { status: 'blocked', blockedReason: 'reached max fix cycles (3/3) with blocking findings' },
        2: { status: 'pending', agents: [] },
      },
    },
  };
}

test('canary 1 — a blocked task produces TECHNICAL_STOP', () => {
  const outcome = taskExecutionOutcome(canaryWorkflow());
  assert.equal(outcome.kind, 'technical_stop');
  assert.equal(outcome.technicalStop.outcome, TECHNICAL_STOP);
  assert.equal(outcome.technicalStop.reasonCode, REASON_CODES.BLOCKED_TASKS);
  assert.deepEqual(outcome.technicalStop.tasks.map((t) => t.name), ['Sync engine']);
});

test('canary 2 — no transition toward merge is possible from that stop', () => {
  const { technicalStop } = taskExecutionOutcome(canaryWorkflow());
  assert.equal(canAutoAdvance(technicalStop), false);
  assert.equal(isMergeEligible(technicalStop), false);

  // And the step itself never reports completed while a task is blocked.
  const wf = canaryWorkflow();
  const outcome = taskExecutionOutcome(wf);
  assert.notEqual(outcome.kind, 'complete');
  assert.notEqual(outcome.nextStep, 'merge_for_review');

  // The condition is visible to every consumer, not just to the caller.
  const attention = deriveNeedsAttention(wf);
  assert.ok(attention);
  assert.equal(attention.principal, 'technical');
});

test('canary 3 — reload and restart do not restore a spent budget', () => {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-canary-'));
  const budgets = resolveBudgets({ max_review_rounds: 3 });

  const first = createRunGuard({ statePath });
  for (let i = 0; i < 3; i++) assert.equal(consumeReviewRound(first, RUN_ID, budgets, { step: 'reviewing' }).allowed, true);
  for (let i = 0; i < budgets.maxAutoAdvanceRefusals; i++) noteAutoAdvanceRefusal(first, RUN_ID, 'qa_validation', budgets, 'gate refused');

  // "Reload the page" and "restart the server" are the same thing to the store:
  // a brand-new reader over the same disk.
  const afterReload = createRunGuard({ statePath });
  assert.equal(consumeReviewRound(afterReload, RUN_ID, budgets, { step: 'reviewing' }).allowed, false);
  assert.equal(noteAutoAdvanceRefusal(afterReload, RUN_ID, 'qa_validation', budgets, 'again').exhausted, true);

  // A different run is unaffected — budgets are run-scoped, not global.
  assert.equal(consumeReviewRound(afterReload, 'other-run', budgets, { step: 'reviewing' }).allowed, true);
});

test('canary 4 — two concurrent incidents are both detected', () => {
  let list = [];
  list = openIncident(list, {
    runId: RUN_ID, symptom: 'usage-limit-t1-ios', principal: PRINCIPALS.TECHNICAL,
    severity: SEVERITIES.WARNING, step: 'task_execution', agent: 't1-ios',
    description: 'iOS Dev hit a usage limit.', allowedRecoveryAction: 'nudge-agent',
  });
  list = openIncident(list, {
    runId: RUN_ID, symptom: 'package-lock-conflict', principal: PRINCIPALS.ORCHESTRATOR,
    severity: SEVERITIES.CRITICAL, step: 'task_execution',
    description: 'package-lock.json has conflict markers.', allowedRecoveryAction: 'resolve-conflict',
  });
  const open = openIncidents(list);
  assert.equal(open.length, 2, 'the second symptom must not be suppressed by the first');
  assert.deepEqual(open.map((i) => i.symptom).sort(), ['package-lock-conflict', 'usage-limit-t1-ios']);
  // A1a raises technical/orchestrator incidents — never a founder question for a technical fault.
  assert.ok(open.every((i) => i.principal !== PRINCIPALS.FOUNDER));
});

test('canary 5 — force-complete and kill-and-skip cannot become approval', () => {
  const wf = canaryWorkflow();
  wf.taskExecution.taskStates['1'] = {
    status: 'running', agents: [{ role: 'iOS Dev', window: 't2-ios', status: 'running', taskIndex: 1 }],
  };
  const state = {
    loadWorkflow: () => JSON.parse(JSON.stringify(wf)),
    saveWorkflow: (next) => { Object.assign(wf, JSON.parse(JSON.stringify(next))); },
  };
  const overseer = createOverseer({ projectRoot: '/nonexistent-project-root', port: 0 }, state, () => {});

  assert.equal(overseer.forceCompleteTaskAgent('t2-ios').ok, true);
  const agent = wf.taskExecution.taskStates['1'].agents[0];
  assert.equal(countsAsApproval(agent), false);
  assert.equal(countsAsAcceptanceEvidence(agent), false);
  assert.doesNotMatch(agent.feedback, /\*\*Approved:\*\*\s*yes/i);
  assert.notEqual(wf.taskExecution.taskStates['1'].status, 'done');
});

test('canary 6 — the hub cannot autonomously advance the workflow', () => {
  // The client's autonomy is a source-level property: the policy must not exist
  // to be re-enabled. Asserted here as part of the canary so the whole contract
  // fails together, and in full in hub-transition-authority.test.js.
  const view = path.join(__dirname, '..', '..', 'hub', 'components', 'workflow-view.tsx');
  const src = fs.readFileSync(view, 'utf8');
  assert.ok(!src.includes('AUTO_ADVANCE_MAX_ROUNDS'), 'client-side advance budget survives');
  assert.ok(!/\baction\s*=\s*['"`]send_to_devs['"`]/.test(src), 'client still computes a transition');

  const effectStart = src.indexOf('// Auto-advance logic');
  assert.equal(effectStart, -1, 'the client-side auto-advance effect still exists');
});
