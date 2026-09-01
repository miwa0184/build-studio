'use strict';

/**
 * The admission registry — the durable record of which runs exist and which
 * nonces have been spent.
 *
 * Two facts live here, in ONE file, because they must move together:
 *
 * 1. **Run registration.** A run exists when — and only when — this registry
 *    holds an entry for its id. The run-guard file alone is not a run: guard
 *    creation and registration are two writes, and whichever one fails must
 *    leave an unambiguous state. Registration is the commit point.
 *
 * 2. **Nonce consumption.** A RunRequest's nonce is spent in the same atomic
 *    write that registers the run. A failed registration write therefore
 *    leaves the nonce unspent and no run behind — there is no window where a
 *    valid request has paid its nonce for nothing, and no window where a run
 *    exists that no nonce paid for.
 *
 * Durability follows run-guard.js: unique temp file + rename(2), a monotonic
 * revision, and a lost-update check on every save, so a stale writer cannot
 * roll back a consumed nonce or an existing registration. The file survives
 * restarts; replay protection is only protection if it does.
 *
 * There is deliberately no delete, no prune, and no retention policy in this
 * store. A1b.2 adds the lineage ledger to this same atomic file; forgetting a
 * spent nonce, predecessor child claim or lineage charge would require a
 * separately authoritative archive, which does not exist yet.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DEFAULT_MAX_SUCCESSORS, DEFAULT_MAX_NO_PROGRESS_REPEATS } = require('./lineage-budgets');

const SCHEMA_VERSION = 2;
const ADMISSION_DIR = 'admission';
const REGISTRY_FILE = 'registry.json';

class AdmissionRegistryConflictError extends Error {
  constructor(message, { expected, actual } = {}) {
    super(message);
    this.name = 'AdmissionRegistryConflictError';
    this.code = 'ADMISSION_REGISTRY_CONFLICT';
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

class AdmissionRegistryBusyError extends Error {
  constructor(message, { lock } = {}) {
    super(message);
    this.name = 'AdmissionRegistryBusyError';
    this.code = 'ADMISSION_REGISTRY_BUSY';
    this.lock = lock;
  }
}

class LineageRegistryRefusalError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'LineageRegistryRefusalError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * An existing registry file that cannot be trusted. Same failure model as the
 * run guard: absence is an empty registry (nothing was ever admitted), but an
 * unreadable file is NOT — treating it as empty would forget every consumed
 * nonce and every registered run at once, which is precisely the power this
 * store exists to withhold. Fails closed; the file stays as evidence.
 */
class AdmissionRegistryCorruptError extends Error {
  constructor(message, { file, cause } = {}) {
    super(message);
    this.name = 'AdmissionRegistryCorruptError';
    this.code = 'ADMISSION_REGISTRY_UNREADABLE';
    this.file = file;
    if (cause) this.cause = cause;
  }
}

class NonceReplayError extends Error {
  constructor(nonce) {
    super(`nonce has already been consumed: ${String(nonce).slice(0, 64)}`);
    this.name = 'NonceReplayError';
    this.code = 'ADMISSION_NONCE_REPLAYED';
  }
}

function emptyRegistry() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    /** nonce -> { consumedAt, runId } */
    nonces: {},
    /** runId -> { registeredAt, verdict, lineage, claims } */
    runs: {},
    /** lineageId -> immutable limits, monotonic spend and ordered events */
    lineages: {},
    updatedAt: new Date().toISOString(),
  };
}

