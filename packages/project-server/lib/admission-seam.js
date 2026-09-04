'use strict';

/**
 * The central Express admission seam — mounted in server.js BEFORE every API
 * router, so a UI click and a direct curl meet exactly the same verdict.
 *
 * Three request classes, three behaviours:
 *
 * A. START INGRESS (POST /api/workflow/start, POST /api/launch): requires and
 *    verifies a RunRequest, creates the server's GateVerdict, and registers
 *    the run identity — all BEFORE the handler runs, so a refusal leaves no
 *    workflow record, no run record, no branch, no worktree, no process. The
 *    handler receives the admitted context on req.admission and MUST use its
 *    runId as the run's id.
 *
 * B. MUTATION OF A REGISTERED ACTIVE RUN (advance, feedback, auto-advance,
 *    model-override, restore, recover, the overseer's force-complete and
 *    kill-skip, run merge): no fresh RunRequest — the server loads and
 *    verifies the run's STORED admission context. A run that was never
 *    admitted, or whose guard is missing or unreadable, refuses fail-closed.
 *    A client-supplied runRequest / verdict / approval / bypass on these
 *    routes refuses outright: the client neither needs nor may mint one.
 *
 * C. READ-ONLY (GET/HEAD/OPTIONS): passes through, so the hub can always
 *    render WHY a run was refused or stopped. This seam adds one read route
 *    of its own, GET /api/admission/context, which tells a client what a
 *    valid RunRequest for this project would contain right now — pure reads;
 *    admission still re-verifies everything at start time.
 *
 * Deliberately exempt, by name (the A1a lesson, twice over: fail-closed
 * belongs to the engine's autonomy, never to the operator's escape hatch):
 * cancel, finish, open, run-cancel, run-open, overseer dismiss/nudge. Cancel
 * must keep working on a legacy or broken run precisely BECAUSE everything
 * else refuses on it.
 *
 * Any exception anywhere in this seam — validator missing, git timeout, a
 * corrupt store — REFUSES the request (403, typed). It never fails open into
 * the handler.
 */

const { AdmissionRefusedError } = require('./admission');
const express = require('express');
const { admissionErrorPayload } = require('./admission-error');

/** Start-ingress routes: path -> run id prefix source. */
const START_INGRESS = new Map([
  ['/api/workflow/start', (req) => {
    const t = req.body && req.body.type;
    return ['review', 'execution', 'kickoff', 'onboarding', 'bugfix'].includes(t) ? t : 'run';
  }],
  ['/api/launch', () => 'run'],
]);

/** Work-advancing mutations on the active WORKFLOW run. */
const WORKFLOW_MUTATIONS = new Set([
  '/api/workflow/advance',
  '/api/workflow/feedback',
  '/api/workflow/auto-advance',
  '/api/workflow/model-override',
  '/api/workflow/restore',
  '/api/workflow/recover',
  // A1c receipt: finalizing the factory-run receipt binds the admitted run's
  // stored identity, so it verifies the stored context like every mutation.
  '/api/workflow/receipt/finalize',
  '/api/overseer/force-complete-task',
  '/api/overseer/kill-skip-task',
]);

/** Work-advancing mutations on the active EXECUTION-TAB run. */
const RUN_MUTATION_PREFIXES = ['/api/run/merge/:branch'];

/**
 * Compile through Express itself, rather than maintaining a second, narrower
 * idea of route equality. The real routers use the same defaults: case
 * insensitive, non-strict trailing slash, end-anchored route matching. Using
 * an Express route layer also preserves its raw-path/percent-decoding rules.
 */
function compileExpressPostMatcher(routePath) {
  const probe = express.Router();
  probe.post(routePath, (req, res) => res.end());
  const layer = probe.stack[0];
  if (!layer || typeof layer.match !== 'function') {
    throw new Error(`could not compile Express route matcher for ${routePath}`);
  }
  return (requestPath) => {
    try {
      return layer.match(requestPath) === true;
    } catch (err) {
      // Express found the route shape but could not decode a parameter. The
      // real router treats that as a malformed URL (400), not as an admitted
      // mutation and not as a policy refusal. Let the request reach that same
      // router layer so it emits its native response without side effects.
      if (err && err.status === 400) return false;
      throw err;
    }
  };
}

