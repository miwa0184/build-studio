'use strict';

// A1b.2R Slice 1 authority repair canaries.
//
// This file is copied byte-for-byte to the frozen pre-repair head for the RED
// receipt. It covers the two authority failures reproduced after the first S1
// commit: refusal spend split across two writes, and acceptance gaps that the
// aggregate stored but the state boundary did not enforce.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const runBudgets = require('./run-budgets');
const { createStateManager } = require('./state');
const { createWorkflowRouter } = require('./api/workflow');
const { createTechnicalStop, REASON_CODES } = require('./technical-stop');
const { registerTestRoot } = require('./test-support/root-aggregate');

let sequence = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function gapFor(index = 0) {
  return {
    index,
    name: `Task ${index + 1}`,
    status: 'skipped',
    reason: 'operator ended the task without an agent verdict',
  };
}

function workflow(runId, { step = 'task_execution', taskStatus = 'skipped' } = {}) {
  return {
    id: runId,
    type: 'execution',
    input: 'PRD-001',
    currentStep: step,
    round: 1,
    autoAdvance: false,
    sessionName: 'authority-repair-test',
    steps: {
      task_execution: { status: step === 'task_execution' ? 'running' : 'completed', agents: [] },
      merge_for_review: { status: step === 'merge_for_review' ? 'running' : 'pending', agents: [] },
      ac_verification: { status: step === 'ac_verification' ? 'running' : 'pending', agents: [] },
      merge_to_main: { status: step === 'merge_to_main' ? 'running' : 'pending', agents: [] },
    },
    taskPlan: {
      tasks: [{ name: 'Task 1', roles: [], acs_covered: ['AC-1'] }],
    },
    taskExecution: {
      currentTaskIndex: 0,
      taskStates: {
        0: {
          status: taskStatus,
          agents: [],
          acceptanceCovered: taskStatus === 'done',
          skipReason: taskStatus === 'skipped' ? 'operator ended the task without an agent verdict' : undefined,
        },
      },
    },
    acceptanceGaps: [],
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a1b2r-authority-repair-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
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
  const state = createStateManager(config, () => {});
  const runId = `authority-repair-${process.pid}-${++sequence}`;
  const guard = registerTestRoot({ statePath: config.statePath, runId, guard: state.runGuard });
  return {
    root,
    config,
    state,
    guard,
    runId,
    workflowFile: path.join(config.statePath, 'workflow-state.json'),
    snapshotsDir: path.join(config.statePath, 'snapshots'),
  };
}

async function invokePost(router, routePath, body) {
  const layer = router.stack.find((candidate) => candidate.route && candidate.route.path === routePath);
  assert.ok(layer, `route ${routePath} must exist`);
  const routeLayer = layer.route.stack.find((candidate) => candidate.method === 'post');
  assert.ok(routeLayer, `POST ${routePath} must exist`);
  let status = 200;
  let payload;
  const res = {
    headersSent: false,
    status(value) { status = value; return this; },
    json(value) { payload = value; this.headersSent = true; return this; },
  };
  await routeLayer.handle({ body: body || {} }, res);
  return { status, body: payload || {} };
}

function runChild(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`child exited ${code}: ${stderr || stdout}`));
    });
  });
}

test('F1a — an injected compound refusal failure leaves both counters and revision unchanged', (t) => {
  const fx = fixture(t);
  const budgets = runBudgets.resolveBudgets({
    max_auto_advance_refusals: 3,
    max_auto_advance_refusals_total: 15,
  });
  const before = fx.guard.load(fx.runId);
  const faultGuard = {
    // Pre-repair code enters here: the first bump lands and the second throws.
    bump(runId, key, max) {
      if (key === runBudgets.COUNTERS.AUTO_ADVANCE_REFUSALS) {
        throw new Error('injected second counter write failure');
      }
      return fx.guard.bump(runId, key, max);
    },
    // Repaired code enters here: the named compound transition fails before it
    // owns the lock or writes either counter.
    noteAutoAdvanceRefusal() {
      throw new Error('injected compound transition failure');
    },
  };

  assert.throws(
    () => runBudgets.noteAutoAdvanceRefusal(faultGuard, fx.runId, 'qa_validation', budgets, 'gate refused'),
    /injected/,
  );
  const after = fx.guard.load(fx.runId);
  assert.equal(after.revision, before.revision, 'a refused compound event must not create a partial revision');
  assert.equal(after.counters['auto_advance_refusals:qa_validation'], undefined);
  assert.equal(after.counters.auto_advance_refusals, undefined);

  // Exercise failure after the real reducer has updated both values in memory
  // but before its single atomic replace can commit. Disk must still expose
  // neither value and no new revision.
  const guardDir = path.dirname(fx.guard.fileFor(fx.runId));
  fs.chmodSync(guardDir, 0o555);
  try {
    assert.throws(() => fx.guard.noteAutoAdvanceRefusal(fx.runId, 'qa_validation'), /EACCES|permission denied/);
  } finally {
    fs.chmodSync(guardDir, 0o755);
  }
  const afterAtomicFailure = fx.guard.load(fx.runId);
  assert.equal(afterAtomicFailure.revision, before.revision);
  assert.equal(afterAtomicFailure.counters['auto_advance_refusals:qa_validation'], undefined);
  assert.equal(afterAtomicFailure.counters.auto_advance_refusals, undefined);
});

