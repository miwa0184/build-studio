'use strict';

/**
 * TECHNICAL_STOP — the terminal outcome the engine had no way to express.
 *
 * Every halt used to borrow a shape that already meant something else. A task
 * that exhausted its fix cycles was marked `blocked`, which no downstream
 * reader treated as terminal, and the run walked past it into merge. A strict
 * review that hit its round cap with findings still open was recorded as an
 * APPROVAL, because "approve unless blocking" was the only fallback available.
 * In both cases the state a later reader saw was indistinguishable from success.
 *
 * A technical stop is deliberately none of the things that could be mistaken
 * for progress:
 *
 *   - not an approval          — nothing may read it as positive evidence
 *   - not a founder rejection  — the product decision was never asked
 *   - not auto-advanceable     — the server's tick refuses to act on it
 *   - not merge-eligible       — no transition toward merge can start from it
 *   - not acceptance-eligible  — it can never satisfy an acceptance gate
 *
 * It exists so a machine can tell "this run stopped because something broke"
 * apart from "this run stopped because it is waiting for a person". Those need
 * different humans, and conflating them sent every technical fault to the owner
 * as if it were theirs to decide.
 *
 * `principal` is always 'technical': a technical fault is never a founder
 * question. See incidents.js for the same vocabulary applied to non-terminal
 * conditions.
 *
 * TERMINAL FOR THE RUN IT STOPS. This is the property everything else hangs
 * off, and it was learned the hard way: the first design treated a stop as a
 * pause that an operator could lift, and three review rounds each found a
 * different hole in that. They were all the same hole. Every in-run recovery
 * route had to answer "has the original cause actually gone?", and none of them
 * could — `acceptanceCovered` went false and nothing set it true, so a run that
 * had been "recovered" carried a permanent, invisible gap while reporting
 * itself healthy.
 *
 * A stop now ends the run. Recovery is a SUCCESSOR repair run, with its own run
 * id and its own budget (A1b) — which is also the only honest place to rebuild
 * acceptance evidence, because a fresh run can actually produce it. That makes
 * terminality one check in one place instead of six, and it deletes the class
 * of question the recovery routes kept getting wrong.
 */

const crypto = require('crypto');

const SCHEMA_VERSION = 2;

const TECHNICAL_STOP = 'TECHNICAL_STOP';

/**
 * Why the run stopped. A machine-stable key — the prose in `recoveryHint` may
 * be reworded freely, these may not.
 */
const REASON_CODES = {
  /** One or more implementation tasks are blocked and cannot be completed. */
  BLOCKED_TASKS: 'BLOCKED_TASKS',
  /** Strict review reached its round cap with findings still open. */
  STRICT_REVIEW_CAP_WITH_FINDINGS: 'STRICT_REVIEW_CAP_WITH_FINDINGS',
  /** The run spent every review round its budget allows. */
  REVIEW_ROUND_BUDGET_EXHAUSTED: 'REVIEW_ROUND_BUDGET_EXHAUSTED',
  /** The run spent every fix round its budget allows. */
  FIX_ROUND_BUDGET_EXHAUSTED: 'FIX_ROUND_BUDGET_EXHAUSTED',
  /** A fix plan exceeded the ceiling on how many tasks one plan may carry. */
  FIX_PLAN_TASK_CEILING: 'FIX_PLAN_TASK_CEILING',
  /** An implementation plan exceeded the ceiling on planned tasks. */
  TASK_PLAN_CEILING: 'TASK_PLAN_CEILING',
  /** Auto-advance was refused by a gate more times than the run's budget allows. */
  AUTO_ADVANCE_REFUSAL_BUDGET_EXHAUSTED: 'AUTO_ADVANCE_REFUSAL_BUDGET_EXHAUSTED',
  /** An operator force-completed a task; no agent ever certified it. */
  TASK_FORCE_COMPLETED_UNVERIFIED: 'TASK_FORCE_COMPLETED_UNVERIFIED',
  /** An operator aborted a task; no work is attributed to it. */
  TASK_SKIPPED_UNVERIFIED: 'TASK_SKIPPED_UNVERIFIED',
  /** A successor's bounded repair attempt reported that the same cause remains. */
  SUCCESSOR_REPAIR_FAILED: 'SUCCESSOR_REPAIR_FAILED',
};

const VALID_REASON_CODES = new Set(Object.values(REASON_CODES));

/**
 * @param {object}   input
 * @param {string}   input.reasonCode      one of REASON_CODES
 * @param {string}   input.runId           the run this stop belongs to
 * @param {string}   input.step            the workflow step it happened on
 * @param {Array}    [input.tasks]         [{ index, name, reason }] — every blocking task
 * @param {string[]} [input.evidence]      machine-checkable facts behind the stop
 * @param {string}   [input.recoveryHint]  what a human can do about it
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A reproducible signal for "the same recorded technical cause".
 *
 * This intentionally does not claim semantic code progress. It hashes only
 * the machine-stable cause: reason, step, tasks and evidence. Run ids and
 * timestamps are excluded so the same failure in a successor compares equal.
 * A successor repair failure may carry its predecessor's fingerprint directly
 * (`causeFingerprint`) because that outcome means exactly "this cause remains".
 */
function technicalStopFingerprint(stop) {
  if (stop && typeof stop.causeFingerprint === 'string' && /^[0-9a-f]{64}$/.test(stop.causeFingerprint)) {
    return stop.causeFingerprint;
  }
  const canonical = {
    reasonCode: stop && stop.reasonCode || null,
    step: stop && stop.step || null,
    tasks: Array.isArray(stop && stop.tasks) ? stop.tasks : [],
    evidence: Array.isArray(stop && stop.evidence) ? stop.evidence : [],
  };
  return crypto.createHash('sha256').update(stableJson(canonical)).digest('hex');
}

