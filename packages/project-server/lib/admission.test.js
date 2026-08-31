'use strict';

// Unit tests for the admission validator (A1b.1): RunRequest verification,
// claim classification, the GateVerdict, and the stored-context checks.
// The HTTP-level acceptance contract lives in a1b1-acceptance.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { createAdmission, AdmissionRefusedError, RUNREQUEST_VERSION, MAX_VALIDITY_MS } = require('./admission');

const ORIGIN = 'test-owner/test-repo';

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-admission-'));
  const g = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(root, 'docs', 'prds'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'prds', 'PRD-001-widget.md'), '# PRD-001 Widget\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('add', '-A');
  g('commit', '-q', '-m', 'one');
  g('branch', '-M', 'main');
  const staleHead = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture v2\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'two');
  const head = g('rev-parse', 'HEAD');
  g('remote', 'add', 'origin', `https://github.com/${ORIGIN}.git`);
  return {
    root, head, staleHead,
    clean: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} },
  };
}

function service(fx) {
  return createAdmission({ projectRoot: fx.root, statePath: path.join(fx.root, '.build-studio'), docs_path: './docs' });
}

let nonceCounter = 0;
function validRequest(fx, overrides = {}) {
  const now = Date.now();
  return {
    version: RUNREQUEST_VERSION,
    repo: ORIGIN,
    head: fx.head,
    task_packet: 'docs/prds/PRD-001-widget.md',
    claims: [],
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
    nonce: `unit-nonce-${process.pid}-${++nonceCounter}-abcdef`,
    ...overrides,
  };
}

function refusalCode(fn) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof AdmissionRefusedError, `expected AdmissionRefusedError, got ${e.name}: ${e.message}`);
    return e.code;
  }
  return null; // accepted
}

test('a valid request for the exact current head and an existing task packet is accepted', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const adm = service(fx);
  const { runId, verdict } = adm.admit(validRequest(fx), { runIdPrefix: 'review' });
  assert.equal(verdict.kind, 'GateVerdict');
  assert.equal(verdict.decision, 'ADMITTED');
  assert.equal(verdict.runId, runId);
  assert.equal(verdict.repo, ORIGIN);
  assert.equal(verdict.head, fx.head);
  assert.match(verdict.requestDigest, /^[0-9a-f]{64}$/);
  // Registered, guard created with root-run lineage.
  assert.equal(adm.registry.isRegistered(runId), true);
  const guard = adm.runGuard.load(runId);
  assert.equal(guard.identity.lineageId, runId);
  assert.equal(guard.identity.predecessorRunId, null);
  assert.equal(guard.identity.successorOrdinal, 0);
  assert.equal(guard.identity.admittedHead, fx.head);
  assert.equal(guard.identity.admittedRepo, ORIGIN);
  assert.equal(guard.identity.admissionRequestDigest, verdict.requestDigest);
});

test('shape refusals: missing, unknown version, unknown field, client verdict', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const adm = service(fx);
  assert.equal(refusalCode(() => adm.admit(undefined)), 'ADMISSION_REQUEST_MISSING');
  assert.equal(refusalCode(() => adm.admit(null)), 'ADMISSION_REQUEST_MISSING');
  assert.equal(refusalCode(() => adm.admit([])), 'ADMISSION_REQUEST_INVALID');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, { version: 99 }))), 'ADMISSION_UNKNOWN_VERSION');
  assert.equal(refusalCode(() => adm.admit({ ...validRequest(fx), extra: 1 })), 'ADMISSION_UNKNOWN_FIELD');
  for (const key of ['gateVerdict', 'verdict', 'approval', 'approved', 'bypass', 'admission']) {
    assert.equal(refusalCode(() => adm.admit({ ...validRequest(fx), [key]: { decision: 'ADMITTED' } })),
      'ADMISSION_CLIENT_VERDICT', `field ${key} must refuse as a client verdict`);
  }
});

