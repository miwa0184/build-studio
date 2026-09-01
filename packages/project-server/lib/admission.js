'use strict';

/**
 * Execution admission — the server-side gate a run passes BEFORE its first
 * work-related side effect.
 *
 * What this is: a verifier of a client-stated intent (the RunRequest) against
 * the project's actual git reality, an evidence classifier for the claims the
 * request carries, and the ONLY producer of the GateVerdict that registers a
 * run. What this is NOT: user authentication, transport security, or a
 * complete security boundary. A local process that can write this machine's
 * files can forge anything here; the boundary being enforced is that no HTTP
 * caller — the hub included — can assert its own admission. The hub carries
 * no authority: a UI click and a hand-written curl meet exactly the same
 * verification and receive the same verdict shape.
 *
 * The RunRequest (version 1) — exactly these top-level fields, nothing else:
 *
 *   version     integer, must be a known version
 *   repo        "owner/name", verified against the project's origin remote
 *   head        full 40-hex SHA, must be the project's CURRENT head — a
 *               fabricated sha, a stale-but-real sha, and a sha from another
 *               repo all refuse
 *   task_packet safe relative path that must exist AT that head (committed
 *               content, read via git — the working tree does not count)
 *   claims      array (may be empty) of classified evidence, see below
 *   issued_at   ISO-8601
 *   expires_at  ISO-8601, after issued_at, not yet passed, and no further out
 *               than MAX_VALIDITY_MS
 *   nonce       unique string, consumed durably on admission — replay refuses,
 *               across restarts
 *
 * Any other top-level field refuses — specifically including anything shaped
 * like a client-supplied GateVerdict, approval, or bypass. The verdict is
 * created here or it does not exist.
 *
 * Claim classes:
 *   MEASURED    something observed; must carry a structured receipt
 *               ({ source, observedAt, value }) or it refuses
 *   DERIVED     a computation; accepted ONLY for a method this validator can
 *               recompute itself (sha256_hex), and the recomputed result must
 *               match — correct operands with a wrong result refuse
 *   INFERENCE / HYPOTHESIS / UNKNOWN
 *               transported and recorded, never authority: verification of
 *               repo/head/task_packet never reads claims, so no claim can
 *               substitute for a failed verification
 *
 * Transaction order on admission (measured against I9):
 *   1. Verify everything. Read-only.
 *   2. Create the run's guard file (runGuard.register) with its identity.
 *      A failure here leaves nothing registered and the nonce unspent.
 *   3. Registry.admit — ONE atomic write that consumes the nonce and
 *      registers the run. This is the commit point: the run exists iff this
 *      write landed. A failure here refuses; the guard file from step 2 is an
 *      orphan (never a run — registration is the registry entry) and is left
 *      in place, because nothing here deletes guard files, ever.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const {
  createAdmissionRegistry,
  NonceReplayError,
  AdmissionRegistryBusyError,
  LineageRegistryRefusalError,
  requestAuthorityDigest,
} = require('./admission-registry');
const { createRunGuard } = require('./run-guard');
const {
  resolveLineageBudgets,
  successorRecoveryEligibility,
  recoveryCharge,
} = require('./lineage-budgets');

const RUNREQUEST_VERSION = 1;
/** The documented ceiling on a RunRequest's validity window. */
const MAX_VALIDITY_MS = 15 * 60 * 1000;
/** How long a single git verification command may take before refusing. */
const GIT_TIMEOUT_MS = 10 * 1000;

const RUNREQUEST_FIELDS = ['version', 'repo', 'head', 'task_packet', 'claims', 'issued_at', 'expires_at', 'nonce'];
/**
 * Field names that read as an attempt to carry a client-made verdict. All
 * unknown fields refuse; these get a sharper code so the refusal says what it
 * saw rather than "unknown field".
 */
const CLIENT_VERDICT_FIELDS = /verdict|approval|approved|bypass|admission|gate/i;

const CLAIM_CLASSES = ['MEASURED', 'DERIVED', 'INFERENCE', 'HYPOTHESIS', 'UNKNOWN'];
/** Claim classes that may be transported but can never authorise anything. */
const NON_AUTHORITATIVE_CLASSES = ['INFERENCE', 'HYPOTHESIS', 'UNKNOWN'];

class AdmissionRefusedError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'AdmissionRefusedError';
    this.code = code;
    this.detail = detail;
  }
}

