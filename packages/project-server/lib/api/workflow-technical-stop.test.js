'use strict';

// F1 / F2, through the real HTTP surface.
//
// The unit tests pin the gate (blocked-tasks.js) and the outcome
// (technical-stop.js). These drive the actual router, because the fail-open was
// never visible in a helper — it was visible in what the API answered: a
// workflow carrying a blocked task reported `needsAttention: null` and would
// advance on request.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWorkflowRouter } = require('./workflow');
const { registerTestRoot } = require('../test-support/root-aggregate');

function makeApp(wf) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-tstop-test-'));
  const config = {
    projectRoot: root,
    statePath: path.join(root, '.build-studio'),
    docsPath: path.join(root, 'docs'),
    worktreesPath: path.join(root, 'tmp', '.worktrees'),
    logsPath: path.join(root, 'tmp', '.logs'),
    tmpPath: path.join(root, 'tmp'),
    roles: { review: [], execution: [], standalone: [] },
  };
  fs.mkdirSync(config.statePath, { recursive: true });
  fs.mkdirSync(config.docsPath, { recursive: true });
  const state = {
    loadWorkflow: () => wf,
    saveWorkflow: (w) => { Object.assign(wf, w); },
    loadRun: () => null,
    registerCompletionHook: () => {},
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createWorkflowRouter(config, state, {}, {}, () => {}));
  registerTestRoot({ statePath: config.statePath, runId: wf.id, guard: state.runGuard });
  return app;
}

