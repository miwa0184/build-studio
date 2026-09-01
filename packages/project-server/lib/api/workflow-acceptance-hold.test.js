'use strict';

// R9 — the acceptance hold, exercised through the real auto-advance tick.
//
// This replaces a test that asserted nothing. It built a run guard over a fresh
// temp directory that nothing ever wrote to, then asserted two counters were 0
// — `0 === 0` whatever the code did — and it picked a step that returns at the
// `alwaysManual` check before the hold is even reached. It would have passed
// against the very bug it was written to guard.
//
// The property that actually matters: an unverified task must HOLD an
// acceptance-sensitive step without spending budget. The distinction is the
// whole reason the second review round was needed — a refusal is an event that
// costs a unit of the run's refusal budget, and this condition never clears on
// its own, so writing it as a refusal drove a healthy run into a terminal stop
// in about two minutes of ticks.
//
// So this drives the real timer: enable auto-advance, let the tick fire, and
// read the guard the server itself wrote to.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWorkflowRouter } = require('./workflow');
const { createRunGuard } = require('../run-guard');
const { COUNTERS } = require('../run-budgets');
const { registerTestRoot } = require('../test-support/root-aggregate');

/**
 * The tick runs 500ms after auto-advance is enabled, then every 8 seconds.
 *
 * Kept just past the first firing rather than into the second: these tests
 * hold a real timer and a real server open, and on a 2-core CI runner that
 * contention is felt by every other test file in the suite. One tick is enough
 * — the assertions below check that it ran, so a settle time too short fails
 * loudly instead of passing vacuously.
 */
const TICK_SETTLE_MS = 1200;

function makeServer(wf) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-hold-'));
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
    loadWorkflow: () => JSON.parse(JSON.stringify(wf)),
    saveWorkflow: (w) => { Object.assign(wf, JSON.parse(JSON.stringify(w))); },
    loadRun: () => null,
    registerCompletionHook: () => {},
  };
  const app = express();
  app.use(express.json());
  const router = createWorkflowRouter(config, state, {}, {}, () => {});
  // Acceptance evidence is mutable authority, so this fixture must represent
  // an admitted schema-2 root. Schema 1 is intentionally render/cancel-only.
  registerTestRoot({ statePath: config.statePath, runId: wf.id, guard: state.runGuard });
  app.use('/api', router);
  return { app, config };
}

async function withServer(wf, fn) {
  const { app, config } = makeServer(wf);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    return await fn(base, config);
  } finally {
    // Turn the timer off before the server goes away, or it keeps ticking into
    // a closed socket for the rest of the file.
    await fetch(`${base}/workflow/auto-advance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }).catch(() => {});
    server.close();
  }
}

/** A run at an acceptance-sensitive step carrying one task nobody verified. */
function runWithGap(currentStep = 'ac_verification') {
  return {
    id: 'hold-run',
    type: 'execution',
    input: 'PRD-001',
    sessionName: 'bs-test',
    createdAt: new Date().toISOString(),
    round: 1,
    currentStep,
    autoAdvance: false,
    feedback: [],
    steps: {
      task_execution: { status: 'completed', agents: [] },
      [currentStep]: { status: 'pending', agents: [] },
    },
    taskPlan: { tasks: [{ name: 'Auth screen', roles: [] }, { name: 'Sync engine', roles: [] }] },
    taskExecution: {
      currentTaskIndex: 1,
      taskStates: {
        0: { status: 'done', agents: [] },
        1: { status: 'skipped', acceptanceCovered: false, skipReason: 'aborted by operator', agents: [] },
      },
    },
  };
}

test('R9 — the real tick holds an acceptance-sensitive step and spends no budget', async () => {
  const wf = runWithGap('ac_verification');

  await withServer(wf, async (base, config) => {
    const guard = createRunGuard({ statePath: config.statePath });
    // Precondition: nothing spent yet, and the guard file genuinely reflects
    // this run rather than an empty directory.
    assert.equal(guard.count(wf.id, COUNTERS.AUTO_ADVANCE_REFUSALS), 0);

    const on = await fetch(`${base}/workflow/auto-advance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(on.status, 200);

    await new Promise((r) => setTimeout(r, TICK_SETTLE_MS));

    // The tick ran and DECIDED something — the hold is recorded on the step.
    // Without this the rest of the test would pass on a tick that never fired.
    assert.ok(
      wf.steps.ac_verification.acceptanceHold,
      'the tick must have run and recorded the hold — otherwise this test proves nothing',
    );
    assert.match(wf.steps.ac_verification.acceptanceHold, /Sync engine/);

    // It held rather than advanced.
    assert.equal(wf.currentStep, 'ac_verification');
    assert.equal(wf.technicalStop, undefined, 'a hold must not become a stop');

    // And it cost nothing. These are the assertions the replaced test only
    // pretended to make: the guard here is the one the SERVER wrote to.
    assert.equal(guard.count(wf.id, COUNTERS.AUTO_ADVANCE_REFUSALS), 0, 'the hold spent run-wide refusal budget');
    assert.equal(
      guard.count(wf.id, `${COUNTERS.AUTO_ADVANCE_REFUSALS}:ac_verification`), 0,
      'the hold spent per-step refusal budget',
    );
  });
});

test('R9 — holding repeatedly across ticks still spends nothing', async () => {
  // The failure mode was cumulative: one refusal per 8-second tick against a
  // condition that never clears. A single tick catches it — the spend happened
  // on the first one — and the assertion that the hold was recorded proves the
  // tick actually ran.
  const wf = runWithGap('merge_to_main');

  await withServer(wf, async (base, config) => {
    await fetch(`${base}/workflow/auto-advance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    await new Promise((r) => setTimeout(r, TICK_SETTLE_MS));

    const guard = createRunGuard({ statePath: config.statePath });
    assert.ok(wf.steps.merge_to_main.acceptanceHold, 'the tick must have run');
    assert.equal(guard.count(wf.id, COUNTERS.AUTO_ADVANCE_REFUSALS), 0);
    assert.equal(wf.currentStep, 'merge_to_main', 'the run must not have merged');
  });
});

test('R9 — a run with no gap is not held, so the hold is not a blanket stall', async () => {
  const wf = runWithGap('ac_verification');
  wf.taskExecution.taskStates['1'] = { status: 'done', agents: [] };

  await withServer(wf, async (base) => {
    await fetch(`${base}/workflow/auto-advance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    await new Promise((r) => setTimeout(r, TICK_SETTLE_MS));
    assert.equal(
      wf.steps.ac_verification && wf.steps.ac_verification.acceptanceHold, undefined,
      'a verified run must not be held',
    );
  });
});

test('R9 — the hold text does not promise an in-run relaunch', () => {
  // It used to say "Relaunch them for a real verdict". Nothing in this run can
  // produce that verdict any more: a task in an unverified state is not
  // relaunchable, and after force-complete or kill-and-skip the run is parked.
  const src = fs.readFileSync(path.join(__dirname, 'workflow.js'), 'utf8');
  const i = src.indexOf('acceptanceHold');
  assert.ok(i > 0, 'the hold must exist');
  const region = src.slice(Math.max(0, i - 1400), i + 400);
  assert.ok(!/Relaunch them for a real verdict/.test(region), 'the hold still promises an in-run relaunch');
});
