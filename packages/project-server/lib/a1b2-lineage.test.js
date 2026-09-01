'use strict';

// A1b.2 lineage contract. These tests exercise the real admission registry and
// run-guard files; no in-memory replacement store is used.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { createAdmission } = require('./admission');
const { createTechnicalStop, REASON_CODES } = require('./technical-stop');
const { resolveLineageBudgets } = require('./lineage-budgets');

let nonceN = 0;

function fixture(t, overrides = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-a1b2-lineage-'));
  t.after(() => { try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {} });
  const git = (...args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# lineage fixture\n');
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  git('branch', '-M', 'main');
  git('remote', 'add', 'origin', 'https://github.com/test-owner/test-repo.git');
  const head = git('rev-parse', 'HEAD');
  const statePath = path.join(projectRoot, '.build-studio');
  const config = {
    projectRoot,
    statePath,
    max_review_rounds: 5,
    max_fix_rounds: 5,
    max_task_fix_cycles: 3,
    max_auto_advance_refusals: 3,
    max_auto_advance_refusals_total: 15,
    max_successor_runs: 2,
    max_lineage_recovery_units: 58,
    max_lineage_no_progress_repeats: 1,
    ...overrides,
  };
  return { projectRoot, statePath, config, head };
}

function request(fx) {
  const now = Date.now();
  return {
    version: 1,
    repo: 'test-owner/test-repo',
    head: fx.head,
    task_packet: 'README.md',
    claims: [],
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
    nonce: `a1b2-${process.pid}-${++nonceN}-0123456789`,
  };
}

function rootRun(fx) {
  const admission = createAdmission(fx.config);
  assert.equal(typeof admission.createSuccessor, 'function',
    'A1b.2 needs a server-owned successor transaction, not a client-minted root admission');
  const { runId } = admission.admit(request(fx), { runIdPrefix: 'root' });
  return { admission, runId };
}

function stopRun(admission, runId, input = {}) {
  const stop = createTechnicalStop({
    reasonCode: REASON_CODES.BLOCKED_TASKS,
    runId,
    step: 'task_execution',
    tasks: [{ index: 0, name: 'repair target', reason: 'reproducible failure' }],
    evidence: ['exit=1', 'test=successor-canary'],
    ...input,
  });
  admission.runGuard.mutate(runId, (doc) => { doc.technicalStop = stop; });
  return stop;
}

function lineage(admission, lineageId) {
  const doc = admission.registry.read();
  return doc.lineages && doc.lineages[lineageId];
}

function successorFromFreshProcess(config, runId) {
  const script = `
    const { createAdmission } = require(process.argv[1]);
    try {
      const out = createAdmission(JSON.parse(process.argv[2])).createSuccessor(process.argv[3]);
      process.stdout.write(JSON.stringify({ ok: true, runId: out.runId, replayed: out.replayed }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e', script, require.resolve('./admission'), JSON.stringify(config), String(runId),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`successor child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (_) { reject(new Error(`invalid successor child output: ${stdout}\n${stderr}`)); }
    });
  });
}

test('L0 — defaults derive from the shipped measurable caps and invalid config is rejected', () => {
  assert.deepEqual(resolveLineageBudgets({}), {
    maxSuccessors: 2,
    maxRecoveryUnits: 58,
    maxNoProgressRepeats: 1,
  });
  assert.throws(() => resolveLineageBudgets({ max_successor_runs: -1 }), /integer/);
  assert.throws(() => resolveLineageBudgets({ max_lineage_recovery_units: 1.5 }), /integer/);
  assert.throws(() => resolveLineageBudgets({ max_lineage_no_progress_repeats: 99 }), /integer/);
});

test('L1 — successor identity is new, ordered and bound to one terminal predecessor', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  const stop = stopRun(admission, runId);

  const out = admission.createSuccessor(runId);
  assert.notEqual(out.runId, runId);
  assert.equal(out.replayed, false);
  assert.equal(out.lineage.lineageId, runId);
  assert.equal(out.lineage.predecessorRunId, runId);
  assert.equal(out.lineage.successorOrdinal, 1);

  const rootEntry = admission.registry.getRun(runId);
  assert.equal(rootEntry.successorRunId, out.runId, 'the predecessor can point at exactly one successor');
  assert.equal(rootEntry.terminalStop.reasonCode, stop.reasonCode, 'terminal evidence is retained in the identity store');
  assert.equal(admission.runGuard.load(runId).technicalStop.reasonCode, stop.reasonCode,
    'creating a successor never reopens or rewrites the predecessor guard');
  assert.equal(admission.runGuard.load(out.runId).identity.predecessorRunId, runId);
});

