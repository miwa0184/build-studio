'use strict';

/**
 * Durable authority for one admitted root run.
 *
 * Schema 2 deliberately puts the run's identity, non-renewable counters,
 * terminal cause and the single bounded continuation envelope in one file.
 * The immutable Egress Hold identity is a separately digested write-once file
 * in the same ignored authority directory, registered monotonically by the
 * aggregate before publication so absence or deletion fails closed.
 * The admission registry is only the root-registration cross-link; it is not a
 * second lineage store. Schema 1 remains readable for historical rendering and
 * cancellation, but no authority mutation may upgrade or rewrite it.
 */

const fs = require('fs');
const path = require('path');
const { REASON_CODES } = require('./technical-stop');
const {
  safeRunId,
  digest,
  isObject,
  exactKeys,
  writeAtomic,
  writeExclusive,
  createLeaseStore,
} = require('./authority-store');

const LEGACY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 2;
const GUARD_DIR = 'run-guard';
const EGRESS_HOLD_SUFFIX = '.egress-hold.json';
const EGRESS_HOLD_COUNTER = 'egress_hold_authority';
const REPAIR_STATES = Object.freeze({ ACTIVE_ROOT: 'ACTIVE_ROOT', STOPPED: 'STOPPED' });
const WORKFLOW_TYPES = new Set(['review', 'execution', 'kickoff', 'onboarding', 'bugfix']);
const TECHNICAL_REASON_CODES = new Set(Object.values(REASON_CODES));

class RunGuardError extends Error {
  constructor(name, code, message, details = {}) {
    super(message);
    this.name = name;
    this.code = code;
    Object.assign(this, details);
  }
}

class RunGuardConflictError extends RunGuardError {
  constructor(message, details = {}) {
    super('RunGuardConflictError', 'RUN_GUARD_CONFLICT', message, details);
  }
}

class RunGuardCorruptError extends RunGuardError {
  constructor(message, details = {}) {
    super('RunGuardCorruptError', 'RUN_GUARD_UNREADABLE', message, details);
  }
}

class RunGuardMissingError extends RunGuardError {
  constructor(message, details = {}) {
    super('RunGuardMissingError', 'RUN_GUARD_MISSING', message, details);
  }
}

class RunGuardExistsError extends RunGuardError {
  constructor(message, details = {}) {
    super('RunGuardExistsError', 'RUN_GUARD_EXISTS', message, details);
  }
}

class RunGuardBusyError extends RunGuardError {
  constructor(message, details = {}) {
    super('RunGuardBusyError', 'RUN_GUARD_BUSY', message, details);
  }
}

class RunGuardLegacyReadOnlyError extends RunGuardError {
  constructor(message, details = {}) {
    super('RunGuardLegacyReadOnlyError', 'LEGACY_READ_ONLY', message, details);
  }
}

class RunGuardTerminalError extends RunGuardError {
  constructor(message, details = {}) {
    super('RunGuardTerminalError', 'RUN_GUARD_TERMINAL', message, details);
  }
}

class RunGuardRegistryMismatchError extends RunGuardError {
  constructor(message, details = {}) {
    super('RunGuardRegistryMismatchError', 'RUN_GUARD_REGISTRY_MISMATCH', message, details);
  }
}

class RunGuardNamedTransitionError extends RunGuardError {
  constructor(message, details = {}) {
    super('RunGuardNamedTransitionError', 'RUN_GUARD_NAMED_TRANSITION_REQUIRED', message, details);
  }
}

function assertExact(value, keys, label) {
  if (!exactKeys(value, keys)) throw new Error(`${label} has missing or unknown fields`);
}

function assertString(value, label, { nullable = false, empty = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || (!empty && value.length === 0)) throw new Error(`${label} must be a string`);
}

function assertInteger(value, label, min = 0) {
  if (!Number.isInteger(value) || value < min) throw new Error(`${label} must be an integer >= ${min}`);
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
}

function validateTaskEvidence(tasks, label) {
  if (!Array.isArray(tasks)) throw new Error(`${label} must be an array`);
  tasks.forEach((task, index) => {
    assertExact(task, ['index', 'name', 'reason'], `${label}[${index}]`);
    assertInteger(task.index, `${label}[${index}].index`);
    assertString(task.name, `${label}[${index}].name`);
    assertString(task.reason, `${label}[${index}].reason`);
  });
}

function validateAcceptanceGaps(gaps) {
  if (!Array.isArray(gaps)) throw new Error('acceptanceGaps must be an array');
  gaps.forEach((gap, index) => {
    const label = `acceptanceGaps[${index}]`;
    assertExact(gap, ['index', 'name', 'status', 'reason'], label);
    assertInteger(gap.index, `${label}.index`);
    assertString(gap.name, `${label}.name`);
    assertString(gap.status, `${label}.status`);
    assertString(gap.reason, `${label}.reason`);
  });
}

