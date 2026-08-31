'use strict';

// R11–R21 — the run guard is the authority at the state boundary.
//
// A1a gave every run a guard file that holds its budgets and terminal outcome.
// What it did not do was make anything ENFORCE that file at the point where
// state actually moves: workflow-state.json was still written whole, by
// whoever held an object, and the guard was consulted only where individual
// routes remembered to. That left four working routes back to a transitionable
// run that the terminal model says cannot exist:
//
//   - POST /workflow/restore rewrote workflow-state.json from any snapshot,
//     including a pre-stop snapshot of the same run — the stop and the
//     acceptance gap vanished together (R11), and a snapshot of a different
//     run replaced a terminal one outright (R12);
//   - a stale workflow copy that predates the stop loaded as transitionable
//     (R13) and saved over the stop (R14), and a restart read whatever the
//     file happened to say (R15);
//   - GET /workflow/token-stats read snapshots through restoreSnapshot — a
//     WRITE path that replaces workflow-state.json, moves the step tracker,
//     rewrites agent-status.json and broadcasts (R16/R17);
//   - a guard file that was corrupt, unreadable or belonged to another run was
//     silently replaced by an empty one, renewing every budget and dropping
//     any recorded stop (R18/R19); a guard that could not be WRITTEN was
//     logged and forgotten (R20).
//
// The repair is one seam, not per-route checks: attachStateAuthority (state.js)
// wraps loadWorkflow/saveWorkflow so the guard's technicalStop is projected on
// every read and re-applied on every write, snapshot reading is split from
// snapshot restoring, and a guard that cannot be read or written fails closed
// with a typed, machine-readable error. These tests drive the REAL state
// manager and the real router, because the property under test is what the
// storage boundary does, not what any one route remembers.
//
// The auto-advance timer and the overseer read and write through this same
// boundary (state.loadWorkflow / state.saveWorkflow), so R13 + R14 are also
// the timer's and the overseer's inability to wake a terminal run: whatever
// they load is already parked, and whatever they save is re-parked.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStateManager } = require('./state');
const { createWorkflowRouter } = require('./api/workflow');
const { createRunGuard, GUARD_DIR } = require('./run-guard');
const { createTechnicalStop, REASON_CODES, isTechnicalStop } = require('./technical-stop');

// ---------- harness ----------

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-authority-'));
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
  const broadcasts = [];
  const state = createStateManager(config, (event) => broadcasts.push(event));
  const app = express();
  app.use(express.json());
  app.use('/api', createWorkflowRouter(config, state, {}, {}, () => {}));
  return {
    root,
    config,
    state,
    app,
    broadcasts,
    wfFile: path.join(config.statePath, 'workflow-state.json'),
    guardFile: path.join(config.statePath, GUARD_DIR, 'rn-1.json'),
    snapshotsDir: path.join(config.statePath, 'snapshots'),
    agentStatusFile: path.join(config.docsPath, 'agent-status.json'),
  };
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

/** A transitionable execution run mid task_execution. */
function activeWf(id = 'rn-1') {
  return {
    id,
    type: 'execution',
    input: `PRD-${id}`,
    sessionName: 'bs-test',
    createdAt: '2026-08-30T10:00:00.000Z',
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
        1: { status: 'running', agents: [{ role: 'developer', status: 'running', window: 'task-2' }] },
      },
    },
  };
}

function stopFor(runId) {
  return createTechnicalStop({
    reasonCode: REASON_CODES.BLOCKED_TASKS,
    runId,
    step: 'task_execution',
    tasks: [{ index: 1, name: 'Sync engine', reason: 'reached max fix cycles (3/3)' }],
    evidence: ['taskStates.1.status=blocked'],
  });
}

/** The stop as the guard holds it — written through the guard's own API. */
function writeGuardStop(config, runId, stop) {
  createRunGuard({ statePath: config.statePath }).mutate(runId, (doc) => {
    doc.technicalStop = stop;
    doc.blockingTasks = stop.tasks;
  });
}