test('F1b — one named refusal event spends both counters in one revision', (t) => {
  const fx = fixture(t);
  const before = fx.guard.load(fx.runId);
  const spent = fx.guard.noteAutoAdvanceRefusal(fx.runId, 'qa_validation');
  const after = fx.guard.load(fx.runId);

  assert.deepEqual(spent, { stepCount: 1, totalCount: 1 });
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.counters['auto_advance_refusals:qa_validation'], 1);
  assert.equal(after.counters.auto_advance_refusals, 1);
});

test('F1c — cross-process compound refusal spend loses neither per-step nor total events', async (t) => {
  const fx = fixture(t);
  const workers = 5;
  const eventsPerWorker = 8;
  const before = fx.guard.load(fx.runId);
  const runGuardModule = require.resolve('./run-guard');
  const registryModule = require.resolve('./admission-registry');
  const script = `
    const { createRunGuard } = require(process.argv[1]);
    const { createAdmissionRegistry } = require(process.argv[2]);
    const statePath = process.argv[3];
    const runId = process.argv[4];
    const count = Number(process.argv[5]);
    const registry = createAdmissionRegistry({ statePath });
    const guard = createRunGuard({
      statePath,
      isRegistered: registry.isRegistered,
      getRegistration: registry.getRun,
      lockTimeoutMs: 10000,
    });
    for (let i = 0; i < count; i += 1) guard.noteAutoAdvanceRefusal(runId, 'qa_validation');
  `;
  await Promise.all(Array.from({ length: workers }, () => runChild(script, [
    runGuardModule,
    registryModule,
    fx.config.statePath,
    fx.runId,
    String(eventsPerWorker),
  ])));

  const expected = workers * eventsPerWorker;
  const after = fx.guard.load(fx.runId);
  assert.equal(after.counters['auto_advance_refusals:qa_validation'], expected);
  assert.equal(after.counters.auto_advance_refusals, expected);
  assert.equal(after.revision, before.revision + expected, 'each acknowledged event owns exactly one revision');
});

test('F2a — aggregate gaps survive stale save/load and can never project acceptanceCovered=true', (t) => {
  const fx = fixture(t);
  const gap = gapFor();
  fx.guard.recordAcceptanceGaps(fx.runId, [gap]);

  const stale = workflow(fx.runId, { step: 'merge_to_main', taskStatus: 'done' });
  stale.taskExecution.taskStates[0].acceptanceCovered = true;
  stale.acceptanceGaps = [];
  fx.state.saveWorkflow(stale);

  const loaded = fx.state.loadWorkflow();
  assert.deepEqual(loaded.acceptanceGaps, [gap]);
  assert.equal(loaded.taskExecution.taskStates[0].acceptanceCovered, false);
  assert.deepEqual(fx.guard.load(fx.runId).acceptanceGaps, [gap]);

  // A direct stale "set empty" cannot clear monotonic acceptance authority.
  assert.deepEqual(fx.guard.setAcceptanceGaps(fx.runId, []), [gap]);
  assert.deepEqual(fx.guard.load(fx.runId).acceptanceGaps, [gap]);
});

