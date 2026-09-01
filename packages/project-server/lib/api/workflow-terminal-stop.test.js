'use strict';

// TECHNICAL_STOP is terminal for the run it stops.
//
// The first cut of this gate treated a stop as a pause: the operator could
// relaunch the task, skip it, or acknowledge the halt, and the SAME run carried
// on. Three review rounds each found a different hole in that idea, and they
// were all the same hole — a run that had failed closed could be walked back
// open by a button, and every recovery route had to re-derive whether the
// original cause was actually resolved. It never was: `acceptanceCovered` went
// false and nothing set it true, so a "recovered" run carried a permanent gap
// while reporting itself healthy.
//
// So a stop now ends the run. Recovery is a successor repair run with its own
// run id and its own budget (A1b), not a second life for this one. That makes
// terminality checkable in one place instead of six, and it removes the class
// of question — "has the cause really gone?" — that the recovery routes kept
// getting wrong.
//
// These tests drive the real router, because terminality is a property of what
// the API answers, not of a helper.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWorkflowRouter } = require('./workflow');
const { REASON_CODES } = require('../technical-stop');
const { registerTestRoot } = require('../test-support/root-aggregate');

function makeApp(wf) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-terminal-test-'));
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
  return { app, config };
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

function stoppedRun({ reasonCode = REASON_CODES.BLOCKED_TASKS, step = 'task_execution', taskStatus = 'blocked' } = {}) {
  return {
    id: 'terminal-run',
    type: 'execution',
    input: 'PRD-001',
    sessionName: 'bs-test',
    createdAt: new Date().toISOString(),
    round: 1,
    currentStep: 'technical_stop',
    autoAdvance: false,
    feedback: [],
    technicalStop: {
      schemaVersion: 1,
      outcome: 'TECHNICAL_STOP',
      reasonCode,
      principal: 'technical',
      runId: 'terminal-run',
      step,
      tasks: [{ index: 1, name: 'Sync engine', reason: 'reached max fix cycles (3/3)' }],
      evidence: ['taskStates.1.status=' + taskStatus],
      recoveryHint: 'This run is parked. Recovery is a separate repair run.',
      approved: false,
      founderRejection: false,
      autoAdvanceable: false,
      mergeEligible: false,
      acceptanceEligible: false,
      createdAt: new Date().toISOString(),
    },
    steps: {
      task_execution: { status: 'running', agents: [] },
      merge_for_review: { status: 'pending', agents: [] },
      technical_stop: { status: 'blocked', reasonCode, error: `${reasonCode}: parked` },
    },
    taskPlan: { tasks: [{ name: 'Auth screen', roles: [] }, { name: 'Sync engine', roles: [] }] },
    taskExecution: {
      currentTaskIndex: 1,
      taskStates: {
        0: { status: 'done', agents: [] },
        1: { status: taskStatus, acceptanceCovered: false, blockedReason: 'reached max fix cycles (3/3)', agents: [] },
      },
    },
  };
}

/** Every action the engine or a person can put on the wire. */
const ALL_ACTIONS = [
  'approve', 'skip', 'override', 'launch', 'relaunch', 'next_task',
  'send_to_devs', 'send_to_pm', 'another_round', 'request_changes',
  'relaunch_task', 'skip_blocked', 'clear_technical_stop',
  'commit_findings', 'propose_findings', 'discard_findings', 'mark_done',
];

// ── R1 ────────────────────────────────────────────────────────────────────────

test('R1 — every transition is refused while the run is stopped', async () => {
  for (const action of ALL_ACTIONS) {
    const wf = stoppedRun();
    const { app } = makeApp(wf);
    const { status, body } = await call(app, 'POST', '/workflow/advance', { action, taskIndex: 1 });

    assert.equal(status, 409, `action=${action} returned ${status}; a stopped run must refuse it`);
    assert.equal(body.outcome, 'TECHNICAL_STOP', `action=${action} must answer with the typed outcome`);
    assert.equal(body.terminal, true, `action=${action} must say the stop is terminal`);
    assert.equal(body.reasonCode, REASON_CODES.BLOCKED_TASKS);
    assert.ok(Array.isArray(body.evidence) && body.evidence.length > 0, `action=${action} must carry evidence`);
    assert.match(body.error, /repair run/i, `action=${action} must name the successor repair run as the route`);

    // Nothing moved.
    assert.equal(wf.currentStep, 'technical_stop', `action=${action} moved the run off its stop`);
    assert.ok(wf.technicalStop, `action=${action} cleared the stop`);
  }
});

test('R1 — the refusal names no in-run recovery action', async () => {
  const wf = stoppedRun();
  const { app } = makeApp(wf);
  const { body } = await call(app, 'POST', '/workflow/advance', { action: 'approve' });
  // The old shape advertised `recoveryActions: [relaunch_task, skip_blocked,
  // clear_technical_stop]`. Offering an in-run route is the defect, so the
  // field must be gone rather than empty-but-present.
  assert.equal(body.recoveryActions, undefined, 'a stopped run must not advertise in-run recovery');
  assert.equal(body.recovery, 'successor_repair_run');
});

// ── R2 ────────────────────────────────────────────────────────────────────────