/** Simulate a crash-ordered or stale write: the raw file, no boundary. */
function rawWriteWf(env, wf) {
  fs.writeFileSync(env.wfFile, JSON.stringify(wf, null, 2));
}

function writeSnapshot(env, name, wf) {
  fs.mkdirSync(env.snapshotsDir, { recursive: true });
  fs.writeFileSync(path.join(env.snapshotsDir, name), JSON.stringify(wf, null, 2));
}

function bytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function isTerminal(wf) {
  return !!wf && isTechnicalStop(wf.technicalStop) && wf.currentStep === 'technical_stop';
}

// ---------- R11 / R12 — restore cannot roll back a stop ----------

test('R11 — a pre-stop snapshot of the same run cannot restore the stop away', async () => {
  const env = makeEnv();
  const stop = stopFor('rn-1');
  writeGuardStop(env.config, 'rn-1', stop);
  const stopped = activeWf('rn-1');
  stopped.technicalStop = stop;
  stopped.currentStep = 'technical_stop';
  stopped.steps.technical_stop = { status: 'blocked', reasonCode: stop.reasonCode };
  rawWriteWf(env, stopped);
  writeSnapshot(env, 'workflow-rn-1-step-task_execution-2026-08-30.json', activeWf('rn-1'));

  const wfBefore = bytes(env.wfFile);
  const guardBefore = bytes(env.guardFile);
  const broadcastsBefore = env.broadcasts.length;

  const res = await call(env.app, 'POST', '/workflow/restore', {
    snapshotFile: 'workflow-rn-1-step-task_execution-2026-08-30.json',
  });

  assert.equal(res.status, 409, `restore of a pre-stop snapshot must be refused, got ${res.status}`);
  assert.equal(res.body.outcome, 'TECHNICAL_STOP', 'the refusal must carry the typed terminal outcome');
  assert.equal(bytes(env.wfFile), wfBefore, 'a refused restore must leave workflow-state.json byte-identical');
  assert.equal(bytes(env.guardFile), guardBefore, 'a refused restore must leave the run guard byte-identical');
  assert.equal(env.broadcasts.length, broadcastsBefore, 'a refused restore must not broadcast');
  assert.ok(isTerminal(env.state.loadWorkflow()), 'the run must still load as terminal');
});

test('R12 — a snapshot of a different run cannot replace an active terminal run', async () => {
  const env = makeEnv();
  const stop = stopFor('rn-1');
  writeGuardStop(env.config, 'rn-1', stop);
  const stopped = activeWf('rn-1');
  stopped.technicalStop = stop;
  stopped.currentStep = 'technical_stop';
  rawWriteWf(env, stopped);
  writeSnapshot(env, 'workflow-rn-2-step-task_execution-2026-08-29.json', activeWf('rn-2'));

  const wfBefore = bytes(env.wfFile);

  const res = await call(env.app, 'POST', '/workflow/restore', {
    snapshotFile: 'workflow-rn-2-step-task_execution-2026-08-29.json',
  });

  assert.equal(res.status, 409, `restoring another run over a terminal one must be refused, got ${res.status}`);
  assert.equal(bytes(env.wfFile), wfBefore, 'the terminal run must survive byte-identically');
  const wf = env.state.loadWorkflow();
  assert.equal(wf.id, 'rn-1', 'the active run id must not change');
  assert.ok(isTerminal(wf), 'the active run must still be terminal');
});

// ---------- R13 / R14 / R15 — the guard outranks the workflow file ----------

test('R13 — guard stop + stale workflow file loads as terminal', async () => {
  const env = makeEnv();
  writeGuardStop(env.config, 'rn-1', stopFor('rn-1'));
  // The file predates the stop — a slow writer or a crash between the guard
  // write and the workflow write leaves exactly this on disk.
  rawWriteWf(env, activeWf('rn-1'));

  const wf = env.state.loadWorkflow();
  assert.ok(isTechnicalStop(wf.technicalStop), 'loadWorkflow must expose the guard\'s stop on a stale file');
  assert.equal(wf.currentStep, 'technical_stop', 'a stopped run must not load onto a transitionable step');

  const res = await call(env.app, 'POST', '/workflow/advance', { action: 'approve' });
  assert.equal(res.status, 409, `advance on a guard-stopped run must be refused, got ${res.status}`);
  assert.equal(res.body.outcome, 'TECHNICAL_STOP');
});

