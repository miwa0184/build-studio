'use strict';

/**
 * Shared durable-authority primitives.
 *
 * Extracted verbatim from run-guard.js so that every per-run authority file
 * in `.build-studio/` — the run aggregate and the factory-run receipt — is
 * written with ONE discipline: canonical digesting, unique temp file +
 * fsync + rename + directory fsync, and one per-key filesystem lease with
 * the proved-dead reclaim protocol. The semantics here are the A1b.2R-S1
 * contract; this module changes none of them, it only names them.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_PROTOCOL_VERSION = 1;

function safeRunId(runId) {
  const raw = String(runId || 'unknown-run');
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  if (cleaned === raw && raw.length <= 100) return cleaned;
  return `${cleaned.slice(0, 60)}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

/** Refuse symlinks in every existing component from base through target. */
function assertPathComponentsNoSymlink(base, target) {
  const root = path.resolve(base);
  const leaf = path.resolve(target);
  const relative = path.relative(root, leaf);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error(`authority path escapes its base: ${leaf}`);
    error.code = 'AUTHORITY_PATH_ESCAPE';
    throw error;
  }
  const candidates = [root];
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    candidates.push(current);
  }
  for (const candidate of candidates) {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const error = new Error(`authority path component is a symbolic link: ${candidate}`);
      error.code = 'AUTHORITY_PATH_SYMLINK';
      throw error;
    }
  }
}

function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Unique temp file, fsync, rename over the target, directory fsync. */
function writeAtomic(file, value, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, exclusive ? 'wx' : 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

/**
 * Unique temp file, fsync, then an EXCLUSIVE publish: link(2) fails with
 * EEXIST when the target already exists, so two writers can never both
 * believe they created the file. Returns false when the target was already
 * there; the caller decides what an existing file means.
 */
function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(tmp, file);
    } catch (error) {
      if (error && error.code === 'EEXIST') return false;
      throw error;
    }
    syncDirectory(path.dirname(file));
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

/**
 * Per-key filesystem leases, serialized across processes.
 *
 * A writer publishes an owner receipt (protocol version, random token, pid,
 * hostname, key, timestamp). A contender reclaims only when the receipt is
 * valid, the hostname is local and kill(pid, 0) proves the owner is gone
 * with ESRCH; a permanent token-specific claim prevents a delayed stale
 * reclaimer from moving a newer live owner. Bounded waiting ends in the
 * caller's typed busy error.
 */