function validateIncidentList(incidents, runId) {
  if (!Array.isArray(incidents)) throw new Error('incidents must be an array');
  incidents.forEach((incident, index) => {
    const label = `incidents[${index}]`;
    assertExact(incident, [
      'schemaVersion', 'id', 'runId', 'symptom', 'dedupeKey', 'principal', 'severity',
      'step', 'agent', 'task', 'description', 'allowedRecoveryAction', 'status',
      'createdAt', 'resolvedAt',
    ], label);
    if (incident.schemaVersion !== 1 || incident.runId !== runId) throw new Error(`${label} identity is invalid`);
    assertString(incident.id, `${label}.id`);
    assertString(incident.symptom, `${label}.symptom`);
    if (incident.dedupeKey !== `${runId}::${incident.symptom}`) throw new Error(`${label}.dedupeKey is invalid`);
    if (!['orchestrator', 'technical', 'founder'].includes(incident.principal)) throw new Error(`${label}.principal is invalid`);
    if (!['info', 'warning', 'critical'].includes(incident.severity)) throw new Error(`${label}.severity is invalid`);
    for (const key of ['step', 'agent', 'task', 'allowedRecoveryAction', 'resolvedAt']) {
      assertString(incident[key], `${label}.${key}`, { nullable: true, empty: true });
    }
    assertString(incident.description, `${label}.description`, { empty: true });
    if (!['open', 'resolved'].includes(incident.status)) throw new Error(`${label}.status is invalid`);
    if (incident.status === 'open' && incident.resolvedAt !== null) throw new Error(`${label} open incident is resolved`);
    if (incident.status === 'resolved' && incident.resolvedAt === null) throw new Error(`${label} resolved incident lacks a timestamp`);
    assertString(incident.createdAt, `${label}.createdAt`);
  });
}

function validateTechnicalStop(stop, runId) {
  if (stop === null) return;
  assertExact(stop, [
    'schemaVersion', 'outcome', 'reasonCode', 'principal', 'runId', 'step', 'tasks', 'evidence',
    'recoveryHint', 'approved', 'founderRejection', 'autoAdvanceable', 'mergeEligible',
    'acceptanceEligible', 'createdAt',
  ], 'technicalStop');
  if (stop.schemaVersion !== 1 || stop.outcome !== 'TECHNICAL_STOP' || stop.principal !== 'technical') {
    throw new Error('technicalStop is not a supported technical stop');
  }
  if (stop.runId !== runId) throw new Error('technicalStop.runId does not match the aggregate');
  assertString(stop.reasonCode, 'technicalStop.reasonCode');
  if (!TECHNICAL_REASON_CODES.has(stop.reasonCode)) throw new Error('technicalStop.reasonCode is invalid');
  assertString(stop.step, 'technicalStop.step', { nullable: true });
  validateTaskEvidence(stop.tasks, 'technicalStop.tasks');
  assertStringArray(stop.evidence, 'technicalStop.evidence');
  assertString(stop.recoveryHint, 'technicalStop.recoveryHint');
  for (const key of ['approved', 'founderRejection', 'autoAdvanceable', 'mergeEligible', 'acceptanceEligible']) {
    if (stop[key] !== false) throw new Error(`technicalStop.${key} must be false`);
  }
  assertString(stop.createdAt, 'technicalStop.createdAt');
}

function validateIdentity(identity, runId) {
  assertExact(identity, [
    'runId', 'lineageId', 'predecessorRunId', 'successorOrdinal', 'registeredAt',
    'admissionRequestDigest', 'admittedHead', 'admittedRepo', 'rootRegistry',
  ], 'identity');
  if (identity.runId !== runId || identity.lineageId !== runId || identity.predecessorRunId !== null
    || identity.successorOrdinal !== 0) {
    throw new Error('identity is not a root-run identity');
  }
  assertString(identity.registeredAt, 'identity.registeredAt');
  assertString(identity.admissionRequestDigest, 'identity.admissionRequestDigest');
  assertString(identity.admittedHead, 'identity.admittedHead');
  assertString(identity.admittedRepo, 'identity.admittedRepo');
  if (!/^[a-f0-9]{64}$/.test(identity.admissionRequestDigest)) throw new Error('identity admission digest is invalid');
  if (!/^[a-f0-9]{40,64}$/.test(identity.admittedHead)) throw new Error('identity admitted head is invalid');
  assertExact(identity.rootRegistry, ['runId', 'requestDigest'], 'identity.rootRegistry');
  assertString(identity.rootRegistry.runId, 'identity.rootRegistry.runId');
  assertString(identity.rootRegistry.requestDigest, 'identity.rootRegistry.requestDigest');
  if (identity.rootRegistry.requestDigest !== identity.admissionRequestDigest) {
    throw new Error('root registry digest does not match the admitted identity');
  }
}

function validateCause(cause, runId) {
  if (cause === null) return;
  assertExact(cause, ['schemaVersion', 'runId', 'reasonCode', 'stoppedStep', 'tasks', 'evidence'], 'technicalCause');
  if (cause.schemaVersion !== 1 || cause.runId !== runId) throw new Error('technicalCause identity is invalid');
  assertString(cause.reasonCode, 'technicalCause.reasonCode');
  assertString(cause.stoppedStep, 'technicalCause.stoppedStep');
  validateTaskEvidence(cause.tasks, 'technicalCause.tasks');
  assertStringArray(cause.evidence, 'technicalCause.evidence');
}