const ROUTE_MATCHERS = [
  ...[...START_INGRESS].map(([routePath, prefixFor]) => ({
    kind: 'start', routePath, prefixFor, matches: compileExpressPostMatcher(routePath),
  })),
  ...[...WORKFLOW_MUTATIONS].map((routePath) => ({
    kind: 'workflow-mutation', routePath, matches: compileExpressPostMatcher(routePath),
  })),
  ...RUN_MUTATION_PREFIXES.map((routePath) => ({
    kind: 'run-mutation', routePath, matches: compileExpressPostMatcher(routePath),
  })),
];

function classifyAdmissionRoute(req) {
  if (!req || req.method !== 'POST') return null;
  const requestPath = req.path;
  if (typeof requestPath !== 'string') return null;
  return ROUTE_MATCHERS.find((route) => route.matches(requestPath)) || null;
}

/** Body fields a client may never use to carry its own authority. */
const CLIENT_AUTHORITY_FIELDS = /^(runRequest|.*verdict.*|.*approval.*|approved|bypass.*|admission)$/i;

function refusalResponse(res, e) {
  const payload = admissionErrorPayload(e);
  if (!e || !e.code) payload.code = 'ADMISSION_VALIDATOR_FAILURE';
  return res.status(403).json(payload);
}

function createAdmissionSeam({ state, admission }) {
  if (!state || !admission) throw new Error('createAdmissionSeam: state and admission are required');

  return function admissionSeam(req, res, next) {
    try {
      // The seam's own read route — what would a valid RunRequest say right now?
      if (req.method === 'GET' && req.path === '/api/admission/context') {
        try {
          const ctx = admission.describeContext({ type: req.query.type, input: req.query.input });
          return res.json(ctx);
        } catch (e) {
          return refusalResponse(res, e);
        }
      }

      // C — reads pass. A refused or stopped run must stay renderable.
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

      const classifiedRoute = classifyAdmissionRoute(req);

      // A — start ingress.
      if (classifiedRoute && classifiedRoute.kind === 'start') {
        const body = req.body || {};
        for (const key of Object.keys(body)) {
          if (key !== 'runRequest' && CLIENT_AUTHORITY_FIELDS.test(key)) {
            return refusalResponse(res, new AdmissionRefusedError(
              'ADMISSION_CLIENT_VERDICT',
              `request carries ${JSON.stringify(key)} — verdicts, approvals and bypasses are created by this server, never accepted from a client`,
            ));
          }
        }
        const { runId } = admission.admit(body.runRequest, { runIdPrefix: classifiedRoute.prefixFor(req) });
        // Re-load through the stored path so what the handler holds is exactly
        // what every later mutation will verify against.
        req.admission = admission.contextFor(runId);
        return next();
      }

      // B — mutations of the active run use the STORED context.
      const isWorkflowMutation = classifiedRoute && classifiedRoute.kind === 'workflow-mutation';
      const isRunMutation = classifiedRoute && classifiedRoute.kind === 'run-mutation';
      if (isWorkflowMutation || isRunMutation) {
        const body = req.body || {};
        for (const key of Object.keys(body)) {
          if (CLIENT_AUTHORITY_FIELDS.test(key)) {
            return refusalResponse(res, new AdmissionRefusedError(
              'ADMISSION_CLIENT_VERDICT',
              `${JSON.stringify(key)} is not accepted here — mutations of a registered run run on the server's stored admission, not on anything a client sends`,
            ));
          }
        }
        const active = isWorkflowMutation ? state.loadWorkflow() : state.loadRun();
        // No active run: fall through — the handler's own "no active run"
        // answer is the truthful one, and there is nothing to protect.
        if (!active || !active.id) return next();
        req.admission = admission.contextFor(active.id);
        return next();
      }

      // Everything else is outside this seam's authority (measured in the
      // A1b.1 plan: none of those routes can start or advance a run).
      return next();
    } catch (e) {
      // Fail CLOSED — a broken validator refuses; it never waves through.
      return refusalResponse(res, e);
    }
  };
}

module.exports = {
  createAdmissionSeam,
  classifyAdmissionRoute,
  START_INGRESS,
  WORKFLOW_MUTATIONS,
  RUN_MUTATION_PREFIXES,
};
