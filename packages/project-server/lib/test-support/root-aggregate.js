'use strict';

const crypto = require('crypto');

const { createAdmissionRegistry } = require('../admission-registry');
const { createRunGuard } = require('../run-guard');

/** Register a strict root aggregate for legacy A1a/A1b.1 regression fixtures. */
function registerTestRoot({ statePath, runId, guard: suppliedGuard }) {
  const registry = createAdmissionRegistry({ statePath });
  const guard = suppliedGuard || createRunGuard({
    statePath,
    isRegistered: registry.isRegistered,
    getRegistration: registry.getRun,
  });
  if (registry.isRegistered(runId)) return guard;
  const requestDigest = crypto.createHash('sha256').update(`test-root:${runId}`).digest('hex');
  const lineage = {
    runId,
    lineageId: runId,
    predecessorRunId: null,
    successorOrdinal: 0,
    registeredAt: '2026-09-01T00:00:00.000Z',
    admissionRequestDigest: requestDigest,
    admittedHead: 'b'.repeat(40),
    admittedRepo: 'test-owner/test-repo',
  };
  guard.register(runId, { identity: {
    ...lineage,
    rootRegistry: { runId, requestDigest },
  } });
  registry.admit({
    nonce: `test-root-${runId}-${requestDigest.slice(0, 12)}`,
    runId,
    verdict: {
      kind: 'GateVerdict',
      decision: 'ADMITTED',
      runId,
      requestDigest,
      head: lineage.admittedHead,
      repo: lineage.admittedRepo,
    },
    lineage,
    claims: [],
  });
  return guard;
}

module.exports = { registerTestRoot };