function validateContinuation(envelope, runId) {
  if (envelope === null) return;
  assertExact(envelope, [
    'schemaVersion', 'runId', 'workflowType', 'input', 'taskPacket', 'branches', 'stoppedStep',
    'round', 'stepStates', 'taskPlan', 'taskExecution', 'fixTaskIndex',
  ], 'repair.continuationEnvelope');
  if (envelope.schemaVersion !== 1 || envelope.runId !== runId || !WORKFLOW_TYPES.has(envelope.workflowType)) {
    throw new Error('continuation identity or workflow type is invalid');
  }
  assertString(envelope.input, 'continuation.input', { nullable: true, empty: true });
  assertExact(envelope.taskPacket, ['prdPath', 'itemId'], 'continuation.taskPacket');
  assertString(envelope.taskPacket.prdPath, 'continuation.taskPacket.prdPath', { nullable: true, empty: true });
  assertString(envelope.taskPacket.itemId, 'continuation.taskPacket.itemId', { nullable: true, empty: true });
  assertExact(envelope.branches, ['branch', 'defaultBranch', 'reviewBranch'], 'continuation.branches');
  for (const key of ['branch', 'defaultBranch', 'reviewBranch']) {
    assertString(envelope.branches[key], `continuation.branches.${key}`, { nullable: true, empty: true });
  }
  assertString(envelope.stoppedStep, 'continuation.stoppedStep');
  assertInteger(envelope.round, 'continuation.round', 1);
  if (!isObject(envelope.stepStates)) throw new Error('continuation.stepStates must be an object');
  for (const [step, state] of Object.entries(envelope.stepStates)) {
    assertExact(state, ['status', 'reasonCode', 'validation'], `continuation.stepStates.${step}`);
    for (const key of ['status', 'reasonCode', 'validation']) {
      assertString(state[key], `continuation.stepStates.${step}.${key}`, { nullable: true, empty: true });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(envelope.stepStates, envelope.stoppedStep)) {
    throw new Error('continuation does not include its stopped step');
  }
  if (envelope.taskPlan !== null) {
    assertExact(envelope.taskPlan, ['validation', 'tasks'], 'continuation.taskPlan');
    assertString(envelope.taskPlan.validation, 'continuation.taskPlan.validation', { nullable: true, empty: true });
    if (!Array.isArray(envelope.taskPlan.tasks)) throw new Error('continuation.taskPlan.tasks must be an array');
    envelope.taskPlan.tasks.forEach((task, index) => {
      const label = `continuation.taskPlan.tasks[${index}]`;
      assertExact(task, [
        'id', 'name', 'description', 'roles', 'dependencies', 'acsCovered', 'estimatedSize',
      ], label);
      if (task.id !== null) assertInteger(task.id, `${label}.id`);
      assertString(task.name, `${label}.name`, { empty: true });
      assertString(task.description, `${label}.description`, { empty: true });
      assertStringArray(task.roles, `${label}.roles`);
      assertStringArray(task.dependencies, `${label}.dependencies`);
      assertStringArray(task.acsCovered, `${label}.acsCovered`);
      assertString(task.estimatedSize, `${label}.estimatedSize`, { nullable: true, empty: true });
    });
  }
  if (envelope.taskExecution !== null) {
    assertExact(envelope.taskExecution, ['currentTaskIndex', 'taskStates'], 'continuation.taskExecution');
    if (envelope.taskExecution.currentTaskIndex !== null) {
      assertInteger(envelope.taskExecution.currentTaskIndex, 'continuation.taskExecution.currentTaskIndex');
    }
    if (!isObject(envelope.taskExecution.taskStates)) throw new Error('continuation.taskExecution.taskStates must be an object');
    for (const [taskIndex, state] of Object.entries(envelope.taskExecution.taskStates)) {
      const label = `continuation.taskExecution.taskStates.${taskIndex}`;
      assertExact(state, [
        'status', 'fixCycles', 'acceptanceCovered', 'blockedReason', 'branches', 'startedAt',
      ], label);
      assertString(state.status, `${label}.status`, { nullable: true, empty: true });
      assertInteger(state.fixCycles, `${label}.fixCycles`);
      if (state.acceptanceCovered !== null && typeof state.acceptanceCovered !== 'boolean') {
        throw new Error(`${label}.acceptanceCovered must be a boolean or null`);
      }
      assertString(state.blockedReason, `${label}.blockedReason`, { nullable: true, empty: true });
      assertStringArray(state.branches, `${label}.branches`);
      assertString(state.startedAt, `${label}.startedAt`, { nullable: true, empty: true });
    }
  }
  if (envelope.fixTaskIndex !== null) assertInteger(envelope.fixTaskIndex, 'continuation.fixTaskIndex');
}

function validateRepair(repair, runId) {
  assertExact(repair, ['state', 'maxSuccessors', 'successorsUsed', 'continuationEnvelope', 'continuationDigest'], 'repair');
  if (!Object.values(REPAIR_STATES).includes(repair.state)) throw new Error('repair.state is invalid');
  if (repair.maxSuccessors !== 1 || repair.successorsUsed !== 0) throw new Error('repair budget is invalid for Slice 1');
  validateContinuation(repair.continuationEnvelope, runId);
  if (repair.state === REPAIR_STATES.ACTIVE_ROOT) {
    if (repair.continuationEnvelope !== null || repair.continuationDigest !== null) {
      throw new Error('ACTIVE_ROOT cannot carry continuation authority');
    }
  } else if (!repair.continuationEnvelope || repair.continuationDigest !== digest(repair.continuationEnvelope)) {
    throw new Error('continuation digest does not match its envelope');
  }
}

function validateV2(doc, runId) {
  assertExact(doc, [
    'schemaVersion', 'runId', 'laneId', 'revision', 'identity', 'counters', 'incidents',
    'blockingTasks', 'acceptanceGaps', 'technicalStop', 'technicalCause',
    'technicalCauseDigest', 'repair', 'createdAt', 'updatedAt',
  ], 'run guard');
  if (doc.schemaVersion !== SCHEMA_VERSION || doc.runId !== runId || doc.laneId !== 'default') {
    throw new Error('run guard schema, run id or lane is invalid');
  }
  assertInteger(doc.revision, 'revision', 1);
  validateIdentity(doc.identity, runId);
  if (!isObject(doc.counters) || Object.values(doc.counters).some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error('counters must contain non-negative integers');
  }
  validateIncidentList(doc.incidents, runId);
  validateTaskEvidence(doc.blockingTasks, 'blockingTasks');
  validateAcceptanceGaps(doc.acceptanceGaps);
  validateTechnicalStop(doc.technicalStop, runId);
  validateCause(doc.technicalCause, runId);
  validateRepair(doc.repair, runId);
  assertString(doc.createdAt, 'createdAt');
  assertString(doc.updatedAt, 'updatedAt');
  if (doc.repair.state === REPAIR_STATES.ACTIVE_ROOT) {
    if (doc.technicalStop !== null || doc.technicalCause !== null || doc.technicalCauseDigest !== null) {
      throw new Error('ACTIVE_ROOT cannot carry terminal authority');
    }
  } else {
    if (!doc.technicalStop || !doc.technicalCause || doc.technicalCauseDigest !== digest(doc.technicalCause)) {
      throw new Error('terminal cause digest does not match its cause');
    }
    if (doc.technicalStop.reasonCode !== doc.technicalCause.reasonCode
      || doc.technicalStop.step !== doc.technicalCause.stoppedStep
      || digest(doc.technicalStop.tasks) !== digest(doc.technicalCause.tasks)
      || digest(doc.technicalStop.evidence) !== digest(doc.technicalCause.evidence)) {
      throw new Error('technical stop and canonical cause disagree');
    }
  }
}

function validateLegacy(doc, runId) {
  if (!isObject(doc) || doc.schemaVersion !== LEGACY_SCHEMA_VERSION || String(doc.runId) !== runId
    || !Number.isInteger(doc.revision) || doc.revision < 0) {
    throw new Error('legacy guard has an unrecognisable schema');
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function continuationEnvelope(runId, workflow) {
  if (!isObject(workflow) || workflow.id !== runId || !WORKFLOW_TYPES.has(workflow.type)) {
    throw new Error('captureTechnicalStop requires the stopped root workflow');
  }
  assertString(workflow.currentStep, 'workflow.currentStep');
  const steps = isObject(workflow.steps) ? workflow.steps : {};
  if (!Object.prototype.hasOwnProperty.call(steps, workflow.currentStep)) {
    throw new Error('workflow does not contain its stopped step');
  }
  const stepStates = {};
  for (const [key, value] of Object.entries(steps)) {
    if (!isObject(value)) continue;
    stepStates[key] = {
      status: typeof value.status === 'string' ? value.status : null,
      reasonCode: typeof value.reasonCode === 'string' ? value.reasonCode : null,
      validation: typeof value.validation === 'string' ? value.validation : null,
    };
  }
  const taskPlan = isObject(workflow.taskPlan) ? {
    validation: typeof workflow.taskPlan.validation === 'string' ? workflow.taskPlan.validation : null,
    tasks: Array.isArray(workflow.taskPlan.tasks) ? workflow.taskPlan.tasks.map((task) => ({
      id: Number.isInteger(task.id) ? task.id : null,
      name: typeof task.name === 'string' ? task.name : '',
      description: typeof task.description === 'string' ? task.description : '',
      roles: cleanStrings(task.roles),
      dependencies: Array.isArray(task.dependencies) ? task.dependencies.map(String) : [],
      acsCovered: cleanStrings(task.acs_covered),
      estimatedSize: typeof task.estimated_size === 'string' ? task.estimated_size : null,
    })) : [],
  } : null;
  const taskExecution = isObject(workflow.taskExecution) ? {
    currentTaskIndex: Number.isInteger(workflow.taskExecution.currentTaskIndex)
      ? workflow.taskExecution.currentTaskIndex : null,
    taskStates: Object.fromEntries(Object.entries(workflow.taskExecution.taskStates || {}).map(([key, state]) => [key, {
      status: isObject(state) && typeof state.status === 'string' ? state.status : null,
      fixCycles: isObject(state) && Number.isInteger(state.fixCycles) ? state.fixCycles : 0,
      acceptanceCovered: isObject(state) && typeof state.acceptanceCovered === 'boolean' ? state.acceptanceCovered : null,
      blockedReason: isObject(state) && typeof state.blockedReason === 'string' ? state.blockedReason : null,
      branches: isObject(state) ? cleanStrings(state.branches) : [],
      startedAt: isObject(state) && typeof state.startedAt === 'string' ? state.startedAt : null,
    }])),
  } : null;
  return {
    schemaVersion: 1,
    runId,
    workflowType: workflow.type,
    input: typeof workflow.input === 'string' ? workflow.input : null,
    taskPacket: {
      prdPath: typeof workflow.prdPath === 'string' ? workflow.prdPath : null,
      itemId: typeof workflow.itemId === 'string' ? workflow.itemId : null,
    },
    branches: {
      branch: typeof workflow.branch === 'string' ? workflow.branch : null,
      defaultBranch: typeof workflow.defaultBranch === 'string' ? workflow.defaultBranch : null,
      reviewBranch: typeof workflow.reviewBranch === 'string' ? workflow.reviewBranch : null,
    },
    stoppedStep: workflow.currentStep,
    round: Number.isInteger(workflow.round) && workflow.round >= 1 ? workflow.round : 1,
    stepStates,
    taskPlan,
    taskExecution,
    fixTaskIndex: Number.isInteger(workflow.fixTaskIndex) ? workflow.fixTaskIndex : null,
  };
}

function technicalCause(runId, stop) {
  return {
    schemaVersion: 1,
    runId,
    reasonCode: stop.reasonCode,
    stoppedStep: stop.step,
    tasks: clone(stop.tasks),
    evidence: clone(stop.evidence),
  };
}

function validateEgressHoldAuthority(hold, runId) {
  assertExact(hold, [
    'schemaVersion', 'runId', 'candidateBranch', 'candidateSha',
    'defaultBranch', 'createdAt', 'authorityDigest',
  ], 'egress hold authority');
  if (hold.schemaVersion !== 1 || hold.runId !== runId) {
    throw new Error('egress hold authority identity is invalid');
  }
  for (const key of ['candidateBranch', 'defaultBranch']) {
    assertString(hold[key], `egress hold authority.${key}`);
    if (!/^(?!.*\.\.)[A-Za-z0-9._/-]+$/.test(hold[key])) {
      throw new Error(`egress hold authority.${key} is not a safe ref`);
    }
  }
  assertString(hold.candidateSha, 'egress hold authority.candidateSha');
  if (!/^[a-f0-9]{40}$/.test(hold.candidateSha)) {
    throw new Error('egress hold authority.candidateSha is invalid');
  }
  assertString(hold.createdAt, 'egress hold authority.createdAt');
  const body = { ...hold };
  delete body.authorityDigest;
  if (!/^[a-f0-9]{64}$/.test(hold.authorityDigest)
    || hold.authorityDigest !== digest(body)) {
    throw new Error('egress hold authority digest does not match');
  }
}

function createRunGuard({
  statePath,
  isRegistered,
  getRegistration,
  lockTimeoutMs = 5000,
  lockPollMs = 5,
} = {}) {
  if (!statePath) throw new Error('createRunGuard: statePath is required');
  const dir = path.join(statePath, GUARD_DIR);
  const locksDir = path.join(dir, '.locks');
  const registeredCheck = typeof isRegistered === 'function' ? isRegistered : null;
  const registrationFor = typeof getRegistration === 'function' ? getRegistration : null;

  function fileFor(runId) {
    return path.join(dir, `${safeRunId(runId)}.json`);
  }

  function egressHoldFileFor(runId) {
    return path.join(dir, `${safeRunId(runId)}${EGRESS_HOLD_SUFFIX}`);
  }

  const leases = createLeaseStore({
    locksDir,
    lockTimeoutMs,
    lockPollMs,
    busyError: (runId) => new RunGuardBusyError(`run aggregate for ${runId} is busy`, { runId }),
  });
  const { lockFor, acquire, release } = leases;

  function corrupt(runId, file, error) {
    if (error instanceof RunGuardError) throw error;
    throw new RunGuardCorruptError(
      `run guard for ${runId} cannot be verified: ${error.message}`,
      { runId, file, cause: error },
    );
  }

  function readEgressHoldFile(runId) {
    const id = String(runId);
    const file = egressHoldFileFor(id);
    if (!fs.existsSync(file)) return null;
    let hold;
    try {
      hold = JSON.parse(fs.readFileSync(file, 'utf8'));
      validateEgressHoldAuthority(hold, id);
    } catch (error) {
      corrupt(id, file, error);
    }
    return clone(hold);
  }

  function crossCheckRegistry(doc, runId) {
    if (!registrationFor) return;
    let entry;
    try {
      entry = registrationFor(runId);
    } catch (error) {
      throw new RunGuardRegistryMismatchError(
        `root registration for ${runId} cannot be verified: ${error.message}`,
        { runId, cause: error },
      );
    }
    const verdict = entry && entry.verdict;
    const lineage = entry && entry.lineage;
    const root = doc.identity.rootRegistry;
    if (!entry || !verdict || !lineage
      || root.runId !== runId
      || verdict.kind !== 'GateVerdict'
      || verdict.decision !== 'ADMITTED'
      || verdict.runId !== runId
      || lineage.runId !== runId
      || lineage.lineageId !== doc.identity.lineageId
      || lineage.predecessorRunId !== doc.identity.predecessorRunId
      || lineage.successorOrdinal !== doc.identity.successorOrdinal
      || lineage.registeredAt !== doc.identity.registeredAt
      || verdict.requestDigest !== root.requestDigest
      || lineage.admissionRequestDigest !== root.requestDigest
      || lineage.admittedHead !== doc.identity.admittedHead
      || lineage.admittedRepo !== doc.identity.admittedRepo
      || verdict.head !== doc.identity.admittedHead
      || verdict.repo !== doc.identity.admittedRepo) {
      throw new RunGuardRegistryMismatchError(
        `run guard for ${runId} does not match its root admission registration`,
        { runId },
      );
    }
  }

  function legacyEmpty(runId) {
    const now = new Date().toISOString();
    return {
      schemaVersion: LEGACY_SCHEMA_VERSION,
      runId,
      laneId: 'default',
      revision: 0,
      counters: {},
      incidents: [],
      blockingTasks: [],
      acceptanceGaps: [],
      technicalStop: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  function readDoc(runId, { skipRegistry = false } = {}) {
    const id = String(runId);
    const file = fileFor(id);
    if (!fs.existsSync(file)) {
      if (registeredCheck && registeredCheck(id)) {
        throw new RunGuardMissingError(
          `run ${id} is registered but its aggregate is missing`,
          { runId: id, file },
        );
      }
      return legacyEmpty(id);
    }
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      corrupt(id, file, error);
    }
    try {
      if (!isObject(doc) || !Number.isInteger(doc.schemaVersion)) throw new Error('schemaVersion is missing');
      if (doc.schemaVersion === LEGACY_SCHEMA_VERSION) validateLegacy(doc, id);
      else if (doc.schemaVersion === SCHEMA_VERSION) validateV2(doc, id);
      else throw new Error(`unsupported schemaVersion ${JSON.stringify(doc.schemaVersion)}`);
    } catch (error) {
      corrupt(id, file, error);
    }
    if (doc.schemaVersion === SCHEMA_VERSION && !skipRegistry) crossCheckRegistry(doc, id);
    return clone(doc);
  }

  function loadEgressHold(runId) {
    const id = String(runId);
    // A hold is authority only for a readable, registered run aggregate.
    const run = readDoc(id);
    const marker = Number(run.counters && run.counters[EGRESS_HOLD_COUNTER] || 0);
    const hold = readEgressHoldFile(id);
    if (marker === 0 && hold === null) return null;
    if (marker !== 1 || hold === null) {
      corrupt(id, egressHoldFileFor(id), new Error(
        marker === 1
          ? 'egress hold authority is registered but missing'
          : 'egress hold authority file and aggregate marker disagree',
      ));
    }
    return hold;
  }

  function captureEgressHold(runId, hold) {
    const id = String(runId);
    const lease = acquire(id);
    try {
      const run = readDoc(id);
      if (run.schemaVersion === LEGACY_SCHEMA_VERSION) {
        throw new RunGuardLegacyReadOnlyError(`run ${id} uses legacy schema 1 and is read-only`, { runId: id });
      }
      if (!isObject(hold)) throw new RunGuardNamedTransitionError('a complete egress hold authority is required');
      const body = {
        schemaVersion: 1,
        runId: id,
        candidateBranch: hold.candidateBranch,
        candidateSha: hold.candidateSha,
        defaultBranch: hold.defaultBranch,
        createdAt: new Date().toISOString(),
      };
      const proposed = { ...body, authorityDigest: digest(body) };
      try {
        validateEgressHoldAuthority(proposed, id);
      } catch (error) {
        throw new RunGuardNamedTransitionError(`invalid egress hold authority: ${error.message}`, { runId: id });
      }
      const marker = Number(run.counters && run.counters[EGRESS_HOLD_COUNTER] || 0);
      const existing = readEgressHoldFile(id);
      if (marker !== 0 || existing) {
        if (marker !== 1 || !existing) {
          corrupt(id, egressHoldFileFor(id), new Error('egress hold authority file and aggregate marker disagree'));
        }
        const sameIdentity = existing.candidateBranch === proposed.candidateBranch
          && existing.candidateSha === proposed.candidateSha
          && existing.defaultBranch === proposed.defaultBranch;
        if (sameIdentity) return existing;
        throw new RunGuardConflictError(`egress hold authority for ${id} is already frozen`, { runId: id });
      }
      // Register that this run owns a durable freeze before publishing the
      // separate immutable document. A crash or deletion between these writes
      // leaves marker=1 + missing file, which loadEgressHold refuses closed.
      run.counters[EGRESS_HOLD_COUNTER] = 1;
      writeTransition(run);
      const file = egressHoldFileFor(id);
      if (!writeExclusive(file, proposed)) {
        const raced = readEgressHoldFile(id);
        if (raced
          && raced.candidateBranch === proposed.candidateBranch
          && raced.candidateSha === proposed.candidateSha
          && raced.defaultBranch === proposed.defaultBranch) return raced;
        throw new RunGuardConflictError(`egress hold authority for ${id} was frozen concurrently`, { runId: id });
      }
      return clone(proposed);
    } finally {
      release(lease);
    }
  }

  function rootDoc(runId, identity) {
    const id = String(runId);
    validateIdentity(identity, id);
    if (identity.rootRegistry.runId !== id) throw new Error('root registry link must name the admitted root');
    const now = new Date().toISOString();
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: id,
      laneId: 'default',
      revision: 1,
      identity: clone(identity),
      counters: {},
      incidents: [],
      blockingTasks: [],
      acceptanceGaps: [],
      technicalStop: null,
      technicalCause: null,
      technicalCauseDigest: null,
      repair: {
        state: REPAIR_STATES.ACTIVE_ROOT,
        maxSuccessors: 1,
        successorsUsed: 0,
        continuationEnvelope: null,
        continuationDigest: null,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  function register(runId, { identity } = {}) {
    if (!runId) throw new Error('runGuard.register: runId is required');
    const id = String(runId);
    const file = fileFor(id);
    if (fs.existsSync(file)) {
      throw new RunGuardExistsError(`run ${id} already has a run aggregate`, { runId: id, file });
    }
    const doc = rootDoc(id, identity);
    const lease = acquire(id);
    try {
      if (fs.existsSync(file)) {
        throw new RunGuardExistsError(`run ${id} already has a run aggregate`, { runId: id, file });
      }
      writeAtomic(file, doc);
    } catch (error) {
      if (!(error instanceof RunGuardExistsError) && fs.existsSync(file)) {
        throw new RunGuardExistsError(`run ${id} already has a run aggregate`, { runId: id, file });
      }
      throw error;
    } finally {
      release(lease);
    }
    return clone(doc);
  }

  function writeTransition(doc) {
    const file = fileFor(doc.runId);
    const disk = readDoc(doc.runId);
    if (disk.revision !== doc.revision) {
      throw new RunGuardConflictError(
        `run aggregate for ${doc.runId} moved from revision ${doc.revision} to ${disk.revision}`,
        { runId: doc.runId, expectedRevision: doc.revision, actualRevision: disk.revision },
      );
    }
    const next = { ...doc, revision: doc.revision + 1, updatedAt: new Date().toISOString() };
    validateV2(next, next.runId);
    crossCheckRegistry(next, next.runId);
    writeAtomic(file, next);
    return next;
  }

  function reduce(doc, action) {
    if (!isObject(action) || typeof action.type !== 'string') throw new RunGuardNamedTransitionError('a named run-guard transition is required');
    if (doc.repair.state === REPAIR_STATES.STOPPED) {
      if (action.type === 'CAPTURE_TECHNICAL_STOP') {
        try {
          validateTechnicalStop(action.stop, doc.runId);
          const cause = technicalCause(doc.runId, action.stop);
          const continuation = continuationEnvelope(doc.runId, action.workflow);
          if (digest(action.stop) === digest(doc.technicalStop)
            && digest(cause) === doc.technicalCauseDigest
            && digest(continuation) === doc.repair.continuationDigest) {
            return { changed: false, result: clone(doc.technicalStop) };
          }
        } catch (_) {}
      }
      throw new RunGuardTerminalError(`run ${doc.runId} is terminal`, { runId: doc.runId });
    }
    switch (action.type) {
      case 'BUMP_COUNTER': {
        assertString(action.key, 'counter key');
        const value = Number(doc.counters[action.key] || 0) + 1;
        doc.counters[action.key] = value;
        return { changed: true, result: value };
      }
      case 'NOTE_AUTO_ADVANCE_REFUSAL': {
        // One gate refusal is one authority event. The reducer derives both
        // exact keys itself so callers cannot turn this into a generic
        // multi-counter mutation, and writeTransition commits them under the
        // same lock and revision.
        assertString(action.stepKey, 'auto-advance refusal step');
        const stepKey = `auto_advance_refusals:${action.stepKey}`;
        const stepCount = Number(doc.counters[stepKey] || 0) + 1;
        const totalCount = Number(doc.counters.auto_advance_refusals || 0) + 1;
        doc.counters[stepKey] = stepCount;
        doc.counters.auto_advance_refusals = totalCount;
        return { changed: true, result: { stepCount, totalCount } };
      }
      case 'CLEAR_COUNTER':
        assertString(action.key, 'counter key');
        if (!Object.prototype.hasOwnProperty.call(doc.counters, action.key)) return { changed: false, result: 0 };
        delete doc.counters[action.key];
        return { changed: true, result: 0 };
      case 'RECORD_ACCEPTANCE_GAPS': {
        validateAcceptanceGaps(action.gaps);
        const byIndex = new Map(doc.acceptanceGaps.map((gap) => [gap.index, gap]));
        let changed = false;
        for (const gap of action.gaps) {
          const existing = byIndex.get(gap.index);
          if (existing) {
            if (digest(existing) !== digest(gap)) {
              throw new RunGuardConflictError(
                `acceptance gap ${gap.index} conflicts with the run aggregate`,
                { runId: doc.runId, taskIndex: gap.index },
              );
            }
            continue;
          }
          byIndex.set(gap.index, clone(gap));
          changed = true;
        }
        if (changed) doc.acceptanceGaps = [...byIndex.values()].sort((a, b) => a.index - b.index);
        return { changed, result: clone(doc.acceptanceGaps) };
      }
      case 'SET_INCIDENTS':
        validateIncidentList(action.incidents, doc.runId);
        doc.incidents = clone(action.incidents);
        return { changed: true, result: clone(doc.incidents) };
      case 'CAPTURE_TECHNICAL_STOP': {
        validateTechnicalStop(action.stop, doc.runId);
        const cause = technicalCause(doc.runId, action.stop);
        const continuation = continuationEnvelope(doc.runId, action.workflow);
        doc.technicalStop = clone(action.stop);
        doc.blockingTasks = clone(action.stop.tasks);
        doc.technicalCause = cause;
        doc.technicalCauseDigest = digest(cause);
        doc.repair = {
          state: REPAIR_STATES.STOPPED,
          maxSuccessors: 1,
          successorsUsed: 0,
          continuationEnvelope: continuation,
          continuationDigest: digest(continuation),
        };
        return { changed: true, result: clone(action.stop) };
      }
      default:
        throw new RunGuardNamedTransitionError(`unknown run-guard transition ${JSON.stringify(action.type)}`);
    }
  }

  function transition(runId, action) {
    const id = String(runId);
    const lease = acquire(id);
    try {
      const doc = readDoc(id);
      if (doc.schemaVersion === LEGACY_SCHEMA_VERSION) {
        throw new RunGuardLegacyReadOnlyError(`run ${id} uses legacy schema 1 and is read-only`, { runId: id });
      }
      const outcome = reduce(doc, action);
      if (!outcome.changed) return { doc, result: outcome.result };
      return { doc: writeTransition(doc), result: outcome.result };
    } finally {
      release(lease);
    }
  }

  function count(runId, key) {
    return Number(readDoc(runId).counters[key] || 0);
  }

  function bump(runId, key, max) {
    const { result } = transition(runId, { type: 'BUMP_COUNTER', key });
    return {
      value: result,
      exceeded: typeof max === 'number' ? result > max : false,
      max: typeof max === 'number' ? max : null,
    };
  }

  function noteAutoAdvanceRefusal(runId, stepKey) {
    return transition(runId, { type: 'NOTE_AUTO_ADVANCE_REFUSAL', stepKey }).result;
  }

  function clearCounter(runId, key) {
    return transition(runId, { type: 'CLEAR_COUNTER', key }).result;
  }

  function recordAcceptanceGaps(runId, gaps) {
    return transition(runId, { type: 'RECORD_ACCEPTANCE_GAPS', gaps }).result;
  }

  // Compatibility name for the existing public surface. Gaps are monotonic:
  // "set []" no longer means "erase authority".
  function setAcceptanceGaps(runId, gaps) {
    return recordAcceptanceGaps(runId, gaps);
  }

  function setIncidents(runId, incidents) {
    return transition(runId, { type: 'SET_INCIDENTS', incidents }).result;
  }

  function captureTechnicalStop(runId, { stop, workflow } = {}) {
    return transition(runId, { type: 'CAPTURE_TECHNICAL_STOP', stop, workflow }).result;
  }

  function namedOnly() {
    throw new RunGuardNamedTransitionError('use a named run-guard transition');
  }

  return {
    fileFor,
    egressHoldFileFor,
    lockFor,
    register,
    load: readDoc,
    transition,
    save: namedOnly,
    mutate: namedOnly,
    count,
    bump,
    noteAutoAdvanceRefusal,
    exceeded: (runId, key, max) => typeof max === 'number' && count(runId, key) > max,
    clearCounter,
    recordAcceptanceGaps,
    setAcceptanceGaps,
    setIncidents,
    captureTechnicalStop,
    loadEgressHold,
    captureEgressHold,
  };
}

module.exports = {
  createRunGuard,
  RunGuardConflictError,
  RunGuardCorruptError,
  RunGuardMissingError,
  RunGuardExistsError,
  RunGuardBusyError,
  RunGuardLegacyReadOnlyError,
  RunGuardTerminalError,
  RunGuardRegistryMismatchError,
  RunGuardNamedTransitionError,
  LEGACY_SCHEMA_VERSION,
  SCHEMA_VERSION,
  GUARD_DIR,
  EGRESS_HOLD_SUFFIX,
  REPAIR_STATES,
};