test('R14 — a stale save without the stop cannot erase or bypass it', async () => {
  const env = makeEnv();
  const stop = stopFor('rn-1');
  writeGuardStop(env.config, 'rn-1', stop);
  const stopped = activeWf('rn-1');
  stopped.technicalStop = stop;
  stopped.currentStep = 'technical_stop';
  rawWriteWf(env, stopped);
  const guardBefore = bytes(env.guardFile);

  // A handler that loaded the workflow before the stop landed saves its copy.
  env.state.saveWorkflow(activeWf('rn-1'));

  const onDisk = JSON.parse(bytes(env.wfFile));
  assert.ok(isTechnicalStop(onDisk.technicalStop), 'the persisted file must still carry the stop after a stale save');
  assert.equal(onDisk.currentStep, 'technical_stop', 'a stale save must not persist a transitionable step');
  assert.equal(bytes(env.guardFile), guardBefore, 'the guard must be untouched by a stale workflow save');

  const res = await call(env.app, 'POST', '/workflow/advance', { action: 'approve' });
  assert.equal(res.status, 409, 'the run must stay non-transitionable after a stale save');
});

test('R15 — terminality survives a server / state-manager restart', async () => {
  const env = makeEnv();
  writeGuardStop(env.config, 'rn-1', stopFor('rn-1'));
  rawWriteWf(env, activeWf('rn-1'));

  // A fresh process: new state manager, new router, same disk.
  const state2 = createStateManager(env.config, () => {});
  const wf = state2.loadWorkflow();
  assert.ok(isTerminal(wf), 'a restarted state manager must read the guard, not trust the stale file');

  const app2 = express();
  app2.use(express.json());
  app2.use('/api', createWorkflowRouter(env.config, state2, {}, {}, () => {}));
  const res = await call(app2, 'POST', '/workflow/advance', { action: 'approve' });
  assert.equal(res.status, 409, 'the restarted server must refuse to advance the stopped run');
});

// ---------- R16 / R17 — reading statistics and snapshots must not write ----------

test('R16 — GET /workflow/token-stats reads snapshots without mutating anything', async () => {
  const env = makeEnv();
  const current = activeWf('rn-1');
  current.steps.task_execution.cumulativeTokens = { inputTokens: 100, outputTokens: 50, costUSD: 0.01 };
  env.state.saveWorkflow(current);

  const old = activeWf('rn-0');
  old.input = 'PRD-archived';
  old.currentStep = 'reviewing';
  old.steps.reviewing = {
    status: 'done', agents: [],
    cumulativeTokens: { inputTokens: 4000, outputTokens: 2000, costUSD: 0.5 },
  };
  writeSnapshot(env, 'workflow-rn-0-step-reviewing-2026-08-20.json', old);

  fs.writeFileSync(env.agentStatusFile, JSON.stringify({ agents: [{ role: 'developer', status: 'working' }] }, null, 2));

  const wfBefore = bytes(env.wfFile);
  const statusBefore = bytes(env.agentStatusFile);
  const snapListBefore = fs.readdirSync(env.snapshotsDir).sort().join(',');
  const broadcastsBefore = env.broadcasts.length;

  const res = await call(env.app, 'GET', '/workflow/token-stats');
  assert.equal(res.status, 200);

  // The stats must actually come from the snapshots. On the unrepaired code the
  // only snapshot primitive was restoreSnapshot — a write path — so this route
  // either replaced live state per snapshot or (misused) read nothing at all.
  const archived = (res.body.prds || []).find((p) => p.prdId === 'PRD-archived');
  assert.ok(archived, 'token stats must include workflows that exist only as snapshots');
  assert.equal(archived.tokens, 6000);

  assert.equal(bytes(env.wfFile), wfBefore, 'a statistics GET must not rewrite workflow-state.json');
  assert.equal(bytes(env.agentStatusFile), statusBefore, 'a statistics GET must not rewrite agent-status.json');
  assert.equal(fs.readdirSync(env.snapshotsDir).sort().join(','), snapListBefore, 'a statistics GET must not add or drop snapshots');
  assert.equal(env.broadcasts.length, broadcastsBefore, 'a statistics GET must not broadcast');

  // And the step-transition tracker must be untouched: re-saving the current
  // workflow on the same step must not mint a snapshot of a "transition".
  env.state.saveWorkflow(env.state.loadWorkflow());
  assert.equal(fs.readdirSync(env.snapshotsDir).sort().join(','), snapListBefore,
    'the GET must not have moved the last-step tracker (a same-step save minted a snapshot)');
});