test('F2b — restoring a stale snapshot re-projects the aggregate gap', (t) => {
  const fx = fixture(t);
  const gap = gapFor();
  fx.state.saveWorkflow(workflow(fx.runId, { step: 'ac_verification', taskStatus: 'done' }));
  fx.guard.recordAcceptanceGaps(fx.runId, [gap]);

  const snapshot = workflow(fx.runId, { step: 'merge_to_main', taskStatus: 'done' });
  snapshot.taskExecution.taskStates[0].acceptanceCovered = true;
  snapshot.acceptanceGaps = [];
  fs.mkdirSync(fx.snapshotsDir, { recursive: true });
  fs.writeFileSync(path.join(fx.snapshotsDir, 'stale-before-gap.json'), JSON.stringify(snapshot, null, 2));

  const restored = fx.state.restoreSnapshot('stale-before-gap.json');
  assert.deepEqual(restored.acceptanceGaps, [gap]);
  assert.equal(restored.taskExecution.taskStates[0].acceptanceCovered, false);
  assert.deepEqual(fx.state.loadWorkflow().acceptanceGaps, [gap]);
});

test('F2c — a new gap that cannot reach the guard fails closed before task completion or merge', async (t) => {
  const fx = fixture(t);
  const wf = workflow(fx.runId, { step: 'task_execution', taskStatus: 'skipped' });
  fx.state.saveWorkflow(wf);
  const beforeBytes = fs.readFileSync(fx.workflowFile, 'utf8');
  const beforeGuard = fx.guard.load(fx.runId);
  const guardDir = path.dirname(fx.guard.fileFor(fx.runId));
  fs.chmodSync(guardDir, 0o555);
  t.after(() => { try { fs.chmodSync(guardDir, 0o755); } catch (_) {} });

  const router = createWorkflowRouter(fx.config, fx.state, {}, {}, () => {});
  await assert.rejects(
    () => invokePost(router, '/workflow/advance', { action: 'launch' }),
    (error) => error && error.code === 'ACCEPTANCE_GAP_PERSIST_FAILED',
  );
  assert.equal(fs.readFileSync(fx.workflowFile, 'utf8'), beforeBytes, 'no workflow write may land after the guard refusal');
  const disk = JSON.parse(beforeBytes);
  assert.equal(disk.currentStep, 'task_execution');
  assert.notEqual(disk.steps.task_execution.status, 'completed');
  const afterGuard = fx.guard.load(fx.runId);
  assert.equal(afterGuard.revision, beforeGuard.revision);
  assert.deepEqual(afterGuard.acceptanceGaps, []);
});

test('F2d — technical stop projection retains aggregate gaps and legacy cancel remains the escape', async (t) => {
  const fx = fixture(t);
  const gap = gapFor();
  const stoppedSource = workflow(fx.runId, { step: 'task_execution', taskStatus: 'skipped' });
  fx.state.saveWorkflow(stoppedSource);
  fx.state.recordAcceptanceGaps(stoppedSource, [gap]);
  const stop = createTechnicalStop({
    reasonCode: REASON_CODES.BLOCKED_TASKS,
    runId: fx.runId,
    step: 'task_execution',
    tasks: [{ index: 0, name: 'Task 1', reason: 'blocked after the acceptance gap was recorded' }],
    evidence: ['acceptanceCovered=false'],
  });
  fx.state.recordTechnicalStop(stoppedSource, stop);

  fs.writeFileSync(fx.workflowFile, JSON.stringify(workflow(fx.runId, { step: 'merge_to_main', taskStatus: 'done' }), null, 2));
  const loaded = fx.state.loadWorkflow();
  assert.equal(loaded.currentStep, 'technical_stop');
  assert.deepEqual(loaded.acceptanceGaps, [gap]);
  assert.equal(loaded.taskExecution.taskStates[0].acceptanceCovered, false);

  // Cancellation remains deliberately outside authority mutation, including
  // for a schema-1 guard: it removes the workflow but never rewrites the guard.
  const legacy = fixture(t);
  const legacyFile = legacy.guard.fileFor(legacy.runId);
  fs.writeFileSync(legacyFile, JSON.stringify({
    schemaVersion: 1,
    runId: legacy.runId,
    laneId: 'default',
    revision: 4,
    counters: {},
    incidents: [],
    blockingTasks: [],
    acceptanceGaps: [],
    technicalStop: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }, null, 2));
  const legacyBytes = fs.readFileSync(legacyFile, 'utf8');
  legacy.state.saveWorkflow(workflow(legacy.runId, { taskStatus: 'done' }));
  const tmuxOps = new Proxy({}, { get: () => () => {} });
  const legacyRouter = createWorkflowRouter(legacy.config, legacy.state, {}, tmuxOps, () => {});
  const cancelled = await invokePost(legacyRouter, '/workflow/cancel', {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(legacy.state.loadWorkflow(), null);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacyBytes);
});
