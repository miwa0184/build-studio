'use strict';

/**
 * Durable, cross-process launch receipts for A1b.2 repair agents.
 *
 * The workflow file is operational state, not a process-start transaction.
 * A server can die after tmux accepts send-keys but before workflow-state.json
 * records the agent. This store gives that external side effect a stable
 * attempt id and a monotonic outbox: intent (provably unsent), dispatching
 * (send-keys may have been attempted), started (the wrapper durably crossed its
 * exact Git self-check), completed, or terminal. A dispatching attempt is never
 * relaunched: if process/tmux evidence is insufficient it becomes
 * LAUNCH_AMBIGUOUS. A separate per-run mkdir lock serialises two project-server
 * processes around intent, workflow persistence and launch/adoption.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCHEMA_VERSION = 2;
const RECEIPT_DIR = 'successor-launch';
const VALID_STATUS = new Set(['intent', 'dispatching', 'started', 'completed', 'terminal']);

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

class SuccessorGitAuthorityError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'SuccessorGitAuthorityError';
    this.code = 'SUCCESSOR_REPAIR_GIT_AUTHORITY_REFUSED';
    this.detail = detail;
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

/** Serialise receipt compare-and-transition across the server and shell wrapper. */
function withReceiptTransitionLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.transition.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    let created = false;
    try {
      fs.mkdirSync(lock);
      created = true;
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }));
      break;
    } catch (error) {
      if (created) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) {} }
      if (!error || error.code !== 'EEXIST') throw error;
      let ownerDead = false;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
        try { process.kill(Number(owner.pid), 0); } catch (probe) {
          if (probe && probe.code === 'ESRCH') ownerDead = true;
        }
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
        throw new SuccessorLaunchBusyError('successor launch receipt transition is owned by another process', {
          lock,
        });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); } finally {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) {}
  }
}

function validObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateGitAuthority(git, file) {
  if (!validObject(git)
    || typeof git.cwd !== 'string' || !path.isAbsolute(git.cwd)
    || typeof git.ref !== 'string' || !git.ref.startsWith('refs/heads/')
    || !/^[0-9a-f]{40,64}$/.test(String(git.head || ''))
    || !/^[0-9a-f]{40,64}$/.test(String(git.tree || ''))) {
    throw new SuccessorLaunchCorruptError(
      'successor launch receipt has invalid immutable Git authority', { file },
    );
  }
  return git;
}

function validateReceipt(doc, file, expectedRunId) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)
    || doc.schemaVersion !== SCHEMA_VERSION
    || (expectedRunId !== null && expectedRunId !== undefined && String(doc.runId) !== String(expectedRunId))
    || !/^[0-9a-f]{64}$/.test(String(doc.attemptId || ''))
    || !VALID_STATUS.has(doc.status)
    || typeof doc.sessionName !== 'string' || !doc.sessionName
    || typeof doc.windowName !== 'string' || !doc.windowName
    || typeof doc.createdAt !== 'string' || typeof doc.updatedAt !== 'string') {
    throw new SuccessorLaunchCorruptError(
      `successor launch receipt for ${expectedRunId} has an unrecognisable schema`,
      { runId: String(expectedRunId), file },
    );
  }
  validateGitAuthority(doc.git, file);
  if (['dispatching', 'started', 'completed'].includes(doc.status) && typeof doc.dispatchingAt !== 'string') {
    throw new SuccessorLaunchCorruptError(`successor launch receipt for ${expectedRunId} lacks dispatching authority`, {
      runId: String(expectedRunId), file,
    });
  }
  if (['started', 'completed'].includes(doc.status) && typeof doc.startedAt !== 'string') {
    throw new SuccessorLaunchCorruptError(`successor launch receipt for ${expectedRunId} lacks durable started authority`, {
      runId: String(expectedRunId), file,
    });
  }
  if (doc.status === 'completed' && (typeof doc.completedAt !== 'string' || !Number.isInteger(doc.exitCode))) {
    throw new SuccessorLaunchCorruptError(`successor launch receipt for ${expectedRunId} has invalid completion authority`, {
      runId: String(expectedRunId), file,
    });
  }
  if (doc.status === 'terminal' && (typeof doc.terminalAt !== 'string'
    || typeof doc.terminalCode !== 'string' || !doc.terminalCode
    || typeof doc.terminalReason !== 'string' || !doc.terminalReason)) {
    throw new SuccessorLaunchCorruptError(`successor launch receipt for ${expectedRunId} has invalid terminal authority`, {
      runId: String(expectedRunId), file,
    });
  }
  return doc;
}

function measureGitAuthority(cwd) {
  const run = (args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
  }).trim();
  let ref;
  try { ref = run(['symbolic-ref', '--quiet', 'HEAD']); } catch (error) {
    throw new SuccessorGitAuthorityError(`repair checkout must be attached to its exact branch ref: ${error.message}`, {
      cwd, currentRef: null,
    });
  }
  const head = run(['rev-parse', 'HEAD']);
  const tree = run(['rev-parse', 'HEAD^{tree}']);
  const dirtyPaths = run(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean);
  return { cwd: path.resolve(cwd), ref, head, tree, dirtyPaths };
}