test('R17 — readSnapshot is a pure read: no writes, no broadcasts, no restore marker', async () => {
  const env = makeEnv();
  env.state.saveWorkflow(activeWf('rn-1'));
  const old = activeWf('rn-0');
  writeSnapshot(env, 'workflow-rn-0-step-task_execution-2026-08-20.json', old);

  assert.equal(typeof env.state.readSnapshot, 'function',
    'the state manager must offer a pure snapshot read, separate from restore');

  const wfBefore = bytes(env.wfFile);
  const broadcastsBefore = env.broadcasts.length;

  const snap = env.state.readSnapshot('workflow-rn-0-step-task_execution-2026-08-20.json');
  assert.equal(snap.id, 'rn-0', 'readSnapshot must return the parsed snapshot');
  assert.equal(snap._restoredFrom, undefined, 'a read is not a restore and must not be marked as one');
  assert.equal(bytes(env.wfFile), wfBefore, 'readSnapshot must not touch workflow-state.json');
  assert.equal(env.broadcasts.length, broadcastsBefore, 'readSnapshot must not broadcast');
});

// ---------- R18 / R19 — a guard that cannot be trusted fails closed ----------

test('R18 — a malformed guard file fails closed, it is not replaced by an empty one', async () => {
  const env = makeEnv();
  fs.mkdirSync(path.dirname(env.guardFile), { recursive: true });
  fs.writeFileSync(env.guardFile, '{ this is not JSON');
  rawWriteWf(env, activeWf('rn-1'));

  const guard = createRunGuard({ statePath: env.config.statePath });
  assert.throws(() => guard.load('rn-1'), (e) => e.name === 'RunGuardCorruptError',
    'reading a corrupt guard must throw a typed error, not return a fresh document');
  assert.throws(() => guard.bump('rn-1', 'review_rounds', 5), (e) => e.name === 'RunGuardCorruptError',
    'a budget must not be renewable by corrupting the guard');

  const wfBefore = bytes(env.wfFile);
  assert.throws(() => env.state.saveWorkflow(activeWf('rn-1')), (e) => e.name === 'RunGuardCorruptError',
    'no workflow write may proceed while the guard\'s authority cannot be verified');
  assert.equal(bytes(env.wfFile), wfBefore, 'the refused save must leave the file byte-identical');

  const res = await call(env.app, 'POST', '/workflow/advance', { action: 'approve' });
  assert.ok(res.status >= 400, `advance must be refused over an unreadable guard, got ${res.status}`);
  assert.equal(res.body.code, 'RUN_GUARD_UNREADABLE', 'the refusal must be machine-readable');
  assert.equal(bytes(env.guardFile), '{ this is not JSON', 'the corrupt file must be preserved as evidence, not overwritten');
});

