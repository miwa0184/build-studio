'use strict';

// R7 / R8 — the hub shows a parked run; it does not offer a way out of one.
//
// The hub is not an authority over transitions (hub-transition-authority.test.js
// pins that for the autonomous case). This is the narrower, operator-facing
// half: for a run that has been technically stopped, the UI must render a
// STATUS surface — reason code, which task and step, the evidence, and the fact
// that recovery is a separate repair run — and must not render a control that
// implies the halt can be lifted here.
//
// Buttons are the honest signal of what a product believes is possible. Leaving
// Clear / Continue / Relaunch / Skip / Approve / Override on a parked run tells
// the operator the run can be resumed, which is exactly what the terminal model
// says it cannot. The previous shape offered Advance and Relaunch on a stopped
// run; both answered 409, so the only thing they communicated was that the UI
// and the engine disagreed.
//
// Lives in project-server because the invariant is the server's — and because
// this suite is the one CI already runs as a required check.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VIEW = path.join(__dirname, '..', '..', 'hub', 'components', 'workflow-view.tsx');
const src = fs.readFileSync(VIEW, 'utf8');

/**
 * The body of `function <name>(...)`, by brace matching.
 *
 * Not simply "the first `{` after the name" — these components destructure
 * their props, so that brace opens the parameter object and the extracted
 * block would be the signature rather than the body.
 */
function functionBody(text, name) {
  const at = text.indexOf(`function ${name}`);
  if (at < 0) return '';
  // Walk past the parameter list, tracking parens, then take the next `{`.
  let i = text.indexOf('(', at);
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  return blockAt(text, text.indexOf('{', i));
}

/** Extract a balanced JSX/TS block starting at `from`, by brace matching. */
function blockAt(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return text.slice(from);
}

test('R7 — the hub models a technical stop at all', () => {
  assert.match(src, /technicalStop\??:/, 'the Workflow type must carry technicalStop');
  assert.ok(src.includes('TechnicalStop'), 'the stop needs a named type, not an inline any');
});

test('R7 — a parked run renders reason code, location, evidence and the repair-run route', () => {
  const i = src.indexOf('TechnicalStopPanel');
  assert.ok(i > 0, 'a dedicated status surface for a stopped run must exist');
  const panel = src.slice(i, src.indexOf('\n}', src.indexOf('function TechnicalStopPanel')) + 2);

  assert.match(panel, /reasonCode/, 'the panel must show the reason code');
  assert.match(panel, /evidence/, 'the panel must show the evidence');
  assert.match(panel, /step/, 'the panel must name where it stopped');
  assert.match(panel, /parked/i, 'the panel must say the run is parked');
  assert.match(panel, /repair run/i, 'the panel must name the successor repair run as the route');
});

test('R7 — the parked panel renders no recovery or advance control', () => {
  const panel = functionBody(src, 'TechnicalStopPanel');
  assert.ok(panel.length > 200, 'the panel body must be found');

  assert.ok(!/<button/.test(panel), 'a parked run must render no button at all');
  for (const forbidden of ['onAdvance', 'clear_technical_stop', 'relaunch_task', 'skip_blocked']) {
    assert.ok(!panel.includes(forbidden), `the parked panel wires ${forbidden}`);
  }
});

test('A1b.2 — an exhausted lineage is shown as terminal technical policy, never a founder question', () => {
  const panel = functionBody(src, 'TechnicalStopPanel');
  assert.match(src, /lineageRefusal\??:/, 'the Workflow type must carry the authoritative lineage refusal');
  assert.match(panel, /lineage authority/, 'the parked surface must name the authority that refused another successor');
  assert.match(panel, /no founder decision is requested/i, 'a technical cap must not be converted into an owner decision');
  assert.match(panel, /replay or restart will not\s+renew the budget/i, 'the UI must not imply a renewable cap');
  assert.ok(!/<button/.test(panel), 'a lineage refusal remains a status surface, not a bypass control');
});

test('R7 — step actions and the task board are suppressed while the run is parked', () => {
  // StepActions renders Advance and ↻ Relaunch; TaskBoard renders per-task
  // Relaunch. Both must be gated off for a stopped run rather than rendering
  // controls that answer 409.
  const stepActions = src.indexOf('<StepActions');
  assert.ok(stepActions > 0);
  const gate = src.slice(Math.max(0, stepActions - 500), stepActions);
  assert.match(gate, /technicalStop/, 'StepActions must be gated on the absence of a technical stop');

  const boardSrc = functionBody(src, 'TaskBoard');
  assert.ok(boardSrc.length > 200, 'the TaskBoard body must be found');
  assert.match(boardSrc, /technicalStop|stopped/, 'TaskBoard must know whether the run is parked');
  // …and actually use it to gate its controls, not merely read it.
  assert.match(boardSrc, /!stopped|stopped\s*&&/, 'TaskBoard must gate its controls on the parked state');
});

test('R8 — no transition can be posted from a parked run', () => {
  // advanceWorkflow is the single explicit user-action path. It must refuse to
  // send anything while the run is stopped, so a stale render or a keyboard
  // shortcut cannot put a transition on the wire.
  const i = src.indexOf('async function advanceWorkflow');
  assert.ok(i > 0, 'the explicit user-action helper must exist');
  const helper = src.slice(i, src.indexOf('\n  }\n', i));
  assert.match(helper, /technicalStop/, 'advanceWorkflow must short-circuit on a technical stop');

  // And the guard must come before the POST, not after it.
  const guardAt = helper.indexOf('technicalStop');
  const postAt = helper.indexOf("api.post('/workflow/advance'");
  assert.ok(postAt > 0, 'the helper must still be able to post for a healthy run');
  assert.ok(guardAt < postAt, 'the technical-stop guard must precede the POST');
});

test('R8 — the client offers no clearing vocabulary anywhere', () => {
  for (const forbidden of ['clear_technical_stop', 'skip_blocked']) {
    assert.ok(!src.includes(forbidden), `the hub references ${forbidden}`);
  }
});

test('R7 — needs-attention reasons the server can send are all modelled', () => {
  // acceptance_gap was emitted by the server and missing from the union, so the
  // most common new case fell through to a generic warning.
  for (const reason of ['technical_stop', 'blocked_task', 'acceptance_gap']) {
    assert.ok(src.includes(`'${reason}'`), `NeedsAttention union is missing ${reason}`);
  }
});