test('L2 — replay and two cross-process requests converge on exactly one successor and one charge', async (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);

  const [a, b] = await Promise.all([
    successorFromFreshProcess(fx.config, runId),
    successorFromFreshProcess(fx.config, runId),
  ]);
  const successes = [a, b].filter((out) => out.ok);
  const refusals = [a, b].filter((out) => !out.ok);
  assert.ok(successes.length >= 1, `one cross-process writer must commit: ${JSON.stringify([a, b])}`);
  assert.ok(refusals.every((out) => out.code === 'ADMISSION_REGISTRY_BUSY'),
    `a writer colliding inside the lock may only fail closed as busy: ${JSON.stringify(refusals)}`);

  const replay = admission.createSuccessor(runId);
  assert.ok(successes.every((out) => out.runId === replay.runId));
  assert.equal(replay.replayed, true);

  const l = lineage(admission, runId);
  assert.equal(l.spent.successors, 1);
  assert.equal(l.events.filter((e) => e.type === 'SUCCESSOR_CREATED').length, 1);
  assert.deepEqual(l.runs, [runId, replay.runId]);
});

test('L2b — active cross-process lock contention is a typed, side-effect-free refusal', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);
  const lock = path.join(fx.statePath, 'admission', 'registry.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }));
  const before = fs.readFileSync(admission.registry.file, 'utf8');
  assert.throws(() => admission.createSuccessor(runId), (error) => error.code === 'ADMISSION_REGISTRY_BUSY'
    && error.detail && error.detail.retryable === true);
  assert.equal(fs.readFileSync(admission.registry.file, 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(fx.statePath, 'run-guard')).length, 1);
  fs.rmSync(lock, { recursive: true, force: true });
});

test('L3 — restart preserves the winner, spend and immutable limits', (t) => {
  const fx = fixture(t, { max_successor_runs: 1, max_lineage_recovery_units: 9 });
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);
  const first = admission.createSuccessor(runId);

  const afterRestart = createAdmission({
    ...fx.config,
    // Raising config later must not raise an existing lineage's captured cap.
    max_successor_runs: 9,
    max_lineage_recovery_units: 999,
  });
  const replay = afterRestart.createSuccessor(runId);
  assert.equal(replay.runId, first.runId);
  assert.equal(replay.replayed, true);
  const l = lineage(afterRestart, runId);
  assert.equal(l.limits.maxSuccessors, 1);
  assert.equal(l.limits.maxRecoveryUnits, 9);
  assert.equal(l.spent.successors, 1);
});

test('L4 — measured per-run spend is charged cumulatively; a new guard does not reset the lineage', (t) => {
  const fx = fixture(t, { max_successor_runs: 3, max_lineage_recovery_units: 5 });
  const { admission, runId } = rootRun(fx);
  admission.runGuard.bump(runId, 'review_rounds');
  admission.runGuard.bump(runId, 'auto_advance_refusals');
  stopRun(admission, runId);
  const first = admission.createSuccessor(runId);

  assert.equal(admission.runGuard.count(first.runId, 'review_rounds'), 0,
    'the successor has its own per-run guard');
  assert.equal(lineage(admission, runId).spent.recoveryUnits, 3,
    'one terminal event + two measurable spent units are charged to the lineage');

  admission.runGuard.bump(first.runId, 'fix_rounds');
  admission.runGuard.bump(first.runId, 'task_fix_cycles:0');
  stopRun(admission, first.runId, { evidence: ['different failure'] });
  assert.throws(() => admission.createSuccessor(first.runId), (e) => e.code === 'LINEAGE_RECOVERY_BUDGET_EXHAUSTED');
  assert.equal(lineage(admission, runId).spent.recoveryUnits, 3, 'a refused creation spends nothing');
  assert.equal(admission.registry.getRun(first.runId).successorRunId, undefined);
});