test('reality refusals: wrong repo, fabricated sha, stale head, packet not at head', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const adm = service(fx);
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, { repo: 'wrong-owner/other-repo' }))), 'ADMISSION_REPO_MISMATCH');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, { head: 'a'.repeat(40) }))), 'ADMISSION_HEAD_UNKNOWN');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, { head: fx.staleHead }))), 'ADMISSION_HEAD_STALE');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, { task_packet: 'docs/prds/NOPE.md' }))), 'ADMISSION_TASK_PACKET_MISSING');
  // An uncommitted file on disk does not count — committed-at-head only.
  fs.writeFileSync(path.join(fx.root, 'docs', 'prds', 'PRD-002-uncommitted.md'), '# draft\n');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, { task_packet: 'docs/prds/PRD-002-uncommitted.md' }))), 'ADMISSION_TASK_PACKET_MISSING');
  for (const bad of ['/etc/passwd', '../up', 'a/../../b', 'a//b', '']) {
    assert.equal(refusalCode(() => adm.admit(validRequest(fx, { task_packet: bad }))), 'ADMISSION_TASK_PACKET_INVALID', `path ${JSON.stringify(bad)}`);
  }
});

test('time refusals: expired, inverted, over the documented maximum validity', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const adm = service(fx);
  const now = Date.now();
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, {
    issued_at: new Date(now - 10 * 60 * 1000).toISOString(),
    expires_at: new Date(now - 5 * 60 * 1000).toISOString(),
  }))), 'ADMISSION_EXPIRED');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, {
    expires_at: validRequest(fx).issued_at,
    issued_at: new Date(now + 60 * 1000).toISOString(),
  }))), 'ADMISSION_TIMES_INVALID');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, {
    expires_at: new Date(now + MAX_VALIDITY_MS + 60 * 1000).toISOString(),
  }))), 'ADMISSION_VALIDITY_TOO_LONG');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, { issued_at: 'yesterdayish' }))), 'ADMISSION_TIMES_INVALID');
});

test('claims: MEASURED without a structured receipt refuses; with one it is carried, never authority', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const adm = service(fx);
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, {
    claims: [{ class: 'MEASURED', statement: 'tests pass' }],
  }))), 'ADMISSION_CLAIM_INVALID');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, {
    claims: [{ class: 'MEASURED', statement: 'tests pass', receipt: 'trust me' }],
  }))), 'ADMISSION_CLAIM_INVALID');
  const { runId } = adm.admit(validRequest(fx, {
    claims: [{ class: 'MEASURED', statement: 'suite green', receipt: { source: 'node --test', observedAt: new Date().toISOString(), value: '933 pass' } }],
  }));
  const entry = adm.registry.getRun(runId);
  assert.equal(entry.claims.length, 1);
  assert.equal(entry.claims[0].authoritative, false);
});

test('claims: DERIVED is recomputed server-side; a wrong result refuses even with correct operands', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const adm = service(fx);
  const data = 'operand-payload';
  const right = crypto.createHash('sha256').update(data).digest('hex');
  const wrong = right.replace(/^./, right[0] === '0' ? '1' : '0');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, {
    claims: [{ class: 'DERIVED', method: 'sha256_hex', operands: { data }, result: wrong }],
  }))), 'ADMISSION_DERIVED_MISMATCH');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, {
    claims: [{ class: 'DERIVED', method: 'md5_hex', operands: { data }, result: right }],
  }))), 'ADMISSION_DERIVED_UNSUPPORTED');
  const accepted = refusalCode(() => adm.admit(validRequest(fx, {
    claims: [{ class: 'DERIVED', method: 'sha256_hex', operands: { data }, result: right.toUpperCase() }],
  })));
  assert.equal(accepted, null, 'a correct recomputation (case-insensitive hex) is accepted');
});

