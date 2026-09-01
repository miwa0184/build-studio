'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunGuard } = require('./run-guard');

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function rootGuard(t) {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-run-lock-'));
  t.after(() => { try { fs.rmSync(statePath, { recursive: true, force: true }); } catch (_) {} });
  const runId = 'lock-root';
  const guard = createRunGuard({ statePath, lockTimeoutMs: 20 });
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
  return { guard, runId };
}

test('only a proved-dead owner is reclaimed and its token cannot displace a new live lock', (t) => {
  const { guard, runId } = rootGuard(t);
  const lock = guard.lockFor(runId);
  fs.mkdirSync(lock, { recursive: true });
  const staleToken = crypto.randomUUID();
  writeJson(path.join(lock, 'owner.json'), {
    protocolVersion: 1,
    token: staleToken,
    pid: 2147483647,
    hostname: os.hostname(),
    runId,
    createdAt: new Date().toISOString(),
  });

  assert.equal(guard.bump(runId, 'stale_reclaim').value, 1);
  const permanentClaim = `${lock}.reclaimed-${staleToken}`;
  assert.equal(fs.existsSync(permanentClaim), true, 'the stale token must remain claimed forever');

  fs.mkdirSync(lock, { recursive: true });
  const liveOwner = {
    protocolVersion: 1,
    token: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    runId,
    createdAt: new Date().toISOString(),
  };
  writeJson(path.join(lock, 'owner.json'), liveOwner);
  assert.throws(() => guard.bump(runId, 'must_not_land'), (error) => error.code === 'RUN_GUARD_BUSY');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')), liveOwner,
    'a delayed stale-token path must not move the new live owner');
  assert.equal(guard.count(runId, 'must_not_land'), 0);
});