test('L5 — a hold is not spend', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  admission.runGuard.mutate(runId, (doc) => {
    doc.acceptanceGaps = [{ index: 0, name: 'waiting for evidence' }];
  });
  stopRun(admission, runId, { evidence: [] });
  admission.createSuccessor(runId);
  assert.equal(lineage(admission, runId).spent.recoveryUnits, 1,
    'standing acceptance gaps and observation time are not recovery events');
});

test('L6 — product/founder/acceptance-shaped outcomes cannot be auto-converted into recovery', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  const fake = {
    outcome: 'TECHNICAL_STOP',
    schemaVersion: 1,
    reasonCode: REASON_CODES.BLOCKED_TASKS,
    principal: 'founder',
    runId,
    step: 'owner_consultations',
    approved: false,
    founderRejection: true,
    autoAdvanceable: false,
    mergeEligible: false,
    acceptanceEligible: false,
    recovery: { mode: 'successor_repair', eligible: true },
    tasks: [], evidence: ['owner decision'],
  };
  admission.runGuard.mutate(runId, (doc) => { doc.technicalStop = fake; });
  const before = admission.registry.read();
  assert.throws(() => admission.createSuccessor(runId), (e) => e.code === 'SUCCESSOR_NOT_ELIGIBLE');
  const after = admission.registry.read();
  assert.equal(after.revision, before.revision);
  assert.equal(fs.readdirSync(path.join(fx.statePath, 'run-guard')).length, 1, 'no successor guard side effect');
});

test('L7 — missing or corrupt authority fails closed before successor side effects', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);
  const guardFile = admission.runGuard.fileFor(runId);
  const original = fs.readFileSync(guardFile, 'utf8');

  fs.unlinkSync(guardFile);
  assert.throws(() => admission.createSuccessor(runId), (e) => e.code === 'RUN_GUARD_MISSING');
  assert.equal(Object.keys(admission.registry.read().runs).length, 1);

  fs.writeFileSync(guardFile, '{broken');
  assert.throws(() => admission.createSuccessor(runId), (e) => e.code === 'ADMISSION_VALIDATOR_FAILURE');
  assert.equal(Object.keys(admission.registry.read().runs).length, 1);

  fs.writeFileSync(guardFile, original);
  const registryFile = admission.registry.file;
  fs.writeFileSync(registryFile, '{broken');
  assert.throws(() => admission.createSuccessor(runId), (e) => e.code === 'ADMISSION_VALIDATOR_FAILURE');
  assert.equal(fs.readdirSync(path.join(fx.statePath, 'run-guard')).length, 1);
});

test('L7b — structurally corrupt schema-2 lineage authority fails closed instead of renewing a zero cap', (t) => {
  const fx = fixture(t, { max_successor_runs: 0, max_lineage_recovery_units: 1 });
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);

  const registryFile = admission.registry.file;
  const corrupt = admission.registry.read();
  delete corrupt.lineages[runId].limits;
  fs.writeFileSync(registryFile, JSON.stringify(corrupt, null, 2));
  const guardFilesBefore = fs.readdirSync(path.join(fx.statePath, 'run-guard')).sort();

  assert.throws(() => admission.registry.read(), (error) => error.code === 'ADMISSION_REGISTRY_UNREADABLE'
    && error.detail && error.detail.path === `lineages.${runId}.limits`);
  assert.throws(() => admission.createSuccessor(runId), (error) => error.code === 'ADMISSION_VALIDATOR_FAILURE'
    && /limits/.test(error.message));
  assert.deepEqual(fs.readdirSync(path.join(fx.statePath, 'run-guard')).sort(), guardFilesBefore,
    'corrupt lineage authority cannot materialise a successor guard');
});

test('L7c — an unknown future registry schema fails closed with typed evidence', (t) => {
  const fx = fixture(t);
  const { admission } = rootRun(fx);
  const future = admission.registry.read();
  future.schemaVersion = 3;
  fs.writeFileSync(admission.registry.file, JSON.stringify(future, null, 2));

  assert.throws(() => admission.registry.read(), (error) => error.code === 'ADMISSION_REGISTRY_UNREADABLE'
    && error.detail && error.detail.path === 'schemaVersion'
    && error.detail.actual === 3);
});