function assertGitAuthority(expected, cwd = expected && expected.cwd) {
  validateGitAuthority(expected, null);
  let current;
  try { current = measureGitAuthority(cwd); } catch (error) {
    if (error instanceof SuccessorGitAuthorityError) {
      error.detail = { expected, ...(error.detail || {}) };
      throw error;
    }
    throw new SuccessorGitAuthorityError(`repair Git authority cannot be measured: ${error.message}`, { expected });
  }
  const mismatches = [];
  for (const key of ['cwd', 'ref', 'head', 'tree']) {
    if (current[key] !== expected[key]) mismatches.push(key);
  }
  if (current.dirtyPaths.length > 0) mismatches.push('clean');
  if (mismatches.length > 0) {
    throw new SuccessorGitAuthorityError(
      `repair Git authority changed before launch (${mismatches.join(', ')})`,
      {
        expected,
        currentRef: current.ref,
        currentHead: current.head,
        currentTree: current.tree,
        dirtyPaths: current.dirtyPaths,
        mismatches,
      },
    );
  }
  return current;
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
        || existing.windowName !== input.windowName
        || JSON.stringify(existing.git) !== JSON.stringify(input.git)) {
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
      git: validateGitAuthority({ ...input.git }, fileFor(runId)),
      status: 'intent',
      createdAt: now,
      updatedAt: now,
    }, fileFor(runId), runId));
  }

  function markDispatching(runId, attemptId) {
    const file = fileFor(runId);
    return withReceiptTransitionLock(file, () => {
      const current = read(runId);
      if (!current || current.attemptId !== attemptId || current.status !== 'intent') {
        throw new SuccessorLaunchCorruptError(
          `successor launch ${runId} cannot dispatch from ${current && current.status || 'missing'} state`,
          { runId: String(runId), file },
        );
      }
      const now = new Date().toISOString();
      return writeAtomic(file, validateReceipt({
        ...current,
        status: 'dispatching',
        dispatchingAt: now,
        updatedAt: now,
      }, file, runId));
    });
  }

  function markTerminal(runId, attemptId, code, reason, detail = {}) {
    const file = fileFor(runId);
    return withReceiptTransitionLock(file, () => {
      const current = read(runId);
      if (!current || current.attemptId !== attemptId) {
        throw new SuccessorLaunchCorruptError(`successor launch ${runId} terminal transition has no matching attempt`, {
          runId: String(runId), file,
        });
      }
      if (current.status === 'completed' || current.status === 'terminal') return current;
      const now = new Date().toISOString();
      return writeAtomic(file, validateReceipt({
        ...current,
        status: 'terminal',
        terminalAt: now,
        terminalCode: code,
        terminalReason: reason,
        terminalDetail: detail,
        updatedAt: now,
      }, file, runId));
    });
  }

  return { fileFor, lockFor, read, withLock, ensureIntent, markDispatching, markTerminal };
}

/** Called by the launched shell wrapper, not by the server launch transaction. */
function updateReceiptFile(file, status, exitCode) {
  if (!['started', 'completed'].includes(status)) throw new Error(`invalid successor launch status ${status}`);
  return withReceiptTransitionLock(file, () => {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateReceipt(current, file, current.runId);
    if (current.status === 'completed' && status === 'completed') return current;
    if (current.status === 'terminal') throw new Error(`successor launch ${current.runId} is terminal (${current.terminalCode})`);
    if (status === 'started' && current.status !== 'dispatching') {
      throw new Error(`cannot start successor launch ${current.runId} from ${current.status}`);
    }
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
    return writeAtomic(file, validateReceipt(next, file, current.runId));
  });
}

function startCheckedReceiptFile(file) {
  return withReceiptTransitionLock(file, () => {
    const current = validateReceipt(JSON.parse(fs.readFileSync(file, 'utf8')), file, null);
    if (current.status !== 'dispatching') {
      throw new Error(`cannot start successor launch ${current.runId} from ${current.status}`);
    }
    try {
      assertGitAuthority(current.git, current.git.cwd);
    } catch (error) {
      const now = new Date().toISOString();
      writeAtomic(file, validateReceipt({
        ...current,
        status: 'terminal',
        terminalAt: now,
        terminalCode: error.code || 'SUCCESSOR_REPAIR_GIT_AUTHORITY_REFUSED',
        terminalReason: error.message,
        terminalDetail: error.detail || {},
        updatedAt: now,
      }, file, current.runId));
      throw error;
    }
    const now = new Date().toISOString();
    return writeAtomic(file, validateReceipt({
      ...current,
      status: 'started',
      startedAt: now,
      updatedAt: now,
    }, file, current.runId));
  });
}

if (require.main === module) {
  const file = Buffer.from(String(process.argv[2] || ''), 'base64').toString('utf8');
  if (process.argv[3] === 'start-checked') startCheckedReceiptFile(file);
  else updateReceiptFile(file, process.argv[3], process.argv[4]);
}

module.exports = {
  createSuccessorLaunchStore,
  updateReceiptFile,
  startCheckedReceiptFile,
  measureGitAuthority,
  assertGitAuthority,
  SuccessorLaunchBusyError,
  SuccessorLaunchCorruptError,
  SuccessorGitAuthorityError,
  SCHEMA_VERSION,
  RECEIPT_DIR,
};