/** In-process brand for contexts this module created. Not forgeable over HTTP. */
const CONTEXTS = new WeakSet();

function isAdmissionContext(ctx) {
  return typeof ctx === 'object' && ctx !== null && CONTEXTS.has(ctx);
}

function refuse(code, message, detail) {
  throw new AdmissionRefusedError(code, message, detail);
}

function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
  if (p.includes('\0') || p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return false;
  const segments = p.split('/');
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..');
}

function parseIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** "owner/name" from any common git remote URL form; null when unparseable. */
function parseRepoFromUrl(url) {
  const cleaned = String(url || '').trim().replace(/\.git$/, '');
  const m = cleaned.match(/[:/]([^:/]+)\/([^:/]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function validateClaims(claims) {
  if (!Array.isArray(claims)) {
    refuse('ADMISSION_REQUEST_INVALID', 'claims must be an array (it may be empty)');
  }
  const recorded = [];
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
      refuse('ADMISSION_CLAIM_INVALID', `claims[${i}] is not an object`);
    }
    const cls = claim.class;
    if (!CLAIM_CLASSES.includes(cls)) {
      refuse('ADMISSION_CLAIM_INVALID', `claims[${i}] has unknown class ${JSON.stringify(cls)} — known classes: ${CLAIM_CLASSES.join(', ')}`);
    }
    if (cls === 'MEASURED') {
      const r = claim.receipt;
      const ok = r && typeof r === 'object' && !Array.isArray(r)
        && typeof r.source === 'string' && r.source.trim().length > 0
        && parseIso(r.observedAt) !== null
        && r.value !== undefined;
      if (!ok) {
        refuse('ADMISSION_CLAIM_INVALID', `claims[${i}] is MEASURED without a structured receipt ({ source, observedAt, value }) — a measurement with no receipt is an assertion`);
      }
      recorded.push({ class: cls, statement: String(claim.statement || ''), receipt: r, authoritative: false });
    } else if (cls === 'DERIVED') {
      // Only methods this validator recomputes ITSELF are accepted. The
      // client's arithmetic is never trusted: correct operands with a wrong
      // result refuse.
      if (claim.method !== 'sha256_hex') {
        refuse('ADMISSION_DERIVED_UNSUPPORTED', `claims[${i}] uses DERIVED method ${JSON.stringify(claim.method)} — the only server-recomputable method is sha256_hex`);
      }
      const operands = claim.operands;
      if (!operands || typeof operands !== 'object' || typeof operands.data !== 'string') {
        refuse('ADMISSION_CLAIM_INVALID', `claims[${i}] DERIVED sha256_hex needs operands.data (string)`);
      }
      const recomputed = crypto.createHash('sha256').update(operands.data).digest('hex');
      if (typeof claim.result !== 'string' || claim.result.toLowerCase() !== recomputed) {
        refuse('ADMISSION_DERIVED_MISMATCH', `claims[${i}] DERIVED result does not match the server's recomputation`, { recomputed });
      }
      recorded.push({ class: cls, method: claim.method, operands, result: recomputed, authoritative: false });
    } else {
      // INFERENCE / HYPOTHESIS / UNKNOWN: carried, recorded, never authority.
      recorded.push({ class: cls, statement: String(claim.statement || ''), authoritative: false });
    }
  }
  return recorded;
}

function createAdmission(config) {
  const projectRoot = config.projectRoot;
  const statePath = config.statePath || path.join(projectRoot || process.cwd(), '.build-studio');
  if (!projectRoot) throw new Error('createAdmission: config.projectRoot is required');
  const registry = createAdmissionRegistry({ statePath });
  const runGuard = createRunGuard({ statePath, isRegistered: registry.isRegistered });

  /** Every git read used for verification. A failure or timeout REFUSES. */
  function git(args) {
    return execFileSync('git', args, {
      cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS,
    }).trim();
  }

  function originRepo() {
    let url;
    try {
      url = git(['remote', 'get-url', 'origin']);
    } catch (e) {
      refuse('ADMISSION_VALIDATOR_FAILURE', `cannot read the project's origin remote: ${e.message}`);
    }
    const repo = parseRepoFromUrl(url);
    if (!repo) refuse('ADMISSION_VALIDATOR_FAILURE', `the project's origin remote URL is not parseable as owner/name`);
    return repo;
  }

  function currentHead() {
    try {
      return git(['rev-parse', 'HEAD']);
    } catch (e) {
      refuse('ADMISSION_VALIDATOR_FAILURE', `cannot read the project's current head: ${e.message}`);
    }
  }

  function shaExists(sha) {
    try {
      git(['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch (_) {
      return false;
    }
  }

  function existsAtHead(head, relPath) {
    try {
      git(['cat-file', '-e', `${head}:${relPath}`]);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Verify a RunRequest. Read-only — nothing is consumed or registered here.
   * Returns { request, digest, claims } or throws AdmissionRefusedError.
   */
  function verifyRunRequest(raw, { now = new Date() } = {}) {
    if (raw === undefined || raw === null) {
      refuse('ADMISSION_REQUEST_MISSING', 'this route starts a run and requires a runRequest — none was sent');
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      refuse('ADMISSION_REQUEST_INVALID', 'runRequest must be an object');
    }
    for (const key of Object.keys(raw)) {
      if (!RUNREQUEST_FIELDS.includes(key)) {
        if (CLIENT_VERDICT_FIELDS.test(key)) {
          refuse('ADMISSION_CLIENT_VERDICT', `runRequest carries ${JSON.stringify(key)} — verdicts, approvals and bypasses are created by this server, never accepted from a client`);
        }
        refuse('ADMISSION_UNKNOWN_FIELD', `runRequest has unknown field ${JSON.stringify(key)}`);
      }
    }
    if (raw.version !== RUNREQUEST_VERSION) {
      refuse('ADMISSION_UNKNOWN_VERSION', `runRequest version ${JSON.stringify(raw.version)} is not known (this server speaks version ${RUNREQUEST_VERSION})`);
    }
    if (typeof raw.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(raw.repo)) {
      refuse('ADMISSION_REQUEST_INVALID', 'repo must be "owner/name"');
    }
    if (typeof raw.head !== 'string' || !/^[0-9a-f]{40}$/.test(raw.head)) {
      refuse('ADMISSION_HEAD_INVALID', 'head must be a full 40-character lowercase hex commit sha');
    }
    if (!isSafeRelativePath(raw.task_packet)) {
      refuse('ADMISSION_TASK_PACKET_INVALID', 'task_packet must be a safe relative path (no "..", no absolute paths)');
    }
    const issuedAt = parseIso(raw.issued_at);
    const expiresAt = parseIso(raw.expires_at);
    if (issuedAt === null || expiresAt === null) {
      refuse('ADMISSION_TIMES_INVALID', 'issued_at and expires_at must be ISO-8601 timestamps');
    }
    if (expiresAt <= issuedAt) {
      refuse('ADMISSION_TIMES_INVALID', 'expires_at must be after issued_at');
    }
    if (expiresAt - issuedAt > MAX_VALIDITY_MS) {
      refuse('ADMISSION_VALIDITY_TOO_LONG', `a runRequest may be valid for at most ${MAX_VALIDITY_MS / 1000}s`);
    }
    if (expiresAt <= now.getTime()) {
      refuse('ADMISSION_EXPIRED', 'runRequest has expired');
    }
    if (typeof raw.nonce !== 'string' || raw.nonce.length < 16 || raw.nonce.length > 128) {
      refuse('ADMISSION_NONCE_INVALID', 'nonce must be a string of 16–128 characters');
    }
    const claims = validateClaims(raw.claims === undefined ? [] : raw.claims);

    // Reality checks — the request against the project itself, via git.
    // Deliberately AFTER the shape checks and BEFORE any consumption, and
    // deliberately blind to claims: no claim class can stand in for these.
    const actualRepo = originRepo();
    if (raw.repo !== actualRepo) {
      refuse('ADMISSION_REPO_MISMATCH', `runRequest names repo ${raw.repo} but this project's origin is ${actualRepo}`);
    }
    const head = currentHead();
    if (raw.head !== head) {
      const code = shaExists(raw.head) ? 'ADMISSION_HEAD_STALE' : 'ADMISSION_HEAD_UNKNOWN';
      refuse(code, code === 'ADMISSION_HEAD_STALE'
        ? `runRequest head ${raw.head.slice(0, 12)} exists but is not the current head (${head.slice(0, 12)}) — re-read the head and re-issue the request`
        : `runRequest head ${raw.head.slice(0, 12)} does not name a commit in this repository`);
    }
    if (!existsAtHead(head, raw.task_packet)) {
      refuse('ADMISSION_TASK_PACKET_MISSING', `task packet ${raw.task_packet} does not exist at head ${head.slice(0, 12)} — commit it first; the working tree does not count`);
    }
    try {
      if (registry.hasNonce(raw.nonce)) {
        refuse('ADMISSION_NONCE_REPLAYED', 'this nonce has already been consumed — a runRequest is single-use');
      }
    } catch (error) {
      if (error instanceof AdmissionRefusedError) throw error;
      refuse('ADMISSION_VALIDATOR_FAILURE', `admission registry unreadable: ${error.message}`);
    }

    const request = {
      version: raw.version,
      repo: raw.repo,
      head: raw.head,
      task_packet: raw.task_packet,
      claims: raw.claims === undefined ? [] : raw.claims,
      issued_at: raw.issued_at,
      expires_at: raw.expires_at,
      nonce: raw.nonce,
    };
    return { request, digest: requestAuthorityDigest(request), claims };
  }

  /**
   * Admit a verified request: create the guard, then commit the registration.
   * Returns { runId, verdict }. Throws AdmissionRefusedError on any failure.
   */
  function admit(raw, { runIdPrefix = 'run', now = new Date() } = {}) {
    const { request, digest, claims } = verifyRunRequest(raw, { now });

    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const runId = `${String(runIdPrefix).replace(/[^a-z0-9_-]/gi, '') || 'run'}-${timestamp}-${crypto.randomBytes(2).toString('hex')}`;

    const verdict = {
      kind: 'GateVerdict',
      version: 1,
      decision: 'ADMITTED',
      runId,
      repo: request.repo,
      head: request.head,
      taskPacket: request.task_packet,
      nonce: request.nonce,
      requestDigest: digest,
      admittedAt: now.toISOString(),
    };
    const lineage = {
      runId,
      lineageId: runId,
      predecessorRunId: null,
      successorOrdinal: 0,
      registeredAt: now.toISOString(),
      admissionRequestDigest: digest,
      admittedHead: request.head,
      admittedRepo: request.repo,
    };

    // Step 2 — the guard file, with identity. Fails: nothing registered,
    // nonce unspent.
    try {
      runGuard.register(runId, { identity: lineage });
    } catch (e) {
      refuse('ADMISSION_REGISTRATION_FAILED', `could not create the run guard for ${runId}: ${e.message}`);
    }

    // Step 3 — THE commit point: one atomic write consumes the nonce and
    // registers the run. Fails: refusal; the run does not exist (a run is a
    // registry entry); the guard file above is an inert orphan and stays —
    // nothing in this system deletes guard files.
    try {
      registry.admit({
        nonce: request.nonce,
        runId,
        verdict,
        lineage,
        claims,
        lineageBudget: resolveLineageBudgets(config),
        request,
        requestDigest: digest,
      });
    } catch (e) {
      if (e instanceof NonceReplayError) {
        refuse('ADMISSION_NONCE_REPLAYED', 'this nonce has already been consumed — a runRequest is single-use');
      }
      refuse('ADMISSION_REGISTRATION_FAILED', `could not register run ${runId}: ${e.message}`);
    }

    return { runId, verdict };
  }

  /**
   * Register one bounded successor for a terminal technical predecessor.
   *
   * Unlike a root RunRequest, every fact comes from server-owned stores: the
   * predecessor's registry identity and guard stop. The registry transaction
   * is the commit point for the one-child claim, lineage charge and successor
   * identity. The guard is materialised afterwards; until it exists contextFor
   * fails closed, so a crash can leave an inert pending run but never a
   * runnable orphan. Replaying the predecessor resumes that materialisation.
   */
  function loadSuccessorAuthority(predecessorRunId) {
    let predecessor;
    try {
      predecessor = registry.getRun(predecessorRunId);
    } catch (e) {
      refuse('ADMISSION_VALIDATOR_FAILURE', `admission registry unreadable: ${e.message}`);
    }
    if (!predecessor) refuse('RUN_NOT_ADMITTED', `predecessor ${predecessorRunId} was never admitted`);

    let predecessorGuard;
    try {
      predecessorGuard = runGuard.load(predecessorRunId);
    } catch (e) {
      if (e && e.code === 'RUN_GUARD_MISSING') refuse('RUN_GUARD_MISSING', e.message, { runId: String(predecessorRunId) });
      refuse('ADMISSION_VALIDATOR_FAILURE', `run guard for ${predecessorRunId} cannot be verified: ${e.message}`);
    }
    const identity = predecessor.lineage;
    const guardIdentity = predecessorGuard.identity;
    if (!identity || !guardIdentity
      || String(identity.runId) !== String(guardIdentity.runId)
      || identity.lineageId !== guardIdentity.lineageId
      || identity.predecessorRunId !== guardIdentity.predecessorRunId
      || identity.admissionRequestDigest !== guardIdentity.admissionRequestDigest
      || identity.admittedHead !== guardIdentity.admittedHead
      || identity.admittedRepo !== guardIdentity.admittedRepo
      || Number(identity.successorOrdinal || 0) !== Number(guardIdentity.successorOrdinal || 0)) {
      refuse('LINEAGE_IDENTITY_MISMATCH', `registry and guard identity disagree for predecessor ${predecessorRunId}`);
    }

    const stop = predecessorGuard.technicalStop;
    let eligibility;
    try {
      eligibility = successorRecoveryEligibility(stop);
    } catch (error) {
      if (error && error.code === 'TECHNICAL_STOP_CAUSE_UNVERIFIABLE') {
        refuse(error.code, error.message, error.detail || {});
      }
      throw error;
    }
    if (!eligibility.eligible) {
      refuse('SUCCESSOR_NOT_ELIGIBLE', `run ${predecessorRunId} cannot create a successor: ${eligibility.reason}`);
    }
    if (String(stop.runId) !== String(predecessorRunId)) {
      refuse('LINEAGE_IDENTITY_MISMATCH', `technical stop belongs to ${stop.runId}, not predecessor ${predecessorRunId}`);
    }
    return { predecessor, predecessorGuard, identity, stop, eligibility };
  }

  /** Read-only budget/cause preflight. The locked commit re-runs every check. */
  function inspectSuccessor(predecessorRunId) {
    const authority = loadSuccessorAuthority(predecessorRunId);
    try {
      return registry.inspectSuccessor({
        predecessorRunId: String(predecessorRunId),
        terminalStop: authority.stop,
        terminalCause: authority.eligibility.cause,
        terminalFingerprint: authority.eligibility.fingerprint,
        charge: recoveryCharge(authority.predecessorGuard),
        legacyLineageBudget: resolveLineageBudgets(config),
      });
    } catch (e) {
      if (e instanceof LineageRegistryRefusalError || e && /^(?:LINEAGE_|RUN_|TECHNICAL_STOP_)/.test(e.code || '')) {
        refuse(e.code, e.message, e.detail || {});
      }
      refuse('ADMISSION_VALIDATOR_FAILURE', `successor registry preflight failed: ${e.message}`);
    }
  }

  function createSuccessor(predecessorRunId, { now = new Date() } = {}) {
    const {
      predecessor,
      predecessorGuard,
      identity,
      stop,
      eligibility,
    } = loadSuccessorAuthority(predecessorRunId);

    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const successorRunId = `repair-${timestamp}-${crypto.randomBytes(3).toString('hex')}`;
    const successorIdentity = {
      runId: successorRunId,
      lineageId: identity.lineageId,
      predecessorRunId: String(predecessorRunId),
      successorOrdinal: Number(identity.successorOrdinal || 0) + 1,
      registeredAt: now.toISOString(),
      admissionRequestDigest: identity.admissionRequestDigest || null,
      admittedHead: identity.admittedHead || predecessor.verdict && predecessor.verdict.head || null,
      admittedRepo: identity.admittedRepo || predecessor.verdict && predecessor.verdict.repo || null,
    };
    const verdict = {
      kind: 'GateVerdict',
      version: 1,
      decision: 'ADMITTED',
      runId: successorRunId,
      repo: successorIdentity.admittedRepo,
      head: successorIdentity.admittedHead,
      taskPacket: predecessor.verdict && predecessor.verdict.taskPacket || null,
      requestDigest: identity.admissionRequestDigest || predecessor.verdict && predecessor.verdict.requestDigest || null,
      admittedAt: now.toISOString(),
      successor: true,
      predecessorRunId: String(predecessorRunId),
      lineageId: identity.lineageId,
    };
    const repairSpec = {
      version: 1,
      predecessorRunId: String(predecessorRunId),
      lineageId: identity.lineageId,
      successorOrdinal: successorIdentity.successorOrdinal,
      reasonCode: stop.reasonCode,
      step: stop.step,
      tasks: Array.isArray(stop.tasks) ? stop.tasks : [],
      evidence: Array.isArray(stop.evidence) ? stop.evidence : [],
      cause: eligibility.cause,
      fingerprint: eligibility.fingerprint,
      assignment: 'Repair only the recorded technical cause. Do not change product requirements, acceptance policy, or founder decisions.',
    };

    let committed;
    try {
      committed = registry.createSuccessor({
        predecessorRunId: String(predecessorRunId),
        successorRunId,
        verdict,
        lineage: successorIdentity,
        terminalStop: stop,
        terminalCause: eligibility.cause,
        terminalFingerprint: eligibility.fingerprint,
        repairSpec,
        charge: recoveryCharge(predecessorGuard),
        legacyLineageBudget: resolveLineageBudgets(config),
      });
    } catch (e) {
      if (e instanceof AdmissionRegistryBusyError) {
        refuse(e.code, e.message, { retryable: true, predecessorRunId: String(predecessorRunId) });
      }
      if (e instanceof LineageRegistryRefusalError || e && /^LINEAGE_|^RUN_/.test(e.code || '')) {
        refuse(e.code, e.message, e.detail || {});
      }
      refuse('ADMISSION_VALIDATOR_FAILURE', `successor registry transaction failed: ${e.message}`);
    }

    const committedRunId = committed.runId;
    const committedEntry = committed.run;
    const committedIdentity = committedEntry.lineage;
    try {
      if (!fs.existsSync(runGuard.fileFor(committedRunId))) {
        try {
          runGuard.register(committedRunId, { identity: committedIdentity });
        } catch (error) {
          // Two replaying processes can both observe the committed registry
          // child before either materialises its guard. RUN_GUARD_EXISTS means
          // the peer won that one-shot write; verify its exact identity below.
          if (!error || error.code !== 'RUN_GUARD_EXISTS') throw error;
        }
      }
      const materialized = runGuard.load(committedRunId);
      if (!materialized.identity
        || materialized.identity.lineageId !== committedIdentity.lineageId
        || materialized.identity.predecessorRunId !== committedIdentity.predecessorRunId
        || materialized.identity.successorOrdinal !== committedIdentity.successorOrdinal) {
        refuse('LINEAGE_IDENTITY_MISMATCH', `materialized guard identity disagrees for successor ${committedRunId}`);
      }
    } catch (e) {
      if (e instanceof AdmissionRefusedError) throw e;
      refuse(
        'SUCCESSOR_MATERIALIZATION_PENDING',
        `successor ${committedRunId} is committed but remains unlaunchable until its guard can be materialized: ${e.message}`,
        { runId: committedRunId, predecessorRunId: String(predecessorRunId) },
      );
    }

    return {
      runId: committedRunId,
      verdict: committedEntry.verdict,
      lineage: committedIdentity,
      lineageBudget: committed.lineage,
      repairSpec: committedEntry.repairSpec,
      replayed: committed.replayed === true,
    };
  }

  /**
   * The stored admission context for a REGISTERED run — what mutation routes
   * and backstops verify instead of a per-call RunRequest. Throws:
   *   RUN_NOT_ADMITTED   the id was never registered (a legacy or fabricated run)
   *   RUN_GUARD_MISSING  registered, but the guard file is gone — deleted
   *                      history, fail closed
   *   ADMISSION_VALIDATOR_FAILURE  the registry/guard exists but can't be read
   */
  function contextFor(runId) {
    let entry;
    try {
      entry = registry.getRun(runId);
    } catch (e) {
      refuse('ADMISSION_VALIDATOR_FAILURE', `admission registry unreadable: ${e.message}`);
    }
    if (!entry) {
      refuse('RUN_NOT_ADMITTED', `run ${runId} was never admitted — it has no registration and no server verdict`);
    }
    let guardDoc;
    try {
      guardDoc = runGuard.load(runId);
    } catch (e) {
      if (e && e.code === 'RUN_GUARD_MISSING') {
        refuse('RUN_GUARD_MISSING', e.message, { runId: String(runId) });
      }
      refuse('ADMISSION_VALIDATOR_FAILURE', `run guard for ${runId} cannot be verified: ${e.message}`);
    }
    const ctx = Object.freeze({
      runId: String(runId),
      verdict: entry.verdict,
      lineage: entry.lineage,
      registeredAt: entry.registeredAt,
      guardRevision: guardDoc.revision,
      lineageBudget: registry.read().lineages[entry.lineage.lineageId] || null,
    });
    CONTEXTS.add(ctx);
    return ctx;
  }

  /** Backstop form: throws unless the run has a verified stored admission. */
  function assertRunAdmitted(runId, where) {
    try {
      return contextFor(runId);
    } catch (e) {
      if (e instanceof AdmissionRefusedError) {
        e.message = `${where ? `${where}: ` : ''}${e.message}`;
        throw e;
      }
      throw e;
    }
  }

  /**
   * Read-only helper for clients BUILDING a RunRequest: the repo, the current
   * head, and the task packet this server would expect for a given start.
   * Resolution is best-effort convenience; admission re-verifies everything.
   */
  function describeContext({ type, input } = {}) {
    const repo = originRepo();
    const head = currentHead();
    const taskPacket = resolveTaskPacket({ type, input, head });
    return {
      version: RUNREQUEST_VERSION,
      maxValiditySeconds: MAX_VALIDITY_MS / 1000,
      repo,
      head,
      ...taskPacket,
    };
  }

  /** { taskPacket } or { taskPacket: null, taskPacketError } — never throws for resolution misses. */
  function resolveTaskPacket({ type, input, head }) {
    const relDocsPath = (config.docs_path || './docs').replace(/^\.\//, '');
    const tryPacket = (rel) => (rel && existsAtHead(head, rel) ? rel : null);

    if (type === 'bugfix' || type === 'review' || type === 'execution') {
      const { readItem, isValidId } = require('./backlog');
      const id = String(input || '').trim().toUpperCase().replace(/\s+/g, '-');
      if (type === 'bugfix') {
        const rel = path.posix.join(relDocsPath, 'backlog', `${id}.md`);
        const found = tryPacket(rel);
        return found ? { taskPacket: found }
          : { taskPacket: null, taskPacketError: `bug file ${rel} is not committed at the current head` };
      }
      // review / execution: the PRD the run works against.
      let prdRel = null;
      if (isValidId(id)) {
        try {
          const story = readItem(projectRoot, config.docs_path || './docs', id);
          if (story && typeof story.prd === 'string') prdRel = story.prd.trim();
        } catch (_) { /* fall through to directory scan */ }
      }
      if (!prdRel) {
        try {
          const prdsDir = path.join(projectRoot, relDocsPath, 'prds');
          const needle = String(input || '').toUpperCase().replace(/\s+/g, '-');
          const match = fs.existsSync(prdsDir) && fs.readdirSync(prdsDir).find((f) => f.toUpperCase().includes(needle));
          if (match) prdRel = path.posix.join(relDocsPath, 'prds', match);
        } catch (_) {}
      }
      const found = tryPacket(prdRel);
      return found ? { taskPacket: found }
        : { taskPacket: null, taskPacketError: prdRel
          ? `PRD ${prdRel} is not committed at the current head — commit it first`
          : `no PRD could be resolved for ${JSON.stringify(input)}` };
    }

    // kickoff / onboarding / execution-tab launches have no committed spec
    // document yet, by design. Until a later slice gives them a real committed
    // packet, the packet ANCHORS on a stable tracked file so the binding
    // "this request was made against this exact tree" still holds.
    const anchors = type === 'onboarding'
      ? [path.posix.join('docs', 'onboarding', 'inventory.json'), '.build-studio/config.yaml', 'README.md', path.posix.join(relDocsPath, 'vision.md')]
      : ['.build-studio/config.yaml', 'README.md', path.posix.join(relDocsPath, 'vision.md')];
    for (const rel of anchors) {
      const found = tryPacket(rel);
      if (found) return { taskPacket: found };
    }
    return {
      taskPacket: null,
      taskPacketError: `no tracked anchor file exists at the current head (tried: ${anchors.join(', ')}) — commit one of them first`,
    };
  }

  return {
    verifyRunRequest,
    admit,
    createSuccessor,
    inspectSuccessor,
    contextFor,
    assertRunAdmitted,
    describeContext,
    registry,
    runGuard,
  };
}

module.exports = {
  createAdmission,
  isAdmissionContext,
  AdmissionRefusedError,
  RUNREQUEST_VERSION,
  MAX_VALIDITY_MS,
  CLAIM_CLASSES,
  NON_AUTHORITATIVE_CLASSES,
};
