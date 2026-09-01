'use strict';

// A1b.2R Slice 1 — the root run guard is the only repair aggregate.
//
// These canaries intentionally exercise disk authority. They do not import a
// successor, scheduler, tmux or launch implementation because none belongs to
// this slice. The same file is run unchanged against the frozen start SHA for
// the red-first receipt.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { createAdmission } = require('./admission');
const { createAdmissionRegistry } = require('./admission-registry');
const { createRunGuard } = require('./run-guard');
const { createStateManager, attachStateAuthority } = require('./state');
const { createWorkflowRouter } = require('./api/workflow');
const { createTechnicalStop, REASON_CODES } = require('./technical-stop');

let fixtureNumber = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-a1b2r-root-'));
  t.after(() => { try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {} });
  const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(projectRoot, 'docs', 'prds'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# A1b.2R fixture\n');
  fs.writeFileSync(path.join(projectRoot, 'docs', 'prds', 'PRD-001.md'), '# PRD-001\n');
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  git('branch', '-M', 'main');
  git('remote', 'add', 'origin', 'https://github.com/test-owner/test-repo.git');
  const statePath = path.join(projectRoot, '.build-studio');
  const config = {
    projectRoot,
    statePath,
    docsPath: path.join(projectRoot, 'docs'),
    worktreesPath: path.join(projectRoot, 'tmp', '.worktrees'),
    logsPath: path.join(projectRoot, 'tmp', '.logs'),
    tmpPath: path.join(projectRoot, 'tmp'),
    roles: { review: [], execution: [], standalone: [] },
  };
  const admission = createAdmission(config);
  const now = Date.now();
  const request = {
    version: 1,
    repo: 'test-owner/test-repo',
    head: git('rev-parse', 'HEAD'),
    task_packet: 'docs/prds/PRD-001.md',
    claims: [],
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
    nonce: `a1b2r-${process.pid}-${++fixtureNumber}-${crypto.randomBytes(8).toString('hex')}`,
  };
  const admitted = admission.admit(request, { runIdPrefix: 'root' });
  const workflow = {
    id: admitted.runId,
    type: 'execution',
    input: 'PRD-001',
    prdPath: 'docs/prds/PRD-001.md',
    itemId: 'PRD-001',
    branch: 'exec/PRD-001',
    defaultBranch: 'main',
    reviewBranch: 'exec/PRD-001',
    currentStep: 'task_execution',
    round: 2,
    sessionName: 'must-not-enter-continuation',
    steps: {
      qa_tests: { status: 'completed', agents: [{ role: 'QA', window: 'qa' }] },
      task_execution: { status: 'running', agents: [{ role: 'Dev', window: 'dev' }] },
      merge_for_review: { status: 'pending', agents: [] },
    },
    taskPlan: {
      validation: 'passed',
      tasks: [{
        id: 1,
        name: 'Repair target',
        description: 'Implement the bounded target.',
        roles: ['Backend Dev'],
        dependencies: [],
        acs_covered: ['AC-1'],
        estimated_size: 'small',
      }],
    },
    taskExecution: {
      currentTaskIndex: 0,
      taskStates: {
        0: {
          status: 'blocked',
          agents: [{ role: 'Dev', window: 'dev', pid: 999 }],
          fixCycles: 3,
          acceptanceCovered: false,
          blockedReason: 'deterministic failure',
          branches: ['task/one'],
          startedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    },
    technicalStop: null,
    guardUnverifiable: { should: 'not be copied' },
    successorRepair: { should: 'not be copied' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:01:00.000Z',
  };
  const stop = createTechnicalStop({
    reasonCode: REASON_CODES.BLOCKED_TASKS,
    runId: admitted.runId,
    step: 'task_execution',
    tasks: [{ index: 0, name: 'Repair target', reason: 'deterministic failure' }],
    evidence: ['taskStates.0.status=blocked', 'test=a1b2r-root-aggregate'],
  });
  return { projectRoot, statePath, config, admission, request, runId: admitted.runId, workflow, stop };
}

function productionGuard(fx, options = {}) {
  const registry = createAdmissionRegistry({ statePath: fx.statePath });
  return createRunGuard({
    statePath: fx.statePath,
    isRegistered: registry.isRegistered,
    getRegistration: registry.getRun,
    ...options,
  });
}

function capture(fx) {
  return productionGuard(fx).captureTechnicalStop(fx.runId, {
    stop: fx.stop,
    workflow: fx.workflow,
  });
}

function guardChild(fx, operation) {
  const source = `
    const { createAdmissionRegistry } = require(process.argv[1]);
    const { createRunGuard } = require(process.argv[2]);
    const statePath = process.argv[3];
    const runId = process.argv[4];
    const registry = createAdmissionRegistry({ statePath });
    const guard = createRunGuard({
      statePath,
      isRegistered: registry.isRegistered,
      getRegistration: registry.getRun,
    });
    try {
      if (process.argv[5] === 'stop') {
        guard.captureTechnicalStop(runId, {
          stop: JSON.parse(process.argv[6]),
          workflow: JSON.parse(process.argv[7]),
        });
      } else {
        guard.bump(runId, 'cross_process_units');
      }
      process.stdout.write(JSON.stringify({ ok: true, operation: process.argv[5] }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, operation: process.argv[5], code: error.code, message: error.message }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e', source,
      require.resolve('./admission-registry'),
      require.resolve('./run-guard'),
      fx.statePath,
      fx.runId,
      operation,
      JSON.stringify(fx.stop),
      JSON.stringify(fx.workflow),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`guard child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (_) { reject(new Error(`invalid guard child output: ${stdout}\n${stderr}`)); }
    });
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

async function invokePost(router, routePath, body, admission = null) {
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
  await routeLayer.handle({ body: body || {}, admission }, res);
  return { status, body: payload || {} };
}

test('S1 — every new admitted root gets the exact strict ACTIVE_ROOT aggregate schema', (t) => {
  const fx = fixture(t);
  const doc = productionGuard(fx).load(fx.runId);
  assert.equal(doc.schemaVersion, 2);
  assert.equal(doc.runId, fx.runId);
  assert.equal(doc.revision, 1);
  assert.equal(doc.identity.rootRegistry.runId, fx.runId);
  assert.equal(doc.identity.rootRegistry.requestDigest, fx.admission.registry.getRun(fx.runId).verdict.requestDigest);
  assert.deepEqual(doc.counters, {});
  assert.deepEqual(doc.incidents, []);
  assert.deepEqual(doc.acceptanceGaps, []);
  assert.equal(doc.technicalStop, null);
  assert.equal(doc.technicalCause, null);
  assert.equal(doc.technicalCauseDigest, null);
  assert.deepEqual(doc.repair, {
    state: 'ACTIVE_ROOT',
    maxSuccessors: 1,
    successorsUsed: 0,
    continuationEnvelope: null,
    continuationDigest: null,
  });
});

test('A — two processes preserve every acknowledged spend and a racing stop', async (t) => {
  const spendFx = fixture(t);
  const spend = await Promise.all(Array.from({ length: 24 }, () => guardChild(spendFx, 'bump')));
  assert.ok(spend.every((result) => result.ok), JSON.stringify(spend));
  assert.equal(productionGuard(spendFx).load(spendFx.runId).counters.cross_process_units, 24);

  const stopFx = fixture(t);
  const outcomes = await Promise.all([
    ...Array.from({ length: 16 }, () => guardChild(stopFx, 'bump')),
    guardChild(stopFx, 'stop'),
  ]);
  const stop = outcomes.find((result) => result.operation === 'stop');
  const acknowledged = outcomes.filter((result) => result.operation === 'bump' && result.ok).length;
  const refused = outcomes.filter((result) => result.operation === 'bump' && !result.ok);
  assert.equal(stop.ok, true, JSON.stringify(outcomes));
  assert.ok(refused.every((result) => result.code === 'RUN_GUARD_TERMINAL'), JSON.stringify(refused));
  const final = productionGuard(stopFx).load(stopFx.runId);
  assert.equal(final.counters.cross_process_units || 0, acknowledged);
  assert.equal(final.repair.state, 'STOPPED');
  assert.equal(final.technicalStop.reasonCode, REASON_CODES.BLOCKED_TASKS);
});

test('B — stop commit is the authority boundary across pre-commit refusal and post-commit projection crash', (t) => {
  const beforeFx = fixture(t);
  const beforeGuard = productionGuard(beforeFx, { lockTimeoutMs: 25 });
  const lock = beforeGuard.lockFor(beforeFx.runId);
  fs.mkdirSync(lock, { recursive: true });
  writeJson(path.join(lock, 'owner.json'), {
    protocolVersion: 1,
    token: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    runId: beforeFx.runId,
    createdAt: new Date().toISOString(),
  });
  assert.throws(() => beforeGuard.captureTechnicalStop(beforeFx.runId, {
    stop: beforeFx.stop,
    workflow: beforeFx.workflow,
  }), (error) => error.code === 'RUN_GUARD_BUSY');
  assert.equal(readJson(beforeGuard.fileFor(beforeFx.runId)).technicalStop, null,
    'a refusal before the aggregate commit cannot claim stop authority');

  const afterFx = fixture(t);
  const stale = clone(afterFx.workflow);
  const crashingBase = {
    loadWorkflow: () => clone(stale),
    saveWorkflow: () => { throw new Error('simulated projection crash'); },
  };
  const crashingState = attachStateAuthority(crashingBase, afterFx.config);
  assert.throws(() => crashingState.recordTechnicalStop(clone(stale), afterFx.stop), /simulated projection crash/);

  const restarted = attachStateAuthority({
    loadWorkflow: () => clone(stale),
    saveWorkflow: () => {},
  }, afterFx.config);
  const projected = restarted.loadWorkflow();
  const aggregate = productionGuard(afterFx).load(afterFx.runId);
  assert.equal(projected.currentStep, 'technical_stop');
  assert.deepEqual(projected.technicalStop, aggregate.technicalStop);
  assert.equal(aggregate.repair.state, 'STOPPED');
  assert.equal(aggregate.repair.continuationEnvelope.stoppedStep, 'task_execution');
  assert.ok(aggregate.technicalCauseDigest);
  assert.ok(aggregate.repair.continuationDigest);
});

test('C — missing, mistyped, unknown and future authority fail closed before mutation', (t) => {
  for (const mutate of [
    (doc) => { delete doc.repair.continuationDigest; },
    (doc) => { doc.repair.maxSuccessors = '1'; },
    (doc) => { doc.unrecognisedAuthority = true; },
    (doc) => { doc.schemaVersion = 99; },
  ]) {
    const fx = fixture(t);
    const guard = productionGuard(fx);
    const file = guard.fileFor(fx.runId);
    const corrupt = readJson(file);
    mutate(corrupt);
    writeJson(file, corrupt);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => guard.load(fx.runId), (error) => error.code === 'RUN_GUARD_UNREADABLE');
    assert.throws(() => guard.bump(fx.runId, 'must_not_land'), (error) => error.code === 'RUN_GUARD_UNREADABLE');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('D — schema 1 renders and cancel works, but authority mutation is LEGACY_READ_ONLY and byte-stable', async (t) => {
  const fx = fixture(t);
  const guard = productionGuard(fx);
  const file = guard.fileFor(fx.runId);
  writeJson(file, {
    schemaVersion: 1,
    runId: fx.runId,
    laneId: 'default',
    revision: 7,
    counters: { review_rounds: 2 },
    incidents: [],
    blockingTasks: [],
    acceptanceGaps: [],
    technicalStop: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(guard.load(fx.runId).schemaVersion, 1, 'legacy remains readable');
  assert.throws(() => guard.bump(fx.runId, 'review_rounds'), (error) => error.code === 'LEGACY_READ_ONLY');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'legacy mutation must not rewrite or upgrade the file');

  const state = createStateManager(fx.config, () => {});
  state.saveWorkflow(clone(fx.workflow));
  let tmuxCalls = 0;
  const tmuxOps = new Proxy({}, { get: () => () => { tmuxCalls += 1; } });
  const router = createWorkflowRouter(fx.config, state, {}, tmuxOps, () => {}, { admission: fx.admission });
  const cancelled = await invokePost(router, '/workflow/cancel', {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(state.loadWorkflow(), null);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'cancel cannot mutate legacy authority');
  assert.ok(tmuxCalls <= 1, 'cancel may use only its operator cleanup seam');
});

test('E — cause, digest, continuation and root-registry tamper refuse on authority read', (t) => {
  const cases = [
    (doc) => { doc.technicalCause.evidence = ['tampered']; },
    (doc) => { doc.technicalCauseDigest = 'f'.repeat(64); },
    (doc) => { doc.repair.continuationEnvelope.stoppedStep = 'merge_to_main'; },
    (doc) => { doc.identity.rootRegistry.requestDigest = 'e'.repeat(64); },
  ];
  for (const mutate of cases) {
    const fx = fixture(t);
    capture(fx);
    const guard = productionGuard(fx);
    const file = guard.fileFor(fx.runId);
    const tampered = readJson(file);
    mutate(tampered);
    writeJson(file, tampered);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => guard.load(fx.runId), (error) => error.code === 'RUN_GUARD_UNREADABLE');
    assert.throws(() => guard.bump(fx.runId, 'must_not_land'), (error) => error.code === 'RUN_GUARD_UNREADABLE');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('F — stale workflow saves and snapshots cannot lower counters or replace terminal continuation', (t) => {
  const fx = fixture(t);
  const guard = productionGuard(fx);
  guard.bump(fx.runId, 'review_rounds');
  guard.bump(fx.runId, 'review_rounds');
  guard.bump(fx.runId, 'review_rounds');
  const stale = clone(fx.workflow);
  const state = createStateManager(fx.config, () => {});
  state.saveWorkflow(stale);
  state.recordTechnicalStop(clone(stale), fx.stop);
  const terminal = guard.load(fx.runId);
  const continuation = clone(terminal.repair.continuationEnvelope);

  state.saveWorkflow(stale);
  const projected = state.loadWorkflow();
  assert.equal(projected.currentStep, 'technical_stop');
  const afterSave = guard.load(fx.runId);
  assert.equal(afterSave.counters.review_rounds, 3);
  assert.deepEqual(afterSave.repair.continuationEnvelope, continuation);

  const snapshots = path.join(fx.statePath, 'snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  writeJson(path.join(snapshots, 'stale.json'), { ...stale, currentStep: 'merge_to_main' });
  assert.throws(() => state.restoreSnapshot('stale.json'), (error) => error.code === 'RUN_TERMINAL');
  const afterRestore = guard.load(fx.runId);
  assert.equal(afterRestore.counters.review_rounds, 3);
  assert.deepEqual(afterRestore.repair.continuationEnvelope, continuation);
});

test('G — the real stop path performs zero launch, tmux, CLI or worktree calls in Slice 1', async (t) => {
  const fx = fixture(t);
  const state = createStateManager(fx.config, () => {});
  state.saveWorkflow(clone(fx.workflow));
  let externalCalls = 0;
  const external = new Proxy({}, {
    get: (_target, key) => () => {
      externalCalls += 1;
      throw new Error(`unexpected external seam: ${String(key)}`);
    },
  });
  const router = createWorkflowRouter(fx.config, state, external, external, () => {}, { admission: fx.admission });
  const stopped = await invokePost(
    router,
    '/workflow/advance',
    { action: 'approve' },
    fx.admission.contextFor(fx.runId),
  );
  assert.equal(stopped.status, 409, JSON.stringify(stopped.body));
  assert.equal(stopped.body.outcome, 'TECHNICAL_STOP');
  assert.equal(externalCalls, 0);
  assert.equal(productionGuard(fx).load(fx.runId).repair.state, 'STOPPED');
  assert.equal(fs.existsSync(path.join(fx.statePath, 'successor-launch')), false);
  assert.equal(fs.existsSync(path.join(fx.statePath, 'launch-receipts')), false);
});

test('H — missing root, digest mismatch and wrong run id break the guard/registry cross-link', (t) => {
  for (const mutate of [
    (fx) => {
      const file = fx.admission.registry.file;
      const registry = readJson(file);
      delete registry.runs[fx.runId];
      writeJson(file, registry);
    },
    (fx) => {
      const file = fx.admission.registry.file;
      const registry = readJson(file);
      registry.runs[fx.runId].verdict.requestDigest = 'f'.repeat(64);
      writeJson(file, registry);
    },
    (fx) => {
      const guard = productionGuard(fx);
      const file = guard.fileFor(fx.runId);
      const doc = readJson(file);
      doc.identity.rootRegistry.runId = 'another-root';
      writeJson(file, doc);
    },
  ]) {
    const fx = fixture(t);
    mutate(fx);
    const guard = productionGuard(fx);
    const before = fs.readFileSync(guard.fileFor(fx.runId), 'utf8');
    assert.throws(() => guard.load(fx.runId), (error) => error.code === 'RUN_GUARD_REGISTRY_MISMATCH');
    assert.throws(() => guard.bump(fx.runId, 'must_not_land'), (error) => error.code === 'RUN_GUARD_REGISTRY_MISMATCH');
    assert.equal(fs.readFileSync(guard.fileFor(fx.runId), 'utf8'), before);
  }
});
