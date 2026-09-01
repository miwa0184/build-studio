'use strict';

// A1b.1 identity and guard-lifecycle contract (I1–I9).
//
// The distinction under test everywhere here: a genuinely NEW, never-
// registered run is not the same thing as a REGISTERED run whose guard file
// is missing. The old store conflated them — a missing file always meant "new
// run", and an mtime prune deleted old guard files on every write, so the two
// together could silently renew a finished run's budgets. This file pins the
// replacement lifecycle.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunGuard } = require('./run-guard');
const { createAdmissionRegistry, AdmissionRegistryConflictError } = require('./admission-registry');
const { createAdmission } = require('./admission');
const { attachStateAuthority } = require('./state');

function tmpState(t) {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-a1b1-id-'));
  t.after(() => { try { fs.rmSync(statePath, { recursive: true, force: true }); } catch (_) {} });
  return statePath;
}

let n = 0;
const nonce = () => `id-test-nonce-${process.pid}-${++n}-abcdef`;
const rootIdentity = (runId) => ({ runId, lineageId: runId, predecessorRunId: null, successorOrdinal: 0 });

/** Register a run the way the admission service does: registry entry + guard. */
function registerRun(statePath, runId) {
  const registry = createAdmissionRegistry({ statePath });
  const guard = createRunGuard({ statePath, isRegistered: registry.isRegistered });
  registry.admit({ nonce: nonce(), runId, verdict: { kind: 'GateVerdict', decision: 'ADMITTED', runId }, lineage: rootIdentity(runId) });
  guard.register(runId, { identity: rootIdentity(runId) });
  return { registry, guard };
}

// ─── I1: a run comes into being ONLY through explicit register ───────────────

test('I1 — plain load never creates a guard file; register does, exactly once', (t) => {
  const statePath = tmpState(t);
  const registry = createAdmissionRegistry({ statePath });
  const guard = createRunGuard({ statePath, isRegistered: registry.isRegistered });

  // Loading an unregistered id yields an in-memory empty doc and writes NOTHING.
  const doc = guard.load('never-created');
  assert.equal(doc.revision, 0);
  assert.equal(fs.existsSync(guard.fileFor('never-created')), false, 'load must not create a file');

  // register is the explicit creation, with identity, and it is one-shot.
  assert.equal(typeof guard.register, 'function', 'the guard store must expose an explicit register operation');
  guard.register('run-a', { identity: { runId: 'run-a', lineageId: 'run-a', predecessorRunId: null, successorOrdinal: 0 } });
  assert.equal(fs.existsSync(guard.fileFor('run-a')), true);
  assert.throws(() => guard.register('run-a', {}), (e) => e.code === 'RUN_GUARD_EXISTS');
});

// ─── I2: registered + deleted guard = fail closed, never a fresh empty doc ───

test('I2 — a registered active run with a deleted guard fails closed, not emptyDoc', (t) => {
  const statePath = tmpState(t);
  const { registry, guard } = registerRun(statePath, 'run-x');

  // Spend budget so a silent "new run" would be a visible renewal.
  guard.bump('run-x', 'review_rounds');
  assert.equal(guard.count('run-x', 'review_rounds'), 1);

  fs.unlinkSync(guard.fileFor('run-x'));

  assert.throws(() => guard.load('run-x'), (e) => e.code === 'RUN_GUARD_MISSING',
    'a registered run with no guard file must throw RUN_GUARD_MISSING');
  assert.throws(() => guard.bump('run-x', 'review_rounds'), (e) => e.code === 'RUN_GUARD_MISSING',
    'no budget can be spent — or granted fresh — through a missing guard');
  assert.equal(fs.existsSync(guard.fileFor('run-x')), false, 'the failure must not have recreated the file');

  // An UNREGISTERED id still gets the old meaning: in-memory empty doc.
  assert.equal(guard.load('some-legacy-run').revision, 0);
});

test('I2b — the state authority renders a guard-missing run but refuses to save it', (t) => {
  const statePath = tmpState(t);
  const { guard } = registerRun(statePath, 'wf-gone');

  const wfDoc = { id: 'wf-gone', currentStep: 'reviewing', steps: {} };
  const stub = {
    loadWorkflow: () => ({ ...wfDoc }),
    saveWorkflow: () => { throw new Error('the raw save must never be reached'); },
  };
  attachStateAuthority(stub, { statePath, projectRoot: statePath });

  fs.unlinkSync(guard.fileFor('wf-gone'));

  // Reads stay readable — the hub must be able to SHOW why the run is stuck.
  const loaded = stub.loadWorkflow();
  assert.equal(loaded.guardUnverifiable.code, 'RUN_GUARD_MISSING');
  // Writes fail closed — no transition, no restore, on top of deleted history.
  assert.throws(() => stub.saveWorkflow({ ...wfDoc }), (e) => e.code === 'RUN_GUARD_MISSING');
});

// ─── I3: nothing prunes guard files, ever ────────────────────────────────────

test('I3 — creating far more than 40 runs deletes none of them', (t) => {
  const statePath = tmpState(t);
  const guard = createRunGuard({ statePath });
  const total = 45;
  for (let i = 0; i < total; i++) {
    const doc = guard.load(`run-${String(i).padStart(3, '0')}`);
    guard.save(doc); // every save used to prune the oldest beyond 40
  }
  const files = fs.readdirSync(path.join(statePath, 'run-guard')).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, total,
    `all ${total} guard files must survive — pruning a guard file renews the run it belonged to`);
});

