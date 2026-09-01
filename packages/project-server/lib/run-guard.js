'use strict';

/**
 * The run guard store — where a run's budgets and safety state actually live.
 *
 * Two problems this exists to fix, both of which let a bounded loop become
 * unbounded:
 *
 * 1. The budgets did not survive anything. The auto-advance refusal counter was
 *    a `let` in the project-server process, and the hub's round counter was
 *    React state. Restarting the server or reloading the page put both back to
 *    zero, so "at most three refusals" meant "at most three refusals since the
 *    last time anyone touched anything".
 *
 * 2. What did reach disk lived INSIDE the workflow object, and saveWorkflow
 *    writes that object whole with no revision check. Anything holding an older
 *    snapshot — a slow handler, a restore — wrote its version over the top and
 *    silently rolled the counters back. Measured on the unmodified code: a save
 *    from a stale snapshot took round 4 → 1, dropped an intervention record and
 *    dropped capOverrides entirely.
 *
 * So the guard is a SEPARATE file, per run, with a monotonic revision and
 * lost-update detection. It is deliberately small: this is not a replacement for
 * the workflow state, it is the handful of fields that must not be renewable.
 *
 * Isolation is by run id, one file per run under `<statePath>/run-guard/`. That
 * is what lets a stop in one run leave another alone, and it is the seam a
 * later multi-lane scheduler needs.
 *
 * Durability: each write goes to a UNIQUE temp file (pid + random) and is
 * renamed into place. rename(2) is atomic within a filesystem, so a reader sees
 * either the old file or the new one. The unique name matters less for
 * corruption than for not having two writers meet on one path — the constant
 * `.tmp` name used elsewhere is a hazard, not an observed failure.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const GUARD_DIR = 'run-guard';

// There is deliberately NO file cap and NO pruning in this store any more.
// The old MAX_RUN_FILES=40 mtime prune meant the 41st run silently erased the
// oldest run's budgets and recorded stop — which, combined with load()'s
// missing-file-means-new-run behaviour, RENEWED that run: exactly the rewind
// this store exists to make impossible, applied by the store to itself.
// Guard files are small JSON; they stay until a real archiving and lineage
// model (A1b.2) can retire them without forgetting what they proved.

class RunGuardConflictError extends Error {
  constructor(message, { runId, expected, actual } = {}) {
    super(message);
    this.name = 'RunGuardConflictError';
    this.runId = runId;
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

class RunGuardBusyError extends Error {
  constructor(message, { runId, lock } = {}) {
    super(message);
    this.name = 'RunGuardBusyError';
    this.code = 'RUN_GUARD_BUSY';
    this.runId = runId;
    this.lock = lock;
  }
}

class RunGuardTerminalError extends Error {
  constructor(message, { runId } = {}) {
    super(message);
    this.name = 'RunGuardTerminalError';
    this.code = 'RUN_GUARD_TERMINAL';
    this.runId = runId;
  }
}

/**
 * A guard file that EXISTS but cannot be trusted: unparseable, unreadable,
 * wrong schema, or claiming to belong to a different run.
 *
 * This is a different situation from a missing file, and the difference is the
 * whole failure model. A missing file is a new run with no prior guard state —
 * cheap and correct to start clean. An existing file that cannot be verified
 * used to be silently replaced by an empty document, which handed corruption a
 * power nothing else in the system has: it renewed every budget and dropped any
 * recorded terminal stop. So it fails closed instead — the caller gets a typed
 * error, the corrupt file stays on disk as evidence, and nothing that depends
 * on the guard's authority (budgets, transitions, saves) proceeds until a human
 * has looked at it.
 */
class RunGuardCorruptError extends Error {
  constructor(message, { runId, file, cause } = {}) {
    super(message);
    this.name = 'RunGuardCorruptError';
    this.code = 'RUN_GUARD_UNREADABLE';
    this.runId = runId;
    this.file = file;
    if (cause) this.cause = cause;
  }
}

