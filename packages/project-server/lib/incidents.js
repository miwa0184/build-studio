'use strict';

/**
 * Incidents — what replaces the single `pendingEscalation` slot.
 *
 * The overseer runs six detectors. Five of them are written
 * `if (!overseer.pendingEscalation)`, because there was exactly one place to put
 * an answer. So the first symptom to fire made the overseer blind to every
 * other one: an agent hitting a usage limit hid a package-lock conflict, a step
 * loop, a second agent's wallclock overrun and a stall — until somebody
 * dismissed the banner. On a run with several agents in flight that is most of
 * the time.
 *
 * The obvious replacement — let every detector raise whatever it likes — trades
 * one failure for another: a wall of repeating banners nobody reads. So an
 * incident is deduplicated by symptom while it is open, and resolving one
 * leaves the rest alone.
 *
 * `principal` is who the incident is FOR, and it is the field that keeps
 * technical faults away from the owner:
 *
 *   orchestrator — the engine can act on it (retry, relaunch, replan)
 *   technical    — an engineer must look; not a product question
 *   founder      — a genuine product or device decision
 *
 * A1a raises only orchestrator and technical incidents. A technical fault is
 * never a founder question, and nothing in this module will make one.
 */

const crypto = require('crypto');

const SCHEMA_VERSION = 1;

const PRINCIPALS = {
  ORCHESTRATOR: 'orchestrator',
  TECHNICAL: 'technical',
  FOUNDER: 'founder',
};

const SEVERITIES = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

const VALID_PRINCIPALS = new Set(Object.values(PRINCIPALS));
const VALID_SEVERITIES = new Set(Object.values(SEVERITIES));

/**
 * The dedupe key. `symptom` is expected to already be specific to the thing that
 * went wrong — the overseer builds it per agent/window/step — so two agents with
 * the same class of problem are two incidents, not one.
 */
function dedupeKeyOf({ runId, symptom }) {
  return `${runId || 'no-run'}::${symptom}`;
}

function createIncident({
  runId, symptom, principal, severity, step, agent, task,
  description, allowedRecoveryAction,
} = {}) {
  if (!symptom) throw new Error('createIncident: symptom is required');
  if (!VALID_PRINCIPALS.has(principal)) {
    throw new Error(
      `createIncident: unknown principal ${JSON.stringify(principal)} — expected one of ${[...VALID_PRINCIPALS].join(', ')}`,
    );
  }
  if (severity !== undefined && !VALID_SEVERITIES.has(severity)) {
    throw new Error(
      `createIncident: unknown severity ${JSON.stringify(severity)} — expected one of ${[...VALID_SEVERITIES].join(', ')}`,
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id: crypto.randomUUID(),
    runId: runId || null,
    symptom,
    dedupeKey: dedupeKeyOf({ runId, symptom }),
    principal,
    severity: severity || SEVERITIES.WARNING,
    step: step || null,
    agent: agent || null,
    task: task === undefined || task === null ? null : String(task),
    description: description || '',
    allowedRecoveryAction: allowedRecoveryAction || null,
    status: 'open',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
}

/** Open incidents only — the ones still standing between the run and progress. */
function openIncidents(list) {
  return (list || []).filter((i) => i && i.status === 'open');
}

function findIncident(list, symptom) {
  return (list || []).find((i) => i && i.symptom === symptom) || null;
}

/**
 * Raise an incident, returning a new list.
 *
 * Idempotent while the same symptom is open: raising it again on the next
 * 15-second tick updates nothing and adds nothing. Once it has been resolved,
 * the same symptom can be raised again as a fresh incident — a usage limit that
 * comes back is a new event, not the old one.
 */
function openIncident(list, input) {
  const current = list || [];
  const key = dedupeKeyOf(input);
  if (current.some((i) => i && i.status === 'open' && i.dedupeKey === key)) return current;
  return [...current, createIncident(input)];
}

/** Resolve every open incident with this symptom; the others are untouched. */
function resolveIncident(list, symptom, at) {
  const when = at || new Date().toISOString();
  return (list || []).map((i) =>
    i && i.symptom === symptom && i.status === 'open'
      ? { ...i, status: 'resolved', resolvedAt: when }
      : i,
  );
}

/** Resolve by incident id — for a UI that has the id but not the symptom. */
function resolveIncidentById(list, id, at) {
  const when = at || new Date().toISOString();
  return (list || []).map((i) =>
    i && i.id === id && i.status === 'open' ? { ...i, status: 'resolved', resolvedAt: when } : i,
  );
}

/** Drop resolved incidents beyond the most recent `keep`, so the list stays bounded. */
function pruneIncidents(list, keep = 50) {
  const all = list || [];
  const open = all.filter((i) => i && i.status === 'open');
  const resolved = all.filter((i) => i && i.status !== 'open');
  return [...open, ...resolved.slice(-keep)];
}

module.exports = {
  SCHEMA_VERSION,
  PRINCIPALS,
  SEVERITIES,
  createIncident,
  openIncident,
  resolveIncident,
  resolveIncidentById,
  openIncidents,
  findIncident,
  pruneIncidents,
  dedupeKeyOf,
};