// ─── I4: the registry survives a restart ─────────────────────────────────────

test('I4 — nonce, registration and identity survive a new process (new instances)', (t) => {
  const statePath = tmpState(t);
  const first = createAdmissionRegistry({ statePath });
  const usedNonce = nonce();
  first.admit({ nonce: usedNonce, runId: 'run-r', verdict: { kind: 'GateVerdict', runId: 'run-r' }, lineage: rootIdentity('run-r') });

  // A fresh instance over the same statePath — the restart.
  const second = createAdmissionRegistry({ statePath });
  assert.equal(second.hasNonce(usedNonce), true, 'a consumed nonce must survive restart');
  assert.equal(second.isRegistered('run-r'), true, 'a registration must survive restart');
  assert.equal(second.getRun('run-r').lineage.lineageId, 'run-r');
  assert.throws(() => second.admit({ nonce: usedNonce, runId: 'run-r2', verdict: {}, lineage: {} }),
    (e) => e.code === 'ADMISSION_NONCE_REPLAYED');
});

// ─── I5: a stale writer cannot roll the registry back ────────────────────────

test('I5 — a stale snapshot cannot overwrite a consumed nonce or a registration', (t) => {
  const statePath = tmpState(t);
  const registry = createAdmissionRegistry({ statePath });
  const stale = registry.read(); // revision 0, empty

  const spent = nonce();
  registry.admit({ nonce: spent, runId: 'run-s', verdict: { kind: 'GateVerdict', runId: 'run-s' }, lineage: rootIdentity('run-s') });

  assert.throws(() => registry.save(stale), AdmissionRegistryConflictError,
    'a writer holding an older revision must be refused');
  assert.equal(registry.hasNonce(spent), true, 'the nonce is still consumed');
  assert.equal(registry.isRegistered('run-s'), true, 'the run is still registered');
});

// ─── I9: a failed registration write leaves neither a spent nonce nor a half run ──

test('I9 — when the registry write fails, the nonce is unspent and no run exists', (t) => {
  const statePath = tmpState(t);
  // A real admission service over a real git fixture, so the failure happens
  // exactly where it would in production: after full verification, at the
  // registration write.
  const { execFileSync } = require('child_process');
  const g = (...args) => execFileSync('git', args, { cwd: statePath, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(statePath, 'README.md'), '# fixture\n');
  g('init', '-q'); g('config', 'user.email', 't@e.com'); g('config', 'user.name', 'T');
  g('add', '-A'); g('commit', '-q', '-m', 'init'); g('branch', '-M', 'main');
  g('remote', 'add', 'origin', 'https://github.com/o/r.git');
  const head = g('rev-parse', 'HEAD');

  const bsPath = path.join(statePath, '.build-studio');
  const adm = createAdmission({ projectRoot: statePath, statePath: bsPath });
  const request = {
    version: 1, repo: 'o/r', head, task_packet: 'README.md', claims: [],
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    nonce: nonce(),
  };

  // Make the admission dir unwritable so the registry's atomic write fails —
  // AFTER guard registration, at the commit point.
  const admissionDir = path.join(bsPath, 'admission');
  fs.mkdirSync(admissionDir, { recursive: true });
  fs.chmodSync(admissionDir, 0o500);
  t.after(() => { try { fs.chmodSync(admissionDir, 0o700); } catch (_) {} });

  assert.throws(() => adm.admit({ ...request }), (e) => e.code === 'ADMISSION_REGISTRATION_FAILED');
  fs.chmodSync(admissionDir, 0o700);
  assert.equal(adm.registry.hasNonce(request.nonce), false, 'the failed write must not have consumed the nonce');
  assert.equal(Object.keys(adm.registry.read().runs).length, 0, 'no half-registered run may exist');

  // The same nonce, retried once the store is healthy, is accepted — proof it
  // was never spent. (The orphan guard file from the failed attempt stays on
  // disk, deliberately: it is not a run, and nothing here deletes guard files.)
  const { runId } = adm.admit({ ...request });
  assert.equal(adm.registry.isRegistered(runId), true);
});

// ─── The other failure order: guard creation fails before the commit point ───

test('I9b — when the guard write fails, nothing is consumed and nothing is registered', (t) => {
  const statePath = tmpState(t);
  const { execFileSync } = require('child_process');
  const g = (...args) => execFileSync('git', args, { cwd: statePath, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(statePath, 'README.md'), '# fixture\n');
  g('init', '-q'); g('config', 'user.email', 't@e.com'); g('config', 'user.name', 'T');
  g('add', '-A'); g('commit', '-q', '-m', 'init'); g('branch', '-M', 'main');
  g('remote', 'add', 'origin', 'https://github.com/o/r.git');
  const head = g('rev-parse', 'HEAD');

  const bsPath = path.join(statePath, '.build-studio');
  // Occupy the guard DIRECTORY path with a file so mkdir/rename must fail.
  fs.mkdirSync(bsPath, { recursive: true });
  fs.writeFileSync(path.join(bsPath, 'run-guard'), 'not a directory');

  const adm = createAdmission({ projectRoot: statePath, statePath: bsPath });
  const request = {
    version: 1, repo: 'o/r', head, task_packet: 'README.md', claims: [],
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    nonce: nonce(),
  };
  assert.throws(() => adm.admit({ ...request }), (e) => e.code === 'ADMISSION_REGISTRATION_FAILED');
  assert.equal(adm.registry.hasNonce(request.nonce), false);
  assert.equal(Object.keys(adm.registry.read().runs).length, 0);
});
