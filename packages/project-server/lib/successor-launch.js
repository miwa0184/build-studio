'use strict';

/**
 * Durable, cross-process launch receipts for A1b.2 repair agents.
 *
 * The workflow file is operational state, not a process-start transaction.
 * A server can die after tmux accepts send-keys but before workflow-state.json
 * records the agent. This store gives that external side effect a stable
 * attempt id and three monotonic receipts: intent (before tmux), started (the
 * wrapper's first command), completed (the wrapper's last command). A separate
 * per-run mkdir lock serialises two project-server processes around intent,
 * workflow persistence and launch/adoption.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const RECEIPT_DIR = 'successor-launch';
const VALID_STATUS = new Set(['intent', 'started', 'completed']);

class SuccessorLaunchBusyError extends Error {
  constructor(message, { runId, lock } = {}) {
    super(message);
    this.name = 'SuccessorLaunchBusyError';
    this.code = 'SUCCESSOR_LAUNCH_BUSY';
    this.runId = runId;
    this.lock = lock;
  }
}

class SuccessorLaunchCorruptError extends Error {
  constructor(message, { runId, file, cause } = {}) {
    super(message);
    this.name = 'SuccessorLaunchCorruptError';
    this.code = 'SUCCESSOR_LAUNCH_UNREADABLE';
    this.runId = runId;
    this.file = file;
    if (cause) this.cause = cause;
  }
}

function safeRunId(runId) {
  const raw = String(runId || 'unknown-run');
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (cleaned === raw && raw.length <= 100) return cleaned;
  return `${cleaned.slice(0, 60)}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
}

function writeAtomic(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
  return doc;
}

function validateReceipt(doc, file, expectedRunId) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)
    || doc.schemaVersion !== SCHEMA_VERSION
    || String(doc.runId) !== String(expectedRunId)
    || !/^[0-9a-f]{64}$/.test(String(doc.attemptId || ''))
    || !VALID_STATUS.has(doc.status)
    || typeof doc.sessionName !== 'string' || !doc.sessionName
    || typeof doc.windowName !== 'string' || !doc.windowName) {
    throw new SuccessorLaunchCorruptError(
      `successor launch receipt for ${expectedRunId} has an unrecognisable schema`,
      { runId: String(expectedRunId), file },
    );
  }
  return doc;
}

function createSuccessorLaunchStore({ statePath } = {}) {
  if (!statePath) throw new Error('createSuccessorLaunchStore: statePath is required');
  const dir = path.join(statePath, RECEIPT_DIR);

  function fileFor(runId) { return path.join(dir, `${safeRunId(runId)}.json`); }
  function lockFor(runId) { return path.join(dir, `${safeRunId(runId)}.lock`); }

  function read(runId) {
    const file = fileFor(runId);
    if (!fs.existsSync(file)) return null;
    try {
      return validateReceipt(JSON.parse(fs.readFileSync(file, 'utf8')), file, runId);
    } catch (error) {
      if (error instanceof SuccessorLaunchCorruptError) throw error;
      throw new SuccessorLaunchCorruptError(
        `successor launch receipt for ${runId} cannot be read: ${error.message}`,
        { runId: String(runId), file, cause: error },
      );
    }
  }

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
      let ownerDead = false;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
        try { process.kill(Number(owner.pid), 0); } catch (error) { if (error && error.code === 'ESRCH') ownerDead = true; }
      } catch (_) {
        // A half-created lock is live contention until its owner receipt lands.
      }
      if (ownerDead) {
        const retired = `${lock}.stale-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        try {
          fs.renameSync(lock, retired);
          try { fs.rmSync(retired, { recursive: true, force: true }); } catch (_) {}
          continue;
        } catch (_) {}
      }
      if (Date.now() >= deadline) {
        throw new SuccessorLaunchBusyError(
          `successor launch for ${runId} is owned by another server process`,
          { runId: String(runId), lock },
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    return lock;
  }

  function withLock(runId, fn) {
    const lock = acquireLock(runId);
    try { return fn(); } finally {
      try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) {}
    }
  }

  function ensureIntent(runId, input) {
    const existing = read(runId);
    if (existing) {
      if (existing.attemptId !== input.attemptId
        || existing.sessionName !== input.sessionName
        || existing.windowName !== input.windowName) {
        throw new SuccessorLaunchCorruptError(
          `successor launch receipt for ${runId} conflicts with its immutable attempt identity`,
          { runId: String(runId), file: fileFor(runId) },
        );
      }
      return existing;
    }
    const now = new Date().toISOString();
    return writeAtomic(fileFor(runId), validateReceipt({
      schemaVersion: SCHEMA_VERSION,
      runId: String(runId),
      attemptId: input.attemptId,
      sessionName: input.sessionName,
      windowName: input.windowName,
      status: 'intent',
      createdAt: now,
      updatedAt: now,
    }, fileFor(runId), runId));
  }

  return { fileFor, lockFor, read, withLock, ensureIntent };
}

/** Called by the launched shell wrapper, not by the server launch transaction. */
function updateReceiptFile(file, status, exitCode) {
  if (!['started', 'completed'].includes(status)) throw new Error(`invalid successor launch status ${status}`);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateReceipt(current, file, current.runId);
  if (current.status === 'completed') return current;
  if (status === 'completed' && current.status !== 'started') {
    throw new Error(`cannot complete successor launch ${current.runId} before its started receipt`);
  }
  const now = new Date().toISOString();
  const next = {
    ...current,
    status,
    updatedAt: now,
    ...(status === 'started' ? { startedAt: current.startedAt || now } : {
      completedAt: now,
      exitCode: Number.isInteger(Number(exitCode)) ? Number(exitCode) : null,
    }),
  };
  return writeAtomic(file, next);
}

if (require.main === module) {
  const file = Buffer.from(String(process.argv[2] || ''), 'base64').toString('utf8');
  updateReceiptFile(file, process.argv[3], process.argv[4]);
}

module.exports = {
  createSuccessorLaunchStore,
  updateReceiptFile,
  SuccessorLaunchBusyError,
  SuccessorLaunchCorruptError,
  SCHEMA_VERSION,
  RECEIPT_DIR,
};
