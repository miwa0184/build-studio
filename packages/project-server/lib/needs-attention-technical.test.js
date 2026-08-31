'use strict';

// F2 — a blocked task was invisible.
//
// deriveNeedsAttention reads STEP status. When a task exhausted its fix cycles
// the TASK went to `blocked` while task_execution was marked `completed` and the
// run moved on, so the one function every consumer asks "does this need a
// human?" answered `null` about a workflow carrying refused code.
//
// It must also tell a technical halt apart from a gate waiting on a person:
// TECHNICAL_STOP is not an owner decision, and presenting it as one sends the
// wrong human at the wrong problem.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveNeedsAttention } = require('./needs-attention');

// Built as a literal rather than imported, so this file exercises
// deriveNeedsAttention on its own and fails on behaviour, not on a missing
// module. technical-stop.js pins the shape itself.
const BLOCKED_TASKS = 'BLOCKED_TASKS';

function afterBlockedTask(currentStep) {
  return {
    id: 'run-a',
    type: 'execution',
    input: 'PRD-001',
    currentStep,
    round: 1,
    steps: {
      task_execution: { status: 'completed', agents: [] },
      merge_for_review: { status: 'pending', agents: [] },
    },
    taskPlan: { tasks: [{ name: 'Auth screen' }, { name: 'Sync engine' }] },
    taskExecution: {
      currentTaskIndex: 1,
      taskStates: {
        0: { status: 'done' },
        1: { status: 'blocked', blockedReason: 'reached max fix cycles (3/3)' },
      },
    },
  };
}

test('a blocked task is surfaced even though task_execution says completed', () => {
  const n = deriveNeedsAttention(afterBlockedTask('merge_for_review'));
  assert.ok(n, 'a workflow carrying a blocked task must not report "nothing needed"');
  assert.equal(n.reason, 'blocked_task');
  assert.match(n.detail, /Sync engine/);
  assert.match(n.detail, /max fix cycles/);
});

test('a blocked task is a technical condition, not an owner decision', () => {
  const n = deriveNeedsAttention(afterBlockedTask('merge_for_review'));
  assert.equal(n.principal, 'technical');
});

test('a recorded TECHNICAL_STOP is reported as a technical halt with its reason code', () => {
  const wf = afterBlockedTask('technical_stop');
  wf.technicalStop = {
    outcome: 'TECHNICAL_STOP',
    schemaVersion: 1,
    reasonCode: BLOCKED_TASKS,
    principal: 'technical',
    runId: 'run-a',
    step: 'task_execution',
    tasks: [{ index: 1, name: 'Sync engine', reason: 'reached max fix cycles (3/3)' }],
    evidence: ['taskStates.1.status=blocked'],
    recoveryHint: 'Relaunch the blocked task after addressing the findings.',
    approved: false,
    founderRejection: false,
    createdAt: new Date().toISOString(),
  };
  wf.steps.technical_stop = { status: 'blocked' };

  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'technical_stop');
  assert.equal(n.principal, 'technical');
  assert.equal(n.reasonCode, BLOCKED_TASKS);
  assert.match(n.detail, /Sync engine/);
  assert.match(n.action, /Relaunch/);
});

test('a human gate is still reported as an owner decision', () => {
  const wf = {
    id: 'run-a', type: 'execution', input: 'PRD-001', currentStep: 'device_testing',
    steps: { device_testing: { status: 'pending', agents: [] } },
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'human_gate');
  assert.equal(n.principal, 'founder');
});

test('a clean run with every task done still needs nothing', () => {
  const wf = afterBlockedTask('merge_for_review');
  wf.taskExecution.taskStates['1'] = { status: 'done' };
  assert.equal(deriveNeedsAttention(wf), null);
});

// ── Repair round 1 ────────────────────────────────────────────────────────────
// Recording a task as unverified and never reading it left the coverage claim
// exactly as false as before. Acceptance gaps are surfaced, and the
// auto-advance tick refuses the steps where the claim is about to be made.

test('a skipped task is reported once the run reaches an acceptance-sensitive step', () => {
  const wf = afterBlockedTask('ac_verification');
  wf.steps.ac_verification = { status: 'pending', agents: [] };
  wf.taskExecution.taskStates['1'] = { status: 'skipped', acceptanceCovered: false };

  const n = deriveNeedsAttention(wf);
  assert.ok(n, 'an unverified task at ac_verification must not report "nothing needed"');
  assert.equal(n.reason, 'acceptance_gap');
  assert.equal(n.principal, 'technical');
  assert.match(n.detail, /Sync engine/);
  assert.match(n.detail, /covered by nothing/);
});

test('a force-completed task is an acceptance gap too', () => {
  const wf = afterBlockedTask('merge_to_main');
  wf.steps.merge_to_main = { status: 'pending', agents: [] };
  wf.taskExecution.taskStates['1'] = { status: 'force_completed', forceCompleted: true, acceptanceCovered: false };
  assert.equal(deriveNeedsAttention(wf).reason, 'acceptance_gap');
});

test('before an acceptance-sensitive step, a skipped task is not yet a problem', () => {
  // The operator dropped a task and the run is still building. Reporting it at
  // every step would be noise; it becomes a gap when the run is about to claim
  // the criteria are met.
  const wf = afterBlockedTask('task_execution');
  wf.steps.task_execution = { status: 'running', agents: [] };
  wf.taskExecution.taskStates['1'] = { status: 'skipped', acceptanceCovered: false };
  assert.equal(deriveNeedsAttention(wf), null);
});
