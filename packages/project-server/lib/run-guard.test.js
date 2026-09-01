'use strict';

// F4 / F8 / F9 — the run-local guard store.
//
// The budgets that stop a runaway workflow used to live in two places that
// both forget: `_aaReject` in the project-server process (gone on restart) and
// `autoAdvanceRound` in React state (gone on reload). And the guard fields that
// did reach disk lived inside the workflow object, so a save from a stale
// whole-object snapshot silently rolled them back.
//
// These tests pin the store that replaces both: separate file, monotonic
// revision, lost-update detection, run-id isolation, survives restart.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunGuard } = require('./run-guard');
const { createTechnicalStop, REASON_CODES } = require('./technical-stop');

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bs-run-guard-'));
}

function register(guard, runId) {
  guard.register(runId, { identity: {
    runId,
    lineageId: runId,
    predecessorRunId: null,
    successorOrdinal: 0,
    registeredAt: '2026-09-01T00:00:00.000Z',
    admissionRequestDigest: 'a'.repeat(64),
    admittedHead: 'b'.repeat(40),
    admittedRepo: 'owner/repo',
    rootRegistry: { runId, requestDigest: 'a'.repeat(64) },
  } });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

test('a fresh run gets a guard doc with revision 0 and its own run id', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  const doc = guard.load('run-a');
  assert.equal(doc.runId, 'run-a');
  assert.equal(doc.revision, 0);
  assert.equal(doc.technicalStop, null);
  assert.deepEqual(doc.incidents, []);
  assert.equal(typeof doc.counters, 'object');
});

test('counters persist across a process restart — a new store on the same path sees them', () => {
  const statePath = tmpState();
  const first = createRunGuard({ statePath });
  register(first, 'run-a');
  first.bump('run-a', 'review_rounds');
  first.bump('run-a', 'review_rounds');
  first.bump('run-a', 'review_rounds');

  // Simulate a project-server restart: brand new store object, same disk.
  const second = createRunGuard({ statePath });
  assert.equal(second.count('run-a', 'review_rounds'), 3);
});

test('bump reports budget exhaustion at exactly the configured ceiling', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  register(guard, 'run-a');
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(guard.bump('run-a', 'review_rounds', 5).exceeded);
  // A ceiling of 5 means five allowed rounds: the sixth is over budget.
  assert.deepEqual(seen, [false, false, false, false, false, true]);
});

test('an exhausted budget cannot be renewed by resetting it — reset is not part of the API', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  register(guard, 'run-a');
  for (let i = 0; i < 5; i++) guard.bump('run-a', 'review_rounds', 5);
  assert.equal(guard.exceeded('run-a', 'review_rounds', 5), false);
  guard.bump('run-a', 'review_rounds', 5);
  assert.equal(guard.exceeded('run-a', 'review_rounds', 5), true);
  // No API surface renews a spent budget within the same run.
  assert.equal(typeof guard.reset, 'undefined');
  assert.equal(typeof guard.clearCounters, 'undefined');
});

test('run ids are isolated — one run exhausting a budget leaves another untouched', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  register(guard, 'run-a');
  register(guard, 'run-b');
  for (let i = 0; i < 6; i++) guard.bump('run-a', 'review_rounds', 5);
  assert.equal(guard.exceeded('run-a', 'review_rounds', 5), true);
  assert.equal(guard.exceeded('run-b', 'review_rounds', 5), false);
  assert.equal(guard.count('run-b', 'review_rounds'), 0);
});

test('every write advances the revision monotonically', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  register(guard, 'run-a');
  const r0 = guard.load('run-a').revision;
  guard.bump('run-a', 'fix_rounds');
  const r1 = guard.load('run-a').revision;
  guard.bump('run-a', 'fix_rounds');
  const r2 = guard.load('run-a').revision;
  assert.ok(r1 > r0, `${r1} > ${r0}`);
  assert.ok(r2 > r1, `${r2} > ${r1}`);
});

test('arbitrary saves are rejected; only named reducers can mutate authority', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  register(guard, 'run-a');
  const stale = guard.load('run-a');
  guard.bump('run-a', 'fix_rounds');

  stale.counters.fix_rounds = 999;
  assert.throws(() => guard.save(stale), (error) => error.code === 'RUN_GUARD_NAMED_TRANSITION_REQUIRED');

  // B's write stands; A's stale numbers never landed.
  assert.equal(guard.count('run-a', 'fix_rounds'), 1);
});

test('guard state is NOT stored inside the workflow object — a stale whole-object save cannot roll it back', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  register(guard, 'run-a');
  guard.bump('run-a', 'auto_advance_refusals');
  guard.bump('run-a', 'auto_advance_refusals');

  // The classic F8 shape: something writes an older whole workflow snapshot.
  const wfFile = path.join(statePath, 'workflow-state.json');
  fs.writeFileSync(wfFile, JSON.stringify({ id: 'run-a', currentStep: 'planning' }, null, 2));

  assert.equal(guard.count('run-a', 'auto_advance_refusals'), 2);
  // And the guard's own file is a different file entirely.
  assert.notEqual(guard.fileFor('run-a'), wfFile);
});

test('writes are atomic through a unique temp file — no fixed .tmp name to collide on', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  register(guard, 'run-a');
  guard.bump('run-a', 'fix_rounds');
  const dir = path.dirname(guard.fileFor('run-a'));
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], `temp files left behind: ${leftovers.join(', ')}`);
});

test('named evidence reducers replace unrestricted mutate()', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  register(guard, 'run-a');
  assert.throws(() => guard.mutate('run-a', () => {}), (error) => error.code === 'RUN_GUARD_NAMED_TRANSITION_REQUIRED');
  guard.setAcceptanceGaps('run-a', [{
    index: 2, name: 'auth', status: 'skipped', reason: 'max fix cycles',
  }]);
  const doc = guard.load('run-a');
  assert.equal(doc.acceptanceGaps.length, 1);
  assert.equal(doc.acceptanceGaps[0].index, 2);
  assert.ok(doc.revision > 0);
});

test('a self-consistent digest cannot smuggle process coordinates into continuation authority', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  register(guard, 'run-a');
  const workflow = {
    id: 'run-a',
    type: 'execution',
    input: 'PRD-001',
    currentStep: 'task_execution',
    round: 1,
    steps: { task_execution: { status: 'running', agents: [{ pid: 42 }] } },
    taskPlan: { tasks: [] },
    taskExecution: { currentTaskIndex: 0, taskStates: {} },
  };
  const stop = createTechnicalStop({
    reasonCode: REASON_CODES.BLOCKED_TASKS,
    runId: 'run-a',
    step: 'task_execution',
    evidence: ['blocked=true'],
  });
  guard.captureTechnicalStop('run-a', { stop, workflow });

  const file = guard.fileFor('run-a');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.repair.continuationEnvelope.stepStates.task_execution.agents = [{ pid: 42 }];
  doc.repair.continuationDigest = crypto.createHash('sha256')
    .update(canonicalJson(doc.repair.continuationEnvelope)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));

  assert.throws(() => guard.load('run-a'), (error) => error.code === 'RUN_GUARD_UNREADABLE');
});
