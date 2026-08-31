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
/** Keep the most recent N run files; older runs are pruned on write. */
const MAX_RUN_FILES = 40;

class RunGuardConflictError extends Error {
  constructor(message, { runId, expected, actual } = {}) {
    super(message);
    this.name = 'RunGuardConflictError';
    this.runId = runId;
    this.expectedRevision = expected;
    this.actualRevision = actual;
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

function createRunGuard({ statePath }) {
  if (!statePath) throw new Error('createRunGuard: statePath is required');
  const dir = path.join(statePath, GUARD_DIR);

  function fileFor(runId) {
    return path.join(dir, `${safeRunId(runId)}.json`);
  }

  function readDoc(runId) {
    const file = fileFor(runId);
    // Absence is a NEW run — no prior guard state, nothing to distrust.
    if (!fs.existsSync(file)) return emptyDoc(runId);
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

  function prune() {
    try {
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
      for (const old of files.slice(0, Math.max(0, files.length - MAX_RUN_FILES))) {
        try { fs.unlinkSync(path.join(dir, old.name)); } catch (_) {}
      }
    } catch (_) {}
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
    fs.mkdirSync(dir, { recursive: true });
    const onDisk = readDoc(doc.runId);
    if (onDisk.revision !== doc.revision) {
      throw new RunGuardConflictError(
        `run guard for ${doc.runId} moved on: held revision ${doc.revision}, disk is at ${onDisk.revision}`,
        { runId: doc.runId, expected: doc.revision, actual: onDisk.revision },
      );
    }
    const next = { ...doc, revision: doc.revision + 1, updatedAt: new Date().toISOString() };
    const file = fileFor(doc.runId);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    prune();
    return next;
  }

  /**
   * Read-modify-write under the current revision.
   *
   * Retries once on a conflict: the point of the revision check is to stop a
   * STALE writer, not to fail a caller that is willing to re-read. A caller that
   * needs to see the conflict uses load() + save() directly.
   */
  function mutate(runId, fn) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const doc = readDoc(runId);
      const result = fn(doc);
      try {
        const saved = save(doc);
        return { doc: saved, result };
      } catch (e) {
        if (!(e instanceof RunGuardConflictError) || attempt === 1) throw e;
      }
    }
    /* istanbul ignore next — the loop above always returns or throws */
    throw new RunGuardConflictError(`run guard for ${runId} could not be written`, { runId });
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
    load: readDoc,
    save,
    mutate,
    count,
    bump,
    exceeded,
    // Intentionally absent: reset / clearCounters. A budget spent inside a run
    // is spent. Renewal is a new run.
  };
}

module.exports = { createRunGuard, RunGuardConflictError, RunGuardCorruptError, SCHEMA_VERSION, GUARD_DIR };
