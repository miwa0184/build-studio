'use strict';

// F1 — the blocked-task fail-open.
//
// A task that exhausts MAX_FIX_CYCLES is set to `blocked`, and then
// launchNextTask goes looking for the next task with status `pending`. A blocked
// task is not pending, so the search comes up empty, the step is marked
// `completed`, and the run walks on to merge_for_review carrying code that a
// reviewer refused three times. Nothing downstream re-reads the task state.
//
// These pin the gate that replaces the fail-open: blocked is terminal and
// fail-closed, and the outcome names every blocking task.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  findBlockingTasks,
  findAcceptanceGaps,
  taskExecutionOutcome,
  BLOCKING_STATUSES,
} = require('./blocked-tasks');
const { TECHNICAL_STOP, REASON_CODES } = require('./technical-stop');

function wfWith(taskStates) {
  return {
    id: 'run-a',
    type: 'execution',
    currentStep: 'task_execution',
    steps: { task_execution: { status: 'running', agents: [] } },
    taskPlan: { tasks: [{ name: 'Auth screen' }, { name: 'Sync engine' }, { name: 'Settings' }] },
    taskExecution: { currentTaskIndex: 0, taskStates },
  };
}

test('blocked is a blocking status; done and pending are not', () => {
  assert.ok(BLOCKING_STATUSES.includes('blocked'));
  assert.ok(!BLOCKING_STATUSES.includes('done'));
  assert.ok(!BLOCKING_STATUSES.includes('pending'));
});

test('a blocked task is found, with its index, name and reason', () => {
  const wf = wfWith({
    0: { status: 'done' },
    1: { status: 'blocked', blockedReason: 'reached max fix cycles (3/3)' },
    2: { status: 'done' },
  });
  const blocking = findBlockingTasks(wf);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].index, 1);
  assert.equal(blocking[0].name, 'Sync engine');
  assert.match(blocking[0].reason, /max fix cycles/);
});

test('every blocking task is reported, not just the first', () => {
  const wf = wfWith({
    0: { status: 'blocked', blockedReason: 'a' },
    1: { status: 'done' },
    2: { status: 'blocked', blockedReason: 'b' },
  });
  assert.deepEqual(findBlockingTasks(wf).map((t) => t.index), [0, 2]);
});

test('with a blocked task, task_execution does NOT complete — the outcome is a technical stop', () => {
  const wf = wfWith({
    0: { status: 'done' },
    1: { status: 'blocked', blockedReason: 'reached max fix cycles (3/3)' },
    2: { status: 'done' },
  });
  const outcome = taskExecutionOutcome(wf);
  assert.equal(outcome.kind, 'technical_stop');
  assert.notEqual(outcome.kind, 'complete');
  assert.equal(outcome.technicalStop.outcome, TECHNICAL_STOP);
  assert.equal(outcome.technicalStop.reasonCode, REASON_CODES.BLOCKED_TASKS);
  assert.equal(outcome.technicalStop.step, 'task_execution');
  assert.equal(outcome.technicalStop.runId, 'run-a');
});

test('the technical stop names every blocking task and its cause', () => {
  const wf = wfWith({
    0: { status: 'blocked', blockedReason: 'review refused 3x' },
    1: { status: 'done' },
    2: { status: 'blocked', blockedReason: 'role could not be resolved' },
  });
  const { technicalStop } = taskExecutionOutcome(wf);
  assert.deepEqual(technicalStop.tasks.map((t) => t.index), [0, 2]);
  assert.deepEqual(technicalStop.tasks.map((t) => t.name), ['Auth screen', 'Settings']);
  assert.match(technicalStop.tasks[0].reason, /review refused 3x/);
  assert.match(technicalStop.tasks[1].reason, /role could not be resolved/);
  assert.ok(technicalStop.recoveryHint);
});

test('a pending task means keep going — the next task launches, no stop', () => {
  const wf = wfWith({ 0: { status: 'done' }, 1: { status: 'pending' }, 2: { status: 'pending' } });
  const outcome = taskExecutionOutcome(wf);
  assert.equal(outcome.kind, 'launch_next');
  assert.equal(outcome.nextIndex, 1);
});

test('a blocked task takes precedence over remaining pending work — no launch past a stop', () => {
  const wf = wfWith({ 0: { status: 'blocked', blockedReason: 'x' }, 1: { status: 'pending' }, 2: { status: 'pending' } });
  assert.equal(taskExecutionOutcome(wf).kind, 'technical_stop');
});

test('all tasks genuinely done → complete', () => {
  const wf = wfWith({ 0: { status: 'done' }, 1: { status: 'done' }, 2: { status: 'done' } });
  const outcome = taskExecutionOutcome(wf);
  assert.equal(outcome.kind, 'complete');
});

test('an operator-skipped task does not block the step, but does block acceptance coverage', () => {
  const wf = wfWith({
    0: { status: 'skipped', acceptanceCovered: false },
    1: { status: 'done' },
    2: { status: 'done' },
  });
  const outcome = taskExecutionOutcome(wf);
  assert.equal(outcome.kind, 'complete');
  assert.deepEqual(outcome.acceptanceGaps.map((g) => g.index), [0]);
  assert.deepEqual(findAcceptanceGaps(wf).map((g) => g.index), [0]);
});

test('a force-completed task blocks acceptance coverage too', () => {
  const wf = wfWith({
    0: { status: 'done', forceCompleted: true, acceptanceCovered: false },
    1: { status: 'done' },
    2: { status: 'done' },
  });
  assert.deepEqual(findAcceptanceGaps(wf).map((g) => g.index), [0]);
});