async function call(app, method, urlPath, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

/** A run that finished its tasks except one the reviewer refused three times. */
function wfWithBlockedTask(currentStep = 'task_execution') {
  return {
    id: 'test-blocked-run',
    type: 'execution',
    input: 'PRD-001',
    createdAt: new Date().toISOString(),
    round: 1,
    currentStep,
    autoAdvance: false,
    feedback: [],
    steps: {
      task_execution: { status: 'running', agents: [] },
      merge_for_review: { status: 'pending', agents: [] },
    },
    taskPlan: { tasks: [{ name: 'Auth screen', roles: [] }, { name: 'Sync engine', roles: [] }] },
    taskExecution: {
      currentTaskIndex: 1,
      taskStates: {
        0: { status: 'done', agents: [] },
        1: { status: 'blocked', blockedReason: 'reached max fix cycles (3/3) with blocking review findings still open', agents: [] },
      },
    },
  };
}

test('GET /workflow reports a blocked task as a technical condition, not silence', async () => {
  const wf = wfWithBlockedTask();
  const { status, body } = await call(makeApp(wf), 'GET', '/workflow');
  assert.equal(status, 200);
  assert.ok(body.needsAttention, 'a run carrying a blocked task must not report needsAttention: null');
  assert.equal(body.needsAttention.principal, 'technical');
  assert.match(body.needsAttention.detail, /Sync engine/);
});

test('GET /workflow surfaces a recorded TECHNICAL_STOP with its reason code', async () => {
  const wf = wfWithBlockedTask('technical_stop');
  wf.technicalStop = {
    outcome: 'TECHNICAL_STOP',
    reasonCode: 'BLOCKED_TASKS',
    principal: 'technical',
    runId: wf.id,
    step: 'task_execution',
    tasks: [{ index: 1, name: 'Sync engine', reason: 'reached max fix cycles (3/3)' }],
    evidence: ['taskStates.1.status=blocked'],
    recoveryHint: 'Relaunch the blocked task after addressing the findings.',
    approved: false,
    founderRejection: false,
  };
  wf.steps.technical_stop = { status: 'blocked' };

  const { body } = await call(makeApp(wf), 'GET', '/workflow');
  assert.equal(body.needsAttention.reason, 'technical_stop');
  assert.equal(body.needsAttention.reasonCode, 'BLOCKED_TASKS');
  assert.equal(body.needsAttention.principal, 'technical');
});

test('a stopped run has no transition — advance is refused, never approved forward', async () => {
  const wf = wfWithBlockedTask('technical_stop');
  wf.technicalStop = { outcome: 'TECHNICAL_STOP', reasonCode: 'BLOCKED_TASKS', runId: wf.id, step: 'task_execution', tasks: [], evidence: [] };
  wf.steps.technical_stop = { status: 'blocked' };

  for (const action of ['approve', 'launch', 'skip']) {
    const { status } = await call(makeApp(wf), 'POST', '/workflow/advance', { action });
    assert.ok(status >= 400, `advance(${action}) from a technical stop returned ${status} — it must be refused`);
    assert.equal(wf.currentStep, 'technical_stop', `advance(${action}) moved the run off its stop`);
  }
});

test('the run never reaches merge_for_review while a task is blocked', async () => {
  const wf = wfWithBlockedTask();
  await call(makeApp(wf), 'POST', '/workflow/advance', { action: 'approve' });
  assert.notEqual(wf.currentStep, 'merge_for_review');
  assert.notEqual(wf.steps.task_execution.status, 'completed');
});

// ── Repair round 1 ────────────────────────────────────────────────────────────
// An independent review found that the first cut of this gate was terminal in
// places it should not have been, and not terminal in the place it claimed. All
// four are regressions worth keeping: each one was reachable by ordinary
// operator behaviour.

test('a stopped run refuses every transition BY A GUARD, not by falling through', () => {
  // The terminality used to be incidental — no handler matched the step key
  // 'technical_stop', so everything reached "no valid transition". That holds
  // only until someone adds a handler. The guard answers before any handler.
  const wf = wfWithBlockedTask('technical_stop');
  wf.technicalStop = {
    outcome: 'TECHNICAL_STOP', reasonCode: 'BLOCKED_TASKS', runId: wf.id, step: 'task_execution',
    tasks: [], evidence: [], recoveryHint: 'Relaunch the blocked task.',
  };
  wf.steps.technical_stop = { status: 'blocked', error: 'BLOCKED_TASKS' };

  return call(makeApp(wf), 'POST', '/workflow/advance', { action: 'approve' }).then(({ status, body }) => {
    assert.equal(status, 409);
    assert.equal(body.technicalStop.reasonCode, 'BLOCKED_TASKS');
    assert.equal(body.terminal, true);
    // No in-run recovery is advertised any more — offering one was the defect.
    assert.equal(body.recoveryActions, undefined);
    assert.equal(body.recovery, 'successor_repair_run');
  });
});

test('relaunch cannot erase the stop record it is rendered next to', () => {
  // The hub shows "Relaunch step" whenever step.status === 'blocked' && step.error,
  // both of which applyTechnicalStop sets. The generic relaunch handler resets
  // wf.steps[currentStep] to a bare pending object — which would delete the
  // reasonCode and evidence written there for consumers that only read steps.
  const wf = wfWithBlockedTask('technical_stop');
  wf.technicalStop = {
    outcome: 'TECHNICAL_STOP', reasonCode: 'BLOCKED_TASKS', runId: wf.id, step: 'task_execution',
    tasks: [{ index: 1, name: 'Sync engine', reason: 'max fix cycles' }], evidence: ['taskStates.1.status=blocked'],
    recoveryHint: 'Relaunch the blocked task.',
  };
  wf.steps.technical_stop = { status: 'blocked', error: 'BLOCKED_TASKS: relaunch it', stop: wf.technicalStop };

  return call(makeApp(wf), 'POST', '/workflow/advance', { action: 'relaunch' }).then(({ status }) => {
    assert.equal(status, 409);
    // The step record survives — and may be RE-PROJECTED from the
    // authoritative stop (reason code and hint), since the refusal now also
    // mirrors a workflow-carried stop into the run guard. What must never
    // happen is the record being reset to a bare pending step.
    assert.match(wf.steps.technical_stop.error, /^BLOCKED_TASKS/, 'the stop reason must survive a refused relaunch');
    assert.ok(wf.steps.technical_stop.stop, 'the stop record must survive a refused relaunch');
    assert.equal(wf.steps.technical_stop.status, 'blocked');
    assert.equal(wf.currentStep, 'technical_stop');
  });
});
test('an explicit advance is guarded too, not only the timer', async () => {
  // Terminality used to hold because nothing matched the step key — a
  // convention, not a guard. A restored snapshot or a run already in flight can
  // sit on a later step with a blocked task and no stop recorded.
  const wf = wfWithBlockedTask('merge_to_main');
  wf.steps.merge_to_main = { status: 'pending', agents: [] };
  assert.equal(wf.technicalStop, undefined, 'precondition: no stop recorded yet');

  const { status, body } = await call(makeApp(wf), 'POST', '/workflow/advance', { action: 'approve' });
  assert.equal(status, 409);
  assert.equal(body.technicalStop.reasonCode, 'BLOCKED_TASKS');
  assert.equal(wf.currentStep, 'technical_stop');
  assert.notEqual(wf.currentStep, 'capture_learnings');
});