test('P1-A — deleting a consumed nonce from schema 2 cannot reconstruct or replay its request authority', (t) => {
  const fx = fixture(t);
  const admission = createAdmission(fx.config);
  const runRequest = request(fx);
  const root = admission.admit(runRequest, { runIdPrefix: 'nonce-root' });
  const registry = admission.registry.read();
  delete registry.nonces[runRequest.nonce];
  fs.writeFileSync(admission.registry.file, JSON.stringify(registry, null, 2));

  assert.throws(() => admission.registry.read(), (error) => error.code === 'ADMISSION_REGISTRY_UNREADABLE'
    && error.detail && /requestIdentity|nonces/.test(error.detail.path));
  assert.throws(() => admission.admit(runRequest, { runIdPrefix: 'replay' }),
    (error) => error.code === 'ADMISSION_VALIDATOR_FAILURE');
  assert.equal(fs.readdirSync(path.join(fx.statePath, 'run-guard')).length, 1,
    `the replay must not materialise a second guard beside ${root.runId}`);
});

for (const { name, mutate, expectedPath } of [
  {
    name: 'missing nonce digest',
    mutate: (doc, runId, nonce) => { delete doc.nonces[nonce].requestDigest; },
    expectedPath: /nonces\..+\.requestDigest$/,
  },
  {
    name: 'mistyped nonce digest',
    mutate: (doc, runId, nonce) => { doc.nonces[nonce].requestDigest = 7; },
    expectedPath: /nonces\..+\.requestDigest$/,
  },
  {
    name: 'missing root request identity',
    mutate: (doc, runId) => { delete doc.runs[runId].requestIdentity; },
    expectedPath: /runs\..+\.requestIdentity$/,
  },
  {
    name: 'inconsistent root request digest',
    mutate: (doc, runId) => { doc.runs[runId].requestIdentity.requestDigest = 'f'.repeat(64); },
    expectedPath: /runs\..+\.requestIdentity\.requestDigest$/,
  },
]) {
  test(`P1-A — schema-2 ${name} is corrupt authority`, (t) => {
    const fx = fixture(t);
    const admission = createAdmission(fx.config);
    const runRequest = request(fx);
    const { runId } = admission.admit(runRequest, { runIdPrefix: 'nonce-shape' });
    const registry = admission.registry.read();
    mutate(registry, runId, runRequest.nonce);
    fs.writeFileSync(admission.registry.file, JSON.stringify(registry, null, 2));
    assert.throws(() => admission.registry.read(), (error) => error.code === 'ADMISSION_REGISTRY_UNREADABLE'
      && error.detail && expectedPath.test(error.detail.path));
  });
}

test('P1-A — canonical request-derived verdict and guard identity cannot drift independently', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);
  const registry = admission.registry.read();
  registry.runs[runId].verdict.head = 'f'.repeat(40);
  fs.writeFileSync(admission.registry.file, JSON.stringify(registry, null, 2));
  assert.throws(() => admission.registry.read(), (error) => error.code === 'ADMISSION_REGISTRY_UNREADABLE'
    && error.detail && error.detail.path === `runs.${runId}.requestIdentity`);

  // Restore registry authority, then prove the independent run-guard mirror is
  // compared field-for-field rather than accepted on lineage id alone.
  registry.runs[runId].verdict.head = registry.runs[runId].requestIdentity.request.head;
  fs.writeFileSync(admission.registry.file, JSON.stringify(registry, null, 2));
  const guardFile = admission.runGuard.fileFor(runId);
  const guard = JSON.parse(fs.readFileSync(guardFile, 'utf8'));
  guard.identity.admissionRequestDigest = 'f'.repeat(64);
  fs.writeFileSync(guardFile, JSON.stringify(guard, null, 2));
  assert.throws(() => admission.createSuccessor(runId),
    (error) => error.code === 'LINEAGE_IDENTITY_MISMATCH');
});

test('P1-A — a consumed nonce cannot be attached to a successor identity', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);
  const successor = admission.createSuccessor(runId);
  const registry = admission.registry.read();
  registry.nonces['forged-successor-nonce'] = {
    consumedAt: new Date().toISOString(),
    runId: successor.runId,
    requestDigest: registry.runs[runId].requestIdentity.requestDigest,
  };
  fs.writeFileSync(admission.registry.file, JSON.stringify(registry, null, 2));
  assert.throws(() => admission.registry.read(), (error) => error.code === 'ADMISSION_REGISTRY_UNREADABLE'
    && error.detail && /nonces\.forged-successor-nonce\.runId$/.test(error.detail.path));
});

