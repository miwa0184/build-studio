'use strict';

// R5 / R6 — force-complete and kill-and-skip park the run.
//
// Both actions end an agent that will not finish on its own, and both used to
// carry the run onwards: mark the task, then fire a loopback POST to
// /workflow/advance so the next task launched. That is the fail-open in its
// purest form — the operator's intervention was "this task cannot be
// completed", and the engine answered by continuing as though it had been.
//
// The task is still recorded honestly (provenance, untrusted pane evidence, an
// incident), the agent process is still terminated — those were never the
// problem. What stops is the run. Coverage for that task comes from a successor
// repair run in A1b, not from the run that could not produce it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOverseer } = require('./overseer');
const { REASON_CODES } = require('./technical-stop');
const { createRunGuard } = require('./run-guard');
const { registerTestRoot } = require('./test-support/root-aggregate');

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-terminal-'));
  const statePath = path.join(root, '.build-studio');
  fs.mkdirSync(statePath, { recursive: true });

  const wf = {
    id: 'overseer-run',
    type: 'execution',
    input: 'PRD-001',
    sessionName: 'bs-test',
    currentStep: 'task_execution',
    round: 1,
    steps: { task_execution: { status: 'running', agents: [] } },
    taskPlan: { tasks: [{ name: 'Auth screen' }, { name: 'Sync engine' }] },
    taskExecution: {
      currentTaskIndex: 0,
      taskStates: {
        0: { status: 'running', fixCycles: 0, agents: [{ role: 'iOS Dev', window: 't1-ios', status: 'running', taskIndex: 0 }] },
        1: { status: 'pending', fixCycles: 0, agents: [] },
      },
    },
  };
  const state = {
    loadWorkflow: () => JSON.parse(JSON.stringify(wf)),
    saveWorkflow: (next) => { Object.assign(wf, JSON.parse(JSON.stringify(next))); },
  };

  // Record any loopback the overseer attempts. The port is unroutable, so a
  // real request would fail anyway — but "it failed" is not the assertion we
  // want. We want "it was never attempted".
  const requested = [];
  const http = require('http');
  const realRequest = http.request;
  http.request = function patched(opts, cb) {
    requested.push(typeof opts === 'string' ? opts : `${opts.method} ${opts.path}`);
    return realRequest.call(this, opts, cb);
  };
  const restore = () => { http.request = realRequest; };

  const config = { projectRoot: root, statePath, port: 0 };
  const overseer = createOverseer(config, state, () => {});
  registerTestRoot({ statePath, runId: wf.id, guard: state.runGuard });
  return { wf, statePath, requested, restore, overseer };
}

test('R5 — force-complete parks the run with a typed stop', () => {
  const h = harness();
  try {
    const r = h.overseer.forceCompleteTaskAgent('t1-ios');
    assert.equal(r.ok, true, r.error);

    assert.ok(h.wf.technicalStop, 'force-complete must park the run');
    assert.equal(h.wf.technicalStop.outcome, 'TECHNICAL_STOP');
    assert.equal(h.wf.technicalStop.reasonCode, REASON_CODES.TASK_FORCE_COMPLETED_UNVERIFIED);
    assert.equal(h.wf.technicalStop.principal, 'technical');
    assert.equal(h.wf.technicalStop.mergeEligible, false);
    assert.equal(h.wf.technicalStop.acceptanceEligible, false);
    assert.equal(h.wf.currentStep, 'technical_stop');
    assert.deepEqual(h.wf.technicalStop.tasks.map((t) => t.index), [0]);
  } finally { h.restore(); }
});

test('R5 — force-complete never asks the workflow to advance', () => {
  const h = harness();
  try {
    h.overseer.forceCompleteTaskAgent('t1-ios');
    const advances = h.requested.filter((r) => r.includes('/api/workflow/advance'));
    assert.deepEqual(advances, [], `force-complete fired a loopback advance: ${advances.join(', ')}`);
    // …and the next task is untouched.
    assert.equal(h.wf.taskExecution.taskStates['1'].status, 'pending');
  } finally { h.restore(); }
});

test('R5 — the evidence and provenance survive the stop', () => {
  const h = harness();
  try {
    h.overseer.forceCompleteTaskAgent('t1-ios');
    const ts = h.wf.taskExecution.taskStates['0'];
    const agent = ts.agents[0];

    assert.equal(ts.status, 'force_completed');
    assert.notEqual(ts.status, 'done');
    assert.equal(ts.acceptanceCovered, false);
    assert.equal(agent.feedbackProvenance, 'operator_force_complete');
    assert.doesNotMatch(agent.feedback, /\*\*Approved:\*\*\s*yes/i);
    assert.match(agent.feedback, /untrusted/i);
    assert.ok((h.wf.overseer.incidents || []).some((i) => i.symptom === 'force-completed-t1-ios'));
  } finally { h.restore(); }
});

test('R6 — kill-and-skip parks the run with its own reason code', () => {
  const h = harness();
  try {
    const r = h.overseer.killAndSkipTaskAgent('t1-ios');
    assert.equal(r.ok, true, r.error);

    assert.ok(h.wf.technicalStop);
    assert.equal(h.wf.technicalStop.reasonCode, REASON_CODES.TASK_SKIPPED_UNVERIFIED);
    assert.equal(h.wf.currentStep, 'technical_stop');
    assert.equal(h.wf.taskExecution.taskStates['0'].status, 'skipped');
    assert.equal(h.wf.taskExecution.taskStates['0'].acceptanceCovered, false);
  } finally { h.restore(); }
});

test('R6 — kill-and-skip never asks the workflow to advance', () => {
  const h = harness();
  try {
    h.overseer.killAndSkipTaskAgent('t1-ios');
    const advances = h.requested.filter((r) => r.includes('/api/workflow/advance'));
    assert.deepEqual(advances, [], `kill-and-skip fired a loopback advance: ${advances.join(', ')}`);
    assert.equal(h.wf.taskExecution.taskStates['1'].status, 'pending');
  } finally { h.restore(); }
});

test('R5/R6 — the stop reaches the run guard, so a restart still sees it', () => {
  const h = harness();
  try {
    h.overseer.killAndSkipTaskAgent('t1-ios');
    const guard = createRunGuard({ statePath: h.statePath });
    const doc = guard.load('overseer-run');
    assert.ok(doc.technicalStop, 'the guard must carry the stop');
    assert.equal(doc.technicalStop.reasonCode, REASON_CODES.TASK_SKIPPED_UNVERIFIED);
  } finally { h.restore(); }
});

test('R5/R6 — neither action advertises an in-run relaunch as the way back', () => {
  // Four places used to promise "relaunch the task for a real verdict". None of
  // them could deliver it: relaunch_task refuses a skipped or force-completed
  // task, and after this change the run is parked anyway.
  const src = fs.readFileSync(path.join(__dirname, 'overseer.js'), 'utf8');
  assert.ok(!src.includes('relaunch-task-for-real-verdict'), 'overseer still promises an in-run relaunch');
});