test('R2 — clear_technical_stop is not a valid action anywhere', async () => {
  const wf = stoppedRun();
  const { app } = makeApp(wf);
  const { status, body } = await call(app, 'POST', '/workflow/advance', { action: 'clear_technical_stop' });
  assert.equal(status, 409);
  assert.ok(wf.technicalStop, 'the stop must survive');
  assert.equal(wf.clearedTechnicalStops, undefined, 'nothing may record an in-run clearing');
  assert.doesNotMatch(JSON.stringify(body), /cleared/i);
});

test('R2 — the source carries no in-run clearing route at all', () => {
  // A dead-but-present handler is a hidden API: the next reader wires it back
  // up. The route, the helper and the action name all go.
  const src = fs.readFileSync(path.join(__dirname, 'workflow.js'), 'utf8');
  assert.ok(!src.includes('clear_technical_stop'), 'clear_technical_stop survives in workflow.js');
  assert.ok(!src.includes('clearTechnicalStopAfterRecovery'), 'the clearing helper survives');
  assert.ok(!src.includes('TECHNICAL_STOP_RECOVERY_ACTIONS'), 'the in-run recovery action set survives');
});

// ── R3 ────────────────────────────────────────────────────────────────────────

test('R3 — relaunch_task is refused on a stopped run, whatever the task status', async () => {
  for (const taskStatus of ['blocked', 'skipped', 'aborted', 'force_completed']) {
    const wf = stoppedRun({ taskStatus });
    const { app } = makeApp(wf);
    const { status, body } = await call(app, 'POST', '/workflow/advance', { action: 'relaunch_task', taskIndex: 1 });
    assert.equal(status, 409, `taskStatus=${taskStatus} must be refused, not relaunched`);
    assert.equal(body.terminal, true);
    assert.equal(wf.taskExecution.taskStates['1'].status, taskStatus, `taskStatus=${taskStatus} was mutated`);
  }
});

test('R3 — relaunch_task still works for a transient task before any stop', async () => {
  // The point is not to disable the action. A run that has NOT failed closed
  // still needs to restart a wedged agent; that is ordinary operation, and
  // taking it away would be its own regression.
  const wf = stoppedRun();
  delete wf.technicalStop;
  delete wf.steps.technical_stop;
  wf.currentStep = 'task_execution';
  wf.taskExecution.taskStates['1'] = { status: 'running', agents: [], acceptanceCovered: undefined };

  const { app } = makeApp(wf);
  const { status, body } = await call(app, 'POST', '/workflow/advance', { action: 'relaunch_task', taskIndex: 1 });
  assert.notEqual(status, 409, `a transient relaunch must not be refused: ${JSON.stringify(body).slice(0, 200)}`);
  assert.doesNotMatch(JSON.stringify(body), /not in a relaunchable phase/);
});

// ── R4 ────────────────────────────────────────────────────────────────────────

test('R4 — acceptanceCovered=false cannot be washed off inside the stopped run', async () => {
  const wf = stoppedRun();
  const { app } = makeApp(wf);
  for (const action of ALL_ACTIONS) {
    await call(app, 'POST', '/workflow/advance', { action, taskIndex: 1 });
    assert.equal(
      wf.taskExecution.taskStates['1'].acceptanceCovered, false,
      `action=${action} restored acceptance coverage inside the stopped run`,
    );
  }
});

test('R4 — no code path sets acceptanceCovered back to true', () => {
  // Coverage is regained by a successor run producing a real verdict, not by
  // editing the field. A route that flipped it would let the run claim
  // criteria that nothing verified.
  for (const rel of ['api/workflow.js', 'overseer.js', 'blocked-tasks.js', 'needs-attention.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(
      !/acceptanceCovered\s*=\s*true/.test(src),
      `${rel} sets acceptanceCovered = true; coverage must come from a successor run`,
    );
  }
});

// ── R10 ───────────────────────────────────────────────────────────────────────

test('R10 — a stopped run is never merge- or acceptance-eligible, and reload does not change that', async () => {
  const wf = stoppedRun();
  const { app } = makeApp(wf);

  assert.equal(wf.technicalStop.mergeEligible, false);
  assert.equal(wf.technicalStop.acceptanceEligible, false);

  // Replay an action that predates the stop, twice, as a stale client would.
  await call(app, 'POST', '/workflow/advance', { action: 'approve' });
  await call(app, 'POST', '/workflow/advance', { action: 'approve' });

  // "Reload" is a fresh read of the same state.
  const { body } = await call(app, 'GET', '/workflow');
  assert.equal(body.workflow.currentStep, 'technical_stop');
  assert.equal(body.workflow.technicalStop.mergeEligible, false);
  assert.equal(body.workflow.technicalStop.acceptanceEligible, false);
  assert.equal(body.needsAttention.reason, 'technical_stop');
  assert.equal(body.needsAttention.principal, 'technical');
});

test('R10 — a restart re-reads the stop from the guard, not from memory', async () => {
  const wf = stoppedRun();
  const { app, config } = makeApp(wf);
  // Any refused action persists the stop through the guard mirror.
  await call(app, 'POST', '/workflow/advance', { action: 'approve' });

  const { createRunGuard } = require('../run-guard');
  const guard = createRunGuard({ statePath: config.statePath });
  const doc = guard.load(wf.id);
  assert.ok(doc.technicalStop, 'the guard must carry the stop across a restart');
  assert.equal(doc.technicalStop.reasonCode, REASON_CODES.BLOCKED_TASKS);
  assert.equal(doc.technicalStop.mergeEligible, false);
});