test('L7d — the explicit v1→v2 upgrade captures every legacy root with complete immutable authority', (t) => {
  const fx = fixture(t, {
    max_successor_runs: 1,
    max_lineage_recovery_units: 9,
    max_lineage_no_progress_repeats: 0,
  });
  const { admission, runId } = rootRun(fx);
  const second = admission.admit(request(fx), { runIdPrefix: 'other-root' }).runId;
  stopRun(admission, runId);

  const legacy = admission.registry.read();
  legacy.schemaVersion = 1;
  delete legacy.lineages;
  fs.writeFileSync(admission.registry.file, JSON.stringify(legacy, null, 2));

  const created = admission.createSuccessor(runId);
  assert.equal(created.replayed, false);
  const upgraded = admission.registry.read();
  assert.equal(upgraded.schemaVersion, 2);
  for (const rootId of [runId, second]) {
    assert.deepEqual(upgraded.lineages[rootId].limits, {
      maxSuccessors: 1,
      maxRecoveryUnits: 9,
      maxNoProgressRepeats: 0,
    });
    assert.deepEqual(upgraded.lineages[rootId].runs.slice(0, 1), [rootId]);
    assert.equal(upgraded.runs[rootId].requestIdentity.kind, 'LEGACY_V1_CAPTURE');
    assert.match(upgraded.runs[rootId].requestIdentity.requestDigest, /^[0-9a-f]{64}$/);
  }
  const consumedNonce = Object.entries(upgraded.nonces)
    .find(([, entry]) => entry.runId === runId)[0];
  const replay = request(fx);
  replay.nonce = consumedNonce;
  assert.throws(() => admission.admit(replay), (error) => error.code === 'ADMISSION_NONCE_REPLAYED',
    'legacy capture must preserve consumed authority rather than mint a fresh nonce');
});

test('P1-B — lineage event fingerprint replacement is rejected against its canonical cause', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);
  admission.createSuccessor(runId);
  const registry = admission.registry.read();
  const event = registry.lineages[runId].events[1];
  event.causeFingerprint = event.causeFingerprint === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
  fs.writeFileSync(admission.registry.file, JSON.stringify(registry, null, 2));
  assert.throws(() => admission.registry.read(), (error) => error.code === 'ADMISSION_REGISTRY_UNREADABLE'
    && error.detail && /events\.1\.causeFingerprint$/.test(error.detail.path));
});

test('P1-B — replay revalidates the live guard cause against committed predecessor authority', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);
  const successor = admission.createSuccessor(runId);
  const before = admission.registry.read();
  const guardFile = admission.runGuard.fileFor(runId);
  const guard = JSON.parse(fs.readFileSync(guardFile, 'utf8'));
  guard.technicalStop = createTechnicalStop({
    reasonCode: REASON_CODES.BLOCKED_TASKS,
    runId,
    step: 'task_execution',
    tasks: [{ index: 0, name: 'different target', reason: 'different canonical failure' }],
    evidence: ['exit=2', 'test=changed-after-successor'],
  });
  fs.writeFileSync(guardFile, JSON.stringify(guard, null, 2));

  assert.throws(() => admission.createSuccessor(runId),
    (error) => error.code === 'TECHNICAL_STOP_CAUSE_UNVERIFIABLE');
  const after = admission.registry.read();
  assert.equal(after.revision, before.revision, 'refused replay cannot mutate committed authority');
  assert.equal(after.runs[runId].successorRunId, successor.runId);
});

test('P1-B — visible stop fields cannot diverge from their canonical cause receipt', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);
  const guardFile = admission.runGuard.fileFor(runId);
  const guard = JSON.parse(fs.readFileSync(guardFile, 'utf8'));
  guard.technicalStop.evidence = ['mutated-visible-evidence'];
  fs.writeFileSync(guardFile, JSON.stringify(guard, null, 2));
  assert.throws(() => admission.createSuccessor(runId),
    (error) => error.code === 'TECHNICAL_STOP_CAUSE_UNVERIFIABLE');
});