test('R19 — a guard file with the wrong runId or schema fails closed', () => {
  const env = makeEnv();
  const guard = createRunGuard({ statePath: env.config.statePath });
  fs.mkdirSync(path.dirname(env.guardFile), { recursive: true });

  // Wrong run: a file at rn-1's path claiming to belong to another run.
  const foreign = { schemaVersion: 1, runId: 'rn-other', revision: 3, counters: { review_rounds: 5 }, incidents: [], blockingTasks: [], acceptanceGaps: [], technicalStop: null };
  fs.writeFileSync(env.guardFile, JSON.stringify(foreign));
  assert.throws(() => guard.load('rn-1'), (e) => e.name === 'RunGuardCorruptError',
    'a runId mismatch must fail closed, not start a clean run');
  assert.throws(() => guard.bump('rn-1', 'review_rounds', 5), (e) => e.name === 'RunGuardCorruptError',
    'a mismatched file must not hand out a fresh budget');

  // Wrong schema: runId matches but the document shape cannot be trusted.
  fs.writeFileSync(env.guardFile, JSON.stringify({ schemaVersion: 'x', runId: 'rn-1', revision: 'many' }));
  assert.throws(() => guard.load('rn-1'), (e) => e.name === 'RunGuardCorruptError',
    'an unrecognisable schema must fail closed');

  // Absence is different: a missing file IS a new run and must stay cheap.
  fs.unlinkSync(env.guardFile);
  assert.equal(guard.load('rn-1').revision, 0, 'no guard file means a new run with no prior guard state');
});

// ---------- R20 — a guard that cannot be written cannot report a parked run ----------

test('R20 — an injected guard write failure fails closed and cannot be saved over', async (t) => {
  const env = makeEnv();
  const wf = activeWf('rn-1');
  wf.taskExecution.taskStates[1] = { status: 'blocked', blockedReason: 'reached max fix cycles (3/3)', acceptanceCovered: false, agents: [] };
  env.state.saveWorkflow(wf);

  // Make the guard directory unwritable — every attempt to persist terminal
  // truth now fails at the filesystem.
  const guardDir = path.dirname(env.guardFile);
  fs.mkdirSync(guardDir, { recursive: true });
  fs.chmodSync(guardDir, 0o555);
  t.after(() => { try { fs.chmodSync(guardDir, 0o755); } catch (_) {} });

  // Advancing hits the blocked task and tries to park the run. The park cannot
  // reach the guard, so the answer must be a typed persistence failure — not a
  // response that claims the run was successfully parked.
  const res1 = await call(env.app, 'POST', '/workflow/advance', { action: 'approve' });
  assert.ok(res1.status >= 400, `a stop that could not be persisted must not read as success, got ${res1.status}`);
  assert.equal(res1.body.code, 'TECHNICAL_STOP_PERSIST_FAILED',
    'the failure to persist terminal truth must be machine-readable, not logged and swallowed');

  // A stale save must still not reopen the run while its stop is undurable.
  env.state.saveWorkflow(activeWf('rn-1'));
  const wfAfter = env.state.loadWorkflow();
  assert.ok(isTechnicalStop(wfAfter.technicalStop),
    'a guard write failure followed by a stale save must not leave the run transitionable');

  const res2 = await call(env.app, 'POST', '/workflow/advance', { action: 'approve' });
  assert.ok(res2.status >= 400 && res2.status < 500, `the run must stay non-transitionable, got ${res2.status}`);
});

// ---------- R21 — live components cannot write a terminal run back to active ----------

test('R21 — agent feedback cannot reactivate a terminal run, even over a stale file', async () => {
  const env = makeEnv();
  writeGuardStop(env.config, 'rn-1', stopFor('rn-1'));
  // Worst case: the on-disk workflow predates the stop and still shows a
  // running agent that feedback would normally complete and advance past.
  const stale = activeWf('rn-1');
  stale.currentStep = 'design';
  stale.steps.design = { status: 'running', agents: [{ role: 'developer', status: 'running', window: 'design' }] };
  rawWriteWf(env, stale);

  const res = await call(env.app, 'POST', '/workflow/feedback', {
    role: 'developer',
    feedback: '## Design\n**Approved:** yes\nAll good.',
  });
  assert.ok(res.status >= 400, `feedback against a guard-stopped run must be refused, got ${res.status}`);

  const onDisk = JSON.parse(bytes(env.wfFile));
  const agent = ((onDisk.steps.design || {}).agents || [])[0] || {};
  assert.notEqual(agent.status, 'done', 'the refused feedback must not have completed the agent');
  assert.ok(isTerminal(env.state.loadWorkflow()), 'the run must still load as terminal after the attempt');
});
