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
 */

const SCHEMA_VERSION = 1;

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
function createTechnicalStop({ reasonCode, runId, step, tasks, evidence, recoveryHint } = {}) {
  if (!VALID_REASON_CODES.has(reasonCode)) {
    throw new Error(
      `createTechnicalStop: unknown reasonCode ${JSON.stringify(reasonCode)} — expected one of ${[...VALID_REASON_CODES].join(', ')}`,
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    outcome: TECHNICAL_STOP,
    reasonCode,
    principal: 'technical',
    runId: runId || null,
    step: step || null,
    tasks: Array.isArray(tasks) ? tasks : [],
    evidence: Array.isArray(evidence) ? evidence : [],
    recoveryHint: recoveryHint || 'Diagnose the cause, then relaunch the step or cancel the run.',
    // Stated as fields, not only as behaviour, so a reader that has only the
    // serialised object — a snapshot, an API response, another process — reaches
    // the same conclusion as a reader with these functions.
    approved: false,
    founderRejection: false,
    autoAdvanceable: false,
    mergeEligible: false,
    acceptanceEligible: false,
    createdAt: new Date().toISOString(),
  };
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

module.exports = {
  SCHEMA_VERSION,
  TECHNICAL_STOP,
  REASON_CODES,
  createTechnicalStop,
  isTechnicalStop,
  countsAsApproval,
  canAutoAdvance,
  isMergeEligible,
  isAcceptanceEligible,
};