function createTechnicalStop({ reasonCode, runId, step, tasks, evidence, recoveryHint, causeFingerprint } = {}) {
  if (!VALID_REASON_CODES.has(reasonCode)) {
    throw new Error(
      `createTechnicalStop: unknown reasonCode ${JSON.stringify(reasonCode)} — expected one of ${[...VALID_REASON_CODES].join(', ')}`,
    );
  }
  const stop = {
    schemaVersion: SCHEMA_VERSION,
    outcome: TECHNICAL_STOP,
    reasonCode,
    principal: 'technical',
    runId: runId || null,
    step: step || null,
    tasks: Array.isArray(tasks) ? tasks : [],
    evidence: Array.isArray(evidence) ? evidence : [],
    // The default hint must not advertise in-run recovery: a technical stop is
    // terminal for the run it stops, and every route that could act on advice
    // like "relaunch the step" answers 409.
    recoveryHint: recoveryHint || 'Diagnose the cause. This run stays parked; a further attempt is a successor repair run with its own run id and budget.',
    // Stated as fields, not only as behaviour, so a reader that has only the
    // serialised object — a snapshot, an API response, another process — reaches
    // the same conclusion as a reader with these functions.
    approved: false,
    founderRejection: false,
    autoAdvanceable: false,
    mergeEligible: false,
    acceptanceEligible: false,
    // The contract A1b.2 reads. The reason whitelist remains a second check;
    // this field alone can never turn an owner/product outcome into recovery.
    recovery: { mode: 'successor_repair', eligible: true },
    ...(causeFingerprint ? { causeFingerprint } : {}),
    createdAt: new Date().toISOString(),
  };
  stop.fingerprint = technicalStopFingerprint(stop);
  return stop;
}

function isTechnicalStop(x) {
  return !!x && typeof x === 'object' && x.outcome === TECHNICAL_STOP;
}

/** A technical stop never counts as an approval, whatever else it carries. */
function countsAsApproval(x) {
  return !isTechnicalStop(x) && !!x && x.approved === true;
}

function canAutoAdvance(x) {
  return !isTechnicalStop(x);
}

function isMergeEligible(x) {
  return !isTechnicalStop(x);
}

function isAcceptanceEligible(x) {
  return !isTechnicalStop(x);
}

/**
 * Put a stop onto a workflow object. Pure — no persistence, no guard.
 *
 * Shared so the two callers cannot drift: the workflow router (which also
 * mirrors into the run guard) and the overseer (whose operator actions park the
 * run). A second hand-rolled copy is how `currentStep` and `steps.technical_stop`
 * would end up disagreeing about whether a run is stopped.
 */
function applyToWorkflow(wf, stop) {
  wf.technicalStop = stop;
  wf.currentStep = 'technical_stop';
  wf.steps = wf.steps || {};
  wf.steps.technical_stop = {
    status: 'blocked',
    reasonCode: stop.reasonCode,
    error: `${stop.reasonCode}: ${stop.recoveryHint}`,
    stop,
  };
  return wf;
}

/**
 * The wire shape for refusing an action on a parked run.
 *
 * Deliberately carries no list of in-run recovery actions: the previous
 * response advertised three, and advertising any is the defect. `recovery`
 * names the only real route.
 */
function refusalPayload(stop) {
  return {
    outcome: TECHNICAL_STOP,
    terminal: true,
    reasonCode: stop.reasonCode,
    principal: stop.principal,
    runId: stop.runId,
    step: stop.step,
    tasks: stop.tasks || [],
    evidence: stop.evidence || [],
    recovery: 'successor_repair_run',
    error: `This run is parked: ${stop.reasonCode}. It is terminal — no action resumes it. `
      + `${stop.recoveryHint} Recovery is a separate repair run with its own run id and budget.`,
    technicalStop: stop,
  };
}

/**
 * Thrown when an operation would replace or transition a run whose guard says
 * it is terminal — e.g. restoring a snapshot over a technically stopped run.
 * Carries the authoritative stop so the refusing surface can answer with
 * `refusalPayload(err.technicalStop)`.
 */
class TerminalRunError extends Error {
  constructor(stop) {
    super(`run ${stop && stop.runId} is terminal: ${stop && stop.reasonCode} — no state may replace or resume it`);
    this.name = 'TerminalRunError';
    this.code = 'RUN_TERMINAL';
    this.technicalStop = stop;
  }
}

/**
 * Thrown when a technical stop could not be made durable in the run guard.
 *
 * The one thing this error exists to prevent is a FALSE SUCCESS: a route that
 * parks a run, fails to write the guard, logs a line and answers as though the
 * park took. The stop is still applied to the in-memory workflow and held as a
 * pending stop at the state boundary (see state.js), so the run is not
 * transitionable — but the caller must report the failure, because until the
 * guard holds the stop it is not durable across a restart.
 */
class TechnicalStopPersistError extends Error {
  constructor(stop, cause) {
    super(`technical stop ${stop && stop.reasonCode} for run ${stop && stop.runId} could not be persisted to the run guard: ${cause && cause.message}`);
    this.name = 'TechnicalStopPersistError';
    this.code = 'TECHNICAL_STOP_PERSIST_FAILED';
    this.technicalStop = stop;
    if (cause) this.cause = cause;
  }
}

module.exports = {
  SCHEMA_VERSION,
  TECHNICAL_STOP,
  REASON_CODES,
  TerminalRunError,
  TechnicalStopPersistError,
  createTechnicalStop,
  isTechnicalStop,
  countsAsApproval,
  canAutoAdvance,
  isMergeEligible,
  isAcceptanceEligible,
  technicalStopFingerprint,
  applyToWorkflow,
  refusalPayload,
};
