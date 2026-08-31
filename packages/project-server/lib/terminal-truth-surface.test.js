'use strict';

// R22 / R23 — what the product SAYS about a terminal run must match what the
// engine DOES about one.
//
// Two surfaces drifted from the terminal model:
//
//   - The hub showed a "Cancel" button on a running agent whose handler posted
//     the literal text "Manually marked as done." as ordinary agent feedback.
//     It neither terminated the process nor carried provenance — it
//     manufactured an agent report out of an operator click, which is the
//     exact class of synthetic evidence feedback-provenance.js exists to keep
//     out of verdicts. The surface is removed, not repaired: a trustworthy
//     manual completion path would need provenance and process control this
//     slice does not add (R22).
//
//   - Several TECHNICAL_STOP recovery hints still advertised in-run recovery —
//     "relaunch the task", "relaunch the step", "advance the step explicitly" —
//     for stops that are terminal for the run they stop. A hint on a terminal
//     outcome may describe the successor repair run (A1b, not implemented
//     here); it must not tell the operator this run can be walked back open,
//     because every route that could act on that advice answers 409 (R23).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTechnicalStop, refusalPayload, REASON_CODES } = require('./technical-stop');
const { taskExecutionOutcome } = require('./blocked-tasks');
const { createRunGuard } = require('./run-guard');
const runBudgets = require('./run-budgets');

// ---------- R22 — the false Cancel / mark-done surface is gone ----------

const HUB_COMPONENTS = path.join(__dirname, '..', '..', 'hub', 'components');

function hubSources() {
  return fs.readdirSync(HUB_COMPONENTS)
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(HUB_COMPONENTS, f), 'utf8') }));
}

test('R22 — the hub carries no markAgentDone / synthetic "marked as done" feedback path', () => {
  for (const { file, src } of hubSources()) {
    assert.ok(!src.includes('markAgentDone'),
      `${file}: markAgentDone posted operator clicks as agent feedback and must not exist`);
    assert.ok(!src.includes('onMarkDone'),
      `${file}: the onMarkDone prop threaded the synthetic-feedback path into agent cards`);
    assert.ok(!/marked as done/i.test(src),
      `${file}: no surface may post "marked as done" text as agent feedback`);
  }
});

// ---------- R23 — terminal recovery hints do not advertise in-run recovery ----------

/** Phrases that tell the operator THIS run can be brought back. */
const IN_RUN_RECOVERY = /relaunch|advance the step|re-enable|skip the task|clear the (stop|halt)/i;
/** A terminal hint must point at the only real route. */
const SUCCESSOR_ROUTE = /successor|repair run|new run|fresh run|separate run/i;

function assertTerminalHint(stop, label) {
  assert.ok(stop && stop.outcome === 'TECHNICAL_STOP', `${label}: expected a technical stop`);
  assert.ok(!IN_RUN_RECOVERY.test(stop.recoveryHint),
    `${label}: terminal hint advertises in-run recovery: "${stop.recoveryHint}"`);
  assert.ok(SUCCESSOR_ROUTE.test(stop.recoveryHint),
    `${label}: terminal hint must name the successor repair run as the route: "${stop.recoveryHint}"`);
}

test('R23 — the default recovery hint does not advertise relaunching the stopped run', () => {
  const stop = createTechnicalStop({ reasonCode: REASON_CODES.BLOCKED_TASKS, runId: 'rn-1', step: 'task_execution' });
  assertTerminalHint(stop, 'createTechnicalStop default hint');
});

test('R23 — the blocked-tasks stop does not advertise relaunching inside the run', () => {
  const wf = {
    id: 'rn-1',
    taskPlan: { tasks: [{ name: 'Auth screen' }, { name: 'Sync engine' }] },
    taskExecution: {
      taskStates: {
        0: { status: 'done' },
        1: { status: 'blocked', blockedReason: 'reached max fix cycles (3/3)' },
      },
    },
  };
  const outcome = taskExecutionOutcome(wf);
  assert.equal(outcome.kind, 'technical_stop');
  assertTerminalHint(outcome.technicalStop, 'BLOCKED_TASKS hint');
});

test('R23 — an exhausted task fix-cycle budget does not advertise relaunching the task', () => {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-hints-'));
  const guard = createRunGuard({ statePath });
  const budgets = { ...runBudgets.resolveBudgets({}), maxTaskFixCycles: 0 };
  const spend = runBudgets.consumeTaskFixCycle(guard, 'rn-1', 1, budgets);
  assert.equal(spend.allowed, false);
  assertTerminalHint(spend.technicalStop, 'FIX_CYCLES hint');
});

test('R23 — an exhausted auto-advance refusal budget does not advertise advancing the run', () => {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-hints-'));
  const guard = createRunGuard({ statePath });
  const budgets = { ...runBudgets.resolveBudgets({}), maxAutoAdvanceRefusals: 1, maxAutoAdvanceRefusalsTotal: 1 };
  let out = runBudgets.noteAutoAdvanceRefusal(guard, 'rn-1', 'merge_for_review', budgets, 'gate said no');
  if (!out.exhausted) out = runBudgets.noteAutoAdvanceRefusal(guard, 'rn-1', 'merge_for_review', budgets, 'gate said no');
  assert.equal(out.exhausted, true);
  assertTerminalHint(out.technicalStop, 'AUTO_ADVANCE_REFUSAL hint');
});

test('R23 — the refusal payload names the successor repair run and nothing in-run', () => {
  const stop = createTechnicalStop({ reasonCode: REASON_CODES.BLOCKED_TASKS, runId: 'rn-1', step: 'task_execution' });
  const payload = refusalPayload(stop);
  assert.equal(payload.recovery, 'successor_repair_run');
  assert.equal(payload.terminal, true);
  assert.ok(!IN_RUN_RECOVERY.test(payload.error), `refusal error advertises in-run recovery: "${payload.error}"`);
});