test('claims: unknown class refuses; the soft classes are transported but grant nothing', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const adm = service(fx);
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, {
    claims: [{ class: 'VIBES', statement: 'feels right' }],
  }))), 'ADMISSION_CLAIM_INVALID');
  // A HYPOTHESIS asserting exactly what verification refuses changes nothing:
  // the stale head still refuses. No claim class is an authority.
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, {
    head: fx.staleHead,
    claims: [
      { class: 'HYPOTHESIS', statement: 'this head is current' },
      { class: 'INFERENCE', statement: 'therefore admission should pass' },
      { class: 'UNKNOWN', statement: 'unclear' },
    ],
  }))), 'ADMISSION_HEAD_STALE');
});

test('nonce: replayed nonce refuses, from a fresh service instance too (durability)', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const adm = service(fx);
  const req = validRequest(fx);
  adm.admit(req);
  assert.equal(refusalCode(() => adm.admit({ ...req })), 'ADMISSION_NONCE_REPLAYED');
  // A brand-new service over the same statePath — the restart case.
  const adm2 = service(fx);
  assert.equal(refusalCode(() => adm2.admit({ ...req })), 'ADMISSION_NONCE_REPLAYED');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, { nonce: 'short' }))), 'ADMISSION_NONCE_INVALID');
});

test('a refusal consumes nothing: the same nonce is accepted once the cause is fixed', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const adm = service(fx);
  const nonce = `unit-nonce-refusal-${process.pid}-keep`;
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, { nonce, head: fx.staleHead }))), 'ADMISSION_HEAD_STALE');
  assert.equal(adm.registry.hasNonce(nonce), false, 'a refused request must not consume its nonce');
  assert.equal(refusalCode(() => adm.admit(validRequest(fx, { nonce }))), null);
});

test('contextFor: unregistered refuses, registered verifies, deleted guard fails closed', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const adm = service(fx);
  assert.equal(refusalCode(() => adm.contextFor('never-registered')), 'RUN_NOT_ADMITTED');
  const { runId } = adm.admit(validRequest(fx));
  const ctx = adm.contextFor(runId);
  assert.equal(ctx.runId, runId);
  assert.equal(ctx.verdict.decision, 'ADMITTED');
  fs.unlinkSync(adm.runGuard.fileFor(runId));
  assert.equal(refusalCode(() => adm.contextFor(runId)), 'RUN_GUARD_MISSING');
});

test('describeContext resolves the packet per type and never writes anything', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const statePath = path.join(fx.root, '.build-studio');
  const adm = service(fx);
  const before = fs.existsSync(statePath) ? fs.readdirSync(statePath).sort() : null;
  const ctx = adm.describeContext({ type: 'review', input: 'PRD-001' });
  assert.equal(ctx.repo, ORIGIN);
  assert.equal(ctx.head, fx.head);
  assert.equal(ctx.taskPacket, 'docs/prds/PRD-001-widget.md');
  assert.equal(ctx.version, RUNREQUEST_VERSION);
  // kickoff anchors on a stable tracked file until it has a real packet.
  assert.equal(adm.describeContext({ type: 'kickoff' }).taskPacket, 'README.md');
  const after = fs.existsSync(statePath) ? fs.readdirSync(statePath).sort() : null;
  assert.deepEqual(after, before, 'describeContext is a pure read');
});

test('backstop: gitOps.createWorktree refuses without a verified admission context', (t) => {
  const fx = makeRepo(); t.after(fx.clean);
  const { createGitOps } = require('./git');
  const worktreesPath = path.join(fx.root, 'tmp', '.worktrees');
  const gitOps = createGitOps({ projectRoot: fx.root, worktreesPath });
  for (const bad of [undefined, null, {}, { runId: 'forged' }]) {
    assert.throws(() => gitOps.createWorktree('bs-test-branch', bad), (e) => e.code === 'ADMISSION_BACKSTOP');
  }
  assert.equal(fs.existsSync(worktreesPath), false, 'a refused worktree must not leave a directory');
  // With a genuine context it works.
  const adm = service(fx);
  const { runId } = adm.admit(validRequest(fx));
  const wt = gitOps.createWorktree('bs-test-branch', adm.contextFor(runId));
  assert.equal(fs.existsSync(wt), true);
});