/**
 * A run the admission registry says EXISTS, whose guard file is gone.
 *
 * This is not a new run and must never be treated as one. The guard held the
 * run's spent budgets and any recorded stop; its absence for a registered run
 * means that history was deleted or lost, and synthesising an empty document
 * would renew every budget and erase any stop — a rewind by file deletion.
 * Fails closed: typed error, no fresh budget, no transition, no restore, no
 * worktree, no agent start, until a human has looked at what happened.
 */
class RunGuardMissingError extends Error {
  constructor(message, { runId, file } = {}) {
    super(message);
    this.name = 'RunGuardMissingError';
    this.code = 'RUN_GUARD_MISSING';
    this.runId = runId;
    this.file = file;
  }
}

/**
 * An attempt to register a run id that already has a guard file.
 */
class RunGuardExistsError extends Error {
  constructor(message, { runId, file } = {}) {
    super(message);
    this.name = 'RunGuardExistsError';
    this.code = 'RUN_GUARD_EXISTS';
    this.runId = runId;
    this.file = file;
  }
}

/** Run ids come from workflow ids; keep them safe as filenames without collapsing distinct ids. */
function safeRunId(runId) {
  const raw = String(runId || 'unknown-run');
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  // A long or heavily-escaped id keeps a hash so two different ids never share a file.
  if (cleaned === raw && raw.length <= 100) return cleaned;
  return `${cleaned.slice(0, 60)}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
}

function emptyDoc(runId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: String(runId),
    laneId: 'default',
    revision: 0,
    counters: {},
    incidents: [],
    /** Tasks that cannot complete — the evidence behind a BLOCKED_TASKS stop. */
    blockingTasks: [],
    /** Tasks whose acceptance coverage is not satisfied (skipped, force-completed). */
    acceptanceGaps: [],
    /** The typed terminal outcome, once the run has one. */
    technicalStop: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createRunGuard({ statePath, isRegistered } = {}) {
  if (!statePath) throw new Error('createRunGuard: statePath is required');
  const dir = path.join(statePath, GUARD_DIR);
  // `isRegistered(runId)` asks the admission registry whether this run id was
  // explicitly registered. Without it (older callers, unit tests of the store
  // itself) a missing file keeps the pre-registration meaning: an in-memory
  // empty document for a run nothing has ever recorded against.
  const registeredCheck = typeof isRegistered === 'function' ? isRegistered : null;

  function fileFor(runId) {
    return path.join(dir, `${safeRunId(runId)}.json`);
  }

  function lockFor(runId) {
    return path.join(dir, `${safeRunId(runId)}.lock`);
  }

  /**
   * Cross-process exclusion for one run's complete read/mutate/write cycle.
   *
   * A revision check by itself has a TOCTOU window: two processes can both
   * verify revision N before either rename, acknowledge both writes, and leave
   * only one N+1 document. mkdir is the compare-and-set. Normal writers wait
   * briefly for the tiny critical section; a crashed local owner is reclaimed
   * only after it is old and its pid is provably gone.
   */
  function acquireLock(runId) {
    fs.mkdirSync(dir, { recursive: true });
    const lock = lockFor(runId);
    const deadline = Date.now() + 5000;
    const claim = () => {
      let created = false;
      try {
        fs.mkdirSync(lock);
        created = true;
        fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
          pid: process.pid,
          runId: String(runId),
          createdAt: new Date().toISOString(),
        }));
        return true;
      } catch (error) {
        if (created) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) {} }
        if (error && error.code === 'EEXIST') return false;
        throw error;
      }
    };

    while (!claim()) {
      let stale = false;
      try {
        const stat = fs.statSync(lock);
        const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
        let alive = true;
        try { process.kill(Number(owner.pid), 0); } catch (error) { if (error && error.code === 'ESRCH') alive = false; }
        stale = Date.now() - stat.mtimeMs > 30000 && !alive;
      } catch (_) {
        // A half-created fresh lock is contention, not evidence of staleness.
        stale = false;
      }
      if (stale) {
        const retired = `${lock}.stale-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        try {
          fs.renameSync(lock, retired);
          try { fs.rmSync(retired, { recursive: true, force: true }); } catch (_) {}
          continue;
        } catch (_) {
          // The owner or another contender changed it. Re-read on the next pass.
        }
      }
      if (Date.now() >= deadline) {
        throw new RunGuardBusyError(
          `run guard for ${runId} is locked by another writer; retry from fresh state`,
          { runId: String(runId), lock },
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    return lock;
  }

  function releaseLock(lock) {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) {}
  }

  function withLock(runId, fn) {
    const lock = acquireLock(runId);
    try { return fn(); } finally { releaseLock(lock); }
  }

  function comparable(doc) {
    const copy = JSON.parse(JSON.stringify(doc));
    delete copy.revision;
    delete copy.updatedAt;
    return copy;
  }

  /** A durable terminal guard is immutable, including every charged counter. */
  function assertTransition(onDisk, proposed) {
    if (!onDisk.technicalStop) return;
    if (JSON.stringify(comparable(onDisk)) !== JSON.stringify(comparable(proposed))) {
      throw new RunGuardTerminalError(
        `run guard for ${onDisk.runId} is terminal and cannot be changed`,
        { runId: String(onDisk.runId) },
      );
    }
  }

  function writeNext(doc) {
    const next = { ...doc, revision: doc.revision + 1, updatedAt: new Date().toISOString() };
    const file = fileFor(doc.runId);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    return next;
  }

  function readDoc(runId) {
    const file = fileFor(runId);
    if (!fs.existsSync(file)) {
      // The distinction the whole lifecycle turns on: a run the registry KNOWS
      // with no guard file is deleted history, not a new run. Fail closed.
      if (registeredCheck && registeredCheck(runId)) {
        throw new RunGuardMissingError(
          `run ${runId} is registered but its guard file is missing — its budgets and any recorded stop are unaccounted for`,
          { runId: String(runId), file },
        );
      }
      // An UNREGISTERED id with no file: nothing was ever recorded. The empty
      // document is in-memory only; nothing is written here.
      return emptyDoc(runId);
    }
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // An existing file that cannot be read or parsed fails CLOSED. Returning
      // emptyDoc here let corruption renew every budget and erase a recorded
      // technical stop — the one thing this store exists to make impossible.
      throw new RunGuardCorruptError(
        `run guard for ${runId} exists but cannot be read: ${e.message}`,
        { runId: String(runId), file, cause: e },
      );
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new RunGuardCorruptError(
        `run guard for ${runId} is not a guard document`,
        { runId: String(runId), file },
      );
    }
    // A file at this run's path claiming another run's id is either corruption
    // or tampering; trusting it would cross two runs' budgets, and replacing it
    // would erase whichever run it really belongs to.
    if (String(doc.runId) !== String(runId)) {
      throw new RunGuardCorruptError(
        `run guard file for ${runId} claims to belong to run ${JSON.stringify(doc.runId)}`,
        { runId: String(runId), file },
      );
    }
    if (!Number.isInteger(doc.schemaVersion) || doc.schemaVersion < 1
      || !Number.isInteger(doc.revision) || doc.revision < 0) {
      throw new RunGuardCorruptError(
        `run guard for ${runId} has an unrecognisable schema (schemaVersion=${JSON.stringify(doc.schemaVersion)}, revision=${JSON.stringify(doc.revision)})`,
        { runId: String(runId), file },
      );
    }
    return { ...emptyDoc(runId), ...doc, runId: String(runId) };
  }

  /**
   * Explicitly create the guard for a NEW run, with its identity.
   *
   * This is the only way a guard file comes into existence for a run being
   * registered — plain load() never creates one, and save() below still
   * refuses to move a revision it did not read. `identity` carries the
   * lineage metadata a root run starts with (lineageId = its own id,
   * predecessorRunId = null, successorOrdinal = 0) plus what admission
   * verified: the request digest, the admitted head, the admitted repo.
   *
   * Refuses (RunGuardExistsError) when a file is already there: a register
   * that overwrote an existing guard would be the budget rewind again, with
   * a nicer name.
   */
  function register(runId, { identity } = {}) {
    if (!runId) throw new Error('runGuard.register: runId is required');
    return withLock(runId, () => {
      const file = fileFor(runId);
      if (fs.existsSync(file)) {
        throw new RunGuardExistsError(
          `run ${runId} already has a guard file — a run is registered once`,
          { runId: String(runId), file },
        );
      }
      const doc = {
        ...emptyDoc(runId),
        ...(identity ? { identity } : {}),
        revision: 1,
        updatedAt: new Date().toISOString(),
      };
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
      fs.renameSync(tmp, file);
      return doc;
    });
  }

  /**
   * Write `doc`, refusing if the file has moved on since `doc` was read.
   *
   * This is the lost-update check. A writer holding revision 3 cannot land on a
   * file already at revision 4 — the guard whose whole purpose is to be
   * un-rewindable must not be rewound by a slow caller.
   */
  function save(doc) {
    if (!doc || !doc.runId) throw new Error('runGuard.save: doc.runId is required');
    return withLock(doc.runId, () => {
      const onDisk = readDoc(doc.runId);
      if (onDisk.revision !== doc.revision) {
        throw new RunGuardConflictError(
          `run guard for ${doc.runId} moved on: held revision ${doc.revision}, disk is at ${onDisk.revision}`,
          { runId: doc.runId, expected: doc.revision, actual: onDisk.revision },
        );
      }
      assertTransition(onDisk, doc);
      return writeNext(doc);
    });
  }

  /**
   * Read-modify-write under the current revision.
   *
   * Retries once on a conflict: the point of the revision check is to stop a
   * STALE writer, not to fail a caller that is willing to re-read. A caller that
   * needs to see the conflict uses load() + save() directly.
   */
  function mutate(runId, fn) {
    return withLock(runId, () => {
      const doc = readDoc(runId);
      const before = JSON.parse(JSON.stringify(doc));
      const result = fn(doc);
      assertTransition(before, doc);
      if (JSON.stringify(comparable(before)) === JSON.stringify(comparable(doc))) {
        return { doc: before, result, unchanged: true };
      }
      return { doc: writeNext(doc), result };
    });
  }

  function count(runId, key) {
    return Number(readDoc(runId).counters[key] || 0);
  }

  /**
   * Spend one unit of a budget.
   *
   * There is deliberately no way to put it back. `max` is the number of ALLOWED
   * units: bumping to exactly `max` is still within budget, and the next bump is
   * over it. A caller that wants to ask without spending uses `exceeded`.
   */
  function bump(runId, key, max) {
    const { result } = mutate(runId, (doc) => {
      const next = Number(doc.counters[key] || 0) + 1;
      doc.counters[key] = next;
      return next;
    });
    return {
      value: result,
      exceeded: typeof max === 'number' ? result > max : false,
      max: typeof max === 'number' ? max : null,
    };
  }

  function exceeded(runId, key, max) {
    return typeof max === 'number' ? count(runId, key) > max : false;
  }

  return {
    fileFor,
    lockFor,
    register,
    load: readDoc,
    save,
    mutate,
    count,
    bump,
    exceeded,
    // Intentionally absent: reset / clearCounters / prune / delete. A budget
    // spent inside a run is spent, and a guard written stays written. Renewal
    // is a new run; retirement is A1b.2's archiving model.
  };
}

module.exports = {
  createRunGuard,
  RunGuardConflictError,
  RunGuardBusyError,
  RunGuardTerminalError,
  RunGuardCorruptError,
  RunGuardMissingError,
  RunGuardExistsError,
  SCHEMA_VERSION,
  GUARD_DIR,
};
