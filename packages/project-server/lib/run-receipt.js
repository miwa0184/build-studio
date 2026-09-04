'use strict';

/**
 * The factory-run receipt — machine evidence that ONE admitted run produced
 * ONE candidate that reached the A1c Egress Hold with its technical evidence
 * intact.
 *
 * What a receipt IS: a per-run, write-once, digest-bound record of the
 * admitted identity (registry + run aggregate), the committed task packet,
 * the exact candidate branch tip and its base, the server-run QA authority
 * and its artifact digests, every review verdict the durable run state
 * carries, and an allowlisted projection of the EFFECTIVELY RESOLVED
 * execution configuration.
 *
 * What a receipt is NOT: product or founder acceptance, a merge or push
 * authorization, or proof of who ran the factory. Its digests are integrity
 * bindings a later reader can recompute; they are not signatures, and this
 * module claims no authenticity the system cannot verify. This module itself
 * never reaches a remote or the default branch. A separate receipt-egress
 * authority may use a verified receipt to publish only its frozen branch,
 * open the exact PR and attach the exact-SHA receipt status.
 *
 * Finalization fails CLOSED on every missing, stale, contradictory, malformed
 * or ambiguous input, and a finalized receipt is immutable: a later
 * finalization of the same run either returns the byte-identical file or
 * refuses. Supersession is by a successor run's receipt naming this one in
 * `supersedes`, never by rewriting this file.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  safeRunId, digest, isObject, exactKeys, writeExclusive, createLeaseStore,
  assertAbsolutePathNoSymlink,
} = require('./authority-store');
const { createAdmissionRegistry } = require('./admission-registry');
const { isTechnicalStop } = require('./technical-stop');
const { isAgentVerdict, parseStructuredVerdict } = require('./feedback-provenance');
const qaSuite = require('./qa-suite-run');
const { LOCAL_MERGE_REMOVED, EGRESS_NOT_INSTALLED } = require('./egress-boundary');

const SCHEMA_VERSION = 1;
const CONFIG_PROJECTION_SCHEMA_VERSION = 1;
const RECEIPT_DIR = 'run-receipt';
const RECEIPT_KIND = 'FactoryRunReceipt';
const HOLD_STEP = 'merge_to_main';
const RECEIPT_WORKFLOW_TYPES = new Set(['execution', 'bugfix']);
const DEFAULT_BUGFIX_STEPS = ['task_execution', 'qa_validation', 'code_review', 'merge_to_main', 'capture_learnings'];
/** Owner-decided gates: 'skipped' is a person's decision, recorded, not evidence. */
const MANUAL_GATES = new Set(['merge_for_review', 'demo_review', 'device_testing', 'owner_consultations', 'review_cap_reached']);
/** Steps whose agent verdicts gate the receipt. coverage_matrix is advisory by design and is not read. */
const REVIEW_GATE_STEPS = ['qa_validation', 'code_review', 'ac_verification', 'security_audit', 'final_review'];
const DYNAMIC_EXECUTION_STEPS = new Set(['fix_plan', 'fix_execution', 'review_cap_reached']);
const RECEIPT_IGNORE_LINE = '.build-studio/run-receipt/';
const SHA_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]+$/;
const MAX_STRING = 200;

const CODES = Object.freeze({
  RUN_NOT_ADMITTED: 'RECEIPT_RUN_NOT_ADMITTED',
  RUN_UNVERIFIABLE: 'RECEIPT_RUN_UNVERIFIABLE',
  WORKFLOW_MISMATCH: 'RECEIPT_WORKFLOW_MISMATCH',
  WORKFLOW_TYPE: 'RECEIPT_WORKFLOW_TYPE',
  RUN_STOPPED: 'RECEIPT_RUN_STOPPED',
  ACCEPTANCE_GAP: 'RECEIPT_ACCEPTANCE_GAP',
  NOT_AT_EGRESS_HOLD: 'RECEIPT_NOT_AT_EGRESS_HOLD',
  HOLD_NOT_FROZEN: 'RECEIPT_HOLD_NOT_FROZEN',
  CANDIDATE_DRIFT: 'RECEIPT_CANDIDATE_DRIFT',
  CANDIDATE_UNRESOLVED: 'RECEIPT_CANDIDATE_UNRESOLVED',
  CANDIDATE_NOT_DESCENDED: 'RECEIPT_CANDIDATE_NOT_DESCENDED',
  PACKET_NOT_COMMITTED: 'RECEIPT_PACKET_NOT_COMMITTED',
  PACKET_MISMATCH: 'RECEIPT_PACKET_MISMATCH',
  QA_AUTHORITY_REFUSED: 'RECEIPT_QA_AUTHORITY_REFUSED',
  QA_ARTIFACT_MISMATCH: 'RECEIPT_QA_ARTIFACT_MISMATCH',
  QA_OPERATOR_OVERRIDE: 'RECEIPT_QA_OPERATOR_OVERRIDE',
  REVIEW_BLOCKING: 'RECEIPT_REVIEW_BLOCKING',
  EVIDENCE_AMBIGUOUS: 'RECEIPT_EVIDENCE_AMBIGUOUS',
  EVIDENCE_DRIFT: 'RECEIPT_EVIDENCE_DRIFT',
  SEQUENCE_MISMATCH: 'RECEIPT_SEQUENCE_MISMATCH',
  STORAGE_UNPROTECTED: 'RECEIPT_STORAGE_UNPROTECTED',
  PROJECTION_UNSAFE: 'RECEIPT_PROJECTION_UNSAFE',
  CONFLICT: 'RECEIPT_CONFLICT',
  UNREADABLE: 'RECEIPT_UNREADABLE',
  BUSY: 'RECEIPT_BUSY',
  NOT_FOUND: 'RECEIPT_NOT_FOUND',
  NO_ACTIVE_RUN: 'RECEIPT_NO_ACTIVE_RUN',
  BAD_REQUEST: 'RECEIPT_BAD_REQUEST',
});

class RunReceiptError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RunReceiptError';
    this.code = code;
    Object.assign(this, details);
  }
}

function refuse(code, message, details) {
  throw new RunReceiptError(code, message, details);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_STRING) : null;
}

/**
 * Effective string for the configuration projection, or null. Never
 * truncates: an over-long value must reach assertProjectionSafe intact so it
 * refuses (RECEIPT_PROJECTION_UNSAFE) instead of collapsing into the same
 * projection and configDigest as another value that shares its prefix.
 */