for (const { name, corrupt: corruptAuthority, expectedPath } of [
  {
    name: 'run identity',
    corrupt: (doc, rootId) => { doc.runs[rootId].lineage.lineageId = 'foreign-lineage'; },
    expectedPath: /^runs\..+\.lineage$/,
  },
  {
    name: 'limit type',
    corrupt: (doc, rootId) => { doc.lineages[rootId].limits.maxSuccessors = '2'; },
    expectedPath: /^lineages\..+\.limits\.maxSuccessors$/,
  },
  {
    name: 'spent invariant',
    corrupt: (doc, rootId) => { doc.lineages[rootId].spent.recoveryUnits += 1; },
    expectedPath: /^lineages\..+\.spent\.recoveryUnits$/,
  },
  {
    name: 'ordered runs',
    corrupt: (doc, rootId, successorId) => { doc.lineages[rootId].runs.push(successorId); },
    expectedPath: /^lineages\..+\.runs$/,
  },
  {
    name: 'successor event',
    corrupt: (doc, rootId) => { doc.lineages[rootId].events[1].successorRunId = rootId; },
    expectedPath: /^lineages\..+\.events\.1$/,
  },
  {
    name: 'event charge',
    corrupt: (doc, rootId) => { doc.lineages[rootId].events[1].charge.counters.review_rounds = '1'; },
    expectedPath: /^lineages\..+\.events\.1\.charge\.counters\.review_rounds$/,
  },
]) {
  test(`L7e — schema-2 ${name} corruption is typed and fail-closed`, (t) => {
    const fx = fixture(t);
    const { admission, runId } = rootRun(fx);
    stopRun(admission, runId);
    const successor = admission.createSuccessor(runId);
    const doc = admission.registry.read();
    corruptAuthority(doc, runId, successor.runId);
    fs.writeFileSync(admission.registry.file, JSON.stringify(doc, null, 2));

    assert.throws(() => admission.registry.read(), (error) => error.code === 'ADMISSION_REGISTRY_UNREADABLE'
      && error.detail && expectedPath.test(error.detail.path));
  });
}

test('L8 — successor count refuses before a guard, workflow or agent can exist', (t) => {
  const fx = fixture(t, { max_successor_runs: 1, max_lineage_recovery_units: 99 });
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);
  const first = admission.createSuccessor(runId);
  stopRun(admission, first.runId, { evidence: ['new cause'] });
  const beforeFiles = fs.readdirSync(path.join(fx.statePath, 'run-guard')).sort();
  assert.throws(() => admission.createSuccessor(first.runId), (e) => e.code === 'LINEAGE_SUCCESSOR_BUDGET_EXHAUSTED');
  assert.deepEqual(fs.readdirSync(path.join(fx.statePath, 'run-guard')).sort(), beforeFiles);
  assert.equal(admission.registry.getRun(first.runId).successorRunId, undefined);
});

test('L9 — a reproducible repeated-cause fingerprint reaches an exact no-progress cap', (t) => {
  const fx = fixture(t, {
    max_successor_runs: 4,
    max_lineage_recovery_units: 99,
    max_lineage_no_progress_repeats: 1,
  });
  const { admission, runId } = rootRun(fx);
  const firstStop = stopRun(admission, runId);
  assert.match(firstStop.fingerprint, /^[0-9a-f]{64}$/);
  const first = admission.createSuccessor(runId);

  const repeated1 = stopRun(admission, first.runId, {
    reasonCode: REASON_CODES.SUCCESSOR_REPAIR_FAILED,
    causeSource: firstStop.cause,
  });
  assert.equal(repeated1.fingerprint, firstStop.fingerprint);
  const second = admission.createSuccessor(first.runId);
  assert.equal(lineage(admission, runId).spent.noProgressRepeats, 1);

  stopRun(admission, second.runId, {
    reasonCode: REASON_CODES.SUCCESSOR_REPAIR_FAILED,
    causeSource: firstStop.cause,
  });
  const before = admission.registry.read().revision;
  assert.throws(() => admission.createSuccessor(second.runId), (e) => e.code === 'LINEAGE_NO_PROGRESS_BUDGET_EXHAUSTED');
  assert.equal(admission.registry.read().revision, before, 'the over-cap replay is side-effect free');
  assert.equal(lineage(admission, runId).spent.successors, 2, 'the exact cap, not an off-by-one third successor');
});