function createAdmissionRegistry({ statePath }) {
  if (!statePath) throw new Error('createAdmissionRegistry: statePath is required');
  const dir = path.join(statePath, ADMISSION_DIR);
  const file = path.join(dir, REGISTRY_FILE);

  function read() {
    if (!fs.existsSync(file)) return emptyRegistry();
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new AdmissionRegistryCorruptError(
        `admission registry exists but cannot be read: ${e.message}`, { file, cause: e },
      );
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)
      || !Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1
      || !Number.isInteger(doc.revision) || doc.revision < 0
      || !doc.nonces || typeof doc.nonces !== 'object'
      || !doc.runs || typeof doc.runs !== 'object'
      || (doc.lineages !== undefined && (!doc.lineages || typeof doc.lineages !== 'object'))) {
      throw new AdmissionRegistryCorruptError('admission registry has an unrecognisable schema', { file });
    }
    return { ...emptyRegistry(), ...doc, lineages: doc.lineages || {} };
  }

  const lock = path.join(dir, 'registry.lock');

  /**
   * Cross-process exclusion around the revision check + rename.
   *
   * The revision check alone has a TOCTOU window when two project-server
   * processes share a state directory. mkdir is the compare-and-set: one wins,
   * the other refuses typed. A lock left by a crashed local process may be
   * reclaimed only after 30 seconds and only when its pid is provably gone.
   */
  function acquireLock() {
    fs.mkdirSync(dir, { recursive: true });
    const claim = () => {
      let created = false;
      try {
        fs.mkdirSync(lock);
        created = true;
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      } catch (error) {
        // A failed owner receipt must not leave a lock owned by a live process
        // that can never become stale. Only remove the directory this call
        // itself created; an EEXIST belongs to another writer.
        if (created) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) {} }
        throw error;
      }
    };
    try {
      claim();
      return;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }

    let stale = false;
    try {
      const stat = fs.statSync(lock);
      const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      let alive = true;
      try { process.kill(Number(owner.pid), 0); } catch (e) { if (e && e.code === 'ESRCH') alive = false; }
      stale = Date.now() - stat.mtimeMs > 30000 && !alive;
    } catch (_) {
      // A half-created fresh lock is contention, not proof of staleness.
      stale = false;
    }
    if (!stale) {
      throw new AdmissionRegistryBusyError('admission registry is locked by another writer; retry from fresh state', { lock });
    }
    const retired = `${lock}.stale-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    try { fs.renameSync(lock, retired); } catch (_) {
      throw new AdmissionRegistryBusyError('admission registry lock changed while stale ownership was checked', { lock });
    }
    try {
      claim();
    } catch (e) {
      throw new AdmissionRegistryBusyError(`admission registry lock could not be acquired after retiring a stale owner: ${e.message}`, { lock });
    } finally {
      try { fs.rmSync(retired, { recursive: true, force: true }); } catch (_) {}
    }
  }

  function releaseLock() {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) {}
  }

  /** Lost-update-checked atomic write, exactly the run-guard discipline. */
  function save(doc) {
    acquireLock();
    try {
      const onDisk = read();
      if (onDisk.revision !== doc.revision) {
        throw new AdmissionRegistryConflictError(
          `admission registry moved on: held revision ${doc.revision}, disk is at ${onDisk.revision}`,
          { expected: doc.revision, actual: onDisk.revision },
        );
      }
      const next = {
        ...doc,
        schemaVersion: SCHEMA_VERSION,
        revision: doc.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, file);
      return next;
    } finally {
      releaseLock();
    }
  }

  /** Read-modify-write under the current revision; one retry for a concurrent writer. */
  function mutate(fn) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const doc = read();
      const result = fn(doc);
      if (result && result.noWrite === true) return { doc, result: result.value, unchanged: true };
      try {
        return { doc: save(doc), result };
      } catch (e) {
        if (!(e instanceof AdmissionRegistryConflictError) || attempt === 1) throw e;
      }
    }
    /* istanbul ignore next — the loop above always returns or throws */
    throw new AdmissionRegistryConflictError('admission registry could not be written');
  }

  /**
   * The one transaction: consume the nonce AND register the run, atomically.
   *
   * Both checks re-run inside the mutate, so a concurrent writer racing this
   * one cannot double-spend a nonce or double-register a run id — the retry
   * re-reads the file the winner wrote.
   */
  function admit({ nonce, runId, verdict, lineage, claims, lineageBudget }) {
    if (!nonce || typeof nonce !== 'string') throw new Error('admit: nonce is required');
    if (!runId || typeof runId !== 'string') throw new Error('admit: runId is required');
    const { doc } = mutate((reg) => {
      if (reg.nonces[nonce]) throw new NonceReplayError(nonce);
      if (reg.runs[runId]) throw new Error(`run ${runId} is already registered`);
      reg.nonces[nonce] = { consumedAt: new Date().toISOString(), runId };
      reg.runs[runId] = {
        registeredAt: new Date().toISOString(),
        verdict,
        lineage,
        claims: Array.isArray(claims) ? claims : [],
      };
      const lineageId = lineage && lineage.lineageId || runId;
      if (!reg.lineages[lineageId]) {
        const limits = lineageBudget || {
          maxSuccessors: DEFAULT_MAX_SUCCESSORS,
          maxRecoveryUnits: 58,
          maxNoProgressRepeats: DEFAULT_MAX_NO_PROGRESS_REPEATS,
        };
        reg.lineages[lineageId] = {
          lineageId,
          rootRunId: runId,
          limits: { ...limits },
          spent: { successors: 0, recoveryUnits: 0, noProgressRepeats: 0 },
          runs: [runId],
          events: [{ type: 'ROOT_ADMITTED', runId, at: new Date().toISOString() }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
    });
    return doc.runs[runId];
  }

  /**
   * Commit a successor, its predecessor's single-child claim and the lineage
   * charge in one registry write. The caller has already verified the guard's
   * terminal stop; every registry fact is checked again inside the mutation.
   */
  function createSuccessor({
    predecessorRunId,
    successorRunId,
    verdict,
    lineage,
    terminalStop,
    terminalFingerprint,
    repairSpec,
    charge,
    legacyLineageBudget,
  }) {
    const { doc, result, unchanged } = mutate((reg) => {
      const predecessor = reg.runs[String(predecessorRunId)];
      if (!predecessor) {
        throw new LineageRegistryRefusalError('RUN_NOT_ADMITTED', `predecessor ${predecessorRunId} is not registered`);
      }
      if (predecessor.successorRunId) {
        return {
          noWrite: true,
          value: {
            run: reg.runs[predecessor.successorRunId],
            runId: predecessor.successorRunId,
            replayed: true,
            lineage: reg.lineages[predecessor.lineage.lineageId] || null,
          },
        };
      }

      const lineageId = predecessor.lineage && predecessor.lineage.lineageId;
      if (!lineageId || lineage.lineageId !== lineageId) {
        throw new LineageRegistryRefusalError('LINEAGE_IDENTITY_MISMATCH', 'successor lineage does not match its registered predecessor');
      }
      let ledger = reg.lineages[lineageId];
      if (!ledger) {
        // Upgrade path for a root admitted by A1b.1. Limits are captured once,
        // in this same first successor transaction, then immutable.
        const limits = legacyLineageBudget || {
          maxSuccessors: DEFAULT_MAX_SUCCESSORS,
          maxRecoveryUnits: 58,
          maxNoProgressRepeats: DEFAULT_MAX_NO_PROGRESS_REPEATS,
        };
        ledger = reg.lineages[lineageId] = {
          lineageId,
          rootRunId: predecessor.lineage.lineageId,
          limits: { ...limits },
          spent: { successors: 0, recoveryUnits: 0, noProgressRepeats: 0 },
          runs: [predecessor.lineage.lineageId],
          events: [{ type: 'LEGACY_LINEAGE_CAPTURED', runId: predecessor.lineage.lineageId, at: new Date().toISOString() }],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const spent = ledger.spent || { successors: 0, recoveryUnits: 0, noProgressRepeats: 0 };
      const limits = ledger.limits || {};
      const previousEvent = [...(ledger.events || [])].reverse().find((event) => event.type === 'SUCCESSOR_CREATED');
      const repeated = previousEvent && previousEvent.causeFingerprint === terminalFingerprint ? 1 : 0;
      const nextNoProgress = Number(spent.noProgressRepeats || 0) + repeated;
      if (nextNoProgress > limits.maxNoProgressRepeats) {
        throw new LineageRegistryRefusalError(
          'LINEAGE_NO_PROGRESS_BUDGET_EXHAUSTED',
          `lineage ${lineageId} repeated cause ${terminalFingerprint} ${nextNoProgress} times; cap is ${limits.maxNoProgressRepeats}`,
          { lineageId, terminalFingerprint, used: spent.noProgressRepeats || 0, requested: nextNoProgress, max: limits.maxNoProgressRepeats },
        );
      }
      if (Number(spent.successors || 0) + 1 > limits.maxSuccessors) {
        throw new LineageRegistryRefusalError(
          'LINEAGE_SUCCESSOR_BUDGET_EXHAUSTED',
          `lineage ${lineageId} already created ${spent.successors || 0} successor(s); cap is ${limits.maxSuccessors}`,
          { lineageId, used: spent.successors || 0, requested: 1, max: limits.maxSuccessors },
        );
      }
      if (Number(spent.recoveryUnits || 0) + charge.units > limits.maxRecoveryUnits) {
        throw new LineageRegistryRefusalError(
          'LINEAGE_RECOVERY_BUDGET_EXHAUSTED',
          `lineage ${lineageId} would spend ${Number(spent.recoveryUnits || 0) + charge.units} recovery units; cap is ${limits.maxRecoveryUnits}`,
          { lineageId, used: spent.recoveryUnits || 0, requested: charge.units, max: limits.maxRecoveryUnits, charge },
        );
      }
      if (reg.runs[successorRunId]) {
        throw new LineageRegistryRefusalError('RUN_ALREADY_REGISTERED', `successor id ${successorRunId} already exists`);
      }

      const now = new Date().toISOString();
      predecessor.successorRunId = successorRunId;
      predecessor.terminalStop = terminalStop;
      predecessor.terminalFingerprint = terminalFingerprint;
      reg.runs[successorRunId] = {
        registeredAt: now,
        verdict,
        lineage,
        claims: [],
        repairSpec,
      };
      ledger.runs = [...(ledger.runs || []), successorRunId];
      ledger.spent = {
        successors: Number(spent.successors || 0) + 1,
        recoveryUnits: Number(spent.recoveryUnits || 0) + charge.units,
        noProgressRepeats: nextNoProgress,
      };
      ledger.events = [...(ledger.events || []), {
        type: 'SUCCESSOR_CREATED',
        at: now,
        predecessorRunId,
        successorRunId,
        successorOrdinal: lineage.successorOrdinal,
        causeFingerprint: terminalFingerprint,
        reasonCode: terminalStop.reasonCode,
        charge,
      }];
      ledger.updatedAt = now;
      return { run: reg.runs[successorRunId], runId: successorRunId, replayed: false };
    });
    const ledger = (result && result.lineage) || doc.lineages[lineage.lineageId];
    return { ...result, lineage: ledger, unchanged: !!unchanged };
  }

  function isRegistered(runId) {
    return Boolean(read().runs[String(runId)]);
  }

  function getRun(runId) {
    return read().runs[String(runId)] || null;
  }

  function hasNonce(nonce) {
    return Boolean(read().nonces[String(nonce)]);
  }

  return {
    file,
    read,
    save,
    mutate,
    admit,
    createSuccessor,
    isRegistered,
    getRun,
    hasNonce,
    // Intentionally absent: delete / prune / clear. A consumed nonce stays
    // consumed and a registered run stays registered. Forgetting is a policy
    // decision A1b.2 has to make with a real lineage model in hand.
  };
}

module.exports = {
  createAdmissionRegistry,
  AdmissionRegistryConflictError,
  AdmissionRegistryBusyError,
  AdmissionRegistryCorruptError,
  LineageRegistryRefusalError,
  NonceReplayError,
  SCHEMA_VERSION,
  ADMISSION_DIR,
};
