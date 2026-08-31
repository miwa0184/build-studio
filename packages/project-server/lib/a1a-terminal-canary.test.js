'use strict';

// The terminal-stop canary: one synthetic run, every way out tried.
//
// The individual R-tests each pin one property. This drives a single fabricated
// run into a TECHNICAL_STOP and then attacks it — every transition, every
// former recovery action, a replay, a reload, a restart — and asserts that none
// of them moves it, spends budget, or makes it merge- or acceptance-eligible.
//
// It exists because the previous three review rounds each found a *different*
// hole in the same wall. A per-property test cannot see that; a test that tries
// everything can.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWorkflowRouter } = require('./api/workflow');
const { createRunGuard } = require('./run-guard');
const { COUNTERS } = require('./run-budgets');
const { REASON_CODES, isMergeEligible, isAcceptanceEligible, canAutoAdvance } = require('./technical-stop');
const { deriveNeedsAttention } = require('./needs-attention');

const RUN_ID = 'canary-terminal-run';

/** Everything a client, a timer, or a stale tab could put on the wire. */
const EVERY_ACTION = [
  'approve', 'skip', 'override', 'launch', 'relaunch', 'next_task', 'mark_done',
  'send_to_devs', 'send_to_pm', 'another_round', 'request_changes',
  'relaunch_task', 'skip_blocked', 'clear_technical_stop', 'rerun_team_review',
  'commit_findings', 'propose_findings', 'discard_findings',
];

function canaryRun() {
  return {
    id: RUN_ID,
    type: 'execution',
    input: 'PRD-CANARY',
    sessionName: 'bs-canary',
    createdAt: new Date().toISOString(),
    round: 1,
    currentStep: 'task_execution',
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
        1: {
          status: 'blocked',
          blockedReason: 'reached max fix cycles (3/3) with blocking review findings still open',
          acceptanceCovered: false,
          agents: [],
        },
      },
    },
  };
}

function makeApp(wf) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-terminal-'));
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
  } finally { server.close(); }
}

test('canary — a blocked task parks the run, and nothing gets it out again', async () => {
  const wf = canaryRun();
  const { app, config } = makeApp(wf);
  const guard = createRunGuard({ statePath: config.statePath });

  // 1. The run is not stopped yet; the blocked task is what stops it.
  assert.equal(wf.technicalStop, undefined);
  const first = await call(app, 'POST', '/workflow/advance', { action: 'approve' });
  assert.equal(first.status, 409);
  assert.equal(wf.currentStep, 'technical_stop');
  assert.equal(wf.technicalStop.reasonCode, REASON_CODES.BLOCKED_TASKS);

  const budgetAfterStop = guard.count(RUN_ID, COUNTERS.AUTO_ADVANCE_REFUSALS);
  const stopCreatedAt = wf.technicalStop.createdAt;

  // 2. Every way out, tried. None may move it.
  for (const action of EVERY_ACTION) {
    const { status, body } = await call(app, 'POST', '/workflow/advance', { action, taskIndex: 1 });
    assert.equal(status, 409, `action=${action} was not refused (${status})`);
    assert.equal(body.terminal, true, `action=${action} did not report terminality`);
    assert.equal(wf.currentStep, 'technical_stop', `action=${action} moved the run`);
    assert.equal(wf.technicalStop.reasonCode, REASON_CODES.BLOCKED_TASKS, `action=${action} changed the stop`);
    assert.equal(wf.technicalStop.createdAt, stopCreatedAt, `action=${action} replaced the stop`);
    assert.equal(wf.taskExecution.taskStates['1'].acceptanceCovered, false, `action=${action} restored coverage`);
    assert.equal(wf.taskExecution.taskStates['1'].status, 'blocked', `action=${action} mutated the task`);
  }

  // 3. Refusing is not an event that costs anything.
  assert.equal(
    guard.count(RUN_ID, COUNTERS.AUTO_ADVANCE_REFUSALS), budgetAfterStop,
    'refusing actions on a parked run spent refusal budget',
  );

  // 4. Merge and acceptance remain unreachable, by field and by predicate.
  assert.equal(isMergeEligible(wf.technicalStop), false);
  assert.equal(isAcceptanceEligible(wf.technicalStop), false);
  assert.equal(canAutoAdvance(wf.technicalStop), false);
  assert.equal(wf.technicalStop.approved, false);
  assert.equal(wf.technicalStop.founderRejection, false);

  // 5. A reload reports it as a technical condition, not an owner decision.
  const reloaded = await call(app, 'GET', '/workflow');
  assert.equal(reloaded.body.needsAttention.reason, 'technical_stop');
  assert.equal(reloaded.body.needsAttention.principal, 'technical');
  assert.equal(reloaded.body.workflow.currentStep, 'technical_stop');

  // 6. A restart re-reads the same verdict from the guard, not from memory.
  const afterRestart = createRunGuard({ statePath: config.statePath }).load(RUN_ID);
  assert.equal(afterRestart.technicalStop.reasonCode, REASON_CODES.BLOCKED_TASKS);
  assert.equal(afterRestart.technicalStop.mergeEligible, false);

  // 7. deriveNeedsAttention agrees without any HTTP at all.
  assert.equal(deriveNeedsAttention(wf).reason, 'technical_stop');
});

test('canary — the parked run never becomes eligible by any recorded state', async () => {
  const wf = canaryRun();
  const { app } = makeApp(wf);
  await call(app, 'POST', '/workflow/advance', { action: 'approve' });

  // Anything a later consumer might read as "this run finished well".
  assert.notEqual(wf.currentStep, 'completed');
  assert.notEqual(wf.currentStep, 'merge_for_review');
  assert.notEqual(wf.currentStep, 'merge_to_main');
  assert.notEqual(wf.steps.task_execution.status, 'completed');
  assert.equal(wf.clearedTechnicalStops, undefined, 'no in-run clearing may be recorded');

  // The stop's own serialised fields say the same thing without any helper.
  const serialised = JSON.parse(JSON.stringify(wf.technicalStop));
  assert.equal(serialised.outcome, 'TECHNICAL_STOP');
  assert.equal(serialised.mergeEligible, false);
  assert.equal(serialised.acceptanceEligible, false);
  assert.equal(serialised.autoAdvanceable, false);
});