function createLeaseStore({
  locksDir, lockTimeoutMs = 5000, lockPollMs = 5, busyError, assertSafePath,
} = {}) {
  if (!locksDir) throw new Error('createLeaseStore: locksDir is required');
  const busy = typeof busyError === 'function'
    ? busyError
    : (key) => Object.assign(new Error(`lease for ${key} is busy`), { code: 'AUTHORITY_LEASE_BUSY' });
  const ensureSafe = (...targets) => {
    if (typeof assertSafePath === 'function') targets.forEach((target) => assertSafePath(target));
  };

  function lockFor(key) {
    return path.join(locksDir, `${safeRunId(key)}.lock`);
  }

  function ownerFile(lock) {
    return path.join(lock, 'owner.json');
  }

  function readOwner(lock) {
    ensureSafe(lock, ownerFile(lock));
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile(lock), 'utf8'));
      if (!exactKeys(owner, ['protocolVersion', 'token', 'pid', 'hostname', 'runId', 'createdAt'])
        || owner.protocolVersion !== LOCK_PROTOCOL_VERSION
        || typeof owner.token !== 'string' || owner.token.length === 0
        || !Number.isInteger(owner.pid) || owner.pid <= 0
        || typeof owner.hostname !== 'string' || owner.hostname.length === 0
        || typeof owner.runId !== 'string' || owner.runId.length === 0
        || typeof owner.createdAt !== 'string' || owner.createdAt.length === 0) return null;
      return owner;
    } catch (_) {
      return null;
    }
  }

  function processIsDead(owner) {
    if (!owner || owner.hostname !== os.hostname()) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return error && error.code === 'ESRCH';
    }
  }

  function reclaimStale(lock, owner) {
    if (!processIsDead(owner)) return false;
    // The token-specific claim is intentionally permanent. Without it, a
    // reclaimer that paused after observing dead owner A could wake after A
    // had already been removed and move a new live owner B out of the lock.
    // Only the process that creates this claim may ever move A's lock.
    const claim = `${lock}.reclaimed-${owner.token}`;
    ensureSafe(lock, ownerFile(lock), claim);
    try {
      fs.mkdirSync(claim);
    } catch (_) {
      return false;
    }
    const current = readOwner(lock);
    if (!current || current.token !== owner.token || !processIsDead(current)) return false;
    const tombstone = `${lock}.stale-${owner.token}-${crypto.randomUUID()}`;
    ensureSafe(lock, tombstone);
    try {
      fs.renameSync(lock, tombstone);
    } catch (_) {
      return false;
    }
    const movedOwner = readOwner(tombstone);
    if (!movedOwner || movedOwner.token !== owner.token) {
      ensureSafe(tombstone, lock);
      try { fs.renameSync(tombstone, lock); } catch (_) {}
      return false;
    }
    ensureSafe(tombstone);
    fs.rmSync(tombstone, { recursive: true, force: true });
    return true;
  }

  function tryAcquire(key) {
    ensureSafe(locksDir);
    fs.mkdirSync(locksDir, { recursive: true });
    ensureSafe(locksDir);
    const lock = lockFor(key);
    const token = crypto.randomUUID();
    const candidate = `${lock}.candidate-${token}`;
    ensureSafe(lock, candidate);
    fs.mkdirSync(candidate, { recursive: false });
    const owner = {
      protocolVersion: LOCK_PROTOCOL_VERSION,
      token,
      pid: process.pid,
      hostname: os.hostname(),
      runId: String(key),
      createdAt: new Date().toISOString(),
    };
    ensureSafe(candidate, ownerFile(candidate));
    writeAtomic(ownerFile(candidate), owner);
    try {
      ensureSafe(candidate, lock);
      fs.renameSync(candidate, lock);
      syncDirectory(locksDir);
      return { lock, owner };
    } catch (error) {
      ensureSafe(candidate, lock);
      fs.rmSync(candidate, { recursive: true, force: true });
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      const existing = readOwner(lock);
      if (existing && existing.runId === String(key) && reclaimStale(lock, existing)) return tryAcquire(key);
      return null;
    }
  }

  function acquire(key) {
    const deadline = Date.now() + lockTimeoutMs;
    do {
      const lease = tryAcquire(key);
      if (lease) return lease;
      if (Date.now() >= deadline) break;
      const until = Date.now() + lockPollMs;
      while (Date.now() < until) { /* bounded synchronous lock poll */ }
    } while (true);
    throw busy(String(key));
  }

  function release(lease) {
    ensureSafe(lease.lock, ownerFile(lease.lock));
    const current = readOwner(lease.lock);
    if (!current || current.token !== lease.owner.token || current.runId !== lease.owner.runId) return;
    const released = `${lease.lock}.release-${lease.owner.token}`;
    ensureSafe(lease.lock, released);
    try {
      fs.renameSync(lease.lock, released);
      ensureSafe(released);
      fs.rmSync(released, { recursive: true, force: true });
    } catch (_) {}
  }

  return { lockFor, acquire, release };
}

module.exports = {
  LOCK_PROTOCOL_VERSION,
  safeRunId,
  canonicalJson,
  digest,
  isObject,
  exactKeys,
  assertPathComponentsNoSymlink,
  syncDirectory,
  writeAtomic,
  writeExclusive,
  createLeaseStore,
};