function projected(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function int(value) {
  return Number.isInteger(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

// guardRevision is an observation point, not evidence by itself. Excluding it
// lets a byte-identical receipt be replayed after unrelated counter churn,
// while identity.guardEvidenceDigest and the precommit re-gather bind every
// guard field that can change the receipt verdict.
const DIGEST_EXCLUDED = new Set(['guardRevision', 'evidenceDigest', 'finalizedAt', 'receiptDigest']);

function without(doc, keys) {
  const out = {};
  for (const [key, value] of Object.entries(doc)) if (!keys.has(key)) out[key] = value;
  return out;
}

/** Everything a later finalization must reproduce for the file to be "the same receipt". */
function evidenceDigestOf(doc) {
  return digest(without(doc, DIGEST_EXCLUDED));
}

/** The integrity binding over the whole record, timestamp included. */
function receiptDigestOf(doc) {
  return digest(without(doc, new Set(['receiptDigest'])));
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TOP_KEYS = [
  'schemaVersion', 'kind', 'runId', 'laneId', 'workflowType', 'guardRevision', 'identity', 'project', 'packet',
  'candidate', 'hold', 'sequence', 'qa', 'reviews', 'config', 'configDigest', 'productAcceptance',
  'mergeAuthorization', 'remoteEgress', 'supersedes', 'evidenceDigest', 'finalizedAt', 'receiptDigest',
];
const IDENTITY_KEYS = ['lineageId', 'predecessorRunId', 'successorOrdinal', 'admittedRepo', 'admittedHead', 'admissionRequestDigest', 'registeredAt', 'guardEvidenceDigest'];
const PACKET_KEYS = ['path', 'blobOid', 'contentSha256'];
const CANDIDATE_KEYS = ['branch', 'sha', 'heldSha', 'descendsFromAdmittedHead', 'base'];
const HOLD_KEYS = ['step', 'status', 'code', 'egress', 'skippedGates'];
const SEQUENCE_KEYS = ['steps', 'source', 'reviewGates', 'extraSteps'];
const QA_KEYS = [
  'mode', 'configured', 'code', 'expectedTestCount', 'actualTestCount', 'onlyTesting', 'parallelTesting',
  'appleResultAuthority', 'testLanguage', 'appleTotalTestCount', 'suiteFinishedAt', 'agentTriagedFailures', 'artifacts',
];
const QA_ARTIFACT_KEYS = ['logSha256', 'resultBundleManifestDigest', 'resultBundleFileCount', 'verifiedOnDisk'];
const REVIEW_KEYS = ['step', 'status', 'round', 'agents'];
const REVIEW_AGENT_KEYS = ['role', 'provenance', 'approved', 'blocking', 'medium', 'low', 'feedbackSha256'];
const CONFIG_KEYS = ['schemaVersion', 'preset', 'builderStrategy', 'cli', 'review', 'qa', 'egress', 'executedSteps'];
const EXECUTED_AGENT_KEYS = ['task', 'role', 'cli', 'model', 'modelSource', 'effort'];

function assertExact(value, keys, label) {
  if (!exactKeys(value, keys)) throw new Error(`${label} has missing or unknown fields`);
}

function assertString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a string`);
}

function assertBool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
}

function validateReceipt(doc, runId) {
  assertExact(doc, TOP_KEYS, 'receipt');
  if (doc.schemaVersion !== SCHEMA_VERSION || doc.kind !== RECEIPT_KIND) throw new Error('receipt schema or kind is unsupported');
  if (doc.runId !== runId) throw new Error('receipt run id does not match its file');
  assertString(doc.laneId, 'laneId');
  if (!RECEIPT_WORKFLOW_TYPES.has(doc.workflowType)) throw new Error('workflowType is invalid');
  if (!Number.isInteger(doc.guardRevision) || doc.guardRevision < 1) throw new Error('guardRevision is invalid');
  assertExact(doc.identity, IDENTITY_KEYS, 'identity');
  assertString(doc.identity.lineageId, 'identity.lineageId');
  assertString(doc.identity.predecessorRunId, 'identity.predecessorRunId', { nullable: true });
  if (!Number.isInteger(doc.identity.successorOrdinal) || doc.identity.successorOrdinal < 0) throw new Error('identity.successorOrdinal is invalid');
  assertString(doc.identity.admittedRepo, 'identity.admittedRepo');
  if (!/^[a-f0-9]{40,64}$/.test(doc.identity.admittedHead)) throw new Error('identity.admittedHead is invalid');
  if (!HEX64_RE.test(doc.identity.admissionRequestDigest)) throw new Error('identity.admissionRequestDigest is invalid');
  assertString(doc.identity.registeredAt, 'identity.registeredAt');
  if (!HEX64_RE.test(doc.identity.guardEvidenceDigest)) throw new Error('identity.guardEvidenceDigest is invalid');
  assertExact(doc.project, ['name'], 'project');
  assertString(doc.project.name, 'project.name');
  assertExact(doc.packet, PACKET_KEYS, 'packet');
  assertString(doc.packet.path, 'packet.path');
  if (!SHA_RE.test(doc.packet.blobOid) && !/^[0-9a-f]{64}$/.test(doc.packet.blobOid)) throw new Error('packet.blobOid is invalid');
  if (!HEX64_RE.test(doc.packet.contentSha256)) throw new Error('packet.contentSha256 is invalid');
  assertExact(doc.candidate, CANDIDATE_KEYS, 'candidate');
  assertString(doc.candidate.branch, 'candidate.branch');
  if (!SHA_RE.test(doc.candidate.sha)) throw new Error('candidate.sha is invalid');
  if (!SHA_RE.test(doc.candidate.heldSha) || doc.candidate.heldSha !== doc.candidate.sha) throw new Error('candidate.heldSha disagrees with candidate.sha');
  if (doc.candidate.descendsFromAdmittedHead !== true) throw new Error('candidate must descend from the admitted head');
  assertExact(doc.candidate.base, ['branch', 'sha'], 'candidate.base');
  assertString(doc.candidate.base.branch, 'candidate.base.branch');
  if (!SHA_RE.test(doc.candidate.base.sha)) throw new Error('candidate.base.sha is invalid');
  assertExact(doc.hold, HOLD_KEYS, 'hold');
  if (doc.hold.step !== HOLD_STEP || doc.hold.egress !== EGRESS_NOT_INSTALLED) throw new Error('hold is not the Egress Hold');
  if (doc.hold.status !== 'blocked') throw new Error('hold.status is invalid');
  if (doc.hold.code !== LOCAL_MERGE_REMOVED) throw new Error('hold.code is invalid');
  if (!Array.isArray(doc.hold.skippedGates) || doc.hold.skippedGates.some((g) => typeof g !== 'string')) throw new Error('hold.skippedGates is invalid');
  assertExact(doc.sequence, SEQUENCE_KEYS, 'sequence');
  if (!Array.isArray(doc.sequence.steps) || doc.sequence.steps.some((s) => typeof s !== 'string')) throw new Error('sequence.steps is invalid');
  if (new Set(doc.sequence.steps).size !== doc.sequence.steps.length || !doc.sequence.steps.includes(HOLD_STEP)) {
    throw new Error('sequence.steps must be unique and include the Egress Hold');
  }
  assertString(doc.sequence.source, 'sequence.source');
  if (!Array.isArray(doc.sequence.reviewGates) || doc.sequence.reviewGates.some((s) => typeof s !== 'string')) throw new Error('sequence.reviewGates is invalid');
  if (!Array.isArray(doc.sequence.extraSteps) || doc.sequence.extraSteps.some((s) => typeof s !== 'string')) throw new Error('sequence.extraSteps is invalid');
  const expectedReviewGates = doc.sequence.steps.filter((step) => REVIEW_GATE_STEPS.includes(step));
  if (doc.sequence.reviewGates.join('\0') !== expectedReviewGates.join('\0')) {
    throw new Error('sequence.reviewGates does not match sequence.steps');
  }
  if (new Set(doc.sequence.extraSteps).size !== doc.sequence.extraSteps.length
    || doc.sequence.extraSteps.some((step) => doc.sequence.steps.includes(step) || !DYNAMIC_EXECUTION_STEPS.has(step))) {
    throw new Error('sequence.extraSteps is invalid');
  }
  assertExact(doc.qa, QA_KEYS, 'qa');
  if (!['server_exact_count', 'server_apple_result', 'agent_verdict', 'not_in_sequence'].includes(doc.qa.mode)) throw new Error('qa.mode is invalid');
  assertBool(doc.qa.configured, 'qa.configured');
  assertBool(doc.qa.appleResultAuthority, 'qa.appleResultAuthority');
  assertBool(doc.qa.agentTriagedFailures, 'qa.agentTriagedFailures');
  if (doc.qa.artifacts !== null) {
    assertExact(doc.qa.artifacts, QA_ARTIFACT_KEYS, 'qa.artifacts');
    if (!HEX64_RE.test(doc.qa.artifacts.logSha256) || !HEX64_RE.test(doc.qa.artifacts.resultBundleManifestDigest)) throw new Error('qa.artifacts digests are invalid');
    if (!Number.isInteger(doc.qa.artifacts.resultBundleFileCount) || doc.qa.artifacts.resultBundleFileCount <= 0) throw new Error('qa.artifacts.resultBundleFileCount is invalid');
    if (doc.qa.artifacts.verifiedOnDisk !== true) throw new Error('qa.artifacts must have been verified on disk');
  }
  if (doc.qa.mode === 'server_apple_result' && doc.qa.artifacts === null) throw new Error('Apple result authority requires artifacts');
  if (!Array.isArray(doc.reviews)) throw new Error('reviews must be an array');
  if (doc.reviews.map((review) => review.step).join('\0') !== doc.sequence.reviewGates.join('\0')) {
    throw new Error('reviews do not match sequence.reviewGates');
  }
  for (const review of doc.reviews) {
    assertExact(review, REVIEW_KEYS, 'reviews[]');
    assertString(review.step, 'reviews[].step');
    assertString(review.status, 'reviews[].status');
    if (review.round !== null && !Number.isInteger(review.round)) throw new Error('reviews[].round is invalid');
    if (!Array.isArray(review.agents) || review.agents.length === 0) throw new Error('reviews[].agents must be non-empty');
    for (const agent of review.agents) {
      assertExact(agent, REVIEW_AGENT_KEYS, 'reviews[].agents[]');
      assertString(agent.role, 'reviews[].agents[].role');
      if (agent.provenance !== 'agent' || agent.approved !== true || agent.blocking !== 0) throw new Error('a finalized receipt cannot carry an unapproved or blocking verdict');
      if (!Number.isInteger(agent.medium) || !Number.isInteger(agent.low)) throw new Error('reviews[].agents[] counts are invalid');
      if (!HEX64_RE.test(agent.feedbackSha256)) throw new Error('reviews[].agents[].feedbackSha256 is invalid');
    }
  }
  assertExact(doc.config, CONFIG_KEYS, 'config');
  if (doc.config.schemaVersion !== CONFIG_PROJECTION_SCHEMA_VERSION) throw new Error('config projection schema is unsupported');
  if (!Array.isArray(doc.config.executedSteps)) throw new Error('config.executedSteps must be an array');
  for (const step of doc.config.executedSteps) {
    assertExact(step, ['step', 'agents'], 'config.executedSteps[]');
    for (const agent of step.agents) assertExact(agent, EXECUTED_AGENT_KEYS, 'config.executedSteps[].agents[]');
  }
  assertProjectionSafe(doc.config, 'config');
  if (doc.configDigest !== digest(doc.config)) throw new Error('configDigest does not match the projection');
  if (doc.productAcceptance !== false || doc.mergeAuthorization !== false || doc.remoteEgress !== 'disabled') {
    throw new Error('a receipt cannot claim acceptance, merge authority or remote egress');
  }
  if (doc.supersedes !== null && !HEX64_RE.test(doc.supersedes)) throw new Error('supersedes must be a receipt digest or null');
  assertString(doc.finalizedAt, 'finalizedAt');
  if (doc.evidenceDigest !== evidenceDigestOf(doc)) throw new Error('evidenceDigest does not match the receipt');
  if (doc.receiptDigest !== receiptDigestOf(doc)) throw new Error('receiptDigest does not match the receipt');
}

// ---------------------------------------------------------------------------
// Configuration projection
// ---------------------------------------------------------------------------

const FORBIDDEN_KEY_RE = /token|secret|password|api[_-]?key|\benv\b|environ|credential/i;

/** No absolute path, no over-long string, no secret-shaped key anywhere in a projection. */
function assertProjectionSafe(value, trail) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertProjectionSafe(item, `${trail}[${index}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY_RE.test(key)) throw new Error(`projection key ${trail}.${key} is not allowlisted`);
      assertProjectionSafe(item, `${trail}.${key}`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) throw new Error(`projection string ${trail} is too long`);
    if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('~')) {
      throw new Error(`projection string ${trail} looks like a local path`);
    }
    return;
  }
  if (value !== null && typeof value !== 'boolean' && typeof value !== 'number') {
    throw new Error(`projection value ${trail} has an unsupported type`);
  }
}

function executedAgent(agent, task) {
  return {
    task,
    role: projected(agent.role),
    cli: projected(agent.cli),
    model: projected(agent.model),
    modelSource: projected(agent.modelSource),
    effort: projected(agent.effort),
  };
}

/** Every agent the durable run state says was launched, by step. */
function executedSteps(wf) {
  const out = [];
  const steps = isObject(wf.steps) ? wf.steps : {};
  for (const [step, value] of Object.entries(steps)) {
    const agents = [];
    if (step === 'task_execution' && isObject(wf.taskExecution) && isObject(wf.taskExecution.taskStates)) {
      const indexes = Object.keys(wf.taskExecution.taskStates).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
      for (const index of indexes) {
        const taskState = wf.taskExecution.taskStates[String(index)];
        for (const agent of (isObject(taskState) && Array.isArray(taskState.agents) ? taskState.agents : [])) {
          if (isObject(agent) && typeof agent.role === 'string') agents.push(executedAgent(agent, index));
        }
      }
    }
    for (const agent of (isObject(value) && Array.isArray(value.agents) ? value.agents : [])) {
      if (isObject(agent) && typeof agent.role === 'string') agents.push(executedAgent(agent, null));
    }
    if (agents.length > 0) out.push({ step, agents });
  }
  return out;
}

function projectGroups(groups) {
  const out = {};
  if (!isObject(groups)) return out;
  for (const key of Object.keys(groups).sort()) {
    const slot = isObject(groups[key]) ? groups[key] : {};
    out[key] = { cli: projected(slot.cli), model: projected(slot.model), effort: projected(slot.effort) };
  }
  return out;
}

/**
 * The allowlisted projection of what the resolver returned. Built from the
 * RESOLVED config object only — never from config.yaml or local.json text —
 * so a key the resolver ignores is recorded as the value the server actually
 * runs with, and nothing outside the allowlist can reach the receipt.
 */
function buildConfigProjection(config, wf) {
  const cli = isObject(config.cli) ? config.cli : {};
  const qa = isObject(config.qa_validation) ? config.qa_validation : {};
  const simulator = isObject(config.simulator) ? config.simulator : {};
  const deployment = isObject(config.deployment) ? config.deployment : {};
  const parallel = simulator.parallel_testing;
  const projection = {
    schemaVersion: CONFIG_PROJECTION_SCHEMA_VERSION,
    preset: projected(config.preset),
    builderStrategy: projected(config.builder_strategy) || 'role',
    cli: {
      default: projected(cli.default) || 'claude',
      defaultModel: projected(cli.default_model),
      defaultEffort: projected(cli.default_effort),
      useGlobal: cli.use_global === true,
      groups: projectGroups(cli.groups),
    },
    review: {
      reviewMode: projected(config.review_mode),
      maxReviewRounds: int(config.max_review_rounds),
      codeReviewEffort: projected(isObject(config.code_review) ? config.code_review.effort : null),
      finalReviewEffort: projected(isObject(config.final_review) ? config.final_review.effort : null),
    },
    qa: {
      serverRunsSuite: qa.server_runs_suite !== false,
      strict: qa.strict !== false,
      honorCleanApproval: qa.honor_clean_approval !== false,
      scope: projected(qa.scope),
      expectedTestCount: int(qa.expected_test_count),
      onlyTesting: Array.isArray(qa.only_testing) ? qa.only_testing.map((t) => projected(t)).filter(Boolean) : null,
      appleResultAuthority: qa.apple_result_authority === true,
      testLanguage: projected(qa.test_language),
      simulatorParallelTesting: typeof parallel === 'boolean' || Number.isInteger(parallel) ? parallel : null,
      simulatorDestination: projected(simulator.destination),
    },
    egress: {
      policy: 'egress_hold',
      prEgress: 'disabled',
      localMerge: 'removed',
      remoteMutation: 'disabled',
      legacyAutoDeploy: deployment.auto_deploy === true,
      legacyAutoTag: deployment.auto_tag === true,
      versioning: projected(deployment.versioning),
    },
    executedSteps: executedSteps(wf),
  };
  assertProjectionSafe(projection, 'config');
  return { projection, configDigest: digest(projection) };
}

/**
 * Resolve the same base sequence the workflow engine uses and prove the
 * durable workflow still has that sequence. Dynamic repair steps are kept as
 * explicit extras; an unexpected gate is never silently treated as optional.
 */
function resolveSequence(config, wf) {
  const configured = isObject(config.workflow) ? config.workflow[wf.type] : null;
  let steps;
  let source;
  if (Array.isArray(configured) && configured.length > 0) {
    steps = configured.slice();
    source = `config.workflow.${wf.type}`;
  } else if (wf.type === 'bugfix') {
    steps = DEFAULT_BUGFIX_STEPS.slice();
    source = 'bugfix_default';
  } else {
    refuse(CODES.SEQUENCE_MISMATCH, `execution run ${wf.id} has no effectively resolved workflow sequence`, { runId: wf.id });
  }
  if (steps.some((step) => typeof step !== 'string' || step.length === 0)
    || new Set(steps).size !== steps.length
    || !steps.includes(HOLD_STEP)) {
    refuse(CODES.SEQUENCE_MISMATCH, `resolved ${wf.type} sequence is malformed or has no ${HOLD_STEP}`, { runId: wf.id, steps });
  }
  const actual = isObject(wf.steps) ? Object.keys(wf.steps) : [];
  const actualBase = actual.filter((step) => steps.includes(step));
  if (actualBase.join('\0') !== steps.join('\0')) {
    refuse(CODES.SEQUENCE_MISMATCH, `run ${wf.id} step order does not match the effectively resolved sequence`, { runId: wf.id, expectedSteps: steps, actualSteps: actualBase });
  }
  const extraSteps = actual.filter((step) => !steps.includes(step));
  const unsupported = extraSteps.filter((step) => !DYNAMIC_EXECUTION_STEPS.has(step));
  if (unsupported.length > 0) {
    refuse(CODES.SEQUENCE_MISMATCH, `run ${wf.id} carries step(s) outside the effectively resolved sequence: ${unsupported.join(', ')}`, { runId: wf.id, extraSteps: unsupported });
  }
  const reviewGates = steps.filter((step) => REVIEW_GATE_STEPS.includes(step));
  const holdIndex = steps.indexOf(HOLD_STEP);
  const reviewGatesAfterHold = reviewGates.filter((step) => steps.indexOf(step) > holdIndex);
  if (reviewGatesAfterHold.length > 0) {
    refuse(CODES.SEQUENCE_MISMATCH, `resolved review gate(s) occur after the ${HOLD_STEP} Egress Hold: ${reviewGatesAfterHold.join(', ')}`, {
      runId: wf.id, reviewGatesAfterHold,
    });
  }
  return { steps, source, reviewGates, extraSteps };
}

/** Only guard fields that can change receipt eligibility or identity. */
function guardEvidenceDigestOf(guard) {
  return digest({
    schemaVersion: guard.schemaVersion,
    runId: String(guard.runId),
    laneId: str(guard.laneId) || 'default',
    identity: clone(guard.identity),
    technicalStop: isObject(guard.technicalStop) ? clone(guard.technicalStop) : null,
    acceptanceGaps: Array.isArray(guard.acceptanceGaps) ? clone(guard.acceptanceGaps) : [],
    blockingTasks: Array.isArray(guard.blockingTasks) ? clone(guard.blockingTasks) : [],
  });
}

// ---------------------------------------------------------------------------
// Review evidence
// ---------------------------------------------------------------------------

/**
 * Every gate the resolved sequence requires must hold at least one agent verdict
 * (operator-generated feedback is diagnostic, never a verdict), every verdict
 * must parse, and none may be unapproved or carry a blocking finding.
 */
function collectReviewEvidence(wf, reviewGates = REVIEW_GATE_STEPS.filter((step) => isObject(wf.steps) && isObject(wf.steps[step]))) {
  const reviews = [];
  let agentTriagedFailures = false;
  const steps = isObject(wf.steps) ? wf.steps : {};
  for (const step of reviewGates) {
    const value = steps[step];
    if (!isObject(value)) {
      refuse(CODES.SEQUENCE_MISMATCH, `resolved review gate ${step} is missing from run ${wf.id}`, { runId: wf.id, step });
    }
    if (value.status !== 'completed') {
      refuse(CODES.EVIDENCE_AMBIGUOUS, `${step} is ${value.status || 'unknown'}, not completed; an unfinished review gate yields no receipt evidence`, {
        runId: wf.id, step, status: value.status || null,
      });
    }
    const agents = Array.isArray(value.agents) ? value.agents.filter(isObject) : [];
    const verdictAgents = agents.filter((a) => isAgentVerdict(a) && typeof a.feedback === 'string' && a.feedback.trim().length > 0);
    if (verdictAgents.length === 0) {
      refuse(CODES.EVIDENCE_AMBIGUOUS, `${step} carries no agent verdict (${agents.length} agent(s), none with agent-provenance feedback)`, { step });
    }
    const entries = [];
    for (const agent of verdictAgents) {
      const verdict = parseStructuredVerdict(agent.feedback);
      if (verdict.approved === null) {
        refuse(CODES.EVIDENCE_AMBIGUOUS, `${step}/${agent.role} feedback carries an ambiguous machine-readable verdict (${verdict.reason})`, { step, role: agent.role, verdictReason: verdict.reason });
      }
      if (verdict.approved !== true || (Number.isInteger(verdict.blocking) && verdict.blocking > 0)) {
        refuse(CODES.REVIEW_BLOCKING, `${step}/${agent.role} is ${verdict.approved ? 'approved' : 'not approved'} with ${Number.isInteger(verdict.blocking) ? verdict.blocking : 'unknown'} blocking finding(s)`, {
          step, role: agent.role, approved: verdict.approved, blocking: verdict.blocking,
        });
      }
      if (!Number.isInteger(verdict.blocking)) {
        refuse(CODES.EVIDENCE_AMBIGUOUS, `${step}/${agent.role} feedback carries no unambiguous blocking count`, { step, role: agent.role });
      }
      if (step === 'qa_validation' && verdict.failing > 0) agentTriagedFailures = true;
      entries.push({
        role: str(agent.role) || 'unknown',
        provenance: 'agent',
        approved: true,
        blocking: 0,
        medium: Number.isInteger(verdict.medium) ? verdict.medium : 0,
        low: Number.isInteger(verdict.low) ? verdict.low : 0,
        feedbackSha256: sha256(agent.feedback),
      });
    }
    reviews.push({ step, status: str(value.status) || 'unknown', round: int(wf.round), agents: entries });
  }
  return { reviews, agentTriagedFailures };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createRunReceiptStore({ statePath, lockTimeoutMs = 5000, lockPollMs = 5 } = {}) {
  if (!statePath) throw new Error('createRunReceiptStore: statePath is required');
  const dir = path.join(statePath, RECEIPT_DIR);
  function assertReceiptPathSafe(target, runId = null) {
    try {
      assertAbsolutePathNoSymlink(target);
    } catch (error) {
      throw new RunReceiptError(CODES.STORAGE_UNPROTECTED, `receipt authority path is unsafe: ${error.message}`, {
        runId: runId === null ? null : String(runId), cause: error.code || null,
      });
    }
  }
  const leases = createLeaseStore({
    locksDir: path.join(dir, '.locks'),
    lockTimeoutMs,
    lockPollMs,
    busyError: (runId) => new RunReceiptError(CODES.BUSY, `receipt for ${runId} is being finalized by another process`, { runId }),
    assertSafePath: (target) => assertReceiptPathSafe(target),
  });

  function fileFor(runId) {
    return path.join(dir, `${safeRunId(runId)}.json`);
  }

  /** The validated receipt for a run, or null when none was ever finalized. */
  function load(runId) {
    const id = String(runId);
    const file = fileFor(id);
    assertReceiptPathSafe(file, id);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw new RunReceiptError(CODES.UNREADABLE, `receipt for ${id} cannot be inspected: ${error.message}`, { runId: id, file });
    }
    if (!stat.isFile()) {
      throw new RunReceiptError(CODES.UNREADABLE, `receipt for ${id} exists but is not a regular file`, { runId: id, file });
    }
    let doc;
    try {
      assertReceiptPathSafe(file, id);
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      validateReceipt(doc, id);
    } catch (error) {
      throw new RunReceiptError(CODES.UNREADABLE, `receipt for ${id} exists but cannot be verified: ${error.message}`, { runId: id, file });
    }
    return clone(doc);
  }

  /** Run `fn` while holding the run's receipt lease. */
  function withLease(runId, fn) {
    const id = String(runId);
    assertReceiptPathSafe(path.join(dir, '.locks'), id);
    assertReceiptPathSafe(fileFor(id), id);
    const lease = leases.acquire(id);
    try {
      return fn();
    } finally {
      leases.release(lease);
    }
  }

  /**
   * Publish a receipt exactly once. `body` is the complete record minus
   * evidenceDigest/finalizedAt/receiptDigest. Returns the existing receipt
   * (created: false) when one with identical evidence is already on disk.
   */
  function finalize(runId, body, { now = () => new Date(), precommit = null } = {}) {
    const id = String(runId);
    return withLease(id, () => {
      // The caller's re-verification runs INSIDE the lease so nothing that
      // moved while evidence was gathered can be bound.
      if (typeof precommit === 'function') precommit();
      const existing = load(id);
      const evidenceDigest = evidenceDigestOf(body);
      if (existing) {
        if (existing.evidenceDigest === evidenceDigest) return { created: false, receipt: existing };
        refuse(CODES.CONFLICT, `run ${id} already has a finalized receipt bound to different evidence; a receipt is immutable and supersession is by successor run`, {
          runId: id, existingEvidenceDigest: existing.evidenceDigest, evidenceDigest,
        });
      }
      const draft = { ...body, evidenceDigest, finalizedAt: now().toISOString(), receiptDigest: null };
      draft.receiptDigest = receiptDigestOf(draft);
      validateReceipt(draft, id);
      assertReceiptPathSafe(fileFor(id), id);
      if (!writeExclusive(fileFor(id), draft)) {
        const raced = load(id);
        if (raced && raced.evidenceDigest === evidenceDigest) return { created: false, receipt: raced };
        refuse(CODES.CONFLICT, `run ${id} received a receipt from another writer while this one was being finalized`, { runId: id });
      }
      return { created: true, receipt: clone(draft) };
    });
  }

  return { dir, fileFor, load, finalize, withLease };
}

// ---------------------------------------------------------------------------
// Finalization authority
// ---------------------------------------------------------------------------

function defaultGit(projectRoot) {
  return (args) => execFileSync('git', ['--no-optional-locks', ...args], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
}

function text(output) {
  return Buffer.isBuffer(output) ? output.toString('utf8').trim() : String(output).trim();
}

function bytes(output) {
  return Buffer.isBuffer(output) ? output : Buffer.from(String(output), 'utf8');
}

function createRunReceiptAuthority({ config, state, qaGate, git, store, lockTimeoutMs, lockPollMs } = {}) {
  if (!config || !state || typeof state.loadWorkflow !== 'function') throw new Error('createRunReceiptAuthority: config and state are required');
  if (typeof qaGate !== 'function') throw new Error('createRunReceiptAuthority: qaGate is required');
  const statePath = config.statePath || path.join(config.projectRoot || process.cwd(), '.build-studio');
  const runGuard = state.runGuard;
  if (!runGuard) throw new Error('createRunReceiptAuthority: state must carry the run-guard authority seam');
  const registry = createAdmissionRegistry({ statePath });
  const receipts = store || createRunReceiptStore({ statePath, lockTimeoutMs, lockPollMs });
  const runGit = typeof git === 'function' ? git : defaultGit(config.projectRoot);

  // ---- git reads (all read-only; the structural test pins the subcommand set) ----

  function revParse(spec) {
    try {
      const out = text(runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', spec]));
      return out || null;
    } catch (_) {
      return null;
    }
  }

  function branchTip(branch) {
    if (typeof branch !== 'string' || !BRANCH_RE.test(branch)) return null;
    const sha = revParse(`refs/heads/${branch}^{commit}`);
    return sha && SHA_RE.test(sha) ? sha : null;
  }

  function receiptRelativePath(runId) {
    return path.posix.join('.build-studio', RECEIPT_DIR, `${safeRunId(runId)}.json`);
  }

  function receiptPathIsIgnored(runId) {
    try {
      runGit(['check-ignore', '-q', '--', receiptRelativePath(runId)]);
      return true;
    } catch (error) {
      if (error && error.status === 1) return false;
      refuse(CODES.STORAGE_UNPROTECTED, `git could not verify that the receipt path is ignored: ${error && error.message}`, {
        runId: String(runId), recovery: `add ${RECEIPT_IGNORE_LINE} to the project's ignore policy and retry`,
      });
    }
    return false;
  }

  function assertReceiptPathUntracked(runId) {
    let tracked;
    try {
      tracked = text(runGit(['ls-files', '--', path.posix.join('.build-studio', RECEIPT_DIR)]));
    } catch (error) {
      refuse(CODES.STORAGE_UNPROTECTED, `git could not verify that receipt storage is untracked: ${error && error.message}`, {
        runId: String(runId), recovery: `verify ${RECEIPT_IGNORE_LINE} and retry`,
      });
    }
    if (tracked) {
      refuse(CODES.STORAGE_UNPROTECTED, 'receipt storage already contains tracked files; immutable machine evidence cannot live in the product tree', {
        runId: String(runId), tracked: tracked.split(/\r?\n/).filter(Boolean),
        recovery: `remove the tracked receipt path from the index with git rm --cached and add ${RECEIPT_IGNORE_LINE} before retrying`,
      });
    }
  }

  /**
   * Existing managed projects predate the onboarding ignore rule. Protect
   * them in git's repo-local exclude file, never by editing a product file.
   * A higher-priority .gitignore negation still wins, so protection is read
   * back through git before any receipt directory or lease is created.
   */
  function ensureReceiptStorageProtected(runId) {
    assertReceiptPathUntracked(runId);
    if (receiptPathIsIgnored(runId)) return;
    let excludeRaw;
    try {
      excludeRaw = text(runGit(['rev-parse', '--git-path', 'info/exclude']));
    } catch (error) {
      refuse(CODES.STORAGE_UNPROTECTED, `git could not resolve its local exclude file: ${error && error.message}`, {
        runId: String(runId), recovery: `add ${RECEIPT_IGNORE_LINE} to the project's .gitignore and retry`,
      });
    }
    const excludeFile = path.isAbsolute(excludeRaw) ? excludeRaw : path.resolve(config.projectRoot, excludeRaw);
    let before = '';
    try {
      if (fs.existsSync(excludeFile)) {
        if (fs.lstatSync(excludeFile).isSymbolicLink()) throw new Error('exclude file is a symbolic link');
        before = fs.readFileSync(excludeFile, 'utf8');
      }
      const lines = before.split(/\r?\n/);
      if (!lines.includes(RECEIPT_IGNORE_LINE)) {
        fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
        const prefix = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
        const fd = fs.openSync(excludeFile, 'a', 0o600);
        try {
          fs.writeFileSync(fd, `${prefix}${RECEIPT_IGNORE_LINE}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (error) {
      refuse(CODES.STORAGE_UNPROTECTED, `receipt storage could not be protected in git's local exclude file: ${error.message}`, {
        runId: String(runId), recovery: `add ${RECEIPT_IGNORE_LINE} to the project's .gitignore and retry`,
      });
    }
    if (!receiptPathIsIgnored(runId)) {
      // Roll back our append only when no concurrent writer changed the file.
      try {
        const current = fs.readFileSync(excludeFile, 'utf8');
        const prefix = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
        if (current === `${before}${prefix}${RECEIPT_IGNORE_LINE}\n`) fs.writeFileSync(excludeFile, before);
      } catch (_) {}
      refuse(CODES.STORAGE_UNPROTECTED, `${RECEIPT_IGNORE_LINE} remains unignored after applying the repo-local exclude rule`, {
        runId: String(runId), recovery: `remove any negating ignore rule, or add ${RECEIPT_IGNORE_LINE} to the project's .gitignore, then retry`,
      });
    }
    assertReceiptPathUntracked(runId);
  }

  function isAncestor(ancestor, descendant) {
    try {
      runGit(['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant]);
      return true;
    } catch (error) {
      if (error && error.status === 1) return false;
      refuse(CODES.CANDIDATE_UNRESOLVED, `ancestry of ${descendant} could not be resolved: ${error && error.message}`);
    }
    return false;
  }

  function committedBlob(sha, relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0 || path.isAbsolute(relPath) || relPath.split('/').includes('..')) return null;
    const oid = revParse(`${sha}:${relPath}`);
    if (!oid) return null;
    let content;
    try {
      content = bytes(runGit(['cat-file', 'blob', oid]));
    } catch (_) {
      return null;
    }
    return { blobOid: oid, contentSha256: sha256(content) };
  }

  // ---- evidence gathering ----

  function loadAdmitted(wf) {
    let guard;
    try {
      guard = runGuard.load(wf.id);
    } catch (error) {
      refuse(CODES.RUN_UNVERIFIABLE, `run ${wf.id} cannot be verified against its run aggregate: ${error.message}`, { runId: wf.id, cause: error.code || null });
    }
    if (guard.schemaVersion !== 2 || !isObject(guard.identity)) {
      refuse(CODES.RUN_NOT_ADMITTED, `run ${wf.id} has no admitted root identity; a receipt needs a server-admitted run`, { runId: wf.id });
    }
    let entry;
    try {
      entry = registry.getRun(wf.id);
    } catch (error) {
      refuse(CODES.RUN_UNVERIFIABLE, `admission registry unreadable: ${error.message}`, { runId: wf.id });
    }
    if (!entry || !isObject(entry.verdict) || entry.verdict.decision !== 'ADMITTED') {
      refuse(CODES.RUN_NOT_ADMITTED, `run ${wf.id} is not registered as admitted`, { runId: wf.id });
    }
    const identity = guard.identity;
    if (isObject(wf.admission)) {
      if (wf.admission.runId !== wf.id
        || wf.admission.requestDigest !== identity.admissionRequestDigest
        || wf.admission.admittedHead !== identity.admittedHead) {
        refuse(CODES.WORKFLOW_MISMATCH, `workflow ${wf.id} carries an admission record that disagrees with its run aggregate`, { runId: wf.id });
      }
    }
    return { guard, entry };
  }

  function assertNotStopped(guard, wf) {
    if (isTechnicalStop(guard.technicalStop) || isTechnicalStop(wf.technicalStop) || wf.currentStep === 'technical_stop') {
      const stop = guard.technicalStop || wf.technicalStop || {};
      refuse(CODES.RUN_STOPPED, `run ${wf.id} is technically stopped (${stop.reasonCode || 'TECHNICAL_STOP'}); a stopped run yields no receipt`, { runId: wf.id, reasonCode: stop.reasonCode || null });
    }
    if (Array.isArray(guard.acceptanceGaps) && guard.acceptanceGaps.length > 0) {
      refuse(CODES.ACCEPTANCE_GAP, `run ${wf.id} carries ${guard.acceptanceGaps.length} unresolved acceptance gap(s)`, { runId: wf.id, gaps: clone(guard.acceptanceGaps) });
    }
    if (Array.isArray(guard.blockingTasks) && guard.blockingTasks.length > 0) {
      refuse(CODES.RUN_STOPPED, `run ${wf.id} carries blocking tasks`, { runId: wf.id });
    }
  }

  function assertAtHold(wf) {
    if (wf.currentStep !== HOLD_STEP) {
      refuse(CODES.NOT_AT_EGRESS_HOLD, `run ${wf.id} is at ${wf.currentStep}, not at the ${HOLD_STEP} Egress Hold`, { runId: wf.id, currentStep: wf.currentStep });
    }
    const steps = isObject(wf.steps) ? wf.steps : {};
    if (!isObject(steps[HOLD_STEP])) refuse(CODES.NOT_AT_EGRESS_HOLD, `run ${wf.id} has no ${HOLD_STEP} step`, { runId: wf.id });
    const skippedGates = [];
    for (const [step, value] of Object.entries(steps)) {
      if (step === HOLD_STEP) break;
      const status = isObject(value) ? value.status : null;
      if (status === 'completed') continue;
      if (status === 'skipped' && MANUAL_GATES.has(step)) { skippedGates.push(step); continue; }
      refuse(CODES.NOT_AT_EGRESS_HOLD, `step ${step} is ${status || 'unknown'}; every step before the hold must be completed (or an owner-skipped gate)`, { runId: wf.id, step, status });
    }
    const hold = steps[HOLD_STEP];
    if (hold.status !== 'blocked' || hold.code !== LOCAL_MERGE_REMOVED) {
      refuse(CODES.HOLD_NOT_FROZEN, `${HOLD_STEP} has not reached the finalized Egress Hold`, {
        runId: wf.id, status: hold.status || null, holdCode: hold.code || null,
      });
    }
    if (typeof hold.candidateSha !== 'string' || !SHA_RE.test(hold.candidateSha)) {
      refuse(CODES.HOLD_NOT_FROZEN, `${HOLD_STEP} carries no valid candidateSha frozen by the Egress Hold`, {
        runId: wf.id, candidateSha: hold.candidateSha || null,
      });
    }
    let durableHold;
    try {
      durableHold = typeof state.authoritativeEgressHold === 'function'
        ? state.authoritativeEgressHold(wf.id)
        : null;
    } catch (error) {
      refuse(CODES.RUN_UNVERIFIABLE, `run ${wf.id} cannot verify its durable Egress Hold authority: ${error.message}`, {
        runId: wf.id,
        cause: error.code || null,
      });
    }
    if (!isObject(durableHold)) {
      refuse(CODES.HOLD_NOT_FROZEN, `${HOLD_STEP} has no durable Egress Hold authority`, { runId: wf.id });
    }
    for (const field of ['candidateBranch', 'candidateSha', 'defaultBranch']) {
      if (durableHold[field] !== hold[field]) {
        refuse(CODES.CANDIDATE_DRIFT, `${HOLD_STEP} disagrees with its durable Egress Hold authority on ${field}`, {
          runId: wf.id,
          field,
          heldValue: hold[field] || null,
          authoritativeValue: durableHold[field] || null,
        });
      }
    }
    const workflowBranch = typeof wf.branch === 'string' && wf.branch ? wf.branch : wf.reviewBranch;
    if (hold.candidateBranch !== workflowBranch) {
      refuse(CODES.CANDIDATE_DRIFT, `${HOLD_STEP} froze branch ${hold.candidateBranch || 'nothing'}, not workflow candidate ${workflowBranch || 'nothing'}`, {
        runId: wf.id, heldBranch: hold.candidateBranch || null, candidateBranch: workflowBranch || null,
      });
    }
    const workflowDefault = typeof wf.defaultBranch === 'string' && wf.defaultBranch ? wf.defaultBranch : 'main';
    if (hold.defaultBranch !== workflowDefault) {
      refuse(CODES.CANDIDATE_DRIFT, `${HOLD_STEP} froze default branch ${hold.defaultBranch || 'nothing'}, not ${workflowDefault}`, {
        runId: wf.id, heldDefaultBranch: hold.defaultBranch || null, defaultBranch: workflowDefault,
      });
    }
    const taskStates = isObject(wf.taskExecution) && isObject(wf.taskExecution.taskStates) ? wf.taskExecution.taskStates : {};
    for (const [index, taskState] of Object.entries(taskStates)) {
      const status = isObject(taskState) ? taskState.status : null;
      if (status !== 'done') {
        refuse(status === 'blocked' || status === 'skipped' ? CODES.ACCEPTANCE_GAP : CODES.NOT_AT_EGRESS_HOLD,
          `task ${index} is ${status || 'unknown'}, not done`, { runId: wf.id, taskIndex: Number(index), status });
      }
      if (taskState.acceptanceCovered === false) {
        refuse(CODES.ACCEPTANCE_GAP, `task ${index} has no acceptance coverage`, { runId: wf.id, taskIndex: Number(index) });
      }
    }
    return {
      hold: {
        step: HOLD_STEP,
        status: 'blocked',
        code: LOCAL_MERGE_REMOVED,
        egress: EGRESS_NOT_INSTALLED,
        skippedGates,
      },
      heldSha: hold.candidateSha,
    };
  }

  function resolveCandidate(wf, identity, heldSha, expectedSha) {
    const branch = typeof wf.branch === 'string' && wf.branch ? wf.branch : wf.reviewBranch;
    if (typeof branch !== 'string' || !BRANCH_RE.test(branch)) {
      refuse(CODES.CANDIDATE_UNRESOLVED, `run ${wf.id} names no candidate branch`, { runId: wf.id });
    }
    const sha = branchTip(branch);
    if (!sha) refuse(CODES.CANDIDATE_UNRESOLVED, `candidate branch ${branch} does not resolve to a commit`, { runId: wf.id, branch });
    if (expectedSha !== undefined && expectedSha !== sha) {
      refuse(CODES.CANDIDATE_DRIFT, `candidate ${branch} is at ${sha}, not at the stated ${String(expectedSha).slice(0, 40)}`, { runId: wf.id, branch, candidateSha: sha, expectedSha });
    }
    if (heldSha && heldSha !== sha) {
      refuse(CODES.CANDIDATE_DRIFT, `candidate ${branch} moved from the held ${heldSha} to ${sha} after reaching the Egress Hold`, { runId: wf.id, branch, candidateSha: sha, heldSha });
    }
    if (!isAncestor(identity.admittedHead, sha)) {
      refuse(CODES.CANDIDATE_NOT_DESCENDED, `candidate ${sha} does not descend from the admitted head ${identity.admittedHead}`, { runId: wf.id, candidateSha: sha, admittedHead: identity.admittedHead });
    }
    const baseBranch = typeof wf.defaultBranch === 'string' && BRANCH_RE.test(wf.defaultBranch) ? wf.defaultBranch : 'main';
    const baseSha = branchTip(baseBranch);
    if (!baseSha) refuse(CODES.CANDIDATE_UNRESOLVED, `default branch ${baseBranch} does not resolve to a commit`, { runId: wf.id, branch: baseBranch });
    return { branch, sha, heldSha, descendsFromAdmittedHead: true, base: { branch: baseBranch, sha: baseSha } };
  }

  function resolvePacket(wf, entry, candidateSha) {
    const packetPath = typeof wf.prdPath === 'string' ? wf.prdPath : null;
    const admitted = entry.verdict.taskPacket;
    if (typeof admitted !== 'string' || !admitted) {
      refuse(CODES.PACKET_MISMATCH, `run ${wf.id} was admitted without a task packet`, { runId: wf.id });
    }
    if (!packetPath) refuse(CODES.PACKET_NOT_COMMITTED, `run ${wf.id} names no task packet`, { runId: wf.id });
    if (packetPath !== admitted) {
      refuse(CODES.PACKET_MISMATCH, `workflow packet ${packetPath} is not the admitted task packet ${admitted}`, { runId: wf.id, packetPath, admittedPacket: admitted });
    }
    const blob = committedBlob(candidateSha, packetPath);
    if (!blob) refuse(CODES.PACKET_NOT_COMMITTED, `task packet ${packetPath} is not committed at candidate ${candidateSha}`, { runId: wf.id, packetPath, candidateSha });
    return { path: packetPath, ...blob };
  }

  function resolveQa(wf, agentTriagedFailures, sequence) {
    if (!sequence.steps.includes('qa_validation')) {
      return {
        mode: 'not_in_sequence', configured: false, code: null, expectedTestCount: null, actualTestCount: null,
        onlyTesting: null, parallelTesting: null, appleResultAuthority: false, testLanguage: null,
        appleTotalTestCount: null, suiteFinishedAt: null, agentTriagedFailures: false, artifacts: null,
      };
    }
    const step = isObject(wf.steps) ? wf.steps.qa_validation : null;
    const verdict = qaGate(step, config);
    if (!isObject(verdict)) refuse(CODES.QA_AUTHORITY_REFUSED, 'the QA gate returned no verdict', { runId: wf.id });
    if (verdict.configured !== true) {
      if (!isObject(step)) refuse(CODES.QA_AUTHORITY_REFUSED, `run ${wf.id} carries no qa_validation step`, { runId: wf.id, qaCode: 'QA_STEP_MISSING' });
      const overrides = Array.isArray(step.overrides) ? step.overrides : [];
      const operator = overrides.find((o) => !(isObject(o) && typeof o.reason === 'string' && o.reason.startsWith('honor_clean_approval:')));
      if (operator) {
        refuse(CODES.QA_OPERATOR_OVERRIDE, 'qa_validation was approved through an operator override; that is a decision, not technical evidence', { runId: wf.id, override: clone(operator) });
      }
      return {
        mode: 'agent_verdict', configured: false, code: null, expectedTestCount: null, actualTestCount: null,
        onlyTesting: null, parallelTesting: null, appleResultAuthority: false, testLanguage: null,
        appleTotalTestCount: null, suiteFinishedAt: null, agentTriagedFailures, artifacts: null,
      };
    }
    if (verdict.blocked !== false) {
      refuse(CODES.QA_AUTHORITY_REFUSED, `server QA authority refuses: ${verdict.code} — ${verdict.reason || 'no detail'}`, { runId: wf.id, qaCode: verdict.code, reason: verdict.reason || null });
    }
    const apple = verdict.appleResultAuthority === true;
    if (verdict.code !== (apple ? 'QA_APPLE_RESULT_VERIFIED' : 'QA_EXACT_COUNT_VERIFIED')) {
      refuse(CODES.QA_AUTHORITY_REFUSED, `server QA authority is ${verdict.code}, not a verified verdict`, { runId: wf.id, qaCode: verdict.code });
    }
    const run = step.suiteRun;
    let artifacts = null;
    if (apple) {
      const recorded = isObject(run.artifacts) ? run.artifacts : null;
      const log = recorded && isObject(recorded.log) ? recorded.log : {};
      const bundle = recorded && isObject(recorded.resultBundle) ? recorded.resultBundle : {};
      if (!recorded || recorded.status !== 'complete'
        || verdict.logSha256 !== log.sha256 || verdict.resultBundleManifestDigest !== bundle.manifestDigest) {
        refuse(CODES.QA_ARTIFACT_MISMATCH, 'the persisted QA authority and its artifact record disagree about the evidence digests', { runId: wf.id, qaCode: 'QA_ARTIFACT_RECORD_INCONSISTENT' });
      }
      let onDisk;
      try {
        onDisk = qaSuite.digestNativeArtifacts({ logPath: run.logPath, resultBundlePath: bundle.path });
      } catch (error) {
        refuse(CODES.QA_ARTIFACT_MISMATCH, `native QA artifacts cannot be re-digested: ${error.message}`, { runId: wf.id, qaCode: 'QA_ARTIFACTS_UNAVAILABLE' });
      }
      if (onDisk.logSha256 !== verdict.logSha256 || onDisk.manifestDigest !== verdict.resultBundleManifestDigest || onDisk.fileCount !== bundle.fileCount) {
        refuse(CODES.QA_ARTIFACT_MISMATCH, 'native QA artifacts on disk no longer match the digests the authority was verified against', { runId: wf.id, qaCode: 'QA_ARTIFACT_DIGEST_DRIFT' });
      }
      artifacts = {
        logSha256: verdict.logSha256,
        resultBundleManifestDigest: verdict.resultBundleManifestDigest,
        resultBundleFileCount: bundle.fileCount,
        verifiedOnDisk: true,
      };
    }
    return {
      mode: apple ? 'server_apple_result' : 'server_exact_count',
      configured: true,
      code: verdict.code,
      expectedTestCount: int(verdict.expectedTestCount),
      actualTestCount: int(verdict.actualTestCount),
      onlyTesting: Array.isArray(verdict.onlyTesting) ? verdict.onlyTesting.map(String) : null,
      parallelTesting: typeof verdict.parallelTesting === 'boolean' || Number.isInteger(verdict.parallelTesting) ? verdict.parallelTesting : null,
      appleResultAuthority: apple,
      testLanguage: str(verdict.testLanguage),
      appleTotalTestCount: int(verdict.appleTotalTestCount),
      suiteFinishedAt: str(run && run.finishedAt),
      agentTriagedFailures,
      artifacts,
    };
  }

  function activeWorkflow(runId) {
    const wf = state.loadWorkflow();
    if (!wf || !wf.id) refuse(CODES.NO_ACTIVE_RUN, 'there is no active workflow run to finalize a receipt for');
    if (runId !== undefined && String(runId) !== String(wf.id)) {
      refuse(CODES.NO_ACTIVE_RUN, `run ${runId} is not the active workflow run`, { runId: String(runId), activeRunId: String(wf.id) });
    }
    return wf;
  }

  function gatherReceiptBody(wf, expectedSha) {
    if (!RECEIPT_WORKFLOW_TYPES.has(wf.type)) {
      refuse(CODES.WORKFLOW_TYPE, `a ${wf.type} run produces no candidate; receipts exist for execution and bugfix runs`, { runId: wf.id, type: wf.type });
    }
    if (wf.guardUnverifiable) {
      refuse(CODES.RUN_UNVERIFIABLE, `run ${wf.id} guard is unverifiable: ${wf.guardUnverifiable.error}`, { runId: wf.id, cause: wf.guardUnverifiable.code });
    }
    const { guard, entry } = loadAdmitted(wf);
    assertNotStopped(guard, wf);
    const { hold, heldSha } = assertAtHold(wf);
    const sequence = resolveSequence(config, wf);
    const candidate = resolveCandidate(wf, guard.identity, heldSha, expectedSha);
    const packet = resolvePacket(wf, entry, candidate.sha);
    const { reviews, agentTriagedFailures } = collectReviewEvidence(wf, sequence.reviewGates);
    const qa = resolveQa(wf, agentTriagedFailures, sequence);
    let projection;
    try {
      projection = buildConfigProjection(config, wf);
    } catch (error) {
      refuse(CODES.PROJECTION_UNSAFE, `the effective configuration could not be projected safely: ${error.message}`, { runId: wf.id });
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: RECEIPT_KIND,
      runId: String(wf.id),
      laneId: str(guard.laneId) || 'default',
      workflowType: wf.type,
      guardRevision: guard.revision,
      identity: {
        lineageId: guard.identity.lineageId,
        predecessorRunId: guard.identity.predecessorRunId,
        successorOrdinal: guard.identity.successorOrdinal,
        admittedRepo: guard.identity.admittedRepo,
        admittedHead: guard.identity.admittedHead,
        admissionRequestDigest: guard.identity.admissionRequestDigest,
        registeredAt: guard.identity.registeredAt,
        guardEvidenceDigest: guardEvidenceDigestOf(guard),
      },
      project: { name: str(config.name) || 'unnamed' },
      packet,
      candidate,
      hold,
      sequence,
      qa,
      reviews,
      config: projection.projection,
      configDigest: projection.configDigest,
      productAcceptance: false,
      mergeAuthorization: false,
      remoteEgress: 'disabled',
      supersedes: null,
    };
  }

  /**
   * Finalize the active run's receipt. Every check is against durable server
   * state; the only caller input is an optional expected candidate sha, which
   * can make finalization refuse but never make it succeed.
   */
  function finalize({ candidateSha: expectedSha } = {}) {
    if (expectedSha !== undefined && (typeof expectedSha !== 'string' || !SHA_RE.test(expectedSha))) {
      refuse(CODES.CANDIDATE_DRIFT, 'candidateSha must be a 40-hex commit sha when given', { expectedSha: String(expectedSha).slice(0, 80) });
    }
    const wf = activeWorkflow();
    // An existing unreadable receipt is evidence of tampering or corruption;
    // it is never repaired or replaced.
    receipts.load(wf.id);
    const body = gatherReceiptBody(wf, expectedSha);
    // Only a fully eligible run may cause the repo-local exclude migration.
    // This keeps rejected legacy/early runs entirely side-effect free.
    ensureReceiptStorageProtected(wf.id);
    // Commit point: under the receipt lease, the terminal truth and the
    // candidate tip are read AGAIN so nothing that moved while evidence was
    // being gathered can be bound.
    return receipts.finalize(wf.id, body, {
      precommit: () => {
        assertReceiptPathUntracked(wf.id);
        if (!receiptPathIsIgnored(wf.id)) {
          refuse(CODES.STORAGE_UNPROTECTED, 'receipt storage lost its ignore protection while finalization was in progress', {
            runId: wf.id, recovery: `restore ${RECEIPT_IGNORE_LINE} and retry`,
          });
        }
        const latestWorkflow = activeWorkflow(wf.id);
        const latestBody = gatherReceiptBody(latestWorkflow, body.candidate.sha);
        if (evidenceDigestOf(latestBody) !== evidenceDigestOf(body)) {
          const changed = Object.keys(body).filter((key) => key !== 'guardRevision' && digest(body[key]) !== digest(latestBody[key]));
          refuse(CODES.EVIDENCE_DRIFT, `run ${wf.id} material evidence changed while its receipt was being finalized`, {
            runId: wf.id, changed,
          });
        }
      },
    });
  }

  /** The validated receipt for a run (default: the active run), or null. */
  function read(runId) {
    let id = runId;
    if (id === undefined) {
      const wf = state.loadWorkflow();
      if (!wf || !wf.id) return null;
      id = wf.id;
    }
    return receipts.load(String(id));
  }

  /** The receipt plus whether the candidate branch still sits at the bound sha. */
  function verify(runId) {
    const receipt = read(runId);
    if (!receipt) return null;
    const tip = branchTip(receipt.candidate.branch);
    return {
      receipt,
      verification: {
        candidateBranch: receipt.candidate.branch,
        candidateSha: tip,
        matchesReceipt: tip === receipt.candidate.sha,
        checkedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Re-gather the ACTIVE run's material receipt evidence immediately before
   * an external delivery boundary. This is intentionally read-only and is
   * called while the receipt lease is held by the egress authority.
   */
  function verifyForDelivery({ runId, candidateSha, receiptDigest } = {}) {
    if (typeof runId !== 'string' || !runId
      || typeof candidateSha !== 'string' || !SHA_RE.test(candidateSha)
      || typeof receiptDigest !== 'string' || !HEX64_RE.test(receiptDigest)) {
      refuse(CODES.BAD_REQUEST, 'delivery verification requires runId, candidateSha, and receiptDigest');
    }
    const wf = activeWorkflow(runId);
    const receipt = receipts.load(runId);
    if (!receipt || receipt.receiptDigest !== receiptDigest || receipt.candidate.sha !== candidateSha) {
      refuse(CODES.EVIDENCE_DRIFT, `run ${runId} no longer matches its delivery receipt`, { runId });
    }
    const latestBody = gatherReceiptBody(wf, candidateSha);
    if (evidenceDigestOf(latestBody) !== receipt.evidenceDigest) {
      refuse(CODES.EVIDENCE_DRIFT, `run ${runId} material evidence changed before delivery`, { runId });
    }
    return {
      receipt,
      verification: {
        active: true,
        candidateBranch: receipt.candidate.branch,
        candidateSha,
        matchesReceipt: true,
        checkedAt: new Date().toISOString(),
      },
    };
  }

  return { finalize, read, verify, verifyForDelivery, store: receipts };
}

module.exports = {
  SCHEMA_VERSION,
  CONFIG_PROJECTION_SCHEMA_VERSION,
  RECEIPT_DIR,
  RECEIPT_KIND,
  CODES,
  RunReceiptError,
  createRunReceiptStore,
  createRunReceiptAuthority,
  buildConfigProjection,
  collectReviewEvidence,
  validateReceipt,
  evidenceDigestOf,
  receiptDigestOf,
};
