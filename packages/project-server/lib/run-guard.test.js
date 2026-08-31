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
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunGuard, RunGuardConflictError } = require('./run-guard');

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bs-run-guard-'));
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
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(guard.bump('run-a', 'review_rounds', 5).exceeded);
  // A ceiling of 5 means five allowed rounds: the sixth is over budget.
  assert.deepEqual(seen, [false, false, false, false, false, true]);
});

test('an exhausted budget cannot be renewed by resetting it — reset is not part of the API', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
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
  for (let i = 0; i < 6; i++) guard.bump('run-a', 'review_rounds', 5);
  assert.equal(guard.exceeded('run-a', 'review_rounds', 5), true);
  assert.equal(guard.exceeded('run-b', 'review_rounds', 5), false);
  assert.equal(guard.count('run-b', 'review_rounds'), 0);
});

test('every write advances the revision monotonically', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  const r0 = guard.load('run-a').revision;
  guard.bump('run-a', 'fix_rounds');
  const r1 = guard.load('run-a').revision;
  guard.bump('run-a', 'fix_rounds');
  const r2 = guard.load('run-a').revision;
  assert.ok(r1 > r0, `${r1} > ${r0}`);
  assert.ok(r2 > r1, `${r2} > ${r1}`);
});

test('a stale writer is rejected rather than silently clobbering a newer revision', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  const stale = guard.load('run-a');           // reader A holds revision 0
  guard.bump('run-a', 'fix_rounds');           // writer B advances to revision 1

  stale.counters.fix_rounds = 999;
  assert.throws(() => guard.save(stale), RunGuardConflictError);

  // B's write stands; A's stale numbers never landed.
  assert.equal(guard.count('run-a', 'fix_rounds'), 1);
});

test('guard state is NOT stored inside the workflow object — a stale whole-object save cannot roll it back', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
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
  guard.bump('run-a', 'fix_rounds');
  const dir = path.dirname(guard.fileFor('run-a'));
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], `temp files left behind: ${leftovers.join(', ')}`);
});

test('mutate() applies under the current revision and records the result', () => {
  const statePath = tmpState();
  const guard = createRunGuard({ statePath });
  guard.mutate('run-a', (d) => { d.blockingTasks = [{ index: 2, name: 'auth', reason: 'max fix cycles' }]; });
  const doc = guard.load('run-a');
  assert.equal(doc.blockingTasks.length, 1);
  assert.equal(doc.blockingTasks[0].index, 2);
  assert.ok(doc.revision > 0);
});