test('P1-B — canonical predecessor cause is recomputed across ordering and restart', (t) => {
  const fx = fixture(t, {
    max_successor_runs: 4,
    max_lineage_recovery_units: 99,
    max_lineage_no_progress_repeats: 1,
  });
  const { admission, runId } = rootRun(fx);
  const firstStop = stopRun(admission, runId);
  const first = admission.createSuccessor(runId);
  const reorderedCause = {
    evidence: [...firstStop.cause.evidence],
    tasks: firstStop.cause.tasks.map((task) => ({ reason: task.reason, name: task.name, index: task.index })),
    step: firstStop.cause.step,
    reasonCode: firstStop.cause.reasonCode,
  };
  const repeated = createTechnicalStop({
    reasonCode: REASON_CODES.SUCCESSOR_REPAIR_FAILED,
    runId: first.runId,
    step: 'successor_repair',
    evidence: ['repair report says the cause remains'],
    causeSource: reorderedCause,
  });
  assert.equal(repeated.fingerprint, firstStop.fingerprint,
    'recursive field ordering cannot change canonical cause identity');
  admission.runGuard.mutate(first.runId, (doc) => { doc.technicalStop = repeated; });

  const restarted = createAdmission(fx.config);
  restarted.createSuccessor(first.runId);
  assert.equal(lineage(restarted, runId).spent.noProgressRepeats, 1);
});

test('P1-B — replaced fingerprint and missing inherited cause source both fail closed', (t) => {
  const fx = fixture(t, { max_successor_runs: 4, max_lineage_recovery_units: 99 });
  const { admission, runId } = rootRun(fx);
  const firstStop = stopRun(admission, runId);
  const first = admission.createSuccessor(runId);

  const forged = createTechnicalStop({
    reasonCode: REASON_CODES.SUCCESSOR_REPAIR_FAILED,
    runId: first.runId,
    step: 'successor_repair',
    evidence: ['repair report says the cause remains'],
    causeSource: firstStop.cause,
  });
  forged.fingerprint = forged.fingerprint === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
  admission.runGuard.mutate(first.runId, (doc) => { doc.technicalStop = forged; });
  assert.throws(() => admission.createSuccessor(first.runId),
    (error) => error.code === 'TECHNICAL_STOP_CAUSE_UNVERIFIABLE');

  const restored = createTechnicalStop({
    reasonCode: REASON_CODES.SUCCESSOR_REPAIR_FAILED,
    runId: first.runId,
    step: 'successor_repair',
    evidence: ['repair report says the cause remains'],
    causeSource: firstStop.cause,
  });
  delete restored.cause;
  const guardFile = admission.runGuard.fileFor(first.runId);
  const guardDoc = JSON.parse(fs.readFileSync(guardFile, 'utf8'));
  guardDoc.technicalStop = restored;
  fs.writeFileSync(guardFile, JSON.stringify(guardDoc, null, 2));
  assert.throws(() => admission.createSuccessor(first.runId),
    (error) => error.code === 'TECHNICAL_STOP_CAUSE_UNVERIFIABLE');
});

test('L10 — lineage and spend are outside workflow snapshots and cannot be restored backwards', (t) => {
  const fx = fixture(t);
  const { admission, runId } = rootRun(fx);
  stopRun(admission, runId);
  const first = admission.createSuccessor(runId);
  const before = JSON.parse(JSON.stringify(lineage(admission, runId)));

  // A workflow snapshot is deliberately allowed to contain stale, invented
  // copies of adjacent data. It is not an admission-registry writer.
  const snapshot = {
    id: first.runId,
    currentStep: 'reviewing',
    steps: { reviewing: { status: 'pending', agents: [] } },
    lineage: { spent: { successors: 0, recoveryUnits: 0 }, limits: { maxSuccessors: 999 } },
  };
  fs.mkdirSync(path.join(fx.statePath, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(fx.statePath, 'snapshots', 'stale.json'), JSON.stringify(snapshot));

  const after = lineage(admission, runId);
  assert.deepEqual(after, before);
});
