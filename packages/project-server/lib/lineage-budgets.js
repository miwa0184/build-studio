'use strict';

/**
 * Lineage-wide budgets: the dimensions a new repair run must not renew.
 *
 * Per-run counters remain in run-guard.js. At the successor boundary we charge
 * the terminal predecessor's measurable recovery history into the admission
 * registry's lineage ledger. This keeps one atomic commit point for identity,
 * the predecessor's one-child claim and cumulative spend.
 */

const { resolveBudgets, COUNTERS } = require('./run-budgets');
const { REASON_CODES, isTechnicalStop, technicalStopFingerprint } = require('./technical-stop');

const DEFAULT_MAX_SUCCESSORS = 2;
const DEFAULT_MAX_NO_PROGRESS_REPEATS = 1;

const RECOVERY_ELIGIBLE_REASONS = new Set(Object.values(REASON_CODES));

function integerSetting(value, fallback, { min = 0, max = 10000 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`expected an integer ${min}..${max}, got ${JSON.stringify(value)}`);
  }
  return n;
}

function derivedRecoveryUnits(config, maxSuccessors) {
  const run = resolveBudgets(config);
  const oneAttempt = run.maxReviewRounds
    + run.maxFixRounds
    + run.maxAutoAdvanceRefusalsTotal
    + run.maxTaskFixCycles
    + 1; // the terminal recovery event itself
  return Math.max(1, maxSuccessors * oneAttempt);
}

function resolveLineageBudgets(config = {}) {
  const maxSuccessors = integerSetting(config.max_successor_runs, DEFAULT_MAX_SUCCESSORS, { min: 0, max: 10 });
  return {
    maxSuccessors,
    maxRecoveryUnits: integerSetting(
      config.max_lineage_recovery_units,
      derivedRecoveryUnits(config, maxSuccessors),
      { min: 1, max: 100000 },
    ),
    maxNoProgressRepeats: integerSetting(
      config.max_lineage_no_progress_repeats,
      DEFAULT_MAX_NO_PROGRESS_REPEATS,
      { min: 0, max: 10 },
    ),
  };
}

function successorRecoveryEligibility(stop) {
  if (!isTechnicalStop(stop)) return { eligible: false, reason: 'outcome is not TECHNICAL_STOP' };
  if (stop.principal !== 'technical') return { eligible: false, reason: `principal is ${JSON.stringify(stop.principal)}, not technical` };
  if (stop.approved !== false || stop.founderRejection !== false
    || stop.autoAdvanceable !== false || stop.mergeEligible !== false
    || stop.acceptanceEligible !== false) {
    return { eligible: false, reason: 'terminal technical properties do not all fail closed' };
  }
  if (!RECOVERY_ELIGIBLE_REASONS.has(stop.reasonCode)) {
    return { eligible: false, reason: `reason ${JSON.stringify(stop.reasonCode)} is not successor-recovery eligible` };
  }
  // Schema-1 stops predate the explicit contract but were created from the
  // same closed reason whitelist. Newer stops must carry the contract.
  if (Number(stop.schemaVersion || 1) >= 2) {
    if (!stop.recovery || stop.recovery.mode !== 'successor_repair' || stop.recovery.eligible !== true) {
      return { eligible: false, reason: 'the stop does not allow successor_repair' };
    }
  }
  return { eligible: true, fingerprint: technicalStopFingerprint(stop) };
}

function recoveryCharge(guardDoc) {
  const counters = guardDoc && guardDoc.counters && typeof guardDoc.counters === 'object'
    ? guardDoc.counters : {};
  const charged = {};
  let units = 1; // the bounded recovery attempt itself
  for (const [key, raw] of Object.entries(counters)) {
    const relevant = key === COUNTERS.REVIEW_ROUNDS
      || key === COUNTERS.FIX_ROUNDS
      || key === COUNTERS.AUTO_ADVANCE_REFUSALS
      || key.startsWith('task_fix_cycles:');
    if (!relevant) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    const whole = Math.floor(value);
    charged[key] = whole;
    units += whole;
  }
  return { units, counters: charged, terminalEvents: 1 };
}

module.exports = {
  DEFAULT_MAX_SUCCESSORS,
  DEFAULT_MAX_NO_PROGRESS_REPEATS,
  RECOVERY_ELIGIBLE_REASONS,
  resolveLineageBudgets,
  successorRecoveryEligibility,
  recoveryCharge,
};
