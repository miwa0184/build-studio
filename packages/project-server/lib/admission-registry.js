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
 * store. Entries are small JSON; a real archiving and lineage model is A1b.2's
 * job, and inventing an interim one here would hand a way to forget a spent
 * nonce to whoever finds it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
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
      || !doc.runs || typeof doc.runs !== 'object') {
      throw new AdmissionRegistryCorruptError('admission registry has an unrecognisable schema', { file });
    }
    return { ...emptyRegistry(), ...doc };
  }

  /** Lost-update-checked atomic write, exactly the run-guard discipline. */
  function save(doc) {
    fs.mkdirSync(dir, { recursive: true });
    const onDisk = read();
    if (onDisk.revision !== doc.revision) {
      throw new AdmissionRegistryConflictError(
        `admission registry moved on: held revision ${doc.revision}, disk is at ${onDisk.revision}`,
        { expected: doc.revision, actual: onDisk.revision },
      );
    }
    const next = { ...doc, revision: doc.revision + 1, updatedAt: new Date().toISOString() };
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    return next;
  }

  /** Read-modify-write under the current revision; one retry for a concurrent writer. */
  function mutate(fn) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const doc = read();
      const result = fn(doc);
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
  function admit({ nonce, runId, verdict, lineage, claims }) {
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
    });
    return doc.runs[runId];
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
  AdmissionRegistryCorruptError,
  NonceReplayError,
  SCHEMA_VERSION,
  ADMISSION_DIR,
};
